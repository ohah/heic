import { describe, expect, it } from 'bun:test';
import { applyOrientation, yuv420ToRgba } from '../src/color';
import {
  getRgbLumaCoefficients,
  getRgbToXyzD65Matrix,
  getYCbCrMatrixCoefficients,
} from '../src/color-matrix';
import { getColorTransferFunction } from '../src/color-transfer';
import { multiply3, SRGB_FROM_XYZ } from '../src/icc';

it('matches H.273 Table 3 for BT.709/BT.601/BT.2020 and linear transfer codes', () => {
  const beta = 0.018053968510807;
  for (const code of [1, 6, 14, 15]) {
    const transfer = getColorTransferFunction(code);
    expect(transfer).not.toBeNull();
    expect(transfer!.toLinear(4.5 * beta)).toBeCloseTo(beta, 12);
    expect(transfer!.toLinear(1)).toBeCloseTo(1, 12);
    expect(transfer!.fromLinear(beta)).toBeCloseTo(4.5 * beta, 12);
    expect(transfer!.fromLinear(1)).toBeCloseTo(1, 12);
  }

  const linear = getColorTransferFunction(8);
  expect(linear).not.toBeNull();
  for (const value of [0, 0.125, 0.5, 1]) {
    expect(linear!.toLinear(value)).toBe(value);
    expect(linear!.fromLinear(value)).toBe(value);
  }

  for (const reserved of [0, 3, 19, 255]) expect(getColorTransferFunction(reserved)).toBeNull();
});

function ictcpCodeValues(
  rgb: [number, number, number],
  transfer: 16 | 18,
  bitDepth: number,
  fullRange: boolean,
): [number, number, number] {
  const a = 0.17883277,
    b = 1 - 4 * a,
    c = 0.5 - a * Math.log(4 * a),
    toLinear = (encoded: number) => {
      if (transfer === 18)
        return encoded <= 0.5 ? (encoded * encoded) / 3 : (Math.exp((encoded - c) / a) + b) / 12;
      const n = encoded ** (1 / (2523 / 32));
      return (
        (Math.max(n - 3424 / 4096, 0) / (2413 / 128 - (2392 / 128) * n)) ** (1 / (2610 / 16384))
      );
    },
    fromLinear = (linear: number) => {
      if (transfer === 18)
        return linear <= 1 / 12 ? Math.sqrt(3 * linear) : a * Math.log(12 * linear - b) + c;
      const n = linear ** (2610 / 16384);
      return ((3424 / 4096 + (2413 / 128) * n) / (1 + (2392 / 128) * n)) ** (2523 / 32);
    },
    [r, g, blue] = rgb.map(toLinear),
    l = (1688 * r + 2146 * g + 262 * blue) / 4096,
    m = (683 * r + 2951 * g + 462 * blue) / 4096,
    s = (99 * r + 309 * g + 3688 * blue) / 4096,
    lp = fromLinear(l),
    mp = fromLinear(m),
    sp = fromLinear(s),
    intensity = (lp + mp) / 2,
    ct =
      (transfer === 18 ? 3625 * lp - 7465 * mp + 3840 * sp : 6610 * lp - 13613 * mp + 7003 * sp) /
      4096,
    cp =
      (transfer === 18 ? 9500 * lp - 9212 * mp - 288 * sp : 17933 * lp - 17390 * mp - 543 * sp) /
      4096,
    max = 2 ** bitDepth - 1,
    scale = 2 ** (bitDepth - 8);
  return fullRange
    ? [
        Math.round(intensity * max),
        Math.round(ct * max + 2 ** (bitDepth - 1)),
        Math.round(cp * max + 2 ** (bitDepth - 1)),
      ]
    : [
        Math.round(16 * scale + intensity * 219 * scale),
        Math.round(128 * scale + ct * 224 * scale),
        Math.round(128 * scale + cp * 224 * scale),
      ];
}

