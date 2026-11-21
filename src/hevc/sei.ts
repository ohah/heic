import { HeicError } from '../errors.js';
import { BitReader, toRbsp } from './nal.js';

export interface HevcMasteringDisplayColourVolume {
  /** Coded primary order; coordinates use 0.00002 units. RGB order is suggested as G, B, R. */
  displayPrimaries: readonly [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];
  /** Coded x/y coordinates in units of 0.00002. */
  whitePoint: { x: number; y: number };
  /** Coded values in units of 0.0001 cd/m². */
  maxDisplayMasteringLuminance: number;
  /** Coded values in units of 0.0001 cd/m². */
  minDisplayMasteringLuminance: number;
}

export interface HevcContentLightLevelInfo {
  /** Coded values in cd/m². */
  maxContentLightLevel: number;
  /** Coded values in cd/m². */
  maxPicAverageLightLevel: number;
}

export interface HevcAlternativeTransferCharacteristics {
  /** H.273 transfer_characteristics code from the SEI, as coded. */
  preferredTransferCharacteristics: number;
}

export interface HevcAmbientViewingEnvironment {
  /** Coded environmental illuminance in units of 0.0001 lux. */
  ambientIlluminance: number;
  /** Coded CIE 1931 x/y coordinates in units of 0.00002. */
  ambientLightX: number;
  /** Coded CIE 1931 x/y coordinates in units of 0.00002. */
  ambientLightY: number;
}

export interface HevcContentColourVolume {
  persistence: boolean;
  /** Coded primary order; RGB order is suggested as G, B, R. */
  primaries?: readonly [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];
  /** Coded normalized values in units of 0.0000001. */
  minLuminanceValue?: number;
  /** Coded normalized values in units of 0.0000001. */
  maxLuminanceValue?: number;
  /** Coded normalized values in units of 0.0000001. */
  averageLuminanceValue?: number;
}

/** Coded display-orientation SEI message; messages are retained in NAL order. */
export interface HevcDisplayOrientation {
  /** Cancels a previous persistent display-orientation message. */
  cancelled: boolean;
  /** Whether this transform persists for subsequent pictures of the layer. */
  persistence?: boolean;
  /** H.274 Table 19 transform code (0–7). */
  transformType?: number;
}

/** Picture structure signalled for the access unit by picture_timing SEI. */
export interface HevcPictureTimingInfo {
  /** H.265 Table D.2 picture structure code. */
  picStruct: number;
  sourceScanType: number;
  duplicate: boolean;
}

/** Coded H.274 phase-indication ratios relative to the rendering window. */
export interface HevcPhaseIndication {
  horizontalPhaseNum: number;
  horizontalPhaseDenMinus1: number;
  verticalPhaseNum: number;
  verticalPhaseDenMinus1: number;
}

export interface HevcFilmGrainIntensityInterval {
  lowerBound: number;
  upperBound: number;
  /** Signed Exp-Golomb model parameters, in the order carried by the SEI. */
  modelValues: readonly number[];
}

export interface HevcFilmGrainComponentModel {
  intensityIntervals: readonly HevcFilmGrainIntensityInterval[];
}

export interface HevcFilmGrainCharacteristicsCancel {
  cancelled: true;
}

export interface HevcFilmGrainCharacteristicsData {
  cancelled: false;
  modelId: number;
  separateColourDescriptionPresent: boolean;
  colourDescription?: {
    bitDepthLumaMinus8: number;
    bitDepthChromaMinus8: number;
    fullRange: boolean;
    colourPrimaries: number;
    transferCharacteristics: number;
    matrixCoefficients: number;
  };
  blendingModeId: number;
  log2ScaleFactor: number;
  /** Component order is Y, Cb, Cr; a null entry means no model was signalled. */
  componentModels: readonly [
    HevcFilmGrainComponentModel | null,
    HevcFilmGrainComponentModel | null,
    HevcFilmGrainComponentModel | null,
  ];
  persistence: boolean;
  /** Present in the H.274 V4 SEI extension when spatial resolution is signalled. */
  spatialResolution?: { width: number; height: number };
}

/** Coded H.274 film-grain messages in NAL order; synthesis is not applied. */
export type HevcFilmGrainCharacteristics =
  | HevcFilmGrainCharacteristicsCancel
  | HevcFilmGrainCharacteristicsData;

export type HevcToneMappingModel =
  | { modelId: 0; minValue: number; maxValue: number }
  | { modelId: 1; sigmoidMidpoint: number; sigmoidWidth: number }
  | { modelId: 2; startOfCodedIntervals: readonly number[] }
  | {
      modelId: 3;
      pivots: readonly { codedValue: number; targetValue: number }[];
    }
  | {
      modelId: 4;
      cameraIsoSpeedIdc: number;
      cameraIsoSpeedValue?: number;
      exposureIndexIdc: number;
      exposureIndexValue?: number;
      exposureCompensationNegative: boolean;
      exposureCompensationNumerator: number;
      exposureCompensationDenominatorIdc: number;
      referenceScreenLuminanceWhite: number;
      extendedRangeWhiteLevel: number;
      nominalBlackLevelCodeValue: number;
      nominalWhiteLevelCodeValue: number;
      extendedWhiteLevelCodeValue: number;
    };

export interface HevcToneMappingInfoCancel {
  cancelled: true;
  toneMapId: number;
}

export interface HevcToneMappingInfoData {
  cancelled: false;
  toneMapId: number;
  persistence: boolean;
  codedDataBitDepth: number;
  targetBitDepth: number;
  model: HevcToneMappingModel;
}

/** Coded H.265 tone-mapping messages in NAL order; models 0–3 can be applied to RGBA8 output. */
export type HevcToneMappingInfo = HevcToneMappingInfoCancel | HevcToneMappingInfoData;

export interface HevcKneeFunctionPoint {
  input: number;
  output: number;
}

export interface HevcKneeFunctionInfoCancel {
  cancelled: true;
  kneeFunctionId: number;
}

export interface HevcKneeFunctionInfoData {
  cancelled: false;
  kneeFunctionId: number;
  persistence: boolean;
  inputDynamicRange: number;
  inputDisplayLuminance: number;
  outputDynamicRange: number;
  outputDisplayLuminance: number;
  points: readonly HevcKneeFunctionPoint[];
}

/** Coded H.265 knee-function messages in NAL order; no mapping is applied. */
export type HevcKneeFunctionInfo = HevcKneeFunctionInfoCancel | HevcKneeFunctionInfoData;

export interface HevcColourRemappingLutPoint {
  codedValue: number;
  targetValue: number;
}

