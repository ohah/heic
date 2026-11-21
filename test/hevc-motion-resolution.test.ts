import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { deblockPicture } from '../src/hevc/deblock.js';
import { isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal.js';
import { applySao } from '../src/hevc/sao.js';
import {
  deriveIntegerMotionVectorComponent,
  quantizeMotionVectorToIntegerPel,
} from '../src/hevc/motion.js';
import { PictureDecoder } from '../src/hevc/picture.js';
import { parsePps } from '../src/hevc/pps.js';
import { parseSliceHeader, SLICE_TYPE_B, SLICE_TYPE_P } from '../src/hevc/slice-header.js';
import {
  buildBReferenceLists,
  buildReferenceList0,
  createCurrentPictureReference,
  derivePictureOrderCnt,
  type PictureReference,
} from '../src/hevc/reference-list.js';
import { parseSps } from '../src/hevc/sps.js';

it('derives integer-resolution motion vectors in quarter-sample storage units', () => {
  expect(deriveIntegerMotionVectorComponent(6, 1)).toBe(8);
  expect(deriveIntegerMotionVectorComponent(-6, 1)).toBe(-4);
  expect(deriveIntegerMotionVectorComponent(0, 8193)).toBe(-32764);
  expect(quantizeMotionVectorToIntegerPel(7)).toBe(4);
  expect(quantizeMotionVectorToIntegerPel(-7)).toBe(-8);
});

it('parses B-slice reference and motion-resolution syntax in the official MVRESIDC_B vector', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvresidc-b-ms-2.bit', import.meta.url)),
  );
  const nals = splitAnnexB(bytes);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  const slices = nals.filter((nal) => isSliceNal(nal.type));
  if (!spsNal || !ppsNal || slices.length !== 9)
    throw new Error('official MVRESIDC_B stream is missing its parameters or nine picture slices');

  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const headers = slices.map((slice) => parseSliceHeader(slice.data, sps, pps));
  expect(headers.map((header) => header.sliceType)).toEqual([
    SLICE_TYPE_P,
    ...Array<number>(8).fill(SLICE_TYPE_B),
  ]);
  expect(sps.screenContentExtension?.motionVectorResolutionControlIdc).toBe(1);
  expect(headers.every((header) => header.useIntegerMv)).toBe(true);
  expect(headers.slice(1).map((header) => header.numRefIdxL0ActiveMinus1 + 1)).toEqual([
    2, 3, 4, 5, 5, 5, 5, 5,
  ]);
  expect(headers.slice(1).map((header) => header.numRefIdxL1ActiveMinus1 + 1)).toEqual([
    1, 2, 3, 4, 4, 4, 4, 4,
  ]);
  expect(headers.slice(1).every((header) => header.shortTermRefPicSet !== null)).toBe(true);
  expect(headers.slice(1).every((header) => header.collocatedFromL0 === false)).toBe(true);
  expect(headers.slice(1).every((header) => header.mvdL1ZeroFlag)).toBe(true);
  expect(headers.slice(1).every((header) => header.weightedPrediction === null)).toBe(true);
});

it('constructs both reference lists for every official MVRESIDC_B picture', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvresidc-b-ms-2.bit', import.meta.url)),
  );
  const nals = splitAnnexB(bytes);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  const slices = nals.filter((nal) => isSliceNal(nal.type));
  if (!spsNal || !ppsNal || slices.length !== 9)
    throw new Error('official MVRESIDC_B stream is missing its parameters or nine picture slices');

  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const headers = slices.map((slice) => parseSliceHeader(slice.data, sps, pps));
  const makeReference = (poc: number): PictureReference => ({
    y: new Uint8Array(1),
    cb: new Uint8Array(1),
    cr: new Uint8Array(1),
    width: 1,
    height: 1,
    chromaFormatIdc: 3,
    hasExternalInterMotion: false,
    pictureOrderCntLsb: poc,
    pictureOrderCnt: poc,
    isLongTermReference: false,
  });
  const references = [makeReference(0)];
  const expectedLists = [
    [[0, 1], [0]],
    [
      [1, 0, 2],
      [1, 0],
    ],
    [
      [2, 1, 0, 3],
      [2, 1, 0],
    ],
    [
      [3, 2, 1, 0, 4],
      [3, 2, 1, 0],
    ],
    [
      [4, 3, 2, 0, 5],
      [4, 3, 2, 0],
    ],
    [
      [5, 4, 3, 0, 6],
      [5, 4, 3, 0],
    ],
    [
      [6, 5, 4, 0, 7],
      [6, 5, 4, 0],
    ],
    [
      [7, 6, 4, 0, 8],
      [7, 6, 4, 0],
    ],
  ];

  for (let index = 1; index < headers.length; index++) {
    const header = headers[index];
    const poc = header.pictureOrderCntLsb;
    if (poc === null) throw new Error(`B picture ${index} has no POC`);
    const currentPicture = makeReference(poc);
    const lists = buildBReferenceLists(sps, header, poc, references, currentPicture);
    expect(
      [lists.l0, lists.l1].map((list) => list.map((reference) => reference.pictureOrderCnt)),
    ).toEqual(expectedLists[index - 1]);
    references.push(currentPicture);
  }

  const firstBHeader = headers[1];
  const modifiedLists = buildBReferenceLists(
    sps,
    {
      ...firstBHeader,
      refPicListL0Modification: [1, 0],
      refPicListL1Modification: [1],
    },
    1,
    references.slice(0, 1),
    makeReference(1),
  );
  expect(
    [modifiedLists.l0, modifiedLists.l1].map((list) =>
      list.map((reference) => reference.pictureOrderCnt),
    ),
  ).toEqual([[1, 0], [1]]);
});

