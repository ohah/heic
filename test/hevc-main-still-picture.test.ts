import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { getHeicInfo } from '../src/container/heic.js';
import { parseISOBMFF } from '../src/container/heif.js';
import { decodeHeic } from '../src/decoder.js';
import { decodeItemPlanes } from '../src/planes.js';
import { wrapHevc } from '../scripts/lib/heif.js';

const fixture = new Uint8Array(
  readFileSync(new URL('./fixtures/conformance/ipred-b-nokia-3.bit', import.meta.url)),
);

it('decodes the official Main Still Picture intra-prediction vector through HEIF', () => {
  expect(createHash('sha256').update(fixture).digest('hex')).toBe(
    '456608ae5c14fea0496d770ae9614cd3d7c6ae98c14b22d64bbd96b37f49d7a0',
  );

  const heif = wrapHevc(fixture, 1920, 1080, 8, 1);
  const boxes = parseISOBMFF(heif);
  const info = getHeicInfo(heif, boxes);
  expect(info.primaryItemType).toBe('hvc1');
  expect([info.width, info.height, info.bitDepth]).toEqual([1920, 1080, 8]);

  const planes = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
  const yuv = Buffer.concat([
    Buffer.from(planes.y),
    Buffer.from(planes.cb),
    Buffer.from(planes.cr),
  ]);
  expect(createHash('md5').update(yuv).digest('hex')).toBe('ec3bcad4f9174404e52d132206b6617b');

  const image = decodeHeic(heif);
  expect([image.width, image.height, image.bitDepth, image.data.length]).toEqual([
    1920,
    1080,
    8,
    1920 * 1080 * 4,
  ]);
});
