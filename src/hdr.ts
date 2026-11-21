import { HeicError, asHeicError } from './errors.js';
import { isHeic, type DecodeOptions } from './decoder.js';
import {
  checkSize,
  createRenderContext,
  decodeNative,
  externalTileContext,
  transformRaster,
  type NativeImage,
  type RenderOverrides,
  type RenderContext,
} from './render.js';
import {
  getHeicInfo,
  getItemPayload,
  parseIref,
  validateExternalItemData,
} from './container/heic.js';
import { findBox, parseIinf } from './container/heif.js';
import type { HeifImageBitDepth } from './bit-depth.js';
import { buildTiledTileUrl, getTiledImageTileIndices } from './container/tili.js';
import { getColorTransferFunction } from './color-transfer.js';
import { getRgbLumaCoefficients, getRgbToXyzD65Matrix } from './color-matrix.js';
import {
  activeHevcAlphaChannelInfo,
  getHevcAuxiliarySeiForItem,
  hevcAlphaSampleToFactor,
} from './hevc/heif-sei.js';
import {
  SRGB_FROM_XYZ,
  apply3 as apply,
  multiply3 as multiply,
  parseIccProfile as iccProfile,
} from './icc.js';
import { createIccHagcToneMap } from './icc-hagc.js';

export interface HdrOptions extends DecodeOptions {
  /** Target display/base-white ratio for gain maps and ICC HAGC. Omit for full stored headroom. */
  displayHeadroom?: number;
  /** Reference white luminance for PQ/HLG and cinema transfer 17. Default 203 cd/m². */
  referenceWhiteNits?: number;
  /** HLG reference display peak. Default 1000 cd/m². */
  displayPeakNits?: number;
}
export interface HdrImage {
  width: number;
  height: number;
  bitDepth: HeifImageBitDepth;
  /** Present only when the HEVC chroma depth differs from luma. */
  bitDepthChroma?: HeifImageBitDepth;
  data: Float32Array;
  hasAlpha: boolean;
  colorSpace: 'linear-srgb';
  headroom: number;
  sourceHeadroom: number;
  source: 'sdr' | 'pq' | 'hlg' | 'linear-float' | 'apple-gainmap' | 'iso-gainmap' | 'icc-hagc';
}

export const srgbToLinear = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
export const rec709ToLinear = (v: number) =>
  v < 0.081 ? v / 4.5 : ((v + 0.099) / 1.099) ** (1 / 0.45);
/** ITU-R BT.2100-3 Table 4, normalized to reference white. */
export function pqToLinear(v: number, white = 203): number {
  const n = Math.max(0, v) ** (1 / (2523 / 32)),
    m1 = 2610 / 16384;
  return (
    ((Math.max(n - 3424 / 4096, 0) / (2413 / 128 - (2392 / 128) * n)) ** (1 / m1) * 10000) / white
  );
}
export function hlgInverseOetf(v: number): number {
  const a = 0.17883277,
    b = 1 - 4 * a,
    c = 0.5 - a * Math.log(4 * a);
  return v <= 0.5 ? (v * v) / 3 : (Math.exp((v - c) / a) + b) / 12;
}
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function primaryMatrix(primaries: number): number[] {
  if (primaries === 1 || primaries === 2) return IDENTITY;
  const xyzFromRgb = getRgbToXyzD65Matrix(primaries);
  if (xyzFromRgb) return multiply(SRGB_FROM_XYZ, [...xyzFromRgb]);
  throw new HeicError('UNSUPPORTED_FEATURE', 'heic: HDR color primaries are not supported');
}

