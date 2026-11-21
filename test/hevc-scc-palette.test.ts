import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { getHeicInfo } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { decodeItemPlanes } from '../src/planes';
import { wrapHevc } from '../scripts/lib/heif';

describe('HEVC SCC palette reconstruction', () => {
  it('matches the official zero/one palette-size picture checksum', () => {
    const bitstream = new Uint8Array(
      readFileSync(
        new URL('./fixtures/conformance/Zero_and_One_Palette_Size_A_Canon_2.bit', import.meta.url),
      ),
    );
    const heif = wrapHevc(bitstream, 1920, 1080, 8, 3);
    const boxes = parseISOBMFF(heif);
    const info = getHeicInfo(heif, boxes);
    const planes = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
    const actual = createHash('md5')
      .update(
        Buffer.concat([Buffer.from(planes.y), Buffer.from(planes.cb), Buffer.from(planes.cr)]),
      )
      .digest('hex');
    expect(actual).toBe('a7794b555c9ba89f7f01bb0ce5b66676');
  });
});
