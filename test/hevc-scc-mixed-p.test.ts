import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { getHeicInfo } from '../src/container/heic.js';
import { parseISOBMFF } from '../src/container/heif.js';
import { isSliceNal, splitAnnexB } from '../src/hevc/nal.js';
import { buildReferenceList0, derivePictureOrderCnt } from '../src/hevc/reference-list.js';
import { parsePps } from '../src/hevc/pps.js';
import { parseSliceHeader, SLICE_TYPE_P } from '../src/hevc/slice-header.js';
import { parseSps } from '../src/hevc/sps.js';
import { decodeItemPlanes } from '../src/planes.js';
import { wrapHevcPredChain } from '../scripts/lib/heif.js';

const startCode = Buffer.from([0, 0, 0, 1]);

function asAnnexB(nal: Uint8Array): Buffer {
  return Buffer.concat([startCode, Buffer.from(nal)]);
}

const expectedPlaneMd5s = [
  [
    'fd1f0a25c4e7fe465c5645653b2cb12f',
    'dd2168fd5463433596f297a4ae6ae9b2',
    'dd2168fd5463433596f297a4ae6ae9b2',
  ],
  [
    '39bc1945055adb7d55646d9ec883cb3f',
    'dd2168fd5463433596f297a4ae6ae9b2',
    'dd2168fd5463433596f297a4ae6ae9b2',
  ],
  [
    '22f138cd40d8b00522db4102b6102245',
    'dd2168fd5463433596f297a4ae6ae9b2',
    'dd2168fd5463433596f297a4ae6ae9b2',
  ],
  [
    '6e8f85ae75a00cdd427dc71a45ad1bc9',
    'dd2168fd5463433596f297a4ae6ae9b2',
    'dd2168fd5463433596f297a4ae6ae9b2',
  ],
  [
    'd2954c84008845369749619cfc391840',
    'dd2168fd5463433596f297a4ae6ae9b2',
    'dd2168fd5463433596f297a4ae6ae9b2',
  ],
  [
    '586c08f2b9d3bd8086784b6d4212309a',
    'dd2168fd5463433596f297a4ae6ae9b2',
    'dd2168fd5463433596f297a4ae6ae9b2',
  ],
  [
    '82d91e6ffdd7a0261df151ed1c22c111',
    'dd2168fd5463433596f297a4ae6ae9b2',
    'dd2168fd5463433596f297a4ae6ae9b2',
  ],
  [
    '23c64985bfdd85d007b831d322f66b3d',
    'dd2168fd5463433596f297a4ae6ae9b2',
    'dd2168fd5463433596f297a4ae6ae9b2',
  ],
  [
    '363cf956185c0621a2a1a29f6e1b7144',
    'dd2168fd5463433596f297a4ae6ae9b2',
    'dd2168fd5463433596f297a4ae6ae9b2',
  ],
  [
    'e33a74ded28bfce211f97d217d12f0cd',
    'dd2168fd5463433596f297a4ae6ae9b2',
    'dd2168fd5463433596f297a4ae6ae9b2',
  ],
  [
    '4afc5658b39042386beddf7202208184',
    'dd2168fd5463433596f297a4ae6ae9b2',
    'dd2168fd5463433596f297a4ae6ae9b2',
  ],
  [
    '11f2a09ce3a9f6a478dfd663bb121c9d',
    'dd2168fd5463433596f297a4ae6ae9b2',
    'dd2168fd5463433596f297a4ae6ae9b2',
  ],
];

