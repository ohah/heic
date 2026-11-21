import { HeicError } from '../errors.js';
import type {
  HevcAmbientViewingEnvironment,
  HevcContentLightLevelInfo,
  HevcMasteringDisplayColourVolume,
} from '../hevc/sei.js';
import type { ISOBMFFBox } from './heif.js';

export interface ReferenceViewingEnvironment {
  /** Coded luminance in units of 0.0001 cd/m². */
  surroundLuminance: number;
  /** Coded CIE 1931 x/y chromaticity in units of 0.0001. */
  surroundLightX: number;
  surroundLightY: number;
  /** Coded luminance in units of 0.0001 cd/m². */
  peripheryLuminance: number;
  /** Coded CIE 1931 x/y chromaticity in units of 0.0001. */
  peripheryLightX: number;
  peripheryLightY: number;
}

/** Descriptive HDR metadata carried by ISO/IEC 23008-12 image item properties. */
export interface HeifHdrItemProperties {
  contentLightLevelInfo?: HevcContentLightLevelInfo;
  masteringDisplayColourVolume?: HevcMasteringDisplayColourVolume;
  contentColourVolume?: HeifContentColourVolume;
  ambientViewingEnvironment?: HevcAmbientViewingEnvironment;
  referenceViewingEnvironment?: ReferenceViewingEnvironment;
  /** Diffuse-white luminance in units of 0.0001 cd/m². */
  nominalDiffuseWhiteLuminance?: number;
}

export interface HeifContentColourVolume {
  /** Mini CCLV flag: cancels any persistent content-colour-volume metadata. */
  cancelFlag?: boolean;
  /** Mini CCLV flag: applies this metadata beyond the current decoded picture. */
  persistenceFlag?: boolean;
  /** Coded primary order; coordinates use 0.00002 units. */
  primaries?: readonly [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];
  /** Coded normalized luminance values in units of 0.0000001. */
  minLuminanceValue?: number;
  maxLuminanceValue?: number;
  averageLuminanceValue?: number;
}

function invalid(message: string): never {
  throw new HeicError('INVALID_CONTAINER', `heic: ${message}`);
}

function u16(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > data.length) invalid('truncated HDR item property');
  return (data[offset] << 8) | data[offset + 1];
}

function u32(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > data.length) invalid('truncated HDR item property');
  return (
    data[offset] * 0x1000000 + (data[offset + 1] << 16) + (data[offset + 2] << 8) + data[offset + 3]
  );
}

function readFullProperty(data: Uint8Array, type: string, fieldLength: number): Uint8Array {
  if (data.length !== fieldLength + 4) invalid(`invalid ${type} HDR item property size`);
  if (data[0] !== 0 || data[1] !== 0 || data[2] !== 0 || data[3] !== 0)
    invalid(`invalid ${type} HDR item property full-box header`);
  return data.subarray(4);
}

function parseContentColourVolume(data: Uint8Array): HeifContentColourVolume {
  if (!data.length) invalid('truncated cclv HDR item property');
  const flags = data[0];
  if (flags & 0xc3) invalid('non-zero reserved bits in cclv HDR item property');
  const primariesPresent = (flags & 0x20) !== 0;
  const minPresent = (flags & 0x10) !== 0;
  const maxPresent = (flags & 0x08) !== 0;
  const averagePresent = (flags & 0x04) !== 0;
  if (!primariesPresent && !minPresent && !maxPresent && !averagePresent)
    invalid('cclv HDR item property has no values');
  const expectedSize =
    1 +
    (primariesPresent ? 24 : 0) +
    (minPresent ? 4 : 0) +
    (maxPresent ? 4 : 0) +
    (averagePresent ? 4 : 0);
  if (data.length !== expectedSize) invalid('invalid cclv HDR item property size');

  let offset = 1;
  const output: HeifContentColourVolume = {};
  if (primariesPresent) {
    const primaries = [0, 1, 2].map(() => {
      const x = u32(data, offset) | 0;
      const y = u32(data, offset + 4) | 0;
      offset += 8;
      return { x, y };
    }) as unknown as NonNullable<HeifContentColourVolume['primaries']>;
    if (
      primaries.some(
        ({ x, y }) => x < -5_000_000 || x > 5_000_000 || y < -5_000_000 || y > 5_000_000,
      )
    )
      invalid('cclv primary is out of range');
    output.primaries = primaries;
  }
  if (minPresent) {
    output.minLuminanceValue = u32(data, offset);
    offset += 4;
  }
  if (maxPresent) {
    output.maxLuminanceValue = u32(data, offset);
    offset += 4;
  }
  if (averagePresent) output.averageLuminanceValue = u32(data, offset);
  return output;
}