export interface HevcColourRemappingLut {
  /** Coded count field; zero means the standard's implicit endpoint mapping. */
  numValMinus1: number;
  /** Explicit pivots in coded order; empty when the endpoints are implicit. */
  points: readonly HevcColourRemappingLutPoint[];
}

export interface HevcColourRemappingInfoCancel {
  cancelled: true;
  colourRemapId: number;
}

export interface HevcColourRemappingInfoData {
  cancelled: false;
  colourRemapId: number;
  persistence: boolean;
  videoSignalInfo?: {
    fullRange: boolean;
    primaries: number;
    transferFunction: number;
    matrixCoefficients: number;
  };
  inputBitDepth: number;
  outputBitDepth: number;
  /** Component order is Y/Cb/Cr or G/B/R, as specified by H.265. */
  preLuts: readonly [HevcColourRemappingLut, HevcColourRemappingLut, HevcColourRemappingLut];
  matrix?: {
    log2Denom: number;
    coefficients: readonly [
      readonly [number, number, number],
      readonly [number, number, number],
      readonly [number, number, number],
    ];
  };
  postLuts: readonly [HevcColourRemappingLut, HevcColourRemappingLut, HevcColourRemappingLut];
}

/** Coded H.265 colour-remapping messages in NAL order; remapping is not applied. */
export type HevcColourRemappingInfo = HevcColourRemappingInfoCancel | HevcColourRemappingInfoData;

export interface HevcChromaResamplingFilter {
  tapLengthMinus1: number;
  coefficients: readonly number[];
}

/** Coded H.265 chroma-resampling filter hint for optional display processing. */
export interface HevcChromaResamplingFilterHint {
  verticalFilterIdc: number;
  horizontalFilterIdc: number;
  verticalFilteringFieldProcessing: boolean;
  targetFormatIdc?: number;
  verticalFilters?: readonly HevcChromaResamplingFilter[];
  horizontalFilters?: readonly HevcChromaResamplingFilter[];
}

/** Coded post-filter/correlation hint values in component, row, then column order. */
export interface HevcPostFilterHint {
  filterHintSizeY: number;
  filterHintSizeX: number;
  filterHintType: 0 | 1 | 2;
  /** One luma matrix for monochrome, otherwise Y, Cb, and Cr matrices. */
  filterHintValues: readonly (readonly (readonly number[])[])[];
}

export interface HevcHdrSeiMetadata {
  masteringDisplayColourVolume?: HevcMasteringDisplayColourVolume;
  contentLightLevelInfo?: HevcContentLightLevelInfo;
  alternativeTransferCharacteristics?: HevcAlternativeTransferCharacteristics;
  ambientViewingEnvironment?: HevcAmbientViewingEnvironment;
  /** `null` records a CCV cancellation message for the selected picture. */
  contentColourVolume?: HevcContentColourVolume | null;
}

export interface HevcSeiMetadata extends HevcHdrSeiMetadata {
  /** Picture timing for the selected access unit, when frame-field info is present. */
  pictureTiming?: HevcPictureTimingInfo;
  /** Display-orientation messages in bitstream order. */
  displayOrientation?: HevcDisplayOrientation[];
  /** Phase-indication messages in NAL order; renderer alignment is opt-in. */
  phaseIndication?: HevcPhaseIndication[];
  /** Film-grain model messages in bitstream order; synthesis is not applied. */
  filmGrainCharacteristics?: HevcFilmGrainCharacteristics[];
  /** Tone-mapping model messages in bitstream order; models 0–3 can be applied to RGBA8 output. */
  toneMappingInfo?: HevcToneMappingInfo[];
  /** Knee-function messages in bitstream order; pixel mapping is not applied. */
  kneeFunctionInfo?: HevcKneeFunctionInfo[];
  /** Colour-remapping messages in bitstream order; pixel remapping is not applied. */
  colourRemappingInfo?: HevcColourRemappingInfo[];
  /** Chroma-resampling hints in NAL order; filtering is opt-in. */
  chromaResamplingFilterHint?: HevcChromaResamplingFilterHint[];
  /** Post-filter/correlation hints in NAL order; FIR application is opt-in. */
  postFilterHint?: HevcPostFilterHint[];
}

export interface HevcDepthRepresentationValue {
  sign: boolean;
  exponent: number;
  mantissaLength: number;
  mantissa: number;
}

export interface HevcDepthRepresentationInformation {
  zNear?: HevcDepthRepresentationValue;
  zFar?: HevcDepthRepresentationValue;
  dMin?: HevcDepthRepresentationValue;
  dMax?: HevcDepthRepresentationValue;
  disparityReferenceViewId?: number;
  /** Preserved as coded; this API does not convert depth/disparity to distance. */
  representationType: number;
  nonlinearRepresentationModels?: number[];
}

export interface HevcAlphaChannelInformation {
  cancelled: boolean;
  /** Values above 2 are reserved; H.274 requires their semantics to be ignored. */
  useIdc?: number;
  bitDepth?: number;
  transparentValue?: number;
  opaqueValue?: number;
  increment?: boolean;
  clip?: boolean;
  clipType?: number;
}

/** Auxiliary-image SEI metadata carried by the HEIF auxC subtype. */
export interface HevcAuxiliarySeiMetadata {
  /** Kept in NAL order. Values describe coded metadata, not interpreted samples. */
  depthRepresentationInfo: HevcDepthRepresentationInformation[];
  /** Kept in NAL order; these flags are reported but not applied to alpha samples. */
  alphaChannelInfo: HevcAlphaChannelInformation[];
}

const SEI_PREFIX = 39;
const SEI_SUFFIX = 40;
const MASTERING_DISPLAY_COLOUR_VOLUME = 137;
const CONTENT_LIGHT_LEVEL_INFO = 144;
const ALTERNATIVE_TRANSFER_CHARACTERISTICS = 147;
const AMBIENT_VIEWING_ENVIRONMENT = 148;
const CONTENT_COLOUR_VOLUME = 149;
const DISPLAY_ORIENTATION = 47;
const PHASE_INDICATION = 212;
const FILM_GRAIN_CHARACTERISTICS = 19;
const TONE_MAPPING_INFO = 23;
const POST_FILTER_HINT = 22;
const CHROMA_RESAMPLING_FILTER_HINT = 140;
const KNEE_FUNCTION_INFO = 141;
const COLOUR_REMAPPING_INFO = 142;

function invalid(message: string): never {
  throw new HeicError('INVALID_BITSTREAM', `heic: ${message}`);
}

function readExtendedValue(data: Uint8Array, offset: number, label: string): [number, number] {
  let value = 0;
  while (offset < data.length && data[offset] === 0xff) {
    value += 255;
    offset++;
    if (value > 0x7fffffff) invalid(`HEVC SEI ${label} exceeds the supported range`);
  }
  if (offset >= data.length) invalid(`truncated HEVC SEI ${label}`);
  value += data[offset++];
  return [value, offset];
}

