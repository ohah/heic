import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { getHeicInfo, validatePixiBitDepths } from '../src/container/heic';
import { parseISOBMFF, parsePixi } from '../src/container/heif';
import { decodeHeic } from '../src/decoder';
import { decodeItemPlanes } from '../src/planes';
import { createRenderContext, decodeNative, decodeRendered } from '../src/render';
import { box, buildHeif, codedFixture } from './helpers/heif';

function pixi(flags: number, ...fields: Uint8Array[]): Uint8Array {
  return box('pixi', Uint8Array.from([0, 0, 0, flags]), ...fields);
}

function isPixiProperty(property: Uint8Array): boolean {
  return String.fromCharCode(...property.subarray(4, 8)) === 'pixi';
}

describe('PixelInformationProperty', () => {
  it('parses the legacy bit-depth-only form', () => {
    expect(parsePixi(Uint8Array.from([0, 0, 0, 0, 3, 8, 10, 12]))).toEqual({
      bitsPerChannel: [8, 10, 12],
    });
  });

  it('parses Amendment 2 channel identity, component format, subsampling, and UTF-8 labels', () => {
    const extended = Uint8Array.from([
      0,
      0,
      0,
      1, // version and px_flags
      3, // num_channels
      8,
      8,
      8, // bits_per_channel[]
      0x41,
      0x59,
      0, // Y: unsigned integer, label present
      0x63,
      0x11, // Cb: unsigned integer, subsampling type 1/location 1, label present
      0x43,
      0x62,
      0, // Cb label
      0x83,
      0x11, // Cr: unsigned integer, matching subsampling and label
      0x43,
      0x72,
      0, // Cr label
    ]);
    expect(parsePixi(extended)).toEqual({
      bitsPerChannel: [8, 8, 8],
      channels: [
        { channelIdc: 2, componentFormat: 0, label: 'Y' },
        {
          channelIdc: 3,
          componentFormat: 0,
          subsampling: { type: 1, location: 1 },
          label: 'Cb',
        },
        {
          channelIdc: 4,
          componentFormat: 0,
          subsampling: { type: 1, location: 1 },
          label: 'Cr',
        },
      ],
    });
  });

  it('cross-checks extended pixi depths by channel identity instead of array order', () => {
    const reordered = {
      bitsPerChannel: [8, 10, 8],
      channels: [
        { channelIdc: 3, componentFormat: 0 as const },
        { channelIdc: 2, componentFormat: 0 as const },
        { channelIdc: 4, componentFormat: 0 as const },
      ],
    };
    expect(() => validatePixiBitDepths(reordered, 10, 8)).not.toThrow();
    expect(() => validatePixiBitDepths(reordered, 8, 10)).toThrow(
      'pixi bit depths disagree with hvcC',
    );
    expect(() =>
      validatePixiBitDepths(reordered, 10, 10, 'selected representation format'),
    ).toThrow('pixi bit depths disagree with selected representation format');
  });

  it('rejects reserved, truncated, and contradictory syntax', () => {
    expect(() => parsePixi(new Uint8Array(4))).toThrow('truncated pixel information');
    expect(() => parsePixi(Uint8Array.from([0, 0, 0, 0, 1, 0]))).toThrow('bit depth is zero');
    expect(() => parsePixi(Uint8Array.from([0, 0, 0, 1, 1, 8]))).toThrow(
      'truncated pixel information',
    );
    expect(() => parsePixi(Uint8Array.from([0, 0, 0, 1, 1, 8, 0x10]))).toThrow('reserved bit');
    expect(parsePixi(Uint8Array.from([0, 0, 0, 1, 1, 8, 0x0c]))).toEqual({
      bitsPerChannel: [8],
      channels: [{ channelIdc: 0, componentFormat: 3 }],
    });
    expect(() => parsePixi(Uint8Array.from([0, 0, 0, 1, 1, 8, 0x42, 0x60]))).toThrow(
      'reserved pixel information subsampling value',
    );
    expect(() => parsePixi(Uint8Array.from([0, 0, 0, 1, 2, 8, 8, 0xa0, 0xa0]))).toThrow(
      'duplicate alpha channels',
    );
    expect(() => parsePixi(Uint8Array.from([0, 0, 0, 1, 1, 8, 0x41, 0x59]))).toThrow(
      'unterminated pixel information channel label',
    );
  });

  it('decodes an official 10-bit 4:2:2 HEVC vector with Amendment 2 pixi metadata', () => {
    const item = codedFixture(10, 'pcm-rext-422');
    const extendedPixi = pixi(
      1,
      Uint8Array.from([3, 10, 10, 10, 0x41, 0x59, 0, 0x62, 0x11, 0x82, 0x11]),
    );
    item.properties = item.properties.map((property) =>
      isPixiProperty(property) ? extendedPixi : property,
    );
    const heif = buildHeif([item], item.id);
    const boxes = parseISOBMFF(heif);
    const info = getHeicInfo(heif, boxes);
    expect(info.chromaSampleLocations).toEqual({
      cb: { x: 0.5, y: 0 },
      cr: { x: 0.5, y: 0 },
    });
    const planes = decodeItemPlanes(heif, boxes, info, item.id);
    const bytes = (plane: Uint8Array | Uint16Array) =>
      Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength);
    const actual = Buffer.concat([bytes(planes.y), bytes(planes.cb), bytes(planes.cr)]);
    const reference = readFileSync(
      new URL('./fixtures/conformance/pcm-rext-422-10.yuv', import.meta.url),
    );
    expect(actual).toEqual(reference);

    const rendered = decodeNative(createRenderContext(heif), undefined, false, false);
    const cosited = decodeNative(createRenderContext(heif), undefined, false, false, {
      chromaSampleLocations: { cb: { x: 0, y: 0 }, cr: { x: 0, y: 0 } },
    });
    expect(rendered.data).not.toEqual(cosited.data);
  });

  it('rejects pixi chroma subsampling that contradicts hvcC', () => {
    const item = codedFixture(10, 'pcm-rext-422');
    const wrongPixi = pixi(1, Uint8Array.from([3, 10, 10, 10, 0x40, 0x62, 0x20, 0x82, 0x20]));
    item.properties = item.properties.map((property) =>
      isPixiProperty(property) ? wrongPixi : property,
    );
    const heif = buildHeif([item], item.id);
    expect(() => getHeicInfo(heif, parseISOBMFF(heif))).toThrow(
      'pixi chroma subsampling disagrees with the HEVC chroma format',
    );
  });

  it('uses 4:2:0 pixi locations in the public RGB decoder', () => {
    const item = codedFixture(8, 'pattern');
    const explicitLocation = pixi(1, Uint8Array.from([3, 8, 8, 8, 0x40, 0x62, 0x20, 0x82, 0x20]));
    item.properties = item.properties.map((property) =>
      isPixiProperty(property) ? explicitLocation : property,
    );
    const input = buildHeif([item], item.id);
    expect(getHeicInfo(input, parseISOBMFF(input)).chromaSampleLocations).toEqual({
      cb: { x: 0, y: 0.5 },
      cr: { x: 0, y: 0.5 },
    });
    const decoded = decodeHeic(input);
    expect(decoded.data).toEqual(decodeRendered(input, {}).data);

    const withoutLocation = buildHeif([codedFixture(8, 'pattern')], item.id);
    expect(decoded.data).not.toEqual(decodeHeic(withoutLocation).data);
  });

  it('rejects floating-point component metadata on an HEVC image item', () => {
    const item = codedFixture(10, 'pcm-rext-422');
    const floatPixi = pixi(1, Uint8Array.from([3, 10, 10, 10, 0x44, 0x64, 0x84]));
    item.properties = item.properties.map((property) =>
      isPixiProperty(property) ? floatPixi : property,
    );
    const heif = buildHeif([item], item.id);
    expect(() => getHeicInfo(heif, parseISOBMFF(heif))).toThrow(
      'HEVC pixel information must use unsigned-integer components',
    );
  });

  it('still rejects signed component metadata on an HEVC image item', () => {
    const item = codedFixture(10, 'pcm-rext-422');
    const signedPixi = pixi(1, Uint8Array.from([3, 10, 10, 10, 0x4c, 0x6c, 0x8c]));
    item.properties = item.properties.map((property) =>
      isPixiProperty(property) ? signedPixi : property,
    );
    const heif = buildHeif([item], item.id);
    expect(() => getHeicInfo(heif, parseISOBMFF(heif))).toThrow(
      'HEVC pixel information must use unsigned-integer components',
    );
  });
});
