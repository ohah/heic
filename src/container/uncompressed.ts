import { HeicError } from '../errors.js';
import type { ISOBMFFBox } from './heif.js';
import {
  parseGenericCompressionConfiguration,
  type GenericCompressionConfiguration,
} from './generic-compression.js';

export interface UncompressedComponent {
  componentIndex: number;
  componentType: number;
  bitDepth: number;
  componentFormat: number;
  componentAlignSize: number;
}

export interface UncompressedImageConfiguration {
  width: number;
  height: number;
  bitDepth: number;
  bitDepthChroma?: number;
  interleaveType: number;
  blockSize: number;
  blockLittleEndian: boolean;
  blockPadLsb: boolean;
  blockReversed: boolean;
  padUnknown: boolean;
  pixelSize: number;
  rowAlignSize: number;
  componentsLittleEndian: boolean;
  samplingType: number;
  tileAlignSize: number;
  tileColumns: number;
  tileRows: number;
  chromaFormatIdc: number;
  components: UncompressedComponent[];
  colorModel: 'gray' | 'rgb' | 'yuv' | 'components';
  /** Float samples are stored as 16-bit-normalized real code values for rendering. */
  floatingPointSamples: boolean;
  genericCompression?: GenericCompressionConfiguration;
}

type UncompressedSampleArray = Uint16Array | Float32Array;

export interface HeicUncompressedComponentData {
  componentIndex: number;
  componentType: number;
  bitDepth: number;
  componentFormat: number;
  width: number;
  height: number;
  /** Multi-Y phase for this component, when `interleaveType` is 5. */
  multiYOffset?: number;
  /** Complex values are stored as real, imaginary pairs. */
  valuesPerSample: 1 | 2;
  /** Raw values; signed integers are sign-extended and floating-point values are not normalized. */
  data: Float64Array;
}

export interface HeicUncompressedComponents {
  width: number;
  height: number;
  components: HeicUncompressedComponentData[];
}

export type UncompressedImagePixels =
  | {
      model: 'rgb' | 'gray';
      rgba: UncompressedSampleArray;
      alpha: UncompressedSampleArray | null;
    }
  | {
      model: 'yuv';
      y: UncompressedSampleArray;
      cb: UncompressedSampleArray;
      cr: UncompressedSampleArray;
      alpha: UncompressedSampleArray | null;
    }
  | ({ model: 'components' } & HeicUncompressedComponents);

function invalid(message: string): never {
  throw new HeicError('INVALID_CONTAINER', `heic: ${message}`);
}

function unsupported(message: string): never {
  throw new HeicError('UNSUPPORTED_FEATURE', `heic: ${message}`);
}

function u16(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > data.length) invalid('truncated uncompressed component field');
  return (data[offset] << 8) | data[offset + 1];
}

function u32(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > data.length) invalid('truncated uncompressed component field');
  return (
    data[offset] * 0x1000000 + (data[offset + 1] << 16) + (data[offset + 2] << 8) + data[offset + 3]
  );
}

function parseComponentTypes(data: Uint8Array): number[] {
  if (data.length < 4) invalid('truncated cmpd component definition');
  const count = u32(data, 0);
  if (count === 0 || count > 64) {
    if (count > 64) throw new HeicError('RESOURCE_LIMIT', 'heic: cmpd component count exceeds 64');
    invalid('cmpd has no components');
  }
  const types: number[] = [];
  let offset = 4;
  for (let index = 0; index < count; index++) {
    const type = u16(data, offset);
    offset += 2;
    types.push(type);
    if (type >= 0x8000) {
      const end = data.indexOf(0, offset);
      if (end < 0) invalid('unterminated cmpd user-defined component URI');
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(offset, end));
      } catch {
        invalid('invalid UTF-8 cmpd component URI');
      }
      offset = end + 1;
    }
  }
  if (offset !== data.length) invalid('trailing data in cmpd component definition');
  return types;
}

function uniqueComponent(components: UncompressedComponent[], type: number): boolean {
  return components.filter((component) => component.componentType === type).length <= 1;
}