function u16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function u32(data: Uint8Array, offset: number): number {
  return (
    data[offset] * 0x1000000 + (data[offset + 1] << 16) + (data[offset + 2] << 8) + data[offset + 3]
  );
}

function parseMasteringDisplayColourVolume(payload: Uint8Array): HevcMasteringDisplayColourVolume {
  if (payload.length !== 24) invalid('invalid mastering_display_colour_volume SEI payload size');
  const displayPrimaries = [0, 1, 2].map((index) => ({
    x: u16(payload, index * 4),
    y: u16(payload, index * 4 + 2),
  })) as unknown as HevcMasteringDisplayColourVolume['displayPrimaries'];
  return {
    displayPrimaries,
    whitePoint: { x: u16(payload, 12), y: u16(payload, 14) },
    maxDisplayMasteringLuminance: u32(payload, 16),
    minDisplayMasteringLuminance: u32(payload, 20),
  };
}

function parseContentLightLevelInfo(payload: Uint8Array): HevcContentLightLevelInfo {
  if (payload.length !== 4) invalid('invalid content_light_level_info SEI payload size');
  return {
    maxContentLightLevel: u16(payload, 0),
    maxPicAverageLightLevel: u16(payload, 2),
  };
}

function parsePhaseIndication(payload: Uint8Array): HevcPhaseIndication {
  if (payload.length !== 4) invalid('invalid phase_indication SEI payload size');
  const phase: HevcPhaseIndication = {
    horizontalPhaseNum: payload[0],
    horizontalPhaseDenMinus1: payload[1],
    verticalPhaseNum: payload[2],
    verticalPhaseDenMinus1: payload[3],
  };
  if (phase.horizontalPhaseNum > phase.horizontalPhaseDenMinus1 + 1)
    invalid('invalid horizontal phase_indication ratio');
  if (phase.verticalPhaseNum > phase.verticalPhaseDenMinus1 + 1)
    invalid('invalid vertical phase_indication ratio');
  return phase;
}

function bitAt(data: Uint8Array, position: number): number {
  return (data[position >> 3] >> (7 - (position & 7))) & 1;
}

/** Validate the optional payload extension and its one-bit/zero padding. */
function validatePayloadEnd(payload: Uint8Array, reader: BitReader): void {
  const bitLength = payload.length * 8;
  if (reader.bitPosition > bitLength) invalid('HEVC SEI payload exceeds its declared size');
  if (reader.bitPosition === bitLength) return;

  let marker = bitLength - 1;
  while (marker >= reader.bitPosition && bitAt(payload, marker) === 0) marker--;
  if (marker < reader.bitPosition) invalid('missing HEVC SEI payload_bit_equal_to_one');
  for (let position = marker + 1; position < bitLength; position++)
    if (bitAt(payload, position) !== 0) invalid('invalid HEVC SEI payload alignment bits');
}

/** True when syntax bits remain before the payload_bit_equal_to_one marker. */
function hasPayloadExtension(payload: Uint8Array, reader: BitReader): boolean {
  const bitLength = payload.length * 8;
  let marker = bitLength - 1;
  while (marker >= reader.bitPosition && bitAt(payload, marker) === 0) marker--;
  return marker > reader.bitPosition;
}

function parseFilmGrainCharacteristics(payload: Uint8Array): HevcFilmGrainCharacteristics {
  const reader = new BitReader(payload),
    cancelled = reader.readBit() === 1;
  if (cancelled) {
    validatePayloadEnd(payload, reader);
    return { cancelled };
  }

  const modelId = reader.readBits(2),
    separateColourDescriptionPresent = reader.readBit() === 1;
  const colourDescription = separateColourDescriptionPresent
    ? {
        bitDepthLumaMinus8: reader.readBits(3),
        bitDepthChromaMinus8: reader.readBits(3),
        fullRange: reader.readBit() === 1,
        colourPrimaries: reader.readBits(8),
        transferCharacteristics: reader.readBits(8),
        matrixCoefficients: reader.readBits(8),
      }
    : undefined;
  const blendingModeId = reader.readBits(2),
    log2ScaleFactor = reader.readBits(4),
    componentPresent = [reader.readBit() === 1, reader.readBit() === 1, reader.readBit() === 1];
  const componentModels = componentPresent.map((present) => {
    if (!present) return null;
    const intervalCount = reader.readBits(8) + 1,
      modelValueCount = reader.readBits(3) + 1;
    if (modelValueCount > 6) invalid('film_grain num_model_values_minus1 is out of range');
    const intensityIntervals = Array.from({ length: intervalCount }, () => ({
      lowerBound: reader.readBits(8),
      upperBound: reader.readBits(8),
      modelValues: Array.from({ length: modelValueCount }, () => reader.se()),
    }));
    return { intensityIntervals };
  }) as [
    HevcFilmGrainComponentModel | null,
    HevcFilmGrainComponentModel | null,
    HevcFilmGrainComponentModel | null,
  ];
  const persistence = reader.readBit() === 1;
  let spatialResolution: { width: number; height: number } | undefined;
  if (hasPayloadExtension(payload, reader)) {
    if (reader.readBit()) {
      const width = reader.ue(),
        height = reader.ue();
      if (width < 1 || width > 65_536 || height < 1 || height > 65_536)
        invalid('film_grain spatial resolution is out of range');
      spatialResolution = { width, height };
    }
  }
  validatePayloadEnd(payload, reader);
  return {
    cancelled,
    modelId,
    separateColourDescriptionPresent,
    ...(colourDescription ? { colourDescription } : {}),
    blendingModeId,
    log2ScaleFactor,
    componentModels,
    persistence,
    ...(spatialResolution ? { spatialResolution } : {}),
  };
}

