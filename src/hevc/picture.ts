import { HeicError } from '../errors.js';
import { isHeifHevcBitDepth } from '../bit-depth.js';
/**
 * The HEVC still-image decoder: CTU wavefront loop, coding quadtree,
 * intra/inter CU/PU/TU parsing, residual coding, and reconstruction into YUV
 * planes (7.3.8, 8.4, 8.6, 9.3).
 *
 * Scope: I slices plus bounded external P prediction for HEIF `pred` items,
 * including multi-reference L0, weighted-P, and temporal-MVP subsets;
 * 4:2:0/4:2:2/4:4:4, 8–15-bit HEIF sample depths.
 * WPP (entropy_coding_sync), cu_qp_delta, and scaling lists are supported
 * because iPhone captures enable all three.
 */
import type { PpsInfo } from './pps.js';
import type { SliceHeader } from './slice-header.js';
import type { SpsInfo } from './sps.js';
import { CabacContexts, CabacDecoder, CTX } from './cabac.js';
import { filterRefs, gatherRefs, predictIntra } from './intra.js';
import { buildScalingFactors } from './scaling.js';
import { getScan, SCAN_DIAG, SCAN_TRAV } from './scan.js';
import {
  parseSliceHeader,
  SLICE_TYPE_B,
  SLICE_TYPE_I,
  SLICE_TYPE_P,
  type LayeredSliceContext,
} from './slice-header.js';
import { dequantize, inverseResidualDpcm, inverseTransform, rotateBlock180 } from './transform.js';
import { chromaSubsampling } from './chroma.js';
import { deriveTileLayout } from './tiles.js';
import {
  deriveIntegerMotionVectorComponent,
  interpolateChromaPredictionSample,
  interpolateChromaSample,
  interpolateLumaPredictionSample,
  quantizeMotionVectorToIntegerPel,
} from './motion.js';

const CTX_IDX_MAP_4X4 = [0, 1, 4, 5, 2, 3, 4, 5, 6, 6, 8, 8, 7, 7, 8, 8];
type L0MotionCandidate = {
  x: number;
  y: number;
  refIdxL0: number;
  referencePoc: number;
  referenceLayerId: number;
  isLongTermReference: boolean;
};
type L1MotionCandidate = {
  x: number;
  y: number;
  refIdxL1: number;
  referencePoc: number;
  referenceLayerId: number;
  isLongTermReference: boolean;
};
type MotionVectorCandidate = {
  x: number;
  y: number;
  referencePoc: number;
  referenceLayerId: number;
  isLongTermReference: boolean;
  referenceIndex?: number;
};
type InterMotionField = {
  predFlags: number;
  l0: L0MotionCandidate | null;
  l1: L1MotionCandidate | null;
};
type BiMergeCandidate = InterMotionField;
type MotionPredictionSamples = {
  y: Int32Array;
  cb: Int32Array;
  cr: Int32Array;
};

function clip3(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}

function scaleSpatialMotionVectorComponent(mv: number, td: number, tb: number): number {
  if (td === 0)
    throw new HeicError('INVALID_BITSTREAM', 'heic: cannot scale an MVP from a zero POC distance');
  const tx = Math.trunc((16384 + (Math.abs(td) >> 1)) / td);
  const distScaleFactor = clip3(-4096, 4095, (tb * tx + 32) >> 6);
  const product = distScaleFactor * mv;
  const scaled = Math.sign(product) * ((Math.abs(product) + 127) >> 8);
  return clip3(-32768, 32767, scaled);
}

/** Table 8-3: chroma prediction mode mapping for ChromaArrayType 2. */
const CHROMA_422_MODE_MAP = [
  0, 1, 2, 2, 2, 2, 3, 5, 7, 8, 10, 12, 13, 15, 17, 18, 19, 20, 21, 22, 23, 23, 24, 24, 25, 25, 26,
  27, 27, 28, 28, 29, 29, 30, 31,
];

/** Table 8-10: chroma QP mapping for 4:2:0. */
const CHROMA_QP_TABLE = [29, 30, 31, 32, 33, 33, 34, 34, 35, 35, 36, 36, 37, 37];
const PALETTE_LEVEL_SCALE = [40, 45, 51, 57, 64, 72];

function mapChromaQp(qpY: number, offset: number, bitDepth = 8, chromaFormatIdc = 1): number {
  const qPi = Math.min(57, Math.max(-6 * (bitDepth - 8), qpY + offset));
  // H.265 8.6.2 applies Table 8-10 to ChromaArrayType 1 (4:2:0) only;
  // ChromaArrayType 2 and 3 use Min(qPi, 51) directly.
  if (chromaFormatIdc !== 1) return Math.min(qPi, 51);
  if (qPi < 30) return qPi;
  if (qPi > 43) return qPi - 6;
  return CHROMA_QP_TABLE[qPi - 30];
}

function clipSample(value: number, bitDepth: number): number {
  return Math.max(0, Math.min((1 << bitDepth) - 1, value));
}

/** H.265 8.5.3.3.4.2 single-list default weighted prediction. */
function defaultWeightedSample(prediction: number, bitDepth: number): number {
  const shift = Math.max(2, 14 - bitDepth);
  return clipSample((prediction + (1 << (shift - 1))) >> shift, bitDepth);
}

/** H.265 8.5.3.3.4.3 single-list explicit weighted prediction. */
function explicitWeightedSample(
  prediction: number,
  weight: number,
  offset: number,
  log2WeightDenom: number,
  bitDepth: number,
  highPrecisionOffsetsEnabled: boolean,
): number {
  const shift = Math.max(2, 14 - bitDepth);
  const log2WeightedDenom = log2WeightDenom + shift;
  const offsetShift = highPrecisionOffsetsEnabled ? 0 : bitDepth - 8;
  const weighted =
    ((prediction * weight + (1 << (log2WeightedDenom - 1))) >> log2WeightedDenom) +
    (offset << offsetShift);
  return clipSample(weighted, bitDepth);
}

/** H.265 8.5.3.3.4.2 default two-list sample prediction. */
function defaultBiWeightedSample(
  predictionL0: number,
  predictionL1: number,
  bitDepth: number,
): number {
  const shift = Math.max(3, 15 - bitDepth);
  return clipSample((predictionL0 + predictionL1 + (1 << (shift - 1))) >> shift, bitDepth);
}

/** H.265 8.5.3.3.4.3 explicit two-list weighted sample prediction. */
function explicitBiWeightedSample(
  predictionL0: number,
  predictionL1: number,
  weightL0: number,
  offsetL0: number,
  weightL1: number,
  offsetL1: number,
  log2WeightDenom: number,
  bitDepth: number,
  highPrecisionOffsetsEnabled: boolean,
): number {
  const shift = Math.max(2, 14 - bitDepth);
  const log2WeightedDenom = log2WeightDenom + shift;
  const offsetShift = highPrecisionOffsetsEnabled ? 0 : bitDepth - 8;
  const o0 = offsetL0 << offsetShift;
  const o1 = offsetL1 << offsetShift;
  return clipSample(
    (predictionL0 * weightL0 + predictionL1 * weightL1 + ((o0 + o1 + 1) << log2WeightedDenom)) >>
      (log2WeightedDenom + 1),
    bitDepth,
  );
}

/** H.265 8.6.4: inverse transform of ACT residuals for a 4:4:4 TU. */
function inverseActResidualTransform(
  residuals: [Int32Array, Int32Array, Int32Array],
  bitDepthLuma: number,
  bitDepthChroma: number,
  extendedPrecision: boolean,
  lossless: boolean,
): [Int32Array, Int32Array, Int32Array] {
  const [inputY, inputCb, inputCr] = residuals;
  if (inputY.length !== inputCb.length || inputY.length !== inputCr.length)
    throw new HeicError('INVALID_BITSTREAM', 'heic: ACT requires equal 4:4:4 transform blocks');

  const maxBitDepth = Math.max(bitDepthLuma, bitDepthChroma);
  const shiftLuma = maxBitDepth - bitDepthLuma;
  const shiftChroma = maxBitDepth - bitDepthChroma;
  const roundLuma = shiftLuma === 0 ? 0 : 1 << (shiftLuma - 1);
  const roundChroma = shiftChroma === 0 ? 0 : 1 << (shiftChroma - 1);
  const rangeLuma = 2 ** (extendedPrecision ? Math.max(15, bitDepthLuma + 6) : 15);
  const rangeChroma = 2 ** (extendedPrecision ? Math.max(15, bitDepthChroma + 6) : 15);
  const outputY = new Int32Array(inputY.length);
  const outputCb = new Int32Array(inputY.length);
  const outputCr = new Int32Array(inputY.length);

  for (let i = 0; i < inputY.length; i++) {
    let y = Math.max(-rangeLuma, Math.min(rangeLuma - 1, inputY[i]));
    let cg = Math.max(-rangeChroma, Math.min(rangeChroma - 1, inputCb[i]));
    let co = Math.max(-rangeChroma, Math.min(rangeChroma - 1, inputCr[i]));

    if (lossless) {
      co -= cg;
      const t = cg + (co >> 1);
      cg = y - t;
      y = t + (cg >> 1);
    } else {
      y *= 2 ** shiftLuma;
      cg *= 2 ** (shiftChroma + 1);
      co *= 2 ** (shiftChroma + 1);
      const t = y - (cg >> 1);
      y = cg + t;
      cg = t - (co >> 1);
      co += cg;
      y = (y + roundLuma) >> shiftLuma;
      cg = (cg + roundChroma) >> shiftChroma;
      co = (co + roundChroma) >> shiftChroma;
    }

    outputY[i] = y;
    outputCb[i] = cg;
    outputCr[i] = co;
  }
  return [outputY, outputCb, outputCr];
}

export interface SaoParams {
  /** 0 none, 1 band, 2 edge; per component (cb/cr share type + eo class). */
  typeIdx: Int32Array;
  /** Signed offsets, 4 per component. */
  offsets: Int32Array;
  bandPos: Int32Array;
  eoClass: Int32Array;
}

export interface ReferenceImage {
  y: Uint8Array | Uint16Array;
  cb: Uint8Array | Uint16Array;
  cr: Uint8Array | Uint16Array;
  width: number;
  height: number;
  chromaFormatIdc: number;
  /** Component sample depths; HEVC permits luma and chroma to differ. */
  bitDepthLuma?: number;
  bitDepthChroma?: number;
  /** POC LSB parsed from this coded picture's first independent slice. */
  pictureOrderCntLsb: number;
  /** Full POC for this picture. */
  pictureOrderCnt: number;
  /** `nuh_layer_id` for this decoded picture; defaults to the base layer. */
  layerId?: number;
  /** True for the current decoded picture inserted into either reference list for SCC. */
  isCurrentPicture?: boolean;
  /** Whether this L0 entry is long-term in the current decoding context. */
  isLongTermReference: boolean;
  /** True if its coded picture has external inter motion that TMVP may need. */
  hasExternalInterMotion: boolean;
  /** False for an inter-layer reference that may supply motion but not samples. */
  samplePredictionEnabled?: boolean;
  interMap?: Uint8Array;
  /** Per-4x4 flag: motion comes from an external reference, not SCC IBC. */
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
}

export interface DecodedPicture {
  y: Uint8Array | Uint16Array;
  cb: Uint8Array | Uint16Array;
  cr: Uint8Array | Uint16Array;
  hasExternalInterMotion: boolean;
  /** Coded (pre-crop) luma dimensions; chroma dimensions follow chromaFormatIdc. */
  width: number;
  height: number;
  /** Per-CTU SAO parameters (raster order), for the SAO stage. */
  sao: SaoParams[];
  /** Per-8x8 luma QP map, for the deblocking stage. */
  qpMap: Int16Array;
  /** Per-4x4 luma block: bit0 = left edge is a TU edge, bit1 = top edge. */
  tuEdgesY: Uint8Array;
  /** Per-4x4 chroma block edge flags (chroma TBs). */
  tuEdgesC: Uint8Array;
  sh: SliceHeader;
  /** Independent slice headers in CTB raster order. */
  sliceHeaders: SliceHeader[];
  /** Slice index for each CTB in raster order. */
  sliceIdByCtb: Uint32Array;
  /** Tile index for each CTB in raster order. */
  tileIdByCtb: Uint32Array;
  loopFilterAcrossTilesEnabled: boolean;
  log2CtbSize: number;
  widthInCtbs: number;
  heightInCtbs: number;
  bypassMap: Uint8Array;
  /** Per-4x4 luma block: palette-coded samples are preserved by deblocking. */
  paletteMap: Uint8Array;
  /** Per-4x4 luma block: inter/IBC prediction and motion vectors for deblocking. */
  interMap: Uint8Array;
  motionIsExternal: Uint8Array;
  motionPredFlags: Uint8Array;
  motionXQpel: Int32Array;
  motionYQpel: Int32Array;
  motionRefIdxL0: Uint8Array;
  motionRefPoc: Float64Array;
  motionRefLongTerm: Uint8Array;
  motionRefLayerId: Uint8Array;
  motionXQpelL1: Int32Array;
  motionYQpelL1: Int32Array;
  motionRefIdxL1: Uint8Array;
  motionRefPocL1: Float64Array;
  motionRefLongTermL1: Uint8Array;
  motionRefLayerIdL1: Uint8Array;
  /** Per-4x4 luma block: contains nonzero transform coefficients. */
  cbfYMap: Uint8Array;
  /** Per-4x4 luma block: transform boundary (as distinct from PU boundary). */
  transformEdgesY: Uint8Array;
  chromaFormatIdc: number;
}

export class PictureDecoder {
  private readonly sps: SpsInfo;
  private readonly pps: PpsInfo;
  private referenceImages: readonly ReferenceImage[];
  private referenceImagesL1: readonly ReferenceImage[];
  private readonly layeredContext?: LayeredSliceContext;
  private readonly currentPictureOrderCnt: number;
  private hasExternalInterMotion = false;
  private readonly bd: number;
  private readonly bdC: number;

  private readonly w: number;
  private readonly h: number;
  private readonly cw: number;
  private readonly ch: number;
  private readonly log2Ctb: number;
  private readonly ctbSize: number;
  private readonly widthInCtbs: number;
  private readonly heightInCtbs: number;
  private readonly tileScanToRaster: Uint32Array;
  private readonly rasterToTileScan: Uint32Array;
  private readonly tileIdByCtb: Uint32Array;
  private readonly tileColumnBoundaries: number[];
  private readonly tileColumns: number;

  private readonly y: Uint8Array | Uint16Array;
  private readonly cb: Uint8Array | Uint16Array;
  private readonly cr: Uint8Array | Uint16Array;

  private readonly decodedY: Uint8Array;
  private readonly decodedC: Uint8Array;
  private readonly bwY: number;
  private readonly bhY: number;
  private readonly bwC: number;

  private readonly intraModeMap: Uint8Array;
  private readonly intraPredMap: Uint8Array;
  private readonly cuSkipMap: Uint8Array;
  private readonly interMap: Uint8Array;
  private readonly motionIsExternal: Uint8Array;
  private readonly motionXQpel: Int32Array;
  private readonly motionYQpel: Int32Array;
  private readonly motionRefIdxL0: Uint8Array;
  private readonly motionRefPoc: Float64Array;
  private readonly motionRefLongTerm: Uint8Array;
  private readonly motionRefLayerId: Uint8Array;
  private readonly motionPredFlags: Uint8Array;
  private readonly motionXQpelL1: Int32Array;
  private readonly motionYQpelL1: Int32Array;
  private readonly motionRefIdxL1: Uint8Array;
  private readonly motionRefPocL1: Float64Array;
  private readonly motionRefLongTermL1: Uint8Array;
  private readonly motionRefLayerIdL1: Uint8Array;
  private readonly cbfYMap: Uint8Array;
  private readonly transformEdgesY: Uint8Array;
  private readonly ctDepthMap: Int8Array;
  private readonly qpMap: Int16Array;
  private readonly tuEdgesY: Uint8Array;
  private readonly tuEdgesC: Uint8Array;

  private readonly scalingFactors: (Int32Array | null)[][];

  private readonly sao: SaoParams[];
  private readonly sliceIdByCtb: Uint32Array;
  private sliceHeaders: SliceHeader[] = [];

  // Entropy state
  private ctxs = new CabacContexts();
  private cabac!: CabacDecoder;
  private rowSnapshot: ReturnType<CabacContexts['save']> | null = null;
  private paletteRowSnapshot: number[][] | null = null;

  // Slice / CTU state
  private sh!: SliceHeader;
  private currentSliceId = 0;
  private sliceStartRs = 0;
  private ctbX = 0;
  private ctbY = 0;
  private lastQpY = 0;

  // Quant group state
  private qgPredPending = false;
  private isCuQpDeltaCoded = false;
  private cuQpDeltaVal = 0;
  private isCuChromaQpOffsetCoded = false;
  private cuChromaQpOffsetCb = 0;
  private cuChromaQpOffsetCr = 0;
  private qgX = 0;
  private qgY = 0;
  private qpYPred = 0;

  // Current CU state
  private readonly transformSkipped = new WeakSet<Int32Array>();
  private readonly explicitRdpcm = new WeakMap<Int32Array, 'horizontal' | 'vertical'>();
  private cuBypass = false;
  private readonly bypassMap: Uint8Array;
  private readonly paletteMap: Uint8Array;
  private cuQp = 0;
  private cuChromaMode = 0;
  private cuActFlagAssociated = false;
  private readonly chromaModeMap: Uint8Array;
  private readonly chromaDerivedMap: Uint8Array;
  private predictorPalette: number[][] = [];

