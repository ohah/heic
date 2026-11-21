import { HeicError } from '../errors.js';
import {
  chromaSampleLocationFromCode,
  chromaSubsampling,
  type ChromaSampleLocation,
} from './chroma.js';
import type { Planes } from '../planes.js';
import type { HevcChromaResamplingFilter, HevcChromaResamplingFilterHint } from './sei.js';

type SamplePlane = Uint8Array | Uint16Array;
type Filter = readonly number[];

interface FilterBanks {
  down: Filter[];
  up: Filter[];
}

export interface HevcChromaResamplingResult {
  planes: Planes;
  chromaSampleLocation?: ChromaSampleLocation;
}

function reverse(filter: Filter): number[] {
  return [...filter].reverse();
}

function customFilters(
  filters: readonly HevcChromaResamplingFilter[] | undefined,
  expected: number,
  label: string,
): Filter[] {
  if (!filters || filters.length !== expected)
    throw new HeicError('INVALID_BITSTREAM', `heic: invalid ${label} filter count`);
  return filters.map(({ tapLengthMinus1, coefficients }) => {
    if (
      !Number.isInteger(tapLengthMinus1) ||
      tapLengthMinus1 < 0 ||
      tapLengthMinus1 > 31 ||
      coefficients.length !== tapLengthMinus1 + 1 ||
      coefficients.some((coefficient) => !Number.isInteger(coefficient))
    )
      throw new HeicError('INVALID_BITSTREAM', `heic: invalid ${label} filter`);
    return coefficients;
  });
}

function verticalFilters(
  hint: HevcChromaResamplingFilterHint,
  chromaSampleLocType: number,
  upsampling: boolean,
): FilterBanks {
  if (hint.verticalFilterIdc === 0) return { down: [[1]], up: [[1], [1, 1]] };
  let source: Filter[];
  if (hint.verticalFilterIdc === 1)
    source = customFilters(
      hint.verticalFilters,
      hint.verticalFilteringFieldProcessing
        ? chromaSampleLocType <= 1
          ? 3
          : 5
        : chromaSampleLocType <= 1
          ? 2
          : 3,
      'vertical chroma-resampling',
    );
  else {
    if (chromaSampleLocType > 1)
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: ver_chroma_filter_idc 2 is invalid for this chroma sample location',
      );
    if (hint.verticalFilteringFieldProcessing)
      source = [
        [-8, -26, 115, 586, 409, -48, -4, 0],
        [24, -41, 1169, -128],
        [-76, 783, 330, -13],
      ];
    else
      source = [
        [-3, -19, 34, 500, 500, 34, -19, -3],
        [19, 103, 1037, -135],
      ];
  }

  if (!upsampling) {
    if (!hint.verticalFilteringFieldProcessing) return { down: [source[0]], up: [] };
    const bottom = chromaSampleLocType <= 1 ? reverse(source[0]) : source[1];
    return { down: [source[0], bottom], up: [] };
  }

  if (!hint.verticalFilteringFieldProcessing) {
    if (chromaSampleLocType <= 1) return { down: [], up: [source[1], reverse(source[1])] };
    if (chromaSampleLocType <= 3) return { down: [], up: [source[1], source[2]] };
    return { down: [], up: [source[1], source[2]] };
  }

  if (chromaSampleLocType <= 1)
    return { down: [], up: [source[1], source[2], reverse(source[1]), reverse(source[2])] };
  if (chromaSampleLocType <= 3)
    return { down: [], up: [source[2], source[3], source[4], reverse(source[4])] };
  return { down: [], up: [source[2], reverse(source[2]), source[3], source[4]] };
}

function horizontalFilters(
  hint: HevcChromaResamplingFilterHint,
  chromaSampleLocType: number,
  upsampling: boolean,
): FilterBanks {
  if (hint.horizontalFilterIdc === 0) return { down: [[1]], up: [[1], [1, 1]] };
  let source: Filter[];
  if (hint.horizontalFilterIdc === 1)
    source = customFilters(
      hint.horizontalFilters,
      chromaSampleLocType % 2 === 0 ? 3 : 2,
      'horizontal chroma-resampling',
    );
  else {
    if (chromaSampleLocType % 2 !== 0)
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: hor_chroma_filter_idc 2 is invalid for this chroma sample location',
      );
    source = [[-1, 2, 6, 2, -1], [1], [1, 1]];
  }

  if (!upsampling) return { down: [source[0]], up: [] };
  return chromaSampleLocType % 2 === 0
    ? { down: [], up: [source[1], source[2]] }
    : { down: [], up: [source[1], reverse(source[1])] };
}

