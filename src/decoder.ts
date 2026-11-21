import { decodeItemPlanes, cropPlanes, getActiveSpsFromPayload, stitchGrid } from './planes.js';
import type { ExternalBaseLayerPlanes, Planes } from './planes.js';
import { decodeRendered } from './render.js';
import { prepareAvcDecodeOptionsSync } from './avc.js';
import { HeicError, asHeicError } from './errors.js';
/**
 * Public HEIC decoding API: container walk, HEVC intra decode of every tile,
 * grid stitching, conformance-window crop, YCbCr to RGBA conversion, and the
 * irot/imir display transforms.
 */
import type { HeicInfo, StereoPairInfo } from './container/heic.js';
import type { SpsInfo } from './hevc/sps.js';
import { applyOrientation, yuv420ToRgba } from './color.js';
import { getYCbCrMatrixCoefficients } from './color-matrix.js';
import { getColorTransferFunction } from './color-transfer.js';
import { getHeicInfo, getItemPayload, validateExternalItemData } from './container/heic.js';
import {
  decodeUncompressedImage,
  type HeicUncompressedComponents,
} from './container/uncompressed.js';
import { decompressGenericItemPayloadSync } from './container/generic-compression.js';
import { getFtypInfo, parseISOBMFF, findBox, parseIinf } from './container/heif.js';
import { isSliceNal, splitLengthPrefixed } from './hevc/nal.js';
import { parseLayeredSpsHeader, parseSps, resolveSpsScalingListData } from './hevc/sps.js';
import { parseLayeredVps, readVpsId, type LayeredVpsInfo } from './hevc/vps.js';
import { readPpsParameterSetIds, readSlicePpsId } from './hevc/parameter-sets.js';
import { parseTiledItemRanges } from './container/tili.js';
import { selectHevcKneeFunctionInfo } from './hevc/knee-function.js';
import { selectHevcColourRemappingInfo } from './hevc/colour-remapping.js';
import type { HeifHevcBitDepth, HeifImageBitDepth } from './bit-depth.js';
import type {
  HevcAuxiliarySeiMetadata,
  HevcChromaResamplingFilterHint,
  HevcColourRemappingInfo,
  HevcDisplayOrientation,
  HevcFilmGrainCharacteristics,
  HevcHdrSeiMetadata,
  HevcKneeFunctionInfo,
  HevcPhaseIndication,
  HevcPictureTimingInfo,
  HevcPostFilterHint,
  HevcToneMappingInfo,
} from './hevc/sei.js';
import { getHevcAuxiliarySeiForItem, getHevcSeiMetadata } from './hevc/heif-sei.js';
import type { IccRenderingIntent } from './icc.js';

export interface HeicMetadata extends HeicInfo {
  /** Parsed from the selected item's active SPS; cross-checks the container. */
  sps: SpsInfo | null;
  /** Coded slice NAL count of the primary or first non-empty tili tile. */
  sliceNalCount: number;
  /** Picture structure signalled for the selected HEVC access unit. */
  hevcPictureTiming?: HevcPictureTimingInfo;
  /** Supported colour and HDR metadata from the selected HEVC layer's prefix/suffix SEI. */
  hevcHdrSei?: HevcHdrSeiMetadata;
  /** Display-orientation SEI messages in NAL order. */
  hevcDisplayOrientation?: HevcDisplayOrientation[];
  /** Coded phase-indication ratios in NAL order; applying display alignment is opt-in. */
  hevcPhaseIndication?: HevcPhaseIndication[];
  /** Coded film-grain SEI messages in NAL order; grain synthesis is not applied. */
  hevcFilmGrainCharacteristics?: HevcFilmGrainCharacteristics[];
  /** Coded H.265 tone-mapping messages in NAL order. */
  hevcToneMappingInfo?: HevcToneMappingInfo[];
  /** Coded H.265 knee-function curves in NAL order; RGBA8 decoding can apply a selected curve. */
  hevcKneeFunctionInfo?: HevcKneeFunctionInfo[];
  /** Coded H.265 colour-remapping models in NAL order. */
  hevcColourRemappingInfo?: HevcColourRemappingInfo[];
  /** Coded H.265 chroma-resampling hints; filtering is opt-in. */
  hevcChromaResamplingFilterHint?: HevcChromaResamplingFilterHint[];
  /** Coded H.265 post-filter/correlation hints; FIR application is opt-in. */
  hevcPostFilterHint?: HevcPostFilterHint[];
}

function sameNalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function uniqueParameterSet<T extends { layerId: number; data: Uint8Array }>(
  candidates: T[],
  label: string,
): T | null {
  const first = candidates[0];
  if (!first) return null;
  if (candidates.some((candidate) => !sameNalBytes(candidate.data, first.data)))
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      `heic: multiple active ${label} parameter sets cannot be distinguished`,
    );
  return first;
}

