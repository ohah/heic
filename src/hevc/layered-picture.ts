import { HeicError } from '../errors.js';
import type { Planes } from '../planes.js';
import { applyColourMappingTable } from './colour-map.js';
import { deblockPicture } from './deblock.js';
import type { NalUnit } from './nal.js';
import { BitReader, isSliceNal, toRbsp } from './nal.js';
import { PictureDecoder, type ReferenceImage } from './picture.js';
import { parsePps, type PpsInfo } from './pps.js';
import {
  buildBReferenceLists,
  buildReferenceList0,
  createCurrentPictureReference,
  derivePictureOrderCnt,
  type InterLayerReferencePictureSets,
} from './reference-list.js';
import { resampleInterLayerPicture } from './resample.js';
import { applySao } from './sao.js';
import { parseSliceHeader, SLICE_TYPE_B, SLICE_TYPE_I, SLICE_TYPE_P } from './slice-header.js';
import { parseSps, type SpsInfo } from './sps.js';
import {
  getDirectDependencyPredictionCapabilities,
  parseLayeredVps,
  type LayeredVpsInfo,
} from './vps.js';

function unsupported(message: string): never {
  throw new HeicError('UNSUPPORTED_FEATURE', `heic: ${message}`);
}

function invalid(message: string): never {
  throw new HeicError('INVALID_BITSTREAM', `heic: ${message}`);
}

function ppsIdFromSlice(nal: NalUnit): number {
  const reader = new BitReader(toRbsp(nal.data));
  reader.readBit(); // first_slice_segment_in_pic_flag
  if (nal.type >= 16 && nal.type <= 23) reader.readBit(); // no_output_of_prior_pics_flag
  return reader.ue();
}

function layerContext(vps: LayeredVpsInfo, layerId: number) {
  const layerIndex = vps.layerIds.indexOf(layerId);
  if (layerIndex < 0) invalid(`VPS does not contain coded layer ${layerId}`);
  const directReferenceLayerIds = vps.directReferenceLayerIds?.[layerIndex];
  if (!directReferenceLayerIds) unsupported('layered VPS does not expose direct reference layers');
  return {
    defaultRefLayersActiveFlag: vps.defaultRefLayersActiveFlag ?? false,
    directReferenceLayerIds,
    maxOneActiveRefLayerFlag: vps.maxOneActiveRefLayerFlag ?? false,
    pocLsbNotPresentFlag: vps.pocLsbNotPresentFlags?.[layerIndex] ?? false,
  };
}

function viewId(vps: LayeredVpsInfo, layerId: number): number {
  return vps.views?.find((view) => view.layerIds.includes(layerId))?.viewId ?? 0;
}

/** Split active reference-layer pictures into Annex F's inter-layer sets. */
function splitInterLayerReferencePictures(
  vps: LayeredVpsInfo,
  currentLayerId: number,
  referenceLayerIds: readonly number[],
  references: readonly ReferenceImage[],
): InterLayerReferencePictureSets {
  if (referenceLayerIds.length !== references.length)
    invalid('L-HEVC inter-layer reference identities do not match their pictures');

  const currentViewId = viewId(vps, currentLayerId);
  const baseViewId = viewId(vps, 0);
  const interLayer0: ReferenceImage[] = [];
  const interLayer1: ReferenceImage[] = [];
  for (let i = 0; i < references.length; i++) {
    const reference = references[i];
    if (!reference) invalid('L-HEVC inter-layer reference picture is missing');
    const referenceViewId = viewId(vps, referenceLayerIds[i]!);
    if (
      (currentViewId <= baseViewId && currentViewId <= referenceViewId) ||
      (currentViewId >= baseViewId && currentViewId >= referenceViewId)
    )
      interLayer0.push(reference);
    else interLayer1.push(reference);
  }
  return { interLayer0, interLayer1 };
}

function asReferenceImage(planes: Planes): ReferenceImage {
  const reference: ReferenceImage = {
    y: planes.y,
    cb: planes.cb,
    cr: planes.cr,
    width: planes.width,
    height: planes.height,
    chromaFormatIdc: planes.chromaFormatIdc,
    layerId: planes.sourceSps?.layerId ?? 0,
    bitDepthLuma: planes.bitDepthLuma,
    bitDepthChroma: planes.bitDepthChroma,
    pictureOrderCntLsb: planes.pictureOrderCntLsb ?? 0,
    pictureOrderCnt: planes.pictureOrderCnt ?? 0,
    isLongTermReference: false,
    hasExternalInterMotion: planes.hasExternalInterMotion,
  };
  for (const key of [
    'interMap',
    'motionIsExternal',
    'motionPredFlags',
    'motionRefIdxL0',
    'motionXQpel',
    'motionYQpel',
    'motionRefPoc',
    'motionRefLayerId',
    'motionRefLongTerm',
    'motionXQpelL1',
    'motionYQpelL1',
    'motionRefIdxL1',
    'motionRefPocL1',
    'motionRefLayerIdL1',
    'motionRefLongTermL1',
  ] as const) {
    const value = planes[key];
    if (value !== undefined) Object.assign(reference, { [key]: value });
  }
  return reference;
}

