import { HeicError } from '../errors.js';
/**
 * HEIC-specific HEIF container parsing, layered on the shared ISOBMFF
 * walker in ./heif. Handles what iPhone HEICs actually ship:
 *
 *   - `pitm` primary item selection
 *   - `ipma` item ↔ property association (the first `ispe` in `ipco` is the
 *     TILE size on grid images, so properties must be resolved per item)
 *   - `iref` `dimg` references (grid → tile items)
 *   - `grid` derived-image body (rows/columns/output size)
 *   - `hvcC` HEVC decoder configuration (VPS/SPS/PPS arrays, NAL length size)
 *   - `irot` / `imir` display transforms
 */
import type { ISOBMFFBox, PixelInformation } from './heif.js';
import { findBox, getFtypInfo, parseIinf, parseIloc, parseIspe, parsePixi } from './heif.js';
import { parseMiniImage } from './mini.js';
import { parseHeifCameraProperties } from './heif-camera.js';
import { chromaSampleLocationFromCode, type ChromaSampleLocation } from '../hevc/chroma.js';
import { parseLayeredSpsHeader, type LayeredSpsHeader } from '../hevc/sps.js';
import {
  parseLayeredVps,
  readVpsId,
  selectLayerRepresentationFormat,
  type HevcRepresentationFormat,
  type LayeredVpsInfo,
} from '../hevc/vps.js';
import {
  parseLayerSelector,
  parseLhevcDecoderConfigurationRecord,
  parseOperatingPointsInfo,
  parseTargetOutputLayerSet,
  resolveLhevcOutput,
  type LhevcDecoderConfiguration,
  type OperatingPointsInfo,
  type ResolvedLhevcOutput,
} from './lhevc.js';
import {
  parseTiledDataReference,
  parseTiledImageConfiguration,
  type TiledDataReference,
} from './tili.js';
import { parseHeifHdrItemProperties, type HeifHdrItemProperties } from './heif-hdr.js';
import {
  parseProgressiveDerivedImageInfo,
  type ProgressiveDerivedImageInfo,
} from './heif-progressive.js';
import {
  parseUncompressedImageConfiguration,
  type UncompressedImageConfiguration,
} from './uncompressed.js';

export interface HvcCConfig {
  configurationVersion: number;
  generalProfileIdc: number;
  generalLevelIdc: number;
  chromaFormatIdc: number;
  bitDepthLumaMinus8: number;
  bitDepthChromaMinus8: number;
  /** Bytes prefixed to each NAL unit length in the item payload (1, 2, or 4). */
  nalLengthSize: number;
  /** Parameter set NAL units by type: vps (32), sps (33), pps (34). */
  vps: Uint8Array[];
  sps: Uint8Array[];
  pps: Uint8Array[];
  /** Prefix/suffix SEI NAL units (types 39 and 40) carried in hvcC arrays. */
  seiNals: Uint8Array[];
}

/** Parsed ISO/IEC 14496-15 AVCDecoderConfigurationRecord (`avcC`). */
export interface AvcCConfig {
  configurationVersion: 1;
  profileIdc: number;
  profileCompatibility: number;
  levelIdc: number;
  /** Bytes prefixed to each AVC NAL unit length in the item payload (1, 2, or 4). */
  nalLengthSize: number;
  sequenceParameterSets: Uint8Array[];
  pictureParameterSets: Uint8Array[];
  sequenceParameterSetExtensions: Uint8Array[];
  /** Present in high-profile configuration-record extensions. */
  chromaFormatIdc: number | null;
  bitDepthLumaMinus8: number | null;
  bitDepthChromaMinus8: number | null;
}

/** Validate HEIF pixel-information depths against the HEVC component depths. */
export function validatePixiBitDepths(
  information: PixelInformation | null,
  lumaDepth: number,
  chromaDepth: number,
  reference = 'hvcC',
): void {
  const depths = information?.bitsPerChannel;
  if (!information || !depths?.length) return;

  if (information.channels) {
    if (information.channels.length !== depths.length)
      throw new HeicError('INVALID_CONTAINER', 'heic: pixi channel/depth count mismatch');
    for (let index = 0; index < information.channels.length; index++) {
      const channelIdc = information.channels[index].channelIdc;
      const expectedDepth =
        channelIdc === 1 || channelIdc === 2
          ? lumaDepth
          : channelIdc === 3 || channelIdc === 4
            ? chromaDepth
            : undefined;
      if (expectedDepth !== undefined && depths[index] !== expectedDepth)
        throw new HeicError(
          'INVALID_CONTAINER',
          `heic: pixi bit depths disagree with ${reference}`,
        );
    }
    return;
  }

  if (
    depths[0] !== lumaDepth ||
    (depths.length > 1 && depths.slice(1).some((depth) => depth !== chromaDepth))
  )
    throw new HeicError('INVALID_CONTAINER', `heic: pixi bit depths disagree with ${reference}`);
}

function pixiLumaBitDepth(information: PixelInformation): number | undefined {
  if (information.channels) {
    const channelIndex = information.channels.findIndex(
      (channel) => channel.channelIdc === 1 || channel.channelIdc === 2,
    );
    return channelIndex >= 0 ? information.bitsPerChannel[channelIndex] : undefined;
  }
  return information.bitsPerChannel[0];
}

export interface LhevcInfo extends ResolvedLhevcOutput {
  configuration: LhevcDecoderConfiguration;
  operatingPointsInfo: OperatingPointsInfo;
  /** Parsed Annex F SPS prefix through the POC-width field. */
  selectedSpsHeader: LayeredSpsHeader | null;
  /** Selected image format inferred from the active Annex F VPS, when available. */
  selectedRepresentationFormat: HevcRepresentationFormat | null;
  /** Active Annex F VPS needed to parse fields omitted from the selected SPS. */
  selectedVps: LayeredVpsInfo | null;
}

export interface GridInfo {
  rows: number;
  columns: number;
  outputWidth: number;
  outputHeight: number;
  /** Tile item ids in raster order (from the `dimg` reference). */
  tileItemIds: number[];
  tileWidth: number;
  tileHeight: number;
}

export interface StereoPairInfo {
  groupId: number;
  /** First entity in the `ster` group, specified as the left view. */
  leftItemId: number;
  /** Second entity in the `ster` group, specified as the right view. */
  rightItemId: number;
}

export interface PixelAspectRatio {
  /** Horizontal pixel spacing from the HEIF `pasp` property. */
  horizontalSpacing: number;
  /** Vertical pixel spacing from the HEIF `pasp` property. */
  verticalSpacing: number;
}

export interface RelativeImageLocation {
  /** Horizontal offset of this image in its related base image, in pixels. */
  horizontalOffset: number;
  /** Vertical offset of this image in its related base image, in pixels. */
  verticalOffset: number;
  /** Related image item named by the `tbas` item reference. */
  relatedItemId: number;
}

export interface TiledImageInfo {
  rows: number;
  columns: number;
  tileWidth: number;
  tileHeight: number;
  extraDimensionSizes: number[];
  tileItemType: string | null;
  dataReference: TiledDataReference;
}

export type ImageTransform =
  | { type: 'irot' | 'imir'; value: number }
  | {
      type: 'iscl';
      targetWidthNumerator: number;
      targetWidthDenominator: number;
      targetHeightNumerator: number;
      targetHeightDenominator: number;
    }
  | {
      type: 'clap';
      width: number;
      height: number;
      horizontalOffset: number;
      verticalOffset: number;
    };

export interface HeicInfo {
  primaryItemId: number;
  /** Codec item type (for example 'hvc1', 'avc1', or 'unci'), 'grid', or ISO tiled 'tili'. */
  primaryItemType: string;
  /** Upright display dimensions of the primary image (before irot/imir). */
  width: number;
  height: number;
  /** Pixel spacing ratio in the image's sample axes; defaults to 1:1. */
  pixelAspectRatio: PixelAspectRatio;
  /** HEIF `rloc` offsets relative to the related item named by `tbas`. */
  relativeLocation?: RelativeImageLocation;
  /** HEIF camera pose metadata from all `cmex` item properties before transforms. */
  cameraExtrinsics?: import('./heif-camera.js').HeifCameraExtrinsics[];
  /** HEIF pinhole-camera calibration metadata from the `cmin` item property. */
  cameraIntrinsics?: import('./heif-camera.js').HeifCameraIntrinsics;
  /** HEIF HDR descriptive properties associated with this image item. */
  heifHdrProperties?: HeifHdrItemProperties;
  /** HEIF `prdi` progressive step grouping; the decoder still returns the final image only. */
  progressiveDerivedImage?: ProgressiveDerivedImageInfo;
  /** 0 when an external tile or selected L-HEVC layer depth is not yet resolved. */
  bitDepth: number;
  /** 90-degree counter-clockwise rotation count from `irot` (0-3). */
  rotation: number;
  /** Mirror axis from `imir` (0 vertical, 1 horizontal), or null. */
  mirror: number | null;
  transforms: ImageTransform[];
  hasAlpha: boolean;
  alphaItemId: number | null;
  auxiliaryImages: {
    itemId: number;
    type: string;
    /** HEVCAuxConfigSubType bytes after aux_type's NUL terminator, when present. */
    hevcAuxConfigSubtype?: Uint8Array;
  }[];
  /** HEIF `ster` entity groups in left-view, right-view order. */
  stereoPairs?: StereoPairInfo[];
  /** HEVC reference image items named by `pred` item references. */
  predReferenceItemIds?: number[];
  /** Base-layer image item supplied to an `lhv1` item through `exbl`. */
  externalBaseLayerItemId?: number;
  derivedItems: number[];
  premultipliedAlpha: boolean;
  color: { primaries: number; transfer: number; matrix: number; fullRange: boolean } | null;
  /** Every ICC form associated through HEIF `colr`, in canonical profile-type order. */
  iccProfiles?: { type: 'prof' | 'rICC'; data: Uint8Array }[];
  /** Chroma-sample center in luma-sample coordinates, when specified by mini. */
  chromaSampleLocation?: ChromaSampleLocation;
  /** Per-channel chroma locations declared by ISO/IEC 23008-12 `pixi`. */
  chromaSampleLocations?: { cb?: ChromaSampleLocation; cr?: ChromaSampleLocation };
  /** Raw Exif/XMP payloads stored in a mini box; the payloads may be compressed. */
  miniMetadata?: {
    exif: Uint8Array | null;
    xmp: Uint8Array | null;
    exifXmpCompressed: boolean;
  };
  /** Inline gain-map items synthesized by the `mini` low-overhead container. */
  miniGainMap?: {
    metadataItemId: 3;
    imageItemId: 4;
    toneMappedColor: {
      primaries: number;
      transfer: number;
      matrix: number;
      fullRange: boolean;
    } | null;
    toneMappedIcc: Uint8Array | null;
  };
  /** HDR item properties represented by the compact `mini` header. */
  miniHdrProperties?: {
    baseImage?: HeifHdrItemProperties;
    toneMappedImage?: HeifHdrItemProperties;
  };
  icc: Uint8Array | null;
  /** HEIF ColourInformationBox ICC form, when the container declares one. */
  iccType?: 'prof' | 'rICC' | null;
  hvcC: HvcCConfig | null;
  /** AVC configuration for an `avc1` image item. */
  avcC?: AvcCConfig | null;
  /** ISO/IEC 23001-17 configuration for an uncompressed `unci` image. */
  uncompressedImage?: UncompressedImageConfiguration;
  /** Parsed item configuration and selected output layer for `lhv1` items. */
  lhevc?: LhevcInfo | null;
  grid: GridInfo | null;
  /** ISO/IEC 23008-12 Amendment 2 `tili` image item layout. */
  tiledImage?: TiledImageInfo | null;
}

