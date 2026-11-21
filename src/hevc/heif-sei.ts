import { getHeicInfo, getItemPayload, type HeicInfo } from '../container/heic.js';
import { HeicError } from '../errors.js';
import { parseTiledItemRanges } from '../container/tili.js';
import type { ISOBMFFBox } from '../container/heif.js';
import { parseSps } from './sps.js';
import {
  parseHevcAuxiliarySeiNals,
  parseHevcHdrSeiNals,
  parseHevcPictureTimingSeiNals,
  type HevcAlphaChannelInformation,
  type HevcAuxiliarySeiMetadata,
  type HevcSeiMetadata,
} from './sei.js';
import { splitLengthPrefixed } from './nal.js';

function attachFieldPictureTiming(
  metadata: HevcSeiMetadata | undefined,
  itemNals: readonly Uint8Array[],
  sampleSps: ReturnType<typeof parseSps> | null,
): HevcSeiMetadata | undefined {
  if (!sampleSps?.fieldSequence) return metadata;
  const pictureTiming = parseHevcPictureTimingSeiNals(itemNals, sampleSps.frameFieldInfoPresent);
  if (!pictureTiming)
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: field-sequence access unit has no picture_timing field information',
    );
  if (![1, 2, 9, 10, 11, 12].includes(pictureTiming.picStruct))
    throw new HeicError(
      'INVALID_BITSTREAM',
      'heic: field-sequence picture_timing pic_struct does not identify a field',
    );
  return { ...metadata, pictureTiming };
}

function layerId(nal: Uint8Array): number {
  return ((nal[0] & 1) << 5) | (nal[1] >> 3);
}

/** Parse the HEVC-specific auxC subtype using the associated decoder record. */
export function parseHevcAuxiliarySeiConfigSubtype(
  subtype: Uint8Array | undefined,
  nalLengthSize: number,
  targetLayerId = 0,
): HevcAuxiliarySeiMetadata | undefined {
  if (!subtype?.length) return undefined;
  if (subtype.length < 4)
    throw new HeicError('INVALID_CONTAINER', 'heic: truncated HEVC auxiliary subtype');
  const seiMessageLength = new DataView(
    subtype.buffer,
    subtype.byteOffset,
    subtype.byteLength,
  ).getUint32(0);
  if (seiMessageLength !== subtype.length - 4)
    throw new HeicError('INVALID_CONTAINER', 'heic: invalid HEVC auxiliary subtype length');

  const nals = splitLengthPrefixed(subtype.subarray(4), nalLengthSize, false, [targetLayerId]);
  return parseHevcAuxiliarySeiNals(nals.map((nal) => nal.data));
}

/** Read an auxiliary item's subtype using the configuration associated with that item. */
export function getHevcAuxiliarySeiForItem(
  parentInfo: HeicInfo,
  auxiliaryItemId: number,
  auxiliaryInfo: HeicInfo,
): HevcAuxiliarySeiMetadata | undefined {
  const descriptor = parentInfo.auxiliaryImages.find((item) => item.itemId === auxiliaryItemId);
  if (!descriptor?.hevcAuxConfigSubtype) return undefined;
  const nalLengthSize =
    auxiliaryInfo.lhevc?.configuration.nalLengthSize ?? auxiliaryInfo.hvcC?.nalLengthSize;
  if (nalLengthSize === undefined)
    throw new HeicError(
      'INVALID_CONTAINER',
      `heic: auxiliary image item ${auxiliaryItemId} has no HEVC NAL length size`,
    );
  return parseHevcAuxiliarySeiConfigSubtype(
    descriptor.hevcAuxConfigSubtype,
    nalLengthSize,
    auxiliaryInfo.lhevc?.targetLayerId ?? 0,
  );
}

/** Resolve the last non-cancelled ACI message whose use_idc is defined here. */
export function activeHevcAlphaChannelInfo(
  metadata: HevcAuxiliarySeiMetadata | undefined,
): HevcAlphaChannelInformation | undefined {
  let active: HevcAlphaChannelInformation | undefined;
  for (const message of metadata?.alphaChannelInfo ?? []) {
    if (message.cancelled) active = undefined;
    else if (message.useIdc === undefined || message.useIdc <= 2) active = message;
  }
  return active;
}

/** Convert one coded alpha sample to its H.274 foreground weight, when signalled. */
export function hevcAlphaSampleToFactor(
  sample: number,
  metadata: HevcAlphaChannelInformation | undefined,
): number | undefined {
  if (
    !metadata ||
    metadata.cancelled ||
    (metadata.useIdc !== undefined && metadata.useIdc > 2) ||
    metadata.transparentValue === undefined ||
    metadata.opaqueValue === undefined
  )
    return undefined;

  const transparent = metadata.transparentValue,
    opaque = metadata.opaqueValue,
    range = Math.abs(opaque - transparent);
  if (range === 0) return undefined;

  let interpreted = sample;
  if (metadata.clip) {
    if (metadata.clipType === 0) {
      interpreted =
        interpreted > (opaque + transparent) / 2
          ? Math.max(opaque, transparent)
          : Math.min(opaque, transparent);
    } else if (metadata.clipType === 1) {
      if (interpreted > Math.max(opaque, transparent)) interpreted = Math.max(opaque, transparent);
      else if (interpreted <= Math.min(opaque, transparent))
        interpreted = Math.min(opaque, transparent);
    }
  }
  if (metadata.increment && interpreted > Math.min(opaque, transparent)) interpreted++;
  return Math.abs(interpreted - transparent) / range;
}

