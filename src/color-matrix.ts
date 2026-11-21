import { getColorTransferFunction } from './color-transfer.js';

export interface YCbCrMatrixCoefficients {
  kr: number;
  kb: number;
}

type Matrix3 = readonly [number, number, number, number, number, number, number, number, number];

function invert3x3([a, b, c, d, e, f, g, h, i]: Matrix3): Matrix3 {
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  return [
    (e * i - f * h) / determinant,
    (c * h - b * i) / determinant,
    (b * f - c * e) / determinant,
    (f * g - d * i) / determinant,
    (a * i - c * g) / determinant,
    (c * d - a * f) / determinant,
    (d * h - e * g) / determinant,
    (b * g - a * h) / determinant,
    (a * e - b * d) / determinant,
  ];
}

function multiply3x3(
  matrix: Matrix3,
  [x, y, z]: [number, number, number],
): [number, number, number] {
  return [
    matrix[0] * x + matrix[1] * y + matrix[2] * z,
    matrix[3] * x + matrix[4] * y + matrix[5] * z,
    matrix[6] * x + matrix[7] * y + matrix[8] * z,
  ];
}

function multiplyMatrix3(left: Matrix3, right: Matrix3): Matrix3 {
  return Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3),
      column = index % 3;
    return (
      left[row * 3] * right[column] +
      left[row * 3 + 1] * right[3 + column] +
      left[row * 3 + 2] * right[6 + column]
    );
  }) as unknown as Matrix3;
}

const BRADFORD: Matrix3 = [
    0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296,
  ],
  BRADFORD_INVERSE = invert3x3(BRADFORD),
  D65_CHROMATICITY: Chromaticity = [0.3127, 0.329],
  IDENTITY: Matrix3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

const ICTCP_PQ_TO_LMS = invert3x3([
  0.5,
  0.5,
  0,
  6610 / 4096,
  -13613 / 4096,
  7003 / 4096,
  17933 / 4096,
  -17390 / 4096,
  -543 / 4096,
]);
const ICTCP_HLG_TO_LMS = invert3x3([
  0.5,
  0.5,
  0,
  3625 / 4096,
  -7465 / 4096,
  3840 / 4096,
  9500 / 4096,
  -9212 / 4096,
  -288 / 4096,
]);
const LMS_TO_RGB = invert3x3([
  1688 / 4096,
  2146 / 4096,
  262 / 4096,
  683 / 4096,
  2951 / 4096,
  462 / 4096,
  99 / 4096,
  309 / 4096,
  3688 / 4096,
]);
const IPT_C2_TO_LMS = invert3x3([
  1638 / 4096,
  1638 / 4096,
  820 / 4096,
  18248 / 4096,
  -19870 / 4096,
  1622 / 4096,
  3300 / 4096,
  1463 / 4096,
  -4763 / 4096,
]);
const LMS_C2_TO_RGB = invert3x3([
  1747 / 4096,
  2169 / 4096,
  180 / 4096,
  673 / 4096,
  3029 / 4096,
  394 / 4096,
  50 / 4096,
  207 / 4096,
  3839 / 4096,
]);

type Chromaticity = readonly [x: number, y: number];
interface ColorPrimaries {
  red: Chromaticity;
  green: Chromaticity;
  blue: Chromaticity;
  white: Chromaticity;
}

