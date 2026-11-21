import { HeicError } from './errors.js';
import { getHeicInfo, getItemPayload, type AvcCConfig, type HeicInfo } from './container/heic.js';
import { parseISOBMFF } from './container/heif.js';
import { isHeic, type DecodeOptions } from './decoder.js';
import { chromaSampleLocationFromCode } from './hevc/chroma.js';
import type { ExternalBaseLayerPlanes } from './planes.js';
import {
  buildTiledTileUrl,
  getTiledImageTileIndices,
  parseTiledItemRanges,
} from './container/tili.js';
import initHibernia, {
  initSync as initHiberniaSync,
  WasmDecoder,
} from '../vendor/hibernia/hibernia.js';

interface AvcSpsInfo {
  profileIdc: number;
  chromaFormatIdc: number;
  bitDepthLuma: number;
  bitDepthChroma: number;
  codedWidth: number;
  codedHeight: number;
  displayWidth: number;
  displayHeight: number;
  cropLeft: number;
  cropTop: number;
  frameMbsOnly: boolean;
  gapsInFrameNumAllowed: boolean;
  color: HeicInfo['color'];
  chromaSampleLocation: HeicInfo['chromaSampleLocation'];
}

class AvcBitReader {
  private position = 0;

  constructor(private readonly bytes: Uint8Array) {}

  readBit(): number {
    if (this.position >= this.bytes.length * 8)
      throw new HeicError('INVALID_BITSTREAM', 'heic: truncated AVC sequence parameter set');
    const bit = (this.bytes[this.position >>> 3] >>> (7 - (this.position & 7))) & 1;
    this.position++;
    return bit;
  }

  readBits(count: number): number {
    if (!Number.isInteger(count) || count < 0 || count > 32)
      throw new HeicError('INVALID_BITSTREAM', 'heic: invalid AVC bit field width');
    let value = 0;
    for (let bit = 0; bit < count; bit++) value = value * 2 + this.readBit();
    return value;
  }

  readUnsignedExpGolomb(): number {
    let leadingZeroBits = 0;
    while (this.readBit() === 0) {
      leadingZeroBits++;
      if (leadingZeroBits > 31)
        throw new HeicError('INVALID_BITSTREAM', 'heic: AVC Exp-Golomb value is too large');
    }
    return 2 ** leadingZeroBits - 1 + this.readBits(leadingZeroBits);
  }

  readSignedExpGolomb(): number {
    const code = this.readUnsignedExpGolomb();
    return code & 1 ? (code + 1) / 2 : -(code / 2);
  }
}

function avcRbsp(nal: Uint8Array): Uint8Array {
  if (nal.length < 2 || nal[0] & 0x80 || (nal[0] & 31) !== 7)
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid AVC sequence parameter set NAL unit');
  const output = new Uint8Array(nal.length - 1);
  let length = 0,
    zeroCount = 0;
  for (let offset = 1; offset < nal.length; offset++) {
    const value = nal[offset];
    if (zeroCount >= 2 && value === 3) {
      if (offset + 1 >= nal.length || nal[offset + 1] > 3)
        throw new HeicError('INVALID_BITSTREAM', 'heic: invalid AVC emulation-prevention byte');
      zeroCount = 0;
      continue;
    }
    output[length++] = value;
    zeroCount = value === 0 ? Math.min(2, zeroCount + 1) : 0;
  }
  return output.subarray(0, length);
}

function skipScalingList(reader: AvcBitReader, size: number): void {
  let lastScale = 8,
    nextScale = 8;
  for (let index = 0; index < size; index++) {
    if (nextScale !== 0) nextScale = (lastScale + reader.readSignedExpGolomb() + 256) % 256;
    lastScale = nextScale === 0 ? lastScale : nextScale;
  }
}

