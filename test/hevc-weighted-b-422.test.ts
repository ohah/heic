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
  buildBReferenceLists,
  buildReferenceList0,
  derivePictureOrderCnt,
  type PictureReference,
} from '../src/hevc/reference-list.js';
import {
  parseSliceHeader,
  SLICE_TYPE_B,
  SLICE_TYPE_I,
  SLICE_TYPE_P,
} from '../src/hevc/slice-header.js';
import { parseSps } from '../src/hevc/sps.js';
import { decodeItemPlanes } from '../src/planes.js';
import { wrapHevcPredChain } from '../scripts/lib/heif.js';

const bitstream = new Uint8Array(
  readFileSync(
    new URL('./fixtures/regressions/hevc-weighted-b-422/weighted-b-422.hevc', import.meta.url),
  ),
);
const reconstruction = new Uint8Array(
  readFileSync(new URL('./fixtures/regressions/hevc-weighted-b-422/recon.y4m', import.meta.url)),
);

function readY4mFrames(bytes: Uint8Array): Buffer[] {
  const headerEnd = bytes.indexOf(0x0a);
  if (headerEnd < 0) throw new Error('x265 weighted-B reference has no Y4M header');
  const header = Buffer.from(bytes.subarray(0, headerEnd)).toString();
  expect(header).toContain('W128 H64');
  expect(header).toContain('C422p10');

  const frameSize = (128 * 64 + 2 * 64 * 64) * 2;
  const frames: Buffer[] = [];
  let offset = headerEnd + 1;
  while (offset < bytes.length) {
    const frameHeaderEnd = bytes.indexOf(0x0a, offset);
    if (frameHeaderEnd < 0) throw new Error('x265 weighted-B reference has a truncated frame tag');
    expect(Buffer.from(bytes.subarray(offset, frameHeaderEnd)).toString()).toBe('FRAME');
    const frameStart = frameHeaderEnd + 1;
    const frameEnd = frameStart + frameSize;
    if (frameEnd > bytes.length) throw new Error('x265 weighted-B reference has a truncated frame');
    frames.push(Buffer.from(bytes.subarray(frameStart, frameEnd)));
    offset = frameEnd;
  }
  return frames;
}

function asAnnexB(nals: readonly Uint8Array[]): Buffer {
  return Buffer.concat(nals.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), Buffer.from(nal)]));
}

function planeBytes(plane: Uint8Array | Uint16Array): Buffer {
  return Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength);
}

