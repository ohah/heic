import { HeicError } from '../errors.js';
import { chromaSampleLocationFromCode, type ChromaSampleLocation } from './chroma.js';
/**
 * HEVC sequence parameter set parsing — the full SPS as far as the VUI colour
 * description, cross-checkable against the HEIF container's `ispe` values and
 * feeding the slice decoder (CTB geometry, transform sizes, scaling lists,
 * SAO, strong intra smoothing, colour matrix/range).
 */
import type { ScalingListData } from './scaling.js';
import type { LayeredVpsInfo } from './vps.js';
import { BitReader, toRbsp } from './nal.js';
import { defaultScalingListData, parseScalingListData } from './scaling.js';

export interface VuiColorInfo {
  videoFullRange: boolean;
  colourPrimaries: number;
  transferCharacteristics: number;
  matrixCoeffs: number;
}

/** HEVC VUI default display window offsets, in SubWidthC/SubHeightC units. */
export interface DefaultDisplayWindow {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface SpsScreenContentExtensionInfo {
  currPicRefEnabled: boolean;
  paletteModeEnabled: boolean;
  paletteMaxSize: number;
  deltaPaletteMaxPredictorSize: number;
  palettePredictorInitializersPresent: boolean;
  /** Component-major rows, each containing the component values by entry. */
  palettePredictorInitializers: number[][];
  motionVectorResolutionControlIdc: number;
  intraBoundaryFilteringDisabled: boolean;
}

export interface SpsInfo {
  /** NAL layer whose sequence parameter set was parsed. */
  layerId?: number;
  videoParameterSetId?: number;
  spsId: number;
  /** True when Annex F replaces the SPS picture-format fields with VPS data. */
  multiLayerExtSps?: boolean;
  representationFormatIndex?: number | null;
  /** Whether the SPS contains Annex E VUI parameters. */
  vuiPresent?: boolean;
  chromaFormatIdc: number;
  separateColourPlane: boolean;
  rangeFlags: number;
  /** Parsed SCC syntax; pixel reconstruction using SCC tools is a separate capability. */
  screenContentExtension: SpsScreenContentExtensionInfo | null;
  /** SPS range-extension syntax bit 0 (rangeFlags bit 8). */
  transformSkipRotationEnabled: boolean;
  /** SPS range-extension syntax bit 1 (rangeFlags bit 7). */
  transformSkipContextEnabled: boolean;
  /** SPS range-extension syntax bit 2 (rangeFlags bit 6). */
  implicitRdpcmEnabled: boolean;
  /** SPS range-extension syntax bit 3 (rangeFlags bit 5). */
  explicitRdpcmEnabled: boolean;
  /** SPS range-extension syntax bit 7 (rangeFlags bit 1). */
  persistentRiceAdaptationEnabled: boolean;
  /** SPS range-extension syntax bit 4. Enables extended coefficient range. */
  extendedPrecisionProcessingEnabled: boolean;
  /** SPS range-extension syntax bit 8 (rangeFlags bit 0). */
  cabacBypassAlignmentEnabled: boolean;
  /** SPS range-extension syntax bit 6 (rangeFlags bit 2). */
  highPrecisionOffsetsEnabled: boolean;
  /** Final display width/height after the conformance window crop. */
  width: number;
  height: number;
  /** Coded picture dimensions (multiples of the min CB size). */
  picWidthInLumaSamples: number;
  picHeightInLumaSamples: number;
  cropLeft: number;
  cropRight: number;
  cropTop: number;
  cropBottom: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
  log2MaxPicOrderCntLsb: number;
  log2MinLumaCodingBlockSize: number;
  log2CtbSize: number;
  log2MinTransformBlockSize: number;
  log2MaxTransformBlockSize: number;
  /** Derived maximum hierarchy depth: syntax value plus one (7.3.2.2.1). */
  maxTransformHierarchyDepthInter: number;
  /** Derived maximum hierarchy depth: syntax value plus one (7.3.2.2.1). */
  maxTransformHierarchyDepthIntra: number;
  scalingListEnabled: boolean;
  /** Explicit/default data; null while an inherited matrix remains unresolved. */
  scalingListData: ScalingListData | null;
  /** True when Annex F inherits scaling-list syntax from another layer. */
  scalingListInferred?: boolean;
  /** Layer named by sps_scaling_list_ref_layer_id, when inherited. */
  scalingListRefLayerId?: number | null;
  ampEnabled: boolean;
  sampleAdaptiveOffsetEnabled: boolean;
  pcmEnabled: boolean;
  pcmSampleBitDepthLuma: number;
  pcmSampleBitDepthChroma: number;
  log2MinPcmLumaCodingBlockSize: number;
  log2MaxPcmLumaCodingBlockSize: number;
  pcmLoopFilterDisabled: boolean;
  strongIntraSmoothingEnabled: boolean;
  numShortTermRefPicSets: number;
  numDeltaPocs: number[];
  numUsedByCurrPic: number[];
  shortTermRefPicSets: ShortTermRefPicSet[];
  longTermRefPicsPresent: boolean;
  numLongTermRefPicsSps: number;
  longTermRefPicPocLsbSps: number[];
  longTermUsedByCurrPic: boolean[];
  temporalMvpEnabled: boolean;
  /** From the VUI video_signal_type, if present. */
  color: VuiColorInfo | null;
  /**
   * Optional VUI display hint. The public raster keeps the conformance crop;
   * callers can inspect this window through metadata when no other display
   * indication takes precedence.
   */
  defaultDisplayWindow: DefaultDisplayWindow | null;
  /** Progressive 4:2:0 chroma sample location from the SPS VUI, if known. */
  chromaSampleLocation?: ChromaSampleLocation;
  /** Raw VUI sample-location codes used by H.265 display filters. */
  chromaSampleLocTypeTopField?: number;
  chromaSampleLocTypeBottomField?: number;
  /** VUI field_seq_flag; needed when applying field-aware display filters. */
  fieldSequence: boolean;
  /** VUI frame_field_info_present_flag; gates picture-timing pic_struct. */
  frameFieldInfoPresent: boolean;
}

/** Annex F SPS fields needed to identify its VPS-inferred representation. */
export interface LayeredSpsHeader {
  layerId: number;
  videoParameterSetId: number;
  spsExtOrMaxSubLayersMinus1: 7;
  spsId: number;
  updateRepFormatFlag: boolean;
  spsRepFormatIndex: number | null;
  log2MaxPicOrderCntLsb: number;
}

/** One short-term reference-picture set, in H.265's list order. */
export interface ShortTermRefPicSet {
  /** Negative POC deltas, closest-to-current first. */
  deltaPocS0: number[];
  usedByCurrPicS0: boolean[];
  /** Positive POC deltas, closest-to-current first. */
  deltaPocS1: number[];
  usedByCurrPicS1: boolean[];
}

/**
 * Parse the Annex F prefix used when MultiLayerExtSpsFlag is true.
 * Representation format fields are inferred from the active VPS, so this
 * intentionally returns only the signalled SPS/VPS identifiers and POC size.
 * Returns null for base-layer SPSs and non-multilayer-extension SPS syntax.
 */
export function parseLayeredSpsHeader(nal: Uint8Array): LayeredSpsHeader | null {
  if (nal.length < 3 || nal[0] & 0x80 || !(nal[1] & 0x07))
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid SPS NAL header');
  const nalUnitType = (nal[0] >> 1) & 0x3f;
  const layerId = ((nal[0] & 1) << 5) | (nal[1] >> 3);
  if (nalUnitType !== 33)
    throw new HeicError('INVALID_BITSTREAM', 'heic: expected an SPS NAL unit');
  if (layerId === 0) return null;

  const r = new BitReader(toRbsp(nal));
  const videoParameterSetId = r.readBits(4);
  const spsExtOrMaxSubLayersMinus1 = r.readBits(3);
  if (spsExtOrMaxSubLayersMinus1 !== 7) return null;

  const spsId = r.ue();
  if (spsId > 15) throw new HeicError('INVALID_BITSTREAM', 'heic: SPS id exceeds the HEVC range');
  const updateRepFormatFlag = r.readBit() === 1;
  const spsRepFormatIndex = updateRepFormatFlag ? r.readBits(8) : null;
  const log2MaxPicOrderCntLsb = r.ue() + 4;
  if (log2MaxPicOrderCntLsb > 16)
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid SPS POC bit width');

  return {
    layerId,
    videoParameterSetId,
    spsExtOrMaxSubLayersMinus1: 7,
    spsId,
    updateRepFormatFlag,
    spsRepFormatIndex,
    log2MaxPicOrderCntLsb,
  };
}

/** Skip profile_tier_level syntax while preserving alignment with following fields. */
export function skipProfileTierLevel(
  r: BitReader,
  maxSubLayersMinus1: number,
  profilePresentFlag = true,
): void {
  if (profilePresentFlag) {
    r.readBits(2); // general_profile_space
    r.readBit(); // general_tier_flag
    r.readBits(5); // general_profile_idc
    r.readBits(32); // general_profile_compatibility_flags
    r.readBits(32); // general constraint flags (part 1)
    r.readBits(16); // general constraint flags (part 2)
  }
  r.readBits(8); // general_level_idc

  const subLayerProfilePresent: boolean[] = [];
  const subLayerLevelPresent: boolean[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    subLayerProfilePresent.push(r.readBit() === 1);
    subLayerLevelPresent.push(r.readBit() === 1);
  }
  if (maxSubLayersMinus1 > 0) {
    for (let i = maxSubLayersMinus1; i < 8; i++) r.readBits(2); // reserved_zero_2bits
  }
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (subLayerProfilePresent[i]) {
      r.readBits(32);
      r.readBits(32);
      r.readBits(24);
    }
    if (subLayerLevelPresent[i]) r.readBits(8);
  }
}