// ITU-T H.273 V4 Table 2. Code point 10 (CIE XYZ) is handled separately below.
const COLOR_PRIMARIES: Readonly<Record<number, ColorPrimaries>> = {
  1: { red: [0.64, 0.33], green: [0.3, 0.6], blue: [0.15, 0.06], white: [0.3127, 0.329] },
  4: { red: [0.67, 0.33], green: [0.21, 0.71], blue: [0.14, 0.08], white: [0.31, 0.316] },
  5: { red: [0.64, 0.33], green: [0.29, 0.6], blue: [0.15, 0.06], white: [0.3127, 0.329] },
  6: { red: [0.63, 0.34], green: [0.31, 0.595], blue: [0.155, 0.07], white: [0.3127, 0.329] },
  7: { red: [0.63, 0.34], green: [0.31, 0.595], blue: [0.155, 0.07], white: [0.3127, 0.329] },
  8: { red: [0.681, 0.319], green: [0.243, 0.692], blue: [0.145, 0.049], white: [0.31, 0.316] },
  9: { red: [0.708, 0.292], green: [0.17, 0.797], blue: [0.131, 0.046], white: [0.3127, 0.329] },
  11: { red: [0.68, 0.32], green: [0.265, 0.69], blue: [0.15, 0.06], white: [0.314, 0.351] },
  12: { red: [0.68, 0.32], green: [0.265, 0.69], blue: [0.15, 0.06], white: [0.3127, 0.329] },
  22: { red: [0.63, 0.34], green: [0.295, 0.605], blue: [0.155, 0.077], white: [0.3127, 0.329] },
};

function xyzFromChromaticity([x, y]: Chromaticity): [number, number, number] {
  return [x / y, 1, (1 - x - y) / y];
}

function rgbToXyzNative(colourPrimaries: number): {
  matrix: Matrix3;
  white: [number, number, number];
} | null {
  if (colourPrimaries === 10)
    return { matrix: IDENTITY, white: xyzFromChromaticity([1 / 3, 1 / 3]) };
  const primaries = COLOR_PRIMARIES[colourPrimaries];
  if (!primaries) return null;

  const [xr, , zr] = xyzFromChromaticity(primaries.red),
    [xg, , zg] = xyzFromChromaticity(primaries.green),
    [xb, , zb] = xyzFromChromaticity(primaries.blue),
    white = xyzFromChromaticity(primaries.white),
    unscaled: Matrix3 = [xr, xg, xb, 1, 1, 1, zr, zg, zb],
    scale = multiply3x3(invert3x3(unscaled), white);
  if (scale.some((value) => !Number.isFinite(value))) return null;
  return {
    matrix: [
      xr * scale[0],
      xg * scale[1],
      xb * scale[2],
      scale[0],
      scale[1],
      scale[2],
      zr * scale[0],
      zg * scale[1],
      zb * scale[2],
    ],
    white,
  };
}

/** Resolve H.273 colour primaries to linear RGB-to-XYZ and native luminance values. */
export function getRgbToXyzD65Matrix(colourPrimaries: number): Matrix3 | null {
  const source = rgbToXyzNative(colourPrimaries);
  if (!source) return null;
  const targetWhite = xyzFromChromaticity(D65_CHROMATICITY),
    sourceLms = multiply3x3(BRADFORD, source.white),
    targetLms = multiply3x3(BRADFORD, targetWhite),
    scale = sourceLms.map((value, index) => targetLms[index] / value),
    scaleMatrix: Matrix3 = [scale[0], 0, 0, 0, scale[1], 0, 0, 0, scale[2]],
    adaptation = multiplyMatrix3(BRADFORD_INVERSE, multiplyMatrix3(scaleMatrix, BRADFORD));
  if (scale.some((value) => !Number.isFinite(value))) return null;
  return multiplyMatrix3(adaptation, source.matrix);
}

/** Resolve H.273 linear RGB luminance coefficients before adapting to D65. */
export function getRgbLumaCoefficients(colourPrimaries: number): [number, number, number] | null {
  const source = rgbToXyzNative(colourPrimaries);
  if (!source) return null;
  return [source.matrix[3], source.matrix[4], source.matrix[5]];
}

