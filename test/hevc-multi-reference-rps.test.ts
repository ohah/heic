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

type ShortTermRpsVector = {
  name: 'RPS_A' | 'RPS_B' | 'RPS_F';
  filename: string;
  sha256: string;
  outputMd5: string;
  pictureCount: number;
  iPictureCount: number;
  bPictureCount: number;
  requiresUnusedRpsEntries: boolean;
  checkPublicPredPath?: boolean;
};

function verifyShortTermRpsVector(vector: ShortTermRpsVector): void {
  const bytes = new Uint8Array(
    readFileSync(new URL(`./fixtures/conformance/${vector.filename}`, import.meta.url)),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(vector.sha256);
  const nals = splitAnnexB(bytes);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error(`official ${vector.name} stream lacks SPS or PPS`);

  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  expect(sps.shortTermRefPicSets).toHaveLength(11);
  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples]).toEqual([416, 240]);
  expect([sps.bitDepthLuma, sps.bitDepthChroma, sps.chromaFormatIdc]).toEqual([8, 8, 1]);

  const groups: { nals: Uint8Array[]; firstNalType: number }[] = [];
  let group: { nals: Uint8Array[]; firstNalType: number } | undefined;
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic && group) {
      groups.push(group);
      group = undefined;
    }
    if (!group) group = { nals: [], firstNalType: nal.type };
    group.nals.push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }
  if (group) groups.push(group);
  expect(groups).toHaveLength(vector.pictureCount);
  expect(groups.reduce((sum, picture) => sum + picture.nals.length, 0)).toBe(vector.pictureCount);

  const frames: {
    poc: number;
    y: Uint8Array | Uint16Array;
    cb: Uint8Array | Uint16Array;
    cr: Uint8Array | Uint16Array;
  }[] = [];
  const references: PictureReference[] = [];
  let previousTid0Poc: number | null = null;
  let sliceHeaderRpsCount = 0;
  let unusedRpsEntries = 0;
  let iPictureCount = 0;
  let bPictureCount = 0;

  for (const picture of groups) {
    const header = parseSliceHeader(picture.nals[0], sps, pps);
    const rps = header.shortTermRefPicSet;
    if (header.sliceType !== SLICE_TYPE_I) {
      if (!rps) throw new Error(`${vector.name} inter picture has no short-term RPS`);
      const isSpsSet = sps.shortTermRefPicSets.some(
        (candidate) =>
          JSON.stringify([
            candidate.deltaPocS0,
            candidate.usedByCurrPicS0,
            candidate.deltaPocS1,
            candidate.usedByCurrPicS1,
          ]) ===
          JSON.stringify([
            rps.deltaPocS0,
            rps.usedByCurrPicS0,
            rps.deltaPocS1,
            rps.usedByCurrPicS1,
          ]),
      );
      if (!isSpsSet) sliceHeaderRpsCount++;
      unusedRpsEntries +=
        rps.usedByCurrPicS0.filter((used) => !used).length +
        rps.usedByCurrPicS1.filter((used) => !used).length;
    }

    if (header.sliceType === SLICE_TYPE_I) iPictureCount++;
    if (header.sliceType === SLICE_TYPE_B) bPictureCount++;
    const temporalId = (picture.nals[0][1] & 7) - 1;
    const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
    let referencesL0: PictureReference[] = [];
    let referencesL1: PictureReference[] = [];
    if (header.sliceType === SLICE_TYPE_P)
      referencesL0 = buildReferenceList0(sps, header, poc, references);
    else if (header.sliceType === SLICE_TYPE_B) {
      const lists = buildBReferenceLists(sps, header, poc, references);
      referencesL0 = lists.l0;
      referencesL1 = lists.l1;
    }
    const decoded = new PictureDecoder(sps, pps, referencesL0, poc, referencesL1).decode(
      picture.nals,
    );
    deblockPicture(decoded, pps, sps.bitDepthLuma, sps.bitDepthChroma);
    applySao(decoded, sps, sps.bitDepthLuma, sps.bitDepthChroma);
    frames.push({ poc, y: decoded.y, cb: decoded.cb, cr: decoded.cr });
    references.push({
      ...decoded,
      pictureOrderCntLsb: header.pictureOrderCntLsb ?? 0,
      pictureOrderCnt: poc,
      isLongTermReference: false,
    });
    if (temporalId === 0 && ![6, 7, 8, 9].includes(picture.firstNalType)) previousTid0Poc = poc;
  }

  expect(iPictureCount).toBe(vector.iPictureCount);
  expect(bPictureCount).toBe(vector.bPictureCount);
  expect(sliceHeaderRpsCount).toBeGreaterThan(0);
  if (vector.requiresUnusedRpsEntries) expect(unusedRpsEntries).toBeGreaterThan(0);
  expect(frames.map((frame) => frame.poc).sort((a, b) => a - b)).toEqual(
    Array.from({ length: vector.pictureCount }, (_, poc) => poc),
  );
  const rootDecodedFrame = frames.at(-1)!;
  const hash = createHash('md5');
  for (const frame of frames.sort((a, b) => a.poc - b.poc)) {
    hash.update(Buffer.from(frame.y));
    hash.update(Buffer.from(frame.cb));
    hash.update(Buffer.from(frame.cr));
  }
  expect(hash.digest('hex')).toBe(vector.outputMd5);

  if (vector.checkPublicPredPath) {
    const decodedOrderPictures: {
      header: ReturnType<typeof parseSliceHeader>;
      poc: number;
      index: number;
      previousTid0Index: number | null;
    }[] = [];
    let predPreviousTid0Poc: number | null = null;
    let previousTid0Index: number | null = null;
    for (const [index, picture] of groups.entries()) {
      const header = parseSliceHeader(picture.nals[0], sps, pps);
      const poc = derivePictureOrderCnt(sps, header, predPreviousTid0Poc);
      decodedOrderPictures.push({
        header,
        poc,
        index,
        previousTid0Index,
      });
      if (
        (picture.nals[0][1] & 7) - 1 === 0 &&
        ![6, 7, 8, 9].includes(picture.firstNalType) &&
        !(picture.firstNalType <= 5 && picture.firstNalType % 2 === 0)
      ) {
        predPreviousTid0Poc = poc;
        previousTid0Index = index;
      }
    }
    const indexByPoc = new Map(decodedOrderPictures.map((picture) => [picture.poc, picture.index]));
    const predReferences = decodedOrderPictures.map((picture, pictureIndex) => {
      const predReferenceIndexes = new Set<number>();
      if (picture.header.sliceType !== SLICE_TYPE_I) {
        const rps = picture.header.shortTermRefPicSet;
        if (!rps) throw new Error(`${vector.name} POC ${picture.poc} has no short-term RPS`);
        for (const [deltas, usedFlags] of [
          [rps.deltaPocS0, rps.usedByCurrPicS0],
          [rps.deltaPocS1, rps.usedByCurrPicS1],
        ] as const) {
          for (let index = 0; index < deltas.length; index++) {
            if (!usedFlags[index]) continue;
            const targetPoc = picture.poc + deltas[index];
            const targetIndex = indexByPoc.get(targetPoc);
            if (targetIndex === undefined || targetIndex >= pictureIndex)
              throw new Error(
                `${vector.name} POC ${picture.poc} lacks prior reference ${targetPoc}`,
              );
            predReferenceIndexes.add(targetIndex);
          }
        }
        if (picture.header.longTermRefPics.some((reference) => reference.usedByCurrPic))
          throw new Error(`${vector.name} unexpectedly requires a long-term pred edge`);
        if (picture.previousTid0Index !== null) predReferenceIndexes.add(picture.previousTid0Index);
      }
      const ordered = [...predReferenceIndexes].sort((a, b) => a - b);
      if (picture.header.sliceType === SLICE_TYPE_I || picture.previousTid0Index === null)
        return ordered;
      return [
        ...ordered.filter((index) => index !== picture.previousTid0Index),
        picture.previousTid0Index,
      ];
    });
    const parameterNals = nals
      .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
      .map((nal) => nal.data);
    const asAnnexB = (units: readonly Uint8Array[]) =>
      Buffer.concat(units.flatMap((unit) => [Buffer.from([0, 0, 0, 1]), Buffer.from(unit)]));
    const streams = groups.map((picture, index) =>
      asAnnexB([...(index === 0 ? parameterNals : []), ...picture.nals]),
    );
    const heif = wrapHevcPredChain(
      streams,
      predReferences.map((referenceIndexes) => referenceIndexes.map((index) => index + 1)),
      sps.picWidthInLumaSamples,
      sps.picHeightInLumaSamples,
      sps.bitDepthLuma,
      sps.chromaFormatIdc,
    );
    const boxes = parseISOBMFF(heif);
    const info = getHeicInfo(heif, boxes);
    const primary = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
    const rootHeader = decodedOrderPictures.at(-1)!.header;
    // This synthetic one-picture-per-item graph does not preserve the source
    // sequence's absolute POC MSB history. Check the coded LSB and samples.
    expect(primary.pictureOrderCntLsb).toBe(rootHeader.pictureOrderCntLsb);
    const publicHash = createHash('md5');
    publicHash.update(Buffer.from(primary.y));
    publicHash.update(Buffer.from(primary.cb));
    publicHash.update(Buffer.from(primary.cr));
    const directHash = createHash('md5');
    directHash.update(Buffer.from(rootDecodedFrame.y));
    directHash.update(Buffer.from(rootDecodedFrame.cb));
    directHash.update(Buffer.from(rootDecodedFrame.cr));
    expect(publicHash.digest('hex')).toBe(directHash.digest('hex'));
  }
}