/** Skip HRD timing syntax (H.265 Annex E.2.2). Still-image decoding does not
 * operate the CPB/DPB timing model, but the complete SPS syntax must be read. */
function skipSubLayerHrdParameters(
  r: BitReader,
  cpbCntMinus1: number,
  subPicHrdParamsPresent: boolean,
): void {
  for (let i = 0; i <= cpbCntMinus1; i++) {
    r.ue(); // bit_rate_value_minus1
    r.ue(); // cpb_size_value_minus1
    if (subPicHrdParamsPresent) {
      r.ue(); // cpb_size_du_value_minus1
      r.ue(); // bit_rate_du_value_minus1
    }
    r.readBit(); // cbr_flag
  }
}

interface HrdCommonInfo {
  nalHrdPresent: boolean;
  vclHrdPresent: boolean;
  subPicHrdParamsPresent: boolean;
}

export function skipHrdParameters(
  r: BitReader,
  maxSubLayersMinus1: number,
  commonInfoPresentFlag = true,
  inheritedCommonInfo?: HrdCommonInfo,
): HrdCommonInfo {
  let commonInfo = inheritedCommonInfo;
  if (commonInfoPresentFlag) {
    const nalHrdPresent = r.readBit() === 1;
    const vclHrdPresent = r.readBit() === 1;
    let subPicHrdParamsPresent = false;
    if (nalHrdPresent || vclHrdPresent) {
      subPicHrdParamsPresent = r.readBit() === 1;
      if (subPicHrdParamsPresent) {
        r.readBits(8); // tick_divisor_minus2
        r.readBits(5); // du_cpb_removal_delay_increment_length_minus1
        r.readBit(); // sub_pic_cpb_params_in_pic_timing_sei_flag
        r.readBits(5); // dpb_output_delay_du_length_minus1
      }
      r.readBits(4); // bit_rate_scale
      r.readBits(4); // cpb_size_scale
      if (subPicHrdParamsPresent) r.readBits(4); // cpb_size_du_scale
      r.readBits(5); // initial_cpb_removal_delay_length_minus1
      r.readBits(5); // au_cpb_removal_delay_length_minus1
      r.readBits(5); // dpb_output_delay_length_minus1
    }
    commonInfo = { nalHrdPresent, vclHrdPresent, subPicHrdParamsPresent };
  }
  if (!commonInfo)
    throw new HeicError('INVALID_BITSTREAM', 'heic: HRD common information is missing');

  for (let i = 0; i <= maxSubLayersMinus1; i++) {
    const fixedPicRateGeneral = r.readBit() === 1;
    const fixedPicRateWithinCvs = fixedPicRateGeneral || r.readBit() === 1;
    let lowDelayHrd = false;
    if (fixedPicRateWithinCvs) r.ue(); // elemental_duration_in_tc_minus1
    else lowDelayHrd = r.readBit() === 1;

    let cpbCntMinus1 = 0;
    if (!lowDelayHrd) {
      cpbCntMinus1 = r.ue();
      if (cpbCntMinus1 > 31)
        throw new HeicError('INVALID_BITSTREAM', 'heic: HRD cpb_cnt_minus1 exceeds 31');
    }
    if (commonInfo.nalHrdPresent)
      skipSubLayerHrdParameters(r, cpbCntMinus1, commonInfo.subPicHrdParamsPresent);
    if (commonInfo.vclHrdPresent)
      skipSubLayerHrdParameters(r, cpbCntMinus1, commonInfo.subPicHrdParamsPresent);
  }
  return commonInfo;
}

