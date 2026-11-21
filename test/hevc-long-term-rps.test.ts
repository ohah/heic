import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { getHeicInfo, getItemPayload } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { decodeHevcPayload, decodeItemPlanes } from '../src/planes';
import { BitReader, isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal';
import { parsePps } from '../src/hevc/pps';
import { parseSps } from '../src/hevc/sps';
import {
  parseSliceHeader,
  SLICE_TYPE_B,
  SLICE_TYPE_I,
  SLICE_TYPE_P,
} from '../src/hevc/slice-header';
import { derivePictureOrderCnt } from '../src/hevc/reference-list';
import { wrapHevcPredChain } from '../scripts/lib/heif';

type Picture = {
  slice: Uint8Array;
  sps: ReturnType<typeof parseSps>;
  pps: ReturnType<typeof parsePps>;
  header: ReturnType<typeof parseSliceHeader>;
  poc: number;
  nalType: number;
  temporalId: number;
  expectedPlaneMd5s: string[] | null;
};

const startCode = Buffer.from([0, 0, 0, 1]);

function asAnnexB(nal: Uint8Array): Buffer {
  return Buffer.concat([startCode, Buffer.from(nal)]);
}

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
    if (payload.length !== payloadSize) throw new Error('truncated RPS_D decoded_picture_hash SEI');
    offset += payloadSize;

    if (payloadType !== 132) continue;
    if (payload[0] !== 0 || payload.length !== 49)
      throw new Error('expected a three-plane RPS_D decoded_picture_hash');
    return [0, 1, 2].map((plane) =>
      Buffer.from(payload.subarray(1 + plane * 16, 1 + (plane + 1) * 16)).toString('hex'),
    );
  }
  return null;
}

function planeMd5s(planes: readonly Uint8Array[]): string[] {
  return planes.map((plane) => createHash('md5').update(Buffer.from(plane)).digest('hex'));
}

function combinedPlaneMd5(planes: readonly Uint8Array[]): string {
  const hash = createHash('md5');
  for (const plane of planes) hash.update(Buffer.from(plane));
  return hash.digest('hex');
}

function isPreviousTid0Picture(picture: Pick<Picture, 'nalType' | 'temporalId'>): boolean {
  if (picture.temporalId !== 0) return false;
  // H.265 prevTid0Pic excludes RADL, RASL, and sub-layer non-reference pictures.
  if (picture.nalType >= 6 && picture.nalType <= 9) return false;
  return !(picture.nalType <= 5 && picture.nalType % 2 === 0);
}

function isReferencePicture(picture: Pick<Picture, 'nalType'>): boolean {
  return picture.nalType >= 16 && picture.nalType <= 21
    ? true
    : picture.nalType <= 9 && picture.nalType % 2 === 1;
}

function parsePictures(bitstream: Uint8Array): {
  pictures: Picture[];
  parameterNals: Uint8Array[];
} {
  const nals = splitAnnexB(bitstream);
  const spsById = new Map<number, ReturnType<typeof parseSps>>();
  const ppsById = new Map<number, ReturnType<typeof parsePps>>();
  const parameterNals: Uint8Array[] = [];
  const pictures: Picture[] = [];
  let currentPicture: Picture | null = null;
  let previousTid0Poc: number | null = null;

  for (const nal of nals) {
    if (nal.type === 32) parameterNals.push(nal.data);
    if (nal.type === 33) {
      const sps = parseSps(nal.data);
      spsById.set(sps.spsId, sps);
      parameterNals.push(nal.data);
    }
    if (nal.type === 34) {
      const pps = parsePps(nal.data);
      ppsById.set(pps.ppsId, pps);
      parameterNals.push(nal.data);
    }

    if (isSliceNal(nal.type)) {
      const reader = new BitReader(toRbsp(nal.data));
      reader.readBit(); // first_slice_segment_in_pic_flag
      if (nal.type >= 16 && nal.type <= 23) reader.readBit(); // no_output_of_prior_pics_flag
      const ppsId = reader.ue();
      const pps = ppsById.get(ppsId);
      if (!pps) throw new Error(`RPS_D slice references missing PPS ${ppsId}`);
      const sps = spsById.get(pps.spsId);
      if (!sps) throw new Error(`RPS_D PPS references missing SPS ${pps.spsId}`);
      const header = parseSliceHeader(nal.data, sps, pps);
      if (!header.firstSliceInPic)
        throw new Error('official RPS_D contains an unexpected slice segment');
      const temporalId = (nal.data[1] & 7) - 1;
      const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
      currentPicture = {
        slice: nal.data,
        sps,
        pps,
        header,
        poc,
        nalType: nal.type,
        temporalId,
        expectedPlaneMd5s: null,
      };
      pictures.push(currentPicture);
      if (isPreviousTid0Picture(currentPicture)) previousTid0Poc = poc;
    } else if (nal.type === 40 && currentPicture) {
      const expectedPlaneMd5s = readDecodedPictureHash(nal.data);
      if (expectedPlaneMd5s) {
        if (currentPicture.expectedPlaneMd5s)
          throw new Error(`duplicate RPS_D decoded-picture hash at POC ${currentPicture.poc}`);
        currentPicture.expectedPlaneMd5s = expectedPlaneMd5s;
      }
    }
  }

  return {
    pictures,
    parameterNals: [
      ...new Map(parameterNals.map((nal) => [Buffer.from(nal).toString('hex'), nal])).values(),
    ],
  };
}

