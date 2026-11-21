import { HeicError } from '../errors.js';
import type { SliceHeader } from './slice-header.js';
import type { SpsInfo } from './sps.js';
import type { ReferenceImage } from './picture.js';

export interface BReferenceLists {
  l0: PictureReference[];
  l1: PictureReference[];
}

export interface PictureReference extends ReferenceImage {}

/** Inter-layer reference pictures split into Annex F's two list sets. */
export interface InterLayerReferencePictureSets {
  interLayer0: readonly PictureReference[];
  interLayer1: readonly PictureReference[];
}

/** Make the in-progress current picture that SCC can append to reference lists. */
export function createCurrentPictureReference(
  sps: SpsInfo,
  currentPictureOrderCnt: number,
): PictureReference {
  const maxPocLsb = 1 << sps.log2MaxPicOrderCntLsb;
  return {
    y: new Uint8Array(0),
    cb: new Uint8Array(0),
    cr: new Uint8Array(0),
    width: sps.picWidthInLumaSamples,
    height: sps.picHeightInLumaSamples,
    chromaFormatIdc: sps.chromaFormatIdc,
    bitDepthLuma: sps.bitDepthLuma,
    bitDepthChroma: sps.bitDepthChroma,
    layerId: sps.layerId ?? 0,
    pictureOrderCntLsb: currentPictureOrderCnt & (maxPocLsb - 1),
    pictureOrderCnt: currentPictureOrderCnt,
    isCurrentPicture: true,
    // H.265 8.3.2 marks the in-progress picture as long-term while it is
    // available for prediction from within the same coded picture.
    isLongTermReference: true,
    hasExternalInterMotion: false,
  };
}

/** Derive the full POC for this picture from the previous decoding-order picture. */
export function derivePictureOrderCnt(
  sps: SpsInfo,
  header: SliceHeader,
  previousPictureOrderCnt: number | null,
): number {
  const pocLsb = header.pictureOrderCntLsb;
  if (pocLsb === null) return 0;
  if (previousPictureOrderCnt === null) return pocLsb;

  const maxPocLsb = 1 << sps.log2MaxPicOrderCntLsb;
  const previousPocLsb = previousPictureOrderCnt & (maxPocLsb - 1);
  const previousPocMsb = previousPictureOrderCnt - previousPocLsb;
  let pocMsb = previousPocMsb;
  if (pocLsb < previousPocLsb && previousPocLsb - pocLsb >= maxPocLsb >> 1) {
    pocMsb += maxPocLsb;
  } else if (pocLsb > previousPocLsb && pocLsb - previousPocLsb > maxPocLsb >> 1) {
    pocMsb -= maxPocLsb;
  }
  return pocMsb + pocLsb;
}

