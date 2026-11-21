import { HeicError } from '../errors.js';
import type { HevcKneeFunctionInfo, HevcKneeFunctionInfoData } from './sei.js';

const LUT_SIZE = 65_536;

export interface HevcKneeFunctionLut {
  values: Float32Array;
}

/** Resolve one active still-picture curve, preserving cancellation and NAL order. */
export function selectHevcKneeFunctionInfo(
  messages: readonly HevcKneeFunctionInfo[] | undefined,
  kneeFunctionId?: number,
): HevcKneeFunctionInfoData | undefined {
  const active = new Map<number, HevcKneeFunctionInfoData>();
  for (const message of messages ?? []) {
    if (message.cancelled) active.delete(message.kneeFunctionId);
    else {
      active.delete(message.kneeFunctionId);
      active.set(message.kneeFunctionId, message);
    }
  }

  if (kneeFunctionId !== undefined) return active.get(kneeFunctionId);
  return [...active.values()].at(-1);
}

/** Compile the H.265 normalized piecewise-linear knee function into a sample LUT. */
export function compileHevcKneeFunction(mapping: HevcKneeFunctionInfoData): HevcKneeFunctionLut {
  const points = mapping.points;
  if (!points.length || points.length > 999)
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid knee_function_info point count');

  let previousInput = 0,
    previousOutput = 0;
  for (const point of points) {
    if (
      !Number.isInteger(point.input) ||
      point.input <= previousInput ||
      point.input > 999 ||
      !Number.isInteger(point.output) ||
      point.output < previousOutput ||
      point.output > 1000
    )
      throw new HeicError('INVALID_BITSTREAM', 'heic: invalid knee_function_info point');
    previousInput = point.input;
    previousOutput = point.output;
  }

  const normalized = [
    { input: 0, output: 0 },
    ...points.map(({ input, output }) => ({ input: input / 1000, output: output / 1000 })),
    { input: 1, output: 1 },
  ];
  const values = new Float32Array(LUT_SIZE);
  let segment = 0;
  for (let index = 0; index < values.length; index++) {
    const input = index / (LUT_SIZE - 1);
    while (segment < normalized.length - 2 && input > normalized[segment + 1].input) segment++;
    const from = normalized[segment],
      to = normalized[segment + 1];
    values[index] =
      from.output + ((input - from.input) * (to.output - from.output)) / (to.input - from.input);
  }
  return { values };
}

/** Apply a compiled curve to a normalized linear RGB component. */
export function mapHevcKneeFunction(lut: HevcKneeFunctionLut, linear: number): number {
  const normalized = Number.isFinite(linear) ? Math.max(0, Math.min(1, linear)) : 0;
  return lut.values[Math.round(normalized * (LUT_SIZE - 1))];
}
