import { HeicError } from '../errors.js';
import { chromaSubsampling } from './chroma.js';
import type { Planes } from '../planes.js';
import type { HevcPostFilterHint } from './sei.js';

type SamplePlane = Uint8Array | Uint16Array;
const FILTER_PRECISION = 1 << 16;
const MAX_POST_FILTER_WORK = 500_000_000;

function outputPlaneLike(source: SamplePlane): SamplePlane {
  return source instanceof Uint8Array
    ? new Uint8Array(source.length)
    : new Uint16Array(source.length);
}

function clipAndRound(value: number, sampleMax: number): number {
  return Math.max(0, Math.min(sampleMax, Math.round(value)));
}

function filterTwoDimensional(
  source: SamplePlane,
  width: number,
  height: number,
  coefficients: readonly (readonly number[])[],
  sampleMax: number,
): SamplePlane {
  const filterHeight = coefficients.length,
    filterWidth = coefficients[0]?.length ?? 0;
  if (
    width < 1 ||
    height < 1 ||
    source.length !== width * height ||
    filterHeight < 1 ||
    filterWidth < 1 ||
    coefficients.some(
      (row) => row.length !== filterWidth || row.some((value) => !Number.isInteger(value)),
    )
  )
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid post-filter hint plane or kernel');

  const output = outputPlaneLike(source),
    halfX = filterWidth >> 1,
    halfY = filterHeight >> 1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let ky = 0; ky < filterHeight; ky++) {
        const sampleY = Math.max(0, Math.min(height - 1, y + ky - halfY));
        for (let kx = 0; kx < filterWidth; kx++) {
          const sampleX = Math.max(0, Math.min(width - 1, x + kx - halfX));
          sum += source[sampleY * width + sampleX] * (coefficients[ky][kx] / FILTER_PRECISION);
        }
      }
      output[y * width + x] = clipAndRound(sum, sampleMax);
    }
  return output;
}

function filterSeparable(
  source: SamplePlane,
  width: number,
  height: number,
  horizontalCoefficients: readonly number[],
  verticalCoefficients: readonly number[],
  sampleMax: number,
): SamplePlane {
  const output = outputPlaneLike(source),
    horizontalHalf = horizontalCoefficients.length >> 1,
    verticalHalf = verticalCoefficients.length >> 1,
    horizontalRows = new Map<number, Float64Array>(),
    getHorizontalRow = (sourceY: number): Float64Array => {
      let row = horizontalRows.get(sourceY);
      if (!row) {
        row = new Float64Array(width);
        for (let x = 0; x < width; x++) {
          let sum = 0;
          for (let tap = 0; tap < horizontalCoefficients.length; tap++) {
            const sourceX = Math.max(0, Math.min(width - 1, x + tap - horizontalHalf));
            sum +=
              source[sourceY * width + sourceX] * (horizontalCoefficients[tap] / FILTER_PRECISION);
          }
          row[x] = sum;
        }
        horizontalRows.set(sourceY, row);
      }
      return row;
    };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let tap = 0; tap < verticalCoefficients.length; tap++) {
        const sourceY = Math.max(0, Math.min(height - 1, y + tap - verticalHalf));
        sum += getHorizontalRow(sourceY)[x] * (verticalCoefficients[tap] / FILTER_PRECISION);
      }
      output[y * width + x] = clipAndRound(sum, sampleMax);
    }
    const firstRowForNextOutput = Math.max(0, y + 1 - verticalHalf);
    for (const cachedY of horizontalRows.keys())
      if (cachedY < firstRowForNextOutput) horizontalRows.delete(cachedY);
  }
  return output;
}

function filterComponent(
  source: SamplePlane,
  width: number,
  height: number,
  hint: HevcPostFilterHint,
  component: number,
  sampleMax: number,
): SamplePlane {
  const values = hint.filterHintValues[component];
  if (
    !values ||
    values.length !== hint.filterHintSizeY ||
    values.some((row) => row.length !== hint.filterHintSizeX)
  )
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid post-filter hint component matrix');

  if (hint.filterHintType === 0)
    return filterTwoDimensional(source, width, height, values, sampleMax);

  if (hint.filterHintType !== 1 || hint.filterHintSizeY !== 2)
    throw new HeicError('INVALID_BITSTREAM', 'heic: unsupported post-filter hint type');

  return filterSeparable(source, width, height, values[0], values[1], sampleMax);
}

/** Apply the selected H.265 FIR post-filter hint before colour conversion. */
export function applyHevcPostFilterHint(planes: Planes, hint: HevcPostFilterHint): Planes {
  if (hint.filterHintType === 2) return planes;
  if (
    (hint.filterHintType !== 0 && hint.filterHintType !== 1) ||
    !Number.isInteger(hint.filterHintSizeX) ||
    hint.filterHintSizeX < 1 ||
    hint.filterHintSizeX > 15 ||
    !Number.isInteger(hint.filterHintSizeY) ||
    hint.filterHintSizeY < 1 ||
    hint.filterHintSizeY > 15 ||
    (hint.filterHintType === 1 && hint.filterHintSizeY !== 2)
  )
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid post-filter hint dimensions or type');

  const componentCount = planes.chromaFormatIdc === 0 ? 1 : 3;
  if (hint.filterHintValues.length !== componentCount)
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid post-filter hint component count');

  const width = planes.width,
    height = planes.height,
    sub = chromaSubsampling(planes.chromaFormatIdc),
    chromaWidth = Math.ceil(width / sub.width),
    chromaHeight = Math.ceil(height / sub.height),
    filterTaps =
      hint.filterHintType === 0
        ? hint.filterHintSizeX * hint.filterHintSizeY
        : 2 * hint.filterHintSizeX,
    sampleCount = width * height + (componentCount === 1 ? 0 : 2 * chromaWidth * chromaHeight),
    lumaMax = 2 ** (planes.bitDepthLuma ?? 8) - 1,
    chromaMax = 2 ** (planes.bitDepthChroma ?? planes.bitDepthLuma ?? 8) - 1;
  if (
    !Number.isSafeInteger(sampleCount * filterTaps) ||
    sampleCount * filterTaps > MAX_POST_FILTER_WORK
  )
    throw new HeicError(
      'RESOURCE_LIMIT',
      'heic: post-filter hint exceeds the rendering work limit',
    );

  return {
    ...planes,
    y: filterComponent(planes.y, width, height, hint, 0, lumaMax),
    cb:
      componentCount === 1
        ? planes.cb
        : filterComponent(planes.cb, chromaWidth, chromaHeight, hint, 1, chromaMax),
    cr:
      componentCount === 1
        ? planes.cr
        : filterComponent(planes.cr, chromaWidth, chromaHeight, hint, 2, chromaMax),
  };
}