it('decodes weighted B prediction for 10-bit 4:2:2 through a HEIF pred graph', () => {
  expect(createHash('sha256').update(bitstream).digest('hex')).toBe(
    'e1e2b18132bf5acb9839371d9c0550a21069e80006e542384660f58a37c0772a',
  );
  expect(createHash('sha256').update(reconstruction).digest('hex')).toBe(
    '85d18cd49db923576071bacd82d667503d441eaafa43764a13c2405f7e424243',
  );

  const expectedFrames = readY4mFrames(reconstruction);
  expect(expectedFrames).toHaveLength(6);
  const nals = splitAnnexB(bitstream);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('weighted-B 4:2:2 stream has no SPS or PPS');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples, sps.chromaFormatIdc]).toEqual([
    128, 64, 2,
  ]);
  expect([sps.bitDepthLuma, sps.bitDepthChroma, pps.weightedBipred]).toEqual([10, 10, true]);

  const pictures: Uint8Array[][] = [];
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals.filter((entry) => isSliceNal(entry.type))) {
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic) pictures.push([]);
    if (!pictures.length) throw new Error('weighted-B slice appeared before its first picture');
    pictures[pictures.length - 1]!.push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }

  const references: PictureReference[] = [];
  const predReferenceIds: number[][] = [];
  const decodedFrames: {
    poc: number;
    y: Uint8Array | Uint16Array;
    cb: Uint8Array | Uint16Array;
    cr: Uint8Array | Uint16Array;
  }[] = [];
  let previousTid0Poc: number | null = null;
  let previousTid0ItemId: number | null = null;
  let weightedBCount = 0;
  const weightedBShapes: [number, number, number][] = [];
  for (const [pictureIndex, pictureNals] of pictures.entries()) {
    const header = parseSliceHeader(pictureNals[0]!, sps, pps);
    const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
    const temporalId = (pictureNals[0]![1]! & 7) - 1;
    let referenceList0: readonly PictureReference[] = [];
    let referenceList1: readonly PictureReference[] = [];
    if (header.sliceType === SLICE_TYPE_P) {
      referenceList0 = buildReferenceList0(sps, header, poc, references);
    } else if (header.sliceType === SLICE_TYPE_B) {
      const lists = buildBReferenceLists(sps, header, poc, references);
      referenceList0 = lists.l0;
      referenceList1 = lists.l1;
      if (!header.weightedPrediction)
        throw new Error(`weighted-B picture POC ${poc} has no weighted prediction table`);
      weightedBCount++;
      weightedBShapes.push([
        poc,
        header.weightedPrediction.l0.length,
        header.weightedPrediction.l1.length,
      ]);
    } else if (header.sliceType !== SLICE_TYPE_I) {
      throw new Error(`unexpected HEVC slice type ${header.sliceType}`);
    }

    const dependencies = new Set<number>();
    const addPocDependency = (referencePoc: number) => {
      const referenceIndex = decodedFrames.findIndex((frame) => frame.poc === referencePoc);
      if (referenceIndex < 0)
        throw new Error(
          `weighted-B picture ${pictureIndex} references unknown POC ${referencePoc}`,
        );
      dependencies.add(referenceIndex + 1);
    };
    if (header.sliceType !== SLICE_TYPE_I) {
      for (const reference of [...referenceList0, ...referenceList1])
        if (!reference.isCurrentPicture) addPocDependency(reference.pictureOrderCnt);
      const rps = header.shortTermRefPicSet;
      if (rps) {
        for (let index = 0; index < rps.deltaPocS0.length; index++)
          if (rps.usedByCurrPicS0[index]) addPocDependency(poc + rps.deltaPocS0[index]!);
        for (let index = 0; index < rps.deltaPocS1.length; index++)
          if (rps.usedByCurrPicS1[index]) addPocDependency(poc + rps.deltaPocS1[index]!);
      }
      if (previousTid0ItemId !== null) dependencies.add(previousTid0ItemId);
      predReferenceIds.push([...dependencies].sort((a, b) => a - b));
    } else {
      predReferenceIds.push([]);
    }

    const decoded = new PictureDecoder(sps, pps, referenceList0, poc, referenceList1).decode(
      pictureNals,
    );
    deblockPicture(decoded, pps, sps.bitDepthLuma, sps.bitDepthChroma);
    applySao(decoded, sps, sps.bitDepthLuma, sps.bitDepthChroma);
    const expected = expectedFrames[poc];
    if (!expected) throw new Error(`x265 reference has no display-order frame for POC ${poc}`);
    expect(
      Buffer.concat([planeBytes(decoded.y), planeBytes(decoded.cb), planeBytes(decoded.cr)]),
    ).toEqual(expected);
    decodedFrames.push({ poc, y: decoded.y, cb: decoded.cb, cr: decoded.cr });
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

  expect(pictures).toHaveLength(6);
  expect(weightedBCount).toBe(3);
  expect(decodedFrames.map(({ poc }) => poc)).toEqual([0, 1, 5, 3, 2, 4]);
  expect(weightedBShapes).toEqual([
    [3, 2, 1],
    [2, 2, 2],
    [4, 3, 1],
  ]);
  const parameterNals = nals
    .filter((nal) => nal.type >= 32 && nal.type <= 34)
    .map((nal) => nal.data);
  const heif = wrapHevcPredChain(
    [asAnnexB([...parameterNals, ...pictures[0]!]), ...pictures.slice(1).map(asAnnexB)],
    predReferenceIds,
    sps.picWidthInLumaSamples,
    sps.picHeightInLumaSamples,
    sps.bitDepthLuma,
    sps.chromaFormatIdc,
  );
  const boxes = parseISOBMFF(heif);
  const info = getHeicInfo(heif, boxes);
  const primary = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
  const finalFrame = decodedFrames.at(-1)!;
  expect(primary.pictureOrderCnt).toBe(finalFrame.poc);
  expect(primary.y).toEqual(finalFrame.y);
  expect(primary.cb).toEqual(finalFrame.cb);
  expect(primary.cr).toEqual(finalFrame.cr);
});