function parseAvcVui(reader: AvcBitReader): {
  color: HeicInfo['color'];
  chromaSampleLocation: HeicInfo['chromaSampleLocation'];
} {
  if (reader.readBit()) {
    const aspectRatioIdc = reader.readBits(8);
    if (aspectRatioIdc === 255) reader.readBits(32);
  }
  if (reader.readBit()) reader.readBit();
  let color: HeicInfo['color'] = null;
  if (reader.readBit()) {
    reader.readBits(3);
    const fullRange = reader.readBit() !== 0,
      hasColorDescription = reader.readBit() !== 0;
    if (hasColorDescription)
      color = {
        primaries: reader.readBits(8),
        transfer: reader.readBits(8),
        matrix: reader.readBits(8),
        fullRange,
      };
    else color = { primaries: 2, transfer: 2, matrix: 2, fullRange };
  }
  let chromaSampleLocation: HeicInfo['chromaSampleLocation'];
  if (reader.readBit()) {
    const topField = reader.readUnsignedExpGolomb(),
      bottomField = reader.readUnsignedExpGolomb();
    if (topField !== bottomField)
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        'heic: AVC field-dependent chroma locations are not supported for still images',
      );
    if (topField > 0) {
      const location = chromaSampleLocationFromCode(2, topField - 1);
      if (!location)
        throw new HeicError('INVALID_BITSTREAM', 'heic: invalid AVC chroma sample location');
      chromaSampleLocation = location;
    }
  }
  return { color, chromaSampleLocation };
}

/** Parse the AVC SPS fields needed for a bounded 8-bit progressive 4:2:0 decode. */
export function parseAvcSps(nal: Uint8Array): AvcSpsInfo {
  const reader = new AvcBitReader(avcRbsp(nal)),
    profileIdc = reader.readBits(8);
  reader.readBits(8); // constraint flags and reserved_zero_2bits
  reader.readBits(8); // level_idc
  reader.readUnsignedExpGolomb(); // seq_parameter_set_id
  let chromaFormatIdc = 1,
    bitDepthLuma = 8,
    bitDepthChroma = 8;
  if ([44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 144, 244].includes(profileIdc)) {
    chromaFormatIdc = reader.readUnsignedExpGolomb();
    if (chromaFormatIdc > 3)
      throw new HeicError('INVALID_BITSTREAM', 'heic: invalid AVC chroma_format_idc');
    if (chromaFormatIdc === 3) reader.readBit(); // separate_colour_plane_flag
    bitDepthLuma = reader.readUnsignedExpGolomb() + 8;
    bitDepthChroma = reader.readUnsignedExpGolomb() + 8;
    reader.readBit(); // qpprime_y_zero_transform_bypass_flag
    if (reader.readBit()) {
      const count = chromaFormatIdc === 3 ? 12 : 8;
      for (let index = 0; index < count; index++)
        if (reader.readBit()) skipScalingList(reader, index < 6 ? 16 : 64);
    }
  }
  reader.readUnsignedExpGolomb(); // log2_max_frame_num_minus4
  const picOrderCountType = reader.readUnsignedExpGolomb();
  if (picOrderCountType === 0) reader.readUnsignedExpGolomb();
  else if (picOrderCountType === 1) {
    reader.readBit();
    reader.readSignedExpGolomb();
    reader.readSignedExpGolomb();
    const cycleLength = reader.readUnsignedExpGolomb();
    if (cycleLength > 255)
      throw new HeicError('INVALID_BITSTREAM', 'heic: AVC POC cycle is too large');
    for (let index = 0; index < cycleLength; index++) reader.readSignedExpGolomb();
  } else if (picOrderCountType !== 2)
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid AVC pic_order_cnt_type');
  const maxNumRefFrames = reader.readUnsignedExpGolomb(),
    gapsInFrameNumAllowed = reader.readBit() !== 0,
    widthInMbs = reader.readUnsignedExpGolomb() + 1,
    heightInMapUnits = reader.readUnsignedExpGolomb() + 1,
    frameMbsOnly = reader.readBit() !== 0;
  if (!frameMbsOnly) reader.readBit(); // mb_adaptive_frame_field_flag
  reader.readBit(); // direct_8x8_inference_flag
  let cropLeft = 0,
    cropRight = 0,
    cropTop = 0,
    cropBottom = 0;
  if (reader.readBit()) {
    cropLeft = reader.readUnsignedExpGolomb();
    cropRight = reader.readUnsignedExpGolomb();
    cropTop = reader.readUnsignedExpGolomb();
    cropBottom = reader.readUnsignedExpGolomb();
  }
  let color: HeicInfo['color'] = null,
    chromaSampleLocation: HeicInfo['chromaSampleLocation'];
  if (reader.readBit()) ({ color, chromaSampleLocation } = parseAvcVui(reader));

  const subWidth = chromaFormatIdc === 1 || chromaFormatIdc === 2 ? 2 : 1,
    subHeight = chromaFormatIdc === 1 ? 2 : 1,
    cropUnitX = chromaFormatIdc === 0 ? 1 : subWidth,
    cropUnitY = (chromaFormatIdc === 0 ? 1 : subHeight) * (frameMbsOnly ? 1 : 2),
    codedWidth = widthInMbs * 16,
    codedHeight = heightInMapUnits * 16 * (frameMbsOnly ? 1 : 2),
    displayWidth = codedWidth - cropUnitX * (cropLeft + cropRight),
    displayHeight = codedHeight - cropUnitY * (cropTop + cropBottom);
  if (
    !Number.isSafeInteger(codedWidth * codedHeight) ||
    codedWidth <= 0 ||
    codedHeight <= 0 ||
    displayWidth <= 0 ||
    displayHeight <= 0 ||
    maxNumRefFrames > 16
  )
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid AVC picture dimensions or references');
  return {
    profileIdc,
    chromaFormatIdc,
    bitDepthLuma,
    bitDepthChroma,
    codedWidth,
    codedHeight,
    displayWidth,
    displayHeight,
    cropLeft: cropLeft * cropUnitX,
    cropTop: cropTop * cropUnitY,
    frameMbsOnly,
    gapsInFrameNumAllowed,
    color,
    chromaSampleLocation,
  };
}

