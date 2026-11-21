import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { decodeHeic } from '../src';
import { getHeicInfo, getItemPayload } from '../src/container/heic';
import { findBox, parseISOBMFF } from '../src/container/heif';
import { isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal';
import { parsePps } from '../src/hevc/pps';
import { PictureDecoder } from '../src/hevc/picture';
import {
  buildBReferenceLists,
  buildReferenceList0,
  createCurrentPictureReference,
} from '../src/hevc/reference-list';
import { parseSliceHeader, SLICE_TYPE_B, SLICE_TYPE_P } from '../src/hevc/slice-header';
import { parseSps } from '../src/hevc/sps';
import { decodeItemPlanes } from '../src/planes';
import { buildHeif, box, u16 } from './helpers/heif';
import { wrapHevc, wrapHevcPredChain } from '../scripts/lib/heif';

const startCode = Buffer.from([0, 0, 0, 1]);

function asAnnexB(nal: Uint8Array): Buffer {
  return Buffer.concat([startCode, Buffer.from(nal)]);
}

describe('HEVC SCC ACT with current-picture reference', () => {
  it('matches the first picture of the official ACT_QP_Offsets_A Qualcomm vector', () => {
    const hevc = new Uint8Array(
      readFileSync(new URL('./fixtures/conformance/act-ibc-qualcomm-first.hevc', import.meta.url)),
    );
    const expected = readFileSync(
      new URL('./fixtures/conformance/act-ibc-qualcomm-first.gbr', import.meta.url),
    );
    expect(createHash('sha256').update(hevc).digest('hex')).toBe(
      '8b785d52c109b03f30f2615f8f472c199f9a312e1d4fb73f9b1f763c38c019a6',
    );
    expect(createHash('sha256').update(expected).digest('hex')).toBe(
      '68a623c929fdcb4e997b4ee555454ab5a44870cf9091876ffacfd3773a8b36b6',
    );

    const nals = splitAnnexB(hevc);
    const spsNal = nals.find((nal) => nal.type === 33);
    const ppsNal = nals.find((nal) => nal.type === 34);
    const slices = nals.filter((nal) => isSliceNal(nal.type));
    if (!spsNal || !ppsNal || slices.length !== 1)
      throw new Error('official ACT vector fragment is missing its parameter sets or slice');

    const sps = parseSps(spsNal.data);
    const pps = parsePps(ppsNal.data);
    const spsScc = sps.screenContentExtension;
    const ppsScc = pps.screenContentExtension;
    expect(spsScc?.currPicRefEnabled).toBe(true);
    expect(spsScc?.paletteModeEnabled).toBe(true);
    expect(ppsScc?.currPicRefEnabled).toBe(true);
    expect(ppsScc?.residualAdaptiveColourTransformEnabled).toBe(true);
    expect(ppsScc?.sliceActQpOffsetsPresent).toBe(false);
    expect(ppsScc?.actYQpOffsetPlus5).toBe(2);
    expect(ppsScc?.actCbQpOffsetPlus5).toBe(-1);
    expect(ppsScc?.actCrQpOffsetPlus3).toBe(1);

    const header = parseSliceHeader(slices[0].data, sps, pps);
    expect(header.sliceType).toBe(SLICE_TYPE_P);
    expect(header.currentPictureReferenceEnabled).toBe(true);
    expect(header.sliceActYQpOffset).toBe(0);
    expect(header.sliceActCbQpOffset).toBe(0);
    expect(header.sliceActCrQpOffset).toBe(0);

    const currentReferences = buildReferenceList0(sps, header, header.pictureOrderCntLsb ?? 0, []);
    const picture = new PictureDecoder(
      sps,
      pps,
      currentReferences,
      header.pictureOrderCntLsb ?? 0,
    ).decode(slices.map((nal) => nal.data));
    expect(picture.hasExternalInterMotion).toBe(false);
    expect(picture.interMap.some((value) => value === 1)).toBe(true);

    const heif = wrapHevc(hevc, 1280, 720, 8, 3);
    const boxes = parseISOBMFF(heif);
    const info = getHeicInfo(heif, boxes);
    const planes = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
    const actual = Buffer.concat([
      Buffer.from(planes.y),
      Buffer.from(planes.cb),
      Buffer.from(planes.cr),
    ]);

    expect(actual).toEqual(expected);

    const wrapped = wrapHevc(hevc, 1280, 720, 8, 3),
      wrappedBoxes = parseISOBMFF(wrapped),
      meta = findBox(wrappedBoxes, 'meta')!,
      iprp = findBox(meta.children!, 'iprp')!,
      ipco = findBox(iprp.children!, 'ipco')!,
      properties = ipco.children!.map((property) => box(property.type, property.data)),
      payload = getItemPayload(wrapped, wrappedBoxes, 1)!,
      identityRgb = box('colr', Buffer.from('nclx'), u16(1), u16(13), u16(0), Buffer.from([128])),
      identityHeif = buildHeif(
        [{ id: 1, type: 'hvc1', data: payload, properties: [...properties, identityRgb] }],
        1,
      ),
      rendered = decodeHeic(identityHeif),
      expectedRgba = Buffer.alloc(1280 * 720 * 4),
      pixels = 1280 * 720;
    expect([rendered.width, rendered.height]).toEqual([1280, 720]);
    for (let index = 0; index < pixels; index++) {
      expectedRgba[index * 4] = expected[index + pixels * 2]!;
      expectedRgba[index * 4 + 1] = expected[index]!;
      expectedRgba[index * 4 + 2] = expected[index + pixels]!;
      expectedRgba[index * 4 + 3] = 255;
    }
    expect(Buffer.from(rendered.data)).toEqual(expectedRgba);
  });

  it('decodes the official ACT B picture from a HEIF pred reference and matches its hash', () => {
    const firstPicture = new Uint8Array(
      readFileSync(new URL('./fixtures/conformance/act-ibc-qualcomm-first.hevc', import.meta.url)),
    );
    const secondPicture = new Uint8Array(
      readFileSync(
        new URL('./fixtures/conformance/act-ibc-qualcomm-second-b.hevc', import.meta.url),
      ),
    );
    expect(createHash('sha256').update(secondPicture).digest('hex')).toBe(
      '2fbcc3de17bbb666f3a174ecfdb3364dfa9c4ae51795bfc822b2a52d92f08dc2',
    );

    const firstNals = splitAnnexB(firstPicture);
    const secondNals = splitAnnexB(secondPicture);
    const spsNal = firstNals.find((nal) => nal.type === 33);
    const firstPpsNal = firstNals.find((nal) => nal.type === 34);
    const secondPpsNal = secondNals.find((nal) => nal.type === 34);
    const firstSlice = firstNals.find((nal) => nal.type === 19);
    const secondSlice = secondNals.find((nal) => nal.type === 1);
    const hashSei = secondNals.find((nal) => nal.type === 40);
    if (!spsNal || !firstPpsNal || !secondPpsNal || !firstSlice || !secondSlice || !hashSei)
      throw new Error('official ACT vector is missing its second PPS, B slice, or hash SEI');

    const sps = parseSps(spsNal.data);
    const firstPps = parsePps(firstPpsNal.data);
    const secondPps = parsePps(secondPpsNal.data);
    expect(firstPps.ppsId).toBe(0);
    expect(secondPps.ppsId).toBe(1);
    expect(secondPps.screenContentExtension).toMatchObject({
      currPicRefEnabled: true,
      residualAdaptiveColourTransformEnabled: true,
      sliceActQpOffsetsPresent: true,
    });

    const header = parseSliceHeader(secondSlice.data, sps, secondPps);
    expect(header).toMatchObject({
      sliceType: SLICE_TYPE_B,
      currentPictureReferenceEnabled: true,
      pictureOrderCntLsb: 1,
      numRefIdxL0ActiveMinus1: 1,
      numRefIdxL1ActiveMinus1: 0,
      sliceActYQpOffset: -2,
      sliceActCbQpOffset: -1,
      sliceActCrQpOffset: 1,
    });
    expect(header.shortTermRefPicSet?.deltaPocS0).toEqual([-1]);
    expect(header.shortTermRefPicSet?.usedByCurrPicS0).toEqual([true]);

    const firstStream = Buffer.concat([
      ...firstNals.filter((nal) => nal.type >= 32).map((nal) => asAnnexB(nal.data)),
      asAnnexB(secondPpsNal.data),
      asAnnexB(firstSlice.data),
    ]);
    const predGraph = wrapHevcPredChain(
      [firstStream, secondPicture],
      [[], [1]],
      sps.picWidthInLumaSamples,
      sps.picHeightInLumaSamples,
      sps.bitDepthLuma,
      sps.chromaFormatIdc,
    );
    const boxes = parseISOBMFF(predGraph);
    const info = getHeicInfo(predGraph, boxes);
    expect(info.hvcC?.pps.map((nal) => parsePps(nal).ppsId)).toEqual([0, 1]);

    const referencePlanes = decodeItemPlanes(predGraph, boxes, info, 1);
    const externalReference = {
      ...referencePlanes,
      pictureOrderCntLsb: referencePlanes.pictureOrderCntLsb ?? 0,
      pictureOrderCnt: referencePlanes.pictureOrderCnt ?? 0,
      isLongTermReference: false,
    };
    const referenceLists = buildBReferenceLists(
      sps,
      header,
      1,
      [externalReference],
      createCurrentPictureReference(sps, 1),
    );
    expect(referenceLists.l0.map((reference) => reference.isCurrentPicture ?? false)).toEqual([
      false,
      true,
    ]);
    expect(referenceLists.l1.map((reference) => reference.isCurrentPicture ?? false)).toEqual([
      false,
    ]);

    const planes = decodeItemPlanes(predGraph, boxes, info, info.primaryItemId);
    expect(planes.hasExternalInterMotion).toBe(true);
    expect([...new Set(planes.motionRefIdxL0 ?? [])]).toEqual([0]);
    expect([...new Set(planes.motionRefIdxL1 ?? [])]).toEqual([0]);

    const sei = toRbsp(hashSei.data);
    expect(sei).toHaveLength(52);
    expect([sei[0], sei[1], sei[2], sei[51]]).toEqual([132, 49, 0, 128]);
    const expectedMd5s = [sei.subarray(3, 19), sei.subarray(19, 35), sei.subarray(35, 51)].map(
      (hash) => Buffer.from(hash).toString('hex'),
    );
    const actualMd5s = [planes.y, planes.cb, planes.cr].map((plane) =>
      createHash('md5').update(Buffer.from(plane)).digest('hex'),
    );
    expect(actualMd5s).toEqual(expectedMd5s);
  });
});
