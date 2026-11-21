import { HeicError } from './errors.js';
import {
  getHeicInfo,
  getItemPayload,
  type HeicInfo,
  type ImageTransform,
} from './container/heic.js';
import { parseISOBMFF, type ISOBMFFBox } from './container/heif.js';
import {
  decodeUncompressedImage,
  scaleSignedComponentCode,
  type UncompressedImageConfiguration,
} from './container/uncompressed.js';
import { decompressGenericItemPayloadSync } from './container/generic-compression.js';
import {
  buildTiledTileUrl,
  getTiledImageTileIndices,
  parseTiledItemRanges,
} from './container/tili.js';
import {
  decodeItemPlanes,
  cropPlanes,
  cropPlanesToDefaultDisplayWindow,
  getActiveSpsFromPayload,
  stitchGrid,
  type Planes,
  type ExternalBaseLayerPlanes,
} from './planes.js';
import { parseSps, type VuiColorInfo } from './hevc/sps.js';
import { getVpsVideoSignalInfoForSps, type HevcVpsVideoSignalInfo } from './hevc/vps.js';
import { chromaSubsampling } from './hevc/chroma.js';
import { applyHevcChromaResamplingFilterHint as applyChromaResamplingHint } from './hevc/chroma-resampling.js';
import { applyHevcPostFilterHint } from './hevc/post-filter.js';
import { applyHevcPhaseIndication } from './hevc/phase-indication.js';
import {
  decodeBT2020ConstantLuminance,
  decodeIPTC2,
  decodeICtCp,
  decodeSMPTE2085,
  decodeYCgCo,
  decodeYCgCoReRo,
  getYCbCrMatrixCoefficients,
} from './color-matrix.js';
import type { DecodeOptions, HeicImageData } from './decoder.js';
import { isHeifHevcBitDepth, type HeifHevcBitDepth, type HeifImageBitDepth } from './bit-depth.js';
import { getColorTransferFunction } from './color-transfer.js';
import { iccToLinearSrgb, linearSrgbToSrgb, parseIccProfile } from './icc.js';
import {
  activeHevcAlphaChannelInfo,
  getHevcAuxiliarySeiForItem,
  getHevcSeiMetadata,
  hevcAlphaSampleToFactor,
} from './hevc/heif-sei.js';
import { compileHevcToneMapping, selectHevcToneMappingInfo } from './hevc/tone-mapping.js';
import {
  compileHevcKneeFunction,
  mapHevcKneeFunction,
  selectHevcKneeFunctionInfo,
} from './hevc/knee-function.js';
import {
  compileHevcColourRemapping,
  mapHevcColourRemappingLut,
  mapHevcColourRemappingSamples,
  selectHevcColourRemappingInfo,
} from './hevc/colour-remapping.js';
import type { HevcColourRemappingInfoData, HevcPhaseIndication } from './hevc/sei.js';

export interface NativeImage {
  width: number;
  height: number;
  bitDepth: HeifImageBitDepth;
  bitDepthChroma?: HeifImageBitDepth;
  /** The source components use IEEE 754 floating-point samples. */
  floatingPointSamples?: boolean;
  /** Bit depth of `data` when a display remapping changes its working range. */
  dataBitDepth?: number;
  data: Uint16Array | Float32Array;
  hasAlpha: boolean;
  info: HeicInfo;
}
type UncompressedSampleArray = Uint16Array | Float32Array;
export interface RenderOverrides {
  color?: HeicInfo['color'];
  icc?: Uint8Array | null;
  iccType?: HeicInfo['iccType'];
  chromaSampleLocation?: HeicInfo['chromaSampleLocation'];
  chromaSampleLocations?: HeicInfo['chromaSampleLocations'];
}

export interface RenderColor {
  primaries: number;
  transfer: number;
  matrix: number;
  fullRange: boolean;
}

export function resolveRenderColor(
  declared: HeicInfo['color'] | undefined,
  spsColor: VuiColorInfo | null,
  vpsSignalInfo: HevcVpsVideoSignalInfo | null,
  alternativeTransfer?: number,
): RenderColor {
  const source = vpsSignalInfo
    ? {
        videoFullRange: vpsSignalInfo.fullRange,
        colourPrimaries: vpsSignalInfo.colourPrimaries,
        transferCharacteristics: vpsSignalInfo.transferCharacteristics,
        matrixCoeffs: vpsSignalInfo.matrixCoefficients,
      }
    : spsColor;
  return {
    primaries:
      declared?.primaries !== undefined && declared.primaries !== 2
        ? declared.primaries
        : (source?.colourPrimaries ?? 2),
    transfer:
      declared?.transfer !== undefined && declared.transfer !== 2
        ? declared.transfer
        : (alternativeTransfer ?? source?.transferCharacteristics ?? 2),
    matrix:
      declared?.matrix !== undefined && declared.matrix !== 2
        ? declared.matrix
        : (source?.matrixCoeffs ?? 6),
    fullRange: declared?.fullRange ?? source?.videoFullRange ?? false,
  };
}
export interface RenderContext {
  input: Uint8Array;
  boxes: ISOBMFFBox[];
  options: DecodeOptions;
  stack: Set<number>;
  budget: {
    decodedPixels: number;
    externalTileBytes: number;
    externalTileUrls: Set<string>;
  };
  externalTileDepth: number;
}

function activeSpsForInfo(ctx: RenderContext, info: HeicInfo): ReturnType<typeof parseSps> | null {
  if (!info.hvcC) return null;
  const codedItemId = info.grid ? info.grid.tileItemIds[0] : info.primaryItemId;
  const codedInfo =
    codedItemId === info.primaryItemId ? info : getHeicInfo(ctx.input, ctx.boxes, codedItemId);
  const config = codedInfo.hvcC ?? info.hvcC;
  let payload = getItemPayload(ctx.input, ctx.boxes, codedItemId, ctx.options.externalItemData);
  if (payload && codedInfo.tiledImage) {
    const ranges = parseTiledItemRanges(
      payload,
      codedInfo.tiledImage.dataReference,
      codedInfo.tiledImage.dataReference.inputItemCount,
    );
    const first = ranges.find((range) => range !== null);
    payload = first ? payload.subarray(first.offset, first.offset + first.length) : null;
  }
  if (!payload)
    return parseSps(config.sps[0], {
      allowBaseLayerMultilayerExtension:
        codedInfo.primaryItemType === 'hvc1' || codedInfo.tiledImage?.tileItemType === 'hvc1',
    });
  return getActiveSpsFromPayload(
    payload,
    config,
    `item ${codedItemId}`,
    codedInfo.primaryItemType === 'hvc1' || codedInfo.tiledImage?.tileItemType === 'hvc1',
  );
}
export const createRenderContext = (
  input: Uint8Array,
  options: DecodeOptions = {},
): RenderContext => ({
  input,
  boxes: parseISOBMFF(input),
  options,
  stack: new Set(),
  budget: { decodedPixels: 0, externalTileBytes: 0, externalTileUrls: new Set() },
  externalTileDepth: 0,
});

function sampleChromaPlane(
  plane: Uint8Array | Uint16Array | Float32Array,
  width: number,
  height: number,
  chromaFormatIdc: number,
  x: number,
  y: number,
  location: HeicInfo['chromaSampleLocation'],
): number {
  const sub = chromaSubsampling(chromaFormatIdc),
    chromaWidth = Math.ceil(width / sub.width),
    chromaHeight = Math.ceil(height / sub.height);
  if (!location) return plane[Math.floor(y / sub.height) * chromaWidth + Math.floor(x / sub.width)];
  const sampleX = (x - location.x) / sub.width,
    sampleY = (y - location.y) / sub.height,
    x0 = Math.floor(sampleX),
    y0 = Math.floor(sampleY),
    fx = sampleX - x0,
    fy = sampleY - y0,
    at = (cx: number, cy: number) =>
      plane[
        Math.max(0, Math.min(chromaHeight - 1, cy)) * chromaWidth +
          Math.max(0, Math.min(chromaWidth - 1, cx))
      ],
    upper = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx,
    lower = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return upper * (1 - fy) + lower * fy;
}

export function createExternalTileContext(
  input: Uint8Array,
  parent: RenderContext,
  url?: string,
): RenderContext {
  const tilePlanes = url ? parent.options.externalTileBaseLayerPlanes?.[url] : undefined;
  const options = tilePlanes
    ? {
        ...parent.options,
        externalBaseLayerPlanes: {
          ...parent.options.externalBaseLayerPlanes,
          ...tilePlanes,
        },
      }
    : parent.options;
  const child = createRenderContext(input, options);
  child.budget = parent.budget;
  child.externalTileDepth = parent.externalTileDepth + 1;
  return child;
}

export function checkSize(ctx: RenderContext, w: number, h: number) {
  const pixels = w * h,
    limit = ctx.options.maxPixels ?? 50_000_000;
  if (!Number.isSafeInteger(pixels) || w <= 0 || h <= 0 || pixels > limit || pixels > 50_000_000)
    throw new HeicError('RESOURCE_LIMIT', 'heic: derived image exceeds maxPixels');
  ctx.budget.decodedPixels += pixels;
  if (ctx.budget.decodedPixels > 200_000_000)
    throw new HeicError('RESOURCE_LIMIT', 'heic: derived decode work exceeds 200 million pixels');
}

type RenderPlaneSamples = Uint8Array | Uint16Array | Float32Array;
type RenderPlanes = Omit<Planes, 'y' | 'cb' | 'cr'> & {
  y: RenderPlaneSamples;
  cb: RenderPlaneSamples;
  cr: RenderPlaneSamples;
};

