import { describe, expect, it } from 'bun:test';
import { brotliCompressSync, deflateRawSync, deflateSync } from 'node:zlib';
import { decodeHDRSync } from '../src/hdr';
import { decode, decodeHDR } from '../src/async';
import { decodeHeicUncompressedComponents } from '../src';
import { decodeHeic, getHeicMetadata, isHeic } from '../src/decoder';
import { getHeicInfo, getItemPayload } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { decodeUncompressedImage } from '../src/container/uncompressed';
import { box, buildHeif, full, u16, u32 } from './helpers/heif';

function uncompressedFixture(
  componentTypes: number[],
  payload: Uint8Array,
  interleaveType: 0 | 1 | 2 | 3 | 4 | 5,
  color?: { primaries: number; transfer: number; matrix: number; fullRange: boolean },
  layout: {
    width?: number;
    height?: number;
    samplingType?: number;
    bitDepth?: number;
    componentBitDepths?: number[];
    componentFormats?: number[];
    componentAlignSize?: number;
    componentAlignSizes?: number[];
    blockSize?: number;
    pixelSize?: number;
    componentsLittleEndian?: boolean;
    layoutFlags?: number;
    rowAlignSize?: number;
    tileAlignSize?: number;
    tileColumns?: number;
    tileRows?: number;
    profileCode?: number;
    pixiBitDepth?: number;
    pixiBitDepths?: number[];
    pixiComponentFormats?: number[];
    compressionType?: 'defl' | 'zlib' | 'brot';
    compressedUnitType?: number;
    icef?: Uint8Array;
  } = {},
) {
  const width = layout.width ?? 2,
    height = layout.height ?? 1,
    samplingType = layout.samplingType ?? 0,
    bitDepth = layout.bitDepth ?? 8,
    componentAlignSize = layout.componentAlignSize ?? 0,
    cmpd = box('cmpd', u32(componentTypes.length), ...componentTypes.map(u16));
  const uncCFields = Buffer.concat([
    u32(layout.profileCode ?? 0), // custom profile or known predefined configuration
    u32(componentTypes.length),
    ...componentTypes.map((_, index) =>
      Buffer.concat([
        u16(index),
        Buffer.from([
          (layout.componentBitDepths?.[index] ?? bitDepth) - 1,
          layout.componentFormats?.[index] ?? 0,
          layout.componentAlignSizes?.[index] ?? componentAlignSize,
        ]),
      ]),
    ),
    Buffer.from([
      samplingType,
      interleaveType,
      layout.blockSize ?? 0,
      layout.layoutFlags ?? (layout.componentsLittleEndian ? 0x80 : 0),
    ]), // sampling, interleave, block size, and component/block layout flags
    u32(layout.pixelSize ?? 0), // pixel_size
    u32(layout.rowAlignSize ?? 0), // row_align_size
    u32(layout.tileAlignSize ?? 0), // tile_align_size
    u32((layout.tileColumns ?? 1) - 1), // num_tile_cols_minus_one
    u32((layout.tileRows ?? 1) - 1), // num_tile_rows_minus_one
  ]);
  const properties = [
    full('ispe', 0, u32(width), u32(height)),
    cmpd,
    full('uncC', 0, uncCFields),
    ...(layout.compressionType === undefined
      ? []
      : [
          full(
            'cmpC',
            0,
            Buffer.from(layout.compressionType),
            Buffer.from([layout.compressedUnitType ?? 0]),
          ),
        ]),
    ...(layout.icef === undefined ? [] : [full('icef', 0, layout.icef)]),
    ...(layout.pixiBitDepth === undefined
      ? []
      : [
          box(
            'pixi',
            Buffer.from([0, 0, 0, layout.pixiComponentFormats === undefined ? 0 : 1]),
            Buffer.from([
              componentTypes.length,
              ...componentTypes.map(
                (_, index) => layout.pixiBitDepths?.[index] ?? layout.pixiBitDepth!,
              ),
              ...(layout.pixiComponentFormats === undefined
                ? []
                : componentTypes.map((type, index) => {
                    const channelIdc =
                      type === 0 || type === 1 || type === 4
                        ? 2
                        : type === 2 || type === 5
                          ? 3
                          : type === 3 || type === 6
                            ? 4
                            : type === 7
                              ? 5
                              : 0;
                    return (channelIdc << 5) | ((layout.pixiComponentFormats![index] ?? 0) << 2);
                  })),
            ]),
          ),
        ]),
    ...(color
      ? [
          box(
            'colr',
            Buffer.from('nclx'),
            u16(color.primaries),
            u16(color.transfer),
            u16(color.matrix),
            Buffer.from([color.fullRange ? 0x80 : 0]),
          ),
        ]
      : []),
  ];
  return buildHeif([{ id: 1, type: 'unci', data: payload, properties }], 1);
}

function yv20ProfileFixture(payload: Uint8Array, componentTypes?: number[]) {
  const properties = [
    full('ispe', 0, u32(2), u32(2)),
    ...(componentTypes
      ? [box('cmpd', u32(componentTypes.length), ...componentTypes.map(u16))]
      : []),
    full('uncC', 1, Buffer.from('yv20')),
  ];
  return buildHeif([{ id: 1, type: 'unci', data: payload, properties }], 1);
}

function packUnalignedSamples(values: number[], bitDepth: number): Buffer {
  const packed = Buffer.alloc(Math.ceil((values.length * bitDepth) / 8));
  let bitOffset = 0;
  for (const value of values) {
    for (let bit = bitDepth - 1; bit >= 0; bit--) {
      if ((value >> bit) & 1) packed[bitOffset >> 3] |= 1 << (7 - (bitOffset & 7));
      bitOffset++;
    }
  }
  return packed;
}

function packBlockValue(value: bigint, blockSize: number, littleEndian = false): Buffer {
  const bytes = Buffer.alloc(blockSize);
  for (let index = 0; index < blockSize; index++) {
    const byteIndex = littleEndian ? index : blockSize - index - 1;
    bytes[byteIndex] = Number(value & 0xffn);
    value >>= 8n;
  }
  return bytes;
}

function ieeePowerOfTwoBits(bitDepth: number, power: number): bigint {
  const exponentBits =
      bitDepth === 16 ? 5 : bitDepth === 32 ? 8 : bitDepth === 64 ? 11 : bitDepth === 128 ? 15 : 19,
    bias = 2 ** (exponentBits - 1) - 1;
  return BigInt(bias + power) << BigInt(bitDepth - exponentBits - 1);
}

function packBitPatterns(values: bigint[], bitDepth: number): Buffer {
  const packed = Buffer.alloc(Math.ceil((values.length * bitDepth) / 8));
  let bitOffset = 0;
  for (const value of values) {
    for (let bit = bitDepth - 1; bit >= 0; bit--) {
      if ((value >> BigInt(bit)) & 1n) packed[bitOffset >> 3] |= 1 << (7 - (bitOffset & 7));
      bitOffset++;
    }
  }
  return packed;
}

function decodeUncompressedFixture(input: Uint8Array) {
  const boxes = parseISOBMFF(input),
    info = getHeicInfo(input, boxes),
    payload = getItemPayload(input, boxes, info.primaryItemId);
  if (!info.uncompressedImage || !payload)
    throw new Error('expected decoded uncompressed item payload and configuration');
  return decodeUncompressedImage(payload, info.uncompressedImage);
}