function parseToneMappingInfo(payload: Uint8Array): HevcToneMappingInfo | undefined {
  const reader = new BitReader(payload),
    toneMapId = readHevcUe32(reader, 'tone_map_id'),
    cancelled = reader.readBit() === 1;
  if (cancelled) {
    validatePayloadEnd(payload, reader);
    if (isReservedHevcSeiId(toneMapId)) return undefined;
    return { cancelled, toneMapId };
  }
  if (isReservedHevcSeiId(toneMapId)) return undefined;

  const persistence = reader.readBit() === 1,
    codedDataBitDepth = reader.readBits(8),
    targetBitDepth = reader.readBits(8),
    modelId = reader.ue();
  if (
    codedDataBitDepth < 8 ||
    codedDataBitDepth > 14 ||
    targetBitDepth < 1 ||
    targetBitDepth > 16 ||
    modelId > 4
  )
    return undefined;

  const codedValueWidth = ((codedDataBitDepth + 7) >> 3) << 3,
    targetValueWidth = ((targetBitDepth + 7) >> 3) << 3;
  let model: HevcToneMappingModel;
  switch (modelId) {
    case 0: {
      const minValue = reader.readBits(32),
        maxValue = reader.readBits(32);
      if (maxValue < minValue) invalid('tone_mapping_info max_value precedes min_value');
      model = { modelId, minValue, maxValue };
      break;
    }
    case 1:
      model = {
        modelId,
        sigmoidMidpoint: reader.readBits(32),
        sigmoidWidth: reader.readBits(32),
      };
      break;
    case 2:
      model = {
        modelId,
        startOfCodedIntervals: Array.from({ length: 1 << targetBitDepth }, () =>
          reader.readBits(codedValueWidth),
        ),
      };
      break;
    case 3: {
      const pivotCount = reader.readBits(16),
        pivots = Array.from({ length: pivotCount }, () => ({
          codedValue: reader.readBits(codedValueWidth),
          targetValue: reader.readBits(targetValueWidth),
        }));
      model = { modelId, pivots };
      break;
    }
    case 4: {
      const cameraIsoSpeedIdc = reader.readBits(8);
      const cameraSpeed = cameraIsoSpeedIdc === 255 ? reader.readBits(32) : undefined;
      const exposureIndexIdc = reader.readBits(8),
        exposureIndexValue = exposureIndexIdc === 255 ? reader.readBits(32) : undefined,
        exposureCompensationNegative = reader.readBit() === 1,
        exposureCompensationNumerator = reader.readBits(16),
        exposureCompensationDenominatorIdc = reader.readBits(16),
        referenceScreenLuminanceWhite = reader.readBits(32),
        extendedRangeWhiteLevel = reader.readBits(32),
        nominalBlackLevelCodeValue = reader.readBits(16),
        nominalWhiteLevelCodeValue = reader.readBits(16),
        extendedWhiteLevelCodeValue = reader.readBits(16);
      // Values 31–254 are reserved; the message is ignored after full syntax parsing.
      const reservedIsoCode =
        (cameraIsoSpeedIdc >= 31 && cameraIsoSpeedIdc <= 254) ||
        (exposureIndexIdc >= 31 && exposureIndexIdc <= 254);
      if (cameraSpeed === 0 || exposureIndexValue === 0)
        invalid('tone_mapping_info extended ISO value shall not be zero');
      model = {
        modelId,
        cameraIsoSpeedIdc,
        ...(cameraSpeed === undefined ? {} : { cameraIsoSpeedValue: cameraSpeed }),
        exposureIndexIdc,
        ...(exposureIndexValue === undefined ? {} : { exposureIndexValue }),
        exposureCompensationNegative,
        exposureCompensationNumerator,
        exposureCompensationDenominatorIdc,
        referenceScreenLuminanceWhite,
        extendedRangeWhiteLevel,
        nominalBlackLevelCodeValue,
        nominalWhiteLevelCodeValue,
        extendedWhiteLevelCodeValue,
      };
      validatePayloadEnd(payload, reader);
      if (reservedIsoCode) return undefined;
      return {
        cancelled,
        toneMapId,
        persistence,
        codedDataBitDepth,
        targetBitDepth,
        model,
      };
    }
    default:
      return undefined;
  }

  validatePayloadEnd(payload, reader);
  return { cancelled, toneMapId, persistence, codedDataBitDepth, targetBitDepth, model };
}

function parseKneeFunctionInfo(payload: Uint8Array): HevcKneeFunctionInfo | undefined {
  const reader = new BitReader(payload),
    kneeFunctionId = readHevcUe32(reader, 'knee_function_id'),
    cancelled = reader.readBit() === 1;
  if (cancelled) {
    validatePayloadEnd(payload, reader);
    if (isReservedHevcSeiId(kneeFunctionId)) return undefined;
    return { cancelled, kneeFunctionId };
  }
  if (isReservedHevcSeiId(kneeFunctionId)) return undefined;

  const persistence = reader.readBit() === 1,
    inputDynamicRange = reader.readBits(32),
    inputDisplayLuminance = reader.readBits(32),
    outputDynamicRange = reader.readBits(32),
    outputDisplayLuminance = reader.readBits(32),
    pointCountMinus1 = reader.ue();
  if (pointCountMinus1 > 998) invalid('knee_function_info num_knee_points_minus1 is out of range');
  const pointCount = pointCountMinus1 + 1;
  const remainingBits = payload.length * 8 - reader.bitPosition;
  if (pointCount > Math.floor(remainingBits / 20))
    invalid('knee_function_info point count exceeds its payload size');
  const points = Array.from({ length: pointCount }, () => ({
    input: reader.readBits(10),
    output: reader.readBits(10),
  }));
  for (let index = 0; index < points.length; index++) {
    const point = points[index],
      previous = points[index - 1];
    if (point.input < 1 || point.input > 999)
      invalid('knee_function_info input_knee_point is out of range');
    if (point.output > 1000) invalid('knee_function_info output_knee_point is out of range');
    if (previous && point.input <= previous.input)
      invalid('knee_function_info input_knee_point is not increasing');
    if (previous && point.output < previous.output)
      invalid('knee_function_info output_knee_point is decreasing');
  }
  validatePayloadEnd(payload, reader);
  return {
    cancelled,
    kneeFunctionId,
    persistence,
    inputDynamicRange,
    inputDisplayLuminance,
    outputDynamicRange,
    outputDisplayLuminance,
    points,
  };
}

/** H.265 uses ue(v) values up to 2^32 - 2, wider than BitReader.ue(). */
function readHevcUe32(reader: BitReader, label: string): number {
  let leadingZeroBits = 0;
  while (reader.readBit() === 0) {
    leadingZeroBits++;
    if (leadingZeroBits > 31) invalid(`${label} exceeds the supported range`);
  }
  const value = 2 ** leadingZeroBits - 1 + (leadingZeroBits ? reader.readBits(leadingZeroBits) : 0);
  if (value > 0xffff_fffe) invalid(`${label} is out of range`);
  return value;
}

function readHevcSe32(reader: BitReader, label: string): number {
  const codeNum = readHevcUe32(reader, label);
  return codeNum === 0 ? 0 : codeNum % 2 ? (codeNum + 1) / 2 : -(codeNum / 2);
}

function isReservedHevcSeiId(id: number): boolean {
  return (id >= 256 && id <= 511) || id >= 0x8000_0000;
}

