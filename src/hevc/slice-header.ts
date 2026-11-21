import { HeicError } from '../errors.js';
/**
 * Slice segment header parsing (7.3.6.1) for still images and bounded
 * P-slice decoding, including B-slice reference and weighted-prediction
 * syntax, WPP, and tile entry points.
 *
 * Entry point offsets count bytes of the ESCAPED NAL payload (emulation
 * prevention bytes included, 7.4.7.1), so the header is parsed from the RBSP
 * while tracking the RBSP -> raw byte mapping, and each substream is
 * unescaped independently.
 */
import type { PpsInfo } from './pps.js';
import type { ShortTermRefPicSet, SpsInfo } from './sps.js';
import { BitReader } from './nal.js';
import { parseShortTermRefPicSet } from './sps.js';

export interface L0WeightedPredictionParameters {
  lumaWeight: number;
  lumaOffset: number;
  chromaWeight: [number, number];
  chromaOffset: [number, number];
}

export interface WeightedPredictionParameters {
  lumaLog2WeightDenom: number;
  chromaLog2WeightDenom: number;
  l0: L0WeightedPredictionParameters[];
  l1: L0WeightedPredictionParameters[];
}

export interface LongTermReferencePicture {
  pocLsb: number;
  usedByCurrPic: boolean;
  deltaPocMsbPresent: boolean;
  deltaPocMsbCycle: number;
}

export interface LayeredSliceContext {
  /** VPS flag controlling whether direct reference layers are active by default. */
  defaultRefLayersActiveFlag: boolean;
  /** Direct reference layer ids for the current NAL layer, in VPS order. */
  directReferenceLayerIds: number[];
  maxOneActiveRefLayerFlag: boolean;
  pocLsbNotPresentFlag: boolean;
}

export interface SliceHeader {
  firstSliceInPic: boolean;
  dependentSliceSegment: boolean;
  /** CTB raster index where this segment starts. */
  segmentAddress: number;
  sliceType: number;
  sliceQpY: number;
  cbQpOffset: number;
  crQpOffset: number;
  /** Picture order count LSB from this independent slice header, when present. */
  pictureOrderCntLsb: number | null;
  /** The short-term RPS selected or signalled by this slice. */
  shortTermRefPicSet: ShortTermRefPicSet | null;
  longTermRefPics: LongTermReferencePicture[];
  numRefIdxL0ActiveMinus1: number;
  /** Explicit RefPicList0Temp indices, or null when the list is implicit. */
  refPicListL0Modification: number[] | null;
  numRefIdxL1ActiveMinus1: number;
  /** Explicit RefPicList1Temp indices, or null when the list is implicit. */
  refPicListL1Modification: number[] | null;
  weightedPrediction: WeightedPredictionParameters | null;
  fiveMinusMaxNumMergeCand: number;
  cabacInitFlag: boolean;
  sliceTemporalMvpEnabled: boolean;
  /** Whether the temporal-MVP collocated picture comes from L0. */
  collocatedFromL0: boolean;
  /** Collocated-list index for temporal MVP; inferred as 0 when absent. */
  collocatedRefIdx: number;
  mvdL1ZeroFlag: boolean;
  useIntegerMv: boolean;
  cuChromaQpOffsetEnabled: boolean;
  sliceActYQpOffset: number;
  sliceActCbQpOffset: number;
  sliceActCrQpOffset: number;
  currentPictureReferenceEnabled: boolean;
  interLayerPredictionEnabled: boolean;
  interLayerReferenceCount: number;
  interLayerReferenceLayerIds: number[];
  saoLuma: boolean;
  saoChroma: boolean;
  deblockingDisabled: boolean;
  betaOffsetDiv2: number;
  tcOffsetDiv2: number;
  loopFilterAcrossSlices: boolean;
  /**
   * CABAC substreams (one per WPP row / tile, or a single one), already
   * unescaped and ready for entropy decoding.
   */
  substreams: Uint8Array[];
}

export const SLICE_TYPE_B = 0;
export const SLICE_TYPE_P = 1;
export const SLICE_TYPE_I = 2;

interface Rbsp {
  data: Uint8Array;
  /** rawIndex[i] = byte offset in `nal` that produced rbsp byte i. */
  rawIndex: Int32Array;
}

