import { HeicError } from '../errors.js';
import type { Planes } from '../planes.js';
import { chromaSubsampling } from './chroma.js';
import type { PpsReferenceLocationOffsetInfo } from './pps.js';
import type { SpsInfo } from './sps.js';

const LUMA_FILTER: readonly (readonly number[])[] = [
  [0, 0, 0, 64, 0, 0, 0, 0],
  [0, 1, -3, 63, 4, -2, 1, 0],
  [-1, 2, -5, 62, 8, -3, 1, 0],
  [-1, 3, -8, 60, 13, -4, 1, 0],
  [-1, 4, -10, 58, 17, -5, 1, 0],
  [-1, 4, -11, 52, 26, -8, 3, -1],
  [-1, 3, -9, 47, 31, -10, 4, -1],
  [-1, 4, -11, 45, 34, -10, 4, -1],
  [-1, 4, -11, 40, 40, -11, 4, -1],
  [-1, 4, -10, 34, 45, -11, 4, -1],
  [-1, 4, -10, 31, 47, -9, 3, -1],
  [-1, 3, -8, 26, 52, -11, 4, -1],
  [0, 1, -5, 17, 58, -10, 4, -1],
  [0, 1, -4, 13, 60, -8, 3, -1],
  [0, 1, -3, 8, 62, -5, 2, -1],
  [0, 1, -2, 4, 63, -3, 1, 0],
];

const CHROMA_FILTER: readonly (readonly number[])[] = [
  [0, 64, 0, 0],
  [-2, 62, 4, 0],
  [-2, 58, 10, -2],
  [-4, 56, 14, -2],
  [-4, 54, 16, -2],
  [-6, 52, 20, -2],
  [-6, 46, 28, -4],
  [-4, 42, 30, -4],
  [-4, 36, 36, -4],
  [-4, 30, 42, -4],
  [-4, 28, 46, -6],
  [-2, 20, 52, -6],
  [-2, 16, 54, -4],
  [-2, 14, 56, -4],
  [-2, 10, 58, -2],
  [0, 4, 62, -2],
];

interface ResamplingGeometry {
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  sourceChromaSubWidth: number;
  sourceChromaSubHeight: number;
  targetChromaSubWidth: number;
  targetChromaSubHeight: number;
  refLeft: number;
  refTop: number;
  refRight: number;
  refBottom: number;
  scaledLeft: number;
  scaledTop: number;
  scaledRight: number;
  scaledBottom: number;
  refRegionWidth: number;
  refRegionHeight: number;
  scaledRegionWidth: number;
  scaledRegionHeight: number;
  scaleHorY: number;
  scaleVerY: number;
  scaleHorC: number;
  scaleVerC: number;
  phaseHorY: number;
  phaseVerY: number;
  phaseHorC: number;
  phaseVerC: number;
}

interface ResampledMotionMaps {
  interMap: Uint8Array;
  motionIsExternal: Uint8Array;
  motionPredFlags: Uint8Array;
  motionRefIdxL0: Uint8Array;
  motionXQpel: Int32Array;
  motionYQpel: Int32Array;
  motionRefPoc: Float64Array;
  motionRefLongTerm: Uint8Array;
  motionRefLayerId: Uint8Array;
  motionXQpelL1: Int32Array;
  motionYQpelL1: Int32Array;
  motionRefIdxL1: Uint8Array;
  motionRefPocL1: Float64Array;
  motionRefLongTermL1: Uint8Array;
  motionRefLayerIdL1: Uint8Array;
}

function invalid(message: string): never {
  throw new HeicError('INVALID_BITSTREAM', `heic: ${message}`);
}

function unsupported(message: string): never {
  throw new HeicError('UNSUPPORTED_FEATURE', `heic: ${message}`);
}

function roundedScale(refExtent: number, scaledExtent: number): number {
  if (refExtent <= 0 || scaledExtent <= 0) invalid('empty L-HEVC resampling region');
  return Math.floor((refExtent * 65_536 + Math.floor(scaledExtent / 2)) / scaledExtent);
}