function linearize(image: NativeImage, options: HdrOptions): HdrImage {
  const profile = image.info.icc
      ? iccProfile(image.info.icc, image.info.iccType, options.iccRenderingIntent, {
          imagePixels: image.width * image.height,
          applyHeadroomAdaptiveGainCurve: true,
        })
      : null,
    hagc = profile?.headroomAdaptiveGainCurve,
    transfer = profile?.transfer ?? image.info.color?.transfer ?? 13,
    primaries =
      profile?.primaries !== null && profile?.primaries !== undefined && profile.primaries !== 2
        ? profile.primaries
        : (image.info.color?.primaries ?? 1),
    max = 2 ** (image.dataBitDepth ?? image.bitDepth) - 1,
    white = options.referenceWhiteNits ?? hagc?.referenceWhiteNits ?? 203,
    peak = options.displayPeakNits ?? 1000;
  const matrix = profile?.transformToLinearSrgb
      ? IDENTITY
      : profile && !profile.transfer
        ? profile.matrix
        : profile && profile.primaries === 2 && image.info.color?.primaries === undefined
          ? profile.matrix
          : primaryMatrix(primaries),
    out = new Float32Array(image.data.length);
  const gamma = 1.2 + 0.42 * Math.log10(peak / 1000);
  const linearFloatSource = image.floatingPointSamples === true && transfer === 8;
  let floatSampleHeadroom = 1;
  for (let i = 0; i < image.data.length; i += 4) {
    let rgb = [image.data[i] / max, image.data[i + 1] / max, image.data[i + 2] / max];
    if (profile?.channelModel === 'GRAY') rgb = [rgb[0], 0, 0];
    if (profile?.transformToLinearSrgb)
      rgb = profile.transformToLinearSrgb(rgb as [number, number, number]);
    else if (transfer === 16) rgb = rgb.map((v) => pqToLinear(v, white));
    else if (transfer === 18) {
      rgb = rgb.map(hlgInverseOetf);
      const luma = getRgbLumaCoefficients(primaries) ?? [0.2627, 0.678, 0.0593],
        luminance = luma[0] * rgb[0] + luma[1] * rgb[1] + luma[2] * rgb[2],
        scale = luminance > 0 ? (luminance ** (gamma - 1) * peak) / white : 0;
      rgb = rgb.map((v) => v * scale);
    } else if (profile && hagc && transfer === 8) {
      // ICC HAGC profiles signal linear RGB through their CICP tag. Their
      // matrix/TRC curves do not replace that transfer characteristic.
    } else if (linearFloatSource) {
      // IEEE float components already carry linear values. The integer
      // transfer helper clamps normalized inputs to [0, 1], losing HDR data.
    } else if (profile)
      rgb =
        profile.channelModel === 'GRAY'
          ? [profile.curves[0](rgb[0]), 0, 0]
          : rgb.map((v, c) => profile.curves[c](v));
    else {
      const transferFunction = getColorTransferFunction(transfer);
      if (!transferFunction)
        throw new HeicError('UNSUPPORTED_FEATURE', 'heic: transfer function is not supported');
      const referenceScale = transfer === 17 ? 48 / white : 1;
      rgb = rgb.map((v) => transferFunction.toLinear(v) * referenceScale);
    }
    rgb = apply(matrix, rgb);
    if (rgb.some((v) => !Number.isFinite(v)))
      throw new HeicError('INVALID_CONTAINER', 'heic: non-finite HDR color value');
    if (linearFloatSource)
      floatSampleHeadroom = Math.max(floatSampleHeadroom, rgb[0], rgb[1], rgb[2]);
    out[i] = rgb[0];
    out[i + 1] = rgb[1];
    out[i + 2] = rgb[2];
    out[i + 3] = image.data[i + 3] / max;
  }
  const imageData: HdrImage = {
    width: image.width,
    height: image.height,
    bitDepth: image.bitDepth,
    ...(image.bitDepthChroma !== undefined ? { bitDepthChroma: image.bitDepthChroma } : {}),
    data: out,
    hasAlpha: image.hasAlpha,
    colorSpace: 'linear-srgb',
    headroom: linearFloatSource
      ? floatSampleHeadroom
      : transfer === 16
        ? 10000 / white
        : transfer === 18
          ? peak / white
          : transfer === 17
            ? 52.37 / white
            : 1,
    sourceHeadroom: linearFloatSource
      ? floatSampleHeadroom
      : transfer === 16
        ? 10000 / white
        : transfer === 18
          ? peak / white
          : transfer === 17
            ? 52.37 / white
            : 1,
    source: linearFloatSource
      ? 'linear-float'
      : transfer === 16
        ? 'pq'
        : transfer === 18
          ? 'hlg'
          : 'sdr',
  };
  const toneMap = hagc?.toneMap;
  if (!toneMap || (transfer !== 8 && transfer !== 16 && transfer !== 18)) return imageData;

  const toneMapTransform = createIccHagcToneMap(
      toneMap,
      options.displayHeadroom ??
        2 **
          Math.max(
            toneMap.baselineHeadroom,
            ...toneMap.alternateImages.map((entry) => entry.headroom),
          ),
    ),
    mappedData =
      toneMapTransform.targetHeadroom === toneMap.baselineHeadroom
        ? imageData.data
        : new Float32Array(imageData.data.length);
  if (mappedData !== imageData.data)
    for (let i = 0; i < imageData.data.length; i += 4) {
      const rgb = toneMapTransform.apply([
        imageData.data[i]!,
        imageData.data[i + 1]!,
        imageData.data[i + 2]!,
      ]);
      mappedData[i] = rgb[0];
      mappedData[i + 1] = rgb[1];
      mappedData[i + 2] = rgb[2];
      mappedData[i + 3] = imageData.data[i + 3]!;
    }
  return {
    ...imageData,
    data: mappedData,
    headroom: 2 ** toneMapTransform.targetHeadroom,
    sourceHeadroom: 2 ** toneMapTransform.maximumHeadroom,
    source:
      toneMapTransform.targetHeadroom === toneMap.baselineHeadroom ? imageData.source : 'icc-hagc',
  };
}