  constructor(
    sps: SpsInfo,
    pps: PpsInfo,
    referenceImages: readonly ReferenceImage[] = [],
    currentPictureOrderCnt = 0,
    referenceImagesL1: readonly ReferenceImage[] = [],
    layeredContext?: LayeredSliceContext,
  ) {
    this.sps = sps;
    this.pps = pps;
    this.referenceImages = referenceImages;
    this.referenceImagesL1 = referenceImagesL1;
    this.layeredContext = layeredContext;
    this.currentPictureOrderCnt = currentPictureOrderCnt;
    if (
      ![0, 1, 2, 3].includes(sps.chromaFormatIdc) ||
      !isHeifHevcBitDepth(sps.bitDepthLuma) ||
      (sps.chromaFormatIdc !== 0 && !isHeifHevcBitDepth(sps.bitDepthChroma))
    )
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        'heic: unsupported chroma format or bit depth (supported: monochrome/4:2:0/4:2:2/4:4:4, 8–15-bit)',
      );
    if (
      pps.screenContentExtension?.residualAdaptiveColourTransformEnabled &&
      sps.chromaFormatIdc !== 3
    )
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        'heic: residual adaptive colour transform currently requires 4:4:4 chroma',
      );
    if (
      pps.chromaQpOffsetListEnabled &&
      (sps.chromaFormatIdc === 0 ||
        pps.diffCuChromaQpOffsetDepth > sps.log2CtbSize - sps.log2MinLumaCodingBlockSize ||
        pps.cbQpOffsetList.length === 0 ||
        pps.cbQpOffsetList.length !== pps.crQpOffsetList.length)
    )
      throw new HeicError('INVALID_BITSTREAM', 'heic: invalid chroma QP offset list parameters');
    if (
      pps.log2SaoOffsetScaleLuma > Math.max(0, sps.bitDepthLuma - 10) ||
      pps.log2SaoOffsetScaleChroma > Math.max(0, sps.bitDepthChroma - 10)
    )
      throw new HeicError('INVALID_BITSTREAM', 'heic: SAO offset scale exceeds bit depth');
    if (pps.log2MaxTransformSkipBlockSize > sps.log2MaxTransformBlockSize)
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: transform skip block size exceeds SPS maximum',
      );
    // Explicit RDPCM and high-precision weighted offsets are signalled at the
    // inter-prediction path. decode() rejects non-I slices before processing
    // their coding units, so those SPS capabilities are inert for this decoder.
    if (sps.separateColourPlane)
      throw new HeicError('UNSUPPORTED_FEATURE', 'heic: separate colour planes are unsupported');
    if (
      sps.pcmEnabled &&
      (sps.pcmSampleBitDepthLuma > sps.bitDepthLuma ||
        (sps.chromaFormatIdc !== 0 && sps.pcmSampleBitDepthChroma > sps.bitDepthChroma) ||
        sps.log2MinPcmLumaCodingBlockSize < Math.min(sps.log2MinLumaCodingBlockSize, 5) ||
        sps.log2MinPcmLumaCodingBlockSize > Math.min(sps.log2CtbSize, 5) ||
        sps.log2MaxPcmLumaCodingBlockSize < sps.log2MinPcmLumaCodingBlockSize ||
        sps.log2MaxPcmLumaCodingBlockSize > Math.min(sps.log2CtbSize, 5))
    )
      throw new HeicError('INVALID_BITSTREAM', 'heic: invalid PCM coding parameters in SPS');

    this.bd = sps.bitDepthLuma;
    this.bdC = sps.bitDepthChroma;
    this.w = sps.picWidthInLumaSamples;
    this.h = sps.picHeightInLumaSamples;
    if (sps.log2MinLumaCodingBlockSize < 3 || sps.log2MinLumaCodingBlockSize > 6)
      throw new HeicError('INVALID_BITSTREAM', 'heic: invalid minimum luma coding block size');
    const minLumaCodingBlockSize = 1 << sps.log2MinLumaCodingBlockSize;
    if (
      !Number.isSafeInteger(this.w) ||
      !Number.isSafeInteger(this.h) ||
      this.w <= 0 ||
      this.h <= 0 ||
      this.w % minLumaCodingBlockSize ||
      this.h % minLumaCodingBlockSize
    )
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: coded dimensions violate minimum coding block alignment',
      );
    if (!Number.isSafeInteger(this.w * this.h) || this.w * this.h > 50_000_000)
      throw new HeicError('RESOURCE_LIMIT', 'heic: coded picture exceeds the pixel limit');
    if (
      sps.log2CtbSize < 4 ||
      sps.log2CtbSize > 6 ||
      sps.log2MinTransformBlockSize < 2 ||
      sps.log2MaxTransformBlockSize > 5
    )
      throw new HeicError('UNSUPPORTED_FEATURE', 'heic: unsupported block sizes');
    const chromaSub = chromaSubsampling(sps.chromaFormatIdc);
    this.cw = sps.chromaFormatIdc ? Math.ceil(this.w / chromaSub.width) : 0;
    this.ch = sps.chromaFormatIdc ? Math.ceil(this.h / chromaSub.height) : 0;
    for (const reference of [...referenceImages, ...referenceImagesL1]) {
      const referenceChroma = chromaSubsampling(reference.chromaFormatIdc);
      if (
        reference.width !== this.w ||
        reference.height !== this.h ||
        reference.chromaFormatIdc !== sps.chromaFormatIdc ||
        (!reference.isCurrentPicture &&
          ((reference.bitDepthLuma !== undefined && reference.bitDepthLuma !== sps.bitDepthLuma) ||
            (reference.bitDepthChroma !== undefined &&
              reference.bitDepthChroma !== sps.bitDepthChroma))) ||
        (!reference.isCurrentPicture &&
          (reference.y.length !== this.w * this.h ||
            reference.cb.length !== (reference.chromaFormatIdc ? this.cw * this.ch : 0) ||
            reference.cr.length !== reference.cb.length)) ||
        referenceChroma.width !== chromaSub.width ||
        referenceChroma.height !== chromaSub.height
      )
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: predictive reference image geometry does not match',
        );
    }
    this.log2Ctb = sps.log2CtbSize;
    this.ctbSize = 1 << sps.log2CtbSize;
    this.widthInCtbs = Math.ceil(this.w / this.ctbSize);
    this.heightInCtbs = Math.ceil(this.h / this.ctbSize);
    const tileLayout = deriveTileLayout(this.widthInCtbs, this.heightInCtbs, pps);
    this.tileScanToRaster = tileLayout.tileScanToRaster;
    this.rasterToTileScan = tileLayout.rasterToTileScan;
    this.tileIdByCtb = tileLayout.tileIdByCtb;
    this.tileColumnBoundaries = tileLayout.columnBoundaries;
    this.tileColumns = tileLayout.columns;

    this.y = new (this.bd === 8 ? Uint8Array : Uint16Array)(this.w * this.h);
    this.cb = new (this.bdC === 8 ? Uint8Array : Uint16Array)(this.cw * this.ch);
    this.cr = new (this.bdC === 8 ? Uint8Array : Uint16Array)(this.cw * this.ch);

    this.bwY = this.w >> 2;
    this.bhY = this.h >> 2;
    this.bypassMap = new Uint8Array(this.bwY * this.bhY);
    this.paletteMap = new Uint8Array(this.bwY * this.bhY);
    this.chromaModeMap = new Uint8Array(this.bwY * this.bhY);
    this.chromaDerivedMap = new Uint8Array(this.bwY * this.bhY);
    this.bwC = Math.ceil(this.cw / 4);
    this.decodedY = new Uint8Array(this.bwY * this.bhY);
    this.decodedC = new Uint8Array(this.bwC * Math.ceil(this.ch / 4));

    this.intraModeMap = new Uint8Array(this.bwY * this.bhY).fill(1);
    this.intraPredMap = new Uint8Array(this.bwY * this.bhY);
    this.cuSkipMap = new Uint8Array(this.bwY * this.bhY);
    this.interMap = new Uint8Array(this.bwY * this.bhY);
    this.motionIsExternal = new Uint8Array(this.bwY * this.bhY);
    this.motionPredFlags = new Uint8Array(this.bwY * this.bhY);
    this.motionXQpel = new Int32Array(this.bwY * this.bhY);
    this.motionYQpel = new Int32Array(this.bwY * this.bhY);
    this.motionRefIdxL0 = new Uint8Array(this.bwY * this.bhY);
    this.motionRefPoc = new Float64Array(this.bwY * this.bhY);
    this.motionRefLongTerm = new Uint8Array(this.bwY * this.bhY);
    this.motionRefLayerId = new Uint8Array(this.bwY * this.bhY);
    this.motionXQpelL1 = new Int32Array(this.bwY * this.bhY);
    this.motionYQpelL1 = new Int32Array(this.bwY * this.bhY);
    this.motionRefIdxL1 = new Uint8Array(this.bwY * this.bhY);
    this.motionRefPocL1 = new Float64Array(this.bwY * this.bhY);
    this.motionRefLongTermL1 = new Uint8Array(this.bwY * this.bhY);
    this.motionRefLayerIdL1 = new Uint8Array(this.bwY * this.bhY);
    this.cbfYMap = new Uint8Array(this.bwY * this.bhY);
    this.transformEdgesY = new Uint8Array(this.bwY * this.bhY);
    this.ctDepthMap = new Int8Array(this.bwY * this.bhY).fill(-1);
    this.qpMap = new Int16Array((this.w >> 3) * (this.h >> 3));
    this.tuEdgesY = new Uint8Array(this.bwY * this.bhY);
    this.tuEdgesC = new Uint8Array(this.bwC * Math.ceil(this.ch / 4));

    const data = pps.scalingListData ?? sps.scalingListData;
    this.scalingFactors = [];
    for (let sizeId = 0; sizeId < 4; sizeId++) {
      this.scalingFactors[sizeId] = [];
      for (let matrixId = 0; matrixId < 6; matrixId++)
        this.scalingFactors[sizeId][matrixId] = data
          ? buildScalingFactors(data, sizeId, matrixId)
          : null;
    }

    this.sao = Array.from({ length: this.widthInCtbs * this.heightInCtbs }, () => ({
      typeIdx: new Int32Array(3),
      offsets: new Int32Array(12),
      bandPos: new Int32Array(3),
      eoClass: new Int32Array(3),
    }));
    this.sliceIdByCtb = new Uint32Array(this.widthInCtbs * this.heightInCtbs);
  }

  /** Decode all slice NALs of one coded picture. */
  decode(
    sliceNals: Uint8Array[],
    referenceListsForSlice?: (header: SliceHeader) => {
      l0: readonly ReferenceImage[];
      l1?: readonly ReferenceImage[];
    },
  ): DecodedPicture {
    if (sliceNals.length === 0)
      throw new HeicError('INVALID_BITSTREAM', 'heic: picture has no slice NAL units');
    const totalCtbs = this.widthInCtbs * this.heightInCtbs;
    this.sliceHeaders = [];
    const segments: {
      header: SliceHeader;
      independentHeader: SliceHeader;
      sliceId: number;
      startTs: number;
      referenceImages: readonly ReferenceImage[];
      referenceImagesL1: readonly ReferenceImage[];
    }[] = [];
    let independentHeader: SliceHeader | null = null;
    let independentSliceId = -1;
    let referenceImages = this.referenceImages;
    let referenceImagesL1 = this.referenceImagesL1;
    for (let i = 0; i < sliceNals.length; i++) {
      const header = parseSliceHeader(
        sliceNals[i],
        this.sps,
        this.pps,
        independentHeader ?? undefined,
        this.layeredContext,
      );
      if (!header.dependentSliceSegment) {
        independentHeader = header;
        independentSliceId = this.sliceHeaders.length;
        this.sliceHeaders.push(header);
        if (referenceListsForSlice) {
          const referenceLists = referenceListsForSlice(header);
          referenceImages = referenceLists.l0;
          referenceImagesL1 = referenceLists.l1 ?? [];
        }
      }
      if (!independentHeader)
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: dependent slice segment has no independent slice',
        );
      if (
        i === 0 &&
        (header.dependentSliceSegment || !header.firstSliceInPic || header.segmentAddress !== 0)
      )
        throw new HeicError('INVALID_BITSTREAM', 'heic: first picture slice must start at CTB 0');
      const activeL0 = header.numRefIdxL0ActiveMinus1 + 1;
      const activeL1 = header.numRefIdxL1ActiveMinus1 + 1;
      const supportedSlice =
        header.sliceType === SLICE_TYPE_I ||
        (header.sliceType === SLICE_TYPE_P && referenceImages.length >= activeL0) ||
        (header.sliceType === SLICE_TYPE_B &&
          referenceImages.length >= activeL0 &&
          referenceImagesL1.length >= activeL1);
      if (!supportedSlice)
        throw new HeicError('UNSUPPORTED_FEATURE', 'heic: non-intra slice in still image');
      if (i > 0 && header.firstSliceInPic)
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: picture contains multiple first-slice headers',
        );
      if (header.segmentAddress >= totalCtbs)
        throw new HeicError('INVALID_BITSTREAM', 'heic: slice starts beyond the picture CTB range');
      const startTs = this.rasterToTileScan[header.segmentAddress];
      if (i > 0 && startTs <= segments[i - 1].startTs)
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: slice NAL units are not in tile-scan order',
        );
      segments.push({
        header,
        independentHeader,
        sliceId: independentSliceId,
        startTs,
        referenceImages,
        referenceImagesL1,
      });
    }

    let dependentSnapshot: ReturnType<CabacContexts['save']> | null = null;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const endTsExclusive = segments[i + 1]?.startTs ?? totalCtbs;
      this.referenceImages = segment.referenceImages;
      this.referenceImagesL1 = segment.referenceImagesL1;
      dependentSnapshot = this.decodeSliceSegment(
        segment.header,
        segment.independentHeader,
        segment.startTs,
        endTsExclusive,
        segment.sliceId,
        dependentSnapshot,
      );
    }
    return {
      y: this.y,
      cb: this.cb,
      cr: this.cr,
      width: this.w,
      height: this.h,
      sao: this.sao,
      qpMap: this.qpMap,
      tuEdgesY: this.tuEdgesY,
      tuEdgesC: this.tuEdgesC,
      sh: this.sliceHeaders[0],
      sliceHeaders: this.sliceHeaders,
      sliceIdByCtb: this.sliceIdByCtb,
      tileIdByCtb: this.tileIdByCtb,
      loopFilterAcrossTilesEnabled: this.pps.loopFilterAcrossTilesEnabled,
      log2CtbSize: this.log2Ctb,
      widthInCtbs: this.widthInCtbs,
      heightInCtbs: this.heightInCtbs,
      bypassMap: this.bypassMap,
      paletteMap: this.paletteMap,
      interMap: this.interMap,
      motionIsExternal: this.motionIsExternal,
      motionPredFlags: this.motionPredFlags,
      motionXQpel: this.motionXQpel,
      motionYQpel: this.motionYQpel,
      motionRefIdxL0: this.motionRefIdxL0,
      motionRefPoc: this.motionRefPoc,
      motionRefLongTerm: this.motionRefLongTerm,
      motionRefLayerId: this.motionRefLayerId,
      motionXQpelL1: this.motionXQpelL1,
      motionYQpelL1: this.motionYQpelL1,
      motionRefIdxL1: this.motionRefIdxL1,
      motionRefPocL1: this.motionRefPocL1,
      motionRefLongTermL1: this.motionRefLongTermL1,
      motionRefLayerIdL1: this.motionRefLayerIdL1,
      hasExternalInterMotion: this.hasExternalInterMotion,
      cbfYMap: this.cbfYMap,
      transformEdgesY: this.transformEdgesY,
      chromaFormatIdc: this.sps.chromaFormatIdc,
    };
  }

  private cabacInitType(header: SliceHeader): 0 | 1 | 2 {
    if (header.sliceType === SLICE_TYPE_I) return 0;
    if (header.sliceType === SLICE_TYPE_P) return header.cabacInitFlag ? 2 : 1;
    return header.cabacInitFlag ? 1 : 2;
  }

  /** H.265 9.3.2.3: PPS initializers override SPS initializers. */
  private initializePalettePredictor(): void {
    const spsPalette = this.sps.screenContentExtension;
    const ppsPalette = this.pps.screenContentExtension;
    const componentCount = this.sps.chromaFormatIdc === 0 ? 1 : 3;
    if (ppsPalette?.palettePredictorInitializersPresent) {
      const initializers = ppsPalette.palettePredictorInitializers;
      if (!initializers)
        throw new HeicError('INVALID_BITSTREAM', 'heic: missing PPS palette initializers');
      // An explicitly empty PPS initializer is valid and overrides any SPS
      // initializer. In this syntax form the monochrome and bit-depth fields
      // are absent, so `components` is empty and the predictor starts empty.
      if (initializers.components.length === 0) {
        this.predictorPalette = Array.from({ length: componentCount }, () => []);
        return;
      }
      if (
        initializers.monochrome !== (componentCount === 1) ||
        initializers.bitDepthLuma !== this.sps.bitDepthLuma ||
        (componentCount === 3 && initializers.bitDepthChroma !== this.sps.bitDepthChroma) ||
        initializers.components.length !== componentCount
      )
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: PPS palette initializers do not match the SPS',
        );
      this.predictorPalette = initializers.components.map((entries) => entries.slice());
    } else if (spsPalette?.palettePredictorInitializersPresent) {
      if (spsPalette.palettePredictorInitializers.length !== componentCount)
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: SPS palette initializer component count mismatch',
        );
      const size = spsPalette.palettePredictorInitializers[0]?.length ?? 0;
      if (
        spsPalette.palettePredictorInitializers.some((entries) => entries.length !== size) ||
        size > spsPalette.paletteMaxSize + spsPalette.deltaPaletteMaxPredictorSize
      )
        throw new HeicError('INVALID_BITSTREAM', 'heic: invalid SPS palette initializer size');
      this.predictorPalette = spsPalette.palettePredictorInitializers.map((entries) =>
        entries.slice(),
      );
    } else {
      this.predictorPalette = Array.from({ length: componentCount }, () => []);
    }
  }

  private decodeSliceSegment(
    sh: SliceHeader,
    independentHeader: SliceHeader,
    startTs: number,
    endTsExclusive: number,
    sliceId: number,
    previousSnapshot: ReturnType<CabacContexts['save']> | null,
  ): ReturnType<CabacContexts['save']> | null {
    this.sh = independentHeader;
    this.currentSliceId = sliceId;
    this.sliceStartRs = independentHeader.segmentAddress;
    let substreamIdx = 0;
    const startsAtTile = this.isTileStart(startTs);
    if (sh.dependentSliceSegment) {
      if (!previousSnapshot)
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: dependent segment has no preceding CABAC state',
        );
      // H.265 9.3.2.1 gives WPP synchronization priority at a row start;
      // elsewhere a dependent segment resumes the preceding segment state.
      if (startsAtTile) {
        this.ctxs.init(independentHeader.sliceQpY, this.cabacInitType(independentHeader));
        this.initializePalettePredictor();
        this.lastQpY = independentHeader.sliceQpY;
        this.rowSnapshot = null;
        this.paletteRowSnapshot = null;
      } else if (
        this.pps.entropyCodingSyncEnabled &&
        this.isWppRowStart(this.rasterToTileScan[sh.segmentAddress])
      ) {
        if (this.rowSnapshot && this.tileWidthForCtb(sh.segmentAddress) > 1) {
          this.ctxs.restore(this.rowSnapshot);
          if (this.paletteRowSnapshot)
            this.predictorPalette = this.paletteRowSnapshot.map((entries) => entries.slice());
        } else this.ctxs.init(independentHeader.sliceQpY, this.cabacInitType(independentHeader));
        this.lastQpY = independentHeader.sliceQpY;
      } else {
        this.ctxs.restore(previousSnapshot);
      }
    } else {
      this.ctxs.init(sh.sliceQpY, this.cabacInitType(sh));
      this.initializePalettePredictor();
      this.lastQpY = sh.sliceQpY;
      this.rowSnapshot = null;
      this.paletteRowSnapshot = null;
      this.qgPredPending = false;
      this.isCuQpDeltaCoded = false;
      this.cuQpDeltaVal = 0;
      this.isCuChromaQpOffsetCoded = false;
      this.cuChromaQpOffsetCb = 0;
      this.cuChromaQpOffsetCr = 0;
    }
    this.startCabacSubstream(sh, substreamIdx++);

    for (let ctbAddrTs = startTs; ctbAddrTs < endTsExclusive; ctbAddrTs++) {
      const ctbAddr = this.tileScanToRaster[ctbAddrTs];
      this.ctbX = ctbAddr % this.widthInCtbs;
      this.ctbY = (ctbAddr / this.widthInCtbs) | 0;
      this.sliceIdByCtb[ctbAddr] = sliceId;

      const tileStart = this.isTileStart(ctbAddrTs);
      if (tileStart && ctbAddrTs !== startTs) {
        if (this.cabac.decodeTerminate() !== 1)
          throw new HeicError(
            'INVALID_BITSTREAM',
            'heic: end_of_subset_one_bit missing at tile boundary',
          );
        this.ctxs.init(independentHeader.sliceQpY, this.cabacInitType(independentHeader));
        this.initializePalettePredictor();
        this.lastQpY = independentHeader.sliceQpY;
        this.rowSnapshot = null;
        this.paletteRowSnapshot = null;
        this.startCabacSubstream(sh, substreamIdx++);
      } else if (
        ctbAddrTs !== startTs &&
        this.pps.entropyCodingSyncEnabled &&
        this.isWppRowStart(ctbAddrTs)
      ) {
        // New WPP row: fresh substream, contexts from the row above's
        // second CTU (or fresh init when that is unavailable).
        if (this.rowSnapshot && this.tileWidthForCtb(ctbAddr) > 1) {
          this.ctxs.restore(this.rowSnapshot);
          if (this.paletteRowSnapshot)
            this.predictorPalette = this.paletteRowSnapshot.map((entries) => entries.slice());
        } else this.ctxs.init(independentHeader.sliceQpY, this.cabacInitType(independentHeader));
        this.lastQpY = independentHeader.sliceQpY;
        this.startCabacSubstream(sh, substreamIdx++);
      }

      if (this.sps.sampleAdaptiveOffsetEnabled && (sh.saoLuma || sh.saoChroma)) this.parseSao();

      this.codingQuadtree(this.ctbX << this.log2Ctb, this.ctbY << this.log2Ctb, this.log2Ctb, 0);

      if (
        this.pps.entropyCodingSyncEnabled &&
        this.ctbX === this.tileColumnStartForCtb(ctbAddr) + 1
      ) {
        this.rowSnapshot = this.ctxs.save();
        this.paletteRowSnapshot = this.predictorPalette.map((entries) => entries.slice());
      }

      const end = this.cabac.decodeTerminate();
      if (ctbAddrTs === endTsExclusive - 1) {
        if (end !== 1)
          throw new HeicError(
            'INVALID_BITSTREAM',
            `heic: CABAC desync — end_of_slice_segment_flag not set at slice boundary CTU (${this.ctbX},${this.ctbY})`,
          );
      } else if (end === 1) {
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: slice ended before its next slice boundary',
        );
      } else if (
        this.pps.entropyCodingSyncEnabled &&
        ctbAddrTs + 1 < endTsExclusive &&
        this.isWppRowStart(ctbAddrTs + 1)
      ) {
        if (this.cabac.decodeTerminate() !== 1)
          throw new HeicError(
            'INVALID_BITSTREAM',
            `heic: CABAC desync — end_of_subset_one_bit missing at CTU (${this.ctbX},${this.ctbY}), ts=${ctbAddrTs}, substream=${substreamIdx - 1}`,
          );
      }
    }
    if (substreamIdx !== sh.substreams.length)
      throw new HeicError('INVALID_BITSTREAM', 'heic: unused HEVC CABAC entry-point substream');
    return this.pps.dependentSliceSegmentsEnabled ? this.ctxs.save() : null;
  }

  private startCabacSubstream(sh: SliceHeader, index: number): void {
    const stream = sh.substreams[index];
    if (!stream)
      throw new HeicError('INVALID_BITSTREAM', 'heic: missing HEVC CABAC entry-point substream');
    this.cabac = new CabacDecoder(stream, this.ctxs);
  }

  private isTileStart(ctbAddrTs: number): boolean {
    if (ctbAddrTs === 0) return true;
    const current = this.tileScanToRaster[ctbAddrTs];
    const previous = this.tileScanToRaster[ctbAddrTs - 1];
    return this.tileIdByCtb[current] !== this.tileIdByCtb[previous];
  }

  /** Whether a CTB starts a new WPP row within the same tile. */
  private isWppRowStart(ctbAddrTs: number): boolean {
    if (ctbAddrTs <= 0) return false;
    const current = this.tileScanToRaster[ctbAddrTs];
    const previous = this.tileScanToRaster[ctbAddrTs - 1];
    return (
      this.tileIdByCtb[current] === this.tileIdByCtb[previous] &&
      Math.floor(current / this.widthInCtbs) !== Math.floor(previous / this.widthInCtbs)
    );
  }

  private tileColumnStartForCtb(ctbAddr: number): number {
    const tileColumn = this.tileIdByCtb[ctbAddr] % this.tileColumns;
    return this.tileColumnBoundaries[tileColumn];
  }

  private tileWidthForCtb(ctbAddr: number): number {
    const tileColumn = this.tileIdByCtb[ctbAddr] % this.tileColumns;
    return this.tileColumnBoundaries[tileColumn + 1] - this.tileColumnBoundaries[tileColumn];
  }

  // ---------------------------------------------------------------- SAO

  private parseSao(): void {
    const idx = this.ctbY * this.widthInCtbs + this.ctbX;
    const params = this.sao[idx];
    const { sh } = this;

    let merged = false;
    const ctbAddr = this.ctbY * this.widthInCtbs + this.ctbX;
    const leftAddr = ctbAddr - 1;
    if (
      this.ctbX > 0 &&
      ctbAddr > this.sliceStartRs &&
      this.isSaoMergeNeighborAvailable(leftAddr)
    ) {
      const left = this.cabac.decodeBin(CTX.SAO_MERGE);
      if (left === 1) {
        this.copySao(this.sao[idx - 1], params);
        merged = true;
      }
    }
    const upAddr = ctbAddr - this.widthInCtbs;
    if (
      !merged &&
      this.ctbY > 0 &&
      upAddr >= this.sliceStartRs &&
      this.isSaoMergeNeighborAvailable(upAddr)
    ) {
      const up = this.cabac.decodeBin(CTX.SAO_MERGE);
      if (up === 1) {
        this.copySao(this.sao[idx - this.widthInCtbs], params);
        merged = true;
      }
    }
    if (merged) return;

    for (let cIdx = 0; cIdx < 3; cIdx++) {
      if ((cIdx === 0 && !sh.saoLuma) || (cIdx > 0 && !sh.saoChroma)) continue;
      if (cIdx === 2) {
        // Cr shares type and EO class with Cb; offsets are its own.
        params.typeIdx[2] = params.typeIdx[1];
        params.eoClass[2] = params.eoClass[1];
      } else {
        let type = 0;
        if (this.cabac.decodeBin(CTX.SAO_TYPE_IDX) === 1)
          type = this.cabac.decodeBypass() === 1 ? 2 : 1;
        params.typeIdx[cIdx] = type;
      }
      const type = params.typeIdx[cIdx];
      if (type === 0) continue;

      const bitDepth = cIdx === 0 ? this.bd : this.bdC;
      const offsets = [0, 0, 0, 0];
      for (let i = 0; i < 4; i++) {
        // TR cMax 7, bypass
        let v = 0;
        while (v < (1 << (Math.min(bitDepth, 10) - 5)) - 1 && this.cabac.decodeBypass() === 1) v++;
        offsets[i] = v;
      }
      if (type === 1) {
        for (let i = 0; i < 4; i++) {
          if (offsets[i] !== 0 && this.cabac.decodeBypass() === 1) offsets[i] = -offsets[i];
        }
        params.bandPos[cIdx] = this.cabac.decodeBypassBits(5);
      } else {
        // Edge offsets: first two positive, last two negative.
        offsets[2] = -offsets[2];
        offsets[3] = -offsets[3];
        if (cIdx < 2) params.eoClass[cIdx] = this.cabac.decodeBypassBits(2);
      }
      const offsetScale =
        cIdx === 0 ? this.pps.log2SaoOffsetScaleLuma : this.pps.log2SaoOffsetScaleChroma;
      for (let i = 0; i < 4; i++) params.offsets[cIdx * 4 + i] = offsets[i] << offsetScale;
    }
  }

  private isSaoMergeNeighborAvailable(neighborAddr: number): boolean {
    if (neighborAddr < 0) return false;
    const currentAddr = this.ctbY * this.widthInCtbs + this.ctbX;
    const currentTileId = this.tileIdByCtb[currentAddr];
    return (
      this.sliceIdByCtb[neighborAddr] === this.currentSliceId &&
      this.tileIdByCtb[neighborAddr] === currentTileId
    );
  }

  private copySao(from: SaoParams, to: SaoParams): void {
    to.typeIdx.set(from.typeIdx);
    to.offsets.set(from.offsets);
    to.bandPos.set(from.bandPos);
    to.eoClass.set(from.eoClass);
  }

  // ------------------------------------------------------ coding quadtree

  private codingQuadtree(x0: number, y0: number, log2CbSize: number, ctDepth: number): void {
    const size = 1 << log2CbSize;
    const inside = x0 + size <= this.w && y0 + size <= this.h;

    let split: boolean;
    if (inside && log2CbSize > this.sps.log2MinLumaCodingBlockSize) {
      const condL = x0 > 0 && this.ctDepthAt(x0 - 1, y0) > ctDepth ? 1 : 0;
      const condA = y0 > 0 && this.ctDepthAt(x0, y0 - 1) > ctDepth ? 1 : 0;
      split = this.cabac.decodeBin(CTX.SPLIT_CU + condL + condA) === 1;
    } else {
      split = log2CbSize > this.sps.log2MinLumaCodingBlockSize;
    }

    if (this.pps.cuQpDeltaEnabled && log2CbSize >= this.log2Ctb - this.pps.diffCuQpDeltaDepth) {
      this.isCuQpDeltaCoded = false;
      this.cuQpDeltaVal = 0;
      this.qgX = x0;
      this.qgY = y0;
      this.qgPredPending = true;
    }
    if (
      this.pps.chromaQpOffsetListEnabled &&
      log2CbSize >= this.log2Ctb - this.pps.diffCuChromaQpOffsetDepth
    ) {
      this.isCuChromaQpOffsetCoded = false;
      this.cuChromaQpOffsetCb = 0;
      this.cuChromaQpOffsetCr = 0;
    }

    if (split) {
      const half = size >> 1;
      // Children are recursed only when they start inside the picture.
      this.recurseChild(x0, y0, log2CbSize - 1, ctDepth + 1);
      this.recurseChild(x0 + half, y0, log2CbSize - 1, ctDepth + 1);
      this.recurseChild(x0, y0 + half, log2CbSize - 1, ctDepth + 1);
      this.recurseChild(x0 + half, y0 + half, log2CbSize - 1, ctDepth + 1);
    } else {
      this.codingUnit(x0, y0, log2CbSize, ctDepth);
    }
  }

  private recurseChild(x: number, y: number, log2: number, depth: number): void {
    if (x < this.w && y < this.h) this.codingQuadtree(x, y, log2, depth);
  }

  private ctDepthAt(x: number, y: number): number {
    if (!this.isAvailableInCurrentSlice(x, y)) return -1;
    return this.ctDepthMap[(y >> 2) * this.bwY + (x >> 2)];
  }

  private isAvailableInCurrentSlice(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    const ctbAddr = (y >> this.log2Ctb) * this.widthInCtbs + (x >> this.log2Ctb);
    const currentAddr = this.ctbY * this.widthInCtbs + this.ctbX;
    return (
      this.sliceIdByCtb[ctbAddr] === this.currentSliceId &&
      this.tileIdByCtb[ctbAddr] === this.tileIdByCtb[currentAddr]
    );
  }

  // ------------------------------------------------------------ coding unit

  private codingUnit(x0: number, y0: number, log2CbSize: number, ctDepth: number): void {
    const size = 1 << log2CbSize;
    this.cuActFlagAssociated = false;
    this.cuBypass = this.pps.transquantBypassEnabled && this.cabac.decodeBin(CTX.TQ_BYPASS) === 1;

    const isInterSlice = this.sh.sliceType === SLICE_TYPE_P || this.sh.sliceType === SLICE_TYPE_B;
    if (isInterSlice) {
      const leftSkip =
        x0 > 0 &&
        this.isAvailableInCurrentSlice(x0 - 1, y0) &&
        this.cuSkipMap[(y0 >> 2) * this.bwY + ((x0 - 1) >> 2)] === 1;
      const aboveSkip =
        y0 > 0 &&
        this.isAvailableInCurrentSlice(x0, y0 - 1) &&
        this.cuSkipMap[((y0 - 1) >> 2) * this.bwY + (x0 >> 2)] === 1;
      const skipped =
        this.cabac.decodeBin(CTX.CU_SKIP + Number(leftSkip) + Number(aboveSkip)) === 1;
      this.setCuSkipMap(x0, y0, size, skipped);
      if (skipped) {
        this.interCodingUnit(x0, y0, log2CbSize, ctDepth, true);
        return;
      }
    }

    const predModeIntra = !isInterSlice || this.cabac.decodeBin(CTX.PRED_MODE) === 1;
    if (!predModeIntra) {
      this.interCodingUnit(x0, y0, log2CbSize, ctDepth, false);
      return;
    }

    const paletteEnabled =
      this.sps.screenContentExtension?.paletteModeEnabled === true &&
      log2CbSize <= this.sps.log2MaxTransformBlockSize;
    if (paletteEnabled && this.cabac.decodeBin(CTX.PALETTE_MODE) === 1) {
      this.paletteCodingUnit(x0, y0, log2CbSize, ctDepth);
      return;
    }

    // part_mode: only signalled at the minimum CB size for intra.
    let partNxN = false;
    if (log2CbSize === this.sps.log2MinLumaCodingBlockSize) {
      partNxN = this.cabac.decodeBin(CTX.PART_MODE) === 0;
    }

    // 7.3.8.5 places pcm_flag after part_mode and before prediction syntax.
    // PCM is only signalled for PART_2Nx2N CUs in the SPS size range.
    if (
      this.sps.pcmEnabled &&
      !partNxN &&
      log2CbSize >= this.sps.log2MinPcmLumaCodingBlockSize &&
      log2CbSize <= this.sps.log2MaxPcmLumaCodingBlockSize &&
      this.cabac.decodeTerminate() === 1
    ) {
      this.pcmCodingUnit(x0, y0, log2CbSize, ctDepth);
      return;
    }

    this.deriveCuQp();

    // Luma intra modes (7.4.9.5, 8.4.2).
    const nPu = partNxN ? 2 : 1;
    const pbSize = size >> (partNxN ? 1 : 0);
    const prevFlags: boolean[] = [];
    const mpmIdx: number[] = [];
    const remMode: number[] = [];
    for (let i = 0; i < nPu * nPu; i++) {
      const f = this.cabac.decodeBin(CTX.PREV_INTRA_LUMA_PRED);
      prevFlags.push(f === 1);
    }
    for (let i = 0; i < nPu * nPu; i++) {
      if (prevFlags[i]) {
        // mpm_idx: TR cMax 2, bypass bins.
        let v = 0;
        if (this.cabac.decodeBypass() === 1) {
          v = 1;
          if (this.cabac.decodeBypass() === 1) v = 2;
        }
        mpmIdx.push(v);
        remMode.push(0);
      } else {
        mpmIdx.push(-1);
        const rem = this.cabac.decodeBypassBits(5);
        remMode.push(rem);
      }
    }

    const puModes: number[] = [];
    for (let i = 0; i < nPu * nPu; i++) {
      const xPb = x0 + (i % nPu) * pbSize;
      const yPb = y0 + ((i / nPu) | 0) * pbSize;
      const cand = this.mpmCandidates(xPb, yPb);
      let mode: number;
      if (prevFlags[i]) {
        mode = cand[mpmIdx[i]];
      } else {
        cand.sort((a, b) => a - b);
        mode = remMode[i];
        for (const c of cand) {
          if (mode >= c) mode++;
        }
      }
      puModes.push(mode);
      this.setIntraModes(xPb, yPb, pbSize, mode);
    }

    // H.265 7.3.8.5: 4:4:4 signals one chroma mode per prediction unit.
    if (this.sps.chromaFormatIdc !== 0)
      for (let i = 0; i < (this.sps.chromaFormatIdc === 3 ? puModes.length : 1); i++) {
        const luma = puModes[i];
        let mode = luma;
        const chromaModeSignalled = this.cabac.decodeBin(CTX.INTRA_CHROMA_PRED_MODE);
        const chromaModeDerived = chromaModeSignalled === 0;
        if (!chromaModeDerived) {
          const selected = [0, 26, 10, 1][this.cabac.decodeBypassBits(2)];
          mode = selected === luma ? 34 : selected;
        }
        this.cuChromaMode = mode;
        const px = x0 + (i % nPu) * pbSize,
          py = y0 + Math.floor(i / nPu) * pbSize;
        if (this.sps.chromaFormatIdc === 3)
          for (let by = py >> 2; by < (py + pbSize) >> 2; by++)
            this.chromaModeMap.fill(
              mode,
              by * this.bwY + (px >> 2),
              by * this.bwY + ((px + pbSize) >> 2),
            );
        if (this.sps.chromaFormatIdc === 3)
          for (let by = py >> 2; by < (py + pbSize) >> 2; by++)
            this.chromaDerivedMap.fill(
              chromaModeDerived ? 1 : 0,
              by * this.bwY + (px >> 2),
              by * this.bwY + ((px + pbSize) >> 2),
            );
      }
    if (
      this.pps.screenContentExtension?.residualAdaptiveColourTransformEnabled &&
      this.sps.chromaFormatIdc === 3
    ) {
      const isDerivedAt = (px: number, py: number): boolean =>
        this.chromaDerivedMap[(py >> 2) * this.bwY + (px >> 2)] === 1;
      this.cuActFlagAssociated = partNxN
        ? isDerivedAt(x0, y0) &&
          isDerivedAt(x0 + (size >> 1), y0) &&
          isDerivedAt(x0, y0 + (size >> 1)) &&
          isDerivedAt(x0 + (size >> 1), y0 + (size >> 1))
        : isDerivedAt(x0, y0);
    }

    // Transform tree. MaxTrafoDepth = max_transform_hierarchy_depth_intra
    // + IntraSplitFlag; an NxN CU forces the first split.
    const maxTrafoDepth = this.sps.maxTransformHierarchyDepthIntra + (partNxN ? 1 : 0);
    const minLog2SizeInCu = this.intraMinTransformSizeInCu(log2CbSize, partNxN);
    this.transformTree(
      x0,
      y0,
      x0,
      y0,
      log2CbSize,
      0,
      0,
      partNxN,
      maxTrafoDepth,
      puModes,
      1,
      1,
      false,
      0,
      minLog2SizeInCu,
    );

    // Bookkeeping for neighbors and the loop filters.
    this.setCtDepth(x0, y0, size, ctDepth);
    const qw = this.w >> 3;
    for (let by = y0 >> 3; by < (y0 + size) >> 3; by++) {
      for (let bx = x0 >> 3; bx < (x0 + size) >> 3; bx++) this.qpMap[by * qw + bx] = this.cuQp;
    }
    this.lastQpY = this.cuQp;
  }

  /** H.265 SCC current-picture reference (IBC) coding unit. */
  private interCodingUnit(
    x0: number,
    y0: number,
    log2CbSize: number,
    ctDepth: number,
    skipped: boolean,
  ): void {
    if (this.sh.sliceType === SLICE_TYPE_B) {
      this.interCodingUnitB(x0, y0, log2CbSize, ctDepth, skipped);
      return;
    }
    const currentPictureReferenceEnabled = this.sh.currentPictureReferenceEnabled;
    if (
      currentPictureReferenceEnabled &&
      (!this.sps.screenContentExtension?.currPicRefEnabled ||
        !this.pps.screenContentExtension?.currPicRefEnabled)
    )
      throw new HeicError('UNSUPPORTED_FEATURE', 'heic: IBC is not enabled for this slice');
    // The current picture is an optional L0 entry selected per PU. Palette
    // mode is independent; palette_mode_enabled_flag only gates palette CUs.
    const activeReferenceCount = this.sh.numRefIdxL0ActiveMinus1 + 1;
    if (this.referenceImages.length < activeReferenceCount)
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        'heic: the active L0 reference list is incomplete',
      );

    const size = 1 << log2CbSize;
    this.cuActFlagAssociated =
      this.pps.screenContentExtension?.residualAdaptiveColourTransformEnabled === true &&
      this.sps.chromaFormatIdc === 3;
    const partMode = skipped ? 0 : this.decodeInterPartMode(log2CbSize);
    const predictionUnits = this.interPredictionUnits(x0, y0, size, partMode);
    const maxMergeCandidates = Math.max(1, 5 - this.sh.fiveMinusMaxNumMergeCand);
    let rootMergeFlag = false;

    for (let puIdx = 0; puIdx < predictionUnits.length; puIdx++) {
      const pu = predictionUnits[puIdx];
      let merge = skipped;
      if (!skipped) merge = this.cabac.decodeBin(CTX.MERGE_FLAG) === 1;
      if (puIdx === 0) rootMergeFlag = merge;

      let mvXQpel: number;
      let mvYQpel: number;
      let refIdxL0 = 0;
      if (merge) {
        const mergeIndex = this.decodeMergeIndex(maxMergeCandidates);
        const sharedSmallCuMergeList =
          partMode !== 0 && size <= 8 && this.pps.log2ParallelMergeLevel > 2;
        const candidatePu = sharedSmallCuMergeList
          ? { x: x0, y: y0, width: size, height: size }
          : pu;
        const candidates = this.externalMergeCandidates(
          candidatePu,
          maxMergeCandidates,
          sharedSmallCuMergeList ? 0 : partMode,
          sharedSmallCuMergeList ? 0 : puIdx,
          pu,
        );
        if (mergeIndex >= candidates.length)
          throw new HeicError(
            'INVALID_BITSTREAM',
            'heic: merge candidate index exceeds the candidate list',
          );
        const reference = this.referenceImages[candidates[mergeIndex].refIdxL0];
        if (!reference)
          throw new HeicError(
            'INVALID_BITSTREAM',
            'heic: merge candidate has an unavailable L0 reference',
          );
        mvXQpel =
          reference.isCurrentPicture || this.sh.useIntegerMv
            ? quantizeMotionVectorToIntegerPel(candidates[mergeIndex].x)
            : candidates[mergeIndex].x;
        mvYQpel =
          reference.isCurrentPicture || this.sh.useIntegerMv
            ? quantizeMotionVectorToIntegerPel(candidates[mergeIndex].y)
            : candidates[mergeIndex].y;
        refIdxL0 = candidates[mergeIndex].refIdxL0;
      } else {
        if (this.sh.numRefIdxL0ActiveMinus1 > 0)
          refIdxL0 = this.decodeRefIdxL0(this.sh.numRefIdxL0ActiveMinus1 + 1);
        const [mvdX, mvdY] = this.decodeMvd();
        const mvpIndex = this.cabac.decodeBin(CTX.MVP_INDEX);
        const candidates = this.spatialMvpCandidates(pu, refIdxL0);
        if (mvpIndex >= candidates.length)
          throw new HeicError(
            'INVALID_BITSTREAM',
            'heic: MVP candidate index exceeds the candidate list',
          );
        const mvp = candidates[mvpIndex];
        const reference = this.referenceImages[refIdxL0];
        if (!reference)
          throw new HeicError('INVALID_BITSTREAM', 'heic: MVP references an unavailable L0 entry');
        if (reference.isCurrentPicture || this.sh.useIntegerMv) {
          // Current-picture references and SCC integer-MV slices both use
          // full-pel MVDs while retaining quarter-sample internal units.
          mvXQpel = deriveIntegerMotionVectorComponent(mvp.x, mvdX);
          mvYQpel = deriveIntegerMotionVectorComponent(mvp.y, mvdY);
        } else {
          mvXQpel = mvp.x + mvdX;
          mvYQpel = mvp.y + mvdY;
        }
      }
      const reference = this.referenceImages[refIdxL0];
      if (!reference)
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: L0 reference index exceeds the active list',
        );
      if (reference.isCurrentPicture) this.copyIbcBlock(pu, mvXQpel, mvYQpel);
      else {
        this.hasExternalInterMotion = true;
        this.predictExternalBlock(pu, mvXQpel, mvYQpel, reference, refIdxL0);
      }
      this.setMotionRect(pu, mvXQpel, mvYQpel, refIdxL0);
    }

    this.deriveCuQp();
    if (!skipped) {
      const inferredRootCbf = partMode === 0 && predictionUnits.length === 1 && rootMergeFlag;
      const rootCbf = inferredRootCbf || this.cabac.decodeBin(CTX.ROOT_CBF) === 1;
      if (rootCbf) {
        const minLog2SizeInCu = this.interMinTransformSizeInCu(log2CbSize, partMode);
        this.transformTree(
          x0,
          y0,
          x0,
          y0,
          log2CbSize,
          0,
          0,
          false,
          this.sps.maxTransformHierarchyDepthInter + Number(partMode !== 0),
          [],
          1,
          1,
          true,
          partMode,
          minLog2SizeInCu,
        );
      }
    }

    this.markInterCuDecoded(x0, y0, size);
    this.setCtDepth(x0, y0, size, ctDepth);
    const qw = this.w >> 3;
    for (let by = y0 >> 3; by < (y0 + size) >> 3; by++)
      for (let bx = x0 >> 3; bx < (x0 + size) >> 3; bx++) this.qpMap[by * qw + bx] = this.cuQp;
    this.lastQpY = this.cuQp;
  }

  /** Decode a B-slice CU with independent L0/L1 motion and sample prediction. */
  private interCodingUnitB(
    x0: number,
    y0: number,
    log2CbSize: number,
    ctDepth: number,
    skipped: boolean,
  ): void {
    const activeL0 = this.sh.numRefIdxL0ActiveMinus1 + 1;
    const activeL1 = this.sh.numRefIdxL1ActiveMinus1 + 1;
    if (this.referenceImages.length < activeL0 || this.referenceImagesL1.length < activeL1)
      throw new HeicError('INVALID_CONTAINER', 'heic: B-slice reference lists are incomplete');

    const size = 1 << log2CbSize;
    this.cuActFlagAssociated =
      this.pps.screenContentExtension?.residualAdaptiveColourTransformEnabled === true &&
      this.sps.chromaFormatIdc === 3;
    const partMode = skipped ? 0 : this.decodeInterPartMode(log2CbSize);
    const predictionUnits = this.interPredictionUnits(x0, y0, size, partMode);
    const maxMergeCandidates = Math.max(1, 5 - this.sh.fiveMinusMaxNumMergeCand);
    let rootMergeFlag = false;

    for (let puIdx = 0; puIdx < predictionUnits.length; puIdx++) {
      const pu = predictionUnits[puIdx];
      const merge = skipped || this.cabac.decodeBin(CTX.MERGE_FLAG) === 1;
      if (puIdx === 0) rootMergeFlag = merge;
      let motion: InterMotionField;
      if (merge) {
        const mergeIdx = this.decodeMergeIndex(maxMergeCandidates);
        const sharedSmallCuMergeList =
          partMode !== 0 && size <= 8 && this.pps.log2ParallelMergeLevel > 2;
        const candidatePu = sharedSmallCuMergeList
          ? { x: x0, y: y0, width: size, height: size }
          : pu;
        const candidates = this.bMergeCandidates(
          candidatePu,
          maxMergeCandidates,
          sharedSmallCuMergeList ? 0 : partMode,
          sharedSmallCuMergeList ? 0 : puIdx,
          pu,
        );
        if (mergeIdx >= candidates.length)
          throw new HeicError(
            'INVALID_BITSTREAM',
            'heic: B merge index exceeds its candidate list',
          );
        const selected = candidates[mergeIdx];
        motion = {
          predFlags: selected.predFlags,
          l0: selected.l0 ? { ...selected.l0 } : null,
          l1: selected.l1 ? { ...selected.l1 } : null,
        };
        // H.265 8.5.3.2.2 rounds merge candidates for integer-MV slices and
        // for references to the current picture.
        if (motion.l0) {
          const reference = this.referenceImages[motion.l0.refIdxL0];
          if (reference && (this.sh.useIntegerMv || reference.isCurrentPicture)) {
            motion.l0.x = quantizeMotionVectorToIntegerPel(motion.l0.x);
            motion.l0.y = quantizeMotionVectorToIntegerPel(motion.l0.y);
          }
        }
        if (motion.l1) {
          const reference = this.referenceImagesL1[motion.l1.refIdxL1];
          if (reference && (this.sh.useIntegerMv || reference.isCurrentPicture)) {
            motion.l1.x = quantizeMotionVectorToIntegerPel(motion.l1.x);
            motion.l1.y = quantizeMotionVectorToIntegerPel(motion.l1.y);
          }
        }
        if (motion.l0 && (motion.l0.refIdxL0 < 0 || motion.l0.refIdxL0 >= activeL0))
          throw new HeicError(
            'INVALID_BITSTREAM',
            'heic: B merge candidate has an invalid L0 index',
          );
        if (motion.l1 && (motion.l1.refIdxL1 < 0 || motion.l1.refIdxL1 >= activeL1))
          throw new HeicError(
            'INVALID_BITSTREAM',
            'heic: B merge candidate has an invalid L1 index',
          );
        // H.265 8.5.3.2.2 step 10 disables L1 for bi-predicted 4x8/8x4 PUs.
        if (pu.width + pu.height === 12 && motion.l0 && motion.l1)
          motion = { predFlags: 1, l0: motion.l0, l1: null };
      } else {
        const predFlags = this.decodeInterPredIdc(pu, ctDepth);
        let l0: L0MotionCandidate | null = null;
        let l1: L1MotionCandidate | null = null;
        if (predFlags & 1) {
          const refIdxL0 = activeL0 > 1 ? this.decodeRefIdxL0(activeL0) : 0;
          const [mvdX, mvdY] = this.decodeMvd();
          const mvpIdx = this.cabac.decodeBin(CTX.MVP_INDEX);
          const candidates = this.spatialMvpCandidatesForList(pu, refIdxL0, 0);
          if (mvpIdx >= candidates.length)
            throw new HeicError('INVALID_BITSTREAM', 'heic: B L0 MVP index is unavailable');
          const reference = this.referenceImages[refIdxL0];
          const mvp = candidates[mvpIdx];
          const integerResolution = reference.isCurrentPicture || this.sh.useIntegerMv;
          l0 = {
            x: integerResolution ? deriveIntegerMotionVectorComponent(mvp.x, mvdX) : mvp.x + mvdX,
            y: integerResolution ? deriveIntegerMotionVectorComponent(mvp.y, mvdY) : mvp.y + mvdY,
            refIdxL0,
            referencePoc: reference.pictureOrderCnt,
            referenceLayerId: reference.layerId ?? 0,
            isLongTermReference: reference.isLongTermReference,
          };
        }
        if (predFlags & 2) {
          const refIdxL1 = activeL1 > 1 ? this.decodeRefIdxL1(activeL1) : 0;
          const [mvdX, mvdY] = this.sh.mvdL1ZeroFlag && predFlags === 3 ? [0, 0] : this.decodeMvd();
          const mvpIdx = this.cabac.decodeBin(CTX.MVP_INDEX);
          const candidates = this.spatialMvpCandidatesForList(pu, refIdxL1, 1);
          if (mvpIdx >= candidates.length)
            throw new HeicError('INVALID_BITSTREAM', 'heic: B L1 MVP index is unavailable');
          const reference = this.referenceImagesL1[refIdxL1];
          const mvp = candidates[mvpIdx];
          const integerResolution = reference.isCurrentPicture || this.sh.useIntegerMv;
          l1 = {
            x: integerResolution ? deriveIntegerMotionVectorComponent(mvp.x, mvdX) : mvp.x + mvdX,
            y: integerResolution ? deriveIntegerMotionVectorComponent(mvp.y, mvdY) : mvp.y + mvdY,
            refIdxL1,
            referencePoc: reference.pictureOrderCnt,
            referenceLayerId: reference.layerId ?? 0,
            isLongTermReference: reference.isLongTermReference,
          };
        }
        motion = { predFlags, l0, l1 };
      }
      motion = this.applyEightByEightBipredRestriction(pu, motion);
      const referenceL0 = motion.l0 && this.referenceImages[motion.l0.refIdxL0];
      const referenceL1 = motion.l1 && this.referenceImagesL1[motion.l1.refIdxL1];
      if (
        (referenceL0 && !referenceL0.isCurrentPicture) ||
        (referenceL1 && !referenceL1.isCurrentPicture)
      )
        this.hasExternalInterMotion = true;
      this.predictBBlock(pu, motion);
      this.setBMotionRect(pu, motion);
    }

    this.deriveCuQp();
    if (!skipped) {
      const inferredRootCbf = partMode === 0 && predictionUnits.length === 1 && rootMergeFlag;
      const rootCbf = inferredRootCbf || this.cabac.decodeBin(CTX.ROOT_CBF) === 1;
      if (rootCbf) {
        const minLog2SizeInCu = this.interMinTransformSizeInCu(log2CbSize, partMode);
        this.transformTree(
          x0,
          y0,
          x0,
          y0,
          log2CbSize,
          0,
          0,
          false,
          this.sps.maxTransformHierarchyDepthInter + Number(partMode !== 0),
          [],
          1,
          1,
          true,
          partMode,
          minLog2SizeInCu,
        );
      }
    }
    this.markInterCuDecoded(x0, y0, size);
    this.setCtDepth(x0, y0, size, ctDepth);
    const qw = this.w >> 3;
    for (let by = y0 >> 3; by < (y0 + size) >> 3; by++)
      for (let bx = x0 >> 3; bx < (x0 + size) >> 3; bx++) this.qpMap[by * qw + bx] = this.cuQp;
    this.lastQpY = this.cuQp;
  }

  /** Apply H.265 8.5.3.2.1's SCC current-picture 8x8 bi-pred restriction. */
  private applyEightByEightBipredRestriction(
    pu: { width: number; height: number },
    motion: InterMotionField,
  ): InterMotionField {
    if (!motion.l0 || !motion.l1 || pu.width !== 8 || pu.height !== 8) return motion;

    const twoVersionsOfCurrentPicture =
      this.sh.currentPictureReferenceEnabled &&
      (this.sps.sampleAdaptiveOffsetEnabled ||
        !this.pps.deblockingFilterDisabled ||
        this.pps.deblockingFilterOverrideEnabled);
    if (!twoVersionsOfCurrentPicture) return motion;

    const l0HasIntegerMv = (motion.l0.x & 3) === 0 && (motion.l0.y & 3) === 0;
    const l1HasIntegerMv = (motion.l1.x & 3) === 0 && (motion.l1.y & 3) === 0;
    const noIntegerMv = !l0HasIntegerMv && !l1HasIntegerMv;
    const identicalMvs =
      motion.l0.x === motion.l1.x &&
      motion.l0.y === motion.l1.y &&
      motion.l0.referencePoc === motion.l1.referencePoc &&
      motion.l0.referenceLayerId === motion.l1.referenceLayerId;
    if (!noIntegerMv || identicalMvs) return motion;

    // H.265 retains list 0 and clears list 1 for the restricted 8x8 PU.
    return { predFlags: 1, l0: motion.l0, l1: null };
  }

  private decodeInterPartMode(log2CbSize: number): number {
    let partMode = 0;
    const maxBins = log2CbSize === this.sps.log2MinLumaCodingBlockSize && log2CbSize > 3 ? 3 : 2;
    for (let i = 0; i < maxBins; i++) {
      if (this.cabac.decodeBin(CTX.PART_MODE + i) === 1) break;
      partMode++;
    }

    if (this.sps.ampEnabled && log2CbSize > this.sps.log2MinLumaCodingBlockSize) {
      if (partMode === 1 || partMode === 2) {
        if (this.cabac.decodeBin(CTX.PART_MODE + 3) === 0) {
          partMode = partMode === 1 ? 4 + this.cabac.decodeBypass() : 6 + this.cabac.decodeBypass();
        }
      }
    }
    if (partMode > 7)
      throw new HeicError('INVALID_BITSTREAM', `heic: invalid inter partition mode ${partMode}`);
    return partMode;
  }

  private interPredictionUnits(
    x: number,
    y: number,
    size: number,
    partMode: number,
  ): { x: number; y: number; width: number; height: number }[] {
    const half = size >> 1;
    switch (partMode) {
      case 0:
        return [{ x, y, width: size, height: size }];
      case 1:
        return [
          { x, y, width: size, height: half },
          { x, y: y + half, width: size, height: half },
        ];
      case 2:
        return [
          { x, y, width: half, height: size },
          { x: x + half, y, width: half, height: size },
        ];
      case 3:
        return [
          { x, y, width: half, height: half },
          { x: x + half, y, width: half, height: half },
          { x, y: y + half, width: half, height: half },
          { x: x + half, y: y + half, width: half, height: half },
        ];
      case 4:
        return [
          { x, y, width: size, height: size >> 2 },
          { x, y: y + (size >> 2), width: size, height: size - (size >> 2) },
        ];
      case 5:
        return [
          { x, y, width: size, height: size - (size >> 2) },
          { x, y: y + size - (size >> 2), width: size, height: size >> 2 },
        ];
      case 6:
        return [
          { x, y, width: size >> 2, height: size },
          { x: x + (size >> 2), y, width: size - (size >> 2), height: size },
        ];
      case 7:
        return [
          { x, y, width: size - (size >> 2), height: size },
          { x: x + size - (size >> 2), y, width: size >> 2, height: size },
        ];
      default:
        throw new HeicError('INVALID_BITSTREAM', 'heic: invalid inter partition mode');
    }
  }

  private decodeMergeIndex(maxCandidates: number): number {
    let index = 0;
    for (let i = 0; i < maxCandidates - 1; i++) {
      const bin = i === 0 ? this.cabac.decodeBin(CTX.MERGE_INDEX) : this.cabac.decodeBypass();
      if (bin === 0) break;
      index++;
    }
    return index;
  }

  private decodeRefIdxL0(activeCount: number): number {
    return this.decodeRefIdx(activeCount, CTX.REF_IDX);
  }

  private decodeRefIdxL1(activeCount: number): number {
    // H.265 uses the ref_idx context model for both list directions; the two
    // initValue columns are both set from Table 9-18, but the CABAC state is
    // shared when ref_idx_l1 is decoded.
    return this.decodeRefIdx(activeCount, CTX.REF_IDX);
  }

  private decodeRefIdx(activeCount: number, contextBase: number): number {
    let index = 0;
    for (let binIdx = 0; binIdx < activeCount - 1; binIdx++) {
      const selected =
        binIdx < 2 ? this.cabac.decodeBin(contextBase + binIdx) : this.cabac.decodeBypass();
      if (selected === 0) break;
      index++;
    }
    return index;
  }

  /** H.265 9.3.4.2.8: decode the B-slice inter_pred_idc value. */
  private decodeInterPredIdc(pu: { width: number; height: number }, ctDepth: number): 1 | 2 | 3 {
    // 4x8/8x4 PUs code one bin at context 4: 0 selects L0, 1 selects L1.
    if (pu.width + pu.height === 12)
      return this.cabac.decodeBin(CTX.INTER_PRED_IDC + 4) === 1 ? 2 : 1;
    if (this.cabac.decodeBin(CTX.INTER_PRED_IDC + ctDepth) === 1) return 3;
    return this.cabac.decodeBin(CTX.INTER_PRED_IDC + 4) === 1 ? 2 : 1;
  }

  private decodeMvd(): [number, number] {
    let hor = this.cabac.decodeBin(CTX.MVD);
    let ver = this.cabac.decodeBin(CTX.MVD);
    if (hor) hor += this.cabac.decodeBin(CTX.MVD + 1);
    if (ver) ver += this.cabac.decodeBin(CTX.MVD + 1);

    const readExpGolomb1 = (): number => {
      let order = 1;
      let suffixBase = 0;
      while (this.cabac.decodeBypass() === 1) {
        suffixBase += 1 << order;
        order++;
      }
      return suffixBase + this.cabac.decodeBypassBits(order);
    };
    if (hor === 2) hor += readExpGolomb1();
    if (hor !== 0 && this.cabac.decodeBypass() === 1) hor = -hor;
    if (ver === 2) ver += readExpGolomb1();
    if (ver !== 0 && this.cabac.decodeBypass() === 1) ver = -ver;
    return [hor, ver];
  }

  private interMotionAt(x: number, y: number): L0MotionCandidate | null {
    if (!this.isAvailableInCurrentSlice(x, y)) return null;
    const i = (y >> 2) * this.bwY + (x >> 2);
    if (this.interMap[i] !== 1) return null;
    return {
      x: this.motionXQpel[i],
      y: this.motionYQpel[i],
      refIdxL0: this.motionRefIdxL0[i],
      referencePoc: this.motionRefPoc[i],
      referenceLayerId: this.motionRefLayerId[i] ?? 0,
      isLongTermReference: this.motionRefLongTerm[i] === 1,
    };
  }

  private interMotionFieldAt(x: number, y: number): InterMotionField | null {
    if (!this.isAvailableInCurrentSlice(x, y)) return null;
    const index = (y >> 2) * this.bwY + (x >> 2);
    if (this.interMap[index] !== 1) return null;
    const predFlags = this.motionPredFlags[index] || 1;
    const l0 =
      predFlags & 1
        ? {
            x: this.motionXQpel[index],
            y: this.motionYQpel[index],
            refIdxL0: this.motionRefIdxL0[index],
            referencePoc: this.motionRefPoc[index],
            referenceLayerId: this.motionRefLayerId[index] ?? 0,
            isLongTermReference: this.motionRefLongTerm[index] === 1,
          }
        : null;
    const l1 =
      predFlags & 2
        ? {
            x: this.motionXQpelL1[index],
            y: this.motionYQpelL1[index],
            refIdxL1: this.motionRefIdxL1[index],
            referencePoc: this.motionRefPocL1[index],
            referenceLayerId: this.motionRefLayerIdL1[index] ?? 0,
            isLongTermReference: this.motionRefLongTermL1[index] === 1,
          }
        : null;
    return { predFlags, l0, l1 };
  }

  /** H.265 8.5.3.2.8–9 temporal MVP for either current reference list. */
  private temporalMvpCandidateForList(
    pu: { x: number; y: number; width: number; height: number },
    refIdx: number,
    list: 0 | 1,
  ): MotionVectorCandidate | null {
    if (!this.sh.sliceTemporalMvpEnabled) return null;
    const currentReferences = list === 0 ? this.referenceImages : this.referenceImagesL1;
    const target = currentReferences[refIdx];
    // A current-picture reference can still use temporal MVP from a
    // collocated reference picture; the predictor is copied when the target
    // reference is long-term, as in 8.5.3.2.8.
    if (!target) return null;
    const collocatedReferences = this.sh.collocatedFromL0
      ? this.referenceImages
      : this.referenceImagesL1;
    const colPicture = collocatedReferences[this.sh.collocatedRefIdx];
    if (!colPicture || colPicture.isCurrentPicture) return null;
    // IBC-only pictures still carry the motion map needed by temporal MVP.
    // `hasExternalInterMotion` cannot decide whether that map is useful.
    const {
      interMap,
      motionPredFlags,
      motionXQpel,
      motionYQpel,
      motionRefPoc,
      motionRefLongTerm,
      motionRefLayerId,
      motionXQpelL1,
      motionYQpelL1,
      motionRefPocL1,
      motionRefLongTermL1,
      motionRefLayerIdL1,
    } = colPicture;
    const mapLength = this.bwY * this.bhY;
    if (
      !interMap ||
      !motionXQpel ||
      !motionYQpel ||
      !motionRefPoc ||
      !motionRefLongTerm ||
      interMap.length !== mapLength ||
      motionXQpel.length !== mapLength ||
      motionYQpel.length !== mapLength ||
      motionRefPoc.length !== mapLength ||
      motionRefLongTerm.length !== mapLength ||
      (motionRefLayerId && motionRefLayerId.length !== mapLength) ||
      (motionPredFlags && motionPredFlags.length !== mapLength) ||
      (motionXQpelL1 && motionXQpelL1.length !== mapLength) ||
      (motionYQpelL1 && motionYQpelL1.length !== mapLength) ||
      (motionRefPocL1 && motionRefPocL1.length !== mapLength) ||
      (motionRefLongTermL1 && motionRefLongTermL1.length !== mapLength) ||
      (motionRefLayerIdL1 && motionRefLayerIdL1.length !== mapLength)
    ) {
      if (!colPicture.hasExternalInterMotion) return null;
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        'heic: collocated reference motion map is incomplete',
      );
    }

    const noBackwardPrediction = [...this.referenceImages, ...this.referenceImagesL1].every(
      (reference) => reference.pictureOrderCnt <= this.currentPictureOrderCnt,
    );
    const candidateAt = (x: number, y: number): MotionVectorCandidate | null => {
      if (x < 0 || y < 0 || x >= colPicture.width || y >= colPicture.height) return null;
      const index = (y >> 2) * this.bwY + (x >> 2);
      if (interMap[index] !== 1) return null;
      const predFlags = motionPredFlags?.[index] ?? 1;
      const sourceList: 0 | 1 =
        (predFlags & 1) === 0
          ? 1
          : (predFlags & 2) === 0
            ? 0
            : noBackwardPrediction
              ? list
              : this.sh.collocatedFromL0
                ? 1
                : 0;
      const mvX = sourceList === 0 ? motionXQpel[index] : (motionXQpelL1?.[index] ?? 0);
      const mvY = sourceList === 0 ? motionYQpel[index] : (motionYQpelL1?.[index] ?? 0);
      const refPoc = sourceList === 0 ? motionRefPoc[index] : (motionRefPocL1?.[index] ?? 0);
      const isLongTermReference =
        sourceList === 0 ? motionRefLongTerm[index] === 1 : motionRefLongTermL1?.[index] === 1;
      if (isLongTermReference === undefined) return null;
      // H.265 8.5.3.2.8 makes the temporal candidate unavailable when the
      // collocated and current reference pictures disagree on long-term
      // status. Do not replace the current target with another list entry
      // that happens to have the collocated picture's status.
      if (isLongTermReference !== target.isLongTermReference) return null;

      const colPocDiff = colPicture.pictureOrderCnt - refPoc;
      const currPocDiff = this.currentPictureOrderCnt - target.pictureOrderCnt;
      if (target.isLongTermReference || colPocDiff === currPocDiff || colPocDiff === 0)
        return {
          x: mvX,
          y: mvY,
          referencePoc: target.pictureOrderCnt,
          referenceLayerId: target.layerId ?? 0,
          isLongTermReference: target.isLongTermReference,
          referenceIndex: refIdx,
        };
      const td = clip3(-128, 127, colPocDiff);
      const tb = clip3(-128, 127, currPocDiff);
      return {
        x: scaleSpatialMotionVectorComponent(mvX, td, tb),
        y: scaleSpatialMotionVectorComponent(mvY, td, tb),
        referencePoc: target.pictureOrderCnt,
        referenceLayerId: target.layerId ?? 0,
        isLongTermReference: target.isLongTermReference,
        referenceIndex: refIdx,
      };
    };

    const colBrX = pu.x + pu.width;
    const colBrY = pu.y + pu.height;
    if (
      pu.y >> this.log2Ctb === colBrY >> this.log2Ctb &&
      colBrX < colPicture.width &&
      colBrY < colPicture.height
    ) {
      const sampleX = (colBrX >> 4) << 4;
      const sampleY = (colBrY >> 4) << 4;
      const bottomRight = candidateAt(sampleX, sampleY);
      if (bottomRight) return bottomRight;
    }
    const centerX = ((pu.x + (pu.width >> 1)) >> 4) << 4;
    const centerY = ((pu.y + (pu.height >> 1)) >> 4) << 4;
    return candidateAt(centerX, centerY);
  }

  private spatialMvpCandidatesForList(
    pu: { x: number; y: number; width: number; height: number },
    refIdx: number,
    list: 0 | 1,
  ): MotionVectorCandidate[] {
    const references = list === 0 ? this.referenceImages : this.referenceImagesL1;
    const target = references[refIdx];
    if (!target)
      throw new HeicError(
        'INVALID_BITSTREAM',
        `heic: MVP references an unavailable L${list} entry`,
      );
    const at = (x: number, y: number): InterMotionField | null => this.interMotionFieldAt(x, y);
    const aPositions: [number, number][] = [
      [pu.x - 1, pu.y + pu.height],
      [pu.x - 1, pu.y + pu.height - 1],
    ];
    const bPositions: [number, number][] = [
      [pu.x + pu.width, pu.y - 1],
      [pu.x + pu.width - 1, pu.y - 1],
      [pu.x - 1, pu.y - 1],
    ];
    const isScaledFlag = aPositions.some(([x, y]) => {
      if (!this.isAvailableInCurrentSlice(x, y)) return false;
      const index = (y >> 2) * this.bwY + (x >> 2);
      return this.interMap[index] === 1;
    });
    const fromField = (
      field: InterMotionField,
      exactOnly: boolean,
    ): MotionVectorCandidate | null => {
      const options: (L0MotionCandidate | L1MotionCandidate | null)[] =
        list === 0 ? [field.l0, field.l1] : [field.l1, field.l0];
      for (const candidate of options) {
        if (!candidate) continue;
        if (exactOnly && candidate.referencePoc !== target.pictureOrderCnt) continue;
        if (!exactOnly && candidate.isLongTermReference !== target.isLongTermReference) continue;
        if (
          exactOnly ||
          target.isLongTermReference ||
          candidate.referencePoc === target.pictureOrderCnt
        )
          return {
            x: candidate.x,
            y: candidate.y,
            referencePoc: target.pictureOrderCnt,
            referenceLayerId: target.layerId ?? 0,
            isLongTermReference: target.isLongTermReference,
          };
        const td = clip3(-128, 127, this.currentPictureOrderCnt - candidate.referencePoc);
        const tb = clip3(-128, 127, this.currentPictureOrderCnt - target.pictureOrderCnt);
        return {
          x: scaleSpatialMotionVectorComponent(candidate.x, td, tb),
          y: scaleSpatialMotionVectorComponent(candidate.y, td, tb),
          referencePoc: target.pictureOrderCnt,
          referenceLayerId: target.layerId ?? 0,
          isLongTermReference: target.isLongTermReference,
        };
      }
      return null;
    };
    const find = (
      positions: [number, number][],
      exactOnly: boolean,
    ): MotionVectorCandidate | null => {
      for (const [x, y] of positions) {
        const field = at(x, y);
        if (!field) continue;
        const candidate = fromField(field, exactOnly);
        if (candidate) return candidate;
      }
      return null;
    };

    let a = find(aPositions, true) ?? find(aPositions, false);
    let b: MotionVectorCandidate | null;
    if (isScaledFlag) b = find(bPositions, true);
    else {
      const exactB = find(bPositions, true);
      if (!a && exactB) a = exactB;
      b = find(bPositions, false);
    }
    const candidates: MotionVectorCandidate[] = [];
    if (a) candidates.push(a);
    if (b && (!a || a.x !== b.x || a.y !== b.y)) candidates.push(b);
    if (candidates.length < 2) {
      const temporal = this.temporalMvpCandidateForList(pu, refIdx, list);
      if (temporal) candidates.push(temporal);
    }
    while (candidates.length < 2)
      candidates.push({
        x: 0,
        y: 0,
        referencePoc: target.pictureOrderCnt,
        referenceLayerId: target.layerId ?? 0,
        isLongTermReference: target.isLongTermReference,
      });
    return candidates;
  }

  /** H.265 8.5.3.2.8–9 temporal MVP from an L0 collocated picture. */
  private temporalMvpCandidate(
    pu: { x: number; y: number; width: number; height: number },
    refIdxL0: number,
  ): L0MotionCandidate | null {
    if (!this.sh.sliceTemporalMvpEnabled) return null;

    const colPicture = this.referenceImages[this.sh.collocatedRefIdx];
    if (!colPicture)
      throw new HeicError('INVALID_BITSTREAM', 'heic: collocated L0 reference is unavailable');
    if (colPicture.isCurrentPicture) return null;
    // IBC-only pictures still carry the motion map needed by temporal MVP.

    const target = this.referenceImages[refIdxL0];
    if (!target)
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: temporal MVP target reference is unavailable',
      );
    const {
      interMap,
      motionXQpel,
      motionYQpel,
      motionRefPoc,
      motionRefLongTerm,
      motionRefLayerId,
    } = colPicture;
    const mapLength = this.bwY * this.bhY;
    if (
      !interMap ||
      !motionXQpel ||
      !motionYQpel ||
      !motionRefPoc ||
      !motionRefLongTerm ||
      interMap.length !== mapLength ||
      motionXQpel.length !== mapLength ||
      motionYQpel.length !== mapLength ||
      motionRefPoc.length !== mapLength ||
      motionRefLongTerm.length !== mapLength ||
      (motionRefLayerId && motionRefLayerId.length !== mapLength)
    ) {
      if (!colPicture.hasExternalInterMotion) return null;
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        'heic: collocated reference is missing its inter-motion map',
      );
    }

    const candidateAt = (x: number, y: number): L0MotionCandidate | null => {
      if (x < 0 || y < 0 || x >= colPicture.width || y >= colPicture.height) return null;
      const index = (y >> 2) * this.bwY + (x >> 2);
      if (interMap[index] !== 1) return null;
      const isLongTermReference = motionRefLongTerm[index] === 1;
      if (isLongTermReference !== target.isLongTermReference) return null;
      const mvX = motionXQpel[index];
      const mvY = motionYQpel[index];
      const colPocDiff = colPicture.pictureOrderCnt - motionRefPoc[index];
      const currPocDiff = this.currentPictureOrderCnt - target.pictureOrderCnt;
      if (target.isLongTermReference || colPocDiff === currPocDiff) {
        return {
          x: mvX,
          y: mvY,
          refIdxL0,
          referencePoc: target.pictureOrderCnt,
          referenceLayerId: target.layerId ?? 0,
          isLongTermReference: target.isLongTermReference,
        };
      }

      const td = clip3(-128, 127, colPocDiff);
      const tb = clip3(-128, 127, currPocDiff);
      return {
        x: scaleSpatialMotionVectorComponent(mvX, td, tb),
        y: scaleSpatialMotionVectorComponent(mvY, td, tb),
        refIdxL0,
        referencePoc: target.pictureOrderCnt,
        referenceLayerId: target.layerId ?? 0,
        isLongTermReference: target.isLongTermReference,
      };
    };

    const colBrX = pu.x + pu.width;
    const colBrY = pu.y + pu.height;
    if (
      pu.y >> this.log2Ctb === colBrY >> this.log2Ctb &&
      colBrX < colPicture.width &&
      colBrY < colPicture.height
    ) {
      const bottomRight = candidateAt((colBrX >> 4) << 4, (colBrY >> 4) << 4);
      if (bottomRight) return bottomRight;
    }

    const centerX = ((pu.x + (pu.width >> 1)) >> 4) << 4;
    const centerY = ((pu.y + (pu.height >> 1)) >> 4) << 4;
    const center = candidateAt(centerX, centerY);
    return center;
  }

  private spatialMvpCandidates(
    pu: {
      x: number;
      y: number;
      width: number;
      height: number;
    },
    refIdxL0: number,
  ): L0MotionCandidate[] {
    const candidates: L0MotionCandidate[] = [];
    const target = this.referenceImages[refIdxL0];
    if (!target)
      throw new HeicError('INVALID_BITSTREAM', 'heic: MVP references an unavailable L0 entry');
    const availableAt = (points: [number, number][]): L0MotionCandidate[] =>
      points
        .map(([x, y]) => this.interMotionAt(x, y))
        .filter((candidate): candidate is L0MotionCandidate => candidate !== null);

    const exactCandidate = (points: [number, number][]): L0MotionCandidate | null => {
      const exact = availableAt(points).find(
        (candidate) => candidate.referencePoc === target.pictureOrderCnt,
      );
      return exact ? { ...exact, refIdxL0 } : null;
    };

    const compatibleCandidate = (points: [number, number][]): L0MotionCandidate | null => {
      const compatible = availableAt(points).find(
        (candidate) => candidate.isLongTermReference === target.isLongTermReference,
      );
      if (!compatible) return null;
      if (target.isLongTermReference) return { ...compatible, refIdxL0 };
      // An exact POC match needs no temporal scaling; its POC distance is zero.
      if (compatible.referencePoc === target.pictureOrderCnt) return { ...compatible, refIdxL0 };
      const td = clip3(-128, 127, this.currentPictureOrderCnt - compatible.referencePoc);
      const tb = clip3(-128, 127, this.currentPictureOrderCnt - target.pictureOrderCnt);
      return {
        ...compatible,
        x: scaleSpatialMotionVectorComponent(compatible.x, td, tb),
        y: scaleSpatialMotionVectorComponent(compatible.y, td, tb),
        refIdxL0,
        referencePoc: target.pictureOrderCnt,
        referenceLayerId: target.layerId ?? 0,
        isLongTermReference: target.isLongTermReference,
      };
    };
    const aPositions: [number, number][] = [
      [pu.x - 1, pu.y + pu.height],
      [pu.x - 1, pu.y + pu.height - 1],
    ];
    const bPositions: [number, number][] = [
      [pu.x + pu.width, pu.y - 1],
      [pu.x + pu.width - 1, pu.y - 1],
      [pu.x - 1, pu.y - 1],
    ];
    const isScaledFlag = aPositions.some(([x, y]) => {
      if (!this.isAvailableInCurrentSlice(x, y)) return false;
      const index = (y >> 2) * this.bwY + (x >> 2);
      // Prediction-block availability excludes undecoded neighbors and
      // intra-coded blocks (6.4.2), so an inter motion entry is the relevant
      // signal here. Slice/tile membership alone is insufficient.
      return this.interMap[index] === 1;
    });
    let a = exactCandidate(aPositions) ?? compatibleCandidate(aPositions);
    let b: L0MotionCandidate | null;
    if (isScaledFlag) {
      b = exactCandidate(bPositions);
    } else {
      // H.265 8.5.3.2.7 first uses an exact B match as A when no A
      // position is available, then derives B again from the first neighbor
      // with the same short/long-term class. This second B candidate can be
      // scaled from a different reference than the exact match.
      const exactB = exactCandidate(bPositions);
      if (!a && exactB) a = exactB;
      b = compatibleCandidate(bPositions);
    }
    if (a) candidates.push(a);
    if (b && !candidates.some((old) => old.x === b.x && old.y === b.y)) candidates.push(b);
    if (candidates.length < 2) {
      const temporal = this.temporalMvpCandidate(pu, refIdxL0);
      if (temporal) candidates.push(temporal);
    }
    const zero = {
      x: 0,
      y: 0,
      refIdxL0,
      referencePoc: target.pictureOrderCnt,
      referenceLayerId: target.layerId ?? 0,
      isLongTermReference: target.isLongTermReference,
    };
    while (candidates.length < 2) candidates.push(zero);
    return candidates;
  }

  /** H.265 8.5.3.2.2–5 P-slice L0 merge candidates. */
  private externalMergeCandidates(
    pu: { x: number; y: number; width: number; height: number },
    maxCandidates: number,
    partMode: number,
    partIdx: number,
    temporalPu = pu,
  ): L0MotionCandidate[] {
    const a1Position: [number, number] = [pu.x - 1, pu.y + pu.height - 1];
    const b1Position: [number, number] = [pu.x + pu.width - 1, pu.y - 1];
    const sameMergeRegion = (x: number, y: number): boolean => {
      const shift = this.pps.log2ParallelMergeLevel;
      return x >> shift === pu.x >> shift && y >> shift === pu.y >> shift;
    };
    const from = (position: [number, number]): L0MotionCandidate | null => {
      const [x, y] = position;
      if (this.pps.log2ParallelMergeLevel > 2 && sameMergeRegion(x, y)) return null;
      return this.interMotionAt(x, y);
    };
    const same = (left: L0MotionCandidate | null, right: L0MotionCandidate | null): boolean =>
      left !== null &&
      right !== null &&
      left.x === right.x &&
      left.y === right.y &&
      left.refIdxL0 === right.refIdxL0;

    // A1 is unavailable to the second PU in vertical and asymmetric vertical
    // partitions. B1 has the corresponding restriction for horizontal modes.
    const a1 = partIdx === 1 && [2, 6, 7].includes(partMode) ? null : from(a1Position);
    const b1 = partIdx === 1 && [1, 4, 5].includes(partMode) ? null : from(b1Position);
    const candidates: L0MotionCandidate[] = [];
    if (a1) candidates.push(a1);
    if (b1 && !same(a1, b1)) candidates.push(b1);

    const b0 = from([pu.x + pu.width, pu.y - 1]);
    if (b0 && !same(b1, b0)) candidates.push(b0);

    const a0 = from([pu.x - 1, pu.y + pu.height]);
    if (a0 && !same(a1, a0)) candidates.push(a0);

    const b2 = from([pu.x - 1, pu.y - 1]);
    if (b2 && !same(a1, b2) && !same(b1, b2) && candidates.length !== 4) candidates.push(b2);

    if (candidates.length > maxCandidates) candidates.length = maxCandidates;
    if (candidates.length < maxCandidates) {
      const temporal = this.temporalMvpCandidate(temporalPu, 0);
      if (temporal) candidates.push(temporal);
    }
    let zeroIdx = 0;
    while (candidates.length < maxCandidates) {
      const refIdxL0 = zeroIdx < this.sh.numRefIdxL0ActiveMinus1 + 1 ? zeroIdx : 0;
      const reference = this.referenceImages[refIdxL0];
      if (!reference)
        throw new HeicError('INVALID_BITSTREAM', 'heic: zero merge candidate has no L0 reference');
      candidates.push({
        x: 0,
        y: 0,
        refIdxL0,
        referencePoc: reference.pictureOrderCnt,
        referenceLayerId: reference.layerId ?? 0,
        isLongTermReference: reference.isLongTermReference,
      });
      zeroIdx++;
    }
    return candidates;
  }

  /** H.265 8.5.3.2.2–5 B-slice spatial, temporal and combined merge candidates. */
  private bMergeCandidates(
    pu: { x: number; y: number; width: number; height: number },
    maxCandidates: number,
    partMode: number,
    partIdx: number,
    temporalPu = pu,
  ): BiMergeCandidate[] {
    const a1Position: [number, number] = [pu.x - 1, pu.y + pu.height - 1];
    const b1Position: [number, number] = [pu.x + pu.width - 1, pu.y - 1];
    const sameMergeRegion = (x: number, y: number): boolean => {
      const shift = this.pps.log2ParallelMergeLevel;
      return x >> shift === pu.x >> shift && y >> shift === pu.y >> shift;
    };
    const from = (position: [number, number]): BiMergeCandidate | null => {
      const [x, y] = position;
      if (this.pps.log2ParallelMergeLevel > 2 && sameMergeRegion(x, y)) return null;
      return this.interMotionFieldAt(x, y);
    };
    const sameListCandidate = (
      left: L0MotionCandidate | L1MotionCandidate | null,
      right: L0MotionCandidate | L1MotionCandidate | null,
    ): boolean => {
      if (left === null || right === null) return left === right;
      const leftRefIdx = 'refIdxL0' in left ? left.refIdxL0 : left.refIdxL1;
      const rightRefIdx = 'refIdxL0' in right ? right.refIdxL0 : right.refIdxL1;
      return left.x === right.x && left.y === right.y && leftRefIdx === rightRefIdx;
    };
    const same = (left: BiMergeCandidate | null, right: BiMergeCandidate | null): boolean =>
      left !== null &&
      right !== null &&
      left.predFlags === right.predFlags &&
      sameListCandidate(left.l0, right.l0) &&
      sameListCandidate(left.l1, right.l1);

    const a1 = partIdx === 1 && [2, 6, 7].includes(partMode) ? null : from(a1Position);
    const b1 = partIdx === 1 && [1, 4, 5].includes(partMode) ? null : from(b1Position);
    const candidates: BiMergeCandidate[] = [];
    if (a1) candidates.push(a1);
    if (b1 && !same(a1, b1)) candidates.push(b1);

    const b0 = from([pu.x + pu.width, pu.y - 1]);
    if (b0 && !same(b1, b0)) candidates.push(b0);
    const a0 = from([pu.x - 1, pu.y + pu.height]);
    if (a0 && !same(a1, a0)) candidates.push(a0);
    const b2 = from([pu.x - 1, pu.y - 1]);
    if (b2 && !same(a1, b2) && !same(b1, b2) && candidates.length !== 4) candidates.push(b2);
    if (candidates.length > maxCandidates) candidates.length = maxCandidates;

    if (candidates.length < maxCandidates && this.sh.sliceTemporalMvpEnabled) {
      const temporalL0 = this.temporalMvpCandidateForList(temporalPu, 0, 0);
      const temporalL1 = this.temporalMvpCandidateForList(temporalPu, 0, 1);
      if (temporalL0 || temporalL1) {
        candidates.push({
          predFlags: Number(temporalL0 !== null) | (Number(temporalL1 !== null) << 1),
          l0: temporalL0 ? { ...temporalL0, refIdxL0: temporalL0.referenceIndex ?? 0 } : null,
          l1: temporalL1 ? { ...temporalL1, refIdxL1: temporalL1.referenceIndex ?? 0 } : null,
        });
      }
    }

    const originalSpatialCount = candidates.length;
    const combinations: [number, number][] = [
      [0, 1],
      [1, 0],
      [0, 2],
      [2, 0],
      [1, 2],
      [2, 1],
      [0, 3],
      [3, 0],
      [1, 3],
      [3, 1],
      [2, 3],
      [3, 2],
    ];
    for (const [l0Index, l1Index] of combinations) {
      if (
        candidates.length >= maxCandidates ||
        l0Index >= originalSpatialCount ||
        l1Index >= originalSpatialCount
      )
        break;
      const sourceL0 = candidates[l0Index];
      const sourceL1 = candidates[l1Index];
      if (!sourceL0.l0 || !sourceL1.l1) continue;
      const sameReferencePoc = sourceL0.l0.referencePoc === sourceL1.l1.referencePoc;
      const sameVector = sourceL0.l0.x === sourceL1.l1.x && sourceL0.l0.y === sourceL1.l1.y;
      if (sameReferencePoc && sameVector) continue;
      candidates.push({
        predFlags: 3,
        l0: sourceL0.l0,
        l1: sourceL1.l1,
      });
    }

    const zeroCandidateCount = Math.min(
      this.sh.numRefIdxL0ActiveMinus1 + 1,
      this.sh.numRefIdxL1ActiveMinus1 + 1,
    );
    for (let zeroIdx = 0; candidates.length < maxCandidates; zeroIdx++) {
      const refIdx = zeroIdx < zeroCandidateCount ? zeroIdx : 0;
      const l0Reference = this.referenceImages[refIdx];
      const l1Reference = this.referenceImagesL1[refIdx];
      if (!l0Reference || !l1Reference)
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: B zero-motion merge reference is unavailable',
        );
      candidates.push({
        predFlags: 3,
        l0: {
          x: 0,
          y: 0,
          refIdxL0: refIdx,
          referencePoc: l0Reference.pictureOrderCnt,
          referenceLayerId: l0Reference.layerId ?? 0,
          isLongTermReference: l0Reference.isLongTermReference,
        },
        l1: {
          x: 0,
          y: 0,
          refIdxL1: refIdx,
          referencePoc: l1Reference.pictureOrderCnt,
          referenceLayerId: l1Reference.layerId ?? 0,
          isLongTermReference: l1Reference.isLongTermReference,
        },
      });
    }
    if (candidates.length > maxCandidates) candidates.length = maxCandidates;
    return candidates;
  }

  private copyIbcBlock(
    pu: { x: number; y: number; width: number; height: number },
    mvXQpel: number,
    mvYQpel: number,
  ): void {
    if ((mvXQpel & 3) !== 0 || (mvYQpel & 3) !== 0)
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: IBC motion vector is not integer-sample aligned',
      );
    const dx = mvXQpel >> 2;
    const dy = mvYQpel >> 2;
    const sx = pu.x + dx;
    const sy = pu.y + dy;
    if (sx < 0 || sy < 0 || sx + pu.width > this.w || sy + pu.height > this.h)
      throw new HeicError('INVALID_BITSTREAM', 'heic: IBC source block exceeds picture bounds');
    const sub = this.sps.chromaFormatIdc !== 0 ? chromaSubsampling(this.sps.chromaFormatIdc) : null;
    if (
      sub &&
      (pu.x % sub.width !== 0 ||
        pu.y % sub.height !== 0 ||
        pu.width % sub.width !== 0 ||
        pu.height % sub.height !== 0)
    )
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: IBC block is not aligned to the chroma sampling grid',
      );
    // A zero-vector current-picture reference is the identity prediction: it
    // reads the same samples it is about to replace, so it is a no-op until
    // this PU's residual is reconstructed.
    if (sx === pu.x && sy === pu.y) return;
    // HM reads the current-picture reference into a prediction buffer before
    // reconstructing this PU. Snapshot first so partial overlap has the same
    // semantics instead of letting an earlier destination row clobber a later
    // source row.
    const predictionY = new Uint16Array(pu.width * pu.height);
    for (let row = 0; row < pu.height; row++) {
      const src = (sy + row) * this.w + sx;
      predictionY.set(this.y.subarray(src, src + pu.width), row * pu.width);
    }
    for (let row = 0; row < pu.height; row++)
      this.y.set(
        predictionY.subarray(row * pu.width, (row + 1) * pu.width),
        (pu.y + row) * this.w + pu.x,
      );

    if (sub) {
      const xC = pu.x / sub.width;
      const yC = pu.y / sub.height;
      const widthC = pu.width / sub.width;
      const heightC = pu.height / sub.height;

      // IBC vectors are integer luma samples, but that can be a fractional
      // chroma-sample displacement for 4:2:0 and 4:2:2. Use the regular HEVC
      // eighth-chroma-sample filters, reading a snapshot so overlapping filter
      // footprints cannot observe samples already written to this PU.
      const chromaMvX = (mvXQpel * 2) / sub.width;
      const chromaMvY = (mvYQpel * 2) / sub.height;
      const baseChromaX = xC + (chromaMvX >> 3);
      const baseChromaY = yC + (chromaMvY >> 3);
      const fracChromaX = chromaMvX & 7;
      const fracChromaY = chromaMvY & 7;
      const planes = [this.cb, this.cr] as const;
      const predictions = planes.map((plane) => {
        const output = new Uint16Array(widthC * heightC);
        for (let y = 0; y < heightC; y++) {
          for (let x = 0; x < widthC; x++) {
            output[y * widthC + x] = interpolateChromaSample(
              plane,
              this.cw,
              this.ch,
              baseChromaX + x,
              baseChromaY + y,
              fracChromaX,
              fracChromaY,
              this.sps.bitDepthChroma,
            );
          }
        }
        return output;
      });
      for (let c = 0; c < planes.length; c++) {
        const plane = planes[c];
        const prediction = predictions[c];
        for (let row = 0; row < heightC; row++) {
          const dst = (yC + row) * this.cw + xC;
          plane.set(prediction.subarray(row * widthC, (row + 1) * widthC), dst);
        }
      }
    }
  }

  /** H.265 8.5.3.2.1: constrain an external prediction MV to the CTB bounds. */
  private clipExternalMotionVector(
    pu: { x: number; y: number },
    mvXQpel: number,
    mvYQpel: number,
  ): [number, number] {
    const ctbX = Math.floor(pu.x / this.ctbSize) * this.ctbSize;
    const ctbY = Math.floor(pu.y / this.ctbSize) * this.ctbSize;
    const maxX = (this.w + 8 - ctbX - 1) << 2;
    const minX = (-this.ctbSize - 8 - ctbX + 1) << 2;
    const maxY = (this.h + 8 - ctbY - 1) << 2;
    const minY = (-this.ctbSize - 8 - ctbY + 1) << 2;
    return [Math.max(minX, Math.min(maxX, mvXQpel)), Math.max(minY, Math.min(maxY, mvYQpel))];
  }

  /** H.265 8.5.3.3: predict one PU from its single external L0 reference. */
  private predictExternalBlock(
    pu: { x: number; y: number; width: number; height: number },
    mvXQpel: number,
    mvYQpel: number,
    reference: ReferenceImage,
    refIdxL0: number,
  ): void {
    if (reference.samplePredictionEnabled === false)
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: motion-only inter-layer reference used for sample prediction',
      );
    const weighted = this.sh.weightedPrediction?.l0[refIdxL0];
    if (this.pps.weightedPred && !weighted)
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: weighted P slice has no L0 prediction parameters',
      );
    [mvXQpel, mvYQpel] = this.clipExternalMotionVector(pu, mvXQpel, mvYQpel);
    const baseX = pu.x + (mvXQpel >> 2);
    const baseY = pu.y + (mvYQpel >> 2);
    const fracX = mvXQpel & 3;
    const fracY = mvYQpel & 3;
    for (let y = 0; y < pu.height; y++) {
      const dst = (pu.y + y) * this.w + pu.x;
      for (let x = 0; x < pu.width; x++) {
        const prediction = interpolateLumaPredictionSample(
          reference.y,
          reference.width,
          reference.height,
          baseX + x,
          baseY + y,
          fracX,
          fracY,
          this.sps.bitDepthLuma,
        );
        this.y[dst + x] = weighted
          ? explicitWeightedSample(
              prediction,
              weighted.lumaWeight,
              weighted.lumaOffset,
              this.sh.weightedPrediction!.lumaLog2WeightDenom,
              this.sps.bitDepthLuma,
              this.sps.highPrecisionOffsetsEnabled,
            )
          : defaultWeightedSample(prediction, this.sps.bitDepthLuma);
      }
    }

    if (this.sps.chromaFormatIdc === 0) return;
    const sub = chromaSubsampling(this.sps.chromaFormatIdc);
    const chromaMvX = (mvXQpel * 2) / sub.width;
    const chromaMvY = (mvYQpel * 2) / sub.height;
    const chromaX = pu.x / sub.width;
    const chromaY = pu.y / sub.height;
    const chromaWidth = pu.width / sub.width;
    const chromaHeight = pu.height / sub.height;
    const baseChromaX = chromaX + (chromaMvX >> 3);
    const baseChromaY = chromaY + (chromaMvY >> 3);
    const fracChromaX = chromaMvX & 7;
    const fracChromaY = chromaMvY & 7;
    for (let y = 0; y < chromaHeight; y++) {
      const dst = (chromaY + y) * this.cw + chromaX;
      for (let x = 0; x < chromaWidth; x++) {
        const predCb = interpolateChromaPredictionSample(
          reference.cb,
          this.cw,
          this.ch,
          baseChromaX + x,
          baseChromaY + y,
          fracChromaX,
          fracChromaY,
          this.sps.bitDepthChroma,
        );
        const predCr = interpolateChromaPredictionSample(
          reference.cr,
          this.cw,
          this.ch,
          baseChromaX + x,
          baseChromaY + y,
          fracChromaX,
          fracChromaY,
          this.sps.bitDepthChroma,
        );
        const chromaDenom = this.sh.weightedPrediction?.chromaLog2WeightDenom ?? 0;
        this.cb[dst + x] = weighted
          ? explicitWeightedSample(
              predCb,
              weighted.chromaWeight[0],
              weighted.chromaOffset[0],
              chromaDenom,
              this.sps.bitDepthChroma,
              this.sps.highPrecisionOffsetsEnabled,
            )
          : defaultWeightedSample(predCb, this.sps.bitDepthChroma);
        this.cr[dst + x] = weighted
          ? explicitWeightedSample(
              predCr,
              weighted.chromaWeight[1],
              weighted.chromaOffset[1],
              chromaDenom,
              this.sps.bitDepthChroma,
              this.sps.highPrecisionOffsetsEnabled,
            )
          : defaultWeightedSample(predCr, this.sps.bitDepthChroma);
      }
    }
  }

  /** Read a current-picture reference from already reconstructed samples. */
  private predictCurrentPictureBlock(
    pu: { x: number; y: number; width: number; height: number },
    mvXQpel: number,
    mvYQpel: number,
  ): MotionPredictionSamples {
    if ((mvXQpel & 3) !== 0 || (mvYQpel & 3) !== 0)
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: current-picture reference motion vector is not integer-sample aligned',
      );
    const sx = pu.x + (mvXQpel >> 2);
    const sy = pu.y + (mvYQpel >> 2);
    if (sx < 0 || sy < 0 || sx + pu.width > this.w || sy + pu.height > this.h)
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: current-picture reference block exceeds picture bounds',
      );
    if (
      sx < pu.x + pu.width &&
      pu.x < sx + pu.width &&
      sy < pu.y + pu.height &&
      pu.y < sy + pu.height
    ) {
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: current-picture reference block overlaps destination',
      );
    }
    for (let by = sy >> 2; by < (sy + pu.height) >> 2; by++) {
      for (let bx = sx >> 2; bx < (sx + pu.width) >> 2; bx++) {
        if (
          !this.isAvailableInCurrentSlice(bx << 2, by << 2) ||
          this.decodedY[by * this.bwY + bx] !== 1
        )
          throw new HeicError(
            'INVALID_BITSTREAM',
            'heic: current-picture reference block has not been reconstructed in this slice/tile',
          );
      }
    }

    const y = new Int32Array(pu.width * pu.height);
    const lumaInternalShift = Math.max(2, 14 - this.sps.bitDepthLuma);
    for (let row = 0; row < pu.height; row++) {
      const source = (sy + row) * this.w + sx;
      for (let column = 0; column < pu.width; column++)
        y[row * pu.width + column] = this.y[source + column] << lumaInternalShift;
    }

    const sub = chromaSubsampling(this.sps.chromaFormatIdc);
    const chromaWidth = this.sps.chromaFormatIdc ? pu.width / sub.width : 0;
    const chromaHeight = this.sps.chromaFormatIdc ? pu.height / sub.height : 0;
    const cb = new Int32Array(chromaWidth * chromaHeight);
    const cr = new Int32Array(cb.length);
    if (this.sps.chromaFormatIdc !== 0) {
      if (
        pu.x % sub.width !== 0 ||
        pu.y % sub.height !== 0 ||
        pu.width % sub.width !== 0 ||
        pu.height % sub.height !== 0
      )
        throw new HeicError(
          'INVALID_BITSTREAM',
          'heic: current-picture reference block is not aligned to the chroma sampling grid',
        );
      const chromaMvX = (mvXQpel * 2) / sub.width;
      const chromaMvY = (mvYQpel * 2) / sub.height;
      const destinationX = pu.x / sub.width;
      const destinationY = pu.y / sub.height;
      const baseX = destinationX + (chromaMvX >> 3);
      const baseY = destinationY + (chromaMvY >> 3);
      const fracX = chromaMvX & 7;
      const fracY = chromaMvY & 7;
      for (let row = 0; row < chromaHeight; row++) {
        for (let column = 0; column < chromaWidth; column++) {
          const index = row * chromaWidth + column;
          cb[index] = interpolateChromaPredictionSample(
            this.cb,
            this.cw,
            this.ch,
            baseX + column,
            baseY + row,
            fracX,
            fracY,
            this.sps.bitDepthChroma,
          );
          cr[index] = interpolateChromaPredictionSample(
            this.cr,
            this.cw,
            this.ch,
            baseX + column,
            baseY + row,
            fracX,
            fracY,
            this.sps.bitDepthChroma,
          );
        }
      }
    }
    return { y, cb, cr };
  }

  private predictListBlock(
    pu: { x: number; y: number; width: number; height: number },
    motion: L0MotionCandidate | L1MotionCandidate,
    reference: ReferenceImage,
  ): MotionPredictionSamples {
    if (reference.isCurrentPicture) return this.predictCurrentPictureBlock(pu, motion.x, motion.y);
    if (reference.samplePredictionEnabled === false)
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: motion-only inter-layer reference used for sample prediction',
      );
    const [mvXQpel, mvYQpel] = this.clipExternalMotionVector(pu, motion.x, motion.y);
    // Interpolation samples retain HEVC's internal offset. They can be
    // negative before the prediction lists are combined, so keep them signed.
    const yPlane = new Int32Array(pu.width * pu.height);
    const baseX = pu.x + (mvXQpel >> 2);
    const baseY = pu.y + (mvYQpel >> 2);
    const fracX = mvXQpel & 3;
    const fracY = mvYQpel & 3;
    for (let y = 0; y < pu.height; y++)
      for (let x = 0; x < pu.width; x++)
        yPlane[y * pu.width + x] = interpolateLumaPredictionSample(
          reference.y,
          reference.width,
          reference.height,
          baseX + x,
          baseY + y,
          fracX,
          fracY,
          this.sps.bitDepthLuma,
        );

    const sub = chromaSubsampling(this.sps.chromaFormatIdc);
    const chromaWidth = this.sps.chromaFormatIdc ? pu.width / sub.width : 0;
    const chromaHeight = this.sps.chromaFormatIdc ? pu.height / sub.height : 0;
    const cbPlane = new Int32Array(chromaWidth * chromaHeight);
    const crPlane = new Int32Array(cbPlane.length);
    if (this.sps.chromaFormatIdc !== 0) {
      const chromaMvX = (mvXQpel * 2) / sub.width;
      const chromaMvY = (mvYQpel * 2) / sub.height;
      const chromaX = pu.x / sub.width;
      const chromaY = pu.y / sub.height;
      const baseChromaX = chromaX + (chromaMvX >> 3);
      const baseChromaY = chromaY + (chromaMvY >> 3);
      const fracChromaX = chromaMvX & 7;
      const fracChromaY = chromaMvY & 7;
      for (let y = 0; y < chromaHeight; y++)
        for (let x = 0; x < chromaWidth; x++) {
          const index = y * chromaWidth + x;
          cbPlane[index] = interpolateChromaPredictionSample(
            reference.cb,
            this.cw,
            this.ch,
            baseChromaX + x,
            baseChromaY + y,
            fracChromaX,
            fracChromaY,
            this.sps.bitDepthChroma,
          );
          crPlane[index] = interpolateChromaPredictionSample(
            reference.cr,
            this.cw,
            this.ch,
            baseChromaX + x,
            baseChromaY + y,
            fracChromaX,
            fracChromaY,
            this.sps.bitDepthChroma,
          );
        }
    }
    return { y: yPlane, cb: cbPlane, cr: crPlane };
  }

  /** Combine L0/L1 predictions using H.265 default or explicit B weighting. */
  private predictBBlock(
    pu: { x: number; y: number; width: number; height: number },
    motion: InterMotionField,
  ): void {
    if (
      motion.predFlags === 0 ||
      Boolean(motion.predFlags & 1) !== Boolean(motion.l0) ||
      Boolean(motion.predFlags & 2) !== Boolean(motion.l1)
    )
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: B prediction flags do not match motion vectors',
      );
    const referenceL0 = motion.l0 ? this.referenceImages[motion.l0.refIdxL0] : undefined;
    const referenceL1 = motion.l1 ? this.referenceImagesL1[motion.l1.refIdxL1] : undefined;
    if ((motion.l0 && !referenceL0) || (motion.l1 && !referenceL1))
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: B prediction selects an unavailable reference',
      );
    const predictionL0 = motion.l0 ? this.predictListBlock(pu, motion.l0, referenceL0!) : null;
    const predictionL1 = motion.l1 ? this.predictListBlock(pu, motion.l1, referenceL1!) : null;
    const weightedPrediction = this.pps.weightedBipred;
    const weights = this.sh.weightedPrediction;
    if (weightedPrediction && !weights)
      throw new HeicError('INVALID_BITSTREAM', 'heic: weighted B slice has no prediction table');
    const weightL0 = motion.l0 ? weights?.l0[motion.l0.refIdxL0] : undefined;
    const weightL1 = motion.l1 ? weights?.l1[motion.l1.refIdxL1] : undefined;
    if (
      (motion.l0 && weightedPrediction && !weightL0) ||
      (motion.l1 && weightedPrediction && !weightL1)
    )
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: weighted B slice is missing per-reference values',
      );

    const writePlane = (
      component: 0 | 1 | 2,
      destination: Uint8Array | Uint16Array,
      destinationWidth: number,
      destinationX: number,
      destinationY: number,
      blockWidth: number,
      blockHeight: number,
      prediction0: Int32Array | null,
      prediction1: Int32Array | null,
      bitDepth: number,
    ): void => {
      const prediction0Weight =
        component === 0 ? weightL0?.lumaWeight : weightL0?.chromaWeight[component - 1];
      const prediction0Offset =
        component === 0 ? weightL0?.lumaOffset : weightL0?.chromaOffset[component - 1];
      const prediction1Weight =
        component === 0 ? weightL1?.lumaWeight : weightL1?.chromaWeight[component - 1];
      const prediction1Offset =
        component === 0 ? weightL1?.lumaOffset : weightL1?.chromaOffset[component - 1];
      const denominator =
        component === 0
          ? (weights?.lumaLog2WeightDenom ?? 0)
          : (weights?.chromaLog2WeightDenom ?? 0);
      const size = blockWidth * blockHeight;
      for (let index = 0; index < size; index++) {
        let sample: number;
        if (prediction0 && prediction1) {
          sample = weightedPrediction
            ? explicitBiWeightedSample(
                prediction0[index],
                prediction1[index],
                prediction0Weight!,
                prediction0Offset!,
                prediction1Weight!,
                prediction1Offset!,
                denominator,
                bitDepth,
                this.sps.highPrecisionOffsetsEnabled,
              )
            : defaultBiWeightedSample(prediction0[index], prediction1[index], bitDepth);
        } else if (prediction0) {
          sample = weightedPrediction
            ? explicitWeightedSample(
                prediction0[index],
                prediction0Weight!,
                prediction0Offset!,
                denominator,
                bitDepth,
                this.sps.highPrecisionOffsetsEnabled,
              )
            : defaultWeightedSample(prediction0[index], bitDepth);
        } else if (prediction1) {
          sample = weightedPrediction
            ? explicitWeightedSample(
                prediction1[index],
                prediction1Weight!,
                prediction1Offset!,
                denominator,
                bitDepth,
                this.sps.highPrecisionOffsetsEnabled,
              )
            : defaultWeightedSample(prediction1[index], bitDepth);
        } else {
          throw new HeicError('INVALID_BITSTREAM', 'heic: B prediction has no reference list');
        }
        const x = index % blockWidth;
        const y = Math.floor(index / blockWidth);
        destination[(destinationY + y) * destinationWidth + destinationX + x] = sample;
      }
    };

    writePlane(
      0,
      this.y,
      this.w,
      pu.x,
      pu.y,
      pu.width,
      pu.height,
      predictionL0?.y ?? null,
      predictionL1?.y ?? null,
      this.sps.bitDepthLuma,
    );
    if (this.sps.chromaFormatIdc === 0) return;
    const sub = chromaSubsampling(this.sps.chromaFormatIdc);
    const destinationX = pu.x / sub.width;
    const destinationY = pu.y / sub.height;
    const blockWidth = pu.width / sub.width;
    const blockHeight = pu.height / sub.height;
    writePlane(
      1,
      this.cb,
      this.cw,
      destinationX,
      destinationY,
      blockWidth,
      blockHeight,
      predictionL0?.cb ?? null,
      predictionL1?.cb ?? null,
      this.sps.bitDepthChroma,
    );
    writePlane(
      2,
      this.cr,
      this.cw,
      destinationX,
      destinationY,
      blockWidth,
      blockHeight,
      predictionL0?.cr ?? null,
      predictionL1?.cr ?? null,
      this.sps.bitDepthChroma,
    );
  }

  private setMotionRect(
    pu: { x: number; y: number; width: number; height: number },
    mvXQpel: number,
    mvYQpel: number,
    refIdxL0: number,
  ): void {
    for (let by = pu.y >> 2; by < (pu.y + pu.height) >> 2; by++) {
      const start = by * this.bwY + (pu.x >> 2);
      const end = by * this.bwY + ((pu.x + pu.width) >> 2);
      this.interMap.fill(1, start, end);
      this.motionPredFlags.fill(1, start, end);
      this.motionXQpel.fill(mvXQpel, start, end);
      this.motionYQpel.fill(mvYQpel, start, end);
      this.motionRefIdxL0.fill(refIdxL0, start, end);
      const reference = this.referenceImages[refIdxL0];
      this.motionIsExternal.fill(Number(!reference?.isCurrentPicture), start, end);
      this.motionRefPoc.fill(reference?.pictureOrderCnt ?? this.currentPictureOrderCnt, start, end);
      this.motionRefLongTerm.fill(Number(reference?.isLongTermReference ?? false), start, end);
      this.motionRefLayerId.fill(reference?.layerId ?? this.sps.layerId ?? 0, start, end);
      this.tuEdgesY[start] |= 1;
    }
    const top = (pu.y >> 2) * this.bwY + (pu.x >> 2);
    for (let bx = pu.x >> 2; bx < (pu.x + pu.width) >> 2; bx++)
      this.tuEdgesY[top + bx - (pu.x >> 2)] |= 2;
  }

  private setBMotionRect(
    pu: { x: number; y: number; width: number; height: number },
    motion: InterMotionField,
  ): void {
    const referenceL0 = motion.l0 ? this.referenceImages[motion.l0.refIdxL0] : undefined;
    const referenceL1 = motion.l1 ? this.referenceImagesL1[motion.l1.refIdxL1] : undefined;
    if ((motion.l0 && !referenceL0) || (motion.l1 && !referenceL1))
      throw new HeicError(
        'INVALID_BITSTREAM',
        'heic: B motion map selects an unavailable reference',
      );
    for (let by = pu.y >> 2; by < (pu.y + pu.height) >> 2; by++) {
      const start = by * this.bwY + (pu.x >> 2);
      const end = by * this.bwY + ((pu.x + pu.width) >> 2);
      this.interMap.fill(1, start, end);
      this.motionIsExternal.fill(
        Number(
          (referenceL0 !== undefined && !referenceL0.isCurrentPicture) ||
            (referenceL1 !== undefined && !referenceL1.isCurrentPicture),
        ),
        start,
        end,
      );
      this.motionPredFlags.fill(motion.predFlags, start, end);
      if (motion.l0) {
        this.motionXQpel.fill(motion.l0.x, start, end);
        this.motionYQpel.fill(motion.l0.y, start, end);
        this.motionRefIdxL0.fill(motion.l0.refIdxL0, start, end);
        this.motionRefPoc.fill(referenceL0!.pictureOrderCnt, start, end);
        this.motionRefLongTerm.fill(Number(referenceL0!.isLongTermReference), start, end);
        this.motionRefLayerId.fill(referenceL0!.layerId ?? this.sps.layerId ?? 0, start, end);
      }
      if (motion.l1) {
        this.motionXQpelL1.fill(motion.l1.x, start, end);
        this.motionYQpelL1.fill(motion.l1.y, start, end);
        this.motionRefIdxL1.fill(motion.l1.refIdxL1, start, end);
        this.motionRefPocL1.fill(referenceL1!.pictureOrderCnt, start, end);
        this.motionRefLongTermL1.fill(Number(referenceL1!.isLongTermReference), start, end);
        this.motionRefLayerIdL1.fill(referenceL1!.layerId ?? this.sps.layerId ?? 0, start, end);
      }
      this.tuEdgesY[start] |= 1;
    }
    const top = (pu.y >> 2) * this.bwY + (pu.x >> 2);
    for (let bx = pu.x >> 2; bx < (pu.x + pu.width) >> 2; bx++)
      this.tuEdgesY[top + bx - (pu.x >> 2)] |= 2;
  }

  private markInterCuDecoded(x: number, y: number, size: number): void {
    for (let by = y >> 2; by < (y + size) >> 2; by++) {
      this.decodedY.fill(1, by * this.bwY + (x >> 2), by * this.bwY + ((x + size) >> 2));
      const i = by * this.bwY + (x >> 2);
      this.tuEdgesY[i] |= 1;
      this.transformEdgesY[i] |= 1;
    }
    for (let bx = x >> 2; bx < (x + size) >> 2; bx++) {
      const i = (y >> 2) * this.bwY + bx;
      this.tuEdgesY[i] |= 2;
      this.transformEdgesY[i] |= 2;
    }
    if (this.sps.chromaFormatIdc !== 0) {
      const sub = chromaSubsampling(this.sps.chromaFormatIdc);
      const xC = x / sub.width;
      const yC = y / sub.height;
      const sizeC = size / sub.width;
      const x4 = xC >> 2;
      const y4 = yC >> 2;
      const width4 = Math.ceil(sizeC / 4);
      const height4 = Math.ceil(size / sub.height / 4);
      for (let by = y4; by < y4 + height4; by++) {
        this.decodedC.fill(1, by * this.bwC + x4, by * this.bwC + x4 + width4);
        this.tuEdgesC[by * this.bwC + x4] |= 1;
      }
      for (let bx = x4; bx < x4 + width4; bx++) this.tuEdgesC[y4 * this.bwC + bx] |= 2;
    }
  }

  private interMinTransformSizeInCu(log2CbSize: number, partMode: number): number {
    const hierarchy = this.sps.maxTransformHierarchyDepthInter;
    const interSplitFlag = hierarchy === 1 && partMode !== 0 ? 1 : 0;
    const maxDepthFromCu = hierarchy - 1 + interSplitFlag;
    if (log2CbSize < this.sps.log2MinTransformBlockSize + maxDepthFromCu)
      return this.sps.log2MinTransformBlockSize;
    return Math.min(this.sps.log2MaxTransformBlockSize, log2CbSize - maxDepthFromCu);
  }

  private intraMinTransformSizeInCu(log2CbSize: number, partNxN: boolean): number {
    const maxDepthFromCu = this.sps.maxTransformHierarchyDepthIntra - 1 + Number(partNxN);
    if (log2CbSize < this.sps.log2MinTransformBlockSize + maxDepthFromCu)
      return this.sps.log2MinTransformBlockSize;
    return Math.min(this.sps.log2MaxTransformBlockSize, log2CbSize - maxDepthFromCu);
  }

  /** Derive the CU QP used by neighbours and loop filters (8.6.1). */
  private deriveCuQp(): void {
    if (this.pps.cuQpDeltaEnabled) {
      if (this.qgPredPending) {
        this.qpYPred = this.predictQp();
        this.qgPredPending = false;
      }
      this.cuQp =
        ((this.qpYPred + this.cuQpDeltaVal + 52 + 2 * 6 * (this.bd - 8)) %
          (52 + 6 * (this.bd - 8))) -
        6 * (this.bd - 8);
    } else {
      this.cuQp = this.sh.sliceQpY;
    }
  }

  private setCuSkipMap(x: number, y: number, size: number, skipped: boolean): void {
    const value = skipped ? 1 : 0;
    for (let by = y >> 2; by < (y + size) >> 2; by++)
      this.cuSkipMap.fill(value, by * this.bwY + (x >> 2), by * this.bwY + ((x + size) >> 2));
  }

  /** H.265 7.3.8.13 / 8.4.4.2.7: decode and reconstruct one palette CU. */
  private paletteCodingUnit(x0: number, y0: number, log2CbSize: number, ctDepth: number): void {
    const size = 1 << log2CbSize;
    const area = size * size;
    const spsPalette = this.sps.screenContentExtension;
    if (!spsPalette?.paletteModeEnabled)
      throw new HeicError('INVALID_BITSTREAM', 'heic: palette CU without palette mode enabled');
    const maxPaletteSize = spsPalette.paletteMaxSize;
    const maxPredictorSize = maxPaletteSize + spsPalette.deltaPaletteMaxPredictorSize;
    const componentCount = this.sps.chromaFormatIdc === 0 ? 1 : 3;
    const predictorSize = this.predictorPalette[0]?.length ?? 0;
    if (
      this.predictorPalette.length !== componentCount ||
      this.predictorPalette.some((entries) => entries.length !== predictorSize)
    )
      throw new HeicError('INVALID_BITSTREAM', 'heic: invalid palette predictor state');

    const reuseFlags = new Uint8Array(predictorSize);
    let predictorEntryIdx = 0;
    let predictedCount = 0;
    let predictionFinished = false;
    while (
      predictorEntryIdx < predictorSize &&
      !predictionFinished &&
      predictedCount < maxPaletteSize
    ) {
      const run = this.decodeEgk(0);
      if (run === 1) {
        predictionFinished = true;
      } else {
        predictorEntryIdx += run > 1 ? run - 1 : 0;
        if (predictorEntryIdx >= predictorSize)
          throw new HeicError(
            'INVALID_BITSTREAM',
            `heic: palette predictor run ${run} at index ${predictorEntryIdx} exceeds table ${predictorSize} in CU (${x0},${y0})`,
          );
        reuseFlags[predictorEntryIdx] = 1;
        predictedCount++;
        predictorEntryIdx++;
      }
    }

    const signalledCount = predictedCount < maxPaletteSize ? this.decodeEgk(0) : 0;
    if (signalledCount > maxPaletteSize - predictedCount)
      throw new HeicError('INVALID_BITSTREAM', 'heic: current palette exceeds palette_max_size');

    const currentPalette = Array.from({ length: componentCount }, () => new Array<number>());
    for (let i = 0; i < predictorSize; i++)
      if (reuseFlags[i])
        for (let c = 0; c < componentCount; c++)
          currentPalette[c].push(this.predictorPalette[c][i]);
    for (let c = 0; c < componentCount; c++) {
      const bitDepth = c === 0 ? this.sps.bitDepthLuma : this.sps.bitDepthChroma;
      for (let i = 0; i < signalledCount; i++)
        currentPalette[c].push(this.cabac.decodeBypassBits(bitDepth));
    }
    const currentPaletteSize = predictedCount + signalledCount;
    const escapePresent = currentPaletteSize === 0 ? true : this.cabac.decodeBypass() === 1;
    const maxPaletteIndex = currentPaletteSize - 1 + Number(escapePresent);

    let numberOfIndices = 1;
    const paletteIndices: number[] = [];
    let copyAboveFinalRun = false;
    let transpose = false;
    if (maxPaletteIndex > 0) {
      const riceParam = 3 + ((maxPaletteIndex + 1) >> 3);
      const numIndicesMinus1 = this.decodePaletteNumIndicesMinus1(riceParam);
      numberOfIndices = numIndicesMinus1 + 1;
      if (numberOfIndices > area)
        throw new HeicError('INVALID_BITSTREAM', 'heic: palette index count exceeds the CU area');
      for (let i = 0; i < numberOfIndices; i++)
        paletteIndices.push(
          this.decodeTruncatedBinary(i === 0 ? maxPaletteIndex : maxPaletteIndex - 1),
        );
      copyAboveFinalRun = this.cabac.decodeBin(CTX.COPY_ABOVE_PALETTE) === 1;
      transpose = this.cabac.decodeBin(CTX.PALETTE_TRANSPOSE) === 1;
    }

    this.deriveCuQp();
    if (escapePresent) {
      if (this.pps.cuQpDeltaEnabled && !this.isCuQpDeltaCoded) {
        this.decodeCuQpDelta();
        this.cuQp =
          ((this.qpYPred + this.cuQpDeltaVal + 52 + 2 * 6 * (this.bd - 8)) %
            (52 + 6 * (this.bd - 8))) -
          6 * (this.bd - 8);
      }
      if (!this.cuBypass && this.pps.chromaQpOffsetListEnabled && !this.isCuChromaQpOffsetCoded)
        this.decodeCuChromaQpOffset();
    }

    const scan = getScan(SCAN_TRAV, size);
    const indexMap = new Uint16Array(area);
    const copyAboveMap = new Uint8Array(area);
    let remainingIndices = numberOfIndices;
    let scanPos = 0;
    while (scanPos < area) {
      const rasterPos = scan[scanPos];
      const x = rasterPos % size;
      const y = (rasterPos / size) | 0;
      let copyAbove = false;
      let runMinus1 = area - scanPos - 1;
      let currentIndex = 0;
      let currentIndexIdc = 0;

      if (maxPaletteIndex > 0) {
        const previousRasterPos = scanPos > 0 ? scan[scanPos - 1] : -1;
        if (scanPos >= size && previousRasterPos >= 0 && copyAboveMap[previousRasterPos] === 0) {
          if (remainingIndices > 0 && scanPos < area - 1)
            copyAbove = this.cabac.decodeBin(CTX.COPY_ABOVE_PALETTE) === 1;
          else if (scanPos === area - 1 && remainingIndices > 0) copyAbove = false;
          else copyAbove = true;
        }

        if (!copyAbove) {
          const currentIndexPosition = numberOfIndices - remainingIndices;
          if (currentIndexPosition < 0)
            throw new HeicError('INVALID_BITSTREAM', 'heic: palette index position is negative');
          // H.265 7.4.9.13 infers palette_idx_idc to zero when it is absent.
          currentIndexIdc = paletteIndices[currentIndexPosition] ?? 0;
          currentIndex = currentIndexIdc;
          let adjustedReference = maxPaletteIndex + 1;
          if (scanPos > 0) {
            const referenceRasterPos = scan[scanPos - 1];
            if (copyAboveMap[referenceRasterPos] === 0)
              adjustedReference = indexMap[referenceRasterPos];
            else {
              if (y === 0)
                throw new HeicError(
                  'INVALID_BITSTREAM',
                  'heic: palette copy-above has no upper row',
                );
              adjustedReference = indexMap[(y - 1) * size + x];
            }
          }
          if (currentIndex >= adjustedReference) currentIndex++;
          if (currentIndex > maxPaletteIndex)
            throw new HeicError('INVALID_BITSTREAM', 'heic: palette index is out of range');
        }

        if (!copyAbove) remainingIndices--;
        if (remainingIndices > 0 || copyAbove !== copyAboveFinalRun) {
          const maxRunMinus1 = area - scanPos - 1 - remainingIndices - Number(copyAboveFinalRun);
          if (maxRunMinus1 < 0)
            throw new HeicError('INVALID_BITSTREAM', 'heic: invalid final palette run length');
          if (maxRunMinus1 > 0) {
            const prefixMax = Math.floor(Math.log2(maxRunMinus1)) + 1;
            const prefix = this.decodePaletteRunPrefix(copyAbove, currentIndexIdc, prefixMax);
            let suffix = 0;
            if (prefix > 1 && maxRunMinus1 !== 2 ** (prefix - 1)) {
              const prefixOffset = 2 ** (prefix - 1);
              const suffixMax =
                2 * prefixOffset > maxRunMinus1 ? maxRunMinus1 - prefixOffset : prefixOffset - 1;
              suffix = this.decodeTruncatedBinary(suffixMax);
            }
            runMinus1 = prefix < 2 ? prefix : 2 ** (prefix - 1) + suffix;
            if (runMinus1 > maxRunMinus1)
              throw new HeicError(
                'INVALID_BITSTREAM',
                'heic: palette run exceeds its remaining block',
              );
          } else {
            runMinus1 = 0;
          }
        }
      }

      for (let runPos = 0; runPos <= runMinus1; runPos++) {
        const pos = scanPos + runPos;
        if (pos >= area)
          throw new HeicError('INVALID_BITSTREAM', 'heic: palette run exceeds the CU area');
        const currentRasterPos = scan[pos];
        const currentX = currentRasterPos % size;
        const currentY = (currentRasterPos / size) | 0;
        copyAboveMap[currentRasterPos] = Number(copyAbove);
        if (copyAbove) {
          if (currentY === 0)
            throw new HeicError(
              'INVALID_BITSTREAM',
              `heic: palette copy-above has no upper row in CU (${x0},${y0})`,
            );
          indexMap[currentRasterPos] = indexMap[(currentY - 1) * size + currentX];
        } else {
          indexMap[currentRasterPos] = currentIndex;
        }
      }
      scanPos += runMinus1 + 1;
    }
    const escapeValues = Array.from({ length: componentCount }, () => new Uint16Array(area));
    if (escapePresent) {
      for (let c = 0; c < componentCount; c++) {
        const bitDepth = c === 0 ? this.sps.bitDepthLuma : this.sps.bitDepthChroma;
        const maxSample = (1 << bitDepth) - 1;
        for (let pos = 0; pos < area; pos++) {
          if (indexMap[scan[pos]] !== maxPaletteIndex) continue;
          const rasterPos = scan[pos];
          const x = rasterPos % size;
          const y = (rasterPos / size) | 0;
          const isPresent =
            c === 0 ||
            this.sps.chromaFormatIdc === 3 ||
            (this.sps.chromaFormatIdc === 1 && (x & 1) === 0 && (y & 1) === 0) ||
            (this.sps.chromaFormatIdc === 2 && (transpose ? (y & 1) === 0 : (x & 1) === 0));
          if (!isPresent) continue;
          const value = this.cuBypass ? this.cabac.decodeBypassBits(bitDepth) : this.decodeEgk(3);
          if (value > maxSample)
            throw new HeicError(
              'INVALID_BITSTREAM',
              'heic: palette escape value exceeds bit depth',
            );
          escapeValues[c][rasterPos] = value;
        }
      }
    }
    this.reconstructPalettePlanes(
      x0,
      y0,
      size,
      indexMap,
      maxPaletteIndex,
      escapePresent,
      escapeValues,
      currentPalette,
      transpose,
    );

    const nextPredictor = currentPalette.map((entries) => entries.slice());
    for (let i = 0; i < predictorSize && nextPredictor[0].length < maxPredictorSize; i++) {
      if (reuseFlags[i]) continue;
      for (let c = 0; c < componentCount; c++) nextPredictor[c].push(this.predictorPalette[c][i]);
    }
    this.predictorPalette = nextPredictor;

    this.setIntraModes(x0, y0, size, 1);
    for (let by = y0 >> 2; by < (y0 + size) >> 2; by++)
      this.paletteMap.fill(1, by * this.bwY + (x0 >> 2), by * this.bwY + ((x0 + size) >> 2));
    if (this.sps.chromaFormatIdc === 3) {
      for (let by = y0 >> 2; by < (y0 + size) >> 2; by++) {
        this.chromaModeMap.fill(1, by * this.bwY + (x0 >> 2), by * this.bwY + ((x0 + size) >> 2));
        this.chromaDerivedMap.fill(
          1,
          by * this.bwY + (x0 >> 2),
          by * this.bwY + ((x0 + size) >> 2),
        );
      }
    }
    for (let by = y0 >> 2; by < (y0 + size) >> 2; by++)
      this.decodedY.fill(1, by * this.bwY + (x0 >> 2), by * this.bwY + ((x0 + size) >> 2));
    if (componentCount === 3) {
      const sub = chromaSubsampling(this.sps.chromaFormatIdc);
      const xC = x0 / sub.width;
      const yC = y0 / sub.height;
      const widthC = size / sub.width;
      const heightC = size / sub.height;
      for (let by = yC >> 2; by < Math.ceil((yC + heightC) / 4); by++)
        this.decodedC.fill(
          1,
          by * this.bwC + (xC >> 2),
          by * this.bwC + Math.ceil((xC + widthC) / 4),
        );
    }
    for (let by = y0 >> 2; by < (y0 + size) >> 2; by++)
      this.tuEdgesY[by * this.bwY + (x0 >> 2)] |= 1;
    for (let bx = x0 >> 2; bx < (x0 + size) >> 2; bx++)
      this.tuEdgesY[(y0 >> 2) * this.bwY + bx] |= 2;
    if (this.cuBypass)
      for (let by = y0 >> 2; by < (y0 + size) >> 2; by++)
        this.bypassMap.fill(1, by * this.bwY + (x0 >> 2), by * this.bwY + ((x0 + size) >> 2));

    this.setCtDepth(x0, y0, size, ctDepth);
    const qw = this.w >> 3;
    for (let by = y0 >> 3; by < Math.ceil((y0 + size) / 8); by++)
      for (let bx = x0 >> 3; bx < Math.ceil((x0 + size) / 8); bx++)
        this.qpMap[by * qw + bx] = this.cuQp;
    this.lastQpY = this.cuQp;
  }

  private reconstructPalettePlanes(
    x0: number,
    y0: number,
    size: number,
    indexMap: Uint16Array,
    maxPaletteIndex: number,
    escapePresent: boolean,
    escapeValues: Uint16Array[],
    palette: number[][],
    transpose: boolean,
  ): void {
    const componentCount = this.sps.chromaFormatIdc === 0 ? 1 : 3;
    const planes = [this.y, this.cb, this.cr];
    const bitDepths = [this.sps.bitDepthLuma, this.sps.bitDepthChroma, this.sps.bitDepthChroma];
    const qpOffsets = [
      0,
      this.sh.cbQpOffset + this.cuChromaQpOffsetCb,
      this.sh.crQpOffset + this.cuChromaQpOffsetCr,
    ];
    const sub = chromaSubsampling(this.sps.chromaFormatIdc);
    for (let c = 0; c < componentCount; c++) {
      const plane = planes[c];
      const subW = c === 0 ? 1 : sub.width;
      const subH = c === 0 ? 1 : sub.height;
      const width = size / subW;
      const height = size / subH;
      const xBase = x0 / subW;
      const yBase = y0 / subH;
      const stride = c === 0 ? this.w : this.cw;
      let qp = Math.max(0, this.cuQp + 6 * (bitDepths[c] - 8));
      if (c !== 0)
        qp = Math.max(
          0,
          mapChromaQp(this.cuQp, qpOffsets[c], this.bdC, this.sps.chromaFormatIdc) +
            6 * (this.bdC - 8),
        );
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++) {
          const xL = transpose ? y * subH : x * subW;
          const yL = transpose ? x * subW : y * subH;
          const rasterPos = yL * size + xL;
          const paletteIndex = indexMap[rasterPos];
          let value: number;
          if (escapePresent && paletteIndex === maxPaletteIndex) {
            const escape = escapeValues[c][rasterPos];
            value = this.cuBypass
              ? escape
              : Math.floor(
                  (escape * PALETTE_LEVEL_SCALE[qp % 6] * 2 ** Math.floor(qp / 6) + 32) / 64,
                );
          } else {
            value = palette[c][paletteIndex];
          }
          const maxValue = (1 << bitDepths[c]) - 1;
          plane[(yBase + y) * stride + xBase + x] =
            value < 0 ? 0 : value > maxValue ? maxValue : value;
        }
    }
  }

  private decodeEgk(initialOrder: number): number {
    let order = initialOrder;
    let base = 0;
    for (let prefix = 0; prefix < 32; prefix++) {
      if (this.cabac.decodeBypass() === 0) {
        if (order > 32)
          throw new HeicError('RESOURCE_LIMIT', 'heic: Exp-Golomb suffix is too long');
        let suffix = 0;
        for (let i = 0; i < order; i++) suffix = suffix * 2 + this.cabac.decodeBypass();
        // H.265 9.3.4.3.3: the suffix is added to the accumulated
        // prefix base; it is not concatenated after that base.
        return base + suffix;
      }
      base += 2 ** order;
      order++;
    }
    throw new HeicError('RESOURCE_LIMIT', 'heic: Exp-Golomb prefix is too long');
  }

  private decodeTruncatedRice(cMax: number, riceParam: number): number {
    const maxPrefix = cMax >> riceParam;
    let prefix = 0;
    while (prefix < maxPrefix && this.cabac.decodeBypass() === 1) prefix++;
    if (prefix === maxPrefix) return cMax + this.decodeEgk(riceParam + 1);
    let suffix = 0;
    for (let i = 0; i < riceParam; i++) suffix = suffix * 2 + this.cabac.decodeBypass();
    return (prefix << riceParam) + suffix;
  }

  /** H.265 9.3.4.3 palette num_palette_indices_minus1 (coef_remain with k). */
  private decodePaletteNumIndicesMinus1(riceParam: number): number {
    let prefix = 0;
    while (this.cabac.decodeBypass() === 1) prefix++;
    if (prefix < 3) return (prefix << riceParam) + this.cabac.decodeBypassBits(riceParam);
    if (prefix > 24)
      throw new HeicError('RESOURCE_LIMIT', 'heic: palette index count prefix exceeds limit');
    const suffixLength = prefix - 3 + riceParam;
    const base = ((2 ** (prefix - 3) + 2) << riceParam) >>> 0;
    return base + this.cabac.decodeBypassBits(suffixLength);
  }

  private decodeTruncatedBinary(cMax: number): number {
    if (!Number.isInteger(cMax) || cMax < 0)
      throw new HeicError('INVALID_BITSTREAM', 'heic: invalid truncated-binary maximum');
    const count = cMax + 1;
    const k = Math.floor(Math.log2(count));
    const u = 2 ** (k + 1) - count;
    let prefix = 0;
    for (let i = 0; i < k; i++) prefix = prefix * 2 + this.cabac.decodeBypass();
    if (prefix < u) return prefix;
    return prefix * 2 + this.cabac.decodeBypass() - u;
  }

  private decodePaletteRunPrefix(copyAbove: boolean, paletteIndex: number, cMax: number): number {
    let prefix = 0;
    while (prefix < cMax) {
      if (prefix >= 5) {
        if (this.cabac.decodeBypass() === 0) break;
        prefix++;
        continue;
      }
      let ctxInc: number;
      if (!copyAbove && prefix === 0) ctxInc = paletteIndex < 1 ? 0 : paletteIndex < 3 ? 1 : 2;
      else if (copyAbove) ctxInc = prefix === 0 ? 5 : prefix <= 2 ? 6 : 7;
      else ctxInc = prefix <= 2 ? 3 : 4;
      if (this.cabac.decodeBin(CTX.PALETTE_RUN_PREFIX + ctxInc) === 0) break;
      prefix++;
    }
    return prefix;
  }

  /** Decode one PCM CU without prediction or a transform tree. */
  private pcmCodingUnit(x0: number, y0: number, log2CbSize: number, ctDepth: number): void {
    const size = 1 << log2CbSize;
    this.cabac.alignPcmSamples();

    const lumaScale = this.bd - this.sps.pcmSampleBitDepthLuma;
    for (let y = 0; y < size; y++) {
      const row = (y0 + y) * this.w + x0;
      for (let x = 0; x < size; x++)
        this.y[row + x] = this.cabac.readPcmSample(this.sps.pcmSampleBitDepthLuma) << lumaScale;
    }

    if (this.sps.chromaFormatIdc !== 0) {
      const sub = chromaSubsampling(this.sps.chromaFormatIdc);
      const widthC = size / sub.width;
      const heightC = size / sub.height;
      const xC = x0 / sub.width;
      const yC = y0 / sub.height;
      const chromaScale = this.bdC - this.sps.pcmSampleBitDepthChroma;
      for (const plane of [this.cb, this.cr])
        for (let y = 0; y < heightC; y++) {
          const row = (yC + y) * this.cw + xC;
          for (let x = 0; x < widthC; x++)
            plane[row + x] =
              this.cabac.readPcmSample(this.sps.pcmSampleBitDepthChroma) << chromaScale;
        }

      for (let by = yC >> 2; by < Math.ceil((yC + heightC) / 4); by++)
        this.decodedC.fill(
          1,
          by * this.bwC + (xC >> 2),
          by * this.bwC + Math.ceil((xC + widthC) / 4),
        );
    }

    this.cabac.restartAfterPcm();

    // PCM neighbors contribute INTRA_DC to the intra mode candidate list.
    this.setIntraModes(x0, y0, size, 1);
    if (this.sps.chromaFormatIdc === 3)
      for (let by = y0 >> 2; by < (y0 + size) >> 2; by++) {
        this.chromaModeMap.fill(1, by * this.bwY + (x0 >> 2), by * this.bwY + ((x0 + size) >> 2));
        this.chromaDerivedMap.fill(
          1,
          by * this.bwY + (x0 >> 2),
          by * this.bwY + ((x0 + size) >> 2),
        );
      }

    for (let by = y0 >> 2; by < (y0 + size) >> 2; by++)
      this.decodedY.fill(1, by * this.bwY + (x0 >> 2), by * this.bwY + ((x0 + size) >> 2));

    // PCM contributes intra boundary strength at its perimeter; it has no TU
    // boundaries inside the coding unit.
    for (let by = y0 >> 2; by < (y0 + size) >> 2; by++)
      this.tuEdgesY[by * this.bwY + (x0 >> 2)] |= 1;
    for (let bx = x0 >> 2; bx < (x0 + size) >> 2; bx++)
      this.tuEdgesY[(y0 >> 2) * this.bwY + bx] |= 2;

    if (this.sps.pcmLoopFilterDisabled || this.cuBypass)
      for (let by = y0 >> 2; by < (y0 + size) >> 2; by++)
        this.bypassMap.fill(1, by * this.bwY + (x0 >> 2), by * this.bwY + ((x0 + size) >> 2));

    this.deriveCuQp();
    this.setCtDepth(x0, y0, size, ctDepth);
    const qw = this.w >> 3;
    for (let by = y0 >> 3; by < Math.ceil((y0 + size) / 8); by++)
      for (let bx = x0 >> 3; bx < Math.ceil((x0 + size) / 8); bx++)
        this.qpMap[by * qw + bx] = this.cuQp;
    this.lastQpY = this.cuQp;
  }

  private predictQp(): number {
    const qw = this.w >> 3;
    const inCtbX = (x: number): boolean => x >> this.log2Ctb === this.ctbX;
    const inCtbY = (y: number): boolean => y >> this.log2Ctb === this.ctbY;

    const availA =
      this.qgX > 0 &&
      inCtbX(this.qgX - 1) &&
      inCtbY(this.qgY) &&
      this.isAvailableInCurrentSlice(this.qgX - 1, this.qgY);
    const qpA = availA ? this.qpMap[(this.qgY >> 3) * qw + ((this.qgX - 1) >> 3)] : this.lastQpY;
    const availB =
      this.qgY > 0 &&
      inCtbY(this.qgY - 1) &&
      inCtbX(this.qgX) &&
      this.isAvailableInCurrentSlice(this.qgX, this.qgY - 1);
    const qpB = availB ? this.qpMap[((this.qgY - 1) >> 3) * qw + (this.qgX >> 3)] : this.lastQpY;
    return (qpA + qpB + 1) >> 1;
  }

  private mpmCandidates(xPb: number, yPb: number): number[] {
    // Left neighbor; above neighbor must be inside the current CTB row.
    const candA = this.isAvailableInCurrentSlice(xPb - 1, yPb) ? this.intraModeAt(xPb - 1, yPb) : 1;
    const candB =
      this.isAvailableInCurrentSlice(xPb, yPb - 1) && (yPb - 1) >> this.log2Ctb === this.ctbY
        ? this.intraModeAt(xPb, yPb - 1)
        : 1;

    if (candA === candB) {
      if (candA < 2) return [0, 1, 26];
      return [candA, 2 + ((candA + 29) % 32), 2 + ((candA - 2 + 1) % 32)];
    }
    const third = candA !== 0 && candB !== 0 ? 0 : candA !== 1 && candB !== 1 ? 1 : 26;
    return [candA, candB, third];
  }

  private intraModeAt(x: number, y: number): number {
    return this.intraModeMap[(y >> 2) * this.bwY + (x >> 2)];
  }

  private setIntraModes(x: number, y: number, size: number, mode: number): void {
    for (let by = y >> 2; by < (y + size) >> 2; by++) {
      const start = by * this.bwY + (x >> 2);
      const end = by * this.bwY + ((x + size) >> 2);
      this.intraModeMap.fill(mode, start, end);
      this.intraPredMap.fill(1, start, end);
    }
  }

  private setCtDepth(x: number, y: number, size: number, depth: number): void {
    for (let by = y >> 2; by < (y + size) >> 2; by++)
      this.ctDepthMap.fill(depth, by * this.bwY + (x >> 2), by * this.bwY + ((x + size) >> 2));
  }

  // --------------------------------------------------------- transform tree

  private transformTree(
    x0: number,
    y0: number,
    xBase: number,
    yBase: number,
    log2Size: number,
    trafoDepth: number,
    blkIdx: number,
    intraSplit: boolean,
    maxTrafoDepth: number,
    puModes: number[],
    parentCbfCb: number,
    parentCbfCr: number,
    inter = false,
    partMode = 0,
    minLog2SizeInCu = 0,
  ): void {
    let split: boolean;
    const forcedInterSplit =
      inter &&
      trafoDepth === 0 &&
      this.sps.maxTransformHierarchyDepthInter === 1 &&
      partMode !== 0 &&
      log2Size > minLog2SizeInCu;
    const forcedSplit =
      (intraSplit && trafoDepth === 0) ||
      forcedInterSplit ||
      log2Size > this.sps.log2MaxTransformBlockSize;
    if (forcedSplit) {
      split = true;
    } else if (
      inter &&
      log2Size > this.sps.log2MinTransformBlockSize &&
      log2Size > minLog2SizeInCu
    ) {
      split = this.cabac.decodeBin(CTX.SPLIT_TRANSFORM + (5 - log2Size)) === 1;
    } else if (
      !inter &&
      log2Size <= this.sps.log2MaxTransformBlockSize &&
      log2Size > this.sps.log2MinTransformBlockSize &&
      log2Size > minLog2SizeInCu &&
      trafoDepth < maxTrafoDepth
    ) {
      split = this.cabac.decodeBin(CTX.SPLIT_TRANSFORM + (5 - log2Size)) === 1;
    } else {
      split = false;
    }

    // For 4:2:2, bit 0 and bit 1 carry the upper and lower chroma-TB CBFs.
    // H.265 7.3.8.8 signals the second flag for an unsplit TU and for 8x8
    // luma nodes, where the chroma transform is two 4x4 blocks vertically.
    let cbfCb = this.sps.chromaFormatIdc !== 0 ? parentCbfCb : 0;
    let cbfCr = this.sps.chromaFormatIdc !== 0 ? parentCbfCr : 0;
    if (this.sps.chromaFormatIdc !== 0 && (log2Size > 2 || this.sps.chromaFormatIdc === 3)) {
      const canSignal = (parent: number) => trafoDepth === 0 || (parent & 1) !== 0;
      const signalLower = this.sps.chromaFormatIdc === 2 && (!split || log2Size === 3);
      cbfCb = canSignal(parentCbfCb) ? this.cabac.decodeBin(CTX.CBF_CHROMA + trafoDepth) : 0;
      if (signalLower && canSignal(parentCbfCb))
        cbfCb |= this.cabac.decodeBin(CTX.CBF_CHROMA + trafoDepth) << 1;
      cbfCr = canSignal(parentCbfCr) ? this.cabac.decodeBin(CTX.CBF_CHROMA + trafoDepth) : 0;
      if (signalLower && canSignal(parentCbfCr))
        cbfCr |= this.cabac.decodeBin(CTX.CBF_CHROMA + trafoDepth) << 1;
    }
    if (split) {
      const half = 1 << (log2Size - 1);
      this.transformTree(
        x0,
        y0,
        x0,
        y0,
        log2Size - 1,
        trafoDepth + 1,
        0,
        intraSplit,
        maxTrafoDepth,
        puModes,
        cbfCb,
        cbfCr,
        inter,
        partMode,
        minLog2SizeInCu,
      );
      this.transformTree(
        x0 + half,
        y0,
        x0,
        y0,
        log2Size - 1,
        trafoDepth + 1,
        1,
        intraSplit,
        maxTrafoDepth,
        puModes,
        cbfCb,
        cbfCr,
        inter,
        partMode,
        minLog2SizeInCu,
      );
      this.transformTree(
        x0,
        y0 + half,
        x0,
        y0,
        log2Size - 1,
        trafoDepth + 1,
        2,
        intraSplit,
        maxTrafoDepth,
        puModes,
        cbfCb,
        cbfCr,
        inter,
        partMode,
        minLog2SizeInCu,
      );
      this.transformTree(
        x0 + half,
        y0 + half,
        x0,
        y0,
        log2Size - 1,
        trafoDepth + 1,
        3,
        intraSplit,
        maxTrafoDepth,
        puModes,
        cbfCb,
        cbfCr,
        inter,
        partMode,
        minLog2SizeInCu,
      );
      return;
    }

    // At an inter CU root with no chroma CBF, cbf_luma is inferred to one.
    const cbfLuma =
      inter && trafoDepth === 0 && cbfCb === 0 && cbfCr === 0
        ? true
        : this.cabac.decodeBin(CTX.CBF_LUMA + (trafoDepth === 0 ? 1 : 0)) === 1;
    this.transformUnit(x0, y0, xBase, yBase, log2Size, blkIdx, cbfLuma, cbfCb, cbfCr, inter);
  }

  // --------------------------------------------------------- transform unit

  private transformUnit(
    x0: number,
    y0: number,
    xBase: number,
    yBase: number,
    log2Size: number,
    blkIdx: number,
    cbfLuma: boolean,
    cbfCb: number,
    cbfCr: number,
    inter = false,
  ): void {
    const size = 1 << log2Size;
    if (inter) {
      // Inter transform and prediction boundaries share the same 8x8-grid
      // deblocking process as intra boundaries.
      for (let by = y0 >> 2; by < (y0 + size) >> 2; by++) {
        const i = by * this.bwY + (x0 >> 2);
        this.tuEdgesY[i] |= 1;
        this.transformEdgesY[i] |= 1;
      }
      for (let bx = x0 >> 2; bx < (x0 + size) >> 2; bx++) {
        const i = (y0 >> 2) * this.bwY + bx;
        this.tuEdgesY[i] |= 2;
        this.transformEdgesY[i] |= 2;
      }
      if (cbfLuma)
        for (let by = y0 >> 2; by < (y0 + size) >> 2; by++)
          this.cbfYMap.fill(1, by * this.bwY + (x0 >> 2), by * this.bwY + ((x0 + size) >> 2));
    }
    // cbfChroma refers to the PARENT node's chroma cbfs for 4x4 TUs at any
    // blkIdx (7.3.8.10) — the qp delta can be coded at blkIdx 0 even though
    // the chroma residual itself only follows at blkIdx 3.
    const chromaHere = this.sps.chromaFormatIdc === 3 || log2Size > 2 || blkIdx === 3;
    const cbfChroma = cbfCb !== 0 || cbfCr !== 0;
    const hasResidual = cbfLuma || cbfChroma;
    const actAvailable =
      hasResidual &&
      this.cuActFlagAssociated &&
      this.pps.screenContentExtension?.residualAdaptiveColourTransformEnabled === true;
    const actEnabled = actAvailable && this.cabac.decodeBin(CTX.COLOUR_TRANSFORM_FLAG) === 1;
    if (hasResidual && this.pps.cuQpDeltaEnabled && !this.isCuQpDeltaCoded) {
      this.decodeCuQpDelta();
      this.cuQp =
        ((this.qpYPred + this.cuQpDeltaVal + 52 + 2 * 6 * (this.bd - 8)) %
          (52 + 6 * (this.bd - 8))) -
        6 * (this.bd - 8);
    }
    if (
      cbfChroma &&
      !this.cuBypass &&
      this.pps.chromaQpOffsetListEnabled &&
      !this.isCuChromaQpOffsetCoded
    )
      this.decodeCuChromaQpOffset();

    const lumaMode = this.intraModeAt(x0, y0);
    const lumaLevels = cbfLuma ? this.residualCoding(x0, y0, log2Size, 0, lumaMode, inter) : null;
    if (!chromaHere || this.sps.chromaFormatIdc === 0) {
      if (inter) {
        this.applyInterResidual(
          this.y,
          this.w,
          x0,
          y0,
          size,
          this.inverseResidual(lumaLevels, size, 0, lumaMode, this.cuQp, null, 0, true),
        );
      } else {
        this.reconstruct(
          this.y,
          this.w,
          this.decodedY,
          this.bwY,
          this.tuEdgesY,
          x0,
          y0,
          size,
          lumaMode,
          0,
          lumaLevels,
          this.cuQp,
        );
      }
      return;
    }

    // Chroma TBs: at this node (log2 > 2) or on the parent's area (blkIdx 3).
    const chromaFormat = this.sps.chromaFormatIdc;
    const fullChroma = chromaFormat === 3;
    const sub = chromaSubsampling(chromaFormat);
    const log2C = fullChroma ? log2Size : Math.max(2, log2Size - 1);
    const xL = log2Size === 2 ? xBase : x0;
    const yL = log2Size === 2 ? yBase : y0;
    const xC = fullChroma ? x0 : Math.floor(xL / sub.width);
    const yC = fullChroma ? y0 : Math.floor(yL / sub.height);
    let mode = fullChroma
      ? this.chromaModeMap[(y0 >> 2) * this.bwY + (x0 >> 2)]
      : this.cuChromaMode;
    const chromaModeDerived =
      fullChroma && this.chromaDerivedMap[(y0 >> 2) * this.bwY + (x0 >> 2)] === 1;
    if (chromaFormat === 2) mode = CHROMA_422_MODE_MAP[mode];
    const sizeC = 1 << log2C;
    const qpCb = fullChroma
      ? Math.max(
          -6 * (this.bdC - 8),
          Math.min(51, this.cuQp + this.sh.cbQpOffset + this.cuChromaQpOffsetCb),
        )
      : mapChromaQp(
          this.cuQp,
          this.sh.cbQpOffset + this.cuChromaQpOffsetCb,
          this.bdC,
          chromaFormat,
        );
    const qpCr = fullChroma
      ? Math.max(
          -6 * (this.bdC - 8),
          Math.min(51, this.cuQp + this.sh.crQpOffset + this.cuChromaQpOffsetCr),
        )
      : mapChromaQp(
          this.cuQp,
          this.sh.crQpOffset + this.cuChromaQpOffsetCr,
          this.bdC,
          chromaFormat,
        );

    if (actEnabled) {
      if (!fullChroma || sizeC !== size)
        throw new HeicError('UNSUPPORTED_FEATURE', 'heic: ACT reconstruction requires 4:4:4 TUs');

      const residualY =
        this.inverseResidual(lumaLevels, size, 0, lumaMode, this.actQp(0), null, 0, inter) ??
        new Int32Array(size * size);
      const residualCb = new Int32Array(size * size);
      const residualCr = new Int32Array(size * size);
      const crossComponentPrediction =
        (inter || chromaModeDerived) && this.pps.crossComponentPredictionEnabled && cbfLuma;
      const residuals: [Int32Array, Int32Array, Int32Array] = [residualY, residualCb, residualCr];

      for (const [cIdx, cbf] of [
        [1, cbfCb],
        [2, cbfCr],
      ] as const) {
        const crossScale = crossComponentPrediction ? this.decodeCrossComponentScale(cIdx - 1) : 0;
        const levels = cbf !== 0 ? this.residualCoding(x0, y0, log2Size, cIdx, mode, inter) : null;
        residuals[cIdx] =
          this.inverseResidual(
            levels,
            size,
            cIdx,
            mode,
            this.actQp(cIdx),
            crossComponentPrediction ? residualY : null,
            crossScale,
            inter,
          ) ?? new Int32Array(size * size);
      }

      const [actY, actCb, actCr] = inverseActResidualTransform(
        residuals,
        this.sps.bitDepthLuma,
        this.sps.bitDepthChroma,
        this.sps.extendedPrecisionProcessingEnabled,
        this.cuBypass,
      );
      if (inter) {
        this.applyInterResidual(this.y, this.w, x0, y0, size, actY);
        this.applyInterResidual(this.cb, this.cw, xC, yC, sizeC, actCb);
        this.applyInterResidual(this.cr, this.cw, xC, yC, sizeC, actCr);
      } else {
        this.reconstruct(
          this.y,
          this.w,
          this.decodedY,
          this.bwY,
          this.tuEdgesY,
          x0,
          y0,
          size,
          lumaMode,
          0,
          lumaLevels,
          this.cuQp,
          null,
          0,
          actY,
        );
        this.reconstruct(
          this.cb,
          this.cw,
          this.decodedC,
          this.bwC,
          this.tuEdgesC,
          xC,
          yC,
          sizeC,
          mode,
          1,
          cbfCb !== 0 ? residuals[1] : null,
          qpCb,
          null,
          0,
          actCb,
        );
        this.reconstruct(
          this.cr,
          this.cw,
          this.decodedC,
          this.bwC,
          this.tuEdgesC,
          xC,
          yC,
          sizeC,
          mode,
          2,
          cbfCr !== 0 ? residuals[2] : null,
          qpCr,
          null,
          0,
          actCr,
        );
      }
      return;
    }

    const lumaResidual = inter
      ? this.inverseResidual(lumaLevels, size, 0, lumaMode, this.cuQp, null, 0, true)
      : this.reconstruct(
          this.y,
          this.w,
          this.decodedY,
          this.bwY,
          this.tuEdgesY,
          x0,
          y0,
          size,
          lumaMode,
          0,
          lumaLevels,
          this.cuQp,
        );
    if (inter) this.applyInterResidual(this.y, this.w, x0, y0, size, lumaResidual);

    const chromaTbs = chromaFormat === 2 ? 2 : 1;
    for (const [cIdx, plane, qp, cbf] of [
      [1, this.cb, qpCb, cbfCb],
      [2, this.cr, qpCr, cbfCr],
    ] as const) {
      const crossComponentPrediction =
        (inter || chromaModeDerived) && this.pps.crossComponentPredictionEnabled && cbfLuma;
      const crossComponentScale = crossComponentPrediction
        ? this.decodeCrossComponentScale(cIdx - 1)
        : 0;
      for (let tIdx = 0; tIdx < chromaTbs; tIdx++) {
        const yTb = yC + tIdx * sizeC;
        const levels =
          cbf & (1 << tIdx)
            ? this.residualCoding(xC * sub.width, yTb * sub.height, log2C, cIdx, mode, inter)
            : null;
        if (inter) {
          this.applyInterResidual(
            plane,
            this.cw,
            xC,
            yTb,
            sizeC,
            this.inverseResidual(
              levels,
              sizeC,
              cIdx,
              mode,
              qp,
              crossComponentPrediction ? lumaResidual : null,
              crossComponentScale,
              true,
            ),
          );
        } else {
          this.reconstruct(
            plane,
            this.cw,
            this.decodedC,
            this.bwC,
            this.tuEdgesC,
            xC,
            yTb,
            sizeC,
            mode,
            cIdx,
            levels,
            qp,
            crossComponentPrediction ? lumaResidual : null,
            crossComponentScale,
          );
        }
      }
    }
  }

  private actQp(cIdx: 0 | 1 | 2): number {
    const screen = this.pps.screenContentExtension;
    if (!screen) return this.cuQp;
    const offsetPlus =
      cIdx === 0
        ? screen.actYQpOffsetPlus5 - 5
        : cIdx === 1
          ? screen.actCbQpOffsetPlus5 - 5
          : screen.actCrQpOffsetPlus3 - 3;
    const sliceOffset =
      cIdx === 0
        ? this.sh.sliceActYQpOffset
        : cIdx === 1
          ? this.sh.sliceActCbQpOffset
          : this.sh.sliceActCrQpOffset;
    const actOffset = offsetPlus + sliceOffset;
    if (cIdx === 0) {
      const qpBdOffset = 6 * (this.bd - 8);
      return Math.max(-qpBdOffset, Math.min(51, this.cuQp + actOffset));
    }
    const chromaOffset = cIdx === 1 ? this.cuChromaQpOffsetCb : this.cuChromaQpOffsetCr;
    return mapChromaQp(this.cuQp, actOffset + chromaOffset, this.bdC, this.sps.chromaFormatIdc);
  }

  /** H.265 7.3.8.12 and FFmpeg's HEVC CABAC implementation: TR unary. */
  private decodeCrossComponentScale(component: number): number {
    let log2ResScaleAbsPlus1 = 0;
    while (
      log2ResScaleAbsPlus1 < 4 &&
      this.cabac.decodeBin(CTX.LOG2_RES_SCALE_ABS + 4 * component + log2ResScaleAbsPlus1) === 1
    )
      log2ResScaleAbsPlus1++;
    if (log2ResScaleAbsPlus1 === 0) return 0;
    const sign = this.cabac.decodeBin(CTX.RES_SCALE_SIGN + component);
    return (1 << (log2ResScaleAbsPlus1 - 1)) * (1 - 2 * sign);
  }

  private decodeCuQpDelta(): void {
    // cu_qp_delta_abs: TR prefix (cMax 5, ctx0 then ctx1) + EG0 suffix.
    let prefix = 0;
    if (this.cabac.decodeBin(CTX.CU_QP_DELTA) === 1) {
      prefix = 1;
      while (prefix < 5 && this.cabac.decodeBin(CTX.CU_QP_DELTA + 1) === 1) prefix++;
    }
    let abs = prefix;
    if (prefix === 5) {
      // EG0 suffix, bypass.
      let k = 0;
      let value = 0;
      while (this.cabac.decodeBypass() === 1) {
        value += 1 << k;
        k++;
      }
      abs = 5 + value + this.cabac.decodeBypassBits(k);
    }
    if (abs > 0 && this.cabac.decodeBypass() === 1) abs = -abs;
    this.cuQpDeltaVal = abs;
    this.isCuQpDeltaCoded = true;
  }

  private decodeCuChromaQpOffset(): void {
    if (this.cabac.decodeBin(CTX.CU_CHROMA_QP_OFFSET_FLAG) === 1) {
      let index = 0;
      while (
        index < this.pps.cbQpOffsetList.length - 1 &&
        this.cabac.decodeBin(CTX.CU_CHROMA_QP_OFFSET_IDX) === 1
      )
        index++;
      this.cuChromaQpOffsetCb = this.pps.cbQpOffsetList[index];
      this.cuChromaQpOffsetCr = this.pps.crQpOffsetList[index];
    } else {
      this.cuChromaQpOffsetCb = 0;
      this.cuChromaQpOffsetCr = 0;
    }
    this.isCuChromaQpOffsetCoded = true;
  }

  // -------------------------------------------------------- reconstruction

  private inverseResidual(
    levels: Int32Array | null,
    size: number,
    cIdx: number,
    mode: number,
    qp: number,
    lumaResidual: Int32Array | null = null,
    crossComponentScale = 0,
    inter = false,
  ): Int32Array | null {
    const bitDepth = cIdx === 0 ? this.bd : this.bdC;
    const rotateCoeffs = !inter && this.sps.transformSkipRotationEnabled && size === 4;
    let residual: Int32Array | null = null;
    // Transform-skip rotation is only applied when transform_skip_flag is set;
    // cu_transquant_bypass_flag skips this syntax and uses residual DPCM only.
    if (levels && this.cuBypass) residual = levels;
    else if (levels) {
      const sizeId = 31 - Math.clz32(size) - 2;
      // H.265 7.4.5 signals separate intra and inter matrices for each
      // component; 8.6.3 selects the matrix for this TU's prediction mode.
      const factors = this.scalingFactors[sizeId][cIdx + (inter ? 3 : 0)];
      const skipped = this.transformSkipped.has(levels);
      const extendedPrecision = this.sps.extendedPrecisionProcessingEnabled;
      const deq = dequantize(
        levels,
        size,
        qp + 6 * (bitDepth - 8),
        bitDepth,
        factors,
        skipped,
        extendedPrecision,
      );
      if (skipped) {
        const bdShift = Math.max(20 - bitDepth, extendedPrecision ? 11 : 0);
        const tsShift = 5 + (31 - Math.clz32(size));
        const shift = bdShift - tsShift;
        const skippedResidual = deq.map((value) =>
          shift > 0 ? (value + (1 << (shift - 1))) >> shift : value * 2 ** -shift,
        );
        residual = rotateCoeffs ? rotateBlock180(skippedResidual, size) : skippedResidual;
      } else
        residual = inverseTransform(
          deq,
          size,
          bitDepth,
          !inter && cIdx === 0 && size === 4,
          extendedPrecision,
        );
    }

    if (
      residual &&
      !inter &&
      this.sps.implicitRdpcmEnabled &&
      (this.cuBypass || (levels && this.transformSkipped.has(levels))) &&
      (mode === 10 || mode === 26)
    )
      residual = inverseResidualDpcm(residual, size, mode === 10 ? 'horizontal' : 'vertical');

    const explicitRdpcmDirection = levels ? this.explicitRdpcm.get(levels) : undefined;
    if (residual && explicitRdpcmDirection)
      residual = inverseResidualDpcm(residual, size, explicitRdpcmDirection);

    if (cIdx !== 0 && lumaResidual && crossComponentScale !== 0) {
      if (!residual) residual = new Int32Array(size * size);
      // H.265 8.6.3 scales luma residuals to the chroma transform range before
      // cross-component prediction when the component bit depths differ.
      for (let i = 0; i < residual.length; i++)
        residual[i] +=
          (crossComponentScale * Math.floor(lumaResidual[i] * 2 ** (this.bdC - this.bd))) >> 3;
    }
    return residual;
  }

  private applyInterResidual(
    plane: Uint8Array | Uint16Array,
    stride: number,
    x: number,
    y: number,
    size: number,
    residual: Int32Array | null,
  ): void {
    if (!residual) return;
    const planeHeight = plane === this.y ? this.h : this.ch;
    for (let dy = 0; dy < size; dy++) {
      const row = (y + dy) * stride + x;
      for (let dx = 0; dx < size; dx++) {
        const value = plane[row + dx] + residual[dy * size + dx];
        const bitDepth = plane === this.y ? this.bd : this.bdC;
        plane[row + dx] = value < 0 ? 0 : value > (1 << bitDepth) - 1 ? (1 << bitDepth) - 1 : value;
      }
    }
    // The parser validates component plane coordinates before reaching here;
    // retain the guard as a defensive check for malformed SPS/PPS geometry.
    if (y + size > planeHeight)
      throw new HeicError('INVALID_BITSTREAM', 'heic: inter residual exceeds plane bounds');
  }

  private reconstruct(
    plane: Uint8Array | Uint16Array,
    stride: number,
    decodedMap: Uint8Array,
    blockStride: number,
    edgeMap: Uint8Array,
    x: number,
    y: number,
    size: number,
    mode: number,
    cIdx: number,
    levels: Int32Array | null,
    qp: number,
    lumaResidual: Int32Array | null = null,
    crossComponentScale = 0,
    residualOverride?: Int32Array | null,
  ): Int32Array {
    const bitDepth = cIdx === 0 ? this.bd : this.bdC;
    const planeH = cIdx === 0 ? this.h : this.ch;
    const sliceSub =
      cIdx === 0 ? { width: 1, height: 1 } : chromaSubsampling(this.sps.chromaFormatIdc);
    const available = (px: number, py: number): boolean => {
      if (px < 0 || py < 0 || px >= stride || py >= planeH) return false;
      const lumaX = px * sliceSub.width;
      const lumaY = py * sliceSub.height;
      return (
        this.sliceIdByCtb[(lumaY >> this.log2Ctb) * this.widthInCtbs + (lumaX >> this.log2Ctb)] ===
          this.currentSliceId &&
        this.tileIdByCtb[(lumaY >> this.log2Ctb) * this.widthInCtbs + (lumaX >> this.log2Ctb)] ===
          this.tileIdByCtb[this.ctbY * this.widthInCtbs + this.ctbX] &&
        decodedMap[(py >> 2) * blockStride + (px >> 2)] === 1 &&
        (!this.pps.constrainedIntraPred ||
          this.intraPredMap[(lumaY >> 2) * this.bwY + (lumaX >> 2)] === 1)
      );
    };

    const refs = gatherRefs(plane, stride, x, y, size, bitDepth, available);
    if (!(this.sps.rangeFlags & 8))
      filterRefs(
        refs,
        size,
        mode,
        this.sps.chromaFormatIdc === 3 ? 0 : cIdx,
        bitDepth,
        cIdx === 0 && this.sps.strongIntraSmoothingEnabled,
      );
    const disableIntraBoundaryFilter =
      this.sps.screenContentExtension?.intraBoundaryFilteringDisabled === true ||
      (this.sps.implicitRdpcmEnabled && this.cuBypass);
    const pred = predictIntra(refs, size, mode, cIdx, bitDepth, disableIntraBoundaryFilter);
    // This decoder accepts I-slice CUs only, so every reconstructed CU is
    // MODE_INTRA (the other condition in H.265 8.6.2's rotateCoeffs rule).
    const residual =
      residualOverride === undefined
        ? this.inverseResidual(levels, size, cIdx, mode, qp, lumaResidual, crossComponentScale)
        : residualOverride;

    for (let dy = 0; dy < size; dy++) {
      const row = (y + dy) * stride + x;
      for (let dx = 0; dx < size; dx++) {
        let v = pred[dy * size + dx];
        if (residual) v += residual[dy * size + dx];
        plane[row + dx] = v < 0 ? 0 : v > (1 << bitDepth) - 1 ? (1 << bitDepth) - 1 : v;
      }
    }

    for (let by = y >> 2; by < (y + size) >> 2; by++)
      decodedMap.fill(1, by * blockStride + (x >> 2), by * blockStride + ((x + size) >> 2));

    // Record TU edges for deblocking (left edge, top edge).
    for (let by = y >> 2; by < (y + size) >> 2; by++) edgeMap[by * blockStride + (x >> 2)] |= 1;
    for (let bx = x >> 2; bx < (x + size) >> 2; bx++) edgeMap[(y >> 2) * blockStride + bx] |= 2;
    return residual ?? new Int32Array(size * size);
  }

  // ------------------------------------------------------- residual coding

  private residualCoding(
    x0: number,
    y0: number,
    log2Size: number,
    cIdx: number,
    predMode: number,
    inter = false,
  ): Int32Array {
    const size = 1 << log2Size;
    const levels = new Int32Array(size * size);
    const cabac = this.cabac;
    // H.265 7.3.8.11: this flag precedes last_sig_coeff even when zero.
    let transformSkipped = false;
    if (
      !this.cuBypass &&
      this.pps.transformSkipEnabled &&
      log2Size <= this.pps.log2MaxTransformSkipBlockSize
    ) {
      transformSkipped = cabac.decodeBin(CTX.TRANSFORM_SKIP + (cIdx ? 1 : 0)) === 1;
      if (transformSkipped) this.transformSkipped.add(levels);
    }

    let explicitRdpcmDirection: 'horizontal' | 'vertical' | undefined;
    if (
      inter &&
      this.sps.explicitRdpcmEnabled &&
      (transformSkipped || this.cuBypass) &&
      cabac.decodeBin(CTX.EXPLICIT_RDPCM_FLAG + (cIdx === 0 ? 0 : 1)) === 1
    ) {
      const vertical = cabac.decodeBin(CTX.EXPLICIT_RDPCM_DIR + (cIdx === 0 ? 0 : 1)) === 1;
      explicitRdpcmDirection = vertical ? 'vertical' : 'horizontal';
      this.explicitRdpcm.set(levels, explicitRdpcmDirection);
    }
    // Mode-dependent scan (7.4.9.11).
    let scanIdx = SCAN_DIAG;
    if (
      !inter &&
      (log2Size === 2 || (log2Size === 3 && (cIdx === 0 || this.sps.chromaFormatIdc === 3)))
    ) {
      if (predMode >= 6 && predMode <= 14) scanIdx = 2;
      else if (predMode >= 22 && predMode <= 30) scanIdx = 1;
    }

    // Last significant coefficient position (9.3.4.2.3).
    let lastX = this.decodeLastPrefix(log2Size, cIdx, CTX.LAST_SIG_X);
    let lastY = this.decodeLastPrefix(log2Size, cIdx, CTX.LAST_SIG_Y);
    if (lastX > 3) {
      const bits = (lastX >> 1) - 1;
      lastX = ((2 + (lastX & 1)) << bits) + cabac.decodeBypassBits(bits);
    }
    if (lastY > 3) {
      const bits = (lastY >> 1) - 1;
      lastY = ((2 + (lastY & 1)) << bits) + cabac.decodeBypassBits(bits);
    }
    if (scanIdx === 2) {
      const t = lastX;
      lastX = lastY;
      lastY = t;
    }
    const numSb = size >> 2;
    const sbScan = getScan(scanIdx, numSb);
    const posScan = getScan(scanIdx, 4);

    const lastSbRaster = (lastY >> 2) * numSb + (lastX >> 2);
    const lastPosRaster = ((lastY & 3) << 2) + (lastX & 3);
    let lastSbIdx = -1;
    for (let i = 0; i < numSb * numSb; i++) {
      if (sbScan[i] === lastSbRaster) {
        lastSbIdx = i;
        break;
      }
    }
    let lastPosIdx = -1;
    for (let nIdx = 0; nIdx < 16; nIdx++) {
      if (posScan[nIdx] === lastPosRaster) {
        lastPosIdx = nIdx;
        break;
      }
    }

    const csbf = new Uint8Array(numSb * numSb);
    let prevSubsetG1 = false;
    let firstSubset = true;

    for (let i = lastSbIdx; i >= 0; i--) {
      const sbRaster = sbScan[i];
      const xS = sbRaster % numSb;
      const yS = (sbRaster / numSb) | 0;
      const csbfRight = xS + 1 < numSb ? csbf[sbRaster + 1] : 0;
      const csbfBelow = yS + 1 < numSb ? csbf[sbRaster + numSb] : 0;

      let inferSbDcSig = false;
      if (i < lastSbIdx && i > 0) {
        const ctxInc = Math.min(1, csbfRight + csbfBelow) + (cIdx > 0 ? 2 : 0);
        const csbfBit = cabac.decodeBin(CTX.CODED_SUB_BLOCK + ctxInc);
        if (csbfBit === 0) continue;
        csbf[sbRaster] = 1;
        inferSbDcSig = true;
      } else {
        csbf[sbRaster] = 1;
      }

      // Significance map: positions n (descending scan order) with coeffs.
      const sigPos: number[] = [];
      if (i === lastSbIdx) sigPos.push(lastPosIdx);
      const startN = i === lastSbIdx ? lastPosIdx - 1 : 15;
      for (let pos = startN; pos >= 0; pos--) {
        if (pos > 0 || !inferSbDcSig) {
          const raster = posScan[pos];
          const xP = raster & 3;
          const yP = raster >> 2;
          const ctxInc = this.sigCtxInc(
            log2Size,
            cIdx,
            xS * 4 + xP,
            yS * 4 + yP,
            xP,
            yP,
            scanIdx,
            csbfRight,
            csbfBelow,
            xS,
            yS,
            transformSkipped,
          );
          const sigBit = cabac.decodeBin(CTX.SIG_COEFF + ctxInc);
          if (sigBit === 1) {
            sigPos.push(pos);
            inferSbDcSig = false;
          }
        } else {
          sigPos.push(pos); // inferred significant DC
        }
      }
      if (sigPos.length === 0) continue;

      // coeff_abs_level_greater1 (up to 8), greater2 (at most 1).
      let ctxSet = i === 0 || cIdx > 0 ? 0 : 2;
      if (!firstSubset && prevSubsetG1) ctxSet++;
      firstSubset = false;

      let g1Ctx = 1;
      let firstG1 = -1;
      const g1: number[] = [];
      for (let c = 0; c < sigPos.length; c++) {
        if (c < 8) {
          const ctxInc = ctxSet * 4 + Math.min(3, g1Ctx) + (cIdx > 0 ? 16 : 0);
          const flag = cabac.decodeBin(CTX.GREATER1 + ctxInc);
          g1.push(flag);
          if (flag === 1) {
            if (firstG1 < 0) firstG1 = c;
            g1Ctx = 0;
          } else if (g1Ctx > 0) {
            g1Ctx++;
          }
        } else {
          g1.push(0);
        }
      }
      prevSubsetG1 = firstG1 >= 0;

      let g2 = 0;
      if (firstG1 >= 0) {
        const ctxInc = ctxSet + (cIdx > 0 ? 4 : 0);
        g2 = cabac.decodeBin(CTX.GREATER2 + ctxInc);
      }

      // 7.3.8.11 derives escapeDataPresent from the greater-than flags and
      // coefficient count. It is true exactly when at least one remaining
      // level is present; align once before the bypass-coded signs and levels.
      const escapeDataPresent = sigPos.some((_, c) => {
        const base = 1 + (c < 8 ? g1[c] : 0) + (c === firstG1 ? g2 : 0);
        const threshold = c < 8 ? (c === firstG1 ? 3 : 2) : 1;
        return base === threshold;
      });
      if (this.sps.cabacBypassAlignmentEnabled && escapeDataPresent) cabac.alignBypass();

      // Signs (sign hiding applies to the lowest scan position).
      const lastN = sigPos[0];
      const firstN = sigPos[sigPos.length - 1];
      const signHidden =
        !this.cuBypass &&
        !explicitRdpcmDirection &&
        !(
          this.sps.implicitRdpcmEnabled &&
          transformSkipped &&
          (predMode === 10 || predMode === 26)
        ) &&
        this.pps.signDataHidingEnabled &&
        lastN - firstN > 3;
      const signs: number[] = [];
      for (let c = 0; c < sigPos.length; c++) {
        if (signHidden && sigPos[c] === firstN) signs.push(0);
        else signs.push(cabac.decodeBypass());
      }

      // Levels: base + coeff_abs_level_remaining with Rice adaptation.
      const persistentRice = this.sps.persistentRiceAdaptationEnabled;
      const sbType = (cIdx === 0 ? 2 : 0) + (transformSkipped || this.cuBypass ? 1 : 0);
      const initRiceValue = persistentRice ? this.ctxs.statCoeff[sbType] >> 2 : 0;
      let cRice = initRiceValue;
      let riceStatsUpdated = false;
      let sumAbs = 0;
      const absLevels: number[] = [];
      for (let c = 0; c < sigPos.length; c++) {
        const base = 1 + (c < 8 ? g1[c] : 0) + (c === firstG1 ? g2 : 0);
        const threshold = c < 8 ? (c === firstG1 ? 3 : 2) : 1;
        let level = base;
        if (base === threshold) {
          const rem = this.decodeRemaining(cRice, cIdx);
          level += rem;
          if (level > 3 * (1 << cRice)) cRice = persistentRice ? cRice + 1 : Math.min(cRice + 1, 4);
          if (persistentRice && !riceStatsUpdated) {
            const stat = this.ctxs.statCoeff[sbType];
            if (rem >= 3 * (1 << initRiceValue)) this.ctxs.statCoeff[sbType] = stat + 1;
            else if (2 * rem < 1 << initRiceValue && stat > 0)
              this.ctxs.statCoeff[sbType] = stat - 1;
            riceStatsUpdated = true;
          }
        }
        sumAbs += level;
        absLevels.push(level);
      }

      for (let c = 0; c < sigPos.length; c++) {
        const pos = sigPos[c];
        const raster = posScan[pos];
        const xC = xS * 4 + (raster & 3);
        const yC = yS * 4 + (raster >> 2);
        let negative = signs[c] === 1;
        if (signHidden && pos === firstN) negative = (sumAbs & 1) === 1;
        levels[yC * size + xC] = negative ? -absLevels[c] : absLevels[c];
      }
    }

    return levels;
  }

  private decodeLastPrefix(log2Size: number, cIdx: number, base: number): number {
    const cMax = (log2Size << 1) - 1;
    const offset = cIdx === 0 ? 3 * (log2Size - 2) + ((log2Size - 1) >> 2) : 15;
    const shift = cIdx === 0 ? (log2Size + 1) >> 2 : log2Size - 2;
    let i = 0;
    while (i < cMax) {
      const ctxIdx = base + offset + (i >> shift);
      const bin = this.cabac.decodeBin(ctxIdx);
      if (bin === 0) break;
      i++;
    }
    return i;
  }

  private sigCtxInc(
    log2Size: number,
    cIdx: number,
    xC: number,
    yC: number,
    xP: number,
    yP: number,
    scanIdx: number,
    csbfRight: number,
    csbfBelow: number,
    xS: number,
    yS: number,
    transformSkipped: boolean,
  ): number {
    if (this.sps.transformSkipContextEnabled && (transformSkipped || this.cuBypass))
      return cIdx === 0 ? 42 : 43;

    const chromaOffset = cIdx > 0 ? 27 : 0;
    if (log2Size === 2) return CTX_IDX_MAP_4X4[(yC << 2) + xC] + chromaOffset;
    if (xC + yC === 0) return chromaOffset;

    const prevCsbf = csbfRight + 2 * csbfBelow;
    let sigCtx: number;
    if (prevCsbf === 0) sigCtx = xP + yP === 0 ? 2 : xP + yP < 3 ? 1 : 0;
    else if (prevCsbf === 1) sigCtx = yP === 0 ? 2 : yP === 1 ? 1 : 0;
    else if (prevCsbf === 2) sigCtx = xP === 0 ? 2 : xP === 1 ? 1 : 0;
    else sigCtx = 2;

    if (cIdx === 0 && (xS > 0 || yS > 0)) sigCtx += 3;
    if (log2Size === 3) sigCtx += cIdx !== 0 || scanIdx === SCAN_DIAG ? 9 : 15;
    else sigCtx += cIdx === 0 ? 21 : 12;
    return sigCtx + chromaOffset;
  }

  private decodeRemaining(cRice: number, cIdx: number): number {
    if (this.sps.extendedPrecisionProcessingEnabled) {
      const bitDepth = cIdx === 0 ? this.sps.bitDepthLuma : this.sps.bitDepthChroma;
      const log2TransformRange = Math.max(15, bitDepth + 6);
      const maxPrefixExtensionLength = 28 - log2TransformRange;
      let prefix = 0;
      while (prefix < 4 && this.cabac.decodeBypass() === 1) prefix++;
      if (prefix < 4) return (prefix << cRice) + this.cabac.decodeBypassBits(cRice);

      // coeff_abs_level_remaining first uses a four-bin truncated-Rice
      // prefix. Only the suffix after cMax is limited EGk with k = cRice + 1.
      const cMax = 4 << cRice;
      const riceParam = cRice + 1;
      let prefixExtensionLength = 0;
      while (prefixExtensionLength < maxPrefixExtensionLength) {
        if (this.cabac.decodeBypass() === 0) break;
        prefixExtensionLength++;
      }
      const escapeLength =
        prefixExtensionLength === maxPrefixExtensionLength
          ? log2TransformRange
          : prefixExtensionLength + riceParam;
      const suffix = this.cabac.decodeBypassBits(escapeLength);
      return cMax + (2 ** prefixExtensionLength - 1) * 2 ** riceParam + suffix;
    }

    let prefix = 0;
    while (prefix < 32 && this.cabac.decodeBypass() === 1) prefix++;
    if (prefix <= 3) return (prefix << cRice) + this.cabac.decodeBypassBits(cRice);
    return (((1 << (prefix - 3)) + 2) << cRice) + this.cabac.decodeBypassBits(prefix - 3 + cRice);
  }
}
