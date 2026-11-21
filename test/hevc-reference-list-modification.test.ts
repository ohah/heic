import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { getHeicInfo, getItemPayload } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { decodeHevcPayload, decodeItemPlanes } from '../src/planes';
import { BitReader, isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal';
import { parsePps } from '../src/hevc/pps';
import { derivePictureOrderCnt } from '../src/hevc/reference-list';
import { parseSliceHeader, SLICE_TYPE_B, SLICE_TYPE_I } from '../src/hevc/slice-header';
import { parseSps } from '../src/hevc/sps';
import { wrapHevcPredChain } from '../scripts/lib/heif';

type SliceHeader = ReturnType<typeof parseSliceHeader>;
type Picture = {
  nals: Uint8Array[];
  headers: SliceHeader[];
  poc: number;
  nalType: number;
  temporalId: number;
  previousTid0Index: number | null;
};

type Vector = {
  name: 'RPLM_A' | 'RPLM_B';
  filename: string;
  sha256: string;
  outputMd5: string;
  pictureCount: number;
  sliceCount: number;
  pictureHasPerSliceListChanges: boolean;
  publicItemIndex: number | null;
};

type YuvFrame = {
  poc: number;
  y: Uint8Array | Uint16Array;
  cb: Uint8Array | Uint16Array;
  cr: Uint8Array | Uint16Array;
};

const startCode = Buffer.from([0, 0, 0, 1]);

function asAnnexB(nal: Uint8Array): Buffer {
  return Buffer.concat([startCode, Buffer.from(nal)]);
}

function isPreviousTid0Picture(picture: Pick<Picture, 'nalType' | 'temporalId'>): boolean {
  if (picture.temporalId !== 0) return false;
  if (picture.nalType >= 6 && picture.nalType <= 9) return false;
  return !(picture.nalType <= 5 && picture.nalType % 2 === 0);
}

function parseVector(bitstream: Uint8Array): {
  pictures: Picture[];
  parameterNals: Uint8Array[];
  sps: ReturnType<typeof parseSps>;
  pps: ReturnType<typeof parsePps>;
} {
  const spsById = new Map<number, ReturnType<typeof parseSps>>();
  const ppsById = new Map<number, ReturnType<typeof parsePps>>();
  const parameterNals: Uint8Array[] = [];
  const pictures: Picture[] = [];
  let currentPicture: Picture | null = null;
  let currentIndependentHeader: SliceHeader | undefined;
  let previousTid0Poc: number | null = null;
  let previousTid0Index: number | null = null;
  let firstSps: ReturnType<typeof parseSps> | null = null;
  let firstPps: ReturnType<typeof parsePps> | null = null;

  for (const nal of splitAnnexB(bitstream)) {
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
    if (!isSliceNal(nal.type)) continue;

    const reader = new BitReader(toRbsp(nal.data));
    const firstSliceInPic = reader.readBit() === 1;
    if (nal.type >= 16 && nal.type <= 23) reader.readBit();
    const ppsId = reader.ue();
    const pps = ppsById.get(ppsId);
    if (!pps) throw new Error(`RPLM slice references missing PPS ${ppsId}`);
    const sps = spsById.get(pps.spsId);
    if (!sps) throw new Error(`RPLM PPS references missing SPS ${pps.spsId}`);
    firstSps ??= sps;
    firstPps ??= pps;

    const header = parseSliceHeader(
      nal.data,
      sps,
      pps,
      firstSliceInPic ? undefined : currentIndependentHeader,
    );
    if (firstSliceInPic) {
      if (currentPicture && !currentPicture.headers.length)
        throw new Error('RPLM vector has an empty picture');
      const temporalId = (nal.data[1] & 7) - 1;
      const picture: Picture = {
        nals: [nal.data],
        headers: [header],
        poc: derivePictureOrderCnt(sps, header, previousTid0Poc),
        nalType: nal.type,
        temporalId,
        previousTid0Index,
      };
      pictures.push(picture);
      currentPicture = picture;
      currentIndependentHeader = header;
      if (isPreviousTid0Picture(picture)) {
        previousTid0Poc = picture.poc;
        previousTid0Index = pictures.length - 1;
      }
    } else {
      if (!currentPicture) throw new Error('RPLM vector starts with a non-first slice');
      currentPicture.nals.push(nal.data);
      currentPicture.headers.push(header);
      if (!header.dependentSliceSegment) currentIndependentHeader = header;
    }
  }

  if (!firstSps || !firstPps) throw new Error('RPLM vector has no parameter sets');
  return {
    pictures,
    parameterNals: [
      ...new Map(parameterNals.map((nal) => [Buffer.from(nal).toString('hex'), nal])).values(),
    ],
    sps: firstSps,
    pps: firstPps,
  };
}

function predReferenceIndexes(pictures: readonly Picture[]): number[][] {
  const indexesByPoc = new Map(pictures.map((picture, index) => [picture.poc, index]));
  return pictures.map((picture, pictureIndex) => {
    const references = new Set<number>();
    for (const header of picture.headers) {
      const rps = header.shortTermRefPicSet;
      if (!rps) continue;
      for (let i = 0; i < rps.deltaPocS0.length; i++) {
        if (!rps.usedByCurrPicS0[i]) continue;
        const targetPoc = picture.poc + rps.deltaPocS0[i];
        const targetIndex = indexesByPoc.get(targetPoc);
        if (targetIndex === undefined || targetIndex >= pictureIndex)
          throw new Error(`RPLM POC ${picture.poc} has unavailable short-term POC ${targetPoc}`);
        references.add(targetIndex);
      }
      for (let i = 0; i < rps.deltaPocS1.length; i++) {
        if (!rps.usedByCurrPicS1[i]) continue;
        const targetPoc = picture.poc + rps.deltaPocS1[i];
        const targetIndex = indexesByPoc.get(targetPoc);
        if (targetIndex === undefined || targetIndex >= pictureIndex)
          throw new Error(`RPLM POC ${picture.poc} has unavailable short-term POC ${targetPoc}`);
        references.add(targetIndex);
      }
      if (header.longTermRefPics.some((reference) => reference.usedByCurrPic))
        throw new Error('RPLM vectors unexpectedly use long-term references');
    }

    const isInterPicture = picture.headers[0].sliceType !== SLICE_TYPE_I;
    if (isInterPicture && picture.previousTid0Index !== null)
      references.add(picture.previousTid0Index);
    const ordered = [...references].sort((a, b) => a - b);
    if (!isInterPicture || picture.previousTid0Index === null) return ordered;
    return [
      ...ordered.filter((index) => index !== picture.previousTid0Index),
      picture.previousTid0Index,
    ];
  });
}

function vectorOutputMd5(frames: readonly YuvFrame[]): string {
  const hash = createHash('md5');
  for (const frame of [...frames].sort((a, b) => a.poc - b.poc)) {
    hash.update(Buffer.from(frame.y));
    hash.update(Buffer.from(frame.cb));
    hash.update(Buffer.from(frame.cr));
  }
  return hash.digest('hex');
}

function verifyRplmVector(vector: Vector): void {
  const bitstream = new Uint8Array(
    readFileSync(new URL(`./fixtures/conformance/${vector.filename}`, import.meta.url)),
  );
  expect(createHash('sha256').update(bitstream).digest('hex')).toBe(vector.sha256);
  const { pictures, parameterNals, sps, pps } = parseVector(bitstream);
  expect(pictures).toHaveLength(vector.pictureCount);
  expect(pictures.reduce((sum, picture) => sum + picture.nals.length, 0)).toBe(vector.sliceCount);
  expect(pictures.filter((picture) => picture.headers[0].sliceType === SLICE_TYPE_I)).toHaveLength(
    10,
  );
  expect(pictures.filter((picture) => picture.headers[0].sliceType === SLICE_TYPE_B)).toHaveLength(
    290,
  );
  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples]).toEqual([416, 240]);
  expect([sps.bitDepthLuma, sps.bitDepthChroma, sps.chromaFormatIdc]).toEqual([8, 8, 1]);
  expect(pps.listsModificationPresent).toBe(true);

  const allHeaders = pictures.flatMap((picture) => picture.headers);
  expect(allHeaders.some((header) => header.refPicListL0Modification !== null)).toBe(true);
  expect(allHeaders.some((header) => header.refPicListL1Modification !== null)).toBe(true);
  const hasPerSliceListChanges = pictures.some(
    (picture) =>
      new Set(
        picture.headers.map((header) =>
          JSON.stringify([
            header.refPicListL0Modification,
            header.refPicListL1Modification,
            header.numRefIdxL0ActiveMinus1,
            header.numRefIdxL1ActiveMinus1,
          ]),
        ),
      ).size > 1,
  );
  expect(hasPerSliceListChanges).toBe(vector.pictureHasPerSliceListChanges);

  const referenceIndexes = predReferenceIndexes(pictures);
  const streams = pictures.map((picture, index) =>
    Buffer.concat([
      ...(index === 0 ? parameterNals.map(asAnnexB) : []),
      ...picture.nals.map(asAnnexB),
    ]),
  );
  const heif = wrapHevcPredChain(
    streams,
    referenceIndexes.map((references) => references.map((index) => index + 1)),
    sps.picWidthInLumaSamples,
    sps.picHeightInLumaSamples,
    sps.bitDepthLuma,
    sps.chromaFormatIdc,
  );
  const boxes = parseISOBMFF(heif);
  const info = getHeicInfo(heif, boxes);
  if (!info.hvcC) throw new Error(`synthetic ${vector.name} HEIF graph has no hvcC`);

  const decoded: ReturnType<typeof decodeHevcPayload>[] = [];
  for (const [index, picture] of pictures.entries()) {
    const payload = getItemPayload(heif, boxes, index + 1);
    if (!payload) throw new Error(`${vector.name} HEIF item ${index + 1} has no payload`);
    const isIntra = picture.headers[0].sliceType === SLICE_TYPE_I;
    const references = isIntra
      ? []
      : referenceIndexes[index].map((referenceIndex) => decoded[referenceIndex]);
    let planes: ReturnType<typeof decodeHevcPayload>;
    try {
      planes = decodeHevcPayload(
        payload,
        info.hvcC,
        references,
        `${vector.name} POC ${picture.poc}`,
      );
    } catch (error) {
      throw new Error(
        `${vector.name} picture ${index} POC ${picture.poc}, slices ${picture.nals.length}: ${String(error)}`,
        { cause: error },
      );
    }
    if (!isIntra) expect(planes.pictureOrderCnt).toBe(picture.poc);
    planes.pictureOrderCnt = picture.poc;
    planes.pictureOrderCntLsb = picture.poc & ((1 << sps.log2MaxPicOrderCntLsb) - 1);
    planes.temporalId = picture.temporalId;
    decoded.push(planes);
  }

  expect(decoded.map((frame) => frame.pictureOrderCnt!).sort((a, b) => a - b)).toEqual(
    Array.from({ length: vector.pictureCount }, (_, poc) => poc),
  );
  const decodedFrames = decoded.map((frame) => ({
    poc: frame.pictureOrderCnt!,
    y: frame.y,
    cb: frame.cb,
    cr: frame.cr,
  }));
  expect(vectorOutputMd5(decodedFrames)).toBe(vector.outputMd5);

  if (vector.publicItemIndex !== null) {
    const prefixLength = vector.publicItemIndex + 1;
    const prefix = wrapHevcPredChain(
      streams.slice(0, prefixLength),
      referenceIndexes
        .slice(0, prefixLength)
        .map((references) => references.map((index) => index + 1)),
      sps.picWidthInLumaSamples,
      sps.picHeightInLumaSamples,
      sps.bitDepthLuma,
      sps.chromaFormatIdc,
    );
    const prefixBoxes = parseISOBMFF(prefix);
    const prefixInfo = getHeicInfo(prefix, prefixBoxes);
    const primary = decodeItemPlanes(prefix, prefixBoxes, prefixInfo, prefixInfo.primaryItemId);
    const expected = decoded[vector.publicItemIndex];
    expect(primary.pictureOrderCnt).toBe(expected.pictureOrderCnt);
    expect(
      vectorOutputMd5([
        { poc: primary.pictureOrderCnt!, y: primary.y, cb: primary.cb, cr: primary.cr },
      ]),
    ).toBe(vectorOutputMd5([decodedFrames[vector.publicItemIndex]]));
  }
}

it('decodes official RPLM_A with varying active B reference lists', () => {
  verifyRplmVector({
    name: 'RPLM_A',
    filename: 'rplm-a-qualcomm-4.bit',
    sha256: 'b2994be2579c6835a16d14e8404470caa97d72d45312500703c59f3189075caa',
    outputMd5: '011794872709c341880ee42ade036ed3',
    pictureCount: 300,
    sliceCount: 300,
    pictureHasPerSliceListChanges: false,
    publicItemIndex: null,
  });
}, 30_000);

it('decodes official multi-slice RPLM_B with slice-specific B reference lists', () => {
  verifyRplmVector({
    name: 'RPLM_B',
    filename: 'rplm-b-qualcomm-4.bit',
    sha256: '18d7bc82140f7f117acb48eb62c63d6dcda453bee0eda0975172b1c6012c4be2',
    outputMd5: '653ac7c46fa7b9d7d966e3db317eb938',
    pictureCount: 300,
    sliceCount: 900,
    pictureHasPerSliceListChanges: true,
    publicItemIndex: 2,
  });
}, 30_000);