let hiberniaReady: Promise<void> | undefined;
let hiberniaInitialized = false;

function nodeFileSystem(): { readFileSync(path: URL): Uint8Array } | undefined {
  const runtime = (
    globalThis as typeof globalThis & {
      process?: {
        versions?: { node?: string };
        getBuiltinModule?: (name: string) => { readFileSync(path: URL): Uint8Array } | undefined;
      };
    }
  ).process;
  if (!runtime?.versions?.node) return undefined;
  const fileSystem = runtime.getBuiltinModule?.('fs');
  if (!fileSystem)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: synchronous AVC WebAssembly loading requires Node.js 20.16 or newer',
    );
  return fileSystem;
}

function ensureHiberniaSync(): void {
  if (hiberniaInitialized) return;
  const fileSystem = nodeFileSystem();
  if (!fileSystem)
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      'heic: synchronous AVC decoding requires Node.js 20.16 or newer; use async decode() in browsers',
    );
  const wasmUrl = new URL('../vendor/hibernia/hibernia_wasm_bg.wasm', import.meta.url);
  initHiberniaSync({ module: fileSystem.readFileSync(wasmUrl) });
  hiberniaInitialized = true;
}

async function ensureHibernia(): Promise<void> {
  if (hiberniaInitialized) return;
  if (!hiberniaReady) {
    hiberniaReady = (async () => {
      const wasmUrl = new URL('../vendor/hibernia/hibernia_wasm_bg.wasm', import.meta.url),
        fileSystem = nodeFileSystem();
      if (fileSystem) {
        initHiberniaSync({ module: fileSystem.readFileSync(wasmUrl) });
      } else await initHibernia(wasmUrl);
      hiberniaInitialized = true;
    })().catch((error: unknown) => {
      hiberniaReady = undefined;
      throw error;
    });
  }
  return hiberniaReady;
}

function joinAvcNals(configuration: AvcCConfig, payload: Uint8Array): Uint8Array {
  const parameterSets = [
    ...configuration.sequenceParameterSets,
    ...configuration.pictureParameterSets,
    ...configuration.sequenceParameterSetExtensions,
  ];
  let total = parameterSets.reduce((sum, nal) => sum + 4 + nal.length, 0),
    offset = 0;
  const nals: Uint8Array[] = [];
  for (const nal of parameterSets) nals.push(nal);
  while (offset < payload.length) {
    if (offset + configuration.nalLengthSize > payload.length)
      throw new HeicError('INVALID_CONTAINER', 'heic: truncated AVC NAL length');
    let length = 0;
    for (let byte = 0; byte < configuration.nalLengthSize; byte++)
      length = length * 256 + payload[offset++];
    if (length === 0 || offset + length > payload.length)
      throw new HeicError('INVALID_CONTAINER', 'heic: invalid AVC NAL length');
    nals.push(payload.subarray(offset, offset + length));
    total += 4 + length;
    offset += length;
    if (total > 64 * 1024 * 1024)
      throw new HeicError('RESOURCE_LIMIT', 'heic: AVC access unit exceeds 64 MiB');
  }
  if (!parameterSets.length || nals.length === parameterSets.length)
    throw new HeicError('INVALID_CONTAINER', 'heic: AVC item has no coded NAL units');
  const annexB = new Uint8Array(total);
  offset = 0;
  for (const nal of nals) {
    annexB.set([0, 0, 0, 1], offset);
    offset += 4;
    annexB.set(nal, offset);
    offset += nal.length;
  }
  return annexB;
}