it('recognizes integer motion-vector control in the official MVRESIDC_B vector', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvresidc-b-ms-2.bit', import.meta.url)),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    'c7e21066c689bf0ccb80b60cb03663862777a45f0e68d40ed4e8fcf81287cf9e',
  );

  const nals = splitAnnexB(bytes);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  const firstSlice = nals.find((nal) => isSliceNal(nal.type));
  if (!spsNal || !ppsNal || !firstSlice)
    throw new Error('official MVRESIDC_B stream is missing parameter sets or its first slice');

  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const header = parseSliceHeader(firstSlice.data, sps, pps);
  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples]).toEqual([1280, 720]);
  expect(sps.chromaFormatIdc).toBe(3);
  expect(sps.screenContentExtension?.motionVectorResolutionControlIdc).toBe(1);
  expect(header.sliceType).toBe(SLICE_TYPE_P);
  expect(header.useIntegerMv).toBe(true);
  expect(header.currentPictureReferenceEnabled).toBe(true);

  const currentReferences = buildReferenceList0(sps, header, header.pictureOrderCntLsb ?? 0, []);
  const picture = new PictureDecoder(
    sps,
    pps,
    currentReferences,
    header.pictureOrderCntLsb ?? 0,
  ).decode([firstSlice.data]);
  deblockPicture(picture, pps, sps.bitDepthLuma);
  applySao(picture, sps, sps.bitDepthLuma);
  expect(
    [picture.y, picture.cb, picture.cr].map((plane) =>
      createHash('md5').update(Buffer.from(plane)).digest('hex'),
    ),
  ).toEqual([
    '8517c6623e90dfad948f2199d34e5bf4',
    'a216596ea8e205974ce119cd0ab3f484',
    '170c6da8f29375c8b4e732fe4858b18e',
  ]);
});

it('reconstructs all pictures in the official MVRESIDC_B current-picture-reference vector', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvresidc-b-ms-2.bit', import.meta.url)),
  );
  const nals = splitAnnexB(bytes);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  const slices = nals.filter((nal) => isSliceNal(nal.type));
  if (!spsNal || !ppsNal || slices.length !== 9)
    throw new Error('official MVRESIDC_B stream is missing its parameters or nine picture slices');

  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const references: PictureReference[] = [];
  let previousTid0Poc: number | null = null;
  for (const slice of slices) {
    const header = parseSliceHeader(slice.data, sps, pps);
    const currentPoc = derivePictureOrderCnt(sps, header, previousTid0Poc);
    const decodingOrderReferences = [...references];
    let referenceList0: PictureReference[] = [];
    let referenceList1: PictureReference[] = [];
    if (header.sliceType === SLICE_TYPE_P) {
      referenceList0 = buildReferenceList0(sps, header, currentPoc, decodingOrderReferences);
    } else {
      const currentPicture = header.currentPictureReferenceEnabled
        ? createCurrentPictureReference(sps, currentPoc)
        : undefined;
      const lists = buildBReferenceLists(
        sps,
        header,
        currentPoc,
        decodingOrderReferences,
        currentPicture,
      );
      referenceList0 = lists.l0;
      referenceList1 = lists.l1;
    }

    const picture = new PictureDecoder(sps, pps, referenceList0, currentPoc, referenceList1).decode(
      [slice.data],
    );
    deblockPicture(picture, pps, sps.bitDepthLuma, sps.bitDepthChroma);
    applySao(picture, sps, sps.bitDepthLuma, sps.bitDepthChroma);

    const sliceNalIndex = nals.indexOf(slice);
    const suffix = nals[sliceNalIndex + 1];
    if (!suffix || suffix.type !== 40)
      throw new Error(`official MVRESIDC_B POC ${currentPoc} has no decoded-picture-hash SEI`);
    const sei = toRbsp(suffix.data);
    expect(sei).toHaveLength(52);
    expect([sei[0], sei[1], sei[2], sei[51]]).toEqual([132, 49, 0, 128]);
    const expectedPlaneMd5s = [sei.subarray(3, 19), sei.subarray(19, 35), sei.subarray(35, 51)].map(
      (hash) => Buffer.from(hash).toString('hex'),
    );
    const actualPlaneMd5s = [picture.y, picture.cb, picture.cr].map((plane) =>
      createHash('md5').update(Buffer.from(plane)).digest('hex'),
    );
    expect(actualPlaneMd5s, `official MVRESIDC_B POC ${currentPoc}`).toEqual(expectedPlaneMd5s);

    references.push({
      ...picture,
      chromaFormatIdc: sps.chromaFormatIdc,
      bitDepthLuma: sps.bitDepthLuma,
      bitDepthChroma: sps.bitDepthChroma,
      pictureOrderCntLsb: header.pictureOrderCntLsb ?? 0,
      pictureOrderCnt: currentPoc,
      isLongTermReference: false,
    });
    const temporalId = slice.data.length > 1 ? (slice.data[1] & 7) - 1 : 0;
    if (temporalId === 0) previousTid0Poc = currentPoc;
  }
});
