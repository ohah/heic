import { describe, expect, it } from 'bun:test';
import { splitLengthPrefixed } from '../src/hevc/nal';

describe('HEVC base-layer extraction', () => {
  it('keeps layer 0 and removes higher-layer NAL units when requested', () => {
    const payload = Uint8Array.from([
      0,
      0,
      0,
      2,
      0x26,
      0x01, // IDR_W_RADL, layer 0, temporal_id_plus1 1
      0,
      0,
      0,
      2,
      0x26,
      0x09, // IDR_W_RADL, layer 1, temporal_id_plus1 1
    ]);

    expect(() => splitLengthPrefixed(payload, 4)).toThrow(
      'heic: multilayer HEVC NAL units are not supported',
    );
    expect(splitLengthPrefixed(payload, 4, true).map((nal) => [...nal.data])).toEqual([
      [0x26, 0x01],
    ]);
  });

  it('keeps only the explicitly selected layer for an L-HEVC item', () => {
    const payload = Uint8Array.from([
      0,
      0,
      0,
      2,
      0x26,
      0x01, // layer 0
      0,
      0,
      0,
      2,
      0x26,
      0x09, // layer 1
    ]);

    expect(splitLengthPrefixed(payload, 4, false, [1])).toEqual([
      { type: 19, layerId: 1, data: payload.subarray(10) },
    ]);
  });
});
