import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  decode,
  decodeHDR,
  decodeHeic,
  findBox,
  getHeicInfo,
  getItemPayload,
  isHeic,
  parseAvcC,
  parseISOBMFF,
} from '../src';
import { parseAvcSps } from '../src/avc';
import { splitAnnexB } from '../src/hevc/nal';
import { prepareAvcDecodeOptions } from '../src/avc';
import { box, buildHeif, full, u16, u32 } from './helpers/heif';
import { buildTiledTileUrl, getTiledImageTileIndices } from '../src/container/tili';

const baselineAvcC = Buffer.from([
  1, 66, 128, 30, 255, 225, 0, 4, 0x67, 66, 128, 30, 1, 0, 2, 0x68, 0,
]);

function u64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
}

function u24(value: number): Buffer {
  return Buffer.from([(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

class MiniBitWriter {
  private readonly bytes: number[] = [];
  private bitOffset = 0;

  write(value: number, count: number): void {
    for (let bit = count - 1; bit >= 0; bit--) {
      if (this.bitOffset % 8 === 0) this.bytes.push(0);
      this.bytes[this.bytes.length - 1] |= ((value >>> bit) & 1) << (7 - (this.bitOffset % 8));
      this.bitOffset++;
    }
  }

  align(): void {
    while (this.bitOffset % 8 !== 0) this.write(0, 1);
  }

  toBuffer(): Buffer {
    return Buffer.from(this.bytes);
  }
}

function makeAvcImage(width = 2, height = 2): Uint8Array {
  return buildHeif(
    [
      {
        id: 11,
        type: 'avc1',
        data: Buffer.from([0, 0, 0, 2, 0x65, 0x80]),
        properties: [
          box('avcC', baselineAvcC),
          full('ispe', 0, u32(width), u32(height)),
          full('pixi', 0, Buffer.from([3, 8, 8, 8])),
        ],
      },
    ],
    11,
  );
}

function makeAvcImageFromAnnexB(annexB: Uint8Array): Uint8Array {
  const nals = splitAnnexB(annexB).map((entry) => entry.data),
    sps = nals.find((nal) => (nal[0] & 31) === 7),
    pps = nals.find((nal) => (nal[0] & 31) === 8);
  if (!sps || !pps) throw new Error('AVC conformance fixture has no SPS/PPS');
  const parsed = parseAvcSps(sps),
    avcC = Buffer.concat([
      Buffer.from([1, sps[1], sps[2], sps[3], 255, 225]),
      u16(sps.length),
      sps,
      Buffer.from([1]),
      u16(pps.length),
      pps,
    ]),
    data = Buffer.concat(
      nals.filter((nal) => ![7, 8].includes(nal[0] & 31)).flatMap((nal) => [u32(nal.length), nal]),
    );
  return buildHeif(
    [
      {
        id: 31,
        type: 'avc1',
        data,
        properties: [
          box('avcC', avcC),
          full('ispe', 0, u32(parsed.displayWidth), u32(parsed.displayHeight)),
          full('pixi', 0, Buffer.from([3, parsed.bitDepthLuma, parsed.bitDepthChroma, 8])),
        ],
      },
    ],
    31,
  );
}

function miniGainMapMetadata(): Buffer {
  const fixed = (numerator: number, signed = false) => {
    const value = Buffer.alloc(4);
    if (signed) value.writeInt32BE(numerator);
    else value.writeUInt32BE(numerator);
    return Buffer.concat([value, u32(1)]);
  };
  return Buffer.concat([
    u16(0),
    u16(0),
    Buffer.from([0x40]),
    fixed(0),
    fixed(2),
    fixed(0, true),
    fixed(1, true),
    fixed(1),
    fixed(0, true),
    fixed(0, true),
  ]);
}

function makeMiniAvcFromAnnexB(
  annexB: Uint8Array,
  withAlpha = false,
  withGainMap = false,
): Uint8Array {
  const regular = makeAvcImageFromAnnexB(annexB),
    boxes = parseISOBMFF(regular),
    info = getHeicInfo(regular, boxes),
    avcC = findBox(boxes, 'avcC')?.data,
    payload = getItemPayload(regular, boxes, info.primaryItemId);
  if (!avcC || !payload) throw new Error('AVC fixture has no configuration or payload');

  const writer = new MiniBitWriter();
  writer.write(0, 2); // version
  writer.write(0, 1); // explicit_codec_types_flag: avic implies avc1/avcC
  writer.write(0, 1); // float_flag
  writer.write(1, 1); // full_range_flag
  writer.write(withAlpha ? 1 : 0, 1); // alpha_flag
  writer.write(0, 1); // explicit_cicp_flag
  writer.write(withGainMap ? 1 : 0, 1); // hdr_flag
  writer.write(0, 1); // icc_flag
  writer.write(0, 1); // exif_flag
  writer.write(0, 1); // xmp_flag
  writer.write(1, 2); // 4:2:0 chroma
  writer.write(0, 3); // orientation 1
  writer.write(1, 1); // large_dimensions_flag
  writer.write(info.width - 1, 15);
  writer.write(info.height - 1, 15);
  writer.write(0, 1); // chroma_is_horizontally_centered
  writer.write(0, 1); // chroma_is_vertically_centered
  writer.write(0, 1); // high_bit_depth_flag
  if (withAlpha) writer.write(0, 1); // alpha_is_premultiplied
  if (withGainMap) {
    writer.write(1, 1); // has_gain_map_flag
    writer.write(1, 1); // gainmap_dimension_same_as_main_item_flag
    writer.write(6, 8); // gainmap_matrix_coefficients
    writer.write(1, 1); // gainmap_full_range_flag
    writer.write(1, 2); // gainmap_chroma_subsampling: 4:2:0
    writer.write(0, 1); // gainmap_chroma_is_horizontally_centered
    writer.write(0, 1); // gainmap_chroma_is_vertically_centered
    writer.write(0, 1); // gainmap_float_flag
    writer.write(0, 1); // gainmap_high_bit_depth_flag
    writer.write(0, 1); // tmap_icc_flag
    writer.write(1, 1); // tmap_explicit_cicp_flag
    writer.write(9, 8); // tmap_colour_primaries
    writer.write(16, 8); // tmap_transfer_characteristics
    writer.write(9, 8); // tmap_matrix_coefficients
    writer.write(1, 1); // tmap_full_range_flag
    writer.write(0, 6); // base-image HDR properties
    writer.write(0, 6); // tone-mapped HDR properties
  }
  if (withGainMap) writer.write(0, 1); // large_metadata_flag
  writer.write(1, 1); // large_codec_config_flag
  writer.write(1, 1); // large_item_data_flag
  if (withGainMap) {
    writer.write(miniGainMapMetadata().length, 10);
    writer.write(payload.length, 28); // gainmap_item_data_size
    writer.write(0, 12); // reuse main avcC
  }
  writer.write(avcC.length, 12);
  writer.write(payload.length - 1, 28);
  if (withAlpha) {
    writer.write(payload.length, 28); // alpha_item_data_size
    writer.write(avcC.length, 12); // explicit alpha avcC
  }
  writer.align();

  const metadata = withGainMap ? miniGainMapMetadata() : null;
  return Buffer.concat([
    box('ftyp', Buffer.from('mif3'), Buffer.from('avic')),
    box(
      'mini',
      writer.toBuffer(),
      avcC,
      ...(withAlpha ? [avcC] : []),
      ...(metadata ? [metadata] : []),
      ...(withAlpha ? [payload] : []),
      ...(withGainMap ? [payload] : []),
      payload,
    ),
  ]);
}

function makeExternalAvcTili(tileWidth: number, tileHeight: number, columns: number): Uint8Array {
  const tileCount = columns,
    deti = box(
      'deti',
      Buffer.concat([
        Buffer.from([0, 0, 0, 0x80]),
        Buffer.from([tileCount, 0]),
        u64(1000),
        Buffer.from('https://cdn.example.invalid/avc-tiles/'),
        Buffer.from([0]),
        Buffer.from('v1'),
        Buffer.from([0]),
        Buffer.from('$tileID$.heic'),
        Buffer.from([0]),
      ]),
    ),
    tiled = Buffer.from(
      buildHeif(
        [
          {
            id: 1,
            type: 'tili',
            data: new Uint8Array(),
            properties: [
              full('ispe', 0, u32(tileWidth * columns), u32(tileHeight)),
              full('tilC', 0, u32(tileWidth), u32(tileHeight), Buffer.from([0])),
            ],
            dataReference: deti,
          },
        ],
        1,
      ),
    );
  tiled.write('mif1', 8, 'ascii');
  tiled.write('mif1avci', 16, 'ascii');
  return tiled;
}

function makeInFileAvcTili(tile: Uint8Array): Uint8Array {
  const tileBoxes = parseISOBMFF(tile),
    tileInfo = getHeicInfo(tile, tileBoxes),
    tilePayload = getItemPayload(tile, tileBoxes, tileInfo.primaryItemId)!,
    avcC = findBox(tileBoxes, 'avcC')!;
  if (!tileInfo.avcC || !tilePayload || !avcC)
    throw new Error('AVC fixture has no configuration or item payload');
  const columns = 2,
    tableStart = tilePayload.length * columns,
    tableSize = columns * 7,
    offsetTable = Buffer.concat([
      u32(0),
      u24(tilePayload.length),
      u32(tilePayload.length),
      u24(tilePayload.length),
    ]),
    data = Buffer.concat([Buffer.from(tilePayload), Buffer.from(tilePayload), offsetTable]),
    deti = box('deti', Buffer.from([0, 0, 0, 0x14, columns]), u32(tableStart), u32(tableSize)),
    tilC = full(
      'tilC',
      0,
      u32(tileInfo.width),
      u32(tileInfo.height),
      Buffer.from([0]),
      Buffer.from('avc1'),
      box('tipa', Buffer.from([0, 0, 0, 0, 2, 0x83, 0x04])),
    );
  return buildHeif(
    [
      {
        id: 21,
        type: 'tili',
        data,
        properties: [
          full('ispe', 0, u32(tileInfo.width * columns), u32(tileInfo.height)),
          tilC,
          box('avcC', avcC.data),
          full('pixi', 0, Buffer.from([3, 8, 8, 8])),
        ],
        dataReference: deti,
      },
    ],
    21,
  );
}

describe('AVCDecoderConfigurationRecord', () => {
  it('parses AVCC NAL framing and SPS/PPS arrays', () => {
    expect(parseAvcC(baselineAvcC)).toMatchObject({
      configurationVersion: 1,
      profileIdc: 66,
      profileCompatibility: 128,
      levelIdc: 30,
      nalLengthSize: 4,
      sequenceParameterSets: [Buffer.from([0x67, 66, 128, 30])],
      pictureParameterSets: [Buffer.from([0x68, 0])],
      sequenceParameterSetExtensions: [],
      chromaFormatIdc: null,
      bitDepthLumaMinus8: null,
      bitDepthChromaMinus8: null,
    });
  });

  it('parses high-profile chroma, bit-depth and SPS-extension fields', () => {
    const record = Buffer.from([
      1, 100, 0, 40, 255, 225, 0, 4, 0x67, 100, 0, 40, 1, 0, 2, 0x68, 0, 0xfd, 0xfa, 0xfa, 1, 0, 2,
      0x6d, 0,
    ]);
    expect(parseAvcC(record)).toMatchObject({
      profileIdc: 100,
      chromaFormatIdc: 1,
      bitDepthLumaMinus8: 2,
      bitDepthChromaMinus8: 2,
      sequenceParameterSetExtensions: [Buffer.from([0x6d, 0])],
    });
  });

  it('rejects reserved length sizes, malformed NAL arrays, and trailing bytes', () => {
    const reservedLengthSize = Buffer.from(baselineAvcC);
    reservedLengthSize[4] = 0xfe;
    expect(() => parseAvcC(reservedLengthSize)).toThrow('reserved avcC NAL length size');

    const wrongNalType = Buffer.from(baselineAvcC);
    wrongNalType[8] = 0x68;
    expect(() => parseAvcC(wrongNalType)).toThrow('invalid avcC sequence parameter set NAL unit');

    expect(() => parseAvcC(Buffer.from([...baselineAvcC, 0]))).toThrow(
      'unexpected trailing avcC data',
    );

    const mismatchedProfile = Buffer.from(baselineAvcC);
    mismatchedProfile[9] = 100;
    expect(() => parseAvcC(mismatchedProfile)).toThrow('profile tuple disagrees');

    const overclaimedCompatibility = Buffer.from(baselineAvcC);
    overclaimedCompatibility[10] = 0;
    expect(() => parseAvcC(overclaimedCompatibility)).toThrow('profile tuple disagrees');

    const compatibleProfile = Buffer.from(baselineAvcC);
    compatibleProfile[2] = 0;
    expect(parseAvcC(compatibleProfile).profileCompatibility).toBe(0);
  });
});

describe('avc1 image items', () => {
  it('accepts an essential avcC property and reports AVC image metadata', () => {
    const image = makeAvcImage();
    const info = getHeicInfo(image, parseISOBMFF(image));
    expect(isHeic(image)).toBe(true);
    expect(info).toMatchObject({
      primaryItemId: 11,
      primaryItemType: 'avc1',
      width: 2,
      height: 2,
      bitDepth: 8,
      avcC: { profileIdc: 66, nalLengthSize: 4 },
      hvcC: null,
    });
  });

  it('renders caller-decoded primary AVC planes and validates their shape', () => {
    const image = makeAvcImage();
    const options = {
      externalBaseLayerPlanes: {
        11: {
          width: 2,
          height: 2,
          chromaFormatIdc: 1,
          bitDepthLuma: 8,
          bitDepthChroma: 8,
          y: Uint8Array.from([16, 64, 128, 235]),
          cb: Uint8Array.from([128]),
          cr: Uint8Array.from([128]),
        },
      },
    };
    const output = decodeHeic(image, options);
    expect(output).toMatchObject({ width: 2, height: 2, bitDepth: 8 });
    expect(output.data).toHaveLength(16);

    expect(() =>
      decodeHeic(image, {
        externalBaseLayerPlanes: {
          ...options.externalBaseLayerPlanes,
          11: {
            ...options.externalBaseLayerPlanes[11],
            width: 1,
            y: Uint8Array.from([16, 64]),
            cb: Uint8Array.from([128]),
            cr: Uint8Array.from([128]),
          },
        },
      }),
    ).toThrow('dimensions disagree with ispe');
  });

  it('rejects an AVC item with a truncated SPS', () => {
    expect(() => decodeHeic(makeAvcImage())).toThrow('truncated AVC sequence parameter set');
  });

  it('synchronously decodes an official H.264.1 Baseline IDR in Node', async () => {
    const annexB = new Uint8Array(
        readFileSync(new URL('./fixtures/conformance/SVA_Base_B-first.264', import.meta.url)),
      ),
      image = makeAvcImageFromAnnexB(annexB),
      syncOutput = decodeHeic(image),
      asyncOutput = await decode(image, { execution: 'main' });
    expect(syncOutput).toMatchObject({ width: 176, height: 144, bitDepth: 8 });
    expect(syncOutput.data).toEqual(asyncOutput.data);
  });

  it('decodes a valid progressive AVC HEIF through the async WebAssembly path', async () => {
    const image = new Uint8Array(
        readFileSync(new URL('./fixtures/avc/mini-16x16.heic', import.meta.url)),
      ),
      expected = new Uint8Array(
        readFileSync(new URL('./fixtures/avc/mini-16x16.yuv', import.meta.url)),
      ),
      options = await prepareAvcDecodeOptions(image, {}),
      planes = options.externalBaseLayerPlanes?.[11];
    expect(planes).toBeDefined();
    expect(
      Buffer.concat([Buffer.from(planes!.y), Buffer.from(planes!.cb), Buffer.from(planes!.cr)]),
    ).toEqual(expected);
    const output = await decode(image, { execution: 'main' });
    expect(output).toMatchObject({ width: 16, height: 16, bitDepth: 8 });
    expect(output.data).toHaveLength(16 * 16 * 4);
  });

  it('decodes progressive AVC image files used as external tili tiles', async () => {
    const tile = new Uint8Array(
        readFileSync(new URL('./fixtures/avc/mini-16x16.heic', import.meta.url)),
      ),
      tiled = makeExternalAvcTili(16, 16, 2),
      info = getHeicInfo(tiled, parseISOBMFF(tiled)),
      selected = getTiledImageTileIndices(info.tiledImage!),
      resources = Object.fromEntries(
        selected.map((index) => [buildTiledTileUrl(info.tiledImage!.dataReference, index), tile]),
      ),
      source = await decode(tile, { execution: 'main' }),
      requested: string[] = [],
      output = await decode(tiled, {
        execution: 'main',
        resolveExternalTile: (url) => {
          requested.push(url);
          return resources[url];
        },
      }),
      expected = new Uint8Array(32 * 16 * 4);
    for (let row = 0; row < 16; row++) {
      const sourceRow = source.data.subarray(row * 16 * 4, (row + 1) * 16 * 4),
        targetRow = row * 32 * 4;
      expected.set(sourceRow, targetRow);
      expected.set(sourceRow, targetRow + 16 * 4);
    }
    expect(output).toMatchObject({ width: 32, height: 16, bitDepth: 8 });
    expect(requested.sort()).toEqual(Object.keys(resources).sort());
    expect(output.data).toEqual(expected);

    const supplied = await decode(tiled, { execution: 'main', externalTileData: resources });
    expect(supplied.data).toEqual(output.data);
    expect(decodeHeic(tiled, { externalTileData: resources }).data).toEqual(output.data);

    const prepared = await prepareAvcDecodeOptions(tiled, { externalTileData: resources });
    expect(prepared.externalTileBaseLayerPlanes).toBeDefined();
    expect(decodeHeic(tiled, prepared).data).toEqual(output.data);
  });

  it('decodes progressive AVC items from in-file tili tile ranges', async () => {
    const tile = new Uint8Array(
        readFileSync(new URL('./fixtures/avc/mini-16x16.heic', import.meta.url)),
      ),
      tiled = makeInFileAvcTili(tile),
      info = getHeicInfo(tiled, parseISOBMFF(tiled)),
      source = await decode(tile, { execution: 'main' }),
      prepared = await prepareAvcDecodeOptions(tiled, {}),
      output = await decode(tiled, { execution: 'main' }),
      expected = new Uint8Array(32 * 16 * 4);
    for (let row = 0; row < 16; row++) {
      const sourceRow = source.data.subarray(row * 16 * 4, (row + 1) * 16 * 4),
        targetRow = row * 32 * 4;
      expected.set(sourceRow, targetRow);
      expected.set(sourceRow, targetRow + 16 * 4);
    }
    expect(isHeic(tiled)).toBe(true);
    expect(info).toMatchObject({
      primaryItemType: 'tili',
      width: 32,
      height: 16,
      avcC: { profileIdc: 66 },
      tiledImage: { tileItemType: 'avc1', columns: 2, rows: 1 },
    });
    expect(prepared.avcTiliTilePlanes?.[21]?.[0]).toBeDefined();
    expect(prepared.avcTiliTilePlanes?.[21]?.[1]).toBeDefined();
    expect(output).toMatchObject({ width: 32, height: 16, bitDepth: 8 });
    expect(output.data).toEqual(expected);
    expect(decodeHeic(tiled, prepared).data).toEqual(output.data);
    expect(decodeHeic(tiled).data).toEqual(output.data);
  });

  it('matches the official H.264.1 Baseline IDR through an in-file AVC tili item', async () => {
    const annexB = new Uint8Array(
        readFileSync(new URL('./fixtures/conformance/SVA_Base_B-first.264', import.meta.url)),
      ),
      reference = new Uint8Array(
        readFileSync(new URL('./fixtures/conformance/SVA_Base_B-first.yuv', import.meta.url)),
      ),
      image = makeAvcImageFromAnnexB(annexB),
      imageInfo = getHeicInfo(image, parseISOBMFF(image)),
      preparedImage = await prepareAvcDecodeOptions(image, {}),
      imagePlanes = preparedImage.externalBaseLayerPlanes?.[31];
    expect(imageInfo).toMatchObject({
      primaryItemType: 'avc1',
      width: 176,
      height: 144,
      avcC: { profileIdc: 66 },
    });
    expect(imagePlanes).toBeDefined();
    expect(
      Buffer.concat([
        Buffer.from(imagePlanes!.y),
        Buffer.from(imagePlanes!.cb),
        Buffer.from(imagePlanes!.cr),
      ]),
    ).toEqual(reference);

    const tiled = makeInFileAvcTili(image),
      source = await decode(image, { execution: 'main' }),
      preparedTiled = await prepareAvcDecodeOptions(tiled, {}),
      output = await decode(tiled, { execution: 'main' }),
      expected = new Uint8Array(imageInfo.width * 2 * imageInfo.height * 4);
    for (let row = 0; row < imageInfo.height; row++) {
      const sourceRow = source.data.subarray(
          row * imageInfo.width * 4,
          (row + 1) * imageInfo.width * 4,
        ),
        targetRow = row * imageInfo.width * 2 * 4;
      expected.set(sourceRow, targetRow);
      expected.set(sourceRow, targetRow + imageInfo.width * 4);
    }
    expect(output).toMatchObject({ width: 352, height: 144, bitDepth: 8 });
    expect(output.data).toEqual(expected);
    expect(decodeHeic(tiled, preparedTiled).data).toEqual(output.data);
    expect(decodeHeic(tiled).data).toEqual(output.data);
  });

  it('decodes an official H.264.1 Baseline IDR through an avic mini image', async () => {
    const annexB = new Uint8Array(
        readFileSync(new URL('./fixtures/conformance/SVA_Base_B-first.264', import.meta.url)),
      ),
      reference = new Uint8Array(
        readFileSync(new URL('./fixtures/conformance/SVA_Base_B-first.yuv', import.meta.url)),
      ),
      image = makeMiniAvcFromAnnexB(annexB),
      boxes = parseISOBMFF(image),
      info = getHeicInfo(image, boxes),
      prepared = await prepareAvcDecodeOptions(image, {}),
      planes = prepared.externalBaseLayerPlanes?.[1];
    expect(isHeic(image)).toBe(true);
    expect(info).toMatchObject({
      primaryItemType: 'avc1',
      width: 176,
      height: 144,
      bitDepth: 8,
      avcC: { profileIdc: 66 },
      hvcC: null,
    });
    expect(planes).toBeDefined();
    expect(
      Buffer.concat([Buffer.from(planes!.y), Buffer.from(planes!.cb), Buffer.from(planes!.cr)]),
    ).toEqual(reference);

    const output = await decode(image, { execution: 'main' });
    expect(output).toMatchObject({ width: 176, height: 144, bitDepth: 8 });
    expect(output.data).toHaveLength(176 * 144 * 4);
    for (let alpha = 3; alpha < output.data.length; alpha += 4)
      expect(output.data[alpha]).toBe(255);
  });

  it('decodes an official H.264.1 Baseline IDR as both avic mini image and alpha item', async () => {
    const annexB = new Uint8Array(
        readFileSync(new URL('./fixtures/conformance/SVA_Base_B-first.264', import.meta.url)),
      ),
      reference = new Uint8Array(
        readFileSync(new URL('./fixtures/conformance/SVA_Base_B-first.yuv', import.meta.url)),
      ),
      image = makeMiniAvcFromAnnexB(annexB, true),
      boxes = parseISOBMFF(image),
      info = getHeicInfo(image, boxes),
      alphaInfo = getHeicInfo(image, boxes, 2),
      prepared = await prepareAvcDecodeOptions(image, {}),
      basePlanes = prepared.externalBaseLayerPlanes?.[1],
      alphaPlanes = prepared.externalBaseLayerPlanes?.[2];

    expect(info).toMatchObject({ hasAlpha: true, alphaItemId: 2, premultipliedAlpha: false });
    expect(alphaInfo).toMatchObject({ primaryItemType: 'avc1', avcC: { profileIdc: 66 } });
    for (const planes of [basePlanes, alphaPlanes]) {
      expect(planes).toBeDefined();
      expect(
        Buffer.concat([Buffer.from(planes!.y), Buffer.from(planes!.cb), Buffer.from(planes!.cr)]),
      ).toEqual(reference);
    }

    const output = await decode(image, { execution: 'main' });
    expect(output).toMatchObject({ width: 176, height: 144, bitDepth: 8, hasAlpha: true });
    for (let pixel = 0; pixel < 176 * 144; pixel++)
      expect(output.data[pixel * 4 + 3]).toBe(reference[pixel]);
  });

  it('applies an avic mini gain map using the official H.264.1 reconstruction', async () => {
    const annexB = new Uint8Array(
        readFileSync(new URL('./fixtures/conformance/SVA_Base_B-first.264', import.meta.url)),
      ),
      baseImage = makeMiniAvcFromAnnexB(annexB),
      image = makeMiniAvcFromAnnexB(annexB, false, true),
      boxes = parseISOBMFF(image),
      info = getHeicInfo(image, boxes),
      gainMapInfo = getHeicInfo(image, boxes, 4),
      hdr = await decodeHDR(image, { execution: 'main', displayHeadroom: 4 }),
      selectedToneMap = await decodeHDR(image, {
        execution: 'main',
        itemId: 3,
        displayHeadroom: 4,
      }),
      base = await decodeHDR(baseImage, { execution: 'main' });

    expect(info.miniGainMap?.imageItemId).toBe(4);
    expect(gainMapInfo).toMatchObject({
      primaryItemType: 'avc1',
      width: 176,
      height: 144,
      bitDepth: 8,
      avcC: { profileIdc: 66 },
      hvcC: null,
    });
    expect(hdr.source).toBe('iso-gainmap');
    expect(selectedToneMap.source).toBe('iso-gainmap');
    expect(selectedToneMap.data).toEqual(hdr.data);
    expect(hdr.data.some((value, index) => index % 4 !== 3 && value > base.data[index])).toBe(true);
    expect([...hdr.data].every(Number.isFinite)).toBe(true);
  });
});
