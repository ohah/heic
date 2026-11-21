import { expect, it } from 'bun:test';
import { HeicError } from '../src/errors';
import type { Planes } from '../src/planes';
import { resampleInterLayerPicture } from '../src/hevc/resample';
import type { SpsInfo } from '../src/hevc/sps';

function targetSps(width: number, height: number, bitDepth = 8, chromaFormatIdc = 1): SpsInfo {
  return {
    picWidthInLumaSamples: width,
    picHeightInLumaSamples: height,
    chromaFormatIdc,
    bitDepthLuma: bitDepth,
    bitDepthChroma: bitDepth,
  } as SpsInfo;
}

function sourcePlanes(
  width: number,
  height: number,
  y: number[],
  cb: number[],
  cr: number[],
  bitDepth = 8,
): Planes {
  return {
    width,
    height,
    chromaFormatIdc: 1,
    bitDepthLuma: bitDepth,
    bitDepthChroma: bitDepth,
    hasExternalInterMotion: false,
    y: Uint8Array.from(y),
    cb: Uint8Array.from(cb),
    cr: Uint8Array.from(cr),
  };
}

it('resamples constant luma and chroma samples without changing their values', () => {
  const output = resampleInterLayerPicture(
    sourcePlanes(2, 2, [128, 128, 128, 128], [96], [160]),
    targetSps(4, 4),
    undefined,
  );

  expect([...output.y]).toEqual(Array<number>(16).fill(128));
  expect([...output.cb]).toEqual(Array<number>(4).fill(96));
  expect([...output.cr]).toEqual(Array<number>(4).fill(160));
});

it('maps scaled reference offsets and promotes samples to the current bit depth', () => {
  const output = resampleInterLayerPicture(
    sourcePlanes(2, 2, [16, 32, 48, 64], [20], [40]),
    targetSps(6, 6, 10),
    {
      refLocLayerId: 0,
      scaledRefLayerOffsets: [1, 1, 1, 1],
      refRegionOffsets: null,
      resamplePhases: null,
    },
  );

  expect(output.width).toBe(6);
  expect(output.height).toBe(6);
  expect([...output.y]).toEqual([
    64, 64, 64, 128, 128, 128, 64, 64, 64, 128, 128, 128, 64, 64, 64, 128, 128, 128, 192, 192, 192,
    256, 256, 256, 192, 192, 192, 256, 256, 256, 192, 192, 192, 256, 256, 256,
  ]);
  expect([...output.cb]).toEqual([80, 80, 80, 80, 80, 80, 80, 80, 80]);
  expect([...output.cr]).toEqual([160, 160, 160, 160, 160, 160, 160, 160, 160]);
});

it('resamples denser reference chroma into a sparser current chroma format', () => {
  const source = sourcePlanes(
    4,
    4,
    Array<number>(16).fill(128),
    Array<number>(16).fill(96),
    Array<number>(16).fill(160),
  );
  source.chromaFormatIdc = 3;
  const output = resampleInterLayerPicture(source, targetSps(6, 6), undefined);

  expect(output.width).toBe(6);
  expect(output.height).toBe(6);
  expect([...output.cb]).toEqual(Array<number>(9).fill(96));
  expect([...output.cr]).toEqual(Array<number>(9).fill(160));
});

it('resamples Annex H motion and mode maps on 16x16 block centres', () => {
  const source = sourcePlanes(
    64,
    16,
    Array<number>(64 * 16).fill(128),
    Array<number>(32 * 8).fill(96),
    Array<number>(32 * 8).fill(160),
  );
  const mapLength = (source.width >> 2) * (source.height >> 2);
  source.hasExternalInterMotion = true;
  source.interMap = new Uint8Array(mapLength).fill(1);
  source.motionIsExternal = new Uint8Array(mapLength);
  source.motionPredFlags = new Uint8Array(mapLength).fill(1);
  source.motionRefIdxL0 = new Uint8Array(mapLength).fill(2);
  source.motionXQpel = new Int32Array(mapLength);
  source.motionYQpel = new Int32Array(mapLength).fill(-4);
  source.motionRefPoc = new Float64Array(mapLength).fill(7);
  source.motionRefLongTerm = new Uint8Array(mapLength);
  source.motionXQpelL1 = new Int32Array(mapLength);
  source.motionYQpelL1 = new Int32Array(mapLength);
  source.motionRefIdxL1 = new Uint8Array(mapLength);
  source.motionRefPocL1 = new Float64Array(mapLength);
  source.motionRefLongTermL1 = new Uint8Array(mapLength);

  // The left 16x16 block is IBC; the remaining blocks use external L0 refs.
  for (let y = 0; y < 4; y++) {
    for (let x = 4; x < 16; x++) source.motionIsExternal[y * 16 + x] = 1;
  }
  for (let y = 0; y < 4; y++) {
    for (let x = 4; x < 8; x++) source.motionXQpel[y * 16 + x] = 8;
    for (let x = 8; x < 12; x++) source.motionXQpel[y * 16 + x] = -16;
    for (let x = 12; x < 16; x++) source.motionXQpel[y * 16 + x] = 4;
  }

  const output = resampleInterLayerPicture(source, targetSps(96, 16), undefined);
  const row = output.interMap!.subarray(0, 24);
  expect([...row]).toEqual([
    0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  ]);
  expect([...output.motionXQpel!.subarray(0, 24)]).toEqual([
    0, 0, 0, 0, 12, 12, 12, 12, 12, 12, 12, 12, -24, -24, -24, -24, 6, 6, 6, 6, 6, 6, 6, 6,
  ]);
  expect(output.motionRefIdxL0![4]).toBe(2);
  expect(output.motionRefPoc![4]).toBe(7);
  expect(output.motionPredFlags![4]).toBe(1);
  expect(output.hasExternalInterMotion).toBe(true);
});

