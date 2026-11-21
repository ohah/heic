import { HeicError } from './errors.js';
import type {
  GridInfo,
  HeicInfo,
  HvcCConfig,
  RelativeImageLocation,
  TiledImageInfo,
} from './container/heic.js';
import { getItemPayload, getHeicInfo } from './container/heic.js';
import {
  buildTiledTileUrl,
  getTiledImageTileIndices,
  parseTiledItemRanges,
} from './container/tili.js';
import { findBox, parseIinf, parseISOBMFF, type ISOBMFFBox } from './container/heif.js';
import { parseSps, type SpsInfo } from './hevc/sps.js';
import { chromaSubsampling } from './hevc/chroma.js';
import { parsePps } from './hevc/pps.js';
import { selectActiveHevcParameterSetNals } from './hevc/parameter-sets.js';
import { PictureDecoder, type ReferenceImage } from './hevc/picture.js';
import { NalType, splitLengthPrefixed, isSliceNal } from './hevc/nal.js';
import {
  parseSliceHeader,
  SLICE_TYPE_B,
  SLICE_TYPE_P,
  type SliceHeader,
} from './hevc/slice-header.js';
import { decodeLayeredHevcPicture } from './hevc/layered-picture.js';
import {
  buildBReferenceLists,
  buildReferenceList0,
  createCurrentPictureReference,
  derivePictureOrderCnt,
  type PictureReference,
} from './hevc/reference-list.js';
import { deblockPicture } from './hevc/deblock.js';
import { applySao } from './hevc/sao.js';
import { isHeifHevcBitDepth } from './bit-depth.js';
import type { HevcAlphaChannelInformation } from './hevc/sei.js';
import { activeHevcAlphaChannelInfo, getHevcAuxiliarySeiForItem } from './hevc/heif-sei.js';
export interface Planes {
  chromaFormatIdc: number;
  bitDepthLuma?: number;
  bitDepthChroma?: number;
  hasExternalInterMotion: boolean;
  y: Uint8Array | Uint16Array;
  cb: Uint8Array | Uint16Array;
  cr: Uint8Array | Uint16Array;
  /** Optional external-tile auxiliary alpha, scaled to the luma dimensions. */
  alpha?: Uint8Array | Uint16Array;
  alphaBitDepth?: number;
  premultipliedAlpha?: boolean;
  alphaChannelInfo?: HevcAlphaChannelInformation;
  width: number;
  height: number;
  /** Coded-picture motion maps retained for temporal MVP in dependent items. */
  interMap?: Uint8Array;
  /** Per-4x4 flag: the mode uses motion from an external reference (not IBC). */
  motionIsExternal?: Uint8Array;
  motionPredFlags?: Uint8Array;
  motionRefIdxL0?: Uint8Array;
  motionXQpel?: Int32Array;
  motionYQpel?: Int32Array;
  motionRefPoc?: Float64Array;
  motionRefLongTerm?: Uint8Array;
  motionRefLayerId?: Uint8Array;
  motionXQpelL1?: Int32Array;
  motionYQpelL1?: Int32Array;
  motionRefIdxL1?: Uint8Array;
  motionRefPocL1?: Float64Array;
  motionRefLongTermL1?: Uint8Array;
  motionRefLayerIdL1?: Uint8Array;
  /** POC LSB from the item's first independent slice, or zero for IDR. */
  pictureOrderCntLsb?: number;
  /** Full POC derived in the item's `pred` decoding order. */
  pictureOrderCnt?: number;
  /** NAL temporal_id for previous-Tid0 POC derivation in dependent items. */
  temporalId?: number;
  /** SPS and color hints used when tili tiles live in separate HEIF files. */
  sourceSps?: SpsInfo;
  sourceColor?: HeicInfo['color'];
  sourceIcc?: Uint8Array | null;
  sourceIccType?: HeicInfo['iccType'];
  sourceChromaSampleLocation?: HeicInfo['chromaSampleLocation'];
}

/** Caller-decoded planes for an `avc1` image item. */
export interface ExternalBaseLayerPlanes {
  width: number;
  height: number;
  chromaFormatIdc: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
  y: Uint8Array | Uint16Array;
  cb: Uint8Array | Uint16Array;
  cr: Uint8Array | Uint16Array;
  /** Optional color information from the AVC SPS or the caller's decoder. */
  color?: HeicInfo['color'];
  /** Optional AVC VUI chroma-sample location. */
  chromaSampleLocation?: HeicInfo['chromaSampleLocation'];
}

const MOTION_MAP_KEYS = [
  'interMap',
  'motionIsExternal',
  'motionPredFlags',
  'motionRefIdxL0',
  'motionXQpel',
  'motionYQpel',
  'motionRefPoc',
  'motionRefLongTerm',
  'motionRefLayerId',
  'motionXQpelL1',
  'motionYQpelL1',
  'motionRefIdxL1',
  'motionRefPocL1',
  'motionRefLongTermL1',
  'motionRefLayerIdL1',
] as const;
type MotionMapKey = (typeof MOTION_MAP_KEYS)[number];

interface CodedTiliReferenceTile {
  sps: SpsInfo;
  codedPlanes?: Planes;
}

interface CodedTiliReferenceLayout {
  itemId: number;
  relativeLocation?: RelativeImageLocation;
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  extraDimensionSizes: readonly number[];
  selectedExtraDimensionIndexes: readonly number[];
  selectedTileIndexes: readonly number[];
  tiles: readonly (CodedTiliReferenceTile | undefined)[];
}

interface DecodedTiliLayerLayout {
  itemId: number;
  relativeLocation?: RelativeImageLocation;
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  extraDimensionSizes: readonly number[];
  selectedExtraDimensionIndexes: readonly number[];
  selectedTileIndexes: readonly number[];
  tilesByIndex: ReadonlyMap<number, ReadonlyMap<number, Planes>>;
}

function sameTiliLayerPlane(
  reference: DecodedTiliLayerLayout,
  current: TiledImageInfo,
  selectedExtraDimensionIndexes: readonly number[],
): boolean {
  return (
    reference.extraDimensionSizes.length === selectedExtraDimensionIndexes.length &&
    current.extraDimensionSizes.length === selectedExtraDimensionIndexes.length &&
    reference.selectedExtraDimensionIndexes.every(
      (index, dimension) => index === selectedExtraDimensionIndexes[dimension],
    )
  );
}

function tiliLayerPixelOffset(
  reference: DecodedTiliLayerLayout,
  current: TiledImageInfo,
  selectedExtraDimensionIndexes: readonly number[],
  currentInfo: HeicInfo,
  referenceItemId: number | undefined,
): { x: number; y: number } | undefined {
  if (
    reference.tileWidth !== current.tileWidth ||
    reference.tileHeight !== current.tileHeight ||
    !sameTiliLayerPlane(reference, current, selectedExtraDimensionIndexes) ||
    reference.selectedTileIndexes.length === 0
  )
    return undefined;
  const offset = tiliReferenceOffset(
    currentInfo,
    referenceItemId ?? reference.itemId,
    reference.relativeLocation,
  );
  if (!offset) return undefined;
  return offset;
}

function canReuseTiliLayerLayout(
  reference: DecodedTiliLayerLayout,
  current: TiledImageInfo,
  selectedExtraDimensionIndexes: readonly number[],
  currentInfo: HeicInfo,
  referenceItemId: number | undefined,
): boolean {
  const offset = tiliLayerPixelOffset(
    reference,
    current,
    selectedExtraDimensionIndexes,
    currentInfo,
    referenceItemId,
  );
  if (!offset) return false;
  const referenceWidth = reference.columns * reference.tileWidth;
  const referenceHeight = reference.rows * reference.tileHeight;
  const currentRight = offset.x + current.columns * current.tileWidth;
  const currentBottom = offset.y + current.rows * current.tileHeight;
  return (
    offset.x >= 0 &&
    offset.y >= 0 &&
    Number.isSafeInteger(referenceWidth) &&
    Number.isSafeInteger(referenceHeight) &&
    Number.isSafeInteger(currentRight) &&
    Number.isSafeInteger(currentBottom) &&
    currentRight <= referenceWidth &&
    currentBottom <= referenceHeight
  );
}

function tiliLayerPlaneAt(reference: DecodedTiliLayerLayout, layerId: number): Planes | undefined {
  for (const tileIndex of reference.selectedTileIndexes) {
    const layer = reference.tilesByIndex.get(tileIndex)?.get(layerId);
    if (layer) return layer;
  }
  return undefined;
}

function tiliLayerSamplePlane(
  reference: DecodedTiliLayerLayout,
  layerId: number,
  field: 'y' | 'cb' | 'cr' | 'alpha',
  originX: number,
  originY: number,
  outputWidth: number,
  outputHeight: number,
  tileSampleWidth: number,
  tileSampleHeight: number,
  sampleType: Uint8Array | Uint16Array,
): Uint8Array | Uint16Array {
  const output =
    sampleType instanceof Uint16Array
      ? new Uint16Array(outputWidth * outputHeight)
      : new Uint8Array(outputWidth * outputHeight);
  const referenceWidth = reference.columns * tileSampleWidth;
  const referenceHeight = reference.rows * tileSampleHeight;
  if (
    originX < 0 ||
    originY < 0 ||
    originX + outputWidth > referenceWidth ||
    originY + outputHeight > referenceHeight
  )
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: L-HEVC tili rloc reference region extends outside the selected tiled plane',
    );
  const selectedPlaneStart = reference.selectedTileIndexes[0];
  for (let row = 0; row < outputHeight; row++) {
    const sourceY = originY + row;
    const tileRow = Math.floor(sourceY / tileSampleHeight);
    const localY = sourceY % tileSampleHeight;
    let copied = 0;
    while (copied < outputWidth) {
      const sourceX = originX + copied;
      const tileColumn = Math.floor(sourceX / tileSampleWidth);
      const localX = sourceX % tileSampleWidth;
      const count = Math.min(outputWidth - copied, tileSampleWidth - localX);
      const tileIndex = selectedPlaneStart + tileRow * reference.columns + tileColumn;
      const layer = reference.tilesByIndex.get(tileIndex)?.get(layerId);
      const samples = layer?.[field];
      if (
        !samples ||
        samples.length !== tileSampleWidth * tileSampleHeight ||
        samples.constructor !== output.constructor
      )
        throw new HeicError(
          'UNSUPPORTED_FEATURE',
          `heic: L-HEVC tili rloc reference tile is missing layer ${layerId} ${field} samples`,
        );
      const sourceStart = localY * tileSampleWidth + localX;
      output.set(samples.subarray(sourceStart, sourceStart + count), row * outputWidth + copied);
      copied += count;
    }
  }
  return output;
}

function tiliLayerMotionMap(
  reference: DecodedTiliLayerLayout,
  layerId: number,
  key: MotionMapKey,
  originX: number,
  originY: number,
  width: number,
  height: number,
  tileWidth: number,
  tileHeight: number,
): MotionMap | undefined {
  let sampleMap: MotionMap | undefined;
  for (const tileIndex of reference.selectedTileIndexes) {
    sampleMap = reference.tilesByIndex.get(tileIndex)?.get(layerId)?.[key] as MotionMap | undefined;
    if (sampleMap) break;
  }
  if (!sampleMap) return undefined;
  if (tileWidth % 4 !== 0 || tileHeight % 4 !== 0)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: L-HEVC tili reference tile boundaries must align to 4x4 motion-map blocks',
    );
  const mapWidth = Math.ceil(width / 4);
  const mapHeight = Math.ceil(height / 4);
  const tileMapWidth = tileWidth / 4;
  const tileMapHeight = tileHeight / 4;
  const output = createMotionMap(sampleMap, mapWidth * mapHeight);
  output.fill(0);
  const selectedPlaneStart = reference.selectedTileIndexes[0];
  // Temporal MVP looks up collocated fields at luma positions and derives
  // their 4x4 map cell by flooring the source coordinate.
  const mapOriginX = Math.floor(originX / 4);
  const mapOriginY = Math.floor(originY / 4);
  for (let row = 0; row < mapHeight; row++) {
    const sourceY = mapOriginY + row;
    const tileRow = Math.floor(sourceY / tileMapHeight);
    const localY = sourceY % tileMapHeight;
    let copied = 0;
    while (copied < mapWidth) {
      const sourceX = mapOriginX + copied;
      const tileColumn = Math.floor(sourceX / tileMapWidth);
      const localX = sourceX % tileMapWidth;
      const count = Math.min(mapWidth - copied, tileMapWidth - localX);
      const tileIndex = selectedPlaneStart + tileRow * reference.columns + tileColumn;
      const layer = reference.tilesByIndex.get(tileIndex)?.get(layerId);
      const source = layer?.[key] as MotionMap | undefined;
      if (source) {
        if (source.length !== tileMapWidth * tileMapHeight)
          throw new HeicError(
            'INVALID_BITSTREAM',
            `heic: L-HEVC tili reference ${key} has an invalid map size`,
          );
        const sourceStart = localY * tileMapWidth + localX;
        output.set(source.subarray(sourceStart, sourceStart + count), row * mapWidth + copied);
      }
      copied += count;
    }
  }
  return output;
}

