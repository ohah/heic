import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { getHeicInfo } from '../src/container/heic';
import { getFtypInfo, parseISOBMFF } from '../src/container/heif';
import { decodeHeic } from '../src/decoder';
import { applySao } from '../src/hevc/sao';
import { deblockPicture } from '../src/hevc/deblock';
import { isSliceNal, splitAnnexB, toRbsp, type NalUnit } from '../src/hevc/nal';
import { parsePps } from '../src/hevc/pps';
import { PictureDecoder } from '../src/hevc/picture';
import { buildBReferenceLists, derivePictureOrderCnt } from '../src/hevc/reference-list';
import { parseSliceHeader, SLICE_TYPE_B, SLICE_TYPE_I } from '../src/hevc/slice-header';
import { parseSps } from '../src/hevc/sps';
import { decodeItemPlanes } from '../src/planes';
import { wrapHevcPredChain } from '../scripts/lib/heif';

function md5(data: Uint8Array): string {
  return createHash('md5').update(data).digest('hex');
}

function planeMd5s(planes: readonly (Uint8Array | Uint16Array)[]): string[] {
  return planes.map((plane) => md5(Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength)));
}

function decodedPictureHash(nal: Uint8Array): string[] | null {
  const rbsp = toRbsp(nal);
  let position = 0;
  while (position < rbsp.length) {
    let payloadType = 0;
    while (position < rbsp.length && rbsp[position] === 255) {
      payloadType += 255;
      position++;
    }
    if (position >= rbsp.length) return null;
    payloadType += rbsp[position++]!;

    let payloadSize = 0;
    while (position < rbsp.length && rbsp[position] === 255) {
      payloadSize += 255;
      position++;
    }
    if (position >= rbsp.length) return null;
    payloadSize += rbsp[position++]!;
    const payload = rbsp.subarray(position, position + payloadSize);
    if (payload.length !== payloadSize) throw new Error('truncated decoded_picture_hash SEI');
    position += payloadSize;

    if (payloadType !== 132) continue;
    if (payload[0] !== 0 || payload.length !== 49)
      throw new Error('expected a three-plane MD5 decoded_picture_hash');
    return [0, 1, 2].map((component) =>
      Buffer.from(payload.subarray(1 + component * 16, 17 + component * 16)).toString('hex'),
    );
  }
  return null;
}

function asAnnexB(nals: readonly Uint8Array[]): Buffer {
  return Buffer.concat(nals.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), Buffer.from(nal)]));
}

