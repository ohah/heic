/** Supported inverse/forward H.273 transfer functions used by color and HDR paths. */
export interface ColorTransferFunction {
  toLinear(encoded: number): number;
  fromLinear(linear: number): number;
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

const srgb: ColorTransferFunction = {
  toLinear(encoded) {
    const v = clamp01(encoded);
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  },
  fromLinear(linear) {
    const v = clamp01(linear);
    return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  },
};

// H.273 defines transfer_characteristics 13 as extended sRGB when the matrix
// code is nonzero. Matrix code 10 can reconstruct encoded channels below zero.
const srgbExtended: ColorTransferFunction = {
  toLinear(encoded) {
    if (encoded < -0.04045) return -(((-encoded + 0.055) / 1.055) ** 2.4);
    if (encoded <= 0.04045) return encoded / 12.92;
    return ((encoded + 0.055) / 1.055) ** 2.4;
  },
  fromLinear(linearValue) {
    if (linearValue < -0.0031308) return -(1.055 * (-linearValue) ** (1 / 2.4) - 0.055);
    if (linearValue <= 0.0031308) return 12.92 * linearValue;
    return 1.055 * linearValue ** (1 / 2.4) - 0.055;
  },
};

// H.273 8.2 values for the BT.709 / BT.601 / BT.2020 OETF family.
const rec709Alpha = 1.099296826809442;
const rec709Beta = 0.018053968510807;
const rec709: ColorTransferFunction = {
  toLinear(encoded) {
    const v = clamp01(encoded);
    return v < 4.5 * rec709Beta ? v / 4.5 : ((v + rec709Alpha - 1) / rec709Alpha) ** (1 / 0.45);
  },
  fromLinear(linear) {
    const v = clamp01(linear);
    return v < rec709Beta ? 4.5 * v : rec709Alpha * v ** 0.45 - (rec709Alpha - 1);
  },
};

// H.273 transfer codes 11 and 12 retain negative encoded values. Their OETFs
// are the extended-range forms of the Rec. 709 curve and BT.1361 curve.
const extendedYcc: ColorTransferFunction = {
  toLinear(encoded) {
    const linearThreshold = 4.5 * rec709Beta;
    if (encoded >= linearThreshold)
      return ((encoded + rec709Alpha - 1) / rec709Alpha) ** (1 / 0.45);
    if (encoded <= -linearThreshold)
      return -(((rec709Alpha - 1 - encoded) / rec709Alpha) ** (1 / 0.45));
    return encoded / 4.5;
  },
  fromLinear(linearValue) {
    if (linearValue >= rec709Beta) return rec709Alpha * linearValue ** 0.45 - (rec709Alpha - 1);
    if (linearValue <= -rec709Beta)
      return -rec709Alpha * (-linearValue) ** 0.45 + (rec709Alpha - 1);
    return 4.5 * linearValue;
  },
};

const bt1361Alpha = 1.099;
const bt1361Beta = 0.018;
const bt1361Gamma = 0.0045;
const bt1361: ColorTransferFunction = {
  toLinear(encoded) {
    if (encoded >= 4.5 * bt1361Beta)
      return ((encoded + bt1361Alpha - 1) / bt1361Alpha) ** (1 / 0.45);
    if (encoded >= -4.5 * bt1361Gamma) return encoded / 4.5;
    return -0.25 * ((-4 * encoded + bt1361Alpha - 1) / bt1361Alpha) ** (1 / 0.45);
  },
  fromLinear(linearValue) {
    if (linearValue >= bt1361Beta) return bt1361Alpha * linearValue ** 0.45 - (bt1361Alpha - 1);
    if (linearValue >= -bt1361Gamma) return 4.5 * linearValue;
    return -(bt1361Alpha * (-4 * linearValue) ** 0.45 - (bt1361Alpha - 1)) / 4;
  },
};

const linear: ColorTransferFunction = {
  toLinear: clamp01,
  fromLinear: clamp01,
};

const gamma22: ColorTransferFunction = {
  toLinear(encoded) {
    return clamp01(encoded) ** 2.2;
  },
  fromLinear(linearValue) {
    return clamp01(linearValue) ** (1 / 2.2);
  },
};

const gamma28: ColorTransferFunction = {
  toLinear(encoded) {
    return clamp01(encoded) ** 2.8;
  },
  fromLinear(linearValue) {
    return clamp01(linearValue) ** (1 / 2.8);
  },
};

const smpte240mAlpha = 1.111572195921731;
const smpte240mBeta = 0.022821585529445028;
const smpte240m: ColorTransferFunction = {
  toLinear(encoded) {
    const v = clamp01(encoded);
    return v < 4 * smpte240mBeta
      ? v / 4
      : ((v + smpte240mAlpha - 1) / smpte240mAlpha) ** (1 / 0.45);
  },
  fromLinear(linearValue) {
    const v = clamp01(linearValue);
    return v < smpte240mBeta ? 4 * v : smpte240mAlpha * v ** 0.45 - (smpte240mAlpha - 1);
  },
};

const log100: ColorTransferFunction = {
  toLinear(encoded) {
    const v = clamp01(encoded);
    return v <= 0 ? 0 : 10 ** (2 * (v - 1));
  },
  fromLinear(linearValue) {
    const v = clamp01(linearValue);
    return v < 0.01 ? 0 : 1 + Math.log10(v) / 2;
  },
};

const log100Sqrt10: ColorTransferFunction = {
  toLinear(encoded) {
    const v = clamp01(encoded);
    return v <= 0 ? 0 : 10 ** (2.5 * (v - 1));
  },
  fromLinear(linearValue) {
    const v = clamp01(linearValue);
    return v < Math.sqrt(10) / 1000 ? 0 : 1 + Math.log10(v) / 2.5;
  },
};

const smpteSt428: ColorTransferFunction = {
  toLinear(encoded) {
    return (52.37 / 48) * clamp01(encoded) ** 2.6;
  },
  fromLinear(linearValue) {
    return Math.min(1, (48 / 52.37) ** (1 / 2.6) * Math.max(0, linearValue) ** (1 / 2.6));
  },
};

const pq: ColorTransferFunction = {
  toLinear(encoded) {
    const v = clamp01(encoded),
      n = v ** (1 / (2523 / 32)),
      m1 = 2610 / 16384;
    return (Math.max(n - 3424 / 4096, 0) / (2413 / 128 - (2392 / 128) * n)) ** (1 / m1);
  },
  fromLinear(linearValue) {
    const v = clamp01(linearValue),
      n = v ** (2610 / 16384);
    return ((3424 / 4096 + (2413 / 128) * n) / (1 + (2392 / 128) * n)) ** (2523 / 32);
  },
};

const hlg: ColorTransferFunction = {
  toLinear(encoded) {
    const v = clamp01(encoded),
      a = 0.17883277,
      b = 1 - 4 * a,
      c = 0.5 - a * Math.log(4 * a);
    return v <= 0.5 ? (v * v) / 3 : (Math.exp((v - c) / a) + b) / 12;
  },
  fromLinear(linearValue) {
    const v = clamp01(linearValue),
      a = 0.17883277,
      b = 1 - 4 * a,
      c = 0.5 - a * Math.log(4 * a);
    return v <= 1 / 12 ? Math.sqrt(3 * v) : a * Math.log(12 * v - b) + c;
  },
};

/**
 * H.273 transfer characteristics supported by color conversion and HDR output.
 * Code point 2 follows this library's existing sRGB application default.
 */
export function getColorTransferFunction(code: number): ColorTransferFunction | null {
  if (code === 2) return srgb;
  if (code === 13) return srgbExtended;
  if (code === 1 || code === 6 || code === 14 || code === 15) return rec709;
  if (code === 11) return extendedYcc;
  if (code === 12) return bt1361;
  if (code === 8) return linear;
  if (code === 4) return gamma22;
  if (code === 5) return gamma28;
  if (code === 7) return smpte240m;
  if (code === 9) return log100;
  if (code === 10) return log100Sqrt10;
  if (code === 16) return pq;
  if (code === 17) return smpteSt428;
  if (code === 18) return hlg;
  return null;
}