function deriveGeometry(
  source: Planes,
  target: SpsInfo,
  location: PpsReferenceLocationOffsetInfo | undefined,
): ResamplingGeometry {
  const sourceSub = chromaSubsampling(source.chromaFormatIdc);
  const targetSub = chromaSubsampling(target.chromaFormatIdc);
  if ((source.chromaFormatIdc === 0) !== (target.chromaFormatIdc === 0))
    invalid('L-HEVC reference layer and current layer have incompatible monochrome/colour formats');
  if (
    (source.bitDepthLuma ?? 8) > target.bitDepthLuma ||
    (source.bitDepthChroma ?? source.bitDepthLuma ?? 8) > target.bitDepthChroma
  )
    invalid('L-HEVC reference-layer bit depth exceeds the current layer');
  const [refLeftRaw, refTopRaw, refRightRaw, refBottomRaw] = location?.refRegionOffsets ?? [
    0, 0, 0, 0,
  ];
  const [scaledLeftRaw, scaledTopRaw, scaledRightRaw, scaledBottomRaw] =
    location?.scaledRefLayerOffsets ?? [0, 0, 0, 0];

  const refLeft = refLeftRaw * sourceSub.width;
  const refTop = refTopRaw * sourceSub.height;
  const refRight = refRightRaw * sourceSub.width;
  const refBottom = refBottomRaw * sourceSub.height;
  const scaledLeft = scaledLeftRaw * targetSub.width;
  const scaledTop = scaledTopRaw * targetSub.height;
  const scaledRight = scaledRightRaw * targetSub.width;
  const scaledBottom = scaledBottomRaw * targetSub.height;
  const refRegionWidth = source.width - refLeft - refRight;
  const refRegionHeight = source.height - refTop - refBottom;
  const scaledRegionWidth = target.picWidthInLumaSamples - scaledLeft - scaledRight;
  const scaledRegionHeight = target.picHeightInLumaSamples - scaledTop - scaledBottom;

  if (
    ![refLeft, refTop, refRight, refBottom, scaledLeft, scaledTop, scaledRight, scaledBottom].every(
      Number.isSafeInteger,
    ) ||
    refRegionWidth <= 0 ||
    refRegionHeight <= 0 ||
    scaledRegionWidth <= 0 ||
    scaledRegionHeight <= 0
  )
    invalid('invalid L-HEVC inter-layer reference region');

  if (scaledRegionWidth < refRegionWidth || scaledRegionHeight < refRegionHeight)
    invalid('L-HEVC scaled luma reference region is smaller than the reference region');

  const scaleHorY = roundedScale(refRegionWidth, scaledRegionWidth);
  const scaleVerY = roundedScale(refRegionHeight, scaledRegionHeight);
  const refRegionWidthC = refRegionWidth / sourceSub.width;
  const refRegionHeightC = refRegionHeight / sourceSub.height;
  const scaledRegionWidthC = scaledRegionWidth / targetSub.width;
  const scaledRegionHeightC = scaledRegionHeight / targetSub.height;
  if (
    !Number.isInteger(refRegionWidthC) ||
    !Number.isInteger(refRegionHeightC) ||
    !Number.isInteger(scaledRegionWidthC) ||
    !Number.isInteger(scaledRegionHeightC)
  )
    invalid('L-HEVC chroma resampling region is not aligned to subsampling');

  const scaleHorC = roundedScale(refRegionWidthC, scaledRegionWidthC);
  const scaleVerC = roundedScale(refRegionHeightC, scaledRegionHeightC);
  const phases = location?.resamplePhases;
  const phaseHorY = phases?.[0] ?? 0;
  const phaseVerY = phases?.[1] ?? 0;
  const phaseHorC = (phases?.[2] ?? 8) - 8;
  const defaultPhaseVerCPlus8 =
    target.chromaFormatIdc === 3
      ? 8
      : Math.floor((4 * scaledRegionHeight + refRegionHeight / 2) / refRegionHeight) + 4;
  const phaseVerC = (phases?.[3] ?? defaultPhaseVerCPlus8) - 8;
  if (
    phaseHorY < 0 ||
    phaseHorY > 31 ||
    phaseVerY < 0 ||
    phaseVerY > 31 ||
    phaseHorC < -8 ||
    phaseHorC > 55 ||
    phaseVerC < -8 ||
    phaseVerC > 55
  )
    invalid('L-HEVC resampling phase is out of range');

  return {
    sourceWidth: source.width,
    sourceHeight: source.height,
    targetWidth: target.picWidthInLumaSamples,
    targetHeight: target.picHeightInLumaSamples,
    sourceChromaSubWidth: sourceSub.width,
    sourceChromaSubHeight: sourceSub.height,
    targetChromaSubWidth: targetSub.width,
    targetChromaSubHeight: targetSub.height,
    refLeft,
    refTop,
    refRight,
    refBottom,
    scaledLeft,
    scaledTop,
    scaledRight,
    scaledBottom,
    refRegionWidth,
    refRegionHeight,
    scaledRegionWidth,
    scaledRegionHeight,
    scaleHorY,
    scaleVerY,
    scaleHorC,
    scaleVerC,
    phaseHorY,
    phaseVerY,
    phaseHorC,
    phaseVerC,
  };
}

