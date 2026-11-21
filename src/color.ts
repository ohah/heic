/** YCbCr 4:2:0 to RGBA conversion with supported H.273 matrices. */

import type { HeifImageBitDepth } from './bit-depth.js';
import {
  decodeBT2020ConstantLuminance,
  decodeIPTC2,
  decodeICtCp,
  decodeSMPTE2085,
  decodeYCgCo,
  decodeYCgCoReRo,
  getYCbCrMatrixCoefficients,
} from './color-matrix.js';

export interface ColorOptions {
  bitDepth?: HeifImageBitDepth;
  /** Chroma sample depth when it differs from luma. Defaults to `bitDepth`. */
  bitDepthChroma?: HeifImageBitDepth;

  /**
   * VUI matrix_coeffs; 1 = BT.709, 4 = FCC, 5/6 = BT.601, 7 = SMPTE 240M,
   * 9 = BT.2020 NCL, 10 = BT.2020 constant luminance, 12/13 = chromaticity-derived
   * NCL/CL, 14 = BT.2100 ICtCp, and 16/17 = YCgCo-Re/Ro. Unspecified (2) uses BT.601.
   * Defaults to BT.601.
   */
  matrixCoeffs?: number;
  /** H.273 colour_primaries, used by matrix_coeffs 12 and 13. */
  colorPrimaries?: number;
  /** VUI transfer_characteristics, used by constant-luminance and ICtCp matrices. */
  transferCharacteristics?: number;
  fullRange?: boolean;
}

function imagePixelCount(width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    throw new RangeError('heic: image dimensions must be positive integers');

  const pixels = width * height;
  if (!Number.isSafeInteger(pixels)) throw new RangeError('heic: image dimensions are too large');
  return pixels;
}

/**
 * Convert planar YUV420 (chroma at half resolution, nearest-sample upsample)
 * into RGBA8888.
 */