/** Parse supported ISO/IEC 23001-17 configurations used by a `unci` item. */
export function parseUncompressedImageConfiguration(
  properties: readonly ISOBMFFBox[],
  width: number,
  height: number,
): UncompressedImageConfiguration {
  const uncCProperties = properties.filter((property) => property.type === 'uncC');
  const cmpdProperties = properties.filter((property) => property.type === 'cmpd');
  const genericCompression = parseGenericCompressionConfiguration(properties);
  if (uncCProperties.length !== 1) invalid('unci item requires exactly one uncC property');

  const uncC = uncCProperties[0].data;
  if (uncC.length < 4 || uncC[1] !== 0 || uncC[2] !== 0 || uncC[3] !== 0)
    unsupported('only uncC configurations with zero flags are supported');
  const version = uncC[0];
  if (version !== 0 && version !== 1) unsupported(`uncC version ${version} is not supported`);
  if (uncC.length < 8) invalid('truncated uncC profile identifier');
  let offset = 4;
  const profile = u32(uncC, offset);
  offset += 4;
  const components: UncompressedComponent[] = [];
  let componentTypes: number[] = [];
  let samplingType: number,
    interleaveType: number,
    blockSize: number,
    layoutFlags: number,
    pixelSize: number,
    rowAlignSize: number,
    tileAlignSize: number,
    tileColumnsMinusOne: number,
    tileRowsMinusOne: number;

  if (version === 1) {
    // ISO/IEC 23001-17:2024/Amd 2 adds the YV20 8-bit planar 4:2:0 profile.
    // Its component order is Y, V, U, matching the profile's YCrCb description.
    if (profile !== 0x79763230) unsupported('predefined uncC profile is not supported');
    if (uncC.length !== 8) invalid('version-1 uncC shall contain only its profile identifier');
    if (cmpdProperties.length > 1) invalid('uncC profile has duplicate cmpd properties');
    componentTypes = [1, 3, 2];
    if (cmpdProperties.length === 1) {
      const declaredTypes = parseComponentTypes(cmpdProperties[0].data);
      if (
        declaredTypes.length !== componentTypes.length ||
        declaredTypes.some((type, index) => type !== componentTypes[index])
      )
        invalid('cmpd component order disagrees with the yv20 uncC profile');
    }
    components.push(
      ...componentTypes.map((componentType, componentIndex) => ({
        componentIndex,
        componentType,
        bitDepth: 8,
        componentFormat: 0,
        componentAlignSize: 0,
      })),
    );
    samplingType = 2;
    interleaveType = 0;
    blockSize = 0;
    layoutFlags = 0;
    pixelSize = 0;
    rowAlignSize = 0;
    tileAlignSize = 0;
    tileColumnsMinusOne = 0;
    tileRowsMinusOne = 0;
  } else {
    if (cmpdProperties.length !== 1)
      invalid('version-0 unci item requires exactly one cmpd property');

    const componentCount = u32(uncC, offset);
    offset += 4;
    if (componentCount === 0 || componentCount > 64) {
      if (componentCount > 64)
        throw new HeicError('RESOURCE_LIMIT', 'heic: uncC component count exceeds 64');
      invalid('uncC has no components');
    }
    componentTypes = parseComponentTypes(cmpdProperties[0].data);
    if (componentCount > componentTypes.length)
      invalid('uncC references more components than cmpd defines');

    const componentIndexes = new Set<number>();
    for (let index = 0; index < componentCount; index++) {
      const componentIndex = u16(uncC, offset);
      const componentBitDepth = uncC[offset + 2] + 1;
      const componentFormat = uncC[offset + 3];
      const componentAlignSize = uncC[offset + 4];
      offset += 5;
      if (componentIndex >= componentTypes.length || componentIndexes.has(componentIndex))
        invalid('uncC component index is out of range or duplicated');
      componentIndexes.add(componentIndex);
      if (
        componentFormat !== 0 &&
        componentFormat !== 1 &&
        componentFormat !== 2 &&
        componentFormat !== 3
      )
        unsupported('unci component format is not supported');
      const validFloatDepth = [16, 32, 64, 128, 256].includes(componentBitDepth);
      const validComplexDepth = [32, 64, 128, 256].includes(componentBitDepth);
      if (
        (componentFormat === 0 && (componentBitDepth < 8 || componentBitDepth > 16)) ||
        (componentFormat === 1 && !validFloatDepth) ||
        (componentFormat === 2 && !validComplexDepth) ||
        (componentFormat === 3 && (componentBitDepth < 2 || componentBitDepth > 16))
      )
        unsupported(
          'unci unsigned components require 8–16 bits, float components require 16/32/64/128/256 bits, complex components require 32/64/128/256 bits, and signed components require 2–16 bits',
        );
      if (componentAlignSize > 0 && componentAlignSize * 8 <= componentBitDepth)
        invalid('uncC component_align_size shall contain more bits than component_bit_depth');
      components.push({
        componentIndex,
        componentType: componentTypes[componentIndex],
        bitDepth: componentBitDepth,
        componentFormat,
        componentAlignSize,
      });
    }

    if (offset + 24 !== uncC.length) invalid('invalid version-0 uncC property size');
    samplingType = uncC[offset++];
    interleaveType = uncC[offset++];
    blockSize = uncC[offset++];
    layoutFlags = uncC[offset++];
    pixelSize = u32(uncC, offset);
    offset += 4;
    rowAlignSize = u32(uncC, offset);
    offset += 4;
    tileAlignSize = u32(uncC, offset);
    offset += 4;
    tileColumnsMinusOne = u32(uncC, offset);
    offset += 4;
    tileRowsMinusOne = u32(uncC, offset);
  }

  if (version === 0 && profile !== 0) {
    if (profile !== 0x72676233) unsupported('predefined uncC profile is not supported');
    const matchesRgb3 =
      componentTypes.length === 3 &&
      componentTypes.every((type, index) => type === [4, 5, 6][index]) &&
      components.length === 3 &&
      components.every(
        (component, index) =>
          component.componentIndex === index &&
          component.bitDepth === 8 &&
          component.componentFormat === 0 &&
          component.componentAlignSize === 0,
      ) &&
      samplingType === 0 &&
      interleaveType === 1 &&
      blockSize === 0 &&
      layoutFlags === 0 &&
      pixelSize === 0 &&
      rowAlignSize === 0 &&
      tileAlignSize === 0 &&
      tileColumnsMinusOne === 0 &&
      tileRowsMinusOne === 0;
    if (!matchesRgb3) invalid('uncC values disagree with the rgb3 predefined profile');
  }

  const componentsLittleEndian = (layoutFlags & 0x80) !== 0;
  const blockPadLsb = (layoutFlags & 0x40) !== 0;
  const blockLittleEndian = (layoutFlags & 0x20) !== 0;
  const blockReversed = (layoutFlags & 0x10) !== 0;
  const padUnknown = (layoutFlags & 0x08) !== 0;
  if (samplingType > 3 || interleaveType > 5) invalid('reserved uncC sampling or interleave type');
  if (pixelSize !== 0 && interleaveType !== 1 && interleaveType !== 5)
    invalid('uncC pixel_size is only valid with pixel or multi-Y pixel interleave');
  if (samplingType === 0 && (interleaveType === 2 || interleaveType === 5))
    invalid('uncC mixed or multi-Y interleave requires chroma subsampling');
  if (samplingType === 2 && interleaveType === 5)
    invalid('uncC multi-Y interleave is not valid for 4:2:0 sampling');
  if (samplingType !== 0 && interleaveType === 1)
    invalid('uncC pixel interleave is not valid with chroma subsampling');
  if (samplingType !== 0 && interleaveType === 3)
    invalid('uncC row interleave is not valid with chroma subsampling');
  if (interleaveType === 4 && samplingType !== 0)
    invalid('uncC tile-component interleave requires no chroma subsampling');
  if (componentsLittleEndian && blockLittleEndian)
    invalid('uncC components_little_endian requires block_little_endian to be zero');
  if (componentsLittleEndian && components.some((component) => component.componentAlignSize === 0))
    invalid('uncC components_little_endian requires aligned component values');
  const hasBlockLayout = blockSize !== 0 || (layoutFlags & 0x78) !== 0;
  if ((layoutFlags & 0x07) !== 0)
    unsupported('uncC reserved component layout options are not supported');
  if (hasBlockLayout) {
    if (interleaveType !== 0 && interleaveType !== 1)
      unsupported('uncC block packing is supported only for component and pixel interleave');
    if (componentsLittleEndian)
      unsupported('uncC block packing cannot be combined with components_little_endian');
    if (components.some((component) => component.componentAlignSize !== 0))
      unsupported('uncC block packing cannot be combined with component_align_size');
    if (interleaveType === 0) {
      if (blockSize === 0 || pixelSize !== 0)
        invalid('uncC component block interleave requires block_size and forbids pixel_size');
      if (blockReversed) unsupported('uncC block_reversed is supported only with pixel interleave');
      if (components.some((component) => component.bitDepth > blockSize * 8))
        invalid('uncC component bit depth exceeds the configured block size');
    } else {
      if (pixelSize === 0) invalid('uncC pixel block interleave requires pixel_size');
      if (blockSize !== 0 && blockSize !== pixelSize)
        invalid('uncC pixel block_size shall be zero or equal pixel_size');
      // pixel_size is a 32-bit field, but reading a larger block as one BigInt
      // per pixel is an avoidable memory and CPU denial-of-service vector. The
      // block_size field itself is one byte, so keep the supported limit at
      // the full representable block_size range.
      if (pixelSize > 255) unsupported('uncC pixel blocks above 255 bytes are not supported');
      if (components.reduce((sum, component) => sum + component.bitDepth, 0) > pixelSize * 8)
        invalid('uncC pixel components exceed the configured block size');
    }
  }
  if (
    rowAlignSize !== 0 &&
    interleaveType === 0 &&
    (((samplingType === 1 || samplingType === 2) && rowAlignSize % 2 !== 0) ||
      (samplingType === 3 && rowAlignSize % 4 !== 0))
  )
    invalid('uncC row_align_size does not meet the chroma-subsampling alignment constraint');
  if (
    tileAlignSize !== 0 &&
    ((samplingType === 1 && tileAlignSize % 2 !== 0) ||
      ((samplingType === 2 || samplingType === 3) && tileAlignSize % 4 !== 0))
  )
    invalid('uncC tile_align_size does not meet the chroma-subsampling alignment constraint');
  if (!Number.isSafeInteger(width * height) || width <= 0 || height <= 0)
    invalid('unci item has invalid image dimensions');
  const tileColumns = tileColumnsMinusOne + 1,
    tileRows = tileRowsMinusOne + 1;
  if (
    tileColumns > width ||
    tileRows > height ||
    width % tileColumns !== 0 ||
    height % tileRows !== 0
  )
    invalid('uncC tile grid shall divide the image dimensions evenly');
  const tileWidth = width / tileColumns,
    tileHeight = height / tileRows;
  if (
    (samplingType === 1 && tileWidth % 2 !== 0) ||
    (samplingType === 2 && (tileWidth % 2 !== 0 || tileHeight % 2 !== 0)) ||
    (samplingType === 3 && tileWidth % 4 !== 0)
  )
    invalid('uncC tile dimensions do not meet the chroma-subsampling constraints');
  const colorTypes = new Set(components.map((component) => component.componentType));
  const hasRgb = [4, 5, 6].some((type) => colorTypes.has(type));
  const hasYuv = [1, 2, 3].some((type) => colorTypes.has(type));
  const hasGray = colorTypes.has(0);
  if (
    [0, 4, 5, 6, 2, 3, ...(interleaveType === 5 ? [] : [1])].some(
      (type) => !uniqueComponent(components, type),
    )
  )
    invalid('unci has duplicate visual components');
  let colorModel: UncompressedImageConfiguration['colorModel'];
  const hasComplexComponent = components.some((component) => component.componentFormat === 2);
  if (
    !hasComplexComponent &&
    hasRgb &&
    [4, 5, 6].every((type) => colorTypes.has(type)) &&
    !hasYuv &&
    !hasGray
  )
    colorModel = 'rgb';
  else if (
    !hasComplexComponent &&
    hasYuv &&
    [1, 2, 3].every((type) => colorTypes.has(type)) &&
    !hasRgb &&
    !hasGray
  )
    colorModel = 'yuv';
  else if (!hasComplexComponent && hasGray && !hasRgb && !hasYuv) colorModel = 'gray';
  else if (hasComplexComponent || (!hasRgb && !hasYuv && !hasGray)) colorModel = 'components';
  else unsupported('unci visual components must be monochrome, RGB, or 4:4:4 YCbCr');
  const componentBitDepth = (type: number): number =>
    components.find((component) => component.componentType === type)?.bitDepth ??
    invalid(`unci is missing visual component ${type}`);
  const floatComponentTypes =
    colorModel === 'rgb'
      ? [4, 5, 6, 7]
      : colorModel === 'gray'
        ? [0, 7]
        : colorModel === 'yuv'
          ? [1, 2, 3, 7]
          : [];
  const hasFloatComponents = components.some(
    (component) =>
      component.componentFormat === 1 && floatComponentTypes.includes(component.componentType),
  );
  let bitDepth: number;
  let bitDepthChroma: number | undefined;
  if (hasFloatComponents) {
    // RGBA output and the HDR renderer use a 16-bit normalized working range;
    // each component retains its IEEE-754 source width in the configuration.
    bitDepth = 16;
    if (colorModel === 'yuv') bitDepthChroma = 16;
  } else if (colorModel === 'rgb')
    bitDepth = Math.max(componentBitDepth(4), componentBitDepth(5), componentBitDepth(6));
  else if (colorModel === 'yuv') {
    bitDepth = Math.max(
      ...components
        .filter((component) => component.componentType === 1)
        .map((component) => component.bitDepth),
    );
    bitDepthChroma = Math.max(componentBitDepth(2), componentBitDepth(3));
  } else if (colorModel === 'gray') bitDepth = componentBitDepth(0);
  else bitDepth = Math.max(...components.map((component) => component.bitDepth));
  if (samplingType !== 0 && (!hasYuv || ![1, 2, 3].every((type) => colorTypes.has(type))))
    invalid('subsampled uncC requires Y, Cb, and Cr components');
  if (samplingType !== 0 && (hasRgb || hasGray))
    invalid('subsampled uncC cannot mix YCbCr with RGB or monochrome components');
  if (interleaveType === 2) {
    const cbIndex = components.findIndex((component) => component.componentType === 2),
      crIndex = components.findIndex((component) => component.componentType === 3);
    if (Math.abs(cbIndex - crIndex) !== 1)
      invalid('uncC mixed interleave requires consecutive Cb and Cr components');
  }
  if (interleaveType === 5) {
    const samplesPerGroup = samplingType === 1 ? 2 : samplingType === 3 ? 4 : 0;
    if (samplesPerGroup === 0) invalid('uncC multi-Y interleave requires 4:2:2 or 4:1:1 sampling');
    const samplesPerComponent = new Map<number, number>();
    for (const component of components)
      samplesPerComponent.set(
        component.componentType,
        (samplesPerComponent.get(component.componentType) ?? 0) + 1,
      );
    for (const [type, count] of samplesPerComponent) {
      const expected = type === 2 || type === 3 ? 1 : samplesPerGroup;
      if (count !== expected)
        invalid(
          'uncC multi-Y interleave requires one full-resolution component value per pixel in each group',
        );
    }
  }
  if (samplingType === 1 && width % 2 !== 0) invalid('4:2:2 uncC image width shall be even');
  if (samplingType === 2 && (width % 2 !== 0 || height % 2 !== 0))
    invalid('4:2:0 uncC image dimensions shall be even');
  if (samplingType === 3 && width % 4 !== 0)
    invalid('4:1:1 uncC image width shall be a multiple of four');
  if (interleaveType !== 5 && !uniqueComponent(components, 7))
    invalid('unci has duplicate alpha components');

  return {
    width,
    height,
    interleaveType,
    blockSize,
    blockLittleEndian,
    blockPadLsb,
    blockReversed,
    padUnknown,
    pixelSize,
    rowAlignSize,
    tileAlignSize,
    componentsLittleEndian,
    samplingType,
    tileColumns,
    tileRows,
    chromaFormatIdc: samplingType === 1 ? 2 : samplingType === 2 ? 1 : samplingType === 3 ? 4 : 3,
    bitDepth,
    ...(bitDepthChroma !== undefined ? { bitDepthChroma } : {}),
    components,
    colorModel,
    floatingPointSamples: hasFloatComponents,
    ...(genericCompression ? { genericCompression } : {}),
  };
}

