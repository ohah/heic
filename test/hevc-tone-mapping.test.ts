import { expect, it } from 'bun:test';
import type { HevcToneMappingInfoData, HevcToneMappingModel } from '../src/hevc/sei';
import { compileHevcToneMapping, selectHevcToneMappingInfo } from '../src/hevc/tone-mapping';

function data(model: HevcToneMappingModel, toneMapId = 1): HevcToneMappingInfoData {
  return {
    cancelled: false,
    toneMapId,
    persistence: true,
    codedDataBitDepth: 8,
    targetBitDepth: model.modelId === 2 ? 2 : 8,
    model,
  };
}

it('compiles H.265 model 0 linear mapping with clipping and rounded output', () => {
  const lut = compileHevcToneMapping(data({ modelId: 0, minValue: 10, maxValue: 100 }));
  expect(lut?.values[0]).toBe(0);
  expect(lut?.values[10]).toBe(0);
  expect(lut?.values[55]).toBe(128);
  expect(lut?.values[100]).toBe(255);
  expect(lut?.values[255]).toBe(255);
});

it('compiles H.265 model 1 sigmoid mapping using the target bit-depth range', () => {
  const lut = compileHevcToneMapping(data({ modelId: 1, sigmoidMidpoint: 50, sigmoidWidth: 20 }));
  expect(lut?.values[40]).toBe(12);
  expect(lut?.values[50]).toBe(128);
  expect(lut?.values[60]).toBe(243);
});

it('compiles H.265 model 2 interval starts including the implied final endpoint', () => {
  const lut = compileHevcToneMapping(data({ modelId: 2, startOfCodedIntervals: [0, 10, 20, 30] }));
  expect(lut?.values[0]).toBe(0);
  expect(lut?.values[9]).toBe(0);
  expect(lut?.values[10]).toBe(1);
  expect(lut?.values[29]).toBe(2);
  expect(lut?.values[30]).toBe(3);
  expect(lut?.values[255]).toBe(3);
});

it('compiles H.265 model 3 piecewise-linear pivots with implicit endpoints', () => {
  const lut = compileHevcToneMapping(
    data({ modelId: 3, pivots: [{ codedValue: 100, targetValue: 50 }] }),
  );
  expect(lut?.values[0]).toBe(0);
  expect(lut?.values[50]).toBe(25);
  expect(lut?.values[100]).toBe(50);
  expect(lut?.values[255]).toBe(255);
});

it('resolves active mappings by cancellation, signal order, and tone_map_id', () => {
  const first = data({ modelId: 0, minValue: 0, maxValue: 255 }, 1),
    second = data({ modelId: 3, pivots: [] }, 2),
    messages = [first, second, { cancelled: true as const, toneMapId: 2 }];
  expect(selectHevcToneMappingInfo(messages)?.toneMapId).toBe(1);
  expect(selectHevcToneMappingInfo(messages, 2)).toBeUndefined();
  expect(selectHevcToneMappingInfo([...messages, second])?.toneMapId).toBe(2);
  expect(selectHevcToneMappingInfo([...messages, second], 1)?.toneMapId).toBe(1);
});

it('rejects zero-width sigmoid and invalid interval tables', () => {
  expect(() =>
    compileHevcToneMapping(data({ modelId: 1, sigmoidMidpoint: 0, sigmoidWidth: 0 })),
  ).toThrow('sigmoid_width is zero');
  expect(() =>
    compileHevcToneMapping(data({ modelId: 2, startOfCodedIntervals: [0, 20, 10, 30] })),
  ).toThrow('interval start');
});
