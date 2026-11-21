import { HeicError } from '../errors.js';
import type { Planes } from '../planes.js';
import { type PpsColourMappingOctantInfo, type PpsColourMappingTableInfo } from './pps.js';
import { chromaSubsampling } from './chroma.js';

type ColourMappingCoefficients = [Int32Array, Int32Array, Int32Array];

interface ColourMappingLut {
  /** [idxY][idxCb][idxCr], with four coefficients for each output component. */
  entries: ColourMappingCoefficients[][][];
  yShift: number;
  cShift: number;
  mappingShift: number;
  mappingOffset: number;
  thresholdU: number;
  thresholdV: number;
  octantDepth: number;
  yPartNumLog2: number;
  inputBitDepthY: number;
  inputBitDepthC: number;
  outputBitDepthY: number;
  outputBitDepthC: number;
}

function invalid(message: string): never {
  throw new HeicError('INVALID_BITSTREAM', `heic: ${message}`);
}

function collectLeaves(
  node: PpsColourMappingOctantInfo,
  maxDepth: number,
  depth = 0,
  idxY = 0,
  idxCb = 0,
  idxCr = 0,
  leaves = new Map<string, PpsColourMappingOctantInfo>(),
): Map<string, PpsColourMappingOctantInfo> {
  if (depth === maxDepth || node.children.length === 0) {
    leaves.set(`${idxY}:${idxCb}:${idxCr}`, node);
    return leaves;
  }
  if (node.children.length !== 8) invalid('PPS colour mapping octant has an invalid child count');
  for (let childIndex = 0; childIndex < 8; childIndex++) {
    const child = node.children[childIndex];
    if (!child) invalid('PPS colour mapping octant is missing a child');
    collectLeaves(
      child,
      maxDepth,
      depth + 1,
      (idxY << 1) | ((childIndex >> 2) & 1),
      (idxCb << 1) | ((childIndex >> 1) & 1),
      (idxCr << 1) | (childIndex & 1),
      leaves,
    );
  }
  return leaves;
}

function coefficientResidual(
  table: PpsColourMappingTableInfo,
  cell: PpsColourMappingOctantInfo['yParts'][number][number],
  componentIndex: number,
  residualLsbBits: number,
): bigint {
  const component = cell.components?.[componentIndex];
  if (!component) return 0n;
  const magnitude =
    ((BigInt(component.resCoeffQ) << BigInt(residualLsbBits)) + BigInt(component.resCoeffR)) <<
    BigInt(table.cmResQuantBits);
  return component.resCoeffSignFlag === true ? -magnitude : magnitude;
}