function stitchTiliLayerReferenceRegion(
  reference: DecodedTiliLayerLayout,
  currentInfo: HeicInfo,
  layerId: number,
  sourceX: number,
  sourceY: number,
): Planes {
  const first = tiliLayerPlaneAt(reference, layerId);
  if (!first)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      `heic: L-HEVC tili prediction reference has no decoded layer ${layerId}`,
    );
  const currentSpsNal = currentInfo.lhevc?.configuration.arrays
    .filter((array) => array.nalUnitType === 33)
    .flatMap((array) => array.nalUnits)
    .find((nal) => nal.layerId === layerId);
  if (!currentSpsNal || !currentInfo.lhevc)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      `heic: L-HEVC tili prediction has no SPS for layer ${layerId}`,
    );
  const currentSps = parseSps(currentSpsNal.data, {
    allowBaseLayerMultilayerExtension: true,
    layeredVps: currentInfo.lhevc.selectedVps ?? undefined,
  });
  if (
    currentSps.width !== first.width ||
    currentSps.height !== first.height ||
    currentSps.chromaFormatIdc !== first.chromaFormatIdc ||
    currentSps.bitDepthLuma !== (first.bitDepthLuma ?? currentSps.bitDepthLuma) ||
    currentSps.bitDepthChroma !== (first.bitDepthChroma ?? currentSps.bitDepthChroma)
  )
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      `heic: L-HEVC temporal reference layer ${layerId} has incompatible sample dimensions`,
    );
  // rloc uses the selected image's pixel grid; an L-HEVC reference layer can
  // use a different spatial scale, so convert the location before sampling.
  const layerOffsetXNumerator = sourceX * first.width;
  const layerOffsetYNumerator = sourceY * first.height;
  if (
    !Number.isSafeInteger(layerOffsetXNumerator) ||
    !Number.isSafeInteger(layerOffsetYNumerator) ||
    layerOffsetXNumerator % reference.tileWidth !== 0 ||
    layerOffsetYNumerator % reference.tileHeight !== 0
  )
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      `heic: L-HEVC layer ${layerId} rloc offset does not align to its sample grid`,
    );
  const originX = layerOffsetXNumerator / reference.tileWidth;
  const originY = layerOffsetYNumerator / reference.tileHeight;
  const sub = chromaSubsampling(first.chromaFormatIdc);
  if (
    first.width % sub.width !== 0 ||
    first.height % sub.height !== 0 ||
    originX % sub.width !== 0 ||
    originY % sub.height !== 0
  )
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      `heic: L-HEVC layer ${layerId} rloc offset does not align to chroma samples`,
    );
  const y = tiliLayerSamplePlane(
    reference,
    layerId,
    'y',
    originX,
    originY,
    first.width,
    first.height,
    first.width,
    first.height,
    first.y,
  );
  const alpha = first.alpha
    ? tiliLayerSamplePlane(
        reference,
        layerId,
        'alpha',
        originX,
        originY,
        first.width,
        first.height,
        first.width,
        first.height,
        first.alpha,
      )
    : undefined;
  const cb = first.cb.length
    ? tiliLayerSamplePlane(
        reference,
        layerId,
        'cb',
        originX / sub.width,
        originY / sub.height,
        first.width / sub.width,
        first.height / sub.height,
        first.width / sub.width,
        first.height / sub.height,
        first.cb,
      )
    : first.cb.slice();
  const cr = first.cr.length
    ? tiliLayerSamplePlane(
        reference,
        layerId,
        'cr',
        originX / sub.width,
        originY / sub.height,
        first.width / sub.width,
        first.height / sub.height,
        first.width / sub.width,
        first.height / sub.height,
        first.cr,
      )
    : first.cr.slice();
  const motionMaps: Partial<Pick<Planes, MotionMapKey>> = {};
  for (const key of MOTION_MAP_KEYS) {
    const map = tiliLayerMotionMap(
      reference,
      layerId,
      key,
      originX,
      originY,
      first.width,
      first.height,
      first.width,
      first.height,
    );
    if (map) Object.assign(motionMaps, { [key]: map });
  }
  const firstColumn = Math.floor(originX / first.width);
  const lastColumn = Math.floor((originX + first.width - 1) / first.width);
  const firstRow = Math.floor(originY / first.height);
  const lastRow = Math.floor((originY + first.height - 1) / first.height);
  let hasExternalInterMotion = false;
  const selectedPlaneStart = reference.selectedTileIndexes[0];
  for (let row = firstRow; row <= lastRow; row++)
    for (let column = firstColumn; column <= lastColumn; column++) {
      const tileIndex = selectedPlaneStart + row * reference.columns + column;
      const tileLayer = reference.tilesByIndex.get(tileIndex)?.get(layerId);
      if (!tileLayer)
        throw new HeicError(
          'UNSUPPORTED_FEATURE',
          `heic: L-HEVC tili rloc region is missing layer ${layerId} tile samples`,
        );
      hasExternalInterMotion ||= tileLayer.hasExternalInterMotion;
    }
  return {
    ...first,
    ...motionMaps,
    hasExternalInterMotion,
    y,
    cb,
    cr,
    ...(alpha ? { alpha } : {}),
  };
}

function tiliLayerReferenceForTile(
  reference: DecodedTiliLayerLayout,
  current: TiledImageInfo,
  selectedExtraDimensionIndexes: readonly number[],
  currentInfo: HeicInfo,
  referenceItemId: number | undefined,
  spatialIndex: number,
  currentLayerInfo: HeicInfo = currentInfo,
): ReadonlyMap<number, Planes> | undefined {
  const offset = tiliLayerPixelOffset(
    reference,
    current,
    selectedExtraDimensionIndexes,
    currentInfo,
    referenceItemId,
  );
  if (
    !offset ||
    !canReuseTiliLayerLayout(
      reference,
      current,
      selectedExtraDimensionIndexes,
      currentInfo,
      referenceItemId,
    )
  )
    return undefined;
  const column = spatialIndex % current.columns,
    row = Math.floor(spatialIndex / current.columns);
  const sourceX = offset.x + column * current.tileWidth;
  const sourceY = offset.y + row * current.tileHeight;
  const referenceLayers = new Set<number>();
  for (const tileIndex of reference.selectedTileIndexes)
    for (const layerId of reference.tilesByIndex.get(tileIndex)?.keys() ?? [])
      referenceLayers.add(layerId);
  return new Map(
    [...referenceLayers].map((layerId) => [
      layerId,
      stitchTiliLayerReferenceRegion(reference, currentLayerInfo, layerId, sourceX, sourceY),
    ]),
  );
}

const codedTiliReferenceLayouts = new WeakMap<Planes, CodedTiliReferenceLayout>();

function hasConformanceCrop(sps: SpsInfo): boolean {
  return sps.cropLeft > 0 || sps.cropRight > 0 || sps.cropTop > 0 || sps.cropBottom > 0;
}

function compatibleCodedTiliReferenceSps(reference: SpsInfo, current: SpsInfo): boolean {
  return (
    reference.picWidthInLumaSamples === current.picWidthInLumaSamples &&
    reference.picHeightInLumaSamples === current.picHeightInLumaSamples &&
    reference.bitDepthLuma === current.bitDepthLuma &&
    reference.bitDepthChroma === current.bitDepthChroma &&
    reference.chromaFormatIdc === current.chromaFormatIdc
  );
}

function tiliReferenceOffset(
  current: HeicInfo,
  referenceItemId: number | undefined,
  referenceLocation: RelativeImageLocation | undefined,
): { x: number; y: number } | undefined {
  const currentLocation = current.relativeLocation;
  if (!currentLocation) return { x: 0, y: 0 };
  if (referenceItemId !== undefined && currentLocation.relatedItemId === referenceItemId)
    return { x: currentLocation.horizontalOffset, y: currentLocation.verticalOffset };
  if (referenceLocation && currentLocation.relatedItemId === referenceLocation.relatedItemId)
    return {
      x: currentLocation.horizontalOffset - referenceLocation.horizontalOffset,
      y: currentLocation.verticalOffset - referenceLocation.verticalOffset,
    };
  return undefined;
}

function tiliReferenceForTile(
  reference: Planes,
  sps: SpsInfo,
  currentInfo: HeicInfo,
  referenceItemId: number | undefined,
  tiledImage: TiledImageInfo,
  selectedTileIndexes: readonly number[],
  selectedExtraDimensionIndexes: readonly number[],
  spatialIndex: number,
  x: number,
  y: number,
  referenceWidth: number,
  referenceHeight: number,
): Planes {
  const layout = codedTiliReferenceLayouts.get(reference);
  const offset = tiliReferenceOffset(currentInfo, referenceItemId, layout?.relativeLocation);
  if (!offset)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: tili rloc position cannot be resolved against its pred reference',
    );
  const subsampling = chromaSubsampling(sps.chromaFormatIdc);
  if (offset.x % subsampling.width !== 0 || offset.y % subsampling.height !== 0)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: tili rloc pred offset is not aligned to the chroma sample grid',
    );
  const referenceX = x + offset.x;
  const referenceY = y + offset.y;
  const matchingLayout =
    layout !== undefined &&
    layout.columns === tiledImage.columns &&
    layout.rows === tiledImage.rows &&
    layout.selectedTileIndexes.length === selectedTileIndexes.length &&
    layout.selectedTileIndexes.every((index, tile) => index === selectedTileIndexes[tile]);
  if (layout && matchingLayout && offset.x === 0 && offset.y === 0) {
    const tileReference = layout.tiles[spatialIndex];
    if (tileReference && compatibleCodedTiliReferenceSps(tileReference.sps, sps)) {
      if (tileReference.codedPlanes) return tileReference.codedPlanes;
      if (
        !hasConformanceCrop(tileReference.sps) &&
        tileReference.sps.picWidthInLumaSamples === referenceWidth &&
        tileReference.sps.picHeightInLumaSamples === referenceHeight
      ) {
        const tileX = (spatialIndex % layout.columns) * layout.tileWidth;
        const tileY = Math.floor(spatialIndex / layout.columns) * layout.tileHeight;
        if (
          tileX + referenceWidth <= reference.width &&
          tileY + referenceHeight <= reference.height
        )
          return cropReferencePlanesForTile(
            reference,
            tileX,
            tileY,
            referenceWidth,
            referenceHeight,
          );
      }
    }
  }

  if (
    layout &&
    matchingLayout &&
    referenceX >= 0 &&
    referenceY >= 0 &&
    referenceX % layout.tileWidth === 0 &&
    referenceY % layout.tileHeight === 0
  ) {
    const column = referenceX / layout.tileWidth;
    const row = referenceY / layout.tileHeight;
    if (column < layout.columns && row < layout.rows) {
      const tileReference = layout.tiles[row * layout.columns + column];
      if (tileReference && compatibleCodedTiliReferenceSps(tileReference.sps, sps)) {
        if (tileReference.codedPlanes) return tileReference.codedPlanes;
        if (
          !hasConformanceCrop(tileReference.sps) &&
          tileReference.sps.picWidthInLumaSamples === referenceWidth &&
          tileReference.sps.picHeightInLumaSamples === referenceHeight &&
          referenceX + referenceWidth <= reference.width &&
          referenceY + referenceHeight <= reference.height
        )
          return cropReferencePlanesForTile(
            reference,
            referenceX,
            referenceY,
            referenceWidth,
            referenceHeight,
          );
      }
    }
  }

  if (layout) {
    const codedRegion = stitchCodedTiliReferenceRegion(
      reference,
      layout,
      sps,
      tiledImage,
      selectedExtraDimensionIndexes,
      spatialIndex,
      x,
      y,
      offset,
      referenceWidth,
      referenceHeight,
    );
    if (codedRegion) return codedRegion;
  }

  if (
    hasConformanceCrop(sps) &&
    (tiledImage.columns !== 1 || tiledImage.rows !== 1 || selectedTileIndexes.length !== 1)
  )
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: cropped multi-tile prediction requires matching coded tili reference tiles',
    );
  if (
    referenceX < 0 ||
    referenceY < 0 ||
    referenceX + referenceWidth > reference.width ||
    referenceY + referenceHeight > reference.height
  )
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: tili pred reference dimensions do not cover the coded tile',
    );
  return cropReferencePlanesForTile(
    reference,
    referenceX,
    referenceY,
    referenceWidth,
    referenceHeight,
  );
}

function tiliReferenceExtent(sps: SpsInfo): { width: number; height: number } {
  return hasConformanceCrop(sps)
    ? { width: sps.picWidthInLumaSamples, height: sps.picHeightInLumaSamples }
    : { width: sps.width, height: sps.height };
}