function h273MatrixCodes(
  rgb: [number, number, number],
  matrix: 10 | 12 | 13,
  primaries: number,
  transferCharacteristics: number,
  bitDepth: number,
  fullRange: boolean,
): [number, number, number] {
  const coefficients =
    matrix === 10 ? { kr: 0.2627, kb: 0.0593 } : getYCbCrMatrixCoefficients(matrix, primaries);
  if (!coefficients) throw new Error('expected supported test colour primaries');
  const { kr, kb } = coefficients,
    kg = 1 - kr - kb;
  let y: number, cb: number, cr: number;
  if (matrix === 12) {
    y = kr * rgb[0] + kg * rgb[1] + kb * rgb[2];
    cb = (rgb[2] - y) / (2 * (1 - kb));
    cr = (rgb[0] - y) / (2 * (1 - kr));
  } else {
    const transfer = getColorTransferFunction(transferCharacteristics);
    if (!transfer) throw new Error('expected supported test transfer characteristics');
    const linearY =
      kr * transfer.toLinear(rgb[0]) +
      kg * transfer.toLinear(rgb[1]) +
      kb * transfer.toLinear(rgb[2]);
    y = transfer.fromLinear(linearY);
    const nb = transfer.fromLinear(1 - kb),
      pb = 1 - transfer.fromLinear(kb),
      nr = transfer.fromLinear(1 - kr),
      pr = 1 - transfer.fromLinear(kr);
    cb = (rgb[2] - y) / (2 * (rgb[2] < y ? nb : pb));
    cr = (rgb[0] - y) / (2 * (rgb[0] < y ? nr : pr));
  }
  const scale = 2 ** (bitDepth - 8),
    max = 2 ** bitDepth - 1;
  return fullRange
    ? [
        Math.round(y * max),
        Math.round(cb * max + 2 ** (bitDepth - 1)),
        Math.round(cr * max + 2 ** (bitDepth - 1)),
      ]
    : [
        Math.round(16 * scale + 219 * scale * y),
        Math.round(128 * scale + 224 * scale * cb),
        Math.round(128 * scale + 224 * scale * cr),
      ];
}

function smpte2085Codes(
  rgb: [number, number, number],
  bitDepth: number,
  fullRange: boolean,
): [number, number, number] {
  const y = rgb[1],
    dz = (0.986566 * rgb[2] - y) / 2,
    dx = (rgb[0] - 0.991902 * y) / 2,
    scale = 2 ** (bitDepth - 8),
    max = 2 ** bitDepth - 1;
  return fullRange
    ? [
        Math.round(y * max),
        Math.round(dz * max + 2 ** (bitDepth - 1)),
        Math.round(dx * max + 2 ** (bitDepth - 1)),
      ]
    : [
        Math.round(16 * scale + y * 219 * scale),
        Math.round(128 * scale + dz * 224 * scale),
        Math.round(128 * scale + dx * 224 * scale),
      ];
}

function iptC2Codes(
  rgb: [number, number, number],
  transferCharacteristics: number,
  bitDepth: number,
  fullRange: boolean,
): [number, number, number] {
  const transfer = getColorTransferFunction(transferCharacteristics);
  if (!transfer) throw new Error('expected supported test transfer characteristics');
  const [r, g, b] = rgb.map((value) => transfer.toLinear(value)),
    l = (1747 * r + 2169 * g + 180 * b) / 4096,
    m = (673 * r + 3029 * g + 394 * b) / 4096,
    s = (50 * r + 207 * g + 3839 * b) / 4096,
    lp = transfer.fromLinear(l),
    mp = transfer.fromLinear(m),
    sp = transfer.fromLinear(s),
    intensity = (1638 * lp + 1638 * mp + 820 * sp) / 4096,
    p = (18248 * lp - 19870 * mp + 1622 * sp) / 4096,
    t = (3300 * lp + 1463 * mp - 4763 * sp) / 4096,
    scale = 2 ** (bitDepth - 8),
    max = 2 ** bitDepth - 1;
  return fullRange
    ? [
        Math.round(intensity * max),
        Math.round(p * max + 2 ** (bitDepth - 1)),
        Math.round(t * max + 2 ** (bitDepth - 1)),
      ]
    : [
        Math.round(16 * scale + intensity * 219 * scale),
        Math.round(128 * scale + p * 224 * scale),
        Math.round(128 * scale + t * 224 * scale),
      ];
}

