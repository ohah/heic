import { HeicError } from '../errors.js';
import type {
  HevcColourRemappingInfo,
  HevcColourRemappingInfoData,
  HevcColourRemappingLut,
} from './sei.js';

export interface HevcColourRemappingLutFunction {
  inputMax: number;
  outputMax: number;
  points: readonly { input: number; output: number }[];
}

export interface HevcColourRemappingFunction {
  inputBitDepth: number;
  outputBitDepth: number;
  preLuts: readonly [
    HevcColourRemappingLutFunction,
    HevcColourRemappingLutFunction,
    HevcColourRemappingLutFunction,
  ];
  matrix?: HevcColourRemappingInfoData['matrix'];
  postLuts: readonly [
    HevcColourRemappingLutFunction,
    HevcColourRemappingLutFunction,
    HevcColourRemappingLutFunction,
  ];
}

/** Resolve one active still-picture remapping while preserving cancellation and NAL order. */
export function selectHevcColourRemappingInfo(
  messages: readonly HevcColourRemappingInfo[] | undefined,
  colourRemapId?: number,
): HevcColourRemappingInfoData | undefined {
  const active = new Map<number, HevcColourRemappingInfoData>();
  for (const message of messages ?? []) {
    if (message.cancelled) active.delete(message.colourRemapId);
    else {
      active.delete(message.colourRemapId);
      active.set(message.colourRemapId, message);
    }
  }

  if (colourRemapId !== undefined) return active.get(colourRemapId);
  return [...active.values()].at(-1);
}

function compileLut(
  lut: HevcColourRemappingLut,
  inputBitDepth: number,
  outputBitDepth: number,
  label: string,
): HevcColourRemappingLutFunction {
  const inputMax = 2 ** inputBitDepth - 1,
    outputMax = 2 ** outputBitDepth - 1,
    expectedPointCount = lut.numValMinus1 === 0 ? 0 : lut.numValMinus1 + 1;
  if (lut.numValMinus1 < 0 || lut.numValMinus1 > 32 || lut.points.length !== expectedPointCount)
    throw new HeicError('INVALID_BITSTREAM', `heic: invalid ${label} LUT point count`);

  const points: { input: number; output: number }[] = [];
  let previousInput = -1;
  for (const point of lut.points) {
    if (
      !Number.isInteger(point.codedValue) ||
      point.codedValue < 0 ||
      point.codedValue > inputMax ||
      point.codedValue <= previousInput ||
      !Number.isInteger(point.targetValue) ||
      point.targetValue < 0 ||
      point.targetValue > outputMax
    )
      throw new HeicError('INVALID_BITSTREAM', `heic: invalid ${label} LUT pivot`);
    points.push({ input: point.codedValue, output: point.targetValue });
    previousInput = point.codedValue;
  }

  if (!points.length) points.push({ input: 0, output: 0 }, { input: inputMax, output: outputMax });
  else {
    if (points[0].input > 0) points.unshift({ input: 0, output: 0 });
    if (points.at(-1)!.input < inputMax) points.push({ input: inputMax, output: outputMax });
  }
  return { inputMax, outputMax, points };
}

/** Compile the coded pivots and implicit endpoint segments for a CRI message. */
export function compileHevcColourRemapping(
  mapping: HevcColourRemappingInfoData,
): HevcColourRemappingFunction {
  if (
    !Number.isInteger(mapping.inputBitDepth) ||
    mapping.inputBitDepth < 8 ||
    mapping.inputBitDepth > 16 ||
    !Number.isInteger(mapping.outputBitDepth) ||
    mapping.outputBitDepth < 8 ||
    mapping.outputBitDepth > 16
  )
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid colour_remapping_info bit depth');
  if (
    mapping.matrix &&
    (!Number.isInteger(mapping.matrix.log2Denom) ||
      mapping.matrix.log2Denom < 0 ||
      mapping.matrix.log2Denom > 15 ||
      mapping.matrix.coefficients.some((row) =>
        row.some((value) => !Number.isInteger(value) || value < -32_768 || value > 32_767),
      ))
  )
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid colour_remap matrix');

  return {
    inputBitDepth: mapping.inputBitDepth,
    outputBitDepth: mapping.outputBitDepth,
    preLuts: mapping.preLuts.map((lut, index) =>
      compileLut(lut, mapping.inputBitDepth, mapping.outputBitDepth, `pre_lut[${index}]`),
    ) as unknown as HevcColourRemappingFunction['preLuts'],
    ...(mapping.matrix ? { matrix: mapping.matrix } : {}),
    postLuts: mapping.postLuts.map((lut, index) =>
      compileLut(lut, mapping.outputBitDepth, mapping.outputBitDepth, `post_lut[${index}]`),
    ) as unknown as HevcColourRemappingFunction['postLuts'],
  };
}

/** Evaluate one piecewise-linear CRI LUT and round its result to a code value. */
export function mapHevcColourRemappingLut(
  lut: HevcColourRemappingLutFunction,
  sample: number,
): number {
  const input = Math.max(0, Math.min(lut.inputMax, sample));
  let low = 0,
    high = lut.points.length - 1;
  while (low + 1 < high) {
    const middle = (low + high) >> 1;
    if (input <= lut.points[middle].input) high = middle;
    else low = middle;
  }
  const from = lut.points[low],
    to = lut.points[high],
    output =
      from.output + ((input - from.input) * (to.output - from.output)) / (to.input - from.input);
  return Math.max(0, Math.min(lut.outputMax, Math.round(output)));
}

/** Apply pre-LUTs, the fixed-point matrix, and post-LUTs to G/Y, B/Cb, R/Cr. */
export function mapHevcColourRemappingSamples(
  mapping: HevcColourRemappingFunction,
  samples: readonly [number, number, number],
): [number, number, number] {
  const pre = samples.map((sample, index) =>
    mapHevcColourRemappingLut(mapping.preLuts[index], sample),
  ) as [number, number, number];
  let transformed = pre;
  if (mapping.matrix) {
    const denominator = 2 ** mapping.matrix.log2Denom,
      roundingOffset = mapping.matrix.log2Denom === 0 ? 0 : denominator / 2;
    transformed = mapping.matrix.coefficients.map((row) => {
      const value = Math.floor(
        (row[0] * pre[0] + row[1] * pre[1] + row[2] * pre[2] + roundingOffset) / denominator,
      );
      return Math.max(0, Math.min(2 ** mapping.outputBitDepth - 1, value));
    }) as [number, number, number];
  }
  return transformed.map((sample, index) =>
    mapHevcColourRemappingLut(mapping.postLuts[index], sample),
  ) as [number, number, number];
}
