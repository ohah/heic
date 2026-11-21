/**
 * HEVC multilayer VPS parsing for layer maps, representation formats, and VUI.
 * The still-image decoder reads timing and DPB fields as metadata but does not
 * apply their video scheduling model to a single decoded image.
 */
import { HeicError } from '../errors.js';
import { BitReader, toRbsp } from './nal.js';
import { skipHrdParameters, skipProfileTierLevel } from './sps.js';
import type { SpsInfo } from './sps.js';

export interface HevcRepresentationFormat {
  index: number;
  width: number;
  height: number;
  chromaFormatIdc: number;
  separateColourPlane: boolean;
  bitDepthLuma: number;
  bitDepthChroma: number;
  cropLeft: number;
  cropRight: number;
  cropTop: number;
  cropBottom: number;
}

export interface HevcVpsVideoSignalInfo {
  videoFormat: number;
  fullRange: boolean;
  colourPrimaries: number;
  transferCharacteristics: number;
  matrixCoefficients: number;
}

export interface HevcVpsVuiInfo {
  crossLayerPicTypeAligned: boolean;
  crossLayerIrapAligned: boolean;
  allLayersIdrAligned: boolean | null;
  bitRateAndPictureRate: Array<{
    layerSetIndex: number;
    subLayerIndex: number;
    averageBitRate?: number;
    maximumBitRate?: number;
    constantPictureRateIdc?: number;
    averagePictureRate?: number;
  }>;
  videoSignalInfoIdxPresent: boolean;
  videoSignalInfo: HevcVpsVideoSignalInfo[];
  /** Video-signal-info table index for each VPS layer, including inferred indices. */
  videoSignalInfoIndices: number[];
  tilesNotInUse: boolean;
  tilesInUse: boolean[];
  loopFilterNotAcrossTiles: Array<boolean | null>;
  /** Square layer-index matrix; true entries map a dependent layer to a direct reference. */
  tileBoundariesAligned: boolean[][];
  wppNotInUse: boolean;
  wppInUse: boolean[];
  singleLayerForNonIrap: boolean;
  higherLayerIrapSkip: boolean;
  interLayerRestrictedRefLayers: boolean;
  bitstreamPartitionHrdPresent: boolean;
}

export interface HevcViewInfo {
  /** HEVC ViewOrderIdx used by inter-view prediction and output ordering. */
  viewOrderIndex: number;
  /** Signalled `view_id_val`, or its inferred value when view_id_len is zero. */
  viewId: number;
  /** VPS layer IDs that belong to this view. */
  layerIds: number[];
}

export interface LayeredVpsInfo {
  vpsId: number;
  baseLayerInternal?: boolean;
  baseLayerAvailable?: boolean;
  maxSubLayersMinus1: number;
  temporalIdNested: boolean;
  layerIds: number[];
  /** View identity and layer mapping when the VPS signals the multiview dimension. */
  views?: HevcViewInfo[];
  /** Direct and indirect reference layer ids, indexed by `layerIds` order. */
  referenceLayerIds?: number[][];
  /** Direct reference layer ids, indexed by `layerIds` order. */
  directReferenceLayerIds?: number[][];
  /** Direct dependency type for each layer pair, indexed by `layerIds` order; null means no direct dependency. */
  directDependencyTypes: Array<Array<number | null>>;
  defaultRefLayersActiveFlag?: boolean;
  maxOneActiveRefLayerFlag?: boolean;
  /** VPS `poc_lsb_not_present_flag`, indexed by `layerIds` order. */
  pocLsbNotPresentFlags?: boolean[];
  /** Representation-format index for each layer in `layerIds` order. */
  representationFormatIndices: number[];
  representationFormats: HevcRepresentationFormat[];
  /** Annex F VPS VUI, when the extension contains one. */
  vui?: HevcVpsVuiInfo;
}

export interface DirectDependencyPredictionCapabilities {
  samplePredictionEnabled: boolean;
  motionPredictionEnabled: boolean;
}

/** Derive Annex F's inter-layer sample/motion flags from direct_dependency_type. */
export function getDirectDependencyPredictionCapabilities(
  directDependencyType: number,
): DirectDependencyPredictionCapabilities {
  if (!Number.isInteger(directDependencyType) || directDependencyType < 0)
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid direct_dependency_type');
  const flags = (directDependencyType + 1) % 4;
  return {
    samplePredictionEnabled: (flags & 1) !== 0,
    motionPredictionEnabled: (flags & 2) !== 0,
  };
}

/** Return the VPS VUI video-signal record assigned to one layer. */
export function getVpsVideoSignalInfoForLayer(
  vps: LayeredVpsInfo,
  layerId: number,
): HevcVpsVideoSignalInfo | null {
  const layerIndex = vps.layerIds.indexOf(layerId);
  if (layerIndex < 0 || !vps.vui?.videoSignalInfo.length) return null;
  const signalIndex = vps.vui.videoSignalInfoIndices[layerIndex] ?? 0;
  return vps.vui.videoSignalInfo[signalIndex] ?? null;
}

