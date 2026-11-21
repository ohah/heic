import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { getHeicInfo } from '../src/container/heic.js';
import { parseISOBMFF } from '../src/container/heif.js';
import { deblockPicture } from '../src/hevc/deblock.js';
import { BitReader, isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal.js';
import { parsePps } from '../src/hevc/pps.js';
import { PictureDecoder, type ReferenceImage } from '../src/hevc/picture.js';
import {
  buildBReferenceLists,
  buildReferenceList0,
  createCurrentPictureReference,
  derivePictureOrderCnt,
} from '../src/hevc/reference-list.js';
import { applySao } from '../src/hevc/sao.js';
import { parseSliceHeader, SLICE_TYPE_B, SLICE_TYPE_P } from '../src/hevc/slice-header.js';
import { parseSps } from '../src/hevc/sps.js';
import { decodeItemPlanes } from '../src/planes.js';
import { wrapHevcPredChain } from '../scripts/lib/heif.js';

const startCode = Buffer.from([0, 0, 0, 1]);

function asAnnexB(units: readonly Uint8Array[]): Buffer {
  return Buffer.concat(units.flatMap((unit) => [startCode, Buffer.from(unit)]));
}

function planeMd5s(planes: readonly Uint8Array[]): string[] {
  return planes.map((plane) => createHash('md5').update(Buffer.from(plane)).digest('hex'));
}

describe('HEVC SCC DPB loop-filter conformance', () => {
  it('reconstructs the official DPB_Loop_Filters_A vector including current-picture references', () => {
    const bytes = new Uint8Array(
      readFileSync(
        new URL('./fixtures/conformance/dpb-loop-filters-a-mediatek-2.bit', import.meta.url),
      ),
    );
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '9287d1ee8bc21d13ddd4bc12fd07b8c77f77fa526518a76a11bdd8c593fd4cf1',
    );

    const nals = splitAnnexB(bytes);
    const spsNal = nals.find((nal) => nal.type === 33);
    if (!spsNal) throw new Error('DPB_Loop_Filters_A stream is missing its SPS');
    const sps = parseSps(spsNal.data);
    const ppsById = new Map(
      nals
        .filter((nal) => nal.type === 34)
        .map((nal) => {
          const pps = parsePps(nal.data);
          return [pps.ppsId, pps] as const;
        }),
    );

    const pictures: {
      nal: Uint8Array;
      pps: ReturnType<typeof parsePps>;
      header: ReturnType<typeof parseSliceHeader>;
    }[] = [];
    for (const nal of nals) {
      if (!isSliceNal(nal.type)) continue;
      const bits = new BitReader(toRbsp(nal.data));
      bits.readBit();
      if (nal.type >= 16 && nal.type <= 23) bits.readBit();
      const pps = ppsById.get(bits.ue());
      if (!pps) throw new Error('DPB_Loop_Filters_A stream references a missing PPS');
      pictures.push({ nal: nal.data, pps, header: parseSliceHeader(nal.data, sps, pps) });
    }

    expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples, sps.chromaFormatIdc]).toEqual([
      1280, 720, 3,
    ]);
    expect([sps.bitDepthLuma, sps.bitDepthChroma]).toEqual([8, 8]);
    expect(sps.screenContentExtension?.currPicRefEnabled).toBe(true);
    expect(pictures).toHaveLength(10);
    expect(pictures.map(({ header }) => header.sliceType)).toEqual([
      SLICE_TYPE_P,
      ...Array<number>(9).fill(SLICE_TYPE_B),
    ]);
    expect(pictures.every(({ header }) => header.currentPictureReferenceEnabled)).toBe(true);

    const loopFilterPicture = pictures[7];
    expect(loopFilterPicture?.pps.ppsId).toBe(1);
    expect(loopFilterPicture?.header.numRefIdxL0ActiveMinus1 + 1).toBe(6);
    expect(loopFilterPicture?.header.deblockingDisabled).toBe(true);
    expect(loopFilterPicture?.header.saoLuma).toBe(false);
    expect(loopFilterPicture?.header.saoChroma).toBe(false);

    const pictureOrderCounts: number[] = [];
    const previousTid0Indexes: (number | null)[] = [];
    let previousTid0Poc: number | null = null;
    let previousTid0Index: number | null = null;
    for (const [index, { nal, header }] of pictures.entries()) {
      pictureOrderCounts.push(derivePictureOrderCnt(sps, header, previousTid0Poc));
      previousTid0Indexes.push(previousTid0Index);
      if (((nal[1] ?? 0) & 7) - 1 === 0) {
        previousTid0Poc = pictureOrderCounts[index];
        previousTid0Index = index;
      }
    }
    expect(pictureOrderCounts).toEqual(Array.from({ length: 10 }, (_, index) => index));

    const indexByPoc = new Map(pictureOrderCounts.map((poc, index) => [poc, index]));
    const dependencies = pictures.map(({ header }, index) => {
      if (header.sliceType !== SLICE_TYPE_P && header.sliceType !== SLICE_TYPE_B)
        throw new Error(`unexpected DPB_Loop_Filters_A slice type ${header.sliceType}`);
      const rps = header.shortTermRefPicSet;
      const referenceIndexes = new Set<number>();
      if (rps) {
        for (const [deltas, usedFlags] of [
          [rps.deltaPocS0, rps.usedByCurrPicS0],
          [rps.deltaPocS1, rps.usedByCurrPicS1],
        ] as const) {
          for (let referenceIndex = 0; referenceIndex < deltas.length; referenceIndex++) {
            if (!usedFlags[referenceIndex]) continue;
            const referencePoc = pictureOrderCounts[index] + deltas[referenceIndex];
            const targetIndex = indexByPoc.get(referencePoc);
            if (targetIndex === undefined || targetIndex >= index)
              throw new Error(`DPB_Loop_Filters_A lacks prior POC ${referencePoc}`);
            referenceIndexes.add(targetIndex);
          }
        }
      } else if (header.sliceType === SLICE_TYPE_B) {
        throw new Error(`DPB_Loop_Filters_A POC ${pictureOrderCounts[index]} has no RPS`);
      }
      if (header.longTermRefPics.some((reference) => reference.usedByCurrPic))
        throw new Error('DPB_Loop_Filters_A unexpectedly uses long-term references');
      const previousIndex = previousTid0Indexes[index];
      if (previousIndex !== null) referenceIndexes.add(previousIndex);
      const ordered = [...referenceIndexes].sort((a, b) => a - b);
      return previousIndex === null
        ? ordered
        : [...ordered.filter((referenceIndex) => referenceIndex !== previousIndex), previousIndex];
    });

    const references: ReferenceImage[] = [];
    const decodedYuvMd5 = createHash('md5');
    const decodedPlaneMd5s: string[][] = [];
    previousTid0Poc = null;
    for (const { nal, pps, header } of pictures) {
      const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
      const currentPicture = header.currentPictureReferenceEnabled
        ? createCurrentPictureReference(sps, poc)
        : undefined;
      let list0: ReferenceImage[] = [];
      let list1: ReferenceImage[] = [];
      if (header.sliceType === SLICE_TYPE_P) {
        list0 = buildReferenceList0(sps, header, poc, references);
      } else if (header.sliceType === SLICE_TYPE_B) {
        const lists = buildBReferenceLists(sps, header, poc, references, currentPicture);
        list0 = lists.l0;
        list1 = lists.l1;
      }

      const picture = new PictureDecoder(sps, pps, list0, poc, list1).decode([nal]);
      deblockPicture(picture, pps, sps.bitDepthLuma, sps.bitDepthChroma);
      applySao(picture, sps, sps.bitDepthLuma, sps.bitDepthChroma);
      decodedPlaneMd5s.push(planeMd5s([picture.y, picture.cb, picture.cr]));
      for (const plane of [picture.y, picture.cb, picture.cr])
        decodedYuvMd5.update(Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength));

      references.push({
        ...picture,
        chromaFormatIdc: sps.chromaFormatIdc,
        bitDepthLuma: sps.bitDepthLuma,
        bitDepthChroma: sps.bitDepthChroma,
        pictureOrderCntLsb: header.pictureOrderCntLsb ?? 0,
        pictureOrderCnt: poc,
        isLongTermReference: false,
      });
      if (((nal[1] ?? 0) & 7) - 1 === 0) previousTid0Poc = poc;
    }

    expect(decodedYuvMd5.digest('hex')).toBe('8dba33e8843e05bca8eb8c0fb4131a6b');

    const parameterNals = nals
      .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
      .map((nal) => nal.data);
    const itemStreams = pictures.map(({ nal }, index) =>
      asAnnexB([...(index === 0 ? parameterNals : []), nal]),
    );
    const heif = wrapHevcPredChain(
      itemStreams,
      dependencies.map((indexes) => indexes.map((index) => index + 1)),
      sps.picWidthInLumaSamples,
      sps.picHeightInLumaSamples,
      sps.bitDepthLuma,
      sps.chromaFormatIdc,
    );
    const boxes = parseISOBMFF(heif);
    const info = getHeicInfo(heif, boxes);
    for (const targetIndex of [7, 9]) {
      const itemId = targetIndex + 1;
      const itemInfo = getHeicInfo(heif, boxes, itemId);
      const planes = decodeItemPlanes(heif, boxes, info, itemId);
      expect(planes.pictureOrderCnt).toBe(pictureOrderCounts[targetIndex]);
      expect(planeMd5s([planes.y, planes.cb, planes.cr])).toEqual(decodedPlaneMd5s[targetIndex]);
      expect(itemInfo.predReferenceItemIds).toEqual(
        dependencies[targetIndex]?.map((index) => index + 1),
      );
    }
  });
});