/** Read supported SEI metadata associated with the selected HEVC still-image layer. */
export function getHevcSeiMetadata(
  input: Uint8Array,
  boxes: ISOBMFFBox[],
  info: HeicInfo,
  externalItemData?: Readonly<Record<number, Uint8Array>>,
): HevcSeiMetadata | undefined {
  if (info.lhevc) {
    const configuration = info.lhevc.configuration,
      targetLayerId = info.lhevc.targetLayerId,
      itemPayload = getItemPayload(input, boxes, info.primaryItemId, externalItemData);
    let payload = itemPayload;
    if (payload && info.tiledImage) {
      const ranges = parseTiledItemRanges(
        payload,
        info.tiledImage.dataReference,
        info.tiledImage.dataReference.inputItemCount,
      );
      const firstTile = ranges.find((range) => range !== null);
      payload = firstTile
        ? payload.subarray(firstTile.offset, firstTile.offset + firstTile.length)
        : null;
    }
    const itemNals = payload
        ? splitLengthPrefixed(
            payload,
            configuration.nalLengthSize,
            false,
            info.lhevc.requiredLayerIds,
          )
        : [],
      configurationSei = configuration.arrays.flatMap((array) =>
        array.nalUnits
          .filter(
            (nal) =>
              nal.layerId === targetLayerId &&
              (array.nalUnitType === 39 || array.nalUnitType === 40),
          )
          .map((nal) => nal.data),
      ),
      sampleSpsNal =
        itemNals.find((nal) => nal.layerId === targetLayerId && nal.type === 33) ??
        configuration.arrays
          .filter((array) => array.nalUnitType === 33)
          .flatMap((array) => array.nalUnits)
          .find((nal) => nal.layerId === targetLayerId),
      sampleSps = sampleSpsNal
        ? parseSps(sampleSpsNal.data, { layeredVps: info.lhevc.selectedVps ?? undefined })
        : null,
      chromaSampleLocType = sampleSps?.chromaSampleLocTypeTopField ?? 0,
      chromaSampleLocTypeBottomField =
        sampleSps?.chromaSampleLocTypeBottomField ?? chromaSampleLocType;
    const metadata = parseHevcHdrSeiNals(
      [
        ...configurationSei,
        ...itemNals.filter((nal) => nal.layerId === targetLayerId).map((nal) => nal.data),
      ],
      info.lhevc.selectedRepresentationFormat?.chromaFormatIdc ?? 1,
      chromaSampleLocType,
      chromaSampleLocTypeBottomField,
    );
    return attachFieldPictureTiming(
      metadata,
      itemNals.filter((nal) => nal.layerId === targetLayerId).map((nal) => nal.data),
      sampleSps,
    );
  }

  if (!info.hvcC) return undefined;
  const codedItemId = info.grid?.tileItemIds[0] ?? info.primaryItemId,
    codedInfo = codedItemId === info.primaryItemId ? info : getHeicInfo(input, boxes, codedItemId),
    configuration = codedInfo.hvcC ?? info.hvcC,
    baseLayerOnly =
      codedInfo.primaryItemType === 'hvc1' || codedInfo.tiledImage?.tileItemType === 'hvc1';
  let payload = getItemPayload(input, boxes, codedItemId, externalItemData);
  if (payload && codedInfo.tiledImage) {
    const ranges = parseTiledItemRanges(
      payload,
      codedInfo.tiledImage.dataReference,
      codedInfo.tiledImage.dataReference.inputItemCount,
    );
    const firstTile = ranges.find((range) => range !== null);
    payload = firstTile
      ? payload.subarray(firstTile.offset, firstTile.offset + firstTile.length)
      : null;
  }
  const itemNals = payload
      ? splitLengthPrefixed(payload, configuration.nalLengthSize, baseLayerOnly)
      : [],
    configurationSei = configuration.seiNals.filter((nal) => layerId(nal) === 0),
    sampleSps = configuration.sps[0]
      ? parseSps(configuration.sps[0], {
          allowBaseLayerMultilayerExtension: baseLayerOnly,
        })
      : null,
    chromaSampleLocType = sampleSps?.chromaSampleLocTypeTopField ?? 0,
    chromaSampleLocTypeBottomField =
      sampleSps?.chromaSampleLocTypeBottomField ?? chromaSampleLocType;
  const metadata = parseHevcHdrSeiNals(
    [...configurationSei, ...itemNals.map((nal) => nal.data)],
    configuration.chromaFormatIdc,
    chromaSampleLocType,
    chromaSampleLocTypeBottomField,
  );
  return attachFieldPictureTiming(
    metadata,
    itemNals.filter((nal) => nal.layerId === 0).map((nal) => nal.data),
    sampleSps,
  );
}