function stitchCodedTiliReferenceRegion(
  reference: Planes,
  layout: CodedTiliReferenceLayout,
  currentSps: SpsInfo,
  current: TiledImageInfo,
  selectedExtraDimensionIndexes: readonly number[],
  spatialIndex: number,
  tileX: number,
  tileY: number,
  offset: { x: number; y: number },
  outputWidth: number,
  outputHeight: number,
): Planes | undefined {
  if (
    layout.extraDimensionSizes.length !== current.extraDimensionSizes.length ||
    layout.selectedExtraDimensionIndexes.length !== selectedExtraDimensionIndexes.length ||
    !layout.selectedExtraDimensionIndexes.every(
      (index, dimension) => index === selectedExtraDimensionIndexes[dimension],
    ) ||
    layout.columns <= 0 ||
    layout.rows <= 0 ||
    layout.tiles.length !== layout.columns * layout.rows
  )
    return undefined;

  const firstTile = layout.tiles.find((tile) => tile?.codedPlanes && hasConformanceCrop(tile.sps));
  if (!firstTile?.codedPlanes) return undefined;
  const codedTileWidth = firstTile.sps.picWidthInLumaSamples;
  const codedTileHeight = firstTile.sps.picHeightInLumaSamples;
  const subsampling = chromaSubsampling(currentSps.chromaFormatIdc);
  if (
    !hasConformanceCrop(firstTile.sps) ||
    !compatibleCodedTiliReferenceSps(firstTile.sps, currentSps) ||
    outputWidth !== currentSps.picWidthInLumaSamples ||
    outputHeight !== currentSps.picHeightInLumaSamples ||
    currentSps.width !== current.tileWidth ||
    currentSps.height !== current.tileHeight ||
    firstTile.sps.width !== layout.tileWidth ||
    firstTile.sps.height !== layout.tileHeight ||
    codedTileWidth % 4 !== 0 ||
    codedTileHeight % 4 !== 0 ||
    layout.tileWidth % subsampling.width !== 0 ||
    layout.tileHeight % subsampling.height !== 0 ||
    ![tileX, tileY, offset.x, offset.y].every(Number.isSafeInteger)
  )
    return undefined;

  // rloc and x/y use the reconstructed image's visible pixel grid. Move the
  // coded child tile's origin back over its own SPS conformance crop before
  // mapping those pixels into the parent tile grid.
  const originX = tileX + offset.x - subsampling.width * currentSps.cropLeft;
  const originY = tileY + offset.y - subsampling.height * currentSps.cropTop;
  if (
    originX % subsampling.width !== 0 ||
    originY % subsampling.height !== 0 ||
    outputWidth % subsampling.width !== 0 ||
    outputHeight % subsampling.height !== 0
  )
    return undefined;

  const usedTiles = new Set<number>();
  const sourceTileAt = (
    displayX: number,
    displayY: number,
    sampleSubWidth: number,
    sampleSubHeight: number,
  ) => {
    const visibleTileWidth = layout.tileWidth / sampleSubWidth;
    const visibleTileHeight = layout.tileHeight / sampleSubHeight;
    const column = Math.max(
      0,
      Math.min(layout.columns - 1, Math.floor(displayX / visibleTileWidth)),
    );
    const row = Math.max(0, Math.min(layout.rows - 1, Math.floor(displayY / visibleTileHeight)));
    return {
      index: row * layout.columns + column,
      localX: displayX - column * visibleTileWidth,
      localY: displayY - row * visibleTileHeight,
    };
  };
  const copyPlane = (
    field: 'y' | 'cb' | 'cr',
    sourceX: number,
    sourceY: number,
    width: number,
    height: number,
    tileSampleWidth: number,
    tileSampleHeight: number,
    sampleType: Uint8Array | Uint16Array,
  ): Uint8Array | Uint16Array | undefined => {
    const sampleSubWidth = field === 'y' ? 1 : subsampling.width;
    const sampleSubHeight = field === 'y' ? 1 : subsampling.height;
    const visibleTileWidth = layout.tileWidth / sampleSubWidth;
    const visibleTileHeight = layout.tileHeight / sampleSubHeight;
    if (
      !Number.isInteger(visibleTileWidth) ||
      !Number.isInteger(visibleTileHeight) ||
      tileSampleWidth !== codedTileWidth / sampleSubWidth ||
      tileSampleHeight !== codedTileHeight / sampleSubHeight
    )
      return undefined;
    const output =
      sampleType instanceof Uint16Array
        ? new Uint16Array(width * height)
        : new Uint8Array(width * height);
    for (let row = 0; row < height; row++) {
      const globalY = sourceY + row;
      let copied = 0;
      while (copied < width) {
        const globalX = sourceX + copied;
        const tileLocation = sourceTileAt(globalX, globalY, sampleSubWidth, sampleSubHeight);
        const tileColumn = tileLocation.index % layout.columns;
        const tileIndex = tileLocation.index;
        const tile = layout.tiles[tileIndex];
        if (!tile?.codedPlanes)
          throw new HeicError(
            'UNSUPPORTED_FEATURE',
            `heic: cropped tili reference tile ${tileIndex} has no coded ${field} samples`,
          );
        const samples = tile?.codedPlanes?.[field];
        const cropLeft =
          field === 'y' ? tile!.sps.cropLeft * subsampling.width : tile!.sps.cropLeft;
        const cropTop = field === 'y' ? tile.sps.cropTop * subsampling.height : tile.sps.cropTop;
        const codedX = tileLocation.localX + cropLeft;
        const codedY = tileLocation.localY + cropTop;
        const tileSampleWidthForSource = tile!.sps.picWidthInLumaSamples / sampleSubWidth;
        const tileSampleHeightForSource = tile!.sps.picHeightInLumaSamples / sampleSubHeight;
        const count =
          tileColumn === layout.columns - 1 && globalX >= visibleTileWidth * layout.columns
            ? width - copied
            : Math.min(width - copied, visibleTileWidth - tileLocation.localX);
        if (
          !tile?.codedPlanes ||
          !hasConformanceCrop(tile.sps) ||
          !compatibleCodedTiliReferenceSps(tile.sps, firstTile.sps) ||
          tile.sps.width !== layout.tileWidth ||
          tile.sps.height !== layout.tileHeight ||
          !samples ||
          samples.length !== tileSampleWidthForSource * tileSampleHeightForSource ||
          samples.constructor !== output.constructor
        )
          throw new HeicError(
            'UNSUPPORTED_FEATURE',
            `heic: cropped tili reference tile ${tileIndex} has no coded ${field} samples`,
          );
        if (
          codedX < 0 ||
          codedX + count > tileSampleWidthForSource ||
          codedY < 0 ||
          codedY >= tileSampleHeightForSource ||
          tileSampleHeightForSource !== tileSampleHeight
        )
          return undefined;
        usedTiles.add(tileIndex);
        const inputOffset = codedY * tileSampleWidthForSource + codedX;
        output.set(samples.subarray(inputOffset, inputOffset + count), row * width + copied);
        copied += count;
      }
    }
    return output;
  };

  const y = copyPlane(
    'y',
    originX,
    originY,
    outputWidth,
    outputHeight,
    codedTileWidth,
    codedTileHeight,
    firstTile.codedPlanes.y,
  );
  const chromaWidth = outputWidth / subsampling.width;
  const chromaHeight = outputHeight / subsampling.height;
  const codedChromaWidth = codedTileWidth / subsampling.width;
  const codedChromaHeight = codedTileHeight / subsampling.height;
  const cb = firstTile.codedPlanes.cb.length
    ? copyPlane(
        'cb',
        originX / subsampling.width,
        originY / subsampling.height,
        chromaWidth,
        chromaHeight,
        codedChromaWidth,
        codedChromaHeight,
        firstTile.codedPlanes.cb,
      )
    : firstTile.codedPlanes.cb.slice();
  const cr = firstTile.codedPlanes.cr.length
    ? copyPlane(
        'cr',
        originX / subsampling.width,
        originY / subsampling.height,
        chromaWidth,
        chromaHeight,
        codedChromaWidth,
        codedChromaHeight,
        firstTile.codedPlanes.cr,
      )
    : firstTile.codedPlanes.cr.slice();
  if (
    !y ||
    (firstTile.codedPlanes.cb.length > 0 && !cb) ||
    (firstTile.codedPlanes.cr.length > 0 && !cr)
  )
    return undefined;

  const motionMaps: Partial<Pick<Planes, MotionMapKey>> = {};
  const firstCoded = firstTile.codedPlanes;
  const outputMapWidth = Math.ceil(outputWidth / 4);
  const outputMapHeight = Math.ceil(outputHeight / 4);
  for (const key of MOTION_MAP_KEYS) {
    const firstMap = layout.tiles.find((tile) => tile?.codedPlanes?.[key])?.codedPlanes?.[key] as
      | MotionMap
      | undefined;
    if (!firstMap) continue;
    const output = createMotionMap(firstMap, outputMapWidth * outputMapHeight);
    output.fill(0);
    for (let row = 0; row < outputMapHeight; row++) {
      for (let column = 0; column < outputMapWidth; column++) {
        const location = sourceTileAt(originX + column * 4, originY + row * 4, 1, 1);
        const tileIndex = location.index;
        const tile = layout.tiles[tileIndex];
        if (!tile?.codedPlanes)
          throw new HeicError(
            'UNSUPPORTED_FEATURE',
            `heic: cropped tili reference tile ${tileIndex} has no coded ${key} map`,
          );
        const codedX = location.localX + tile.sps.cropLeft * subsampling.width;
        const codedY = location.localY + tile.sps.cropTop * subsampling.height;
        const sourceMap = tile.codedPlanes[key] as MotionMap | undefined;
        if (sourceMap) {
          const tileMapWidth = tile.sps.picWidthInLumaSamples / 4;
          const tileMapHeight = tile.sps.picHeightInLumaSamples / 4;
          if (sourceMap.length !== tileMapWidth * tileMapHeight)
            throw new HeicError(
              'INVALID_BITSTREAM',
              `heic: cropped tili reference tile ${tileIndex} has an invalid ${key} map`,
            );
          const sourceMapX = Math.floor(codedX / 4);
          const sourceMapY = Math.floor(codedY / 4);
          if (
            sourceMapX < 0 ||
            sourceMapY < 0 ||
            sourceMapX >= tileMapWidth ||
            sourceMapY >= tileMapHeight
          )
            return undefined;
          output[row * outputMapWidth + column] = sourceMap[sourceMapY * tileMapWidth + sourceMapX];
          usedTiles.add(tileIndex);
        }
      }
    }
    Object.assign(motionMaps, { [key]: output });
  }

  return {
    ...motionMaps,
    y,
    cb: cb as Uint8Array | Uint16Array,
    cr: cr as Uint8Array | Uint16Array,
    width: outputWidth,
    height: outputHeight,
    chromaFormatIdc: firstCoded.chromaFormatIdc,
    bitDepthLuma: firstCoded.bitDepthLuma,
    bitDepthChroma: firstCoded.bitDepthChroma,
    hasExternalInterMotion: [...usedTiles].some(
      (tileIndex) => layout.tiles[tileIndex]?.codedPlanes?.hasExternalInterMotion,
    ),
    pictureOrderCntLsb: reference.pictureOrderCntLsb,
    pictureOrderCnt: reference.pictureOrderCnt,
    temporalId: reference.temporalId,
    sourceSps: firstTile.sps,
    sourceColor: reference.sourceColor,
    sourceIcc: reference.sourceIcc,
    sourceIccType: reference.sourceIccType,
    sourceChromaSampleLocation: reference.sourceChromaSampleLocation,
  };
}

export interface DecodeItemPlanesOptions {
  externalTileData?: Readonly<Record<string, Uint8Array>>;
  externalItemData?: Readonly<Record<number, Uint8Array>>;
  externalBaseLayerPlanes?: Readonly<Record<number, ExternalBaseLayerPlanes>>;
  extraDimensionIndexes?: readonly number[];
}

function checkedExternalBaseLayerPlanes(input: ExternalBaseLayerPlanes, itemId: number): Planes {
  if (!input || typeof input !== 'object')
    throw new HeicError(
      'INVALID_OPTIONS',
      `heic: externalBaseLayerPlanes item ${itemId} must be an object`,
    );
  const { width, height, chromaFormatIdc, bitDepthLuma, bitDepthChroma, y, cb, cr } = input;
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width * height > 50_000_000 ||
    ![0, 1, 2, 3].includes(chromaFormatIdc) ||
    !isHeifHevcBitDepth(bitDepthLuma) ||
    !isHeifHevcBitDepth(bitDepthChroma)
  )
    throw new HeicError(
      'INVALID_OPTIONS',
      `heic: externalBaseLayerPlanes item ${itemId} has invalid format metadata`,
    );
  if (
    input.color &&
    (![input.color.primaries, input.color.transfer, input.color.matrix].every(
      (value) => Number.isInteger(value) && value >= 0 && value <= 255,
    ) ||
      typeof input.color.fullRange !== 'boolean')
  )
    throw new HeicError(
      'INVALID_OPTIONS',
      `heic: externalBaseLayerPlanes item ${itemId} has invalid color metadata`,
    );
  if (
    input.chromaSampleLocation &&
    (![0, 0.5].includes(input.chromaSampleLocation.x) ||
      ![0, 0.5, 1].includes(input.chromaSampleLocation.y))
  )
    throw new HeicError(
      'INVALID_OPTIONS',
      `heic: externalBaseLayerPlanes item ${itemId} has invalid chroma sample location`,
    );
  const sampleType = bitDepthLuma <= 8 ? Uint8Array : Uint16Array;
  const chromaSampleType = bitDepthChroma <= 8 ? Uint8Array : Uint16Array;
  const sub = chromaSubsampling(chromaFormatIdc);
  const chromaLength =
    chromaFormatIdc === 0 ? 0 : Math.ceil(width / sub.width) * Math.ceil(height / sub.height);
  if (
    !(y instanceof sampleType) ||
    y.length !== width * height ||
    (chromaFormatIdc === 0
      ? !(cb instanceof chromaSampleType) ||
        !(cr instanceof chromaSampleType) ||
        cb.length !== 0 ||
        cr.length !== 0
      : !(cb instanceof chromaSampleType) ||
        !(cr instanceof chromaSampleType) ||
        cb.length !== chromaLength ||
        cr.length !== chromaLength)
  )
    throw new HeicError(
      'INVALID_OPTIONS',
      `heic: externalBaseLayerPlanes item ${itemId} has invalid sample planes`,
    );
  return {
    width,
    height,
    chromaFormatIdc,
    bitDepthLuma,
    bitDepthChroma,
    y,
    cb,
    cr,
    sourceColor: input.color,
    sourceChromaSampleLocation: input.chromaSampleLocation,
    hasExternalInterMotion: false,
    pictureOrderCntLsb: 0,
    pictureOrderCnt: 0,
    temporalId: 0,
  };
}

function checkedAvcItemPlanes(
  input: ExternalBaseLayerPlanes,
  info: HeicInfo,
  itemId: number,
): Planes {
  const planes = checkedExternalBaseLayerPlanes(input, itemId);
  if (!info.avcC) throw new HeicError('INVALID_CONTAINER', `heic: avc1 item ${itemId} has no avcC`);
  if (info.width <= 0 || info.height <= 0)
    throw new HeicError('INVALID_CONTAINER', `heic: avc1 item ${itemId} has no valid ispe size`);
  if (planes.width !== info.width || planes.height !== info.height)
    throw new HeicError(
      'INVALID_OPTIONS',
      `heic: externalBaseLayerPlanes item ${itemId} dimensions disagree with ispe`,
    );
  if (info.avcC.chromaFormatIdc !== null && planes.chromaFormatIdc !== info.avcC.chromaFormatIdc)
    throw new HeicError(
      'INVALID_OPTIONS',
      `heic: externalBaseLayerPlanes item ${itemId} chroma format disagrees with avcC`,
    );
  if (
    (info.avcC.bitDepthLumaMinus8 !== null &&
      planes.bitDepthLuma !== info.avcC.bitDepthLumaMinus8 + 8) ||
    (info.avcC.bitDepthChromaMinus8 !== null &&
      planes.bitDepthChroma !== info.avcC.bitDepthChromaMinus8 + 8)
  )
    throw new HeicError(
      'INVALID_OPTIONS',
      `heic: externalBaseLayerPlanes item ${itemId} bit depth disagrees with avcC`,
    );
  return planes;
}

function decodeFilteredPicture(
  slices: Uint8Array[],
  sps: SpsInfo,
  pps: ReturnType<typeof parsePps>,
  references: readonly ReferenceImage[] = [],
  currentPictureOrderCnt = 0,
  referencesL1: readonly ReferenceImage[] = [],
  referenceListsForSlice?: (header: SliceHeader) => {
    l0: readonly ReferenceImage[];
    l1?: readonly ReferenceImage[];
  },
) {
  const pic = new PictureDecoder(sps, pps, references, currentPictureOrderCnt, referencesL1).decode(
    slices,
    referenceListsForSlice,
  );
  // In-loop filters run on the fully reconstructed tile: deblock first, then
  // SAO reads the deblocked samples (8.7).
  deblockPicture(pic, pps, sps.bitDepthLuma, sps.bitDepthChroma);
  applySao(pic, sps, sps.bitDepthLuma, sps.bitDepthChroma);
  return pic;
}

