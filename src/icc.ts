import { HeicError } from './errors.js';
import { parseIccMpeInputProfile } from './icc-mpe.js';
import { parseIccHagcTag, type IccHeadroomAdaptiveGainCurve } from './icc-hagc.js';

export interface IccProfile {
  /** Number of encoded channels represented by this ICC transform. */
  channelModel: 'RGB' | 'GRAY';
  /** CICP transfer characteristic, when the profile contains a `cicp` tag. */
  transfer: number | null;
  /** CICP colour primaries, when the profile contains a `cicp` tag. */
  primaries: number | null;
  /** Matrix from the linear device channels to linear sRGB. */
  matrix: number[];
  /** Per-channel device tone-reproduction curves. */
  curves: ((value: number) => number)[];
  /** Direct RGB input transform for LUT profiles, including PCS conversion. */
  transformToLinearSrgb?: (rgb: readonly [number, number, number]) => [number, number, number];
  /** ICC LUT produced as a backward-compatible SDR rendering for an HDR HAGC profile. */
  hdrSdrCompatibilityTransform?: boolean;
  /** Optional ICC.1 Headroom Adaptive Gain Curve tone-mapping metadata. */
  headroomAdaptiveGainCurve?: IccHeadroomAdaptiveGainCurve;
}

export type IccRenderingIntent = 'perceptual' | 'relative' | 'saturation' | 'absolute';
export interface IccProfileParseOptions {
  /** Image pixels used to bound the work of an ICC MPE transform. */
  imagePixels?: number;
  /** Use an ICC HAGC profile's CICP HDR signal instead of its SDR LUT fallback. */
  applyHeadroomAdaptiveGainCurve?: boolean;
}

export const SRGB_FROM_XYZ = [
  3.24096994, -1.53738318, -0.49861076, -0.96924364, 1.8759675, 0.04155506, 0.05563008, -0.20397696,
  1.05697151,
];
export const D65_FROM_D50 = [
  0.9555766, -0.0230393, 0.0631636, -0.0282895, 1.0099416, 0.0210077, 0.0122982, -0.020483,
  1.3299098,
];
export const multiply3 = (a: number[], b: number[]) =>
  Array.from(
    { length: 9 },
    (_, i) =>
      a[Math.floor(i / 3) * 3] * b[i % 3] +
      a[Math.floor(i / 3) * 3 + 1] * b[3 + (i % 3)] +
      a[Math.floor(i / 3) * 3 + 2] * b[6 + (i % 3)],
  );
const D50_TO_LINEAR_SRGB = multiply3(SRGB_FROM_XYZ, D65_FROM_D50);

export const apply3 = (matrix: number[], values: number[]) => [
  matrix[0] * values[0] + matrix[1] * values[1] + matrix[2] * values[2],
  matrix[3] * values[0] + matrix[4] * values[1] + matrix[5] * values[2],
  matrix[6] * values[0] + matrix[7] * values[1] + matrix[8] * values[2],
];

function invert3(matrix: readonly number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = matrix,
    determinant = a! * (e! * i! - f! * h!) - b! * (d! * i! - f! * g!) + c! * (d! * h! - e! * g!);
  if (!Number.isFinite(determinant) || determinant === 0) malformedIcc();
  return [
    e! * i! - f! * h!,
    c! * h! - b! * i!,
    b! * f! - c! * e!,
    f! * g! - d! * i!,
    a! * i! - c! * g!,
    c! * d! - a! * f!,
    d! * h! - e! * g!,
    b! * g! - a! * h!,
    a! * e! - b! * d!,
  ].map((value) => value / determinant);
}

const LINEAR_SRGB_TO_D50 = invert3(D50_TO_LINEAR_SRGB);

const signature = (bytes: Uint8Array, offset: number) =>
  String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);

function malformedIcc(): never {
  throw new HeicError('INVALID_CONTAINER', 'heic: malformed ICC profile');
}

function unsupportedIcc(message: string): never {
  throw new HeicError('UNSUPPORTED_FEATURE', `heic: ${message}`);
}

function checkCurve(curve: (value: number) => number): (value: number) => number {
  for (let i = 0; i <= 32; i++) if (!Number.isFinite(curve(i / 32))) malformedIcc();
  return curve;
}

