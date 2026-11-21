import { HeicError } from '../errors.js';
import { isHeifHevcBitDepth } from '../bit-depth.js';
import type {
  HeifContentColourVolume,
  HeifHdrItemProperties,
  ReferenceViewingEnvironment,
} from './heif-hdr.js';
import type {
  HevcAmbientViewingEnvironment,
  HevcContentLightLevelInfo,
  HevcMasteringDisplayColourVolume,
} from '../hevc/sei.js';

export interface MiniImage {
  itemType: string;
  codecConfigType: string;
  width: number;
  height: number;
  bitDepth: number;
  chromaFormatIdc: number;
  chromaCenteredHorizontally: boolean;
  chromaCenteredVertically: boolean;
  orientation: number;
  rotation: number;
  mirror: number | null;
  color: { primaries: number; transfer: number; matrix: number; fullRange: boolean };
  codecConfig: Uint8Array;
  itemData: Uint8Array;
  iccData: Uint8Array | null;
  exifData: Uint8Array | null;
  xmpData: Uint8Array | null;
  exifXmpCompressed: boolean;
  alphaCodecConfig: Uint8Array | null;
  alphaItemData: Uint8Array | null;
  premultipliedAlpha: boolean;
  gainMap: MiniGainMap | null;
  gainMapMetadata: Uint8Array | null;
  hdrProperties: HeifHdrItemProperties | undefined;
  toneMappedHdrProperties: HeifHdrItemProperties | undefined;
  toneMappedColor: {
    primaries: number;
    transfer: number;
    matrix: number;
    fullRange: boolean;
  } | null;
  toneMappedIccData: Uint8Array | null;
}

export interface MiniGainMap {
  width: number;
  height: number;
  bitDepth: number;
  chromaFormatIdc: number;
  chromaCenteredHorizontally: boolean;
  chromaCenteredVertically: boolean;
  matrix: number;
  fullRange: boolean;
  codecConfig: Uint8Array;
  itemData: Uint8Array;
}

class MiniBitReader {
  private bitOffset = 0;

  constructor(private readonly data: Uint8Array) {}

  readBits(count: number): number {
    if (
      !Number.isInteger(count) ||
      count < 0 ||
      count > 32 ||
      this.bitOffset + count > this.data.length * 8
    )
      throw new HeicError('INVALID_CONTAINER', 'heic: truncated mini box');
    let value = 0;
    for (let i = 0; i < count; i++) {
      const byte = this.data[this.bitOffset >> 3];
      value = value * 2 + ((byte >> (7 - (this.bitOffset & 7))) & 1);
      this.bitOffset++;
    }
    return value;
  }

  readFlag(): boolean {
    return this.readBits(1) !== 0;
  }

  skipBits(count: number): void {
    if (!Number.isInteger(count) || count < 0)
      throw new HeicError('INVALID_CONTAINER', 'heic: invalid mini bit range');
    while (count > 0) {
      const chunk = Math.min(32, count);
      this.readBits(chunk);
      count -= chunk;
    }
  }

  readFourCC(): string {
    return String.fromCharCode(...Array.from({ length: 4 }, () => this.readBits(8)));
  }

  alignToByte(): void {
    this.bitOffset = (this.bitOffset + 7) & ~7;
    if (this.bitOffset > this.data.length * 8)
      throw new HeicError('INVALID_CONTAINER', 'heic: truncated mini box');
  }

  readBytes(length: number): Uint8Array {
    if (!Number.isSafeInteger(length) || length < 0 || this.bitOffset & 7)
      throw new HeicError('INVALID_CONTAINER', 'heic: invalid mini box byte range');
    const start = this.bitOffset >> 3;
    const end = start + length;
    if (!Number.isSafeInteger(end) || end > this.data.length)
      throw new HeicError('INVALID_CONTAINER', 'heic: mini box chunk exceeds its bounds');
    this.bitOffset = end * 8;
    return this.data.subarray(start, end);
  }

  get hasRemainingBytes(): boolean {
    return this.bitOffset !== this.data.length * 8;
  }
}