export function decodeItemPlanes(
  buffer: Uint8Array,
  boxes: ISOBMFFBox[],
  info: HeicInfo,
  itemId: number,
  options: DecodeItemPlanesOptions = {},
): Planes {
  return decodeItemPlanesRecursive(
    buffer,
    boxes,
    info,
    itemId,
    new Map(),
    new Map(),
    new Map(),
    new Set(),
    new Set(),
    options,
  );
}

function decodeItemPlanesRecursive(
  buffer: Uint8Array,
  boxes: ISOBMFFBox[],
  fallbackInfo: HeicInfo,
  itemId: number,
  decoded: Map<number, Planes>,
  decodedLayersByItem: Map<number, Map<number, Planes>>,
  decodedTiliLayersByItem: Map<number, DecodedTiliLayerLayout>,
  captureTiliLayerReferences: Set<number>,
  active: Set<number>,
  options: DecodeItemPlanesOptions,
): Planes {
  const cached = decoded.get(itemId);
  if (cached) return cached;
  if (active.has(itemId))
    throw new HeicError(
      'INVALID_CONTAINER',
      `heic: predictive reference cycle includes item ${itemId}`,
    );
  active.add(itemId);

  const itemInfo = getHeicInfo(buffer, boxes, itemId);
  const payload = getItemPayload(buffer, boxes, itemId, options.externalItemData);
  if (itemInfo.primaryItemType === 'avc1') {
    if (!payload)
      throw new HeicError('INVALID_CONTAINER', `heic: avc1 item ${itemId} has no coded payload`);
    const suppliedPlanes = options.externalBaseLayerPlanes?.[itemId];
    if (!suppliedPlanes)
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        `heic: synchronous AVC decoding is unavailable for avc1 item ${itemId}; use async decode() or provide externalBaseLayerPlanes`,
      );
    const result = checkedAvcItemPlanes(suppliedPlanes, itemInfo, itemId);
    active.delete(itemId);
    decoded.set(itemId, result);
    decodedLayersByItem.set(itemId, new Map([[0, result]]));
    return result;
  }
  if (itemInfo.primaryItemType === 'lhv1') {
    if (!payload) throw new Error(`heic: item ${itemId} has no payload`);
    const lhevc = itemInfo.lhevc;
    if (!lhevc)
      throw new HeicError('INVALID_CONTAINER', 'heic: lhv1 item has no parsed layer configuration');
    const parameterSetNals = lhevc.configuration.arrays.flatMap((array) =>
      array.nalUnits.map((nal) => ({
        type: array.nalUnitType as NalType,
        layerId: nal.layerId,
        data: nal.data,
      })),
    );
    const accessUnitNals = splitLengthPrefixed(
      payload,
      lhevc.configuration.nalLengthSize,
      false,
      lhevc.requiredLayerIds,
    );
    for (const referenceId of itemInfo.predReferenceItemIds ?? [])
      decodeItemPlanesRecursive(
        buffer,
        boxes,
        fallbackInfo,
        referenceId,
        decoded,
        decodedLayersByItem,
        decodedTiliLayersByItem,
        captureTiliLayerReferences,
        active,
        options,
      );
    const temporalReferencesByLayer = new Map<number, Planes[]>();
    for (const layerId of lhevc.requiredLayerIds) {
      const temporalReferences = (itemInfo.predReferenceItemIds ?? []).flatMap((referenceId) => {
        const reference = decodedLayersByItem.get(referenceId)?.get(layerId);
        return reference ? [reference] : [];
      });
      if (temporalReferences.length > 0) temporalReferencesByLayer.set(layerId, temporalReferences);
    }
    let externalBaseLayer: Planes | undefined;
    if (itemInfo.externalBaseLayerItemId !== undefined) {
      const baseItemId = itemInfo.externalBaseLayerItemId;
      const suppliedPlanes = options.externalBaseLayerPlanes?.[baseItemId];
      if (suppliedPlanes) {
        const meta = findBox(boxes, 'meta');
        const iinf = meta?.children && findBox(meta.children, 'iinf');
        const baseItem = iinf
          ? parseIinf(iinf.data).find((item) => item.itemId === baseItemId)
          : null;
        if (!baseItem)
          throw new HeicError('INVALID_CONTAINER', `heic: exbl base item ${baseItemId} is missing`);
        if (baseItem.itemType !== 'avc1')
          throw new HeicError(
            'INVALID_OPTIONS',
            `heic: externalBaseLayerPlanes item ${baseItemId} is not an avc1 image`,
          );
        externalBaseLayer = checkedAvcItemPlanes(
          suppliedPlanes,
          getHeicInfo(buffer, boxes, baseItemId),
          baseItemId,
        );
      } else {
        const externalBaseInfo = getHeicInfo(buffer, boxes, baseItemId);
        if (!['hvc1', 'lhv1', 'tili'].includes(externalBaseInfo.primaryItemType))
          throw new HeicError(
            'UNSUPPORTED_FEATURE',
            'heic: exbl base item does not use a supported HEVC image path',
          );
        externalBaseLayer = decodeItemPlanesRecursive(
          buffer,
          boxes,
          fallbackInfo,
          baseItemId,
          decoded,
          decodedLayersByItem,
          decodedTiliLayersByItem,
          captureTiliLayerReferences,
          active,
          options,
        );
      }
    }
    const decodedLayers = new Map<number, Planes>();
    const result = decodeLayeredHevcPicture(
      [...parameterSetNals, ...accessUnitNals],
      lhevc.requiredLayerIds,
      lhevc.targetLayerId,
      externalBaseLayer,
      temporalReferencesByLayer,
      decodedLayers,
    );
    active.delete(itemId);
    decoded.set(itemId, result);
    decodedLayersByItem.set(itemId, decodedLayers);
    return result;
  }
  if (itemInfo.primaryItemType === 'tili') {
    const tiledImage = itemInfo.tiledImage;
    if (!tiledImage)
      throw new HeicError('INVALID_CONTAINER', `heic: tili item ${itemId} has no tile metadata`);
    if (!payload && !tiledImage.dataReference.externalTileUrls)
      throw new HeicError('INVALID_CONTAINER', `heic: tili item ${itemId} has no payload`);
    const referenceIds = itemInfo.predReferenceItemIds ?? [];
    for (const referenceId of referenceIds) captureTiliLayerReferences.add(referenceId);
    const referencePlanes = referenceIds.map((referenceId) =>
      decodeItemPlanesRecursive(
        buffer,
        boxes,
        fallbackInfo,
        referenceId,
        decoded,
        decodedLayersByItem,
        decodedTiliLayersByItem,
        captureTiliLayerReferences,
        active,
        options,
      ),
    );
    const referenceLayersByItem = referenceIds.map((referenceId) => {
      const layers = decodedLayersByItem.get(referenceId);
      if (layers) return layers;
      const reference = decoded.get(referenceId);
      if (!reference)
        throw new HeicError(
          'INVALID_CONTAINER',
          `heic: tili pred reference item ${referenceId} was not decoded`,
        );
      return new Map([[0, reference]]);
    });
    const decodedLayers = new Map<number, Planes>();
    const decodedTiliTileLayers = captureTiliLayerReferences.has(itemId)
      ? new Map<number, Map<number, Planes>>()
      : undefined;
    const result = stitchTiledImage(
      buffer,
      boxes,
      itemInfo,
      tiledImage,
      options.externalTileData,
      options.extraDimensionIndexes,
      referencePlanes,
      referenceLayersByItem,
      decodedLayers,
      referenceIds.map((referenceId) => decodedTiliLayersByItem.get(referenceId)),
      decodedTiliTileLayers,
    );
    active.delete(itemId);
    decoded.set(itemId, result);
    if (decodedTiliTileLayers) {
      decodedTiliLayersByItem.set(itemId, {
        itemId,
        ...(itemInfo.relativeLocation ? { relativeLocation: itemInfo.relativeLocation } : {}),
        columns: tiledImage.columns,
        rows: tiledImage.rows,
        tileWidth: tiledImage.tileWidth,
        tileHeight: tiledImage.tileHeight,
        extraDimensionSizes: [...tiledImage.extraDimensionSizes],
        selectedExtraDimensionIndexes: [
          ...(options.extraDimensionIndexes ?? tiledImage.extraDimensionSizes.map(() => 0)),
        ],
        selectedTileIndexes: getTiledImageTileIndices(tiledImage, options.extraDimensionIndexes),
        tilesByIndex: decodedTiliTileLayers,
      });
    }
    if (decodedLayers.size > 0) decodedLayersByItem.set(itemId, decodedLayers);
    else if (itemInfo.lhevc)
      decodedLayersByItem.set(itemId, new Map([[itemInfo.lhevc.targetLayerId, result]]));
    else decodedLayersByItem.set(itemId, new Map([[0, result]]));
    return result;
  }
  if (!payload) throw new Error(`heic: item ${itemId} has no payload`);
  const config =
    itemInfo.hvcC ?? (itemId === fallbackInfo.primaryItemId ? fallbackInfo.hvcC : null);
  if (!config)
    throw new HeicError('INVALID_CONTAINER', `heic: item ${itemId} has no HEVC configuration`);
  const referenceIds = itemInfo.predReferenceItemIds ?? [];
  const referencePlanes = referenceIds.map((referenceId) =>
    decodeItemPlanesRecursive(
      buffer,
      boxes,
      fallbackInfo,
      referenceId,
      decoded,
      decodedLayersByItem,
      decodedTiliLayersByItem,
      captureTiliLayerReferences,
      active,
      options,
    ),
  );
  const result = decodeHevcPayload(
    payload,
    config,
    referencePlanes,
    `item ${itemId}`,
    itemInfo.primaryItemType === 'hvc1',
  );
  active.delete(itemId);
  decoded.set(itemId, result);
  decodedLayersByItem.set(itemId, new Map([[0, result]]));
  return result;
}

/** Decode one independently coded HEVC item or tili tile payload. */
export function decodeHevcPayload(
  payload: Uint8Array,
  config: HvcCConfig,
  referencePlanes: readonly Planes[] = [],
  label = 'tile',
  baseLayerOnly = false,
): Planes {
  const nals = splitLengthPrefixed(payload, config.nalLengthSize, baseLayerOnly);
  const sliceNals = nals.filter((n) => isSliceNal(n.type));
  const slices = sliceNals.map((n) => n.data);
  if (slices.length === 0)
    throw new HeicError('INVALID_BITSTREAM', `heic: ${label} carries no coded slices`);

  const firstSlice = sliceNals[0];
  const { pps, sps } = parseActiveParameterSets(firstSlice.data, config, label, baseLayerOnly);
  const header = parseSliceHeader(slices[0], sps, pps);
  const temporalId = sliceNals[0].data.length > 1 ? (sliceNals[0].data[1] & 7) - 1 : 0;
  if (header.sliceType === SLICE_TYPE_P || header.sliceType === SLICE_TYPE_B) {
    for (const reference of referencePlanes)
      if (
        reference.width < sps.picWidthInLumaSamples ||
        reference.height < sps.picHeightInLumaSamples
      )
        throw new HeicError(
          'UNSUPPORTED_FEATURE',
          `heic: ${label} pred reference does not cover the coded picture dimensions`,
        );
  }
  let previousTid0PictureOrderCnt: number | null = null;
  for (const reference of referencePlanes) {
    if (reference.temporalId === 0 && reference.pictureOrderCnt !== undefined)
      previousTid0PictureOrderCnt = reference.pictureOrderCnt;
  }
  const currentPictureOrderCnt = derivePictureOrderCnt(sps, header, previousTid0PictureOrderCnt);
  let decodingOrderReferences: PictureReference[] = [];
  if (header.sliceType === SLICE_TYPE_P || header.sliceType === SLICE_TYPE_B) {
    decodingOrderReferences = referencePlanes.map((reference) => {
      if (reference.pictureOrderCntLsb === undefined || reference.pictureOrderCnt === undefined)
        throw new HeicError(
          'INVALID_CONTAINER',
          'heic: pred item has no parsed picture order count',
        );
      return {
        ...reference,
        pictureOrderCntLsb: reference.pictureOrderCntLsb,
        pictureOrderCnt: reference.pictureOrderCnt,
        isLongTermReference: false,
      };
    });
  } else if (referencePlanes.length > 0) {
    throw new HeicError('INVALID_CONTAINER', 'heic: intra item cannot carry pred references');
  }
  const referenceListsForSlice = (sliceHeader: SliceHeader) => {
    if (sliceHeader.sliceType === SLICE_TYPE_P) {
      return {
        l0: buildReferenceList0(sps, sliceHeader, currentPictureOrderCnt, decodingOrderReferences),
        l1: [],
      };
    }
    if (sliceHeader.sliceType === SLICE_TYPE_B) {
      const currentPicture = sliceHeader.currentPictureReferenceEnabled
        ? createCurrentPictureReference(sps, currentPictureOrderCnt)
        : undefined;
      return buildBReferenceLists(
        sps,
        sliceHeader,
        currentPictureOrderCnt,
        decodingOrderReferences,
        currentPicture,
      );
    }
    return { l0: [], l1: [] };
  };
  const initialReferenceLists = referenceListsForSlice(header);
  const pic = decodeFilteredPicture(
    slices,
    sps,
    pps,
    initialReferenceLists.l0,
    currentPictureOrderCnt,
    initialReferenceLists.l1,
    referenceListsForSlice,
  );
  const hasInterMotion = pic.interMap.some((value) => value === 1);
  const result: Planes = {
    y: pic.y,
    cb: pic.cb,
    cr: pic.cr,
    width: pic.width,
    height: pic.height,
    chromaFormatIdc: sps.chromaFormatIdc,
    bitDepthLuma: sps.bitDepthLuma,
    bitDepthChroma: sps.bitDepthChroma,
    hasExternalInterMotion: pic.hasExternalInterMotion,
    ...(hasInterMotion
      ? {
          interMap: pic.interMap,
          motionIsExternal: pic.motionIsExternal,
          motionPredFlags: pic.motionPredFlags,
          motionXQpel: pic.motionXQpel,
          motionYQpel: pic.motionYQpel,
          motionRefIdxL0: pic.motionRefIdxL0,
          motionRefPoc: pic.motionRefPoc,
          motionRefLongTerm: pic.motionRefLongTerm,
          motionRefLayerId: pic.motionRefLayerId,
          motionXQpelL1: pic.motionXQpelL1,
          motionYQpelL1: pic.motionYQpelL1,
          motionRefIdxL1: pic.motionRefIdxL1,
          motionRefPocL1: pic.motionRefPocL1,
          motionRefLongTermL1: pic.motionRefLongTermL1,
          motionRefLayerIdL1: pic.motionRefLayerIdL1,
        }
      : {}),
    pictureOrderCntLsb: header.pictureOrderCntLsb ?? 0,
    pictureOrderCnt: currentPictureOrderCnt,
    temporalId,
    sourceSps: sps,
  };
  return result;
}

