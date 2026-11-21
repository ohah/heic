import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { getFtypInfo } from '../src/container/heif';
import { getHeicInfo } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { isSliceNal, splitAnnexB } from '../src/hevc/nal';
import { parseSps } from '../src/hevc/sps';
import { decodeItemPlanes } from '../src/planes';
import { wrapHevc } from '../scripts/lib/heif';

describe('HRD syntax in a HEVC still image item', () => {
  it('skips the official HRD_A SPS timing syntax and decodes its first picture', () => {
    const bitstream = new Uint8Array(
      readFileSync(new URL('./fixtures/conformance/hrd-a-fujitsu-first.hevc', import.meta.url)),
    );
    const nals = splitAnnexB(bitstream);
    expect(nals.map((nal) => nal.type)).toEqual([32, 33, 34, 19, 19, 19, 19]);
    const spsNal = nals.find((nal) => nal.type === 33)!;
    const sps = parseSps(spsNal.data);
    expect([
      sps.picWidthInLumaSamples,
      sps.picHeightInLumaSamples,
      sps.bitDepthLuma,
      sps.chromaFormatIdc,
    ]).toEqual([416, 240, 8, 1]);
    expect(nals.filter((nal) => isSliceNal(nal.type))).toHaveLength(4);

    const heif = wrapHevc(
      bitstream,
      sps.picWidthInLumaSamples,
      sps.picHeightInLumaSamples,
      sps.bitDepthLuma,
      sps.chromaFormatIdc,
    );
    const boxes = parseISOBMFF(heif);
    expect(getFtypInfo(heif)?.majorBrand).toBe('heic');
    const info = getHeicInfo(heif, boxes);
    const planes = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
    const actual = createHash('md5')
      .update(Buffer.from(planes.y))
      .update(Buffer.from(planes.cb))
      .update(Buffer.from(planes.cr))
      .digest('hex');

    // First-frame Y/Cb/Cr framemd5 from FFmpeg 9.0.1 decoding the official vector.
    expect(actual).toBe('9eb8570f92b9d7b35dfa3a57b0e743ee');
  });
});
