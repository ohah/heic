import { expect, it } from 'bun:test';
import { resolveRenderColor } from '../src/render';

const spsColor = {
  videoFullRange: true,
  colourPrimaries: 9,
  transferCharacteristics: 16,
  matrixCoeffs: 9,
};

const vpsSignalInfo = {
  videoFormat: 5,
  fullRange: false,
  colourPrimaries: 1,
  transferCharacteristics: 1,
  matrixCoefficients: 1,
};

it('uses inferred VPS color values for the selected layered output', () => {
  expect(resolveRenderColor(null, spsColor, vpsSignalInfo)).toEqual({
    primaries: 1,
    transfer: 1,
    matrix: 1,
    fullRange: false,
  });
});

it('keeps HEIF color declarations and alternative-transfer precedence', () => {
  expect(
    resolveRenderColor(
      { primaries: 4, transfer: 2, matrix: 6, fullRange: true },
      spsColor,
      vpsSignalInfo,
      18,
    ),
  ).toEqual({ primaries: 4, transfer: 18, matrix: 6, fullRange: true });
  expect(
    resolveRenderColor(
      { primaries: 4, transfer: 16, matrix: 6, fullRange: true },
      spsColor,
      vpsSignalInfo,
      18,
    ).transfer,
  ).toBe(16);
});

it('preserves the existing SPS VUI and default color fallbacks without VPS inference', () => {
  expect(resolveRenderColor(undefined, spsColor, null)).toEqual({
    primaries: 9,
    transfer: 16,
    matrix: 9,
    fullRange: true,
  });
  expect(resolveRenderColor(undefined, null, null)).toEqual({
    primaries: 2,
    transfer: 2,
    matrix: 6,
    fullRange: false,
  });
});