function planePixels(
  planes: RenderPlanes,
  depth: number,
  chromaDepth: number,
  color: NonNullable<HeicInfo['color']>,
  auxiliary: boolean,
  chromaSampleLocation?: HeicInfo['chromaSampleLocation'],
  chromaSampleLocations?: HeicInfo['chromaSampleLocations'],
  floatingPointSamples = false,
): Uint16Array | Float32Array {
  const { width: w, height: h } = planes,
    max = 2 ** depth - 1,
    maxChroma = 2 ** chromaDepth - 1,
    factor = 2 ** (depth - 8),
    chromaFactor = 2 ** (chromaDepth - 8),
    preserveExtended =
      !auxiliary &&
      (color.transfer === 11 ||
        color.transfer === 12 ||
        (color.transfer === 13 && color.matrix !== 0) ||
        floatingPointSamples),
    out = preserveExtended ? new Float32Array(w * h * 4) : new Uint16Array(w * h * 4);
  const matrix = color.matrix,
    coefficients = getYCbCrMatrixCoefficients(matrix, color.primaries),
    { kr, kb } =
      coefficients ?? (matrix === 10 ? { kr: 0.2627, kb: 0.0593 } : { kr: 0.299, kb: 0.114 });
  const ycgc = !auxiliary && planes.cb.length > 0 && matrix === 8;
  const ycgcReRo = !auxiliary && planes.cb.length > 0 && (matrix === 16 || matrix === 17);
  const ictcp = !auxiliary && planes.cb.length > 0 && matrix === 14;
  if (ycgc && chromaDepth !== depth && chromaDepth !== depth + 1)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: YCgCo requires equal or one-bit-higher chroma depth',
    );
  if (
    !auxiliary &&
    planes.cb.length &&
    matrix !== 0 &&
    matrix !== 8 &&
    matrix !== 10 &&
    matrix !== 11 &&
    matrix !== 12 &&
    matrix !== 13 &&
    matrix !== 14 &&
    matrix !== 15 &&
    matrix !== 16 &&
    matrix !== 17 &&
    !coefficients
  )
    throw new HeicError('UNSUPPORTED_FEATURE', 'heic: unsupported YCbCr matrix');
  if (!auxiliary && planes.cb.length && (matrix === 12 || matrix === 13) && !coefficients)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      `heic: matrix_coeffs ${matrix} requires supported colour_primaries`,
    );
  if (!auxiliary && planes.cb.length && matrix === 0 && planes.chromaFormatIdc !== 3)
    throw new HeicError('UNSUPPORTED_FEATURE', 'heic: matrix_coeffs 0 requires 4:4:4 chroma');
  if (ycgcReRo && !color.fullRange && depth - (matrix === 16 ? 2 : 1) < 8)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      `heic: limited-range matrix_coeffs ${matrix} requires BitDepthRGB >= 8`,
    );
  const ys = color.fullRange ? 1 : max / (219 * factor),
    cs = color.fullRange ? max / maxChroma : max / (224 * chromaFactor),
    offset = color.fullRange ? 0 : 16 * factor,
    // Identity matrix uses all three components as RGB, with video-range scaling on each.
    identityChromaOffset = color.fullRange ? 0 : 16 * chromaFactor,
    identityChromaScale = color.fullRange ? max / maxChroma : max / (219 * chromaFactor);
  const clip = (v: number) => Math.max(0, Math.min(max, Math.round(v)));
  const store = preserveExtended ? (v: number) => v : clip;
  const sampleCb = (x: number, y: number) =>
      sampleChromaPlane(
        planes.cb,
        w,
        h,
        planes.chromaFormatIdc,
        x,
        y,
        chromaSampleLocations?.cb ?? chromaSampleLocation,
      ),
    sampleCr = (x: number, y: number) =>
      sampleChromaPlane(
        planes.cr,
        w,
        h,
        planes.chromaFormatIdc,
        x,
        y,
        chromaSampleLocations?.cr ?? chromaSampleLocation,
      );
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x,
        o = i * 4;
      if (auxiliary || !planes.cb.length) {
        out[o] =
          out[o + 1] =
          out[o + 2] =
            auxiliary ? planes.y[i] : store((planes.y[i] - offset) * ys);
      } else {
        const lum = (planes.y[i] - offset) * ys;
        let u: number, v: number;
        if (planes.chromaFormatIdc === 3) {
          u = (planes.cb[i] - 128 * chromaFactor) * cs;
          v = (planes.cr[i] - 128 * chromaFactor) * cs;
        } else {
          u = (sampleCb(x, y) - 128 * chromaFactor) * cs;
          v = (sampleCr(x, y) - 128 * chromaFactor) * cs;
        }
        if (ycgc) {
          const rgb = decodeYCgCo(
            planes.y[i],
            sampleCb(x, y),
            sampleCr(x, y),
            depth,
            chromaDepth,
            max,
            color.fullRange,
          );
          if (!rgb)
            throw new HeicError(
              'UNSUPPORTED_FEATURE',
              'heic: unsupported YCgCo bit-depth combination',
            );
          out[o] = store(rgb[0]);
          out[o + 1] = store(rgb[1]);
          out[o + 2] = store(rgb[2]);
          out[o + 3] = max;
          continue;
        }
        if (ycgcReRo) {
          const rgb = decodeYCgCoReRo(
            planes.y[i],
            sampleCb(x, y),
            sampleCr(x, y),
            depth,
            chromaDepth,
            matrix === 16 ? 2 : 1,
            max,
            color.fullRange,
          );
          if (!rgb)
            throw new HeicError(
              'UNSUPPORTED_FEATURE',
              `heic: unsupported bit-depth combination for matrix_coeffs ${matrix}`,
            );
          out[o] = store(rgb[0]);
          out[o + 1] = store(rgb[1]);
          out[o + 2] = store(rgb[2]);
          out[o + 3] = max;
          continue;
        }
        if (!auxiliary && (matrix === 10 || matrix === 13)) {
          const rgb = decodeBT2020ConstantLuminance(
            planes.y[i],
            sampleCb(x, y),
            sampleCr(x, y),
            depth,
            chromaDepth,
            color.transfer,
            max,
            color.fullRange,
            kr,
            kb,
          );
          if (!rgb)
            throw new HeicError(
              'UNSUPPORTED_FEATURE',
              `heic: unsupported transfer_characteristics for matrix_coeffs ${matrix} constant luminance`,
            );
          out[o] = store(rgb[0]);
          out[o + 1] = store(rgb[1]);
          out[o + 2] = store(rgb[2]);
          out[o + 3] = max;
          continue;
        }
        if (ictcp) {
          const rgb = decodeICtCp(
            planes.y[i],
            sampleCb(x, y),
            sampleCr(x, y),
            depth,
            chromaDepth,
            color.transfer,
            max,
            color.fullRange,
          );
          if (!rgb)
            throw new HeicError(
              'UNSUPPORTED_FEATURE',
              'heic: matrix_coeffs 14 requires PQ or HLG transfer characteristics',
            );
          out[o] = store(rgb[0]);
          out[o + 1] = store(rgb[1]);
          out[o + 2] = store(rgb[2]);
          out[o + 3] = max;
          continue;
        }
        if (!auxiliary && matrix === 11) {
          const xyz = decodeSMPTE2085(
            planes.y[i],
            sampleCb(x, y),
            sampleCr(x, y),
            depth,
            chromaDepth,
            max,
            color.fullRange,
          );
          out[o] = store(xyz[0]);
          out[o + 1] = store(xyz[1]);
          out[o + 2] = store(xyz[2]);
          out[o + 3] = max;
          continue;
        }
        if (!auxiliary && matrix === 15) {
          const rgb = decodeIPTC2(
            planes.y[i],
            sampleCb(x, y),
            sampleCr(x, y),
            depth,
            chromaDepth,
            color.transfer,
            max,
            color.fullRange,
          );
          if (!rgb)
            throw new HeicError(
              'UNSUPPORTED_FEATURE',
              'heic: matrix_coeffs 15 uses unsupported transfer_characteristics',
            );
          out[o] = store(rgb[0]);
          out[o + 1] = store(rgb[1]);
          out[o + 2] = store(rgb[2]);
          out[o + 3] = max;
          continue;
        }
        if (matrix === 0 && planes.chromaFormatIdc === 3) {
          out[o] = store((planes.cr[i] - identityChromaOffset) * identityChromaScale);
          out[o + 1] = store(lum);
          out[o + 2] = store((planes.cb[i] - identityChromaOffset) * identityChromaScale);
          out[o + 3] = max;
          continue;
        }
        out[o] = store(lum + 2 * (1 - kr) * v);
        out[o + 1] = store(
          lum -
            ((2 * kb * (1 - kb)) / (1 - kr - kb)) * u -
            ((2 * kr * (1 - kr)) / (1 - kr - kb)) * v,
        );
        out[o + 2] = store(lum + 2 * (1 - kb) * u);
      }
      out[o + 3] = max;
    }
  return out;
}

function convertSampleDepth(sample: number, fromDepth: number, toDepth: number): number {
  const fromMax = 2 ** fromDepth - 1,
    toMax = 2 ** toDepth - 1;
  return Math.max(0, Math.min(toMax, Math.round((sample * toMax) / fromMax)));
}