/** Parse one st_ref_pic_set (7.3.7), including inter-RPS prediction. */
export function parseShortTermRefPicSet(
  r: BitReader,
  idx: number,
  numSets: number,
  previousSets: readonly ShortTermRefPicSet[],
): ShortTermRefPicSet {
  let interRpsPred = false;
  if (idx !== 0) interRpsPred = r.readBit() === 1;
  if (interRpsPred) {
    const deltaIdxMinus1 = idx === numSets ? r.ue() : 0;
    const refIdx = idx - (deltaIdxMinus1 + 1);
    const referenceSet = previousSets[refIdx];
    if (!referenceSet)
      throw new HeicError('INVALID_BITSTREAM', 'heic: invalid inter-RPS reference index');

    const deltaRpsSign = r.readBit() === 1 ? -1 : 1;
    const absDeltaRpsMinus1 = r.ue();
    if (absDeltaRpsMinus1 > 32767)
      throw new HeicError('INVALID_BITSTREAM', 'heic: invalid inter-RPS delta');
    const deltaRps = deltaRpsSign * (absDeltaRpsMinus1 + 1);
    const sourceNegativeCount = referenceSet.deltaPocS0.length;
    const sourcePositiveCount = referenceSet.deltaPocS1.length;
    const sourceDeltaCount = sourceNegativeCount + sourcePositiveCount;
    const usedByCurrPic: boolean[] = [];
    const useDelta: boolean[] = [];
    for (let j = 0; j <= sourceDeltaCount; j++) {
      const used = r.readBit() === 1;
      usedByCurrPic.push(used);
      useDelta.push(used || r.readBit() === 1);
    }

    const deltaPocS0: number[] = [];
    const usedByCurrPicS0: boolean[] = [];
    for (let j = sourcePositiveCount - 1; j >= 0; j--) {
      const delta = referenceSet.deltaPocS1[j] + deltaRps;
      const sourceIdx = sourceNegativeCount + j;
      if (delta < 0 && useDelta[sourceIdx]) {
        deltaPocS0.push(delta);
        usedByCurrPicS0.push(usedByCurrPic[sourceIdx]);
      }
    }
    if (deltaRps < 0 && useDelta[sourceDeltaCount]) {
      deltaPocS0.push(deltaRps);
      usedByCurrPicS0.push(usedByCurrPic[sourceDeltaCount]);
    }
    for (let j = 0; j < sourceNegativeCount; j++) {
      const delta = referenceSet.deltaPocS0[j] + deltaRps;
      if (delta < 0 && useDelta[j]) {
        deltaPocS0.push(delta);
        usedByCurrPicS0.push(usedByCurrPic[j]);
      }
    }

    const deltaPocS1: number[] = [];
    const usedByCurrPicS1: boolean[] = [];
    for (let j = sourceNegativeCount - 1; j >= 0; j--) {
      const delta = referenceSet.deltaPocS0[j] + deltaRps;
      if (delta > 0 && useDelta[j]) {
        deltaPocS1.push(delta);
        usedByCurrPicS1.push(usedByCurrPic[j]);
      }
    }
    if (deltaRps > 0 && useDelta[sourceDeltaCount]) {
      deltaPocS1.push(deltaRps);
      usedByCurrPicS1.push(usedByCurrPic[sourceDeltaCount]);
    }
    for (let j = 0; j < sourcePositiveCount; j++) {
      const delta = referenceSet.deltaPocS1[j] + deltaRps;
      const sourceIdx = sourceNegativeCount + j;
      if (delta > 0 && useDelta[sourceIdx]) {
        deltaPocS1.push(delta);
        usedByCurrPicS1.push(usedByCurrPic[sourceIdx]);
      }
    }
    if (deltaPocS0.length + deltaPocS1.length > 16)
      throw new HeicError('INVALID_BITSTREAM', 'heic: too many short-term reference pictures');
    return { deltaPocS0, usedByCurrPicS0, deltaPocS1, usedByCurrPicS1 };
  }

  const numNegative = r.ue();
  const numPositive = r.ue();
  if (numNegative + numPositive > 16)
    throw new HeicError('INVALID_BITSTREAM', 'heic: too many short-term reference pictures');
  const deltaPocS0: number[] = [];
  const usedByCurrPicS0: boolean[] = [];
  let delta = 0;
  for (let j = 0; j < numNegative; j++) {
    const deltaMinus1 = r.ue();
    if (deltaMinus1 > 32767)
      throw new HeicError('INVALID_BITSTREAM', 'heic: invalid negative reference POC delta');
    delta -= deltaMinus1 + 1;
    deltaPocS0.push(delta);
    usedByCurrPicS0.push(r.readBit() === 1);
  }

  const deltaPocS1: number[] = [];
  const usedByCurrPicS1: boolean[] = [];
  delta = 0;
  for (let j = 0; j < numPositive; j++) {
    const deltaMinus1 = r.ue();
    if (deltaMinus1 > 32767)
      throw new HeicError('INVALID_BITSTREAM', 'heic: invalid positive reference POC delta');
    delta += deltaMinus1 + 1;
    deltaPocS1.push(delta);
    usedByCurrPicS1.push(r.readBit() === 1);
  }
  return { deltaPocS0, usedByCurrPicS0, deltaPocS1, usedByCurrPicS1 };
}

