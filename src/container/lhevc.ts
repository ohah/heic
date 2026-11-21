import { HeicError } from '../errors.js';

export interface LhevcParameterSetNal {
  nalUnitType: number;
  layerId: number;
  data: Uint8Array;
}

export interface LhevcConfigurationArray {
  arrayCompleteness: boolean;
  nalUnitType: number;
  nalUnits: LhevcParameterSetNal[];
}

/** ISO/IEC 14496-15 LHEVCDecoderConfigurationRecord carried by `lhvC`. */
export interface LhevcDecoderConfiguration {
  configurationVersion: number;
  minSpatialSegmentationIdc: number;
  parallelismType: number;
  numTemporalLayers: number;
  temporalIdNested: boolean;
  nalLengthSize: number;
  arrays: LhevcConfigurationArray[];
}

export interface LhevcProfileTierLevel {
  generalProfileSpace: number;
  generalTierFlag: number;
  generalProfileIdc: number;
  generalProfileCompatibilityFlags: number;
  generalConstraintIndicatorFlags: number;
  generalLevelIdc: number;
}

export interface LhevcOperatingPointLayer {
  ptlIndex: number;
  layerId: number;
  isOutputLayer: boolean;
  isAlternateOutputLayer: boolean;
}

export interface LhevcOperatingPoint {
  outputLayerSetIndex: number;
  maxTemporalId: number;
  layers: LhevcOperatingPointLayer[];
  minPicWidth: number;
  minPicHeight: number;
  maxPicWidth: number;
  maxPicHeight: number;
  maxChromaFormat: number;
  maxBitDepthMinus8: number;
  frameRateInfo: { averageFrameRate: number; constantFrameRate: number } | null;
  bitRateInfo: { maxBitRate: number; averageBitRate: number } | null;
}

export interface LhevcLayerDependency {
  layerId: number;
  dependsOnLayerIds: number[];
  dimensionIdentifiers: number[];
}

/** ISO/IEC 23008-12 `oinf` property. */
export interface OperatingPointsInfo {
  version: number;
  scalabilityMask: number;
  profileTierLevels: LhevcProfileTierLevel[];
  operatingPoints: LhevcOperatingPoint[];
  layerDependencies: LhevcLayerDependency[];
}

export interface ResolvedLhevcOutput {
  targetOutputLayerSetIndex: number;
  targetLayerId: number;
  requiredLayerIds: number[];
  operatingPoint: LhevcOperatingPoint;
}

function invalid(message: string): never {
  throw new HeicError('INVALID_CONTAINER', `heic: ${message}`);
}

function unsupported(message: string): never {
  throw new HeicError('UNSUPPORTED_FEATURE', `heic: ${message}`);
}

function readU16(data: Uint8Array, offset: number): number {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 2 > data.length)
    return invalid('truncated L-HEVC property');
  return (data[offset] << 8) | data[offset + 1];
}

class PropertyBitReader {
  private position = 0;

  constructor(
    private readonly data: Uint8Array,
    private readonly label: string,
  ) {}

  read(count: number): number {
    if (!Number.isInteger(count) || count < 0 || count > 48)
      return invalid(`invalid ${this.label} field width`);
    if (this.position + count > this.data.length * 8)
      return invalid(`truncated ${this.label} property`);
    let value = 0;
    for (let i = 0; i < count; i++) {
      value = value * 2 + ((this.data[this.position >> 3] >> (7 - (this.position & 7))) & 1);
      this.position++;
    }
    return value;
  }

  get remainingBits(): number {
    return this.data.length * 8 - this.position;
  }
}

