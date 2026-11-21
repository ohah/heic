import { HeicError } from '../errors.js';
/**
 * HEVC picture parameter set parsing — every field an intra still-image
 * decoder needs, including tile layout, WPP, cu_qp_delta, and deblocking
 * controls. Verified field-by-field against iPhone captures (which enable
 * entropy_coding_sync and cu_qp_delta, and disable tiles/sign-hiding).
 */
import type { ScalingListData } from './scaling.js';
import type { LayeredVpsInfo } from './vps.js';
import type { SpsInfo } from './sps.js';
import { BitReader, toRbsp } from './nal.js';
import { defaultScalingListData, parseScalingListData } from './scaling.js';

export interface PpsScreenContentExtensionInfo {
  currPicRefEnabled: boolean;
  residualAdaptiveColourTransformEnabled: boolean;
  sliceActQpOffsetsPresent: boolean;
  actYQpOffsetPlus5: number;
  actCbQpOffsetPlus5: number;
  actCrQpOffsetPlus3: number;
  palettePredictorInitializersPresent: boolean;
  palettePredictorInitializers: {
    monochrome: boolean;
    bitDepthLuma: number;
    bitDepthChroma: number;
    /** Component-major rows, each containing the component values by entry. */
    components: number[][];
  } | null;
}

export interface PpsColourMappingComponentInfo {
  resCoeffQ: number;
  resCoeffR: number;
  /** Absent when both residual coefficient values are zero. */
  resCoeffSignFlag: boolean | null;
}

export interface PpsColourMappingCellInfo {
  /** Null when coded_res_flag is zero; otherwise one entry per Y, Cb, and Cr. */
  components:
    | [PpsColourMappingComponentInfo, PpsColourMappingComponentInfo, PpsColourMappingComponentInfo]
    | null;
}

export interface PpsColourMappingOctantInfo {
  /** Split nodes contain eight children; leaves contain Y-partition entries. */
  children: PpsColourMappingOctantInfo[];
  /** At a leaf: [Y partition][one of four coefficient vertices (j)]. */
  yParts: PpsColourMappingCellInfo[][];
}

export interface PpsColourMappingTableInfo {
  numCmRefLayersMinus1: number;
  cmRefLayerIds: number[];
  cmOctantDepth: number;
  cmYPartNumLog2: number;
  lumaBitDepthCmInput: number;
  chromaBitDepthCmInput: number;
  lumaBitDepthCmOutput: number;
  chromaBitDepthCmOutput: number;
  cmResQuantBits: number;
  cmDeltaFlcBitsMinus1: number;
  cmAdaptThresholdUDelta: number | null;
  cmAdaptThresholdVDelta: number | null;
  octants: PpsColourMappingOctantInfo;
}

export interface PpsReferenceLocationOffsetInfo {
  refLocLayerId: number;
  /** `scaled_ref_layer_*_offset` in left, top, right, bottom syntax order. */
  scaledRefLayerOffsets: [number, number, number, number] | null;
  /** `ref_region_*_offset` in left, top, right, bottom syntax order. */
  refRegionOffsets: [number, number, number, number] | null;
  /** phase_hor_luma, phase_ver_luma, phase_hor_chroma_plus8, phase_ver_chroma_plus8. */
  resamplePhases: [number, number, number, number] | null;
}