function activeLayerSps(
  nal: Uint8Array,
  layerId: number,
  configuration: NonNullable<HeicInfo['lhevc']>['configuration'],
  selectedVps: LayeredVpsInfo | null,
): { sps: SpsInfo; vps: LayeredVpsInfo | null } {
  const header = parseLayeredSpsHeader(nal);
  if (!header)
    return { sps: parseSps(nal, { allowBaseLayerMultilayerExtension: layerId === 0 }), vps: null };

  let vps = selectedVps?.vpsId === header.videoParameterSetId ? selectedVps : null;
  if (!vps) {
    const vpsNals = configuration.arrays
      .filter((array) => array.nalUnitType === 32)
      .flatMap((array) => array.nalUnits)
      .filter((candidate) => readVpsId(candidate.data) === header.videoParameterSetId);
    const selectedVpsNal = uniqueParameterSet(vpsNals, 'VPS');
    if (!selectedVpsNal)
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        `heic: active VPS ${header.videoParameterSetId} for layered SPS is unavailable`,
      );
    vps = parseLayeredVps(selectedVpsNal.data);
  }
  return { sps: parseSps(nal, { layeredVps: vps }), vps };
}

function readConfiguredSpsId(nal: Uint8Array, layerId: number): number {
  const header = parseLayeredSpsHeader(nal);
  return header?.spsId ?? parseSps(nal, { allowBaseLayerMultilayerExtension: layerId === 0 }).spsId;
}

function activeSpsForLayer(
  layerId: number,
  slice: Uint8Array,
  parameterSets: { nalUnitType: number; layerId: number; data: Uint8Array }[],
  selectedVps: LayeredVpsInfo | null,
  configuration: NonNullable<HeicInfo['lhevc']>['configuration'],
): { sps: SpsInfo; vps: LayeredVpsInfo | null } | null {
  const ppsId = readSlicePpsId(slice);
  const ppsNals = parameterSets.filter((candidate) => {
    if (candidate.nalUnitType !== 34 || candidate.layerId !== layerId) return false;
    return readPpsParameterSetIds(candidate.data).ppsId === ppsId;
  });
  const ppsNal = uniqueParameterSet(ppsNals, 'PPS');
  if (!ppsNal) return null;

  const { spsId } = readPpsParameterSetIds(ppsNal.data);
  const spsNals = parameterSets.filter((candidate) => {
    if (candidate.nalUnitType !== 33 || candidate.layerId !== layerId) return false;
    return readConfiguredSpsId(candidate.data, layerId) === spsId;
  });
  const spsNal = uniqueParameterSet(spsNals, 'SPS');
  if (!spsNal) return null;
  return activeLayerSps(spsNal.data, layerId, configuration, selectedVps);
}

/** Whether a buffer looks like a HEIC/HEIF file. */
export function isHeic(buffer: Uint8Array): boolean {
  const ftyp = getFtypInfo(buffer);
  if (!ftyp) return false;

  const hasMif3Brand = ftyp.majorBrand === 'mif3' || ftyp.compatibleBrands.includes('mif3');
  if (hasMif3Brand) {
    const minorBrand = String.fromCharCode(
      (ftyp.minorVersion >>> 24) & 0xff,
      (ftyp.minorVersion >>> 16) & 0xff,
      (ftyp.minorVersion >>> 8) & 0xff,
      ftyp.minorVersion & 0xff,
    );
    try {
      const boxes = parseISOBMFF(buffer);
      if (!findBox(boxes, 'mini')) return false;
      // A codec brand in the minor_version identifies the mini codec even
      // when the codec configuration needs later validation by the decoder.
      if (
        ftyp.majorBrand === 'mif3' &&
        (minorBrand === 'heic' || minorBrand === 'heix' || minorBrand === 'avic')
      )
        return true;
      return ['hvc1', 'avc1', 'unci'].includes(getHeicInfo(buffer, boxes).primaryItemType);
    } catch {
      return false;
    }
  }

  const brands = [ftyp.majorBrand, ...ftyp.compatibleBrands];
  if (
    brands.some((brand) =>
      ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'avci'].includes(brand),
    )
  )
    return true;
  // Generic HEIF brands do not identify the codec. Inspect item declarations,
  // rather than interpreting AVIF/VVC containers as HEVC from their extension.
  if (!brands.some((brand) => ['mif1', 'mif2'].includes(brand))) return false;
  try {
    const boxes = parseISOBMFF(buffer);
    const meta = findBox(boxes, 'meta');
    const iinf = meta?.children && findBox(meta.children, 'iinf');
    if (
      iinf &&
      parseIinf(iinf.data).some((item) => ['hvc1', 'lhv1', 'avc1', 'unci'].includes(item.itemType))
    )
      return true;
    const info = getHeicInfo(buffer, boxes);
    return (
      info.primaryItemType === 'tili' &&
      (info.tiledImage?.tileItemType === 'hvc1' ||
        info.tiledImage?.tileItemType === 'lhv1' ||
        info.tiledImage?.tileItemType === 'avc1' ||
        info.tiledImage?.tileItemType === 'unci' ||
        info.tiledImage?.dataReference.externalTileUrls === true)
    );
  } catch {
    return false;
  }
}

/**
 * Parse metadata for the primary item, or for `itemId` when supplied, without
 * entropy-decoding pixels. Resolve the first coded slice's active SPS where possible.
 */