function deriveLumaCoefficients(colourPrimaries: number): YCbCrMatrixCoefficients | null {
  if (colourPrimaries === 10) return { kr: 1 / 3, kb: 1 / 3 };
  const primaries = COLOR_PRIMARIES[colourPrimaries];
  if (!primaries) return null;
  const xyz = ([x, y]: Chromaticity): [number, number, number] => [x / y, 1, (1 - x - y) / y];
  const [xr, , zr] = xyz(primaries.red),
    [xg, , zg] = xyz(primaries.green),
    [xb, , zb] = xyz(primaries.blue),
    [xw, , zw] = xyz(primaries.white),
    scale = multiply3x3(invert3x3([xr, xg, xb, 1, 1, 1, zr, zg, zb]), [xw, 1, zw]),
    sum = scale[0] + scale[1] + scale[2];
  if (!Number.isFinite(sum) || sum <= 0 || scale.some((value) => !Number.isFinite(value)))
    return null;
  return { kr: scale[0] / sum, kb: scale[2] / sum };
}

/** Resolve H.273 matrix coefficients 12/13 from the signalled primaries. */
export function getYCbCrMatrixCoefficients(
  matrix: number,
  colourPrimaries = 2,
): YCbCrMatrixCoefficients | null {
  if (matrix === 12 || matrix === 13) return deriveLumaCoefficients(colourPrimaries);
  switch (matrix) {
    case 1:
      return { kr: 0.2126, kb: 0.0722 };
    case 2: // Unspecified: retain the decoder's BT.601 application default.
      return { kr: 0.299, kb: 0.114 };
    case 4:
      return { kr: 0.3, kb: 0.11 };
    case 5:
    case 6:
      return { kr: 0.299, kb: 0.114 };
    case 7:
      return { kr: 0.212, kb: 0.087 };
    case 9:
      return { kr: 0.2627, kb: 0.0593 };
    default:
      return null;
  }
}

/** Decode H.273 matrix_coefficients 14 (BT.2100 ICtCp) for PQ or HLG. */
export function decodeICtCp(
  y: number,
  ct: number,
  cp: number,
  bitDepthY: number,
  bitDepthC: number,
  transferCharacteristics: number,
  outputMax: number,
  fullRange: boolean,
): [r: number, g: number, b: number] | null {
  if (transferCharacteristics !== 16 && transferCharacteristics !== 18) return null;
  const transfer = getColorTransferFunction(transferCharacteristics);
  if (!transfer) return null;

  const scaleY = 2 ** (bitDepthY - 8),
    scaleC = 2 ** (bitDepthC - 8),
    maxY = 2 ** bitDepthY - 1,
    maxC = 2 ** bitDepthC - 1,
    intensity = fullRange ? y / maxY : (y - 16 * scaleY) / (219 * scaleY),
    chromaT = fullRange ? (ct - 2 ** (bitDepthC - 1)) / maxC : (ct - 128 * scaleC) / (224 * scaleC),
    chromaP = fullRange ? (cp - 2 ** (bitDepthC - 1)) / maxC : (cp - 128 * scaleC) / (224 * scaleC),
    lmsEncoded = multiply3x3(transferCharacteristics === 18 ? ICTCP_HLG_TO_LMS : ICTCP_PQ_TO_LMS, [
      intensity,
      chromaT,
      chromaP,
    ]),
    lmsLinear = lmsEncoded.map((value) => transfer.toLinear(value)) as [number, number, number],
    rgbLinear = multiply3x3(LMS_TO_RGB, lmsLinear),
    rgbEncoded = rgbLinear.map((value) => transfer.fromLinear(value));

  return [rgbEncoded[0] * outputMax, rgbEncoded[1] * outputMax, rgbEncoded[2] * outputMax];
}

