import { expect, it } from 'bun:test';
import {
  compileHevcColourRemapping,
  mapHevcColourRemappingLut,
  mapHevcColourRemappingSamples,
  selectHevcColourRemappingInfo,
} from '../src/hevc/colour-remapping.js';
import type { HevcColourRemappingInfoData } from '../src/hevc/sei.js';

function mapping(
  overrides: Partial<HevcColourRemappingInfoData> = {},
): HevcColourRemappingInfoData {
  const empty = { numValMinus1: 0, points: [] } as const;
  return {
    cancelled: false,
    colourRemapId: 7,
    persistence: true,
    inputBitDepth: 8,
    outputBitDepth: 8,
    preLuts: [empty, empty, empty],
    postLuts: [empty, empty, empty],
    ...overrides,
  };
}

it('compiles implicit endpoints and interpolates explicit CRI pivots', () => {
  const compiled = compileHevcColourRemapping(
    mapping({
      inputBitDepth: 8,
      outputBitDepth: 10,
      preLuts: [
        {
          numValMinus1: 1,
          points: [
            { codedValue: 100, targetValue: 200 },
            { codedValue: 200, targetValue: 800 },
          ],
        },
        { numValMinus1: 0, points: [] },
        { numValMinus1: 0, points: [] },
      ],
    }),
  );
  const lut = compiled.preLuts[0];
  expect(mapHevcColourRemappingLut(lut, 0)).toBe(0);
  expect(mapHevcColourRemappingLut(lut, 100)).toBe(200);
  expect(mapHevcColourRemappingLut(lut, 150)).toBe(500);
  expect(mapHevcColourRemappingLut(lut, 200)).toBe(800);
  expect(mapHevcColourRemappingLut(lut, 255)).toBe(1023);
  expect(mapHevcColourRemappingLut(compiled.preLuts[1], 127)).toBe(509);
});

it('applies the signed fixed-point CRI matrix with normative rounding and clipping', () => {
  const compiled = compileHevcColourRemapping(
    mapping({
      matrix: {
        log2Denom: 1,
        coefficients: [
          [1, 1, 1],
          [-32_768, 0, 0],
          [32_767, 32_767, 32_767],
        ],
      },
    }),
  );
  expect(mapHevcColourRemappingSamples(compiled, [10, 20, 30])).toEqual([30, 0, 255]);
});

it('runs the pre-LUT, matrix, and post-LUT in that order', () => {
  const compiled = compileHevcColourRemapping(
    mapping({
      preLuts: [
        {
          numValMinus1: 1,
          points: [
            { codedValue: 0, targetValue: 0 },
            { codedValue: 255, targetValue: 127 },
          ],
        },
        { numValMinus1: 0, points: [] },
        { numValMinus1: 0, points: [] },
      ],
      matrix: {
        log2Denom: 0,
        coefficients: [
          [1, 1, 0],
          [0, 1, 0],
          [0, 0, 1],
        ],
      },
      postLuts: [
        {
          numValMinus1: 1,
          points: [
            { codedValue: 0, targetValue: 0 },
            { codedValue: 127, targetValue: 254 },
          ],
        },
        { numValMinus1: 0, points: [] },
        { numValMinus1: 0, points: [] },
      ],
    }),
  );
  expect(mapHevcColourRemappingSamples(compiled, [200, 20, 30])).toEqual([240, 20, 30]);
});

it('selects the latest active CRI and observes cancellation by ID', () => {
  const first = mapping({ colourRemapId: 2 }),
    second = mapping({ colourRemapId: 9 }),
    messages = [first, second, { cancelled: true, colourRemapId: 9 }] as const;
  expect(selectHevcColourRemappingInfo(messages)).toBe(first);
  expect(selectHevcColourRemappingInfo(messages, 2)).toBe(first);
  expect(selectHevcColourRemappingInfo(messages, 9)).toBeUndefined();
});