describe('ISO/IEC 23001-17 uncompressed HEIF image items', () => {
  it('extracts complex components as raw real/imaginary pairs without assigning RGBA meaning', () => {
    for (const bitDepth of [32, 64]) {
      const halfDepth = bitDepth / 2,
        complexWord = (realPower: number, imaginaryPower: number) =>
          (ieeePowerOfTwoBits(halfDepth, realPower) << BigInt(halfDepth)) |
          ieeePowerOfTwoBits(halfDepth, imaginaryPower),
        input = uncompressedFixture(
          [0],
          packBitPatterns([complexWord(-2, -1), complexWord(1, -2)], bitDepth),
          0,
          undefined,
          {
            width: 2,
            height: 1,
            bitDepth,
            componentFormats: [2],
          },
        ),
        decoded = decodeHeicUncompressedComponents(input);

      expect(decoded.itemId).toBe(1);
      expect([decoded.width, decoded.height]).toEqual([2, 1]);
      expect(decoded.components).toHaveLength(1);
      expect(decoded.components[0]).toMatchObject({
        componentIndex: 0,
        componentType: 0,
        bitDepth,
        componentFormat: 2,
        width: 2,
        height: 1,
        valuesPerSample: 2,
      });
      expect([...decoded.components[0].data]).toEqual([0.25, 0.5, 2, 0.25]);
      expect(() => decodeHeic(input)).toThrow(/no standard RGBA mapping/);
    }
  });

  it('preserves complex components in aligned little-endian and block-pixel layouts', () => {
    const complexWord = 0x3800bc00n,
      aligned = uncompressedFixture(
        [8],
        Buffer.from([0x00, 0xbc, 0x00, 0x38, 0, 0]),
        0,
        undefined,
        {
          width: 1,
          height: 1,
          bitDepth: 32,
          componentFormats: [2],
          componentAlignSizes: [6],
          componentsLittleEndian: true,
        },
      ),
      blockPacked = uncompressedFixture([8], packBlockValue(complexWord, 8, true), 1, undefined, {
        width: 1,
        height: 1,
        bitDepth: 32,
        componentFormats: [2],
        blockSize: 8,
        pixelSize: 8,
        layoutFlags: 0x20,
      });

    expect([...decodeHeicUncompressedComponents(aligned).components[0].data]).toEqual([0.5, -1]);
    expect([...decodeHeicUncompressedComponents(blockPacked).components[0].data]).toEqual([
      0.5, -1,
    ]);
  });

  it('exposes signed integer component values as sign-extended numbers', () => {
    const input = uncompressedFixture([8], Buffer.from([0x80, 0x7f]), 0, undefined, {
      width: 2,
      height: 1,
      bitDepth: 8,
      componentFormats: [3],
    });
    expect([...decodeHeicUncompressedComponents(input).components[0].data]).toEqual([-128, 127]);
  });

  it('returns separate sample phases for complex Multi-Y components', () => {
    const complexWord = (realBits: bigint, imaginaryBits: bigint) =>
        (realBits << 16n) | imaginaryBits,
      input = uncompressedFixture(
        [1, 1, 2, 3],
        Buffer.concat([
          packBitPatterns([complexWord(0x3800n, 0x3400n), complexWord(0x4000n, 0xbc00n)], 32),
          Buffer.from([128, 129]),
        ]),
        5,
        undefined,
        {
          width: 2,
          height: 1,
          samplingType: 1,
          componentBitDepths: [32, 32, 8, 8],
          componentFormats: [2, 2, 0, 0],
        },
      ),
      decoded = decodeHeicUncompressedComponents(input);

    expect(
      decoded.components.map(({ componentType, multiYOffset, width, height }) => ({
        componentType,
        multiYOffset,
        width,
        height,
      })),
    ).toEqual([
      { componentType: 1, multiYOffset: 0, width: 1, height: 1 },
      { componentType: 1, multiYOffset: 1, width: 1, height: 1 },
      { componentType: 2, multiYOffset: undefined, width: 1, height: 1 },
      { componentType: 3, multiYOffset: undefined, width: 1, height: 1 },
    ]);
    expect([...decoded.components[0].data]).toEqual([0.5, 0.25]);
    expect([...decoded.components[1].data]).toEqual([2, -1]);
    expect([...decoded.components[2].data]).toEqual([128]);
    expect([...decoded.components[3].data]).toEqual([129]);
  });

  it('rejects complex widths outside the standard component-size set and keeps non-finite IEEE values raw', () => {
    for (const bitDepth of [16, 48]) {
      const invalidDepth = uncompressedFixture(
        [0],
        Buffer.alloc(Math.ceil(bitDepth / 8)),
        0,
        undefined,
        { width: 1, height: 1, bitDepth, componentFormats: [2] },
      );
      expect(() => decodeHeicUncompressedComponents(invalidDepth)).toThrow(
        /complex components require 32\/64\/128\/256 bits/,
      );
    }

    const nonFinite = uncompressedFixture(
        [0],
        packBitPatterns([(0x7c00n << 16n) | 0x7e00n], 32),
        0,
        undefined,
        { width: 1, height: 1, bitDepth: 32, componentFormats: [2] },
      ),
      data = decodeHeicUncompressedComponents(nonFinite).components[0].data;
    expect(data[0]).toBe(Number.POSITIVE_INFINITY);
    expect(Number.isNaN(data[1])).toBe(true);
  });

  it('decodes IEEE 754 RGB floats from all signalled uncC widths through sync and async APIs', async () => {
    for (const bitDepth of [16, 32, 64, 128, 256]) {
      const input = uncompressedFixture(
          [4, 5, 6],
          packBitPatterns(
            [
              ieeePowerOfTwoBits(bitDepth, -2),
              ieeePowerOfTwoBits(bitDepth, -1),
              ieeePowerOfTwoBits(bitDepth, 1),
            ],
            bitDepth,
          ),
          1,
          { primaries: 1, transfer: 8, matrix: 0, fullRange: true },
          {
            width: 1,
            height: 1,
            bitDepth,
            componentBitDepths: [bitDepth, bitDepth, bitDepth],
            componentFormats: [1, 1, 1],
            ...(bitDepth <= 255 ? { pixiBitDepth: bitDepth, pixiComponentFormats: [1, 1, 1] } : {}),
          },
        ),
        expectedSamples = Float32Array.from([0.25 * 65535, 0.5 * 65535, 2 * 65535, 65535]),
        pixels = decodeUncompressedFixture(input);

      expect(pixels.model).toBe('rgb');
      if (pixels.model !== 'rgb') throw new Error('expected RGB float samples');
      expect(pixels.rgba).toEqual(expectedSamples);
      expect([...decodeHeic(input).data]).toEqual([64, 128, 255, 255]);
      expect([...(await decode(input, { execution: 'main' })).data]).toEqual([64, 128, 255, 255]);
      const hdr = decodeHDRSync(input);
      expect(hdr.data[0]).toBeCloseTo(0.25, 5);
      expect(hdr.data[1]).toBeCloseTo(0.5, 5);
      expect(hdr.data[2]).toBeCloseTo(2, 5);
      expect(hdr.data[3]).toBe(1);
      expect(hdr.headroom).toBeCloseTo(2, 5);
      expect(hdr.sourceHeadroom).toBeCloseTo(2, 5);
      expect(hdr.source).toBe('linear-float');
      const asyncHdr = await decodeHDR(input, { execution: 'main' });
      expect(asyncHdr.data[2]).toBeCloseTo(2, 5);
      expect(asyncHdr.source).toBe('linear-float');
    }
  });

  it('decodes float YCbCr and aligned big-/little-endian float components', () => {
    const color = { primaries: 1, transfer: 8, matrix: 1, fullRange: true },
      yuv = uncompressedFixture(
        [1, 2, 3],
        packBitPatterns(
          [ieeePowerOfTwoBits(16, -1), ieeePowerOfTwoBits(16, -1), ieeePowerOfTwoBits(16, -1)],
          16,
        ),
        0,
        color,
        {
          width: 1,
          height: 1,
          bitDepth: 16,
          componentFormats: [1, 1, 1],
        },
      );
    const yuvHdr = decodeHDRSync(yuv);
    expect(yuvHdr.data[0]).toBeCloseTo(0.5, 4);
    expect(yuvHdr.data[1]).toBeCloseTo(0.5, 4);
    expect(yuvHdr.data[2]).toBeCloseTo(0.5, 4);

    const words = [-2, -1, 0].map((power) => {
      let bits = ieeePowerOfTwoBits(32, power);
      const word = Buffer.alloc(4);
      for (let index = 3; index >= 0; index--) {
        word[index] = Number(bits & 0xffn);
        bits >>= 8n;
      }
      return word;
    });
    for (const littleEndian of [false, true]) {
      const payload = Buffer.concat(
        words.map((word) =>
          littleEndian
            ? Buffer.concat([Buffer.from([...word].reverse()), Buffer.alloc(1)])
            : Buffer.concat([Buffer.alloc(1), word]),
        ),
      );
      const input = uncompressedFixture([4, 5, 6], payload, 0, undefined, {
        width: 1,
        height: 1,
        bitDepth: 32,
        componentBitDepths: [32, 32, 32],
        componentFormats: [1, 1, 1],
        componentAlignSizes: [5, 5, 5],
        componentsLittleEndian: littleEndian,
      });
      const decoded = decodeUncompressedFixture(input);
      if (decoded.model !== 'rgb') throw new Error('expected RGB float samples');
      expect(decoded.rgba).toEqual(Float32Array.from([0.25 * 65535, 0.5 * 65535, 65535, 65535]));
    }
  });

  it('decodes all float widths in block-pixel and block-component layouts', () => {
    const color = { primaries: 1, transfer: 8, matrix: 0, fullRange: true };

    for (const bitDepth of [16, 32, 64, 128, 256]) {
      const samples = [
          ieeePowerOfTwoBits(bitDepth, -2),
          ieeePowerOfTwoBits(bitDepth, -1),
          ieeePowerOfTwoBits(bitDepth, 0),
        ],
        blockPixelSize = (3 * bitDepth) / 8,
        componentBlocks = uncompressedFixture(
          [4, 5, 6],
          Buffer.concat(samples.map((sample) => packBlockValue(sample, bitDepth / 8))),
          0,
          color,
          {
            width: 1,
            height: 1,
            bitDepth,
            componentFormats: [1, 1, 1],
            blockSize: bitDepth / 8,
          },
        ),
        pixelBlock = uncompressedFixture(
          [4, 5, 6],
          packBlockValue(
            (samples[0] << BigInt(bitDepth * 2)) | (samples[1] << BigInt(bitDepth)) | samples[2],
            blockPixelSize,
          ),
          1,
          color,
          {
            width: 1,
            height: 1,
            bitDepth,
            componentFormats: [1, 1, 1],
            blockSize: blockPixelSize,
            pixelSize: blockPixelSize,
          },
        );

      for (const input of [componentBlocks, pixelBlock]) {
        expect([...decodeHeic(input).data]).toEqual([64, 128, 255, 255]);
        expect([...decodeHDRSync(input).data]).toEqual([0.25, 0.5, 1, 1]);
      }
    }
  });

  it('decodes all float widths in row and tile-component interleave', () => {
    const color = { primaries: 1, transfer: 8, matrix: 0, fullRange: true };

    for (const bitDepth of [16, 32, 64, 128, 256]) {
      const samples = [
          ieeePowerOfTwoBits(bitDepth, -2),
          ieeePowerOfTwoBits(bitDepth, -1),
          ieeePowerOfTwoBits(bitDepth, 0),
        ],
        payload = packBitPatterns(samples, bitDepth),
        rowInterleaved = uncompressedFixture([4, 5, 6], payload, 3, color, {
          width: 1,
          height: 1,
          bitDepth,
          componentFormats: [1, 1, 1],
        }),
        tileComponentInterleaved = uncompressedFixture([4, 5, 6], payload, 4, color, {
          width: 1,
          height: 1,
          bitDepth,
          componentFormats: [1, 1, 1],
        });

      for (const input of [rowInterleaved, tileComponentInterleaved]) {
        expect([...decodeHeic(input).data]).toEqual([64, 128, 255, 255]);
        expect([...decodeHDRSync(input).data]).toEqual([0.25, 0.5, 1, 1]);
      }
    }
  });

  it('preserves negative finite linear floats and rejects NaN and infinity', () => {
    const linearValues = uncompressedFixture(
        [4, 5, 6],
        packBitPatterns(
          [
            ieeePowerOfTwoBits(16, -2) | (1n << 15n),
            ieeePowerOfTwoBits(16, 0),
            ieeePowerOfTwoBits(16, 1),
          ],
          16,
        ),
        1,
        { primaries: 1, transfer: 8, matrix: 0, fullRange: true },
        { width: 1, height: 1, bitDepth: 16, componentFormats: [1, 1, 1] },
      ),
      nan = uncompressedFixture(
        [4, 5, 6],
        packBitPatterns([0x7e00n, 0x3c00n, 0x3c00n], 16),
        1,
        undefined,
        { width: 1, height: 1, bitDepth: 16, componentFormats: [1, 1, 1] },
      ),
      infinity = uncompressedFixture(
        [4, 5, 6],
        packBitPatterns([0x7c00n, 0x3c00n, 0x3c00n], 16),
        1,
        undefined,
        { width: 1, height: 1, bitDepth: 16, componentFormats: [1, 1, 1] },
      );

    expect([...decodeHeic(linearValues).data]).toEqual([0, 255, 255, 255]);
    const hdr = decodeHDRSync(linearValues);
    expect([...hdr.data]).toEqual([-0.25, 1, 2, 1]);
    expect(hdr.headroom).toBe(2);
    expect(() => decodeHeic(nan)).toThrow(/contains NaN/);
    expect(() => decodeHeic(infinity)).toThrow(/contains infinity/);
  });

  it('renders float monochrome with inline alpha and rejects Float32 overflow', () => {
    const grayWithAlpha = uncompressedFixture(
        [0, 7],
        packBitPatterns([ieeePowerOfTwoBits(16, -2), ieeePowerOfTwoBits(16, -1)], 16),
        1,
        { primaries: 1, transfer: 8, matrix: 0, fullRange: true },
        {
          width: 1,
          height: 1,
          bitDepth: 16,
          componentFormats: [1, 1],
        },
      ),
      oversizedFloat = uncompressedFixture(
        [4, 5, 6],
        packBitPatterns(
          [ieeePowerOfTwoBits(32, 114), ieeePowerOfTwoBits(32, 0), ieeePowerOfTwoBits(32, 0)],
          32,
        ),
        1,
        { primaries: 1, transfer: 8, matrix: 0, fullRange: true },
        {
          width: 1,
          height: 1,
          bitDepth: 32,
          componentBitDepths: [32, 32, 32],
          componentFormats: [1, 1, 1],
        },
      );

    expect([...decodeHeic(grayWithAlpha).data]).toEqual([64, 64, 64, 128]);
    const hdr = decodeHDRSync(grayWithAlpha);
    expect([...hdr.data]).toEqual([0.25, 0.25, 0.25, 0.5]);
    expect(hdr.hasAlpha).toBe(true);
    expect(() => decodeHeic(oversizedFloat)).toThrow(/Float32 rendering range/);
  });

  it('decodes block-packed 10-bit RGB pixels in big- and little-endian blocks', () => {
    const red = 0x155,
      green = 0x2aa,
      blue = 0x3ff,
      block = (BigInt(red) << 20n) | (BigInt(green) << 10n) | BigInt(blue),
      expected = {
        model: 'rgb' as const,
        rgba: Uint16Array.from([red, green, blue, 0x3ff]),
        alpha: null,
      };

    for (const littleEndian of [false, true]) {
      const input = uncompressedFixture(
        [4, 5, 6],
        packBlockValue(block, 4, littleEndian),
        1,
        undefined,
        {
          width: 1,
          height: 1,
          bitDepth: 10,
          blockSize: 4,
          pixelSize: 4,
          layoutFlags: littleEndian ? 0x20 : 0,
        },
      );
      expect(decodeUncompressedFixture(input)).toEqual(expected);
      expect([...decodeHeic(input).data]).toEqual([85, 170, 255, 255]);
    }

    const inferredBlockSize = uncompressedFixture(
      [4, 5, 6],
      packBlockValue(block, 4, true),
      1,
      undefined,
      { width: 1, height: 1, bitDepth: 10, pixelSize: 4, layoutFlags: 0x20 },
    );
    expect(decodeUncompressedFixture(inferredBlockSize)).toEqual(expected);
  });

  it('decodes component blocks and honors block padding and reversal flags', () => {
    const lowPadded = uncompressedFixture(
        [4, 5, 6],
        Buffer.from([0x01, 0x55, 0x02, 0xaa, 0x03, 0xff]),
        0,
        undefined,
        { width: 1, height: 1, bitDepth: 10, blockSize: 2 },
      ),
      highPadded = uncompressedFixture(
        [4, 5, 6],
        Buffer.from([0x55, 0x40, 0xaa, 0x80, 0xff, 0xc0]),
        0,
        undefined,
        { width: 1, height: 1, bitDepth: 10, blockSize: 2, layoutFlags: 0x40 },
      );
    const expected = {
      model: 'rgb' as const,
      rgba: Uint16Array.from([0x155, 0x2aa, 0x3ff, 0x3ff]),
      alpha: null,
    };
    expect(decodeUncompressedFixture(lowPadded)).toEqual(expected);
    expect(decodeUncompressedFixture(highPadded)).toEqual(expected);

    const littleEndianComponents = uncompressedFixture(
      [4, 5, 6],
      Buffer.concat([
        packBlockValue(0x155n, 2, true),
        packBlockValue(0x2aan, 2, true),
        packBlockValue(0x3ffn, 2, true),
      ]),
      0,
      undefined,
      { width: 1, height: 1, bitDepth: 10, blockSize: 2, layoutFlags: 0x20 },
    );
    expect(decodeUncompressedFixture(littleEndianComponents)).toEqual(expected);

    const packed = (red: number, green: number, blue: number, reversed: boolean) => {
      const shifts = reversed ? [0, 10, 20] : [20, 10, 0],
        value =
          (BigInt(red) << BigInt(shifts[0])) |
          (BigInt(green) << BigInt(shifts[1])) |
          (BigInt(blue) << BigInt(shifts[2]));
      return packBlockValue(value, 4);
    };
    const ordinary = uncompressedFixture(
        [4, 5, 6],
        packed(0x155, 0x2aa, 0x3ff, false),
        1,
        undefined,
        { width: 1, height: 1, bitDepth: 10, blockSize: 4, pixelSize: 4 },
      ),
      reversed = uncompressedFixture([4, 5, 6], packed(0x155, 0x2aa, 0x3ff, true), 1, undefined, {
        width: 1,
        height: 1,
        bitDepth: 10,
        blockSize: 4,
        pixelSize: 4,
        layoutFlags: 0x10,
      });
    expect(decodeUncompressedFixture(ordinary)).toEqual(expected);
    expect(decodeUncompressedFixture(reversed)).toEqual(expected);
  });

  it('decodes block-packed component-interleaved subsampled YCbCr', () => {
    const cases = [
      {
        samplingType: 1,
        width: 4,
        height: 1,
        y: [16, 32, 48, 64],
        cb: [128, 128],
        cr: [128, 128],
      },
      {
        samplingType: 2,
        width: 4,
        height: 2,
        rowAlignSize: 8,
        tileAlignSize: 8,
        y: [16, 32, 48, 64, 80, 96, 112, 128],
        cb: [128, 128],
        cr: [128, 128],
      },
      {
        samplingType: 3,
        width: 4,
        height: 1,
        y: [16, 32, 48, 64],
        cb: [128],
        cr: [128],
      },
    ];

    for (const { samplingType, width, height, rowAlignSize, tileAlignSize, y, cb, cr } of cases) {
      const blocks = (values: number[]) =>
          Buffer.concat(values.map((value) => packBlockValue(BigInt(value), 2))),
        yBlocks = blocks(y),
        cbBlocks = blocks(cb),
        crBlocks = blocks(cr),
        payload =
          samplingType === 2
            ? Buffer.concat([yBlocks, cbBlocks, Buffer.alloc(4), crBlocks, Buffer.alloc(4)])
            : Buffer.concat([yBlocks, cbBlocks, crBlocks]);
      const input = uncompressedFixture(
        [1, 2, 3],
        payload,
        0,
        { primaries: 1, transfer: 1, matrix: 1, fullRange: true },
        { width, height, samplingType, blockSize: 2, rowAlignSize, tileAlignSize },
      );

      expect(decodeUncompressedFixture(input)).toEqual({
        model: 'yuv',
        y: Uint16Array.from(y),
        cb: Uint16Array.from(cb),
        cr: Uint16Array.from(cr),
        alpha: null,
      });
      expect([...decodeHeic(input).data]).toEqual(y.flatMap((value) => [value, value, value, 255]));
    }
  });

  it('decodes component and pixel blocks through the 255-byte block-size limit', () => {
    const expected = {
      model: 'rgb' as const,
      rgba: Uint16Array.from([0x12, 0x34, 0x56, 0xff]),
      alpha: null,
    };

    for (const blockSize of [9, 255]) {
      const componentBlock = (value: number) => packBlockValue(BigInt(value), blockSize),
        componentInput = uncompressedFixture(
          [4, 5, 6],
          Buffer.concat([componentBlock(0x12), componentBlock(0x34), componentBlock(0x56)]),
          0,
          undefined,
          { width: 1, height: 1, bitDepth: 8, blockSize },
        ),
        pixelValue = (0x12n << 16n) | (0x34n << 8n) | 0x56n,
        pixelInput = uncompressedFixture(
          [4, 5, 6],
          packBlockValue(pixelValue, blockSize),
          1,
          undefined,
          { width: 1, height: 1, bitDepth: 8, blockSize, pixelSize: blockSize },
        );

      expect(decodeUncompressedFixture(componentInput)).toEqual(expected);
      expect(decodeUncompressedFixture(pixelInput)).toEqual(expected);
    }
  });

  it('validates block padding and rejects unsupported block configurations', () => {
    const nonzeroPadding = uncompressedFixture(
        [4, 5, 6],
        packBlockValue(0xc0000000n | (0x155n << 20n) | (0x2aan << 10n) | 0x3ffn, 4),
        1,
        undefined,
        { width: 1, height: 1, bitDepth: 10, blockSize: 4, pixelSize: 4 },
      ),
      unknownPadding = uncompressedFixture(
        [4, 5, 6],
        packBlockValue(0xc0000000n | (0x155n << 20n) | (0x2aan << 10n) | 0x3ffn, 4),
        1,
        undefined,
        { width: 1, height: 1, bitDepth: 10, blockSize: 4, pixelSize: 4, layoutFlags: 0x08 },
      ),
      mismatchedPixelSize = uncompressedFixture([4, 5, 6], Buffer.alloc(5), 1, undefined, {
        width: 1,
        height: 1,
        bitDepth: 10,
        blockSize: 4,
        pixelSize: 5,
      }),
      oversizedPixelBlock = uncompressedFixture([4, 5, 6], Buffer.alloc(256), 1, undefined, {
        width: 1,
        height: 1,
        bitDepth: 8,
        pixelSize: 256,
        layoutFlags: 0x20,
      });
    expect(() => decodeUncompressedFixture(nonzeroPadding)).toThrow(
      /block padding bits shall be zero/,
    );
    expect(decodeUncompressedFixture(unknownPadding).model).toBe('rgb');
    expect(() => decodeUncompressedFixture(mismatchedPixelSize)).toThrow(
      /block_size shall be zero or equal pixel_size/,
    );
    expect(() => decodeUncompressedFixture(oversizedPixelBlock)).toThrow(
      /pixel blocks above 255 bytes are not supported/,
    );
  });

  it('applies row and tile alignment to block-packed samples', () => {
    const rowAligned = uncompressedFixture(
        [4, 5, 6],
        Buffer.concat([
          packBlockValue((0x155n << 20n) | (0x2aan << 10n) | 0x3ffn, 4),
          Buffer.alloc(4),
          packBlockValue((0x3ffn << 20n) | (0x155n << 10n) | 0x2aan, 4),
          Buffer.alloc(4),
        ]),
        1,
        undefined,
        {
          width: 1,
          height: 2,
          bitDepth: 10,
          blockSize: 4,
          pixelSize: 4,
          rowAlignSize: 8,
        },
      ),
      tileAligned = uncompressedFixture(
        [4, 5, 6],
        Buffer.concat([
          packBlockValue((0x155n << 20n) | (0x2aan << 10n) | 0x3ffn, 4),
          Buffer.alloc(4),
          packBlockValue((0x3ffn << 20n) | (0x155n << 10n) | 0x2aan, 4),
          Buffer.alloc(4),
        ]),
        1,
        undefined,
        {
          width: 2,
          height: 1,
          bitDepth: 10,
          blockSize: 4,
          pixelSize: 4,
          tileColumns: 2,
          tileAlignSize: 8,
        },
      );

    expect([...decodeHeic(rowAligned).data]).toEqual([85, 170, 255, 255, 255, 85, 170, 255]);
    expect([...decodeHeic(tileAligned).data]).toEqual([85, 170, 255, 255, 255, 85, 170, 255]);
  });

  it('decodes signed two-complement samples and signed pixi channel formats', () => {
    const input = uncompressedFixture(
      [4, 5, 6],
      Buffer.from([0x80, 0xff, 0x7f, 0x00, 0x7f, 0xff]),
      1,
      undefined,
      {
        width: 2,
        height: 1,
        bitDepth: 8,
        componentFormats: [3, 3, 3],
        pixiBitDepth: 8,
        pixiComponentFormats: [3, 3, 3],
      },
    );
    expect([...decodeHeic(input).data]).toEqual([0, 127, 255, 255, 128, 255, 127, 255]);

    const signedTwoBitGray = uncompressedFixture([0], Buffer.from([0b10_11_00_01]), 0, undefined, {
      width: 4,
      height: 1,
      bitDepth: 2,
      componentBitDepths: [2],
      componentFormats: [3],
    });
    expect([...decodeHeic(signedTwoBitGray).data]).toEqual([
      0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 255, 255, 255, 255,
    ]);

    const signedEightBitYuv = uncompressedFixture(
        [1, 2, 3],
        Buffer.from([0, 0, 0]),
        1,
        { primaries: 1, transfer: 1, matrix: 1, fullRange: true },
        { width: 1, height: 1, bitDepth: 8, componentFormats: [3, 3, 3] },
      ),
      signedTwoBitYuv = uncompressedFixture(
        [1, 2, 3],
        Buffer.from([0]),
        1,
        { primaries: 1, transfer: 1, matrix: 1, fullRange: true },
        {
          width: 1,
          height: 1,
          bitDepth: 2,
          componentBitDepths: [2, 2, 2],
          componentFormats: [3, 3, 3],
        },
      );
    expect([...decodeHeic(signedTwoBitYuv).data]).toEqual([128, 128, 128, 255]);
    expect(decodeHDRSync(signedTwoBitYuv).data).toEqual(decodeHDRSync(signedEightBitYuv).data);
  });

  it('reads signed samples from aligned little- and big-endian component words', () => {
    const values = [0x200, 0x3ff, 0, 0x1ff],
      bigEndian = Buffer.concat(values.map((value) => packBlockValue(BigInt(value), 2))),
      littleEndian = Buffer.concat(values.map((value) => packBlockValue(BigInt(value), 2, true))),
      fixture = (payload: Uint8Array, layoutFlags = 0) =>
        uncompressedFixture([0], payload, 0, undefined, {
          width: values.length,
          height: 1,
          bitDepth: 10,
          componentBitDepths: [10],
          componentFormats: [3],
          componentAlignSize: 2,
          layoutFlags,
        });

    expect([...decodeHeic(fixture(bigEndian)).data]).toEqual([
      0, 0, 0, 255, 127, 127, 127, 255, 128, 128, 128, 255, 255, 255, 255, 255,
    ]);
    expect([...decodeHeic(fixture(littleEndian, 0x80)).data]).toEqual([
      0, 0, 0, 255, 127, 127, 127, 255, 128, 128, 128, 255, 255, 255, 255, 255,
    ]);

    const oneByteAligned = uncompressedFixture([0], Buffer.from([4, 7, 0, 3]), 0, undefined, {
      width: 4,
      height: 1,
      bitDepth: 3,
      componentBitDepths: [3],
      componentFormats: [3],
      componentAlignSize: 1,
      pixiBitDepth: 3,
      pixiComponentFormats: [3],
    });
    expect([...decodeHeic(oneByteAligned).data]).toEqual([
      0, 0, 0, 255, 96, 96, 96, 255, 128, 128, 128, 255, 255, 255, 255, 255,
    ]);

    const signedBlock = uncompressedFixture([0], packBlockValue(0x200n, 2), 0, undefined, {
      width: 1,
      height: 1,
      bitDepth: 10,
      componentFormats: [3],
      blockSize: 2,
    });
    expect([...decodeHeic(signedBlock).data]).toEqual([0, 0, 0, 255]);
  });

  it('decodes the version-1 yv20 predefined profile with implicit Y, V, U components', () => {
    const payload = Buffer.from([16, 64, 128, 235, 200, 50]);
    const profiled = yv20ProfileFixture(payload);
    const profiledWithCmpd = yv20ProfileFixture(payload, [1, 3, 2]);
    const explicit = uncompressedFixture([1, 3, 2], payload, 0, undefined, {
      width: 2,
      height: 2,
      samplingType: 2,
    });
    const boxes = parseISOBMFF(profiled);
    const info = getHeicInfo(profiled, boxes);
    const itemPayload = getItemPayload(profiled, boxes, info.primaryItemId);
    if (!itemPayload || !info.uncompressedImage)
      throw new Error('yv20 profile fixture did not resolve its item payload and configuration');

    expect(info.uncompressedImage).toMatchObject({
      width: 2,
      height: 2,
      bitDepth: 8,
      bitDepthChroma: 8,
      samplingType: 2,
      interleaveType: 0,
      colorModel: 'yuv',
      components: [
        { componentIndex: 0, componentType: 1, bitDepth: 8 },
        { componentIndex: 1, componentType: 3, bitDepth: 8 },
        { componentIndex: 2, componentType: 2, bitDepth: 8 },
      ],
    });
    expect(decodeUncompressedImage(itemPayload, info.uncompressedImage)).toEqual({
      model: 'yuv',
      y: Uint16Array.from([16, 64, 128, 235]),
      cb: Uint16Array.from([50]),
      cr: Uint16Array.from([200]),
      alpha: null,
    });
    expect(decodeHeic(profiled)).toEqual(decodeHeic(explicit));
    expect(decodeHeic(profiledWithCmpd)).toEqual(decodeHeic(explicit));
    expect(() => decodeHeic(yv20ProfileFixture(payload, [1, 2, 3]))).toThrow(
      /cmpd component order disagrees with the yv20 uncC profile/,
    );
  });

  it('decodes the version-0 rgb3 predefined profile as packed 8-bit RGB', () => {
    const payload = Buffer.from([255, 0, 0, 0, 255, 32]);
    const profiled = uncompressedFixture([4, 5, 6], payload, 1, undefined, {
      width: 2,
      profileCode: 0x72676233,
    });
    const explicit = uncompressedFixture([4, 5, 6], payload, 1, undefined, {
      width: 2,
    });

    expect(decodeHeic(profiled)).toEqual(decodeHeic(explicit));
    expect([...decodeHeic(profiled).data]).toEqual([255, 0, 0, 255, 0, 255, 32, 255]);

    const mismatched = uncompressedFixture([4, 6, 5], payload, 1, undefined, {
      width: 2,
      profileCode: 0x72676233,
    });
    expect(() => decodeHeic(mismatched)).toThrow(
      /uncC values disagree with the rgb3 predefined profile/,
    );
  });

  it('decompresses whole-item deflate, zlib, and Brotli unci items in sync and async APIs', async () => {
    const payload = Buffer.from([255, 0, 0, 0, 255, 32]),
      expectedInput = uncompressedFixture([4, 5, 6], payload, 1, undefined, { width: 2 }),
      expected = decodeHeic(expectedInput),
      variants = [
        ['defl', deflateRawSync(payload)],
        ['zlib', deflateSync(payload)],
        ['brot', brotliCompressSync(payload)],
      ] as const;

    for (const [compressionType, compressed] of variants) {
      const input = uncompressedFixture([4, 5, 6], compressed, 1, undefined, {
        width: 2,
        compressionType,
      });
      expect(decodeHeic(input)).toEqual(expected);
      expect(await decode(input, { execution: 'main' })).toEqual(expected);
      expect(decodeHDRSync(input).data).toEqual(decodeHDRSync(expectedInput).data);
    }

    const tilePayloads = [
        deflateRawSync(Buffer.from([255, 0, 0])),
        deflateRawSync(Buffer.from([0, 255, 32])),
      ],
      tilePayload = Buffer.concat(tilePayloads),
      tileIndex = Buffer.concat([
        Buffer.from([0]), // implied offsets, 8-bit sizes
        u32(tilePayloads.length),
        ...tilePayloads.map((tile) => Buffer.from([tile.length])),
      ]),
      tiledExpected = uncompressedFixture(
        [4, 5, 6],
        Buffer.from([255, 0, 0, 0, 255, 32]),
        1,
        undefined,
        {
          width: 2,
          tileColumns: 2,
        },
      ),
      tiledCompressed = uncompressedFixture([4, 5, 6], tilePayload, 1, undefined, {
        width: 2,
        tileColumns: 2,
        compressionType: 'defl',
        compressedUnitType: 2,
        icef: tileIndex,
      });
    expect(decodeHeic(tiledCompressed)).toEqual(decodeHeic(tiledExpected));
    expect(await decode(tiledCompressed, { execution: 'main' })).toEqual(decodeHeic(tiledExpected));
    expect(decodeHDRSync(tiledCompressed).data).toEqual(decodeHDRSync(tiledExpected).data);

    const outOfRangeIndex = Buffer.concat([
      Buffer.from([0x20]), // 16-bit offsets, 8-bit sizes
      u32(1),
      Buffer.from([0xff, 0xff, 1]),
    ]);
    const invalidIndex = uncompressedFixture([4, 5, 6], tilePayloads[0], 1, undefined, {
      width: 1,
      tileColumns: 1,
      compressionType: 'defl',
      compressedUnitType: 2,
      icef: outOfRangeIndex,
    });
    expect(() => decodeHeic(invalidIndex)).toThrow(/icef compressed-unit range exceeds/);

    const invalidData = uncompressedFixture([4, 5, 6], Buffer.from([1, 2, 3]), 1, undefined, {
      width: 2,
      compressionType: 'defl',
    });
    expect(() => decodeHeic(invalidData)).toThrow(/invalid generic-compressed item data/);
  });

  it('decodes pixel-interleaved RGB and alpha through the public SDR and HDR APIs', () => {
    const input = uncompressedFixture(
      [4, 5, 6, 7],
      Buffer.from([255, 0, 0, 128, 0, 255, 0, 64]),
      1,
    );

    expect(isHeic(input)).toBe(true);
    expect(getHeicInfo(input, parseISOBMFF(input)).primaryItemType).toBe('unci');
    expect(getHeicMetadata(input).sps).toBeNull();
    expect(decodeHeic(input)).toMatchObject({
      width: 2,
      height: 1,
      hasAlpha: true,
      bitDepth: 8,
      data: new Uint8Array([255, 0, 0, 128, 0, 255, 0, 64]),
    });

    const hdr = decodeHDRSync(input);
    expect(hdr.data[0]).toBeCloseTo(1, 6);
    expect(hdr.data[1]).toBeCloseTo(0, 6);
    expect(hdr.data[3]).toBeCloseTo(128 / 255, 6);
  });

  it('decodes unsigned 16-bit uncompressed RGB and YCbCr through public APIs', async () => {
    const payload = Buffer.from([
      0, 0, 0x80, 0, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x40, 0, 0, 0, 0x80, 0,
    ]);
    const input = uncompressedFixture([4, 5, 6, 7], payload, 1, undefined, {
      width: 2,
      height: 1,
      bitDepth: 16,
      pixiBitDepth: 16,
    });
    const decoded = decodeHeic(input);

    expect(decoded).toMatchObject({
      width: 2,
      height: 1,
      bitDepth: 16,
      hasAlpha: true,
      data: new Uint8Array([0, 128, 255, 255, 255, 64, 0, 128]),
    });
    expect(getHeicMetadata(input).bitDepth).toBe(16);

    const hdr = decodeHDRSync(input);
    expect(hdr.bitDepth).toBe(16);
    expect(hdr.data[0]).toBeCloseTo(0, 6);
    expect(hdr.data[1]).toBeGreaterThan(0.2);
    expect(hdr.data[2]).toBeCloseTo(1, 5);
    expect(hdr.data[3]).toBeCloseTo(1, 6);
    expect(hdr.data[7]).toBeCloseTo(32768 / 65535, 5);

    const alignedRgb = uncompressedFixture(
      [4, 5, 6],
      Buffer.from([0, 0, 0, 0, 0x80, 0, 0, 0xff, 0xff]),
      1,
      undefined,
      { width: 1, height: 1, bitDepth: 16, componentAlignSize: 3, pixiBitDepth: 16 },
    );
    expect([...decodeHeic(alignedRgb).data]).toEqual([0, 128, 255, 255]);

    const yuv420 = uncompressedFixture(
      [1, 2, 3],
      Buffer.from([0, 0, 0x40, 0, 0x80, 0, 0xff, 0xff, 0x80, 0, 0x80, 0]),
      0,
      { primaries: 1, transfer: 1, matrix: 1, fullRange: true },
      { width: 2, height: 2, samplingType: 2, bitDepth: 16, pixiBitDepth: 16 },
    );
    expect([...decodeHeic(yuv420).data]).toEqual([
      0, 0, 0, 255, 64, 64, 64, 255, 128, 128, 128, 255, 255, 255, 255, 255,
    ]);

    const asynchronous = await decode(input, { execution: 'main' });
    expect(asynchronous.bitDepth).toBe(16);
    expect(asynchronous.data).toEqual(decoded.data);
  });

  it('decodes component-interleaved RGB and neutral 4:4:4 YCbCr', () => {
    const planarRgb = uncompressedFixture([4, 5, 6], Buffer.from([255, 0, 0, 255, 0, 0]), 0);
    expect([...decodeHeic(planarRgb).data]).toEqual([255, 0, 0, 255, 0, 255, 0, 255]);

    const yuv = uncompressedFixture([1, 2, 3], Buffer.from([96, 128, 128, 160, 128, 128]), 1, {
      primaries: 1,
      transfer: 1,
      matrix: 1,
      fullRange: true,
    });
    const decoded = decodeHeic(yuv);
    expect([...decoded.data]).toEqual([96, 96, 96, 255, 160, 160, 160, 255]);
  });

  it('applies pixel_size padding to each pixel in pixel-interleaved images', () => {
    const paddedPixels = uncompressedFixture(
      [4, 5, 6],
      Buffer.from([10, 20, 30, 0xaa, 40, 50, 60, 0xbb]),
      1,
      undefined,
      { width: 2, height: 1, pixelSize: 4 },
    );
    expect([...decodeHeic(paddedPixels).data]).toEqual([10, 20, 30, 255, 40, 50, 60, 255]);

    const paddedTenBitPixels = uncompressedFixture(
      [4, 5, 6],
      Buffer.from([
        0x00, 0x40, 0x00, 0x20, 0x00, 0x00, 0, 0, 0x03, 0xff, 0x00, 0x00, 0x00, 0x00, 0, 0,
      ]),
      1,
      undefined,
      {
        width: 2,
        height: 1,
        bitDepth: 10,
        componentAlignSize: 2,
        pixelSize: 8,
      },
    );
    expect(getHeicMetadata(paddedTenBitPixels).bitDepth).toBe(10);
    expect([...decodeHeic(paddedTenBitPixels).data]).toEqual([16, 8, 0, 255, 255, 0, 0, 255]);

    const tooSmallPixel = uncompressedFixture(
      [4, 5, 6],
      Buffer.from([10, 20, 30, 40, 50, 60]),
      1,
      undefined,
      { width: 2, height: 1, pixelSize: 2 },
    );
    expect(() => decodeHeic(tooSmallPixel)).toThrow(/pixel_size is smaller/);

    const invalidInterleave = uncompressedFixture(
      [4, 5, 6],
      Buffer.from([10, 20, 30]),
      0,
      undefined,
      { width: 1, height: 1, pixelSize: 3 },
    );
    expect(() => decodeHeic(invalidInterleave)).toThrow(/only valid with pixel/);
  });

  it('decodes component, pixel, and mixed-interleaved tile grids in raster order', () => {
    const expectedRgba = [
      1, 11, 21, 255, 2, 12, 22, 255, 3, 13, 23, 255, 4, 14, 24, 255, 5, 15, 25, 255, 6, 16, 26,
      255, 7, 17, 27, 255, 8, 18, 28, 255,
    ];
    const componentTiled = uncompressedFixture(
        [4, 5, 6],
        Buffer.from([
          1, 2, 11, 12, 21, 22, 3, 4, 13, 14, 23, 24, 5, 6, 15, 16, 25, 26, 7, 8, 17, 18, 27, 28,
        ]),
        0,
        undefined,
        { width: 4, height: 2, tileColumns: 2, tileRows: 2 },
      ),
      pixelTiled = uncompressedFixture(
        [4, 5, 6],
        Buffer.from([
          1, 11, 21, 2, 12, 22, 3, 13, 23, 4, 14, 24, 5, 15, 25, 6, 16, 26, 7, 17, 27, 8, 18, 28,
        ]),
        1,
        undefined,
        { width: 4, height: 2, tileColumns: 2, tileRows: 2 },
      ),
      rowAlignedComponentTiled = uncompressedFixture(
        [4, 5, 6],
        Buffer.from([
          1, 2, 0, 0, 11, 12, 0, 0, 21, 22, 0, 0, 3, 4, 0, 0, 13, 14, 0, 0, 23, 24, 0, 0, 5, 6, 0,
          0, 15, 16, 0, 0, 25, 26, 0, 0, 7, 8, 0, 0, 17, 18, 0, 0, 27, 28, 0, 0,
        ]),
        0,
        undefined,
        { width: 4, height: 2, tileColumns: 2, tileRows: 2, rowAlignSize: 4 },
      );

    expect([...decodeHeic(componentTiled).data]).toEqual(expectedRgba);
    expect([...decodeHeic(pixelTiled).data]).toEqual(expectedRgba);
    expect([...decodeHeic(rowAlignedComponentTiled).data]).toEqual(expectedRgba);

    const mixedTiled = uncompressedFixture(
      [1, 2, 3],
      Buffer.from([1, 2, 3, 4, 10, 20, 11, 21, 5, 6, 7, 8, 12, 22, 13, 23]),
      2,
      undefined,
      { width: 4, height: 2, samplingType: 1, tileColumns: 2 },
    );
    const boxes = parseISOBMFF(mixedTiled),
      info = getHeicInfo(mixedTiled, boxes),
      payload = getItemPayload(mixedTiled, boxes, info.primaryItemId);
    if (!info.uncompressedImage || !payload)
      throw new Error('expected the tiled uncompressed image payload and configuration');
    const planes = decodeUncompressedImage(payload, info.uncompressedImage);
    if (planes.model !== 'yuv') throw new Error('expected decoded YCbCr component planes');
    expect([...planes.y]).toEqual([1, 2, 5, 6, 3, 4, 7, 8]);
    expect([...planes.cb]).toEqual([10, 12, 11, 13]);
    expect([...planes.cr]).toEqual([20, 22, 21, 23]);
  });

  it('aligns component and pixel tile data at their respective boundaries', () => {
    const expectedRgba = [1, 11, 21, 255, 2, 12, 22, 255, 3, 13, 23, 255, 4, 14, 24, 255],
      componentTiled = uncompressedFixture(
        [4, 5, 6],
        Buffer.from([
          1, 2, 0, 0, 11, 12, 0, 0, 21, 22, 0, 0, 3, 4, 0, 0, 13, 14, 0, 0, 23, 24, 0, 0,
        ]),
        0,
        undefined,
        { width: 4, height: 1, tileColumns: 2, tileAlignSize: 4 },
      ),
      pixelTiled = uncompressedFixture(
        [4, 5, 6],
        Buffer.from([1, 11, 21, 2, 12, 22, 0, 0, 3, 13, 23, 4, 14, 24, 0, 0]),
        1,
        undefined,
        { width: 4, height: 1, tileColumns: 2, tileAlignSize: 4 },
      );

    expect([...decodeHeic(componentTiled).data]).toEqual(expectedRgba);
    expect([...decodeHeic(pixelTiled).data]).toEqual(expectedRgba);

    const truncatedTilePadding = uncompressedFixture(
      [4, 5, 6],
      Buffer.from([1, 2, 11, 12, 21, 22]),
      0,
      undefined,
      { width: 2, height: 1, tileAlignSize: 4 },
    );
    expect(() => decodeHeic(truncatedTilePadding)).toThrow(/configured tile alignment/);
  });

  it('aligns subsampled component and mixed-interleaved tiles', () => {
    const decodePlanes = (input: Uint8Array) => {
      const boxes = parseISOBMFF(input),
        info = getHeicInfo(input, boxes),
        payload = getItemPayload(input, boxes, info.primaryItemId);
      if (!info.uncompressedImage || !payload)
        throw new Error('expected decoded uncompressed item configuration');
      const planes = decodeUncompressedImage(payload, info.uncompressedImage);
      if (planes.model !== 'yuv') throw new Error('expected decoded YCbCr component planes');
      return planes;
    };
    const expected422 = {
      y: [1, 2, 3, 4],
      cb: [10, 11],
      cr: [20, 21],
    };
    const component422 = decodePlanes(
        uncompressedFixture(
          [1, 2, 3],
          Buffer.from([
            1, 2, 0, 0, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 20, 0, 0, 0, 0, 0, 0, 0, 3, 4, 0, 0, 0,
            0, 0, 0, 11, 0, 0, 0, 0, 0, 0, 0, 21, 0, 0, 0, 0, 0, 0, 0,
          ]),
          0,
          undefined,
          { width: 4, height: 1, samplingType: 1, tileColumns: 2, tileAlignSize: 8 },
        ),
      ),
      mixed422 = decodePlanes(
        uncompressedFixture(
          [1, 2, 3],
          Buffer.from([
            1, 2, 0, 0, 0, 0, 0, 0, 10, 20, 0, 0, 0, 0, 0, 0, 3, 4, 0, 0, 0, 0, 0, 0, 11, 21, 0, 0,
            0, 0, 0, 0,
          ]),
          2,
          undefined,
          { width: 4, height: 1, samplingType: 1, tileColumns: 2, tileAlignSize: 8 },
        ),
      );
    expect([...component422.y]).toEqual(expected422.y);
    expect([...component422.cb]).toEqual(expected422.cb);
    expect([...component422.cr]).toEqual(expected422.cr);
    expect([...mixed422.y]).toEqual(expected422.y);
    expect([...mixed422.cb]).toEqual(expected422.cb);
    expect([...mixed422.cr]).toEqual(expected422.cr);

    const expected420 = {
      y: [1, 2, 3, 4, 5, 6, 7, 8],
      cb: [10, 11],
      cr: [20, 21],
    };
    const component420 = decodePlanes(
        uncompressedFixture(
          [1, 2, 3],
          Buffer.from([
            1, 2, 5, 6, 0, 0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 20, 0, 0, 0, 0, 0, 0, 0, 3, 4, 7, 8, 0,
            0, 0, 0, 11, 0, 0, 0, 0, 0, 0, 0, 21, 0, 0, 0, 0, 0, 0, 0,
          ]),
          0,
          undefined,
          { width: 4, height: 2, samplingType: 2, tileColumns: 2, tileAlignSize: 8 },
        ),
      ),
      mixed420 = decodePlanes(
        uncompressedFixture(
          [1, 2, 3],
          Buffer.from([
            1, 2, 5, 6, 0, 0, 0, 0, 10, 20, 0, 0, 0, 0, 0, 0, 3, 4, 7, 8, 0, 0, 0, 0, 11, 21, 0, 0,
            0, 0, 0, 0,
          ]),
          2,
          undefined,
          { width: 4, height: 2, samplingType: 2, tileColumns: 2, tileAlignSize: 8 },
        ),
      );
    expect([...component420.y]).toEqual(expected420.y);
    expect([...component420.cb]).toEqual(expected420.cb);
    expect([...component420.cr]).toEqual(expected420.cr);
    expect([...mixed420.y]).toEqual(expected420.y);
    expect([...mixed420.cb]).toEqual(expected420.cb);
    expect([...mixed420.cr]).toEqual(expected420.cr);
  });

  it('decodes tile-component interleave in component-major tile order', () => {
    const input = uncompressedFixture(
      [4, 5, 6],
      Buffer.from([1, 2, 0, 0, 3, 4, 0, 0, 11, 12, 0, 0, 13, 14, 0, 0, 21, 22, 0, 0, 23, 24, 0, 0]),
      4,
      undefined,
      { width: 4, height: 1, tileColumns: 2, tileAlignSize: 4 },
    );

    expect([...decodeHeic(input).data]).toEqual([
      1, 11, 21, 255, 2, 12, 22, 255, 3, 13, 23, 255, 4, 14, 24, 255,
    ]);

    const invalidSubsampled = uncompressedFixture([1, 2, 3], Buffer.alloc(6), 4, undefined, {
      width: 2,
      height: 1,
      samplingType: 1,
    });
    expect(() => decodeHeic(invalidSubsampled)).toThrow(
      /tile-component interleave requires no chroma/,
    );
  });

  it('decodes row-interleaved components with row and tile alignment', () => {
    const input = uncompressedFixture(
      [4, 5, 6],
      Buffer.from([
        1, 2, 0, 0, 11, 12, 0, 0, 21, 22, 0, 0, 3, 4, 0, 0, 13, 14, 0, 0, 23, 24, 0, 0, 0, 0, 0, 0,
        0, 0, 0, 0, 5, 6, 0, 0, 15, 16, 0, 0, 25, 26, 0, 0, 7, 8, 0, 0, 17, 18, 0, 0, 27, 28, 0, 0,
        0, 0, 0, 0, 0, 0, 0, 0,
      ]),
      3,
      undefined,
      { width: 4, height: 2, rowAlignSize: 4, tileAlignSize: 16, tileColumns: 2 },
    );

    expect([...decodeHeic(input).data]).toEqual([
      1, 11, 21, 255, 2, 12, 22, 255, 5, 15, 25, 255, 6, 16, 26, 255, 3, 13, 23, 255, 4, 14, 24,
      255, 7, 17, 27, 255, 8, 18, 28, 255,
    ]);

    const invalidSubsampled = uncompressedFixture([1, 2, 3], Buffer.alloc(6), 3, undefined, {
      width: 2,
      height: 1,
      samplingType: 1,
    });
    expect(() => decodeHeic(invalidSubsampled)).toThrow(/row interleave is not valid/);
  });

  it('rejects tile grids that do not divide the image or chroma tile dimensions', () => {
    const unevenGrid = uncompressedFixture([4, 5, 6], Buffer.alloc(9), 0, undefined, {
        width: 3,
        height: 1,
        tileColumns: 2,
      }),
      split420Rows = uncompressedFixture([1, 2, 3], Buffer.alloc(12), 0, undefined, {
        width: 4,
        height: 2,
        samplingType: 2,
        tileRows: 2,
      });

    expect(() => decodeHeic(unevenGrid)).toThrow(/tile grid shall divide the image dimensions/);
    expect(() => decodeHeic(split420Rows)).toThrow(/tile dimensions do not meet/);
  });

  it('decodes component-interleaved 4:2:2 and 4:2:0 YCbCr with full-resolution alpha', () => {
    const color = { primaries: 1, transfer: 1, matrix: 1, fullRange: true },
      yuv422 = uncompressedFixture(
        [1, 2, 3, 7],
        Buffer.from([32, 64, 96, 128, 128, 128, 128, 128, 255, 128, 64, 0]),
        0,
        color,
        { width: 4, height: 1, samplingType: 1 },
      ),
      yuv420 = uncompressedFixture(
        [1, 2, 3],
        Buffer.from([16, 32, 48, 64, 80, 96, 112, 128, 128, 128, 128, 128]),
        0,
        color,
        { width: 4, height: 2, samplingType: 2 },
      );

    expect([...decodeHeic(yuv422).data]).toEqual([
      32, 32, 32, 255, 64, 64, 64, 128, 96, 96, 96, 64, 128, 128, 128, 0,
    ]);
    expect([...decodeHeic(yuv420).data]).toEqual([
      16, 16, 16, 255, 32, 32, 32, 255, 48, 48, 48, 255, 64, 64, 64, 255, 80, 80, 80, 255, 96, 96,
      96, 255, 112, 112, 112, 255, 128, 128, 128, 255,
    ]);
  });

  it('decodes Multi-Y 4:2:2 and 4:1:1 groups into full-resolution YCbCr pixels', () => {
    const color = { primaries: 1, transfer: 1, matrix: 1, fullRange: true },
      yuv422 = uncompressedFixture(
        [1, 1, 2, 3],
        Buffer.from([16, 235, 128, 128, 32, 64, 128, 128]),
        5,
        color,
        { width: 4, height: 1, samplingType: 1 },
      ),
      yuv411 = uncompressedFixture(
        [1, 1, 1, 1, 2, 3],
        Buffer.from([16, 64, 128, 235, 128, 128]),
        5,
        color,
        { width: 4, height: 1, samplingType: 3 },
      );

    expect([...decodeHeic(yuv422).data]).toEqual([
      16, 16, 16, 255, 235, 235, 235, 255, 32, 32, 32, 255, 64, 64, 64, 255,
    ]);
    expect([...decodeHeic(yuv411).data]).toEqual([
      16, 16, 16, 255, 64, 64, 64, 255, 128, 128, 128, 255, 235, 235, 235, 255,
    ]);

    const paddedGroups = uncompressedFixture(
      [1, 1, 2, 3],
      Buffer.from([16, 235, 128, 128, 0, 0, 32, 64, 128, 128, 0, 0]),
      5,
      color,
      { width: 4, height: 1, samplingType: 1, pixelSize: 6 },
    );
    expect([...decodeHeic(paddedGroups).data]).toEqual([...decodeHeic(yuv422).data]);

    const tileAlignedGroups = uncompressedFixture(
      [1, 1, 2, 3],
      Buffer.from([16, 235, 128, 128, 0, 0, 0, 0, 32, 64, 128, 128, 0, 0, 0, 0]),
      5,
      color,
      { width: 4, height: 1, samplingType: 1, tileColumns: 2, tileAlignSize: 8 },
    );
    expect([...decodeHeic(tileAlignedGroups).data]).toEqual([...decodeHeic(yuv422).data]);

    const yuv422Alpha = uncompressedFixture(
      [1, 7, 1, 7, 2, 3],
      Buffer.from([16, 64, 235, 192, 128, 128, 32, 128, 64, 255, 128, 128]),
      5,
      color,
      { width: 4, height: 1, samplingType: 1 },
    );
    expect([...decodeHeic(yuv422Alpha).data]).toEqual([
      16, 16, 16, 64, 235, 235, 235, 192, 32, 32, 32, 128, 64, 64, 64, 255,
    ]);

    const mixedDepth = uncompressedFixture(
      [1, 1, 2, 3],
      Buffer.from([0, 255, 3, 255, 0, 128, 0, 128]),
      5,
      color,
      {
        width: 2,
        height: 1,
        samplingType: 1,
        componentBitDepths: [8, 10, 8, 8],
        componentAlignSizes: [2, 2, 2, 2],
      },
    );
    expect([...decodeHeic(mixedDepth).data]).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);

    const tooSmallGroup = uncompressedFixture(
      [1, 1, 2, 3],
      Buffer.from([16, 235, 128, 128, 32, 64, 128, 128]),
      5,
      color,
      { width: 4, height: 1, samplingType: 1, pixelSize: 3 },
    );
    expect(() => decodeHeic(tooSmallGroup)).toThrow(/pixel_size is smaller than its multi-Y group/);
  });

  it('rejects Multi-Y component counts that do not match the chroma group size', () => {
    const tooFewY = uncompressedFixture([1, 2, 3], Buffer.from([16, 128, 128]), 5, undefined, {
      width: 2,
      height: 1,
      samplingType: 1,
    });
    expect(() => decodeHeic(tooFewY)).toThrow(/one full-resolution component value per pixel/);

    const multiY420 = uncompressedFixture(
      [1, 1, 1, 1, 2, 3],
      Buffer.from([16, 32, 48, 64, 128, 128]),
      5,
      undefined,
      { width: 2, height: 2, samplingType: 2 },
    );
    expect(() => decodeHeic(multiY420)).toThrow(/multi-Y interleave is not valid for 4:2:0/);
  });

  it('decodes mixed-interleaved 4:2:0 with Cr declared before Cb', () => {
    const input = uncompressedFixture(
      [1, 3, 2],
      Buffer.from([16, 32, 48, 64, 80, 96, 112, 128, 128, 128, 128, 128, 128, 128, 128, 128]),
      2,
      { primaries: 1, transfer: 1, matrix: 1, fullRange: true },
      { width: 4, height: 2, samplingType: 2 },
    );

    expect([...decodeHeic(input).data]).toEqual([
      16, 16, 16, 255, 32, 32, 32, 255, 48, 48, 48, 255, 64, 64, 64, 255, 80, 80, 80, 255, 96, 96,
      96, 255, 112, 112, 112, 255, 128, 128, 128, 255,
    ]);
  });

  it('decodes mixed-interleaved 4:2:2 and 4:1:1 chroma pairs', () => {
    const color = { primaries: 1, transfer: 1, matrix: 1, fullRange: true };
    for (const { samplingType, chroma } of [
      { samplingType: 1, chroma: [128, 128, 128, 128] },
      { samplingType: 3, chroma: [128, 128] },
    ]) {
      const input = uncompressedFixture(
        [1, 2, 3],
        Buffer.from([32, 64, 96, 128, ...chroma]),
        2,
        color,
        { width: 4, height: 1, samplingType },
      );
      expect([...decodeHeic(input).data]).toEqual([
        32, 32, 32, 255, 64, 64, 64, 255, 96, 96, 96, 255, 128, 128, 128, 255,
      ]);
    }
  });

  it('byte-aligns packed component rows and applies the configured row alignment', () => {
    const color10 = (rowAlignSize: number) =>
        uncompressedFixture(
          [0],
          Buffer.concat([
            packUnalignedSamples([128], 10),
            Buffer.alloc(rowAlignSize === 0 ? 0 : 2),
            packUnalignedSamples([768], 10),
            Buffer.alloc(rowAlignSize === 0 ? 0 : 2),
          ]),
          0,
          undefined,
          { width: 1, height: 2, bitDepth: 10, rowAlignSize },
        ),
      byteAlignedRows = decodeHeic(color10(0)),
      fourByteAlignedRows = decodeHeic(color10(4)),
      pixelInterleavedRows = decodeHeic(
        uncompressedFixture(
          [4, 5, 6],
          Buffer.concat([
            packUnalignedSamples([1023, 512, 0], 10),
            packUnalignedSamples([0, 512, 1023], 10),
          ]),
          1,
          undefined,
          { width: 1, height: 2, bitDepth: 10 },
        ),
      ),
      truncatedRowPadding = uncompressedFixture(
        [0],
        packUnalignedSamples([128], 10),
        0,
        undefined,
        { width: 1, height: 1, bitDepth: 10, rowAlignSize: 4 },
      );

    expect([...byteAlignedRows.data]).toEqual([32, 32, 32, 255, 191, 191, 191, 255]);
    expect([...fourByteAlignedRows.data]).toEqual([...byteAlignedRows.data]);
    expect([...pixelInterleavedRows.data]).toEqual([255, 128, 0, 255, 0, 128, 255, 255]);
    expect(() => decodeHeic(truncatedRowPadding)).toThrow(/configured row alignment/);
  });

  it('applies row alignment to component rows and mixed-interleaved subsampled chroma', () => {
    const color = { primaries: 1, transfer: 1, matrix: 1, fullRange: true },
      componentPlanar = uncompressedFixture(
        [4, 5, 6],
        Buffer.from([
          10, 20, 30, 0, 40, 50, 60, 0, 70, 80, 90, 0, 100, 110, 120, 0, 130, 140, 150, 0, 160, 170,
          180, 0,
        ]),
        0,
        undefined,
        { width: 3, height: 2, rowAlignSize: 4 },
      ),
      mixed420 = uncompressedFixture(
        [1, 2, 3],
        Buffer.from([
          16, 32, 48, 64, 80, 96, 0, 0, 112, 128, 144, 160, 176, 192, 0, 0, 128, 128, 128, 128, 128,
          128, 0, 0,
        ]),
        2,
        color,
        { width: 6, height: 2, samplingType: 2, rowAlignSize: 4 },
      ),
      component420 = uncompressedFixture(
        [1, 2, 3],
        Buffer.from([16, 32, 48, 64, 80, 96, 112, 128, 128, 128, 0, 0, 128, 128, 0, 0]),
        0,
        color,
        { width: 4, height: 2, samplingType: 2, rowAlignSize: 4 },
      );

    expect([...decodeHeic(componentPlanar).data]).toEqual([
      10, 70, 130, 255, 20, 80, 140, 255, 30, 90, 150, 255, 40, 100, 160, 255, 50, 110, 170, 255,
      60, 120, 180, 255,
    ]);
    expect([...decodeHeic(mixed420).data]).toEqual([
      16, 16, 16, 255, 32, 32, 32, 255, 48, 48, 48, 255, 64, 64, 64, 255, 80, 80, 80, 255, 96, 96,
      96, 255, 112, 112, 112, 255, 128, 128, 128, 255, 144, 144, 144, 255, 160, 160, 160, 255, 176,
      176, 176, 255, 192, 192, 192, 255,
    ]);
    expect([...decodeHeic(component420).data]).toEqual([
      16, 16, 16, 255, 32, 32, 32, 255, 48, 48, 48, 255, 64, 64, 64, 255, 80, 80, 80, 255, 96, 96,
      96, 255, 112, 112, 112, 255, 128, 128, 128, 255,
    ]);
  });

  it('decodes component-interleaved 4:1:1 YCbCr', () => {
    const yuv411 = uncompressedFixture(
      [1, 2, 3],
      Buffer.from([32, 64, 96, 128, 128, 128]),
      0,
      { primaries: 1, transfer: 1, matrix: 1, fullRange: true },
      { width: 4, height: 1, samplingType: 3 },
    );

    expect([...decodeHeic(yuv411).data]).toEqual([
      32, 32, 32, 255, 64, 64, 64, 255, 96, 96, 96, 255, 128, 128, 128, 255,
    ]);
  });

  it('decodes 10-bit component-interleaved YCbCr and alpha from aligned words', () => {
    const payload = Buffer.alloc(24),
      values = [0, 256, 768, 1023, 512, 512, 512, 512, 1023, 512, 0, 1023];
    values.forEach((value, index) => payload.writeUInt16BE(value, index * 2));
    const input = uncompressedFixture(
      [1, 2, 3, 7],
      payload,
      0,
      { primaries: 1, transfer: 1, matrix: 1, fullRange: true },
      {
        width: 4,
        height: 1,
        samplingType: 1,
        bitDepth: 10,
        componentAlignSize: 2,
        pixiBitDepth: 10,
      },
    );
    const decoded = decodeHeic(input);

    expect(decoded.bitDepth).toBe(10);
    expect(getHeicInfo(input, parseISOBMFF(input)).bitDepth).toBe(10);
    expect([...decoded.data]).toEqual([
      0, 0, 0, 255, 64, 64, 64, 128, 191, 191, 191, 0, 255, 255, 255, 255,
    ]);
  });

  it('accepts matching non-8-bit pixi depths and rejects conflicts with uncC', () => {
    const matching = uncompressedFixture([4, 5, 6], Buffer.alloc(6), 1, undefined, {
        width: 1,
        height: 1,
        bitDepth: 10,
        componentAlignSize: 2,
        pixiBitDepth: 10,
      }),
      conflicting = uncompressedFixture([4, 5, 6], Buffer.alloc(6), 1, undefined, {
        width: 1,
        height: 1,
        bitDepth: 10,
        componentAlignSize: 2,
        pixiBitDepth: 9,
      });

    expect(getHeicInfo(matching, parseISOBMFF(matching)).bitDepth).toBe(10);
    expect([...decodeHeic(matching).data]).toEqual([0, 0, 0, 255]);
    expect(() => decodeHeic(conflicting)).toThrow(/pixi bit depths disagree with uncC/);
  });

  it('decodes 10-bit pixel-interleaved RGB and alpha', () => {
    const payload = Buffer.alloc(8),
      values = [1023, 512, 0, 256];
    values.forEach((value, index) => payload.writeUInt16BE(value, index * 2));
    const input = uncompressedFixture([4, 5, 6, 7], payload, 1, undefined, {
      width: 1,
      height: 1,
      bitDepth: 10,
      componentAlignSize: 2,
    });
    const decoded = decodeHeic(input);

    expect(decoded.bitDepth).toBe(10);
    expect([...decoded.data]).toEqual([255, 128, 0, 64]);
  });

  it('decodes 10-bit RGB values packed without byte alignment across pixel boundaries', () => {
    const input = uncompressedFixture(
      [4, 5, 6],
      packUnalignedSamples([1023, 0, 512, 0, 1023, 0], 10),
      1,
      undefined,
      { width: 2, height: 1, bitDepth: 10, pixiBitDepth: 10 },
    );
    const decoded = decodeHeic(input);

    expect(decoded.bitDepth).toBe(10);
    expect([...decoded.data]).toEqual([255, 0, 128, 255, 0, 255, 0, 255]);
  });

  it('normalizes an 8-bit inline alpha component with 10-bit RGB', () => {
    const input = uncompressedFixture(
      [4, 5, 6, 7],
      Buffer.from([0x03, 0xff, 0x02, 0x00, 0x00, 0x00, 0x00, 0x80]),
      1,
      undefined,
      {
        width: 1,
        height: 1,
        bitDepth: 10,
        componentBitDepths: [10, 10, 10, 8],
        componentAlignSize: 2,
      },
    );
    const decoded = decodeHeic(input);

    expect(decoded.bitDepth).toBe(10);
    expect(decoded.hasAlpha).toBe(true);
    expect([...decoded.data]).toEqual([255, 128, 0, 128]);
  });

  it('normalizes RGB components with independent 8-, 10-, and 12-bit depths', () => {
    const input = uncompressedFixture(
      [4, 5, 6, 7],
      Buffer.from([0x00, 0x80, 0x02, 0x00, 0x0f, 0xff, 0x00, 0x80]),
      1,
      undefined,
      {
        width: 1,
        height: 1,
        bitDepth: 8,
        componentBitDepths: [8, 10, 12, 8],
        componentAlignSizes: [2, 2, 2, 2],
        pixiBitDepths: [8, 10, 12, 8],
      },
    );
    const decoded = decodeHeic(input);

    expect(decoded.bitDepth).toBe(12);
    expect(getHeicInfo(input, parseISOBMFF(input)).bitDepth).toBe(12);
    expect([...decoded.data]).toEqual([128, 128, 255, 128]);
  });

  it('renders Y, Cb, and Cr stored at independent component depths', () => {
    const input = uncompressedFixture(
      [1, 2, 3],
      Buffer.from([0x00, 0x00, 0x0f, 0xff, 128, 128, 0x02, 0x00, 0x02, 0x00]),
      0,
      { primaries: 1, transfer: 1, matrix: 1, fullRange: true },
      {
        width: 2,
        height: 1,
        bitDepth: 12,
        componentBitDepths: [12, 8, 10],
        componentAlignSizes: [2, 0, 2],
        pixiBitDepths: [12, 8, 10],
      },
    );
    const decoded = decodeHeic(input);

    expect(decoded.bitDepth).toBe(12);
    expect([...decoded.data]).toEqual([0, 0, 0, 255, 255, 255, 255, 255]);
  });

  it('aligns packed component values before aligned words and checks the intervening padding', () => {
    const layout = {
        width: 1,
        height: 1,
        bitDepth: 10,
        componentAlignSizes: [0, 2, 0],
      },
      valid = uncompressedFixture(
        [4, 5, 6],
        Buffer.from([0xaa, 0x80, 0x02, 0x00, 0xff, 0xc0]),
        1,
        undefined,
        layout,
      ),
      invalidPadding = uncompressedFixture(
        [4, 5, 6],
        Buffer.from([0xaa, 0x81, 0x02, 0x00, 0xff, 0xc0]),
        1,
        undefined,
        layout,
      );

    expect([...decodeHeic(valid).data]).toEqual([170, 128, 255, 255]);
    expect(() => decodeHeic(invalidPadding)).toThrow(/pre-alignment padding bits shall be zero/);
  });

  it('rejects nonzero padding bits in aligned component words', () => {
    const payload = Buffer.alloc(6);
    payload.writeUInt16BE(0xfc00, 0);
    const input = uncompressedFixture([4, 5, 6], payload, 1, undefined, {
      width: 1,
      height: 1,
      bitDepth: 10,
      componentAlignSize: 2,
    });

    expect(() => decodeHeic(input)).toThrow(/alignment padding bits shall be zero/);
  });

  it('reads aligned component words up to the 255-byte uncC field limit', () => {
    const componentValues = [0xabc, 0x123, 0xfff];
    for (const componentAlignSize of [4, 255]) {
      const payload = Buffer.alloc(componentValues.length * componentAlignSize);
      componentValues.forEach((value, index) => {
        const offset = (index + 1) * componentAlignSize - 2;
        payload.writeUInt16BE(value, offset);
      });
      const input = uncompressedFixture([4, 5, 6], payload, 1, undefined, {
        width: 1,
        height: 1,
        bitDepth: 12,
        componentAlignSizes: [componentAlignSize, componentAlignSize, componentAlignSize],
      });

      expect([...decodeHeic(input).data]).toEqual([171, 18, 255, 255]);
    }

    const invalidPadding = Buffer.alloc(12);
    invalidPadding[0] = 1;
    const malformed = uncompressedFixture([4, 5, 6], invalidPadding, 1, undefined, {
      width: 1,
      height: 1,
      bitDepth: 12,
      componentAlignSizes: [4, 4, 4],
    });
    expect(() => decodeHeic(malformed)).toThrow(/alignment padding bits shall be zero/);
  });

  it('reads little-endian aligned component words and validates high-order padding', () => {
    const componentValues = [0xabc, 0x123, 0xfff];
    for (const componentAlignSize of [2, 4, 255]) {
      const payload = Buffer.alloc(componentValues.length * componentAlignSize);
      componentValues.forEach((value, index) => {
        payload.writeUInt16LE(value, index * componentAlignSize);
      });
      const input = uncompressedFixture([4, 5, 6], payload, 1, undefined, {
        width: 1,
        height: 1,
        bitDepth: 12,
        componentAlignSize,
        componentsLittleEndian: true,
      });

      expect([...decodeHeic(input).data]).toEqual([171, 18, 255, 255]);
    }

    const invalidWord = {
        payload: Buffer.from([0x00, 0xf0, 0x00, 0x00, 0x00, 0x00]),
        alignSize: 2,
      },
      invalidWordPadding = {
        payload: Buffer.from([0x00, 0x04, 0x00, 0x00, 0x00, 0x00]),
        alignSize: 2,
      },
      invalidExtendedPadding = {
        payload: Buffer.from([0x01, 0x00, 0x00, 0x01, ...Buffer.alloc(8)]),
        alignSize: 4,
      };
    for (const { payload, alignSize } of [
      invalidWord,
      invalidWordPadding,
      invalidExtendedPadding,
    ]) {
      const malformed = uncompressedFixture([4, 5, 6], payload, 1, undefined, {
        width: 1,
        height: 1,
        bitDepth: 10,
        componentAlignSize: alignSize,
        componentsLittleEndian: true,
      });
      expect(() => decodeHeic(malformed)).toThrow(/alignment padding bits shall be zero/);
    }
  });

  it('validates the uncC constraints for little-endian component words', () => {
    const unaligned = uncompressedFixture([4, 5, 6], Buffer.alloc(3), 1, undefined, {
        width: 1,
        height: 1,
        componentsLittleEndian: true,
      }),
      conflictingBlockEndian = uncompressedFixture([4, 5, 6], Buffer.alloc(6), 1, undefined, {
        width: 1,
        height: 1,
        bitDepth: 10,
        componentAlignSize: 2,
        layoutFlags: 0xa0,
      });

    expect(() => decodeHeic(unaligned)).toThrow(/requires aligned component values/);
    expect(() => decodeHeic(conflictingBlockEndian)).toThrow(
      /requires block_little_endian to be zero/,
    );
  });

  it('rejects pixel interleave with a subsampled component layout', () => {
    const malformed = uncompressedFixture(
      [1, 2, 3],
      Buffer.from([16, 32, 48, 64, 80, 96, 112, 128, 128, 128, 128, 128]),
      1,
      { primaries: 1, transfer: 1, matrix: 1, fullRange: true },
      { width: 4, height: 2, samplingType: 2 },
    );
    expect(() => decodeHeic(malformed)).toThrow(/pixel interleave is not valid/);
  });

  it('rejects mixed interleave when Cb and Cr are not consecutive', () => {
    const malformed = uncompressedFixture([1, 2, 7, 3], Buffer.alloc(8), 2, undefined, {
      width: 2,
      height: 1,
      samplingType: 1,
    });
    expect(() => decodeHeic(malformed)).toThrow(/mixed interleave requires consecutive Cb and Cr/);
  });

  it('rejects an uncompressed item without its required configuration properties', () => {
    const malformed = buildHeif(
      [
        {
          id: 1,
          type: 'unci',
          data: Buffer.from([0, 0, 0]),
          properties: [full('ispe', 0, u32(2), u32(1))],
        },
      ],
      1,
    );
    expect(() => decodeHeic(malformed)).toThrow(/essential uncC property/);
  });
});
