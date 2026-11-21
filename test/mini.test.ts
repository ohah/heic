import { readFileSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'bun:test';
import { decodeHeic, decodeHeicAuxiliaryPlanes, getHeicMetadata, isHeic } from '../src/decoder';
import { decodeHDRSync } from '../src/hdr';
import { getFtypInfo, parseISOBMFF } from '../src/container/heif';
import { getHeicInfo, getItemPayload } from '../src/container/heic';
import { parseMiniImage } from '../src/container/mini';
import { decodeItemPlanes } from '../src/planes';
import { buildHeif as buildRegularHeif, full as fullHeif } from './helpers/heif';

const input = new Uint8Array(
  readFileSync(new URL('./fixtures/conformance/mini-C71.heic', import.meta.url)),
);
const miniBox = parseISOBMFF(input).find((miniBoxEntry) => miniBoxEntry.type === 'mini')!;
const baseMini = parseMiniImage(miniBox.data, 0x68656963);
const alphaCodecConfig = new Uint8Array(
  readFileSync(new URL('./fixtures/conformance/mini-alpha-L_8.hvcc', import.meta.url)),
);
const alphaItemData = new Uint8Array(
  readFileSync(new URL('./fixtures/conformance/mini-alpha-L_8.hevc', import.meta.url)),
);
const alphaReference = new Uint8Array(
  readFileSync(new URL('./fixtures/conformance/mini-alpha-L_8.y', import.meta.url)),
);

function miniParseError(data: Uint8Array): unknown {
  try {
    parseMiniImage(data, 0x68656963);
  } catch (error) {
    return error;
  }
  throw new Error('expected the HEVC mini image to be rejected');
}

class BitWriter {
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

function u32(value: number): Buffer {
  const output = Buffer.alloc(4);
  output.writeUInt32BE(value);
  return output;
}

function u16(value: number): Buffer {
  const output = Buffer.alloc(2);
  output.writeUInt16BE(value);
  return output;
}

function box(type: string, data: Uint8Array): Buffer {
  return Buffer.concat([u32(data.length + 8), Buffer.from(type), data]);
}

function miniWithAlpha(): Uint8Array {
  const writer = new BitWriter();
  writer.write(0, 2); // version
  writer.write(0, 1); // explicit_codec_types_flag
  writer.write(0, 1); // float_flag
  writer.write(1, 1); // full_range_flag
  writer.write(1, 1); // alpha_flag
  writer.write(0, 1); // explicit_cicp_flag
  writer.write(0, 1); // hdr_flag
  writer.write(0, 1); // icc_flag
  writer.write(0, 1); // exif_flag
  writer.write(0, 1); // xmp_flag
  writer.write(1, 2); // 4:2:0 chroma
  writer.write(7, 3); // orientation 8
  writer.write(1, 1); // large_dimensions_flag
  writer.write(baseMini.width - 1, 15);
  writer.write(baseMini.height - 1, 15);
  writer.write(0, 1); // chroma_is_horizontally_centered
  writer.write(0, 1); // chroma_is_vertically_centered
  writer.write(0, 1); // high_bit_depth_flag
  writer.write(0, 1); // alpha_is_premultiplied
  writer.write(1, 1); // large_codec_config_flag
  writer.write(0, 1); // large_item_data_flag
  writer.write(baseMini.codecConfig.length, 12);
  writer.write(baseMini.itemData.length - 1, 15);
  writer.write(alphaItemData.length, 15);
  writer.write(alphaCodecConfig.length, 12);
  writer.align();

  const miniPayload = Buffer.concat([
    writer.toBuffer(),
    Buffer.from(baseMini.codecConfig),
    Buffer.from(alphaCodecConfig),
    Buffer.from(alphaItemData),
    Buffer.from(baseMini.itemData),
  ]);
  const fileType = box('ftyp', Buffer.concat([Buffer.from('mif3'), u32(0x68656963)]));
  return new Uint8Array(Buffer.concat([fileType, box('mini', miniPayload)]));
}

function miniWithChromaCentering(
  horizontal: boolean,
  vertical: boolean,
  floatDepthCode?: number,
): Uint8Array {
  const writer = new BitWriter();
  writer.write(0, 2); // version
  writer.write(0, 1); // explicit_codec_types_flag
  writer.write(floatDepthCode === undefined ? 0 : 1, 1); // float_flag
  writer.write(1, 1); // full_range_flag
  writer.write(0, 1); // alpha_flag
  writer.write(0, 1); // explicit_cicp_flag
  writer.write(0, 1); // hdr_flag
  writer.write(0, 1); // icc_flag
  writer.write(0, 1); // exif_flag
  writer.write(0, 1); // xmp_flag
  writer.write(1, 2); // 4:2:0 chroma
  writer.write(baseMini.orientation - 1, 3);
  writer.write(1, 1); // large_dimensions_flag
  writer.write(baseMini.width - 1, 15);
  writer.write(baseMini.height - 1, 15);
  writer.write(horizontal ? 1 : 0, 1); // chroma_is_horizontally_centered
  writer.write(vertical ? 1 : 0, 1); // chroma_is_vertically_centered
  if (floatDepthCode === undefined) writer.write(0, 1); // high_bit_depth_flag
  else writer.write(floatDepthCode, 2); // bit_depth_log2_minus4
  writer.write(1, 1); // large_codec_config_flag
  writer.write(0, 1); // large_item_data_flag
  writer.write(baseMini.codecConfig.length, 12);
  writer.write(baseMini.itemData.length - 1, 15);
  writer.align();

  const miniPayload = Buffer.concat([
    writer.toBuffer(),
    Buffer.from(baseMini.codecConfig),
    Buffer.from(baseMini.itemData),
  ]);
  const fileType = box('ftyp', Buffer.concat([Buffer.from('mif3'), u32(0x68656963)]));
  return new Uint8Array(Buffer.concat([fileType, box('mini', miniPayload)]));
}

function miniWithYv20(payload: Uint8Array): Uint8Array {
  const codecConfig = Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from('yv20')]),
    writer = new BitWriter();
  writer.write(0, 2); // version
  writer.write(1, 1); // explicit_codec_types_flag
  writer.write(0, 1); // float_flag
  writer.write(0, 1); // full_range_flag
  writer.write(0, 1); // alpha_flag
  writer.write(1, 1); // explicit_cicp_flag
  writer.write(0, 1); // hdr_flag
  writer.write(0, 1); // icc_flag
  writer.write(0, 1); // exif_flag
  writer.write(0, 1); // xmp_flag
  writer.write(1, 2); // 4:2:0 chroma
  writer.write(0, 3); // orientation 1
  writer.write(0, 1); // large_dimensions_flag
  writer.write(1, 7); // width_minus1: 2
  writer.write(1, 7); // height_minus1: 2
  writer.write(0, 1); // chroma_is_horizontally_centered
  writer.write(0, 1); // chroma_is_vertically_centered
  writer.write(0, 1); // high_bit_depth_flag
  writer.write(2, 8); // unspecified colour primaries
  writer.write(2, 8); // unspecified transfer characteristics
  writer.write(6, 8); // SMPTE 170M matrix
  for (const type of ['unci', 'uncC'])
    for (const character of type) writer.write(character.charCodeAt(0), 8);
  writer.write(1, 1); // large_codec_config_flag
  writer.write(0, 1); // large_item_data_flag
  writer.write(codecConfig.length, 12);
  writer.write(payload.length - 1, 15);
  writer.align();

  const miniPayload = Buffer.concat([writer.toBuffer(), codecConfig, Buffer.from(payload)]),
    fileType = box('ftyp', Buffer.concat([Buffer.from('mif3'), u32(0), Buffer.from('mif3')]));
  return new Uint8Array(Buffer.concat([fileType, box('mini', miniPayload)]));
}