describe('yuv420ToRgba', () => {
  it('uses ceil-divided chroma planes for odd image dimensions', () => {
    const y = new Uint8Array([10, 20, 30, 40, 50, 60, 70, 80, 90]);
    const neutralChroma = new Uint8Array(4).fill(128);
    const rgba = yuv420ToRgba(y, neutralChroma, neutralChroma, 3, 3);

    for (let i = 0; i < y.length; i++)
      expect(Array.from(rgba.subarray(i * 4, i * 4 + 4))).toEqual([y[i], y[i], y[i], 255]);
  });

  it('uses the H.273 FCC and SMPTE 240M matrix coefficients', () => {
    const y = new Uint8Array([128]);
    const cb = new Uint8Array([180]);
    const cr = new Uint8Array([128]);

    expect(Array.from(yuv420ToRgba(y, cb, cr, 1, 1, { matrixCoeffs: 4, fullRange: true }))).toEqual(
      [128, 111, 221, 255],
    );
    expect(Array.from(yuv420ToRgba(y, cb, cr, 1, 1, { matrixCoeffs: 7, fullRange: true }))).toEqual(
      [128, 116, 223, 255],
    );
  });

  it('derives H.273 chromaticity coefficients and decodes matrix codes 12 and 13', () => {
    const bt2020 = getYCbCrMatrixCoefficients(12, 9)!;
    expect(bt2020.kr).toBeCloseTo(0.2627, 3);
    expect(bt2020.kb).toBeCloseTo(0.0593, 3);

    const rgb: [number, number, number] = [0.72, 0.38, 0.16];
    for (const matrix of [12, 13] as const)
      for (const fullRange of [true, false]) {
        const transferCharacteristics = matrix === 13 ? 14 : 13,
          [y, cb, cr] = h273MatrixCodes(rgb, matrix, 4, transferCharacteristics, 12, fullRange),
          decoded = yuv420ToRgba(
            new Uint16Array([y]),
            new Uint16Array([cb]),
            new Uint16Array([cr]),
            1,
            1,
            {
              bitDepth: 12,
              matrixCoeffs: matrix,
              colorPrimaries: 4,
              transferCharacteristics,
              fullRange,
            },
          );
        for (let channel = 0; channel < 3; channel++)
          expect(Math.abs(decoded[channel] - Math.round(rgb[channel] * 255))).toBeLessThanOrEqual(
            2,
          );
      }

    expect(() =>
      yuv420ToRgba(new Uint8Array([128]), new Uint8Array([128]), new Uint8Array([128]), 1, 1, {
        matrixCoeffs: 12,
        colorPrimaries: 2,
      }),
    ).toThrow('matrix_coeffs 12 requires supported colour_primaries');
  });

  it('decodes BT.2020 constant-luminance samples with the sign-specific inverse', () => {
    expect(
      Array.from(
        yuv420ToRgba(new Uint8Array([122]), new Uint8Array([80]), new Uint8Array([206]), 1, 1, {
          matrixCoeffs: 10,
          transferCharacteristics: 14,
          fullRange: true,
        }),
      ),
    ).toEqual([200, 80, 29, 255]);
  });

  it('uses the BT.2020 constant-luminance transfer function for range expansion and inversion', () => {
    const decode = (
      y: number,
      cb: number,
      cr: number,
      transferCharacteristics: number,
      fullRange: boolean,
    ) =>
      Array.from(
        yuv420ToRgba(new Uint8Array([y]), new Uint8Array([cb]), new Uint8Array([cr]), 1, 1, {
          matrixCoeffs: 10,
          transferCharacteristics,
          fullRange,
        }).subarray(0, 3),
      );
    expect(decode(121, 86, 197, 14, false)).toEqual([200, 80, 29]);
    expect(decode(171, 68, 244, 16, true)).toEqual([204, 127, 52]);
    expect(decode(161, 72, 214, 18, true)).toEqual([204, 128, 50]);
    for (const transfer of [11, 12])
      expect(decode(122, 80, 206, transfer, true).every(Number.isFinite)).toBe(true);
    expect(() => decode(122, 80, 206, 3, true)).toThrow(
      'unsupported transfer_characteristics for matrix_coeffs 10 constant luminance',
    );
  });

  it('decodes constant-luminance matrices with every defined H.273 transfer curve', () => {
    const rgb: [number, number, number] = [0.72, 0.38, 0.16];
    const definedTransfers = [1, ...Array.from({ length: 15 }, (_, index) => index + 4)];
    for (const matrix of [10, 13] as const)
      for (const transferCharacteristics of definedTransfers)
        for (const fullRange of [true, false]) {
          const [y, cb, cr] = h273MatrixCodes(
              rgb,
              matrix,
              9,
              transferCharacteristics,
              12,
              fullRange,
            ),
            decoded = yuv420ToRgba(
              new Uint16Array([y]),
              new Uint16Array([cb]),
              new Uint16Array([cr]),
              1,
              1,
              {
                bitDepth: 12,
                matrixCoeffs: matrix,
                colorPrimaries: 9,
                transferCharacteristics,
                fullRange,
              },
            );
          for (let channel = 0; channel < 3; channel++)
            expect(Math.abs(decoded[channel] - Math.round(rgb[channel] * 255))).toBeLessThanOrEqual(
              2,
            );
        }
  });

  it('preserves H.273 extended sRGB values while solving BT.2020 constant luminance', () => {
    const y = new Uint8Array([128]),
      cb = new Uint8Array([128]),
      cr = new Uint8Array([0]);
    const sRGB = yuv420ToRgba(y, cb, cr, 1, 1, {
      matrixCoeffs: 10,
      transferCharacteristics: 2,
      fullRange: true,
    });
    const extendedSRGB = yuv420ToRgba(y, cb, cr, 1, 1, {
      matrixCoeffs: 10,
      transferCharacteristics: 13,
      fullRange: true,
    });
    expect(Array.from(sRGB.subarray(0, 3))).toEqual([0, 149, 128]);
    expect(Array.from(extendedSRGB.subarray(0, 3))).toEqual([0, 159, 128]);
  });

  it('decodes BT.2100 ICtCp PQ and HLG full- and limited-range samples', () => {
    const sourceColors: [number, number, number][] = [
      [0.8, 0.35, 0.1],
      [0.2, 0.7, 0.9],
    ];
    for (const transferCharacteristics of [16, 18] as const)
      for (const fullRange of [true, false])
        for (const rgb of sourceColors) {
          const [y, ct, cp] = ictcpCodeValues(rgb, transferCharacteristics, 12, fullRange),
            decoded = yuv420ToRgba(
              new Uint16Array([y]),
              new Uint16Array([ct]),
              new Uint16Array([cp]),
              1,
              1,
              {
                bitDepth: 12,
                matrixCoeffs: 14,
                transferCharacteristics,
                fullRange,
              },
            );
          for (let channel = 0; channel < 3; channel++)
            expect(Math.abs(decoded[channel] - Math.round(rgb[channel] * 255))).toBeLessThanOrEqual(
              2,
            );
        }
    expect(() =>
      yuv420ToRgba(new Uint8Array([128]), new Uint8Array([128]), new Uint8Array([128]), 1, 1, {
        matrixCoeffs: 14,
        transferCharacteristics: 2,
      }),
    ).toThrow('matrix_coeffs 14 requires PQ or HLG transfer characteristics');
  });

  it('decodes SMPTE ST 2085 and IPT-C2 full- and limited-range samples', () => {
    const rgb: [number, number, number] = [0.72, 0.38, 0.16];
    for (const fullRange of [true, false]) {
      const [y, dz, dx] = smpte2085Codes(rgb, 12, fullRange),
        decoded = yuv420ToRgba(
          new Uint16Array([y]),
          new Uint16Array([dz]),
          new Uint16Array([dx]),
          1,
          1,
          { bitDepth: 12, matrixCoeffs: 11, fullRange },
        );
      for (let channel = 0; channel < 3; channel++)
        expect(Math.abs(decoded[channel] - Math.round(rgb[channel] * 255))).toBeLessThanOrEqual(1);
    }

    for (const transferCharacteristics of [16, 18] as const)
      for (const fullRange of [true, false]) {
        const [y, p, t] = iptC2Codes(rgb, transferCharacteristics, 12, fullRange),
          decoded = yuv420ToRgba(
            new Uint16Array([y]),
            new Uint16Array([p]),
            new Uint16Array([t]),
            1,
            1,
            {
              bitDepth: 12,
              matrixCoeffs: 15,
              transferCharacteristics,
              fullRange,
            },
          );
        for (let channel = 0; channel < 3; channel++)
          expect(Math.abs(decoded[channel] - Math.round(rgb[channel] * 255))).toBeLessThanOrEqual(
            2,
          );
      }
    expect(() =>
      yuv420ToRgba(new Uint8Array([128]), new Uint8Array([128]), new Uint8Array([128]), 1, 1, {
        matrixCoeffs: 15,
        transferCharacteristics: 3,
      }),
    ).toThrow('matrix_coeffs 15 uses unsupported transfer_characteristics');
  });

  it('decodes full-range YCgCo and YCgCo-R samples', () => {
    const y = new Uint8Array([100]);
    expect(
      Array.from(
        yuv420ToRgba(y, new Uint8Array([148]), new Uint8Array([118]), 1, 1, {
          matrixCoeffs: 8,
          fullRange: true,
        }),
      ),
    ).toEqual([70, 120, 90, 255]);
    expect(
      Array.from(
        yuv420ToRgba(y, new Uint16Array([276]), new Uint16Array([236]), 1, 1, {
          matrixCoeffs: 8,
          bitDepth: 8,
          bitDepthChroma: 9,
          fullRange: true,
        }),
      ),
    ).toEqual([80, 110, 100, 255]);
    expect(() =>
      yuv420ToRgba(y, new Uint16Array([276]), new Uint16Array([236]), 1, 1, {
        matrixCoeffs: 8,
        bitDepth: 8,
        bitDepthChroma: 10,
      }),
    ).toThrow('YCgCo requires equal or one-bit-higher chroma depth');
  });

  it('expands limited-range YCgCo RGB values after the inverse transform', () => {
    expect(
      Array.from(
        yuv420ToRgba(new Uint8Array([100]), new Uint8Array([148]), new Uint8Array([118]), 1, 1, {
          matrixCoeffs: 8,
          fullRange: false,
        }),
      ),
    ).toEqual([63, 121, 86, 255]);
  });

  it('decodes YCgCo-Re/Ro with their lower RGB precision and range mapping', () => {
    for (const { matrixCoeffs, y, cb, cr } of [
      { matrixCoeffs: 16, y: 127, cb: 513, cr: 767 },
      { matrixCoeffs: 17, y: 255, cb: 513, cr: 1023 },
    ]) {
      expect(
        Array.from(
          yuv420ToRgba(new Uint16Array([y]), new Uint16Array([cb]), new Uint16Array([cr]), 1, 1, {
            bitDepth: 10,
            bitDepthChroma: 10,
            matrixCoeffs,
            fullRange: true,
          }),
        ),
      ).toEqual([255, 128, 0, 255]);
    }

    for (const { matrixCoeffs, y, cb, cr } of [
      { matrixCoeffs: 16, y: 125, cb: 513, cr: 731 },
      { matrixCoeffs: 17, y: 251, cb: 513, cr: 950 },
    ]) {
      expect(
        Array.from(
          yuv420ToRgba(new Uint16Array([y]), new Uint16Array([cb]), new Uint16Array([cr]), 1, 1, {
            bitDepth: 10,
            bitDepthChroma: 10,
            matrixCoeffs,
            fullRange: false,
          }),
        ),
      ).toEqual([255, 128, 0, 255]);
    }

    expect(() =>
      yuv420ToRgba(new Uint8Array([0]), new Uint8Array([0]), new Uint8Array([0]), 1, 1, {
        matrixCoeffs: 16,
        bitDepth: 8,
        fullRange: false,
      }),
    ).toThrow('limited-range matrix_coeffs 16 requires BitDepthRGB >= 8');
  });

  it('rejects invalid dimensions and undersized planes', () => {
    expect(() => yuv420ToRgba(new Uint8Array(), new Uint8Array(), new Uint8Array(), 0, 1)).toThrow(
      RangeError,
    );
    expect(() =>
      yuv420ToRgba(new Uint8Array(9), new Uint8Array(1), new Uint8Array(1), 3, 3),
    ).toThrow(RangeError);
  });
});