function parseColourRemappingInfo(payload: Uint8Array): HevcColourRemappingInfo | undefined {
  const reader = new BitReader(payload),
    colourRemapId = readHevcUe32(reader, 'colour_remap_id'),
    cancelled = reader.readBit() === 1;
  if (cancelled) {
    validatePayloadEnd(payload, reader);
    if (isReservedHevcSeiId(colourRemapId)) return undefined;
    return { cancelled, colourRemapId };
  }
  if (isReservedHevcSeiId(colourRemapId)) return undefined;

  const persistence = reader.readBit() === 1,
    videoSignalInfoPresent = reader.readBit() === 1;
  const videoSignalInfo = videoSignalInfoPresent
    ? {
        fullRange: reader.readBit() === 1,
        primaries: reader.readBits(8),
        transferFunction: reader.readBits(8),
        matrixCoefficients: reader.readBits(8),
      }
    : undefined;
  const inputBitDepth = reader.readBits(8),
    outputBitDepth = reader.readBits(8);
  // H.265 requires decoders to ignore values outside 8–16. These values also
  // determine subsequent syntax widths, so do not guess at reserved encodings.
  if (inputBitDepth < 8 || inputBitDepth > 16 || outputBitDepth < 8 || outputBitDepth > 16)
    return undefined;

  const readLuts = (codedBitDepth: number, targetBitDepth: number) => {
    const codedWidth = ((codedBitDepth + 7) >> 3) << 3,
      targetWidth = ((targetBitDepth + 7) >> 3) << 3;
    let unsupportedLutCount = false;
    return [0, 1, 2].map(() => {
      if (unsupportedLutCount) return null;
      const numValMinus1 = reader.readBits(8);
      if (numValMinus1 > 32) {
        unsupportedLutCount = true;
        return null;
      }
      const count = numValMinus1 === 0 ? 0 : numValMinus1 + 1,
        bitsPerPoint = codedWidth + targetWidth,
        remainingBits = payload.length * 8 - reader.bitPosition;
      if (count > Math.floor(remainingBits / bitsPerPoint))
        invalid('colour_remapping_info LUT points exceed their payload size');
      const points = Array.from({ length: count }, () => ({
        codedValue: reader.readBits(codedWidth),
        targetValue: reader.readBits(targetWidth),
      }));
      return { numValMinus1, points };
    });
  };

  const preLuts = readLuts(inputBitDepth, outputBitDepth);
  if (preLuts.some((lut) => lut === null)) return undefined;
  const matrixPresent = reader.readBit() === 1;
  let matrix: HevcColourRemappingInfoData['matrix'];
  if (matrixPresent) {
    const log2Denom = reader.readBits(4),
      rows = [0, 1, 2].map(() => [0, 1, 2].map(() => reader.se()));
    if (
      rows.some((row) => row.some((coefficient) => coefficient < -32_768 || coefficient > 32_767))
    )
      invalid('colour_remap_coeffs is out of range');
    matrix = {
      log2Denom,
      coefficients: rows as unknown as NonNullable<
        HevcColourRemappingInfoData['matrix']
      >['coefficients'],
    };
  }
  const postLuts = readLuts(outputBitDepth, outputBitDepth);
  if (postLuts.some((lut) => lut === null)) return undefined;
  validatePayloadEnd(payload, reader);

  return {
    cancelled,
    colourRemapId,
    persistence,
    ...(videoSignalInfo ? { videoSignalInfo } : {}),
    inputBitDepth,
    outputBitDepth,
    preLuts: preLuts as unknown as HevcColourRemappingInfoData['preLuts'],
    ...(matrix ? { matrix } : {}),
    postLuts: postLuts as unknown as HevcColourRemappingInfoData['postLuts'],
  };
}

function parseChromaResamplingFilterHint(
  payload: Uint8Array,
  chromaFormatIdc?: number,
  chromaSampleLocType = 0,
  chromaSampleLocTypeBottomField = chromaSampleLocType,
): HevcChromaResamplingFilterHint | undefined {
  const reader = new BitReader(payload),
    verticalFilterIdc = reader.readBits(8),
    horizontalFilterIdc = reader.readBits(8),
    verticalFilteringFieldProcessing = reader.readBit() === 1;
  if (verticalFilterIdc > 2 || horizontalFilterIdc > 2) return undefined;
  if (verticalFilterIdc === 0 && horizontalFilterIdc === 0)
    invalid('chroma_resampling_filter_hint cannot leave both directions unspecified');

  const targetFormatIdc =
    verticalFilterIdc === 1 || horizontalFilterIdc === 1 ? reader.ue() : undefined;
  if (targetFormatIdc !== undefined && (targetFormatIdc < 1 || targetFormatIdc > 3))
    invalid('chroma_resampling_filter_hint target_format_idc is out of range');

  const readFilters = (axis: 'vertical' | 'horizontal', idc: number) => {
    if (idc !== 1) return undefined;
    const count = reader.ue(),
      validCounts = axis === 'vertical' ? [2, 3, 5] : [2, 3];
    if (!validCounts.includes(count))
      invalid(`chroma_resampling_filter_hint num_${axis}_filters is out of range`);
    return Array.from({ length: count }, () => {
      const tapLengthMinus1 = reader.ue();
      if (tapLengthMinus1 > 31)
        invalid(`chroma_resampling_filter_hint ${axis} tap length is out of range`);
      const coefficientCount = tapLengthMinus1 + 1,
        remainingBits = payload.length * 8 - reader.bitPosition;
      if (coefficientCount > remainingBits)
        invalid(`chroma_resampling_filter_hint ${axis} coefficients exceed their payload size`);
      const coefficients = Array.from({ length: coefficientCount }, () =>
        readHevcSe32(reader, `chroma_resampling_filter_hint ${axis} coefficient`),
      );
      return { tapLengthMinus1, coefficients };
    });
  };

  const verticalFilters = readFilters('vertical', verticalFilterIdc),
    horizontalFilters = readFilters('horizontal', horizontalFilterIdc);
  if (chromaFormatIdc !== undefined) {
    if (chromaFormatIdc === 0)
      invalid('chroma_resampling_filter_hint is not valid for monochrome pictures');
    if (chromaFormatIdc === 1 && chromaSampleLocType !== chromaSampleLocTypeBottomField)
      invalid('chroma_resampling_filter_hint requires matching top and bottom chroma locations');
    const sampleLocType = chromaFormatIdc === 1 ? chromaSampleLocType : 0,
      targetFormat =
        targetFormatIdc ??
        (chromaFormatIdc === 1
          ? horizontalFilterIdc === 2
            ? 3
            : 2
          : chromaFormatIdc === 2
            ? verticalFilterIdc === 2
              ? 1
              : 3
            : verticalFilterIdc === 2
              ? 1
              : 2);
    if (sampleLocType > 5)
      invalid('chroma_resampling_filter_hint uses an unsupported chroma sample location');
    if (targetFormat === chromaFormatIdc)
      invalid('chroma_resampling_filter_hint target format must differ from chroma_format_idc');
    if (chromaFormatIdc === 1 && verticalFilterIdc === 0)
      invalid('4:2:0 chroma_resampling_filter_hint requires a vertical filter');
    if (chromaFormatIdc === 3 && horizontalFilterIdc === 0)
      invalid('4:4:4 chroma_resampling_filter_hint requires a horizontal filter');
    if (chromaFormatIdc === 2 && verticalFilterIdc === 2 && horizontalFilterIdc !== 0)
      invalid('4:2:2 vertical filter 2 requires an unspecified horizontal filter');
    if (chromaFormatIdc > 1 && targetFormat > 1 && verticalFilterIdc !== 0)
      invalid('chroma_resampling_filter_hint requires an unspecified vertical filter');
    if (chromaFormatIdc < 3 && targetFormat < 3 && horizontalFilterIdc !== 0)
      invalid('chroma_resampling_filter_hint requires an unspecified horizontal filter');
    if (sampleLocType > 1 && verticalFilterIdc === 2)
      invalid('vertical filter 2 is invalid for this chroma sample location');
    if ([1, 3, 5].includes(sampleLocType) && horizontalFilterIdc === 2)
      invalid('horizontal filter 2 is invalid for this chroma sample location');
    if (verticalFilters) {
      const expected = verticalFilteringFieldProcessing
        ? sampleLocType <= 1
          ? 3
          : 5
        : sampleLocType <= 1
          ? 2
          : 3;
      if (verticalFilters.length !== expected)
        invalid('chroma_resampling_filter_hint has an invalid vertical filter count');
    }
    if (horizontalFilters) {
      const expected = sampleLocType % 2 === 0 ? 3 : 2;
      if (horizontalFilters.length !== expected)
        invalid('chroma_resampling_filter_hint has an invalid horizontal filter count');
    }
  }
  validatePayloadEnd(payload, reader);
  return {
    verticalFilterIdc,
    horizontalFilterIdc,
    verticalFilteringFieldProcessing,
    ...(targetFormatIdc === undefined ? {} : { targetFormatIdc }),
    ...(verticalFilters ? { verticalFilters } : {}),
    ...(horizontalFilters ? { horizontalFilters } : {}),
  };
}