it('resamples motion maps on 16x16 block centres when sample geometry is identical', () => {
  const source = sourcePlanes(
    32,
    16,
    Array<number>(32 * 16).fill(128),
    Array<number>(16 * 8).fill(96),
    Array<number>(16 * 8).fill(160),
  );
  const mapLength = (source.width >> 2) * (source.height >> 2);
  source.hasExternalInterMotion = true;
  source.interMap = new Uint8Array(mapLength).fill(1);
  source.motionIsExternal = new Uint8Array(mapLength).fill(1);
  source.motionPredFlags = new Uint8Array(mapLength).fill(1);
  source.motionRefIdxL0 = new Uint8Array(mapLength);
  source.motionXQpel = new Int32Array(mapLength);
  source.motionYQpel = new Int32Array(mapLength);
  source.motionRefPoc = new Float64Array(mapLength).fill(3);
  source.motionRefLongTerm = new Uint8Array(mapLength);
  source.motionXQpelL1 = new Int32Array(mapLength);
  source.motionYQpelL1 = new Int32Array(mapLength);
  source.motionRefIdxL1 = new Uint8Array(mapLength);
  source.motionRefPocL1 = new Float64Array(mapLength);
  source.motionRefLongTermL1 = new Uint8Array(mapLength);

  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) source.motionXQpel[y * 8 + x] = 8;
    for (let x = 4; x < 8; x++) source.motionXQpel[y * 8 + x] = 16;
  }

  const output = resampleInterLayerPicture(source, targetSps(32, 16), undefined);

  expect(output.y).toBe(source.y);
  expect(output.cb).toBe(source.cb);
  expect(output.cr).toBe(source.cr);
  expect([...output.motionXQpel!.subarray(0, 8)]).toEqual([8, 8, 8, 8, 16, 16, 16, 16]);
  expect([...output.motionXQpel!.subarray(8, 16)]).toEqual([8, 8, 8, 8, 16, 16, 16, 16]);
  expect([...output.motionPredFlags!.subarray(0, 16)]).toEqual(Array<number>(16).fill(1));
  expect(output.hasExternalInterMotion).toBe(true);
});

it('rejects inter-layer downsampling as a non-conforming bitstream', () => {
  let error: unknown;
  try {
    resampleInterLayerPicture(
      sourcePlanes(4, 4, Array<number>(16).fill(0), [0, 0, 0, 0], [0, 0, 0, 0]),
      targetSps(2, 2),
      undefined,
    );
  } catch (caught) {
    error = caught;
  }

  expect(error).toBeInstanceOf(HeicError);
  expect(error).toMatchObject({ code: 'INVALID_BITSTREAM' });
});

it('rejects monochrome/color layer mismatches as non-conforming bitstreams', () => {
  const monochromeSource = sourcePlanes(2, 2, [0, 64, 128, 255], [], []);
  monochromeSource.chromaFormatIdc = 0;
  const colourSource = sourcePlanes(2, 2, [0, 64, 128, 255], [96], [160]);
  const cases = [
    [monochromeSource, targetSps(4, 4)],
    [colourSource, targetSps(4, 4, 8, 0)],
  ] as const;

  for (const [source, target] of cases) {
    let error: unknown;
    try {
      resampleInterLayerPicture(source, target, undefined);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HeicError);
    expect(error).toMatchObject({ code: 'INVALID_BITSTREAM' });
  }
});