it('parses SPS and active L0 reference sets from the official RPS_C P-slice vector', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/rps-c-ericsson-5.bit', import.meta.url)),
  );
  const nals = splitAnnexB(bytes);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official RPS_C stream is missing its SPS or PPS');

  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  expect(sps.shortTermRefPicSets).toHaveLength(64);
  expect(sps.shortTermRefPicSets[1].deltaPocS0).toEqual(
    Array.from({ length: 15 }, (_, index) => -(index + 1)),
  );
  expect(sps.shortTermRefPicSets[63].usedByCurrPicS0.filter(Boolean)).toHaveLength(8);

  let previous: ReturnType<typeof parseSliceHeader> | undefined;
  let pictureCount = 0;
  let pPictureCount = 0;
  let maxActiveL0 = 0;
  let multiReferenceHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals.filter((entry) => isSliceNal(entry.type))) {
    const header = parseSliceHeader(nal.data, sps, pps, previous);
    if (!header.dependentSliceSegment) {
      previous = header;
      if (header.firstSliceInPic) pictureCount++;
      if (header.sliceType === SLICE_TYPE_P) {
        pPictureCount++;
        maxActiveL0 = Math.max(maxActiveL0, header.numRefIdxL0ActiveMinus1 + 1);
        if (header.numRefIdxL0ActiveMinus1 > 0 && !multiReferenceHeader)
          multiReferenceHeader = header;
        expect(header.pictureOrderCntLsb).not.toBeNull();
        expect(header.shortTermRefPicSet).not.toBeNull();
      }
    }
  }

  expect(pictureCount).toBe(40);
  expect(pPictureCount).toBe(39);
  expect(maxActiveL0).toBe(8);
  expect(pps.listsModificationPresent).toBe(false);

  expect(multiReferenceHeader).toBeDefined();
  const header = multiReferenceHeader!;
  const maxPocLsb = 1 << sps.log2MaxPicOrderCntLsb;
  const currentPocLsb = header.pictureOrderCntLsb!;
  const currentPoc = currentPocLsb;
  const wrap = (value: number): number => ((value % maxPocLsb) + maxPocLsb) % maxPocLsb;
  const tempPocs = [
    ...header.shortTermRefPicSet!.deltaPocS0.flatMap((delta, index) =>
      header.shortTermRefPicSet!.usedByCurrPicS0[index] ? [currentPoc + delta] : [],
    ),
    ...header.shortTermRefPicSet!.deltaPocS1.flatMap((delta, index) =>
      header.shortTermRefPicSet!.usedByCurrPicS1[index] ? [currentPoc + delta] : [],
    ),
  ];
  const tempReferences: PictureReference[] = tempPocs.map((pictureOrderCnt) => ({
    y: new Uint8Array(1),
    cb: new Uint8Array(1),
    cr: new Uint8Array(1),
    width: 1,
    height: 1,
    chromaFormatIdc: 0,
    hasExternalInterMotion: false,
    pictureOrderCntLsb: wrap(pictureOrderCnt),
    pictureOrderCnt,
    isLongTermReference: false,
  }));
  const activeCount = header.numRefIdxL0ActiveMinus1 + 1;
  const implicitList = buildReferenceList0(sps, header, currentPoc, tempReferences);
  expect(implicitList.map((reference) => reference.pictureOrderCnt)).toEqual(
    Array.from({ length: activeCount }, (_, index) => tempPocs[index % tempPocs.length]),
  );

  const modifiedHeader = {
    ...header,
    refPicListL0Modification: Array.from(
      { length: activeCount },
      (_, index) => (activeCount - index - 1) % tempPocs.length,
    ),
  };
  const modifiedList = buildReferenceList0(sps, modifiedHeader, currentPoc, tempReferences);
  expect(modifiedList.map((reference) => reference.pictureOrderCnt)).toEqual(
    modifiedHeader.refPicListL0Modification.map((index) => tempPocs[index]),
  );

  const oneEntryWithCurrent = buildReferenceList0(
    sps,
    {
      ...header,
      currentPictureReferenceEnabled: true,
      numRefIdxL0ActiveMinus1: 0,
      refPicListL0Modification: null,
    },
    currentPoc,
    tempReferences,
  );
  expect(oneEntryWithCurrent).toHaveLength(1);
  expect(oneEntryWithCurrent[0].isCurrentPicture).toBe(true);
  expect(oneEntryWithCurrent[0].isLongTermReference).toBe(true);

  const twoEntriesWithCurrent = buildReferenceList0(
    sps,
    {
      ...header,
      currentPictureReferenceEnabled: true,
      numRefIdxL0ActiveMinus1: 1,
      refPicListL0Modification: null,
    },
    currentPoc,
    tempReferences,
  );
  expect(twoEntriesWithCurrent.map((reference) => reference.isCurrentPicture ?? false)).toEqual([
    false,
    true,
  ]);
  expect(twoEntriesWithCurrent[0].pictureOrderCnt).toBe(tempPocs[0]);

  const modifiedCurrentList = buildReferenceList0(
    sps,
    {
      ...header,
      currentPictureReferenceEnabled: true,
      numRefIdxL0ActiveMinus1: 1,
      refPicListL0Modification: [tempPocs.length, 0],
    },
    currentPoc,
    tempReferences,
  );
  expect(modifiedCurrentList.map((reference) => reference.isCurrentPicture ?? false)).toEqual([
    true,
    false,
  ]);

  const currentOnlyHeader = {
    ...header,
    shortTermRefPicSet: {
      ...header.shortTermRefPicSet!,
      deltaPocS0: [],
      usedByCurrPicS0: [],
      deltaPocS1: [],
      usedByCurrPicS1: [],
    },
    longTermRefPics: [],
    currentPictureReferenceEnabled: true,
    numRefIdxL0ActiveMinus1: 0,
    refPicListL0Modification: null,
  };
  const currentOnlyList = buildReferenceList0(sps, currentOnlyHeader, currentPoc, []);
  expect(currentOnlyList).toHaveLength(1);
  expect(currentOnlyList[0].isCurrentPicture).toBe(true);
});

