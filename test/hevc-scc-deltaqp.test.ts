import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { getHeicInfo } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { isSliceNal, splitAnnexB } from '../src/hevc/nal';
import { parsePps } from '../src/hevc/pps';
import { parseSliceHeader, SLICE_TYPE_P } from '../src/hevc/slice-header';
import { parseSps } from '../src/hevc/sps';
import { decodeItemPlanes } from '../src/planes';
import { wrapHevc } from '../scripts/lib/heif';

const startCode = Buffer.from([0, 0, 0, 1]);

function asAnnexB(nal: Uint8Array): Buffer {
  return Buffer.concat([startCode, Buffer.from(nal)]);
}

describe('HEVC SCC palette delta-QP and chroma-QP offsets', () => {
  it('matches both official Qualcomm pictures with palette escape samples', () => {
    const bitstream = new Uint8Array(
      readFileSync(
        new URL(
          './fixtures/conformance/delta-qp-chroma-qp-offsets-a-qualcomm-2.bit',
          import.meta.url,
        ),
      ),
    );
    expect(createHash('md5').update(bitstream).digest('hex')).toBe(
      'dcdb0fd52212ff9e04fc3adcfd53b0cd',
    );

    const nals = splitAnnexB(bitstream);
    const spsNal = nals.find((nal) => nal.type === 33);
    const ppsNals = nals.filter((nal) => nal.type === 34);
    if (!spsNal || ppsNals.length === 0)
      throw new Error('official SCC vector is missing its SPS or PPS');

    const sps = parseSps(spsNal.data);
    const pps = parsePps(ppsNals[0].data);
    expect(sps.chromaFormatIdc).toBe(3);
    expect(sps.screenContentExtension?.paletteModeEnabled).toBe(true);
    expect(pps.cuQpDeltaEnabled).toBe(true);
    expect(pps.diffCuQpDeltaDepth).toBe(1);
    expect(pps.chromaQpOffsetListEnabled).toBe(true);
    expect(pps.diffCuChromaQpOffsetDepth).toBe(1);

    const pictures: Uint8Array[][] = [];
    for (const nal of nals.filter((entry) => isSliceNal(entry.type))) {
      const header = parseSliceHeader(nal.data, sps, pps);
      if (header.firstSliceInPic) pictures.push([]);
      const picture = pictures.at(-1);
      if (!picture) throw new Error('official SCC vector starts without a first slice');
      expect(header.sliceType).toBe(SLICE_TYPE_P);
      expect(header.currentPictureReferenceEnabled).toBe(true);
      picture.push(nal.data);
    }
    expect(pictures).toHaveLength(2);
    expect(pictures.map((picture) => picture.length)).toEqual([1, 1]);

    const parameterSets = nals
      .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
      .map((nal) => asAnnexB(nal.data));
    const reconstructedPictures = pictures.map((picture) => {
      const stillImage = wrapHevc(
        Buffer.concat([...parameterSets, ...picture.map(asAnnexB)]),
        1280,
        720,
        8,
        3,
      );
      const boxes = parseISOBMFF(stillImage);
      const info = getHeicInfo(stillImage, boxes);
      const planes = decodeItemPlanes(stillImage, boxes, info, info.primaryItemId);
      return Buffer.concat([Buffer.from(planes.y), Buffer.from(planes.cb), Buffer.from(planes.cr)]);
    });

    expect(createHash('md5').update(Buffer.concat(reconstructedPictures)).digest('hex')).toBe(
      'b5535b153c9ea0a01b22236d9a753e0c',
    );
  });
});