function componentSampleCount(
  componentType: number,
  width: number,
  height: number,
  samplingType: number,
): number {
  if (componentType !== 2 && componentType !== 3) return width * height;
  if (samplingType === 1) return (width / 2) * height;
  if (samplingType === 2) return (width / 2) * (height / 2);
  if (samplingType === 3) return (width / 4) * height;
  return width * height;
}

function componentDimensions(
  componentType: number,
  width: number,
  height: number,
  samplingType: number,
): { width: number; height: number } {
  if (componentType !== 2 && componentType !== 3) return { width, height };
  if (samplingType === 1) return { width: width / 2, height };
  if (samplingType === 2) return { width: width / 2, height: height / 2 };
  if (samplingType === 3) return { width: width / 4, height };
  return { width, height };
}

function alignRowEnd(payload: Uint8Array, bitOffset: number, rowAlignSize: number): number {
  let byteOffset = Math.ceil(bitOffset / 8);
  if (rowAlignSize > 0) byteOffset = Math.ceil(byteOffset / rowAlignSize) * rowAlignSize;
  if (byteOffset > payload.length)
    invalid('unci payload is shorter than its configured row alignment');
  return byteOffset * 8;
}

function alignTileEnd(payload: Uint8Array, bitOffset: number, tileAlignSize: number): number {
  let byteOffset = Math.ceil(bitOffset / 8);
  if (tileAlignSize > 0) byteOffset = Math.ceil(byteOffset / tileAlignSize) * tileAlignSize;
  if (byteOffset > payload.length)
    invalid('unci payload is shorter than its configured tile alignment');
  return byteOffset * 8;
}

