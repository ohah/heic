import { isHeifHevcBitDepth } from '../bit-depth.js';
import { HeicError } from '../errors.js';
import type { HevcDepthRepresentationInformation, HevcDepthRepresentationValue } from './sei.js';

export type HevcDepthSampleInterpretation =
  | {
      representation: 'inverse-z';
      normalizedValue: number;
      inverseZ?: number;
      z?: number;
    }
  | { representation: 'z'; normalizedValue: number; z?: number }
  | {
      representation: 'disparity';
      normalizedValue: number;
      disparity?: number;
      disparityReferenceViewId?: number;
    }
  | { representation: 'reserved'; representationType: number };

function invalidOptions(message: string): never {
  throw new HeicError('INVALID_OPTIONS', `heic: ${message}`);
}

function invalidMetadata(message: string): never {
  throw new HeicError('INVALID_BITSTREAM', `heic: ${message}`);
}

function depthParameterValue(value: HevcDepthRepresentationValue | undefined): number | undefined {
  if (!value) return undefined;
  const { exponent, mantissa, mantissaLength, sign } = value;
  if (
    !Number.isInteger(exponent) ||
    exponent < 0 ||
    exponent > 127 ||
    !Number.isInteger(mantissaLength) ||
    mantissaLength < 1 ||
    mantissaLength > 32 ||
    !Number.isInteger(mantissa) ||
    mantissa < 0 ||
    mantissa >= 2 ** mantissaLength
  )
    invalidMetadata('invalid depth representation floating-point value');

  // H.274 assigns exponent 127 the meaning "unspecified".
  if (exponent === 127) return undefined;
  const magnitude =
    exponent === 0
      ? 2 ** -(30 + mantissaLength) * mantissa
      : 2 ** (exponent - 31) * (1 + mantissa / 2 ** mantissaLength);
  return sign ? -magnitude : magnitude;
}

function nonlinearDisparitySample(
  sample: number,
  maxValue: number,
  models: number[] | undefined,
): number {
  if (!models || models.length < 1 || models.length > 63)
    invalidMetadata('invalid depth nonlinear representation model count');
  if (models.some((model) => !Number.isInteger(model) || model < 0 || model > 65_535))
    invalidMetadata('depth nonlinear representation model is out of range');

  // The first and last model points are inferred as zero by H.274. The signalled
  // models are the intervening deviations from the identity line.
  const points = [0, ...models, 0];
  const segmentCount = points.length - 1;
  let mapped: number | undefined;
  for (let k = 0; k < segmentCount; k++) {
    const position1 = Math.floor((maxValue * k) / segmentCount);
    const position2 = Math.floor((maxValue * (k + 1)) / segmentCount);
    const x1 = position1 - points[k];
    const y1 = position1 + points[k];
    const x2 = position2 - points[k + 1];
    const y2 = position2 + points[k + 1];
    const lower = Math.max(x1, 0);
    const upper = Math.min(x2, maxValue);
    if (sample < lower || sample > upper) continue;
    if (x2 === x1) invalidMetadata('depth nonlinear representation has a zero-width segment');

    const interpolated = ((sample - x1) * (y2 - y1)) / (x2 - x1) + y1;
    const rounded = Math.sign(interpolated) * Math.floor(Math.abs(interpolated) + 0.5);
    mapped = Math.max(0, Math.min(maxValue, rounded));
  }
  if (mapped === undefined)
    invalidMetadata('depth nonlinear representation does not cover the sample range');
  return mapped;
}

/**
 * Interpret one decoded auxiliary luma sample using its H.274 depth-representation SEI.
 * Normalized values are in 0..1. Physical Z/disparity is included only when both
 * corresponding bounds are signalled and specified. Z units remain source-defined.
 */
export function interpretHevcDepthSample(
  sample: number,
  bitDepth: number,
  info: HevcDepthRepresentationInformation,
): HevcDepthSampleInterpretation {
  if (!isHeifHevcBitDepth(bitDepth)) invalidOptions('HEVC bit depth must be between 8 and 15');
  const maxValue = 2 ** bitDepth - 1;
  if (!Number.isInteger(sample) || sample < 0 || sample > maxValue)
    invalidOptions(`depth sample must be an integer between 0 and ${maxValue}`);
  if (!Number.isInteger(info.representationType) || info.representationType < 0)
    invalidMetadata('invalid depth representation type');
  if (info.representationType > 15) invalidMetadata('depth representation type is out of range');
  if (info.representationType >= 4)
    return { representation: 'reserved', representationType: info.representationType };

  const sampleValue =
    info.representationType === 3
      ? nonlinearDisparitySample(sample, maxValue, info.nonlinearRepresentationModels)
      : sample;
  const normalizedValue = sampleValue / maxValue;

  if (info.representationType === 0) {
    const zNear = depthParameterValue(info.zNear),
      zFar = depthParameterValue(info.zFar);
    if (zNear === undefined || zFar === undefined || zNear === 0 || zFar === 0)
      return { representation: 'inverse-z', normalizedValue };
    const inverseZ = 1 / zFar + normalizedValue * (1 / zNear - 1 / zFar);
    const z = inverseZ === 0 ? undefined : 1 / inverseZ;
    return {
      representation: 'inverse-z',
      normalizedValue,
      ...(Number.isFinite(inverseZ) ? { inverseZ } : {}),
      ...(z !== undefined && Number.isFinite(z) ? { z } : {}),
    };
  }

  if (info.representationType === 2) {
    const zNear = depthParameterValue(info.zNear),
      zFar = depthParameterValue(info.zFar);
    if (zNear === undefined || zFar === undefined) return { representation: 'z', normalizedValue };
    const z = zFar + normalizedValue * (zNear - zFar);
    return { representation: 'z', normalizedValue, ...(Number.isFinite(z) ? { z } : {}) };
  }

  const dMin = depthParameterValue(info.dMin),
    dMax = depthParameterValue(info.dMax);
  if (dMin === undefined || dMax === undefined)
    return {
      representation: 'disparity',
      normalizedValue,
      ...(info.disparityReferenceViewId === undefined
        ? {}
        : { disparityReferenceViewId: info.disparityReferenceViewId }),
    };
  const disparity = dMin + normalizedValue * (dMax - dMin);
  return {
    representation: 'disparity',
    normalizedValue,
    ...(Number.isFinite(disparity) ? { disparity } : {}),
    ...(info.disparityReferenceViewId === undefined
      ? {}
      : { disparityReferenceViewId: info.disparityReferenceViewId }),
  };
}