export interface PpsInfo {
  layerId: number;
  ppsId: number;
  spsId: number;
  dependentSliceSegmentsEnabled: boolean;
  outputFlagPresent: boolean;
  numExtraSliceHeaderBits: number;
  signDataHidingEnabled: boolean;
  cabacInitPresent: boolean;
  numRefIdxL0DefaultActiveMinus1: number;
  numRefIdxL1DefaultActiveMinus1: number;
  initQp: number;
  constrainedIntraPred: boolean;
  transformSkipEnabled: boolean;
  cuQpDeltaEnabled: boolean;
  diffCuQpDeltaDepth: number;
  cbQpOffset: number;
  crQpOffset: number;
  sliceChromaQpOffsetsPresent: boolean;
  weightedPred: boolean;
  weightedBipred: boolean;
  log2MaxTransformSkipBlockSize: number;
  chromaQpOffsetListEnabled: boolean;
  crossComponentPredictionEnabled: boolean;
  diffCuChromaQpOffsetDepth: number;
  cbQpOffsetList: number[];
  crQpOffsetList: number[];
  log2SaoOffsetScaleLuma: number;
  log2SaoOffsetScaleChroma: number;
  transquantBypassEnabled: boolean;
  tilesEnabled: boolean;
  entropyCodingSyncEnabled: boolean;
  numTileColumns: number;
  numTileRows: number;
  uniformSpacing: boolean;
  tileColumnWidths: number[];
  tileRowHeights: number[];
  loopFilterAcrossTilesEnabled: boolean;
  loopFilterAcrossSlicesEnabled: boolean;
  deblockingFilterControlPresent: boolean;
  deblockingFilterOverrideEnabled: boolean;
  deblockingFilterDisabled: boolean;
  betaOffsetDiv2: number;
  tcOffsetDiv2: number;
  scalingListDataPresent: boolean;
  scalingListData: ScalingListData | null;
  /** Annex F PPS multilayer extension syntax and scaling-list inference. */
  multilayerExtension: boolean;
  pocResetInfoPresent: boolean;
  scalingListInferred: boolean;
  scalingListRefLayerId: number | null;
  /** PPS reference-region and resampling-phase syntax for Annex F inter-layer prediction. */
  referenceLocationOffsets: PpsReferenceLocationOffsetInfo[];
  /** Parsed Annex F colour-map syntax; pixel mapping is used by enhancement-layer decoding. */
  colourMappingTable: PpsColourMappingTableInfo | null;
  listsModificationPresent: boolean;
  log2ParallelMergeLevel: number;
  sliceSegmentHeaderExtensionPresent: boolean;
  /** Parsed SCC syntax; decoding tools are implemented independently. */
  screenContentExtension: PpsScreenContentExtensionInfo | null;
}

// Annex F constrains cm_octant_depth to at most 1 and the sum of it and
// cm_y_part_num_log2 to at most 3: at most 8 leaves × 4 Y parts × 4 cells.
const MAX_COLOUR_MAPPING_CELLS = 8 * 4 * 4;

function parseColourMappingOctants(
  r: BitReader,
  inpDepth: number,
  cmOctantDepth: number,
  cmYPartNumLog2: number,
  cmResBits: number,
  cellBudget: { count: number },
): PpsColourMappingOctantInfo {
  const split = inpDepth < cmOctantDepth && r.readBit() === 1;
  if (split) {
    const children: PpsColourMappingOctantInfo[] = [];
    // Annex F orders the eight children by luma, Cb, and then Cr partition.
    for (let k = 0; k < 2; k++)
      for (let m = 0; m < 2; m++)
        for (let n = 0; n < 2; n++)
          children.push(
            parseColourMappingOctants(
              r,
              inpDepth + 1,
              cmOctantDepth,
              cmYPartNumLog2,
              cmResBits,
              cellBudget,
            ),
          );
    return { children, yParts: [] };
  }

  const yParts: PpsColourMappingCellInfo[][] = [];
  for (let yPart = 0; yPart < 1 << cmYPartNumLog2; yPart++) {
    const cells: PpsColourMappingCellInfo[] = [];
    for (let vertex = 0; vertex < 4; vertex++) {
      if (++cellBudget.count > MAX_COLOUR_MAPPING_CELLS)
        throw new HeicError('RESOURCE_LIMIT', 'heic: PPS colour mapping table exceeds limit');
      if (r.readBit() === 0) {
        cells.push({ components: null });
        continue;
      }

      const components: PpsColourMappingCellInfo['components'] = [
        { resCoeffQ: 0, resCoeffR: 0, resCoeffSignFlag: null },
        { resCoeffQ: 0, resCoeffR: 0, resCoeffSignFlag: null },
        { resCoeffQ: 0, resCoeffR: 0, resCoeffSignFlag: null },
      ];
      for (const component of components) {
        component.resCoeffQ = r.ue();
        component.resCoeffR = cmResBits > 0 ? r.readBits(cmResBits) : 0;
        if (component.resCoeffQ !== 0 || component.resCoeffR !== 0)
          component.resCoeffSignFlag = r.readBit() === 1;
      }
      cells.push({ components });
    }
    yParts.push(cells);
  }
  return { children: [], yParts };
}

