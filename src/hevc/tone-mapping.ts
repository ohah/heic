import { HeicError } from '../errors.js';
import type { HevcToneMappingInfo, HevcToneMappingInfoData } from './sei.js';

export interface HevcToneMappingLut {
  codedMax: number;
  targetMax: number;
  values: Uint16Array;
}

/** Resolve one active map for a still picture, preserving SEI cancellation order. */
export function selectHevcToneMappingInfo(
  messages: readonly HevcToneMappingInfo[] | undefined,
  toneMapId?: number,
): HevcToneMappingInfoData | undefined {
  const active = new Map<number, HevcToneMappingInfoData>();
  for (const message of messages ?? []) {
    if (message.cancelled) active.delete(message.toneMapId);
    else {
      // Reinsert so the default is the most recently signalled active map.
      active.delete(message.toneMapId);
      active.set(message.toneMapId, message);
    }
  }

  if (toneMapId !== undefined) return active.get(toneMapId);
  return [...active.values()].reverse().find((message) => message.model.modelId <= 3);
}

/** Compile H.265 tone-mapping models 0–3 into a compact coded-RGB lookup table. */
export function compileHevcToneMapping(
  mapping: HevcToneMappingInfoData,
): HevcToneMappingLut | undefined {
  const { codedDataBitDepth, targetBitDepth, model } = mapping;
  if (
    !Number.isInteger(codedDataBitDepth) ||
    codedDataBitDepth < 8 ||
    codedDataBitDepth > 14 ||
    !Number.isInteger(targetBitDepth) ||
    targetBitDepth < 1 ||
    targetBitDepth > 16
  )
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid tone_mapping_info bit depth');
  if (model.modelId === 4) return undefined;

  const codedMax = 2 ** codedDataBitDepth - 1,
    targetMax = 2 ** targetBitDepth - 1,
    values = new Uint16Array(codedMax + 1),
    clip = (value: number) => Math.max(0, Math.min(targetMax, value));

  if (model.modelId === 0) {
    const { minValue, maxValue } = model;
    for (let value = 0; value <= codedMax; value++) {
      if (value <= minValue) values[value] = 0;
      else if (value >= maxValue || minValue === maxValue) values[value] = targetMax;
      else
        values[value] = clip(Math.round(((value - minValue) * targetMax) / (maxValue - minValue)));
    }
    return { codedMax, targetMax, values };
  }

  if (model.modelId === 1) {
    const { sigmoidMidpoint, sigmoidWidth } = model;
    if (sigmoidWidth === 0)
      throw new HeicError('INVALID_BITSTREAM', 'heic: tone_mapping_info sigmoid_width is zero');
    for (let value = 0; value <= codedMax; value++) {
      const exponent = (-6 * (value - sigmoidMidpoint)) / sigmoidWidth;
      values[value] = clip(Math.round(targetMax / (1 + Math.exp(exponent))));
    }
    return { codedMax, targetMax, values };
  }

  if (model.modelId === 2) {
    const starts = model.startOfCodedIntervals;
    if (starts.length !== 2 ** targetBitDepth || starts[0] !== 0)
      throw new HeicError('INVALID_BITSTREAM', 'heic: invalid tone_mapping_info interval table');
    let previous = -1;
    for (const start of starts) {
      if (!Number.isInteger(start) || start < previous || start > codedMax + 1)
        throw new HeicError('INVALID_BITSTREAM', 'heic: invalid tone_mapping_info interval start');
      previous = start;
    }
    for (let index = 0; index < starts.length; index++) {
      const start = starts[index],
        end = starts[index + 1] ?? codedMax + 1;
      for (let value = start; value < end; value++) values[value] = index;
    }
    return { codedMax, targetMax, values };
  }

  const pivots = model.pivots;
  let previousCoded = 0;
  for (const pivot of pivots) {
    if (
      !Number.isInteger(pivot.codedValue) ||
      pivot.codedValue <= previousCoded ||
      pivot.codedValue >= codedMax ||
      !Number.isInteger(pivot.targetValue) ||
      pivot.targetValue < 0 ||
      pivot.targetValue > targetMax
    )
      throw new HeicError('INVALID_BITSTREAM', 'heic: invalid tone_mapping_info pivot');
    previousCoded = pivot.codedValue;
  }

  const points = [
    { codedValue: 0, targetValue: 0 },
    ...pivots,
    { codedValue: codedMax, targetValue: targetMax },
  ];
  let segment = 0;
  for (let value = 0; value <= codedMax; value++) {
    while (segment < points.length - 2 && value > points[segment + 1].codedValue) segment++;
    const from = points[segment],
      to = points[segment + 1];
    values[value] = clip(
      Math.round(
        from.targetValue +
          ((value - from.codedValue) * (to.targetValue - from.targetValue)) /
            (to.codedValue - from.codedValue),
      ),
    );
  }
  return { codedMax, targetMax, values };
}
