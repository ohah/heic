import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { getHeicInfo } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { BitReader, isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal';
import { parsePps } from '../src/hevc/pps';
import { parseSps } from '../src/hevc/sps';
import { PictureDecoder } from '../src/hevc/picture';
import { buildReferenceList0 } from '../src/hevc/reference-list';
import { parseSliceHeader, SLICE_TYPE_P } from '../src/hevc/slice-header';
import { decodeItemPlanes } from '../src/planes';
import { wrapHevc, wrapHevcPredChain } from '../scripts/lib/heif';

const startCode = Buffer.from([0, 0, 0, 1]);

function asAnnexB(nal: Uint8Array): Buffer {
  return Buffer.concat([startCode, Buffer.from(nal)]);
}

describe('HEVC SCC palette predictor initialization', () => {
  it('matches the first picture of the official PPI_B InterDigital vector', () => {
    const hevc = new Uint8Array(
      readFileSync(
        new URL('./fixtures/conformance/ppi-b-interdigital-2-first.hevc', import.meta.url),
      ),
    );
    const nals = splitAnnexB(hevc);
    const spsNal = nals.find((nal) => nal.type === 33);
    const ppsNal = nals.find((nal) => nal.type === 34);
    if (!spsNal || !ppsNal) throw new Error('official SCC vector is missing its SPS or PPS');
    const sps = parseSps(spsNal.data);
    const pps = parsePps(ppsNal.data);
    const slices = nals.filter((nal) => isSliceNal(nal.type));
    const header = parseSliceHeader(slices[0].data, sps, pps);
    const references = buildReferenceList0(sps, header, header.pictureOrderCntLsb ?? 0, []);
    const picture = new PictureDecoder(sps, pps, references, header.pictureOrderCntLsb ?? 0).decode(
      slices.map((nal) => nal.data),
    );
    expect(picture.sh.currentPictureReferenceEnabled).toBe(true);
    expect(picture.hasExternalInterMotion).toBe(false);
    expect(picture.interMap.some((value) => value === 1)).toBe(true);

    const heif = wrapHevc(hevc, 1280, 720, 8, 1);
    const boxes = parseISOBMFF(heif);
    const info = getHeicInfo(heif, boxes);
    const planes = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
    const actual = Buffer.concat([
      Buffer.from(planes.y),
      Buffer.from(planes.cb),
      Buffer.from(planes.cr),
    ]);
    const expected = readFileSync(
      new URL('./fixtures/conformance/ppi-b-interdigital-2-first.yuv', import.meta.url),
    );

    expect(actual).toEqual(expected);
  });

  it('decodes the SPS, nonempty PPS, and empty PPS phases in official PPI_A', () => {
    const bitstream = new Uint8Array(
      readFileSync(new URL('./fixtures/conformance/ppi-a-interdigital-2.bit', import.meta.url)),
    );
    expect(createHash('md5').update(bitstream).digest('hex')).toBe(
      '96f81d3ef08661724bf305edb08af177',
    );
    expect(createHash('sha256').update(bitstream).digest('hex')).toBe(
      '27339fa9b5a70978ed0e3723ed80f18f014b313341825d4658a1fb492e89434b',
    );

    const nals = splitAnnexB(bitstream);
    const vps = nals.find((nal) => nal.type === 32);
    const spsNal = nals.find((nal) => nal.type === 33);
    const sps = spsNal && parseSps(spsNal.data);
    const ppsEntries = nals
      .filter((nal) => nal.type === 34)
      .map((nal) => ({ nal, pps: parsePps(nal.data) }));
    const ppsById = new Map(ppsEntries.map((entry) => [entry.pps.ppsId, entry]));
    if (!vps || !spsNal || !sps || !ppsById.has(0) || !ppsById.has(1) || !ppsById.has(2))
      throw new Error('official PPI_A vector is missing a parameter set');

    const spsScc = sps.screenContentExtension;
    expect(spsScc?.paletteModeEnabled).toBe(true);
    expect(spsScc?.palettePredictorInitializersPresent).toBe(true);
    expect(spsScc?.palettePredictorInitializers[0]?.length).toBeGreaterThan(0);
    expect(ppsById.get(0)?.pps.screenContentExtension?.palettePredictorInitializersPresent).toBe(
      false,
    );
    expect(ppsById.get(1)?.pps.screenContentExtension).toMatchObject({
      palettePredictorInitializersPresent: true,
    });
    expect(
      ppsById.get(1)?.pps.screenContentExtension?.palettePredictorInitializers?.components[0]
        ?.length,
    ).toBeGreaterThan(0);
    expect(ppsById.get(2)?.pps.screenContentExtension).toMatchObject({
      palettePredictorInitializersPresent: true,
      palettePredictorInitializers: {
        components: [],
        bitDepthLuma: 0,
        bitDepthChroma: 0,
      },
    });

    const pictures = [
      {
        ppsId: 0,
        nalType: 19,
        poc: 0,
        expectedPlaneMd5s: [
          '30444e397598b6f89ecb59520c1287a7',
          'efb67d2bc4b11ab2f7322a813beed187',
          '8deb84a4e1f4c8349d005661a6d1fe88',
        ],
      },
      {
        ppsId: 1,
        nalType: 21,
        poc: 16,
        expectedPlaneMd5s: [
          'f28b96d104a3da3e1f6ed0343305f091',
          '8c2a1c8f284e781db800047d652835b0',
          'cec7261c1a4031b2bf41b315dadc4ab7',
        ],
      },
      {
        ppsId: 2,
        nalType: 21,
        poc: 32,
        expectedPlaneMd5s: [
          'aec71c98084b5f6ad4b0121ee20a5867',
          '314fdc5d107e7315e330da34ccd28a3d',
          'edd1daeca31580c5dfa5a2f0ba251eff',
        ],
      },
    ];
    const selectedSlices: Uint8Array[] = [];

    for (const target of pictures) {
      const targetPps = ppsById.get(target.ppsId)!;
      const sliceNal = nals.find((nal) => {
        if (nal.type !== target.nalType) return false;
        const r = new BitReader(toRbsp(nal.data));
        r.readBit(); // first_slice_segment_in_pic_flag
        if (nal.type >= 16 && nal.type <= 23) r.readBit(); // no_output_of_prior_pics_flag
        return r.ue() === target.ppsId;
      });
      if (!sliceNal) throw new Error(`official PPI_A POC ${target.poc} picture was not found`);
      selectedSlices.push(sliceNal.data);
      const header = parseSliceHeader(sliceNal.data, sps, targetPps.pps);
      expect(header).toMatchObject({
        firstSliceInPic: true,
        sliceType: SLICE_TYPE_P,
        currentPictureReferenceEnabled: true,
      });
      expect(header.pictureOrderCntLsb ?? 0).toBe(target.poc);
      const references = buildReferenceList0(sps, header, target.poc, []);
      expect(references.map((reference) => reference.isCurrentPicture)).toEqual([true]);

      const picture = new PictureDecoder(sps, targetPps.pps, references, target.poc).decode([
        sliceNal.data,
      ]);
      expect(picture.hasExternalInterMotion).toBe(false);
      expect(picture.interMap.some((value) => value === 1)).toBe(true);
      expect(picture.paletteMap.some((value) => value === 1)).toBe(true);

      const suffix = nals[nals.indexOf(sliceNal) + 1];
      if (!suffix || suffix.type !== 40)
        throw new Error(`official PPI_A POC ${target.poc} decoded-picture-hash SEI was not found`);
      const sei = toRbsp(suffix.data);
      expect(sei).toHaveLength(52);
      expect([sei[0], sei[1], sei[2], sei[51]]).toEqual([132, 49, 0, 128]);
      const seiPlaneMd5s = [sei.subarray(3, 19), sei.subarray(19, 35), sei.subarray(35, 51)].map(
        (hash) => Buffer.from(hash).toString('hex'),
      );
      expect(seiPlaneMd5s).toEqual(target.expectedPlaneMd5s);

      const heif = wrapHevc(
        Buffer.concat([vps.data, spsNal.data, targetPps.nal.data, sliceNal.data].map(asAnnexB)),
        sps.picWidthInLumaSamples,
        sps.picHeightInLumaSamples,
        sps.bitDepthLuma,
        sps.chromaFormatIdc,
      );
      const boxes = parseISOBMFF(heif);
      const info = getHeicInfo(heif, boxes);
      const planes = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
      const actualPlaneMd5s = [planes.y, planes.cb, planes.cr].map((plane) =>
        createHash('md5').update(Buffer.from(plane)).digest('hex'),
      );
      expect(actualPlaneMd5s).toEqual(target.expectedPlaneMd5s);
    }

    const prefix = [vps, spsNal, ...ppsEntries.map((entry) => entry.nal)];
    const itemStreams = selectedSlices.map((slice, index) =>
      Buffer.concat(
        (index === 0 ? [...prefix.map((nal) => nal.data), slice] : [slice]).flatMap(asAnnexB),
      ),
    );
    const predChain = wrapHevcPredChain(
      itemStreams,
      [[], [], []],
      sps.picWidthInLumaSamples,
      sps.picHeightInLumaSamples,
      sps.bitDepthLuma,
      sps.chromaFormatIdc,
    );
    const chainBoxes = parseISOBMFF(predChain);
    const chainInfo = getHeicInfo(predChain, chainBoxes);
    expect(chainInfo.hvcC?.pps).toHaveLength(3);
    const primary = decodeItemPlanes(predChain, chainBoxes, chainInfo, chainInfo.primaryItemId);
    const primaryPlaneMd5s = [primary.y, primary.cb, primary.cr].map((plane) =>
      createHash('md5').update(Buffer.from(plane)).digest('hex'),
    );
    expect(primaryPlaneMd5s).toEqual(pictures[2].expectedPlaneMd5s);
  });
});
