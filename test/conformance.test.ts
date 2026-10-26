import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'bun:test';
import {
  decodeHeic,
  getHeicMetadata,
  getItemPayload,
  parseISOBMFF,
  splitLengthPrefixed,
  isSliceNal,
  parsePps,
  PictureDecoder,
} from '../src';
import { deblockPicture } from '../src/hevc/deblock';
import { applySao } from '../src/hevc/sao';

for (const depth of [8, 10, 12])
  for (const pattern of ['pattern', 'gradient', 'chroma444']) {
    it(`${depth}-bit ${pattern}: all reconstructed samples equal FFmpeg reference`, () => {
      const prefix = join(import.meta.dir, 'fixtures', 'conformance', `${pattern}-${depth}`);
      const input = new Uint8Array(readFileSync(prefix + '.heic'));
      const metadata = getHeicMetadata(input);
      const pps = parsePps(metadata.hvcC!.pps[0]);
      const payload = getItemPayload(input, parseISOBMFF(input), metadata.primaryItemId)!;
      const slices = splitLengthPrefixed(payload, metadata.hvcC!.nalLengthSize)
        .filter((n) => isSliceNal(n.type))
        .map((n) => n.data);
      const pic = new PictureDecoder(metadata.sps!, pps).decode(slices);
      deblockPicture(pic, pps, depth);
      applySao(pic, metadata.sps!, depth);
      const reference = readFileSync(prefix + '.yuv');
      let i = 0;
      for (const plane of [pic.y, pic.cb, pic.cr])
        for (const sample of plane) {
          expect(sample).toBe(depth === 8 ? reference[i++] : reference.readUInt16LE(i++ * 2));
        }
      const image = decodeHeic(input);
      expect(image.bitDepth).toBe(depth);
      expect(image.data.length).toBe(image.width * image.height * 4);
    });
  }