/** Apply Annex F.15.3.1 VPS color-signal inference to a qualifying SPS layer. */
export function getVpsVideoSignalInfoForSps(
  vps: LayeredVpsInfo,
  sps: Pick<SpsInfo, 'layerId' | 'multiLayerExtSps' | 'vuiPresent'>,
): HevcVpsVideoSignalInfo | null {
  const layerId = sps.layerId;
  if (layerId === undefined || layerId === 0) return null;
  const layerIndex = vps.layerIds.indexOf(layerId);
  if (layerIndex < 0) return null;
  const hasDirectReferenceLayer = (vps.directReferenceLayerIds?.[layerIndex]?.length ?? 0) > 0;
  const hasIndependentMultilayerVui = sps.multiLayerExtSps === true && sps.vuiPresent === true;
  if (!hasDirectReferenceLayer && !hasIndependentMultilayerVui) return null;
  return getVpsVideoSignalInfoForLayer(vps, layerId);
}

interface OutputLayerSet {
  layerSetIndex: number;
  layerIds: number[];
  necessaryLayers: boolean[];
}

interface VpsVuiContext {
  baseLayerInternal: boolean;
  layerIds: number[];
  layerSets: number[][];
  outputLayerSets: OutputLayerSet[];
  directDependencies: boolean[][];
  maxSubLayersMinus1: number;
  subLayersMaxMinus1ByLayer: number[];
  numHrdParameters: number;
  hrdCommonInfo: Array<ReturnType<typeof skipHrdParameters>>;
}

function invalid(message: string): never {
  throw new HeicError('INVALID_BITSTREAM', `heic: ${message}`);
}

function boundedUe(r: BitReader, maximum: number, label: string): number {
  const value = r.ue();
  if (value > maximum) invalid(`${label} exceeds its HEVC range`);
  return value;
}

function ceilLog2(value: number): number {
  return value <= 1 ? 0 : Math.ceil(Math.log2(value));
}

function readAlignedOnes(r: BitReader, label: string): void {
  while (r.bitPosition & 7) {
    if (r.readBit() !== 1) invalid(label);
  }
}

function maxSubLayersInLayerSetMinus1(
  layerSet: number[],
  layerIdToIndex: Map<number, number>,
  subLayersMaxMinus1ByLayer: number[],
): number {
  let maximum = 0;
  for (const layerId of layerSet) {
    const layerIndex = layerIdToIndex.get(layerId);
    if (layerIndex === undefined) invalid('VPS layer set references an unknown layer');
    maximum = Math.max(maximum, subLayersMaxMinus1ByLayer[layerIndex]);
  }
  return maximum;
}

function skipVpsVuiBspHrdParameters(
  r: BitReader,
  context: VpsVuiContext,
  maxSubLayersInLayerSet: number[],
): void {
  const numAddHrdParameters = boundedUe(
    r,
    1024 - context.numHrdParameters,
    'vps_num_add_hrd_params',
  );
  const totalHrdParameters = context.numHrdParameters + numAddHrdParameters;
  if (totalHrdParameters > 1024) invalid('VPS VUI has too many HRD parameter sets');

  let inheritedCommon = context.hrdCommonInfo.at(-1);
  for (let i = context.numHrdParameters; i < totalHrdParameters; i++) {
    const commonInfoPresent = i === 0 || r.readBit() === 1;
    const maxSubLayersMinus1 = boundedUe(r, context.maxSubLayersMinus1, 'num_sub_layer_hrd_minus1');
    inheritedCommon = skipHrdParameters(r, maxSubLayersMinus1, commonInfoPresent, inheritedCommon);
  }

  if (totalHrdParameters === 0) return;
  const numPartitionsMinus1: number[][] = Array.from(
    { length: context.outputLayerSets.length },
    () => [0],
  );
  for (let h = 1; h < context.outputLayerSets.length; h++) {
    const outputLayerSet = context.outputLayerSets[h];
    const layerSet = context.layerSets[outputLayerSet.layerSetIndex];
    if (!layerSet) invalid('VPS VUI references a missing output layer set');
    numPartitionsMinus1[h][0] = layerSet.length - 1;
    const schemeCount = boundedUe(r, 16, 'num_signalled_partitioning_schemes');
    for (let j = 1; j <= schemeCount; j++) {
      const partitionsMinus1 = boundedUe(r, layerSet.length - 1, 'num_partitions_in_scheme_minus1');
      numPartitionsMinus1[h][j] = partitionsMinus1;
      for (let k = 0; k <= partitionsMinus1; k++)
        for (let layerIndex = 0; layerIndex < layerSet.length; layerIndex++) r.readBit();
    }
    for (let schemeIndex = 0; schemeIndex <= schemeCount; schemeIndex++) {
      const partitionsMinus1 = numPartitionsMinus1[h][schemeIndex];
      for (
        let subLayer = 0;
        subLayer <= maxSubLayersInLayerSet[outputLayerSet.layerSetIndex];
        subLayer++
      ) {
        const schedulesMinus1 = boundedUe(r, 31, 'num_bsp_schedules_minus1');
        for (let schedule = 0; schedule <= schedulesMinus1; schedule++) {
          for (let partition = 0; partition <= partitionsMinus1; partition++) {
            if (totalHrdParameters > 1) {
              const hrdIndex = r.readBits(ceilLog2(totalHrdParameters));
              if (hrdIndex >= totalHrdParameters) invalid('bsp_hrd_idx exceeds the VPS HRD table');
            }
            boundedUe(r, 31, 'bsp_sched_idx');
          }
        }
      }
    }
  }
}