function parseCurve(tag: DataView, bytes: Uint8Array): (value: number) => number {
  if (tag.byteLength < 12) malformedIcc();
  const type = signature(bytes, tag.byteOffset - bytes.byteOffset);
  if (type === 'para') {
    if (tag.getUint32(4) !== 0 || tag.getUint16(10) !== 0) malformedIcc();
    const kind = tag.getUint16(8),
      parameterCount = [1, 3, 4, 5, 7][kind];
    if (!parameterCount) unsupportedIcc('ICC parametric curve function is not supported');
    if (tag.byteLength < 12 + 4 * parameterCount) malformedIcc();
    const p = Array.from({ length: parameterCount }, (_, i) => tag.getInt32(12 + i * 4) / 65536),
      [g, a, b, c, d, e, f] = p;
    if (!(g > 0) || ((kind === 1 || kind === 2 || kind === 3 || kind === 4) && !(a > 0)))
      malformedIcc();
    if ((kind === 3 || kind === 4) && d! < -b! / a!) malformedIcc();
    return checkCurve((x: number) =>
      kind === 0
        ? x ** g!
        : kind === 1
          ? x >= -b! / a!
            ? (a! * x + b!) ** g!
            : 0
          : kind === 2
            ? x >= -b! / a!
              ? (a! * x + b!) ** g! + c!
              : c!
            : kind === 3
              ? x >= d!
                ? (a! * x + b!) ** g!
                : c! * x
              : x >= d!
                ? (a! * x + b!) ** g! + e!
                : c! * x + f!,
    );
  }
  if (type === 'curv') {
    if (tag.getUint32(4) !== 0) malformedIcc();
    const count = tag.getUint32(8);
    if (count > 65_536 || 12 + 2 * count > tag.byteLength) malformedIcc();
    if (count === 0) return (x: number) => x;
    if (count === 1) {
      const gamma = tag.getUint16(12) / 256;
      if (!(gamma > 0)) malformedIcc();
      return checkCurve((x: number) => x ** gamma);
    }
    return (x: number) => {
      const position = Math.max(0, Math.min(count - 1, x * (count - 1))),
        lower = Math.floor(position),
        upper = Math.min(count - 1, lower + 1),
        fraction = position - lower,
        low = tag.getUint16(12 + 2 * lower),
        high = tag.getUint16(12 + 2 * upper);
      return (low * (1 - fraction) + high * fraction) / 65535;
    };
  }
  return unsupportedIcc('ICC tone response curve type is not supported');
}

function parseEmbeddedCurve(
  tag: DataView,
  bytes: Uint8Array,
  offset: number,
): { curve: (value: number) => number; length: number } {
  if (offset < 32 || offset % 4 !== 0 || offset + 12 > tag.byteLength) malformedIcc();
  const tagOffset = tag.byteOffset - bytes.byteOffset,
    absoluteOffset = tagOffset + offset,
    view = new DataView(bytes.buffer, bytes.byteOffset + absoluteOffset, tag.byteLength - offset),
    type = signature(bytes, absoluteOffset);
  let length: number;
  if (type === 'curv') {
    const entries = view.getUint32(8);
    if (entries > 65_536) malformedIcc();
    length = 12 + entries * 2;
  } else if (type === 'para') {
    const parameterCount = [1, 3, 4, 5, 7][view.getUint16(8)];
    if (!parameterCount) unsupportedIcc('ICC parametric curve function is not supported');
    length = 12 + parameterCount * 4;
  } else {
    return unsupportedIcc('ICC LUT profile uses an unsupported embedded curve type');
  }
  if (length > view.byteLength) malformedIcc();
  return {
    curve: parseCurve(new DataView(bytes.buffer, bytes.byteOffset + absoluteOffset, length), bytes),
    length,
  };
}

function parseMabCurves(
  tag: DataView,
  bytes: Uint8Array,
  offset: number,
  channelCount: number,
): ((value: number) => number)[] {
  if (offset < 32 || offset % 4 !== 0) malformedIcc();
  const curves: ((value: number) => number)[] = [];
  let cursor = offset;
  for (let channel = 0; channel < channelCount; channel++) {
    const parsed = parseEmbeddedCurve(tag, bytes, cursor);
    curves.push(parsed.curve);
    cursor += parsed.length;
    if (channel + 1 < channelCount) cursor = (cursor + 3) & ~3;
  }
  return curves;
}

interface MabClut {
  grids: number[];
  dataOffset: number;
  precision: 1 | 2;
}

function parseMabClut(
  tag: DataView,
  offset: number,
  inputChannels: number,
  outputChannels: number,
): MabClut {
  if (offset < 32 || offset % 4 !== 0 || offset + 20 > tag.byteLength) malformedIcc();
  if (inputChannels !== 1 && inputChannels !== 3)
    return unsupportedIcc('ICC mAB LUT supports one or three input channels');
  const grids = Array.from({ length: inputChannels }, (_, index) => tag.getUint8(offset + index)),
    precision = tag.getUint8(offset + 16);
  if (
    grids.some((grid) => grid < 2) ||
    Array.from({ length: 16 - inputChannels }, (_, i) =>
      tag.getUint8(offset + inputChannels + i),
    ).some((grid) => grid !== 0) ||
    (precision !== 1 && precision !== 2) ||
    tag.getUint8(offset + 17) !== 0 ||
    tag.getUint8(offset + 18) !== 0 ||
    tag.getUint8(offset + 19) !== 0
  )
    malformedIcc();
  const dataLength = grids.reduce((size, grid) => size * grid, outputChannels) * precision;
  if (offset + 20 + dataLength > tag.byteLength) malformedIcc();
  return { grids, dataOffset: offset + 20, precision };
}