export interface ItemReference {
  referenceType: string;
  fromItemId: number;
  toItemIds: number[];
}

interface PropertyAssociation {
  itemId: number;
  /** 1-based indexes into ipco's child boxes. */
  propertyIndexes: number[];
  essentialIndexes: number[];
}

function u16(data: Uint8Array, off: number): number {
  if (!Number.isSafeInteger(off) || off < 0 || off + 2 > data.length)
    throw new HeicError('INVALID_CONTAINER', 'heic: truncated container field');
  return (data[off] << 8) | data[off + 1];
}

function u32(data: Uint8Array, off: number): number {
  if (!Number.isSafeInteger(off) || off < 0 || off + 4 > data.length)
    throw new HeicError('INVALID_CONTAINER', 'heic: truncated container field');
  return ((data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3]) >>> 0;
}

function parsePixelAspectRatio(properties: readonly ISOBMFFBox[]): PixelAspectRatio {
  const matches = properties.filter((property) => property.type === 'pasp');
  if (matches.length > 1)
    throw new HeicError('INVALID_CONTAINER', 'heic: duplicate pasp pixel aspect ratio properties');
  const data = matches[0]?.data;
  if (!data) return { horizontalSpacing: 1, verticalSpacing: 1 };
  if (data.length !== 8)
    throw new HeicError('INVALID_CONTAINER', 'heic: invalid pasp pixel aspect ratio size');
  const horizontalSpacing = u32(data, 0);
  const verticalSpacing = u32(data, 4);
  if (horizontalSpacing === 0 || verticalSpacing === 0)
    throw new HeicError('INVALID_CONTAINER', 'heic: pasp spacing values must be non-zero');
  return { horizontalSpacing, verticalSpacing };
}

function parseRelativeImageLocation(
  properties: readonly ISOBMFFBox[],
  references: readonly ItemReference[],
  itemId: number,
  knownItemIds: ReadonlySet<number>,
): RelativeImageLocation | undefined {
  const matches = properties.filter((property) => property.type === 'rloc');
  if (matches.length > 1)
    throw new HeicError('INVALID_CONTAINER', 'heic: duplicate rloc relative location properties');
  const tbasTargets = references
    .filter((reference) => reference.referenceType === 'tbas' && reference.fromItemId === itemId)
    .flatMap((reference) => reference.toItemIds);
  if (matches.length === 0) {
    if (tbasTargets.length)
      throw new HeicError('INVALID_CONTAINER', 'heic: tbas reference requires an rloc property');
    return undefined;
  }
  if (tbasTargets.length !== 1 || tbasTargets[0] === itemId || !knownItemIds.has(tbasTargets[0]))
    throw new HeicError('INVALID_CONTAINER', 'heic: rloc requires one existing related tbas item');

  const data = matches[0].data;
  if (data.length !== 12 || data[0] !== 0 || data[1] !== 0 || data[2] !== 0 || data[3] !== 0)
    throw new HeicError('INVALID_CONTAINER', 'heic: invalid rloc relative location property');
  return {
    horizontalOffset: u32(data, 4),
    verticalOffset: u32(data, 8),
    relatedItemId: tbasTargets[0],
  };
}

function readFourCC(data: Uint8Array, off: number): string {
  if (!Number.isSafeInteger(off) || off < 0 || off + 4 > data.length)
    throw new HeicError('INVALID_CONTAINER', 'heic: truncated reference type');
  return String.fromCharCode(data[off], data[off + 1], data[off + 2], data[off + 3]);
}

/** Parse `pitm` (primary item id). */
export function parsePitm(data: Uint8Array): number {
  const version = data[0];
  return version === 0 ? u16(data, 4) : u32(data, 4);
}

/** Parse `iref` child boxes into flat references. */
export function parseIref(box: ISOBMFFBox): ItemReference[] {
  const version = box.data[0];
  const idSize = version === 0 ? 2 : 4;
  const refs: ItemReference[] = [];

  // Children of iref are the individual reference boxes (dimg, thmb, cdsc, …)
  for (const child of box.children ?? []) {
    const d = child.data;
    let p = 0;
    const fromItemId = idSize === 2 ? u16(d, p) : u32(d, p);
    p += idSize;
    const count = u16(d, p);
    p += 2;
    const toItemIds: number[] = [];
    for (let i = 0; i < count; i++) {
      toItemIds.push(idSize === 2 ? u16(d, p) : u32(d, p));
      p += idSize;
    }
    refs.push({ referenceType: child.type, fromItemId, toItemIds });
  }
  return refs;
}

function parseStereoPairs(
  groupList: ISOBMFFBox | undefined,
  items: ReturnType<typeof parseIinf>,
): StereoPairInfo[] {
  if (!groupList) return [];
  if (!groupList.children)
    throw new HeicError('INVALID_CONTAINER', 'heic: invalid entity group list');

  const pairs: StereoPairInfo[] = [];
  for (const group of groupList.children) {
    if (group.type !== 'ster') continue;
    const data = group.data;
    if (data.length < 4)
      throw new HeicError('INVALID_CONTAINER', 'heic: truncated stereo pair group');
    const version = data[0];
    const flags = (data[1] << 16) | (data[2] << 8) | data[3];
    // Entity groups are optional presentation metadata. Leave future versions
    // to the caller without preventing decoding of the primary image.
    if (version !== 0 || flags !== 0) continue;
    if (data.length < 12)
      throw new HeicError('INVALID_CONTAINER', 'heic: truncated stereo pair group');

    const groupId = u32(data, 4);
    const entityCount = u32(data, 8);
    if (entityCount !== 2 || data.length !== 20)
      throw new HeicError('INVALID_CONTAINER', 'heic: stereo pair group must contain two items');
    const leftItemId = u32(data, 12);
    const rightItemId = u32(data, 16);
    if (
      leftItemId === rightItemId ||
      !items.some((item) => item.itemId === leftItemId) ||
      !items.some((item) => item.itemId === rightItemId)
    )
      throw new HeicError('INVALID_CONTAINER', 'heic: stereo pair references an unknown item');
    pairs.push({ groupId, leftItemId, rightItemId });
  }
  return pairs;
}

/** Parse the ISO/IEC 23008-12 RequiredReferenceTypesProperty (`rref`). */
export function parseRequiredReferenceTypes(data: Uint8Array): string[] {
  if (data.length < 5 || data[0] !== 0 || data[1] !== 0 || data[2] !== 0 || data[3] !== 0)
    throw new HeicError('INVALID_CONTAINER', 'heic: invalid rref full-box header');

  // ISO/IEC 23008-12 §6.5.17.2 uses an 8-bit count. Some published Nokia
  // candidates use a legacy 32-bit count, so accept that layout only when its
  // length is otherwise exact. Item references still determine the actual graph.
  const count8 = data[4];
  let count: number;
  let offset: number;
  if (data.length === 5 + count8 * 4) {
    count = count8;
    offset = 5;
  } else if (data.length >= 8) {
    const count32 = u32(data, 4);
    if (data.length !== 8 + count32 * 4)
      throw new HeicError('INVALID_CONTAINER', 'heic: invalid rref reference-type count');
    count = count32;
    offset = 8;
  } else {
    throw new HeicError('INVALID_CONTAINER', 'heic: truncated rref reference-type list');
  }

  return Array.from({ length: count }, (_, i) => readFourCC(data, offset + i * 4));
}

/** Parse `ipma` associations (which ipco properties apply to which item). */
export function parseIpma(data: Uint8Array): PropertyAssociation[] {
  const version = data[0];
  const flags = (data[1] << 16) | (data[2] << 8) | data[3];
  if (version > 1 || flags & ~1)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: unsupported property association version or flags',
    );
  let p = 4;
  const entryCount = u32(data, p);
  p += 4;
  if (entryCount > Math.floor((data.length - p) / (version < 1 ? 3 : 5)))
    throw new HeicError('INVALID_CONTAINER', 'heic: association count exceeds container bounds');

  const out: PropertyAssociation[] = [];
  for (let e = 0; e < entryCount; e++) {
    const itemId = version < 1 ? u16(data, p) : u32(data, p);
    p += version < 1 ? 2 : 4;
    const associationCount = data[p++];
    if (
      !Number.isInteger(associationCount) ||
      p + associationCount * (flags & 1 ? 2 : 1) > data.length
    )
      throw new HeicError('INVALID_CONTAINER', 'heic: truncated property associations');
    const propertyIndexes: number[] = [];
    const essentialIndexes: number[] = [];
    for (let a = 0; a < associationCount; a++) {
      if (flags & 1) {
        // 15-bit index (top bit = essential flag)
        const value = u16(data, p);
        propertyIndexes.push(value & 0x7fff);
        if (value & 0x8000) essentialIndexes.push(value & 0x7fff);
        p += 2;
      } else {
        const value = data[p++];
        propertyIndexes.push(value & 0x7f);
        if (value & 0x80) essentialIndexes.push(value & 0x7f);
      }
    }
    out.push({ itemId, propertyIndexes, essentialIndexes });
  }
  return out;
}

/** Parse the `hvcC` HEVCDecoderConfigurationRecord. */
export function parseHvcC(data: Uint8Array): HvcCConfig {
  if (data.length < 23 || data[0] !== 1)
    throw new HeicError('INVALID_CONTAINER', 'heic: invalid HEVC decoder configuration');
  const configurationVersion = data[0];
  const generalProfileIdc = data[1] & 0x1f;
  const generalLevelIdc = data[12];
  const chromaFormatIdc = data[16] & 0x03;
  const bitDepthLumaMinus8 = data[17] & 0x07;
  const bitDepthChromaMinus8 = data[18] & 0x07;
  const nalLengthSize = (data[21] & 0x03) + 1;
  const numArrays = data[22];

  const vps: Uint8Array[] = [];
  const sps: Uint8Array[] = [];
  const pps: Uint8Array[] = [];
  const seiNals: Uint8Array[] = [];

  let p = 23;
  for (let i = 0; i < numArrays; i++) {
    const nalType = data[p] & 0x3f;
    p += 1;
    const numNalus = u16(data, p);
    p += 2;
    for (let n = 0; n < numNalus; n++) {
      const len = u16(data, p);
      p += 2;
      if (len < 2 || p + len > data.length)
        throw new HeicError('INVALID_CONTAINER', 'heic: truncated HEVC configuration NAL');
      const nal = data.subarray(p, p + len);
      p += len;
      if (nalType === 32) vps.push(nal);
      else if (nalType === 33) sps.push(nal);
      else if (nalType === 34) pps.push(nal);
      else if (nalType === 39 || nalType === 40) seiNals.push(nal);
    }
  }

  return {
    configurationVersion,
    generalProfileIdc,
    generalLevelIdc,
    chromaFormatIdc,
    bitDepthLumaMinus8,
    bitDepthChromaMinus8,
    nalLengthSize,
    vps,
    sps,
    pps,
    seiNals,
  };
}

