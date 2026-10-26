import { expect, it } from 'bun:test';
import { buildScalingFactors, defaultScalingListData } from '../src/hevc/scaling';

it('derives 32x32 chroma scaling from the corresponding 16x16 list (H.265 7-50/7-51)', () => {
  const data = defaultScalingListData();
  data.lists[2][1].fill(23);
  data.lists[2][2].fill(29);
  data.dc[0][1] = 31;
  data.dc[0][2] = 37;
  data.dc[1][0] = 41;
  const cb = buildScalingFactors(data, 3, 1);
  const cr = buildScalingFactors(data, 3, 2);
  const y = buildScalingFactors(data, 3, 0);
  expect(cb[0]).toBe(31);
  expect(cb[1]).toBe(23);
  expect(cb[1023]).toBe(23);
  expect(cr[0]).toBe(37);
  expect(cr[1023]).toBe(29);
  expect(y[0]).toBe(41);
});