/** Parse an SPS NAL unit (including its 2-byte NAL header). */
export function parseSps(
  nal: Uint8Array,
  options: {
    /**
     * Accept Annex F multilayer extension syntax after the base-layer SPS.
     * This only permits parsing an `hvc1` layer-0 item; it does not decode
     * `lhv1` enhancement-layer prediction.
     */
    allowBaseLayerMultilayerExtension?: boolean;
    /** Active VPS required to infer fields omitted by an Annex F multilayer SPS. */
    layeredVps?: LayeredVpsInfo;
  } = {},
): SpsInfo {
  if (nal.length < 3 || nal[0] & 0x80 || !(nal[1] & 0x07))
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid SPS NAL header');
  if (((nal[0] >> 1) & 0x3f) !== 33)
    throw new HeicError('INVALID_BITSTREAM', 'heic: expected an SPS NAL unit');
  const layerId = ((nal[0] & 1) << 5) | (nal[1] >> 3);
  const r = new BitReader(toRbsp(nal));

  const videoParameterSetId = r.readBits(4);
  const spsExtOrMaxSubLayersMinus1 = r.readBits(3);
  const multiLayerExtSps = layerId !== 0 && spsExtOrMaxSubLayersMinus1 === 7;
  let maxSubLayersMinus1 = spsExtOrMaxSubLayersMinus1;
  if (!multiLayerExtSps && maxSubLayersMinus1 > 6)
    throw new HeicError('INVALID_BITSTREAM', 'heic: reserved SPS sub-layer count');
  if (multiLayerExtSps) {
    const vps = options.layeredVps;
    if (!vps)
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        'heic: multilayer SPS requires its active VPS representation formats',
      );
    if (vps.vpsId !== videoParameterSetId)
      throw new HeicError('INVALID_BITSTREAM', 'heic: layered SPS refers to a different VPS');
    if (!vps.layerIds.includes(layerId))
      throw new HeicError('INVALID_BITSTREAM', 'heic: layered SPS layer is absent from its VPS');
    maxSubLayersMinus1 = vps.maxSubLayersMinus1;
  } else {
    r.readBit(); // sps_temporal_id_nesting_flag
    skipProfileTierLevel(r, maxSubLayersMinus1);
  }

  const spsId = r.ue();
  let representationFormatIndex: number | null = null;
  let chromaFormatIdc: number;
  let separateColourPlane: boolean;
  let picWidthInLumaSamples: number;
  let picHeightInLumaSamples: number;
  let cropLeft = 0;
  let cropRight = 0;
  let cropTop = 0;
  let cropBottom = 0;
  let bitDepthLuma: number;
  let bitDepthChroma: number;
  if (multiLayerExtSps) {
    const vps = options.layeredVps!;
    const updateRepFormatFlag = r.readBit() === 1;
    if (vps.representationFormats.length === 1 && updateRepFormatFlag)
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: layered SPS updates a VPS with only one representation format',
      );
    const spsRepFormatIndex = updateRepFormatFlag ? r.readBits(8) : null;
    const layerIndex = vps.layerIds.indexOf(layerId);
    representationFormatIndex = updateRepFormatFlag
      ? spsRepFormatIndex
      : vps.representationFormatIndices[layerIndex];
    if (representationFormatIndex === null || representationFormatIndex === undefined)
      throw new HeicError('INVALID_BITSTREAM', 'heic: layered SPS has no VPS format index');
    const representationFormat = vps.representationFormats[representationFormatIndex];
    if (!representationFormat)
      throw new HeicError('INVALID_BITSTREAM', 'heic: layered SPS selects a missing VPS format');
    ({
      chromaFormatIdc,
      separateColourPlane,
      width: picWidthInLumaSamples,
      height: picHeightInLumaSamples,
      bitDepthLuma,
      bitDepthChroma,
      cropLeft,
      cropRight,
      cropTop,
      cropBottom,
    } = representationFormat);
  } else {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc > 3)
      throw new HeicError(
        'INVALID_BITSTREAM',
        `heic: invalid chroma_format_idc ${chromaFormatIdc}`,
      );
    separateColourPlane = chromaFormatIdc === 3 && r.readBit() === 1;

    picWidthInLumaSamples = r.ue();
    picHeightInLumaSamples = r.ue();

    if (r.readBit() === 1) {
      // conformance_window_flag
      cropLeft = r.ue();
      cropRight = r.ue();
      cropTop = r.ue();
      cropBottom = r.ue();
    }

    bitDepthLuma = r.ue() + 8;
    bitDepthChroma = r.ue() + 8;
  }

  const log2MaxPicOrderCntLsb = r.ue() + 4;

  if (!multiLayerExtSps) {
    const subLayerOrderingPresent = r.readBit() === 1;
    const first = subLayerOrderingPresent ? 0 : maxSubLayersMinus1;
    for (let i = first; i <= maxSubLayersMinus1; i++) {
      r.ue(); // sps_max_dec_pic_buffering_minus1
      r.ue(); // sps_max_num_reorder_pics
      r.ue(); // sps_max_latency_increase_plus1
    }
  }

  const log2MinLumaCodingBlockSize = r.ue() + 3;
  const log2CtbSize = log2MinLumaCodingBlockSize + r.ue();
  if (log2MinLumaCodingBlockSize < 3 || log2MinLumaCodingBlockSize > 6)
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid minimum luma coding block size');
  const minLumaCodingBlockSize = 1 << log2MinLumaCodingBlockSize;
  // H.265 7.4.3.2.1 requires the coded dimensions to be multiples of
  // MinCbSizeY. CTBs may be incomplete at picture edges, but minimum CUs may not.
  if (
    picWidthInLumaSamples % minLumaCodingBlockSize !== 0 ||
    picHeightInLumaSamples % minLumaCodingBlockSize !== 0
  )
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: coded dimensions are not multiples of the minimum luma coding block size',
    );
  const log2MinTransformBlockSize = r.ue() + 2;
  const log2MaxTransformBlockSize = log2MinTransformBlockSize + r.ue();
  // H.265 7.3.2.2.1: the signalled max_transform_hierarchy_depth_* values
  // are coded as minus one; keep the derived maximum depth internally.
  const maxTransformHierarchyDepthInter = r.ue() + 1;
  const maxTransformHierarchyDepthIntra = r.ue() + 1;

  const scalingListEnabled = r.readBit() === 1;
  let scalingListData: ScalingListData | null = null;
  let scalingListInferred = false;
  let scalingListRefLayerId: number | null = null;
  if (scalingListEnabled) {
    if (multiLayerExtSps) scalingListInferred = r.readBit() === 1;
    if (scalingListInferred) {
      scalingListRefLayerId = r.readBits(6);
      if (
        scalingListRefLayerId > 62 ||
        !options.layeredVps?.layerIds.includes(scalingListRefLayerId)
      )
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: scaling-list reference layer is absent from the active VPS',
        );
      const layerIndex = options.layeredVps.layerIds.indexOf(layerId);
      const referenceLayerIds = options.layeredVps.referenceLayerIds?.[layerIndex];
      if (referenceLayerIds && !referenceLayerIds.includes(scalingListRefLayerId))
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: scaling-list reference is not a reference layer of this SPS layer',
        );
    } else {
      scalingListData =
        r.readBit() === 1 // sps_scaling_list_data_present_flag
          ? parseScalingListData(r)
          : defaultScalingListData();
    }
  }

  const ampEnabled = r.readBit() === 1;
  const sampleAdaptiveOffsetEnabled = r.readBit() === 1;
  const pcmEnabled = r.readBit() === 1;
  let pcmSampleBitDepthLuma = 0;
  let pcmSampleBitDepthChroma = 0;
  let log2MinPcmLumaCodingBlockSize = 0;
  let log2MaxPcmLumaCodingBlockSize = 0;
  let pcmLoopFilterDisabled = false;
  if (pcmEnabled) {
    pcmSampleBitDepthLuma = r.readBits(4) + 1;
    pcmSampleBitDepthChroma = r.readBits(4) + 1;
    log2MinPcmLumaCodingBlockSize = r.ue() + 3;
    log2MaxPcmLumaCodingBlockSize = log2MinPcmLumaCodingBlockSize + r.ue();
    pcmLoopFilterDisabled = r.readBit() === 1;
  }

  const numShortTermRefPicSets = r.ue();
  if (numShortTermRefPicSets > 64)
    throw new HeicError('INVALID_BITSTREAM', 'heic: too many short-term reference picture sets');
  const numDeltaPocs: number[] = [];
  const numUsedByCurrPic: number[] = [];
  const shortTermRefPicSets: ShortTermRefPicSet[] = [];
  for (let i = 0; i < numShortTermRefPicSets; i++) {
    const refSet = parseShortTermRefPicSet(r, i, numShortTermRefPicSets, shortTermRefPicSets);
    shortTermRefPicSets.push(refSet);
    numDeltaPocs[i] = refSet.deltaPocS0.length + refSet.deltaPocS1.length;
    numUsedByCurrPic[i] =
      refSet.usedByCurrPicS0.filter(Boolean).length + refSet.usedByCurrPicS1.filter(Boolean).length;
  }

  const longTermRefPicsPresent = r.readBit() === 1;
  let numLongTermRefPicsSps = 0;
  const longTermRefPicPocLsbSps: number[] = [];
  const longTermUsedByCurrPic: boolean[] = [];
  if (longTermRefPicsPresent) {
    numLongTermRefPicsSps = r.ue();
    if (numLongTermRefPicsSps > 32)
      throw new HeicError('INVALID_BITSTREAM', 'heic: too many SPS long-term reference pictures');
    for (let i = 0; i < numLongTermRefPicsSps; i++) {
      longTermRefPicPocLsbSps.push(r.readBits(log2MaxPicOrderCntLsb));
      longTermUsedByCurrPic.push(r.readBit() === 1);
    }
  }

  const temporalMvpEnabled = r.readBit() === 1;
  const strongIntraSmoothingEnabled = r.readBit() === 1;

  let color: VuiColorInfo | null = null;
  let chromaSampleLocation: ChromaSampleLocation | undefined;
  let defaultDisplayWindow: DefaultDisplayWindow | null = null;
  let chromaSampleLocTypeTopField: number | undefined,
    chromaSampleLocTypeBottomField: number | undefined,
    fieldSequence = false,
    frameFieldInfoPresent = false;
  const vuiPresent = r.readBit() === 1;
  if (vuiPresent) {
    // vui_parameters_present_flag
    if (r.readBit() === 1) {
      // aspect_ratio_info_present_flag
      const aspectRatioIdc = r.readBits(8);
      if (aspectRatioIdc === 255) {
        r.readBits(16); // sar_width
        r.readBits(16); // sar_height
      }
    }
    if (r.readBit() === 1)
      // overscan_info_present_flag
      r.readBit(); // overscan_appropriate_flag
    if (r.readBit() === 1) {
      // video_signal_type_present_flag
      r.readBits(3); // video_format
      const videoFullRange = r.readBit() === 1;
      let colourPrimaries = 2;
      let transferCharacteristics = 2;
      let matrixCoeffs = 2;
      if (r.readBit() === 1) {
        // colour_description_present_flag
        colourPrimaries = r.readBits(8);
        transferCharacteristics = r.readBits(8);
        matrixCoeffs = r.readBits(8);
      }
      color = { videoFullRange, colourPrimaries, transferCharacteristics, matrixCoeffs };
    }
    if (r.readBit()) {
      const topFieldLocation = r.ue();
      const bottomFieldLocation = r.ue();
      if (topFieldLocation > 6 || bottomFieldLocation > 6)
        throw new HeicError('INVALID_BITSTREAM', 'heic: invalid VUI chroma sample location');
      // H.265 Annex E defines these VUI values only for 4:2:0. For still
      // frames, a single location is usable only when both field values agree.
      // H.274 V4 value 6 means the location is unspecified; the code-point
      // mapper returns null for it, so it remains valid metadata without
      // selecting an upsampling phase.
      if (chromaFormatIdc === 1 && topFieldLocation === bottomFieldLocation)
        chromaSampleLocation = chromaSampleLocationFromCode(2, topFieldLocation) ?? undefined;
      chromaSampleLocTypeTopField = topFieldLocation;
      chromaSampleLocTypeBottomField = bottomFieldLocation;
    }
    r.readBit(); // neutral_chroma_indication_flag
    fieldSequence = r.readBit() === 1;
    frameFieldInfoPresent = r.readBit() === 1;
    if (fieldSequence && !frameFieldInfoPresent)
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: field-sequence SPS requires frame-field information',
      );
    if (r.readBit()) {
      defaultDisplayWindow = {
        left: r.ue(),
        right: r.ue(),
        top: r.ue(),
        bottom: r.ue(),
      };
    }
    if (r.readBit()) {
      r.readBits(32);
      r.readBits(32);
      if (r.readBit()) r.ue();
      if (r.readBit()) skipHrdParameters(r, maxSubLayersMinus1);
    }
    if (r.readBit()) {
      r.readBit();
      r.readBit();
      r.readBit();
      r.ue();
      r.ue();
      r.ue();
      r.ue();
      r.ue();
    }
  }

  let rangeFlags = 0;
  let screenContentExtension: SpsScreenContentExtensionInfo | null = null;
  if (r.readBit()) {
    // sps_extension_present_flag
    const rangeExtensionPresent = r.readBit() === 1;
    const multilayerExtensionPresent = r.readBit() === 1;
    const extension3dPresent = r.readBit() === 1;
    const screenContentExtensionPresent = r.readBit() === 1;
    // Reserved extension bits may be nonzero. H.265 V11 requires decoders to
    // allow them and ignore the trailing sps_extension_data_flag syntax.
    r.readBits(layerId === 0 ? 4 : 5);
    const baseLayerMultilayerExtension =
      multilayerExtensionPresent && options.allowBaseLayerMultilayerExtension === true;
    if (
      (multilayerExtensionPresent && layerId === 0 && !baseLayerMultilayerExtension) ||
      extension3dPresent
    )
      throw new HeicError('UNSUPPORTED_FEATURE', 'heic: unsupported SPS extension');
    if (rangeExtensionPresent) rangeFlags = r.readBits(9);
    if (multilayerExtensionPresent) r.readBit(); // inter_view_mv_vert_constraint_flag

    if (screenContentExtensionPresent) {
      const currPicRefEnabled = r.readBit() === 1;
      const paletteModeEnabled = r.readBit() === 1;
      let paletteMaxSize = 0;
      let deltaPaletteMaxPredictorSize = 0;
      let palettePredictorInitializersPresent = false;
      const palettePredictorInitializers: number[][] = [];
      if (paletteModeEnabled) {
        paletteMaxSize = r.ue();
        deltaPaletteMaxPredictorSize = r.ue();
        palettePredictorInitializersPresent = r.readBit() === 1;
        const maxPredictorSize = paletteMaxSize + deltaPaletteMaxPredictorSize;
        if (
          !Number.isSafeInteger(maxPredictorSize) ||
          maxPredictorSize > 4096 ||
          (paletteMaxSize === 0 &&
            (deltaPaletteMaxPredictorSize !== 0 || palettePredictorInitializersPresent))
        )
          throw new HeicError('INVALID_BITSTREAM', 'heic: invalid SPS palette size parameters');

        if (palettePredictorInitializersPresent) {
          const entryCount = r.ue() + 1;
          if (entryCount > maxPredictorSize)
            throw new HeicError(
              'INVALID_BITSTREAM',
              'heic: SPS palette initializer count exceeds predictor size',
            );
          const componentCount = chromaFormatIdc === 0 ? 1 : 3;
          for (let component = 0; component < componentCount; component++) {
            const bitDepth = component === 0 ? bitDepthLuma : bitDepthChroma;
            const values: number[] = [];
            for (let i = 0; i < entryCount; i++) values.push(r.readBits(bitDepth));
            palettePredictorInitializers.push(values);
          }
        }
      }
      const motionVectorResolutionControlIdc = r.readBits(2);
      if (motionVectorResolutionControlIdc === 3)
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: reserved motion vector resolution control value',
        );
      const intraBoundaryFilteringDisabled = r.readBit() === 1;
      screenContentExtension = {
        currPicRefEnabled,
        paletteModeEnabled,
        paletteMaxSize,
        deltaPaletteMaxPredictorSize,
        palettePredictorInitializersPresent,
        palettePredictorInitializers,
        motionVectorResolutionControlIdc,
        intraBoundaryFilteringDisabled,
      };
    }
  }

  // SubWidthC/SubHeightC per chroma_format_idc (4:2:0 = 2/2, 4:2:2 = 2/1).
  const subW = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1;
  const subH = chromaFormatIdc === 1 ? 2 : 1;

  const width = picWidthInLumaSamples - subW * (cropLeft + cropRight);
  const height = picHeightInLumaSamples - subH * (cropTop + cropBottom);
  const displayLeft = cropLeft + (defaultDisplayWindow?.left ?? 0);
  const displayRight = cropRight + (defaultDisplayWindow?.right ?? 0);
  const displayTop = cropTop + (defaultDisplayWindow?.top ?? 0);
  const displayBottom = cropBottom + (defaultDisplayWindow?.bottom ?? 0);
  if (
    width <= 0 ||
    height <= 0 ||
    subW * (displayLeft + displayRight) >= picWidthInLumaSamples ||
    subH * (displayTop + displayBottom) >= picHeightInLumaSamples
  )
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: SPS crop or default display window is out of bounds',
    );

  return {
    layerId,
    videoParameterSetId,
    spsId,
    vuiPresent,
    multiLayerExtSps,
    representationFormatIndex,
    chromaFormatIdc,
    separateColourPlane,
    rangeFlags,
    screenContentExtension,
    transformSkipRotationEnabled: (rangeFlags & (1 << 8)) !== 0,
    transformSkipContextEnabled: (rangeFlags & (1 << 7)) !== 0,
    implicitRdpcmEnabled: (rangeFlags & (1 << 6)) !== 0,
    explicitRdpcmEnabled: (rangeFlags & (1 << 5)) !== 0,
    persistentRiceAdaptationEnabled: (rangeFlags & (1 << 1)) !== 0,
    extendedPrecisionProcessingEnabled: (rangeFlags & (1 << 4)) !== 0,
    cabacBypassAlignmentEnabled: (rangeFlags & 1) !== 0,
    highPrecisionOffsetsEnabled: (rangeFlags & (1 << 2)) !== 0,
    width,
    height,
    picWidthInLumaSamples,
    picHeightInLumaSamples,
    cropLeft,
    cropRight,
    cropTop,
    cropBottom,
    bitDepthLuma,
    bitDepthChroma,
    log2MaxPicOrderCntLsb,
    log2MinLumaCodingBlockSize,
    log2CtbSize,
    log2MinTransformBlockSize,
    log2MaxTransformBlockSize,
    maxTransformHierarchyDepthInter,
    maxTransformHierarchyDepthIntra,
    scalingListEnabled,
    scalingListData,
    scalingListInferred,
    scalingListRefLayerId,
    ampEnabled,
    sampleAdaptiveOffsetEnabled,
    pcmEnabled,
    pcmSampleBitDepthLuma,
    pcmSampleBitDepthChroma,
    log2MinPcmLumaCodingBlockSize,
    log2MaxPcmLumaCodingBlockSize,
    pcmLoopFilterDisabled,
    strongIntraSmoothingEnabled,
    numShortTermRefPicSets,
    numDeltaPocs,
    numUsedByCurrPic,
    shortTermRefPicSets,
    longTermRefPicsPresent,
    numLongTermRefPicsSps,
    longTermRefPicPocLsbSps,
    longTermUsedByCurrPic,
    temporalMvpEnabled,
    color,
    defaultDisplayWindow,
    fieldSequence,
    frameFieldInfoPresent,
    ...(chromaSampleLocation ? { chromaSampleLocation } : {}),
    ...(chromaSampleLocTypeTopField === undefined
      ? {}
      : { chromaSampleLocTypeTopField, chromaSampleLocTypeBottomField }),
  };
}