function parseColourMappingTable(
  r: BitReader,
  layerId: number,
  vps?: LayeredVpsInfo,
): PpsColourMappingTableInfo {
  const numCmRefLayersMinus1 = r.ue();
  if (numCmRefLayersMinus1 > 61)
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: PPS colour mapping reference-layer count is out of range',
    );
  const cmRefLayerIds: number[] = [];
  const seenLayerIds = new Set<number>();
  for (let i = 0; i <= numCmRefLayersMinus1; i++) {
    const cmRefLayerId = r.readBits(6);
    if (cmRefLayerId > 62 || seenLayerIds.has(cmRefLayerId))
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: invalid or duplicate PPS colour mapping reference layer',
      );
    if (vps && !vps.layerIds.includes(cmRefLayerId))
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: PPS colour mapping reference layer is absent from the active VPS',
      );
    const layerIndex = vps?.layerIds.indexOf(layerId) ?? -1;
    const referenceLayerIds = layerIndex >= 0 ? vps?.referenceLayerIds?.[layerIndex] : undefined;
    if (referenceLayerIds && !referenceLayerIds.includes(cmRefLayerId))
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: PPS colour mapping reference layer is not a direct reference layer',
      );
    seenLayerIds.add(cmRefLayerId);
    cmRefLayerIds.push(cmRefLayerId);
  }

  const cmOctantDepth = r.readBits(2);
  const cmYPartNumLog2 = r.readBits(2);
  if (cmOctantDepth > 1 || cmOctantDepth + cmYPartNumLog2 > 3)
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid PPS colour mapping octant dimensions');
  const lumaBitDepthCmInput = r.ue() + 8;
  const chromaBitDepthCmInput = r.ue() + 8;
  const lumaBitDepthCmOutput = r.ue() + 8;
  const chromaBitDepthCmOutput = r.ue() + 8;
  if (
    lumaBitDepthCmInput > 16 ||
    chromaBitDepthCmInput > 16 ||
    lumaBitDepthCmOutput > 16 ||
    chromaBitDepthCmOutput > 16 ||
    lumaBitDepthCmOutput < lumaBitDepthCmInput ||
    chromaBitDepthCmOutput < chromaBitDepthCmInput
  )
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid PPS colour mapping bit depth');

  const cmResQuantBits = r.readBits(2);
  const cmDeltaFlcBitsMinus1 = r.readBits(2);
  let cmAdaptThresholdUDelta: number | null = null;
  let cmAdaptThresholdVDelta: number | null = null;
  if (cmOctantDepth === 1) {
    cmAdaptThresholdUDelta = r.se();
    cmAdaptThresholdVDelta = r.se();
    const thresholdRange = 2 ** (chromaBitDepthCmInput - 1);
    if (
      cmAdaptThresholdUDelta < -thresholdRange ||
      cmAdaptThresholdUDelta >= thresholdRange ||
      cmAdaptThresholdVDelta < -thresholdRange ||
      cmAdaptThresholdVDelta >= thresholdRange
    )
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: PPS colour mapping adaptation threshold is out of range',
      );
  }
  const cmResBits = Math.max(
    0,
    10 + lumaBitDepthCmInput - lumaBitDepthCmOutput - cmResQuantBits - (cmDeltaFlcBitsMinus1 + 1),
  );
  const octants = parseColourMappingOctants(r, 0, cmOctantDepth, cmYPartNumLog2, cmResBits, {
    count: 0,
  });

  return {
    numCmRefLayersMinus1,
    cmRefLayerIds,
    cmOctantDepth,
    cmYPartNumLog2,
    lumaBitDepthCmInput,
    chromaBitDepthCmInput,
    lumaBitDepthCmOutput,
    chromaBitDepthCmOutput,
    cmResQuantBits,
    cmDeltaFlcBitsMinus1,
    cmAdaptThresholdUDelta,
    cmAdaptThresholdVDelta,
    octants,
  };
}