/** Parse the ISO/IEC 14496-15 AVCDecoderConfigurationRecord (`avcC`). */
export function parseAvcC(data: Uint8Array): AvcCConfig {
  if (data.length < 7 || data[0] !== 1)
    throw new HeicError('INVALID_CONTAINER', 'heic: invalid AVC decoder configuration');
  if ((data[4] & 0xfc) !== 0xfc || (data[5] & 0xe0) !== 0xe0)
    throw new HeicError('INVALID_CONTAINER', 'heic: invalid avcC reserved bits');

  const lengthSizeMinusOne = data[4] & 3;
  if (lengthSizeMinusOne === 2)
    throw new HeicError('INVALID_CONTAINER', 'heic: reserved avcC NAL length size');
  const nalLengthSize = lengthSizeMinusOne + 1;
  const profileIdc = data[1];
  let p = 6;

  const readNalArray = (count: number, type: number, label: string): Uint8Array[] => {
    const nals: Uint8Array[] = [];
    for (let i = 0; i < count; i++) {
      const length = u16(data, p);
      p += 2;
      if (length < 1 || p + length > data.length)
        throw new HeicError('INVALID_CONTAINER', `heic: truncated avcC ${label}`);
      const nal = data.subarray(p, p + length);
      p += length;
      if ((nal[0] & 0x80) !== 0 || (nal[0] & 0x1f) !== type)
        throw new HeicError('INVALID_CONTAINER', `heic: invalid avcC ${label} NAL unit`);
      if (type === 7 && length < 4)
        throw new HeicError(
          'INVALID_CONTAINER',
          'heic: truncated avcC sequence parameter set header',
        );
      nals.push(nal);
    }
    return nals;
  };

  const sequenceParameterSetCount = data[5] & 0x1f;
  const sequenceParameterSets = readNalArray(
    sequenceParameterSetCount,
    7,
    'sequence parameter set',
  );
  if (p >= data.length)
    throw new HeicError('INVALID_CONTAINER', 'heic: truncated avcC picture parameter set count');
  const pictureParameterSetCount = data[p++];
  const pictureParameterSets = readNalArray(pictureParameterSetCount, 8, 'picture parameter set');
  if (sequenceParameterSets.length === 0 || pictureParameterSets.length === 0)
    throw new HeicError('INVALID_CONTAINER', 'heic: avcC must contain SPS and PPS NAL units');

  let chromaFormatIdc: number | null = null;
  let bitDepthLumaMinus8: number | null = null;
  let bitDepthChromaMinus8: number | null = null;
  const sequenceParameterSetExtensions: Uint8Array[] = [];
  const extendedProfiles = new Set([
    44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 144, 244,
  ]);
  if (extendedProfiles.has(profileIdc)) {
    if (p + 4 > data.length)
      throw new HeicError('INVALID_CONTAINER', 'heic: unexpected trailing avcC data');
    if ((data[p] & 0xfc) !== 0xfc || (data[p + 1] & 0xf8) !== 0xf8 || (data[p + 2] & 0xf8) !== 0xf8)
      throw new HeicError('INVALID_CONTAINER', 'heic: invalid avcC extension reserved bits');
    chromaFormatIdc = data[p++] & 3;
    bitDepthLumaMinus8 = data[p++] & 7;
    bitDepthChromaMinus8 = data[p++] & 7;
    const extensionCount = data[p++];
    sequenceParameterSetExtensions.push(...readNalArray(extensionCount, 13, 'SPS extension'));
    if (p !== data.length)
      throw new HeicError('INVALID_CONTAINER', 'heic: trailing avcC extension data');
  } else if (p !== data.length)
    throw new HeicError('INVALID_CONTAINER', 'heic: unexpected trailing avcC data');

  for (const sps of sequenceParameterSets)
    if (sps[1] !== profileIdc || (data[2] & ~sps[2]) !== 0 || sps[3] > data[3])
      throw new HeicError(
        'INVALID_CONTAINER',
        'heic: avcC profile tuple disagrees with its sequence parameter set',
      );

  return {
    configurationVersion: 1,
    profileIdc,
    profileCompatibility: data[2],
    levelIdc: data[3],
    nalLengthSize,
    sequenceParameterSets,
    pictureParameterSets,
    sequenceParameterSetExtensions,
    chromaFormatIdc,
    bitDepthLumaMinus8,
    bitDepthChromaMinus8,
  };
}

/** Parse a `grid` derived-image item body. */
export function parseGridBody(
  data: Uint8Array,
): Omit<GridInfo, 'tileItemIds' | 'tileWidth' | 'tileHeight'> {
  // ImageGrid: version(1) flags(1) rows_minus_one(1) columns_minus_one(1)
  // then output width/height as 16 or 32 bit depending on flags bit 0.
  const flags = data[1];
  const rows = data[2] + 1;
  const columns = data[3] + 1;
  const fieldSize = flags & 1 ? 4 : 2;
  const outputWidth = fieldSize === 2 ? u16(data, 4) : u32(data, 4);
  const outputHeight = fieldSize === 2 ? u16(data, 4 + fieldSize) : u32(data, 4 + fieldSize);
  return { rows, columns, outputWidth, outputHeight };
}

function parseLhevcProperties(
  properties: readonly ISOBMFFBox[],
  allProperties: readonly ISOBMFFBox[],
  essentialIndexes: readonly number[],
  pixiInformation: PixelInformation | null,
): { lhevc: LhevcInfo; bitDepth: number } {
  const lhvCBoxes = properties.filter((prop) => prop.type === 'lhvC');
  const oinfBoxes = properties.filter((prop) => prop.type === 'oinf');
  const tolsBoxes = properties.filter((prop) => prop.type === 'tols');
  const lselBoxes = properties.filter((prop) => prop.type === 'lsel');
  if (lhvCBoxes.length !== 1 || oinfBoxes.length !== 1 || tolsBoxes.length !== 1)
    throw new HeicError(
      'INVALID_CONTAINER',
      'heic: lhv1 item must have exactly one lhvC, oinf, and tols property',
    );
  if (lselBoxes.length > 1)
    throw new HeicError('INVALID_CONTAINER', 'heic: lhv1 item has duplicate lsel properties');

  for (const [name, property] of [
    ['lhvC', lhvCBoxes[0]],
    ['tols', tolsBoxes[0]],
  ] as const) {
    const propertyIndex = allProperties.findIndex((entry) => entry === property) + 1;
    if (!essentialIndexes.includes(propertyIndex))
      throw new HeicError('INVALID_CONTAINER', `heic: ${name} property must be essential`);
  }
  if (lselBoxes.length === 1) {
    const lselIndex = allProperties.findIndex((prop) => prop === lselBoxes[0]) + 1;
    if (!essentialIndexes.includes(lselIndex))
      throw new HeicError('INVALID_CONTAINER', 'heic: lsel property must be essential');
  }

  const configuration = parseLhevcDecoderConfigurationRecord(lhvCBoxes[0].data);
  const operatingPointsInfo = parseOperatingPointsInfo(oinfBoxes[0].data);
  const targetOutputLayerSetIndex = parseTargetOutputLayerSet(tolsBoxes[0].data);
  const selectedLayerId = lselBoxes.length === 1 ? parseLayerSelector(lselBoxes[0].data) : null;
  const selectedOperatingPoint = operatingPointsInfo.operatingPoints.find(
    (entry) => entry.outputLayerSetIndex === targetOutputLayerSetIndex,
  );
  if (!selectedOperatingPoint)
    throw new HeicError(
      'INVALID_CONTAINER',
      'heic: tols selects an output layer set missing from oinf',
    );
  const outputLayerCount = selectedOperatingPoint.layers.filter(
    (layer) => layer.isOutputLayer,
  ).length;
  if (outputLayerCount > 1 !== (selectedLayerId !== null))
    throw new HeicError(
      'INVALID_CONTAINER',
      'heic: lsel presence disagrees with the selected output layer set',
    );
  const resolvedOutput = resolveLhevcOutput(
    operatingPointsInfo,
    targetOutputLayerSetIndex,
    selectedLayerId,
  );
  const selectedSps = configuration.arrays
    .filter((array) => array.nalUnitType === 33)
    .flatMap((array) => array.nalUnits)
    .find((nal) => nal.layerId === resolvedOutput.targetLayerId);
  const selectedSpsHeader =
    resolvedOutput.targetLayerId > 0 && selectedSps
      ? parseLayeredSpsHeader(selectedSps.data)
      : null;
  let selectedRepresentationFormat: HevcRepresentationFormat | null = null;
  let selectedVps: LayeredVpsInfo | null = null;
  if (selectedSpsHeader) {
    const vpsNal = configuration.arrays
      .filter((array) => array.nalUnitType === 32)
      .flatMap((array) => array.nalUnits)
      .find((nal) => readVpsId(nal.data) === selectedSpsHeader.videoParameterSetId);
    if (vpsNal) {
      const vps = parseLayeredVps(vpsNal.data);
      selectedVps = vps;
      selectedRepresentationFormat = selectLayerRepresentationFormat(
        vps,
        resolvedOutput.targetLayerId,
        selectedSpsHeader.updateRepFormatFlag,
        selectedSpsHeader.spsRepFormatIndex,
      );
    }
  }
  if (selectedRepresentationFormat && pixiInformation) {
    const format = selectedRepresentationFormat;
    validatePixiBitDepths(
      pixiInformation,
      format.bitDepthLuma,
      format.bitDepthChroma,
      'selected L-HEVC representation format',
    );
  }

  const lhevc: LhevcInfo = {
    configuration,
    operatingPointsInfo,
    selectedSpsHeader,
    selectedRepresentationFormat,
    selectedVps,
    ...resolvedOutput,
  };
  return {
    lhevc,
    // hvcC describes a single-layer HEVC configuration and cannot establish
    // the selected L-HEVC output layer's depth. Use output pixi when present;
    // otherwise leave it unknown until that layer's SPS is parsed.
    bitDepth:
      (pixiInformation ? pixiLumaBitDepth(pixiInformation) : undefined) ??
      selectedRepresentationFormat?.bitDepthLuma ??
      0,
  };
}

/**
 * Resolve the full picture of a HEIC file's primary image: dimensions,
 * codec configuration, grid layout, and display transforms.
 */