function deriveTargetFormat(sourceFormat: number, hint: HevcChromaResamplingFilterHint): number {
  if (hint.targetFormatIdc !== undefined) return hint.targetFormatIdc;
  if (sourceFormat === 1) return hint.horizontalFilterIdc === 2 ? 3 : 2;
  if (sourceFormat === 2) return hint.verticalFilterIdc === 2 ? 1 : 3;
  if (sourceFormat === 3) return hint.verticalFilterIdc === 2 ? 1 : 2;
  throw new HeicError('UNSUPPORTED_FEATURE', 'heic: CRFH is not supported for monochrome images');
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(length - 1, index));
}

function filterValue(
  source: SamplePlane,
  width: number,
  height: number,
  axis: 'horizontal' | 'vertical',
  outputX: number,
  outputY: number,
  filter: Filter,
  upsampling: boolean,
  sampleMax: number,
): number {
  const divisor = filter.reduce((sum, coefficient) => sum + coefficient, 0);
  if (divisor === 0)
    throw new HeicError('INVALID_BITSTREAM', 'heic: chroma-resampling filter has a zero sum');
  const outputIndex = axis === 'horizontal' ? outputX : outputY,
    center = upsampling ? outputIndex >> 1 : outputIndex << 1,
    filterCenter = Math.floor((filter.length - 1) / 2);
  let sum = 0;
  for (let tap = 0; tap < filter.length; tap++) {
    const sampleIndex = center + tap - filterCenter,
      x = axis === 'horizontal' ? clampIndex(sampleIndex, width) : outputX,
      y = axis === 'vertical' ? clampIndex(sampleIndex, height) : outputY;
    sum += source[y * width + x] * filter[tap];
  }
  return Math.max(0, Math.min(sampleMax, Math.trunc((sum + Math.floor(divisor / 2)) / divisor)));
}

function createPlane(source: SamplePlane, length: number): SamplePlane {
  return source instanceof Uint8Array ? new Uint8Array(length) : new Uint16Array(length);
}

function resampleAxis(
  source: SamplePlane,
  width: number,
  height: number,
  outputWidth: number,
  outputHeight: number,
  axis: 'horizontal' | 'vertical',
  upsampling: boolean,
  filters: FilterBanks,
  fieldProcessing: boolean,
  sampleMax: number,
  fieldSequenceParity?: 0 | 1,
): SamplePlane {
  const output = createPlane(source, outputWidth * outputHeight),
    filtersForDirection = upsampling ? filters.up : filters.down;
  if (axis === 'vertical' && fieldProcessing) {
    if (fieldSequenceParity !== undefined) {
      const phases = upsampling
        ? filtersForDirection.slice(fieldSequenceParity * 2, fieldSequenceParity * 2 + 2)
        : [filtersForDirection[fieldSequenceParity]];
      if (phases.length !== (upsampling ? 2 : 1) || phases.some((filter) => !filter))
        throw new HeicError('INVALID_BITSTREAM', 'heic: missing field-sequence resampling phase');
      for (let row = 0; row < outputHeight; row++)
        for (let column = 0; column < outputWidth; column++) {
          const filter = phases[upsampling ? row % 2 : 0],
            value = filterValue(
              source,
              width,
              height,
              'vertical',
              column,
              row,
              filter,
              upsampling,
              sampleMax,
            );
          output[row * outputWidth + column] = value;
        }
      return output;
    }
    for (let field = 0; field < 2; field++) {
      const inputFieldHeight = Math.ceil((height - field) / 2),
        outputFieldHeight = Math.ceil((outputHeight - field) / 2),
        fieldPlane = createPlane(source, width * inputFieldHeight);
      for (let row = 0; row < inputFieldHeight; row++)
        fieldPlane.set(
          source.subarray((row * 2 + field) * width, (row * 2 + field + 1) * width),
          row * width,
        );
      const phases = upsampling
        ? [filtersForDirection[field * 2], filtersForDirection[field * 2 + 1]]
        : [filtersForDirection[field]];
      if (phases.some((filter) => !filter))
        throw new HeicError('INVALID_BITSTREAM', 'heic: missing vertical resampling phase');
      for (let row = 0; row < outputFieldHeight; row++)
        for (let column = 0; column < outputWidth; column++) {
          const filter = phases[upsampling ? row % 2 : 0],
            value = filterValue(
              fieldPlane,
              width,
              inputFieldHeight,
              'vertical',
              column,
              row,
              filter,
              upsampling,
              sampleMax,
            ),
            outputRow = row * 2 + field;
          output[outputRow * outputWidth + column] = value;
        }
    }
    return output;
  }

  const phases = upsampling ? filtersForDirection : [filtersForDirection[0]];
  if (!phases.length || phases.some((filter) => !filter))
    throw new HeicError('INVALID_BITSTREAM', `heic: missing ${axis} resampling filter`);
  for (let row = 0; row < outputHeight; row++)
    for (let column = 0; column < outputWidth; column++) {
      const phase = upsampling ? (axis === 'horizontal' ? column : row) % 2 : 0,
        filter = phases[phase];
      output[row * outputWidth + column] = filterValue(
        source,
        width,
        height,
        axis,
        column,
        row,
        filter,
        upsampling,
        sampleMax,
      );
    }
  return output;
}