function metadata(ctx: RenderContext, itemId: number, type: string): Uint8Array[] {
  const meta = findBox(ctx.boxes, 'meta')!,
    iinf = findBox(meta.children!, 'iinf'),
    iref = findBox(meta.children!, 'iref'),
    items = iinf ? parseIinf(iinf.data) : [],
    refs = iref ? parseIref(iref) : [];
  return refs
    .filter((ref) => ref.referenceType === 'cdsc' && ref.toItemIds.includes(itemId))
    .flatMap((ref) =>
      items.find((item) => item.itemId === ref.fromItemId)?.itemType === type
        ? [getItemPayload(ctx.input, ctx.boxes, ref.fromItemId, ctx.options.externalItemData)!]
        : [],
    );
}
function appleHeadroom(payload: Uint8Array): number | null {
  // TIFF offsets are relative to the TIFF header; Apple's MakerNote uses its own origin.
  try {
    const pv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength),
      offset = 4 + pv.getUint32(0),
      tiff = payload.subarray(offset),
      v = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const little = v.getUint16(0) === 0x4949;
    if (v.getUint16(2, little) !== 42) return null;
    const find = (view: DataView, ifd: number, tag: number, le: boolean) => {
      const n = view.getUint16(ifd, le);
      if (n > 1024 || ifd + 2 + n * 12 > view.byteLength) return null;
      for (let i = 0; i < n; i++) {
        const p = ifd + 2 + i * 12;
        if (view.getUint16(p, le) === tag)
          return { type: view.getUint16(p + 2, le), count: view.getUint32(p + 4, le), at: p + 8 };
      }
      return null;
    };
    const exif = find(v, v.getUint32(4, little), 0x8769, little);
    if (!exif) return null;
    const note = find(v, v.getUint32(exif.at, little), 0x927c, little);
    if (!note) return null;
    const start = v.getUint32(note.at, little);
    if (start + note.count > v.byteLength) return null;
    const bytes = tiff.subarray(start, start + note.count);
    if (new TextDecoder().decode(bytes.subarray(0, 10)) !== 'Apple iOS\0') return null;
    const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      le = n.getUint16(12) === 0x4949;
    const real = (tag: number) => {
      const f = find(n, 14, tag, le);
      if (!f) return NaN;
      if (f.type === 11) return n.getFloat32(f.at, le);
      const p = n.getUint32(f.at, le);
      return f.type === 10
        ? n.getInt32(p, le) / n.getInt32(p + 4, le)
        : f.type === 5
          ? n.getUint32(p, le) / n.getUint32(p + 4, le)
          : NaN;
    };
    const a = real(33),
      b = real(48);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const stops =
      a < 1
        ? b <= 0.01
          ? -20 * b + 1.8
          : -0.101 * b + 1.601
        : b <= 0.01
          ? -70 * b + 3
          : -0.303 * b + 2.303;
    const headroom = 2 ** Math.max(stops, 0);
    return Number.isFinite(headroom) ? headroom : null;
  } catch {
    return null;
  }
}
function sample(image: NativeImage, x: number, y: number, w: number, h: number, c: number): number {
  const fx = Math.max(0, Math.min(image.width - 1, ((x + 0.5) * image.width) / w - 0.5)),
    fy = Math.max(0, Math.min(image.height - 1, ((y + 0.5) * image.height) / h - 0.5)),
    x0 = Math.floor(fx),
    y0 = Math.floor(fy),
    x1 = Math.min(x0 + 1, image.width - 1),
    y1 = Math.min(y0 + 1, image.height - 1),
    a = fx - x0,
    b = fy - y0,
    max = 2 ** image.bitDepth - 1;
  const at = (px: number, py: number) => image.data[(py * image.width + px) * 4 + c] / max;
  return (
    (at(x0, y0) * (1 - a) + at(x1, y0) * a) * (1 - b) + (at(x0, y1) * (1 - a) + at(x1, y1) * a) * b
  );
}
function decodeHDRContext(
  ctx: RenderContext,
  options: HdrOptions,
  overrides?: RenderOverrides,
): HdrImage {
  const sourceInfo = getHeicInfo(ctx.input, ctx.boxes, options.itemId),
    info = {
      ...sourceInfo,
      color: overrides?.color ?? sourceInfo.color,
      icc: overrides?.icc ?? sourceInfo.icc,
      iccType: overrides?.iccType ?? sourceInfo.iccType,
      chromaSampleLocation: overrides?.chromaSampleLocation ?? sourceInfo.chromaSampleLocation,
      chromaSampleLocations: overrides?.chromaSampleLocations ?? sourceInfo.chromaSampleLocations,
    };
  if (info.miniGainMap) {
    return isoGainMap(
      ctx,
      {
        ...info,
        primaryItemId: info.miniGainMap.metadataItemId,
        primaryItemType: 'tmap',
        hasAlpha: false,
        alphaItemId: null,
        auxiliaryImages: [],
        derivedItems: [1, info.miniGainMap.imageItemId],
        premultipliedAlpha: false,
        color: overrides?.color ?? info.miniGainMap.toneMappedColor,
        icc: overrides?.icc ?? info.miniGainMap.toneMappedIcc,
        iccType: overrides?.iccType ?? null,
        hvcC: null,
        grid: null,
        // The mini item's orientation/aperture is already applied while its
        // primary coded image is decoded by `decodeNative`.
        transforms: [],
      },
      options,
      overrides,
    );
  }
  if (
    info.tiledImage?.dataReference.externalTileUrls &&
    (info.predReferenceItemIds?.length ?? 0) === 0
  )
    return stitchExternalTiledHdr(ctx, info, options, overrides);
  if (info.primaryItemType === 'tmap') return isoGainMap(ctx, info, options, overrides);
  const native = decodeNative(ctx, options.itemId, false, undefined, overrides),
    image = linearize(native, options),
    gain = info.auxiliaryImages.find(
      (aux) => aux.type === 'urn:com:apple:photo:2020:aux:hdrgainmap',
    );
  if (gain) {
    const hasVersion = metadata(ctx, gain.itemId, 'mime').some((bytes) =>
      new TextDecoder().decode(bytes).includes('HDRGainMapVersion'),
    );
    const headroom = metadata(ctx, info.primaryItemId, 'Exif')
      .map(appleHeadroom)
      .find((value) => value !== null);
    if (!hasVersion || headroom === undefined || headroom === null)
      throw new HeicError('INVALID_CONTAINER', 'heic: Apple gain-map metadata is incomplete');
    const map = decodeNative(ctx, gain.itemId, true),
      limit = Math.min(headroom, options.displayHeadroom ?? Number.POSITIVE_INFINITY);
    for (let y = 0; y < image.height; y++)
      for (let x = 0; x < image.width; x++) {
        // Apple published procedure specifies the inverse Rec.709 transfer.
        const factor =
            1 + (limit - 1) * rec709ToLinear(sample(map, x, y, image.width, image.height, 0)),
          i = (y * image.width + x) * 4;
        image.data[i] *= factor;
        image.data[i + 1] *= factor;
        image.data[i + 2] *= factor;
      }
    image.headroom = limit;
    image.sourceHeadroom = headroom;
    image.source = 'apple-gainmap';
  }
  return image;
}