/** Derive RefPicListTemp0 and RefPicList0 for a P slice (H.265 8.3.4). */
export function buildReferenceList0(
  sps: SpsInfo,
  header: SliceHeader,
  currentPictureOrderCnt: number,
  decodingOrderReferences: readonly PictureReference[],
  additionalReferences: readonly PictureReference[] = [],
  interLayerReferenceSets?: InterLayerReferencePictureSets,
): PictureReference[] {
  if (header.sliceType !== 1) return [];
  if (
    !header.currentPictureReferenceEnabled &&
    additionalReferences.length === 0 &&
    (header.pictureOrderCntLsb === null || !header.shortTermRefPicSet)
  )
    throw new HeicError('INVALID_BITSTREAM', 'heic: P slice is missing its POC or reference set');

  const maxPocLsb = 1 << sps.log2MaxPicOrderCntLsb;
  const temp: PictureReference[] = [];
  const before: PictureReference[] = [];
  const after: PictureReference[] = [];
  const longTerm: PictureReference[] = [];
  const resolvePoc = (targetPoc: number, isLongTermReference: boolean): PictureReference => {
    const matches = decodingOrderReferences.filter(
      (reference) => reference.pictureOrderCnt === targetPoc,
    );
    if (matches.length === 0)
      throw new HeicError(
        'INVALID_CONTAINER',
        `heic: pred references do not contain required POC ${targetPoc}`,
      );
    if (matches.length > 1)
      throw new HeicError(
        'INVALID_CONTAINER',
        `heic: duplicate pred references have POC ${targetPoc}`,
      );
    return { ...matches[0], isLongTermReference };
  };
  const resolveLongTerm = (reference: SliceHeader['longTermRefPics'][number]): PictureReference => {
    if (reference.deltaPocMsbPresent) {
      const targetPoc =
        currentPictureOrderCnt -
        reference.deltaPocMsbCycle * maxPocLsb -
        (currentPictureOrderCnt & (maxPocLsb - 1)) +
        reference.pocLsb;
      return resolvePoc(targetPoc, true);
    }
    const matches = decodingOrderReferences.filter(
      (candidate) => candidate.pictureOrderCntLsb === reference.pocLsb,
    );
    if (matches.length === 0)
      throw new HeicError(
        'INVALID_CONTAINER',
        `heic: pred references do not contain long-term POC LSB ${reference.pocLsb}`,
      );
    if (matches.length > 1)
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        `heic: long-term POC LSB ${reference.pocLsb} is ambiguous across pred references`,
      );
    return { ...matches[0], isLongTermReference: true };
  };

  const rps = header.shortTermRefPicSet;
  if (rps) {
    for (let i = 0; i < rps.deltaPocS0.length; i++) {
      if (rps.usedByCurrPicS0[i]) {
        const reference = resolvePoc(currentPictureOrderCnt + rps.deltaPocS0[i], false);
        before.push(reference);
        temp.push(reference);
      }
    }
    for (let i = 0; i < rps.deltaPocS1.length; i++) {
      if (rps.usedByCurrPicS1[i]) {
        const reference = resolvePoc(currentPictureOrderCnt + rps.deltaPocS1[i], false);
        after.push(reference);
        temp.push(reference);
      }
    }
  }
  for (const reference of header.longTermRefPics) {
    if (reference.usedByCurrPic) {
      const resolved = resolveLongTerm(reference);
      longTerm.push(resolved);
      temp.push(resolved);
    }
  }

  if (
    temp.length === 0 &&
    additionalReferences.length === 0 &&
    !header.currentPictureReferenceEnabled
  )
    throw new HeicError('INVALID_BITSTREAM', 'heic: P slice has no external L0 references');

  const activeCount = header.numRefIdxL0ActiveMinus1 + 1;
  const currentPicture = header.currentPictureReferenceEnabled
    ? createCurrentPictureReference(sps, currentPictureOrderCnt)
    : null;
  const orderedReferences = interLayerReferenceSets
    ? [
        ...before,
        ...interLayerReferenceSets.interLayer0,
        ...after,
        ...longTerm,
        ...interLayerReferenceSets.interLayer1,
        ...(currentPicture ? [currentPicture] : []),
      ]
    : [...temp, ...additionalReferences, ...(currentPicture ? [currentPicture] : [])];
  const numPicTotalCurr = orderedReferences.length;
  const tempListSize = Math.max(activeCount, numPicTotalCurr);
  const tempList: PictureReference[] = [];
  while (tempList.length < tempListSize) {
    for (const reference of orderedReferences) {
      if (tempList.length >= tempListSize) break;
      tempList.push(reference);
    }
  }

  const list: PictureReference[] = [];
  for (let i = 0; i < activeCount; i++) {
    const tempIndex = header.refPicListL0Modification?.[i] ?? i;
    const reference = tempList[tempIndex];
    if (!reference)
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: L0 list modification selects an unavailable reference',
      );
    list.push(reference);
  }
  if (currentPicture && header.refPicListL0Modification === null && tempListSize > activeCount)
    list[activeCount - 1] = currentPicture;
  return list;
}

