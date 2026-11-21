import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { getHeicInfo } from '../src/container/heic.js';
import { parseISOBMFF } from '../src/container/heif.js';
import { deblockPicture } from '../src/hevc/deblock.js';
import { isSliceNal, splitAnnexB } from '../src/hevc/nal.js';
import { PictureDecoder } from '../src/hevc/picture.js';
import { parsePps } from '../src/hevc/pps.js';
import { applySao } from '../src/hevc/sao.js';
import {
  parseSliceHeader,
  SLICE_TYPE_B,
  SLICE_TYPE_I,
  SLICE_TYPE_P,
} from '../src/hevc/slice-header.js';
import {
  buildBReferenceLists,
  buildReferenceList0,
  derivePictureOrderCnt,
  type PictureReference,
} from '../src/hevc/reference-list.js';
import { parseSps } from '../src/hevc/sps.js';
import { decodeItemPlanes } from '../src/planes.js';
import { wrapHevcPredChain } from '../scripts/lib/heif.js';

it('parses both weighted prediction lists in the official WP_B vector', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/wp-b-toshiba-3.bit', import.meta.url)),
  );
  expect(createHash('md5').update(bytes).digest('hex')).toBe('7715fd0ee2cd80d90c104e405964c844');
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    'c638c1c1052639ac52bf6c1ffe5b5bee55484ccfb56c13bcdc2a085fdb066799',
  );

  const nals = splitAnnexB(bytes);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  const sliceNals = nals.filter((nal) => isSliceNal(nal.type));
  if (!spsNal || !ppsNal || sliceNals.length !== 256)
    throw new Error('official WP_B stream is missing its parameter sets or 256 picture slices');

  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples, sps.chromaFormatIdc]).toEqual([
    416, 240, 1,
  ]);
  expect([pps.weightedPred, pps.weightedBipred]).toEqual([true, true]);

  const weightedBHeaders: {
    poc: number | null;
    l0: number;
    l1: number;
    weightedPrediction: NonNullable<ReturnType<typeof parseSliceHeader>['weightedPrediction']>;
  }[] = [];
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  let intraCount = 0;
  for (const nal of sliceNals) {
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (!header.dependentSliceSegment) previousHeader = header;
    if (header.sliceType === SLICE_TYPE_I) {
      intraCount++;
      continue;
    }
    if (header.sliceType !== SLICE_TYPE_B || !header.weightedPrediction)
      throw new Error('official WP_B stream contains a non-weighted B picture');
    const weighted = header.weightedPrediction;
    const l0Count = header.numRefIdxL0ActiveMinus1 + 1;
    const l1Count = header.numRefIdxL1ActiveMinus1 + 1;
    expect([weighted.l0.length, weighted.l1.length]).toEqual([l0Count, l1Count]);
    weightedBHeaders.push({
      poc: header.pictureOrderCntLsb,
      l0: l0Count,
      l1: l1Count,
      weightedPrediction: weighted,
    });
  }

  expect(intraCount).toBe(4);
  expect(weightedBHeaders).toHaveLength(252);
  expect(Math.max(...weightedBHeaders.map((header) => header.l0))).toBe(4);
  expect(Math.max(...weightedBHeaders.map((header) => header.l1))).toBe(4);
  expect(weightedBHeaders[0]).toMatchObject({
    poc: 8,
    l0: 1,
    l1: 1,
    weightedPrediction: {
      lumaLog2WeightDenom: 7,
      chromaLog2WeightDenom: 3,
      l0: [{ lumaWeight: 118, lumaOffset: -1, chromaWeight: [8, 8], chromaOffset: [0, 0] }],
      l1: [{ lumaWeight: 117, lumaOffset: 1, chromaWeight: [8, 8], chromaOffset: [0, 0] }],
    },
  });
  expect(createHash('sha256').update(JSON.stringify(weightedBHeaders)).digest('hex')).toBe(
    '039b8948b9d1bbb2fe4d73e80b8c52adff95745e9228dcf3436f53d8bc32a381',
  );
});