function remapColourPlanes(
  planes: Planes,
  depth: number,
  chromaDepth: number,
  mapping: HevcColourRemappingInfoData,
  outputMatrix: number,
  chromaSampleLocation: HeicInfo['chromaSampleLocation'],
  chromaSampleLocations: HeicInfo['chromaSampleLocations'],
): Planes {
  const compiled = compileHevcColourRemapping(mapping),
    width = planes.width,
    height = planes.height,
    count = width * height,
    sourceFormat = planes.chromaFormatIdc,
    fullResolutionOutput =
      mapping.matrix !== undefined || (outputMatrix === 0 && sourceFormat !== 3),
    allocatePlane = (length: number): Uint8Array | Uint16Array =>
      mapping.outputBitDepth <= 8 ? new Uint8Array(length) : new Uint16Array(length);

  let y: Uint8Array | Uint16Array, cb: Uint8Array | Uint16Array, cr: Uint8Array | Uint16Array;
  if (mapping.matrix) {
    y = allocatePlane(count);
    cb = allocatePlane(count);
    cr = allocatePlane(count);
    for (let row = 0; row < height; row++)
      for (let column = 0; column < width; column++) {
        const index = row * width + column,
          cbAtPixel =
            sourceFormat === 3
              ? planes.cb[index]
              : sampleChromaPlane(
                  planes.cb,
                  width,
                  height,
                  sourceFormat,
                  column,
                  row,
                  chromaSampleLocations?.cb ?? chromaSampleLocation,
                ),
          crAtPixel =
            sourceFormat === 3
              ? planes.cr[index]
              : sampleChromaPlane(
                  planes.cr,
                  width,
                  height,
                  sourceFormat,
                  column,
                  row,
                  chromaSampleLocations?.cr ?? chromaSampleLocation,
                ),
          ySample = convertSampleDepth(planes.y[index], depth, mapping.inputBitDepth),
          cbSample = convertSampleDepth(cbAtPixel, chromaDepth, mapping.inputBitDepth),
          crSample = convertSampleDepth(crAtPixel, chromaDepth, mapping.inputBitDepth),
          [mappedY, mappedCb, mappedCr] = mapHevcColourRemappingSamples(compiled, [
            ySample,
            cbSample,
            crSample,
          ]);
        y[index] = mappedY;
        cb[index] = mappedCb;
        cr[index] = mappedCr;
      }
  } else {
    const mapPlane = (
      plane: Uint8Array | Uint16Array,
      component: 0 | 1 | 2,
      sourceBitDepth: number,
    ) => {
      const output = allocatePlane(plane.length);
      for (let index = 0; index < plane.length; index++) {
        const input = convertSampleDepth(plane[index], sourceBitDepth, mapping.inputBitDepth),
          pre = mapHevcColourRemappingLut(compiled.preLuts[component], input),
          post = mapHevcColourRemappingLut(compiled.postLuts[component], pre);
        output[index] = post;
      }
      return output;
    };
    y = mapPlane(planes.y, 0, depth);
    cb = mapPlane(planes.cb, 1, chromaDepth);
    cr = mapPlane(planes.cr, 2, chromaDepth);
  }

  if (!mapping.matrix && outputMatrix === 0 && sourceFormat !== 3) {
    const upsample = (
      plane: Uint8Array | Uint16Array,
      location: HeicInfo['chromaSampleLocation'],
    ) => {
      const output = allocatePlane(count);
      for (let row = 0; row < height; row++)
        for (let column = 0; column < width; column++)
          output[row * width + column] = Math.round(
            sampleChromaPlane(plane, width, height, sourceFormat, column, row, location),
          );
      return output;
    };
    cb = upsample(cb, chromaSampleLocations?.cb ?? chromaSampleLocation);
    cr = upsample(cr, chromaSampleLocations?.cr ?? chromaSampleLocation);
  }

  return {
    ...planes,
    y,
    cb,
    cr,
    chromaFormatIdc: fullResolutionOutput ? 3 : sourceFormat,
    bitDepthLuma: mapping.outputBitDepth,
    bitDepthChroma: mapping.outputBitDepth,
  };
}

export function transformRaster(
  data: Uint16Array,
  width: number,
  height: number,
  transforms: HeicInfo['transforms'],
  ctx: RenderContext,
): { data: Uint16Array; width: number; height: number };
export function transformRaster(
  data: Float32Array,
  width: number,
  height: number,
  transforms: HeicInfo['transforms'],
  ctx: RenderContext,
): { data: Float32Array; width: number; height: number };
export function transformRaster(
  data: Uint16Array | Float32Array,
  width: number,
  height: number,
  transforms: HeicInfo['transforms'],
  ctx: RenderContext,
): { data: Uint16Array | Float32Array; width: number; height: number };
export function transformRaster(
  data: Uint16Array | Float32Array,
  width: number,
  height: number,
  transforms: HeicInfo['transforms'],
  ctx: RenderContext,
): { data: Uint16Array | Float32Array; width: number; height: number } {
  const allocate = (length: number) =>
      data instanceof Float32Array ? new Float32Array(length) : new Uint16Array(length),
    store = (value: number) => (data instanceof Float32Array ? value : Math.round(value));
  let result = { data, width, height };
  for (const step of transforms) {
    if (step.type === 'iscl') {
      const scaledWidth = Math.floor(
          (result.width * step.targetWidthNumerator + step.targetWidthDenominator - 1) /
            step.targetWidthDenominator,
        ),
        scaledHeight = Math.floor(
          (result.height * step.targetHeightNumerator + step.targetHeightDenominator - 1) /
            step.targetHeightDenominator,
        );
      if (scaledWidth === result.width && scaledHeight === result.height) continue;
      checkSize(ctx, scaledWidth, scaledHeight);
      const out = allocate(scaledWidth * scaledHeight * 4);
      for (let y = 0; y < scaledHeight; y++)
        for (let x = 0; x < scaledWidth; x++) {
          const sx = Math.max(
              0,
              Math.min(result.width - 1, ((x + 0.5) * result.width) / scaledWidth - 0.5),
            ),
            sy = Math.max(
              0,
              Math.min(result.height - 1, ((y + 0.5) * result.height) / scaledHeight - 0.5),
            ),
            x0 = Math.floor(sx),
            y0 = Math.floor(sy),
            x1 = Math.min(result.width - 1, x0 + 1),
            y1 = Math.min(result.height - 1, y0 + 1),
            fx = sx - x0,
            fy = sy - y0,
            dst = (y * scaledWidth + x) * 4,
            topLeft = (y0 * result.width + x0) * 4,
            topRight = (y0 * result.width + x1) * 4,
            bottomLeft = (y1 * result.width + x0) * 4,
            bottomRight = (y1 * result.width + x1) * 4;
          for (let c = 0; c < 4; c++) {
            const upper = result.data[topLeft + c] * (1 - fx) + result.data[topRight + c] * fx,
              lower = result.data[bottomLeft + c] * (1 - fx) + result.data[bottomRight + c] * fx;
            out[dst + c] = store(upper * (1 - fy) + lower * fy);
          }
        }
      result = { ...result, width: scaledWidth, height: scaledHeight, data: out };
      continue;
    }
    if (step.type === 'clap') {
      const w = step.width,
        h = step.height,
        left = (result.width - w) / 2 + step.horizontalOffset,
        top = (result.height - h) / 2 + step.verticalOffset;
      if (
        ![w, h, left, top].every(Number.isFinite) ||
        w <= 0 ||
        h <= 0 ||
        left < 0 ||
        top < 0 ||
        left + w > result.width ||
        top + h > result.height
      )
        throw new HeicError('INVALID_CONTAINER', 'heic: clean aperture is out of bounds');
      const outWidth = Math.max(1, Math.round(w)),
        outHeight = Math.max(1, Math.round(h));
      checkSize(ctx, outWidth, outHeight);
      const out = allocate(outWidth * outHeight * 4);
      if ([w, h, left, top].every(Number.isInteger)) {
        for (let y = 0; y < outHeight; y++)
          out.set(
            result.data.subarray(
              ((top + y) * result.width + left) * 4,
              ((top + y) * result.width + left + outWidth) * 4,
            ),
            y * outWidth * 4,
          );
      } else {
        const coordinate = (start: number, extent: number, index: number, count: number) =>
          count === 1 ? start + (extent - 1) / 2 : start + (index * (extent - 1)) / (count - 1);
        for (let y = 0; y < outHeight; y++)
          for (let x = 0; x < outWidth; x++) {
            const sx = Math.max(0, Math.min(result.width - 1, coordinate(left, w, x, outWidth))),
              sy = Math.max(0, Math.min(result.height - 1, coordinate(top, h, y, outHeight))),
              x0 = Math.floor(sx),
              y0 = Math.floor(sy),
              x1 = Math.min(result.width - 1, x0 + 1),
              y1 = Math.min(result.height - 1, y0 + 1),
              fx = sx - x0,
              fy = sy - y0,
              dst = (y * outWidth + x) * 4,
              topLeft = (y0 * result.width + x0) * 4,
              topRight = (y0 * result.width + x1) * 4,
              bottomLeft = (y1 * result.width + x0) * 4,
              bottomRight = (y1 * result.width + x1) * 4;
            for (let c = 0; c < 4; c++) {
              const upper = result.data[topLeft + c] * (1 - fx) + result.data[topRight + c] * fx,
                lower = result.data[bottomLeft + c] * (1 - fx) + result.data[bottomRight + c] * fx;
              out[dst + c] = store(upper * (1 - fy) + lower * fy);
            }
          }
      }
      result = { ...result, width: outWidth, height: outHeight, data: out };
      continue;
    }
    const rotate = step.type === 'irot' ? step.value : 0,
      mirror = step.type === 'imir' ? step.value : null;
    if (!rotate && mirror === null) continue;
    const w = rotate % 2 ? result.height : result.width,
      h = rotate % 2 ? result.width : result.height,
      out = allocate(result.data.length);
    for (let y = 0; y < result.height; y++)
      for (let x = 0; x < result.width; x++) {
        let dx = x,
          dy = y;
        if (rotate === 1) {
          dx = y;
          dy = result.width - 1 - x;
        } else if (rotate === 2) {
          dx = result.width - 1 - x;
          dy = result.height - 1 - y;
        } else if (rotate === 3) {
          dx = result.height - 1 - y;
          dy = x;
        }
        if (mirror === 0) dx = w - 1 - dx;
        else if (mirror === 1) dy = h - 1 - dy;
        out.set(
          result.data.subarray((y * result.width + x) * 4, (y * result.width + x) * 4 + 4),
          (dy * w + dx) * 4,
        );
      }
    result = { ...result, width: w, height: h, data: out };
  }
  return result;
}

function transform(image: NativeImage, ctx: RenderContext): NativeImage {
  const displayTransforms: ImageTransform[] = [];
  if (ctx.options.applyHevcDisplayOrientation !== false) {
    let codedInfo = image.info;
    for (
      let depth = 0;
      depth < 32 &&
      (codedInfo.primaryItemType === 'iden' || codedInfo.primaryItemType === 'tmap') &&
      codedInfo.derivedItems.length > 0;
      depth++
    )
      codedInfo = getHeicInfo(ctx.input, ctx.boxes, codedInfo.derivedItems[0]);

    const messages =
      getHevcSeiMetadata(ctx.input, ctx.boxes, codedInfo, ctx.options.externalItemData)
        ?.displayOrientation ?? [];
    let activeTransformType: number | undefined;
    for (const message of messages) {
      if (message.cancelled) activeTransformType = undefined;
      else activeTransformType = message.transformType;
    }
    if (activeTransformType !== undefined) {
      const rotation = [0, 0, 2, 2, 1, 1, 3, 3][activeTransformType];
      if (rotation) displayTransforms.push({ type: 'irot', value: rotation });
      if ([1, 3, 4, 6].includes(activeTransformType))
        displayTransforms.push({ type: 'imir', value: 0 });
    }
  }

  const containerTransforms = ctx.options.applyTransforms === false ? [] : image.info.transforms;
  return {
    ...image,
    ...transformRaster(
      image.data,
      image.width,
      image.height,
      [...displayTransforms, ...containerTransforms],
      ctx,
    ),
  };
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  return (
    (a?.length ?? 0) === (b?.length ?? 0) &&
    (a === null || a === undefined || a.every((value, index) => value === b?.[index]))
  );
}