/** Derive the Annex F coefficient table used by Annex H colour mapping. */
function deriveColourMappingLut(table: PpsColourMappingTableInfo): ColourMappingLut {
  const { cmOctantDepth: octantDepth, cmYPartNumLog2: yPartNumLog2 } = table;
  if (
    !Number.isInteger(octantDepth) ||
    octantDepth < 0 ||
    octantDepth > 1 ||
    !Number.isInteger(yPartNumLog2) ||
    yPartNumLog2 < 0 ||
    octantDepth + yPartNumLog2 > 3
  )
    invalid('PPS colour mapping octant dimensions are invalid');

  const inputBitDepthY = table.lumaBitDepthCmInput;
  const inputBitDepthC = table.chromaBitDepthCmInput;
  const outputBitDepthY = table.lumaBitDepthCmOutput;
  const outputBitDepthC = table.chromaBitDepthCmOutput;
  if (
    ![inputBitDepthY, inputBitDepthC, outputBitDepthY, outputBitDepthC].every(
      (depth) => Number.isInteger(depth) && depth >= 8 && depth <= 15,
    ) ||
    outputBitDepthY < inputBitDepthY ||
    outputBitDepthC < inputBitDepthC
  )
    invalid('PPS colour mapping bit depths are invalid');

  const residualLsbBits = Math.max(
    0,
    10 + inputBitDepthY - outputBitDepthY - table.cmResQuantBits - (table.cmDeltaFlcBitsMinus1 + 1),
  );
  const octantCountY = 1 << octantDepth;
  const octantCountC = 1 << octantDepth;
  const yPartCount = 1 << yPartNumLog2;
  const indexCountY = octantCountY * yPartCount;
  const leaves = collectLeaves(table.octants, octantDepth);
  const entries: ColourMappingCoefficients[][][] = Array.from({ length: indexCountY }, () =>
    Array.from({ length: octantCountC }, () =>
      Array.from({ length: octantCountC }, () => [
        new Int32Array(4),
        new Int32Array(4),
        new Int32Array(4),
      ]),
    ),
  );

  for (let idxY = 0; idxY < indexCountY; idxY++) {
    const octantY = idxY >> yPartNumLog2;
    const yPart = idxY & (yPartCount - 1);
    for (let idxCb = 0; idxCb < octantCountC; idxCb++) {
      for (let idxCr = 0; idxCr < octantCountC; idxCr++) {
        const leaf = leaves.get(`${octantY}:${idxCb}:${idxCr}`);
        const cells = leaf?.yParts[yPart];
        if (!cells || cells.length !== 4)
          invalid('PPS colour mapping octant has an incomplete coefficient set');
        for (let j = 0; j < 4; j++) {
          const cell = cells[j];
          if (!cell) invalid('PPS colour mapping coefficient is missing');
          for (let component = 0; component < 3; component++) {
            const predicted =
              idxY === 0
                ? component === j
                  ? 1024n
                  : 0n
                : BigInt(entries[idxY - 1][idxCb][idxCr][component][j]);
            const value = predicted + coefficientResidual(table, cell, component, residualLsbBits);
            if (value < -2048n || value > 2047n)
              invalid('PPS colour mapping coefficient is outside the conforming range');
            entries[idxY][idxCb][idxCr][component][j] = Number(value);
          }
        }
      }
    }
  }

  const mappingShift = 10 + inputBitDepthY - outputBitDepthY;
  if (mappingShift < 1) invalid('PPS colour mapping shift is invalid');
  const halfChromaRange = 1 << (inputBitDepthC - 1);
  return {
    entries,
    yShift: inputBitDepthY - octantDepth - yPartNumLog2,
    cShift: inputBitDepthC - octantDepth,
    mappingShift,
    mappingOffset: 1 << (mappingShift - 1),
    thresholdU: (table.cmAdaptThresholdUDelta ?? 0) + halfChromaRange,
    thresholdV: (table.cmAdaptThresholdVDelta ?? 0) + halfChromaRange,
    octantDepth,
    yPartNumLog2,
    inputBitDepthY,
    inputBitDepthC,
    outputBitDepthY,
    outputBitDepthC,
  };
}

function clipSample(value: number, bitDepth: number): number {
  return Math.max(0, Math.min((1 << bitDepth) - 1, value));
}

function mapSample(
  coefficients: Int32Array,
  first: number,
  second: number,
  third: number,
  lut: ColourMappingLut,
  outputBitDepth: number,
): number {
  const mapped =
    ((coefficients[0] * first +
      coefficients[1] * second +
      coefficients[2] * third +
      lut.mappingOffset) >>
      lut.mappingShift) +
    coefficients[3];
  return clipSample(mapped, outputBitDepth);
}

function chromaAtLumaSample(
  plane: Uint8Array | Uint16Array,
  xP: number,
  yP: number,
  chromaWidth: number,
  chromaHeight: number,
  subWidth: number,
  subHeight: number,
): number {
  const xPC = Math.floor(xP / subWidth);
  const yPC = Math.floor(yP / subHeight);
  const at = (x: number, y: number) => plane[y * chromaWidth + x];

  if (subWidth === 2 && subHeight === 2) {
    if ((xP & 1) === 0) {
      const yP2C = (yP & 1) === 0 ? Math.max(0, yPC - 1) : Math.min(yPC + 1, chromaHeight - 1);
      return (at(xPC, yPC) * 3 + at(xPC, yP2C) + 2) >> 2;
    }
    const xP2C = Math.min(xPC + 1, chromaWidth - 1);
    if ((yP & 1) === 0) {
      const yP2C = Math.max(0, yPC - 1);
      return (at(xPC, yP2C) + at(xP2C, yP2C) + (at(xPC, yPC) + at(xP2C, yPC)) * 3 + 4) >> 3;
    }
    const yP2C = Math.min(yPC + 1, chromaHeight - 1);
    return ((at(xPC, yPC) + at(xP2C, yPC)) * 3 + at(xPC, yP2C) + at(xP2C, yP2C) + 4) >> 3;
  }
  if (subWidth === 2) {
    if ((xP & 1) === 1) {
      const xP2C = Math.min(xPC + 1, chromaWidth - 1);
      return (at(xPC, yPC) + at(xP2C, yPC) + 1) >> 1;
    }
    return at(xPC, yPC);
  }
  return at(xPC, yPC);
}