export function getHeicMetadata(
  buffer: Uint8Array,
  itemId?: number,
  options: Pick<DecodeOptions, 'externalItemData'> = {},
): HeicMetadata {
  if (!isHeic(buffer)) throw new Error('heic: not a HEIC file (ftyp brand mismatch)');

  const boxes = parseISOBMFF(buffer);
  const info = getHeicInfo(buffer, boxes, itemId);

  let sps: SpsInfo | null = null;
  let sliceNalCount = 0;
  const hevcSei = getHevcSeiMetadata(buffer, boxes, info, options.externalItemData),
    {
      displayOrientation: hevcDisplayOrientation,
      phaseIndication: hevcPhaseIndication,
      filmGrainCharacteristics: hevcFilmGrainCharacteristics,
      toneMappingInfo: hevcToneMappingInfo,
      kneeFunctionInfo: hevcKneeFunctionInfo,
      colourRemappingInfo: hevcColourRemappingInfo,
      chromaResamplingFilterHint: hevcChromaResamplingFilterHint,
      postFilterHint: hevcPostFilterHint,
      pictureTiming: hevcPictureTiming,
      ...hdrSei
    } = hevcSei ?? {},
    hevcHdrSei = Object.keys(hdrSei).length ? hdrSei : undefined;

  if (info.lhevc) {
    let payload = getItemPayload(buffer, boxes, info.primaryItemId, options.externalItemData);
    if (payload && info.tiledImage) {
      const ranges = parseTiledItemRanges(
        payload,
        info.tiledImage.dataReference,
        info.tiledImage.dataReference.inputItemCount,
      );
      const firstTile = ranges.find((range) => range !== null);
      payload = firstTile
        ? payload.subarray(firstTile.offset, firstTile.offset + firstTile.length)
        : null;
    }
    const targetLayerId = info.lhevc.targetLayerId;
    const parameterSets = info.lhevc.configuration.arrays.flatMap((array) =>
      array.nalUnits.map((nal) => ({ ...nal, nalUnitType: array.nalUnitType })),
    );
    const layerNals = payload
      ? splitLengthPrefixed(
          payload,
          info.lhevc.configuration.nalLengthSize,
          false,
          info.lhevc.requiredLayerIds,
        )
      : [];
    const activeSpsByLayer = new Map<number, SpsInfo>();
    const activeVpsByLayer = new Map<number, LayeredVpsInfo>();
    for (const layerId of info.lhevc.requiredLayerIds) {
      const slice = layerNals.find((nal) => nal.layerId === layerId && isSliceNal(nal.type));
      if (!slice) continue;
      const active = activeSpsForLayer(
        layerId,
        slice.data,
        parameterSets,
        info.lhevc.selectedVps,
        info.lhevc.configuration,
      );
      if (active) {
        activeSpsByLayer.set(layerId, active.sps);
        if (active.vps) activeVpsByLayer.set(layerId, active.vps);
      }
    }

    sps = activeSpsByLayer.get(targetLayerId) ?? null;
    if (sps?.scalingListInferred) {
      try {
        sps = resolveSpsScalingListData(
          sps,
          activeSpsByLayer,
          activeVpsByLayer.get(targetLayerId) ?? info.lhevc.selectedVps ?? undefined,
        );
      } catch (error) {
        if (!(error instanceof HeicError) || error.code !== 'UNSUPPORTED_FEATURE') throw error;
      }
    }

    // Keep configuration-only metadata available when an item has no slice
    // payload from which to identify the active PPS/SPS pair.
    if (!sps) {
      const targetSps = parameterSets.find(
        (nal) => nal.nalUnitType === 33 && nal.layerId === targetLayerId,
      );
      if (targetSps) {
        const active = activeLayerSps(
          targetSps.data,
          targetLayerId,
          info.lhevc.configuration,
          info.lhevc.selectedVps,
        );
        sps = active.sps;
      }
    }
    if (payload) {
      sliceNalCount = layerNals.filter(
        (nal) => nal.layerId === targetLayerId && isSliceNal(nal.type),
      ).length;
    }
  } else if (info.hvcC) {
    const codedItemId = info.grid ? info.grid.tileItemIds[0] : info.primaryItemId;
    const codedItemInfo = info.grid ? getHeicInfo(buffer, boxes, codedItemId) : info;
    const baseLayerOnly =
      codedItemInfo.primaryItemType === 'hvc1' ||
      codedItemInfo.tiledImage?.tileItemType === 'hvc1' ||
      info.tiledImage?.tileItemType === 'hvc1';
    let payload = getItemPayload(buffer, boxes, codedItemId, options.externalItemData);
    const codedTiledImage = codedItemInfo.tiledImage ?? info.tiledImage;
    if (payload && codedTiledImage && info.hvcC) {
      const tileRanges = parseTiledItemRanges(
        payload,
        codedTiledImage.dataReference,
        codedTiledImage.dataReference.inputItemCount,
      );
      const firstTile = tileRanges.find((range) => range !== null);
      payload = firstTile
        ? payload.subarray(firstTile.offset, firstTile.offset + firstTile.length)
        : null;
    }
    if (payload) {
      const nals = splitLengthPrefixed(payload, info.hvcC.nalLengthSize, baseLayerOnly);
      sliceNalCount = nals.filter((n) => isSliceNal(n.type)).length;
      if (sliceNalCount > 0)
        sps = getActiveSpsFromPayload(payload, info.hvcC, `item ${codedItemId}`, baseLayerOnly);
    }
    if (!sps && info.hvcC.sps.length > 0)
      sps = parseSps(info.hvcC.sps[0], { allowBaseLayerMultilayerExtension: baseLayerOnly });
  }

  return {
    ...info,
    sps,
    sliceNalCount,
    ...(hevcPictureTiming ? { hevcPictureTiming } : {}),
    ...(hevcHdrSei ? { hevcHdrSei } : {}),
    ...(hevcDisplayOrientation ? { hevcDisplayOrientation } : {}),
    ...(hevcPhaseIndication ? { hevcPhaseIndication } : {}),
    ...(hevcFilmGrainCharacteristics ? { hevcFilmGrainCharacteristics } : {}),
    ...(hevcToneMappingInfo ? { hevcToneMappingInfo } : {}),
    ...(hevcKneeFunctionInfo ? { hevcKneeFunctionInfo } : {}),
    ...(hevcColourRemappingInfo ? { hevcColourRemappingInfo } : {}),
    ...(hevcChromaResamplingFilterHint ? { hevcChromaResamplingFilterHint } : {}),
    ...(hevcPostFilterHint ? { hevcPostFilterHint } : {}),
  };
}