/** Parse the L-HEVC decoder record without treating it as an `hvcC` record. */
export function parseLhevcDecoderConfigurationRecord(data: Uint8Array): LhevcDecoderConfiguration {
  if (data.length < 6) return invalid('truncated lhvC decoder configuration');
  const configurationVersion = data[0];
  if (configurationVersion !== 1)
    return unsupported(`unsupported lhvC configuration version ${configurationVersion}`);
  if ((data[1] & 0xf0) !== 0xf0 || (data[3] & 0xfc) !== 0xfc || (data[4] & 0xc0) !== 0xc0)
    return invalid('invalid reserved bits in lhvC decoder configuration');

  const minSpatialSegmentationIdc = ((data[1] & 0x0f) << 8) | data[2];
  const parallelismType = data[3] & 0x03;
  const numTemporalLayers = (data[4] >> 3) & 0x07;
  const temporalIdNested = (data[4] & 0x04) !== 0;
  const nalLengthSize = (data[4] & 0x03) + 1;
  const numArrays = data[5];
  const arrays: LhevcConfigurationArray[] = [];
  let offset = 6;

  for (let arrayIndex = 0; arrayIndex < numArrays; arrayIndex++) {
    if (offset + 3 > data.length) return invalid('truncated lhvC NAL array header');
    const arrayHeader = data[offset++];
    if (arrayHeader & 0x40) return invalid('invalid reserved bit in lhvC NAL array');
    const arrayCompleteness = (arrayHeader & 0x80) !== 0;
    const nalUnitType = arrayHeader & 0x3f;
    const numNalus = readU16(data, offset);
    offset += 2;
    const nalUnits: LhevcParameterSetNal[] = [];

    for (let nalIndex = 0; nalIndex < numNalus; nalIndex++) {
      if (offset + 2 > data.length) return invalid('truncated lhvC NAL length');
      const nalLength = readU16(data, offset);
      offset += 2;
      if (nalLength < 2 || offset + nalLength > data.length)
        return invalid('invalid or truncated lhvC NAL unit');
      const nal = data.subarray(offset, offset + nalLength);
      offset += nalLength;
      if (nal[0] & 0x80 || !(nal[1] & 0x07)) return invalid('invalid NAL header in lhvC');
      const actualNalUnitType = (nal[0] >> 1) & 0x3f;
      if (actualNalUnitType !== nalUnitType)
        return invalid('lhvC NAL type disagrees with its array header');
      nalUnits.push({
        nalUnitType: actualNalUnitType,
        layerId: ((nal[0] & 1) << 5) | (nal[1] >> 3),
        data: nal,
      });
    }

    arrays.push({ arrayCompleteness, nalUnitType, nalUnits });
  }

  if (offset !== data.length)
    return invalid('unexpected trailing data in lhvC decoder configuration');
  return {
    configurationVersion,
    minSpatialSegmentationIdc,
    parallelismType,
    numTemporalLayers,
    temporalIdNested,
    nalLengthSize,
    arrays,
  };
}

/** Parse the `oinf` FullBox property defined by ISO/IEC 23008-12. */
export function parseOperatingPointsInfo(data: Uint8Array): OperatingPointsInfo {
  const r = new PropertyBitReader(data, 'oinf');
  const version = r.read(8);
  const flags = r.read(24);
  if (version !== 0 || flags !== 0)
    return unsupported(`unsupported oinf version ${version} or flags ${flags}`);

  const scalabilityMask = r.read(16);
  const dimensionCount = scalabilityMask.toString(2).replace(/0/g, '').length;
  if (r.read(2) !== 0) return invalid('nonzero reserved bits in oinf property');
  const profileTierLevelCount = r.read(6);
  const profileTierLevels: LhevcProfileTierLevel[] = [];
  for (let i = 0; i < profileTierLevelCount; i++) {
    profileTierLevels.push({
      generalProfileSpace: r.read(2),
      generalTierFlag: r.read(1),
      generalProfileIdc: r.read(5),
      generalProfileCompatibilityFlags: r.read(32),
      generalConstraintIndicatorFlags: r.read(48),
      generalLevelIdc: r.read(8),
    });
  }

  const operatingPointCount = r.read(16);
  const operatingPoints: LhevcOperatingPoint[] = [];
  const operatingPointIds = new Set<number>();
  for (let i = 0; i < operatingPointCount; i++) {
    const outputLayerSetIndex = r.read(16);
    if (operatingPointIds.has(outputLayerSetIndex))
      return invalid('duplicate output layer set index in oinf property');
    operatingPointIds.add(outputLayerSetIndex);
    const maxTemporalId = r.read(8);
    const layerCount = r.read(8);
    const layers: LhevcOperatingPointLayer[] = [];
    const layerIds = new Set<number>();
    for (let j = 0; j < layerCount; j++) {
      const ptlIndex = r.read(8);
      const layerId = r.read(6);
      const isOutputLayer = r.read(1) !== 0;
      const isAlternateOutputLayer = r.read(1) !== 0;
      if (ptlIndex === 0 || ptlIndex > profileTierLevelCount)
        return invalid('invalid profile tier level index in oinf operating point');
      if (layerIds.has(layerId)) return invalid('duplicate layer id in oinf operating point');
      layerIds.add(layerId);
      layers.push({ ptlIndex, layerId, isOutputLayer, isAlternateOutputLayer });
    }

    const minPicWidth = r.read(16);
    const minPicHeight = r.read(16);
    const maxPicWidth = r.read(16);
    const maxPicHeight = r.read(16);
    const maxChromaFormat = r.read(2);
    const maxBitDepthMinus8 = r.read(3);
    if (r.read(1) !== 0) return invalid('nonzero reserved bit in oinf operating point');
    // ISO/IEC 23008-12 constrains the OperatingPointsRecord inside HEIF:
    // both optional rate-info flags shall be zero (B.2.3.4.3).
    if (r.read(1) !== 0) return invalid('oinf frame-rate info is prohibited for HEIF items');
    if (r.read(1) !== 0) return invalid('oinf bit-rate info is prohibited for HEIF items');
    operatingPoints.push({
      outputLayerSetIndex,
      maxTemporalId,
      layers,
      minPicWidth,
      minPicHeight,
      maxPicWidth,
      maxPicHeight,
      maxChromaFormat,
      maxBitDepthMinus8,
      frameRateInfo: null,
      bitRateInfo: null,
    });
  }

  const maxLayerCount = r.read(8);
  const layerDependencies: LhevcLayerDependency[] = [];
  const dependencyIds = new Set<number>();
  for (let i = 0; i < maxLayerCount; i++) {
    const layerId = r.read(8);
    if (layerId > 63) return invalid('layer id exceeds the HEVC layer-id range in oinf');
    if (dependencyIds.has(layerId)) return invalid('duplicate layer dependency entry in oinf');
    dependencyIds.add(layerId);
    const dependencyCount = r.read(8);
    const dependsOnLayerIds: number[] = [];
    const uniqueDependencies = new Set<number>();
    for (let j = 0; j < dependencyCount; j++) {
      const dependsOnLayerId = r.read(8);
      if (dependsOnLayerId > 63 || uniqueDependencies.has(dependsOnLayerId))
        return invalid('invalid or duplicate layer dependency in oinf');
      uniqueDependencies.add(dependsOnLayerId);
      dependsOnLayerIds.push(dependsOnLayerId);
    }
    const dimensionIdentifiers = Array.from({ length: dimensionCount }, () => r.read(8));
    layerDependencies.push({ layerId, dependsOnLayerIds, dimensionIdentifiers });
  }

  if (r.remainingBits !== 0) return invalid('unexpected trailing data in oinf property');
  const dependencyMap = new Map(layerDependencies.map((layer) => [layer.layerId, layer]));
  for (const layer of layerDependencies) {
    for (const dependencyId of layer.dependsOnLayerIds) {
      if (dependencyId !== 0 && !dependencyMap.has(dependencyId))
        return invalid('oinf dependency points to an undescribed layer');
    }
  }
  assertAcyclicDependencies(layerDependencies, dependencyMap);

  return { version, scalabilityMask, profileTierLevels, operatingPoints, layerDependencies };
}