/** Apply Annex F PPS colour coefficients through Annex H inter-layer mapping. */
export function applyColourMappingTable(
  reference: Planes,
  table: PpsColourMappingTableInfo,
): Planes {
  const lut = deriveColourMappingLut(table);
  if (reference.chromaFormatIdc === 0)
    throw new HeicError('UNSUPPORTED_FEATURE', 'heic: colour mapping requires chroma samples');
  const { width, height } = reference;
  const { width: subWidth, height: subHeight } = chromaSubsampling(reference.chromaFormatIdc);
  const chromaWidth = Math.ceil(width / subWidth);
  const chromaHeight = Math.ceil(height / subHeight);
  if (
    reference.y.length !== width * height ||
    reference.cb.length !== chromaWidth * chromaHeight ||
    reference.cr.length !== reference.cb.length
  )
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: inter-layer reference sample planes have invalid geometry',
    );
  if (
    (reference.bitDepthLuma !== undefined && reference.bitDepthLuma !== lut.inputBitDepthY) ||
    (reference.bitDepthChroma !== undefined && reference.bitDepthChroma !== lut.inputBitDepthC)
  )
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: PPS colour mapping bit depths disagree with reference layer',
    );

  const y: Uint8Array | Uint16Array =
    lut.outputBitDepthY <= 8
      ? new Uint8Array(reference.y.length)
      : new Uint16Array(reference.y.length);
  const cb: Uint8Array | Uint16Array =
    lut.outputBitDepthC <= 8
      ? new Uint8Array(reference.cb.length)
      : new Uint16Array(reference.cb.length);
  const cr: Uint8Array | Uint16Array =
    lut.outputBitDepthC <= 8
      ? new Uint8Array(reference.cr.length)
      : new Uint16Array(reference.cr.length);
  for (let yP = 0; yP < height; yP++) {
    for (let xP = 0; xP < width; xP++) {
      const offset = yP * width + xP;
      const sourceY = reference.y[offset];
      const tempCb = chromaAtLumaSample(
        reference.cb,
        xP,
        yP,
        chromaWidth,
        chromaHeight,
        subWidth,
        subHeight,
      );
      const tempCr = chromaAtLumaSample(
        reference.cr,
        xP,
        yP,
        chromaWidth,
        chromaHeight,
        subWidth,
        subHeight,
      );
      const idxY = sourceY >> lut.yShift;
      const idxCb = lut.octantDepth === 1 ? Number(tempCb >= lut.thresholdU) : tempCb >> lut.cShift;
      const idxCr = lut.octantDepth === 1 ? Number(tempCr >= lut.thresholdV) : tempCr >> lut.cShift;
      const coefficientSet = lut.entries[idxY]?.[idxCb]?.[idxCr];
      if (!coefficientSet) invalid('reference sample selects a missing PPS colour mapping octant');
      y[offset] = mapSample(coefficientSet[0], sourceY, tempCb, tempCr, lut, lut.outputBitDepthY);
    }
  }

  for (let yC = 0; yC < chromaHeight; yC++) {
    for (let xC = 0; xC < chromaWidth; xC++) {
      const offset = yC * chromaWidth + xC;
      const xP = xC * subWidth;
      const yP = yC * subHeight;
      const tempY =
        subWidth === 2 && subHeight === 2
          ? (reference.y[yP * width + xP] + reference.y[(yP + 1) * width + xP] + 1) >> 1
          : reference.y[yP * width + xP];
      const sourceCb = reference.cb[offset];
      const sourceCr = reference.cr[offset];
      const idxY = tempY >> lut.yShift;
      const idxCb =
        lut.octantDepth === 1 ? Number(sourceCb >= lut.thresholdU) : sourceCb >> lut.cShift;
      const idxCr =
        lut.octantDepth === 1 ? Number(sourceCr >= lut.thresholdV) : sourceCr >> lut.cShift;
      const coefficientSet = lut.entries[idxY]?.[idxCb]?.[idxCr];
      if (!coefficientSet) invalid('reference sample selects a missing PPS colour mapping octant');
      cb[offset] = mapSample(
        coefficientSet[1],
        tempY,
        sourceCb,
        sourceCr,
        lut,
        lut.outputBitDepthC,
      );
      cr[offset] = mapSample(
        coefficientSet[2],
        tempY,
        sourceCb,
        sourceCr,
        lut,
        lut.outputBitDepthC,
      );
    }
  }

  return {
    ...reference,
    y,
    cb,
    cr,
    bitDepthLuma: lut.outputBitDepthY,
    bitDepthChroma: lut.outputBitDepthC,
  };
}