function parseMiniHdrProperties(bits: MiniBitReader): HeifHdrItemProperties | undefined {
  const clli = bits.readFlag();
  const mdcv = bits.readFlag();
  const cclv = bits.readFlag();
  const amve = bits.readFlag();
  const reve = bits.readFlag();
  const ndwt = bits.readFlag();
  if (!clli && !mdcv && !cclv && !amve && !reve && !ndwt) return undefined;

  const output: HeifHdrItemProperties = {};
  if (clli) {
    const contentLightLevelInfo: HevcContentLightLevelInfo = {
      maxContentLightLevel: bits.readBits(16),
      maxPicAverageLightLevel: bits.readBits(16),
    };
    output.contentLightLevelInfo = contentLightLevelInfo;
  }
  if (mdcv) {
    const masteringDisplayColourVolume: HevcMasteringDisplayColourVolume = {
      displayPrimaries: [0, 1, 2].map(() => ({
        x: bits.readBits(16),
        y: bits.readBits(16),
      })) as unknown as HevcMasteringDisplayColourVolume['displayPrimaries'],
      whitePoint: { x: bits.readBits(16), y: bits.readBits(16) },
      maxDisplayMasteringLuminance: bits.readBits(32),
      minDisplayMasteringLuminance: bits.readBits(32),
    };
    output.masteringDisplayColourVolume = masteringDisplayColourVolume;
  }
  if (cclv) {
    const contentColourVolume: HeifContentColourVolume = {};
    contentColourVolume.cancelFlag = bits.readFlag();
    if (!contentColourVolume.cancelFlag) {
      contentColourVolume.persistenceFlag = bits.readFlag();
      const primaries = bits.readFlag();
      const minLuminance = bits.readFlag();
      const maxLuminance = bits.readFlag();
      const averageLuminance = bits.readFlag();
      // H.274 says decoders ignore these reserved bits, including values
      // reserved for future versions.
      bits.readBits(2);
      if (!primaries && !minLuminance && !maxLuminance && !averageLuminance)
        throw new HeicError('INVALID_CONTAINER', 'heic: mini cclv has no values');
      if (primaries) {
        const values = [0, 1, 2].map(() => ({
          x: bits.readBits(32) | 0,
          y: bits.readBits(32) | 0,
        })) as unknown as NonNullable<HeifContentColourVolume['primaries']>;
        if (
          values.some(
            ({ x, y }) => x < -5_000_000 || x > 5_000_000 || y < -5_000_000 || y > 5_000_000,
          )
        )
          throw new HeicError('INVALID_CONTAINER', 'heic: mini cclv primary is out of range');
        contentColourVolume.primaries = values;
      }
      if (minLuminance) contentColourVolume.minLuminanceValue = bits.readBits(32);
      if (maxLuminance) contentColourVolume.maxLuminanceValue = bits.readBits(32);
      if (averageLuminance) contentColourVolume.averageLuminanceValue = bits.readBits(32);
    }
    output.contentColourVolume = contentColourVolume;
  }
  if (amve) {
    const ambientViewingEnvironment: HevcAmbientViewingEnvironment = {
      ambientIlluminance: bits.readBits(32),
      ambientLightX: bits.readBits(16),
      ambientLightY: bits.readBits(16),
    };
    if (ambientViewingEnvironment.ambientIlluminance === 0)
      throw new HeicError(
        'INVALID_CONTAINER',
        'heic: mini amve ambient_illuminance shall not be zero',
      );
    if (
      ambientViewingEnvironment.ambientLightX > 50_000 ||
      ambientViewingEnvironment.ambientLightY > 50_000
    )
      throw new HeicError('INVALID_CONTAINER', 'heic: mini amve chromaticity is out of range');
    output.ambientViewingEnvironment = ambientViewingEnvironment;
  }
  if (reve) {
    const referenceViewingEnvironment: ReferenceViewingEnvironment = {
      surroundLuminance: bits.readBits(32),
      surroundLightX: bits.readBits(16),
      surroundLightY: bits.readBits(16),
      peripheryLuminance: bits.readBits(32),
      peripheryLightX: bits.readBits(16),
      peripheryLightY: bits.readBits(16),
    };
    if (
      referenceViewingEnvironment.surroundLightX > 10_000 ||
      referenceViewingEnvironment.surroundLightY > 10_000 ||
      referenceViewingEnvironment.peripheryLightX > 10_000 ||
      referenceViewingEnvironment.peripheryLightY > 10_000
    )
      throw new HeicError('INVALID_CONTAINER', 'heic: mini reve chromaticity is out of range');
    output.referenceViewingEnvironment = referenceViewingEnvironment;
  }
  if (ndwt) output.nominalDiffuseWhiteLuminance = bits.readBits(32);
  return output;
}