/** Decode H.273 matrix_coefficients 11 (SMPTE ST 2085 Y'D'ZD'X). */
export function decodeSMPTE2085(
  y: number,
  dz: number,
  dx: number,
  bitDepthY: number,
  bitDepthC: number,
  outputMax: number,
  fullRange: boolean,
): [x: number, y: number, z: number] {
  const scaleY = 2 ** (bitDepthY - 8),
    scaleC = 2 ** (bitDepthC - 8),
    maxY = 2 ** bitDepthY - 1,
    maxC = 2 ** bitDepthC - 1,
    eY = fullRange ? y / maxY : (y - 16 * scaleY) / (219 * scaleY),
    ePz = fullRange ? (dz - 2 ** (bitDepthC - 1)) / maxC : (dz - 128 * scaleC) / (224 * scaleC),
    ePx = fullRange ? (dx - 2 ** (bitDepthC - 1)) / maxC : (dx - 128 * scaleC) / (224 * scaleC);
  return [
    (2 * ePx + 0.991902 * eY) * outputMax,
    eY * outputMax,
    ((2 * ePz + eY) / 0.986566) * outputMax,
  ];
}

/** Decode H.273 matrix_coefficients 15 (IPT-C2). */
export function decodeIPTC2(
  y: number,
  p: number,
  t: number,
  bitDepthY: number,
  bitDepthC: number,
  transferCharacteristics: number,
  outputMax: number,
  fullRange: boolean,
): [r: number, g: number, b: number] | null {
  const transfer = getColorTransferFunction(transferCharacteristics);
  if (!transfer) return null;
  const scaleY = 2 ** (bitDepthY - 8),
    scaleC = 2 ** (bitDepthC - 8),
    maxY = 2 ** bitDepthY - 1,
    maxC = 2 ** bitDepthC - 1,
    intensity = fullRange ? y / maxY : (y - 16 * scaleY) / (219 * scaleY),
    chromaP = fullRange ? (p - 2 ** (bitDepthC - 1)) / maxC : (p - 128 * scaleC) / (224 * scaleC),
    chromaT = fullRange ? (t - 2 ** (bitDepthC - 1)) / maxC : (t - 128 * scaleC) / (224 * scaleC),
    lmsEncoded = multiply3x3(IPT_C2_TO_LMS, [intensity, chromaP, chromaT]),
    lmsLinear = lmsEncoded.map((value) => transfer.toLinear(value)) as [number, number, number],
    rgbLinear = multiply3x3(LMS_C2_TO_RGB, lmsLinear),
    rgbEncoded = rgbLinear.map((value) => transfer.fromLinear(value));
  return [rgbEncoded[0] * outputMax, rgbEncoded[1] * outputMax, rgbEncoded[2] * outputMax];
}

/**
 * Decode H.273 matrix_coefficients 10 or 13 (constant luminance).
 * Range expansion, transfer inversion, the linear-luminance green solve, and
 * the transfer re-application follow H.273 8.2 and 8.3.
 */
export function decodeBT2020ConstantLuminance(
  y: number,
  cb: number,
  cr: number,
  bitDepthY: number,
  bitDepthC: number,
  transferCharacteristics: number,
  outputMax: number,
  fullRange: boolean,
  kr = 0.2627,
  kb = 0.0593,
): [r: number, g: number, b: number] | null {
  const transfer = getColorTransferFunction(transferCharacteristics);
  if (!transfer) return null;
  const extended =
    transferCharacteristics === 11 ||
    transferCharacteristics === 12 ||
    transferCharacteristics === 13;
  const clipEncoded = (value: number) => (extended ? value : Math.max(0, Math.min(1, value)));

  const maxY = 2 ** bitDepthY - 1,
    maxC = 2 ** bitDepthC - 1,
    scaleY = 2 ** (bitDepthY - 8),
    scaleC = 2 ** (bitDepthC - 8),
    eY = fullRange ? y / maxY : (y - 16 * scaleY) / (219 * scaleY),
    ePb = fullRange ? (cb - 2 ** (bitDepthC - 1)) / maxC : (cb - 128 * scaleC) / (224 * scaleC),
    ePr = fullRange ? (cr - 2 ** (bitDepthC - 1)) / maxC : (cr - 128 * scaleC) / (224 * scaleC),
    // H.273 equations 65–68 derive these scale factors from the active OETF.
    nB = transfer.fromLinear(1 - kb),
    pB = 1 - transfer.fromLinear(kb),
    nR = transfer.fromLinear(1 - kr),
    pR = 1 - transfer.fromLinear(kr),
    eB = clipEncoded(eY + 2 * ePb * (ePb < 0 ? nB : pB)),
    eR = clipEncoded(eY + 2 * ePr * (ePr < 0 ? nR : pR)),
    linearY = transfer.toLinear(clipEncoded(eY)),
    linearB = transfer.toLinear(eB),
    linearR = transfer.toLinear(eR),
    linearGValue = (linearY - kr * linearR - kb * linearB) / (1 - kr - kb),
    linearG = extended ? linearGValue : Math.max(0, Math.min(1, linearGValue)),
    r = (extended ? eR : Math.max(0, Math.min(1, eR))) * outputMax,
    g = transfer.fromLinear(linearG) * outputMax,
    b = (extended ? eB : Math.max(0, Math.min(1, eB))) * outputMax;
  return [r, g, b];
}