/** Resolve the SPS activated by a payload's first coded slice. */
export function getActiveSpsFromPayload(
  payload: Uint8Array,
  config: HvcCConfig,
  label = 'item',
  baseLayerOnly = false,
): SpsInfo {
  const slice = splitLengthPrefixed(payload, config.nalLengthSize, baseLayerOnly).find((nal) =>
    isSliceNal(nal.type),
  );
  if (!slice) throw new HeicError('INVALID_BITSTREAM', `heic: ${label} carries no coded slices`);
  return parseActiveParameterSets(slice.data, config, label, baseLayerOnly).sps;
}

function parseActiveParameterSets(
  slice: Uint8Array,
  config: HvcCConfig,
  label: string,
  baseLayerOnly: boolean,
): { pps: ReturnType<typeof parsePps>; sps: SpsInfo } {
  if (!config.pps.length)
    throw new HeicError('INVALID_CONTAINER', `heic: ${label} has no PPS in hvcC`);
  const active = selectActiveHevcParameterSetNals(slice, config.pps, config.sps, label);
  const pps = parsePps(active.pps, {
    allowBaseLayerMultilayerExtension: baseLayerOnly,
  });
  const sps = parseSps(active.sps, { allowBaseLayerMultilayerExtension: baseLayerOnly });
  if (
    sps.bitDepthLuma !== config.bitDepthLumaMinus8 + 8 ||
    sps.bitDepthChroma !== config.bitDepthChromaMinus8 + 8
  )
    throw new HeicError('INVALID_CONTAINER', `heic: ${label} SPS bit depths disagree with hvcC`);
  return { pps, sps };
}

export function stitchGrid(
  buffer: Uint8Array,
  boxes: ISOBMFFBox[],
  info: HeicInfo,
  grid: GridInfo,
  options: DecodeItemPlanesOptions = {},
): Planes {
  if (grid.tileItemIds.length !== grid.rows * grid.columns || grid.tileItemIds.length > 4096)
    throw new Error('heic: invalid or oversized grid');
  const tileW = grid.tileWidth;
  const tileH = grid.tileHeight;
  const canvasW = grid.columns * tileW;
  const canvasH = grid.rows * tileH;
  if (
    !Number.isSafeInteger(tileW) ||
    !Number.isSafeInteger(tileH) ||
    tileW <= 0 ||
    tileH <= 0 ||
    !Number.isSafeInteger(canvasW * canvasH) ||
    canvasW * canvasH > 50_000_000
  )
    throw new RangeError('heic: padded grid exceeds pixel limit');
  const firstTileInfo = getHeicInfo(buffer, boxes, grid.tileItemIds[0]);
  const decoded = new Map<number, Planes>();
  const decodedLayersByItem = new Map<number, Map<number, Planes>>();
  const decodedTiliLayersByItem = new Map<number, DecodedTiliLayerLayout>();
  const captureTiliLayerReferences = new Set<number>();
  const decodeGridTile = (itemId: number) =>
    decodeItemPlanesRecursive(
      buffer,
      boxes,
      info,
      itemId,
      decoded,
      decodedLayersByItem,
      decodedTiliLayersByItem,
      captureTiliLayerReferences,
      new Set(),
      options,
    );
  const firstRaw = decodeGridTile(grid.tileItemIds[0]);
  const firstTileConfig = firstTileInfo.hvcC ?? info.hvcC;
  const firstSps =
    firstRaw.sourceSps ??
    (firstTileConfig
      ? parseSps(firstTileConfig.sps[0], {
          allowBaseLayerMultilayerExtension: firstTileInfo.primaryItemType === 'hvc1',
        })
      : null);
  if (!firstSps)
    throw new HeicError('INVALID_CONTAINER', 'heic: first grid tile has no HEVC configuration');
  const LumaSamples = firstSps.bitDepthLuma === 8 ? Uint8Array : Uint16Array;
  const ChromaSamples = firstSps.bitDepthChroma === 8 ? Uint8Array : Uint16Array;
  const y = new LumaSamples(canvasW * canvasH);
  const chromaFormatIdc = firstSps.chromaFormatIdc,
    sub = chromaSubsampling(chromaFormatIdc);
  const chroma = chromaFormatIdc !== 0;
  const cCanvasW = Math.ceil(canvasW / sub.width);
  const cCanvasH = Math.ceil(canvasH / sub.height);
  const cb = new ChromaSamples(chroma ? cCanvasW * cCanvasH : 0);
  const cr = new ChromaSamples(cb.length);
  let hasExternalInterMotion = false;
  let firstDecodedSps: SpsInfo | null = null;

  for (let t = 0; t < grid.tileItemIds.length; t++) {
    const itemId = grid.tileItemIds[t],
      tileInfo = getHeicInfo(buffer, boxes, itemId),
      raw = t === 0 ? firstRaw : decodeGridTile(itemId),
      tileSps =
        raw.sourceSps ??
        parseSps(tileInfo.hvcC!.sps[0], {
          allowBaseLayerMultilayerExtension: tileInfo.primaryItemType === 'hvc1',
        }),
      tileSub = chromaSubsampling(tileSps.chromaFormatIdc);
    if (t === 0) firstDecodedSps = tileSps;
    const tile = cropPlanes(
      raw,
      tileSub.width * tileSps.cropLeft,
      tileSub.height * tileSps.cropTop,
      tileSps.width,
      tileSps.height,
    );
    hasExternalInterMotion ||= tile.hasExternalInterMotion;
    if (tile.width !== tileW || tile.height !== tileH)
      throw new Error(
        `heic: tile ${t} is ${tile.width}x${tile.height}, expected ${tileW}x${tileH}`,
      );
    if (
      tileSps.bitDepthLuma !== firstSps.bitDepthLuma ||
      tileSps.bitDepthChroma !== firstSps.bitDepthChroma ||
      tileSps.chromaFormatIdc !== chromaFormatIdc
    )
      throw new HeicError('INVALID_CONTAINER', 'heic: grid tiles do not share one HEVC format');
    const tx = (t % grid.columns) * tileW;
    const ty = Math.floor(t / grid.columns) * tileH;
    for (let row = 0; row < tileH; row++)
      y.set(tile.y.subarray(row * tileW, (row + 1) * tileW), (ty + row) * canvasW + tx);
    const cTileW = Math.ceil(tileW / sub.width);
    for (let row = 0; cb.length && row < Math.ceil(tileH / sub.height); row++) {
      const src = row * cTileW;
      const dst = (Math.floor(ty / sub.height) + row) * cCanvasW + Math.floor(tx / sub.width);
      cb.set(tile.cb.subarray(src, src + cTileW), dst);
      cr.set(tile.cr.subarray(src, src + cTileW), dst);
    }
  }
  return {
    y,
    cb,
    cr,
    width: canvasW,
    height: canvasH,
    chromaFormatIdc,
    bitDepthLuma: firstSps.bitDepthLuma,
    bitDepthChroma: firstSps.bitDepthChroma,
    hasExternalInterMotion,
    sourceSps: firstDecodedSps ?? firstSps,
  };
}