function pictureReferenceState(pictures: readonly Picture[]): {
  directReferenceIndexes: number[][];
} {
  const directReferenceIndexes: number[][] = [];
  const dpb = new Set<number>();
  const maxPocLsb = 1 << pictures[0].sps.log2MaxPicOrderCntLsb;
  let previousTid0Index: number | null = null;

  const findEarlierIndex = (pictureIndex: number, targetPoc: number): number | null => {
    const matches = pictures
      .slice(0, pictureIndex)
      .map((candidate, index) => ({ candidate, index }))
      .filter(({ candidate }) => candidate.poc === targetPoc);
    if (matches.length > 1)
      throw new Error(
        `RPS_D POC ${pictures[pictureIndex].poc} resolves ${matches.length} prior pictures at POC ${targetPoc}`,
      );
    return matches[0]?.index ?? null;
  };

  for (const [pictureIndex, picture] of pictures.entries()) {
    const { header, poc } = picture;
    if (picture.nalType >= 16 && picture.nalType <= 20) dpb.clear();
    const currentRpsIndexes = new Set<number>();
    const currentIndexes = new Set<number>();
    const rps = header.shortTermRefPicSet;
    if (rps) {
      for (let i = 0; i < rps.deltaPocS0.length; i++) {
        const index = findEarlierIndex(pictureIndex, poc + rps.deltaPocS0[i]);
        if (index !== null) {
          if (dpb.has(index)) currentRpsIndexes.add(index);
          if (rps.usedByCurrPicS0[i]) {
            if (!dpb.has(index))
              throw new Error(
                `RPS_D POC ${poc} is missing used short-term DPB POC ${pictures[index].poc}`,
              );
            currentIndexes.add(index);
          }
        } else if (rps.usedByCurrPicS0[i]) {
          throw new Error(
            `RPS_D POC ${poc} is missing used short-term POC ${poc + rps.deltaPocS0[i]}`,
          );
        }
      }
      for (let i = 0; i < rps.deltaPocS1.length; i++) {
        const index = findEarlierIndex(pictureIndex, poc + rps.deltaPocS1[i]);
        if (index !== null) {
          if (dpb.has(index)) currentRpsIndexes.add(index);
          if (rps.usedByCurrPicS1[i]) {
            if (!dpb.has(index))
              throw new Error(
                `RPS_D POC ${poc} is missing used short-term DPB POC ${pictures[index].poc}`,
              );
            currentIndexes.add(index);
          }
        } else if (rps.usedByCurrPicS1[i]) {
          throw new Error(
            `RPS_D POC ${poc} is missing used short-term POC ${poc + rps.deltaPocS1[i]}`,
          );
        }
      }
    }

    for (const longTerm of header.longTermRefPics) {
      let targetIndex: number | null;
      if (longTerm.deltaPocMsbPresent) {
        const targetPoc =
          poc - longTerm.deltaPocMsbCycle * maxPocLsb - (poc & (maxPocLsb - 1)) + longTerm.pocLsb;
        targetIndex = findEarlierIndex(pictureIndex, targetPoc);
        if (targetIndex === null && longTerm.usedByCurrPic)
          throw new Error(`RPS_D POC ${poc} is missing used long-term POC ${targetPoc}`);
        if (targetIndex !== null && !dpb.has(targetIndex)) {
          if (longTerm.usedByCurrPic)
            throw new Error(
              `RPS_D POC ${poc} is missing used long-term DPB POC ${pictures[targetIndex].poc}`,
            );
          targetIndex = null;
        }
      } else {
        // Without an MSB cycle, the matching picture must still be in the DPB.
        const matches = [...dpb].filter(
          (index) => (pictures[index].poc & (maxPocLsb - 1)) === longTerm.pocLsb,
        );
        if (matches.length !== 1 && longTerm.usedByCurrPic)
          throw new Error(
            `RPS_D POC ${poc} has ${matches.length} retained long-term pictures with POC LSB ${longTerm.pocLsb}`,
          );
        targetIndex = matches.length === 1 ? matches[0] : null;
      }
      if (targetIndex !== null) {
        currentRpsIndexes.add(targetIndex);
        if (longTerm.usedByCurrPic) currentIndexes.add(targetIndex);
      }
    }

    const interSlice =
      picture.header.sliceType === SLICE_TYPE_P || picture.header.sliceType === SLICE_TYPE_B;
    if (interSlice && previousTid0Index !== null) currentIndexes.add(previousTid0Index);
    const sorted = interSlice ? [...currentIndexes].sort((a, b) => a - b) : [];
    directReferenceIndexes.push(
      !interSlice || previousTid0Index === null
        ? sorted
        : [...sorted.filter((index) => index !== previousTid0Index), previousTid0Index],
    );

    // RPS entries retain prior pictures; an absent POC can be a future or
    // unavailable entry, so only decoded DPB members are carried forward.
    dpb.clear();
    for (const index of currentRpsIndexes) dpb.add(index);
    if (isReferencePicture(picture)) dpb.add(pictureIndex);
    if (isPreviousTid0Picture(picture)) previousTid0Index = pictureIndex;
  }

  return { directReferenceIndexes };
}