/** Decode the H.273 YCgCo / YCgCo-R matrix (code point 8). */
export function decodeYCgCo(
  y: number,
  cb: number,
  cr: number,
  bitDepthY: number,
  bitDepthC: number,
  outputMax: number,
  fullRange: boolean,
): [r: number, g: number, b: number] | null {
  if (bitDepthC !== bitDepthY && bitDepthC !== bitDepthY + 1) return null;

  const maxY = 2 ** bitDepthY - 1;
  const center = 2 ** (bitDepthC - 1);
  const cg = cb - center;
  const co = cr - center;
  let r: number, g: number, b: number;
  if (bitDepthC === bitDepthY) {
    const t = y - cg;
    g = y + cg;
    b = t - co;
    r = t + co;
  } else {
    const t = y - Math.floor(cg / 2);
    g = t + cg;
    b = t - Math.floor(co / 2);
    r = b + co;
  }

  r = Math.max(0, Math.min(maxY, r));
  g = Math.max(0, Math.min(maxY, g));
  b = Math.max(0, Math.min(maxY, b));

  const scale = fullRange ? outputMax / maxY : outputMax / (219 * 2 ** (bitDepthY - 8));
  const offset = fullRange ? 0 : 16 * 2 ** (bitDepthY - 8);
  const convertRange = (sample: number) =>
    Math.max(0, Math.min(outputMax, (sample - offset) * scale));
  return [convertRange(r), convertRange(g), convertRange(b)];
}

/**
 * Decode H.273 matrix_coefficients 16/17 (YCgCo-Re/Ro, equations 62–65).
 * The coded Y/C planes use BitDepthY/BitDepthC, while the recovered RGB
 * components have two fewer bits for Re and one fewer bit for Ro.
 */
export function decodeYCgCoReRo(
  y: number,
  cb: number,
  cr: number,
  bitDepthY: number,
  bitDepthC: number,
  extraBits: 1 | 2,
  outputMax: number,
  fullRange: boolean,
): [r: number, g: number, b: number] | null {
  const bitDepthRGB = bitDepthY - extraBits;
  if (bitDepthRGB <= 0 || bitDepthC <= 0 || (!fullRange && bitDepthRGB < 8)) return null;

  const maxRGB = 2 ** bitDepthRGB - 1;
  const center = 2 ** (bitDepthC - 1);
  const cg = cb - center;
  const co = cr - center;
  const t = y - Math.floor(cg / 2);
  const g = Math.max(0, Math.min(maxRGB, t + cg));
  const b = Math.max(0, Math.min(maxRGB, t - Math.floor(co / 2)));
  const r = Math.max(0, Math.min(maxRGB, b + co));

  const factor = 2 ** (bitDepthRGB - 8);
  const scale = fullRange ? outputMax / maxRGB : outputMax / (219 * factor);
  const offset = fullRange ? 0 : 16 * factor;
  const convertRange = (sample: number) =>
    Math.max(0, Math.min(outputMax, (sample - offset) * scale));
  return [convertRange(r), convertRange(g), convertRange(b)];
}