export function stitchTiledImage(
  buffer: Uint8Array,
  boxes: ISOBMFFBox[],
  info: HeicInfo,
  tiledImage: TiledImageInfo,
  externalTileData?: Readonly<Record<string, Uint8Array>>,
  extraDimensionIndexes?: readonly number[],
  referencePlanes: readonly Planes[] = [],
  referenceLayersByItem: readonly ReadonlyMap<number, Planes>[] = [],
  decodedLayersOutput?: Map<number, Planes>,
  referenceTiliLayersByItem: readonly (DecodedTiliLayerLayout | undefined)[] = [],
  decodedTiliLayersOutput?: Map<number, Map<number, Planes>>,
): Planes {
  if (tiledImage.dataReference.externalTileUrls)
    return stitchExternalTiledImage(
      info,
      tiledImage,
      externalTileData,
      extraDimensionIndexes,
      referencePlanes,
      referenceLayersByItem,
      decodedLayersOutput,
      referenceTiliLayersByItem,
      decodedTiliLayersOutput,
    );
  const lhevc = info.lhevc;
  const hvcC = info.hvcC;
  if (!lhevc && !hvcC)
    throw new HeicError('INVALID_CONTAINER', 'heic: tili item has no HEVC tile configuration');
  if (lhevc && tiledImage.tileItemType !== 'lhv1')
    throw new HeicError(
      'INVALID_CONTAINER',
      'heic: L-HEVC tile configuration has a mismatched type',
    );
  if (!lhevc && tiledImage.tileItemType === 'lhv1')
    throw new HeicError('INVALID_CONTAINER', 'heic: lhv1 tiles have no L-HEVC configuration');
  const itemData = getItemPayload(buffer, boxes, info.primaryItemId);
  if (!itemData) throw new HeicError('INVALID_CONTAINER', 'heic: tili item has no tile data');
  const tileCount = tiledImage.dataReference.inputItemCount;
  const ranges = parseTiledItemRanges(itemData, tiledImage.dataReference, tileCount);
  const selectedTileIndexes = getTiledImageTileIndices(tiledImage, extraDimensionIndexes);
  const selectedExtraDimensionIndexes =
    extraDimensionIndexes ?? tiledImage.extraDimensionSizes.map(() => 0);
  if (lhevc && referencePlanes.length > 0) {
    if (referenceLayersByItem.length !== referencePlanes.length)
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        'heic: L-HEVC tili pred references do not have per-item layer data',
      );
    const requiresTiledReferences =
      tiledImage.columns !== 1 || tiledImage.rows !== 1 || selectedTileIndexes.length !== 1;
    const hasTiledReferences = referenceTiliLayersByItem.some(Boolean);
    if (requiresTiledReferences || hasTiledReferences) {
      if (referenceTiliLayersByItem.length !== referencePlanes.length)
        throw new HeicError(
          'UNSUPPORTED_FEATURE',
          'heic: L-HEVC tili pred requires per-item tiled reference layouts',
        );
      for (
        let referenceIndex = 0;
        referenceIndex < referenceTiliLayersByItem.length;
        referenceIndex++
      ) {
        const referenceLayout = referenceTiliLayersByItem[referenceIndex];
        if (!referenceLayout && requiresTiledReferences)
          throw new HeicError(
            'UNSUPPORTED_FEATURE',
            'heic: multi-tile L-HEVC pred requires tiled L-HEVC reference items',
          );
        if (
          referenceLayout &&
          !canReuseTiliLayerLayout(
            referenceLayout,
            tiledImage,
            selectedExtraDimensionIndexes,
            info,
            info.predReferenceItemIds?.[referenceIndex],
          )
        )
          throw new HeicError(
            'UNSUPPORTED_FEATURE',
            'heic: L-HEVC tili pred requires matching tile sizes and a sample-aligned in-bounds reference region',
          );
      }
    }
  }
  const firstCodedRange = selectedTileIndexes
    .map((index) => ranges[index])
    .find((range) => range !== null && range !== undefined);
  let firstSps: SpsInfo;
  if (lhevc) {
    const targetSps = lhevc.configuration.arrays
      .filter((array) => array.nalUnitType === 33)
      .flatMap((array) => array.nalUnits)
      .find((nal) => nal.layerId === lhevc.targetLayerId);
    if (!targetSps)
      throw new HeicError('INVALID_CONTAINER', 'heic: L-HEVC tile configuration has no target SPS');
    firstSps = parseSps(targetSps.data, {
      allowBaseLayerMultilayerExtension: true,
      layeredVps: lhevc.selectedVps ?? undefined,
    });
  } else {
    firstSps = firstCodedRange
      ? getActiveSpsFromPayload(
          itemData.subarray(
            firstCodedRange.offset,
            firstCodedRange.offset + firstCodedRange.length,
          ),
          hvcC!,
          'first tili tile',
          tiledImage.tileItemType === 'hvc1',
        )
      : parseSps(hvcC!.sps[0], {
          allowBaseLayerMultilayerExtension: tiledImage.tileItemType === 'hvc1',
        });
  }
  if (!isHeifHevcBitDepth(firstSps.bitDepthLuma) || !isHeifHevcBitDepth(firstSps.bitDepthChroma))
    throw new HeicError('UNSUPPORTED_FEATURE', 'heic: tili bit depth is not supported');
  const LumaSamples = firstSps.bitDepthLuma === 8 ? Uint8Array : Uint16Array;
  const ChromaSamples = firstSps.bitDepthChroma === 8 ? Uint8Array : Uint16Array;
  const tileW = tiledImage.tileWidth;
  const tileH = tiledImage.tileHeight;
  const canvasW = tiledImage.columns * tileW;
  const canvasH = tiledImage.rows * tileH;
  if (
    !Number.isSafeInteger(canvasW * canvasH) ||
    canvasW * canvasH > 50_000_000 ||
    canvasW < info.width ||
    canvasH < info.height
  )
    throw new HeicError('RESOURCE_LIMIT', 'heic: padded tili image exceeds pixel limit');
  const chromaFormatIdc = firstSps.chromaFormatIdc;
  const sub = chromaSubsampling(chromaFormatIdc);
  const chromaWidth = Math.ceil(canvasW / sub.width);
  const chromaHeight = Math.ceil(canvasH / sub.height);
  const y = new LumaSamples(canvasW * canvasH);
  const cb = new ChromaSamples(chromaFormatIdc === 0 ? 0 : chromaWidth * chromaHeight);
  const cr = new ChromaSamples(cb.length);
  // ISO leaves rendering of empty/unspecified tiles to the reader. Use a
  // neutral black canvas so an empty tile is deterministic and does not tint
  // the output through zero-valued chroma samples.
  const fullRange = info.color?.fullRange ?? firstSps.color?.videoFullRange ?? false;
  y.fill(fullRange ? 0 : 16 << (firstSps.bitDepthLuma - 8));
  cb.fill(1 << (firstSps.bitDepthChroma - 1));
  cr.fill(1 << (firstSps.bitDepthChroma - 1));
  let hasExternalInterMotion = false;
  let decodedTile: Planes | null = null;
  const codedReferenceTiles: (CodedTiliReferenceTile | undefined)[] = new Array(
    selectedTileIndexes.length,
  );
  const stitchedMotionMaps: Partial<Pick<Planes, MotionMapKey>> = {};
  const canvasMapWidth = Math.ceil(canvasW / 4);
  const canvasMapHeight = Math.ceil(canvasH / 4);
  const lhevcParameterSets = lhevc
    ? lhevc.configuration.arrays.flatMap((array) =>
        array.nalUnits.map((nal) => ({
          type: array.nalUnitType as NalType,
          layerId: nal.layerId,
          data: nal.data,
        })),
      )
    : null;

  for (let spatialIndex = 0; spatialIndex < selectedTileIndexes.length; spatialIndex++) {
    const index = selectedTileIndexes[spatialIndex];
    const range = ranges[index];
    if (!range) continue;
    const tx = (spatialIndex % tiledImage.columns) * tileW;
    const ty = Math.floor(spatialIndex / tiledImage.columns) * tileH;
    const tilePayload = itemData.subarray(range.offset, range.offset + range.length);
    let tileSps: SpsInfo;
    let raw: Planes;
    let decodedTileLayers: Map<number, Planes> | undefined;
    if (lhevc) {
      const tileNals = splitLengthPrefixed(
        tilePayload,
        lhevc.configuration.nalLengthSize,
        false,
        lhevc.requiredLayerIds,
      );
      const temporalReferencesByLayer = new Map<number, Planes[]>();
      if (referencePlanes.length > 0) {
        const hasTiledReferences = referenceTiliLayersByItem.some((layout) => layout !== undefined);
        for (const layerId of lhevc.requiredLayerIds) {
          const temporalReferences = hasTiledReferences
            ? referenceTiliLayersByItem.map((layout, referenceIndex) => {
                const reference = layout
                  ? tiliLayerReferenceForTile(
                      layout,
                      tiledImage,
                      selectedExtraDimensionIndexes,
                      info,
                      info.predReferenceItemIds?.[referenceIndex],
                      spatialIndex,
                    )?.get(layerId)
                  : referenceLayersByItem[referenceIndex]?.get(layerId);
                if (!reference)
                  throw new HeicError(
                    'UNSUPPORTED_FEATURE',
                    `heic: L-HEVC tili pred item has no aligned decoded tile for layer ${layerId}`,
                  );
                return reference;
              })
            : referenceLayersByItem.flatMap((itemLayers) => {
                const reference = itemLayers.get(layerId);
                return reference ? [reference] : [];
              });
          if (temporalReferences.length > 0)
            temporalReferencesByLayer.set(layerId, temporalReferences);
        }
      }
      decodedTileLayers = new Map();
      raw = decodeLayeredHevcPicture(
        [...lhevcParameterSets!, ...tileNals],
        lhevc.requiredLayerIds,
        lhevc.targetLayerId,
        undefined,
        temporalReferencesByLayer,
        decodedTileLayers,
      );
      if (!raw.sourceSps)
        throw new HeicError('INVALID_BITSTREAM', `heic: L-HEVC tile ${index} has no active SPS`);
      tileSps = raw.sourceSps;
    } else {
      tileSps = getActiveSpsFromPayload(
        tilePayload,
        hvcC!,
        `tili tile ${index}`,
        tiledImage.tileItemType === 'hvc1',
      );
      const referenceExtent =
        referencePlanes.length > 0 ? tiliReferenceExtent(tileSps) : { width: tileW, height: tileH };
      const tileReferences = referencePlanes.map((reference, referenceIndex) =>
        tiliReferenceForTile(
          reference,
          tileSps,
          info,
          info.predReferenceItemIds?.[referenceIndex],
          tiledImage,
          selectedTileIndexes,
          selectedExtraDimensionIndexes,
          spatialIndex,
          tx,
          ty,
          referenceExtent.width,
          referenceExtent.height,
        ),
      );
      raw = decodeHevcPayload(
        tilePayload,
        hvcC!,
        tileReferences,
        `tili tile ${index}`,
        tiledImage.tileItemType === 'hvc1',
      );
    }
    if (
      tileSps.picWidthInLumaSamples !== raw.width ||
      tileSps.picHeightInLumaSamples !== raw.height
    )
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: in-file tili decoder output does not match the coded tile dimensions',
      );
    codedReferenceTiles[spatialIndex] = {
      sps: tileSps,
      ...(hasConformanceCrop(tileSps) ? { codedPlanes: raw } : {}),
    };
    if (
      tileSps.bitDepthLuma !== firstSps.bitDepthLuma ||
      tileSps.bitDepthChroma !== firstSps.bitDepthChroma ||
      tileSps.chromaFormatIdc !== chromaFormatIdc
    )
      throw new HeicError('INVALID_CONTAINER', 'heic: tili tiles do not share one HEVC format');
    const tile = cropPlanes(
      raw,
      sub.width * tileSps.cropLeft,
      sub.height * tileSps.cropTop,
      tileSps.width,
      tileSps.height,
    );
    if (
      lhevc &&
      (decodedTiliLayersOutput ||
        (decodedLayersOutput &&
          tiledImage.columns === 1 &&
          tiledImage.rows === 1 &&
          selectedTileIndexes.length === 1))
    ) {
      const croppedTileLayers = new Map<number, Planes>();
      for (const [layerId, layer] of decodedTileLayers ?? []) {
        const layerSps = layer.sourceSps;
        if (!layerSps)
          throw new HeicError(
            'INVALID_BITSTREAM',
            `heic: L-HEVC tile layer ${layerId} has no active SPS`,
          );
        const layerSub = chromaSubsampling(layerSps.chromaFormatIdc);
        const croppedLayer = cropPlanes(
          layer,
          layerSub.width * layerSps.cropLeft,
          layerSub.height * layerSps.cropTop,
          layerSps.width,
          layerSps.height,
        );
        croppedTileLayers.set(layerId, croppedLayer);
        if (
          decodedLayersOutput &&
          tiledImage.columns === 1 &&
          tiledImage.rows === 1 &&
          selectedTileIndexes.length === 1
        )
          decodedLayersOutput.set(layerId, croppedLayer);
      }
      if (croppedTileLayers.size > 0) decodedTiliLayersOutput?.set(index, croppedTileLayers);
    } else if (decodedTiliLayersOutput) decodedTiliLayersOutput.set(index, new Map([[0, tile]]));
    if (tile.width !== tileW || tile.height !== tileH)
      throw new HeicError(
        'INVALID_BITSTREAM',
        `heic: tili tile ${index} is ${tile.width}x${tile.height}, expected ${tileW}x${tileH}`,
      );
    hasExternalInterMotion ||= tile.hasExternalInterMotion;
    if (!decodedTile) decodedTile = tile;
    else if (
      tile.pictureOrderCntLsb !== decodedTile.pictureOrderCntLsb ||
      tile.pictureOrderCnt !== decodedTile.pictureOrderCnt ||
      tile.temporalId !== decodedTile.temporalId
    )
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: in-file tili tiles do not belong to the same HEVC picture',
      );
    stitchTileMotionMaps(
      tile,
      tx,
      ty,
      tileW,
      tileH,
      canvasMapWidth,
      canvasMapHeight,
      stitchedMotionMaps,
    );
    for (let row = 0; row < tileH; row++)
      y.set(tile.y.subarray(row * tileW, (row + 1) * tileW), (ty + row) * canvasW + tx);
    const tileChromaW = Math.ceil(tileW / sub.width);
    const tileChromaH = Math.ceil(tileH / sub.height);
    for (let row = 0; row < tileChromaH && cb.length; row++) {
      const src = row * tileChromaW;
      const dst = (Math.floor(ty / sub.height) + row) * chromaWidth + Math.floor(tx / sub.width);
      cb.set(tile.cb.subarray(src, src + tileChromaW), dst);
      cr.set(tile.cr.subarray(src, src + tileChromaW), dst);
    }
  }
  const result: Planes = {
    ...(selectedTileIndexes.length === 1 && decodedTile ? decodedTile : {}),
    ...stitchedMotionMaps,
    ...(selectedTileIndexes.length > 1 && decodedTile
      ? {
          pictureOrderCntLsb: decodedTile.pictureOrderCntLsb,
          pictureOrderCnt: decodedTile.pictureOrderCnt,
          temporalId: decodedTile.temporalId,
        }
      : {}),
    y,
    cb,
    cr,
    width: canvasW,
    height: canvasH,
    chromaFormatIdc,
    bitDepthLuma: firstSps.bitDepthLuma,
    bitDepthChroma: firstSps.bitDepthChroma,
    hasExternalInterMotion,
    sourceSps: decodedTile?.sourceSps ?? firstSps,
  };
  codedTiliReferenceLayouts.set(result, {
    itemId: info.primaryItemId,
    ...(info.relativeLocation ? { relativeLocation: info.relativeLocation } : {}),
    columns: tiledImage.columns,
    rows: tiledImage.rows,
    tileWidth: tiledImage.tileWidth,
    tileHeight: tiledImage.tileHeight,
    extraDimensionSizes: [...tiledImage.extraDimensionSizes],
    selectedExtraDimensionIndexes: [...selectedExtraDimensionIndexes],
    selectedTileIndexes: [...selectedTileIndexes],
    tiles: codedReferenceTiles,
  });
  return result;
}