function readBit(payload: Uint8Array, bitOffset: number): number {
  const byteOffset = Math.floor(bitOffset / 8);
  if (byteOffset < 0 || byteOffset >= payload.length)
    invalid('unci payload is shorter than its component configuration');
  return (payload[byteOffset] >> (7 - (bitOffset % 8))) & 1;
}

type UncompressedComponentValue = number | { real: number; imaginary: number };

function decodeIeeeFloat(bits: bigint, bitDepth: number, allowNonFinite = false): number {
  const exponentBits =
      bitDepth === 16 ? 5 : bitDepth === 32 ? 8 : bitDepth === 64 ? 11 : bitDepth === 128 ? 15 : 19,
    fractionBits = bitDepth - exponentBits - 1,
    exponentMask = (1n << BigInt(exponentBits)) - 1n,
    fractionMask = (1n << BigInt(fractionBits)) - 1n,
    sign = bits >> BigInt(bitDepth - 1) === 0n ? 1 : -1,
    exponent = Number((bits >> BigInt(fractionBits)) & exponentMask),
    fraction = bits & fractionMask,
    maxExponent = Number(exponentMask),
    bias = 2 ** (exponentBits - 1) - 1,
    fractionValue = Number(fraction) / 2 ** fractionBits;

  if (exponent === maxExponent) {
    if (allowNonFinite) return fraction !== 0n ? Number.NaN : sign * Number.POSITIVE_INFINITY;
    if (fraction !== 0n) invalid('unci float component contains NaN');
    invalid('unci float component contains infinity');
  }
  if (exponent === 0) return sign * fractionValue * 2 ** (1 - bias);
  const value = sign * (1 + fractionValue) * 2 ** (exponent - bias);
  if (!Number.isFinite(value) && !allowNonFinite)
    invalid('unci float component exceeds the supported numeric range');
  return value;
}

function decodeFloatComponent(
  bits: bigint,
  component: UncompressedComponent,
  allowNonFinite: boolean,
): UncompressedComponentValue {
  if (component.componentFormat !== 2)
    return decodeIeeeFloat(bits, component.bitDepth, allowNonFinite);
  const halfDepth = component.bitDepth / 2,
    mask = (1n << BigInt(halfDepth)) - 1n;
  return {
    real: decodeIeeeFloat((bits >> BigInt(halfDepth)) & mask, halfDepth, allowNonFinite),
    imaginary: decodeIeeeFloat(bits & mask, halfDepth, allowNonFinite),
  };
}

function readFloatComponentSample(
  payload: Uint8Array,
  bitOffset: number,
  component: UncompressedComponent,
  componentsLittleEndian: boolean,
  allowNonFinite: boolean,
): { value: UncompressedComponentValue; nextBitOffset: number } {
  let bits = 0n;
  if (component.componentAlignSize === 0) {
    for (let index = 0; index < component.bitDepth; index++)
      bits = (bits << 1n) | BigInt(readBit(payload, bitOffset + index));
    return {
      value: decodeFloatComponent(bits, component, allowNonFinite),
      nextBitOffset: bitOffset + component.bitDepth,
    };
  }

  let alignedBitOffset = bitOffset;
  while (alignedBitOffset % 8 !== 0) {
    if (readBit(payload, alignedBitOffset) !== 0)
      invalid('unci component pre-alignment padding bits shall be zero');
    alignedBitOffset++;
  }
  const byteOffset = alignedBitOffset / 8,
    bytes = component.componentAlignSize,
    sampleBytes = component.bitDepth / 8;
  if (byteOffset + bytes > payload.length)
    invalid('unci payload is shorter than its component configuration');
  for (let index = 0; index < bytes - sampleBytes; index++) {
    const paddingByteOffset = componentsLittleEndian
      ? byteOffset + sampleBytes + index
      : byteOffset + index;
    if (payload[paddingByteOffset] !== 0)
      invalid('unci component alignment padding bits shall be zero');
  }
  if (componentsLittleEndian) {
    for (let index = sampleBytes - 1; index >= 0; index--)
      bits = (bits << 8n) | BigInt(payload[byteOffset + index]);
  } else {
    for (let index = 0; index < sampleBytes; index++)
      bits = (bits << 8n) | BigInt(payload[byteOffset + bytes - sampleBytes + index]);
  }
  return {
    value: decodeFloatComponent(bits, component, allowNonFinite),
    nextBitOffset: alignedBitOffset + bytes * 8,
  };
}