function miniWithYv20GainMap(mainPayload: Uint8Array, gainMapPayload: Uint8Array): Uint8Array {
  const codecConfig = Buffer.concat([Buffer.from([1, 0, 0, 0]), Buffer.from('yv20')]),
    metadata = miniGainMapMetadata(),
    writer = new BitWriter();
  writer.write(0, 2); // version
  writer.write(1, 1); // explicit_codec_types_flag
  writer.write(0, 1); // float_flag
  writer.write(0, 1); // full_range_flag
  writer.write(0, 1); // alpha_flag
  writer.write(1, 1); // explicit_cicp_flag
  writer.write(1, 1); // hdr_flag
  writer.write(0, 1); // icc_flag
  writer.write(0, 1); // exif_flag
  writer.write(0, 1); // xmp_flag
  writer.write(1, 2); // 4:2:0 chroma
  writer.write(0, 3); // orientation 1
  writer.write(0, 1); // large_dimensions_flag
  writer.write(1, 7); // width_minus1: 2
  writer.write(1, 7); // height_minus1: 2
  writer.write(0, 1); // chroma_is_horizontally_centered
  writer.write(0, 1); // chroma_is_vertically_centered
  writer.write(0, 1); // high_bit_depth_flag
  writer.write(2, 8); // unspecified colour primaries
  writer.write(2, 8); // unspecified transfer characteristics
  writer.write(6, 8); // SMPTE 170M matrix
  for (const type of ['unci', 'uncC'])
    for (const character of type) writer.write(character.charCodeAt(0), 8);
  writer.write(1, 1); // gainmap_flag
  writer.write(1, 1); // gainmap_dimension_same_as_main_item_flag
  writer.write(6, 8); // gainmap_matrix_coefficients
  writer.write(0, 1); // gainmap_full_range_flag
  writer.write(1, 2); // gainmap_chroma_subsampling: 4:2:0
  writer.write(0, 1); // gainmap_chroma_is_horizontally_centered
  writer.write(0, 1); // gainmap_chroma_is_vertically_centered
  writer.write(0, 1); // gainmap_float_flag
  writer.write(0, 1); // gainmap_high_bit_depth_flag
  writer.write(0, 1); // tmap_icc_flag
  writer.write(1, 1); // tmap_explicit_cicp_flag
  writer.write(2, 8); // unspecified colour primaries
  writer.write(2, 8); // unspecified transfer characteristics
  writer.write(6, 8); // SMPTE 170M matrix
  writer.write(0, 1); // tmap_full_range_flag
  writer.write(0, 6); // main HDR metadata flags
  writer.write(0, 6); // tone-map HDR metadata flags
  writer.write(0, 1); // large_metadata_flag
  writer.write(1, 1); // large_codec_config_flag
  writer.write(0, 1); // large_item_data_flag
  writer.write(metadata.length, 10);
  writer.write(gainMapPayload.length, 15);
  writer.write(0, 12); // reuse main uncC configuration for the gain map
  writer.write(codecConfig.length, 12);
  writer.write(mainPayload.length - 1, 15);
  writer.align();

  const miniPayload = Buffer.concat([
    writer.toBuffer(),
    codecConfig,
    metadata,
    Buffer.from(gainMapPayload),
    Buffer.from(mainPayload),
  ]);
  const fileType = box('ftyp', Buffer.concat([Buffer.from('mif3'), u32(0), Buffer.from('mif3')]));
  return new Uint8Array(Buffer.concat([fileType, box('mini', miniPayload)]));
}