function interpolateMabClut(
  tag: DataView,
  clut: MabClut,
  input: readonly number[],
  output: [number, number, number],
): void {
  const { grids, dataOffset, precision } = clut;
  if (input.length !== grids.length) malformedIcc();
  const positions = input.map((value, axis) => Math.max(0, Math.min(1, value)) * (grids[axis] - 1)),
    lower = positions.map(Math.floor),
    upper = lower.map((value, axis) => Math.min(grids[axis] - 1, value + 1)),
    fractions = positions.map((value, axis) => value - lower[axis]),
    // ICC CLUT data stores the first input dimension with the least rapid stride.
    strides = grids.map((_, axis) => grids.slice(axis + 1).reduce((size, grid) => size * grid, 3)),
    scale = precision === 1 ? 255 : 65_535;
  output[0] = 0;
  output[1] = 0;
  output[2] = 0;
  for (let corner = 0; corner < 2 ** input.length; corner++) {
    const indexes = grids.map((_, axis) => (corner & (1 << axis) ? upper[axis] : lower[axis])),
      weight = fractions.reduce(
        (result, fraction, axis) => result * (corner & (1 << axis) ? fraction : 1 - fraction),
        1,
      );
    if (weight === 0) continue;
    const sampleOffset =
      dataOffset +
      indexes.reduce((index, value, axis) => index + value * strides[axis], 0) * precision;
    for (let channel = 0; channel < 3; channel++) {
      const channelOffset = sampleOffset + channel * precision,
        sample = precision === 1 ? tag.getUint8(channelOffset) : tag.getUint16(channelOffset);
      output[channel] += (sample / scale) * weight;
    }
  }
}

function labToLinearSrgb(lab: readonly [number, number, number]): [number, number, number] {
  const lightness = lab[0] * 100,
    a = lab[1] * 255 - 128,
    b = lab[2] * 255 - 128,
    fy = (lightness + 16) / 116,
    fx = fy + a / 500,
    fz = fy - b / 200,
    delta = 6 / 29,
    inverse = (value: number) => (value > delta ? value ** 3 : 3 * delta ** 2 * (value - 4 / 29)),
    x = 0.9642 * inverse(fx),
    y = inverse(fy),
    z = 0.8249 * inverse(fz);
  return [
    D50_TO_LINEAR_SRGB[0] * x + D50_TO_LINEAR_SRGB[1] * y + D50_TO_LINEAR_SRGB[2] * z,
    D50_TO_LINEAR_SRGB[3] * x + D50_TO_LINEAR_SRGB[4] * y + D50_TO_LINEAR_SRGB[5] * z,
    D50_TO_LINEAR_SRGB[6] * x + D50_TO_LINEAR_SRGB[7] * y + D50_TO_LINEAR_SRGB[8] * z,
  ];
}

function xyzToLinearSrgb(xyz: readonly [number, number, number]): [number, number, number] {
  return apply3(D50_TO_LINEAR_SRGB, [...xyz]) as [number, number, number];
}

function absoluteCorrectionFromMediaWhitePoint(
  tag: DataView | undefined,
  bytes: Uint8Array,
): number[] {
  if (
    !tag ||
    tag.byteLength < 20 ||
    signature(bytes, tag.byteOffset - bytes.byteOffset) !== 'XYZ ' ||
    tag.getUint32(4) !== 0
  )
    malformedIcc();
  const mediaWhite = [tag.getInt32(8), tag.getInt32(12), tag.getInt32(16)].map(
      (value) => value / 65_536,
    ),
    scale = mediaWhite.map((value, index) => value / [0.9642, 1, 0.8249][index]);
  if (scale.some((value) => !Number.isFinite(value) || value <= 0)) malformedIcc();
  const scaling = [scale[0], 0, 0, 0, scale[1], 0, 0, 0, scale[2]];
  return multiply3(D50_TO_LINEAR_SRGB, multiply3(scaling, LINEAR_SRGB_TO_D50));
}

function withAbsoluteCorrection(
  transform: (rgb: readonly [number, number, number]) => [number, number, number],
  correction: () => number[],
): (rgb: readonly [number, number, number]) => [number, number, number] {
  return (rgb) => apply3(correction(), transform(rgb)) as [number, number, number];
}

function iccFloatLabToLinearSrgb(lab: readonly [number, number, number]): [number, number, number] {
  return labToLinearSrgb([lab[0] / 100, (lab[1] + 128) / 255, (lab[2] + 128) / 255]);
}

function pcsXyzFromLut(values: readonly [number, number, number]): [number, number, number] {
  // ICC's 16-bit PCSXYZ encoding is u1Fixed15: code 0x8000 represents 1.0.
  // LUT samples are normalized by 0xFFFF, so decode them using that same scale.
  const scale = 65_535 / 32_768;
  return [values[0] * scale, values[1] * scale, values[2] * scale];
}

function sampleMftTable(
  tag: DataView,
  offset: number,
  entries: number,
  precision: 1 | 2,
  input: number,
): number {
  const clamped = Math.max(0, Math.min(1, input)),
    position = clamped * (entries - 1),
    lower = Math.floor(position),
    upper = Math.min(entries - 1, lower + 1),
    fraction = position - lower,
    lowOffset = offset + lower * precision,
    highOffset = offset + upper * precision,
    low = precision === 1 ? tag.getUint8(lowOffset) : tag.getUint16(lowOffset),
    high = precision === 1 ? tag.getUint8(highOffset) : tag.getUint16(highOffset),
    maximum = precision === 1 ? 255 : 65_535;
  return (low * (1 - fraction) + high * fraction) / maximum;
}

