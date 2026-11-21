/**
 * Inverse transforms and dequantization (8.6).
 *
 * The DCT matrices are generated rather than hardcoded: even rows of T_N are
 * rows of T_{N/2} mirrored per the DCT-II symmetry, and odd rows fold the
 * angle k*(2n+1) into the quarter-wave tables below — reproducing the exact
 * hand-tuned integer values of the spec (the tables ARE those values).
 */

/** Quarter-wave odd-row values for each transform size. */
const ODD4 = [83, 36];
const ODD8 = [89, 75, 50, 18];
const ODD16 = [90, 87, 80, 70, 57, 43, 25, 9];
const ODD32 = [90, 90, 88, 85, 82, 78, 73, 67, 61, 54, 46, 38, 31, 22, 13, 4];

function buildDctMatrix(size: number): Int32Array {
  if (size === 2) return new Int32Array([64, 64, 64, -64]);

  const half = buildDctMatrix(size >> 1);
  const odd = size === 4 ? ODD4 : size === 8 ? ODD8 : size === 16 ? ODD16 : ODD32;
  const out = new Int32Array(size * size);

  for (let k = 0; k < size >> 1; k++) {
    for (let n = 0; n < size >> 1; n++) {
      const v = half[k * (size >> 1) + n];
      out[2 * k * size + n] = v;
      // DCT-II symmetry: T[r][N-1-n] = (-1)^r * T[r][n]; r = 2k is even.
      out[2 * k * size + (size - 1 - n)] = v;
    }
  }
  for (let k = 0; 2 * k + 1 < size; k++) {
    const r = 2 * k + 1;
    for (let n = 0; n < size; n++) {
      // Fold angle r*(2n+1) mod 4N into [0, N) with the cosine's sign.
      let m = (r * (2 * n + 1)) % (4 * size);
      let sign = 1;
      if (m > 2 * size) m = 4 * size - m;
      if (m > size) {
        sign = -1;
        m = 2 * size - m;
      }
      out[r * size + n] = sign * odd[(m - 1) >> 1];
    }
  }
  return out;
}

const dctCache = new Map<number, Int32Array>();
export function getDctMatrix(size: number): Int32Array {
  let m = dctCache.get(size);
  if (!m) {
    m = buildDctMatrix(size);
    dctCache.set(size, m);
  }
  return m;
}

/** The 4x4 DST-VII matrix used for intra luma 4x4 blocks. */
export const DST4 = new Int32Array([
  29, 55, 74, 84, 74, 74, 0, -74, 84, -29, -74, 55, 55, -84, 74, -29,
]);

function clipCoeff(v: number, log2TransformRange: number): number {
  const min = -(2 ** log2TransformRange);
  const max = 2 ** log2TransformRange - 1;
  return v < min ? min : v > max ? max : v;
}

/** Reverse both axes of a residual block (the 180-degree REXT rotation). */
export function rotateBlock180(block: Int32Array, size: number): Int32Array {
  if (!Number.isInteger(size) || size <= 0 || block.length !== size * size)
    throw new RangeError('HEVC residual block size does not match its samples');
  const rotated = new Int32Array(block.length);
  for (let i = 0; i < block.length; i++) rotated[i] = block[block.length - 1 - i];
  return rotated;
}

/** Apply the cumulative horizontal or vertical residual DPCM process (8.6.5). */
export function inverseResidualDpcm(
  residual: Int32Array,
  size: number,
  direction: 'horizontal' | 'vertical',
): Int32Array {
  if (!Number.isInteger(size) || size <= 0 || residual.length !== size * size)
    throw new RangeError('HEVC residual block size does not match its samples');
  const out = residual.slice();
  if (direction === 'horizontal') {
    for (let y = 0; y < size; y++) {
      const row = y * size;
      for (let x = 1; x < size; x++) out[row + x] += out[row + x - 1];
    }
  } else {
    for (let y = 1; y < size; y++) {
      const row = y * size;
      const previousRow = row - size;
      for (let x = 0; x < size; x++) out[row + x] += out[previousRow + x];
    }
  }
  return out;
}

/**
 * One inverse-transform pass: out = in^T x T, with rounding shift and the
 * bitstream's coefficient-range clip. Applying it twice yields T^T x C x T.
 */
function inversePass(
  matrix: Int32Array,
  input: Int32Array,
  output: Int32Array,
  size: number,
  shift: number,
  log2TransformRange: number,
): void {
  const add = 1 << (shift - 1);
  for (let j = 0; j < size; j++) {
    for (let n = 0; n < size; n++) {
      let sum = 0;
      for (let k = 0; k < size; k++) sum += matrix[k * size + n] * input[k * size + j];
      output[j * size + n] = clipCoeff((sum + add) >> shift, log2TransformRange);
    }
  }
}

/**
 * Inverse 2D transform of a dequantized coefficient block (raster order,
 * frequency domain) into spatial residuals, in place semantics via return.
 * Uses DST-VII for 4x4 intra luma, DCT-II otherwise.
 */
export function inverseTransform(
  coeffs: Int32Array,
  size: number,
  bitDepth: number,
  useDst: boolean,
  extendedPrecision = false,
): Int32Array {
  const matrix = useDst ? DST4 : getDctMatrix(size);
  const log2TransformRange = extendedPrecision ? Math.max(15, bitDepth + 6) : 15;
  const tmp = new Int32Array(size * size);
  const out = new Int32Array(size * size);
  inversePass(matrix, coeffs, tmp, size, 7, log2TransformRange);
  // H.265 8.6.4's second inverse-transform shift depends on the permitted
  // coefficient range. For the default 15-bit range this reduces to
  // 20 - bitDepth; extended precision increases it with log2TransformRange.
  inversePass(matrix, tmp, out, size, 5 + log2TransformRange - bitDepth, log2TransformRange);
  return out;
}

const LEVEL_SCALE = [40, 45, 51, 57, 64, 72];

/**
 * Dequantize a coefficient block (8.6.3). `scalingFactors` is the m[x][y]
 * matrix (16s when scaling lists are disabled). Uses float64 arithmetic to
 * dodge 32-bit overflow; exact for all conformant magnitudes. H.265 uses
 * scaling lists for skipped 4x4 blocks, but fixed 16s for larger skipped blocks.
 */
export function dequantize(
  levels: Int32Array,
  size: number,
  qp: number,
  bitDepth: number,
  scalingFactors: Int32Array | null,
  transformSkipped = false,
  extendedPrecision = false,
): Int32Array {
  const log2Size = 31 - Math.clz32(size);
  const log2TransformRange = extendedPrecision ? Math.max(15, bitDepth + 6) : 15;
  const bdShift = bitDepth + log2Size + 10 - log2TransformRange;
  const add = 1 << (bdShift - 1);
  const scale = LEVEL_SCALE[qp % 6] * 2 ** Math.floor(qp / 6);
  const out = new Int32Array(size * size);
  const div = 2 ** bdShift;
  for (let i = 0; i < size * size; i++) {
    const level = levels[i];
    if (level === 0) continue;
    const m = scalingFactors && !(transformSkipped && size > 4) ? scalingFactors[i] : 16;
    out[i] = clipCoeff(Math.floor((level * m * scale + add) / div), log2TransformRange);
  }
  return out;
}
