import { expect, it } from 'bun:test';
import type { HevcKneeFunctionInfoData } from '../src/hevc/sei';
import {
  compileHevcKneeFunction,
  mapHevcKneeFunction,
  selectHevcKneeFunctionInfo,
} from '../src/hevc/knee-function';

function kneeFunction(
  kneeFunctionId: number,
  points: readonly { input: number; output: number }[],
): HevcKneeFunctionInfoData {
  return {
    cancelled: false,
    kneeFunctionId,
    persistence: false,
    inputDynamicRange: 0,
    inputDisplayLuminance: 0,
    outputDynamicRange: 0,
    outputDisplayLuminance: 0,
    points,
  };
}

it('applies the H.265 knee curve across the leading, interior, and trailing segments', () => {
  const lut = compileHevcKneeFunction(
    kneeFunction(3, [
      { input: 250, output: 125 },
      { input: 500, output: 400 },
      { input: 750, output: 600 },
    ]),
  );

  expect(mapHevcKneeFunction(lut, 0)).toBe(0);
  expect(mapHevcKneeFunction(lut, 0.125)).toBeCloseTo(0.0625, 4);
  expect(mapHevcKneeFunction(lut, 0.25)).toBeCloseTo(0.125, 4);
  expect(mapHevcKneeFunction(lut, 0.375)).toBeCloseTo(0.2625, 4);
  expect(mapHevcKneeFunction(lut, 0.5)).toBeCloseTo(0.4, 4);
  expect(mapHevcKneeFunction(lut, 0.625)).toBeCloseTo(0.5, 4);
  expect(mapHevcKneeFunction(lut, 0.75)).toBeCloseTo(0.6, 4);
  expect(mapHevcKneeFunction(lut, 0.875)).toBeCloseTo(0.8, 4);
  expect(mapHevcKneeFunction(lut, 1)).toBe(1);
});

it('clamps normalized linear samples to the defined knee domain', () => {
  const lut = compileHevcKneeFunction(kneeFunction(1, [{ input: 500, output: 400 }]));
  expect(mapHevcKneeFunction(lut, -1)).toBe(0);
  expect(mapHevcKneeFunction(lut, 2)).toBe(1);
  expect(mapHevcKneeFunction(lut, Number.NaN)).toBe(0);
});

it('selects the latest active curve and honors cancellation and explicit ids', () => {
  const first = kneeFunction(1, [{ input: 400, output: 300 }]),
    second = kneeFunction(2, [{ input: 600, output: 500 }]);
  expect(selectHevcKneeFunctionInfo([first, second, { cancelled: true, kneeFunctionId: 2 }])).toBe(
    first,
  );
  expect(selectHevcKneeFunctionInfo([first, second], 1)).toBe(first);
  expect(selectHevcKneeFunctionInfo([first, second], 9)).toBeUndefined();
});

it('rejects invalid knee points when compiling a curve', () => {
  expect(() => compileHevcKneeFunction(kneeFunction(1, [{ input: 0, output: 0 }]))).toThrow(
    'invalid knee_function_info point',
  );
  expect(() =>
    compileHevcKneeFunction(
      kneeFunction(1, [
        { input: 500, output: 600 },
        { input: 700, output: 500 },
      ]),
    ),
  ).toThrow('invalid knee_function_info point');
});
