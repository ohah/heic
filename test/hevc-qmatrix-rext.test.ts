import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { getHeicInfo } from '../src/container/heic';
import { getFtypInfo, parseISOBMFF } from '../src/container/heif';
import { decodeHeic } from '../src/decoder';
import { deblockPicture } from '../src/hevc/deblock';
import { isSliceNal, splitAnnexB, type NalUnit } from '../src/hevc/nal';
import { parsePps } from '../src/hevc/pps';
import { PictureDecoder } from '../src/hevc/picture';
import { applySao } from '../src/hevc/sao';
import { parseSliceHeader, SLICE_TYPE_B, SLICE_TYPE_I } from '../src/hevc/slice-header';
import { derivePictureOrderCnt, buildBReferenceLists } from '../src/hevc/reference-list';
import { parseSps } from '../src/hevc/sps';
import { decodeItemPlanes } from '../src/planes';
import { wrapHevcPredChain } from '../scripts/lib/heif';

function md5(data: Uint8Array): string {
  return createHash('md5').update(data).digest('hex');
}

function planeMd5s(planes: readonly (Uint8Array | Uint16Array)[]): string[] {
  return planes.map((plane) => md5(Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength)));
}

function asAnnexB(nals: readonly Uint8Array[]): Buffer {
  return Buffer.concat(nals.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), Buffer.from(nal)]));
}

it('decodes the official RExt scaling-list vector through HEVC and a still HEIF item', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/qmatrix-a-rext-sony-1.bit', import.meta.url)),
  );
  expect(md5(bytes)).toBe('cacbce5c7a5f2ba9c97cda24580c8291');
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    '74847e07f3298923da0e9b68b1f861930d227bd5ad83a834a8280cf042a7e78f',
  );

  const nals = splitAnnexB(bytes);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official QMATRIX vector is missing parameter sets');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples]).toEqual([1280, 720]);
  expect([sps.chromaFormatIdc, sps.bitDepthLuma, sps.bitDepthChroma]).toEqual([3, 8, 8]);
  expect(sps.scalingListEnabled).toBe(true);
  expect(sps.scalingListData).not.toBeNull();
  expect(pps.transformSkipEnabled).toBe(true);

  type Picture = {
    nal: NalUnit;
    header: ReturnType<typeof parseSliceHeader>;
    pps: ReturnType<typeof parsePps>;
    ppsNal: NalUnit;
  };
  const pictures: Picture[] = [];
  let activePps: ReturnType<typeof parsePps> | null = null;
  let activePpsNal: NalUnit | null = null;
  for (const nal of nals) {
    if (nal.type === 34) {
      activePps = parsePps(nal.data);
      activePpsNal = nal;
    } else if (isSliceNal(nal.type)) {
      if (!activePps || !activePpsNal)
        throw new Error('official QMATRIX vector has a slice before its PPS');
      pictures.push({
        nal,
        header: parseSliceHeader(nal.data, sps, activePps),
        pps: activePps,
        ppsNal: activePpsNal,
      });
    }
  }
  expect(pictures.every(({ header }) => header.firstSliceInPic)).toBe(true);
  expect(pictures.map(({ header }) => header.sliceType)).toEqual([
    SLICE_TYPE_I,
    ...Array<number>(19).fill(SLICE_TYPE_B),
  ]);

  const pocs: number[] = [];
  let previousTid0Poc: number | null = null;
  for (const { nal, header } of pictures) {
    const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
    pocs.push(poc);
    if (((nal.data[1] ?? 0) & 7) === 1) previousTid0Poc = poc;
  }
  expect(pocs).toEqual(Array.from({ length: 20 }, (_, index) => index));

  const references: Parameters<typeof buildBReferenceLists>[3] = [];
  const decodedByPoc = new Map<number, (Uint8Array | Uint16Array)[]>();
  previousTid0Poc = null;
  for (const [index, { nal, header, pps: picturePps }] of pictures.entries()) {
    const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
    const lists =
      header.sliceType === SLICE_TYPE_B
        ? buildBReferenceLists(sps, header, poc, references)
        : { l0: [], l1: [] };
    const decoded = new PictureDecoder(sps, picturePps, lists.l0, poc, lists.l1).decode([nal.data]);
    deblockPicture(decoded, picturePps, sps.bitDepthLuma, sps.bitDepthChroma);
    applySao(decoded, sps, sps.bitDepthLuma, sps.bitDepthChroma);
    decodedByPoc.set(poc, [decoded.y, decoded.cb, decoded.cr]);
    references.push({
      ...decoded,
      chromaFormatIdc: sps.chromaFormatIdc,
      bitDepthLuma: sps.bitDepthLuma,
      bitDepthChroma: sps.bitDepthChroma,
      pictureOrderCntLsb: header.pictureOrderCntLsb ?? 0,
      pictureOrderCnt: poc,
      isLongTermReference: false,
    });
    if (((nal.data[1] ?? 0) & 7) === 1) previousTid0Poc = poc;
    expect(index).toBe(poc);
  }

  const validatedPrefixHashes = [
    '815832a55aceb48345a84f157ffc169f',
    '498fac12650c766013a9a84c804c3394',
    'f8a0240e5d579a26159cae67e3dcf942',
  ];
  expect(
    [0, 1, 2].map((poc) =>
      md5(
        Buffer.concat(
          decodedByPoc
            .get(poc)!
            .map((plane) => Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength)),
        ),
      ),
    ),
  ).toEqual(validatedPrefixHashes);
  const displayOrderYuv = Buffer.concat(
    [...decodedByPoc.keys()]
      .sort((left, right) => left - right)
      .flatMap((poc) =>
        decodedByPoc
          .get(poc)!
          .map((plane) => Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength)),
      ),
  );
  expect(md5(displayOrderYuv)).toBe('e0fe38f19cf0ac875ce6674da989ea38');

  const firstPicture = pictures[0]!;
  const vpsNals = nals.filter((nal) => nal.type === 32).map((nal) => nal.data);
  const firstItemStream = asAnnexB([
    ...vpsNals,
    spsNal.data,
    firstPicture.ppsNal.data,
    firstPicture.nal.data,
  ]);
  const heif = wrapHevcPredChain([firstItemStream], [[]], 1280, 720, 8, 3);
  expect(getFtypInfo(heif)?.majorBrand).toBe('heix');
  const boxes = parseISOBMFF(heif);
  const info = getHeicInfo(heif, boxes);
  const primary = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
  const rawPrimary = decodedByPoc.get(0);
  if (!rawPrimary) throw new Error('raw QMATRIX first picture was not decoded');
  expect(planeMd5s([primary.y, primary.cb, primary.cr])).toEqual(planeMd5s(rawPrimary));
  const image = decodeHeic(heif, { applyTransforms: false });
  expect([image.width, image.height, image.bitDepth]).toEqual([1280, 720, 8]);
}, 60_000);
