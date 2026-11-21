import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { CabacDecoder, CTX } from '../src/hevc/cabac.js';
import { deblockPicture } from '../src/hevc/deblock.js';
import { isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal.js';
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

type ExplicitRdpcmPicture = {
  slices: Uint8Array[];
  expectedPlaneMd5s: string[] | null;
};

function readDecodedPictureHash(nal: Uint8Array): string[] | null {
  const rbsp = toRbsp(nal);
  let offset = 0;
  while (offset < rbsp.length) {
    let payloadType = 0;
    while (offset < rbsp.length && rbsp[offset] === 0xff) {
      payloadType += 255;
      offset++;
    }
    if (offset >= rbsp.length) break;
    payloadType += rbsp[offset++];

    let payloadSize = 0;
    while (offset < rbsp.length && rbsp[offset] === 0xff) {
      payloadSize += 255;
      offset++;
    }
    if (offset >= rbsp.length) break;
    payloadSize += rbsp[offset++];
    const payload = rbsp.subarray(offset, offset + payloadSize);
    if (payload.length !== payloadSize)
      throw new Error('truncated Explicit RDPCM decoded_picture_hash SEI');
    offset += payloadSize;

    if (payloadType !== 132) continue;
    if (payload[0] !== 0 || payload.length !== 49)
      throw new Error('expected a three-plane MD5 Explicit RDPCM decoded_picture_hash');
    return [0, 1, 2].map((plane) =>
      Buffer.from(payload.subarray(1 + plane * 16, 1 + (plane + 1) * 16)).toString('hex'),
    );
  }
  return null;
}

it('reconstructs all pictures in the official Explicit RDPCM A vector', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/explicit-rdpcm-a-bbc-1.bit', import.meta.url)),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    'f8ba09b0ab7fcd9d9bcab1868f16344f97fab0ef719126132e3f1a1909cb3918',
  );

  const nals = splitAnnexB(bytes);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official Explicit RDPCM A stream has no SPS/PPS');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  expect([
    sps.picWidthInLumaSamples,
    sps.picHeightInLumaSamples,
    sps.chromaFormatIdc,
    sps.bitDepthLuma,
    sps.bitDepthChroma,
    sps.explicitRdpcmEnabled,
  ]).toEqual([1280, 720, 3, 8, 8, true]);

  const pictures: ExplicitRdpcmPicture[] = [];
  let currentPicture: ExplicitRdpcmPicture | null = null;
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (isSliceNal(nal.type)) {
      const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
      if (header.firstSliceInPic) {
        currentPicture = { slices: [], expectedPlaneMd5s: null };
        pictures.push(currentPicture);
      }
      if (!currentPicture) throw new Error('Explicit RDPCM slice precedes its first picture');
      currentPicture.slices.push(nal.data);
      if (!header.dependentSliceSegment) previousHeader = header;
    } else if (nal.type === 40 && currentPicture) {
      const decodedPictureHash = readDecodedPictureHash(nal.data);
      if (decodedPictureHash) {
        if (currentPicture.expectedPlaneMd5s)
          throw new Error('duplicate Explicit RDPCM decoded_picture_hash SEI');
        currentPicture.expectedPlaneMd5s = decodedPictureHash;
      }
    }
  }
  expect(pictures).toHaveLength(600);
  expect(pictures.every((picture) => picture.expectedPlaneMd5s !== null)).toBe(true);

  const headers = pictures.map((picture) => parseSliceHeader(picture.slices[0], sps, pps));
  const picturePocs: number[] = [];
  let previousTid0Poc: number | null = null;
  for (const [index, header] of headers.entries()) {
    const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
    picturePocs.push(poc);
    if ((pictures[index].slices[0][1] & 7) - 1 === 0) previousTid0Poc = poc;
  }
  expect(new Set(picturePocs).size).toBe(pictures.length);

  // Keep a decoded picture only through the last later RPS that names it.
  // The official stream needs at most four retained references, so all 600
  // hashes can be checked without keeping every reconstructed frame in memory.
  const pictureIndexByPoc = new Map(picturePocs.map((poc, index) => [poc, index]));
  const lastReferenceUse = new Array<number>(pictures.length).fill(-1);
  const maxPocLsb = 1 << sps.log2MaxPicOrderCntLsb;
  for (let index = 0; index < headers.length; index++) {
    const currentPoc = picturePocs[index];
    const references = new Set<number>();
    const rps = headers[index].shortTermRefPicSet;
    if (rps) {
      for (const delta of [...rps.deltaPocS0, ...rps.deltaPocS1])
        references.add(currentPoc + delta);
    }
    for (const reference of headers[index].longTermRefPics) {
      if (reference.deltaPocMsbPresent) {
        references.add(
          currentPoc -
            reference.deltaPocMsbCycle * maxPocLsb -
            (currentPoc & (maxPocLsb - 1)) +
            reference.pocLsb,
        );
      } else {
        for (let priorIndex = 0; priorIndex < index; priorIndex++) {
          if ((picturePocs[priorIndex] & (maxPocLsb - 1)) === reference.pocLsb)
            lastReferenceUse[priorIndex] = Math.max(lastReferenceUse[priorIndex], index);
        }
      }
    }
    for (const referencePoc of references) {
      const referenceIndex = pictureIndexByPoc.get(referencePoc);
      if (referenceIndex === undefined || referenceIndex >= index)
        throw new Error(
          `official Explicit RDPCM picture ${index} has invalid reference POC ${referencePoc}`,
        );
      lastReferenceUse[referenceIndex] = Math.max(lastReferenceUse[referenceIndex], index);
    }
  }

  const references: PictureReference[] = [];
  const frames: {
    poc: number;
    actualPlaneMd5s: string[];
    expectedPlaneMd5s: string[];
  }[] = [];
  const explicitRdpcmCounts: { poc: number; reads: number; ones: number }[] = [];
  let activeExplicitRdpcmCounts: { reads: number; ones: number } | null = null;
  let peakRetainedReferenceCount = 0;
  const originalDecodeBin = CabacDecoder.prototype.decodeBin;
  CabacDecoder.prototype.decodeBin = function (ctxIdx) {
    const value = originalDecodeBin.call(this, ctxIdx);
    if (
      activeExplicitRdpcmCounts &&
      (ctxIdx === CTX.EXPLICIT_RDPCM_FLAG || ctxIdx === CTX.EXPLICIT_RDPCM_FLAG + 1)
    ) {
      activeExplicitRdpcmCounts.reads++;
      activeExplicitRdpcmCounts.ones += value;
    }
    return value;
  };
  try {
    for (const [pictureIndex, picture] of pictures.entries()) {
      const { slices, expectedPlaneMd5s } = picture;
      if (!expectedPlaneMd5s)
        throw new Error(`Explicit RDPCM picture ${pictureIndex} has no decoded_picture_hash SEI`);
      const header = headers[pictureIndex];
      const poc = picturePocs[pictureIndex];
      let referenceList0: readonly PictureReference[] = [];
      let referenceList1: readonly PictureReference[] = [];
      if (header.sliceType === SLICE_TYPE_P) {
        referenceList0 = buildReferenceList0(sps, header, poc, references);
      } else if (header.sliceType === SLICE_TYPE_B) {
        const lists = buildBReferenceLists(sps, header, poc, references);
        referenceList0 = lists.l0;
        referenceList1 = lists.l1;
      } else if (header.sliceType !== SLICE_TYPE_I) {
        throw new Error(`unexpected Explicit RDPCM A slice type ${header.sliceType}`);
      }

      const rdpcmCounts = { reads: 0, ones: 0 };
      activeExplicitRdpcmCounts = rdpcmCounts;
      let decoded;
      try {
        decoded = new PictureDecoder(sps, pps, referenceList0, poc, referenceList1).decode(slices);
      } catch (error) {
        throw new Error(
          `Explicit RDPCM A picture ${pictureIndex} (POC ${poc}) failed to decode: ${String(error)}`,
          { cause: error },
        );
      } finally {
        activeExplicitRdpcmCounts = null;
      }
      deblockPicture(decoded, pps, sps.bitDepthLuma);
      applySao(decoded, sps, sps.bitDepthLuma);
      const actualPlaneMd5s = [decoded.y, decoded.cb, decoded.cr].map((plane) =>
        createHash('md5').update(Buffer.from(plane)).digest('hex'),
      );
      frames.push({ poc, actualPlaneMd5s, expectedPlaneMd5s });
      explicitRdpcmCounts.push({ poc, ...rdpcmCounts });
      references.push({
        ...decoded,
        pictureOrderCntLsb: header.pictureOrderCntLsb ?? 0,
        pictureOrderCnt: poc,
        isLongTermReference: false,
      });
      for (let referenceIndex = references.length - 1; referenceIndex >= 0; referenceIndex--) {
        const retainedPoc = references[referenceIndex].pictureOrderCnt;
        const retainedIndex = pictureIndexByPoc.get(retainedPoc);
        if (retainedIndex === undefined || lastReferenceUse[retainedIndex] <= pictureIndex)
          references.splice(referenceIndex, 1);
      }
      peakRetainedReferenceCount = Math.max(peakRetainedReferenceCount, references.length);
    }
  } finally {
    activeExplicitRdpcmCounts = null;
    CabacDecoder.prototype.decodeBin = originalDecodeBin;
  }

  expect(frames).toHaveLength(600);
  expect(frames.slice(0, 10).map((frame) => frame.poc)).toEqual([0, 8, 4, 2, 1, 3, 6, 5, 7, 16]);
  expect(peakRetainedReferenceCount).toBe(4);
  const codedRdpcmPicture = explicitRdpcmCounts.find((entry) => entry.poc === 16);
  expect(codedRdpcmPicture).toEqual({ poc: 16, reads: 299, ones: 68 });
  const displayOrder = frames.slice().sort((a, b) => a.poc - b.poc);
  for (const frame of displayOrder) {
    expect(frame.actualPlaneMd5s).toEqual(frame.expectedPlaneMd5s);
  }
}, 120_000);