export function yuv420ToRgba(
  y: Uint8Array | Uint16Array,
  cb: Uint8Array | Uint16Array,
  cr: Uint8Array | Uint16Array,
  width: number,
  height: number,
  options: ColorOptions = {},
): Uint8Array {
  const pixels = imagePixelCount(width, height);
  const cw = Math.ceil(width / 2);
  const ch = Math.ceil(height / 2);
  if (y.length < pixels || cb.length < cw * ch || cr.length < cw * ch)
    throw new RangeError('heic: YUV planes are smaller than the requested image dimensions');

  const bitDepth = options.bitDepth ?? 8;
  const bitDepthChroma = options.bitDepthChroma ?? bitDepth;
  const factor = 2 ** (bitDepth - 8);
  const chromaFactor = 2 ** (bitDepthChroma - 8);
  const matrix = options.matrixCoeffs ?? 6;
  const fullRange = options.fullRange ?? true;
  const coefficients = getYCbCrMatrixCoefficients(matrix, options.colorPrimaries);
  if (
    !coefficients &&
    matrix !== 8 &&
    matrix !== 10 &&
    matrix !== 11 &&
    matrix !== 12 &&
    matrix !== 13 &&
    matrix !== 14 &&
    matrix !== 15 &&
    matrix !== 16 &&
    matrix !== 17
  )
    throw new RangeError(`heic: unsupported YCbCr matrix ${matrix}`);
  if ((matrix === 12 || matrix === 13) && !coefficients)
    throw new RangeError(`heic: matrix_coeffs ${matrix} requires supported colour_primaries`);
  if (matrix === 8 && bitDepthChroma !== bitDepth && bitDepthChroma !== bitDepth + 1)
    throw new RangeError('heic: YCgCo requires equal or one-bit-higher chroma depth');
  if ((matrix === 16 || matrix === 17) && !fullRange && bitDepth - (matrix === 16 ? 2 : 1) < 8)
    throw new RangeError(`heic: limited-range matrix_coeffs ${matrix} requires BitDepthRGB >= 8`);
  const { kr, kb } =
    coefficients ?? (matrix === 10 ? { kr: 0.2627, kb: 0.0593 } : { kr: 0.299, kb: 0.114 });
  const crR = 2 * (1 - kr);
  const cbB = 2 * (1 - kb);
  const crG = (2 * kr * (1 - kr)) / (1 - kr - kb);
  const cbG = (2 * kb * (1 - kb)) / (1 - kr - kb);

  // Limited range expands 16..235 (luma) / 16..240 (chroma) to 0..255.
  const yScale = fullRange ? 255 / (2 ** bitDepth - 1) : 255 / (219 * factor);
  const cScale = fullRange ? 255 / (2 ** bitDepthChroma - 1) : 255 / (224 * chromaFactor);
  const yOffset = fullRange ? 0 : 16 * factor;

  const out = new Uint8Array(pixels * 4);
  let o = 0;
  for (let py = 0; py < height; py++) {
    const cRow = (py >> 1) * cw;
    const yRow = py * width;
    for (let px = 0; px < width; px++) {
      const lum = (y[yRow + px] - yOffset) * yScale;
      const cIdx = cRow + (px >> 1);
      if (matrix === 8) {
        const rgb = decodeYCgCo(
          y[yRow + px],
          cb[cIdx],
          cr[cIdx],
          bitDepth,
          bitDepthChroma,
          255,
          fullRange,
        );
        if (!rgb) throw new RangeError('heic: unsupported YCgCo bit-depth combination');
        out[o] = (rgb[0] + 0.5) | 0;
        out[o + 1] = (rgb[1] + 0.5) | 0;
        out[o + 2] = (rgb[2] + 0.5) | 0;
        out[o + 3] = 255;
        o += 4;
        continue;
      }
      if (matrix === 16 || matrix === 17) {
        const rgb = decodeYCgCoReRo(
          y[yRow + px],
          cb[cIdx],
          cr[cIdx],
          bitDepth,
          bitDepthChroma,
          matrix === 16 ? 2 : 1,
          255,
          fullRange,
        );
        if (!rgb)
          throw new RangeError(
            `heic: unsupported bit-depth combination for matrix_coeffs ${matrix}`,
          );
        out[o] = (rgb[0] + 0.5) | 0;
        out[o + 1] = (rgb[1] + 0.5) | 0;
        out[o + 2] = (rgb[2] + 0.5) | 0;
        out[o + 3] = 255;
        o += 4;
        continue;
      }
      if (matrix === 10 || matrix === 13) {
        const rgb = decodeBT2020ConstantLuminance(
          y[yRow + px],
          cb[cIdx],
          cr[cIdx],
          bitDepth,
          bitDepthChroma,
          options.transferCharacteristics ?? 2,
          255,
          fullRange,
          kr,
          kb,
        );
        if (!rgb)
          throw new RangeError(
            `heic: unsupported transfer_characteristics for matrix_coeffs ${matrix} constant luminance`,
          );
        out[o] = Math.max(0, Math.min(255, (rgb[0] + 0.5) | 0));
        out[o + 1] = Math.max(0, Math.min(255, (rgb[1] + 0.5) | 0));
        out[o + 2] = Math.max(0, Math.min(255, (rgb[2] + 0.5) | 0));
        out[o + 3] = 255;
        o += 4;
        continue;
      }
      if (matrix === 14) {
        const rgb = decodeICtCp(
          y[yRow + px],
          cb[cIdx],
          cr[cIdx],
          bitDepth,
          bitDepthChroma,
          options.transferCharacteristics ?? 2,
          255,
          fullRange,
        );
        if (!rgb)
          throw new RangeError(
            'heic: matrix_coeffs 14 requires PQ or HLG transfer characteristics',
          );
        out[o] = Math.max(0, Math.min(255, (rgb[0] + 0.5) | 0));
        out[o + 1] = Math.max(0, Math.min(255, (rgb[1] + 0.5) | 0));
        out[o + 2] = Math.max(0, Math.min(255, (rgb[2] + 0.5) | 0));
        out[o + 3] = 255;
        o += 4;
        continue;
      }
      if (matrix === 11) {
        const xyz = decodeSMPTE2085(
          y[yRow + px],
          cb[cIdx],
          cr[cIdx],
          bitDepth,
          bitDepthChroma,
          255,
          fullRange,
        );
        out[o] = Math.max(0, Math.min(255, (xyz[0] + 0.5) | 0));
        out[o + 1] = Math.max(0, Math.min(255, (xyz[1] + 0.5) | 0));
        out[o + 2] = Math.max(0, Math.min(255, (xyz[2] + 0.5) | 0));
        out[o + 3] = 255;
        o += 4;
        continue;
      }
      if (matrix === 15) {
        const rgb = decodeIPTC2(
          y[yRow + px],
          cb[cIdx],
          cr[cIdx],
          bitDepth,
          bitDepthChroma,
          options.transferCharacteristics ?? 2,
          255,
          fullRange,
        );
        if (!rgb)
          throw new RangeError('heic: matrix_coeffs 15 uses unsupported transfer_characteristics');
        out[o] = Math.max(0, Math.min(255, (rgb[0] + 0.5) | 0));
        out[o + 1] = Math.max(0, Math.min(255, (rgb[1] + 0.5) | 0));
        out[o + 2] = Math.max(0, Math.min(255, (rgb[2] + 0.5) | 0));
        out[o + 3] = 255;
        o += 4;
        continue;
      }
      const u = (cb[cIdx] - 128 * chromaFactor) * cScale;
      const v = (cr[cIdx] - 128 * chromaFactor) * cScale;

      const r = lum + crR * v;
      const g = lum - cbG * u - crG * v;
      const b = lum + cbB * u;
      out[o] = r < 0 ? 0 : r > 255 ? 255 : (r + 0.5) | 0;
      out[o + 1] = g < 0 ? 0 : g > 255 ? 255 : (g + 0.5) | 0;
      out[o + 2] = b < 0 ? 0 : b > 255 ? 255 : (b + 0.5) | 0;
      out[o + 3] = 255;
      o += 4;
    }
  }
  return out;
}