export function externalTileContext(ctx: RenderContext, url: string, index: number): RenderContext {
  const payload = ctx.options.externalTileData?.[url];
  if (!(payload instanceof Uint8Array) || payload.length === 0)
    throw new HeicError(
      'INVALID_INPUT',
      `heic: external tili tile ${index} has no data for ${url}`,
    );
  if (payload.length > 64 * 1024 * 1024)
    throw new HeicError('RESOURCE_LIMIT', 'heic: external tili tile exceeds 64 MiB');
  if (!ctx.budget.externalTileUrls.has(url)) {
    ctx.budget.externalTileBytes += payload.byteLength;
    ctx.budget.externalTileUrls.add(url);
    if (ctx.budget.externalTileBytes > 64 * 1024 * 1024)
      throw new HeicError('RESOURCE_LIMIT', 'heic: external tile data exceeds 64 MiB total');
  }
  if (ctx.externalTileDepth >= 32)
    throw new HeicError('RESOURCE_LIMIT', 'heic: external tili nesting exceeds 32 levels');
  return createExternalTileContext(payload, ctx, url);
}

function stitchExternalTiledNative(
  ctx: RenderContext,
  info: HeicInfo,
  overrides: RenderOverrides = {},
): NativeImage {
  const tiledImage = info.tiledImage!;
  const indexes = getTiledImageTileIndices(tiledImage, ctx.options.extraDimensionIndexes);
  const tileCount = tiledImage.columns * tiledImage.rows;
  if (!Number.isSafeInteger(tileCount) || tileCount <= 0 || tileCount > 65_536)
    throw new HeicError('RESOURCE_LIMIT', 'heic: external tili tile count exceeds 65536');
  if (indexes.length !== tileCount)
    throw new HeicError('INVALID_CONTAINER', 'heic: external tili plane has an invalid tile count');
  const canvasWidth = tiledImage.columns * tiledImage.tileWidth;
  const canvasHeight = tiledImage.rows * tiledImage.tileHeight;
  if (
    !Number.isSafeInteger(canvasWidth * canvasHeight) ||
    canvasWidth < info.width ||
    canvasHeight < info.height
  )
    throw new HeicError('INVALID_CONTAINER', 'heic: external tili extent exceeds its tile grid');
  checkSize(ctx, canvasWidth, canvasHeight);

  const inherited: RenderOverrides = {
    color: overrides.color ?? info.color ?? undefined,
    icc: overrides.icc ?? info.icc ?? undefined,
    iccType: overrides.iccType ?? info.iccType ?? undefined,
    chromaSampleLocation: overrides.chromaSampleLocation ?? info.chromaSampleLocation ?? undefined,
    chromaSampleLocations: overrides.chromaSampleLocations ?? info.chromaSampleLocations,
  };
  let first: NativeImage | null = null;
  let hasAlpha = false;
  let data: Uint16Array | Float32Array | null = null;
  for (let spatialIndex = 0; spatialIndex < tileCount; spatialIndex++) {
    const index = indexes[spatialIndex];
    const url = buildTiledTileUrl(tiledImage.dataReference, index);
    const tileContext = externalTileContext(ctx, url, index);
    const tile = decodeNative(tileContext, undefined, false, undefined, inherited);
    if (tile.width !== tiledImage.tileWidth || tile.height !== tiledImage.tileHeight)
      throw new HeicError(
        'INVALID_BITSTREAM',
        `heic: external tili tile ${index} is ${tile.width}x${tile.height}, expected ${tiledImage.tileWidth}x${tiledImage.tileHeight} after derivation`,
      );
    if (first) {
      if (
        tile.bitDepth !== first.bitDepth ||
        tile.bitDepthChroma !== first.bitDepthChroma ||
        tile.floatingPointSamples !== first.floatingPointSamples ||
        tile.dataBitDepth !== first.dataBitDepth ||
        tile.data.constructor !== first.data.constructor ||
        JSON.stringify(tile.info.color ?? null) !== JSON.stringify(first.info.color ?? null) ||
        tile.info.iccType !== first.info.iccType ||
        !sameBytes(tile.info.icc, first.info.icc)
      )
        throw new HeicError(
          'INVALID_CONTAINER',
          'heic: external tili tiles do not share one format',
        );
    } else {
      first = tile;
      data =
        tile.data instanceof Float32Array
          ? new Float32Array(canvasWidth * canvasHeight * 4)
          : new Uint16Array(canvasWidth * canvasHeight * 4);
    }

    const x = (spatialIndex % tiledImage.columns) * tiledImage.tileWidth;
    const y = Math.floor(spatialIndex / tiledImage.columns) * tiledImage.tileHeight;
    for (let row = 0; row < tiledImage.tileHeight; row++) {
      const source = row * tiledImage.tileWidth * 4;
      const destination = ((y + row) * canvasWidth + x) * 4;
      for (let i = 0; i < tiledImage.tileWidth * 4; i++)
        data![destination + i] = tile.data[source + i];
    }
    hasAlpha ||= tile.hasAlpha;
  }
  if (!first) throw new HeicError('INVALID_CONTAINER', 'heic: external tili has no selected tiles');

  const output =
    data instanceof Float32Array
      ? new Float32Array(info.width * info.height * 4)
      : new Uint16Array(info.width * info.height * 4);
  for (let row = 0; row < info.height; row++)
    for (let i = 0; i < info.width * 4; i++)
      output[row * info.width * 4 + i] = data![row * canvasWidth * 4 + i];
  return {
    width: info.width,
    height: info.height,
    bitDepth: first.bitDepth,
    ...(first.bitDepthChroma !== undefined ? { bitDepthChroma: first.bitDepthChroma } : {}),
    ...(first.floatingPointSamples ? { floatingPointSamples: true } : {}),
    ...(first.dataBitDepth !== undefined ? { dataBitDepth: first.dataBitDepth } : {}),
    data: output,
    hasAlpha,
    info: {
      ...info,
      color: overrides.color ?? info.color ?? first.info.color,
      icc: overrides.icc ?? info.icc ?? first.info.icc,
      iccType: overrides.iccType ?? info.iccType ?? first.info.iccType,
      chromaSampleLocation:
        overrides.chromaSampleLocation ??
        info.chromaSampleLocation ??
        first.info.chromaSampleLocation,
      chromaSampleLocations:
        overrides.chromaSampleLocations ??
        info.chromaSampleLocations ??
        first.info.chromaSampleLocations,
    },
  };
}

function checkedAvcTiliTilePlanes(
  input: ExternalBaseLayerPlanes | undefined,
  tileWidth: number,
  tileHeight: number,
  tileIndex: number,
): Planes {
  if (
    !input ||
    input.width !== tileWidth ||
    input.height !== tileHeight ||
    input.chromaFormatIdc !== 1 ||
    input.bitDepthLuma !== 8 ||
    input.bitDepthChroma !== 8 ||
    !(input.y instanceof Uint8Array) ||
    input.y.length !== tileWidth * tileHeight ||
    !(input.cb instanceof Uint8Array) ||
    !(input.cr instanceof Uint8Array) ||
    input.cb.length !== Math.ceil(tileWidth / 2) * Math.ceil(tileHeight / 2) ||
    input.cr.length !== input.cb.length
  )
    throw new HeicError(
      'INVALID_OPTIONS',
      `heic: prepared AVC tili tile ${tileIndex} has invalid 8-bit 4:2:0 planes`,
    );
  return {
    width: tileWidth,
    height: tileHeight,
    chromaFormatIdc: 1,
    bitDepthLuma: 8,
    bitDepthChroma: 8,
    y: input.y,
    cb: input.cb,
    cr: input.cr,
    hasExternalInterMotion: false,
    sourceColor: input.color,
    sourceChromaSampleLocation: input.chromaSampleLocation,
  };
}