function interpolateMftClut(
  tag: DataView,
  offset: number,
  gridPoints: number,
  precision: 1 | 2,
  input: readonly number[],
): [number, number, number] {
  const positions = input.map((value) => Math.max(0, Math.min(1, value)) * (gridPoints - 1)),
    lower = positions.map(Math.floor),
    upper = lower.map((value) => Math.min(gridPoints - 1, value + 1)),
    fractions = positions.map((value, index) => value - lower[index]),
    strides = input.map((_, axis) => gridPoints ** (input.length - axis - 1)),
    maximum = precision === 1 ? 255 : 65_535,
    output: [number, number, number] = [0, 0, 0];

  // In lut8Type/lut16Type data the first input dimension varies least rapidly.
  for (let corner = 0; corner < 2 ** input.length; corner++) {
    const indexes = input.map((_, axis) => (corner & (1 << axis) ? upper[axis] : lower[axis])),
      weight = input.reduce(
        (result, _, axis) =>
          result * (corner & (1 << axis) ? fractions[axis] : 1 - fractions[axis]),
        1,
      );
    if (weight === 0) continue;
    const sampleOffset =
      offset +
      indexes.reduce((index, value, axis) => index + value * strides[axis], 0) * 3 * precision;
    for (let channel = 0; channel < 3; channel++) {
      const channelOffset = sampleOffset + channel * precision,
        sample = precision === 1 ? tag.getUint8(channelOffset) : tag.getUint16(channelOffset);
      output[channel] += (sample / maximum) * weight;
    }
  }
  return output;
}

function parseMftInputProfile(
  tag: DataView,
  bytes: Uint8Array,
  pcs: 'Lab ' | 'XYZ ',
  expectedInputChannels: 1 | 3,
): (rgb: readonly [number, number, number]) => [number, number, number] {
  if (tag.byteLength < 8) malformedIcc();
  const type = signature(bytes, tag.byteOffset - bytes.byteOffset),
    precision = type === 'mft1' ? 1 : type === 'mft2' ? 2 : null;
  if (precision === null) return unsupportedIcc('ICC A2B LUT type is not supported');
  const headerLength = precision === 1 ? 48 : 52;
  if (tag.byteLength < headerLength || tag.getUint32(4) !== 0 || tag.getUint8(11) !== 0)
    malformedIcc();

  const inputChannels = tag.getUint8(8),
    outputChannels = tag.getUint8(9),
    gridPoints = tag.getUint8(10);
  if (inputChannels !== expectedInputChannels || outputChannels !== 3)
    return unsupportedIcc('ICC LUT profile input channels do not match its data color space');
  if (precision === 1 && pcs === 'XYZ ')
    return unsupportedIcc('ICC mft1 LUTs with XYZ PCS have implementation-specific encoding');
  if (gridPoints < 2) malformedIcc();

  const inputEntries = precision === 1 ? 256 : tag.getUint16(48),
    outputEntries = precision === 1 ? 256 : tag.getUint16(50);
  if (
    (precision === 2 &&
      (inputEntries < 2 || inputEntries > 4096 || outputEntries < 2 || outputEntries > 4096)) ||
    Array.from({ length: 9 }, (_, index) => tag.getInt32(12 + index * 4)).some(
      (value, index) => value !== [65_536, 0, 0, 0, 65_536, 0, 0, 0, 65_536][index],
    )
  )
    malformedIcc();

  const inputOffset = headerLength,
    clutOffset = inputOffset + inputChannels * inputEntries * precision,
    outputOffset = clutOffset + gridPoints ** inputChannels * outputChannels * precision,
    requiredLength = outputOffset + outputChannels * outputEntries * precision;
  if (!Number.isSafeInteger(requiredLength) || requiredLength > tag.byteLength) malformedIcc();

  return (rgb) => {
    const input = Array.from({ length: inputChannels }, (_, channel) =>
        sampleMftTable(
          tag,
          inputOffset + channel * inputEntries * precision,
          inputEntries,
          precision,
          rgb[channel],
        ),
      ),
      clut = interpolateMftClut(tag, clutOffset, gridPoints, precision, input),
      pcsValues = [0, 1, 2].map((channel) =>
        sampleMftTable(
          tag,
          outputOffset + channel * outputEntries * precision,
          outputEntries,
          precision,
          clut[channel],
        ),
      ) as [number, number, number];

    if (pcs === 'XYZ ') return xyzToLinearSrgb(pcsXyzFromLut(pcsValues));

    // lut16Type retains the v2 PCSLAB encoding: L* 100 maps to FF00h, and
    // a*/b* zero maps to 8000h. Convert that range to labToLinearSrgb's scale.
    if (precision === 2) {
      const legacyLabScale = 65_535 / 65_280;
      pcsValues[0] = Math.min(1, pcsValues[0] * legacyLabScale);
      pcsValues[1] *= legacyLabScale;
      pcsValues[2] *= legacyLabScale;
    }
    return labToLinearSrgb(pcsValues);
  };
}