function parseProperty(type: string, data: Uint8Array, output: HeifHdrItemProperties): void {
  if (type === 'clli') {
    if (data.length !== 4) invalid('invalid clli HDR item property size');
    output.contentLightLevelInfo = {
      maxContentLightLevel: u16(data, 0),
      maxPicAverageLightLevel: u16(data, 2),
    };
  } else if (type === 'mdcv') {
    if (data.length !== 24) invalid('invalid mdcv HDR item property size');
    output.masteringDisplayColourVolume = {
      displayPrimaries: [0, 1, 2].map((index) => ({
        x: u16(data, index * 4),
        y: u16(data, index * 4 + 2),
      })) as unknown as HevcMasteringDisplayColourVolume['displayPrimaries'],
      whitePoint: { x: u16(data, 12), y: u16(data, 14) },
      maxDisplayMasteringLuminance: u32(data, 16),
      minDisplayMasteringLuminance: u32(data, 20),
    };
  } else if (type === 'cclv') {
    output.contentColourVolume = parseContentColourVolume(data);
  } else if (type === 'amve') {
    if (data.length !== 8) invalid('invalid amve HDR item property size');
    const ambientIlluminance = u32(data, 0),
      ambientLightX = u16(data, 4),
      ambientLightY = u16(data, 6);
    if (ambientIlluminance === 0) invalid('amve ambient_illuminance shall not be zero');
    if (ambientLightX > 50_000 || ambientLightY > 50_000)
      invalid('amve chromaticity is out of range');
    output.ambientViewingEnvironment = { ambientIlluminance, ambientLightX, ambientLightY };
  } else if (type === 'reve') {
    const fields = readFullProperty(data, type, 16);
    const referenceViewingEnvironment = {
      surroundLuminance: u32(fields, 0),
      surroundLightX: u16(fields, 4),
      surroundLightY: u16(fields, 6),
      peripheryLuminance: u32(fields, 8),
      peripheryLightX: u16(fields, 12),
      peripheryLightY: u16(fields, 14),
    };
    if (
      referenceViewingEnvironment.surroundLightX > 10_000 ||
      referenceViewingEnvironment.surroundLightY > 10_000 ||
      referenceViewingEnvironment.peripheryLightX > 10_000 ||
      referenceViewingEnvironment.peripheryLightY > 10_000
    )
      invalid('reve chromaticity is out of range');
    output.referenceViewingEnvironment = referenceViewingEnvironment;
  } else if (type === 'ndwt') {
    output.nominalDiffuseWhiteLuminance = u32(readFullProperty(data, type, 4), 0);
  }
}

/** Parse optional HDR descriptive item properties associated with one HEIF item. */
export function parseHeifHdrItemProperties(
  properties: readonly ISOBMFFBox[],
): HeifHdrItemProperties | undefined {
  const hdrProperties = properties.filter(({ type }) =>
    ['clli', 'mdcv', 'cclv', 'amve', 'reve', 'ndwt'].includes(type),
  );
  if (!hdrProperties.length) return undefined;

  const counts = new Map<string, number>();
  const output: HeifHdrItemProperties = {};
  for (const property of hdrProperties) {
    const count = (counts.get(property.type) ?? 0) + 1;
    counts.set(property.type, count);
    if (count > 1) invalid(`duplicate ${property.type} HDR item properties`);
    parseProperty(property.type, property.data, output);
  }
  return output;
}