function parseVpsVui(r: BitReader, context: VpsVuiContext): HevcVpsVuiInfo {
  const layerIdToIndex = new Map(context.layerIds.map((layerId, index) => [layerId, index]));
  const maxSubLayersInLayerSet = context.layerSets.map((layerSet) =>
    maxSubLayersInLayerSetMinus1(layerSet, layerIdToIndex, context.subLayersMaxMinus1ByLayer),
  );

  const crossLayerPicTypeAligned = r.readBit() === 1;
  const crossLayerIrapAligned = crossLayerPicTypeAligned ? true : r.readBit() === 1;
  const allLayersIdrAligned = crossLayerIrapAligned ? r.readBit() === 1 : null;
  const bitRatePresentVps = r.readBit() === 1;
  const picRatePresentVps = r.readBit() === 1;
  const bitRateAndPictureRate: HevcVpsVuiInfo['bitRateAndPictureRate'] = [];
  if (bitRatePresentVps || picRatePresentVps) {
    for (let i = context.baseLayerInternal ? 0 : 1; i < context.layerSets.length; i++) {
      for (let j = 0; j <= maxSubLayersInLayerSet[i]; j++) {
        const bitRatePresent = bitRatePresentVps && r.readBit() === 1;
        const picRatePresent = picRatePresentVps && r.readBit() === 1;
        const entry: (typeof bitRateAndPictureRate)[number] = {
          layerSetIndex: i,
          subLayerIndex: j,
        };
        if (bitRatePresent) {
          entry.averageBitRate = r.readBits(16);
          entry.maximumBitRate = r.readBits(16);
        }
        if (picRatePresent) {
          entry.constantPictureRateIdc = r.readBits(2);
          if (entry.constantPictureRateIdc > 2)
            invalid('constant_pic_rate_idc exceeds its HEVC range');
          entry.averagePictureRate = r.readBits(16);
        }
        bitRateAndPictureRate.push(entry);
      }
    }
  }

  const videoSignalInfoIdxPresent = r.readBit() === 1;
  const videoSignalInfoCountMinus1 = videoSignalInfoIdxPresent
    ? r.readBits(4)
    : context.layerIds.length - (context.baseLayerInternal ? 1 : 2);
  const videoSignalInfoCount = Math.max(0, videoSignalInfoCountMinus1 + 1);
  const videoSignalInfo: HevcVpsVideoSignalInfo[] = [];
  const videoSignalInfoIndices = Array<number>(context.layerIds.length).fill(0);
  for (let i = 0; i < videoSignalInfoCount; i++) {
    videoSignalInfo.push({
      videoFormat: r.readBits(3),
      fullRange: r.readBit() === 1,
      colourPrimaries: r.readBits(8),
      transferCharacteristics: r.readBits(8),
      matrixCoefficients: r.readBits(8),
    });
  }
  if (videoSignalInfoIdxPresent) {
    if (videoSignalInfoCountMinus1 > 0) {
      for (let i = context.baseLayerInternal ? 0 : 1; i < context.layerIds.length; i++) {
        const index = r.readBits(4);
        if (index > videoSignalInfoCountMinus1)
          invalid('VPS video signal info index exceeds its table');
        videoSignalInfoIndices[i] = index;
      }
    }
  } else {
    // The VPS video-signal table excludes an external base layer. The Annex F
    // inferred-index wording uses the VPS layer index directly, which would
    // address past this table for the last layer; map the signalled layers
    // densely so every inferred index remains inside the inferred table.
    for (let i = context.baseLayerInternal ? 0 : 1; i < context.layerIds.length; i++)
      videoSignalInfoIndices[i] = i - Number(!context.baseLayerInternal);
  }

  const tilesNotInUse = r.readBit() === 1;
  const tilesInUse = Array<boolean>(context.layerIds.length).fill(false);
  const loopFilterNotAcrossTiles = Array<boolean | null>(context.layerIds.length).fill(null);
  const tileBoundariesAligned = context.layerIds.map(() =>
    Array<boolean>(context.layerIds.length).fill(false),
  );
  if (!tilesNotInUse) {
    for (let i = context.baseLayerInternal ? 0 : 1; i < context.layerIds.length; i++) {
      tilesInUse[i] = r.readBit() === 1;
      if (tilesInUse[i]) loopFilterNotAcrossTiles[i] = r.readBit() === 1;
    }
    for (let i = context.baseLayerInternal ? 1 : 2; i < context.layerIds.length; i++) {
      for (let j = 0; j < i; j++) {
        if (context.directDependencies[i][j] && tilesInUse[i] && tilesInUse[j])
          tileBoundariesAligned[i][j] = r.readBit() === 1;
      }
    }
  }

  const wppNotInUse = r.readBit() === 1;
  const wppInUse = Array<boolean>(context.layerIds.length).fill(false);
  if (!wppNotInUse)
    for (let i = context.baseLayerInternal ? 0 : 1; i < context.layerIds.length; i++)
      wppInUse[i] = r.readBit() === 1;

  const singleLayerForNonIrap = r.readBit() === 1;
  const higherLayerIrapSkip = r.readBit() === 1;
  const interLayerRestrictedRefLayers = r.readBit() === 1;
  if (interLayerRestrictedRefLayers) {
    for (let i = 1; i < context.layerIds.length; i++) {
      for (let j = 0; j < i; j++) {
        if (!context.directDependencies[i][j]) continue;
        if (!context.baseLayerInternal && context.layerIds[j] === 0) continue;
        const minSpatialSegmentOffsetPlus1 = boundedUe(
          r,
          1 << 20,
          'min_spatial_segment_offset_plus1',
        );
        if (minSpatialSegmentOffsetPlus1 > 0 && r.readBit())
          boundedUe(r, 1 << 20, 'min_horizontal_ctu_offset_plus1');
      }
    }
  }

  const bitstreamPartitionHrdPresent = r.readBit() === 1;
  if (bitstreamPartitionHrdPresent) skipVpsVuiBspHrdParameters(r, context, maxSubLayersInLayerSet);

  return {
    crossLayerPicTypeAligned,
    crossLayerIrapAligned,
    allLayersIdrAligned,
    bitRateAndPictureRate,
    videoSignalInfoIdxPresent,
    videoSignalInfo,
    videoSignalInfoIndices,
    tilesNotInUse,
    tilesInUse,
    loopFilterNotAcrossTiles,
    tileBoundariesAligned,
    wppNotInUse,
    wppInUse,
    singleLayerForNonIrap,
    higherLayerIrapSkip,
    interLayerRestrictedRefLayers,
    bitstreamPartitionHrdPresent,
  };
}