export interface OrientedImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/**
 * Apply the HEIF display transforms: `irot` (90-degree counter-clockwise
 * rotation count) followed by `imir` (0 = mirror about a vertical axis,
 * 1 = about a horizontal axis).
 */
export function applyOrientation(
  rgba: Uint8Array,
  width: number,
  height: number,
  rotation: number,
  mirror: number | null,
): OrientedImage {
  const pixels = imagePixelCount(width, height);
  if (rgba.length < pixels * 4)
    throw new RangeError('heic: RGBA buffer is smaller than the requested image dimensions');
  if (!Number.isInteger(rotation))
    throw new RangeError('heic: rotation must be an integer number of quarter turns');
  if (mirror !== null && mirror !== 0 && mirror !== 1)
    throw new RangeError('heic: mirror must be 0, 1, or null');

  let data = rgba;
  let w = width;
  let h = height;
  const rot = ((rotation % 4) + 4) % 4;

  if (rot !== 0) {
    const dw = rot % 2 === 0 ? w : h;
    const dh = rot % 2 === 0 ? h : w;
    const out = new Uint8Array(dw * dh * 4);
    for (let dy = 0; dy < dh; dy++) {
      for (let dx = 0; dx < dw; dx++) {
        let sx: number;
        let sy: number;
        if (rot === 1) {
          // 90 CCW: dst(x,y) <- src(w-1-y, x)
          sx = w - 1 - dy;
          sy = dx;
        } else if (rot === 2) {
          sx = w - 1 - dx;
          sy = h - 1 - dy;
        } else {
          // 270 CCW (= 90 CW): dst(x,y) <- src(y, h-1-x)
          sx = dy;
          sy = h - 1 - dx;
        }
        const s = (sy * w + sx) * 4;
        const d = (dy * dw + dx) * 4;
        out[d] = data[s];
        out[d + 1] = data[s + 1];
        out[d + 2] = data[s + 2];
        out[d + 3] = data[s + 3];
      }
    }
    data = out;
    w = dw;
    h = dh;
  }

  if (mirror !== null && mirror !== undefined) {
    const out = new Uint8Array(w * h * 4);
    for (let yPos = 0; yPos < h; yPos++) {
      for (let xPos = 0; xPos < w; xPos++) {
        const sx = mirror === 0 ? w - 1 - xPos : xPos;
        const sy = mirror === 0 ? yPos : h - 1 - yPos;
        const s = (sy * w + sx) * 4;
        const d = (yPos * w + xPos) * 4;
        out[d] = data[s];
        out[d + 1] = data[s + 1];
        out[d + 2] = data[s + 2];
        out[d + 3] = data[s + 3];
      }
    }
    data = out;
  }

  return { data, width: w, height: h };
}