/**
 * Resolve Annex F SPS scaling-list inference from the active SPS in the
 * referenced layer. The map must contain the SPS active for the same picture
 * in each layer; selecting an arbitrary SPS from the VPS is not sufficient.
 */
export function resolveSpsScalingListData(
  sps: SpsInfo,
  activeSpsByLayer: ReadonlyMap<number, SpsInfo>,
  vps?: LayeredVpsInfo,
): SpsInfo {
  if (sps.scalingListInferred !== true) return sps;
  const layerId = sps.layerId;
  const referenceLayerId = sps.scalingListRefLayerId;
  if (layerId === undefined || referenceLayerId === undefined || referenceLayerId === null)
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: inferred SPS scaling-list reference is incomplete',
    );

  const layerIndex = vps?.layerIds.indexOf(layerId) ?? -1;
  if (vps && layerIndex < 0)
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: active VPS does not contain the inferred SPS layer',
    );
  const referenceLayerIds = layerIndex >= 0 ? vps?.referenceLayerIds?.[layerIndex] : undefined;
  if (referenceLayerIds && !referenceLayerIds.includes(referenceLayerId))
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: scaling-list reference is not a reference layer of this SPS layer',
    );

  const referenceSps = activeSpsByLayer.get(referenceLayerId);
  if (!referenceSps)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      `heic: active SPS for scaling-list reference layer ${referenceLayerId} is unavailable`,
    );
  if (referenceSps.layerId !== referenceLayerId)
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: active scaling-list reference SPS belongs to a different layer',
    );
  if (
    !referenceSps.scalingListEnabled ||
    referenceSps.scalingListInferred === true ||
    !referenceSps.scalingListData
  )
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: scaling-list reference SPS must enable and explicitly resolve scaling lists',
    );

  return { ...sps, scalingListData: referenceSps.scalingListData };
}
