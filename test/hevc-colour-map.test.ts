import { describe, expect, it } from 'bun:test';
import { applyColourMappingTable } from '../src/hevc/colour-map';
import type {
  PpsColourMappingCellInfo,
  PpsColourMappingOctantInfo,
  PpsColourMappingTableInfo,
} from '../src/hevc/pps';
import type { Planes } from '../src/planes';

function emptyCell(): PpsColourMappingCellInfo {
  return { components: null };
}

function emptyLeaf(yPartCount: number): PpsColourMappingOctantInfo {
  return {
    children: [],
    yParts: Array.from({ length: yPartCount }, () => Array.from({ length: 4 }, () => emptyCell())),
  };
}

function makeTable(
  options: {
    inputBitDepth?: number;
    outputBitDepth?: number;
    octantDepth?: number;
    yPartNumLog2?: number;
    addLumaCbCoefficient?: boolean;
    crossYOctantCoefficient?: boolean;
  } = {},
): PpsColourMappingTableInfo {
  const {
    inputBitDepth = 8,
    outputBitDepth = inputBitDepth,
    octantDepth = 0,
    yPartNumLog2 = 0,
    addLumaCbCoefficient = false,
    crossYOctantCoefficient = false,
  } = options;
  const yPartCount = 1 << yPartNumLog2;
  let octants = emptyLeaf(yPartCount);
  if (octantDepth === 1) {
    octants = {
      children: Array.from({ length: 8 }, () => emptyLeaf(yPartCount)),
      yParts: [],
    };
  }

  if (addLumaCbCoefficient) {
    const leaf = octantDepth === 0 ? octants : octants.children[0];
    if (!leaf) throw new Error('test setup: missing first colour-mapping octant');
    const yPart = crossYOctantCoefficient ? yPartCount - 1 : 0;
    leaf.yParts[yPart][1] = {
      components: [
        { resCoeffQ: 2, resCoeffR: 0, resCoeffSignFlag: false },
        { resCoeffQ: 0, resCoeffR: 0, resCoeffSignFlag: null },
        { resCoeffQ: 0, resCoeffR: 0, resCoeffSignFlag: null },
      ],
    };
  }

  return {
    numCmRefLayersMinus1: 0,
    cmRefLayerIds: [0],
    cmOctantDepth: octantDepth,
    cmYPartNumLog2: yPartNumLog2,
    lumaBitDepthCmInput: inputBitDepth,
    chromaBitDepthCmInput: inputBitDepth,
    lumaBitDepthCmOutput: outputBitDepth,
    chromaBitDepthCmOutput: outputBitDepth,
    cmResQuantBits: 0,
    cmDeltaFlcBitsMinus1: 0,
    cmAdaptThresholdUDelta: octantDepth === 1 ? 0 : null,
    cmAdaptThresholdVDelta: octantDepth === 1 ? 0 : null,
    octants,
  };
}

function makePlanes(
  chromaFormatIdc: number,
  width: number,
  height: number,
  y: number[],
  cb: number[],
  cr: number[],
  bitDepth = 8,
): Planes {
  return {
    chromaFormatIdc,
    bitDepthLuma: bitDepth,
    bitDepthChroma: bitDepth,
    hasExternalInterMotion: false,
    y: Uint8Array.from(y),
    cb: Uint8Array.from(cb),
    cr: Uint8Array.from(cr),
    width,
    height,
  };
}

describe('HEVC Annex H colour mapping', () => {
  it('derives the default identity coefficients and raises 8-bit samples to 10-bit', () => {
    const reference = makePlanes(1, 2, 2, [1, 64, 127, 255], [0], [255]);
    const mapped = applyColourMappingTable(reference, makeTable({ outputBitDepth: 10 }));

    expect(Array.from(mapped.y)).toEqual([4, 256, 508, 1020]);
    expect(Array.from(mapped.cb)).toEqual([0]);
    expect(Array.from(mapped.cr)).toEqual([1020]);
    expect(mapped.bitDepthLuma).toBe(10);
    expect(mapped.bitDepthChroma).toBe(10);
  });

  it('uses the specified 4:2:0 chroma upsampling filters in luma mapping', () => {
    const reference = makePlanes(1, 4, 2, [10, 10, 10, 10, 10, 10, 10, 10], [20, 60], [5, 15]);
    const mapped = applyColourMappingTable(reference, makeTable({ addLumaCbCoefficient: true }));

    expect(Array.from(mapped.y)).toEqual([30, 50, 70, 70, 30, 50, 70, 70]);
    expect(Array.from(mapped.cb)).toEqual([20, 60]);
    expect(Array.from(mapped.cr)).toEqual([5, 15]);
  });

  it('carries luma coefficients across adjacent Y octants as Annex F requires', () => {
    const reference = makePlanes(1, 2, 2, [200, 200, 200, 200], [20], [10]);
    const mapped = applyColourMappingTable(
      reference,
      makeTable({
        octantDepth: 1,
        yPartNumLog2: 2,
        addLumaCbCoefficient: true,
        crossYOctantCoefficient: true,
      }),
    );

    expect(Array.from(mapped.y)).toEqual([220, 220, 220, 220]);
  });

  it('supports 4:2:2 and 4:4:4 chroma sample locations', () => {
    const coefficientTable = makeTable({ addLumaCbCoefficient: true });
    const reference422 = makePlanes(2, 4, 1, [10, 10, 10, 10], [20, 60], [0, 0]);
    const reference444 = makePlanes(3, 2, 2, [10, 10, 10, 10], [20, 60, 40, 80], [0, 0, 0, 0]);

    expect(Array.from(applyColourMappingTable(reference422, coefficientTable).y)).toEqual([
      30, 50, 70, 70,
    ]);
    expect(Array.from(applyColourMappingTable(reference444, coefficientTable).y)).toEqual([
      30, 70, 50, 90,
    ]);
  });
});