function stitchInFileAvcTiledNative(
  ctx: RenderContext,
  info: HeicInfo,
  overrides?: RenderOverrides,
): NativeImage {
  const tiledImage = info.tiledImage!;
  if (!info.avcC)
    throw new HeicError('INVALID_CONTAINER', 'heic: avc1 tili image has no avcC configuration');
  const indexes = getTiledImageTileIndices(tiledImage, ctx.options.extraDimensionIndexes);
  const tileCount = tiledImage.columns * tiledImage.rows;
  if (!Number.isSafeInteger(tileCount) || tileCount <= 0 || tileCount > 65_536)
    throw new HeicError('RESOURCE_LIMIT', 'heic: AVC tili tile count exceeds 65536');
  if (indexes.length !== tileCount)
    throw new HeicError('INVALID_CONTAINER', 'heic: AVC tili plane has an invalid tile count');
  const canvasWidth = tiledImage.columns * tiledImage.tileWidth;
  const canvasHeight = tiledImage.rows * tiledImage.tileHeight;
  if (
    !Number.isSafeInteger(canvasWidth * canvasHeight) ||
    canvasWidth < info.width ||
    canvasHeight < info.height
  )
    throw new HeicError('INVALID_CONTAINER', 'heic: AVC tili extent exceeds its tile grid');
  checkSize(ctx, canvasWidth, canvasHeight);

  const payload = getItemPayload(
    ctx.input,
    ctx.boxes,
    info.primaryItemId,
    ctx.options.externalItemData,
  );
  if (!payload) throw new HeicError('INVALID_CONTAINER', 'heic: avc1 tili image has no tile data');
  const ranges = parseTiledItemRanges(
    payload,
    tiledImage.dataReference,
    tiledImage.dataReference.inputItemCount,
  );
  const prepared = ctx.options.avcTiliTilePlanes?.[info.primaryItemId];
  let firstColor: RenderColor | undefined;
  let firstIcc: Uint8Array | null = null;
  let firstIccType: HeicInfo['iccType'] = null;
  let output: Uint16Array | Float32Array | null = null;
  const initializeBlack = (data: Uint16Array | Float32Array) => {
    if (data instanceof Float32Array) {
      for (let index = 3; index < data.length; index += 4) data[index] = 1;
    } else {
      for (let index = 3; index < data.length; index += 4) data[index] = 255;
    }
  };

  for (let spatialIndex = 0; spatialIndex < tileCount; spatialIndex++) {
    const tileIndex = indexes[spatialIndex];
    if (!ranges[tileIndex]) continue;
    const externalPlanes = prepared?.[tileIndex];
    if (!externalPlanes)
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        'heic: synchronous AVC decoding is unavailable for in-file tili tiles; use async decode()',
      );
    const planes = checkedAvcTiliTilePlanes(
        externalPlanes,
        tiledImage.tileWidth,
        tiledImage.tileHeight,
        tileIndex,
      ),
      color = resolveRenderColor(overrides?.color ?? info.color ?? planes.sourceColor, null, null),
      tile = planePixels(
        planes,
        8,
        8,
        color,
        false,
        overrides?.chromaSampleLocation ??
          info.chromaSampleLocation ??
          planes.sourceChromaSampleLocation,
        overrides?.chromaSampleLocations ?? info.chromaSampleLocations,
      );
    if (!output) {
      output =
        tile instanceof Float32Array
          ? new Float32Array(canvasWidth * canvasHeight * 4)
          : new Uint16Array(canvasWidth * canvasHeight * 4);
      initializeBlack(output);
      firstColor = color;
      firstIcc = overrides?.icc ?? info.icc ?? null;
      firstIccType = overrides?.iccType ?? info.iccType ?? null;
    } else if (tile.constructor !== output.constructor)
      throw new HeicError(
        'INVALID_CONTAINER',
        'heic: AVC tili tiles do not share one pixel format',
      );
    const x = (spatialIndex % tiledImage.columns) * tiledImage.tileWidth;
    const y = Math.floor(spatialIndex / tiledImage.columns) * tiledImage.tileHeight;
    for (let row = 0; row < tiledImage.tileHeight; row++) {
      const source = row * tiledImage.tileWidth * 4;
      const destination = ((y + row) * canvasWidth + x) * 4;
      output.set(tile.subarray(source, source + tiledImage.tileWidth * 4), destination);
    }
  }

  if (!output) {
    const color = resolveRenderColor(overrides?.color ?? info.color, null, null),
      preserveExtended =
        color.transfer === 11 ||
        color.transfer === 12 ||
        (color.transfer === 13 && color.matrix !== 0);
    output = preserveExtended
      ? new Float32Array(canvasWidth * canvasHeight * 4)
      : new Uint16Array(canvasWidth * canvasHeight * 4);
    initializeBlack(output);
    firstColor = color;
    firstIcc = overrides?.icc ?? info.icc ?? null;
    firstIccType = overrides?.iccType ?? info.iccType ?? null;
  }

  const cropped =
    output instanceof Float32Array
      ? new Float32Array(info.width * info.height * 4)
      : new Uint16Array(info.width * info.height * 4);
  for (let row = 0; row < info.height; row++)
    cropped.set(
      output.subarray(row * canvasWidth * 4, row * canvasWidth * 4 + info.width * 4),
      row * info.width * 4,
    );
  return {
    width: info.width,
    height: info.height,
    bitDepth: 8,
    data: cropped,
    hasAlpha: false,
    info: {
      ...info,
      color: firstColor ?? resolveRenderColor(overrides?.color ?? info.color, null, null),
      icc: firstIcc,
      iccType: firstIccType,
    },
  };
}

function renderUncompressedPayload(
  ctx: RenderContext,
  info: HeicInfo,
  configuration: UncompressedImageConfiguration,
  payload: Uint8Array,
  overrides: RenderOverrides | undefined,
  auxiliary: boolean,
): NativeImage {
  checkSize(ctx, configuration.width, configuration.height);
  const decoded = decodeUncompressedImage(payload, configuration);
  if (decoded.model === 'components')
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: unci component data has no standard RGBA mapping',
    );
  let data: Uint16Array | Float32Array;
  let color = overrides?.color ?? info.color;
  if (decoded.model === 'yuv') {
    const renderColor = resolveRenderColor(color, null, null),
      chromaDepth = configuration.bitDepthChroma ?? configuration.bitDepth,
      renderDepth = Math.max(8, configuration.bitDepth),
      renderChromaDepth = Math.max(8, chromaDepth),
      normalizeDepth = (
        plane: UncompressedSampleArray,
        sourceDepth: number,
        targetDepth: number,
        signed: boolean,
      ): UncompressedSampleArray => {
        if (plane instanceof Float32Array || sourceDepth === targetDepth) return plane;
        if (signed)
          return Uint16Array.from(plane, (sample) =>
            scaleSignedComponentCode(sample, sourceDepth, targetDepth),
          );
        const scale =
          sourceDepth < 8
            ? (2 ** targetDepth - 1) / (2 ** sourceDepth - 1)
            : 2 ** (targetDepth - sourceDepth);
        return Uint16Array.from(plane, (sample) => Math.round(sample * scale));
      },
      normalizeChromaDepth = (
        componentType: 2 | 3,
        plane: UncompressedSampleArray,
      ): UncompressedSampleArray => {
        const component = configuration.components.find(
          (entry) => entry.componentType === componentType,
        );
        return normalizeDepth(
          plane,
          component?.bitDepth ?? chromaDepth,
          renderChromaDepth,
          component?.componentFormat === 3,
        );
      },
      cb = normalizeChromaDepth(2, decoded.cb),
      cr = normalizeChromaDepth(3, decoded.cr),
      yComponent = configuration.components.find((component) => component.componentType === 1),
      y = normalizeDepth(
        decoded.y,
        configuration.bitDepth,
        renderDepth,
        yComponent?.componentFormat === 3,
      );
    data = planePixels(
      {
        chromaFormatIdc: configuration.chromaFormatIdc,
        bitDepthLuma: renderDepth,
        bitDepthChroma: renderChromaDepth,
        hasExternalInterMotion: false,
        y,
        cb,
        cr,
        width: configuration.width,
        height: configuration.height,
      },
      renderDepth as HeifImageBitDepth,
      renderChromaDepth as HeifImageBitDepth,
      renderColor,
      auxiliary,
      undefined,
      undefined,
      configuration.floatingPointSamples,
    );
    color = renderColor;
    if (decoded.alpha) {
      const alphaComponent = configuration.components.find(
        (component) => component.componentType === 7,
      );
      for (let pixel = 0; pixel < decoded.alpha.length; pixel++)
        data[pixel * 4 + 3] =
          decoded.alpha instanceof Float32Array
            ? decoded.alpha[pixel]
            : alphaComponent?.componentFormat === 3
              ? scaleSignedComponentCode(decoded.alpha[pixel], configuration.bitDepth, renderDepth)
              : Math.round(
                  (decoded.alpha[pixel] * (2 ** renderDepth - 1)) /
                    (2 ** configuration.bitDepth - 1),
                );
    }
  } else data = decoded.rgba;
  if (configuration.bitDepth < 8 && decoded.model !== 'yuv') {
    const maximum = 2 ** configuration.bitDepth - 1,
      alphaComponent = configuration.components.find((component) => component.componentType === 7),
      colorComponents =
        decoded.model === 'rgb'
          ? [4, 5, 6].map((componentType) =>
              configuration.components.find(
                (component) => component.componentType === componentType,
              ),
            )
          : [configuration.components.find((component) => component.componentType === 0)];
    data = Uint16Array.from(decoded.rgba);
    for (let pixel = 0; pixel < configuration.width * configuration.height; pixel++) {
      for (let channel = 0; channel < 3; channel++) {
        const component = colorComponents[decoded.model === 'rgb' ? channel : 0];
        if (!component) continue;
        const index = pixel * 4 + channel,
          sample = decoded.rgba[index];
        data[index] =
          component.componentFormat === 3
            ? scaleSignedComponentCode(sample, configuration.bitDepth, 8)
            : Math.round((sample * 255) / maximum);
      }
      const alphaIndex = pixel * 4 + 3,
        alphaSample = decoded.rgba[alphaIndex];
      data[alphaIndex] =
        alphaComponent?.componentFormat === 3
          ? scaleSignedComponentCode(alphaSample, configuration.bitDepth, 8)
          : Math.round((alphaSample * 255) / maximum);
    }
  }
  return {
    width: configuration.width,
    height: configuration.height,
    bitDepth: configuration.bitDepth as HeifImageBitDepth,
    ...(configuration.bitDepth < 8 ? { dataBitDepth: 8 } : {}),
    ...(configuration.floatingPointSamples ? { floatingPointSamples: true } : {}),
    data,
    hasAlpha: decoded.alpha !== null,
    info: {
      ...info,
      color,
      icc: overrides?.icc ?? info.icc,
      iccType: overrides?.iccType ?? info.iccType,
    },
  };
}