function fourCC(value: number): string {
  return String.fromCharCode(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function orientationTransforms(orientation: number): { rotation: number; mirror: number | null } {
  // Annex O uses the eight EXIF/TIFF orientation values. These map to the
  // HEIF irot (counter-clockwise) and imir (vertical-axis) operations.
  switch (orientation) {
    case 1:
      return { rotation: 0, mirror: null };
    case 2:
      return { rotation: 0, mirror: 0 };
    case 3:
      return { rotation: 2, mirror: null };
    case 4:
      return { rotation: 2, mirror: 0 };
    case 5:
      return { rotation: 3, mirror: 0 };
    case 6:
      return { rotation: 3, mirror: null };
    case 7:
      return { rotation: 1, mirror: 0 };
    case 8:
      return { rotation: 1, mirror: null };
    default:
      throw new HeicError('INVALID_CONTAINER', 'heic: invalid mini orientation');
  }
}

/** Parse the supported still-image subset of ISO/IEC 23008-12 Annex O `mini`. */
export function parseMiniImage(data: Uint8Array, minorVersion: number): MiniImage {
  const bits = new MiniBitReader(data);
  const version = bits.readBits(2);
  const explicitCodecTypes = bits.readFlag();
  const floatSamples = bits.readFlag();
  const fullRange = bits.readFlag();
  const hasAlpha = bits.readFlag();
  const explicitCicp = bits.readFlag();
  const hasHdr = bits.readFlag();
  const hasIcc = bits.readFlag();
  const hasExif = bits.readFlag();
  const hasXmp = bits.readFlag();
  const chromaFormatIdc = bits.readBits(2);
  const orientation = bits.readBits(3) + 1;

  if (version !== 0)
    throw new HeicError('UNSUPPORTED_FEATURE', `heic: unsupported mini version ${version}`);

  const largeDimensions = bits.readFlag();
  const dimensionBits = largeDimensions ? 15 : 7;
  const width = bits.readBits(dimensionBits) + 1;
  const height = bits.readBits(dimensionBits) + 1;
  if (!Number.isSafeInteger(width * height))
    throw new HeicError('RESOURCE_LIMIT', 'heic: mini image dimensions are too large');

  const chromaCenteredHorizontally =
    chromaFormatIdc === 1 || chromaFormatIdc === 2 ? bits.readFlag() : false;
  const chromaCenteredVertically = chromaFormatIdc === 1 ? bits.readFlag() : false;
  let bitDepth: number;
  if (floatSamples) {
    const floatBitDepthLog2Minus4 = bits.readBits(2);
    if (floatBitDepthLog2Minus4 === 3)
      throw new HeicError('INVALID_CONTAINER', 'heic: reserved mini float sample depth');
    bitDepth = 2 ** (floatBitDepthLog2Minus4 + 4);
  } else {
    const highBitDepth = bits.readFlag();
    bitDepth = highBitDepth ? bits.readBits(3) + 9 : 8;
  }
  const premultipliedAlpha = hasAlpha ? bits.readFlag() : false;

  let primaries = hasIcc ? 2 : 1;
  let transfer = hasIcc ? 2 : 13;
  let matrix = chromaFormatIdc === 0 ? 2 : 6;
  if (explicitCicp) {
    primaries = bits.readBits(8);
    transfer = bits.readBits(8);
    matrix = bits.readBits(8);
  }

  let itemType: string;
  let codecConfigType: string;
  if (explicitCodecTypes) {
    itemType = bits.readFourCC();
    codecConfigType = bits.readFourCC();
  } else {
    const codecBrand = fourCC(minorVersion);
    if (codecBrand === 'heic' || codecBrand === 'heix') {
      itemType = 'hvc1';
      codecConfigType = 'hvcC';
    } else if (codecBrand === 'avic') {
      itemType = 'avc1';
      codecConfigType = 'avcC';
    } else {
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        `heic: unsupported mini codec brand ${codecBrand}`,
      );
    }
  }

  let gainMapProperties: Omit<MiniGainMap, 'codecConfig' | 'itemData'> | null = null;
  let gainMapFloatSamples = false;
  let toneMappedColor: MiniImage['toneMappedColor'] = null;
  let hasToneMappedIcc = false;
  let hdrProperties: HeifHdrItemProperties | undefined;
  let toneMappedHdrProperties: HeifHdrItemProperties | undefined;
  if (hasHdr) {
    const hasGainMap = bits.readFlag();
    if (hasGainMap) {
      const sameDimensions = bits.readFlag();
      const gainMapWidth = sameDimensions ? width : bits.readBits(dimensionBits) + 1;
      const gainMapHeight = sameDimensions ? height : bits.readBits(dimensionBits) + 1;
      const gainMapMatrix = bits.readBits(8);
      const gainMapFullRange = bits.readFlag();
      const gainMapChromaFormatIdc = bits.readBits(2);
      const gainMapChromaCenteredHorizontally =
        gainMapChromaFormatIdc === 1 || gainMapChromaFormatIdc === 2 ? bits.readFlag() : false;
      const gainMapChromaCenteredVertically =
        gainMapChromaFormatIdc === 1 ? bits.readFlag() : false;
      const gainMapFloat = bits.readFlag();
      let gainMapBitDepth: number;
      if (gainMapFloat) {
        const floatBitDepthLog2Minus4 = bits.readBits(2);
        if (floatBitDepthLog2Minus4 === 3)
          throw new HeicError('INVALID_CONTAINER', 'heic: reserved mini gain-map float depth');
        gainMapBitDepth = 2 ** (floatBitDepthLog2Minus4 + 4);
        gainMapFloatSamples = true;
      } else {
        const gainMapHighBitDepth = bits.readFlag();
        gainMapBitDepth = gainMapHighBitDepth ? bits.readBits(3) + 9 : 8;
      }
      if (!gainMapFloat && !isHeifHevcBitDepth(gainMapBitDepth))
        throw new HeicError(
          'UNSUPPORTED_FEATURE',
          `heic: unsupported mini gain-map bit depth ${gainMapBitDepth}`,
        );
      hasToneMappedIcc = bits.readFlag();
      const toneMappedExplicitCicp = bits.readFlag();
      toneMappedColor = toneMappedExplicitCicp
        ? {
            primaries: bits.readBits(8),
            transfer: bits.readBits(8),
            matrix: bits.readBits(8),
            fullRange: bits.readFlag(),
          }
        : { primaries: 1, transfer: 13, matrix: 6, fullRange: true };
      gainMapProperties = {
        width: gainMapWidth,
        height: gainMapHeight,
        bitDepth: gainMapBitDepth,
        chromaFormatIdc: gainMapChromaFormatIdc,
        chromaCenteredHorizontally: gainMapChromaCenteredHorizontally,
        chromaCenteredVertically: gainMapChromaCenteredVertically,
        matrix: gainMapMatrix,
        fullRange: gainMapFullRange,
      };
    }
    hdrProperties = parseMiniHdrProperties(bits);
    if (hasGainMap) toneMappedHdrProperties = parseMiniHdrProperties(bits);
  }

  const isHevc = itemType === 'hvc1' && codecConfigType === 'hvcC';
  const isAvc = itemType === 'avc1' && codecConfigType === 'avcC';
  const isUncompressed = itemType === 'unci' && codecConfigType === 'uncC';
  if (!isHevc && !isAvc && !isUncompressed)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      `heic: unsupported mini item codec/configuration ${itemType}/${codecConfigType}`,
    );
  if (isHevc && !floatSamples && !isHeifHevcBitDepth(bitDepth))
    throw new HeicError('UNSUPPORTED_FEATURE', `heic: unsupported mini bit depth ${bitDepth}`);
  if (isAvc && (floatSamples || bitDepth !== 8 || chromaFormatIdc !== 1))
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: mini AVC decoding supports only integer 8-bit 4:2:0 images',
    );
  if (isUncompressed && (floatSamples || hasAlpha || gainMapFloatSamples))
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: mini uncompressed decoding supports only integer samples without separate alpha items or floating-point gain maps',
    );
  if (
    isAvc &&
    gainMapProperties &&
    !gainMapFloatSamples &&
    (gainMapProperties.bitDepth !== 8 || gainMapProperties.chromaFormatIdc !== 1)
  )
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: mini AVC gain maps support only integer 8-bit 4:2:0 images',
    );
  const hasMetadata = hasIcc || hasExif || hasXmp || gainMapProperties !== null;
  const largeMetadata = hasMetadata ? bits.readFlag() : false;
  const largeCodecConfig = bits.readFlag();
  const largeItemData = bits.readFlag();
  const iccDataSize = hasIcc ? bits.readBits(largeMetadata ? 20 : 10) + 1 : 0;
  const toneMappedIccDataSize = hasToneMappedIcc ? bits.readBits(largeMetadata ? 20 : 10) + 1 : 0;
  const gainMapMetadataSize = gainMapProperties ? bits.readBits(largeMetadata ? 20 : 10) : 0;
  const gainMapItemDataSize = gainMapProperties ? bits.readBits(largeItemData ? 28 : 15) : 0;
  const gainMapCodecConfigSize =
    gainMapProperties && gainMapItemDataSize > 0 ? bits.readBits(largeCodecConfig ? 12 : 3) : 0;
  const codecConfigSize = bits.readBits(largeCodecConfig ? 12 : 3);
  const itemDataSize = bits.readBits(largeItemData ? 28 : 15) + 1;
  const alphaItemDataSize = hasAlpha ? bits.readBits(largeItemData ? 28 : 15) : 0;
  const alphaCodecConfigSize =
    hasAlpha && alphaItemDataSize > 0 ? bits.readBits(largeCodecConfig ? 12 : 3) : 0;
  const exifXmpCompressed = hasExif || hasXmp ? bits.readFlag() : false;
  const exifDataSize = hasExif ? bits.readBits(largeMetadata ? 20 : 10) + 1 : 0;
  const xmpDataSize = hasXmp ? bits.readBits(largeMetadata ? 20 : 10) + 1 : 0;
  bits.alignToByte();
  const codecConfig = bits.readBytes(codecConfigSize);
  const alphaCodecConfig =
    hasAlpha && alphaItemDataSize > 0
      ? alphaCodecConfigSize > 0
        ? bits.readBytes(alphaCodecConfigSize)
        : codecConfig
      : null;
  const gainMapCodecConfig =
    gainMapProperties && gainMapItemDataSize > 0
      ? gainMapCodecConfigSize > 0
        ? bits.readBytes(gainMapCodecConfigSize)
        : codecConfig
      : null;
  const iccData = hasIcc ? bits.readBytes(iccDataSize) : null;
  const toneMappedIccData = hasToneMappedIcc ? bits.readBytes(toneMappedIccDataSize) : null;
  const gainMapMetadata = gainMapProperties ? bits.readBytes(gainMapMetadataSize) : null;
  const alphaItemData = alphaItemDataSize > 0 ? bits.readBytes(alphaItemDataSize) : null;
  const gainMapItemData = gainMapItemDataSize > 0 ? bits.readBytes(gainMapItemDataSize) : null;
  const itemData = bits.readBytes(itemDataSize);
  const exifData = hasExif ? bits.readBytes(exifDataSize) : null;
  const xmpData = hasXmp ? bits.readBytes(xmpDataSize) : null;
  if (gainMapProperties && (!gainMapCodecConfig || !gainMapItemData || !gainMapMetadata?.length))
    throw new HeicError(
      'INVALID_CONTAINER',
      'heic: mini gain map is missing coded data or metadata',
    );
  if (bits.hasRemainingBytes)
    throw new HeicError('INVALID_CONTAINER', 'heic: trailing bytes in mini box');

  if (floatSamples && isHevc)
    throw new HeicError(
      'INVALID_CONTAINER',
      'heic: HEVC mini images cannot signal floating-point samples',
    );
  if (gainMapFloatSamples && !isUncompressed)
    throw new HeicError(
      'INVALID_CONTAINER',
      'heic: integer AVC/HEVC mini gain-map codecs cannot signal floating-point samples',
    );

  const expected = orientationTransforms(orientation);
  return {
    itemType,
    codecConfigType,
    width,
    height,
    bitDepth,
    chromaFormatIdc,
    chromaCenteredHorizontally,
    chromaCenteredVertically,
    orientation,
    ...expected,
    color: { primaries, transfer, matrix, fullRange },
    codecConfig,
    itemData,
    iccData,
    exifData,
    xmpData,
    exifXmpCompressed,
    alphaCodecConfig,
    alphaItemData,
    premultipliedAlpha,
    gainMap:
      gainMapProperties && gainMapCodecConfig && gainMapItemData
        ? { ...gainMapProperties, codecConfig: gainMapCodecConfig, itemData: gainMapItemData }
        : null,
    gainMapMetadata,
    hdrProperties,
    toneMappedHdrProperties,
    toneMappedColor,
    toneMappedIccData,
  };
}