function readComponentSample(
  payload: Uint8Array,
  bitOffset: number,
  component: UncompressedComponent,
  componentsLittleEndian: boolean,
  allowNonFinite: boolean,
): { value: UncompressedComponentValue; nextBitOffset: number } {
  if (component.componentFormat === 1 || component.componentFormat === 2)
    return readFloatComponentSample(
      payload,
      bitOffset,
      component,
      componentsLittleEndian,
      allowNonFinite,
    );

  if (component.componentAlignSize === 0) {
    let value = 0;
    for (let index = 0; index < component.bitDepth; index++)
      value = value * 2 + readBit(payload, bitOffset + index);
    return { value, nextBitOffset: bitOffset + component.bitDepth };
  }

  let alignedBitOffset = bitOffset;
  while (alignedBitOffset % 8 !== 0) {
    if (readBit(payload, alignedBitOffset) !== 0)
      invalid('unci component pre-alignment padding bits shall be zero');
    alignedBitOffset++;
  }
  const byteOffset = alignedBitOffset / 8,
    bytes = component.componentAlignSize;
  if (byteOffset + bytes > payload.length)
    invalid('unci payload is shorter than its component configuration');
  const sampleBytes = Math.ceil(component.bitDepth / 8);
  for (let index = 0; index < bytes - sampleBytes; index++) {
    const paddingByteOffset = componentsLittleEndian
      ? byteOffset + sampleBytes + index
      : byteOffset + index;
    if (payload[paddingByteOffset] !== 0)
      invalid('unci component alignment padding bits shall be zero');
  }
  let word = 0;
  if (componentsLittleEndian) {
    for (let index = sampleBytes - 1; index >= 0; index--)
      word = word * 256 + payload[byteOffset + index];
  } else {
    for (let index = 0; index < sampleBytes; index++)
      word = word * 256 + payload[byteOffset + bytes - sampleBytes + index];
  }
  const max = 2 ** component.bitDepth - 1;
  if (word > max) invalid('unci component alignment padding bits shall be zero');
  return { value: word, nextBitOffset: alignedBitOffset + bytes * 8 };
}

type BlockValue = number | bigint;

function readBlockValue(
  payload: Uint8Array,
  byteOffset: number,
  blockSize: number,
  littleEndian: boolean,
): BlockValue {
  if (byteOffset < 0 || byteOffset + blockSize > payload.length)
    invalid('unci payload is shorter than its configured block size');
  if (blockSize <= 6) {
    let value = 0;
    if (littleEndian) {
      for (let index = blockSize - 1; index >= 0; index--)
        value = value * 256 + payload[byteOffset + index];
    } else {
      for (let index = 0; index < blockSize; index++)
        value = value * 256 + payload[byteOffset + index];
    }
    return value;
  }

  let value = 0n;
  if (littleEndian) {
    for (let index = blockSize - 1; index >= 0; index--)
      value = (value << 8n) | BigInt(payload[byteOffset + index]);
  } else {
    for (let index = 0; index < blockSize; index++)
      value = (value << 8n) | BigInt(payload[byteOffset + index]);
  }
  return value;
}

function extractBlockSample(value: BlockValue, shift: number, bitDepth: number): number {
  if (typeof value === 'bigint')
    return Number((value >> BigInt(shift)) & ((1n << BigInt(bitDepth)) - 1n));
  return Math.floor(value / 2 ** shift) % 2 ** bitDepth;
}

function extractBlockComponentSample(
  value: BlockValue,
  shift: number,
  component: UncompressedComponent,
  allowNonFinite: boolean,
): UncompressedComponentValue {
  if (component.componentFormat !== 1 && component.componentFormat !== 2)
    return extractBlockSample(value, shift, component.bitDepth);
  const word = typeof value === 'bigint' ? value : BigInt(value),
    mask = (1n << BigInt(component.bitDepth)) - 1n;
  return decodeFloatComponent((word >> BigInt(shift)) & mask, component, allowNonFinite);
}

/** Map a sign-biased two's-complement code to the same signed range at a wider depth. */
export function scaleSignedComponentCode(
  sample: number,
  sourceDepth: number,
  targetDepth: number,
): number {
  if (sourceDepth === targetDepth) return sample;
  const sourceSign = 2 ** (sourceDepth - 1),
    targetSign = 2 ** (targetDepth - 1);
  return sample < sourceSign
    ? Math.round((sample * targetSign) / sourceSign)
    : targetSign + Math.round(((sample - sourceSign) * (targetSign - 1)) / (sourceSign - 1));
}

function normalizeUncompressedComponentSample(
  component: UncompressedComponent,
  sample: number,
  targetDepth: number,
): number {
  if (component.componentFormat === 1) {
    const normalized = sample * (2 ** targetDepth - 1);
    if (!Number.isFinite(normalized) || !Number.isFinite(Math.fround(normalized)))
      unsupported('unci float sample exceeds the Float32 rendering range');
    return normalized;
  }
  if (component.componentFormat === 3)
    return scaleSignedComponentCode(sample, component.bitDepth, targetDepth);
  return Math.round((sample * (2 ** targetDepth - 1)) / (2 ** component.bitDepth - 1));
}

function hasZeroBlockPadding(
  value: BlockValue,
  blockBits: number,
  componentBits: number,
  padLsb: boolean,
): boolean {
  const paddingBits = blockBits - componentBits;
  if (paddingBits <= 0) return true;
  const paddingMask = padLsb
    ? (1n << BigInt(paddingBits)) - 1n
    : ((1n << BigInt(paddingBits)) - 1n) << BigInt(componentBits);
  return ((typeof value === 'bigint' ? value : BigInt(value)) & paddingMask) === 0n;
}

function blockPixelComponentShifts(
  components: readonly UncompressedComponent[],
  blockBits: number,
  padLsb: boolean,
  reversed: boolean,
): { shifts: number[]; totalBits: number } {
  const totalBits = components.reduce((sum, component) => sum + component.bitDepth, 0);
  if (totalBits > blockBits) invalid('uncC pixel components exceed the configured block size');
  const shifts = new Array<number>(components.length);
  if (padLsb) {
    let bitOffset = blockBits;
    for (let index = 0; index < components.length; index++) {
      const componentIndex = reversed ? index : components.length - 1 - index;
      bitOffset -= components[componentIndex].bitDepth;
      shifts[componentIndex] = bitOffset;
    }
  } else {
    let bitOffset = 0;
    for (let index = 0; index < components.length; index++) {
      const componentIndex = reversed ? index : components.length - 1 - index;
      shifts[componentIndex] = bitOffset;
      bitOffset += components[componentIndex].bitDepth;
    }
  }
  return { shifts, totalBits };
}

