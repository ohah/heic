import { describe, expect, it } from 'bun:test';
import { isHeifHevcBitDepth, isHeifImageBitDepth } from '../src/bit-depth';

describe('HEIF HEVC sample depths', () => {
  it('accepts every integer depth representable by hvcC', () => {
    for (let depth = 8; depth <= 15; depth++) expect(isHeifHevcBitDepth(depth)).toBe(true);
  });

  it('rejects depths outside hvcC and non-integer values', () => {
    for (const depth of [7, 16, 8.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(isHeifHevcBitDepth(depth)).toBe(false);
  });

  it('accepts 2–16-bit integer images without widening the HEVC hvcC range', () => {
    expect(isHeifImageBitDepth(16)).toBe(true);
    expect(isHeifHevcBitDepth(16)).toBe(false);
    for (let depth = 2; depth <= 7; depth++) expect(isHeifImageBitDepth(depth)).toBe(true);
    for (const depth of [1, 17, 8.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(isHeifImageBitDepth(depth)).toBe(false);
  });
});
