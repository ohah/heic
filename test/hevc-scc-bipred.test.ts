import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { getHeicInfo } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal';
import { parsePps } from '../src/hevc/pps';
import { PictureDecoder, type ReferenceImage } from '../src/hevc/picture';
import {
  buildBReferenceLists,
  buildReferenceList0,
  createCurrentPictureReference,
  derivePictureOrderCnt,
} from '../src/hevc/reference-list';
import { parseSliceHeader, SLICE_TYPE_B, SLICE_TYPE_P } from '../src/hevc/slice-header';
import { parseSps } from '../src/hevc/sps';
import { decodeItemPlanes } from '../src/planes';
import { applySao } from '../src/hevc/sao';
import { deblockPicture } from '../src/hevc/deblock';
import { wrapHevcPredChain } from '../scripts/lib/heif';

const startCode = Buffer.from([0, 0, 0, 1]);

function asAnnexB(nal: Uint8Array): Buffer {
  return Buffer.concat([startCode, Buffer.from(nal)]);
}

function expectedPlaneMd5s(nals: ReturnType<typeof splitAnnexB>, slice: Uint8Array): string[] {
  const sliceIndex = nals.findIndex((nal) => isSliceNal(nal.type) && nal.data === slice);
  if (sliceIndex < 0) throw new Error('official Bipred_8by8_A slice was not found');
  const seiNal = nals[sliceIndex + 1];
  if (!seiNal || seiNal.type !== 40)
    throw new Error('official Bipred_8by8_A picture has no decoded-picture-hash SEI');
  const sei = toRbsp(seiNal.data);
  if (sei.length !== 52 || sei[0] !== 132 || sei[1] !== 49 || sei[2] !== 0 || sei[51] !== 128)
    throw new Error('official Bipred_8by8_A decoded-picture-hash SEI is malformed');
  return [sei.subarray(3, 19), sei.subarray(19, 35), sei.subarray(35, 51)].map((hash) =>
    Buffer.from(hash).toString('hex'),
  );
}

function planeMd5s(planes: readonly Uint8Array[]): string[] {
  return planes.map((plane) => createHash('md5').update(Buffer.from(plane)).digest('hex'));
}

describe('HEVC SCC 8x8 bi-prediction restriction', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/bipred-8by8-a-qualcomm-2.bit', import.meta.url)),
  );
  const nals = splitAnnexB(bytes);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  const slices = nals.filter((nal) => isSliceNal(nal.type));

  if (!spsNal || !ppsNal || slices.length !== 3)
    throw new Error('official Bipred_8by8_A vector is missing its parameters or three pictures');

  it('reconstructs all three official pictures, including the five restricted 8x8 PUs', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '6b2f15a4e364b02684d7e52e0d57f2e307064f3c534feb1c71c110742792461c',
    );
    const sps = parseSps(spsNal.data);
    const pps = parsePps(ppsNal.data);
    expect(sps.screenContentExtension?.currPicRefEnabled).toBe(true);
    expect(pps.screenContentExtension?.currPicRefEnabled).toBe(true);
    expect(sps.chromaFormatIdc).toBe(1);
    expect(sps.sampleAdaptiveOffsetEnabled).toBe(true);

    const references: ReferenceImage[] = [];
    let previousTid0Poc: number | null = null;
    const actualHashes: string[][] = [];
    const pictureOrderCounts: number[] = [];
    for (const slice of slices) {
      const header = parseSliceHeader(slice.data, sps, pps);
      const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
      let list0: ReferenceImage[];
      let list1: ReferenceImage[] = [];
      if (header.sliceType === SLICE_TYPE_P) {
        list0 = buildReferenceList0(sps, header, poc, references);
      } else {
        expect(header.sliceType).toBe(SLICE_TYPE_B);
        const lists = buildBReferenceLists(
          sps,
          header,
          poc,
          references,
          createCurrentPictureReference(sps, poc),
        );
        list0 = lists.l0;
        list1 = lists.l1;
      }

      const picture = new PictureDecoder(sps, pps, list0, poc, list1).decode([slice.data]);
      deblockPicture(picture, pps, sps.bitDepthLuma, sps.bitDepthChroma);
      applySao(picture, sps, sps.bitDepthLuma, sps.bitDepthChroma);
      const actual = planeMd5s([picture.y, picture.cb, picture.cr]);
      expect(actual, `official Bipred_8by8_A POC ${poc}`).toEqual(
        expectedPlaneMd5s(nals, slice.data),
      );
      actualHashes.push(actual);
      pictureOrderCounts.push(poc);

      references.push({
        ...picture,
        chromaFormatIdc: sps.chromaFormatIdc,
        bitDepthLuma: sps.bitDepthLuma,
        bitDepthChroma: sps.bitDepthChroma,
        pictureOrderCntLsb: header.pictureOrderCntLsb ?? 0,
        pictureOrderCnt: poc,
        isLongTermReference: false,
      });
      if (((slice.data[1] ?? 0) & 7) - 1 === 0) previousTid0Poc = poc;
    }
    expect(pictureOrderCounts).toEqual([0, 1, 2]);
    expect(actualHashes[2]).toEqual([
      'f1c6dcd3c8923aee7c900440fa69d914',
      'fd1f37aff4b132a76093f0b4b7ab3343',
      '27ae2955b6f8168b25610529241fe978',
    ]);
  });

  it('decodes the restricted third picture as a primary item through a synthetic HEIF pred graph', () => {
    const parameterNals = nals
      .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
      .map((nal) => asAnnexB(nal.data));
    const streams = slices.map((slice, index) =>
      Buffer.concat([...(index === 0 ? parameterNals : []), asAnnexB(slice.data)]),
    );
    const heif = wrapHevcPredChain(streams, [[], [1], [1, 2]], 416, 240, 8, 1);
    const boxes = parseISOBMFF(heif);
    const info = getHeicInfo(heif, boxes);
    const planes = decodeItemPlanes(heif, boxes, info, info.primaryItemId);

    expect(info.primaryItemId).toBe(3);
    expect(planeMd5s([planes.y, planes.cb, planes.cr])).toEqual(
      expectedPlaneMd5s(nals, slices[2].data),
    );
  });
});
