import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { splitAnnexB } from '../src/hevc/nal';
import { parsePps } from '../src/hevc/pps';
import { parseSps } from '../src/hevc/sps';

describe('HEVC screen-content parameter sets', () => {
  it('parses the official zero/one palette-size vector SPS and PPS', () => {
    const bitstream = new Uint8Array(
      readFileSync(
        new URL('./fixtures/conformance/Zero_and_One_Palette_Size_A_Canon_2.bit', import.meta.url),
      ),
    );
    const nals = splitAnnexB(bitstream);
    const spsNal = nals.find((nal) => nal.type === 33);
    const ppsNal = nals.find((nal) => nal.type === 34);
    if (!spsNal || !ppsNal) throw new Error('official SCC vector is missing its SPS or PPS');

    const sps = parseSps(spsNal.data);
    expect([sps.chromaFormatIdc, sps.bitDepthLuma, sps.bitDepthChroma]).toEqual([3, 8, 8]);
    expect(sps.explicitRdpcmEnabled).toBe(true);
    expect([sps.maxTransformHierarchyDepthInter, sps.maxTransformHierarchyDepthIntra]).toEqual([
      3, 3,
    ]);
    expect(sps.screenContentExtension).toMatchObject({
      currPicRefEnabled: true,
      paletteModeEnabled: true,
      paletteMaxSize: 63,
      deltaPaletteMaxPredictorSize: 65,
      palettePredictorInitializersPresent: false,
      motionVectorResolutionControlIdc: 0,
      intraBoundaryFilteringDisabled: true,
    });

    const pps = parsePps(ppsNal.data);
    expect(pps.screenContentExtension).toMatchObject({
      currPicRefEnabled: true,
      residualAdaptiveColourTransformEnabled: true,
      sliceActQpOffsetsPresent: false,
      palettePredictorInitializersPresent: false,
      palettePredictorInitializers: null,
    });
  });
});