function copyPlane(
  source: Uint8Array,
  sourceStride: number,
  sourceX: number,
  sourceY: number,
  width: number,
  height: number,
): Uint8Array {
  if (
    sourceStride < sourceX + width ||
    (height > 0 && source.length < (sourceY + height - 1) * sourceStride + sourceX + width)
  )
    throw new HeicError('INVALID_BITSTREAM', 'heic: AVC decoder returned a truncated sample plane');
  const output = new Uint8Array(width * height);
  for (let row = 0; row < height; row++)
    output.set(
      source.subarray(
        (sourceY + row) * sourceStride + sourceX,
        (sourceY + row) * sourceStride + sourceX + width,
      ),
      row * width,
    );
  return output;
}

function supportedSps(
  configuration: AvcCConfig,
  width: number,
  height: number,
  maxPixels: number,
): AvcSpsInfo {
  const sps = configuration.sequenceParameterSets.map(parseAvcSps);
  if (!sps.length)
    throw new HeicError('INVALID_CONTAINER', 'heic: avcC has no sequence parameter set');
  const supportedProfiles = new Set([66, 77, 100]);
  for (const candidate of sps) {
    if (!supportedProfiles.has(candidate.profileIdc))
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        `heic: bundled AVC decoder does not support profile_idc ${candidate.profileIdc}`,
      );
    if (
      candidate.chromaFormatIdc !== 1 ||
      candidate.bitDepthLuma !== 8 ||
      candidate.bitDepthChroma !== 8 ||
      !candidate.frameMbsOnly ||
      candidate.gapsInFrameNumAllowed
    )
      throw new HeicError(
        'UNSUPPORTED_FEATURE',
        'heic: bundled AVC decoder supports progressive 8-bit 4:2:0 without frame-number gaps',
      );
    if (
      candidate.displayWidth !== width ||
      candidate.displayHeight !== height ||
      candidate.codedWidth * candidate.codedHeight >
        Math.max(maxPixels + 1_000_000, maxPixels * 1.1)
    )
      throw new HeicError(
        'INVALID_CONTAINER',
        'heic: AVC SPS dimensions disagree with ispe or exceed maxPixels',
      );
  }
  const first = sps[0];
  if (
    sps.some(
      (candidate) =>
        candidate.displayWidth !== first.displayWidth ||
        candidate.displayHeight !== first.displayHeight ||
        candidate.chromaFormatIdc !== first.chromaFormatIdc,
    )
  )
    throw new HeicError('UNSUPPORTED_FEATURE', 'heic: AVC resolution changes are not supported');
  return first;
}

