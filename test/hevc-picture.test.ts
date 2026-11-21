import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'bun:test';
import { getHeicInfo, getItemPayload, parseHvcC } from '../src/container/heic';
import { getFtypInfo } from '../src/container/heif';
import { parseISOBMFF } from '../src/container/heif';
import { deblockPicture } from '../src/hevc/deblock';
import { BitReader, isSliceNal, splitLengthPrefixed, toRbsp } from '../src/hevc/nal';
import { PictureDecoder } from '../src/hevc/picture';
import { parsePps } from '../src/hevc/pps';
import { applySao } from '../src/hevc/sao';
import { parseSps, skipProfileTierLevel } from '../src/hevc/sps';
import { decodeHeic, getHeicMetadata } from '../src/decoder';
import { decodeHDRSync } from '../src/hdr';
import { box, buildHeif, codedFixture, u16 } from './helpers/heif';

const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(join(import.meta.dir, 'fixtures', name)));

function replaceSpsId(nal: Uint8Array, spsId: number): Uint8Array {
  const rbsp = toRbsp(nal);
  const reader = new BitReader(rbsp);
  reader.readBits(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = reader.readBits(3);
  reader.readBit(); // sps_temporal_id_nesting_flag
  skipProfileTierLevel(reader, maxSubLayersMinus1);
  const prefixEnd = reader.bitPosition;
  reader.ue();
  const suffixStart = reader.bitPosition;
  let stopBit = rbsp.length * 8 - 1;
  while (stopBit >= 0 && ((rbsp[stopBit >> 3] >> (7 - (stopBit & 7))) & 1) === 0) stopBit--;
  if (stopBit < suffixStart) throw new Error('SPS rbsp_trailing_bits not found');

  const bits: number[] = [];
  const appendExistingBits = (start: number, end: number) => {
    for (let index = start; index < end; index++)
      bits.push((rbsp[index >> 3] >> (7 - (index & 7))) & 1);
  };
  appendExistingBits(0, prefixEnd);
  const codeNum = spsId + 1;
  const codeWidth = Math.floor(Math.log2(codeNum)) + 1;
  for (let index = 1; index < codeWidth; index++) bits.push(0);
  for (let index = codeWidth - 1; index >= 0; index--) bits.push((codeNum >> index) & 1);
  appendExistingBits(suffixStart, stopBit);
  bits.push(1); // rbsp_stop_one_bit
  while (bits.length % 8) bits.push(0);

  const output = new Uint8Array(bits.length / 8);
  for (let index = 0; index < bits.length; index++)
    output[index >> 3] |= bits[index] << (7 - (index & 7));
  const escaped: number[] = [];
  let zeroCount = 0;
  for (const byte of output) {
    if (zeroCount >= 2 && byte <= 3) {
      escaped.push(3);
      zeroCount = 0;
    }
    escaped.push(byte);
    zeroCount = byte === 0 ? zeroCount + 1 : 0;
  }
  return Uint8Array.from([...nal.subarray(0, 2), ...escaped]);
}

function addHvcCSps(record: Uint8Array, sps: Uint8Array): Uint8Array {
  const source = Buffer.from(record);
  const arrays: Buffer[] = [];
  let offset = 23;
  let foundSpsArray = false;
  for (let arrayIndex = 0; arrayIndex < source[22]; arrayIndex++) {
    const start = offset;
    const arrayHeader = source[offset++];
    const nalType = arrayHeader & 0x3f;
    const count = source.readUInt16BE(offset);
    offset += 2;
    const units: Buffer[] = [];
    for (let unitIndex = 0; unitIndex < count; unitIndex++) {
      const length = source.readUInt16BE(offset);
      offset += 2;
      units.push(source.subarray(offset, offset + length));
      offset += length;
    }
    if (nalType === 33) {
      foundSpsArray = true;
      arrays.push(
        Buffer.concat([
          Buffer.from([arrayHeader]),
          u16(count + 1),
          ...units.flatMap((unit) => [u16(unit.length), unit]),
          u16(sps.length),
          sps,
        ]),
      );
    } else arrays.push(source.subarray(start, offset));
  }
  if (!foundSpsArray)
    arrays.push(Buffer.concat([Buffer.from([0xa1]), u16(1), u16(sps.length), sps]));
  const header = Buffer.from(source.subarray(0, 23));
  if (!foundSpsArray) header[22]++;
  return Buffer.concat([header, ...arrays]);
}

function decodeTile(buffer: Uint8Array, tileIndex: number, filter = false) {
  const boxes = parseISOBMFF(buffer);
  const info = getHeicInfo(buffer, boxes);
  const sps = parseSps(info.hvcC!.sps[0]);
  const pps = parsePps(info.hvcC!.pps[0]);
  const itemId = info.grid ? info.grid.tileItemIds[tileIndex] : info.primaryItemId;
  const payload = getItemPayload(buffer, boxes, itemId)!;
  const nals = splitLengthPrefixed(payload, info.hvcC!.nalLengthSize);
  const slices = nals.filter((n) => isSliceNal(n.type)).map((n) => n.data);
  const pic = new PictureDecoder(sps, pps).decode(slices);
  if (filter) {
    deblockPicture(pic, pps, sps.bitDepthLuma);
    applySao(pic, sps, sps.bitDepthLuma);
  }
  return pic;
}

describe('PictureDecoder', () => {
  it('selects the SPS referenced by the active PPS when hvcC has multiple SPS records', () => {
    const activeItem = codedFixture(8, 'pattern');
    const decoyItem = codedFixture(8, 'gradient');
    const hvcCProperty = (item: ReturnType<typeof codedFixture>) =>
      item.properties.find((property) => property.subarray(4, 8).toString() === 'hvcC');
    const activeConfig = parseHvcC(hvcCProperty(activeItem)!.subarray(8));
    const decoyConfig = parseHvcC(hvcCProperty(decoyItem)!.subarray(8));
    const decoySps = replaceSpsId(decoyConfig.sps[0], 1);
    expect(parseSps(decoySps).width).toBe(96);
    expect(parseSps(activeConfig.sps[0]).width).toBe(64);
    const input = buildHeif(
      [
        {
          ...activeItem,
          properties: activeItem.properties.map((property) =>
            property.subarray(4, 8).toString() === 'hvcC'
              ? box('hvcC', addHvcCSps(property.subarray(8), decoySps))
              : property,
          ),
        },
      ],
      activeItem.id,
    );
    expect(parseHvcC(addHvcCSps(hvcCProperty(activeItem)!.subarray(8), decoySps)).sps).toHaveLength(
      2,
    );
    expect(getHeicMetadata(input).sps?.width).toBe(64);
    const baseline = buildHeif([activeItem], activeItem.id);
    const expected = decodeHeic(baseline);
    const actual = decodeHeic(input);
    expect([actual.width, actual.height, actual.bitDepth]).toEqual([
      expected.width,
      expected.height,
      expected.bitDepth,
    ]);
    expect(actual.data).toEqual(expected.data);
    expect(decodeHDRSync(input).data).toEqual(decodeHDRSync(baseline).data);
  });

  it('decodes tile 0 of iphone-small bit-exactly (verified vs libde265)', () => {
    const pic = decodeTile(fixture('iphone-small.heic'), 0);
    expect(pic.width).toBe(640);
    expect(pic.height).toBe(896);
    // SHA-256 of Y+Cb+Cr planes, identical to libde265's pre-loop-filter
    // reconstruction of the same tile (--disable-deblocking --disable-sao).
    const hash = createHash('sha256').update(pic.y).update(pic.cb).update(pic.cr).digest('hex');
    expect(hash).toBe('9fa68e415559979da659909f50f6a22049f0bd72c7ec6dbd0dab823e93c01dc2');
  });

  it('matches libde265 bit-exactly after deblocking + SAO', () => {
    const pic = decodeTile(fixture('iphone-small.heic'), 0, true);
    // SHA-256 of the fully filtered tile, identical to libde265's default
    // (deblock + SAO) reconstruction.
    const hash = createHash('sha256').update(pic.y).update(pic.cb).update(pic.cr).digest('hex');
    expect(hash).toBe('57f19be89b92c4b126628c762972faf1b553cc1935d54ec183eaaae74c84ac66');
  });

  it('decodes 4:2:2 chroma transform blocks bit-exactly against FFmpeg', () => {
    const input = fixture('conformance/chroma422-8.heic');
    expect(getFtypInfo(input)?.majorBrand).toBe('heix');
    const info = getHeicInfo(input, parseISOBMFF(input));
    expect(info.hvcC?.generalProfileIdc).toBe(4);
    expect(info.hvcC?.chromaFormatIdc).toBe(2);
    const pic = decodeTile(input, 0, true);
    expect(pic.chromaFormatIdc).toBe(2);
    expect(pic.width).toBe(64);
    expect(pic.height).toBe(64);
    const actual = Buffer.concat([Buffer.from(pic.y), Buffer.from(pic.cb), Buffer.from(pic.cr)]);
    expect(actual).toEqual(Buffer.from(fixture('conformance/chroma422-8.yuv')));

    const image = decodeHeic(input);
    expect([image.width, image.height, image.data.length]).toEqual([64, 64, 64 * 64 * 4]);
  });

  it('decodes official 10-bit 4:2:2 PCM blocks bit-exactly against FFmpeg', () => {
    const input = fixture('conformance/pcm-rext-422-10.heic');
    expect(getFtypInfo(input)?.majorBrand).toBe('heix');
    const info = getHeicInfo(input, parseISOBMFF(input));
    const sps = parseSps(info.hvcC!.sps[0]);
    expect([sps.bitDepthLuma, sps.pcmSampleBitDepthLuma, sps.chromaFormatIdc]).toEqual([10, 8, 2]);

    const pic = decodeTile(input, 0, true);
    expect([pic.width, pic.height, pic.chromaFormatIdc]).toEqual([416, 240, 2]);
    const bytes = (plane: Uint8Array | Uint16Array) =>
      Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength);
    const actual = Buffer.concat([bytes(pic.y), bytes(pic.cb), bytes(pic.cr)]);
    expect(actual).toEqual(Buffer.from(fixture('conformance/pcm-rext-422-10.yuv')));

    const image = decodeHeic(input);
    expect([image.width, image.height, image.data.length]).toEqual([416, 240, 416 * 240 * 4]);
  });

  it('decodes official 12-bit 4:4:4 PCM blocks bit-exactly against FFmpeg', () => {
    const input = fixture('conformance/pcm-rext-444-12.heic');
    expect(getFtypInfo(input)?.majorBrand).toBe('heix');
    const info = getHeicInfo(input, parseISOBMFF(input));
    const sps = parseSps(info.hvcC!.sps[0]);
    expect([sps.bitDepthLuma, sps.pcmSampleBitDepthLuma, sps.chromaFormatIdc]).toEqual([12, 8, 3]);

    const pic = decodeTile(input, 0, true);
    expect([pic.width, pic.height, pic.chromaFormatIdc]).toEqual([416, 240, 3]);
    const bytes = (plane: Uint8Array | Uint16Array) =>
      Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength);
    const actual = Buffer.concat([bytes(pic.y), bytes(pic.cb), bytes(pic.cr)]);
    expect(actual).toEqual(Buffer.from(fixture('conformance/pcm-rext-444-12.yuv')));

    const image = decodeHeic(input);
    expect([image.width, image.height, image.data.length]).toEqual([416, 240, 416 * 240 * 4]);
  });

  it('decodes the official CABAC bypass-alignment vector bit-exactly against HM 16.14', () => {
    const input = fixture('conformance/cabac-bypass-align-14-i.heic');
    expect(getFtypInfo(input)?.majorBrand).toBe('heix');
    const info = getHeicInfo(input, parseISOBMFF(input));
    const sps = parseSps(info.hvcC!.sps[0]);
    expect([sps.width, sps.height, sps.bitDepthLuma, sps.chromaFormatIdc]).toEqual([
      1024, 768, 8, 1,
    ]);
    expect(sps.cabacBypassAlignmentEnabled).toBe(true);

    const pic = decodeTile(input, 0, true);
    const actual = Buffer.concat([Buffer.from(pic.y), Buffer.from(pic.cb), Buffer.from(pic.cr)]);
    expect(actual).toEqual(Buffer.from(fixture('conformance/cabac-bypass-align-14-i.yuv')));
  });

  it('decodes every tile of both fixtures without CABAC desync', () => {
    // The decoder throws on any end_of_slice/end_of_subset mismatch, so a
    // clean run is itself a strong bitstream-conformance check.
    for (const name of ['iphone-small.heic', 'iphone-grid.heic']) {
      const buffer = fixture(name);
      const boxes = parseISOBMFF(buffer);
      const info = getHeicInfo(buffer, boxes);
      const tiles = info.grid ? info.grid.tileItemIds.length : 1;
      for (let t = 0; t < tiles; t++) {
        const pic = decodeTile(buffer, t);
        expect(pic.y.length).toBe(pic.width * pic.height);
      }
    }
  }, 120000);
});