export function getHeicInfo(buffer: Uint8Array, boxes: ISOBMFFBox[], itemId?: number): HeicInfo {
  const ftyp = getFtypInfo(buffer);
  const miniBox = findBox(boxes, 'mini');
  if (ftyp && (ftyp.majorBrand === 'mif3' || ftyp.compatibleBrands.includes('mif3')) && miniBox) {
    const mini = parseMiniImage(miniBox.data, ftyp.minorVersion);
    const miniHdrProperties =
      mini.hdrProperties || mini.toneMappedHdrProperties
        ? {
            ...(mini.hdrProperties ? { baseImage: mini.hdrProperties } : {}),
            ...(mini.toneMappedHdrProperties
              ? { toneMappedImage: mini.toneMappedHdrProperties }
              : {}),
          }
        : undefined;
    if (
      itemId !== undefined &&
      itemId !== 1 &&
      itemId !== 2 &&
      !(mini.gainMap && (itemId === 3 || itemId === 4))
    )
      throw new HeicError('INVALID_CONTAINER', `heic: mini has no image item ${itemId}`);

    const parseMiniUncompressedConfiguration = (
      codecConfig: Uint8Array,
      width: number,
      height: number,
      bitDepth: number,
      chromaFormatIdc: number,
      label: string,
    ): UncompressedImageConfiguration => {
      const configuration = parseUncompressedImageConfiguration(
        [{ type: 'uncC', data: codecConfig, size: codecConfig.byteLength + 8, offset: 0 }],
        width,
        height,
      );
      if (
        configuration.floatingPointSamples ||
        configuration.bitDepth !== bitDepth ||
        configuration.chromaFormatIdc !== chromaFormatIdc
      )
        throw new HeicError(
          'INVALID_CONTAINER',
          `heic: mini ${label} properties disagree with uncC`,
        );
      return configuration;
    };
    const mainHvcC = mini.itemType === 'hvc1' ? parseHvcC(mini.codecConfig) : null;
    const mainAvcC = mini.itemType === 'avc1' ? parseAvcC(mini.codecConfig) : null;
    const mainUncompressed =
      mini.itemType === 'unci'
        ? parseMiniUncompressedConfiguration(
            mini.codecConfig,
            mini.width,
            mini.height,
            mini.bitDepth,
            mini.chromaFormatIdc,
            'image',
          )
        : null;
    const gainMapUncompressed =
      mini.itemType === 'unci' && mini.gainMap
        ? parseMiniUncompressedConfiguration(
            mini.gainMap.codecConfig,
            mini.gainMap.width,
            mini.gainMap.height,
            mini.gainMap.bitDepth,
            mini.gainMap.chromaFormatIdc,
            'gain-map',
          )
        : null;
    if (mainHvcC) {
      if (
        mainHvcC.chromaFormatIdc !== mini.chromaFormatIdc ||
        mainHvcC.bitDepthLumaMinus8 + 8 !== mini.bitDepth ||
        mainHvcC.bitDepthChromaMinus8 + 8 !== mini.bitDepth
      )
        throw new HeicError('INVALID_CONTAINER', 'heic: mini image properties disagree with hvcC');
    } else if (mainAvcC) {
      const chromaFormatIdc = mainAvcC.chromaFormatIdc ?? 1;
      const bitDepthLuma = (mainAvcC.bitDepthLumaMinus8 ?? 0) + 8;
      const bitDepthChroma = (mainAvcC.bitDepthChromaMinus8 ?? 0) + 8;
      if (
        chromaFormatIdc !== mini.chromaFormatIdc ||
        bitDepthLuma !== mini.bitDepth ||
        bitDepthChroma !== mini.bitDepth
      )
        throw new HeicError('INVALID_CONTAINER', 'heic: mini image properties disagree with avcC');
    } else if (!mainUncompressed) {
      throw new HeicError('UNSUPPORTED_FEATURE', 'heic: unsupported mini codec configuration');
    }

    if (mini.gainMap && itemId === 3) {
      if (!mini.gainMapMetadata || mini.gainMapMetadata.length === 0)
        throw new HeicError('INVALID_CONTAINER', 'heic: mini tone map has no gain-map metadata');
      return {
        primaryItemId: 3,
        primaryItemType: 'tmap',
        width: mini.width,
        height: mini.height,
        pixelAspectRatio: { horizontalSpacing: 1, verticalSpacing: 1 },
        bitDepth: mini.bitDepth,
        rotation: mini.rotation,
        mirror: mini.mirror,
        transforms:
          mini.rotation || mini.mirror !== null
            ? [
                ...(mini.rotation ? [{ type: 'irot' as const, value: mini.rotation }] : []),
                ...(mini.mirror !== null ? [{ type: 'imir' as const, value: mini.mirror }] : []),
              ]
            : [],
        hasAlpha: false,
        alphaItemId: null,
        auxiliaryImages: [],
        derivedItems: [1, 4],
        premultipliedAlpha: false,
        color: mini.toneMappedColor,
        icc: mini.toneMappedIccData,
        miniHdrProperties,
        hvcC: null,
        grid: null,
      };
    }

    if (itemId === 4) {
      const gainMap = mini.gainMap!;
      if (gainMapUncompressed) {
        const transforms: ImageTransform[] = [];
        if (mini.rotation) transforms.push({ type: 'irot', value: mini.rotation });
        if (mini.mirror !== null) transforms.push({ type: 'imir', value: mini.mirror });
        return {
          primaryItemId: 4,
          primaryItemType: 'unci',
          width: gainMap.width,
          height: gainMap.height,
          pixelAspectRatio: { horizontalSpacing: 1, verticalSpacing: 1 },
          bitDepth: gainMap.bitDepth,
          rotation: mini.rotation,
          mirror: mini.mirror,
          transforms,
          hasAlpha: false,
          alphaItemId: null,
          auxiliaryImages: [],
          derivedItems: [],
          premultipliedAlpha: false,
          color: {
            primaries: 2,
            transfer: 2,
            matrix: gainMap.matrix,
            fullRange: gainMap.fullRange,
          },
          icc: null,
          miniHdrProperties,
          hvcC: null,
          grid: null,
          uncompressedImage: gainMapUncompressed,
          chromaSampleLocation: {
            x: gainMap.chromaCenteredHorizontally ? 0.5 : 0,
            y: gainMap.chromaCenteredVertically ? 0.5 : 0,
          },
        };
      }
      if (mini.codecConfigType === 'avcC') {
        const gainMapAvcC = parseAvcC(gainMap.codecConfig),
          chromaFormatIdc = gainMapAvcC.chromaFormatIdc ?? 1,
          bitDepthLuma = (gainMapAvcC.bitDepthLumaMinus8 ?? 0) + 8,
          bitDepthChroma = (gainMapAvcC.bitDepthChromaMinus8 ?? 0) + 8;
        if (
          chromaFormatIdc !== gainMap.chromaFormatIdc ||
          bitDepthLuma !== gainMap.bitDepth ||
          bitDepthChroma !== gainMap.bitDepth
        )
          throw new HeicError(
            'INVALID_CONTAINER',
            'heic: mini AVC gain-map properties disagree with avcC',
          );
        const transforms: ImageTransform[] = [];
        if (mini.rotation) transforms.push({ type: 'irot', value: mini.rotation });
        if (mini.mirror !== null) transforms.push({ type: 'imir', value: mini.mirror });
        return {
          primaryItemId: 4,
          primaryItemType: 'avc1',
          width: gainMap.width,
          height: gainMap.height,
          pixelAspectRatio: { horizontalSpacing: 1, verticalSpacing: 1 },
          bitDepth: gainMap.bitDepth,
          rotation: mini.rotation,
          mirror: mini.mirror,
          transforms,
          hasAlpha: false,
          alphaItemId: null,
          auxiliaryImages: [],
          derivedItems: [],
          premultipliedAlpha: false,
          color: {
            primaries: 2,
            transfer: 2,
            matrix: gainMap.matrix,
            fullRange: gainMap.fullRange,
          },
          icc: null,
          miniHdrProperties,
          avcC: gainMapAvcC,
          hvcC: null,
          grid: null,
          chromaSampleLocation: {
            x: gainMap.chromaCenteredHorizontally ? 0.5 : 0,
            y: gainMap.chromaCenteredVertically ? 0.5 : 0,
          },
        };
      }
      const gainMapHvcC = parseHvcC(gainMap.codecConfig);
      if (
        gainMapHvcC.chromaFormatIdc !== gainMap.chromaFormatIdc ||
        gainMapHvcC.bitDepthLumaMinus8 + 8 !== gainMap.bitDepth ||
        gainMapHvcC.bitDepthChromaMinus8 + 8 !== gainMap.bitDepth
      )
        throw new HeicError(
          'INVALID_CONTAINER',
          'heic: mini gain-map properties disagree with hvcC',
        );
      const transforms: ImageTransform[] = [];
      if (mini.rotation) transforms.push({ type: 'irot', value: mini.rotation });
      if (mini.mirror !== null) transforms.push({ type: 'imir', value: mini.mirror });
      return {
        primaryItemId: 4,
        primaryItemType: 'hvc1',
        width: gainMap.width,
        height: gainMap.height,
        pixelAspectRatio: { horizontalSpacing: 1, verticalSpacing: 1 },
        bitDepth: gainMap.bitDepth,
        rotation: mini.rotation,
        mirror: mini.mirror,
        transforms,
        hasAlpha: false,
        alphaItemId: null,
        auxiliaryImages: [],
        derivedItems: [],
        premultipliedAlpha: false,
        color: {
          primaries: 2,
          transfer: 2,
          matrix: gainMap.matrix,
          fullRange: gainMap.fullRange,
        },
        icc: null,
        miniHdrProperties,
        hvcC: gainMapHvcC,
        grid: null,
        chromaSampleLocation: {
          x: gainMap.chromaCenteredHorizontally ? 0.5 : 0,
          y: gainMap.chromaCenteredVertically ? 0.5 : 0,
        },
      };
    }

    if (itemId === 2) {
      if (!mini.alphaItemData || !mini.alphaCodecConfig)
        throw new HeicError('INVALID_CONTAINER', 'heic: mini alpha item has no coded data');
      if (mini.codecConfigType === 'avcC') {
        const alphaAvcC = parseAvcC(mini.alphaCodecConfig);
        return {
          primaryItemId: 2,
          primaryItemType: 'avc1',
          width: mini.width,
          height: mini.height,
          pixelAspectRatio: { horizontalSpacing: 1, verticalSpacing: 1 },
          bitDepth: (alphaAvcC.bitDepthLumaMinus8 ?? 0) + 8,
          rotation: 0,
          mirror: null,
          transforms: [],
          hasAlpha: false,
          alphaItemId: null,
          auxiliaryImages: [],
          derivedItems: [],
          premultipliedAlpha: false,
          color: null,
          icc: null,
          avcC: alphaAvcC,
          hvcC: null,
          grid: null,
        };
      }
      const alphaHvcc = parseHvcC(mini.alphaCodecConfig);
      return {
        primaryItemId: 2,
        primaryItemType: 'hvc1',
        width: mini.width,
        height: mini.height,
        pixelAspectRatio: { horizontalSpacing: 1, verticalSpacing: 1 },
        bitDepth: alphaHvcc.bitDepthLumaMinus8 + 8,
        rotation: 0,
        mirror: null,
        transforms: [],
        hasAlpha: false,
        alphaItemId: null,
        auxiliaryImages: [],
        derivedItems: [],
        premultipliedAlpha: false,
        color: null,
        miniMetadata: undefined,
        icc: null,
        hvcC: alphaHvcc,
        grid: null,
      };
    }

    const transforms: ImageTransform[] = [];
    if (mini.rotation) transforms.push({ type: 'irot', value: mini.rotation });
    if (mini.mirror !== null) transforms.push({ type: 'imir', value: mini.mirror });
    return {
      primaryItemId: 1,
      primaryItemType: mini.itemType,
      width: mini.width,
      height: mini.height,
      pixelAspectRatio: { horizontalSpacing: 1, verticalSpacing: 1 },
      bitDepth: mini.bitDepth,
      rotation: mini.rotation,
      mirror: mini.mirror,
      transforms,
      hasAlpha: mini.alphaItemData !== null,
      alphaItemId: mini.alphaItemData ? 2 : null,
      auxiliaryImages: mini.alphaItemData
        ? [{ itemId: 2, type: 'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha' }]
        : [],
      derivedItems: [],
      premultipliedAlpha: mini.premultipliedAlpha,
      color: mini.color,
      chromaSampleLocation: {
        x: mini.chromaCenteredHorizontally ? 0.5 : 0,
        y: mini.chromaCenteredVertically ? 0.5 : 0,
      },
      miniMetadata:
        mini.exifData !== null || mini.xmpData !== null
          ? {
              exif: mini.exifData,
              xmp: mini.xmpData,
              exifXmpCompressed: mini.exifXmpCompressed,
            }
          : undefined,
      miniGainMap: mini.gainMap
        ? {
            metadataItemId: 3,
            imageItemId: 4,
            toneMappedColor: mini.toneMappedColor,
            toneMappedIcc: mini.toneMappedIccData,
          }
        : undefined,
      miniHdrProperties,
      icc: mini.iccData,
      hvcC: mainHvcC,
      avcC: mainAvcC,
      uncompressedImage: mainUncompressed ?? undefined,
      grid: null,
    };
  }

  const metaBox = findBox(boxes, 'meta');
  if (!metaBox?.children) {
    if (findBox(boxes, 'moov'))
      throw new HeicError('UNSUPPORTED_FEATURE', 'heic: timed image sequences are not supported');
    throw new HeicError('INVALID_CONTAINER', 'heic: no meta box found');
  }

  const pitmBox = findBox(metaBox.children, 'pitm');
  if (!pitmBox) throw new HeicError('INVALID_CONTAINER', 'heic: no primary item (pitm) box found');
  const primaryItemId = itemId ?? parsePitm(pitmBox.data);

  const iinfBox = findBox(metaBox.children, 'iinf');
  const items = iinfBox ? parseIinf(iinfBox.data) : [];
  const primaryItem = items.find((i) => i.itemId === primaryItemId);
  if (primaryItem?.itemProtectionIndex)
    throw new HeicError('UNSUPPORTED_FEATURE', 'heic: encrypted image items are not supported');
  if (!primaryItem)
    throw new HeicError(
      'INVALID_CONTAINER',
      `heic: primary item ${primaryItemId} not present in iinf`,
    );

  const iprpBox = findBox(metaBox.children, 'iprp');
  const ipcoBox = iprpBox?.children ? findBox(iprpBox.children, 'ipco') : undefined;
  const ipmaBox = iprpBox?.children ? findBox(iprpBox.children, 'ipma') : undefined;
  if (!ipcoBox?.children || !ipmaBox)
    throw new HeicError('INVALID_CONTAINER', 'heic: missing item properties (ipco/ipma)');

  const associations = parseIpma(ipmaBox.data);
  const itemTypeById = new Map(items.map((item) => [item.itemId, item.itemType]));
  const propsFor = (targetItemId: number): ISOBMFFBox[] => {
    const assoc = associations.find((a) => a.itemId === targetItemId);
    if (!assoc) return [];
    for (const index of assoc.propertyIndexes)
      if (index > ipcoBox.children!.length)
        throw new HeicError(
          'INVALID_CONTAINER',
          'heic: property association index is out of range',
        );
    for (const index of assoc.essentialIndexes) {
      const type = ipcoBox.children![index - 1]?.type;
      const layeredHevcProperty =
        itemTypeById.get(targetItemId) === 'lhv1' &&
        ['lhvC', 'oinf', 'tols', 'lsel'].includes(type ?? '');
      const uncompressedProperty =
        itemTypeById.get(targetItemId) === 'unci' &&
        ['uncC', 'cmpd', 'cmpC', 'icef'].includes(type ?? '');
      if (
        index &&
        !layeredHevcProperty &&
        !uncompressedProperty &&
        ![
          'hvcC',
          'avcC',
          'ispe',
          'pixi',
          'irot',
          'imir',
          'clap',
          'iscl',
          'rloc',
          'auxC',
          'colr',
          'pasp',
          'clli',
          'mdcv',
          'cclv',
          'amve',
          'reve',
          'ndwt',
          'rref',
          'tilC',
          'cmex',
          'cmin',
          'prdi',
        ].includes(type!)
      )
        throw new HeicError('UNSUPPORTED_FEATURE', 'heic: unsupported essential property ' + type);
    }
    return assoc.propertyIndexes.map((index) => ipcoBox.children![index - 1]).filter(Boolean);
  };

  const irefBox = findBox(metaBox.children, 'iref');
  const refs = irefBox ? parseIref(irefBox) : [];
  const stereoPairs = parseStereoPairs(findBox(metaBox.children, 'grpl'), items);
  const primaryProps = propsFor(primaryItemId);
  const pixelAspectRatio = parsePixelAspectRatio(primaryProps);
  const relativeLocation = parseRelativeImageLocation(
    primaryProps,
    refs,
    primaryItemId,
    new Set(items.map((item) => item.itemId)),
  );
  const heifHdrProperties = parseHeifHdrItemProperties(primaryProps);
  const primaryDimgInputCount = refs
    .filter(
      (reference) => reference.referenceType === 'dimg' && reference.fromItemId === primaryItemId,
    )
    .reduce((count, reference) => count + reference.toItemIds.length, 0);
  const progressiveDerivedImage = parseProgressiveDerivedImageInfo(
    primaryProps,
    primaryItem.itemType,
    primaryDimgInputCount,
  );
  const predReferences = refs.filter(
    (ref) => ref.referenceType === 'pred' && ref.fromItemId === primaryItemId,
  );
  const externalBaseReferences = refs.filter(
    (ref) => ref.referenceType === 'exbl' && ref.fromItemId === primaryItemId,
  );
  let externalBaseLayerItemId: number | undefined;
  if (externalBaseReferences.length > 0) {
    if (primaryItem.itemType !== 'lhv1')
      throw new HeicError('INVALID_CONTAINER', 'heic: exbl reference is only valid for lhv1 items');
    const targets = externalBaseReferences.flatMap((reference) => reference.toItemIds);
    if (targets.length !== 1 || !itemTypeById.has(targets[0]))
      throw new HeicError(
        'INVALID_CONTAINER',
        'heic: lhv1 exbl reference must name exactly one existing image item',
      );
    externalBaseLayerItemId = targets[0];
  }
  const rrefBox = primaryProps.find((prop) => prop.type === 'rref');
  let predReferenceItemIds: number[] = [];
  if (rrefBox) {
    const association = associations.find((entry) => entry.itemId === primaryItemId);
    const rrefIndex = ipcoBox.children.findIndex((prop) => prop === rrefBox) + 1;
    if (!association?.essentialIndexes.includes(rrefIndex))
      throw new HeicError('INVALID_CONTAINER', 'heic: rref property must be essential');
    const requiredTypes = parseRequiredReferenceTypes(rrefBox.data);
    const hasPredReferences = predReferences.length > 0;
    if (hasPredReferences || requiredTypes.includes('pred')) {
      // ISO/IEC 23008-12 requires a predictively coded image item to declare
      // exactly one required reference type: `pred`. Other reference types
      // can be declared by non-predictive derived/auxiliary image items.
      if (requiredTypes.length !== 1 || requiredTypes[0] !== 'pred')
        throw new HeicError(
          'INVALID_CONTAINER',
          'heic: predictively coded image must require only pred references',
        );
      if (predReferences.length === 0)
        throw new HeicError('INVALID_CONTAINER', 'heic: rref requires a missing pred reference');
      predReferenceItemIds = predReferences.flatMap((ref) => ref.toItemIds);
    } else {
      // These reference types are consumed by this decoder's item paths.
      // Unknown required types must continue to fail rather than be ignored.
      const supportedRequiredTypes = new Set(['auxl', 'dimg', 'exbl', 'prem', 'tbas']);
      const unsupportedType = requiredTypes.find((type) => !supportedRequiredTypes.has(type));
      if (unsupportedType)
        throw new HeicError(
          'UNSUPPORTED_FEATURE',
          `heic: required image reference type ${unsupportedType} is not supported`,
        );
      for (const type of requiredTypes) {
        const present = refs.some(
          (reference) =>
            reference.referenceType === type &&
            (type === 'auxl'
              ? reference.toItemIds.includes(primaryItemId)
              : reference.fromItemId === primaryItemId),
        );
        if (!present)
          throw new HeicError(
            'INVALID_CONTAINER',
            `heic: rref requires a missing ${type} reference`,
          );
      }
    }
  } else if (predReferences.length > 0) {
    throw new HeicError('INVALID_CONTAINER', 'heic: predictively coded image has no rref property');
  }

  const ispeBox = primaryProps.find((b) => b.type === 'ispe');
  const extent = ispeBox ? parseIspe(ispeBox.data) : { width: 0, height: 0 };
  let bitDepth = 8;
  let uncompressedImage: UncompressedImageConfiguration | undefined;
  if (primaryItem.itemType === 'unci') {
    if (primaryProps.filter((property) => property.type === 'ispe').length !== 1)
      throw new HeicError(
        'INVALID_CONTAINER',
        'heic: unci item must have exactly one ispe property',
      );
    const association = associations.find((entry) => entry.itemId === primaryItemId);
    const uncCIndexes = (association?.propertyIndexes ?? []).filter(
      (index) => ipcoBox.children![index - 1]?.type === 'uncC',
    );
    const cmpdIndexes = (association?.propertyIndexes ?? []).filter(
      (index) => ipcoBox.children![index - 1]?.type === 'cmpd',
    );
    const cmpCIndexes = (association?.propertyIndexes ?? []).filter(
      (index) => ipcoBox.children![index - 1]?.type === 'cmpC',
    );
    if (uncCIndexes.length !== 1 || !association?.essentialIndexes.includes(uncCIndexes[0]))
      throw new HeicError(
        'INVALID_CONTAINER',
        'heic: unci item requires one essential uncC property',
      );
    const uncCProperty = primaryProps.find((property) => property.type === 'uncC')!;
    if (uncCProperty.data[0] === 0) {
      if (cmpdIndexes.length !== 1 || !association.essentialIndexes.includes(cmpdIndexes[0]))
        throw new HeicError(
          'INVALID_CONTAINER',
          'heic: version-0 unci item requires one essential cmpd property',
        );
    } else if (cmpdIndexes.length > 1) {
      throw new HeicError('INVALID_CONTAINER', 'heic: unci item has duplicate cmpd properties');
    }
    if (cmpCIndexes.length > 1)
      throw new HeicError('INVALID_CONTAINER', 'heic: unci item has duplicate cmpC properties');
    if (cmpCIndexes.length === 1 && !association?.essentialIndexes.includes(cmpCIndexes[0]))
      throw new HeicError(
        'INVALID_CONTAINER',
        'heic: generic-compression cmpC property shall be essential',
      );
    uncompressedImage = parseUncompressedImageConfiguration(
      primaryProps,
      extent.width,
      extent.height,
    );
    bitDepth = uncompressedImage.bitDepth;
  }

  const pixiBox = primaryProps.find((b) => b.type === 'pixi');
  let pixiInformation: PixelInformation | null = null;
  const assertHevcPixiComponentFormats = (information: PixelInformation | null): void => {
    if (information?.channels?.some((channel) => channel.componentFormat !== 0))
      throw new HeicError(
        'INVALID_CONTAINER',
        'heic: HEVC pixel information must use unsigned-integer components',
      );
  };
  const validateUncompressedPixi = (
    information: PixelInformation | null,
    configuration: UncompressedImageConfiguration,
  ): void => {
    if (!information) return;
    const components = configuration.components;
    if (information.bitsPerChannel.length !== components.length)
      throw new HeicError('INVALID_CONTAINER', 'heic: pixi channel count disagrees with uncC');
    if (information.bitsPerChannel.some((depth, index) => depth !== components[index].bitDepth))
      throw new HeicError('INVALID_CONTAINER', 'heic: pixi bit depths disagree with uncC');
    if (
      information.channels?.some(
        (channel, index) => channel.componentFormat !== components[index].componentFormat,
      )
    )
      throw new HeicError('INVALID_CONTAINER', 'heic: pixi component formats disagree with uncC');
  };
  if (pixiBox) {
    pixiInformation = parsePixi(pixiBox.data);
    if (primaryItem.itemType === 'unci') {
      validateUncompressedPixi(pixiInformation, uncompressedImage!);
    } else if (primaryItem.itemType !== 'tili') assertHevcPixiComponentFormats(pixiInformation);
    if (primaryItem.itemType !== 'unci') bitDepth = pixiLumaBitDepth(pixiInformation) ?? bitDepth;
  }

  const irotBox = primaryProps.find((b) => b.type === 'irot');
  const rotation = irotBox ? irotBox.data[0] & 0x03 : 0;
  const imirBox = primaryProps.find((b) => b.type === 'imir');
  const mirror = imirBox ? imirBox.data[0] & 0x01 : null;
  if (primaryProps.filter((prop) => prop.type === 'iscl').length > 1)
    throw new HeicError('INVALID_CONTAINER', 'heic: duplicate image scaling property');

  const transforms: ImageTransform[] = primaryProps
    .filter((prop) => ['clap', 'irot', 'imir', 'iscl'].includes(prop.type))
    .map((prop) => {
      if (prop.type === 'iscl') {
        if (
          prop.data.length !== 12 ||
          prop.data[0] !== 0 ||
          prop.data[1] !== 0 ||
          prop.data[2] !== 0 ||
          prop.data[3] !== 0
        )
          throw new HeicError('INVALID_CONTAINER', 'heic: invalid image scaling property');
        const view = new DataView(prop.data.buffer, prop.data.byteOffset, prop.data.byteLength),
          targetWidthNumerator = view.getUint16(4),
          targetWidthDenominator = view.getUint16(6),
          targetHeightNumerator = view.getUint16(8),
          targetHeightDenominator = view.getUint16(10);
        if (
          !targetWidthNumerator ||
          !targetWidthDenominator ||
          !targetHeightNumerator ||
          !targetHeightDenominator
        )
          throw new HeicError('INVALID_CONTAINER', 'heic: zero image scaling ratio');
        return {
          type: 'iscl',
          targetWidthNumerator,
          targetWidthDenominator,
          targetHeightNumerator,
          targetHeightDenominator,
        };
      }
      if (prop.type === 'clap') {
        if (prop.data.length !== 32)
          throw new HeicError('INVALID_CONTAINER', 'heic: invalid clean aperture property');
        const v = new DataView(prop.data.buffer, prop.data.byteOffset, 32);
        const ratio = (offset: number, signed = false) => {
          const denominator = v.getUint32(offset + 4);
          if (!denominator)
            throw new HeicError('INVALID_CONTAINER', 'heic: zero clean aperture denominator');
          return (signed ? v.getInt32(offset) : v.getUint32(offset)) / denominator;
        };
        return {
          type: 'clap',
          width: ratio(0),
          height: ratio(8),
          horizontalOffset: ratio(16, true),
          verticalOffset: ratio(24, true),
        };
      }
      if (prop.data.length !== 1)
        throw new HeicError('INVALID_CONTAINER', 'heic: invalid image transform property');
      return {
        type: prop.type as 'irot' | 'imir',
        value: prop.data[0] & (prop.type === 'irot' ? 3 : 1),
      };
    });
  const cameraProperties = parseHeifCameraProperties(
    primaryProps,
    extent.width,
    extent.height,
    transforms,
  );
  const auxiliaryImages = refs
    .filter((ref) => ref.referenceType === 'auxl' && ref.toItemIds.includes(primaryItemId))
    .map((ref) => {
      const aux = propsFor(ref.fromItemId).find((prop) => prop.type === 'auxC');
      if (!aux || aux.data.length < 5 || aux.data[0] !== 0)
        throw new HeicError('INVALID_CONTAINER', 'heic: invalid auxiliary image descriptor');
      const end = aux.data.indexOf(0, 4);
      if (end < 0) throw new HeicError('INVALID_CONTAINER', 'heic: unterminated auxiliary type');
      const type = new TextDecoder().decode(aux.data.subarray(4, end)),
        subtype = aux.data.subarray(end + 1);
      return {
        itemId: ref.fromItemId,
        type,
        ...(type.startsWith('urn:mpeg:hevc:2015:auxid:') && subtype.length
          ? { hevcAuxConfigSubtype: subtype }
          : {}),
      };
    });
  const alphaItems = auxiliaryImages.filter((aux) =>
    ['urn:mpeg:hevc:2015:auxid:1', 'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha'].includes(
      aux.type,
    ),
  );
  if (alphaItems.length > 1)
    throw new HeicError('INVALID_CONTAINER', 'heic: duplicate auxiliary alpha planes');
  const alphaItemId = alphaItems[0]?.itemId ?? null;
  const hasAlpha = alphaItemId !== null;
  const derivedItems = refs
    .filter((ref) => ref.referenceType === 'dimg' && ref.fromItemId === primaryItemId)
    .flatMap((ref) => ref.toItemIds);
  const premultipliedAlpha = refs.some(
    (ref) =>
      ref.referenceType === 'prem' &&
      ref.fromItemId === primaryItemId &&
      ref.toItemIds.includes(alphaItemId!),
  );
  const colrProperties = primaryProps.filter((prop) => prop.type === 'colr');
  let color: HeicInfo['color'] = null;
  let icc: Uint8Array | null = null;
  let iccType: HeicInfo['iccType'] = null;
  const seenColorTypes = new Set<string>(),
    profileByType = new Map<'prof' | 'rICC', Uint8Array>();
  for (const property of colrProperties) {
    const colr = property.data;
    if (colr.length < 4)
      throw new HeicError('INVALID_CONTAINER', 'heic: truncated color information type');
    const type = new TextDecoder().decode(colr.subarray(0, 4));
    if (type !== 'nclx' && type !== 'prof' && type !== 'rICC') continue;
    if (seenColorTypes.has(type))
      throw new HeicError('INVALID_CONTAINER', `heic: duplicate colr property of type ${type}`);
    seenColorTypes.add(type);
    if (type === 'nclx') {
      if (colr.length < 11)
        throw new HeicError('INVALID_CONTAINER', 'heic: truncated nclx color information');
      color = {
        primaries: u16(colr, 4),
        transfer: u16(colr, 6),
        matrix: u16(colr, 8),
        fullRange: !!(colr[10] & 128),
      };
    } else profileByType.set(type, colr.subarray(4));
  }
  // HEIF colour information of different colour_type values has distinct
  // purposes and its association order is not semantically significant.
  // Keep both ICC forms when present; prefer the unrestricted `prof` profile
  // for the legacy single-profile rendering fields.
  const iccProfiles: NonNullable<HeicInfo['iccProfiles']> = [];
  for (const type of ['prof', 'rICC'] as const) {
    const data = profileByType.get(type);
    if (data) iccProfiles.push({ type, data });
  }
  const selectedIcc = iccProfiles[0];
  if (selectedIcc) {
    icc = selectedIcc.data;
    iccType = selectedIcc.type;
  }

  let grid: GridInfo | null = null;
  let tiledImage: TiledImageInfo | null = null;
  let hvcC: HvcCConfig | null = null;
  let avcC: AvcCConfig | null = null;
  let lhevc: LhevcInfo | null = null;

  if (primaryItem.itemType === 'grid') {
    const body = getItemPayload(buffer, boxes, primaryItemId);
    if (!body) throw new HeicError('INVALID_CONTAINER', 'heic: grid item has no body');
    const gridBody = parseGridBody(body);

    const dimg = refs.find((r) => r.referenceType === 'dimg' && r.fromItemId === primaryItemId);
    if (!dimg)
      throw new HeicError('INVALID_CONTAINER', 'heic: grid image without dimg tile references');

    const firstTileProps = propsFor(dimg.toItemIds[0]);
    const tileIspe = firstTileProps.find((b) => b.type === 'ispe');
    const tileExtent = tileIspe ? parseIspe(tileIspe.data) : { width: 0, height: 0 };

    grid = {
      ...gridBody,
      tileItemIds: dimg.toItemIds,
      tileWidth: tileExtent.width,
      tileHeight: tileExtent.height,
    };

    const tileHvcc = firstTileProps.find((b) => b.type === 'hvcC');
    if (tileHvcc) hvcC = parseHvcC(tileHvcc.data);
    else if (itemTypeById.get(dimg.toItemIds[0]) === 'tili') {
      // A tili child carries its codec properties through tilC/tipa, so they
      // are not necessarily directly associated with the child image item.
      const firstTileInfo = getHeicInfo(buffer, boxes, dimg.toItemIds[0]);
      hvcC = firstTileInfo.hvcC;
      avcC = firstTileInfo.avcC ?? null;
      lhevc = firstTileInfo.lhevc ?? null;
    }
  } else if (primaryItem.itemType === 'tili') {
    if (primaryProps.filter((prop) => prop.type === 'ispe').length !== 1)
      throw new HeicError(
        'INVALID_CONTAINER',
        'heic: tili item must have exactly one ispe property',
      );
    const tilCProperties = primaryProps.filter((prop) => prop.type === 'tilC');
    if (tilCProperties.length !== 1)
      throw new HeicError(
        'INVALID_CONTAINER',
        'heic: tili item must have exactly one tilC property',
      );
    const tilCBox = tilCProperties[0];
    const ilocBox = findBox(metaBox.children, 'iloc');
    if (!ilocBox) throw new HeicError('INVALID_CONTAINER', 'heic: tili item has no iloc box');
    const itemLocation = parseIloc(ilocBox.data).find(
      (location) => location.itemId === primaryItemId,
    );
    if (!itemLocation)
      throw new HeicError('INVALID_CONTAINER', 'heic: tili item has no iloc entry');
    if (itemLocation.dataReferenceIndex === 0)
      throw new HeicError('INVALID_CONTAINER', 'heic: tili item has no deti data reference');
    const drefBox = findBox(metaBox.children, 'dref');
    const dataReferenceBox = drefBox?.children?.[itemLocation.dataReferenceIndex - 1];
    if (!dataReferenceBox || dataReferenceBox.type !== 'deti')
      throw new HeicError('INVALID_CONTAINER', 'heic: tili item does not reference a deti box');
    const dataReference = parseTiledDataReference(dataReferenceBox.data);
    const tileConfig = parseTiledImageConfiguration(tilCBox.data, dataReference.externalTileUrls);
    if (extent.width <= 0 || extent.height <= 0)
      throw new HeicError('INVALID_CONTAINER', 'heic: tili item has invalid image dimensions');
    const columns = Math.ceil(extent.width / tileConfig.tileWidth);
    const rows = Math.ceil(extent.height / tileConfig.tileHeight);
    const tileCount =
      columns * rows * tileConfig.extraDimensionSizes.reduce((product, size) => product * size, 1);
    if (!Number.isSafeInteger(tileCount) || tileCount <= 0 || tileCount > 4_000_000)
      throw new HeicError('RESOURCE_LIMIT', 'heic: tili tile count exceeds the decoder limit');

    if (dataReference.inputItemCount !== tileCount)
      throw new HeicError('INVALID_CONTAINER', 'heic: deti tile count does not match tili extent');

    if (dataReference.externalTileUrls) {
      bitDepth = 0;
      tiledImage = {
        rows,
        columns,
        tileWidth: tileConfig.tileWidth,
        tileHeight: tileConfig.tileHeight,
        extraDimensionSizes: tileConfig.extraDimensionSizes,
        tileItemType: null,
        dataReference,
      };
    } else {
      if (!tileConfig.tileItemType)
        throw new HeicError(
          'INVALID_CONTAINER',
          'heic: in-file tilC property has no tile_item_type',
        );
      if (
        tileConfig.tileItemType !== 'hvc1' &&
        tileConfig.tileItemType !== 'lhv1' &&
        tileConfig.tileItemType !== 'avc1' &&
        tileConfig.tileItemType !== 'unci'
      )
        throw new HeicError(
          'UNSUPPORTED_FEATURE',
          `heic: unsupported tili tile codec ${tileConfig.tileItemType}`,
        );

      const tilePropertyBoxes = ipcoBox.children!;
      for (const index of tileConfig.propertyIndexes)
        if (index > tilePropertyBoxes.length)
          throw new HeicError('INVALID_CONTAINER', 'heic: tipa property index is out of range');
      for (const index of tileConfig.essentialIndexes) {
        const type = tilePropertyBoxes[index - 1]?.type;
        if (
          type !== 'hvcC' &&
          type !== 'avcC' &&
          type !== 'lhvC' &&
          type !== 'oinf' &&
          type !== 'tols' &&
          type !== 'lsel' &&
          type !== 'ispe' &&
          type !== 'pixi' &&
          type !== 'colr' &&
          type !== 'cmpd' &&
          type !== 'uncC' &&
          type !== 'cmpC' &&
          type !== 'icef'
        )
          throw new HeicError(
            'UNSUPPORTED_FEATURE',
            'heic: unsupported essential tile property ' + type,
          );
      }
      const tileProperties = tileConfig.propertyIndexes
        .map((index) => tilePropertyBoxes[index - 1])
        .filter(Boolean);
      const tileIspe = tileProperties.find((prop) => prop.type === 'ispe');
      if (tileIspe) {
        const tileExtent = parseIspe(tileIspe.data);
        if (
          tileExtent.width !== tileConfig.tileWidth ||
          tileExtent.height !== tileConfig.tileHeight
        )
          throw new HeicError('INVALID_CONTAINER', 'heic: tile ispe dimensions disagree with tilC');
      }
      const tilePixi = tileProperties.find((prop) => prop.type === 'pixi');
      let tilePixiInformation: PixelInformation | null = null;
      if (tilePixi) {
        tilePixiInformation = parsePixi(tilePixi.data);
        if (!pixiBox) {
          if (tilePixiInformation.bitsPerChannel.length > 0)
            bitDepth = tilePixiInformation.bitsPerChannel[0];
        }
      }
      if (tileConfig.tileItemType !== 'unci') {
        assertHevcPixiComponentFormats(tilePixiInformation);
        assertHevcPixiComponentFormats(pixiInformation);
      }
      if (colrProperties.length === 0) {
        const tileColr = tileProperties.find((prop) => prop.type === 'colr')?.data;
        if (tileColr) {
          const type = new TextDecoder().decode(tileColr.subarray(0, 4));
          if (type === 'nclx') {
            if (tileColr.length < 11)
              throw new HeicError(
                'INVALID_CONTAINER',
                'heic: truncated tile nclx color information',
              );
            color = {
              primaries: u16(tileColr, 4),
              transfer: u16(tileColr, 6),
              matrix: u16(tileColr, 8),
              fullRange: !!(tileColr[10] & 128),
            };
          } else if (type === 'prof' || type === 'rICC') {
            icc = tileColr.subarray(4);
            iccType = type;
          }
        }
      }
      if (tileConfig.tileItemType === 'avc1') {
        const tileAvcC = tileProperties.filter((prop) => prop.type === 'avcC');
        if (tileAvcC.length !== 1)
          throw new HeicError(
            'INVALID_CONTAINER',
            'heic: avc1 tili tile properties must have exactly one avcC',
          );
        avcC = parseAvcC(tileAvcC[0].data);
        const lumaDepth = (avcC.bitDepthLumaMinus8 ?? 0) + 8;
        const chromaDepth = (avcC.bitDepthChromaMinus8 ?? 0) + 8;
        if (avcC.bitDepthLumaMinus8 !== null && avcC.bitDepthChromaMinus8 !== null)
          validatePixiBitDepths(
            tilePixiInformation ?? pixiInformation,
            lumaDepth,
            chromaDepth,
            'avcC',
          );
        bitDepth =
          (tilePixiInformation ? pixiLumaBitDepth(tilePixiInformation) : undefined) ?? lumaDepth;
      } else if (tileConfig.tileItemType === 'hvc1') {
        const tileHvcc = tileProperties.find((prop) => prop.type === 'hvcC');
        if (!tileHvcc)
          throw new HeicError('INVALID_CONTAINER', 'heic: tili tile properties have no hvcC');
        hvcC = parseHvcC(tileHvcc.data);
        validatePixiBitDepths(
          pixiInformation ?? tilePixiInformation,
          hvcC.bitDepthLumaMinus8 + 8,
          hvcC.bitDepthChromaMinus8 + 8,
        );
        bitDepth = hvcC.bitDepthLumaMinus8 + 8;
      } else if (tileConfig.tileItemType === 'unci') {
        const uncCIndexes = tileConfig.propertyIndexes.filter(
          (index) => tilePropertyBoxes[index - 1]?.type === 'uncC',
        );
        const cmpdIndexes = tileConfig.propertyIndexes.filter(
          (index) => tilePropertyBoxes[index - 1]?.type === 'cmpd',
        );
        const cmpCIndexes = tileConfig.propertyIndexes.filter(
          (index) => tilePropertyBoxes[index - 1]?.type === 'cmpC',
        );
        if (uncCIndexes.length !== 1 || !tileConfig.essentialIndexes.includes(uncCIndexes[0]))
          throw new HeicError(
            'INVALID_CONTAINER',
            'heic: unci tili tiles require one essential uncC property',
          );
        const uncCProperty = tilePropertyBoxes[uncCIndexes[0] - 1];
        if (uncCProperty.data[0] === 0) {
          if (cmpdIndexes.length !== 1 || !tileConfig.essentialIndexes.includes(cmpdIndexes[0]))
            throw new HeicError(
              'INVALID_CONTAINER',
              'heic: version-0 unci tili tiles require one essential cmpd property',
            );
        } else if (cmpdIndexes.length > 1)
          throw new HeicError('INVALID_CONTAINER', 'heic: unci tili tiles have duplicate cmpd');
        if (cmpCIndexes.length > 1)
          throw new HeicError('INVALID_CONTAINER', 'heic: unci tili tiles have duplicate cmpC');
        if (cmpCIndexes.length === 1 && !tileConfig.essentialIndexes.includes(cmpCIndexes[0]))
          throw new HeicError(
            'INVALID_CONTAINER',
            'heic: generic-compression cmpC property shall be essential',
          );
        uncompressedImage = parseUncompressedImageConfiguration(
          tileProperties,
          tileConfig.tileWidth,
          tileConfig.tileHeight,
        );
        validateUncompressedPixi(tilePixiInformation, uncompressedImage);
        validateUncompressedPixi(pixiInformation, uncompressedImage);
        bitDepth = uncompressedImage.bitDepth;
      } else {
        const parsed = parseLhevcProperties(
          tileProperties,
          tilePropertyBoxes,
          tileConfig.essentialIndexes,
          tilePixiInformation ?? pixiInformation,
        );
        lhevc = parsed.lhevc;
        bitDepth = parsed.bitDepth;
      }
      tiledImage = {
        rows,
        columns,
        tileWidth: tileConfig.tileWidth,
        tileHeight: tileConfig.tileHeight,
        extraDimensionSizes: tileConfig.extraDimensionSizes,
        tileItemType: tileConfig.tileItemType,
        dataReference,
      };
    }
  } else if (primaryItem.itemType === 'lhv1') {
    const association = associations.find((entry) => entry.itemId === primaryItemId);
    const parsed = parseLhevcProperties(
      primaryProps,
      ipcoBox.children,
      association?.essentialIndexes ?? [],
      pixiInformation,
    );
    lhevc = parsed.lhevc;
    const hvccBox = primaryProps.find((prop) => prop.type === 'hvcC');
    if (hvccBox) hvcC = parseHvcC(hvccBox.data);
    bitDepth = parsed.bitDepth;
  } else if (primaryItem.itemType === 'avc1') {
    const avcCBoxes = primaryProps.filter((property) => property.type === 'avcC');
    if (avcCBoxes.length !== 1)
      throw new HeicError(
        'INVALID_CONTAINER',
        'heic: avc1 image item must have exactly one avcC property',
      );
    avcC = parseAvcC(avcCBoxes[0].data);
    if (avcC.bitDepthLumaMinus8 !== null && avcC.bitDepthChromaMinus8 !== null) {
      validatePixiBitDepths(
        pixiInformation,
        avcC.bitDepthLumaMinus8 + 8,
        avcC.bitDepthChromaMinus8 + 8,
        'avcC',
      );
      bitDepth =
        (pixiInformation ? pixiLumaBitDepth(pixiInformation) : undefined) ??
        avcC.bitDepthLumaMinus8 + 8;
    }
  } else {
    const hvccBox = primaryProps.find((b) => b.type === 'hvcC');
    if (hvccBox) {
      hvcC = parseHvcC(hvccBox.data);
      validatePixiBitDepths(
        pixiInformation,
        hvcC.bitDepthLumaMinus8 + 8,
        hvcC.bitDepthChromaMinus8 + 8,
      );
      bitDepth = hvcC.bitDepthLumaMinus8 + 8;
    }
  }

  return {
    primaryItemId,
    primaryItemType: primaryItem.itemType,
    width: extent.width || grid?.outputWidth || 0,
    height: extent.height || grid?.outputHeight || 0,
    pixelAspectRatio,
    relativeLocation,
    heifHdrProperties,
    ...(progressiveDerivedImage ? { progressiveDerivedImage } : {}),
    bitDepth,
    rotation,
    mirror,
    hasAlpha:
      hasAlpha ||
      uncompressedImage?.components.some((component) => component.componentType === 7) === true,
    transforms,
    alphaItemId,
    auxiliaryImages,
    stereoPairs,
    predReferenceItemIds,
    externalBaseLayerItemId,
    derivedItems,
    premultipliedAlpha,
    color,
    ...cameraProperties,
    ...(iccProfiles.length ? { iccProfiles } : {}),
    chromaSampleLocations: parsePixiChromaSampleLocations(
      pixiInformation,
      hvcC?.chromaFormatIdc ??
        lhevc?.selectedRepresentationFormat?.chromaFormatIdc ??
        avcC?.chromaFormatIdc ??
        undefined,
    ),
    icc,
    iccType,
    hvcC,
    avcC,
    uncompressedImage,
    lhevc,
    grid,
    tiledImage,
  };
}