describe('H.273 transfer characteristics', () => {
  it('decodes gamma, SMPTE 240M, and logarithmic transfer curves', () => {
    expect(getColorTransferFunction(4)!.toLinear(0.5)).toBeCloseTo(0.5 ** 2.2, 12);
    expect(getColorTransferFunction(5)!.toLinear(0.5)).toBeCloseTo(0.5 ** 2.8, 12);

    const smpte240m = getColorTransferFunction(7)!,
      smpte240mAlpha = 1.111572195921731,
      smpte240mBeta = 0.022821585529445028;
    expect(smpte240m.toLinear(0.0456)).toBeCloseTo(0.0114, 12);
    expect(smpte240m.toLinear(0.5)).toBeCloseTo(
      ((0.5 + smpte240mAlpha - 1) / smpte240mAlpha) ** (1 / 0.45),
      12,
    );
    expect(smpte240m.fromLinear(0.0114)).toBeCloseTo(0.0456, 12);
    expect(smpte240m.toLinear(4 * smpte240mBeta)).toBeCloseTo(smpte240mBeta, 12);
    expect(smpte240m.fromLinear(smpte240mBeta)).toBeCloseTo(4 * smpte240mBeta, 12);

    const log100 = getColorTransferFunction(9)!;
    expect(log100.toLinear(0.5)).toBeCloseTo(0.1, 12);
    expect(log100.fromLinear(0.01)).toBe(0);
    expect(log100.fromLinear(log100.toLinear(0.25))).toBeCloseTo(0.25, 12);

    const log100Sqrt10 = getColorTransferFunction(10)!;
    expect(log100Sqrt10.toLinear(0.5)).toBeCloseTo(10 ** -1.25, 12);
    expect(log100Sqrt10.fromLinear(Math.sqrt(10) / 1000)).toBeCloseTo(0, 12);
    expect(log100Sqrt10.fromLinear(log100Sqrt10.toLinear(0.25))).toBeCloseTo(0.25, 12);

    const smpteSt428 = getColorTransferFunction(17)!;
    expect(smpteSt428.toLinear(1)).toBeCloseTo(52.37 / 48, 12);
    expect(smpteSt428.fromLinear(52.37 / 48)).toBeCloseTo(1, 12);

    const xvYcc = getColorTransferFunction(11)!;
    for (const value of [-1, -0.018053968510807, 0, 0.018053968510807, 1])
      expect(xvYcc.toLinear(xvYcc.fromLinear(value))).toBeCloseTo(value, 12);
    expect(xvYcc.toLinear(-4.5 * 0.018053968510807)).toBeCloseTo(-0.018053968510807, 12);

    const bt1361 = getColorTransferFunction(12)!;
    for (const value of [-0.25, -0.0045, 0, 0.018, 1, 1.33])
      expect(bt1361.toLinear(bt1361.fromLinear(value))).toBeCloseTo(value, 12);
    expect(bt1361.toLinear(-4.5 * 0.0045)).toBeCloseTo(-0.0045, 12);
  });
});