export function decodeHDRSync(input: Uint8Array, options: HdrOptions = {}): HdrImage {
  try {
    if (!(input instanceof Uint8Array))
      throw new HeicError('INVALID_INPUT', 'heic: expected Uint8Array');
    if (input.length > 64 * 1024 * 1024)
      throw new HeicError('RESOURCE_LIMIT', 'heic: input exceeds 64 MiB');
    if (!isHeic(input)) throw new HeicError('UNSUPPORTED_FORMAT', 'heic: not a HEIC file');
    validateExternalItemData(options.externalItemData);
    if (
      options.applyHevcColourRemapping !== undefined &&
      typeof options.applyHevcColourRemapping !== 'boolean'
    )
      throw new HeicError('INVALID_OPTIONS', 'heic: invalid applyHevcColourRemapping');
    if (
      options.applyHevcChromaResamplingFilterHint !== undefined &&
      typeof options.applyHevcChromaResamplingFilterHint !== 'boolean'
    )
      throw new HeicError('INVALID_OPTIONS', 'heic: invalid applyHevcChromaResamplingFilterHint');
    if (
      options.applyHevcPostFilterHint !== undefined &&
      typeof options.applyHevcPostFilterHint !== 'boolean'
    )
      throw new HeicError('INVALID_OPTIONS', 'heic: invalid applyHevcPostFilterHint');
    if (
      options.applyHevcPhaseIndication !== undefined &&
      typeof options.applyHevcPhaseIndication !== 'boolean'
    )
      throw new HeicError('INVALID_OPTIONS', 'heic: invalid applyHevcPhaseIndication');
    for (const [name, value, min] of [
      ['displayHeadroom', options.displayHeadroom ?? Number.POSITIVE_INFINITY, 1],
      ['referenceWhiteNits', options.referenceWhiteNits ?? 203, 1],
      ['displayPeakNits', options.displayPeakNits ?? 1000, 1],
    ] as const)
      if (
        (!Number.isFinite(value) &&
          !(name === 'displayHeadroom' && value === Number.POSITIVE_INFINITY)) ||
        value < min
      )
        throw new HeicError('INVALID_OPTIONS', 'heic: invalid ' + name);
    const maxPixels = options.maxPixels ?? 50_000_000;
    if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 50_000_000)
      throw new HeicError('INVALID_OPTIONS', 'heic: invalid maxPixels');
    if (
      options.applyHevcToneMapping === true ||
      options.hevcToneMapId !== undefined ||
      options.applyHevcKneeFunction === true ||
      options.hevcKneeFunctionId !== undefined ||
      options.applyHevcColourRemapping === true ||
      options.hevcColourRemapId !== undefined
    )
      throw new HeicError(
        'INVALID_OPTIONS',
        'heic: HEVC tone, knee, and colour remapping options apply only to RGBA8 decode',
      );
    return decodeHDRContext(createRenderContext(input, options), options);
  } catch (error) {
    throw asHeicError(error);
  }
}