function decodeAvcItemCore(
  input: Uint8Array,
  boxes: ReturnType<typeof parseISOBMFF>,
  info: HeicInfo,
  options: DecodeOptions,
  payloadOverride?: Uint8Array,
): ExternalBaseLayerPlanes {
  const configuration = info.avcC,
    width = info.width,
    height = info.height,
    maxPixels = options.maxPixels ?? 50_000_000;
  if (!configuration)
    throw new HeicError('INVALID_CONTAINER', `heic: avc1 item ${info.primaryItemId} has no avcC`);
  if (
    !Number.isSafeInteger(width * height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > maxPixels
  )
    throw new HeicError('RESOURCE_LIMIT', 'heic: AVC image exceeds maxPixels');
  const parsedSps = supportedSps(configuration, width, height, maxPixels),
    payload =
      payloadOverride ?? getItemPayload(input, boxes, info.primaryItemId, options.externalItemData);
  if (!payload)
    throw new HeicError(
      'INVALID_CONTAINER',
      `heic: avc1 item ${info.primaryItemId} has no payload`,
    );
  const annexB = joinAvcNals(configuration, payload);
  let decoder: InstanceType<typeof WasmDecoder> | undefined,
    frame: ReturnType<InstanceType<typeof WasmDecoder>['decode_next_frame']>;
  try {
    decoder = new WasmDecoder(annexB);
    frame = decoder.decode_next_frame();
    if (!frame)
      throw new HeicError('INVALID_BITSTREAM', 'heic: AVC decoder produced no image frame');
    const displayWidth = frame.display_width(),
      displayHeight = frame.display_height(),
      codedWidth = frame.width(),
      codedHeight = frame.height(),
      cropLeft = frame.crop_left(),
      cropTop = frame.crop_top();
    if (
      displayWidth !== info.width ||
      displayHeight !== info.height ||
      codedWidth !== parsedSps.codedWidth ||
      codedHeight !== parsedSps.codedHeight ||
      cropLeft !== parsedSps.cropLeft ||
      cropTop !== parsedSps.cropTop ||
      (cropLeft & 1) !== 0 ||
      (cropTop & 1) !== 0
    )
      throw new HeicError(
        'INVALID_CONTAINER',
        'heic: AVC decoder dimensions disagree with ispe/SPS',
      );
    const y = copyPlane(
        frame.y_data(),
        frame.y_stride(),
        cropLeft,
        cropTop,
        displayWidth,
        displayHeight,
      ),
      chromaWidth = Math.ceil(displayWidth / 2),
      chromaHeight = Math.ceil(displayHeight / 2),
      chromaX = cropLeft / 2,
      chromaY = cropTop / 2,
      cb = copyPlane(frame.u_data(), frame.u_stride(), chromaX, chromaY, chromaWidth, chromaHeight),
      cr = copyPlane(frame.v_data(), frame.v_stride(), chromaX, chromaY, chromaWidth, chromaHeight),
      anotherFrame = decoder.decode_next_frame();
    if (anotherFrame) {
      anotherFrame.free();
      throw new HeicError('UNSUPPORTED_FEATURE', 'heic: AVC item contains more than one picture');
    }
    return {
      width: displayWidth,
      height: displayHeight,
      chromaFormatIdc: 1,
      bitDepthLuma: 8,
      bitDepthChroma: 8,
      y,
      cb,
      cr,
      ...((info.color ?? parsedSps.color) ? { color: info.color ?? parsedSps.color } : {}),
      ...((info.chromaSampleLocation ?? parsedSps.chromaSampleLocation)
        ? { chromaSampleLocation: info.chromaSampleLocation ?? parsedSps.chromaSampleLocation }
        : {}),
    };
  } catch (cause) {
    if (cause instanceof HeicError) throw cause;
    const message = cause instanceof Error ? cause.message : String(cause),
      code = /FeatureNotSupported|not supported|unsupported/i.test(message)
        ? 'UNSUPPORTED_FEATURE'
        : 'INVALID_BITSTREAM';
    throw new HeicError(code, `heic: AVC decode failed: ${message}`, { cause });
  } finally {
    frame?.free();
    decoder?.free();
  }
}

function decodeAvcItem(
  input: Uint8Array,
  boxes: ReturnType<typeof parseISOBMFF>,
  info: HeicInfo,
  options: DecodeOptions,
  payloadOverride?: Uint8Array,
): Promise<ExternalBaseLayerPlanes> {
  return ensureHibernia().then(() =>
    decodeAvcItemCore(input, boxes, info, options, payloadOverride),
  );
}

function decodeAvcItemSync(
  input: Uint8Array,
  boxes: ReturnType<typeof parseISOBMFF>,
  info: HeicInfo,
  options: DecodeOptions,
  payloadOverride?: Uint8Array,
): ExternalBaseLayerPlanes {
  ensureHiberniaSync();
  return decodeAvcItemCore(input, boxes, info, options, payloadOverride);
}

/** Prepare AVC image items and tiles for synchronous rendering in Node.js. */
export function prepareAvcDecodeOptionsSync(
  input: Uint8Array,
  options: DecodeOptions,
): DecodeOptions {
  if (!isHeic(input)) return options;
  const boxes = parseISOBMFF(input),
    info = getHeicInfo(input, boxes, options.itemId),
    baseInfo =
      info.primaryItemType === 'tmap' && info.derivedItems.length === 2
        ? getHeicInfo(input, boxes, info.derivedItems[0])
        : info;
  const itemIds = [
      ...(baseInfo.primaryItemType === 'avc1' ? [baseInfo.primaryItemId] : []),
      ...(baseInfo.alphaItemId === null ? [] : [baseInfo.alphaItemId]),
      ...(baseInfo.miniGainMap ? [baseInfo.miniGainMap.imageItemId] : []),
      ...(baseInfo.externalBaseLayerItemId === undefined ? [] : [baseInfo.externalBaseLayerItemId]),
      ...(info.primaryItemType === 'avc1' && info.primaryItemId !== baseInfo.primaryItemId
        ? [info.primaryItemId]
        : []),
    ],
    externalBaseLayerPlanes: Record<number, ExternalBaseLayerPlanes> = {
      ...options.externalBaseLayerPlanes,
    },
    externalTileBaseLayerPlanes: Record<
      string,
      Readonly<Record<number, ExternalBaseLayerPlanes>>
    > = { ...options.externalTileBaseLayerPlanes },
    avcTiliTilePlanes: Record<number, Readonly<Record<number, ExternalBaseLayerPlanes>>> = {
      ...options.avcTiliTilePlanes,
    };
  let changed = false;
  for (const itemId of new Set(itemIds)) {
    if (externalBaseLayerPlanes[itemId]) continue;
    const avcInfo = getHeicInfo(input, boxes, itemId);
    if (avcInfo.primaryItemType !== 'avc1' || avcInfo.tiledImage) continue;
    externalBaseLayerPlanes[itemId] = decodeAvcItemSync(input, boxes, avcInfo, options);
    changed = true;
  }

  const tiledImage = info.tiledImage;
  if (tiledImage?.dataReference.externalTileUrls && options.externalTileData) {
    let decodedPixels = 0,
      externalBytes = 0;
    const urls = new Set(
      getTiledImageTileIndices(tiledImage, options.extraDimensionIndexes).map((index) =>
        buildTiledTileUrl(tiledImage.dataReference, index),
      ),
    );
    if (urls.size > 65_536)
      throw new HeicError('RESOURCE_LIMIT', 'heic: external tili tile count exceeds 65536');
    for (const url of urls) {
      const payload = options.externalTileData[url];
      if (!payload) continue;
      if (!(payload instanceof Uint8Array))
        throw new HeicError('INVALID_OPTIONS', 'heic: externalTileData values must be Uint8Array');
      if (payload.length > 64 * 1024 * 1024)
        throw new HeicError('RESOURCE_LIMIT', 'heic: external tili tile exceeds 64 MiB');
      externalBytes += payload.byteLength;
      if (!Number.isSafeInteger(externalBytes) || externalBytes > 64 * 1024 * 1024)
        throw new HeicError('RESOURCE_LIMIT', 'heic: external tile data exceeds 64 MiB total');
      if (!isHeic(payload)) continue;
      const tileBoxes = parseISOBMFF(payload),
        tileInfo = getHeicInfo(payload, tileBoxes);
      if (tileInfo.primaryItemType !== 'avc1') continue;
      const pixels = tileInfo.width * tileInfo.height;
      decodedPixels += pixels;
      if (
        !Number.isSafeInteger(pixels) ||
        pixels <= 0 ||
        pixels > (options.maxPixels ?? 50_000_000) ||
        !Number.isSafeInteger(decodedPixels) ||
        decodedPixels > 200_000_000
      )
        throw new HeicError('RESOURCE_LIMIT', 'heic: external AVC tile decode work exceeds limit');
      if (!externalTileBaseLayerPlanes[url]?.[tileInfo.primaryItemId]) {
        externalTileBaseLayerPlanes[url] = {
          ...externalTileBaseLayerPlanes[url],
          [tileInfo.primaryItemId]: decodeAvcItemSync(payload, tileBoxes, tileInfo, options),
        };
        changed = true;
      }
    }
  }

  if (
    tiledImage &&
    !tiledImage.dataReference.externalTileUrls &&
    tiledImage.tileItemType === 'avc1'
  ) {
    if (!info.avcC)
      throw new HeicError('INVALID_CONTAINER', 'heic: avc1 tili image has no avcC configuration');
    const itemData = getItemPayload(input, boxes, info.primaryItemId, options.externalItemData);
    if (!itemData)
      throw new HeicError('INVALID_CONTAINER', 'heic: avc1 tili image has no tile data');
    const ranges = parseTiledItemRanges(
        itemData,
        tiledImage.dataReference,
        tiledImage.dataReference.inputItemCount,
      ),
      indexes = getTiledImageTileIndices(tiledImage, options.extraDimensionIndexes);
    if (indexes.length > 65_536)
      throw new HeicError('RESOURCE_LIMIT', 'heic: AVC tili plane exceeds 65536 tiles');
    const planesForItem: Record<number, ExternalBaseLayerPlanes> = {
      ...(avcTiliTilePlanes[info.primaryItemId] ?? {}),
    };
    const tileInfo: HeicInfo = {
      ...info,
      primaryItemType: 'avc1',
      width: tiledImage.tileWidth,
      height: tiledImage.tileHeight,
      hvcC: null,
      lhevc: null,
      grid: null,
      tiledImage: null,
      transforms: [],
    };
    let decodedPixels = 0;
    for (const index of indexes) {
      const range = ranges[index];
      if (!range || planesForItem[index]) continue;
      const pixels = tiledImage.tileWidth * tiledImage.tileHeight;
      decodedPixels += pixels;
      if (
        !Number.isSafeInteger(pixels) ||
        pixels <= 0 ||
        pixels > (options.maxPixels ?? 50_000_000) ||
        !Number.isSafeInteger(decodedPixels) ||
        decodedPixels > 200_000_000
      )
        throw new HeicError('RESOURCE_LIMIT', 'heic: AVC tili decode work exceeds limit');
      planesForItem[index] = decodeAvcItemSync(
        input,
        boxes,
        tileInfo,
        options,
        itemData.subarray(range.offset, range.offset + range.length),
      );
      changed = true;
    }
    if (changed) avcTiliTilePlanes[info.primaryItemId] = planesForItem;
  }

  return changed
    ? { ...options, externalBaseLayerPlanes, externalTileBaseLayerPlanes, avcTiliTilePlanes }
    : options;
}

/** Decode selected AVC items to planes before running the normal HEIF renderer. */
export async function prepareAvcDecodeOptions(
  input: Uint8Array,
  options: DecodeOptions,
): Promise<DecodeOptions> {
  if (!isHeic(input)) return options;
  const boxes = parseISOBMFF(input),
    info = getHeicInfo(input, boxes, options.itemId),
    baseInfo =
      info.primaryItemType === 'tmap' && info.derivedItems.length === 2
        ? getHeicInfo(input, boxes, info.derivedItems[0])
        : info,
    itemIds = [
      ...(baseInfo.primaryItemType === 'avc1' ? [baseInfo.primaryItemId] : []),
      ...(baseInfo.alphaItemId === null ? [] : [baseInfo.alphaItemId]),
      ...(baseInfo.miniGainMap ? [baseInfo.miniGainMap.imageItemId] : []),
      ...(baseInfo.externalBaseLayerItemId === undefined ? [] : [baseInfo.externalBaseLayerItemId]),
      ...(info.primaryItemType === 'avc1' && info.primaryItemId !== baseInfo.primaryItemId
        ? [info.primaryItemId]
        : []),
    ],
    externalBaseLayerPlanes: Record<number, ExternalBaseLayerPlanes> = {
      ...options.externalBaseLayerPlanes,
    },
    externalTileBaseLayerPlanes: Record<
      string,
      Readonly<Record<number, ExternalBaseLayerPlanes>>
    > = { ...options.externalTileBaseLayerPlanes };
  const avcTiliTilePlanes: Record<number, Readonly<Record<number, ExternalBaseLayerPlanes>>> = {
    ...options.avcTiliTilePlanes,
  };
  let changed = false;
  for (const itemId of new Set(itemIds)) {
    if (externalBaseLayerPlanes[itemId]) continue;
    const avcInfo = getHeicInfo(input, boxes, itemId);
    if (avcInfo.primaryItemType !== 'avc1') continue;
    externalBaseLayerPlanes[itemId] = await decodeAvcItem(input, boxes, avcInfo, options);
    changed = true;
  }

  const tiledImage = info.tiledImage;
  if (tiledImage?.dataReference.externalTileUrls && options.externalTileData) {
    let decodedPixels = 0,
      externalBytes = 0;
    const urls = new Set(
      getTiledImageTileIndices(tiledImage, options.extraDimensionIndexes).map((index) =>
        buildTiledTileUrl(tiledImage.dataReference, index),
      ),
    );
    if (urls.size > 65_536)
      throw new HeicError('RESOURCE_LIMIT', 'heic: external tili tile count exceeds 65536');
    for (const url of urls) {
      const payload = options.externalTileData[url];
      if (!payload) continue;
      if (!(payload instanceof Uint8Array))
        throw new HeicError('INVALID_OPTIONS', 'heic: externalTileData values must be Uint8Array');
      if (payload.length > 64 * 1024 * 1024)
        throw new HeicError('RESOURCE_LIMIT', 'heic: external tili tile exceeds 64 MiB');
      externalBytes += payload.byteLength;
      if (!Number.isSafeInteger(externalBytes) || externalBytes > 64 * 1024 * 1024)
        throw new HeicError('RESOURCE_LIMIT', 'heic: external tile data exceeds 64 MiB total');
      if (!isHeic(payload)) continue;
      const tileBoxes = parseISOBMFF(payload),
        tileInfo = getHeicInfo(payload, tileBoxes);
      if (tileInfo.primaryItemType !== 'avc1') continue;
      const pixels = tileInfo.width * tileInfo.height;
      decodedPixels += pixels;
      if (
        !Number.isSafeInteger(pixels) ||
        pixels <= 0 ||
        pixels > (options.maxPixels ?? 50_000_000) ||
        !Number.isSafeInteger(decodedPixels) ||
        decodedPixels > 200_000_000
      )
        throw new HeicError('RESOURCE_LIMIT', 'heic: external AVC tile decode work exceeds limit');
      if (!externalTileBaseLayerPlanes[url]?.[tileInfo.primaryItemId]) {
        externalTileBaseLayerPlanes[url] = {
          ...externalTileBaseLayerPlanes[url],
          [tileInfo.primaryItemId]: await decodeAvcItem(payload, tileBoxes, tileInfo, options),
        };
        changed = true;
      }
    }
  }

  if (
    tiledImage &&
    !tiledImage.dataReference.externalTileUrls &&
    tiledImage.tileItemType === 'avc1'
  ) {
    if (!info.avcC)
      throw new HeicError('INVALID_CONTAINER', 'heic: avc1 tili image has no avcC configuration');
    const itemData = getItemPayload(input, boxes, info.primaryItemId, options.externalItemData);
    if (!itemData)
      throw new HeicError('INVALID_CONTAINER', 'heic: avc1 tili image has no tile data');
    const ranges = parseTiledItemRanges(
        itemData,
        tiledImage.dataReference,
        tiledImage.dataReference.inputItemCount,
      ),
      indexes = getTiledImageTileIndices(tiledImage, options.extraDimensionIndexes);
    if (indexes.length > 65_536)
      throw new HeicError('RESOURCE_LIMIT', 'heic: AVC tili plane exceeds 65536 tiles');
    const planesForItem: Record<number, ExternalBaseLayerPlanes> = {
      ...(avcTiliTilePlanes[info.primaryItemId] ?? {}),
    };
    const tileInfo: HeicInfo = {
      ...info,
      primaryItemType: 'avc1',
      width: tiledImage.tileWidth,
      height: tiledImage.tileHeight,
      hvcC: null,
      lhevc: null,
      grid: null,
      tiledImage: null,
      transforms: [],
    };
    let decodedPixels = 0;
    for (const index of indexes) {
      const range = ranges[index];
      if (!range || planesForItem[index]) continue;
      const pixels = tiledImage.tileWidth * tiledImage.tileHeight;
      decodedPixels += pixels;
      if (
        !Number.isSafeInteger(pixels) ||
        pixels <= 0 ||
        pixels > (options.maxPixels ?? 50_000_000) ||
        !Number.isSafeInteger(decodedPixels) ||
        decodedPixels > 200_000_000
      )
        throw new HeicError('RESOURCE_LIMIT', 'heic: AVC tili decode work exceeds limit');
      planesForItem[index] = await decodeAvcItem(
        input,
        boxes,
        tileInfo,
        options,
        itemData.subarray(range.offset, range.offset + range.length),
      );
      changed = true;
    }
    if (changed) avcTiliTilePlanes[info.primaryItemId] = planesForItem;
  }

  return changed
    ? { ...options, externalBaseLayerPlanes, externalTileBaseLayerPlanes, avcTiliTilePlanes }
    : options;
}