function clip(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Parse the explicit P-slice `pred_weight_table()` for list 0. */
function readWeightedPredictionParameters(
  r: BitReader,
  sps: SpsInfo,
  numRefIdxL0ActiveMinus1: number,
  numRefIdxL1ActiveMinus1?: number,
): WeightedPredictionParameters {
  const lumaLog2WeightDenom = r.ue();
  if (lumaLog2WeightDenom > 7)
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid luma weight denominator');

  let chromaLog2WeightDenom = lumaLog2WeightDenom;
  if (sps.chromaFormatIdc !== 0) {
    const deltaChromaLog2WeightDenom = r.se();
    chromaLog2WeightDenom = lumaLog2WeightDenom + deltaChromaLog2WeightDenom;
    if (chromaLog2WeightDenom < 0 || chromaLog2WeightDenom > 7)
      throw new HeicError('INVALID_BITSTREAM', 'heic: invalid chroma weight denominator');
  }

  const lumaHalfRange = 1 << (sps.highPrecisionOffsetsEnabled ? sps.bitDepthLuma - 1 : 7);
  const chromaHalfRange = 1 << (sps.highPrecisionOffsetsEnabled ? sps.bitDepthChroma - 1 : 7);
  const readList = (refCount: number): L0WeightedPredictionParameters[] => {
    const lumaPresent = Array.from({ length: refCount }, () => r.readBit() === 1);
    const chromaPresent =
      sps.chromaFormatIdc !== 0
        ? Array.from({ length: refCount }, () => r.readBit() === 1)
        : Array<boolean>(refCount).fill(false);
    const list: L0WeightedPredictionParameters[] = [];
    for (let i = 0; i < refCount; i++) {
      let lumaWeight = 1 << lumaLog2WeightDenom;
      let lumaOffset = 0;
      if (lumaPresent[i]) {
        const deltaLumaWeight = r.se();
        lumaOffset = r.se();
        if (
          deltaLumaWeight < -128 ||
          deltaLumaWeight > 127 ||
          lumaOffset < -lumaHalfRange ||
          lumaOffset >= lumaHalfRange
        )
          throw new HeicError(
            'INVALID_BITSTREAM',
            'heic: invalid luma prediction weight or offset',
          );
        lumaWeight += deltaLumaWeight;
      }

      const chromaWeight: [number, number] = [
        1 << chromaLog2WeightDenom,
        1 << chromaLog2WeightDenom,
      ];
      const chromaOffset: [number, number] = [0, 0];
      if (chromaPresent[i]) {
        for (let component = 0; component < 2; component++) {
          const deltaWeight = r.se();
          const deltaOffset = r.se();
          if (
            deltaWeight < -128 ||
            deltaWeight > 127 ||
            deltaOffset < -4 * chromaHalfRange ||
            deltaOffset >= 4 * chromaHalfRange
          )
            throw new HeicError(
              'INVALID_BITSTREAM',
              'heic: invalid chroma prediction weight or offset',
            );
          const weight = (1 << chromaLog2WeightDenom) + deltaWeight;
          chromaWeight[component] = weight;
          chromaOffset[component] = clip(
            chromaHalfRange + deltaOffset - ((chromaHalfRange * weight) >> chromaLog2WeightDenom),
            -chromaHalfRange,
            chromaHalfRange - 1,
          );
        }
      }

      list.push({ lumaWeight, lumaOffset, chromaWeight, chromaOffset });
    }
    return list;
  };
  const l0 = readList(numRefIdxL0ActiveMinus1 + 1);
  const l1 = numRefIdxL1ActiveMinus1 === undefined ? [] : readList(numRefIdxL1ActiveMinus1 + 1);
  return { lumaLog2WeightDenom, chromaLog2WeightDenom, l0, l1 };
}

/** Unescape a NAL payload (after the 2-byte header), keeping a raw map. */
function toRbspMapped(nal: Uint8Array): Rbsp {
  const data = new Uint8Array(nal.length - 2);
  const rawIndex = new Int32Array(nal.length - 2);
  let o = 0;
  let zeros = 0;
  for (let i = 2; i < nal.length; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 0x03) {
      zeros = 0;
      continue;
    }
    rawIndex[o] = i;
    data[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return { data: data.subarray(0, o), rawIndex: rawIndex.subarray(0, o) };
}

/** Strip emulation prevention bytes from a raw byte range of the NAL. */
function unescapeRange(nal: Uint8Array, start: number, end: number): Uint8Array {
  const out = new Uint8Array(end - start);
  let o = 0;
  let zeros = 0;
  for (let i = start; i < end; i++) {
    const b = nal[i];
    if (zeros >= 2 && b === 0x03) {
      zeros = 0;
      continue;
    }
    out[o++] = b;
    zeros = b === 0 ? zeros + 1 : 0;
  }
  return out.subarray(0, o);
}

function isIrap(nalType: number): boolean {
  return nalType >= 16 && nalType <= 23;
}

function isIdr(nalType: number): boolean {
  return nalType === 19 || nalType === 20;
}

/** Parse one coded slice segment NAL into its header + CABAC substreams. */
export function parseSliceHeader(
  nal: Uint8Array,
  sps: SpsInfo,
  pps: PpsInfo,
  independentHeader?: SliceHeader,
  layeredContext?: LayeredSliceContext,
): SliceHeader {
  const layerId = ((nal[0] & 1) << 5) | (nal[1] >> 3);
  if (layerId > 0 && !layeredContext)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: layered slice parsing requires its active VPS reference-layer context',
    );
  if (
    layeredContext &&
    (layeredContext.directReferenceLayerIds.length > 63 ||
      layeredContext.directReferenceLayerIds.some(
        (referenceLayerId) =>
          !Number.isInteger(referenceLayerId) || referenceLayerId < 0 || referenceLayerId > 62,
      ))
  )
    throw new HeicError('INVALID_OPTIONS', 'heic: invalid direct reference-layer count');
  const nalType = (nal[0] >> 1) & 0x3f;
  const rbsp = toRbspMapped(nal);
  const r = new BitReader(rbsp.data);

  const firstSliceInPic = r.readBit() === 1;
  if (isIrap(nalType)) r.readBit(); // no_output_of_prior_pics_flag
  r.ue(); // slice_pic_parameter_set_id

  const ctbSize = 1 << sps.log2CtbSize;
  const picWidthInCtbs = Math.ceil(sps.picWidthInLumaSamples / ctbSize);
  const picHeightInCtbs = Math.ceil(sps.picHeightInLumaSamples / ctbSize);
  const picSizeInCtbs = picWidthInCtbs * picHeightInCtbs;

  let dependentSliceSegment = false;
  let segmentAddress = 0;
  if (!firstSliceInPic) {
    if (pps.dependentSliceSegmentsEnabled) dependentSliceSegment = r.readBit() === 1;
    segmentAddress = r.readBits(Math.ceil(Math.log2(picSizeInCtbs)));
  }

  const inheritedHeader = dependentSliceSegment ? independentHeader : undefined;
  if (dependentSliceSegment && (!inheritedHeader || inheritedHeader.dependentSliceSegment))
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: dependent slice segment has no preceding independent slice header',
    );

  let sliceType = inheritedHeader?.sliceType ?? SLICE_TYPE_I;
  let sliceQpY = inheritedHeader?.sliceQpY ?? pps.initQp;
  let cbQpOffset = inheritedHeader?.cbQpOffset ?? pps.cbQpOffset;
  let crQpOffset = inheritedHeader?.crQpOffset ?? pps.crQpOffset;
  let pictureOrderCntLsb = inheritedHeader?.pictureOrderCntLsb ?? null;
  let shortTermRefPicSet = inheritedHeader?.shortTermRefPicSet ?? null;
  let longTermRefPics = inheritedHeader?.longTermRefPics ?? [];
  let numRefIdxL0ActiveMinus1 =
    inheritedHeader?.numRefIdxL0ActiveMinus1 ?? pps.numRefIdxL0DefaultActiveMinus1;
  let refPicListL0Modification = inheritedHeader?.refPicListL0Modification ?? null;
  let numRefIdxL1ActiveMinus1 =
    inheritedHeader?.numRefIdxL1ActiveMinus1 ?? pps.numRefIdxL1DefaultActiveMinus1;
  let refPicListL1Modification = inheritedHeader?.refPicListL1Modification ?? null;
  let weightedPrediction = inheritedHeader?.weightedPrediction ?? null;
  let fiveMinusMaxNumMergeCand = inheritedHeader?.fiveMinusMaxNumMergeCand ?? 0;
  let cabacInitFlag = inheritedHeader?.cabacInitFlag ?? false;
  let sliceTemporalMvpEnabled = inheritedHeader?.sliceTemporalMvpEnabled ?? false;
  let collocatedFromL0 = inheritedHeader?.collocatedFromL0 ?? true;
  let collocatedRefIdx = inheritedHeader?.collocatedRefIdx ?? 0;
  let mvdL1ZeroFlag = inheritedHeader?.mvdL1ZeroFlag ?? false;
  let useIntegerMv =
    inheritedHeader?.useIntegerMv ??
    sps.screenContentExtension?.motionVectorResolutionControlIdc === 1;
  let cuChromaQpOffsetEnabled = inheritedHeader?.cuChromaQpOffsetEnabled ?? false;
  let sliceActYQpOffset = inheritedHeader?.sliceActYQpOffset ?? 0;
  let sliceActCbQpOffset = inheritedHeader?.sliceActCbQpOffset ?? 0;
  let sliceActCrQpOffset = inheritedHeader?.sliceActCrQpOffset ?? 0;
  let currentPictureReferenceEnabled = inheritedHeader?.currentPictureReferenceEnabled ?? false;
  let interLayerPredictionEnabled = inheritedHeader?.interLayerPredictionEnabled ?? false;
  let interLayerReferenceCount = inheritedHeader?.interLayerReferenceCount ?? 0;
  let interLayerReferenceLayerIds = inheritedHeader?.interLayerReferenceLayerIds ?? [];
  let saoLuma = inheritedHeader?.saoLuma ?? false;
  let saoChroma = inheritedHeader?.saoChroma ?? false;
  let deblockingDisabled = inheritedHeader?.deblockingDisabled ?? pps.deblockingFilterDisabled;
  let betaOffsetDiv2 = inheritedHeader?.betaOffsetDiv2 ?? pps.betaOffsetDiv2;
  let tcOffsetDiv2 = inheritedHeader?.tcOffsetDiv2 ?? pps.tcOffsetDiv2;
  let loopFilterAcrossSlices =
    inheritedHeader?.loopFilterAcrossSlices ?? pps.loopFilterAcrossSlicesEnabled;

  if (!dependentSliceSegment) {
    for (let i = 0; i < pps.numExtraSliceHeaderBits; i++) r.readBit(); // slice_reserved_flag

    sliceType = r.ue();
    if (sliceType !== SLICE_TYPE_I && sliceType !== SLICE_TYPE_P && sliceType !== SLICE_TYPE_B)
      throw new HeicError('UNSUPPORTED_FEATURE', `heic: unsupported slice_type ${sliceType}`);

    if (pps.outputFlagPresent) r.readBit(); // pic_output_flag
    let numPicTotalCurr = 0;
    if ((layerId > 0 && !layeredContext!.pocLsbNotPresentFlag) || !isIdr(nalType))
      pictureOrderCntLsb = r.readBits(sps.log2MaxPicOrderCntLsb);
    if (!isIdr(nalType)) {
      // Reference-picture-set syntax is absent in IDR pictures.
      const useSpsSet = r.readBit() === 1; // H.265 7.3.6.1: present even with no SPS RPS.
      if (!useSpsSet) {
        shortTermRefPicSet = parseShortTermRefPicSet(
          r,
          sps.numShortTermRefPicSets,
          sps.numShortTermRefPicSets,
          sps.shortTermRefPicSets,
        );
      } else if (sps.numShortTermRefPicSets > 1) {
        const rpsIdx = r.readBits(Math.ceil(Math.log2(sps.numShortTermRefPicSets)));
        shortTermRefPicSet = sps.shortTermRefPicSets[rpsIdx] ?? null;
      } else if (sps.numShortTermRefPicSets === 1) {
        shortTermRefPicSet = sps.shortTermRefPicSets[0] ?? null;
      } else {
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: slice selects a missing short-term reference picture set',
        );
      }
      if (!shortTermRefPicSet)
        throw new HeicError('INVALID_BITSTREAM', 'heic: missing short-term reference picture set');
      numPicTotalCurr +=
        shortTermRefPicSet.usedByCurrPicS0.filter(Boolean).length +
        shortTermRefPicSet.usedByCurrPicS1.filter(Boolean).length;
      if (sps.longTermRefPicsPresent) {
        const fromSps = sps.numLongTermRefPicsSps ? r.ue() : 0,
          fromSlice = r.ue();
        if (fromSps > sps.numLongTermRefPicsSps || fromSps + fromSlice > 32)
          throw new HeicError('INVALID_BITSTREAM', 'heic: invalid long-term reference count');
        longTermRefPics = [];
        for (let i = 0; i < fromSps + fromSlice; i++) {
          let pocLsb: number;
          let usedByCurrPic: boolean;
          if (i < fromSps) {
            const spsIndex =
              sps.numLongTermRefPicsSps > 1
                ? r.readBits(Math.ceil(Math.log2(sps.numLongTermRefPicsSps)))
                : 0;
            if (spsIndex >= sps.numLongTermRefPicsSps)
              throw new HeicError(
                'INVALID_BITSTREAM',
                'heic: long-term SPS reference index is out of range',
              );
            pocLsb = sps.longTermRefPicPocLsbSps[spsIndex];
            usedByCurrPic = sps.longTermUsedByCurrPic[spsIndex] ?? false;
          } else {
            pocLsb = r.readBits(sps.log2MaxPicOrderCntLsb);
            usedByCurrPic = r.readBit() === 1;
          }
          if (usedByCurrPic) numPicTotalCurr++;
          const deltaPocMsbPresent = r.readBit() === 1;
          const deltaCycle = deltaPocMsbPresent ? r.ue() : 0;
          const previousCycle = longTermRefPics[i - 1]?.deltaPocMsbCycle ?? 0;
          const deltaPocMsbCycle =
            i === 0 || i === fromSps ? deltaCycle : deltaCycle + previousCycle;
          longTermRefPics.push({
            pocLsb,
            usedByCurrPic,
            deltaPocMsbPresent,
            deltaPocMsbCycle,
          });
        }
      }
      if (sps.temporalMvpEnabled) sliceTemporalMvpEnabled = r.readBit() === 1;
    }

    currentPictureReferenceEnabled =
      (sps.screenContentExtension?.currPicRefEnabled ?? false) &&
      (pps.screenContentExtension?.currPicRefEnabled ?? false);
    if (sliceType !== SLICE_TYPE_I && currentPictureReferenceEnabled) numPicTotalCurr++;

    interLayerPredictionEnabled = false;
    interLayerReferenceCount = 0;
    interLayerReferenceLayerIds = [];
    const directReferenceLayerIds = layeredContext?.directReferenceLayerIds ?? [];
    const directReferenceLayerCount = directReferenceLayerIds.length;
    if (layerId > 0 && directReferenceLayerCount > 0) {
      if (layeredContext!.defaultRefLayersActiveFlag) {
        interLayerPredictionEnabled = true;
        interLayerReferenceCount = directReferenceLayerCount;
        interLayerReferenceLayerIds = directReferenceLayerIds.slice();
      } else {
        interLayerPredictionEnabled = r.readBit() === 1;
        if (interLayerPredictionEnabled) {
          let selectedLayerIdcs: number[];
          if (layeredContext!.maxOneActiveRefLayerFlag || directReferenceLayerCount === 1) {
            interLayerReferenceCount = 1;
          } else {
            const layerIdcBits = Math.ceil(Math.log2(directReferenceLayerCount));
            interLayerReferenceCount = r.readBits(layerIdcBits) + 1;
          }
          if (interLayerReferenceCount !== directReferenceLayerCount) {
            const layerIdcBits = Math.ceil(Math.log2(directReferenceLayerCount));
            let previousLayerIdc = -1;
            selectedLayerIdcs = [];
            for (let i = 0; i < interLayerReferenceCount; i++) {
              const layerIdc = r.readBits(layerIdcBits);
              if (layerIdc >= directReferenceLayerCount || layerIdc <= previousLayerIdc)
                throw new HeicError(
                  'INVALID_BITSTREAM',
                  'heic: invalid inter-layer reference selection',
                );
              previousLayerIdc = layerIdc;
              selectedLayerIdcs.push(layerIdc);
            }
          } else {
            selectedLayerIdcs = directReferenceLayerIds.map((_, index) => index);
          }
          interLayerReferenceLayerIds = selectedLayerIdcs.map(
            (index) => directReferenceLayerIds[index],
          );
        }
      }
    }
    numPicTotalCurr += interLayerReferenceCount;

    if (sps.sampleAdaptiveOffsetEnabled) {
      saoLuma = r.readBit() === 1;
      if (sps.chromaFormatIdc !== 0) saoChroma = r.readBit() === 1;
    }

    if (sliceType === SLICE_TYPE_P || sliceType === SLICE_TYPE_B) {
      if (r.readBit() === 1) {
        numRefIdxL0ActiveMinus1 = r.ue();
        if (numRefIdxL0ActiveMinus1 > 14)
          throw new HeicError('INVALID_BITSTREAM', 'heic: invalid active L0 reference count');
        if (sliceType === SLICE_TYPE_B) {
          numRefIdxL1ActiveMinus1 = r.ue();
          if (numRefIdxL1ActiveMinus1 > 14)
            throw new HeicError('INVALID_BITSTREAM', 'heic: invalid active L1 reference count');
        }
      }
      if (numPicTotalCurr === 0)
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: inter slice has no current reference pictures',
        );
      if (pps.listsModificationPresent && numPicTotalCurr > 1) {
        if (r.readBit() === 1) {
          const entryBits = Math.ceil(Math.log2(numPicTotalCurr));
          refPicListL0Modification = [];
          for (let i = 0; i <= numRefIdxL0ActiveMinus1; i++) {
            const entry = entryBits === 0 ? 0 : r.readBits(entryBits);
            if (entry >= numPicTotalCurr)
              throw new HeicError(
                'INVALID_BITSTREAM',
                'heic: reference-list modification index exceeds the current reference set',
              );
            refPicListL0Modification.push(entry);
          }
        } else {
          refPicListL0Modification = null;
        }
        if (sliceType === SLICE_TYPE_B) {
          if (r.readBit() === 1) {
            const entryBits = Math.ceil(Math.log2(numPicTotalCurr));
            refPicListL1Modification = [];
            for (let i = 0; i <= numRefIdxL1ActiveMinus1; i++) {
              const entry = entryBits === 0 ? 0 : r.readBits(entryBits);
              if (entry >= numPicTotalCurr)
                throw new HeicError(
                  'INVALID_BITSTREAM',
                  'heic: L1 reference-list modification index exceeds the current reference set',
                );
              refPicListL1Modification.push(entry);
            }
          } else {
            refPicListL1Modification = null;
          }
        }
      }
      if (sliceType === SLICE_TYPE_B) mvdL1ZeroFlag = r.readBit() === 1;
      if (pps.cabacInitPresent) cabacInitFlag = r.readBit() === 1;
      if (sliceTemporalMvpEnabled) {
        if (sliceType === SLICE_TYPE_B) collocatedFromL0 = r.readBit() === 1;
        const collocatedActiveMinus1 =
          sliceType === SLICE_TYPE_B && !collocatedFromL0
            ? numRefIdxL1ActiveMinus1
            : numRefIdxL0ActiveMinus1;
        if (collocatedActiveMinus1 > 0) {
          collocatedRefIdx = r.ue();
          if (collocatedRefIdx > collocatedActiveMinus1)
            throw new HeicError(
              'INVALID_BITSTREAM',
              `heic: collocated_ref_idx exceeds active L${sliceType === SLICE_TYPE_B && !collocatedFromL0 ? '1' : '0'}`,
            );
        } else {
          collocatedRefIdx = 0;
        }
      } else {
        collocatedFromL0 = true;
        collocatedRefIdx = 0;
      }

      if (
        (pps.weightedPred && sliceType === SLICE_TYPE_P) ||
        (pps.weightedBipred && sliceType === SLICE_TYPE_B)
      ) {
        weightedPrediction = readWeightedPredictionParameters(
          r,
          sps,
          numRefIdxL0ActiveMinus1,
          sliceType === SLICE_TYPE_B ? numRefIdxL1ActiveMinus1 : undefined,
        );
      }

      fiveMinusMaxNumMergeCand = r.ue();
      const mvResolutionControl = sps.screenContentExtension?.motionVectorResolutionControlIdc ?? 0;
      if (mvResolutionControl === 2) useIntegerMv = r.readBit() === 1;
    }

    sliceQpY = pps.initQp + r.se();
    if (pps.sliceChromaQpOffsetsPresent) {
      cbQpOffset += r.se();
      crQpOffset += r.se();
    }
    if (pps.screenContentExtension?.sliceActQpOffsetsPresent) {
      sliceActYQpOffset = r.se();
      sliceActCbQpOffset = r.se();
      sliceActCrQpOffset = r.se();
    }
    if (pps.chromaQpOffsetListEnabled) cuChromaQpOffsetEnabled = r.readBit() === 1;

    let deblockingOverride = false;
    if (pps.deblockingFilterOverrideEnabled) deblockingOverride = r.readBit() === 1;
    if (deblockingOverride) {
      deblockingDisabled = r.readBit() === 1;
      if (!deblockingDisabled) {
        betaOffsetDiv2 = r.se();
        tcOffsetDiv2 = r.se();
      }
    }

    if (pps.loopFilterAcrossSlicesEnabled && (saoLuma || saoChroma || !deblockingDisabled))
      loopFilterAcrossSlices = r.readBit() === 1;
  }

  const entryPointOffsets: number[] = [];
  if (pps.tilesEnabled || pps.entropyCodingSyncEnabled) {
    const numEntryPoints = r.ue();
    if (numEntryPoints > 0) {
      const offsetLen = r.ue() + 1;
      for (let i = 0; i < numEntryPoints; i++) entryPointOffsets.push(r.readBits(offsetLen) + 1);
    }
  }

  if (pps.sliceSegmentHeaderExtensionPresent) {
    const extLength = r.ue();
    for (let i = 0; i < extLength; i++) r.readBits(8);
  }

  // byte_alignment(): a '1' bit then zeros to the next byte boundary.
  if (r.readBit() !== 1)
    throw new HeicError('INVALID_BITSTREAM', 'heic: slice header byte alignment bit missing');
  while (r.bitPosition % 8 !== 0) r.readBit();

  // Slice data begins here; map back to raw NAL bytes and split substreams.
  const dataStartRbsp = r.bitPosition >> 3;
  const dataStartRaw = dataStartRbsp < rbsp.data.length ? rbsp.rawIndex[dataStartRbsp] : nal.length;
  const substreams: Uint8Array[] = [];
  let start = dataStartRaw;
  for (const offset of entryPointOffsets) {
    substreams.push(unescapeRange(nal, start, start + offset));
    start += offset;
  }
  substreams.push(unescapeRange(nal, start, nal.length));

  return {
    firstSliceInPic,
    dependentSliceSegment,
    segmentAddress,
    sliceType,
    sliceQpY,
    cbQpOffset,
    crQpOffset,
    pictureOrderCntLsb,
    shortTermRefPicSet,
    longTermRefPics,
    numRefIdxL0ActiveMinus1,
    refPicListL0Modification,
    numRefIdxL1ActiveMinus1,
    refPicListL1Modification,
    weightedPrediction,
    fiveMinusMaxNumMergeCand,
    cabacInitFlag,
    sliceTemporalMvpEnabled,
    collocatedFromL0,
    collocatedRefIdx,
    mvdL1ZeroFlag,
    useIntegerMv,
    cuChromaQpOffsetEnabled,
    sliceActYQpOffset,
    sliceActCbQpOffset,
    sliceActCrQpOffset,
    currentPictureReferenceEnabled,
    interLayerPredictionEnabled,
    interLayerReferenceCount,
    interLayerReferenceLayerIds,
    saoLuma,
    saoChroma,
    deblockingDisabled,
    betaOffsetDiv2,
    tcOffsetDiv2,
    loopFilterAcrossSlices,
    substreams,
  };
}
