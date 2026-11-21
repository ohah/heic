import { describe, expect, it } from 'bun:test';
import {
  interpretHevcDepthSample,
  type HevcDepthRepresentationInformation,
  type HevcDepthRepresentationValue,
} from '../src/index.js';

function parameter(exponent: number, mantissa = 0): HevcDepthRepresentationValue {
  return { sign: false, exponent, mantissaLength: 1, mantissa };
}

describe('H.274 depth sample interpretation', () => {
  it('maps type 0 samples through uniformly quantized inverse Z', () => {
    const info: HevcDepthRepresentationInformation = {
      representationType: 0,
      zNear: parameter(32), // 2
      zFar: parameter(33), // 4
    };
    const result = interpretHevcDepthSample(127, 8, info);
    const normalized = 127 / 255,
      inverseZ = 1 / 4 + normalized * (1 / 2 - 1 / 4);

    expect(result).toEqual({
      representation: 'inverse-z',
      normalizedValue: normalized,
      inverseZ,
      z: 1 / inverseZ,
    });
  });

  it('maps type 2 samples linearly from ZFar to ZNear', () => {
    const result = interpretHevcDepthSample(127, 8, {
      representationType: 2,
      zNear: parameter(32), // 2
      zFar: parameter(33), // 4
    });

    expect(result).toEqual({
      representation: 'z',
      normalizedValue: 127 / 255,
      z: 4 + (127 / 255) * (2 - 4),
    });
  });

  it('maps type 1 samples to linear disparity and includes its reference view', () => {
    const result = interpretHevcDepthSample(128, 8, {
      representationType: 1,
      dMin: parameter(31), // 1
      dMax: parameter(32, 1), // 3
      disparityReferenceViewId: 5,
    });

    expect(result).toEqual({
      representation: 'disparity',
      normalizedValue: 128 / 255,
      disparity: 1 + (128 / 255) * 2,
      disparityReferenceViewId: 5,
    });
  });

  it('uses the H.274 piecewise model before scaling type 3 disparity bounds', () => {
    const result = interpretHevcDepthSample(100, 8, {
      representationType: 3,
      dMin: parameter(31), // 1
      dMax: parameter(32, 1), // 3
      nonlinearRepresentationModels: [32],
    });

    // The middle node is (x=95, y=159); sample 100 maps to 162.
    expect(result).toEqual({
      representation: 'disparity',
      normalizedValue: 162 / 255,
      disparity: 1 + (162 / 255) * 2,
    });
  });

  it('leaves physical values unspecified when an endpoint uses reserved exponent 127', () => {
    expect(
      interpretHevcDepthSample(255, 8, {
        representationType: 2,
        zNear: parameter(127),
        zFar: parameter(33),
      }),
    ).toEqual({ representation: 'z', normalizedValue: 1 });
  });

  it('preserves reserved representations without interpreting samples', () => {
    expect(interpretHevcDepthSample(100, 10, { representationType: 4 })).toEqual({
      representation: 'reserved',
      representationType: 4,
    });
  });

  it('rejects invalid bit depths and sample values', () => {
    expect(() => interpretHevcDepthSample(0, 7, { representationType: 1 })).toThrow(
      'HEVC bit depth must be between 8 and 15',
    );
    expect(() => interpretHevcDepthSample(256, 8, { representationType: 1 })).toThrow(
      'depth sample must be an integer between 0 and 255',
    );
  });
});