function parseA2BInputProfile(
  tag: DataView,
  bytes: Uint8Array,
  pcs: 'Lab ' | 'XYZ ',
  inputChannels: 1 | 3,
  preserveExtendedXyzRange = false,
): (rgb: readonly [number, number, number]) => [number, number, number] {
  const type = signature(bytes, tag.byteOffset - bytes.byteOffset);
  if (type === 'mAB ')
    return parseMabInputProfile(tag, bytes, pcs, inputChannels, preserveExtendedXyzRange);
  return parseMftInputProfile(tag, bytes, pcs, inputChannels);
}

function parseMabInputProfile(
  tag: DataView,
  bytes: Uint8Array,
  pcs: 'Lab ' | 'XYZ ',
  expectedInputChannels: 1 | 3,
  preserveExtendedXyzRange: boolean,
): (rgb: readonly [number, number, number]) => [number, number, number] {
  if (tag.byteLength < 8) malformedIcc();
  if (signature(bytes, tag.byteOffset - bytes.byteOffset) !== 'mAB ')
    return unsupportedIcc('ICC A2B LUT type is not supported');
  if (tag.byteLength < 32 || tag.getUint32(4) !== 0 || tag.getUint16(10) !== 0) malformedIcc();
  const inputChannels = tag.getUint8(8),
    outputChannels = tag.getUint8(9),
    offsets = [12, 16, 20, 24, 28].map((field) => tag.getUint32(field)),
    [bOffset, matrixOffset, mOffset, clutOffset, aOffset] = offsets;
  if (inputChannels !== expectedInputChannels || outputChannels !== 3)
    return unsupportedIcc('ICC mAB input channels do not match its data color space');
  for (const offset of offsets)
    if (offset !== 0 && (offset < 32 || offset % 4 !== 0 || offset >= tag.byteLength))
      malformedIcc();
  if ((aOffset === 0) !== (clutOffset === 0) || (mOffset === 0) !== (matrixOffset === 0))
    malformedIcc();

  const bCurves = bOffset ? parseMabCurves(tag, bytes, bOffset, outputChannels) : null,
    aCurves = aOffset ? parseMabCurves(tag, bytes, aOffset, inputChannels) : null,
    mCurves = mOffset ? parseMabCurves(tag, bytes, mOffset, outputChannels) : null,
    clut = clutOffset ? parseMabClut(tag, clutOffset, inputChannels, outputChannels) : null,
    matrix = matrixOffset
      ? Array.from({ length: 12 }, (_, i) => tag.getInt32(matrixOffset + i * 4) / 65536)
      : null;

  if (
    (inputChannels === 1 && (!aCurves || !clut)) ||
    (!bCurves && !(mCurves && matrix) && !(aCurves && clut))
  )
    malformedIcc();
  return (rgb) => {
    let input = Array.from({ length: inputChannels }, (_, channel) =>
        Math.max(0, Math.min(1, rgb[channel])),
      ),
      values: [number, number, number];
    if (aCurves) {
      input = input.map((value, channel) => aCurves[channel](value));
    }
    if (clut) {
      values = [0, 0, 0];
      interpolateMabClut(tag, clut, input, values);
    } else if (inputChannels === 3) {
      values = input as [number, number, number];
    } else {
      malformedIcc();
    }
    if (mCurves) {
      values[0] = mCurves[0](values[0]);
      values[1] = mCurves[1](values[1]);
      values[2] = mCurves[2](values[2]);
    }
    if (matrix) {
      const matrixValues: [number, number, number] = [
        matrix[0] * values[0] + matrix[1] * values[1] + matrix[2] * values[2] + matrix[9],
        matrix[3] * values[0] + matrix[4] * values[1] + matrix[5] * values[2] + matrix[10],
        matrix[6] * values[0] + matrix[7] * values[1] + matrix[8] * values[2] + matrix[11],
      ];
      // HAGC profiles use A2B0 as a legacy SDR transform. Preserve extended
      // PCS XYZ values in that fallback; clipping here changes the published
      // compatibility rendering carried by profiles such as Apple's HAGC ICC.
      values = preserveExtendedXyzRange
        ? matrixValues
        : (matrixValues.map((value) => Math.max(0, Math.min(1, value)) as number) as typeof values);
    }
    if (bCurves) {
      values[0] = bCurves[0](values[0]);
      values[1] = bCurves[1](values[1]);
      values[2] = bCurves[2](values[2]);
    }
    return pcs === 'XYZ ' ? xyzToLinearSrgb(pcsXyzFromLut(values)) : labToLinearSrgb(values);
  };
}