export interface HeicImageData {
  data: Uint8Array;
  width: number;
  height: number;
  hasAlpha: boolean;
  bitDepth: HeifImageBitDepth;
  /** Present only when the HEVC chroma depth differs from the luma depth. */
  bitDepthChroma?: HeifImageBitDepth;
}

export interface HeicStereoPair extends StereoPairInfo {
  left: HeicImageData;
  right: HeicImageData;
}

/**
 * Decoded component samples for one HEIF auxiliary image. The planes have the
 * HEVC conformance window applied; HEIF clean-aperture, scale, rotation, and
 * mirror transforms are reported but not applied.
 */
export interface HeicAuxiliaryPlanes {
  itemId: number;
  type: string;
  width: number;
  height: number;
  chromaFormatIdc: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
  y: Uint8Array | Uint16Array;
  cb: Uint8Array | Uint16Array;
  cr: Uint8Array | Uint16Array;
  color: HeicInfo['color'];
  pixelAspectRatio: HeicInfo['pixelAspectRatio'];
  transforms: HeicInfo['transforms'];
  /** Depth/alpha SEI values carried by HEVC auxC subtype metadata, when present. */
  hevcAuxiliarySei?: HevcAuxiliarySeiMetadata;
}

export interface DecodeOptions {
  /** Decode this HEIF image item instead of the primary item. */
  itemId?: number;

  /** Maximum output or padded-grid pixel count. Default/hard ceiling: 50 million. */
  maxPixels?: number;

  /** ICC input-profile rendering intent; defaults to `relative`. */
  iccRenderingIntent?: IccRenderingIntent;

  /**
   * Apply HEIF container display transforms (default true). When false the
   * pixels stay before container clean-aperture, scaling, rotation and mirror
   * transforms. `applyHevcDisplayOrientation` is controlled independently.
   * HEVC conformance-window cropping still applies.
   */
  applyTransforms?: boolean;

  /**
   * Apply the active HEVC display-orientation SEI transform (default true).
   * When enabled, it is applied before HEIF item transforms. This is
   * independent of `applyTransforms`.
   */
  applyHevcDisplayOrientation?: boolean;

  /**
   * Apply the SPS VUI default display window when the image has no container
   * clean aperture. Defaults to false because the VUI window is a display hint.
   */
  applyDefaultDisplayWindow?: boolean;

  /** Apply an active H.265 `tone_mapping_info` SEI message to RGBA8 output. Defaults to false. */
  applyHevcToneMapping?: boolean;

  /** Select a `tone_map_id` when several mappings are active; requires applyHevcToneMapping. */
  hevcToneMapId?: number;

  /** Apply an active H.265 `knee_function_info` curve to normalized linear RGB. Defaults to false. */
  applyHevcKneeFunction?: boolean;

  /** Select a `knee_function_id` when several curves are active; requires applyHevcKneeFunction. */
  hevcKneeFunctionId?: number;

  /** Apply an active H.265 `colour_remapping_info` to decoded color samples. Defaults to false. */
  applyHevcColourRemapping?: boolean;

  /** Select a `colour_remap_id` when several mappings are active; requires applyHevcColourRemapping. */
  hevcColourRemapId?: number;

  /** Apply an H.265 `chroma_resampling_filter_hint` before RGB conversion. Defaults to false. */
  applyHevcChromaResamplingFilterHint?: boolean;

  /** Apply the last H.265 2D or separable 1D FIR `post_filter_hint`; correlation hints are metadata-only. */
  applyHevcPostFilterHint?: boolean;

  /**
   * Align RGBA samples using the last H.274 `phase_indication` message in bitstream order.
   * Uses bilinear interpolation with edge replication and keeps raster dimensions.
   * Defaults to false; this rendering filter is an implementation policy.
   */
  applyHevcPhaseIndication?: boolean;