function withMiniFileType(
  miniFile: Uint8Array,
  majorBrand: string,
  minorVersion: number,
  compatibleBrands: string[],
): Uint8Array {
  const miniData = parseISOBMFF(miniFile).find((entry) => entry.type === 'mini')!.data,
    fileType = box(
      'ftyp',
      Buffer.concat([
        Buffer.from(majorBrand),
        u32(minorVersion),
        ...compatibleBrands.map((brand) => Buffer.from(brand)),
      ]),
    );
  return new Uint8Array(Buffer.concat([fileType, box('mini', miniData)]));
}

function miniWithMetadata(options: {
  icc?: Uint8Array;
  exif?: Uint8Array;
  xmp?: Uint8Array;
  compressed: boolean;
  largeMetadata: boolean;
}): Uint8Array {
  const icc = options.icc ?? null,
    exif = options.exif ?? null,
    xmp = options.xmp ?? null,
    hasMetadata = icc !== null || exif !== null || xmp !== null,
    writer = new BitWriter();
  writer.write(0, 2); // version
  writer.write(0, 1); // explicit_codec_types_flag
  writer.write(0, 1); // float_flag
  writer.write(1, 1); // full_range_flag
  writer.write(0, 1); // alpha_flag
  writer.write(0, 1); // explicit_cicp_flag
  writer.write(0, 1); // hdr_flag
  writer.write(icc !== null ? 1 : 0, 1); // icc_flag
  writer.write(exif !== null ? 1 : 0, 1); // exif_flag
  writer.write(xmp !== null ? 1 : 0, 1); // xmp_flag
  writer.write(1, 2); // 4:2:0 chroma
  writer.write(baseMini.orientation - 1, 3);
  writer.write(1, 1); // large_dimensions_flag
  writer.write(baseMini.width - 1, 15);
  writer.write(baseMini.height - 1, 15);
  writer.write(0, 1); // chroma_is_horizontally_centered
  writer.write(0, 1); // chroma_is_vertically_centered
  writer.write(0, 1); // high_bit_depth_flag
  if (hasMetadata) writer.write(options.largeMetadata ? 1 : 0, 1);
  writer.write(1, 1); // large_codec_config_flag
  writer.write(0, 1); // large_item_data_flag
  if (icc) writer.write(icc.length - 1, options.largeMetadata ? 20 : 10);
  writer.write(baseMini.codecConfig.length, 12);
  writer.write(baseMini.itemData.length - 1, 15);
  if (exif || xmp) writer.write(options.compressed ? 1 : 0, 1);
  if (exif) writer.write(exif.length - 1, options.largeMetadata ? 20 : 10);
  if (xmp) writer.write(xmp.length - 1, options.largeMetadata ? 20 : 10);
  writer.align();

  const miniPayload = Buffer.concat([
    writer.toBuffer(),
    Buffer.from(baseMini.codecConfig),
    ...(icc ? [Buffer.from(icc)] : []),
    Buffer.from(baseMini.itemData),
    ...(exif ? [Buffer.from(exif)] : []),
    ...(xmp ? [Buffer.from(xmp)] : []),
  ]);
  const fileType = box('ftyp', Buffer.concat([Buffer.from('mif3'), u32(0x68656963)]));
  return new Uint8Array(Buffer.concat([fileType, box('mini', miniPayload)]));
}

function fixed(value: number, signed = false): Buffer {
  const numerator = Buffer.alloc(4);
  if (signed) numerator.writeInt32BE(value);
  else numerator.writeUInt32BE(value);
  return Buffer.concat([numerator, u32(1)]);
}

function miniGainMapMetadata(useBaseColorSpace = true): Buffer {
  return Buffer.concat([
    u16(0), // minimum reader version
    u16(0), // writer version
    Buffer.from([useBaseColorSpace ? 0x40 : 0]), // use_base_color_space_flag
    fixed(0), // base_hdr_headroom
    fixed(2), // alternate_hdr_headroom
    fixed(0, true), // gain_map_min
    fixed(1, true), // gain_map_max
    fixed(1), // gain_map_gamma
    fixed(0, true), // base_offset
    fixed(0, true), // alternate_offset
  ]);
}

interface MiniCclvOptions {
  cancel?: boolean;
  persistence?: boolean;
  reserved?: number;
}

function writeMiniHdrProperties(writer: BitWriter, cclv: MiniCclvOptions = {}): void {
  writer.write(63, 6); // CLLI, MDCV, CCLV, AMVE, REVE, NDWT flags
  writer.write(1000, 16);
  writer.write(400, 16);
  for (let i = 0; i < 8; i++) writer.write(i + 1, 16); // MDCV primaries and white point
  writer.write(1000, 32);
  writer.write(1, 32);
  writer.write(cclv.cancel ? 1 : 0, 1); // CCLV cancel
  if (!cclv.cancel) {
    writer.write(cclv.persistence ? 1 : 0, 1); // CCLV persistence
    writer.write(15, 4); // CCLV primaries and all luminance values present
    writer.write(cclv.reserved ?? 0, 2); // CCLV reserved bits
    for (let i = 0; i < 9; i++) writer.write(i, 32); // primaries and luminance values
  }
  writer.write(100, 32); // AMVE illumination
  writer.write(2, 16);
  writer.write(3, 16);
  writer.write(1, 32); // REVE fields
  writer.write(2, 16);
  writer.write(3, 16);
  writer.write(4, 32);
  writer.write(5, 16);
  writer.write(6, 16);
  writer.write(203, 32); // NDWT diffuse white
}