function stitchExternalTiledImage(
  info: HeicInfo,
  tiledImage: TiledImageInfo,
  externalTileData?: Readonly<Record<string, Uint8Array>>,
  extraDimensionIndexes?: readonly number[],
  referencePlanes: readonly Planes[] = [],
  referenceLayersByItem: readonly ReadonlyMap<number, Planes>[] = [],
  decodedLayersOutput?: Map<number, Planes>,
  referenceTiliLayersByItem: readonly (DecodedTiliLayerLayout | undefined)[] = [],
  decodedTiliLayersOutput?: Map<number, Map<number, Planes>>,
): Planes {
  const selectedTileIndexes = getTiledImageTileIndices(tiledImage, extraDimensionIndexes);
  const selectedExtraDimensionIndexes =
    extraDimensionIndexes ?? tiledImage.extraDimensionSizes.map(() => 0);
  const tileCount = selectedTileIndexes.length;
  if (!Number.isSafeInteger(tileCount) || tileCount <= 0 || tileCount > 65_536)
    throw new HeicError('RESOURCE_LIMIT', 'heic: external tili tile count exceeds 65536');
  const tileReferencesAt = (
    sps: SpsInfo,
    spatialIndex: number,
    x: number,
    y: number,
    referenceWidth: number,
    referenceHeight: number,
  ) =>
    referencePlanes.map((reference, referenceIndex) =>
      tiliReferenceForTile(
        reference,
        sps,
        info,
        info.predReferenceItemIds?.[referenceIndex],
        tiledImage,
        selectedTileIndexes,
        selectedExtraDimensionIndexes,
        spatialIndex,
        x,
        y,
        referenceWidth,
        referenceHeight,
      ),
    );
  const readTile = (index: number, spatialIndex: number) => {
    const url = buildTiledTileUrl(tiledImage.dataReference, index);
    const payload = externalTileData?.[url];
    if (!(payload instanceof Uint8Array) || payload.length === 0)
      throw new HeicError(
        'INVALID_INPUT',
        `heic: external tili tile ${index} has no bytes for ${url}`,
      );
    if (payload.length > 64 * 1024 * 1024)
      throw new HeicError('RESOURCE_LIMIT', 'heic: external tili tile exceeds 64 MiB');
    const boxes = parseISOBMFF(payload);
    const tileInfo = getHeicInfo(payload, boxes);
    const isHevcItem = tileInfo.primaryItemType === 'hvc1' && tileInfo.hvcC !== null;
    const isLayeredHevcItem = tileInfo.primaryItemType === 'lhv1' && tileInfo.lhevc !== null;
    if (
      (!isHevcItem && !isLayeredHevcItem) ||
      tileInfo.grid ||
      tileInfo.tiledImage ||
      tileInfo.transforms.length > 0
    )
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        `heic: external tili tile ${index} must be a plain HEVC image item`,
      );
    const tilePayload = getItemPayload(payload, boxes, tileInfo.primaryItemId);
    if (!tilePayload)
      throw new HeicError('INVALID_CONTAINER', `heic: external tili tile ${index} has no payload`);
    let raw: Planes;
    let sps: SpsInfo;
    let decodedTileLayers: Map<number, Planes> | undefined;
    if (isLayeredHevcItem) {
      const lhevc = tileInfo.lhevc!;
      const localDecoded = new Map<number, Planes>();
      const localDecodedLayers = new Map<number, Map<number, Planes>>();
      const localDecodedTiliLayers = new Map<number, DecodedTiliLayerLayout>();
      const localCaptureTiliReferences = new Set<number>();
      const localActive = new Set<number>();
      if (referencePlanes.length === 0) {
        raw = decodeItemPlanesRecursive(
          payload,
          boxes,
          tileInfo,
          tileInfo.primaryItemId,
          localDecoded,
          localDecodedLayers,
          localDecodedTiliLayers,
          localCaptureTiliReferences,
          localActive,
          {},
        );
        decodedTileLayers = localDecodedLayers.get(tileInfo.primaryItemId);
      } else {
        if (referenceLayersByItem.length !== referencePlanes.length)
          throw new HeicError(
            'UNSUPPORTED_FEATURE',
            'heic: external L-HEVC tili pred references do not have per-item layer data',
          );
        const requiresTiledReferences =
          tiledImage.columns !== 1 || tiledImage.rows !== 1 || selectedTileIndexes.length !== 1;
        const hasTiledReferences = referenceTiliLayersByItem.some(Boolean);
        if (requiresTiledReferences || hasTiledReferences) {
          if (referenceTiliLayersByItem.length !== referencePlanes.length)
            throw new HeicError(
              'UNSUPPORTED_FEATURE',
              'heic: external L-HEVC tili pred requires per-item tiled reference layouts',
            );
          for (
            let referenceIndex = 0;
            referenceIndex < referenceTiliLayersByItem.length;
            referenceIndex++
          ) {
            const referenceLayout = referenceTiliLayersByItem[referenceIndex];
            if (!referenceLayout && requiresTiledReferences)
              throw new HeicError(
                'UNSUPPORTED_FEATURE',
                'heic: multi-tile external L-HEVC pred requires tiled reference items',
              );
            if (
              referenceLayout &&
              !canReuseTiliLayerLayout(
                referenceLayout,
                tiledImage,
                selectedExtraDimensionIndexes,
                info,
                info.predReferenceItemIds?.[referenceIndex],
              )
            )
              throw new HeicError(
                'UNSUPPORTED_FEATURE',
                'heic: external L-HEVC tili pred requires matching tile sizes and a sample-aligned in-bounds reference region',
              );
          }
        }
        const parentLayerForReference = (referenceIndex: number, layerId: number) => {
          const referenceLayout = referenceTiliLayersByItem[referenceIndex];
          const layers = referenceLayout
            ? tiliLayerReferenceForTile(
                referenceLayout,
                tiledImage,
                selectedExtraDimensionIndexes,
                info,
                info.predReferenceItemIds?.[referenceIndex],
                spatialIndex,
                tileInfo,
              )
            : referenceLayersByItem[referenceIndex];
          const reference = layers?.get(layerId);
          if (!reference)
            throw new HeicError(
              'UNSUPPORTED_FEATURE',
              `heic: external L-HEVC tili pred item has no aligned decoded tile for layer ${layerId}`,
            );
          return reference;
        };
        const parentLayersById = new Map<number, Planes[]>();
        for (const layerId of lhevc.requiredLayerIds) {
          parentLayersById.set(
            layerId,
            referencePlanes.map((_, referenceIndex) =>
              parentLayerForReference(referenceIndex, layerId),
            ),
          );
        }
        const localReferenceIds = tileInfo.predReferenceItemIds ?? [];
        if (localReferenceIds.length > 0) {
          if (localReferenceIds.length !== referencePlanes.length)
            throw new HeicError(
              'UNSUPPORTED_FEATURE',
              'heic: external L-HEVC tile and parent pred reference counts differ',
            );
          for (const referenceId of localReferenceIds)
            decodeItemPlanesRecursive(
              payload,
              boxes,
              tileInfo,
              referenceId,
              localDecoded,
              localDecodedLayers,
              localDecodedTiliLayers,
              localCaptureTiliReferences,
              localActive,
              {},
            );
          for (const [layerId, parentReferences] of parentLayersById) {
            const localReferences = localReferenceIds.flatMap((referenceId) => {
              const layers = localDecodedLayers.get(referenceId);
              const reference = layers?.get(layerId);
              return reference ? [reference] : [];
            });
            for (const parentReference of parentReferences) {
              const matchingReference = localReferences.find(
                (localReference) =>
                  localReference.pictureOrderCnt === parentReference.pictureOrderCnt,
              );
              if (
                !matchingReference ||
                matchingReference.pictureOrderCntLsb !== parentReference.pictureOrderCntLsb ||
                matchingReference.width !== parentReference.width ||
                matchingReference.height !== parentReference.height ||
                matchingReference.chromaFormatIdc !== parentReference.chromaFormatIdc ||
                matchingReference.y.length !== parentReference.y.length ||
                matchingReference.cb.length !== parentReference.cb.length ||
                matchingReference.cr.length !== parentReference.cr.length ||
                !matchingReference.y.every(
                  (value, sample) => value === parentReference.y[sample],
                ) ||
                !matchingReference.cb.every(
                  (value, sample) => value === parentReference.cb[sample],
                ) ||
                !matchingReference.cr.every((value, sample) => value === parentReference.cr[sample])
              )
                throw new HeicError(
                  'INVALID_CONTAINER',
                  `heic: external L-HEVC tili tile ${index} pred references disagree with its parent image`,
                );
            }
          }
        }

        let externalBaseLayer: Planes | undefined;
        if (tileInfo.externalBaseLayerItemId !== undefined) {
          externalBaseLayer = decodeItemPlanesRecursive(
            payload,
            boxes,
            tileInfo,
            tileInfo.externalBaseLayerItemId,
            localDecoded,
            localDecodedLayers,
            localDecodedTiliLayers,
            localCaptureTiliReferences,
            localActive,
            {},
          );
        }
        const parameterSetNals = lhevc.configuration.arrays.flatMap((array) =>
          array.nalUnits.map((nal) => ({
            type: array.nalUnitType as NalType,
            layerId: nal.layerId,
            data: nal.data,
          })),
        );
        const accessUnitNals = splitLengthPrefixed(
          tilePayload,
          lhevc.configuration.nalLengthSize,
          false,
          lhevc.requiredLayerIds,
        );
        const temporalReferencesByLayer = new Map<number, Planes[]>();
        for (const [layerId, references] of parentLayersById)
          if (references.length > 0) temporalReferencesByLayer.set(layerId, references);
        decodedTileLayers = new Map<number, Planes>();
        raw = decodeLayeredHevcPicture(
          [...parameterSetNals, ...accessUnitNals],
          lhevc.requiredLayerIds,
          lhevc.targetLayerId,
          externalBaseLayer,
          temporalReferencesByLayer,
          decodedTileLayers,
        );
      }
      if (!raw.sourceSps)
        throw new HeicError(
          'INVALID_BITSTREAM',
          `heic: external L-HEVC tili tile ${index} has no active SPS`,
        );
      sps = raw.sourceSps;
      if (!isHeifHevcBitDepth(sps.bitDepthLuma) || !isHeifHevcBitDepth(sps.bitDepthChroma))
        throw new HeicError('UNSUPPORTED_FEATURE', 'heic: external tili bit depth is unsupported');
    } else {
      sps = getActiveSpsFromPayload(
        tilePayload,
        tileInfo.hvcC!,
        `external tili tile ${index}`,
        true,
      );
      if (!isHeifHevcBitDepth(sps.bitDepthLuma) || !isHeifHevcBitDepth(sps.bitDepthChroma))
        throw new HeicError('UNSUPPORTED_FEATURE', 'heic: external tili bit depth is unsupported');
      const referenceExtent =
        referencePlanes.length > 0
          ? tiliReferenceExtent(sps)
          : { width: tiledImage.tileWidth, height: tiledImage.tileHeight };
      const tileReferences =
        referencePlanes.length > 0
          ? tileReferencesAt(
              sps,
              spatialIndex,
              (spatialIndex % tiledImage.columns) * tiledImage.tileWidth,
              Math.floor(spatialIndex / tiledImage.columns) * tiledImage.tileHeight,
              referenceExtent.width,
              referenceExtent.height,
            )
          : [];
      if (tileReferences.length > 0) {
        const localReferenceIds = tileInfo.predReferenceItemIds ?? [];
        if (localReferenceIds.length > 0) {
          const localReferences = localReferenceIds.map((referenceId) =>
            decodeItemPlanes(payload, boxes, tileInfo, referenceId),
          );
          if (localReferences.length !== tileReferences.length)
            throw new HeicError(
              'UNSUPPORTED_FEATURE',
              'heic: external tili tile and parent pred reference counts differ',
            );
          for (const parentReference of tileReferences) {
            const matchingReference = localReferences.find(
              (localReference) =>
                localReference.pictureOrderCnt === parentReference.pictureOrderCnt,
            );
            if (
              !matchingReference ||
              matchingReference.pictureOrderCntLsb !== parentReference.pictureOrderCntLsb ||
              matchingReference.width !== parentReference.width ||
              matchingReference.height !== parentReference.height ||
              matchingReference.chromaFormatIdc !== parentReference.chromaFormatIdc ||
              matchingReference.y.length !== parentReference.y.length ||
              matchingReference.cb.length !== parentReference.cb.length ||
              matchingReference.cr.length !== parentReference.cr.length ||
              !matchingReference.y.every((value, sample) => value === parentReference.y[sample]) ||
              !matchingReference.cb.every(
                (value, sample) => value === parentReference.cb[sample],
              ) ||
              !matchingReference.cr.every((value, sample) => value === parentReference.cr[sample])
            )
              throw new HeicError(
                'INVALID_CONTAINER',
                `heic: external tili tile ${index} pred references disagree with its parent image`,
              );
          }
        }
        raw = decodeHevcPayload(
          tilePayload,
          tileInfo.hvcC!,
          tileReferences,
          `external tili tile ${index}`,
          true,
        );
        if (sps.picWidthInLumaSamples !== raw.width || sps.picHeightInLumaSamples !== raw.height)
          throw new HeicError(
            'INVALID_BITSTREAM',
            'heic: external tili decoder output does not match the coded tile dimensions',
          );
      } else {
        raw = decodeItemPlanes(payload, boxes, tileInfo, tileInfo.primaryItemId);
      }
    }
    const sub = chromaSubsampling(sps.chromaFormatIdc);
    const tile = cropPlanes(
      raw,
      sub.width * sps.cropLeft,
      sub.height * sps.cropTop,
      sps.width,
      sps.height,
    );
    const layers = new Map<number, Planes>();
    for (const [layerId, layer] of decodedTileLayers ?? []) {
      const layerSps = layer.sourceSps;
      if (!layerSps)
        throw new HeicError(
          'INVALID_BITSTREAM',
          `heic: external L-HEVC tili layer ${layerId} has no active SPS`,
        );
      const layerSub = chromaSubsampling(layerSps.chromaFormatIdc);
      layers.set(
        layerId,
        cropPlanes(
          layer,
          layerSub.width * layerSps.cropLeft,
          layerSub.height * layerSps.cropTop,
          layerSps.width,
          layerSps.height,
        ),
      );
    }
    if (layers.size === 0) layers.set(0, tile);
    if (tile.width !== tiledImage.tileWidth || tile.height !== tiledImage.tileHeight)
      throw new HeicError(
        'INVALID_BITSTREAM',
        `heic: external tili tile ${index} is ${tile.width}x${tile.height}, expected ${tiledImage.tileWidth}x${tiledImage.tileHeight}`,
      );
    let alpha: Uint8Array | Uint16Array | null = null;
    let alphaBitDepth: number | null = null;
    let alphaChannelInfo: HevcAlphaChannelInformation | undefined;
    if (tileInfo.alphaItemId !== null) {
      const alphaInfo = getHeicInfo(payload, boxes, tileInfo.alphaItemId);
      if (
        alphaInfo.primaryItemType !== 'hvc1' ||
        !alphaInfo.hvcC ||
        alphaInfo.hasAlpha ||
        alphaInfo.grid ||
        alphaInfo.tiledImage ||
        alphaInfo.transforms.length > 0
      )
        throw new HeicError(
          'UNSUPPORTED_FEATURE',
          `heic: external tili alpha plane ${index} must be a plain HEVC image item`,
        );
      const alphaSps = parseSps(alphaInfo.hvcC.sps[0]);
      if (
        alphaSps.chromaFormatIdc !== 0 ||
        !isHeifHevcBitDepth(alphaSps.bitDepthLuma) ||
        alphaSps.bitDepthChroma !== alphaSps.bitDepthLuma
      )
        throw new HeicError(
          'UNSUPPORTED_FEATURE',
          `heic: external tili alpha plane ${index} must use monochrome HEVC`,
        );
      alphaChannelInfo = activeHevcAlphaChannelInfo(
        getHevcAuxiliarySeiForItem(tileInfo, tileInfo.alphaItemId, alphaInfo),
      );
      if (
        alphaChannelInfo?.bitDepth !== undefined &&
        (alphaChannelInfo.bitDepth !== alphaSps.bitDepthLuma ||
          alphaChannelInfo.bitDepth !== sps.bitDepthLuma)
      )
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: alpha_channel_bit_depth does not match the primary and auxiliary images',
        );
      const alphaRaw = decodeItemPlanes(payload, boxes, alphaInfo, alphaInfo.primaryItemId);
      const alphaCropped = cropPlanes(
        alphaRaw,
        alphaSps.cropLeft,
        alphaSps.cropTop,
        alphaSps.width,
        alphaSps.height,
      );
      alphaBitDepth = alphaSps.bitDepthLuma;
      const AlphaSamples = alphaBitDepth === 8 ? Uint8Array : Uint16Array;
      alpha = new AlphaSamples(tile.width * tile.height);
      for (let y = 0; y < tile.height; y++) {
        const sourceY = Math.min(
          alphaCropped.height - 1,
          Math.floor((y * alphaCropped.height) / tile.height),
        );
        for (let x = 0; x < tile.width; x++) {
          const sourceX = Math.min(
            alphaCropped.width - 1,
            Math.floor((x * alphaCropped.width) / tile.width),
          );
          alpha[y * tile.width + x] = alphaCropped.y[sourceY * alphaCropped.width + sourceX];
        }
      }
    }
    const color = tileInfo.color ?? null;
    return {
      planes: tile,
      codedPlanes: raw,
      layers,
      alpha,
      alphaBitDepth,
      ...(alphaChannelInfo ? { alphaChannelInfo } : {}),
      premultipliedAlpha: tileInfo.premultipliedAlpha,
      sps,
      color,
      icc: tileInfo.icc,
      iccType: tileInfo.iccType,
      chromaSampleLocation: tileInfo.chromaSampleLocation,
    };
  };

  const firstTileIndex = selectedTileIndexes[0];
  const first = readTile(firstTileIndex, 0);
  const firstColor = first.color ?? first.sps.color ?? null;
  const canvasW = tiledImage.columns * tiledImage.tileWidth;
  const canvasH = tiledImage.rows * tiledImage.tileHeight;
  if (
    !Number.isSafeInteger(canvasW * canvasH) ||
    canvasW * canvasH > 50_000_000 ||
    canvasW < info.width ||
    canvasH < info.height
  )
    throw new HeicError('RESOURCE_LIMIT', 'heic: padded tili image exceeds pixel limit');
  const chromaFormatIdc = first.sps.chromaFormatIdc;
  const sub = chromaSubsampling(chromaFormatIdc);
  const chromaWidth = Math.ceil(canvasW / sub.width);
  const chromaHeight = Math.ceil(canvasH / sub.height);
  const LumaSamples = first.sps.bitDepthLuma === 8 ? Uint8Array : Uint16Array;
  const ChromaSamples = first.sps.bitDepthChroma === 8 ? Uint8Array : Uint16Array;
  const y = new LumaSamples(canvasW * canvasH);
  const cb = new ChromaSamples(chromaFormatIdc === 0 ? 0 : chromaWidth * chromaHeight);
  const cr = new ChromaSamples(cb.length);
  const alpha = first.alpha
    ? new (first.alpha instanceof Uint16Array ? Uint16Array : Uint8Array)(canvasW * canvasH)
    : undefined;
  const alphaBitDepth = first.alphaBitDepth ?? undefined;
  if (alpha) alpha.fill(2 ** alphaBitDepth! - 1);
  const fullRange =
    info.color?.fullRange ?? first.color?.fullRange ?? first.sps.color?.videoFullRange ?? false;
  y.fill(fullRange ? 0 : 16 << (first.sps.bitDepthLuma - 8));
  cb.fill(1 << (first.sps.bitDepthChroma - 1));
  cr.fill(1 << (first.sps.bitDepthChroma - 1));
  let workPixels = 0;
  let externalBytes = 0;
  const countedUrls = new Set<string>();
  let hasExternalInterMotion = false;
  let decodedTile: Planes | null = null;
  const codedReferenceTiles: (CodedTiliReferenceTile | undefined)[] = new Array(tileCount);
  const stitchedMotionMaps: Partial<Pick<Planes, MotionMapKey>> = {};
  const canvasMapWidth = Math.ceil(canvasW / 4);
  const canvasMapHeight = Math.ceil(canvasH / 4);

  for (let spatialIndex = 0; spatialIndex < tileCount; spatialIndex++) {
    const index = selectedTileIndexes[spatialIndex];
    const url = buildTiledTileUrl(tiledImage.dataReference, index);
    const external = externalTileData?.[url];
    if (!external)
      throw new HeicError(
        'INVALID_INPUT',
        `heic: external tili tile ${index} has no data for ${url}`,
      );
    if (!countedUrls.has(url)) {
      externalBytes += external.byteLength;
      countedUrls.add(url);
    }
    if (!Number.isSafeInteger(externalBytes) || externalBytes > 64 * 1024 * 1024)
      throw new HeicError('RESOURCE_LIMIT', 'heic: external tile data exceeds 64 MiB');
    const item = index === firstTileIndex ? first : readTile(index, spatialIndex);
    const tile = item.planes;
    decodedTiliLayersOutput?.set(index, item.layers);
    codedReferenceTiles[spatialIndex] = {
      sps: item.sps,
      ...(hasConformanceCrop(item.sps) && item.codedPlanes
        ? { codedPlanes: item.codedPlanes }
        : {}),
    };
    if (
      item.sps.bitDepthLuma !== first.sps.bitDepthLuma ||
      item.sps.bitDepthChroma !== first.sps.bitDepthChroma ||
      item.sps.chromaFormatIdc !== chromaFormatIdc ||
      JSON.stringify(item.color ?? item.sps.color ?? null) !== JSON.stringify(firstColor) ||
      item.iccType !== first.iccType ||
      (item.icc?.length ?? 0) !== (first.icc?.length ?? 0) ||
      item.icc?.some((value, byte) => value !== first.icc?.[byte])
    )
      throw new HeicError('INVALID_CONTAINER', 'heic: external tili tiles do not share one format');
    if (
      (item.alpha !== null) !== (first.alpha !== null) ||
      item.alphaBitDepth !== first.alphaBitDepth ||
      item.premultipliedAlpha !== first.premultipliedAlpha ||
      JSON.stringify(item.alphaChannelInfo) !== JSON.stringify(first.alphaChannelInfo)
    )
      throw new HeicError(
        'INVALID_CONTAINER',
        'heic: external tili tiles do not share one alpha format',
      );
    workPixels += tile.width * tile.height;
    if (item.alpha) workPixels += item.alpha.length;
    if (!Number.isSafeInteger(workPixels) || workPixels > 200_000_000)
      throw new HeicError(
        'RESOURCE_LIMIT',
        'heic: external tili decode work exceeds 200 million pixels',
      );
    const x = (spatialIndex % tiledImage.columns) * tiledImage.tileWidth;
    const yOffset = Math.floor(spatialIndex / tiledImage.columns) * tiledImage.tileHeight;
    if (!decodedTile) decodedTile = tile;
    else if (
      tile.pictureOrderCntLsb !== decodedTile.pictureOrderCntLsb ||
      tile.pictureOrderCnt !== decodedTile.pictureOrderCnt ||
      tile.temporalId !== decodedTile.temporalId
    )
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: external tili tiles do not belong to the same HEVC picture',
      );
    stitchTileMotionMaps(
      tile,
      x,
      yOffset,
      tiledImage.tileWidth,
      tiledImage.tileHeight,
      canvasMapWidth,
      canvasMapHeight,
      stitchedMotionMaps,
    );
    for (let row = 0; row < tiledImage.tileHeight; row++)
      y.set(
        tile.y.subarray(row * tiledImage.tileWidth, (row + 1) * tiledImage.tileWidth),
        (yOffset + row) * canvasW + x,
      );
    if (alpha && item.alpha)
      for (let row = 0; row < tiledImage.tileHeight; row++)
        alpha.set(
          item.alpha.subarray(row * tiledImage.tileWidth, (row + 1) * tiledImage.tileWidth),
          (yOffset + row) * canvasW + x,
        );
    const tileChromaW = Math.ceil(tiledImage.tileWidth / sub.width);
    const tileChromaH = Math.ceil(tiledImage.tileHeight / sub.height);
    for (let row = 0; row < tileChromaH && cb.length; row++) {
      const src = row * tileChromaW;
      const dst =
        (Math.floor(yOffset / sub.height) + row) * chromaWidth + Math.floor(x / sub.width);
      cb.set(tile.cb.subarray(src, src + tileChromaW), dst);
      cr.set(tile.cr.subarray(src, src + tileChromaW), dst);
    }
    hasExternalInterMotion ||= tile.hasExternalInterMotion;
  }
  const result: Planes = {
    ...stitchedMotionMaps,
    ...(decodedTile
      ? {
          pictureOrderCntLsb: decodedTile.pictureOrderCntLsb,
          pictureOrderCnt: decodedTile.pictureOrderCnt,
          temporalId: decodedTile.temporalId,
        }
      : {}),
    y,
    cb,
    cr,
    ...(alpha
      ? {
          alpha,
          alphaBitDepth,
          premultipliedAlpha: first.premultipliedAlpha,
          ...(first.alphaChannelInfo ? { alphaChannelInfo: first.alphaChannelInfo } : {}),
        }
      : {}),
    width: canvasW,
    height: canvasH,
    chromaFormatIdc,
    bitDepthLuma: first.sps.bitDepthLuma,
    bitDepthChroma: first.sps.bitDepthChroma,
    hasExternalInterMotion,
    sourceSps: first.sps,
    sourceColor: first.color,
    sourceIcc: first.icc,
    sourceIccType: first.iccType,
    sourceChromaSampleLocation: first.chromaSampleLocation,
  };
  codedTiliReferenceLayouts.set(result, {
    itemId: info.primaryItemId,
    ...(info.relativeLocation ? { relativeLocation: info.relativeLocation } : {}),
    columns: tiledImage.columns,
    rows: tiledImage.rows,
    tileWidth: tiledImage.tileWidth,
    tileHeight: tiledImage.tileHeight,
    extraDimensionSizes: [...tiledImage.extraDimensionSizes],
    selectedExtraDimensionIndexes: [...selectedExtraDimensionIndexes],
    selectedTileIndexes: [...selectedTileIndexes],
    tiles: codedReferenceTiles,
  });
  if (decodedLayersOutput && tiledImage.columns === 1 && tiledImage.rows === 1)
    for (const [layerId, layer] of first.layers) decodedLayersOutput.set(layerId, layer);
  return result;
}