function parsePostFilterHint(
  payload: Uint8Array,
  chromaFormatIdc: number,
): HevcPostFilterHint | undefined {
  const reader = new BitReader(payload),
    filterHintSizeY = reader.ue(),
    filterHintSizeX = reader.ue(),
    filterHintType = reader.readBits(2);
  if (filterHintType === 3) return undefined;
  if (filterHintSizeY < 1 || filterHintSizeY > 15)
    invalid('post_filter_hint filter_hint_size_y is out of range');
  if (filterHintSizeX < 1 || filterHintSizeX > 15)
    invalid('post_filter_hint filter_hint_size_x is out of range');
  if (filterHintType === 1 && filterHintSizeY !== 2)
    invalid('post_filter_hint type 1 requires filter_hint_size_y to equal 2');

  const componentCount = chromaFormatIdc === 0 ? 1 : 3,
    valueCount = componentCount * filterHintSizeY * filterHintSizeX,
    remainingBits = payload.length * 8 - reader.bitPosition;
  if (valueCount >= remainingBits) invalid('post_filter_hint values exceed their payload size');
  const filterHintValues = Array.from({ length: componentCount }, () =>
    Array.from({ length: filterHintSizeY }, () =>
      Array.from({ length: filterHintSizeX }, () =>
        readHevcSe32(reader, 'post_filter_hint filter_hint_value'),
      ),
    ),
  );
  validatePayloadEnd(payload, reader);
  return {
    filterHintSizeY,
    filterHintSizeX,
    filterHintType: filterHintType as 0 | 1 | 2,
    filterHintValues,
  };
}

function readSigned32(reader: BitReader): number {
  return reader.readBits(32) | 0;
}

function parseAlternativeTransferCharacteristics(
  payload: Uint8Array,
): HevcAlternativeTransferCharacteristics {
  if (payload.length !== 1)
    invalid('invalid alternative_transfer_characteristics SEI payload size');
  return { preferredTransferCharacteristics: payload[0] };
}

function parseAmbientViewingEnvironment(payload: Uint8Array): HevcAmbientViewingEnvironment {
  if (payload.length !== 8) invalid('invalid ambient_viewing_environment SEI payload size');
  const ambientIlluminance = u32(payload, 0),
    ambientLightX = u16(payload, 4),
    ambientLightY = u16(payload, 6);
  if (ambientIlluminance === 0) invalid('ambient_illuminance shall not be zero');
  if (ambientLightX > 50_000 || ambientLightY > 50_000)
    invalid('ambient viewing chromaticity is out of range');
  return { ambientIlluminance, ambientLightX, ambientLightY };
}

function parseContentColourVolume(payload: Uint8Array): HevcContentColourVolume | null {
  const reader = new BitReader(payload),
    cancel = reader.readBit();
  if (cancel) {
    validatePayloadEnd(payload, reader);
    return null;
  }

  const persistence = reader.readBit() === 1,
    primariesPresent = reader.readBit() === 1,
    minPresent = reader.readBit() === 1,
    maxPresent = reader.readBit() === 1,
    averagePresent = reader.readBit() === 1;
  reader.readBits(2); // ccv_reserved_zero_2bits is reserved; decoders ignore it.
  if (!primariesPresent && !minPresent && !maxPresent && !averagePresent)
    invalid('content_colour_volume has no values');

  const output: HevcContentColourVolume = { persistence };
  if (primariesPresent) {
    const primaries = [0, 1, 2].map(() => ({
      x: readSigned32(reader),
      y: readSigned32(reader),
    })) as unknown as NonNullable<HevcContentColourVolume['primaries']>;
    if (
      primaries.some(
        ({ x, y }) => x < -5_000_000 || x > 5_000_000 || y < -5_000_000 || y > 5_000_000,
      )
    )
      invalid('content colour volume primary is out of range');
    output.primaries = primaries;
  }
  if (minPresent) output.minLuminanceValue = reader.readBits(32);
  if (maxPresent) output.maxLuminanceValue = reader.readBits(32);
  if (averagePresent) output.averageLuminanceValue = reader.readBits(32);
  validatePayloadEnd(payload, reader);
  return output;
}