function expectedMiniHdrProperties() {
  return {
    contentLightLevelInfo: { maxContentLightLevel: 1000, maxPicAverageLightLevel: 400 },
    masteringDisplayColourVolume: {
      displayPrimaries: [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
        { x: 5, y: 6 },
      ],
      whitePoint: { x: 7, y: 8 },
      maxDisplayMasteringLuminance: 1000,
      minDisplayMasteringLuminance: 1,
    },
    contentColourVolume: {
      cancelFlag: false,
      persistenceFlag: false,
      primaries: [
        { x: 0, y: 1 },
        { x: 2, y: 3 },
        { x: 4, y: 5 },
      ],
      minLuminanceValue: 6,
      maxLuminanceValue: 7,
      averageLuminanceValue: 8,
    },
    ambientViewingEnvironment: { ambientIlluminance: 100, ambientLightX: 2, ambientLightY: 3 },
    referenceViewingEnvironment: {
      surroundLuminance: 1,
      surroundLightX: 2,
      surroundLightY: 3,
      peripheryLuminance: 4,
      peripheryLightX: 5,
      peripheryLightY: 6,
    },
    nominalDiffuseWhiteLuminance: 203,
  };
}

function miniWithGainMap(options: {
  sameDimensions: boolean;
  gainMapFloatDepthCode?: number;
  includeHdrProperties?: boolean;
  cclv?: MiniCclvOptions;
  toneMappedIcc?: Uint8Array;
  gainMapMetadata?: Uint8Array;
  includeAlpha?: boolean;
  useBaseColorSpace?: boolean;
}): Uint8Array {
  const writer = new BitWriter(),
    metadata = options.gainMapMetadata
      ? Buffer.from(options.gainMapMetadata)
      : miniGainMapMetadata(options.useBaseColorSpace ?? true),
    toneMappedIcc = options.toneMappedIcc ?? null,
    hasAlpha = options.includeAlpha ?? false,
    largeMetadata = Math.max(metadata.length + 1, toneMappedIcc?.length ?? 0) > 1024,
    largeCodecConfig =
      Math.max(baseMini.codecConfig.length, hasAlpha ? alphaCodecConfig.length : 0) > 7,
    largeItemData = Math.max(baseMini.itemData.length, hasAlpha ? alphaItemData.length : 0) > 32768,
    gainMapWidth = options.sameDimensions ? baseMini.width : Math.ceil(baseMini.width / 2),
    gainMapHeight = options.sameDimensions ? baseMini.height : Math.ceil(baseMini.height / 2);
  writer.write(0, 2); // version
  writer.write(0, 1); // explicit_codec_types_flag
  writer.write(0, 1); // float_flag
  writer.write(1, 1); // full_range_flag
  writer.write(hasAlpha ? 1 : 0, 1); // alpha_flag
  writer.write(0, 1); // explicit_cicp_flag
  writer.write(1, 1); // hdr_flag
  writer.write(0, 1); // icc_flag
  writer.write(0, 1); // exif_flag
  writer.write(0, 1); // xmp_flag
  writer.write(1, 2); // main 4:2:0 chroma
  writer.write(baseMini.orientation - 1, 3);
  writer.write(1, 1); // large_dimensions_flag
  writer.write(baseMini.width - 1, 15);
  writer.write(baseMini.height - 1, 15);
  writer.write(0, 1); // main chroma_is_horizontally_centered
  writer.write(0, 1); // main chroma_is_vertically_centered
  writer.write(0, 1); // high_bit_depth_flag
  if (hasAlpha) writer.write(0, 1); // alpha_is_premultiplied
  writer.write(1, 1); // gainmap_flag
  writer.write(options.sameDimensions ? 1 : 0, 1); // gainmap_dimension_same_as_main_item_flag
  if (!options.sameDimensions) {
    writer.write(gainMapWidth - 1, 15);
    writer.write(gainMapHeight - 1, 15);
  }
  writer.write(6, 8); // gainmap_matrix_coefficients
  writer.write(1, 1); // gainmap_full_range_flag
  writer.write(1, 2); // gainmap_chroma_subsampling: 4:2:0
  writer.write(0, 1); // gainmap_chroma_is_horizontally_centered
  writer.write(0, 1); // gainmap_chroma_is_vertically_centered
  writer.write(options.gainMapFloatDepthCode === undefined ? 0 : 1, 1); // gainmap_float_flag
  if (options.gainMapFloatDepthCode === undefined) writer.write(0, 1); // gainmap_high_bit_depth_flag
  else writer.write(options.gainMapFloatDepthCode, 2); // gainmap_bit_depth_log2_minus4
  writer.write(toneMappedIcc ? 1 : 0, 1); // tmap_icc_flag
  writer.write(1, 1); // tmap_explicit_cicp_flag
  writer.write(9, 8); // tmap_colour_primaries
  writer.write(16, 8); // tmap_transfer_characteristics
  writer.write(9, 8); // tmap_matrix_coefficients
  writer.write(1, 1); // tmap_full_range_flag
  if (options.includeHdrProperties) writeMiniHdrProperties(writer, options.cclv);
  else writer.write(0, 6); // main HDR metadata flags
  if (options.includeHdrProperties) writeMiniHdrProperties(writer, options.cclv);
  else writer.write(0, 6); // tone-map HDR metadata flags
  writer.write(largeMetadata ? 1 : 0, 1); // large_metadata_flag
  writer.write(largeCodecConfig ? 1 : 0, 1); // large_codec_config_flag
  writer.write(largeItemData ? 1 : 0, 1); // large_item_data_flag
  if (toneMappedIcc) writer.write(toneMappedIcc.length - 1, largeMetadata ? 20 : 10);
  writer.write(metadata.length, largeMetadata ? 20 : 10);
  writer.write(baseMini.itemData.length, largeItemData ? 28 : 15);
  writer.write(0, largeCodecConfig ? 12 : 3); // reuse main hvcC
  writer.write(baseMini.codecConfig.length, largeCodecConfig ? 12 : 3);
  writer.write(baseMini.itemData.length - 1, largeItemData ? 28 : 15);
  if (hasAlpha) {
    writer.write(alphaItemData.length, largeItemData ? 28 : 15);
    writer.write(alphaCodecConfig.length, largeCodecConfig ? 12 : 3);
  }
  writer.align();

  const miniPayload = Buffer.concat([
    writer.toBuffer(),
    Buffer.from(baseMini.codecConfig),
    ...(hasAlpha ? [Buffer.from(alphaCodecConfig)] : []),
    ...(toneMappedIcc ? [Buffer.from(toneMappedIcc)] : []),
    metadata,
    ...(hasAlpha ? [Buffer.from(alphaItemData)] : []),
    Buffer.from(baseMini.itemData), // gain map item data
    Buffer.from(baseMini.itemData), // main item data
  ]);
  const fileType = box('ftyp', Buffer.concat([Buffer.from('mif3'), u32(0x68656963)]));
  return new Uint8Array(Buffer.concat([fileType, box('mini', miniPayload)]));
}