function parseMultilayerExtension(
  r: BitReader,
  ppsId: number,
  layerId: number,
  scalingListDataPresent: boolean,
  vps?: LayeredVpsInfo,
): Pick<
  PpsInfo,
  | 'pocResetInfoPresent'
  | 'scalingListInferred'
  | 'scalingListRefLayerId'
  | 'referenceLocationOffsets'
  | 'colourMappingTable'
> {
  if (vps && !vps.layerIds.includes(layerId))
    throw new HeicError('INVALID_BITSTREAM', 'heic: PPS layer is absent from the active VPS');
  const pocResetInfoPresent = r.readBit() === 1;
  const scalingListInferred = r.readBit() === 1;
  let scalingListRefLayerId: number | null = null;
  if (scalingListInferred) {
    scalingListRefLayerId = r.readBits(6);
    if (scalingListRefLayerId > 62)
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: PPS scaling-list reference layer is reserved',
      );
    if (layerId === 0 || scalingListDataPresent)
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: PPS scaling-list inference is forbidden for this PPS',
      );
    const layerIndex = vps?.layerIds.indexOf(layerId) ?? -1;
    const referenceLayerIds = layerIndex >= 0 ? vps?.referenceLayerIds?.[layerIndex] : undefined;
    if (referenceLayerIds && !referenceLayerIds.includes(scalingListRefLayerId))
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: PPS scaling-list reference is not a reference layer of this PPS layer',
      );
  }

  const numRefLocOffsets = r.ue();
  const maxRefLocOffsets = Math.min(63, Math.max(0, (vps?.layerIds.length ?? 64) - 1));
  if (numRefLocOffsets > maxRefLocOffsets)
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: PPS reference-location offset count is out of range',
    );
  const refLocLayerIds = new Set<number>();
  const referenceLocationOffsets: PpsReferenceLocationOffsetInfo[] = [];
  for (let i = 0; i < numRefLocOffsets; i++) {
    const refLocLayerId = r.readBits(6);
    if (refLocLayerId > 62 || refLocLayerIds.has(refLocLayerId))
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: invalid or duplicate PPS reference-location layer',
      );
    if (vps && !vps.layerIds.includes(refLocLayerId))
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: PPS reference-location layer is absent from the active VPS',
      );
    const layerIndex = vps?.layerIds.indexOf(layerId) ?? -1;
    const directReferenceLayerIds =
      layerIndex >= 0 ? vps?.directReferenceLayerIds?.[layerIndex] : undefined;
    if (directReferenceLayerIds && !directReferenceLayerIds.includes(refLocLayerId))
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: PPS reference-location layer is not a direct reference layer',
      );
    refLocLayerIds.add(refLocLayerId);
    const readOffsets = (): [number, number, number, number] | null => {
      if (r.readBit() === 0) return null;
      const offsets = [r.se(), r.se(), r.se(), r.se()] as [number, number, number, number];
      if (offsets.some((offset) => offset < -(1 << 14) || offset >= 1 << 14))
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: PPS reference-location offset is out of range',
        );
      return offsets;
    };
    const scaledRefLayerOffsets = readOffsets();
    const refRegionOffsets = readOffsets();
    let resamplePhases: [number, number, number, number] | null = null;
    if (r.readBit()) {
      resamplePhases = [r.ue(), r.ue(), r.ue(), r.ue()];
      if (
        resamplePhases[0] > 31 ||
        resamplePhases[1] > 31 ||
        resamplePhases[2] > 63 ||
        resamplePhases[3] > 63
      )
        throw new HeicError('INVALID_BITSTREAM', 'heic: PPS resampling phase is out of range');
    }
    referenceLocationOffsets.push({
      refLocLayerId,
      scaledRefLayerOffsets,
      refRegionOffsets,
      resamplePhases,
    });
  }
  const colourMappingEnabled = r.readBit() === 1;
  if (colourMappingEnabled && ppsId >= 8)
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: PPS colour mapping is forbidden for PPS ids greater than or equal to 8',
    );
  const colourMappingTable = colourMappingEnabled ? parseColourMappingTable(r, layerId, vps) : null;
  return {
    pocResetInfoPresent,
    scalingListInferred,
    scalingListRefLayerId,
    referenceLocationOffsets,
    colourMappingTable,
  };
}