function validateCcpVector(vector: {
  file: string;
  width: number;
  height: number;
  bitDepth: number;
  bitstreamMd5: string;
  bitstreamSha256: string;
  yuvMd5: string;
}) {
  const bytes = new Uint8Array(
    readFileSync(new URL(`./fixtures/conformance/${vector.file}`, import.meta.url)),
  );
  expect(md5(bytes)).toBe(vector.bitstreamMd5);
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(vector.bitstreamSha256);

  const nals = splitAnnexB(bytes);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official CCP vector is missing parameter sets');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples]).toEqual([
    vector.width,
    vector.height,
  ]);
  expect([sps.chromaFormatIdc, sps.bitDepthLuma, sps.bitDepthChroma]).toEqual([
    3,
    vector.bitDepth,
    vector.bitDepth,
  ]);
  expect(pps.crossComponentPredictionEnabled).toBe(true);

  type Picture = {
    nals: NalUnit[];
    slices: Uint8Array[];
    header: ReturnType<typeof parseSliceHeader>;
    expected: string[] | null;
  };
  const pictures: Picture[] = [];
  let current: Picture | undefined;
  for (const nal of nals) {
    if (isSliceNal(nal.type)) {
      const header = parseSliceHeader(nal.data, sps, pps);
      if (header.firstSliceInPic) {
        current = { nals: [nal], slices: [nal.data], header, expected: null };
        pictures.push(current);
      } else {
        if (!current) throw new Error('continuation slice precedes the first CCP slice');
        current.nals.push(nal);
        current.slices.push(nal.data);
      }
    } else if (current) {
      current.nals.push(nal);
      if (nal.type === 40) current.expected = decodedPictureHash(nal.data) ?? current.expected;
    }
  }

  expect(pictures).toHaveLength(9);
  expect(pictures.map(({ header }) => header.sliceType)).toEqual([
    SLICE_TYPE_I,
    ...Array<number>(8).fill(SLICE_TYPE_B),
  ]);

  const pocs: number[] = [];
  let previousTid0Poc: number | null = null;
  for (const picture of pictures) {
    const poc = derivePictureOrderCnt(sps, picture.header, previousTid0Poc);
    pocs.push(poc);
    if (((picture.slices[0]?.[1] ?? 0) & 7) === 1) previousTid0Poc = poc;
  }
  expect(pocs).toEqual([0, 8, 4, 2, 1, 3, 6, 5, 7]);

  const references: Parameters<typeof buildBReferenceLists>[3] = [];
  const decodedByPoc = new Map<number, (Uint8Array | Uint16Array)[]>();
  let expectedHashCount = 0;
  for (const [index, picture] of pictures.entries()) {
    const poc = pocs[index]!;
    const lists =
      picture.header.sliceType === SLICE_TYPE_B
        ? buildBReferenceLists(sps, picture.header, poc, references)
        : { l0: [], l1: [] };
    const decoded = new PictureDecoder(sps, pps, lists.l0, poc, lists.l1).decode(picture.slices);
    deblockPicture(decoded, pps, sps.bitDepthLuma, sps.bitDepthChroma);
    applySao(decoded, sps, sps.bitDepthLuma, sps.bitDepthChroma);
    const planes = [decoded.y, decoded.cb, decoded.cr];
    if (picture.expected) {
      expect(planeMd5s(planes), `POC ${poc} decoded_picture_hash`).toEqual(picture.expected);
      expectedHashCount++;
    }
    decodedByPoc.set(poc, planes);
    references.push({
      ...decoded,
      chromaFormatIdc: sps.chromaFormatIdc,
      bitDepthLuma: sps.bitDepthLuma,
      bitDepthChroma: sps.bitDepthChroma,
      pictureOrderCntLsb: picture.header.pictureOrderCntLsb ?? 0,
      pictureOrderCnt: poc,
      isLongTermReference: false,
    });
    if (((picture.slices[0]?.[1] ?? 0) & 7) === 1) previousTid0Poc = poc;
  }
  // This archive publishes one whole-sequence reconstruction MD5, not per-picture hash SEIs.
  expect(expectedHashCount).toBe(0);

  const displayOrderYuv = Buffer.concat(
    [...decodedByPoc.keys()]
      .sort((left, right) => left - right)
      .flatMap((poc) =>
        decodedByPoc
          .get(poc)!
          .map((plane) => Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength)),
      ),
  );
  expect(md5(displayOrderYuv)).toBe(vector.yuvMd5);

  const parameterNals = nals
    .filter((nal) => nal.type >= 32 && nal.type <= 34)
    .map((nal) => nal.data);
  const itemStreams = pictures.map(({ slices }, index) =>
    asAnnexB([...(index === 0 ? parameterNals : []), ...slices]),
  );
  const indexByPoc = new Map(pocs.map((poc, index) => [poc, index]));
  const dependencies = pictures.map(({ header }, index) => {
    const rps = header.shortTermRefPicSet;
    const referencePocs = new Set<number>();
    if (rps) {
      for (const [deltas, usedFlags] of [
        [rps.deltaPocS0, rps.usedByCurrPicS0],
        [rps.deltaPocS1, rps.usedByCurrPicS1],
      ] as const) {
        for (let referenceIndex = 0; referenceIndex < deltas.length; referenceIndex++)
          if (usedFlags[referenceIndex]) referencePocs.add(pocs[index]! + deltas[referenceIndex]!);
      }
    }
    expect(header.longTermRefPics).toHaveLength(0);
    return [...referencePocs]
      .map((poc) => {
        const referenceIndex = indexByPoc.get(poc);
        if (referenceIndex === undefined || referenceIndex >= index)
          throw new Error(`POC ${pocs[index]} has an invalid reference POC ${poc}`);
        return referenceIndex;
      })
      .sort((left, right) => left - right);
  });
  const heif = wrapHevcPredChain(
    itemStreams,
    dependencies.map((indexes) => indexes.map((index) => index + 1)),
    vector.width,
    vector.height,
    sps.bitDepthLuma,
    sps.chromaFormatIdc,
  );
  expect(getFtypInfo(heif)?.majorBrand).toBe('heix');
  const boxes = parseISOBMFF(heif);
  const info = getHeicInfo(heif, boxes);
  expect(info.hvcC).toMatchObject({
    chromaFormatIdc: 3,
    bitDepthLumaMinus8: vector.bitDepth - 8,
  });
  expect(info.predReferenceItemIds).toEqual(dependencies.at(-1)?.map((index) => index + 1));
  const primaryPlanes = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
  expect([primaryPlanes.width, primaryPlanes.height, primaryPlanes.bitDepthLuma]).toEqual([
    vector.width,
    vector.height,
    vector.bitDepth,
  ]);
  const rawPrimaryPlanes = decodedByPoc.get(pocs.at(-1)!);
  if (!rawPrimaryPlanes) throw new Error('raw CCP primary picture was not decoded');
  expect(planeMd5s([primaryPlanes.y, primaryPlanes.cb, primaryPlanes.cr])).toEqual(
    planeMd5s(rawPrimaryPlanes),
  );
  const image = decodeHeic(heif, { applyTransforms: false });
  expect([image.width, image.height, image.bitDepth]).toEqual([
    vector.width,
    vector.height,
    vector.bitDepth,
  ]);
}

it('decodes the official 8-bit 4:4:4 cross-component prediction sequence', () => {
  validateCcpVector({
    file: 'ccp-8bit-rext-qcom-1.bit',
    width: 1280,
    height: 720,
    bitDepth: 8,
    bitstreamMd5: '89ff7b4e90585587eda35d596dacc172',
    bitstreamSha256: 'c5e0d9b5e0062c2f4bfb1ec9e8a6465fb715e3af498306d7d0e4bec0bc9bae5c',
    yuvMd5: '54231c6f121ca65d8b94a747b9504b8b',
  });
}, 30_000);

it('decodes the official 10-bit 4:4:4 cross-component prediction sequence', () => {
  validateCcpVector({
    file: 'ccp-10bit-rext-qcom-1.bit',
    width: 1920,
    height: 1080,
    bitDepth: 10,
    bitstreamMd5: '2aa5070df3b9f3467b2e3c71640c233c',
    bitstreamSha256: '6e40e49ba5bef61d951c4088b0234db20e1f264804c59a007b9f32a117a45603',
    yuvMd5: '363f55fc6097a3bb7525392b87a6498a',
  });
}, 30_000);