it('derives linear RGB primaries and D65 conversion matrices from H.273 coordinates', () => {
  const bt2020 = getRgbToXyzD65Matrix(9),
    displayP3 = getRgbToXyzD65Matrix(12),
    xyz = getRgbToXyzD65Matrix(10);
  expect(bt2020).not.toBeNull();
  expect(displayP3).not.toBeNull();
  expect(xyz).not.toBeNull();
  for (const [actual, expected] of [
    [
      bt2020!,
      [
        0.63695805, 0.1446169, 0.16888098, 0.26270021, 0.67799807, 0.05930172, 0, 0.02807269,
        1.06098506,
      ],
    ],
    [
      displayP3!,
      [
        0.48657095, 0.26566769, 0.19821729, 0.22897456, 0.69173852, 0.07928691, 0, 0.04511338,
        1.04394437,
      ],
    ],
  ])
    for (let index = 0; index < expected.length; index++)
      expect(actual[index]).toBeCloseTo(expected[index], 6);
  const lcmsLinearSrgbMatrices: Record<number, number[]> = {
    4: [
      1.48615682, -0.40355492, -0.08260194, -0.02510111, 0.95402467, 0.07107642, -0.027224,
      -0.04409523, 1.07131922,
    ],
    5: [1.04404318, -0.04404321, 0, 0, 1, 0, 0, 0.01179338, 0.98820662],
    6: [
      0.93954206, 0.05018136, 0.01027658, 0.01777222, 0.96579283, 0.01643491, -0.0016216,
      -0.00436975, 1.00599134,
    ],
    8: [
      1.34617591, -0.33919507, -0.00698084, -0.04735102, 1.06605148, -0.01870051, -0.02166498,
      -0.0613131, 1.08297813,
    ],
    9: [
      1.660491, -0.58764114, -0.07284986, -0.12455048, 1.1328999, -0.00834942, -0.01815076,
      -0.1005789, 1.11872971,
    ],
    11: [
      1.15751636, -0.15496238, -0.00255403, -0.04150007, 1.04556787, -0.00406785, -0.01805004,
      -0.07857827, 1.09662831,
    ],
    12: [
      1.22494018, -0.22494018, 0, -0.04205696, 1.04205692, 0, -0.01963755, -0.07863604, 1.09827363,
    ],
    22: [
      1.02525246, -0.02654753, 0.00129508, 0.0193935, 0.94802803, 0.03257848, -0.00176953,
      -0.00144232, 1.00321185,
    ],
  };
  for (const [primaries, expected] of Object.entries(lcmsLinearSrgbMatrices)) {
    const xyzFromRgb = getRgbToXyzD65Matrix(Number(primaries));
    if (!xyzFromRgb) throw new Error(`H.273 primary ${primaries} has no matrix`);
    const actual = multiply3(SRGB_FROM_XYZ, [...xyzFromRgb]);
    for (let index = 0; index < expected.length; index++)
      expect(actual[index]).toBeCloseTo(expected[index], 5);
  }
  const rec709Luma = getRgbLumaCoefficients(1)!;
  expect(rec709Luma[0]).toBeCloseTo(0.2126, 4);
  expect(rec709Luma[1]).toBeCloseTo(0.7152, 4);
  expect(rec709Luma[2]).toBeCloseTo(0.0722, 4);
  expect(getRgbLumaCoefficients(10)).toEqual([0, 1, 0]);
  for (const primaries of [1, 4, 5, 6, 7, 8, 9, 10, 11, 12, 22]) {
    const matrix = getRgbToXyzD65Matrix(primaries),
      luma = getRgbLumaCoefficients(primaries);
    expect(matrix).not.toBeNull();
    expect(matrix!.every(Number.isFinite)).toBe(true);
    expect(luma).not.toBeNull();
    if (primaries !== 10) expect(luma!.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 8);
  }
  for (const reserved of [0, 3, 13, 21, 23, 255]) {
    expect(getRgbToXyzD65Matrix(reserved)).toBeNull();
    expect(getRgbLumaCoefficients(reserved)).toBeNull();
  }
});

describe('applyOrientation', () => {
  const pixels = new Uint8Array([
    1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255, 5, 0, 0, 255, 6, 0, 0, 255,
  ]);

  it('normalizes negative quarter turns', () => {
    const negative = applyOrientation(pixels, 3, 2, -2, null);
    const positive = applyOrientation(pixels, 3, 2, 2, null);
    expect(negative).toEqual(positive);
    expect(Array.from(negative.data.filter((_, i) => i % 4 === 0))).toEqual([6, 5, 4, 3, 2, 1]);
  });

  it('rejects invalid transforms and undersized buffers', () => {
    expect(() => applyOrientation(new Uint8Array(4), 2, 2, 0, null)).toThrow(RangeError);
    expect(() => applyOrientation(pixels, 3, 2, 0.5, null)).toThrow(RangeError);
    expect(() => applyOrientation(pixels, 3, 2, 0, 2)).toThrow(RangeError);
  });
});