function parsePixiChromaSampleLocations(
  information: PixelInformation | null,
  chromaFormatIdc?: number,
): HeicInfo['chromaSampleLocations'] {
  if (!information?.channels) return undefined;
  const expectedSubsamplingType =
    chromaFormatIdc === undefined
      ? undefined
      : chromaFormatIdc === 3
        ? 0
        : chromaFormatIdc === 2
          ? 1
          : chromaFormatIdc === 1
            ? 2
            : null;
  let cb: ChromaSampleLocation | undefined;
  let cr: ChromaSampleLocation | undefined;
  for (const channel of information.channels) {
    if (channel.channelIdc !== 3 && channel.channelIdc !== 4) continue;
    if (!channel.subsampling) continue;
    if (expectedSubsamplingType === null || channel.subsampling.type !== expectedSubsamplingType)
      throw new HeicError(
        'INVALID_CONTAINER',
        'heic: pixi chroma subsampling disagrees with the HEVC chroma format',
      );
    const location = chromaSampleLocationFromCode(
      channel.subsampling.type,
      channel.subsampling.location,
    );
    if (!location)
      throw new HeicError('UNSUPPORTED_FEATURE', 'heic: unsupported pixi chroma sample location');
    if (channel.channelIdc === 3) cb = location;
    else cr = location;
  }
  return cb || cr ? { ...(cb ? { cb } : {}), ...(cr ? { cr } : {}) } : undefined;
}