  /**
   * Bytes for external `tili` tiles, keyed by the exact URL from the `deti`
   * box. This map keeps synchronous and worker decoding free of implicit
   * network access.
   */
  externalTileData?: Readonly<Record<string, Uint8Array>>;

  /**
   * External item resources, keyed by HEIF item ID. Values are complete
   * referenced resources; `iloc` extents select the coded bytes. No network
   * requests are made automatically.
   */
  externalItemData?: Readonly<Record<number, Uint8Array>>;

  /** @internal Decompressed generic-compressed item bytes prepared by async decode. */
  decodedItemData?: Readonly<Record<number, Uint8Array>>;

  /**
   * Caller-decoded sample planes for `avc1` image items, keyed by HEIF item
   * ID. This supports both a selected `avc1` image and an `avc1` item referenced
   * by `exbl` from an L-HEVC image.
   */
  externalBaseLayerPlanes?: Readonly<Record<number, ExternalBaseLayerPlanes>>;

  /** @internal Prepared AVC planes for external `tili` tile files, keyed by exact URL. */
  externalTileBaseLayerPlanes?: Readonly<
    Record<string, Readonly<Record<number, ExternalBaseLayerPlanes>>>
  >;

  /** @internal Prepared AVC planes for in-file `tili` tiles, keyed by item ID then tile index. */
  avcTiliTilePlanes?: Readonly<Record<number, Readonly<Record<number, ExternalBaseLayerPlanes>>>>;

  /** Select one coordinate in each additional `tili` dimension (defaults to zero). */
  extraDimensionIndexes?: readonly number[];
}

export interface DecodeUncompressedComponentsOptions {
  /** Maximum component-plane pixel count. Defaults to and cannot exceed 50 million. */
  maxPixels?: number;
  /** External item resources keyed by HEIF item ID. No network requests are made automatically. */
  externalItemData?: Readonly<Record<number, Uint8Array>>;
}

export interface HeicUncompressedImageComponents extends HeicUncompressedComponents {
  itemId: number;
}