function sameBytes(a: Uint8Array | null | undefined, b: Uint8Array | null | undefined): boolean {
  return (
    (a?.length ?? 0) === (b?.length ?? 0) &&
    (a === null || a === undefined || a.every((value, index) => value === b?.[index]))
  );
}

function stitchExternalTiledHdr(
  ctx: RenderContext,
  info: ReturnType<typeof getHeicInfo>,
  options: HdrOptions,
  overrides?: RenderOverrides,
): HdrImage {
  const tiledImage = info.tiledImage!;
  const indexes = getTiledImageTileIndices(tiledImage, ctx.options.extraDimensionIndexes);
  const tileCount = tiledImage.columns * tiledImage.rows;
  if (!Number.isSafeInteger(tileCount) || tileCount <= 0 || tileCount > 65_536)
    throw new HeicError('RESOURCE_LIMIT', 'heic: external tili tile count exceeds 65536');
  if (indexes.length !== tileCount)
    throw new HeicError('INVALID_CONTAINER', 'heic: external tili plane has an invalid tile count');
  const canvasWidth = tiledImage.columns * tiledImage.tileWidth,
    canvasHeight = tiledImage.rows * tiledImage.tileHeight;
  if (
    !Number.isSafeInteger(canvasWidth * canvasHeight) ||
    canvasWidth < info.width ||
    canvasHeight < info.height
  )
    throw new HeicError('INVALID_CONTAINER', 'heic: external tili extent exceeds its tile grid');
  checkSize(ctx, canvasWidth, canvasHeight);

  const inherited: RenderOverrides = {
    color: overrides?.color ?? info.color ?? undefined,
    icc: overrides?.icc ?? info.icc ?? undefined,
    iccType: overrides?.iccType ?? info.iccType ?? undefined,
    chromaSampleLocation: overrides?.chromaSampleLocation ?? info.chromaSampleLocation ?? undefined,
    chromaSampleLocations: overrides?.chromaSampleLocations ?? info.chromaSampleLocations,
  };
  let first: HdrImage | null = null;
  let firstColor: ReturnType<typeof getHeicInfo>['color'] | null = null;
  let firstIcc: Uint8Array | null = null;
  let firstIccType: ReturnType<typeof getHeicInfo>['iccType'] = null;
  let hasAlpha = false;
  const data = new Float32Array(canvasWidth * canvasHeight * 4);
  for (let spatialIndex = 0; spatialIndex < tileCount; spatialIndex++) {
    const index = indexes[spatialIndex],
      url = buildTiledTileUrl(tiledImage.dataReference, index),
      tileContext = externalTileContext(ctx, url, index),
      tileInfo = getHeicInfo(tileContext.input, tileContext.boxes),
      tile = decodeHDRContext(tileContext, options, inherited),
      color = inherited.color ?? tileInfo.color,
      icc = inherited.icc ?? tileInfo.icc,
      iccType = inherited.iccType ?? tileInfo.iccType;
    if (tile.width !== tiledImage.tileWidth || tile.height !== tiledImage.tileHeight)
      throw new HeicError(
        'INVALID_BITSTREAM',
        `heic: external tili tile ${index} is ${tile.width}x${tile.height}, expected ${tiledImage.tileWidth}x${tiledImage.tileHeight} after derivation`,
      );
    if (first) {
      if (
        tile.bitDepth !== first.bitDepth ||
        tile.bitDepthChroma !== first.bitDepthChroma ||
        tile.colorSpace !== first.colorSpace ||
        tile.source !== first.source ||
        tile.headroom !== first.headroom ||
        tile.sourceHeadroom !== first.sourceHeadroom ||
        JSON.stringify(color ?? null) !== JSON.stringify(firstColor) ||
        iccType !== firstIccType ||
        !sameBytes(icc, firstIcc)
      )
        throw new HeicError(
          'INVALID_CONTAINER',
          'heic: external tili tiles do not share one format',
        );
    } else {
      first = tile;
      firstColor = color ?? null;
      firstIcc = icc ?? null;
      firstIccType = iccType ?? null;
    }

    const x = (spatialIndex % tiledImage.columns) * tiledImage.tileWidth,
      y = Math.floor(spatialIndex / tiledImage.columns) * tiledImage.tileHeight;
    for (let row = 0; row < tiledImage.tileHeight; row++) {
      const source = row * tiledImage.tileWidth * 4,
        destination = ((y + row) * canvasWidth + x) * 4;
      data.set(tile.data.subarray(source, source + tiledImage.tileWidth * 4), destination);
    }
    hasAlpha ||= tile.hasAlpha;
  }
  if (!first) throw new HeicError('INVALID_CONTAINER', 'heic: external tili has no selected tiles');

  let image: HdrImage = {
    ...first,
    width: info.width,
    height: info.height,
    data: new Float32Array(info.width * info.height * 4),
    hasAlpha,
  };
  for (let row = 0; row < info.height; row++)
    image.data.set(
      data.subarray(row * canvasWidth * 4, (row * canvasWidth + info.width) * 4),
      row * info.width * 4,
    );

  if (info.alphaItemId !== null) {
    const alpha = decodeNative(ctx, info.alphaItemId, true, false),
      maxAlpha = 2 ** alpha.bitDepth - 1,
      alphaSei = getHevcAuxiliarySeiForItem(info, info.alphaItemId, alpha.info),
      alphaChannelInfo = activeHevcAlphaChannelInfo(alphaSei);
    if (
      alphaChannelInfo?.bitDepth !== undefined &&
      (alphaChannelInfo.bitDepth !== alpha.bitDepth || alphaChannelInfo.bitDepth !== image.bitDepth)
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
            4,
          o = (y * image.width + x) * 4,
          codedSample = alpha.data[ai],
          signalledFactor = hevcAlphaSampleToFactor(codedSample, alphaChannelInfo),
          a = signalledFactor ?? codedSample / maxAlpha;
        image.data[o + 3] *= a;
        if (
          info.premultipliedAlpha ||
          (signalledFactor !== undefined && alphaChannelInfo?.useIdc === 1)
        )
          for (let c = 0; c < 3; c++) image.data[o + c] = a ? image.data[o + c] / a : 0;
      }
    image.hasAlpha = true;
  }

  if (options.applyTransforms !== false)
    image = {
      ...image,
      ...transformRaster(image.data, image.width, image.height, info.transforms, ctx),
    };
  return image;
}

