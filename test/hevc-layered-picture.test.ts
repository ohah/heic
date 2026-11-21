import { expect, it } from 'bun:test';
import type { ReferenceImage } from '../src/hevc/picture';
import { buildLayeredActiveReferenceList } from '../src/hevc/layered-picture';
import { buildBReferenceLists, buildReferenceList0 } from '../src/hevc/reference-list';
import type { SliceHeader } from '../src/hevc/slice-header';
import type { SpsInfo } from '../src/hevc/sps';

function reference(pictureOrderCnt: number, isCurrentPicture = false): ReferenceImage {
  return {
    y: new Uint8Array(0),
    cb: new Uint8Array(0),
    cr: new Uint8Array(0),
    width: 16,
    height: 16,
    chromaFormatIdc: 1,
    pictureOrderCntLsb: pictureOrderCnt,
    pictureOrderCnt,
    isCurrentPicture,
    isLongTermReference: isCurrentPicture,
    hasExternalInterMotion: false,
  };
}

it('appends the current picture after inter-layer references in Annex F lists', () => {
  const interLayer = reference(4);
  const currentPicture = reference(8, true);

  expect(buildLayeredActiveReferenceList([interLayer], currentPicture, 2, null, 'L0')).toEqual([
    interLayer,
    currentPicture,
  ]);
});

it('builds a P-slice list from the current picture when there is no inter-layer reference', () => {
  const currentPicture = reference(8, true);

  expect(buildLayeredActiveReferenceList([], currentPicture, 1, null, 'L0')).toEqual([
    currentPicture,
  ]);
});

it('includes the current picture in both B-slice reference lists', () => {
  const interLayer = reference(4);
  const currentPicture = reference(8, true);

  expect(buildLayeredActiveReferenceList([interLayer], currentPicture, 2, null, 'L0')).toEqual([
    interLayer,
    currentPicture,
  ]);
  expect(buildLayeredActiveReferenceList([interLayer], currentPicture, 2, null, 'L1')).toEqual([
    interLayer,
    currentPicture,
  ]);
});

it('places the current picture at the last active position when the default list is truncated', () => {
  const interLayer = reference(4);
  const currentPicture = reference(8, true);

  expect(buildLayeredActiveReferenceList([interLayer], currentPicture, 1, null, 'L0')).toEqual([
    currentPicture,
  ]);
});

it('honours explicit reference-list modifications and repeats the temporary list', () => {
  const interLayer = reference(4);
  const currentPicture = reference(8, true);

  expect(buildLayeredActiveReferenceList([interLayer], currentPicture, 3, [1, 0, 1], 'L0')).toEqual(
    [currentPicture, interLayer, currentPicture],
  );
});

it('orders temporal references before inter-layer references in L-HEVC P lists', () => {
  const temporal = reference(6);
  const interLayer = reference(8);
  const header = {
    sliceType: 1,
    pictureOrderCntLsb: 8,
    shortTermRefPicSet: {
      deltaPocS0: [-2],
      usedByCurrPicS0: [true],
      deltaPocS1: [],
      usedByCurrPicS1: [],
    },
    longTermRefPics: [],
    numRefIdxL0ActiveMinus1: 1,
    refPicListL0Modification: null,
    currentPictureReferenceEnabled: false,
  } as unknown as SliceHeader;
  const sps = { log2MaxPicOrderCntLsb: 4 } as SpsInfo;

  expect(buildReferenceList0(sps, header, 8, [temporal], [interLayer])).toEqual([
    temporal,
    interLayer,
  ]);
  expect(
    buildReferenceList0(
      sps,
      { ...header, refPicListL0Modification: [1, 0] },
      8,
      [temporal],
      [interLayer],
    ),
  ).toEqual([interLayer, temporal]);
});

it('places temporal and inter-layer references in both L-HEVC B lists', () => {
  const before = reference(6);
  const after = reference(10);
  const interLayer = reference(8);
  const header = {
    sliceType: 0,
    pictureOrderCntLsb: 8,
    shortTermRefPicSet: {
      deltaPocS0: [-2],
      usedByCurrPicS0: [true],
      deltaPocS1: [2],
      usedByCurrPicS1: [true],
    },
    longTermRefPics: [],
    numRefIdxL0ActiveMinus1: 2,
    refPicListL0Modification: null,
    numRefIdxL1ActiveMinus1: 2,
    refPicListL1Modification: null,
    currentPictureReferenceEnabled: false,
  } as unknown as SliceHeader;
  const sps = { log2MaxPicOrderCntLsb: 4 } as SpsInfo;

  expect(buildBReferenceLists(sps, header, 8, [before, after], undefined, [interLayer])).toEqual({
    l0: [before, after, interLayer],
    l1: [after, before, interLayer],
  });
});

it('inserts the two Annex F inter-layer sets at their specified B-list positions', () => {
  const before = reference(6);
  const after = reference(10);
  const interLayer0 = reference(8);
  const interLayer1 = reference(12);
  const header = {
    sliceType: 0,
    pictureOrderCntLsb: 8,
    shortTermRefPicSet: {
      deltaPocS0: [-2],
      usedByCurrPicS0: [true],
      deltaPocS1: [2],
      usedByCurrPicS1: [true],
    },
    longTermRefPics: [],
    numRefIdxL0ActiveMinus1: 3,
    refPicListL0Modification: null,
    numRefIdxL1ActiveMinus1: 3,
    refPicListL1Modification: null,
    currentPictureReferenceEnabled: false,
  } as unknown as SliceHeader;
  const sps = { log2MaxPicOrderCntLsb: 4 } as SpsInfo;

  expect(
    buildBReferenceLists(sps, header, 8, [before, after], undefined, [], {
      interLayer0: [interLayer0],
      interLayer1: [interLayer1],
    }),
  ).toEqual({
    l0: [before, interLayer0, after, interLayer1],
    l1: [after, interLayer1, before, interLayer0],
  });
});