/** Decode a HEIC file to RGBA pixels. */
function decodeInternal(
  buffer: Uint8Array,
  options: DecodeOptions,
  itemId?: number,
): HeicImageData {
  if (!(buffer instanceof Uint8Array))
    throw new HeicError('INVALID_INPUT', 'heic: expected Uint8Array');
  if (buffer.byteLength > 64 * 1024 * 1024)
    throw new HeicError('RESOURCE_LIMIT', 'heic: input exceeds 64 MiB');
  if (!isHeic(buffer)) throw new HeicError('UNSUPPORTED_FORMAT', 'heic: not a HEIC file');
  validateExternalItemData(options.externalItemData);
  const maxPixels = options.maxPixels ?? 50_000_000;
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0 || maxPixels > 50_000_000)
    throw new HeicError('INVALID_OPTIONS', 'heic: invalid maxPixels');
  if (
    options.applyHevcToneMapping !== undefined &&
    typeof options.applyHevcToneMapping !== 'boolean'
  )
    throw new HeicError('INVALID_OPTIONS', 'heic: invalid applyHevcToneMapping');
  if (
    options.applyHevcKneeFunction !== undefined &&
    typeof options.applyHevcKneeFunction !== 'boolean'
  )
    throw new HeicError('INVALID_OPTIONS', 'heic: invalid applyHevcKneeFunction');
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
  if (
    options.hevcToneMapId !== undefined &&
    (options.applyHevcToneMapping !== true ||
      !Number.isSafeInteger(options.hevcToneMapId) ||
      options.hevcToneMapId < 0 ||
      options.hevcToneMapId > 0xffff_ffff)
  )
    throw new HeicError('INVALID_OPTIONS', 'heic: invalid hevcToneMapId');
  if (
    options.hevcKneeFunctionId !== undefined &&
    (options.applyHevcKneeFunction !== true ||
      !Number.isSafeInteger(options.hevcKneeFunctionId) ||
      options.hevcKneeFunctionId < 0 ||
      options.hevcKneeFunctionId > 0xffff_fffe)
  )
    throw new HeicError('INVALID_OPTIONS', 'heic: invalid hevcKneeFunctionId');
  if (
    options.hevcColourRemapId !== undefined &&
    (options.applyHevcColourRemapping !== true ||
      !Number.isSafeInteger(options.hevcColourRemapId) ||
      options.hevcColourRemapId < 0 ||
      options.hevcColourRemapId > 0xffff_fffe)
  )
    throw new HeicError('INVALID_OPTIONS', 'heic: invalid hevcColourRemapId');
  const boxes = parseISOBMFF(buffer);
  const info = getHeicInfo(buffer, boxes, itemId);
  options = prepareAvcDecodeOptionsSync(buffer, options);
  if (info.primaryItemType === 'unci' || info.tiledImage?.tileItemType === 'unci')
    return decodeRendered(buffer, options, itemId);
  if (options.applyHevcToneMapping === true) return decodeRendered(buffer, options, itemId);
  if (options.applyHevcKneeFunction === true) {
    const active = selectHevcKneeFunctionInfo(
      getHeicMetadata(buffer, itemId, options).hevcKneeFunctionInfo,
      options.hevcKneeFunctionId,
    );
    if (options.hevcKneeFunctionId !== undefined || active)
      return decodeRendered(buffer, options, itemId);
  }
  if (options.applyHevcColourRemapping === true) {
    const active = selectHevcColourRemappingInfo(
      getHeicMetadata(buffer, itemId, options).hevcColourRemappingInfo,
      options.hevcColourRemapId,
    );
    if (options.hevcColourRemapId !== undefined || active)
      return decodeRendered(buffer, options, itemId);
  }
  if (options.applyHevcChromaResamplingFilterHint === true) {
    if (getHeicMetadata(buffer, itemId, options).hevcChromaResamplingFilterHint?.length)
      return decodeRendered(buffer, options, itemId);
  }
  if (options.applyHevcPhaseIndication === true) {
    if (getHeicMetadata(buffer, itemId, options).hevcPhaseIndication?.length)
      return decodeRendered(buffer, options, itemId);
  }
  if (options.applyHevcPostFilterHint === true) {
    if (
      getHeicMetadata(buffer, itemId, options).hevcPostFilterHint?.some(
        (hint) => hint.filterHintType === 0 || hint.filterHintType === 1,
      )
    )
      return decodeRendered(buffer, options, itemId);
  }
  if (
    info.primaryItemType === 'avc1' ||
    info.primaryItemType === 'lhv1' ||
    info.lhevc ||
    info.tiledImage?.tileItemType === 'avc1'
  )
    return decodeRendered(buffer, options, itemId);
  if (info.tiledImage?.dataReference.externalTileUrls && !info.hvcC)
    return decodeRendered(buffer, options, itemId);
  if (
    options.applyDefaultDisplayWindow === true ||
    info.transforms.some((transform) => transform.type === 'clap' || transform.type === 'iscl') ||
    info.hasAlpha ||
    info.icc !== null ||
    ['iovl', 'iden', 'tmap'].includes(info.primaryItemType)
  )
    return decodeRendered(buffer, options, itemId);
  if (!info.hvcC)
    throw new HeicError('INVALID_CONTAINER', 'heic: primary item has no HEVC configuration (hvcC)');

  if (info.hasAlpha)
    throw new HeicError('UNSUPPORTED_FEATURE', 'heic: auxiliary alpha planes are not supported');
  const metadata = getHeicMetadata(buffer, itemId, options),
    sps = metadata.sps;
  if (!sps)
    throw new HeicError(
      'INVALID_CONTAINER',
      'heic: primary image has no active HEVC sequence parameters',
    );
  if (
    sps.chromaFormatIdc !== 1 ||
    sps.bitDepthChroma !== sps.bitDepthLuma ||
    info.chromaSampleLocation !== undefined ||
    info.chromaSampleLocations !== undefined ||
    sps.chromaSampleLocation !== undefined
  )
    return decodeRendered(buffer, options, itemId);
  const matrix =
    info.color?.matrix !== undefined && info.color.matrix !== 2
      ? info.color.matrix
      : (sps.color?.matrixCoeffs ?? 6);
  const colorPrimaries =
    info.color?.primaries !== undefined && info.color.primaries !== 2
      ? info.color.primaries
      : (sps.color?.colourPrimaries ?? 2);
  const coefficients = getYCbCrMatrixCoefficients(matrix, colorPrimaries);
  if (
    !coefficients &&
    matrix !== 8 &&
    matrix !== 10 &&
    matrix !== 11 &&
    matrix !== 12 &&
    matrix !== 13 &&
    matrix !== 14 &&
    matrix !== 15 &&
    matrix !== 16 &&
    matrix !== 17
  )
    throw new HeicError('UNSUPPORTED_FEATURE', 'heic: color matrix is not supported');
  if ((matrix === 12 || matrix === 13) && !coefficients)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      `heic: matrix_coeffs ${matrix} requires supported colour_primaries`,
    );
  const transferCharacteristics =
    info.color?.transfer !== undefined && info.color.transfer !== 2
      ? info.color.transfer
      : (metadata.hevcHdrSei?.alternativeTransferCharacteristics
          ?.preferredTransferCharacteristics ??
        sps.color?.transferCharacteristics ??
        2);
  if ((matrix === 10 || matrix === 13) && !getColorTransferFunction(transferCharacteristics))
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      `heic: unsupported transfer_characteristics for matrix_coeffs ${matrix} constant luminance`,
    );
  if (matrix === 14 && transferCharacteristics !== 16 && transferCharacteristics !== 18)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: matrix_coeffs 14 requires PQ or HLG transfer characteristics',
    );
  if (matrix === 15 && !getColorTransferFunction(transferCharacteristics))
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: matrix_coeffs 15 uses unsupported transfer_characteristics',
    );

  const pixels = info.grid
    ? info.grid.rows * info.grid.tileHeight * info.grid.columns * info.grid.tileWidth
    : info.tiledImage
      ? info.tiledImage.rows *
        info.tiledImage.tileHeight *
        info.tiledImage.columns *
        info.tiledImage.tileWidth
      : sps.picWidthInLumaSamples * sps.picHeightInLumaSamples;
  if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > maxPixels)
    throw new HeicError('RESOURCE_LIMIT', 'heic: image exceeds maxPixels');
  let planes: Planes;
  if (info.grid) {
    planes = stitchGrid(buffer, boxes, info, info.grid, {
      externalTileData: options.externalTileData,
      externalItemData: options.externalItemData,
      externalBaseLayerPlanes: options.externalBaseLayerPlanes,
      extraDimensionIndexes: options.extraDimensionIndexes,
    });
    planes = cropPlanes(planes, 0, 0, info.grid.outputWidth, info.grid.outputHeight);
  } else if (info.tiledImage) {
    planes = cropPlanes(
      decodeItemPlanes(buffer, boxes, info, info.primaryItemId, {
        externalTileData: options.externalTileData,
        externalItemData: options.externalItemData,
        externalBaseLayerPlanes: options.externalBaseLayerPlanes,
        extraDimensionIndexes: options.extraDimensionIndexes,
      }),
      0,
      0,
      info.width,
      info.height,
    );
  } else {
    planes = decodeItemPlanes(buffer, boxes, info, info.primaryItemId, {
      externalItemData: options.externalItemData,
      externalBaseLayerPlanes: options.externalBaseLayerPlanes,
    });
    // Conformance window (crop offsets are in chroma units for 4:2:0).
    const subW = sps.chromaFormatIdc === 1 || sps.chromaFormatIdc === 2 ? 2 : 1;
    const subH = sps.chromaFormatIdc === 1 ? 2 : 1;
    planes = cropPlanes(planes, subW * sps.cropLeft, subH * sps.cropTop, sps.width, sps.height);
  }

  const rgba = yuv420ToRgba(planes.y, planes.cb, planes.cr, planes.width, planes.height, {
    bitDepth: sps.bitDepthLuma as HeifHevcBitDepth,
    matrixCoeffs: matrix,
    colorPrimaries,
    transferCharacteristics,
    fullRange: info.color?.fullRange ?? sps.color?.videoFullRange ?? false,
  });

  let data = rgba;
  let width = planes.width;
  let height = planes.height;
  if (options.applyTransforms !== false && (info.rotation !== 0 || info.mirror !== null)) {
    const oriented = applyOrientation(rgba, width, height, info.rotation, info.mirror);
    data = oriented.data;
    width = oriented.width;
    height = oriented.height;
  }

  return {
    data,
    width,
    height,
    hasAlpha: false,
    bitDepth: sps.bitDepthLuma as HeifHevcBitDepth,
    ...(sps.bitDepthChroma !== sps.bitDepthLuma
      ? { bitDepthChroma: sps.bitDepthChroma as HeifHevcBitDepth }
      : {}),
  };
}