interface IsoGainMetadata {
  base: number;
  alternate: number;
  multichannel: boolean;
  useBase: boolean;
  min: number[];
  max: number[];
  gamma: number[];
  baseOffset: number[];
  alternateOffset: number[];
}
export function parseIsoGainMap(data: Uint8Array): IsoGainMetadata | null {
  if (data.length > 4096)
    throw new HeicError('RESOURCE_LIMIT', 'heic: ISO gain-map metadata exceeds 4096 bytes');
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let p = 0;
  const need = (n: number) => {
    if (p + n > data.length)
      throw new HeicError('INVALID_CONTAINER', 'heic: truncated ISO gain-map metadata');
  };
  const u8 = () => {
      need(1);
      return v.getUint8(p++);
    },
    u16 = () => {
      need(2);
      const n = v.getUint16(p);
      p += 2;
      return n;
    };
  const toneMapVersion = u8();
  if (toneMapVersion !== 0) return null;
  const minimumVersion = u16();
  if (minimumVersion !== 0) return null;
  const writerVersion = u16();
  if (writerVersion < minimumVersion)
    throw new HeicError(
      'INVALID_CONTAINER',
      'heic: gain-map writer version is below minimum version',
    );
  const flags = u8();
  if (flags & 63)
    throw new HeicError('UNSUPPORTED_FEATURE', 'heic: unsupported ISO gain-map flags');
  const ratio = (signed = false) => {
    need(8);
    const n = signed ? v.getInt32(p) : v.getUint32(p),
      d = v.getUint32(p + 4);
    p += 8;
    if (d === 0) throw new HeicError('INVALID_CONTAINER', 'heic: zero gain-map denominator');
    return n / d;
  };
  const base = ratio(),
    alternate = ratio(),
    multichannel = !!(flags & 128),
    useBase = !!(flags & 64),
    min: number[] = [],
    max: number[] = [],
    gamma: number[] = [],
    baseOffset: number[] = [],
    alternateOffset: number[] = [];
  if (base === alternate || base >= 127 || alternate >= 127)
    throw new HeicError('INVALID_CONTAINER', 'heic: invalid gain-map headroom');
  for (let c = 0; c < (multichannel ? 3 : 1); c++) {
    min.push(ratio(true));
    max.push(ratio(true));
    gamma.push(ratio());
    baseOffset.push(ratio(true));
    alternateOffset.push(ratio(true));
    if (max[c] < min[c] || gamma[c] <= 0)
      throw new HeicError('INVALID_CONTAINER', 'heic: invalid ISO gain-map channel parameters');
  }
  // ISO 21496-1 Annex C.2.1 permits trailing padding and future optional
  // metadata. minimum_version has already established that the known v0
  // fields are sufficient for this reader, so leave the extension tail alone.
  if (!multichannel)
    for (let c = 1; c < 3; c++)
      for (const array of [min, max, gamma, baseOffset, alternateOffset]) array[c] = array[0];
  return { base, alternate, multichannel, useBase, min, max, gamma, baseOffset, alternateOffset };
}
function inverse(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m,
    A = e * i - f * h,
    B = f * g - d * i,
    C = d * h - e * g,
    det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-10)
    throw new HeicError('INVALID_CONTAINER', 'heic: singular color matrix');
  return [
    A,
    c * h - b * i,
    b * f - c * e,
    B,
    a * i - c * g,
    c * d - a * f,
    C,
    b * g - a * h,
    a * e - b * d,
  ].map((v) => v / det);
}
function gainMapApplicationMatrix(
  profile: ReturnType<typeof iccProfile> | null,
  color: ReturnType<typeof getHeicInfo>['color'],
): number[] {
  if (profile?.channelModel === 'GRAY')
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: ISO gain map application space requires RGB color primaries',
    );
  if (profile?.transformToLinearSrgb) {
    const primaries = profile.primaries ?? color?.primaries;
    if (primaries === null || primaries === undefined || primaries === 2)
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        'heic: ISO gain map LUT ICC profile does not signal usable RGB color primaries',
      );
    // The LUT already converts the encoded image into linear sRGB. The CICP
    // primaries select the gain-map application space, so use the RGB-primary
    // matrix for the sRGB <-> application-space conversion.
    return primaryMatrix(primaries);
  }
  return profile && !profile.transfer
    ? profile.matrix
    : primaryMatrix(profile?.primaries ?? color?.primaries ?? 1);
}
function isoGainMap(
  ctx: RenderContext,
  info: ReturnType<typeof getHeicInfo>,
  options: HdrOptions,
  overrides?: RenderOverrides,
): HdrImage {
  const payload = getItemPayload(
    ctx.input,
    ctx.boxes,
    info.primaryItemId,
    ctx.options.externalItemData,
  );
  if (!payload || info.derivedItems.length !== 2)
    throw new HeicError(
      'INVALID_CONTAINER',
      'heic: ISO tone map must reference base and gain-map images',
    );
  const base = decodeNative(ctx, info.derivedItems[0], false, undefined, overrides),
    image = linearize(base, options),
    meta = parseIsoGainMap(payload);
  // ISO/IEC 23008-12 Amd 1 requires readers to ignore an unknown
  // ToneMapImage version; ISO 21496-1 similarly requires ignoring metadata
  // whose minimum_version is not supported. In both cases the base image is
  // the required fallback.
  if (!meta) return applyHdrTransforms(image, info, ctx, options);
  const map = decodeNative(ctx, info.derivedItems[1]);
  // Gain maps are applied in the selected image's linear color space, before
  // the final conversion to linear sRGB. Single-channel maps share the gain.
  let matrix: number[];
  if (meta.useBase) {
    const profile = base.info.icc
      ? iccProfile(base.info.icc, base.info.iccType, options.iccRenderingIntent)
      : null;
    matrix = gainMapApplicationMatrix(profile, base.info.color);
  } else {
    if (!info.color && !info.icc)
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        'heic: ISO alternate working color space is unspecified',
      );
    const profile = info.icc
      ? iccProfile(info.icc, info.iccType, options.iccRenderingIntent)
      : null;
    matrix = gainMapApplicationMatrix(profile, info.color);
  }
  const inv = inverse(matrix),
    target = Math.min(
      Math.max(
        Math.log2(options.displayHeadroom ?? Number.POSITIVE_INFINITY),
        Math.min(meta.base, meta.alternate),
      ),
      Math.max(meta.base, meta.alternate),
    ),
    progress = (target - meta.base) / (meta.alternate - meta.base),
    weight = meta.alternate > meta.base ? progress : -progress;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4,
        working = apply(inv, [image.data[i], image.data[i + 1], image.data[i + 2]]);
      if (weight !== 0)
        for (let c = 0; c < 3; c++) {
          const encoded = sample(map, x, y, image.width, image.height, meta.multichannel ? c : 0),
            gain = meta.min[c] + (meta.max[c] - meta.min[c]) * encoded ** (1 / meta.gamma[c]);
          working[c] =
            (working[c] + meta.baseOffset[c]) * 2 ** (gain * weight) - meta.alternateOffset[c];
        }
      const rgb = apply(matrix, working);
      if (rgb.some((v) => !Number.isFinite(v)))
        throw new HeicError('INVALID_CONTAINER', 'heic: non-finite gain-map output');
      image.data[i] = rgb[0];
      image.data[i + 1] = rgb[1];
      image.data[i + 2] = rgb[2];
    }
  image.source = 'iso-gainmap';
  image.headroom = 2 ** target;
  image.sourceHeadroom = 2 ** Math.max(meta.base, meta.alternate);
  return applyHdrTransforms(image, info, ctx, options);
}

function applyHdrTransforms(
  image: HdrImage,
  info: ReturnType<typeof getHeicInfo>,
  ctx: RenderContext,
  options: HdrOptions,
): HdrImage {
  if (options.applyTransforms === false) return image;
  return {
    ...image,
    ...transformRaster(image.data, image.width, image.height, info.transforms, ctx),
  };
}