function assertAcyclicDependencies(
  layers: LhevcLayerDependency[],
  dependencyMap: Map<number, LhevcLayerDependency>,
): void {
  const complete = new Set<number>();
  const active = new Set<number>();
  const visit = (layerId: number): void => {
    if (complete.has(layerId)) return;
    if (active.has(layerId)) invalid('cyclic layer dependencies in oinf property');
    active.add(layerId);
    for (const dependencyId of dependencyMap.get(layerId)?.dependsOnLayerIds ?? [])
      visit(dependencyId);
    active.delete(layerId);
    complete.add(layerId);
  };
  for (const layer of layers) visit(layer.layerId);
}

/** Parse the `tols` FullBox and its 16-bit output-layer-set index. */
export function parseTargetOutputLayerSet(data: Uint8Array): number {
  if (data.length !== 6) return invalid('invalid tols property length');
  if (data[0] !== 0 || data[1] !== 0 || data[2] !== 0 || data[3] !== 0)
    return invalid('invalid tols FullBox version or flags');
  return readU16(data, 4);
}

/** Parse `lsel`, a plain 16-bit reconstructed layer identifier property. */
export function parseLayerSelector(data: Uint8Array): number {
  if (data.length !== 2) return invalid('invalid lsel property length');
  return readU16(data, 0);
}

/** Resolve the requested output layer and the full dependency closure. */
export function resolveLhevcOutput(
  info: OperatingPointsInfo,
  targetOutputLayerSetIndex: number,
  selectedLayerId: number | null,
): ResolvedLhevcOutput {
  const operatingPoint = info.operatingPoints.find(
    (entry) => entry.outputLayerSetIndex === targetOutputLayerSetIndex,
  );
  if (!operatingPoint) return invalid('tols selects an output layer set missing from oinf');
  const outputLayers = operatingPoint.layers.filter((layer) => layer.isOutputLayer);
  if (outputLayers.length === 0)
    return invalid('selected oinf output layer set has no output layer');
  if (selectedLayerId === null && outputLayers.length !== 1)
    return invalid('multiple output layers require an essential lsel property');
  const targetLayerId = selectedLayerId ?? outputLayers[0].layerId;
  if (!outputLayers.some((layer) => layer.layerId === targetLayerId))
    return invalid('lsel selects a layer outside the selected output layer set');

  const dependencyMap = new Map(info.layerDependencies.map((layer) => [layer.layerId, layer]));
  for (const layer of operatingPoint.layers) {
    if (layer.layerId !== 0 && !dependencyMap.has(layer.layerId))
      return invalid('selected output layer set lacks a dependency entry for a non-base layer');
  }

  const requiredLayerIds: number[] = [];
  const visited = new Set<number>();
  const visit = (layerId: number): void => {
    if (visited.has(layerId)) return;
    const dependency = dependencyMap.get(layerId);
    if (layerId !== 0 && !dependency)
      return invalid('selected output layer depends on an undescribed layer');
    for (const dependencyId of dependency?.dependsOnLayerIds ?? []) visit(dependencyId);
    visited.add(layerId);
    requiredLayerIds.push(layerId);
  };
  visit(targetLayerId);

  return { targetOutputLayerSetIndex, targetLayerId, requiredLayerIds, operatingPoint };
}