/** Keep sample planes while removing motion data forbidden by a sample-only dependency. */
function withoutInterLayerMotion(planes: Planes): Planes {
  const sampleOnly = { ...planes, hasExternalInterMotion: false };
  delete sampleOnly.interMap;
  delete sampleOnly.motionIsExternal;
  delete sampleOnly.motionPredFlags;
  delete sampleOnly.motionRefIdxL0;
  delete sampleOnly.motionXQpel;
  delete sampleOnly.motionYQpel;
  delete sampleOnly.motionRefPoc;
  delete sampleOnly.motionRefLongTerm;
  delete sampleOnly.motionRefLayerId;
  delete sampleOnly.motionXQpelL1;
  delete sampleOnly.motionYQpelL1;
  delete sampleOnly.motionRefIdxL1;
  delete sampleOnly.motionRefPocL1;
  delete sampleOnly.motionRefLongTermL1;
  delete sampleOnly.motionRefLayerIdL1;
  return sampleOnly;
}

function checkedPps(
  layerNals: readonly NalUnit[],
  layerId: number,
  ppsId: number,
  vps: LayeredVpsInfo,
): PpsInfo {
  const nal = layerNals.find(
    (candidate) =>
      candidate.type === 34 &&
      candidate.layerId === layerId &&
      parsePpsId(candidate.data) === ppsId,
  );
  if (!nal) invalid(`coded layer ${layerId} references missing PPS ${ppsId}`);
  return parsePps(nal.data, {
    allowBaseLayerMultilayerExtension: true,
    allowMultilayerExtension: true,
    layeredVps: vps,
  });
}

/** Build Annex F's still-picture inter-layer/current-picture list subset. */
export function buildLayeredActiveReferenceList(
  interLayerReferences: readonly ReferenceImage[],
  currentPictureReference: ReferenceImage | undefined,
  activeCount: number,
  modification: number[] | null,
  listName: 'L0' | 'L1',
): ReferenceImage[] {
  const referencePictureSet = currentPictureReference
    ? [...interLayerReferences, currentPictureReference]
    : [...interLayerReferences];
  if (referencePictureSet.length === 0 || !Number.isInteger(activeCount) || activeCount < 1)
    invalid(`L-HEVC ${listName} list has no active reference`);

  const tempListSize = Math.max(activeCount, referencePictureSet.length);
  const tempList: ReferenceImage[] = [];
  while (tempList.length < tempListSize) {
    for (const reference of referencePictureSet) {
      if (tempList.length >= tempListSize) break;
      tempList.push(reference);
    }
  }
  const activeList = Array.from({ length: activeCount }, (_, index) => {
    const tempIndex = modification?.[index] ?? index;
    const reference = tempList[tempIndex];
    if (!reference)
      invalid(`L-HEVC ${listName} list modification selects an unavailable reference`);
    return reference;
  });
  if (currentPictureReference && modification === null && tempListSize > activeCount)
    activeList[activeCount - 1] = currentPictureReference;
  return activeList;
}

function parsePpsId(nal: Uint8Array): number {
  const reader = new BitReader(toRbsp(nal));
  return reader.ue();
}

/**
 * Decode one access unit of an L-HEVC image through the selected output layer.
 * Multiple inter-layer sample references, Annex H motion resampling, temporal
 * references supplied by HEIF `pred` items, the Annex F P/B-slice
 * current-picture list subset, and an externally supplied base-layer picture
 * are supported for the decoded still picture.
 */