function stitchInFileUncompressedTiledNative(
  ctx: RenderContext,
  info: HeicInfo,
  overrides?: RenderOverrides,
): NativeImage {
  const tiledImage = info.tiledImage!,
    configuration = info.uncompressedImage;
  if (!configuration)
    throw new HeicError('INVALID_CONTAINER', 'heic: unci tili image has no decoded configuration');
  const indexes = getTiledImageTileIndices(tiledImage, ctx.options.extraDimensionIndexes),
    tileCount = tiledImage.columns * tiledImage.rows;
  if (!Number.isSafeInteger(tileCount) || tileCount <= 0 || tileCount > 65_536)
    throw new HeicError('RESOURCE_LIMIT', 'heic: uncompressed tili tile count exceeds 65536');
  if (indexes.length !== tileCount)
    throw new HeicError(
      'INVALID_CONTAINER',
      'heic: uncompressed tili plane has an invalid tile count',
    );
  const canvasWidth = tiledImage.columns * tiledImage.tileWidth,
    canvasHeight = tiledImage.rows * tiledImage.tileHeight;
  if (
    !Number.isSafeInteger(canvasWidth * canvasHeight) ||
    canvasWidth < info.width ||
    canvasHeight < info.height
  )
    throw new HeicError(
      'INVALID_CONTAINER',
      'heic: uncompressed tili extent exceeds its tile grid',
    );
  checkSize(ctx, canvasWidth, canvasHeight);

  const payload = getItemPayload(
    ctx.input,
    ctx.boxes,
    info.primaryItemId,
    ctx.options.externalItemData,
  );
  if (!payload)
    throw new HeicError('INVALID_CONTAINER', 'heic: uncompressed tili has no tile data');
  const ranges = parseTiledItemRanges(
    payload,
    tiledImage.dataReference,
    tiledImage.dataReference.inputItemCount,
  );
  let output: Uint16Array | Float32Array | null = null;
  let first: NativeImage | null = null;
  const initializeBlack = (data: Uint16Array | Float32Array) => {
    const alpha = data instanceof Float32Array ? 1 : 255;
    for (let index = 3; index < data.length; index += 4) data[index] = alpha;
  };

  for (let spatialIndex = 0; spatialIndex < tileCount; spatialIndex++) {
    const tileIndex = indexes[spatialIndex],
      range = ranges[tileIndex];
    if (!range) continue;
    const tileConfiguration = {
      ...configuration,
      width: tiledImage.tileWidth,
      height: tiledImage.tileHeight,
    };
    const tilePayload = payload.subarray(range.offset, range.offset + range.length),
      decodedPayload = tileConfiguration.genericCompression
        ? decompressGenericItemPayloadSync(tilePayload, tileConfiguration.genericCompression)
        : tilePayload,
      tileInfo = {
        ...info,
        primaryItemType: 'unci',
        width: tiledImage.tileWidth,
        height: tiledImage.tileHeight,
        uncompressedImage: tileConfiguration,
      },
      tile = renderUncompressedPayload(
        ctx,
        tileInfo,
        tileConfiguration,
        decodedPayload,
        overrides,
        false,
      );
    if (first) {
      if (
        tile.bitDepth !== first.bitDepth ||
        tile.bitDepthChroma !== first.bitDepthChroma ||
        tile.floatingPointSamples !== first.floatingPointSamples ||
        tile.dataBitDepth !== first.dataBitDepth ||
        tile.data.constructor !== first.data.constructor ||
        tile.hasAlpha !== first.hasAlpha
      )
        throw new HeicError(
          'INVALID_CONTAINER',
          'heic: uncompressed tili tiles do not share one pixel format',
        );
    } else {
      first = tile;
      output =
        tile.data instanceof Float32Array
          ? new Float32Array(canvasWidth * canvasHeight * 4)
          : new Uint16Array(canvasWidth * canvasHeight * 4);
      initializeBlack(output);
    }
    const x = (spatialIndex % tiledImage.columns) * tiledImage.tileWidth,
      y = Math.floor(spatialIndex / tiledImage.columns) * tiledImage.tileHeight;
    for (let row = 0; row < tiledImage.tileHeight; row++) {
      const source = row * tiledImage.tileWidth * 4,
        destination = ((y + row) * canvasWidth + x) * 4;
      output!.set(tile.data.subarray(source, source + tiledImage.tileWidth * 4), destination);
    }
  }

  if (!output) {
    const color = resolveRenderColor(overrides?.color ?? info.color, null, null),
      preserveExtended =
        color.transfer === 11 ||
        color.transfer === 12 ||
        (color.transfer === 13 && color.matrix !== 0);
    output = preserveExtended
      ? new Float32Array(canvasWidth * canvasHeight * 4)
      : new Uint16Array(canvasWidth * canvasHeight * 4);
    initializeBlack(output);
  }
  const cropped =
    output instanceof Float32Array
      ? new Float32Array(info.width * info.height * 4)
      : new Uint16Array(info.width * info.height * 4);
  for (let row = 0; row < info.height; row++)
    cropped.set(
      output.subarray(row * canvasWidth * 4, row * canvasWidth * 4 + info.width * 4),
      row * info.width * 4,
    );
  return {
    width: info.width,
    height: info.height,
    bitDepth: first?.bitDepth ?? (configuration.bitDepth as HeifImageBitDepth),
    ...(first?.bitDepthChroma !== undefined ? { bitDepthChroma: first.bitDepthChroma } : {}),
    ...(first?.floatingPointSamples ? { floatingPointSamples: true } : {}),
    ...(first?.dataBitDepth !== undefined ? { dataBitDepth: first.dataBitDepth } : {}),
    data: cropped,
    hasAlpha:
      first?.hasAlpha ??
      configuration.components.some((component) => component.componentType === 7),
    info: {
      ...info,
      color: first
        ? first.info.color
        : resolveRenderColor(overrides?.color ?? info.color, null, null),
      icc: overrides?.icc ?? info.icc,
      iccType: overrides?.iccType ?? info.iccType,
    },
  };
}