/** Derive RefPicList0 and RefPicList1 for a B slice (H.265 8.3.4). */
export function buildBReferenceLists(
  sps: SpsInfo,
  header: SliceHeader,
  currentPictureOrderCnt: number,
  decodingOrderReferences: readonly PictureReference[],
  currentPicture?: PictureReference,
  additionalReferences: readonly PictureReference[] = [],
  interLayerReferenceSets?: InterLayerReferencePictureSets,
): BReferenceLists {
  if (header.sliceType !== 0)
    throw new HeicError('INVALID_BITSTREAM', 'heic: B reference lists requested for a non-B slice');
  if (
    header.pictureOrderCntLsb === null &&
    additionalReferences.length === 0 &&
    !header.currentPictureReferenceEnabled
  )
    throw new HeicError('INVALID_BITSTREAM', 'heic: B slice is missing its POC or reference set');
  if (header.currentPictureReferenceEnabled && !currentPicture)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: B slice current-picture reference is not available during list construction',
    );
  const currentReference = header.currentPictureReferenceEnabled ? currentPicture : undefined;

  const maxPocLsb = 1 << sps.log2MaxPicOrderCntLsb;
  const resolvePoc = (targetPoc: number, isLongTermReference: boolean): PictureReference => {
    const matches = decodingOrderReferences.filter(
      (reference) => reference.pictureOrderCnt === targetPoc,
    );
    if (matches.length === 0)
      throw new HeicError(
        'INVALID_CONTAINER',
        `heic: pred references do not contain required POC ${targetPoc}`,
      );
    if (matches.length > 1)
      throw new HeicError(
        'INVALID_CONTAINER',
        `heic: duplicate pred references have POC ${targetPoc}`,
      );
    return { ...matches[0], isLongTermReference };
  };
  const resolveLongTerm = (reference: SliceHeader['longTermRefPics'][number]): PictureReference => {
    if (reference.deltaPocMsbPresent) {
      const targetPoc =
        currentPictureOrderCnt -
        reference.deltaPocMsbCycle * maxPocLsb -
        (currentPictureOrderCnt & (maxPocLsb - 1)) +
        reference.pocLsb;
      return resolvePoc(targetPoc, true);
    }
    const matches = decodingOrderReferences.filter(
      (candidate) => candidate.pictureOrderCntLsb === reference.pocLsb,
    );
    if (matches.length === 0)
      throw new HeicError(
        'INVALID_CONTAINER',
        `heic: pred references do not contain long-term POC LSB ${reference.pocLsb}`,
      );
    if (matches.length > 1)
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        `heic: long-term POC LSB ${reference.pocLsb} is ambiguous across pred references`,
      );
    return { ...matches[0], isLongTermReference: true };
  };

  const rps = header.shortTermRefPicSet;
  const before: PictureReference[] = [];
  const after: PictureReference[] = [];
  if (rps) {
    for (let i = 0; i < rps.deltaPocS0.length; i++) {
      if (rps.usedByCurrPicS0[i])
        before.push(resolvePoc(currentPictureOrderCnt + rps.deltaPocS0[i], false));
    }
    for (let i = 0; i < rps.deltaPocS1.length; i++) {
      if (rps.usedByCurrPicS1[i])
        after.push(resolvePoc(currentPictureOrderCnt + rps.deltaPocS1[i], false));
    }
  }
  const longTerm = header.longTermRefPics
    .filter((reference) => reference.usedByCurrPic)
    .map(resolveLongTerm);
  const numPicTotalCurr =
    before.length +
    after.length +
    longTerm.length +
    additionalReferences.length +
    Number(!!currentReference);
  if (numPicTotalCurr === 0)
    throw new HeicError('INVALID_BITSTREAM', 'heic: B slice has no current reference pictures');

  const makeTempList = (activeCount: number, isList1: boolean): PictureReference[] => {
    const count = Math.max(activeCount, numPicTotalCurr);
    const ordered = interLayerReferenceSets
      ? isList1
        ? [
            ...after,
            ...interLayerReferenceSets.interLayer1,
            ...before,
            ...longTerm,
            ...interLayerReferenceSets.interLayer0,
          ]
        : [
            ...before,
            ...interLayerReferenceSets.interLayer0,
            ...after,
            ...longTerm,
            ...interLayerReferenceSets.interLayer1,
          ]
      : isList1
        ? [...after, ...before, ...longTerm, ...additionalReferences]
        : [...before, ...after, ...longTerm, ...additionalReferences];
    if (currentReference) ordered.push(currentReference);
    const temp: PictureReference[] = [];
    while (temp.length < count) {
      for (const reference of ordered) {
        if (temp.length === count) break;
        temp.push(reference);
      }
    }
    return temp;
  };

  const makeActiveList = (
    activeCount: number,
    modification: number[] | null,
    temp: PictureReference[],
    listName: 'L0' | 'L1',
  ): PictureReference[] =>
    Array.from({ length: activeCount }, (_, index) => {
      const tempIndex = modification?.[index] ?? index;
      const reference = temp[tempIndex];
      if (!reference)
        throw new HeicError(
          'INVALID_BITSTREAM',
          `heic: ${listName} list modification selects an unavailable reference`,
        );
      return reference;
    });

  const activeCountL0 = header.numRefIdxL0ActiveMinus1 + 1;
  const activeCountL1 = header.numRefIdxL1ActiveMinus1 + 1;
  const temp0 = makeTempList(activeCountL0, false);
  const temp1 = makeTempList(activeCountL1, true);
  const l0 = makeActiveList(activeCountL0, header.refPicListL0Modification, temp0, 'L0');
  const l1 = makeActiveList(activeCountL1, header.refPicListL1Modification, temp1, 'L1');

  // H.265 8.3.4 (8-9) places currPic at the last active L0 position when
  // default list construction would otherwise omit it. List 1 has no such rule.
  if (currentReference && header.refPicListL0Modification === null && temp0.length > activeCountL0)
    l0[activeCountL0 - 1] = currentReference;

  return { l0, l1 };
}