/** Apply the H.265 D.3.31 resampling path to a decoded picture's chroma planes. */
export function applyHevcChromaResamplingFilterHint(
  planes: Planes,
  hint: HevcChromaResamplingFilterHint,
  chromaSampleLocType = 0,
  fieldSequenceParity?: 0 | 1,
): HevcChromaResamplingResult {
  if (
    ![1, 2, 3].includes(planes.chromaFormatIdc) ||
    !Number.isInteger(hint.verticalFilterIdc) ||
    hint.verticalFilterIdc < 0 ||
    hint.verticalFilterIdc > 2 ||
    !Number.isInteger(hint.horizontalFilterIdc) ||
    hint.horizontalFilterIdc < 0 ||
    hint.horizontalFilterIdc > 2 ||
    typeof hint.verticalFilteringFieldProcessing !== 'boolean' ||
    (fieldSequenceParity !== undefined && fieldSequenceParity !== 0 && fieldSequenceParity !== 1)
  )
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid CRFH filter selectors');
  if (fieldSequenceParity !== undefined && !hint.verticalFilteringFieldProcessing)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: field-sequence CRFH requires field-based vertical processing',
    );
  if (!planes.cb.length || !planes.cr.length)
    throw new HeicError('INVALID_BITSTREAM', 'heic: CRFH is not valid for monochrome images');
  const sourceFormat = planes.chromaFormatIdc,
    targetFormat = deriveTargetFormat(sourceFormat, hint);
  if (
    !Number.isInteger(chromaSampleLocType) ||
    chromaSampleLocType < 0 ||
    chromaSampleLocType > 5 ||
    !Number.isInteger(targetFormat) ||
    targetFormat < 1 ||
    targetFormat > 3 ||
    targetFormat === sourceFormat
  )
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid CRFH sampling format');
  const sampleLocType = sourceFormat === 1 ? chromaSampleLocType : 0;
  const sourceSubsampling = chromaSubsampling(sourceFormat),
    targetSubsampling = chromaSubsampling(targetFormat),
    sourceWidth = Math.ceil(planes.width / sourceSubsampling.width),
    sourceHeight = Math.ceil(planes.height / sourceSubsampling.height),
    targetWidth = Math.ceil(planes.width / targetSubsampling.width),
    targetHeight = Math.ceil(planes.height / targetSubsampling.height),
    sampleMax = 2 ** (planes.bitDepthChroma ?? planes.bitDepthLuma ?? 16) - 1;
  if (
    planes.cb.length !== sourceWidth * sourceHeight ||
    planes.cr.length !== sourceWidth * sourceHeight
  )
    throw new HeicError('INVALID_BITSTREAM', 'heic: CRFH chroma plane dimensions do not match');

  const process = (input: SamplePlane): SamplePlane => {
    let output = input,
      width = sourceWidth,
      height = sourceHeight;
    if (sourceSubsampling.height !== targetSubsampling.height) {
      const upsampling = sourceSubsampling.height > targetSubsampling.height,
        filters = verticalFilters(hint, sampleLocType, upsampling);
      output = resampleAxis(
        output,
        width,
        height,
        width,
        targetHeight,
        'vertical',
        upsampling,
        filters,
        hint.verticalFilteringFieldProcessing,
        sampleMax,
        fieldSequenceParity,
      );
      height = targetHeight;
    }
    if (sourceSubsampling.width !== targetSubsampling.width) {
      const upsampling = sourceSubsampling.width > targetSubsampling.width,
        filters = horizontalFilters(hint, sampleLocType, upsampling);
      output = resampleAxis(
        output,
        width,
        height,
        targetWidth,
        height,
        'horizontal',
        upsampling,
        filters,
        false,
        sampleMax,
      );
    }
    return output;
  };
  const targetLocation =
    targetFormat === 3
      ? undefined
      : (chromaSampleLocationFromCode(
          targetFormat === 1 ? 2 : 1,
          targetFormat === 1 ? sampleLocType : sampleLocType % 2,
        ) ?? undefined);
  return {
    planes: {
      ...planes,
      cb: process(planes.cb),
      cr: process(planes.cr),
      chromaFormatIdc: targetFormat,
    },
    ...(targetLocation ? { chromaSampleLocation: targetLocation } : {}),
  };
}