it('preserves IBC-only temporal motion maps for mixed-reference P slices', () => {
  const bytes = new Uint8Array(
    readFileSync(
      new URL('./fixtures/generated/scc-mixed-p-hm-scm-16.15-scm-8.5.hevc', import.meta.url),
    ),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    'b0f74280e1db9037220bdd5e26500a1029bfb3df9eb1658d440fe224731e843a',
  );

  const nals = splitAnnexB(bytes);
  const parameterNals = nals.filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  const slices = nals.filter((nal) => isSliceNal(nal.type));
  if (!spsNal || !ppsNal || slices.length !== expectedPlaneMd5s.length)
    throw new Error('synthetic HM-SCM stream is missing parameter sets or one of its 12 pictures');

  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples, sps.chromaFormatIdc]).toEqual([
    256, 256, 1,
  ]);
  expect(sps.screenContentExtension?.currPicRefEnabled).toBe(true);
  expect(pps.screenContentExtension?.currPicRefEnabled).toBe(true);

  const headers = slices.map((slice) => parseSliceHeader(slice.data, sps, pps));
  expect(headers.map((header) => header.sliceType)).toEqual(
    Array<number>(slices.length).fill(SLICE_TYPE_P),
  );
  expect(headers.every((header) => header.currentPictureReferenceEnabled)).toBe(true);
  expect(headers[0]?.numRefIdxL0ActiveMinus1).toBe(0);
  expect(headers[1]?.numRefIdxL0ActiveMinus1).toBe(1);

  const itemIdByPoc = new Map<number, number>();
  const pocs: number[] = [];
  const predReferenceIds: number[][] = [];
  let previousTid0Poc: number | null = null;
  for (const [index, header] of headers.entries()) {
    if (header.longTermRefPics.length !== 0)
      throw new Error('synthetic mixed-P stream unexpectedly uses long-term references');
    const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
    pocs.push(poc);
    const referencePocs = [
      ...(header.shortTermRefPicSet?.deltaPocS0.flatMap((delta, refIndex) =>
        header.shortTermRefPicSet?.usedByCurrPicS0[refIndex] ? [poc + delta] : [],
      ) ?? []),
      ...(header.shortTermRefPicSet?.deltaPocS1.flatMap((delta, refIndex) =>
        header.shortTermRefPicSet?.usedByCurrPicS1[refIndex] ? [poc + delta] : [],
      ) ?? []),
    ];
    predReferenceIds.push(
      [...new Set(referencePocs)].map((referencePoc) => {
        const itemId = itemIdByPoc.get(referencePoc);
        if (itemId === undefined || itemId >= index + 1)
          throw new Error(`POC ${poc} requires unavailable external reference POC ${referencePoc}`);
        return itemId;
      }),
    );
    itemIdByPoc.set(poc, index + 1);
    previousTid0Poc = poc;
  }
  expect(pocs).toEqual(Array.from({ length: 12 }, (_, index) => index));

  const streams = slices.map((slice, index) =>
    Buffer.concat([
      ...(index === 0 ? parameterNals.map((nal) => asAnnexB(nal.data)) : []),
      asAnnexB(slice.data),
    ]),
  );
  const heif = wrapHevcPredChain(
    streams,
    predReferenceIds,
    sps.picWidthInLumaSamples,
    sps.picHeightInLumaSamples,
    sps.bitDepthLuma,
    sps.chromaFormatIdc,
  );
  const boxes = parseISOBMFF(heif);
  const info = getHeicInfo(heif, boxes);
  const pictures = slices.map((_, index) => decodeItemPlanes(heif, boxes, info, index + 1));
  const actualPlaneMd5s = pictures.map((picture) =>
    [picture.y, picture.cb, picture.cr].map((plane) =>
      createHash('md5').update(Buffer.from(plane)).digest('hex'),
    ),
  );
  expect(actualPlaneMd5s).toEqual(expectedPlaneMd5s);

  const ibcOnly = pictures[0];
  expect(ibcOnly.hasExternalInterMotion).toBe(false);
  expect(ibcOnly.interMap?.some((value) => value === 1)).toBe(true);
  expect(ibcOnly.motionIsExternal).toBeDefined();
  expect(
    ibcOnly.interMap?.every(
      (value, index) => value !== 1 || ibcOnly.motionIsExternal?.[index] === 0,
    ),
  ).toBe(true);

  const mixed = pictures[1];
  const interMap = mixed.interMap;
  const externalMap = mixed.motionIsExternal;
  const refIdxL0 = mixed.motionRefIdxL0;
  if (!interMap || !externalMap || !refIdxL0)
    throw new Error('mixed-reference POC 1 did not retain its inter motion maps');
  const currentReferenceIndexes = new Set<number>();
  const externalReferenceIndexes = new Set<number>();
  for (let index = 0; index < interMap.length; index++) {
    if (interMap[index] !== 1) continue;
    (externalMap[index] === 0 ? currentReferenceIndexes : externalReferenceIndexes).add(
      refIdxL0[index]!,
    );
  }
  expect([...currentReferenceIndexes]).toEqual([1]);
  expect([...externalReferenceIndexes]).toEqual([0]);
  expect(
    buildReferenceList0(sps, headers[1]!, pocs[1]!, [pictures[0]]).map(
      ({ isCurrentPicture, pictureOrderCnt }) => ({ isCurrentPicture, pictureOrderCnt }),
    ),
  ).toEqual([
    { isCurrentPicture: undefined, pictureOrderCnt: 0 },
    { isCurrentPicture: true, pictureOrderCnt: 1 },
  ]);
});