export function decodeNative(
  ctx: RenderContext,
  itemId?: number,
  auxiliary = false,
  transforms = ctx.options.applyTransforms !== false ||
    ctx.options.applyHevcDisplayOrientation !== false,
  overrides?: RenderOverrides,
  applyDefaultDisplayWindow = ctx.options.applyDefaultDisplayWindow === true,
): NativeImage {
  const { input, boxes } = ctx,
    info = getHeicInfo(input, boxes, itemId),
    id = info.primaryItemId;
  if (ctx.stack.has(id) || ctx.stack.size >= 32)
    throw new HeicError('INVALID_CONTAINER', 'heic: cyclic or deeply nested derived image');
  ctx.stack.add(id);
  try {
    let image: NativeImage, phaseIndication: HevcPhaseIndication | undefined;
    if (info.primaryItemType === 'iden' || info.primaryItemType === 'tmap') {
      if (info.derivedItems.length !== (info.primaryItemType === 'iden' ? 1 : 2))
        throw new HeicError('INVALID_CONTAINER', 'heic: invalid derived image references');
      const base = decodeNative(
        ctx,
        info.derivedItems[0],
        auxiliary,
        false,
        overrides,
        applyDefaultDisplayWindow &&
          !info.transforms.some((displayProperty) => displayProperty.type === 'clap'),
      );
      image = {
        ...base,
        info: {
          ...info,
          color: overrides?.color ?? info.color ?? base.info.color,
          icc: overrides?.icc ?? info.icc ?? base.info.icc,
          iccType: overrides?.iccType ?? info.iccType ?? base.info.iccType,
          chromaSampleLocation:
            overrides?.chromaSampleLocation ??
            info.chromaSampleLocation ??
            base.info.chromaSampleLocation,
          chromaSampleLocations:
            overrides?.chromaSampleLocations ??
            info.chromaSampleLocations ??
            base.info.chromaSampleLocations,
        },
      };
    } else if (info.primaryItemType === 'iovl') image = decodeOverlay(ctx, info, overrides);
    else if (info.primaryItemType === 'unci') {
      const configuration = info.uncompressedImage;
      if (!configuration)
        throw new HeicError('INVALID_CONTAINER', 'heic: unci item has no decoded configuration');
      const itemPayload = getItemPayload(input, boxes, id, ctx.options.externalItemData);
      if (!itemPayload)
        throw new HeicError('INVALID_CONTAINER', `heic: unci item ${id} has no payload`);
      const payload =
        ctx.options.decodedItemData?.[id] ??
        (configuration.genericCompression
          ? decompressGenericItemPayloadSync(itemPayload, configuration.genericCompression)
          : itemPayload);
      image = renderUncompressedPayload(ctx, info, configuration, payload, overrides, auxiliary);
    } else if (info.primaryItemType === 'avc1') {
      const planes = decodeItemPlanes(input, boxes, info, id, {
          externalItemData: ctx.options.externalItemData,
          externalBaseLayerPlanes: ctx.options.externalBaseLayerPlanes,
        }),
        depth = planes.bitDepthLuma ?? info.bitDepth,
        chromaDepth = planes.bitDepthChroma ?? depth,
        color = resolveRenderColor(
          overrides?.color ?? info.color ?? planes.sourceColor,
          null,
          null,
        );
      checkSize(ctx, planes.width, planes.height);
      image = {
        width: planes.width,
        height: planes.height,
        bitDepth: depth as HeifHevcBitDepth,
        ...(chromaDepth !== depth ? { bitDepthChroma: chromaDepth as HeifHevcBitDepth } : {}),
        data: planePixels(
          planes,
          depth,
          chromaDepth,
          color,
          auxiliary,
          overrides?.chromaSampleLocation ??
            info.chromaSampleLocation ??
            planes.sourceChromaSampleLocation,
          overrides?.chromaSampleLocations ?? info.chromaSampleLocations,
        ),
        hasAlpha: false,
        info: {
          ...info,
          color,
          icc: overrides?.icc ?? info.icc,
          iccType: overrides?.iccType ?? info.iccType,
        },
      };
    } else if (
      info.primaryItemType === 'tili' &&
      info.tiledImage?.tileItemType === 'avc1' &&
      !info.tiledImage.dataReference.externalTileUrls
    )
      image = stitchInFileAvcTiledNative(ctx, info, overrides);
    else if (
      info.primaryItemType === 'tili' &&
      info.tiledImage?.tileItemType === 'unci' &&
      !info.tiledImage.dataReference.externalTileUrls
    )
      image = stitchInFileUncompressedTiledNative(ctx, info, overrides);
    else if (
      info.tiledImage?.dataReference.externalTileUrls &&
      (info.predReferenceItemIds?.length ?? 0) === 0
    )
      image = stitchExternalTiledNative(ctx, info, overrides);
    else {
      if (!info.hvcC && !info.lhevc && !info.tiledImage?.dataReference.externalTileUrls)
        throw new HeicError(
          'UNSUPPORTED_FEATURE',
          'heic: unsupported derived item ' + info.primaryItemType,
        );
      let sps = null;
      if (info.lhevc) {
        const targetSps = info.lhevc.configuration.arrays
          .filter((array) => array.nalUnitType === 33)
          .flatMap((array) => array.nalUnits)
          .find((nal) => nal.layerId === info.lhevc!.targetLayerId);
        if (targetSps)
          sps = parseSps(targetSps.data, {
            allowBaseLayerMultilayerExtension: true,
            layeredVps: info.lhevc.selectedVps ?? undefined,
          });
      } else if (info.hvcC) sps = activeSpsForInfo(ctx, info);
      let planes: Planes;
      if (info.grid) {
        checkSize(
          ctx,
          info.grid.columns * info.grid.tileWidth,
          info.grid.rows * info.grid.tileHeight,
        );
        planes = cropPlanes(
          stitchGrid(input, boxes, info, info.grid, {
            externalTileData: ctx.options.externalTileData,
            externalItemData: ctx.options.externalItemData,
            externalBaseLayerPlanes: ctx.options.externalBaseLayerPlanes,
            extraDimensionIndexes: ctx.options.extraDimensionIndexes,
          }),
          0,
          0,
          info.grid.outputWidth,
          info.grid.outputHeight,
        );
      } else if (info.tiledImage) {
        checkSize(
          ctx,
          info.tiledImage.columns * info.tiledImage.tileWidth,
          info.tiledImage.rows * info.tiledImage.tileHeight,
        );
        planes = cropPlanes(
          decodeItemPlanes(input, boxes, info, id, {
            externalTileData: ctx.options.externalTileData,
            externalItemData: ctx.options.externalItemData,
            externalBaseLayerPlanes: ctx.options.externalBaseLayerPlanes,
            extraDimensionIndexes: ctx.options.extraDimensionIndexes,
          }),
          0,
          0,
          info.width,
          info.height,
        );
        sps ??= planes.sourceSps ?? null;
      } else {
        if (!sps) throw new HeicError('INVALID_CONTAINER', 'heic: image has no HEVC configuration');
        checkSize(ctx, sps.picWidthInLumaSamples, sps.picHeightInLumaSamples);
        const sub = chromaSubsampling(sps.chromaFormatIdc);
        planes = cropPlanes(
          decodeItemPlanes(input, boxes, info, id, {
            externalItemData: ctx.options.externalItemData,
            externalBaseLayerPlanes: ctx.options.externalBaseLayerPlanes,
          }),
          sub.width * sps.cropLeft,
          sub.height * sps.cropTop,
          sps.width,
          sps.height,
        );
        if (
          applyDefaultDisplayWindow &&
          sps.defaultDisplayWindow &&
          !info.transforms.some((displayProperty) => displayProperty.type === 'clap')
        )
          planes = cropPlanesToDefaultDisplayWindow(planes, sps);
      }
      sps ??= planes.sourceSps ?? null;
      if (!sps)
        throw new HeicError('INVALID_CONTAINER', 'heic: image has no HEVC sequence parameters');
      const depth = sps.bitDepthLuma as HeifHevcBitDepth;
      const chromaDepth = sps.bitDepthChroma as HeifHevcBitDepth;
      const colorSps = planes.sourceSps ?? sps;
      const hdrSei = getHevcSeiMetadata(input, boxes, info, ctx.options.externalItemData);
      phaseIndication = hdrSei?.phaseIndication?.at(-1);
      const declared = overrides?.color ?? info.color ?? planes.sourceColor;
      const vpsSignalInfo = info.lhevc?.selectedVps
        ? getVpsVideoSignalInfoForSps(info.lhevc.selectedVps, colorSps)
        : null;
      const color = resolveRenderColor(
        declared,
        colorSps.color,
        vpsSignalInfo,
        hdrSei?.alternativeTransferCharacteristics?.preferredTransferCharacteristics,
      );
      let renderPlanes = planes,
        renderDepth: number = depth,
        renderChromaDepth: number = chromaDepth,
        renderColor = color,
        renderChromaSampleLocation =
          overrides?.chromaSampleLocation ??
          info.chromaSampleLocation ??
          planes.sourceChromaSampleLocation ??
          sps.chromaSampleLocation,
        renderChromaSampleLocations =
          overrides?.chromaSampleLocations ?? info.chromaSampleLocations;
      if (!auxiliary && ctx.options.applyHevcChromaResamplingFilterHint === true) {
        const hint = hdrSei?.chromaResamplingFilterHint?.[0];
        if (hint) {
          let chromaSampleLocType = colorSps.chromaSampleLocTypeTopField ?? 0,
            fieldSequenceParity: 0 | 1 | undefined;
          if (colorSps.fieldSequence) {
            const picStruct = hdrSei?.pictureTiming?.picStruct;
            if (picStruct === undefined)
              throw new HeicError(
                'INVALID_BITSTREAM',
                'heic: field-sequence picture has no picture_timing pic_struct',
              );
            if (picStruct === 1 || picStruct === 9 || picStruct === 11) {
              fieldSequenceParity = 0;
              chromaSampleLocType = colorSps.chromaSampleLocTypeTopField ?? 0;
            } else if (picStruct === 2 || picStruct === 10 || picStruct === 12) {
              fieldSequenceParity = 1;
              chromaSampleLocType = colorSps.chromaSampleLocTypeBottomField ?? 0;
            } else {
              throw new HeicError(
                'INVALID_BITSTREAM',
                'heic: field-sequence picture_timing pic_struct does not identify a field',
              );
            }
            if (!hint.verticalFilteringFieldProcessing) {
              if (picStruct === 1 || picStruct === 2)
                throw new HeicError(
                  'INVALID_BITSTREAM',
                  'heic: field-sequence CRFH requires field-based vertical processing',
                );
              throw new HeicError(
                'UNSUPPORTED_FEATURE',
                'heic: frame-based CRFH for paired fields needs the paired access unit',
              );
            }
          }
          const resampled = applyChromaResamplingHint(
            renderPlanes,
            hint,
            chromaSampleLocType,
            fieldSequenceParity,
          );
          renderPlanes = resampled.planes;
          renderChromaSampleLocation = resampled.chromaSampleLocation;
          renderChromaSampleLocations = resampled.chromaSampleLocation
            ? { cb: resampled.chromaSampleLocation, cr: resampled.chromaSampleLocation }
            : undefined;
        }
      }
      if (!auxiliary && ctx.options.applyHevcPostFilterHint === true) {
        const hint = [...(hdrSei?.postFilterHint ?? [])]
          .reverse()
          .find((candidate) => candidate.filterHintType === 0 || candidate.filterHintType === 1);
        if (hint) renderPlanes = applyHevcPostFilterHint(renderPlanes, hint);
      }
      if (!auxiliary && ctx.options.applyHevcColourRemapping === true) {
        const remapping = selectHevcColourRemappingInfo(
          hdrSei?.colourRemappingInfo,
          ctx.options.hevcColourRemapId,
        );
        if (ctx.options.hevcColourRemapId !== undefined && !remapping)
          throw new HeicError(
            'INVALID_OPTIONS',
            `heic: no active colour_remapping_info for colour_remap_id ${ctx.options.hevcColourRemapId}`,
          );
        // H.265 requires remapping SEI to be ignored for monochrome pictures.
        if (remapping && planes.cb.length > 0) {
          renderColor = remapping.videoSignalInfo
            ? resolveRenderColor(
                {
                  primaries: remapping.videoSignalInfo.primaries,
                  transfer: remapping.videoSignalInfo.transferFunction,
                  matrix: remapping.videoSignalInfo.matrixCoefficients,
                  fullRange: remapping.videoSignalInfo.fullRange,
                },
                null,
                null,
              )
            : color;
          renderPlanes = remapColourPlanes(
            renderPlanes,
            depth,
            chromaDepth,
            remapping,
            renderColor.matrix,
            renderChromaSampleLocation,
            renderChromaSampleLocations,
          );
          renderDepth = remapping.outputBitDepth;
          renderChromaDepth = remapping.outputBitDepth;
        }
      }
      image = {
        width: renderPlanes.width,
        height: renderPlanes.height,
        bitDepth: depth,
        ...(chromaDepth !== depth ? { bitDepthChroma: chromaDepth } : {}),
        ...(renderDepth !== depth ? { dataBitDepth: renderDepth } : {}),
        data: planePixels(
          renderPlanes,
          renderDepth,
          renderChromaDepth,
          renderColor,
          auxiliary,
          renderChromaSampleLocation,
          renderChromaSampleLocations,
        ),
        hasAlpha: false,
        info: {
          ...info,
          color: renderColor,
          icc: overrides?.icc ?? info.icc ?? planes.sourceIcc ?? null,
          iccType: overrides?.iccType ?? info.iccType ?? planes.sourceIccType ?? null,
          chromaSampleLocation: renderChromaSampleLocation,
          chromaSampleLocations: renderChromaSampleLocations,
        },
      };
      if (planes.alpha) {
        const alphaMax = 2 ** (planes.alphaBitDepth ?? depth) - 1,
          max = 2 ** renderDepth - 1;
        for (let i = 0; i < planes.alpha.length; i++) {
          const offset = i * 4,
            signalledFactor = hevcAlphaSampleToFactor(planes.alpha[i], planes.alphaChannelInfo),
            unboundedAlpha = signalledFactor ?? planes.alpha[i] / alphaMax,
            a =
              image.data instanceof Float32Array
                ? unboundedAlpha
                : Math.max(0, Math.min(1, unboundedAlpha));
          image.data[offset + 3] = Math.round(a * max);
          if (
            planes.premultipliedAlpha ||
            (signalledFactor !== undefined && planes.alphaChannelInfo?.useIdc === 1)
          )
            for (let c = 0; c < 3; c++)
              image.data[offset + c] = a
                ? image.data instanceof Float32Array
                  ? image.data[offset + c] / a
                  : Math.min(max, Math.round(image.data[offset + c] / a))
                : 0;
        }
        image.hasAlpha = true;
      }
    }
    if (info.alphaItemId !== null && !auxiliary) {
      // Alpha is combined in reconstructed coordinates, then the colour item's
      // display transforms are applied once to the combined RGBA raster.
      const alpha = decodeNative(ctx, info.alphaItemId, true, false),
        max = 2 ** (image.dataBitDepth ?? image.bitDepth) - 1,
        amax = 2 ** (alpha.dataBitDepth ?? alpha.bitDepth) - 1,
        alphaSei = getHevcAuxiliarySeiForItem(info, info.alphaItemId, alpha.info),
        alphaChannelInfo = activeHevcAlphaChannelInfo(alphaSei);
      if (
        alphaChannelInfo?.bitDepth !== undefined &&
        (alphaChannelInfo.bitDepth !== alpha.bitDepth ||
          alphaChannelInfo.bitDepth !== image.bitDepth)
      )
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: alpha_channel_bit_depth does not match the primary and auxiliary images',
        );
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++) {
          const ai =
            (Math.min(alpha.height - 1, Math.floor((y * alpha.height) / image.height)) *
              alpha.width +
              Math.min(alpha.width - 1, Math.floor((x * alpha.width) / image.width))) *
            4;
          const o = (y * image.width + x) * 4,
            sample = alpha.data[ai],
            signalledFactor = hevcAlphaSampleToFactor(sample, alphaChannelInfo),
            unboundedAlpha = signalledFactor ?? sample / amax,
            a =
              image.data instanceof Float32Array
                ? unboundedAlpha
                : Math.max(0, Math.min(1, unboundedAlpha));
          const currentAlpha = image.data[o + 3] / max;
          image.data[o + 3] = Math.round(a * currentAlpha * max);
          if (
            info.premultipliedAlpha ||
            (signalledFactor !== undefined && alphaChannelInfo?.useIdc === 1)
          )
            for (let c = 0; c < 3; c++)
              image.data[o + c] = a
                ? image.data instanceof Float32Array
                  ? image.data[o + c] / a
                  : Math.min(max, Math.round(image.data[o + c] / a))
                : 0;
        }
      image.hasAlpha = true;
    }
    if (!auxiliary && ctx.options.applyHevcPhaseIndication === true && phaseIndication)
      applyHevcPhaseIndication(image.data, image.width, image.height, phaseIndication);
    return transforms ? transform(image, ctx) : image;
  } finally {
    ctx.stack.delete(id);
  }
}