/** Parse a PPS NAL unit (including its 2-byte NAL header). */
export function parsePps(
  nal: Uint8Array,
  options: {
    /**
     * Accept Annex F multilayer extension syntax after the base-layer PPS.
     * This only permits parsing an `hvc1` layer-0 item; it does not decode
     * `lhv1` enhancement-layer prediction.
     */
    allowBaseLayerMultilayerExtension?: boolean;
    /** Parse Annex F PPS multilayer syntax for an enhancement-layer PPS. */
    allowMultilayerExtension?: boolean;
    /** Active VPS for validating Annex F layer references when available. */
    layeredVps?: LayeredVpsInfo;
  } = {},
): PpsInfo {
  if (nal.length < 3 || nal[0] & 0x80 || !(nal[1] & 0x07) || ((nal[0] >> 1) & 0x3f) !== 34)
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid PPS NAL header');
  const layerId = ((nal[0] & 1) << 5) | (nal[1] >> 3);
  const r = new BitReader(toRbsp(nal));

  const ppsId = r.ue();
  const spsId = r.ue();
  const dependentSliceSegmentsEnabled = r.readBit() === 1;
  const outputFlagPresent = r.readBit() === 1;
  const numExtraSliceHeaderBits = r.readBits(3);
  const signDataHidingEnabled = r.readBit() === 1;
  const cabacInitPresent = r.readBit() === 1;
  const numRefIdxL0DefaultActiveMinus1 = r.ue();
  const numRefIdxL1DefaultActiveMinus1 = r.ue();
  const initQp = 26 + r.se();
  const constrainedIntraPred = r.readBit() === 1;
  const transformSkipEnabled = r.readBit() === 1;
  const cuQpDeltaEnabled = r.readBit() === 1;
  const diffCuQpDeltaDepth = cuQpDeltaEnabled ? r.ue() : 0;
  const cbQpOffset = r.se();
  const crQpOffset = r.se();
  const sliceChromaQpOffsetsPresent = r.readBit() === 1;
  const weightedPred = r.readBit() === 1;
  const weightedBipred = r.readBit() === 1;
  const transquantBypassEnabled = r.readBit() === 1;
  const tilesEnabled = r.readBit() === 1;
  const entropyCodingSyncEnabled = r.readBit() === 1;

  let numTileColumns = 1;
  let numTileRows = 1;
  let uniformSpacing = true;
  const tileColumnWidths: number[] = [];
  const tileRowHeights: number[] = [];
  let loopFilterAcrossTilesEnabled = true;
  if (tilesEnabled) {
    numTileColumns = r.ue() + 1;
    numTileRows = r.ue() + 1;
    uniformSpacing = r.readBit() === 1;
    if (!uniformSpacing) {
      for (let i = 0; i < numTileColumns - 1; i++) tileColumnWidths.push(r.ue() + 1);
      for (let i = 0; i < numTileRows - 1; i++) tileRowHeights.push(r.ue() + 1);
    }
    loopFilterAcrossTilesEnabled = r.readBit() === 1;
  }

  const loopFilterAcrossSlicesEnabled = r.readBit() === 1;
  const deblockingFilterControlPresent = r.readBit() === 1;
  let deblockingFilterOverrideEnabled = false;
  let deblockingFilterDisabled = false;
  let betaOffsetDiv2 = 0;
  let tcOffsetDiv2 = 0;
  if (deblockingFilterControlPresent) {
    deblockingFilterOverrideEnabled = r.readBit() === 1;
    deblockingFilterDisabled = r.readBit() === 1;
    if (!deblockingFilterDisabled) {
      betaOffsetDiv2 = r.se();
      tcOffsetDiv2 = r.se();
    }
  }

  const scalingListDataPresent = r.readBit() === 1;
  const scalingListData = scalingListDataPresent ? parseScalingListData(r) : null;

  const listsModificationPresent = r.readBit() === 1;
  const log2ParallelMergeLevel = r.ue() + 2;
  const sliceSegmentHeaderExtensionPresent = r.readBit() === 1;
  let log2MaxTransformSkipBlockSize = 2;
  let chromaQpOffsetListEnabled = false;
  let crossComponentPredictionEnabled = false;
  let diffCuChromaQpOffsetDepth = 0;
  let cbQpOffsetList: number[] = [];
  let crQpOffsetList: number[] = [];
  let log2SaoOffsetScaleLuma = 0;
  let log2SaoOffsetScaleChroma = 0;
  let screenContentExtension: PpsScreenContentExtensionInfo | null = null;
  let multilayerExtension = false;
  let pocResetInfoPresent = false;
  let scalingListInferred = false;
  let scalingListRefLayerId: number | null = null;
  let referenceLocationOffsets: PpsReferenceLocationOffsetInfo[] = [];
  let colourMappingTable: PpsColourMappingTableInfo | null = null;
  if (r.readBit()) {
    const rangeExtensionPresent = r.readBit() === 1;
    const multilayerExtensionPresent = r.readBit() === 1;
    const extension3dPresent = r.readBit() === 1;
    const screenContentExtensionPresent = r.readBit() === 1;
    // H.265 V11 requires decoders to allow nonzero reserved extension bits;
    // pps_extension_data_flag syntax is ignored by this parser.
    r.readBits(4);
    const baseLayerMultilayerExtension =
      multilayerExtensionPresent &&
      layerId === 0 &&
      options.allowBaseLayerMultilayerExtension === true;
    const enhancementLayerMultilayerExtension =
      multilayerExtensionPresent && layerId !== 0 && options.allowMultilayerExtension === true;
    if (
      (multilayerExtensionPresent &&
        !baseLayerMultilayerExtension &&
        !enhancementLayerMultilayerExtension) ||
      extension3dPresent
    )
      throw new HeicError('UNSUPPORTED_FEATURE', 'heic: unsupported PPS extension');

    if (rangeExtensionPresent) {
      if (transformSkipEnabled) log2MaxTransformSkipBlockSize = r.ue() + 2;
      crossComponentPredictionEnabled = r.readBit() === 1;
      chromaQpOffsetListEnabled = r.readBit() === 1;
      if (chromaQpOffsetListEnabled) {
        diffCuChromaQpOffsetDepth = r.ue();
        const listLenMinus1 = r.ue();
        if (listLenMinus1 > 5)
          throw new HeicError('INVALID_BITSTREAM', 'heic: invalid chroma QP offset list length');
        for (let i = 0; i <= listLenMinus1; i++) {
          const cbOffset = r.se();
          const crOffset = r.se();
          if (cbOffset < -12 || cbOffset > 12 || crOffset < -12 || crOffset > 12)
            throw new HeicError('INVALID_BITSTREAM', 'heic: chroma QP offset is out of range');
          cbQpOffsetList.push(cbOffset);
          crQpOffsetList.push(crOffset);
        }
      }
      log2SaoOffsetScaleLuma = r.ue();
      log2SaoOffsetScaleChroma = r.ue();
    }

    if (multilayerExtensionPresent) {
      multilayerExtension = true;
      ({
        pocResetInfoPresent,
        scalingListInferred,
        scalingListRefLayerId,
        referenceLocationOffsets,
        colourMappingTable,
      } = parseMultilayerExtension(r, ppsId, layerId, scalingListDataPresent, options.layeredVps));
    }

    if (screenContentExtensionPresent) {
      const currPicRefEnabled = r.readBit() === 1;
      const residualAdaptiveColourTransformEnabled = r.readBit() === 1;
      let sliceActQpOffsetsPresent = false;
      let actYQpOffsetPlus5 = 0;
      let actCbQpOffsetPlus5 = 0;
      let actCrQpOffsetPlus3 = 0;
      if (residualAdaptiveColourTransformEnabled) {
        sliceActQpOffsetsPresent = r.readBit() === 1;
        actYQpOffsetPlus5 = r.se();
        actCbQpOffsetPlus5 = r.se();
        actCrQpOffsetPlus3 = r.se();
      }

      const palettePredictorInitializersPresent = r.readBit() === 1;
      let palettePredictorInitializers: PpsScreenContentExtensionInfo['palettePredictorInitializers'] =
        null;
      if (palettePredictorInitializersPresent) {
        const entryCount = r.ue();
        if (entryCount > 4096)
          throw new HeicError(
            'RESOURCE_LIMIT',
            'heic: PPS palette initializer count exceeds limit',
          );
        let monochrome = false;
        let bitDepthLuma = 0;
        let bitDepthChroma = 0;
        const components: number[][] = [];
        if (entryCount > 0) {
          monochrome = r.readBit() === 1;
          bitDepthLuma = r.ue() + 8;
          if (!monochrome) bitDepthChroma = r.ue() + 8;
          if (bitDepthLuma > 16 || (!monochrome && bitDepthChroma > 16))
            throw new HeicError('INVALID_BITSTREAM', 'heic: invalid PPS palette entry bit depth');
          const componentCount = monochrome ? 1 : 3;
          for (let component = 0; component < componentCount; component++) {
            const bitDepth = component === 0 ? bitDepthLuma : bitDepthChroma;
            const values: number[] = [];
            for (let i = 0; i < entryCount; i++) values.push(r.readBits(bitDepth));
            components.push(values);
          }
        }
        palettePredictorInitializers = {
          monochrome,
          bitDepthLuma,
          bitDepthChroma,
          components,
        };
      }

      screenContentExtension = {
        currPicRefEnabled,
        residualAdaptiveColourTransformEnabled,
        sliceActQpOffsetsPresent,
        actYQpOffsetPlus5,
        actCbQpOffsetPlus5,
        actCrQpOffsetPlus3,
        palettePredictorInitializersPresent,
        palettePredictorInitializers,
      };
    }
  }

  return {
    layerId,
    ppsId,
    spsId,
    dependentSliceSegmentsEnabled,
    outputFlagPresent,
    numExtraSliceHeaderBits,
    signDataHidingEnabled,
    cabacInitPresent,
    numRefIdxL0DefaultActiveMinus1,
    numRefIdxL1DefaultActiveMinus1,
    initQp,
    constrainedIntraPred,
    transformSkipEnabled,
    cuQpDeltaEnabled,
    diffCuQpDeltaDepth,
    cbQpOffset,
    crQpOffset,
    sliceChromaQpOffsetsPresent,
    weightedPred,
    weightedBipred,
    log2MaxTransformSkipBlockSize,
    chromaQpOffsetListEnabled,
    crossComponentPredictionEnabled,
    diffCuChromaQpOffsetDepth,
    cbQpOffsetList,
    crQpOffsetList,
    log2SaoOffsetScaleLuma,
    log2SaoOffsetScaleChroma,
    transquantBypassEnabled,
    tilesEnabled,
    entropyCodingSyncEnabled,
    numTileColumns,
    numTileRows,
    uniformSpacing,
    tileColumnWidths,
    tileRowHeights,
    loopFilterAcrossTilesEnabled,
    loopFilterAcrossSlicesEnabled,
    deblockingFilterControlPresent,
    deblockingFilterOverrideEnabled,
    deblockingFilterDisabled,
    betaOffsetDiv2,
    tcOffsetDiv2,
    scalingListDataPresent,
    scalingListData,
    multilayerExtension,
    pocResetInfoPresent,
    scalingListInferred,
    scalingListRefLayerId,
    referenceLocationOffsets,
    colourMappingTable,
    listsModificationPresent,
    log2ParallelMergeLevel,
    sliceSegmentHeaderExtensionPresent,
    screenContentExtension,
  };
}