/**
 * Extract one item's payload, honoring the iloc construction method:
 * 0 = absolute file offsets, 1 = offsets into the `idat` box, and 2 = offsets
 * into item data selected through an `iloc` item reference.
 */
export function getItemPayload(
  buffer: Uint8Array,
  boxes: ISOBMFFBox[],
  itemId: number,
  externalItemData?: Readonly<Record<number, Uint8Array>>,
): Uint8Array | null {
  return getItemPayloadRecursive(buffer, boxes, itemId, new Set(), 0, externalItemData);
}

export type ExternalItemDataReference =
  | { type: 'url'; url: string }
  | { type: 'urn'; name: string; location?: string };

/** Return an item's caller-resolvable external `url ` or `urn ` reference. */
export function getItemDataReference(
  boxes: ISOBMFFBox[],
  itemId: number,
): ExternalItemDataReference | null {
  const metaBox = findBox(boxes, 'meta');
  if (!metaBox?.children) return null;
  const ilocBox = findBox(metaBox.children, 'iloc');
  if (!ilocBox) return null;
  const itemLocation = parseIloc(ilocBox.data).find((entry) => entry.itemId === itemId);
  if (!itemLocation || itemLocation.dataReferenceIndex === 0) return null;
  const dataReference = findBox(metaBox.children, 'dref')?.children?.[
    itemLocation.dataReferenceIndex - 1
  ];
  if (!dataReference)
    throw new HeicError('INVALID_CONTAINER', 'heic: iloc data reference index is out of range');
  if (dataReference.type === 'deti') return null;
  if (dataReference.type !== 'url ' && dataReference.type !== 'urn ')
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: external item data requires a url or urn data entry',
    );
  const data = dataReference.data;
  if (data.length < 4 || data[0] !== 0)
    throw new HeicError('INVALID_CONTAINER', 'heic: invalid item data reference box');
  const flags = (data[1] << 16) | (data[2] << 8) | data[3];
  if (dataReference.type === 'url ' && flags & 1) {
    if (flags !== 1 || data.length !== 4)
      throw new HeicError('INVALID_CONTAINER', 'heic: invalid self-contained url data reference');
    return null;
  }
  if (flags !== 0)
    throw new HeicError('INVALID_CONTAINER', 'heic: invalid item data reference flags');
  const readString = (offset: number, required: boolean): { value: string; next: number } => {
    const terminator = data.indexOf(0, offset);
    if (terminator < 0 || (required && terminator === offset))
      throw new HeicError('INVALID_CONTAINER', 'heic: invalid external item data reference string');
    try {
      return {
        value: new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(offset, terminator)),
        next: terminator + 1,
      };
    } catch (cause) {
      throw new HeicError(
        'INVALID_CONTAINER',
        'heic: invalid external item data reference encoding',
        { cause },
      );
    }
  };
  if (dataReference.type === 'url ') {
    const { value: url, next } = readString(4, true);
    if (next !== data.length)
      throw new HeicError('INVALID_CONTAINER', 'heic: invalid external item URL');
    return { type: 'url', url };
  }
  const { value: name, next: nameEnd } = readString(4, true);
  const { value: resourceLocation, next: end } =
    nameEnd === data.length ? { value: '', next: nameEnd } : readString(nameEnd, false);
  if (end !== data.length)
    throw new HeicError('INVALID_CONTAINER', 'heic: invalid external item URN');
  return resourceLocation
    ? { type: 'urn', name, location: resourceLocation }
    : { type: 'urn', name };
}