function decodeOverlay(
  ctx: RenderContext,
  info: HeicInfo,
  overrides?: RenderOverrides,
): NativeImage {
  const bytes = getItemPayload(
    ctx.input,
    ctx.boxes,
    info.primaryItemId,
    ctx.options.externalItemData,
  );
  if (!bytes || bytes.length < 14 || bytes[0] !== 0 || bytes[1] & ~1)
    throw new HeicError('INVALID_CONTAINER', 'heic: invalid overlay header');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    wide = !!(bytes[1] & 1),
    size = wide ? 4 : 2;
  const width = wide ? view.getUint32(10) : view.getUint16(10),
    height = wide ? view.getUint32(14) : view.getUint16(12),
    header = 10 + 2 * size;
  if (bytes.length !== header + info.derivedItems.length * 2 * size)
    throw new HeicError('INVALID_CONTAINER', 'heic: overlay offset count mismatch');
  checkSize(ctx, width, height);
  // Overlay fill values are normalized unsigned 16-bit samples (HEIF iovl).
  const depth = isHeifHevcBitDepth(info.bitDepth) ? info.bitDepth : 8,
    max = 2 ** depth - 1;
  let data: Uint16Array | Float32Array = new Uint16Array(width * height * 4);
  for (let i = 0; i < width * height; i++)
    for (let c = 0; c < 4; c++)
      data[i * 4 + c] = Math.round((view.getUint16(2 + 2 * c) * max) / 65535);
  let hasAlpha = view.getUint16(8) < 65535;
  for (const [index, id] of info.derivedItems.entries()) {
    const src = decodeNative(ctx, id, false, undefined, overrides),
      smax = 2 ** (src.dataBitDepth ?? src.bitDepth) - 1,
      p = header + index * 2 * size,
      x0 = wide ? view.getInt32(p) : view.getInt16(p),
      y0 = wide ? view.getInt32(p + size) : view.getInt16(p + size);
    if (src.data instanceof Float32Array && !(data instanceof Float32Array))
      data = Float32Array.from(data);
    hasAlpha ||= src.hasAlpha;
    for (let y = Math.max(0, -y0); y < Math.min(src.height, height - y0); y++)
      for (let x = Math.max(0, -x0); x < Math.min(src.width, width - x0); x++) {
        const si = (y * src.width + x) * 4,
          di = ((y + y0) * width + x + x0) * 4,
          a = src.data[si + 3] / smax,
          b = data[di + 3] / max,
          outA = a + b * (1 - a);
        for (let c = 0; c < 3; c++) {
          const value = outA
            ? (((src.data[si + c] / smax) * a + (data[di + c] / max) * b * (1 - a)) / outA) * max
            : 0;
          data[di + c] = data instanceof Float32Array ? value : Math.round(value);
        }
        data[di + 3] = Math.round(outA * max);
      }
  }
  return {
    width,
    height,
    data,
    bitDepth: depth,
    hasAlpha,
    info: {
      ...info,
      color: overrides?.color ?? info.color,
      icc: overrides?.icc ?? info.icc,
      iccType: overrides?.iccType ?? info.iccType,
      chromaSampleLocation: overrides?.chromaSampleLocation ?? info.chromaSampleLocation,
      chromaSampleLocations: overrides?.chromaSampleLocations ?? info.chromaSampleLocations,
    },
  };
}

export function decodeRendered(
  input: Uint8Array,
  options: DecodeOptions,
  itemId?: number,
): HeicImageData {
  const context = createRenderContext(input, options),
    native = decodeNative(context, itemId),
    max = 2 ** (native.dataBitDepth ?? native.bitDepth) - 1,
    data = new Uint8Array(native.data.length),
    profile = native.info.icc
      ? parseIccProfile(native.info.icc, native.info.iccType, options.iccRenderingIntent, {
          imagePixels: native.width * native.height,
        })
      : null,
    applyIcc =
      profile !== null &&
      ((profile.transfer !== 16 && profile.transfer !== 18) ||
        profile.hdrSdrCompatibilityTransform === true);
  let toneMappingLut: ReturnType<typeof compileHevcToneMapping> = undefined;
  let kneeFunctionLut: ReturnType<typeof compileHevcKneeFunction> | undefined;
  let kneeTransferFunction: ReturnType<typeof getColorTransferFunction> = null;
  if (options.applyHevcToneMapping === true) {
    const info = getHeicInfo(input, context.boxes, itemId),
      sei = getHevcSeiMetadata(input, context.boxes, info, options.externalItemData),
      mapping = selectHevcToneMappingInfo(sei?.toneMappingInfo, options.hevcToneMapId);
    if (options.hevcToneMapId !== undefined && !mapping)
      throw new HeicError(
        'INVALID_OPTIONS',
        `heic: no active tone_mapping_info for tone_map_id ${options.hevcToneMapId}`,
      );
    if (mapping?.model.modelId === 4)
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        'heic: tone_mapping_info model 4 carries luminance metadata but no pixel mapping curve',
      );
    if (mapping) toneMappingLut = compileHevcToneMapping(mapping);
  }
  if (options.applyHevcKneeFunction === true) {
    const info = getHeicInfo(input, context.boxes, itemId),
      sei = getHevcSeiMetadata(input, context.boxes, info, options.externalItemData),
      mapping = selectHevcKneeFunctionInfo(sei?.kneeFunctionInfo, options.hevcKneeFunctionId);
    if (options.hevcKneeFunctionId !== undefined && !mapping)
      throw new HeicError(
        'INVALID_OPTIONS',
        `heic: no active knee_function_info for knee_function_id ${options.hevcKneeFunctionId}`,
      );
    if (mapping) {
      const sps = activeSpsForInfo(context, native.info),
        vpsSignalInfo =
          native.info.lhevc?.selectedVps && sps
            ? getVpsVideoSignalInfoForSps(native.info.lhevc.selectedVps, sps)
            : null,
        color = resolveRenderColor(
          native.info.color,
          sps?.color ?? null,
          vpsSignalInfo,
          sei?.alternativeTransferCharacteristics?.preferredTransferCharacteristics,
        );
      if (color.matrix === 11)
        throw new HeicError(
          'UNSUPPORTED_FEATURE',
          'heic: knee_function_info requires RGB output; SMPTE ST 2085 produces XYZ samples',
        );
      kneeFunctionLut = compileHevcKneeFunction(mapping);
      if (!applyIcc) {
        const transfer = profile?.transfer ?? color.transfer;
        kneeTransferFunction = getColorTransferFunction(transfer);
        if (!kneeTransferFunction)
          throw new HeicError(
            'UNSUPPORTED_FEATURE',
            `heic: knee_function_info cannot linearize transfer characteristics ${transfer}`,
          );
      }
    }
  }
  const rgbMax = toneMappingLut?.targetMax ?? max,
    mapSample = (sample: number) => {
      if (!toneMappingLut) return sample;
      const bounded = Number.isFinite(sample) ? Math.max(0, Math.min(max, sample)) : 0,
        coded = Math.round((bounded * toneMappingLut.codedMax) / max);
      return toneMappingLut.values[coded];
    },
    mapKneeSample = (sample: number) => {
      if (!kneeFunctionLut || !kneeTransferFunction) return 0;
      const linear = kneeTransferFunction.toLinear(sample / rgbMax),
        mapped = mapHevcKneeFunction(kneeFunctionLut, linear),
        encoded = kneeTransferFunction.fromLinear(mapped);
      return Math.max(0, Math.min(255, Math.round(encoded * 255)));
    };
  for (let i = 0; i < data.length; i += 4) {
    const red = mapSample(native.data[i]),
      green = mapSample(native.data[i + 1]),
      blue = mapSample(native.data[i + 2]);
    if (applyIcc) {
      const linear = iccToLinearSrgb(profile, [red / rgbMax, green / rgbMax, blue / rgbMax]);
      if (kneeFunctionLut)
        for (let channel = 0; channel < 3; channel++)
          linear[channel] = mapHevcKneeFunction(kneeFunctionLut, linear[channel]);
      const rgb = linearSrgbToSrgb(linear);
      data[i] = Math.round(rgb[0] * 255);
      data[i + 1] = Math.round(rgb[1] * 255);
      data[i + 2] = Math.round(rgb[2] * 255);
    } else if (kneeFunctionLut && kneeTransferFunction) {
      data[i] = mapKneeSample(red);
      data[i + 1] = mapKneeSample(green);
      data[i + 2] = mapKneeSample(blue);
    } else {
      data[i] = Math.max(0, Math.min(255, Math.round((red * 255) / rgbMax)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round((green * 255) / rgbMax)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round((blue * 255) / rgbMax)));
    }
    data[i + 3] = Math.max(0, Math.min(255, Math.round((native.data[i + 3] * 255) / max)));
  }
  return {
    width: native.width,
    height: native.height,
    data,
    bitDepth: native.bitDepth,
    ...(native.bitDepthChroma !== undefined ? { bitDepthChroma: native.bitDepthChroma } : {}),
    hasAlpha: native.hasAlpha,
  };
}