/** Parse supported RGB LUT/matrix and monochrome LUT/grayTRC subsets of ICC v2/v4 profiles. */
export function parseIccProfile(
  bytes: Uint8Array,
  iccType?: 'prof' | 'rICC' | null,
  renderingIntent: IccRenderingIntent = 'relative',
  options: IccProfileParseOptions = {},
): IccProfile {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 132 || signature(bytes, 36) !== 'acsp') malformedIcc();
  const profileSize = view.getUint32(0),
    profileClass = signature(bytes, 12),
    dataSpace = signature(bytes, 16),
    pcs = signature(bytes, 20);
  if (profileSize < 132 || profileSize > bytes.length) malformedIcc();
  if (iccType === 'rICC' && profileClass !== 'scnr')
    throw new HeicError('INVALID_CONTAINER', 'heic: rICC profile is not an input profile');
  if (
    (dataSpace !== 'RGB ' && dataSpace !== 'GRAY') ||
    (profileClass !== 'scnr' && profileClass !== 'mntr' && profileClass !== 'spac')
  )
    return unsupportedIcc(
      'ICC profile must be an RGB or monochrome input/display profile, or an RGB HAGC ColorSpace profile',
    );
  const count = view.getUint32(128),
    tableEnd = 132 + count * 12;
  if (count > 4096 || tableEnd > profileSize) malformedIcc();
  const tags = new Map<string, DataView>();
  for (let i = 0; i < count; i++) {
    const entry = 132 + i * 12,
      name = signature(bytes, entry),
      offset = view.getUint32(entry + 4),
      length = view.getUint32(entry + 8);
    if (
      tags.has(name) ||
      offset < tableEnd ||
      offset % 4 !== 0 ||
      length < 8 ||
      offset + length > profileSize
    )
      malformedIcc();
    tags.set(name, new DataView(bytes.buffer, bytes.byteOffset + offset, length));
  }

  const hagcTag = tags.get('HAGC');
  if (profileClass === 'spac' && !hagcTag)
    return unsupportedIcc('ICC ColorSpace profiles are supported only with an HAGC tag');
  if (hagcTag && dataSpace !== 'RGB ') malformedIcc();
  const headroomAdaptiveGainCurve = hagcTag ? parseIccHagcTag(hagcTag) : null;

  const cicp = tags.get('cicp');
  let transfer: number | null = null,
    primaries: number | null = null;
  if (cicp) {
    if (
      cicp.byteLength < 12 ||
      signature(bytes, cicp.byteOffset - bytes.byteOffset) !== 'cicp' ||
      cicp.getUint32(4) !== 0 ||
      cicp.getUint8(10) !== 0 ||
      cicp.getUint8(11) > 1
    )
      malformedIcc();
    primaries = cicp.getUint8(8);
    transfer = cicp.getUint8(9);
    if (dataSpace === 'GRAY') malformedIcc();
  }

  let grayCurve: ((value: number) => number) | null = null;
  if (dataSpace === 'GRAY') {
    const whitePoint = tags.get('wtpt'),
      grayTrc = tags.get('kTRC');
    if (!whitePoint || !grayTrc) malformedIcc();
    if (
      whitePoint.byteLength < 20 ||
      signature(bytes, whitePoint.byteOffset - bytes.byteOffset) !== 'XYZ ' ||
      whitePoint.getUint32(4) !== 0
    )
      malformedIcc();
    grayCurve = parseCurve(grayTrc, bytes);
  }

  const hasRgbMatrixTrcFallback =
    dataSpace === 'RGB ' &&
    pcs === 'XYZ ' &&
    ['rXYZ', 'gXYZ', 'bXYZ', 'rTRC', 'gTRC', 'bTRC'].every((tag) => tags.has(tag));
  const hasGrayTrcFallback =
    dataSpace === 'GRAY' && grayCurve !== null && (pcs === 'XYZ ' || pcs === 'Lab ');
  const hasColorFallback = hasRgbMatrixTrcFallback || hasGrayTrcFallback;
  const useHagcHdrSignal =
    options.applyHeadroomAdaptiveGainCurve === true &&
    headroomAdaptiveGainCurve !== null &&
    dataSpace === 'RGB ' &&
    (transfer === 8 || transfer === 16 || transfer === 18) &&
    ((primaries !== null && primaries !== 2) || hasRgbMatrixTrcFallback);
  let cachedAbsoluteCorrection: number[] | undefined;
  const getAbsoluteCorrection = () =>
    (cachedAbsoluteCorrection ??= absoluteCorrectionFromMediaWhitePoint(tags.get('wtpt'), bytes));

  if (
    iccType === 'rICC' &&
    ['A2B0', 'A2B1', 'A2B2', 'D2B0', 'D2B1', 'D2B2', 'D2B3'].some((tag) => tags.has(tag))
  )
    throw new HeicError(
      'INVALID_CONTAINER',
      'heic: rICC profile contains an unrestricted LUT transform',
    );
  const perceptualLut = tags.get('A2B0'),
    relativeLut = tags.get('A2B1'),
    saturationLut = tags.get('A2B2'),
    absoluteIntent = renderingIntent === 'absolute',
    selectedMpe = absoluteIntent
      ? (tags.get('D2B3') ?? tags.get('D2B1'))
      : renderingIntent === 'relative'
        ? tags.get('D2B1')
        : renderingIntent === 'saturation'
          ? tags.get('D2B2')
          : tags.get('D2B0');
  if (
    !perceptualLut &&
    (relativeLut || saturationLut) &&
    !hasColorFallback &&
    !selectedMpe &&
    !(absoluteIntent && relativeLut) &&
    !useHagcHdrSignal
  )
    return unsupportedIcc('ICC profile has no supported A2B0 LUT or complete matrix/TRC transform');
  const intentLut = absoluteIntent
      ? relativeLut
      : renderingIntent === 'relative'
        ? relativeLut
        : renderingIntent === 'saturation'
          ? saturationLut
          : perceptualLut,
    selectedLut = useHagcHdrSignal ? undefined : (intentLut ?? perceptualLut),
    mpeTransforms: { tag: DataView; applyWhitePoint: boolean }[] = [],
    lutTransforms: { tag: DataView; applyWhitePoint: boolean }[] = [];
  if (useHagcHdrSignal) {
    // HAGC supplements the HDR signal; A2B tags may be authored as an SDR
    // compatibility approximation and must not replace HDR linearization.
  } else if (absoluteIntent) {
    const absoluteMpe = tags.get('D2B3');
    const relativeMpe = tags.get('D2B1');
    if (absoluteMpe) mpeTransforms.push({ tag: absoluteMpe, applyWhitePoint: false });
    if (relativeMpe) mpeTransforms.push({ tag: relativeMpe, applyWhitePoint: true });
    if (relativeLut) lutTransforms.push({ tag: relativeLut, applyWhitePoint: true });
    if (perceptualLut) lutTransforms.push({ tag: perceptualLut, applyWhitePoint: false });
  } else {
    if (selectedMpe) mpeTransforms.push({ tag: selectedMpe, applyWhitePoint: false });
    if (selectedLut) lutTransforms.push({ tag: selectedLut, applyWhitePoint: false });
    if (perceptualLut && selectedLut !== perceptualLut)
      lutTransforms.push({ tag: perceptualLut, applyWhitePoint: false });
  }

  if (useHagcHdrSignal && !hasRgbMatrixTrcFallback && primaries !== null && primaries !== 2)
    return {
      channelModel: 'RGB',
      transfer,
      primaries,
      matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      curves: [(value) => value, (value) => value, (value) => value],
      ...(headroomAdaptiveGainCurve ? { headroomAdaptiveGainCurve } : {}),
    };

  if (mpeTransforms.length || lutTransforms.length) {
    if (
      (dataSpace !== 'RGB ' && dataSpace !== 'GRAY') ||
      (profileClass !== 'scnr' && profileClass !== 'mntr') ||
      (pcs !== 'Lab ' && pcs !== 'XYZ ')
    )
      return unsupportedIcc(
        'ICC device-to-PCS transforms are limited to RGB or monochrome scanner/display profiles with Lab or XYZ PCS',
      );
    if ((transfer === 16 || transfer === 18) && options.applyHeadroomAdaptiveGainCurve === true)
      return unsupportedIcc('ICC LUT profiles with PQ or HLG CICP metadata are not supported');
    let transformToLinearSrgb: IccProfile['transformToLinearSrgb'];
    const inputChannels = dataSpace === 'GRAY' ? 1 : 3;
    const candidates: {
        source: 'mpe' | 'lut';
        parse: () => IccProfile['transformToLinearSrgb'];
      }[] = [],
      applyCorrection = (
        transform: (rgb: readonly [number, number, number]) => [number, number, number],
        needed: boolean,
      ) => (needed ? withAbsoluteCorrection(transform, getAbsoluteCorrection) : transform);
    for (const candidate of mpeTransforms)
      candidates.push({
        source: 'mpe',
        parse: () => {
          const transform = parseIccMpeInputProfile(
              candidate.tag,
              inputChannels,
              options.imagePixels,
            ),
            toLinearSrgb = (rgb: readonly [number, number, number]) => {
              const pcsValues = transform(
                inputChannels === 1 ? [rgb[0]] : [rgb[0], rgb[1], rgb[2]],
              );
              return pcs === 'XYZ '
                ? xyzToLinearSrgb(pcsValues)
                : iccFloatLabToLinearSrgb(pcsValues);
            };
          return applyCorrection(toLinearSrgb, candidate.applyWhitePoint);
        },
      });
    for (const candidate of lutTransforms)
      candidates.push({
        source: 'lut',
        parse: () =>
          applyCorrection(
            parseA2BInputProfile(
              candidate.tag,
              bytes,
              pcs,
              inputChannels,
              headroomAdaptiveGainCurve !== null &&
                (transfer === 8 || transfer === 16 || transfer === 18) &&
                candidate.tag === perceptualLut,
            ),
            candidate.applyWhitePoint,
          ),
      });
    let lastUnsupported: unknown;
    let usedLutTransform = false;
    for (const candidate of candidates) {
      try {
        transformToLinearSrgb = candidate.parse();
        usedLutTransform = candidate.source === 'lut';
        break;
      } catch (error) {
        if (!(error instanceof HeicError) || error.code !== 'UNSUPPORTED_FEATURE') throw error;
        lastUnsupported = error;
      }
    }
    if (transformToLinearSrgb)
      return {
        channelModel: dataSpace === 'GRAY' ? 'GRAY' : 'RGB',
        transfer,
        primaries,
        matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        curves:
          dataSpace === 'GRAY'
            ? [(value) => value]
            : [(value) => value, (value) => value, (value) => value],
        transformToLinearSrgb,
        ...(headroomAdaptiveGainCurve && usedLutTransform
          ? { hdrSdrCompatibilityTransform: true }
          : {}),
        ...(headroomAdaptiveGainCurve ? { headroomAdaptiveGainCurve } : {}),
      };
    if (!hasColorFallback && lastUnsupported instanceof HeicError) throw lastUnsupported;
  }

  if (dataSpace === 'GRAY') {
    // ICC F.2 maps grayTRC output to the achromatic PCS axis. PCS white is D50;
    // wtpt remains a required profile tag but describes media white separately.
    const curve = grayCurve!,
      grayLabTransform = (rgb: readonly [number, number, number]): [number, number, number] => {
        const encoded = Math.max(0, Math.min(1, rgb[0]));
        const lightness = Math.max(0, Math.min(1, curve(encoded)));
        return labToLinearSrgb([lightness, 128 / 255, 128 / 255]);
      };
    if (pcs === 'Lab ')
      return {
        channelModel: 'GRAY',
        transfer,
        primaries,
        matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        curves: [curve],
        ...(headroomAdaptiveGainCurve ? { headroomAdaptiveGainCurve } : {}),
        transformToLinearSrgb: absoluteIntent
          ? withAbsoluteCorrection(grayLabTransform, getAbsoluteCorrection)
          : grayLabTransform,
      };
    if (pcs !== 'XYZ ') return unsupportedIcc('ICC monochrome profile PCS is not supported');
    const d50ToSrgb = multiply3(SRGB_FROM_XYZ, D65_FROM_D50),
      d50WhiteInSrgb = apply3(d50ToSrgb, [0.9642, 1, 0.8249]);
    const matrix = [d50WhiteInSrgb[0], 0, 0, d50WhiteInSrgb[1], 0, 0, d50WhiteInSrgb[2], 0, 0];
    return {
      channelModel: 'GRAY',
      transfer,
      primaries,
      matrix: absoluteIntent ? multiply3(getAbsoluteCorrection(), matrix) : matrix,
      curves: [curve],
      ...(headroomAdaptiveGainCurve ? { headroomAdaptiveGainCurve } : {}),
    };
  }

  if (pcs !== 'XYZ ')
    return unsupportedIcc('ICC RGB matrix/TRC profiles with Lab PCS are not supported');

  const columns = ['rXYZ', 'gXYZ', 'bXYZ'].map((name) => {
    const tag = tags.get(name);
    if (!tag) return unsupportedIcc('ICC LUT profiles are not supported');
    if (
      tag.byteLength < 20 ||
      signature(bytes, tag.byteOffset - bytes.byteOffset) !== 'XYZ ' ||
      tag.getUint32(4) !== 0
    )
      malformedIcc();
    return [tag.getInt32(8), tag.getInt32(12), tag.getInt32(16)].map((value) => value / 65536);
  });
  const xyzFromRgb = [
    columns[0][0],
    columns[1][0],
    columns[2][0],
    columns[0][1],
    columns[1][1],
    columns[2][1],
    columns[0][2],
    columns[1][2],
    columns[2][2],
  ];
  const curves = ['rTRC', 'gTRC', 'bTRC'].map((name) => {
    const tag = tags.get(name);
    if (!tag) return unsupportedIcc('ICC LUT profiles are not supported');
    return parseCurve(tag, bytes);
  });
  const matrix = multiply3(SRGB_FROM_XYZ, multiply3(D65_FROM_D50, xyzFromRgb));
  return {
    channelModel: 'RGB',
    transfer,
    primaries,
    matrix: absoluteIntent ? multiply3(getAbsoluteCorrection(), matrix) : matrix,
    curves,
    ...(headroomAdaptiveGainCurve ? { headroomAdaptiveGainCurve } : {}),
  };
}

/** Convert encoded RGB or gray samples through the supported ICC transform into linear sRGB. */
export function iccToLinearSrgb(
  profile: IccProfile,
  encodedRgb: readonly [number, number, number],
): [number, number, number] {
  if (profile.transformToLinearSrgb) return profile.transformToLinearSrgb(encodedRgb);
  const linear =
    profile.channelModel === 'GRAY'
      ? [profile.curves[0](Math.max(0, Math.min(1, encodedRgb[0]))), 0, 0]
      : encodedRgb.map((value, channel) =>
          profile.curves[channel](Math.max(0, Math.min(1, value))),
        );
  return apply3(profile.matrix, linear) as [number, number, number];
}

/** Encode linear sRGB as 8-bit-displayable sRGB values, clipping to its gamut. */
export function linearSrgbToSrgb(
  linearRgb: readonly [number, number, number],
): [number, number, number] {
  return linearRgb.map((value) => {
    const encoded = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(1, encoded));
  }) as [number, number, number];
}