/** Return an item's URL locator, or null when it uses another data-entry form. */
export function getItemDataReferenceUrl(boxes: ISOBMFFBox[], itemId: number): string | null {
  const reference = getItemDataReference(boxes, itemId);
  return reference?.type === 'url' ? reference.url : null;
}

/** Validate the caller-supplied resources shared by sync, async, and HDR APIs. */
export function validateExternalItemData(
  externalItemData?: Readonly<Record<number, Uint8Array>>,
): void {
  if (externalItemData === undefined) return;
  if (!externalItemData || typeof externalItemData !== 'object')
    throw new HeicError('INVALID_OPTIONS', 'heic: externalItemData must be an item-ID map');
  let totalBytes = 0;
  for (const [itemId, data] of Object.entries(externalItemData)) {
    if (!/^[1-9]\d*$/.test(itemId) || Number(itemId) > 0xffff_ffff)
      throw new HeicError('INVALID_OPTIONS', 'heic: externalItemData has an invalid item ID');
    if (!(data instanceof Uint8Array) || data.byteLength === 0)
      throw new HeicError(
        'INVALID_OPTIONS',
        'heic: externalItemData values must be non-empty bytes',
      );
    totalBytes += data.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > 64 * 1024 * 1024)
      throw new HeicError('RESOURCE_LIMIT', 'heic: external item data exceeds 64 MiB');
  }
}