function parseDisplayOrientation(payload: Uint8Array): HevcDisplayOrientation {
  const reader = new BitReader(payload),
    cancelled = reader.readBit() === 1;
  if (cancelled) {
    validatePayloadEnd(payload, reader);
    return { cancelled };
  }

  const persistence = reader.readBit() === 1,
    transformType = reader.readBits(3);
  reader.readBits(3); // H.274 reserved_zero_3bits is ignored by decoders.
  validatePayloadEnd(payload, reader);
  return { cancelled, persistence, transformType };
}

function parseDepthRepresentationValue(reader: BitReader): HevcDepthRepresentationValue {
  const sign = reader.readBit() === 1,
    exponent = reader.readBits(7),
    mantissaLength = reader.readBits(5) + 1,
    mantissa = reader.readBits(mantissaLength);
  return { sign, exponent, mantissaLength, mantissa };
}

function parseDepthRepresentationInformation(
  payload: Uint8Array,
): HevcDepthRepresentationInformation {
  const reader = new BitReader(payload),
    zNearPresent = reader.readBit() === 1,
    zFarPresent = reader.readBit() === 1,
    dMinPresent = reader.readBit() === 1,
    dMaxPresent = reader.readBit() === 1,
    representationType = reader.ue();
  const output: HevcDepthRepresentationInformation = { representationType };

  // H.274 reserves types 4–15 and requires decoders to ignore the remaining
  // bits. Preserve the type without guessing the syntax of its tail.
  if (representationType > 15) invalid('depth_representation_type is out of range');
  if (representationType >= 4) return output;

  if (dMinPresent || dMaxPresent) {
    const disparityReferenceViewId = reader.ue();
    if (disparityReferenceViewId > 1023) invalid('disparity_ref_view_id is out of range');
    output.disparityReferenceViewId = disparityReferenceViewId;
  }
  if (zNearPresent) output.zNear = parseDepthRepresentationValue(reader);
  if (zFarPresent) output.zFar = parseDepthRepresentationValue(reader);
  if (dMinPresent) output.dMin = parseDepthRepresentationValue(reader);
  if (dMaxPresent) output.dMax = parseDepthRepresentationValue(reader);
  if (representationType === 3) {
    const numMinus1 = reader.ue();
    if (numMinus1 > 62) invalid('depth nonlinear representation model count is out of range');
    output.nonlinearRepresentationModels = Array.from({ length: numMinus1 + 1 }, () => {
      const model = reader.ue();
      if (model > 65_535) invalid('depth nonlinear representation model is out of range');
      return model;
    });
  }
  validatePayloadEnd(payload, reader);
  return output;
}