type LongTermVector = {
  name: 'RPS_D' | 'RPS_E' | 'LTRPSPS';
  filename: string;
  sha256: string;
  pictureCount: number;
  iPictureCount: number;
  bPictureCount: number;
  rootIndex: number;
};

function verifyLongTermVector(vector: LongTermVector): void {
  const bitstream = new Uint8Array(
    readFileSync(new URL(`./fixtures/conformance/${vector.filename}`, import.meta.url)),
  );
  expect(createHash('sha256').update(bitstream).digest('hex')).toBe(vector.sha256);
  const { pictures, parameterNals } = parsePictures(bitstream);
  expect(pictures).toHaveLength(vector.pictureCount);
  expect(pictures.filter((picture) => picture.header.sliceType === SLICE_TYPE_I)).toHaveLength(
    vector.iPictureCount,
  );
  expect(pictures.filter((picture) => picture.header.sliceType === SLICE_TYPE_B)).toHaveLength(
    vector.bPictureCount,
  );
  expect(
    pictures.every((picture) =>
      vector.name === 'LTRPSPS'
        ? picture.expectedPlaneMd5s === null
        : picture.expectedPlaneMd5s !== null,
    ),
  ).toBe(true);
  expect(pictures.some((picture) => picture.header.longTermRefPics.length > 0)).toBe(true);
  expect(
    pictures.some((picture) =>
      picture.header.longTermRefPics.some((entry) => entry.deltaPocMsbPresent),
    ),
  ).toBe(vector.name === 'RPS_D');
  expect(
    pictures.some((picture) =>
      picture.header.longTermRefPics.some((entry) => !entry.deltaPocMsbPresent),
    ),
  ).toBe(true);

  const firstSps = pictures[0].sps;
  expect([firstSps.picWidthInLumaSamples, firstSps.picHeightInLumaSamples]).toEqual([416, 240]);
  expect([firstSps.bitDepthLuma, firstSps.bitDepthChroma, firstSps.chromaFormatIdc]).toEqual([
    8, 8, 1,
  ]);

  const streams = pictures.map((picture, index) =>
    Buffer.concat([...(index === 0 ? parameterNals.map(asAnnexB) : []), asAnnexB(picture.slice)]),
  );
  const { directReferenceIndexes } = pictureReferenceState(pictures);
  if (vector.name === 'RPS_D') {
    const noMsbLongTermUse = pictures.findIndex(
      (picture) =>
        picture.poc === 1281 &&
        picture.header.longTermRefPics.some(
          (entry) => entry.usedByCurrPic && !entry.deltaPocMsbPresent && entry.pocLsb === 249,
        ),
    );
    expect(noMsbLongTermUse).toBeGreaterThanOrEqual(0);
    const noMsbReferencePocs = directReferenceIndexes[noMsbLongTermUse].map(
      (index) => pictures[index].poc,
    );
    expect(noMsbReferencePocs).toContain(505);
    expect(noMsbReferencePocs).not.toContain(761);
    expect(noMsbReferencePocs).not.toContain(1017);
  } else if (vector.name === 'RPS_E') {
    expect(
      pictures.every((picture) =>
        picture.header.longTermRefPics.every((entry) => !entry.deltaPocMsbPresent),
      ),
    ).toBe(true);
    expect(pictures[vector.rootIndex].header.sliceType).toBe(SLICE_TYPE_B);
    expect(
      pictures[vector.rootIndex].header.longTermRefPics.some((entry) => entry.usedByCurrPic),
    ).toBe(true);
  } else {
    expect(firstSps.numLongTermRefPicsSps).toBe(8);
    expect(new Set(firstSps.longTermRefPicPocLsbSps).size).toBe(4);
    expect(pictures[vector.rootIndex].header.sliceType).toBe(SLICE_TYPE_B);
    expect(
      pictures[vector.rootIndex].header.longTermRefPics.some((entry) => entry.usedByCurrPic),
    ).toBe(true);
  }

  const predReferences = directReferenceIndexes.map((references) =>
    references.map((ref) => ref + 1),
  );
  const heif = wrapHevcPredChain(
    streams,
    predReferences,
    firstSps.picWidthInLumaSamples,
    firstSps.picHeightInLumaSamples,
    firstSps.bitDepthLuma,
    firstSps.chromaFormatIdc,
  );
  const boxes = parseISOBMFF(heif);
  const info = getHeicInfo(heif, boxes);
  if (!info.hvcC) throw new Error(`synthetic ${vector.name} HEIF graph has no hvcC`);

  const decoded: ReturnType<typeof decodeHevcPayload>[] = [];
  const reconstructedFrameHashes: { poc: number; md5: string }[] = [];
  let ffmpegFrameHashes: string[] | null = null;
  for (const [index, picture] of pictures.entries()) {
    const referenceIndexes = directReferenceIndexes[index];
    const payload = getItemPayload(heif, boxes, index + 1);
    if (!payload) throw new Error(`${vector.name} HEIF item ${index + 1} has no payload`);
    let planes: ReturnType<typeof decodeHevcPayload>;
    try {
      planes = decodeHevcPayload(
        payload,
        info.hvcC,
        referenceIndexes.map((referenceIndex) => decoded[referenceIndex]),
        `${vector.name} POC ${picture.poc}`,
      );
    } catch (error) {
      throw new Error(
        `${vector.name} picture ${index} POC ${picture.poc}, slice type ${picture.header.sliceType}, refs ${referenceIndexes.join(',')}`,
        { cause: error },
      );
    }
    // Standalone intra items do not carry a previous-Tid0 dependency. Keep
    // the known sequence POC for later reference-list resolution.
    planes.pictureOrderCnt = picture.poc;
    planes.pictureOrderCntLsb = picture.poc & ((1 << picture.sps.log2MaxPicOrderCntLsb) - 1);
    planes.temporalId = picture.temporalId;
    const actual = planeMd5s([planes.y, planes.cb, planes.cr]);
    if (picture.expectedPlaneMd5s)
      expect(actual, `official ${vector.name} POC ${picture.poc}`).toEqual(
        picture.expectedPlaneMd5s,
      );
    reconstructedFrameHashes.push({
      poc: picture.poc,
      md5: combinedPlaneMd5([planes.y, planes.cb, planes.cr]),
    });
    decoded.push(planes);
  }

  if (vector.name === 'LTRPSPS') {
    ffmpegFrameHashes = readFileSync(
      new URL('./fixtures/conformance/ltrpsps-a-qualcomm-1.ffmpeg-framemd5', import.meta.url),
      'utf8',
    )
      .split(/\r?\n/)
      .filter((line) => /^\s*0,/.test(line))
      .map((line) => line.split(',').at(-1)!.trim());
    expect(ffmpegFrameHashes).toHaveLength(vector.pictureCount);
    const displayOrderFrameHashes = reconstructedFrameHashes.sort((a, b) => a.poc - b.poc);
    expect(displayOrderFrameHashes.map((frame) => frame.poc)).toEqual(
      Array.from({ length: vector.pictureCount }, (_, poc) => poc),
    );
    expect(displayOrderFrameHashes.map((frame) => frame.md5)).toEqual(ffmpegFrameHashes);
  }

  const prefixLength = vector.rootIndex + 1;
  const heifPrefix = wrapHevcPredChain(
    streams.slice(0, prefixLength),
    predReferences.slice(0, prefixLength),
    firstSps.picWidthInLumaSamples,
    firstSps.picHeightInLumaSamples,
    firstSps.bitDepthLuma,
    firstSps.chromaFormatIdc,
  );
  const prefixBoxes = parseISOBMFF(heifPrefix);
  const prefixInfo = getHeicInfo(heifPrefix, prefixBoxes);
  const primary = decodeItemPlanes(heifPrefix, prefixBoxes, prefixInfo, prefixInfo.primaryItemId);
  expect(primary.pictureOrderCnt).toBe(pictures[vector.rootIndex].poc);
  if (pictures[vector.rootIndex].expectedPlaneMd5s) {
    expect(planeMd5s([primary.y, primary.cb, primary.cr])).toEqual(
      pictures[vector.rootIndex].expectedPlaneMd5s,
    );
  } else {
    if (!ffmpegFrameHashes) throw new Error(`${vector.name} has no FFmpeg reference hashes`);
    expect(combinedPlaneMd5([primary.y, primary.cb, primary.cr])).toBe(
      ffmpegFrameHashes[pictures[vector.rootIndex].poc],
    );
  }
}