function bilinearChroma(
  plane: Uint8Array | Uint16Array,
  width: number,
  height: number,
  x: number,
  y: number,
  centeredHorizontally: boolean,
  centeredVertically: boolean,
): number {
  const planeWidth = Math.ceil(width / 2),
    planeHeight = Math.ceil(height / 2),
    sampleX = (x - (centeredHorizontally ? 0.5 : 0)) / 2,
    sampleY = (y - (centeredVertically ? 0.5 : 0)) / 2,
    x0 = Math.floor(sampleX),
    y0 = Math.floor(sampleY),
    fx = sampleX - x0,
    fy = sampleY - y0,
    at = (cx: number, cy: number) =>
      plane[
        Math.max(0, Math.min(planeHeight - 1, cy)) * planeWidth +
          Math.max(0, Math.min(planeWidth - 1, cx))
      ],
    upper = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx,
    lower = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return upper * (1 - fy) + lower * fy;
}

describe('ISO/IEC 23008-12 low-overhead HEVC image', () => {
  it('reads the mif3 codec brand and C71 image properties', () => {
    expect(baseMini.chromaCenteredHorizontally).toBe(false);
    expect(baseMini.chromaCenteredVertically).toBe(false);
    expect(getFtypInfo(input)).toMatchObject({
      majorBrand: 'mif3',
      minorVersion: 0x68656963,
      compatibleBrands: [],
    });
    expect(isHeic(input)).toBe(true);

    const info = getHeicMetadata(input);
    expect(info).toMatchObject({
      primaryItemId: 1,
      primaryItemType: 'hvc1',
      width: 320,
      height: 240,
      bitDepth: 8,
      rotation: 1,
      mirror: null,
      hasAlpha: false,
      color: { primaries: 1, transfer: 13, matrix: 6, fullRange: true },
      hvcC: { chromaFormatIdc: 1, bitDepthLumaMinus8: 0, bitDepthChromaMinus8: 0 },
      chromaSampleLocation: { x: 0, y: 0 },
    });
    expect(info.sliceNalCount).toBeGreaterThan(0);
  });

  it('parses mini CCLV cancellation and persistence flags and ignores reserved bits', () => {
    const parse = (sample: Uint8Array) =>
      parseMiniImage(parseISOBMFF(sample).find((entry) => entry.type === 'mini')!.data, 0x68656963);
    const cancelled = parse(
      miniWithGainMap({ sameDimensions: true, includeHdrProperties: true, cclv: { cancel: true } }),
    );
    expect(cancelled.hdrProperties?.contentColourVolume).toEqual({ cancelFlag: true });
    expect(cancelled.hdrProperties?.ambientViewingEnvironment).toEqual({
      ambientIlluminance: 100,
      ambientLightX: 2,
      ambientLightY: 3,
    });

    const persistent = parse(
      miniWithGainMap({
        sameDimensions: true,
        includeHdrProperties: true,
        cclv: { persistence: true, reserved: 3 },
      }),
    );
    expect(persistent.hdrProperties?.contentColourVolume).toMatchObject({
      cancelFlag: false,
      persistenceFlag: true,
      primaries: [
        { x: 0, y: 1 },
        { x: 2, y: 3 },
        { x: 4, y: 5 },
      ],
      minLuminanceValue: 6,
      maxLuminanceValue: 7,
      averageLuminanceValue: 8,
    });
    expect(persistent.toneMappedHdrProperties?.contentColourVolume).toMatchObject({
      cancelFlag: false,
      persistenceFlag: true,
    });
  });

  it('maps mini chroma-centering flags and upsamples at the signalled sample centers', () => {
    const { width, height } = baseMini;
    for (const [horizontal, vertical] of [
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ] as const) {
      const sample = miniWithChromaCentering(horizontal, vertical),
        boxes = parseISOBMFF(sample),
        info = getHeicInfo(sample, boxes),
        planes = decodeItemPlanes(sample, boxes, info, info.primaryItemId),
        image = decodeHeic(sample, { applyTransforms: false });
      expect(info.chromaSampleLocation).toEqual({
        x: horizontal ? 0.5 : 0,
        y: vertical ? 0.5 : 0,
      });

      const cb = bilinearChroma(planes.cb, width, height, 1, 0, horizontal, vertical) - 128,
        cr = bilinearChroma(planes.cr, width, height, 1, 0, horizontal, vertical) - 128,
        lum = planes.y[1],
        kr = 0.299,
        kb = 0.114,
        red = Math.round(Math.max(0, Math.min(255, lum + 2 * (1 - kr) * cr))),
        green = Math.round(
          Math.max(
            0,
            Math.min(
              255,
              lum -
                ((2 * kb * (1 - kb)) / (1 - kr - kb)) * cb -
                ((2 * kr * (1 - kr)) / (1 - kr - kb)) * cr,
            ),
          ),
        ),
        blue = Math.round(Math.max(0, Math.min(255, lum + 2 * (1 - kb) * cb)));
      expect(Array.from(image.data.subarray(4, 8))).toEqual([red, green, blue, 255]);
    }
  });

  it('rejects floating-point sample signals on HEVC mini images as invalid containers', () => {
    for (const floatDepthCode of [0, 1, 2]) {
      const miniData = parseISOBMFF(miniWithChromaCentering(false, false, floatDepthCode)).find(
        (entry) => entry.type === 'mini',
      )!.data;
      expect(miniParseError(miniData)).toMatchObject({
        code: 'INVALID_CONTAINER',
        message: 'heic: HEVC mini images cannot signal floating-point samples',
      });
    }

    const reservedMiniData = parseISOBMFF(miniWithChromaCentering(false, false, 3)).find(
      (entry) => entry.type === 'mini',
    )!.data;
    expect(() => parseMiniImage(reservedMiniData, 0x68656963)).toThrow(
      'heic: reserved mini float sample depth',
    );

    const validFloatData = parseISOBMFF(miniWithChromaCentering(false, false, 0)).find(
      (entry) => entry.type === 'mini',
    )!.data;
    expect(() =>
      parseMiniImage(validFloatData.subarray(0, validFloatData.length - 1), 0x68656963),
    ).toThrow('heic: mini box chunk exceeds its bounds');
  });

  it('rejects floating-point gain-map signals on HEVC mini images as invalid containers', () => {
    for (const gainMapFloatDepthCode of [0, 1, 2]) {
      const miniData = parseISOBMFF(
        miniWithGainMap({ sameDimensions: true, gainMapFloatDepthCode }),
      ).find((entry) => entry.type === 'mini')!.data;
      expect(miniParseError(miniData)).toMatchObject({
        code: 'INVALID_CONTAINER',
        message: 'heic: integer AVC/HEVC mini gain-map codecs cannot signal floating-point samples',
      });
    }

    const reservedMiniData = parseISOBMFF(
      miniWithGainMap({ sameDimensions: true, gainMapFloatDepthCode: 3 }),
    ).find((entry) => entry.type === 'mini')!.data;
    expect(() => parseMiniImage(reservedMiniData, 0x68656963)).toThrow(
      'heic: reserved mini gain-map float depth',
    );
  });

  it('preserves mini ICC, Exif and XMP payloads and their compression state', () => {
    const icc = new Uint8Array([0x49, 0x43, 0x43, 0x00]),
      exifData = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00]),
      xmpData = new TextEncoder().encode('<x:xmpmeta/>');
    for (const [compressed, largeMetadata] of [
      [false, false],
      [true, true],
    ] as const) {
      const exif = compressed ? new Uint8Array(deflateSync(exifData)) : exifData,
        xmp = compressed ? new Uint8Array(deflateSync(xmpData)) : xmpData,
        sample = miniWithMetadata({ icc, exif, xmp, compressed, largeMetadata }),
        info = getHeicMetadata(sample);
      expect(info.icc).toEqual(icc);
      expect(info.color).toEqual({ primaries: 2, transfer: 2, matrix: 6, fullRange: true });
      expect(info.miniMetadata).toEqual({ exif, xmp, exifXmpCompressed: compressed });
    }
  });

  it('decodes an integer mini gain map through the ISO tone-map path', () => {
    const gainMapInput = miniWithGainMap({ sameDimensions: true, includeHdrProperties: true }),
      boxes = parseISOBMFF(gainMapInput),
      info = getHeicInfo(gainMapInput, boxes),
      tmapInfo = getHeicInfo(gainMapInput, boxes, 3),
      mapInfo = getHeicInfo(gainMapInput, boxes, 4),
      metadataPayload = Buffer.concat([Buffer.from([0]), miniGainMapMetadata()]);
    expect(info).toMatchObject({
      primaryItemId: 1,
      primaryItemType: 'hvc1',
      width: baseMini.width,
      height: baseMini.height,
      derivedItems: [],
      color: { primaries: 1, transfer: 13, matrix: 6, fullRange: true },
      miniGainMap: {
        metadataItemId: 3,
        imageItemId: 4,
        toneMappedColor: { primaries: 9, transfer: 16, matrix: 9, fullRange: true },
      },
      miniHdrProperties: {
        baseImage: expectedMiniHdrProperties(),
        toneMappedImage: expectedMiniHdrProperties(),
      },
    });
    expect(tmapInfo).toMatchObject({
      primaryItemId: 3,
      primaryItemType: 'tmap',
      derivedItems: [1, 4],
      miniHdrProperties: info.miniHdrProperties,
    });
    expect(mapInfo).toMatchObject({
      primaryItemId: 4,
      primaryItemType: 'hvc1',
      width: baseMini.width,
      height: baseMini.height,
      bitDepth: 8,
      chromaSampleLocation: { x: 0, y: 0 },
      miniHdrProperties: info.miniHdrProperties,
    });
    expect(mapInfo.hvcC?.chromaFormatIdc).toBe(1);
    expect(getItemPayload(gainMapInput, boxes, 3)).toEqual(metadataPayload);
    expect(getItemPayload(gainMapInput, boxes, 4)).toEqual(baseMini.itemData);

    const base = decodeHDRSync(input),
      mapped = decodeHDRSync(gainMapInput, { displayHeadroom: 1 }),
      boosted = decodeHDRSync(gainMapInput, { displayHeadroom: 4 });
    expect(decodeHeic(gainMapInput).data).toEqual(decodeHeic(input).data);
    expect(mapped.source).toBe('iso-gainmap');
    expect(mapped.headroom).toBe(1);
    for (let i = 0; i < base.data.length; i++)
      expect(Math.abs(mapped.data[i] - base.data[i])).toBeLessThan(1e-6);
    expect(boosted.headroom).toBe(4);
    expect(boosted.sourceHeadroom).toBe(4);
    expect(boosted.data.some((value, i) => i % 4 !== 3 && value > mapped.data[i])).toBe(true);
    expect([...boosted.data].every(Number.isFinite)).toBe(true);
  });

  it('falls back to the base image when mini gain-map minimum_version is unsupported', () => {
    const metadata = miniGainMapMetadata();
    metadata.writeUInt16BE(1, 0); // minimum_version
    metadata.writeUInt16BE(1, 2); // writer_version >= minimum_version
    const sample = miniWithGainMap({ sameDimensions: true, gainMapMetadata: metadata }),
      baseSdr = decodeHeic(input),
      sampleSdr = decodeHeic(sample),
      baseHdr = decodeHDRSync(input),
      sampleHdr = decodeHDRSync(sample);
    expect(sampleSdr.data).toEqual(baseSdr.data);
    expect(sampleHdr.source).toBe('sdr');
    expect(sampleHdr.headroom).toBe(1);
    expect(sampleHdr.data).toEqual(baseHdr.data);
  });

  it('keeps alpha data when the mini image also has a gain map', () => {
    const gainMapInput = miniWithGainMap({ sameDimensions: true, includeAlpha: true }),
      boxes = parseISOBMFF(gainMapInput),
      info = getHeicInfo(gainMapInput, boxes),
      base = decodeHDRSync(miniWithAlpha()),
      mapped = decodeHDRSync(gainMapInput, { displayHeadroom: 1 });
    expect(getItemPayload(gainMapInput, boxes, 2)).toEqual(alphaItemData);
    expect(mapped.hasAlpha).toBe(true);
    expect(base.hasAlpha).toBe(true);
    expect(info.miniGainMap?.imageItemId).toBe(4);
    expect(mapped.data).toHaveLength(base.data.length);
    for (let i = 0; i < base.data.length; i++)
      expect(Math.abs(mapped.data[i] - base.data[i])).toBeLessThan(1e-6);
  });

  it('uses tone-mapped CICP when gain-map metadata selects the alternate color space', () => {
    const sample = miniWithGainMap({ sameDimensions: true, useBaseColorSpace: false }),
      image = decodeHDRSync(sample, { displayHeadroom: 4 });
    expect(image.source).toBe('iso-gainmap');
    expect(image.headroom).toBe(4);
    expect([...image.data].every(Number.isFinite)).toBe(true);
  });

  it('reads explicit gain-map dimensions in the mini HDR header', () => {
    const sample = miniWithGainMap({ sameDimensions: false }),
      mini = parseMiniImage(
        parseISOBMFF(sample).find((entry) => entry.type === 'mini')!.data,
        0x68656963,
      );
    expect(mini.gainMap).toMatchObject({
      width: Math.ceil(baseMini.width / 2),
      height: Math.ceil(baseMini.height / 2),
      bitDepth: 8,
      chromaFormatIdc: 1,
    });
  });

  it('retains a tone-mapped ICC profile from mini HDR metadata', () => {
    const toneMappedIcc = Uint8Array.from({ length: 1100 }, (_, i) => i & 0xff),
      sample = miniWithGainMap({ sameDimensions: true, toneMappedIcc }),
      boxes = parseISOBMFF(sample),
      info = getHeicMetadata(sample),
      tmapInfo = getHeicInfo(sample, boxes, 3);
    expect(info.miniGainMap?.toneMappedIcc).toEqual(toneMappedIcc);
    expect(tmapInfo.icc).toEqual(toneMappedIcc);
    expect(tmapInfo.color).toEqual({ primaries: 9, transfer: 16, matrix: 9, fullRange: true });
  });

  it('extracts the HEVC item and decodes with the signalled orientation', () => {
    const boxes = parseISOBMFF(input);
    const payload = getItemPayload(input, boxes, 1);
    expect(payload).toBeInstanceOf(Uint8Array);
    expect(payload?.length).toBeGreaterThan(0);

    const info = getHeicInfo(input, boxes);
    const planes = decodeItemPlanes(input, boxes, info, info.primaryItemId);
    const reference = readFileSync(new URL('./fixtures/conformance/mini-C71.yuv', import.meta.url));
    let sampleIndex = 0;
    let mismatches = 0;
    for (const plane of [planes.y, planes.cb, planes.cr])
      for (const sample of plane) if (sample !== reference[sampleIndex++]) mismatches++;
    expect(sampleIndex).toBe(reference.length);
    expect(mismatches).toBe(0);

    const image = decodeHeic(input);
    expect(image).toMatchObject({ width: 240, height: 320, bitDepth: 8, hasAlpha: false });
    expect(image.data).toHaveLength(240 * 320 * 4);

    const untransformed = decodeHeic(input, { applyTransforms: false });
    expect(untransformed).toMatchObject({ width: 320, height: 240 });
  });

  it('decodes a mini HEVC alpha item and composites it with the primary image', () => {
    const alphaInput = miniWithAlpha();
    const boxes = parseISOBMFF(alphaInput);
    const info = getHeicInfo(alphaInput, boxes);

    expect(isHeic(alphaInput)).toBe(true);
    expect(info).toMatchObject({
      primaryItemId: 1,
      hasAlpha: true,
      alphaItemId: 2,
      premultipliedAlpha: false,
    });
    expect(info.auxiliaryImages).toEqual([
      { itemId: 2, type: 'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha' },
    ]);
    expect(getItemPayload(alphaInput, boxes, 1)).toEqual(baseMini.itemData);
    expect(getItemPayload(alphaInput, boxes, 2)).toEqual(alphaItemData);
    expect(getHeicInfo(alphaInput, boxes, 2).hvcC?.chromaFormatIdc).toBe(0);

    const alpha = decodeItemPlanes(alphaInput, boxes, info, 2);
    expect([alpha.width, alpha.height, alpha.chromaFormatIdc]).toEqual([128, 128, 0]);
    expect(alpha.y).toEqual(alphaReference);
    expect(alpha.cb).toHaveLength(0);
    expect(alpha.cr).toHaveLength(0);
    const auxiliaryPlanes = decodeHeicAuxiliaryPlanes(alphaInput);
    expect(auxiliaryPlanes).toHaveLength(1);
    expect(auxiliaryPlanes[0].type).toBe('urn:mpeg:mpegB:cicp:systems:auxiliary:alpha');
    expect(auxiliaryPlanes[0].y).toEqual(alphaReference);

    const image = decodeHeic(alphaInput, { applyTransforms: false });
    expect(image).toMatchObject({ width: 320, height: 240, hasAlpha: true });
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++) {
        const alphaSample =
          alphaReference[
            Math.floor((y * alpha.height) / image.height) * alpha.width +
              Math.floor((x * alpha.width) / image.width)
          ];
        expect(image.data[(y * image.width + x) * 4 + 3]).toBe(alphaSample);
      }
  });

  it('expands an explicit uncompressed yv20 mini item to the ordinary HEIF decode path', () => {
    const payload = Buffer.from([16, 64, 128, 235, 200, 50]),
      miniInput = miniWithYv20(payload),
      regularInput = buildRegularHeif(
        [
          {
            id: 1,
            type: 'unci',
            data: payload,
            properties: [
              fullHeif('ispe', 0, u32(2), u32(2)),
              fullHeif('uncC', 1, Buffer.from('yv20')),
            ],
          },
        ],
        1,
      ),
      boxes = parseISOBMFF(miniInput),
      info = getHeicInfo(miniInput, boxes),
      miniImage = decodeHeic(miniInput, { applyTransforms: false }),
      regularImage = decodeHeic(regularInput, { applyTransforms: false });

    expect(getFtypInfo(miniInput)?.minorVersion).toBe(0);
    expect(isHeic(miniInput)).toBe(true);
    expect(info).toMatchObject({
      primaryItemType: 'unci',
      width: 2,
      height: 2,
      bitDepth: 8,
      uncompressedImage: {
        chromaFormatIdc: 1,
        colorModel: 'yuv',
        samplingType: 2,
        interleaveType: 0,
      },
    });
    expect(getItemPayload(miniInput, boxes, 1)).toEqual(payload);
    expect([...miniImage.data]).toEqual([...regularImage.data]);
  });

  it('reads mini items when mif3 is compatible or minor_version names the expanded brand', () => {
    const payload = Buffer.from([16, 64, 128, 235, 200, 50]),
      majorMif3 = miniWithYv20(payload),
      compatibleMif3 = withMiniFileType(majorMif3, 'mif1', 0, ['mif3']),
      expandedBrand = withMiniFileType(majorMif3, 'mif3', 0x6d696631, []);

    for (const miniFile of [compatibleMif3, expandedBrand]) {
      expect(isHeic(miniFile)).toBe(true);
      expect(getHeicInfo(miniFile, parseISOBMFF(miniFile))).toMatchObject({
        primaryItemType: 'unci',
        width: 2,
        height: 2,
        bitDepth: 8,
      });
      expect([...decodeHeic(miniFile, { applyTransforms: false }).data]).toEqual([
        ...decodeHeic(majorMif3, { applyTransforms: false }).data,
      ]);
    }
  });

  it('decodes an uncompressed yv20 mini gain map through the ISO tone-map path', () => {
    const mainPayload = Buffer.from([16, 64, 128, 235, 200, 50]),
      gainMapPayload = Buffer.from([235, 235, 235, 235, 128, 128]),
      gainMapInput = miniWithYv20GainMap(mainPayload, gainMapPayload),
      boxes = parseISOBMFF(gainMapInput),
      info = getHeicInfo(gainMapInput, boxes),
      mapInfo = getHeicInfo(gainMapInput, boxes, 4);

    expect(info).toMatchObject({
      primaryItemType: 'unci',
      miniGainMap: { metadataItemId: 3, imageItemId: 4 },
      uncompressedImage: { samplingType: 2, interleaveType: 0, colorModel: 'yuv' },
    });
    expect(mapInfo).toMatchObject({
      primaryItemId: 4,
      primaryItemType: 'unci',
      width: 2,
      height: 2,
      uncompressedImage: { samplingType: 2, interleaveType: 0, colorModel: 'yuv' },
    });
    expect(getItemPayload(gainMapInput, boxes, 3)).toEqual(
      Buffer.concat([Buffer.from([0]), miniGainMapMetadata()]),
    );
    expect(getItemPayload(gainMapInput, boxes, 4)).toEqual(gainMapPayload);

    const mapped = decodeHDRSync(gainMapInput, { displayHeadroom: 1 }),
      boosted = decodeHDRSync(gainMapInput, { displayHeadroom: 4 });
    expect(mapped.source).toBe('iso-gainmap');
    expect(boosted.sourceHeadroom).toBe(4);
    expect(boosted.data.some((value, index) => index % 4 !== 3 && value > mapped.data[index])).toBe(
      true,
    );
    expect([...boosted.data].every(Number.isFinite)).toBe(true);
  });
});