it('decodes all official RPS_C pictures to the archived reconstruction', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/rps-c-ericsson-5.bit', import.meta.url)),
  );
  const nals = splitAnnexB(bytes);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official RPS_C stream is missing its SPS or PPS');

  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  expect([sps.bitDepthLuma, sps.chromaFormatIdc]).toEqual([8, 1]);

  const groups: { nals: Uint8Array[]; firstNalType: number }[] = [];
  let group: { nals: Uint8Array[]; firstNalType: number } | undefined;
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic && group) {
      groups.push(group);
      group = undefined;
    }
    if (!group) group = { nals: [], firstNalType: nal.type };
    group.nals.push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }
  if (group) groups.push(group);

  const frames: {
    poc: number;
    y: Uint8Array | Uint16Array;
    cb: Uint8Array | Uint16Array;
    cr: Uint8Array | Uint16Array;
  }[] = [];
  const references: PictureReference[] = [];
  let previousTid0Poc: number | null = null;
  for (const picture of groups) {
    const header = parseSliceHeader(picture.nals[0], sps, pps);
    const temporalId = (picture.nals[0][1] & 7) - 1;
    const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
    const referenceList =
      header.sliceType === SLICE_TYPE_P ? buildReferenceList0(sps, header, poc, references) : [];
    const decoded = new PictureDecoder(sps, pps, referenceList, poc).decode(picture.nals);
    deblockPicture(decoded, pps, sps.bitDepthLuma);
    applySao(decoded, sps, sps.bitDepthLuma);
    frames.push({ poc, y: decoded.y, cb: decoded.cb, cr: decoded.cr });
    references.push({
      ...decoded,
      pictureOrderCntLsb: header.pictureOrderCntLsb ?? 0,
      pictureOrderCnt: poc,
      isLongTermReference: false,
    });
    if (temporalId === 0 && ![6, 7, 8, 9].includes(picture.firstNalType)) previousTid0Poc = poc;
  }

  expect(frames).toHaveLength(40);
  const hash = createHash('md5');
  for (const frame of frames.sort((a, b) => a.poc - b.poc)) {
    hash.update(Buffer.from(frame.y));
    hash.update(Buffer.from(frame.cb));
    hash.update(Buffer.from(frame.cr));
  }
  expect(hash.digest('hex')).toBe('0306b9e3ec365115ccb7060c0a437b32');
});