export function decodeLayeredHevcPicture(
  nals: readonly NalUnit[],
  requiredLayerIds: readonly number[],
  targetLayerId: number,
  externalBaseLayer?: Planes,
  temporalReferencesByLayer: ReadonlyMap<number, readonly Planes[]> = new Map(),
  decodedLayersOutput?: Map<number, Planes>,
): Planes {
  if (requiredLayerIds.length === 0 || requiredLayerIds.at(-1) !== targetLayerId)
    throw new HeicError('INVALID_OPTIONS', 'heic: invalid L-HEVC output-layer dependency order');
  const vpsNal = nals.find((nal) => nal.type === 32);
  if (!vpsNal) invalid('L-HEVC access unit has no VPS');
  const vps = parseLayeredVps(vpsNal.data);
  if (requiredLayerIds.some((layerId) => !vps.layerIds.includes(layerId)))
    invalid('L-HEVC output layer is absent from its VPS');
  if (externalBaseLayer && (!requiredLayerIds.includes(0) || targetLayerId === 0))
    invalid('L-HEVC external base layer is not part of the selected output dependency');
  if (externalBaseLayer && (vps.baseLayerInternal !== false || vps.baseLayerAvailable !== true))
    invalid('L-HEVC VPS does not signal an available external base layer');

  const spsByLayer = new Map<number, Map<number, SpsInfo>>();
  for (const nal of nals) {
    if (nal.type !== 33 || !requiredLayerIds.includes(nal.layerId)) continue;
    const sps = parseSps(nal.data, {
      allowBaseLayerMultilayerExtension: true,
      layeredVps: vps,
    });
    const byId = spsByLayer.get(nal.layerId) ?? new Map<number, SpsInfo>();
    byId.set(sps.spsId, sps);
    spsByLayer.set(nal.layerId, byId);
  }

  const decodedLayers = new Map<number, Planes>();
  if (externalBaseLayer) {
    decodedLayers.set(0, externalBaseLayer);
    decodedLayersOutput?.set(0, externalBaseLayer);
  }
  for (const layerId of requiredLayerIds) {
    const slices = nals.filter((nal) => nal.layerId === layerId && isSliceNal(nal.type));
    if (externalBaseLayer && layerId === 0) {
      if (slices.length > 0)
        invalid('L-HEVC item carries both an external and coded base-layer picture');
      continue;
    }
    if (slices.length === 0) invalid(`required L-HEVC layer ${layerId} has no coded slices`);
    const ppsId = ppsIdFromSlice(slices[0]);
    const pps = checkedPps(nals, layerId, ppsId, vps);
    const sps = spsByLayer.get(layerId)?.get(pps.spsId);
    if (!sps) invalid(`coded layer ${layerId} references missing SPS ${pps.spsId}`);
    const context = layerId === 0 ? undefined : layerContext(vps, layerId);
    const header = parseSliceHeader(slices[0].data, sps, pps, undefined, context);
    const temporalReferences = temporalReferencesByLayer.get(layerId) ?? [];
    let previousTid0PictureOrderCnt: number | null = null;
    for (const reference of temporalReferences) {
      if (reference.temporalId === 0 && reference.pictureOrderCnt !== undefined)
        previousTid0PictureOrderCnt = reference.pictureOrderCnt;
    }
    const currentPoc = derivePictureOrderCnt(sps, header, previousTid0PictureOrderCnt);
    const decodingOrderReferences = temporalReferences.map((reference) => {
      if (reference.pictureOrderCntLsb === undefined || reference.pictureOrderCnt === undefined)
        invalid(`L-HEVC layer ${layerId} pred reference has no parsed picture order count`);
      if (
        reference.width !== sps.width ||
        reference.height !== sps.height ||
        reference.chromaFormatIdc !== sps.chromaFormatIdc ||
        (reference.bitDepthLuma !== undefined && reference.bitDepthLuma !== sps.bitDepthLuma) ||
        (reference.bitDepthChroma !== undefined && reference.bitDepthChroma !== sps.bitDepthChroma)
      )
        throw new HeicError(
          'UNSUPPORTED_FEATURE',
          `heic: L-HEVC layer ${layerId} pred reference format does not match its SPS`,
        );
      return {
        ...asReferenceImage(reference),
        pictureOrderCntLsb: reference.pictureOrderCntLsb,
        pictureOrderCnt: reference.pictureOrderCnt,
        isLongTermReference: false,
      };
    });

    let references: ReferenceImage[] = [];
    let referencesL1: ReferenceImage[] = [];
    if (header.sliceType !== SLICE_TYPE_I) {
      if (header.sliceType !== SLICE_TYPE_P && header.sliceType !== SLICE_TYPE_B)
        unsupported('L-HEVC slice type is not supported for still-image decoding');
      if (
        (!header.interLayerPredictionEnabled || header.interLayerReferenceCount === 0) &&
        !header.currentPictureReferenceEnabled &&
        decodingOrderReferences.length === 0
      )
        unsupported('L-HEVC inter slice has no active temporal or inter-layer reference');
      const interLayerReferences = header.interLayerReferenceLayerIds.map((referenceLayerId) => {
        const source = decodedLayers.get(referenceLayerId);
        if (!source)
          invalid(`L-HEVC layer ${layerId} references an undecoded layer ${referenceLayerId}`);
        const layerIndex = vps.layerIds.indexOf(layerId);
        const referenceLayerIndex = vps.layerIds.indexOf(referenceLayerId);
        const dependencyType = vps.directDependencyTypes[layerIndex]?.[referenceLayerIndex];
        if (dependencyType === null || dependencyType === undefined)
          invalid('L-HEVC slice references a layer without a direct dependency type');
        const predictionCapabilities = getDirectDependencyPredictionCapabilities(dependencyType);
        let predictionSource = predictionCapabilities.motionPredictionEnabled
          ? source
          : withoutInterLayerMotion(source);
        if (
          predictionCapabilities.samplePredictionEnabled &&
          pps.colourMappingTable?.cmRefLayerIds.includes(referenceLayerId)
        )
          predictionSource = applyColourMappingTable(predictionSource, pps.colourMappingTable);
        predictionSource = resampleInterLayerPicture(
          predictionSource,
          sps,
          pps.referenceLocationOffsets.find((entry) => entry.refLocLayerId === referenceLayerId),
        );
        // SHVC inserts the collocated reference-layer picture as a long-term
        // reference, so temporal MVP must not scale its motion with POC delta.
        return {
          ...asReferenceImage(predictionSource),
          isLongTermReference: true,
          samplePredictionEnabled: predictionCapabilities.samplePredictionEnabled,
        };
      });
      if (interLayerReferences.length !== header.interLayerReferenceCount)
        invalid('L-HEVC inter-layer reference count does not match its reference-layer list');
      const interLayerReferenceSets = splitInterLayerReferencePictures(
        vps,
        layerId,
        header.interLayerReferenceLayerIds,
        interLayerReferences,
      );
      const currentPictureReference = header.currentPictureReferenceEnabled
        ? createCurrentPictureReference(sps, currentPoc)
        : undefined;

      if (header.sliceType === SLICE_TYPE_P) {
        references = buildReferenceList0(
          sps,
          header,
          currentPoc,
          decodingOrderReferences,
          interLayerReferences,
          interLayerReferenceSets,
        );
        if (references.length !== header.numRefIdxL0ActiveMinus1 + 1)
          invalid('L-HEVC L0 reference-list length does not match the active count');
      } else {
        const activeL1 = header.numRefIdxL1ActiveMinus1 + 1;
        const lists = buildBReferenceLists(
          sps,
          header,
          currentPoc,
          decodingOrderReferences,
          currentPictureReference,
          interLayerReferences,
          interLayerReferenceSets,
        );
        references = lists.l0;
        referencesL1 = lists.l1;
        if (referencesL1.length !== activeL1)
          invalid('L-HEVC L1 reference-list length does not match the active count');
      }
    } else if (temporalReferences.length > 0) {
      throw new HeicError(
        'INVALID_CONTAINER',
        'heic: intra L-HEVC item cannot carry pred references',
      );
    }

    const picture = new PictureDecoder(
      sps,
      pps,
      references,
      currentPoc,
      referencesL1,
      context,
    ).decode(slices.map((nal) => nal.data));
    deblockPicture(picture, pps, sps.bitDepthLuma, sps.bitDepthChroma);
    applySao(picture, sps, sps.bitDepthLuma, sps.bitDepthChroma);

    const maxPocLsb = 1 << sps.log2MaxPicOrderCntLsb;
    const planes: Planes = {
      y: picture.y,
      cb: picture.cb,
      cr: picture.cr,
      width: picture.width,
      height: picture.height,
      chromaFormatIdc: picture.chromaFormatIdc,
      sourceSps: sps,
      bitDepthLuma: sps.bitDepthLuma,
      bitDepthChroma: sps.bitDepthChroma,
      hasExternalInterMotion: picture.hasExternalInterMotion,
      pictureOrderCntLsb: currentPoc & (maxPocLsb - 1),
      pictureOrderCnt: currentPoc,
      temporalId: slices[0].data.length > 1 ? (slices[0].data[1] & 7) - 1 : 0,
      interMap: picture.interMap,
      motionIsExternal: picture.motionIsExternal,
      motionPredFlags: picture.motionPredFlags,
      motionXQpel: picture.motionXQpel,
      motionYQpel: picture.motionYQpel,
      motionRefIdxL0: picture.motionRefIdxL0,
      motionRefPoc: picture.motionRefPoc,
      motionRefLongTerm: picture.motionRefLongTerm,
      motionRefLayerId: picture.motionRefLayerId,
      motionXQpelL1: picture.motionXQpelL1,
      motionYQpelL1: picture.motionYQpelL1,
      motionRefIdxL1: picture.motionRefIdxL1,
      motionRefPocL1: picture.motionRefPocL1,
      motionRefLongTermL1: picture.motionRefLongTermL1,
      motionRefLayerIdL1: picture.motionRefLayerIdL1,
    };
    decodedLayers.set(layerId, planes);
    decodedLayersOutput?.set(layerId, planes);
  }

  const output = decodedLayers.get(targetLayerId);
  if (!output) invalid('L-HEVC output layer was not reconstructed');
  return output;
}