/**
 * Resolve the scaling-list data active for a picture. Annex F PPS inference
 * copies the active reference-layer PPS data; otherwise the active SPS is the
 * source whenever the PPS does not carry its own scaling_list_data().
 */
export function resolvePpsScalingListData(
  pps: PpsInfo,
  activePpsByLayer: ReadonlyMap<number, PpsInfo>,
  activeSpsByLayer: ReadonlyMap<number, SpsInfo>,
  vps?: LayeredVpsInfo,
): ScalingListData | null {
  const activeSps = activeSpsByLayer.get(pps.layerId);
  if (!activeSps)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      `heic: active SPS for PPS layer ${pps.layerId} is unavailable`,
    );
  if (activeSps.layerId !== pps.layerId || activeSps.spsId !== pps.spsId)
    throw new HeicError('INVALID_BITSTREAM', 'heic: active PPS refers to a different layer SPS');

  if (!activeSps.scalingListEnabled) {
    if (pps.scalingListDataPresent || pps.scalingListInferred)
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: PPS scaling lists are enabled while SPS lists are disabled',
      );
    return null;
  }

  if (pps.scalingListDataPresent) {
    if (!pps.scalingListData)
      throw new HeicError('INVALID_BITSTREAM', 'heic: PPS scaling-list data is missing');
    return pps.scalingListData;
  }

  if (!pps.scalingListInferred) {
    if (activeSps.scalingListInferred && !activeSps.scalingListData)
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        'heic: inherited SPS scaling-list data has not been resolved',
      );
    return activeSps.scalingListData ?? defaultScalingListData();
  }

  const referenceLayerId = pps.scalingListRefLayerId;
  if (referenceLayerId === null)
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: inferred PPS scaling-list reference is missing',
    );
  const layerIndex = vps?.layerIds.indexOf(pps.layerId) ?? -1;
  if (vps && layerIndex < 0)
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: active VPS does not contain the inferred PPS layer',
    );
  const referenceLayerIds = layerIndex >= 0 ? vps?.referenceLayerIds?.[layerIndex] : undefined;
  if (referenceLayerIds && !referenceLayerIds.includes(referenceLayerId))
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: PPS scaling-list reference is not a reference layer of this PPS layer',
    );

  const referencePps = activePpsByLayer.get(referenceLayerId);
  const referenceSps = activeSpsByLayer.get(referenceLayerId);
  if (!referencePps || !referenceSps)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      `heic: active PPS/SPS for scaling-list reference layer ${referenceLayerId} is unavailable`,
    );
  if (referencePps.layerId !== referenceLayerId || referenceSps.layerId !== referenceLayerId)
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: active scaling-list reference parameter set belongs to a different layer',
    );
  if (referencePps.spsId !== referenceSps.spsId)
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: active reference PPS refers to a different layer SPS',
    );
  if (referencePps.scalingListInferred)
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: PPS scaling-list reference must not itself infer scaling lists',
    );
  if (!referenceSps.scalingListEnabled)
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: PPS scaling-list reference SPS must enable scaling lists',
    );
  if (referencePps.scalingListDataPresent) {
    if (!referencePps.scalingListData)
      throw new HeicError('INVALID_BITSTREAM', 'heic: reference PPS scaling-list data is missing');
    return referencePps.scalingListData;
  }
  if (referenceSps.scalingListInferred && !referenceSps.scalingListData)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: inherited reference SPS scaling-list data has not been resolved',
    );
  return referenceSps.scalingListData ?? defaultScalingListData();
}