export function cropPlanes(
  planes: Planes,
  x0: number,
  y0: number,
  width: number,
  height: number,
): Planes {
  if (
    ![x0, y0, width, height].every(Number.isSafeInteger) ||
    x0 < 0 ||
    y0 < 0 ||
    width <= 0 ||
    height <= 0 ||
    x0 + width > planes.width ||
    y0 + height > planes.height
  )
    throw new RangeError('heic: invalid crop bounds');
  if (x0 === 0 && y0 === 0 && width === planes.width && height === planes.height) return planes;
  const Samples = planes.y instanceof Uint16Array ? Uint16Array : Uint8Array;
  const y = new Samples(width * height);
  const sub = chromaSubsampling(planes.chromaFormatIdc);
  const cw = Math.ceil(width / sub.width);
  const ch = Math.ceil(height / sub.height);
  const cb = new Samples(planes.cb.length ? cw * ch : 0);
  const cr = new Samples(cb.length);
  const AlphaSamples = planes.alpha instanceof Uint16Array ? Uint16Array : Uint8Array;
  const alpha = planes.alpha ? new AlphaSamples(width * height) : undefined;
  for (let row = 0; row < height; row++) {
    const src = (y0 + row) * planes.width + x0;
    y.set(planes.y.subarray(src, src + width), row * width);
    if (alpha && planes.alpha) alpha.set(planes.alpha.subarray(src, src + width), row * width);
  }
  const srcCw = Math.ceil(planes.width / sub.width);
  for (let row = 0; cb.length && row < ch; row++) {
    const src = (Math.floor(y0 / sub.height) + row) * srcCw + Math.floor(x0 / sub.width);
    cb.set(planes.cb.subarray(src, src + cw), row * cw);
    cr.set(planes.cr.subarray(src, src + cw), row * cw);
  }
  return {
    y,
    cb,
    cr,
    ...(alpha
      ? {
          alpha,
          alphaBitDepth: planes.alphaBitDepth,
          premultipliedAlpha: planes.premultipliedAlpha,
        }
      : {}),
    width,
    height,
    chromaFormatIdc: planes.chromaFormatIdc,
    hasExternalInterMotion: planes.hasExternalInterMotion,
    pictureOrderCntLsb: planes.pictureOrderCntLsb,
    pictureOrderCnt: planes.pictureOrderCnt,
    temporalId: planes.temporalId,
    sourceSps: planes.sourceSps,
    sourceColor: planes.sourceColor,
    sourceIcc: planes.sourceIcc,
    sourceIccType: planes.sourceIccType,
    sourceChromaSampleLocation: planes.sourceChromaSampleLocation,
  };
}

/** Crop planes that already have the SPS conformance window applied. */
export function cropPlanesToDefaultDisplayWindow(planes: Planes, sps: SpsInfo): Planes {
  const window = sps.defaultDisplayWindow;
  if (!window) return planes;
  const sub = chromaSubsampling(sps.chromaFormatIdc);
  const left = sub.width * window.left;
  const right = sub.width * window.right;
  const top = sub.height * window.top;
  const bottom = sub.height * window.bottom;
  return cropPlanes(planes, left, top, planes.width - left - right, planes.height - top - bottom);
}

type MotionMap = Uint8Array | Int32Array | Float64Array;

function createMotionMap(source: MotionMap, length: number): MotionMap {
  if (source instanceof Int32Array) return new Int32Array(length);
  if (source instanceof Float64Array) return new Float64Array(length);
  return new Uint8Array(length);
}

function cropMotionMap(
  source: MotionMap,
  sourceWidth: number,
  sourceHeight: number,
  x0: number,
  y0: number,
  width: number,
  height: number,
): MotionMap {
  const sourceMapWidth = Math.ceil(sourceWidth / 4);
  const sourceMapHeight = Math.ceil(sourceHeight / 4);
  // Temporal MVP samples the collocated map at positions rounded to 16-luma
  // boundaries. Any integer crop offset therefore selects the source 4x4 cell
  // at floor(offset / 4); the residual offset still applies to sample planes.
  const mapX = Math.floor(x0 / 4);
  const mapY = Math.floor(y0 / 4);
  if (
    source.length !== sourceMapWidth * sourceMapHeight ||
    mapX + Math.ceil(width / 4) > sourceMapWidth ||
    mapY + Math.ceil(height / 4) > sourceMapHeight
  )
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: tili reference motion map does not cover the cropped region',
    );
  const mapWidth = Math.ceil(width / 4);
  const mapHeight = Math.ceil(height / 4);
  const output = source.slice(0, mapWidth * mapHeight);
  output.fill(0);
  for (let row = 0; row < mapHeight; row++) {
    const sourceOffset = (mapY + row) * sourceMapWidth + mapX;
    output.set(source.subarray(sourceOffset, sourceOffset + mapWidth), row * mapWidth);
  }
  return output;
}

/** Crop a whole-image `pred` reference to the tile-local HEVC coordinate space. */
export function cropReferencePlanesForTile(
  planes: Planes,
  x0: number,
  y0: number,
  width: number,
  height: number,
): Planes {
  const cropped = cropPlanes(planes, x0, y0, width, height);
  if (cropped === planes) return planes;
  const motionMaps: Partial<Pick<Planes, MotionMapKey>> = {};
  for (const key of MOTION_MAP_KEYS) {
    const source = planes[key] as MotionMap | undefined;
    if (!source) continue;
    Object.assign(motionMaps, {
      [key]: cropMotionMap(source, planes.width, planes.height, x0, y0, width, height),
    });
  }
  return {
    ...cropped,
    ...motionMaps,
    pictureOrderCntLsb: planes.pictureOrderCntLsb,
    pictureOrderCnt: planes.pictureOrderCnt,
    temporalId: planes.temporalId,
  };
}

function stitchTileMotionMaps(
  tile: Planes,
  x: number,
  y: number,
  tileWidth: number,
  tileHeight: number,
  outputWidth: number,
  outputHeight: number,
  output: Partial<Pick<Planes, MotionMapKey>>,
): void {
  if (MOTION_MAP_KEYS.every((key) => tile[key] === undefined)) return;
  const mapX = x / 4;
  const mapY = y / 4;
  const sourceMapWidth = Math.ceil(tileWidth / 4);
  const sourceMapHeight = Math.ceil(tileHeight / 4);
  if (
    x % 4 !== 0 ||
    y % 4 !== 0 ||
    mapX + sourceMapWidth > outputWidth ||
    mapY + sourceMapHeight > outputHeight
  )
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: in-file tili tile motion map does not align to 4x4 sample blocks',
    );
  for (const key of MOTION_MAP_KEYS) {
    const source = tile[key] as MotionMap | undefined;
    if (!source) continue;
    if (source.length !== sourceMapWidth * sourceMapHeight)
      throw new HeicError('INVALID_BITSTREAM', `heic: tili tile ${key} has an invalid map size`);
    let target = output[key] as MotionMap | undefined;
    if (!target) {
      target = createMotionMap(source, outputWidth * outputHeight);
      Object.assign(output, { [key]: target });
    }
    for (let row = 0; row < sourceMapHeight; row++) {
      const sourceOffset = row * sourceMapWidth;
      const targetOffset = (mapY + row) * outputWidth + mapX;
      target.set(source.subarray(sourceOffset, sourceOffset + sourceMapWidth), targetOffset);
    }
  }
}