const MAX_ITEM_OFFSET_DEPTH = 32;

function getItemPayloadRecursive(
  buffer: Uint8Array,
  boxes: ISOBMFFBox[],
  itemId: number,
  resolving: Set<number>,
  depth: number,
  externalItemData?: Readonly<Record<number, Uint8Array>>,
): Uint8Array | null {
  if (depth > MAX_ITEM_OFFSET_DEPTH)
    throw new HeicError('RESOURCE_LIMIT', 'heic: item-offset reference chain is too deep');
  if (resolving.has(itemId))
    throw new HeicError('INVALID_CONTAINER', 'heic: cyclic item-offset reference');

  const ftyp = getFtypInfo(buffer);
  const miniBox = findBox(boxes, 'mini');
  if (ftyp && (ftyp.majorBrand === 'mif3' || ftyp.compatibleBrands.includes('mif3')) && miniBox) {
    const mini = parseMiniImage(miniBox.data, ftyp.minorVersion);
    if (itemId === 1) return mini.itemData;
    if (itemId === 2) return mini.alphaItemData;
    if (itemId === 3 && mini.gainMap && mini.gainMapMetadata) {
      const payload = new Uint8Array(mini.gainMapMetadata.length + 1);
      payload.set(mini.gainMapMetadata, 1);
      return payload;
    }
    if (itemId === 4) return mini.gainMap?.itemData ?? null;
    return null;
  }

  const metaBox = findBox(boxes, 'meta');
  if (!metaBox?.children) return null;
  const ilocBox = findBox(metaBox.children, 'iloc');
  if (!ilocBox) return null;

  const location = parseIloc(ilocBox.data).find((loc) => loc.itemId === itemId);
  if (!location) return null;

  resolving.add(itemId);
  try {
    const itemType = parseIinf(findBox(metaBox.children, 'iinf')?.data ?? new Uint8Array()).find(
      (item) => item.itemId === itemId,
    )?.itemType;
    if (![0, 1, 2].includes(location.constructionMethod))
      throw new HeicError('INVALID_CONTAINER', 'heic: unsupported item construction method');
    const externalReference =
      location.dataReferenceIndex === 0 ? null : getItemDataReference(boxes, itemId);
    const drefEntry =
      location.dataReferenceIndex === 0
        ? undefined
        : findBox(metaBox.children, 'dref')?.children?.[location.dataReferenceIndex - 1];
    const tiledReference = itemType === 'tili' && drefEntry?.type === 'deti';
    if (
      (location.dataReferenceIndex !== 0 &&
        !externalReference &&
        !tiledReference &&
        drefEntry?.type !== 'url ' &&
        drefEntry?.type !== 'urn ') ||
      (location.constructionMethod === 2 && location.dataReferenceIndex !== 0) ||
      (externalReference !== null && location.constructionMethod !== 0)
    )
      throw new HeicError('INVALID_CONTAINER', 'heic: unsupported external item location');
    let sourceBuffer = buffer;
    if (externalReference !== null) {
      const supplied = externalItemData?.[itemId];
      const label =
        externalReference.type === 'url'
          ? externalReference.url
          : externalReference.location
            ? `${externalReference.name} (${externalReference.location})`
            : externalReference.name;
      if (!(supplied instanceof Uint8Array) || supplied.byteLength === 0)
        throw new HeicError(
          'INVALID_INPUT',
          `heic: external item ${itemId} has no data for ${label}`,
        );
      if (supplied.byteLength > 64 * 1024 * 1024)
        throw new HeicError('RESOURCE_LIMIT', 'heic: external item data exceeds 64 MiB');
      sourceBuffer = supplied;
    }
    if (location.constructionMethod === 1) {
      const idatBox = findBox(metaBox.children, 'idat');
      if (!idatBox) return null;
      const parts = location.extents.map((extent) => {
        const start = location.baseOffset + extent.extentOffset;
        if (
          !Number.isSafeInteger(start + extent.extentLength) ||
          start < 0 ||
          start + extent.extentLength > idatBox.data.length
        )
          throw new HeicError('INVALID_CONTAINER', 'heic: item extent exceeds idat bounds');
        return idatBox.data.subarray(start, start + extent.extentLength);
      });
      return concat(parts);
    }

    if (location.constructionMethod === 2) {
      const irefBox = findBox(metaBox.children, 'iref');
      const itemReferences = irefBox
        ? parseIref(irefBox)
            .filter(
              (reference) => reference.referenceType === 'iloc' && reference.fromItemId === itemId,
            )
            .flatMap((reference) => reference.toItemIds)
        : [];
      const parts = location.extents.map((extent) => {
        const referenceIndex = extent.extentIndex ?? 1;
        if (
          !Number.isSafeInteger(referenceIndex) ||
          referenceIndex < 1 ||
          referenceIndex > itemReferences.length
        )
          throw new HeicError('INVALID_CONTAINER', 'heic: invalid iloc extent reference index');
        const sourceItemId = itemReferences[referenceIndex - 1];
        const source = getItemPayloadRecursive(
          buffer,
          boxes,
          sourceItemId,
          resolving,
          depth + 1,
          externalItemData,
        );
        if (!source)
          throw new HeicError('INVALID_CONTAINER', 'heic: iloc extent references a missing item');

        const start = location.baseOffset + extent.extentOffset;
        let length = extent.extentLength;
        if (length === 0 && location.extents.length === 1) length = source.length - start;
        const end = start + length;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start < 0 ||
          length < 0 ||
          end > source.length
        )
          throw new HeicError(
            'INVALID_CONTAINER',
            'heic: item extent exceeds referenced item bounds',
          );
        return source.subarray(start, end);
      });
      return concat(parts);
    }

    // construction_method 0: absolute file offsets.
    const parts = location.extents.map((extent) => {
      const start = location.baseOffset + extent.extentOffset;
      if (
        !Number.isSafeInteger(start + extent.extentLength) ||
        start < 0 ||
        start + extent.extentLength > sourceBuffer.length
      )
        throw new HeicError('INVALID_CONTAINER', 'heic: item extent exceeds file bounds');
      return sourceBuffer.subarray(start, start + extent.extentLength);
    });
    return concat(parts);
  } finally {
    resolving.delete(itemId);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  if (!Number.isSafeInteger(total) || total > 64 * 1024 * 1024)
    throw new HeicError('RESOURCE_LIMIT', 'heic: combined item extents exceed 64 MiB');
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Re-export the iloc parser for consumers that walk items manually. */
export { parseIloc };