function parseAlphaChannelInformation(payload: Uint8Array): HevcAlphaChannelInformation {
  const reader = new BitReader(payload),
    cancelled = reader.readBit() === 1;
  if (cancelled) {
    validatePayloadEnd(payload, reader);
    return { cancelled };
  }

  const useIdc = reader.readBits(3),
    bitDepth = reader.readBits(3) + 8,
    transparentValue = reader.readBits(bitDepth + 1),
    opaqueValue = reader.readBits(bitDepth + 1),
    increment = reader.readBit() === 1,
    clip = reader.readBit() === 1,
    clipType = clip ? reader.readBit() : undefined;
  if (increment) {
    const range = Math.abs(opaqueValue - transparentValue);
    if (range === 0 || !Number.isInteger(Math.log2(range)))
      invalid('invalid alpha_channel_incr_flag for alpha values');
  }
  validatePayloadEnd(payload, reader);
  return {
    cancelled,
    useIdc,
    bitDepth,
    transparentValue,
    opaqueValue,
    increment,
    clip,
    ...(clipType === undefined ? {} : { clipType }),
  };
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function parseSeiMessages(
  data: Uint8Array,
  onMessage: (payloadType: number, payload: Uint8Array) => void,
): void {
  let offset = 0;
  let hasTrailingBits = false;
  while (offset < data.length) {
    if (data[offset] === 0x80 && data.subarray(offset + 1).every((byte) => byte === 0)) {
      hasTrailingBits = true;
      offset = data.length;
      break;
    }

    let payloadType: number;
    let payloadSize: number;
    [payloadType, offset] = readExtendedValue(data, offset, 'payloadType');
    [payloadSize, offset] = readExtendedValue(data, offset, 'payloadSize');
    if (payloadSize > data.length - offset) invalid('truncated HEVC SEI payload');
    const payload = data.subarray(offset, offset + payloadSize);
    offset += payloadSize;

    onMessage(payloadType, payload);
  }

  if (!hasTrailingBits) invalid('missing HEVC SEI rbsp_trailing_bits');
}

/** Extract frame/field display metadata from picture_timing SEI (H.265 D.2.3). */
export function parseHevcPictureTimingSeiNals(
  nals: readonly Uint8Array[],
  frameFieldInfoPresent: boolean,
): HevcPictureTimingInfo | undefined {
  if (!frameFieldInfoPresent) return undefined;
  let pictureTiming: HevcPictureTimingInfo | undefined;
  for (const nal of nals) {
    if (nal.length < 2) invalid('truncated HEVC NAL header');
    const nalType = (nal[0] >> 1) & 0x3f;
    if (nalType !== SEI_PREFIX && nalType !== SEI_SUFFIX) continue;
    if (nal.length < 3) invalid('truncated HEVC SEI NAL unit');
    if (nal[0] & 0x80 || !(nal[1] & 0x07)) invalid('invalid HEVC SEI NAL header');
    parseSeiMessages(toRbsp(nal), (payloadType, payload) => {
      if (payloadType !== 1) return;
      if (pictureTiming) invalid('multiple picture_timing SEI messages for one access unit');
      const reader = new BitReader(payload),
        picStruct = reader.readBits(4),
        sourceScanType = reader.readBits(2),
        duplicate = reader.readBit() === 1;
      if (picStruct > 12) invalid('picture_timing pic_struct is reserved');
      if (sourceScanType > 2) invalid('picture_timing source_scan_type is reserved');
      pictureTiming = { picStruct, sourceScanType, duplicate };
    });
  }
  return pictureTiming;
}

function parseSeiRbsp(
  data: Uint8Array,
  output: HevcSeiMetadata,
  chromaFormatIdc: number | undefined,
  chromaSampleLocType: number,
  chromaSampleLocTypeBottomField: number,
): void {
  parseSeiMessages(data, (payloadType, payload) => {
    if (payloadType === MASTERING_DISPLAY_COLOUR_VOLUME) {
      const parsed = parseMasteringDisplayColourVolume(payload);
      if (
        output.masteringDisplayColourVolume &&
        !sameValue(output.masteringDisplayColourVolume, parsed)
      )
        invalid('conflicting mastering_display_colour_volume SEI messages');
      output.masteringDisplayColourVolume = parsed;
    } else if (payloadType === CONTENT_LIGHT_LEVEL_INFO) {
      const parsed = parseContentLightLevelInfo(payload);
      if (output.contentLightLevelInfo && !sameValue(output.contentLightLevelInfo, parsed))
        invalid('conflicting content_light_level_info SEI messages');
      output.contentLightLevelInfo = parsed;
    } else if (payloadType === ALTERNATIVE_TRANSFER_CHARACTERISTICS) {
      const parsed = parseAlternativeTransferCharacteristics(payload);
      if (
        output.alternativeTransferCharacteristics &&
        !sameValue(output.alternativeTransferCharacteristics, parsed)
      )
        invalid('conflicting alternative_transfer_characteristics SEI messages');
      output.alternativeTransferCharacteristics = parsed;
    } else if (payloadType === AMBIENT_VIEWING_ENVIRONMENT) {
      const parsed = parseAmbientViewingEnvironment(payload);
      if (output.ambientViewingEnvironment && !sameValue(output.ambientViewingEnvironment, parsed))
        invalid('conflicting ambient_viewing_environment SEI messages');
      output.ambientViewingEnvironment = parsed;
    } else if (payloadType === CONTENT_COLOUR_VOLUME) {
      // CCV may be picture-scoped, persistent, or canceled; preserve message order.
      output.contentColourVolume = parseContentColourVolume(payload);
    } else if (payloadType === DISPLAY_ORIENTATION) {
      // Persistence/cancellation are stateful; retain each message for the caller.
      (output.displayOrientation ??= []).push(parseDisplayOrientation(payload));
    } else if (payloadType === PHASE_INDICATION) {
      // Rendering may use these ratios to align cropped pictures; pixels stay unchanged here.
      (output.phaseIndication ??= []).push(parsePhaseIndication(payload));
    } else if (payloadType === FILM_GRAIN_CHARACTERISTICS) {
      // Synthesis is optional display processing; expose only the coded model.
      (output.filmGrainCharacteristics ??= []).push(parseFilmGrainCharacteristics(payload));
    } else if (payloadType === TONE_MAPPING_INFO) {
      // Preserve supported models for the caller without mapping decoded pixels.
      const parsed = parseToneMappingInfo(payload);
      if (parsed) (output.toneMappingInfo ??= []).push(parsed);
    } else if (payloadType === KNEE_FUNCTION_INFO) {
      // Preserve the coded HDR display curve without mapping decoded pixels.
      const parsed = parseKneeFunctionInfo(payload);
      if (parsed) (output.kneeFunctionInfo ??= []).push(parsed);
    } else if (payloadType === COLOUR_REMAPPING_INFO) {
      // H.265 leaves this display conversion outside the decoding process.
      const parsed = parseColourRemappingInfo(payload);
      if (parsed) (output.colourRemappingInfo ??= []).push(parsed);
    } else if (payloadType === CHROMA_RESAMPLING_FILTER_HINT) {
      const parsed = parseChromaResamplingFilterHint(
        payload,
        chromaFormatIdc,
        chromaSampleLocType,
        chromaSampleLocTypeBottomField,
      );
      if (parsed) {
        const previous = output.chromaResamplingFilterHint?.[0];
        if (previous && !sameValue(previous, parsed))
          invalid('conflicting chroma_resampling_filter_hint SEI messages');
        (output.chromaResamplingFilterHint ??= []).push(parsed);
      }
    } else if (payloadType === POST_FILTER_HINT) {
      if (chromaFormatIdc === undefined) return;
      const parsed = parsePostFilterHint(payload, chromaFormatIdc);
      if (parsed) (output.postFilterHint ??= []).push(parsed);
    }
  });
}

/** Parse supported colour, HDR, orientation, film-grain, and display-hint SEIs from HEVC NAL units. */
export function parseHevcHdrSeiNals(
  nals: readonly Uint8Array[],
  chromaFormatIdc?: number,
  chromaSampleLocType = 0,
  chromaSampleLocTypeBottomField = chromaSampleLocType,
): HevcSeiMetadata | undefined {
  if (
    chromaFormatIdc !== undefined &&
    (!Number.isInteger(chromaFormatIdc) || chromaFormatIdc < 0 || chromaFormatIdc > 3)
  )
    invalid('invalid chroma_format_idc for HEVC SEI parsing');
  if (!Number.isInteger(chromaSampleLocType) || chromaSampleLocType < 0 || chromaSampleLocType > 6)
    invalid('invalid chroma sample location type for HEVC SEI parsing');
  if (
    !Number.isInteger(chromaSampleLocTypeBottomField) ||
    chromaSampleLocTypeBottomField < 0 ||
    chromaSampleLocTypeBottomField > 6
  )
    invalid('invalid bottom-field chroma sample location type for HEVC SEI parsing');
  const output: HevcSeiMetadata = {};
  for (const nal of nals) {
    if (nal.length < 2) invalid('truncated HEVC NAL header');
    const nalType = (nal[0] >> 1) & 0x3f;
    if (nalType !== SEI_PREFIX && nalType !== SEI_SUFFIX) continue;
    if (nal.length < 3) invalid('truncated HEVC SEI NAL unit');
    if (nal[0] & 0x80 || !(nal[1] & 0x07)) invalid('invalid HEVC SEI NAL header');
    parseSeiRbsp(
      toRbsp(nal),
      output,
      chromaFormatIdc,
      chromaSampleLocType,
      chromaSampleLocTypeBottomField,
    );
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

/** Parse depth-representation and alpha-channel SEIs from HEIF auxiliary NALs. */
export function parseHevcAuxiliarySeiNals(
  nals: readonly Uint8Array[],
): HevcAuxiliarySeiMetadata | undefined {
  const output: HevcAuxiliarySeiMetadata = {
    depthRepresentationInfo: [],
    alphaChannelInfo: [],
  };
  for (const nal of nals) {
    if (nal.length < 2) invalid('truncated HEVC NAL header');
    const nalType = (nal[0] >> 1) & 0x3f;
    if (nalType !== SEI_PREFIX && nalType !== SEI_SUFFIX)
      invalid('HEVC auxiliary subtype contains a non-SEI NAL unit');
    if (nal.length < 3) invalid('truncated HEVC SEI NAL unit');
    if (nal[0] & 0x80 || !(nal[1] & 0x07)) invalid('invalid HEVC SEI NAL header');
    parseSeiMessages(toRbsp(nal), (payloadType, payload) => {
      if (payloadType === 177)
        output.depthRepresentationInfo.push(parseDepthRepresentationInformation(payload));
      else if (payloadType === 165)
        output.alphaChannelInfo.push(parseAlphaChannelInformation(payload));
    });
  }
  return output.depthRepresentationInfo.length || output.alphaChannelInfo.length
    ? output
    : undefined;
}