/** Synchronous decoding; unexpected implementation errors retain their cause. */
export function decodeHeic(buffer: Uint8Array, options: DecodeOptions = {}): HeicImageData {
  try {
    return decodeInternal(buffer, options, options.itemId);
  } catch (error) {
    throw asHeicError(error);
  }
}

/** Extract raw component planes from the primary `unci` item without inventing an RGBA mapping. */
export function decodeHeicUncompressedComponents(
  buffer: Uint8Array,
  options: DecodeUncompressedComponentsOptions = {},
): HeicUncompressedImageComponents {
  try {
    if (!(buffer instanceof Uint8Array))
      throw new HeicError('INVALID_INPUT', 'heic: expected Uint8Array');
    if (buffer.byteLength > 64 * 1024 * 1024)
      throw new HeicError('RESOURCE_LIMIT', 'heic: input exceeds 64 MiB');
    if (!isHeic(buffer)) throw new HeicError('UNSUPPORTED_FORMAT', 'heic: not a HEIC file');
    validateExternalItemData(options.externalItemData);
    const maxPixels = options.maxPixels ?? 50_000_000;
    if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0 || maxPixels > 50_000_000)
      throw new HeicError('INVALID_OPTIONS', 'heic: invalid maxPixels');
    const boxes = parseISOBMFF(buffer),
      info = getHeicInfo(buffer, boxes);
    if (info.primaryItemType !== 'unci' || !info.uncompressedImage)
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        'heic: primary image is not a supported uncompressed `unci` item',
      );
    const configuration = info.uncompressedImage,
      pixelCount = configuration.width * configuration.height;
    if (!Number.isSafeInteger(pixelCount) || pixelCount > maxPixels)
      throw new HeicError('RESOURCE_LIMIT', 'heic: unci image exceeds the configured pixel limit');
    const itemPayload = getItemPayload(buffer, boxes, info.primaryItemId, options.externalItemData);
    if (!itemPayload)
      throw new HeicError(
        'INVALID_CONTAINER',
        `heic: unci item ${info.primaryItemId} has no payload`,
      );
    const payload = configuration.genericCompression
      ? decompressGenericItemPayloadSync(itemPayload, configuration.genericCompression)
      : itemPayload;
    const decoded = decodeUncompressedImage(payload, configuration, true);
    if (decoded.model !== 'components')
      throw new HeicError(
        'DECODE_FAILED',
        'heic: raw uncompressed component extraction returned rendered pixels',
      );
    return {
      itemId: info.primaryItemId,
      width: decoded.width,
      height: decoded.height,
      components: decoded.components,
    };
  } catch (error) {
    throw asHeicError(error);
  }
}