function isIdentityResampling(
  source: Planes,
  target: SpsInfo,
  geometry: ResamplingGeometry,
): boolean {
  return (
    source.width === geometry.targetWidth &&
    source.height === geometry.targetHeight &&
    source.chromaFormatIdc === target.chromaFormatIdc &&
    source.bitDepthLuma === target.bitDepthLuma &&
    source.bitDepthChroma === target.bitDepthChroma &&
    geometry.scaledLeft === geometry.refLeft &&
    geometry.scaledTop === geometry.refTop &&
    geometry.scaledRight === geometry.refRight &&
    geometry.scaledBottom === geometry.refBottom &&
    geometry.phaseHorY === 0 &&
    geometry.phaseVerY === 0 &&
    geometry.phaseHorC === 0 &&
    geometry.phaseVerC === 0
  );
}

function clip(value: number, maximum: number): number {
  return Math.min(maximum, Math.max(0, value));
}

function resamplePlane(
  source: Uint8Array | Uint16Array,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  sourceBitDepth: number,
  targetBitDepth: number,
  sourceSubWidth: number,
  sourceSubHeight: number,
  targetSubWidth: number,
  targetSubHeight: number,
  scaledLeft: number,
  scaledTop: number,
  refLeft: number,
  refTop: number,
  scaleHor: number,
  scaleVer: number,
  phaseHor: number,
  phaseVer: number,
  coefficients: readonly (readonly number[])[],
): Uint8Array | Uint16Array {
  if (!source.length) return sourceBitDepth > 8 ? new Uint16Array() : new Uint8Array();
  const targetPlaneWidth = Math.ceil(targetWidth / targetSubWidth);
  const targetPlaneHeight = Math.ceil(targetHeight / targetSubHeight);
  const sourcePlaneWidth = Math.ceil(sourceWidth / sourceSubWidth);
  const sourcePlaneHeight = Math.ceil(sourceHeight / sourceSubHeight);
  if (source.length !== sourcePlaneWidth * sourcePlaneHeight)
    invalid('L-HEVC reference plane dimensions do not match');

  const filter = coefficients;
  const taps = filter[0].length;
  const filterStart = taps === 8 ? 3 : 1;
  const shift1 = sourceBitDepth - 8;
  const shift2 = 20 - targetBitDepth;
  if (shift1 < 0 || shift2 <= 0) unsupported('unsupported L-HEVC resampling bit depth');
  const offset = 2 ** (shift2 - 1);
  const maximum = 2 ** targetBitDepth - 1;
  const destination = new (targetBitDepth <= 8 ? Uint8Array : Uint16Array)(
    targetPlaneWidth * targetPlaneHeight,
  );
  const refX = new Int32Array(targetPlaneWidth);
  const phaseX = new Uint8Array(targetPlaneWidth);
  const centerXOffset = scaledLeft / targetSubWidth;
  const centerYOffset = scaledTop / targetSubHeight;
  const refXOffset16 = (refLeft / sourceSubWidth) * 16;
  const refYOffset16 = (refTop / sourceSubHeight) * 16;
  const addHor = -Math.floor((scaleHor * phaseHor + 8) / 16);
  const addVer = -Math.floor((scaleVer * phaseVer + 8) / 16);

  for (let x = 0; x < targetPlaneWidth; x++) {
    const xRef16 =
      Math.floor(((x - centerXOffset) * scaleHor + addHor + 2048) / 4096) + refXOffset16;
    refX[x] = Math.floor(xRef16 / 16);
    phaseX[x] = ((xRef16 % 16) + 16) % 16;
  }

  const horizontalRows = new Int32Array(targetPlaneWidth * taps);
  for (let y = 0; y < targetPlaneHeight; y++) {
    const yRef16 =
      Math.floor(((y - centerYOffset) * scaleVer + addVer + 2048) / 4096) + refYOffset16;
    const yRef = Math.floor(yRef16 / 16);
    const yPhase = ((yRef16 % 16) + 16) % 16;
    const verticalFilter = filter[yPhase];

    for (let tapY = 0; tapY < taps; tapY++) {
      const sourceY = clip(yRef + tapY - filterStart, sourcePlaneHeight - 1);
      const rowOffset = sourceY * sourcePlaneWidth;
      const intermediateOffset = tapY * targetPlaneWidth;
      for (let x = 0; x < targetPlaneWidth; x++) {
        const horizontalFilter = filter[phaseX[x]];
        const xRefSample = refX[x];
        let sum = 0;
        for (let tapX = 0; tapX < taps; tapX++) {
          const sourceX = clip(xRefSample + tapX - filterStart, sourcePlaneWidth - 1);
          sum += horizontalFilter[tapX] * source[rowOffset + sourceX];
        }
        horizontalRows[intermediateOffset + x] = Math.floor(sum / 2 ** shift1);
      }
    }

    const destinationOffset = y * targetPlaneWidth;
    for (let x = 0; x < targetPlaneWidth; x++) {
      let sum = offset;
      for (let tapY = 0; tapY < taps; tapY++)
        sum += verticalFilter[tapY] * horizontalRows[tapY * targetPlaneWidth + x];
      destination[destinationOffset + x] = clip(Math.floor(sum / 2 ** shift2), maximum);
    }
  }
  return destination;
}