function hasMoreRbspData(rbsp: Uint8Array, bitPosition: number): boolean {
  const bitLength = rbsp.length * 8;
  if (bitPosition >= bitLength) return false;
  const read = (position: number): number => (rbsp[position >> 3] >> (7 - (position & 7))) & 1;
  if (read(bitPosition) !== 1) return true;
  for (let position = bitPosition + 1; position < bitLength; position++)
    if (read(position) !== 0) return true;
  return false;
}

export function readVpsId(nal: Uint8Array): number {
  if (nal.length < 3 || nal[0] & 0x80 || !(nal[1] & 0x07)) invalid('invalid VPS NAL header');
  if (((nal[0] >> 1) & 0x3f) !== 32) invalid('expected a VPS NAL unit');
  return new BitReader(toRbsp(nal)).readBits(4);
}

/** Parse the Annex F VPS, including representation formats and post-table syntax. */
export function parseLayeredVps(nal: Uint8Array): LayeredVpsInfo {
  readVpsId(nal);

  const rbsp = toRbsp(nal);
  const r = new BitReader(rbsp);
  const vpsId = r.readBits(4);
  const baseLayerInternal = r.readBit() === 1;
  const baseLayerAvailable = r.readBit() === 1;
  const maxLayersMinus1 = r.readBits(6);
  const maxSubLayersMinus1 = r.readBits(3);
  if (maxSubLayersMinus1 > 6) invalid('vps_max_sub_layers_minus1 is reserved');
  const temporalIdNested = r.readBit() === 1;
  if (r.readBits(16) !== 0xffff) invalid('invalid VPS reserved bits');
  skipProfileTierLevel(r, maxSubLayersMinus1);

  const orderingInfoPresent = r.readBit() === 1;
  for (let i = orderingInfoPresent ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
    boundedUe(r, 16, 'vps_max_dec_pic_buffering_minus1');
    boundedUe(r, 16, 'vps_max_num_reorder_pics');
    r.ue(); // vps_max_latency_increase_plus1
  }

  const maxLayerId = r.readBits(6);
  const numLayerSetsMinus1 = boundedUe(r, 1023, 'vps_num_layer_sets_minus1');
  const layerSets: number[][] = [[0]];
  for (let i = 1; i <= numLayerSetsMinus1; i++) {
    const layerIds: number[] = [];
    for (let layerId = 0; layerId <= maxLayerId; layerId++) if (r.readBit()) layerIds.push(layerId);
    if (layerIds.length === 0 || layerIds.length > maxLayersMinus1 + 1)
      invalid('invalid VPS layer set');
    layerSets.push(layerIds);
  }

  let numHrdParameters = 0;
  const hrdCommonInfo: Array<ReturnType<typeof skipHrdParameters>> = [];
  if (r.readBit()) {
    r.readBits(32); // vps_num_units_in_tick
    r.readBits(32); // vps_time_scale
    if (r.readBit()) r.ue(); // vps_num_ticks_poc_diff_one_minus1
    numHrdParameters = boundedUe(r, numLayerSetsMinus1 + 1, 'vps_num_hrd_parameters');
    let inheritedHrdCommon: ReturnType<typeof skipHrdParameters> | undefined;
    for (let i = 0; i < numHrdParameters; i++) {
      const layerSetIdx = boundedUe(r, numLayerSetsMinus1, 'hrd_layer_set_idx');
      if (layerSetIdx > numLayerSetsMinus1) invalid('invalid hrd_layer_set_idx');
      const commonInfoPresent = i === 0 || r.readBit() === 1;
      inheritedHrdCommon = skipHrdParameters(
        r,
        maxSubLayersMinus1,
        commonInfoPresent,
        inheritedHrdCommon,
      );
      hrdCommonInfo.push(inheritedHrdCommon);
    }
  }

  if (!r.readBit())
    return {
      vpsId,
      baseLayerInternal,
      baseLayerAvailable,
      maxSubLayersMinus1,
      temporalIdNested,
      layerIds: [0],
      directDependencyTypes: [[null]],
      representationFormatIndices: [0],
      representationFormats: [],
    };
  readAlignedOnes(r, 'invalid VPS extension alignment bit');

  if (maxLayersMinus1 > 0 && baseLayerInternal) skipProfileTierLevel(r, maxSubLayersMinus1, false);

  const splittingFlag = r.readBit() === 1;
  const scalabilityMask: boolean[] = [];
  let numScalabilityTypes = 0;
  for (let i = 0; i < 16; i++) {
    const enabled = r.readBit() === 1;
    scalabilityMask.push(enabled);
    if (enabled) numScalabilityTypes++;
  }
  if (splittingFlag && numScalabilityTypes === 0) invalid('invalid VPS splitting dimensions');

  const dimensionIdLengths: number[] = [];
  for (let i = 0; i < numScalabilityTypes - Number(splittingFlag); i++)
    dimensionIdLengths.push(r.readBits(3) + 1);
  if (splittingFlag) {
    const usedBits = dimensionIdLengths.reduce((sum, length) => sum + length, 0);
    if (usedBits >= 6) invalid('VPS scalability dimensions exceed the layer-id width');
    dimensionIdLengths.push(6 - usedBits);
  }

  const layerIdPresent = r.readBit() === 1;
  const layerIds = [0];
  const layerIdToIndex = new Map<number, number>([[0, 0]]);
  for (let i = 1; i <= maxLayersMinus1; i++) {
    const layerId = layerIdPresent ? r.readBits(6) : i;
    if (layerId <= layerIds[i - 1] || layerIdToIndex.has(layerId))
      invalid('layer_id_in_nuh values are not strictly increasing');
    layerIds.push(layerId);
    layerIdToIndex.set(layerId, i);
  }
  const dimensionIds = Array.from({ length: maxLayersMinus1 + 1 }, () =>
    Array<number>(numScalabilityTypes).fill(0),
  );
  if (!splittingFlag) {
    for (let i = 1; i <= maxLayersMinus1; i++)
      for (let j = 0; j < numScalabilityTypes; j++)
        dimensionIds[i][j] = r.readBits(dimensionIdLengths[j]);
  } else {
    for (let i = 0; i <= maxLayersMinus1; i++) {
      let bitOffset = 0;
      for (let j = 0; j < numScalabilityTypes; j++) {
        const length = dimensionIdLengths[j];
        dimensionIds[i][j] = (layerIds[i] >> bitOffset) & ((1 << length) - 1);
        bitOffset += length;
      }
    }
  }

  let viewDimensionIndex = -1;
  let dimensionIndex = 0;
  for (let i = 0; i < scalabilityMask.length; i++) {
    if (!scalabilityMask[i]) continue;
    if (i === 1) viewDimensionIndex = dimensionIndex;
    dimensionIndex++;
  }
  const viewOrderIndices = dimensionIds.map((dimensions) =>
    viewDimensionIndex < 0 ? 0 : dimensions[viewDimensionIndex],
  );
  const numViews = new Set(viewOrderIndices).size;
  if (viewOrderIndices.some((viewOrderIdx) => viewOrderIdx >= numViews))
    invalid('VPS ViewOrderIdx values are not contiguous');
  const viewIdLength = r.readBits(4);
  const viewIds = Array.from({ length: numViews }, () =>
    viewIdLength > 0 ? r.readBits(viewIdLength) : 0,
  );
  const views =
    viewDimensionIndex < 0
      ? undefined
      : Array.from({ length: numViews }, (_, viewOrderIndex) => ({
          viewOrderIndex,
          viewId: viewIds[viewOrderIndex],
          layerIds: layerIds.filter(
            (_layerId, layerIndex) => viewOrderIndices[layerIndex] === viewOrderIndex,
          ),
        }));

  const directDependencies = Array.from({ length: maxLayersMinus1 + 1 }, () =>
    Array<boolean>(maxLayersMinus1 + 1).fill(false),
  );
  for (let i = 1; i <= maxLayersMinus1; i++)
    for (let j = 0; j < i; j++) directDependencies[i][j] = r.readBit() === 1;

  const dependencies = directDependencies.map((row) => row.slice());
  for (let i = 0; i <= maxLayersMinus1; i++) {
    for (let j = 0; j < i; j++) {
      for (let k = 0; k < i; k++) {
        if (directDependencies[i][k] && dependencies[k][j]) dependencies[i][j] = true;
      }
    }
  }

  const treePartitions: number[][] = [];
  const predictedLayerAssigned = Array<boolean>(maxLayersMinus1 + 1).fill(false);
  for (let root = 0; root <= maxLayersMinus1; root++) {
    if (directDependencies[root].some(Boolean)) continue;
    const tree = [root];
    for (let layer = 0; layer <= maxLayersMinus1; layer++) {
      if (dependencies[layer][root] && !predictedLayerAssigned[layer]) {
        tree.push(layer);
        predictedLayerAssigned[layer] = true;
      }
    }
    treePartitions.push(tree);
  }
  if (treePartitions.length === 0) invalid('VPS has no independent layer');

  let numAddLayerSets = 0;
  if (treePartitions.length > 1) numAddLayerSets = boundedUe(r, 1023, 'num_add_layer_sets');
  if (!baseLayerAvailable && numAddLayerSets === 0)
    invalid('VPS without a base layer must include an additional layer set');
  if (numLayerSetsMinus1 + 1 + numAddLayerSets > 2047) invalid('VPS has too many layer sets');

  for (let i = 0; i < numAddLayerSets; i++) {
    const additionalLayerSet: number[] = [];
    for (let treeIdx = 1; treeIdx < treePartitions.length; treeIdx++) {
      const tree = treePartitions[treeIdx];
      const highestLayerIdxPlus1 = r.readBits(ceilLog2(tree.length + 1));
      if (highestLayerIdxPlus1 > tree.length) invalid('invalid highest_layer_idx_plus1');
      for (let j = 0; j < highestLayerIdxPlus1; j++) additionalLayerSet.push(layerIds[tree[j]]);
    }
    if (additionalLayerSet.length === 0) invalid('empty additional VPS layer set');
    layerSets.push(additionalLayerSet);
  }

  const subLayersMaxMinus1ByLayer = Array<number>(maxLayersMinus1 + 1).fill(maxSubLayersMinus1);
  const subLayersMaxMinus1Present = r.readBit() === 1;
  if (subLayersMaxMinus1Present) {
    for (let i = 0; i <= maxLayersMinus1; i++) {
      const subLayersMaxMinus1 = r.readBits(3);
      if (subLayersMaxMinus1 > 6) invalid('sub_layers_vps_max_minus1 is reserved');
      subLayersMaxMinus1ByLayer[i] = subLayersMaxMinus1;
    }
  }

  if (r.readBit()) {
    for (let i = 0; i < maxLayersMinus1; i++)
      for (let j = i + 1; j <= maxLayersMinus1; j++) if (directDependencies[j][i]) r.readBits(3);
  }
  const defaultRefLayersActiveFlag = r.readBit() === 1;

  const numProfileTierLevelsMinus1 = boundedUe(r, 63, 'vps_num_profile_tier_level_minus1');
  if (maxLayersMinus1 > 0 && numProfileTierLevelsMinus1 < 1)
    invalid('multilayer VPS has no non-base profile_tier_level');
  for (let i = baseLayerInternal ? 2 : 1; i <= numProfileTierLevelsMinus1; i++) {
    const profilePresent = r.readBit() === 1;
    skipProfileTierLevel(r, maxSubLayersMinus1, profilePresent);
  }

  let numAddOlss = 0;
  let defaultOutputLayerIdc = 0;
  const numLayerSets = layerSets.length;
  if (numLayerSets > 1) {
    numAddOlss = boundedUe(r, 1023, 'num_add_olss');
    defaultOutputLayerIdc = Math.min(r.readBits(2), 2);
  }
  const numOutputLayerSets = numLayerSets + numAddOlss;
  if (numOutputLayerSets > 2048) invalid('VPS has too many output layer sets');

  const outputLayerSets: OutputLayerSet[] = [
    { layerSetIndex: 0, layerIds: layerSets[0], necessaryLayers: [true] },
  ];
  for (let i = 1; i < numOutputLayerSets; i++) {
    let layerSetIdx = i;
    if (i >= numLayerSets && numLayerSets > 2)
      layerSetIdx = r.readBits(ceilLog2(numLayerSets - 1)) + 1;
    if (!layerSets[layerSetIdx]) invalid('invalid layer_set_idx_for_ols_minus1');

    const layerSet = layerSets[layerSetIdx];
    const outputLayers: boolean[] = [];
    if (i > numLayerSetsMinus1 || defaultOutputLayerIdc === 2) {
      for (let j = 0; j < layerSet.length; j++) outputLayers.push(r.readBit() === 1);
    } else if (defaultOutputLayerIdc === 0) {
      for (let j = 0; j < layerSet.length; j++) outputLayers.push(true);
    } else {
      const highestLayerId = layerSet[layerSet.length - 1];
      for (const layerId of layerSet) outputLayers.push(layerId === highestLayerId);
    }
    const outputCount = outputLayers.filter(Boolean).length;
    if (outputCount === 0) invalid('VPS output layer set has no output layer');

    const necessaryLayers = Array<boolean>(layerSet.length).fill(false);
    let highestOutputLayerId = -1;
    for (let j = 0; j < layerSet.length; j++) {
      if (!outputLayers[j]) continue;
      const layerId = layerSet[j];
      const layerIdx = layerIdToIndex.get(layerId);
      if (layerIdx === undefined) invalid('VPS layer set references an unknown layer');
      necessaryLayers[j] = true;
      highestOutputLayerId = layerId;
      for (let refPos = 0; refPos < j; refPos++) {
        const refIdx = layerIdToIndex.get(layerSet[refPos]);
        if (refIdx !== undefined && dependencies[layerIdx][refIdx]) necessaryLayers[refPos] = true;
      }
    }

    if (numProfileTierLevelsMinus1 > 0) {
      const profileIndexBits = ceilLog2(numProfileTierLevelsMinus1 + 1);
      for (let j = 0; j < necessaryLayers.length; j++)
        if (necessaryLayers[j]) r.readBits(profileIndexBits);
    }
    const highestIdx = layerIdToIndex.get(highestOutputLayerId);
    if (
      outputCount === 1 &&
      highestIdx !== undefined &&
      directDependencies[highestIdx].some(Boolean)
    )
      r.readBit(); // alt_output_layer_flag

    outputLayerSets.push({
      layerSetIndex: layerSetIdx,
      layerIds: layerSet.slice(),
      necessaryLayers,
    });
  }

  const numRepFormatsMinus1 = boundedUe(r, 255, 'vps_num_rep_formats_minus1');
  const representationFormats: HevcRepresentationFormat[] = [];
  for (let i = 0; i <= numRepFormatsMinus1; i++) {
    const width = r.readBits(16);
    const height = r.readBits(16);
    if (width === 0 || height === 0) invalid('VPS representation format has empty dimensions');
    const chromaAndDepthPresent = r.readBit() === 1;
    if (i === 0 && !chromaAndDepthPresent)
      invalid('first VPS representation format omits chroma and bit depth');

    let chromaFormatIdc = representationFormats[i - 1]?.chromaFormatIdc ?? 0;
    let separateColourPlane = representationFormats[i - 1]?.separateColourPlane ?? false;
    let bitDepthLuma = representationFormats[i - 1]?.bitDepthLuma ?? 8;
    let bitDepthChroma = representationFormats[i - 1]?.bitDepthChroma ?? 8;
    if (chromaAndDepthPresent) {
      chromaFormatIdc = r.readBits(2);
      separateColourPlane = chromaFormatIdc === 3 && r.readBit() === 1;
      const bitDepthLumaMinus8 = r.readBits(4);
      const bitDepthChromaMinus8 = r.readBits(4);
      if (bitDepthLumaMinus8 > 8 || bitDepthChromaMinus8 > 8)
        invalid('VPS representation bit depth exceeds H.265 limits');
      bitDepthLuma = bitDepthLumaMinus8 + 8;
      bitDepthChroma = bitDepthChromaMinus8 + 8;
    }

    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (r.readBit()) {
      cropLeft = boundedUe(r, width, 'conf_win_vps_left_offset');
      cropRight = boundedUe(r, width, 'conf_win_vps_right_offset');
      cropTop = boundedUe(r, height, 'conf_win_vps_top_offset');
      cropBottom = boundedUe(r, height, 'conf_win_vps_bottom_offset');
    }
    representationFormats.push({
      index: i,
      width,
      height,
      chromaFormatIdc,
      separateColourPlane,
      bitDepthLuma,
      bitDepthChroma,
      cropLeft,
      cropRight,
      cropTop,
      cropBottom,
    });
  }

  const repFormatIndices = layerIds.map((_, i) => Math.min(i, numRepFormatsMinus1));
  if (numRepFormatsMinus1 > 0 && r.readBit()) {
    const indexBits = ceilLog2(numRepFormatsMinus1 + 1);
    for (let i = baseLayerInternal ? 1 : 0; i <= maxLayersMinus1; i++) {
      const index = r.readBits(indexBits);
      if (index > numRepFormatsMinus1) invalid('vps_rep_format_idx exceeds the VPS table');
      repFormatIndices[i] = index;
    }
  }

  const maxOneActiveRefLayerFlag = r.readBit() === 1;
  r.readBit(); // vps_poc_lsb_aligned_flag
  const pocLsbNotPresentFlags = Array<boolean>(maxLayersMinus1 + 1).fill(false);
  for (let i = 1; i <= maxLayersMinus1; i++)
    if (!directDependencies[i].some(Boolean)) pocLsbNotPresentFlags[i] = r.readBit() === 1;

  for (let i = 1; i < numOutputLayerSets; i++) {
    const outputLayerSet = outputLayerSets[i];
    const layerSet = layerSets[outputLayerSet.layerSetIndex];
    if (!layerSet) invalid('VPS DPB syntax references a missing layer set');
    const subLayerFlagInfoPresent = r.readBit() === 1;
    const maxSubLayersInSet = maxSubLayersInLayerSetMinus1(
      layerSet,
      layerIdToIndex,
      subLayersMaxMinus1ByLayer,
    );
    for (let j = 0; j <= maxSubLayersInSet; j++) {
      const subLayerDpbInfoPresent = j === 0 || (subLayerFlagInfoPresent && r.readBit() === 1);
      if (!subLayerDpbInfoPresent) continue;
      for (let k = 0; k < layerSet.length; k++) {
        if (!outputLayerSet.necessaryLayers[k]) continue;
        if (baseLayerInternal || layerSet[k] !== 0)
          boundedUe(r, 16, 'max_vps_dec_pic_buffering_minus1');
      }
      boundedUe(r, 16, 'max_vps_num_reorder_pics');
      r.ue(); // max_vps_latency_increase_plus1
    }
  }

  const directDependencyTypeLengthMinus2 = boundedUe(r, 30, 'direct_dep_type_len_minus2');
  const directDependencyTypeWidth = directDependencyTypeLengthMinus2 + 2;
  const directDependencyTypes: Array<Array<number | null>> = directDependencies.map((row) =>
    row.map((isReference) => (isReference ? 0 : null)),
  );
  if (r.readBit()) {
    const type = r.readBits(directDependencyTypeWidth); // direct_dependency_all_layers_type
    const firstLayer = baseLayerInternal ? 1 : 2;
    const firstReferenceLayer = baseLayerInternal ? 0 : 1;
    for (let i = firstLayer; i <= maxLayersMinus1; i++)
      for (let j = firstReferenceLayer; j < i; j++)
        if (directDependencies[i]?.[j]) directDependencyTypes[i]![j] = type;
  } else {
    for (let i = baseLayerInternal ? 1 : 2; i <= maxLayersMinus1; i++) {
      for (let j = baseLayerInternal ? 0 : 1; j < i; j++) {
        if (directDependencies[i]?.[j])
          directDependencyTypes[i]![j] = r.readBits(directDependencyTypeWidth);
      }
    }
  }
  if (!baseLayerInternal)
    for (let i = 1; i <= maxLayersMinus1; i++)
      if (directDependencies[i]?.[0]) directDependencyTypes[i]![0] = 0;

  const nonVuiExtensionLength = boundedUe(r, 4096, 'vps_non_vui_extension_length');
  for (let i = 0; i < nonVuiExtensionLength; i++) r.readBits(8);

  let vui: HevcVpsVuiInfo | undefined;
  if (r.readBit()) {
    readAlignedOnes(r, 'invalid VPS VUI alignment bit');
    vui = parseVpsVui(r, {
      baseLayerInternal,
      layerIds,
      layerSets,
      outputLayerSets,
      directDependencies,
      maxSubLayersMinus1,
      subLayersMaxMinus1ByLayer,
      numHrdParameters,
      hrdCommonInfo,
    });
    for (let i = 1; i <= maxLayersMinus1; i++)
      if (!directDependencies[i].some(Boolean)) r.readBit(); // base_layer_parameter_set_compatibility_flag
  }

  if (r.readBit()) while (hasMoreRbspData(rbsp, r.bitPosition)) r.readBit(); // extension2 data
  if (r.readBit() !== 1) invalid('invalid VPS rbsp_stop_one_bit');
  while (r.bitPosition & 7) if (r.readBit() !== 0) invalid('invalid VPS rbsp_alignment_zero_bit');
  if (r.bitPosition !== rbsp.length * 8) invalid('unexpected data after VPS rbsp_trailing_bits');

  return {
    vpsId,
    baseLayerInternal,
    baseLayerAvailable,
    maxSubLayersMinus1,
    temporalIdNested,
    layerIds,
    ...(views ? { views } : {}),
    referenceLayerIds: dependencies.map((row) =>
      row.flatMap((isReference, refIndex) => (isReference ? [layerIds[refIndex]] : [])),
    ),
    directReferenceLayerIds: directDependencies.map((row) =>
      row.flatMap((isReference, refIndex) => (isReference ? [layerIds[refIndex]] : [])),
    ),
    directDependencyTypes,
    defaultRefLayersActiveFlag,
    maxOneActiveRefLayerFlag,
    pocLsbNotPresentFlags,
    representationFormatIndices: repFormatIndices,
    representationFormats,
    ...(vui ? { vui } : {}),
  };
}

export function selectLayerRepresentationFormat(
  vps: LayeredVpsInfo,
  layerId: number,
  updateRepFormatFlag: boolean,
  spsRepFormatIndex: number | null,
): HevcRepresentationFormat | null {
  const layerIndex = vps.layerIds.indexOf(layerId);
  if (layerIndex < 0) invalid(`VPS does not contain selected layer ${layerId}`);
  const repFormatIndex = updateRepFormatFlag
    ? spsRepFormatIndex
    : vps.representationFormatIndices[layerIndex];
  if (repFormatIndex === null || repFormatIndex === undefined) return null;
  const representationFormat = vps.representationFormats[repFormatIndex];
  if (!representationFormat) invalid('selected VPS representation format is missing');
  return representationFormat;
}