it('reconstructs the official weighted B-slice conformance sequence', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/wp-b-toshiba-3.bit', import.meta.url)),
  );
  const nals = splitAnnexB(bytes);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official WP_B stream has no SPS/PPS');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const pictures: Uint8Array[][] = [];
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals.filter((entry) => isSliceNal(entry.type))) {
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic) pictures.push([]);
    if (pictures.length === 0) throw new Error('WP_B slice appeared before the first picture');
    pictures[pictures.length - 1].push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }

  const references: PictureReference[] = [];
  const predReferenceIds: number[][] = [];
  const frames: {
    poc: number;
    y: Uint8Array | Uint16Array;
    cb: Uint8Array | Uint16Array;
    cr: Uint8Array | Uint16Array;
  }[] = [];
  let previousTid0Poc: number | null = null;
  let previousTid0ItemId: number | null = null;
  for (let pictureIndex = 0; pictureIndex < pictures.length; pictureIndex++) {
    const pictureNals = pictures[pictureIndex];
    const header = parseSliceHeader(pictureNals[0], sps, pps);
    const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
    const temporalId = (pictureNals[0][1] & 7) - 1;
    let referenceList0: readonly PictureReference[] = [];
    let referenceList1: readonly PictureReference[] = [];
    if (header.sliceType === SLICE_TYPE_P) {
      referenceList0 = buildReferenceList0(sps, header, poc, references);
    } else if (header.sliceType === SLICE_TYPE_B) {
      const lists = buildBReferenceLists(sps, header, poc, references);
      referenceList0 = lists.l0;
      referenceList1 = lists.l1;
    }
    if (header.sliceType !== SLICE_TYPE_I) {
      const dependencies = new Set<number>();
      const addPocDependency = (referencePoc: number) => {
        const referenceIndex = frames.findIndex((frame) => frame.poc === referencePoc);
        if (referenceIndex < 0)
          throw new Error(`WP_B picture ${pictureIndex} references unknown POC ${referencePoc}`);
        dependencies.add(referenceIndex + 1);
      };
      for (const reference of [...referenceList0, ...referenceList1]) {
        if (reference.isCurrentPicture) continue;
        addPocDependency(reference.pictureOrderCnt);
      }
      // The active L0/L1 lists can be shorter than NumPicTotalCurr. Keep every
      // used RPS picture as a direct predecessor so later items retain the
      // decoded-picture buffer across a sparse HEIF pred graph.
      const rps = header.shortTermRefPicSet;
      if (rps) {
        for (let i = 0; i < rps.deltaPocS0.length; i++)
          if (rps.usedByCurrPicS0[i]) addPocDependency(poc + rps.deltaPocS0[i]);
        for (let i = 0; i < rps.deltaPocS1.length; i++)
          if (rps.usedByCurrPicS1[i]) addPocDependency(poc + rps.deltaPocS1[i]);
      }
      const maxPocLsb = 1 << sps.log2MaxPicOrderCntLsb;
      for (const reference of header.longTermRefPics) {
        if (!reference.usedByCurrPic) continue;
        if (reference.deltaPocMsbPresent) {
          addPocDependency(
            poc -
              reference.deltaPocMsbCycle * maxPocLsb -
              (poc & (maxPocLsb - 1)) +
              reference.pocLsb,
          );
        } else {
          const matches = frames.filter(
            (frame) => (frame.poc & (maxPocLsb - 1)) === reference.pocLsb,
          );
          if (matches.length !== 1)
            throw new Error(
              `WP_B picture ${pictureIndex} has ${matches.length} prior frames matching long-term POC LSB ${reference.pocLsb}`,
            );
          addPocDependency(matches[0].poc);
        }
      }
      // POC derivation needs the previous Tid0 picture even when it is not
      // part of this picture's active motion-compensation lists.
      if (previousTid0ItemId !== null) dependencies.add(previousTid0ItemId);
      predReferenceIds.push([...dependencies].sort((a, b) => a - b));
    } else {
      predReferenceIds.push([]);
    }
    let decoded;
    try {
      decoded = new PictureDecoder(sps, pps, referenceList0, poc, referenceList1).decode(
        pictureNals,
      );
    } catch (error) {
      throw new Error(
        `WP_B picture ${pictureIndex} (POC ${poc}) failed to decode: ${String(error)}`,
        { cause: error },
      );
    }
    deblockPicture(decoded, pps, sps.bitDepthLuma);
    applySao(decoded, sps, sps.bitDepthLuma);
    frames.push({ poc, y: decoded.y, cb: decoded.cb, cr: decoded.cr });
    references.push({
      ...decoded,
      pictureOrderCntLsb: header.pictureOrderCntLsb ?? 0,
      pictureOrderCnt: poc,
      isLongTermReference: false,
    });
    if (temporalId === 0) {
      previousTid0Poc = poc;
      previousTid0ItemId = pictureIndex + 1;
    }
  }

  expect(pictures).toHaveLength(256);
  const displayOrder = frames.slice().sort((a, b) => a.poc - b.poc);
  const hash = createHash('md5');
  for (const frame of displayOrder) {
    hash.update(Buffer.from(frame.y));
    hash.update(Buffer.from(frame.cb));
    hash.update(Buffer.from(frame.cr));
  }
  // FFmpeg 9.0.1 decoding of the same official ISO/IEC 23008-8 WP_B vector.
  expect(hash.digest('hex')).toBe('82d39f8cd09e532b8fa9d35894c96258');

  const parameterNals = nals
    .filter((nal) => nal.type >= 32 && nal.type <= 34)
    .map((nal) => nal.data);
  const asAnnexB = (units: readonly Uint8Array[]) =>
    Buffer.concat(units.flatMap((unit) => [Buffer.from([0, 0, 0, 1]), Buffer.from(unit)]));
  const stillHeif = wrapHevcPredChain(
    [asAnnexB([...parameterNals, ...pictures[0]]), asAnnexB(pictures[1])],
    [[], [1]],
    sps.picWidthInLumaSamples,
    sps.picHeightInLumaSamples,
    sps.bitDepthLuma,
    sps.chromaFormatIdc,
  );
  const stillBoxes = parseISOBMFF(stillHeif);
  const stillInfo = getHeicInfo(stillHeif, stillBoxes);
  const stillPlanes = decodeItemPlanes(stillHeif, stillBoxes, stillInfo, stillInfo.primaryItemId);
  expect(stillPlanes.y).toEqual(frames[1].y);
  expect(stillPlanes.cb).toEqual(frames[1].cb);
  expect(stillPlanes.cr).toEqual(frames[1].cr);

  const completeChain = wrapHevcPredChain(
    [asAnnexB([...parameterNals, ...pictures[0]]), ...pictures.slice(1).map(asAnnexB)],
    predReferenceIds,
    sps.picWidthInLumaSamples,
    sps.picHeightInLumaSamples,
    sps.bitDepthLuma,
    sps.chromaFormatIdc,
  );
  const chainBoxes = parseISOBMFF(completeChain);
  const chainInfo = getHeicInfo(completeChain, chainBoxes);
  const finalHeifPlanes = decodeItemPlanes(
    completeChain,
    chainBoxes,
    chainInfo,
    chainInfo.primaryItemId,
  );
  const finalFrame = frames.at(-1);
  if (!finalFrame) throw new Error('official WP_B sequence has no final frame');
  expect(finalHeifPlanes.pictureOrderCnt).toBe(finalFrame.poc);
  expect(finalHeifPlanes.y).toEqual(finalFrame.y);
  expect(finalHeifPlanes.cb).toEqual(finalFrame.cb);
  expect(finalHeifPlanes.cr).toEqual(finalFrame.cr);
}, 45_000);