it('decodes official RPS_A slice-header inter-predicted reference sets', () => {
  verifyShortTermRpsVector({
    name: 'RPS_A',
    filename: 'rps-a-docomo-5.bit',
    sha256: 'e7a90335952dc5718d931adb461d90049eb558b4d08c90ff1706612f8bca4439',
    outputMd5: '7f4ad6c6b3de54558b0db59629b87db9',
    pictureCount: 44,
    iPictureCount: 2,
    bPictureCount: 42,
    requiresUnusedRpsEntries: false,
    checkPublicPredPath: true,
  });
});

it('decodes official RPS_B random slice-header reference sets', () => {
  verifyShortTermRpsVector({
    name: 'RPS_B',
    filename: 'rps-b-qualcomm-5.bit',
    sha256: 'a5e2097201740c15824b75540b6d0d5050763681bedf7209cde80d93a3b88996',
    outputMd5: '6d1ed392b067050ebd3a24a37281da03',
    pictureCount: 300,
    iPictureCount: 10,
    bPictureCount: 290,
    requiresUnusedRpsEntries: true,
    checkPublicPredPath: true,
  });
});

it('decodes official RPS_F inter-predicted sets with unused deltas', () => {
  verifyShortTermRpsVector({
    name: 'RPS_F',
    filename: 'rps-f-docomo-2.bit',
    sha256: '57588b676e3d1c2b82b761671c66383fac2b5c9c3eb98644c70a8e5fed486ed6',
    outputMd5: 'fd6e6d973d39622d197dbdf4543643f2',
    pictureCount: 50,
    iPictureCount: 2,
    bPictureCount: 48,
    requiresUnusedRpsEntries: true,
    checkPublicPredPath: true,
  });
});
