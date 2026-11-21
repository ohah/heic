import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { getHeicInfo } from '../src/container/heic.js';
import { getFtypInfo, parseISOBMFF } from '../src/container/heif.js';
import { deblockPicture } from '../src/hevc/deblock.js';
import { isSliceNal, splitAnnexB } from '../src/hevc/nal.js';
import { PictureDecoder } from '../src/hevc/picture.js';
import { parsePps } from '../src/hevc/pps.js';
import { applySao } from '../src/hevc/sao.js';
import { parseSliceHeader, SLICE_TYPE_I, SLICE_TYPE_P } from '../src/hevc/slice-header.js';
import {
  buildReferenceList0,
  derivePictureOrderCnt,
  type PictureReference,
} from '../src/hevc/reference-list.js';
import { parseSps } from '../src/hevc/sps.js';
import { decodeItemPlanes } from '../src/planes.js';
import { wrapHevcPredChain } from '../scripts/lib/heif.js';

const bitstream = new Uint8Array(
  readFileSync(
    new URL(
      './fixtures/regressions/hevc-multiref-weighted-p/weighted-p-multiref.hevc',
      import.meta.url,
    ),
  ),
);
const reconstruction = readFileSync(
  new URL('./fixtures/regressions/hevc-multiref-weighted-p/recon.y4m', import.meta.url),
);

function readY4mFrames(bytes: Uint8Array): Buffer[] {
  const headerEnd = bytes.indexOf(0x0a);
  if (headerEnd < 0) throw new Error('x265 Y4M reference has no header');
  const header = Buffer.from(bytes.subarray(0, headerEnd)).toString();
  expect(header).toContain('W128 H64');
  expect(header).toContain('C420');

  const frameSize = (128 * 64 * 3) / 2;
  const frames: Buffer[] = [];
  let offset = headerEnd + 1;
  while (offset < bytes.length) {
    const frameHeaderEnd = bytes.indexOf(0x0a, offset);
    if (frameHeaderEnd < 0) throw new Error('x265 Y4M reference has a truncated frame header');
    expect(Buffer.from(bytes.subarray(offset, frameHeaderEnd)).toString()).toBe('FRAME');
    const frameStart = frameHeaderEnd + 1;
    const frameEnd = frameStart + frameSize;
    if (frameEnd > bytes.length) throw new Error('x265 Y4M reference has a truncated frame');
    frames.push(Buffer.from(bytes.subarray(frameStart, frameEnd)));
    offset = frameEnd;
  }
  return frames;
}

it('decodes a weighted P picture that selects both active L0 references', () => {
  expect(createHash('sha256').update(bitstream).digest('hex')).toBe(
    '8a8198de23dc4ab0b4c1887aa6912320528e703501a3ee115c7c9758013632c1',
  );
  expect(createHash('sha256').update(reconstruction).digest('hex')).toBe(
    'ea152845db378a77a71900ceaaf5eaa33792424cbcf743ca61b0e7b5a9d29a36',
  );
  const expectedFrames = readY4mFrames(reconstruction);
  expect(expectedFrames).toHaveLength(3);

  const nals = splitAnnexB(bitstream);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('weighted multi-reference stream lacks SPS or PPS');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples, sps.chromaFormatIdc]).toEqual([
    128, 64, 1,
  ]);
  expect(pps.weightedPred).toBe(true);

  const pictures: Uint8Array[][] = [];
  let picture: Uint8Array[] = [];
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals.filter((entry) => isSliceNal(entry.type))) {
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic && picture.length > 0) {
      pictures.push(picture);
      picture = [];
    }
    picture.push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }
  if (picture.length > 0) pictures.push(picture);
  expect(pictures).toHaveLength(3);

  const references: PictureReference[] = [];
  const decodedPictures = [];
  let previousTid0Poc: number | null = null;
  for (const [index, pictureNals] of pictures.entries()) {
    const header = parseSliceHeader(pictureNals[0], sps, pps);
    const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
    let referencesL0: readonly PictureReference[] = [];
    if (header.sliceType === SLICE_TYPE_P) {
      referencesL0 = buildReferenceList0(sps, header, poc, references);
    } else {
      expect(header.sliceType).toBe(SLICE_TYPE_I);
    }
    const decoded = new PictureDecoder(sps, pps, referencesL0, poc).decode(pictureNals);
    deblockPicture(decoded, pps, sps.bitDepthLuma, sps.bitDepthChroma);
    applySao(decoded, sps, sps.bitDepthLuma, sps.bitDepthChroma);
    const output = Buffer.concat([
      Buffer.from(decoded.y),
      Buffer.from(decoded.cb),
      Buffer.from(decoded.cr),
    ]);
    expect(output).toEqual(expectedFrames[index]);
    decodedPictures.push({ decoded, header, poc });
    references.push({
      ...decoded,
      pictureOrderCntLsb: header.pictureOrderCntLsb ?? 0,
      pictureOrderCnt: poc,
      isLongTermReference: false,
    });
    if ((pictureNals[0][1] & 7) - 1 === 0) previousTid0Poc = poc;
  }

  const target = decodedPictures[2];
  expect(target.poc).toBe(2);
  expect(target.header.sliceType).toBe(SLICE_TYPE_P);
  expect(target.header.numRefIdxL0ActiveMinus1).toBe(1);
  const weights = target.header.weightedPrediction;
  if (!weights) throw new Error('target P picture has no weighted-prediction table');
  expect(weights.l0).toHaveLength(2);
  expect(weights.l0[0]).toMatchObject({ lumaWeight: 31, lumaOffset: -6 });
  expect(weights.l0[1]).toMatchObject({ lumaWeight: 32, lumaOffset: 0 });

  const usedReferences = new Set<string>();
  for (let index = 0; index < target.decoded.motionIsExternal.length; index++) {
    if (target.decoded.motionIsExternal[index]) {
      usedReferences.add(
        `${target.decoded.motionRefIdxL0[index]}@${target.decoded.motionRefPoc[index]}`,
      );
    }
  }
  expect([...usedReferences].sort()).toEqual(['0@1', '1@0']);

  const parameterNals = nals
    .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
    .map((nal) => nal.data);
  const asAnnexB = (units: readonly Uint8Array[]) =>
    Buffer.concat(units.flatMap((unit) => [Buffer.from([0, 0, 0, 1]), Buffer.from(unit)]));
  const streams = pictures.map((pictureNals, index) =>
    asAnnexB([...(index === 0 ? parameterNals : []), ...pictureNals]),
  );
  const heif = wrapHevcPredChain(
    streams,
    [[], [1], [1, 2]],
    sps.picWidthInLumaSamples,
    sps.picHeightInLumaSamples,
    sps.bitDepthLuma,
    sps.chromaFormatIdc,
  );
  expect(getFtypInfo(heif)?.majorBrand).toBe('heic');
  const boxes = parseISOBMFF(heif);
  const info = getHeicInfo(heif, boxes);
  const primary = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
  expect(primary.pictureOrderCnt).toBe(2);
  expect(
    Buffer.concat([Buffer.from(primary.y), Buffer.from(primary.cb), Buffer.from(primary.cr)]),
  ).toEqual(expectedFrames[2]);
});