/** Read supported unsigned/signed integer component, pixel, block, mixed, and tile-component unci payloads. */
export function decodeUncompressedImage(
  payload: Uint8Array,
  configuration: UncompressedImageConfiguration,
  captureComponents = false,
): UncompressedImagePixels {
  const {
    width,
    height,
    components,
    interleaveType,
    blockSize,
    blockLittleEndian,
    blockPadLsb,
    blockReversed,
    padUnknown,
    pixelSize,
    rowAlignSize,
    tileAlignSize,
    componentsLittleEndian,
    samplingType,
    tileColumns,
    tileRows,
    colorModel,
    bitDepth,
    floatingPointSamples,
  } = configuration;
  const pixelCount = width * height;
  if (
    !captureComponents &&
    (colorModel === 'components' || components.some((c) => c.componentFormat === 2))
  )
    unsupported(
      'unci component data has no standard RGBA mapping; use decodeHeicUncompressedComponents',
    );
  const multiYSamplesPerGroup = samplingType === 3 ? 4 : 2;
  const minimumBits = components.reduce(
    (sum, component) =>
      sum +
      (interleaveType === 5
        ? (width / multiYSamplesPerGroup) * height
        : componentSampleCount(component.componentType, width, height, samplingType)) *
        component.bitDepth,
    0,
  );
  if (!Number.isSafeInteger(minimumBits))
    throw new HeicError('RESOURCE_LIMIT', 'heic: unci component data size exceeds safe limits');
  if (payload.length * 8 < minimumBits)
    invalid('unci payload is shorter than its component configuration');

  const multiYOffsetByComponentIndex = new Map<number, number>();
  if (interleaveType === 5) {
    const nextOffsetByType = new Map<number, number>();
    for (const component of components) {
      if (component.componentType === 2 || component.componentType === 3) continue;
      const offset = nextOffsetByType.get(component.componentType) ?? 0;
      multiYOffsetByComponentIndex.set(component.componentIndex, offset);
      nextOffsetByType.set(component.componentType, offset + 1);
    }
  }
  let rawComponents: HeicUncompressedComponentData[] | null = null;
  const rawSlotByComponentIndex = new Map(
    components.map((component, index) => [component.componentIndex, index]),
  );
  if (captureComponents) {
    let totalBytes = 0;
    rawComponents = components.map((component) => {
      const multiY =
          interleaveType === 5 && component.componentType !== 2 && component.componentType !== 3,
        dimensions = multiY
          ? { width: width / multiYSamplesPerGroup, height }
          : componentDimensions(component.componentType, width, height, samplingType),
        valuesPerSample = component.componentFormat === 2 ? 2 : 1,
        sampleCount = dimensions.width * dimensions.height;
      totalBytes += sampleCount * valuesPerSample * Float64Array.BYTES_PER_ELEMENT;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > 256 * 1024 * 1024)
        throw new HeicError('RESOURCE_LIMIT', 'heic: unci component output exceeds 256 MiB');
      return {
        componentIndex: component.componentIndex,
        componentType: component.componentType,
        bitDepth: component.bitDepth,
        componentFormat: component.componentFormat,
        width: dimensions.width,
        height: dimensions.height,
        ...(multiY
          ? { multiYOffset: multiYOffsetByComponentIndex.get(component.componentIndex) ?? 0 }
          : {}),
        valuesPerSample,
        data: new Float64Array(sampleCount * valuesPerSample),
      };
    });
  }

  const Samples = floatingPointSamples ? Float32Array : Uint16Array,
    alphaComponent = components.find((component) => component.componentType === 7);
  const alpha = !captureComponents && alphaComponent ? new Samples(pixelCount) : null;
  let rgba: UncompressedSampleArray | null = null;
  let y: UncompressedSampleArray | null = null;
  let cb: UncompressedSampleArray | null = null;
  let cr: UncompressedSampleArray | null = null;

  if (captureComponents) {
    // Raw extraction allocates only the returned per-component buffers.
  } else if (colorModel === 'rgb' || colorModel === 'gray') {
    rgba = new Samples(pixelCount * 4);
    for (let pixel = 0; pixel < pixelCount; pixel++) rgba[pixel * 4 + 3] = 2 ** bitDepth - 1;
  } else {
    y = new Samples(pixelCount);
    const chromaCount = componentSampleCount(2, width, height, samplingType);
    cb = new Samples(chromaCount);
    cr = new Samples(chromaCount);
  }

  const store = (
    component: UncompressedComponent,
    pixel: number,
    value: UncompressedComponentValue,
    rawSampleIndex = pixel,
  ) => {
    if (captureComponents) {
      const destination = rawComponents![rawSlotByComponentIndex.get(component.componentIndex)!]!,
        sampleIndex = rawSampleIndex;
      if (typeof value === 'object') {
        const offset = sampleIndex * 2;
        destination.data[offset] = value.real;
        destination.data[offset + 1] = value.imaginary;
      } else {
        const rawValue =
          component.componentFormat === 3 && value >= 2 ** (component.bitDepth - 1)
            ? value - 2 ** component.bitDepth
            : value;
        destination.data[sampleIndex] = rawValue;
      }
      return;
    }
    if (typeof value !== 'number')
      unsupported('complex unci values require decodeHeicUncompressedComponents');
    if (component.componentFormat === 3) {
      const signBit = 2 ** (component.bitDepth - 1);
      value = value < signBit ? value + signBit : value - signBit;
    }
    if (floatingPointSamples)
      value = normalizeUncompressedComponentSample(component, value, bitDepth);
    switch (component.componentType) {
      case 0:
        if (rgba) {
          rgba[pixel * 4] = value;
          rgba[pixel * 4 + 1] = value;
          rgba[pixel * 4 + 2] = value;
        }
        break;
      case 1:
        if (y)
          y[pixel] =
            !floatingPointSamples && component.bitDepth !== bitDepth
              ? normalizeUncompressedComponentSample(component, value, bitDepth)
              : value;
        break;
      case 2:
        if (cb) cb[pixel] = value;
        break;
      case 3:
        if (cr) cr[pixel] = value;
        break;
      case 4:
      case 5:
      case 6:
        if (rgba)
          rgba[pixel * 4 + component.componentType - 4] = floatingPointSamples
            ? value
            : colorModel === 'rgb'
              ? component.componentFormat === 3
                ? scaleSignedComponentCode(value, component.bitDepth, bitDepth)
                : Math.round((value * (2 ** bitDepth - 1)) / (2 ** component.bitDepth - 1))
              : value;
        break;
      case 7:
        {
          const alphaValue = floatingPointSamples
            ? value
            : component.componentFormat === 3
              ? scaleSignedComponentCode(value, component.bitDepth, bitDepth)
              : Math.round((value * (2 ** bitDepth - 1)) / (2 ** component.bitDepth - 1));
          alpha![pixel] = alphaValue;
          if (rgba) rgba[pixel * 4 + 3] = alphaValue;
        }
        break;
    }
  };

  const tileWidth = width / tileColumns,
    tileHeight = height / tileRows;
  const tileComponentBounds = (component: UncompressedComponent, tileX: number, tileY: number) => {
    const isSubsampledChroma =
        (component.componentType === 2 || component.componentType === 3) && samplingType !== 0,
      horizontalFactor = isSubsampledChroma ? (samplingType === 3 ? 4 : 2) : 1,
      verticalFactor = isSubsampledChroma && samplingType === 2 ? 2 : 1,
      dimensions = componentDimensions(component.componentType, width, height, samplingType);
    return {
      dimensions,
      width: tileWidth / horizontalFactor,
      height: tileHeight / verticalFactor,
      x: (tileX * tileWidth) / horizontalFactor,
      y: (tileY * tileHeight) / verticalFactor,
      horizontalFactor,
    };
  };

  let sourceBitOffset = 0;
  if (interleaveType === 0 && blockSize > 0) {
    const blockBits = blockSize * 8;
    for (let tileY = 0; tileY < tileRows; tileY++) {
      for (let tileX = 0; tileX < tileColumns; tileX++) {
        for (const component of components) {
          const bounds = tileComponentBounds(component, tileX, tileY),
            shift = blockPadLsb ? blockBits - component.bitDepth : 0;
          if (shift < 0) invalid('uncC component exceeds the configured block size');
          for (let row = 0; row < bounds.height; row++) {
            for (let column = 0; column < bounds.width; column++) {
              const word = readBlockValue(
                payload,
                sourceBitOffset / 8,
                blockSize,
                blockLittleEndian,
              );
              if (
                !padUnknown &&
                !hasZeroBlockPadding(word, blockBits, component.bitDepth, blockPadLsb)
              )
                invalid('uncC block padding bits shall be zero');
              const value = extractBlockComponentSample(word, shift, component, captureComponents);
              store(
                component,
                (bounds.y + row) * bounds.dimensions.width + bounds.x + column,
                value,
              );
              sourceBitOffset += blockBits;
            }
            sourceBitOffset = alignRowEnd(payload, sourceBitOffset, rowAlignSize);
          }
          sourceBitOffset = alignTileEnd(payload, sourceBitOffset, tileAlignSize);
        }
      }
    }
  } else if (interleaveType === 0) {
    for (let tileY = 0; tileY < tileRows; tileY++) {
      for (let tileX = 0; tileX < tileColumns; tileX++) {
        for (const component of components) {
          const bounds = tileComponentBounds(component, tileX, tileY),
            componentRowAlignSize = rowAlignSize;
          for (let row = 0; row < bounds.height; row++) {
            for (let column = 0; column < bounds.width; column++) {
              const decoded = readComponentSample(
                payload,
                sourceBitOffset,
                component,
                componentsLittleEndian,
                captureComponents,
              );
              store(
                component,
                (bounds.y + row) * bounds.dimensions.width + bounds.x + column,
                decoded.value,
              );
              sourceBitOffset = decoded.nextBitOffset;
            }
            sourceBitOffset = alignRowEnd(payload, sourceBitOffset, componentRowAlignSize);
          }
          sourceBitOffset = alignTileEnd(payload, sourceBitOffset, tileAlignSize);
        }
      }
    }
  } else if (
    interleaveType === 1 &&
    (blockSize > 0 || blockLittleEndian || blockPadLsb || blockReversed || padUnknown)
  ) {
    const effectiveBlockSize = blockSize || pixelSize,
      blockBits = effectiveBlockSize * 8,
      { shifts, totalBits } = blockPixelComponentShifts(
        components,
        blockBits,
        blockPadLsb,
        blockReversed,
      );
    for (let tileY = 0; tileY < tileRows; tileY++) {
      for (let tileX = 0; tileX < tileColumns; tileX++) {
        for (let row = 0; row < tileHeight; row++) {
          for (let column = 0; column < tileWidth; column++) {
            const word = readBlockValue(
              payload,
              sourceBitOffset / 8,
              effectiveBlockSize,
              blockLittleEndian,
            );
            if (!padUnknown && !hasZeroBlockPadding(word, blockBits, totalBits, blockPadLsb))
              invalid('uncC block padding bits shall be zero');
            const pixel = (tileY * tileHeight + row) * width + tileX * tileWidth + column;
            for (let componentIndex = 0; componentIndex < components.length; componentIndex++)
              store(
                components[componentIndex],
                pixel,
                extractBlockComponentSample(
                  word,
                  shifts[componentIndex],
                  components[componentIndex],
                  captureComponents,
                ),
              );
            sourceBitOffset += blockBits;
          }
          sourceBitOffset = alignRowEnd(payload, sourceBitOffset, rowAlignSize);
        }
        sourceBitOffset = alignTileEnd(payload, sourceBitOffset, tileAlignSize);
      }
    }
  } else if (interleaveType === 1) {
    for (let tileY = 0; tileY < tileRows; tileY++) {
      for (let tileX = 0; tileX < tileColumns; tileX++) {
        for (let row = 0; row < tileHeight; row++) {
          for (let column = 0; column < tileWidth; column++) {
            const pixelStartBitOffset = sourceBitOffset;
            for (const component of components) {
              const decoded = readComponentSample(
                payload,
                sourceBitOffset,
                component,
                componentsLittleEndian,
                captureComponents,
              );
              store(
                component,
                (tileY * tileHeight + row) * width + tileX * tileWidth + column,
                decoded.value,
              );
              sourceBitOffset = decoded.nextBitOffset;
            }
            if (pixelSize > 0) {
              const pixelEndBitOffset = pixelStartBitOffset + pixelSize * 8;
              if (sourceBitOffset > pixelEndBitOffset)
                invalid('uncC pixel_size is smaller than its component data');
              if (pixelEndBitOffset > payload.length * 8)
                invalid('unci payload is shorter than its configured pixel size');
              sourceBitOffset = pixelEndBitOffset;
            }
          }
          sourceBitOffset = alignRowEnd(payload, sourceBitOffset, rowAlignSize);
        }
        sourceBitOffset = alignTileEnd(payload, sourceBitOffset, tileAlignSize);
      }
    }
  } else if (interleaveType === 3) {
    for (let tileY = 0; tileY < tileRows; tileY++) {
      for (let tileX = 0; tileX < tileColumns; tileX++) {
        for (let row = 0; row < tileHeight; row++) {
          for (const component of components) {
            for (let column = 0; column < tileWidth; column++) {
              const decoded = readComponentSample(
                payload,
                sourceBitOffset,
                component,
                componentsLittleEndian,
                captureComponents,
              );
              store(
                component,
                (tileY * tileHeight + row) * width + tileX * tileWidth + column,
                decoded.value,
              );
              sourceBitOffset = decoded.nextBitOffset;
            }
            sourceBitOffset = alignRowEnd(payload, sourceBitOffset, rowAlignSize);
          }
        }
        sourceBitOffset = alignTileEnd(payload, sourceBitOffset, tileAlignSize);
      }
    }
  } else if (interleaveType === 4) {
    for (const component of components) {
      for (let tileY = 0; tileY < tileRows; tileY++) {
        for (let tileX = 0; tileX < tileColumns; tileX++) {
          const bounds = tileComponentBounds(component, tileX, tileY);
          for (let row = 0; row < bounds.height; row++) {
            for (let column = 0; column < bounds.width; column++) {
              const decoded = readComponentSample(
                payload,
                sourceBitOffset,
                component,
                componentsLittleEndian,
                captureComponents,
              );
              store(
                component,
                (bounds.y + row) * bounds.dimensions.width + bounds.x + column,
                decoded.value,
              );
              sourceBitOffset = decoded.nextBitOffset;
            }
            sourceBitOffset = alignRowEnd(payload, sourceBitOffset, rowAlignSize);
          }
          sourceBitOffset = alignTileEnd(payload, sourceBitOffset, tileAlignSize);
        }
      }
    }
  } else if (interleaveType === 5) {
    const samplesPerGroup = samplingType === 3 ? 4 : 2,
      chromaWidth = width / samplesPerGroup;
    for (let tileY = 0; tileY < tileRows; tileY++) {
      for (let tileX = 0; tileX < tileColumns; tileX++) {
        for (let row = 0; row < tileHeight; row++) {
          for (let column = 0; column < tileWidth; column += samplesPerGroup) {
            const groupStartBitOffset = sourceBitOffset,
              fullResolutionPixel = (tileY * tileHeight + row) * width + tileX * tileWidth + column,
              groupSample =
                (tileY * tileHeight + row) * chromaWidth +
                tileX * (tileWidth / samplesPerGroup) +
                column / samplesPerGroup,
              chromaSample = groupSample,
              componentOccurrences = new Map<number, number>();
            for (const component of components) {
              const decoded = readComponentSample(
                payload,
                sourceBitOffset,
                component,
                componentsLittleEndian,
                captureComponents,
              );
              let sample: number, rawSample: number;
              if (component.componentType === 2 || component.componentType === 3) {
                sample = chromaSample;
                rawSample = chromaSample;
              } else {
                const occurrence = componentOccurrences.get(component.componentType) ?? 0;
                componentOccurrences.set(component.componentType, occurrence + 1);
                sample = fullResolutionPixel + occurrence;
                rawSample = groupSample;
              }
              store(component, sample, decoded.value, rawSample);
              sourceBitOffset = decoded.nextBitOffset;
            }
            if (pixelSize > 0) {
              const pixelEndBitOffset = groupStartBitOffset + pixelSize * 8;
              if (sourceBitOffset > pixelEndBitOffset)
                invalid('uncC pixel_size is smaller than its multi-Y group data');
              if (pixelEndBitOffset > payload.length * 8)
                invalid('unci payload is shorter than its configured multi-Y pixel size');
              sourceBitOffset = pixelEndBitOffset;
            }
          }
          sourceBitOffset = alignRowEnd(payload, sourceBitOffset, rowAlignSize);
        }
        sourceBitOffset = alignTileEnd(payload, sourceBitOffset, tileAlignSize);
      }
    }
  } else {
    for (let tileY = 0; tileY < tileRows; tileY++) {
      for (let tileX = 0; tileX < tileColumns; tileX++) {
        for (let componentIndex = 0; componentIndex < components.length; componentIndex++) {
          const component = components[componentIndex];
          if (component.componentType === 2 || component.componentType === 3) {
            const pairedComponent = components[componentIndex + 1];
            if (
              !pairedComponent ||
              (pairedComponent.componentType !== 2 && pairedComponent.componentType !== 3)
            )
              invalid('uncC mixed interleave requires consecutive Cb and Cr components');
            const bounds = tileComponentBounds(component, tileX, tileY);
            for (let row = 0; row < bounds.height; row++) {
              for (let column = 0; column < bounds.width; column++) {
                const sample = (bounds.y + row) * bounds.dimensions.width + bounds.x + column,
                  first = readComponentSample(
                    payload,
                    sourceBitOffset,
                    component,
                    componentsLittleEndian,
                    captureComponents,
                  ),
                  second = readComponentSample(
                    payload,
                    first.nextBitOffset,
                    pairedComponent,
                    componentsLittleEndian,
                    captureComponents,
                  );
                store(component, sample, first.value);
                store(pairedComponent, sample, second.value);
                sourceBitOffset = second.nextBitOffset;
              }
              sourceBitOffset = alignRowEnd(payload, sourceBitOffset, rowAlignSize);
            }
            componentIndex++;
            sourceBitOffset = alignTileEnd(payload, sourceBitOffset, tileAlignSize);
            continue;
          }

          const bounds = tileComponentBounds(component, tileX, tileY);
          for (let row = 0; row < bounds.height; row++) {
            for (let column = 0; column < bounds.width; column++) {
              const decoded = readComponentSample(
                payload,
                sourceBitOffset,
                component,
                componentsLittleEndian,
                captureComponents,
              );
              store(
                component,
                (bounds.y + row) * bounds.dimensions.width + bounds.x + column,
                decoded.value,
              );
              sourceBitOffset = decoded.nextBitOffset;
            }
            sourceBitOffset = alignRowEnd(payload, sourceBitOffset, rowAlignSize);
          }
          sourceBitOffset = alignTileEnd(payload, sourceBitOffset, tileAlignSize);
        }
      }
    }
  }

  if (captureComponents) return { model: 'components', width, height, components: rawComponents! };
  if (colorModel === 'yuv') return { model: 'yuv', y: y!, cb: cb!, cr: cr!, alpha };
  if (colorModel === 'components')
    unsupported(
      'unci component data has no standard RGBA mapping; use decodeHeicUncompressedComponents',
    );
  return { model: colorModel, rgba: rgba!, alpha };
}