/**
 * Decode every HEIF `ster` group as a left/right pair. Each member must be an
 * image item supported by this decoder; bounded `lhv1` still-picture items
 * are supported.
 */
export function decodeHeicStereoPairs(
  buffer: Uint8Array,
  options: DecodeOptions = {},
): HeicStereoPair[] {
  try {
    if (!(buffer instanceof Uint8Array))
      throw new HeicError('INVALID_INPUT', 'heic: expected Uint8Array');
    if (buffer.byteLength > 64 * 1024 * 1024)
      throw new HeicError('RESOURCE_LIMIT', 'heic: input exceeds 64 MiB');
    if (!isHeic(buffer)) throw new HeicError('UNSUPPORTED_FORMAT', 'heic: not a HEIC file');
    const boxes = parseISOBMFF(buffer);
    const info = getHeicInfo(buffer, boxes);
    const stereoPairs = info.stereoPairs ?? [];
    if (stereoPairs.length === 0)
      throw new HeicError('UNSUPPORTED_FEATURE', 'heic: no stereo pair group found');
    return stereoPairs.map((pair) => ({
      ...pair,
      left: decodeInternal(buffer, options, pair.leftItemId),
      right: decodeInternal(buffer, options, pair.rightItemId),
    }));
  } catch (error) {
    throw asHeicError(error);
  }
}

/**
 * Decode the original sample planes of HEIF auxiliary images associated with
 * the primary image. This preserves their coded bit depth for data such as
 * depth maps; container display transforms are returned as metadata.
 */
export function decodeHeicAuxiliaryPlanes(
  buffer: Uint8Array,
  options: DecodeOptions = {},
): HeicAuxiliaryPlanes[] {
  try {
    if (!(buffer instanceof Uint8Array))
      throw new HeicError('INVALID_INPUT', 'heic: expected Uint8Array');
    if (buffer.byteLength > 64 * 1024 * 1024)
      throw new HeicError('RESOURCE_LIMIT', 'heic: input exceeds 64 MiB');
    if (!isHeic(buffer)) throw new HeicError('UNSUPPORTED_FORMAT', 'heic: not a HEIC file');
    const maxPixels = options.maxPixels ?? 50_000_000;
    if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0 || maxPixels > 50_000_000)
      throw new HeicError('INVALID_OPTIONS', 'heic: invalid maxPixels');

    const boxes = parseISOBMFF(buffer),
      primaryInfo = getHeicInfo(buffer, boxes);
    let totalPixels = 0;
    return primaryInfo.auxiliaryImages.map((auxiliary) => {
      const info = getHeicInfo(buffer, boxes, auxiliary.itemId);
      if (info.primaryItemType !== 'hvc1' && info.primaryItemType !== 'lhv1')
        throw new HeicError(
          'UNSUPPORTED_FEATURE',
          `heic: auxiliary image item ${auxiliary.itemId} is not HEVC-coded`,
        );
      const metadata = getHeicMetadata(buffer, auxiliary.itemId),
        configuredSps = metadata.sps;
      if (!configuredSps)
        throw new HeicError(
          'INVALID_CONTAINER',
          `heic: auxiliary image item ${auxiliary.itemId} has no active HEVC SPS`,
        );
      const hevcAuxiliarySei = getHevcAuxiliarySeiForItem(primaryInfo, auxiliary.itemId, info);
      const outputPixels = configuredSps.width * configuredSps.height;
      totalPixels += outputPixels;
      if (
        !Number.isSafeInteger(outputPixels) ||
        outputPixels <= 0 ||
        !Number.isSafeInteger(totalPixels) ||
        totalPixels > maxPixels
      )
        throw new HeicError('RESOURCE_LIMIT', 'heic: auxiliary images exceed maxPixels');

      let planes = decodeItemPlanes(buffer, boxes, info, auxiliary.itemId, {
        externalTileData: options.externalTileData,
        externalItemData: options.externalItemData,
        externalBaseLayerPlanes: options.externalBaseLayerPlanes,
        extraDimensionIndexes: options.extraDimensionIndexes,
      });
      const sps = planes.sourceSps ?? configuredSps,
        subWidth = sps.chromaFormatIdc === 1 || sps.chromaFormatIdc === 2 ? 2 : 1,
        subHeight = sps.chromaFormatIdc === 1 ? 2 : 1;
      planes = cropPlanes(
        planes,
        subWidth * sps.cropLeft,
        subHeight * sps.cropTop,
        sps.width,
        sps.height,
      );
      return {
        itemId: auxiliary.itemId,
        type: auxiliary.type,
        width: planes.width,
        height: planes.height,
        chromaFormatIdc: planes.chromaFormatIdc,
        bitDepthLuma: planes.bitDepthLuma ?? sps.bitDepthLuma,
        bitDepthChroma: planes.bitDepthChroma ?? sps.bitDepthChroma,
        y: planes.y,
        cb: planes.cb,
        cr: planes.cr,
        color: info.color,
        pixelAspectRatio: info.pixelAspectRatio,
        transforms: info.transforms,
        ...(hevcAuxiliarySei ? { hevcAuxiliarySei } : {}),
      };
    });
  } catch (error) {
    throw asHeicError(error);
  }
}
