import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { getHeicInfo } from '../src/container/heic.js';
import { parseISOBMFF } from '../src/container/heif.js';
import { isSliceNal, splitAnnexB } from '../src/hevc/nal.js';
import { parsePps } from '../src/hevc/pps.js';
import { parseSliceHeader, SLICE_TYPE_P } from '../src/hevc/slice-header.js';
import { parseSps } from '../src/hevc/sps.js';
import { decodeItemPlanes } from '../src/planes.js';
import { wrapHevcPredChain } from '../scripts/lib/heif.js';

const expectedPlaneMd5s = [
  [
    'd66cfebb63f2ab3533f247d93e1b4b3b',
    'a4742cadcf059be94aa12d36c161a31c',
    '7d465ba05bad2ae80c5935db3ab51f01',
  ],
  [
    'ad8aa1bab8f2f675e63b8816a687a129',
    '9b7ddb1fce6081b18a265f30d3ffadb6',
    '609a1d3f6afa4262026a0f95868900a5',
  ],
];

const startCode = Buffer.from([0, 0, 0, 1]);

it('matches HM for external-reference integer-MV P slices through HEIF pred items', () => {
  const bytes = new Uint8Array(
    readFileSync(
      new URL(
        './fixtures/generated/integer-mv-external-p-hm-scm-16.15-scm-8.5.hevc',
        import.meta.url,
      ),
    ),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    '01605136a73ba03954d9db3e2b57a84076eae8909a77df37f82e5dfa52680d4b',
  );

  const nals = splitAnnexB(bytes);
  const parameterNals = nals.filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  const slices = nals.filter((nal) => isSliceNal(nal.type));
  if (!spsNal || !ppsNal || slices.length !== expectedPlaneMd5s.length)
    throw new Error('synthetic HM-SCM stream is missing its parameter sets or two pictures');

  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples, sps.chromaFormatIdc]).toEqual([
    128, 128, 1,
  ]);
  expect(sps.screenContentExtension?.motionVectorResolutionControlIdc).toBe(1);

  const headers = slices.map((slice) => parseSliceHeader(slice.data, sps, pps));
  expect(headers.map((header) => header.sliceType)).toEqual([SLICE_TYPE_P, SLICE_TYPE_P]);
  expect(headers.every((header) => header.useIntegerMv)).toBe(true);
  expect(headers[1]?.currentPictureReferenceEnabled).toBe(true);
  expect(headers[1]?.shortTermRefPicSet?.deltaPocS0).toContain(-1);

  const streams = slices.map((slice, index) =>
    Buffer.concat([
      ...(index === 0
        ? parameterNals.map((nal) => Buffer.concat([startCode, Buffer.from(nal.data)]))
        : []),
      Buffer.concat([startCode, Buffer.from(slice.data)]),
    ]),
  );
  const heif = wrapHevcPredChain(streams, [[], [1]], 128, 128, 8, 1);
  const boxes = parseISOBMFF(heif);
  const info = getHeicInfo(heif, boxes);
  const pictures = slices.map((_, index) => decodeItemPlanes(heif, boxes, info, index + 1));
  const actualPlaneMd5s = pictures.map((picture) =>
    [picture.y, picture.cb, picture.cr].map((plane) =>
      createHash('md5').update(Buffer.from(plane)).digest('hex'),
    ),
  );
  expect(actualPlaneMd5s).toEqual(expectedPlaneMd5s);

  const mixed = pictures[1]!;
  const interMap = mixed.interMap;
  const externalMap = mixed.motionIsExternal;
  const refIdxL0 = mixed.motionRefIdxL0;
  const motionXQpel = mixed.motionXQpel;
  const motionYQpel = mixed.motionYQpel;
  if (!interMap || !externalMap || !refIdxL0 || !motionXQpel || !motionYQpel)
    throw new Error('POC 1 did not retain its decoded integer-MV inter maps');

  const externalReferenceIndexes = new Set<number>();
  const currentReferenceIndexes = new Set<number>();
  let externalBlocks = 0;
  let currentBlocks = 0;
  let nonzeroExternalVectors = 0;
  let fractionalExternalVectors = 0;
  for (let index = 0; index < interMap.length; index++) {
    if (interMap[index] !== 1) continue;
    if (externalMap[index] === 1) {
      externalBlocks++;
      externalReferenceIndexes.add(refIdxL0[index]!);
      if (motionXQpel[index] !== 0 || motionYQpel[index] !== 0) nonzeroExternalVectors++;
      if (motionXQpel[index]! % 4 !== 0 || motionYQpel[index]! % 4 !== 0)
        fractionalExternalVectors++;
    } else {
      currentBlocks++;
      currentReferenceIndexes.add(refIdxL0[index]!);
    }
  }
  expect({
    hasExternalInterMotion: mixed.hasExternalInterMotion,
    externalBlocks,
    externalReferenceIndexes: [...externalReferenceIndexes],
    currentBlocks,
    currentReferenceIndexes: [...currentReferenceIndexes],
    nonzeroExternalVectors,
    fractionalExternalVectors,
  }).toEqual({
    hasExternalInterMotion: true,
    externalBlocks: 1008,
    externalReferenceIndexes: [0],
    currentBlocks: 12,
    currentReferenceIndexes: [1],
    nonzeroExternalVectors: 1008,
    fractionalExternalVectors: 0,
  });
});