describe('HEVC long-term reference pictures', () => {
  it('reconstructs every picture in the official RPS_D Ericsson vector', () => {
    verifyLongTermVector({
      name: 'RPS_D',
      filename: 'rps-d-ericsson-6.bit',
      sha256: 'e818e14f50bf73364b405ca3b07c407fdf191bcb2293552d3af8fc3bfcd1aca0',
      pictureCount: 68,
      iPictureCount: 5,
      bPictureCount: 0,
      rootIndex: 8,
    });
  });

  it('reconstructs every picture in the official RPS_E Qualcomm vector', () => {
    verifyLongTermVector({
      name: 'RPS_E',
      filename: 'rps-e-qualcomm-5.bit',
      sha256: 'b82c5c8c251943cc41b59e7f63f72890641fdcdbcec8e916223e4ee28a16c7ad',
      pictureCount: 300,
      iPictureCount: 10,
      bPictureCount: 290,
      rootIndex: 7,
    });
  }, 15_000);

  it('reconstructs every picture using SPS long-term reference candidates', () => {
    verifyLongTermVector({
      name: 'LTRPSPS',
      filename: 'ltrpsps-a-qualcomm-1.bit',
      sha256: '8f8e50fa408b7e96e76e6936b380fc34c208271efb8c283b15a42cb1f8c78ae7',
      pictureCount: 500,
      iPictureCount: 16,
      bPictureCount: 484,
      rootIndex: 11,
    });
  }, 15_000);
});