function clip3(minimum: number, maximum: number, value: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function scaleMotionVector(value: number, scaleQ8: number): number {
  const product = scaleQ8 * value;
  const rounded = Math.sign(product) * Math.floor((Math.abs(product) + 127) / 256);
  return clip3(-32768, 32767, rounded);
}

/** Apply H.265 Annex H.8.1.4.3 to the reference layer's motion/mode maps. */
function resampleMotionParameters(
  source: Planes,
  geometry: ResamplingGeometry,
): ResampledMotionMaps | undefined {
  if (!source.hasExternalInterMotion) return undefined;

  const sourceMapWidth = source.width >> 2;
  const sourceMapHeight = source.height >> 2;
  const sourceMapLength = sourceMapWidth * sourceMapHeight;
  const requiredMaps = [
    source.interMap,
    source.motionIsExternal,
    source.motionPredFlags,
    source.motionRefIdxL0,
    source.motionXQpel,
    source.motionYQpel,
    source.motionRefPoc,
    source.motionRefLongTerm,
    source.motionXQpelL1,
    source.motionYQpelL1,
    source.motionRefIdxL1,
    source.motionRefPocL1,
    source.motionRefLongTermL1,
  ];
  if (
    sourceMapWidth <= 0 ||
    sourceMapHeight <= 0 ||
    requiredMaps.some((map) => !map || map.length !== sourceMapLength)
  )
    unsupported('L-HEVC reference-layer motion map is incomplete');

  const targetMapWidth = geometry.targetWidth >> 2;
  const targetMapHeight = geometry.targetHeight >> 2;
  if (
    targetMapWidth <= 0 ||
    targetMapHeight <= 0 ||
    targetMapWidth * 4 !== geometry.targetWidth ||
    targetMapHeight * 4 !== geometry.targetHeight
  )
    unsupported('L-HEVC motion resampling requires dimensions aligned to 4 luma samples');

  const targetMapLength = targetMapWidth * targetMapHeight;
  const result: ResampledMotionMaps = {
    interMap: new Uint8Array(targetMapLength),
    motionIsExternal: new Uint8Array(targetMapLength),
    motionPredFlags: new Uint8Array(targetMapLength),
    motionRefIdxL0: new Uint8Array(targetMapLength),
    motionXQpel: new Int32Array(targetMapLength),
    motionYQpel: new Int32Array(targetMapLength),
    motionRefPoc: new Float64Array(targetMapLength),
    motionRefLongTerm: new Uint8Array(targetMapLength),
    motionRefLayerId: new Uint8Array(targetMapLength),
    motionXQpelL1: new Int32Array(targetMapLength),
    motionYQpelL1: new Int32Array(targetMapLength),
    motionRefIdxL1: new Uint8Array(targetMapLength),
    motionRefPocL1: new Float64Array(targetMapLength),
    motionRefLongTermL1: new Uint8Array(targetMapLength),
    motionRefLayerIdL1: new Uint8Array(targetMapLength),
  };

  const scaleMvX =
    geometry.scaledRegionWidth === geometry.refRegionWidth
      ? 256
      : clip3(
          -4096,
          4095,
          Math.floor(
            (geometry.scaledRegionWidth * 256 + Math.floor(geometry.refRegionWidth / 2)) /
              geometry.refRegionWidth,
          ),
        );
  const scaleMvY =
    geometry.scaledRegionHeight === geometry.refRegionHeight
      ? 256
      : clip3(
          -4096,
          4095,
          Math.floor(
            (geometry.scaledRegionHeight * 256 + Math.floor(geometry.refRegionHeight / 2)) /
              geometry.refRegionHeight,
          ),
        );
  const sourceInterMap = source.interMap!;
  const sourceMotionIsExternal = source.motionIsExternal!;
  const sourceMotionPredFlags = source.motionPredFlags!;
  const sourceMotionRefIdxL0 = source.motionRefIdxL0!;
  const sourceMotionXQpel = source.motionXQpel!;
  const sourceMotionYQpel = source.motionYQpel!;
  const sourceMotionRefPoc = source.motionRefPoc!;
  const sourceMotionRefLongTerm = source.motionRefLongTerm!;
  const sourceMotionRefLayerId = source.motionRefLayerId;
  const sourceMotionXQpelL1 = source.motionXQpelL1!;
  const sourceMotionYQpelL1 = source.motionYQpelL1!;
  const sourceMotionRefIdxL1 = source.motionRefIdxL1!;
  const sourceMotionRefPocL1 = source.motionRefPocL1!;
  const sourceMotionRefLongTermL1 = source.motionRefLongTermL1!;
  const sourceMotionRefLayerIdL1 = source.motionRefLayerIdL1;
  let hasExternalInterMotion = false;

  for (let blockY = 0; blockY * 16 < geometry.targetHeight; blockY++) {
    const yP = blockY * 16;
    const yPCtr = yP + 8;
    const yRef =
      Math.floor(((yPCtr - geometry.scaledTop) * geometry.scaleVerY + 32768) / 65536) +
      geometry.refTop;
    const yRL = Math.floor((yRef + 4) / 16) * 16;
    for (let blockX = 0; blockX * 16 < geometry.targetWidth; blockX++) {
      const xP = blockX * 16;
      const xPCtr = xP + 8;
      const xRef =
        Math.floor(((xPCtr - geometry.scaledLeft) * geometry.scaleHorY + 32768) / 65536) +
        geometry.refLeft;
      const xRL = Math.floor((xRef + 4) / 16) * 16;
      let sourceIndex = -1;
      if (
        xRL >= 0 &&
        xRL < source.width &&
        yRL >= 0 &&
        yRL < source.height &&
        (yRL >> 2) * sourceMapWidth + (xRL >> 2) < sourceMapLength
      )
        sourceIndex = (yRL >> 2) * sourceMapWidth + (xRL >> 2);

      let predFlags = 0;
      if (
        sourceIndex >= 0 &&
        sourceInterMap[sourceIndex] === 1 &&
        sourceMotionIsExternal[sourceIndex] === 1
      ) {
        predFlags = sourceMotionPredFlags[sourceIndex];
        if (predFlags === 0 || (predFlags & ~3) !== 0)
          invalid('invalid L-HEVC reference-layer prediction flags');
        hasExternalInterMotion = true;
      }

      const mvX0 =
        sourceIndex >= 0 && predFlags & 1
          ? scaleMotionVector(sourceMotionXQpel[sourceIndex], scaleMvX)
          : 0;
      const mvY0 =
        sourceIndex >= 0 && predFlags & 1
          ? scaleMotionVector(sourceMotionYQpel[sourceIndex], scaleMvY)
          : 0;
      const mvX1 =
        sourceIndex >= 0 && predFlags & 2
          ? scaleMotionVector(sourceMotionXQpelL1[sourceIndex], scaleMvX)
          : 0;
      const mvY1 =
        sourceIndex >= 0 && predFlags & 2
          ? scaleMotionVector(sourceMotionYQpelL1[sourceIndex], scaleMvY)
          : 0;
      const firstMapX = xP >> 2;
      const lastMapX = Math.min(targetMapWidth, (xP + 16) >> 2);
      const firstMapY = yP >> 2;
      const lastMapY = Math.min(targetMapHeight, (yP + 16) >> 2);
      for (let mapY = firstMapY; mapY < lastMapY; mapY++) {
        const rowOffset = mapY * targetMapWidth;
        for (let mapX = firstMapX; mapX < lastMapX; mapX++) {
          const targetIndex = rowOffset + mapX;
          if (!predFlags) continue;
          result.interMap[targetIndex] = 1;
          result.motionIsExternal[targetIndex] = 1;
          result.motionPredFlags[targetIndex] = predFlags;
          result.motionRefIdxL0[targetIndex] = sourceMotionRefIdxL0[sourceIndex];
          result.motionXQpel[targetIndex] = mvX0;
          result.motionYQpel[targetIndex] = mvY0;
          result.motionRefPoc[targetIndex] = sourceMotionRefPoc[sourceIndex];
          result.motionRefLongTerm[targetIndex] = sourceMotionRefLongTerm[sourceIndex];
          result.motionRefLayerId[targetIndex] =
            sourceMotionRefLayerId?.[sourceIndex] ?? source.sourceSps?.layerId ?? 0;
          result.motionXQpelL1[targetIndex] = mvX1;
          result.motionYQpelL1[targetIndex] = mvY1;
          result.motionRefIdxL1[targetIndex] = sourceMotionRefIdxL1[sourceIndex];
          result.motionRefPocL1[targetIndex] = sourceMotionRefPocL1[sourceIndex];
          result.motionRefLongTermL1[targetIndex] = sourceMotionRefLongTermL1[sourceIndex];
          result.motionRefLayerIdL1[targetIndex] =
            sourceMotionRefLayerIdL1?.[sourceIndex] ?? source.sourceSps?.layerId ?? 0;
        }
      }
    }
  }

  return hasExternalInterMotion ? result : undefined;
}

/** Apply Annex H sample resampling to one direct inter-layer reference. */
export function resampleInterLayerPicture(
  source: Planes,
  target: SpsInfo,
  location: PpsReferenceLocationOffsetInfo | undefined,
): Planes {
  const geometry = deriveGeometry(source, target, location);
  if (isIdentityResampling(source, target, geometry)) {
    // Annex H still resamples inter-layer motion/mode data on a 16x16 grid
    // when the sample geometry is identical. Temporal MVP uses this resampled map.
    const motion = resampleMotionParameters(source, geometry);
    if (!motion) return source;
    return { ...source, ...motion, hasExternalInterMotion: true };
  }
  if (
    !Number.isSafeInteger(geometry.targetWidth * geometry.targetHeight) ||
    geometry.targetWidth <= 0 ||
    geometry.targetHeight <= 0 ||
    geometry.targetWidth * geometry.targetHeight > 50_000_000
  )
    throw new HeicError('RESOURCE_LIMIT', 'heic: L-HEVC reference picture exceeds pixel limit');

  const y = resamplePlane(
    source.y,
    geometry.sourceWidth,
    geometry.sourceHeight,
    geometry.targetWidth,
    geometry.targetHeight,
    source.bitDepthLuma ?? 8,
    target.bitDepthLuma,
    1,
    1,
    1,
    1,
    geometry.scaledLeft,
    geometry.scaledTop,
    geometry.refLeft,
    geometry.refTop,
    geometry.scaleHorY,
    geometry.scaleVerY,
    geometry.phaseHorY,
    geometry.phaseVerY,
    LUMA_FILTER,
  );
  const cb = resamplePlane(
    source.cb,
    geometry.sourceWidth,
    geometry.sourceHeight,
    geometry.targetWidth,
    geometry.targetHeight,
    source.bitDepthChroma ?? source.bitDepthLuma ?? 8,
    target.bitDepthChroma,
    geometry.sourceChromaSubWidth,
    geometry.sourceChromaSubHeight,
    geometry.targetChromaSubWidth,
    geometry.targetChromaSubHeight,
    geometry.scaledLeft,
    geometry.scaledTop,
    geometry.refLeft,
    geometry.refTop,
    geometry.scaleHorC,
    geometry.scaleVerC,
    geometry.phaseHorC,
    geometry.phaseVerC,
    CHROMA_FILTER,
  );
  const cr = resamplePlane(
    source.cr,
    geometry.sourceWidth,
    geometry.sourceHeight,
    geometry.targetWidth,
    geometry.targetHeight,
    source.bitDepthChroma ?? source.bitDepthLuma ?? 8,
    target.bitDepthChroma,
    geometry.sourceChromaSubWidth,
    geometry.sourceChromaSubHeight,
    geometry.targetChromaSubWidth,
    geometry.targetChromaSubHeight,
    geometry.scaledLeft,
    geometry.scaledTop,
    geometry.refLeft,
    geometry.refTop,
    geometry.scaleHorC,
    geometry.scaleVerC,
    geometry.phaseHorC,
    geometry.phaseVerC,
    CHROMA_FILTER,
  );
  const motion = resampleMotionParameters(source, geometry);

  return {
    y,
    cb,
    cr,
    width: geometry.targetWidth,
    height: geometry.targetHeight,
    chromaFormatIdc: target.chromaFormatIdc,
    bitDepthLuma: target.bitDepthLuma,
    bitDepthChroma: target.bitDepthChroma,
    hasExternalInterMotion: motion !== undefined,
    ...(motion ?? {}),
    pictureOrderCntLsb: source.pictureOrderCntLsb,
    pictureOrderCnt: source.pictureOrderCnt,
    temporalId: source.temporalId,
  };
}
