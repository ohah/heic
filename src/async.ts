import { decodeHDRSync, type HdrOptions, type HdrImage } from './hdr.js';
import { HeicError } from './errors.js';
import type { DecodeOptions, HeicImageData } from './decoder.js';
import { decodeHeic, isHeic } from './decoder.js';
import {
  getHeicInfo,
  getItemDataReference,
  getItemPayload,
  validateExternalItemData,
  type ExternalItemDataReference,
} from './container/heic.js';
import { parseISOBMFF } from './container/heif.js';
import {
  decompressGenericItemPayload,
  MAX_GENERIC_DECOMPRESSED_BYTES,
  type GenericCompressionConfiguration,
} from './container/generic-compression.js';
import { buildTiledTileUrl, getTiledImageTileIndices } from './container/tili.js';
import { isHeifImageBitDepth } from './bit-depth.js';
import { prepareAvcDecodeOptions } from './avc.js';

export type HeicInput = Uint8Array | ArrayBuffer | Blob;

export interface AsyncDecodeOptions extends DecodeOptions {
  /** Defaults to worker. main runs synchronously before resolving its Promise. */
  execution?: 'worker' | 'main';
  signal?: AbortSignal;
  /** Worker only: terminate decoding after this many milliseconds. Default 30s. */
  timeoutMs?: number;
  /** For bundlers/CSP policies that require a custom Worker entry point. */
  workerFactory?: () => Worker;
  /**
   * Optional caller-controlled loader for `tili` external tile URLs. The
   * returned bytes are passed to the decoder; the library does not fetch URLs
   * itself. Resolved tile bytes can also be supplied through externalTileData.
   */
  resolveExternalTile?: (url: string, signal?: AbortSignal) => Uint8Array | Promise<Uint8Array>;
  /**
   * Optional caller-controlled loader for URL/URN data on the primary item or
   * its direct `exbl` base item. Return the complete resource so the decoder
   * can apply that item's `iloc` extents. No request is made automatically.
   */
  resolveExternalItem?: (
    reference: ExternalItemDataReference,
    itemId: number,
    signal?: AbortSignal,
  ) => Uint8Array | Promise<Uint8Array>;
}

function prepareGenericCompressedItemData(
  input: Uint8Array,
  options: DecodeOptions,
  signal?: AbortSignal,
): Promise<void> | undefined {
  if (!isHeic(input)) return;
  const boxes = parseISOBMFF(input),
    root = getHeicInfo(input, boxes, options.itemId),
    pending = [root.primaryItemId],
    visited = new Set<number>(),
    decoded: Record<number, Uint8Array> = { ...(options.decodedItemData ?? {}) };
  let totalBytes = Object.values(decoded).reduce((sum, data) => sum + data.byteLength, 0);
  const maxTotalBytes = MAX_GENERIC_DECOMPRESSED_BYTES * 2;
  const compressedItems: Array<{
    itemId: number;
    payload: Uint8Array;
    compression: GenericCompressionConfiguration;
  }> = [];

  while (pending.length > 0) {
    signal?.throwIfAborted();
    const itemId = pending.pop()!;
    if (visited.has(itemId)) continue;
    visited.add(itemId);
    if (visited.size > 65_536)
      throw new HeicError('RESOURCE_LIMIT', 'heic: derived image item count exceeds 65536');
    const info = getHeicInfo(input, boxes, itemId);
    pending.push(...info.derivedItems);
    if (info.alphaItemId !== null) pending.push(info.alphaItemId);
    if (info.externalBaseLayerItemId !== undefined) pending.push(info.externalBaseLayerItemId);

    if (info.primaryItemType !== 'unci' || !info.uncompressedImage?.genericCompression) continue;
    if (Object.hasOwn(decoded, itemId)) continue;
    const payload = getItemPayload(input, boxes, itemId, options.externalItemData);
    if (!payload)
      throw new HeicError('INVALID_CONTAINER', `heic: unci item ${itemId} has no payload`);
    compressedItems.push({
      itemId,
      payload,
      compression: info.uncompressedImage.genericCompression,
    });
  }

  if (compressedItems.length === 0) return;
  return (async () => {
    for (const { itemId, payload, compression } of compressedItems) {
      signal?.throwIfAborted();
      const output = await decompressGenericItemPayload(payload, compression, signal);
      totalBytes += output.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes)
        throw new HeicError(
          'RESOURCE_LIMIT',
          'heic: generic-compressed items exceed the total decompressed size limit',
        );
      decoded[itemId] = output;
    }
    options.decodedItemData = decoded;
  })();
}

/** Decodes without detaching or modifying the caller's input buffer. */
async function run(
  source: HeicInput,
  options: AsyncDecodeOptions & HdrOptions,
  operation: 'sdr' | 'hdr',
): Promise<HeicImageData | HdrImage> {
  const {
    execution = 'worker',
    signal,
    timeoutMs = 30000,
    workerFactory,
    resolveExternalTile,
    resolveExternalItem,
    ...decodeOptions
  } = options;
  signal?.throwIfAborted();
  const size =
    source instanceof Uint8Array || source instanceof ArrayBuffer
      ? source.byteLength
      : typeof Blob !== 'undefined' && source instanceof Blob
        ? source.size
        : -1;
  if (size < 0)
    throw new HeicError('INVALID_INPUT', 'heic: expected Uint8Array, ArrayBuffer, or Blob');
  if (size > 64 * 1024 * 1024) throw new HeicError('RESOURCE_LIMIT', 'heic: input exceeds 64 MiB');
  let input: Uint8Array;
  try {
    input =
      source instanceof Uint8Array
        ? source
        : new Uint8Array(source instanceof ArrayBuffer ? source : await source.arrayBuffer());
  } catch (cause) {
    throw new HeicError('INVALID_INPUT', 'Could not read HEIC input', { cause });
  }
  if (
    decodeOptions.maxPixels !== undefined &&
    (!Number.isSafeInteger(decodeOptions.maxPixels) ||
      decodeOptions.maxPixels < 1 ||
      decodeOptions.maxPixels > 50_000_000)
  )
    throw new HeicError('INVALID_OPTIONS', 'heic: invalid maxPixels');
  signal?.throwIfAborted();
  if (resolveExternalItem && isHeic(input)) {
    const boxes = parseISOBMFF(input);
    const info = getHeicInfo(input, boxes, decodeOptions.itemId);
    const itemIds = [
      info.primaryItemId,
      ...(info.externalBaseLayerItemId === undefined ? [] : [info.externalBaseLayerItemId]),
    ];
    const resolved: Record<number, Uint8Array> = { ...(decodeOptions.externalItemData ?? {}) };
    validateExternalItemData(resolved);
    let totalBytes = Object.values(resolved).reduce((sum, data) => sum + data.byteLength, 0);
    for (const itemId of new Set(itemIds)) {
      if (Object.hasOwn(resolved, itemId)) continue;
      const reference = getItemDataReference(boxes, itemId);
      if (!reference) continue;
      const label =
        reference.type === 'url'
          ? reference.url
          : reference.location
            ? `${reference.name} (${reference.location})`
            : reference.name;
      signal?.throwIfAborted();
      let data: Uint8Array;
      try {
        data = await resolveExternalItem(reference, itemId, signal);
      } catch (cause) {
        throw new HeicError(
          'INVALID_INPUT',
          `heic: could not resolve external item ${itemId} at ${label}`,
          { cause },
        );
      }
      signal?.throwIfAborted();
      if (!(data instanceof Uint8Array) || data.length === 0)
        throw new HeicError(
          'INVALID_INPUT',
          `heic: external item resolver returned no bytes for item ${itemId}`,
        );
      totalBytes += data.byteLength;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > 64 * 1024 * 1024)
        throw new HeicError('RESOURCE_LIMIT', 'heic: external item data exceeds 64 MiB');
      resolved[itemId] = data;
    }
    decodeOptions.externalItemData = resolved;
  }
  if (resolveExternalTile && isHeic(input)) {
    const info = getHeicInfo(input, parseISOBMFF(input), decodeOptions.itemId);
    const reference = info.tiledImage?.dataReference;
    if (reference?.externalTileUrls && info.tiledImage) {
      const tileIndexes = getTiledImageTileIndices(
        info.tiledImage,
        decodeOptions.extraDimensionIndexes,
      );
      if (tileIndexes.length > 65_536)
        throw new HeicError('RESOURCE_LIMIT', 'heic: external tili tile count exceeds 65536');
      const resolved: Record<string, Uint8Array> = { ...(decodeOptions.externalTileData ?? {}) };
      let totalBytes = 0;
      for (const tile of Object.values(resolved)) {
        if (!(tile instanceof Uint8Array) || tile.length === 0)
          throw new HeicError(
            'INVALID_OPTIONS',
            'heic: externalTileData values must be non-empty Uint8Array',
          );
        totalBytes += tile.byteLength;
      }
      if (!Number.isSafeInteger(totalBytes) || totalBytes > 64 * 1024 * 1024)
        throw new HeicError('RESOURCE_LIMIT', 'heic: external tile data exceeds 64 MiB');
      const urls = new Set<string>();
      for (const index of tileIndexes) urls.add(buildTiledTileUrl(reference, index));
      const pending = [...urls].filter((url) => !Object.hasOwn(resolved, url));
      for (let start = 0; start < pending.length; start += 8) {
        signal?.throwIfAborted();
        const entries = await Promise.all(
          pending.slice(start, start + 8).map(async (url) => {
            try {
              return [url, await resolveExternalTile(url, signal)] as const;
            } catch (cause) {
              throw new HeicError('INVALID_INPUT', `heic: could not resolve external tile ${url}`, {
                cause,
              });
            }
          }),
        );
        for (const [url, tile] of entries) {
          signal?.throwIfAborted();
          if (!(tile instanceof Uint8Array) || tile.length === 0)
            throw new HeicError(
              'INVALID_INPUT',
              `heic: external tile resolver returned no bytes for ${url}`,
            );
          totalBytes += tile.byteLength;
          if (!Number.isSafeInteger(totalBytes) || totalBytes > 64 * 1024 * 1024)
            throw new HeicError('RESOURCE_LIMIT', 'heic: external tile data exceeds 64 MiB');
          resolved[url] = tile;
        }
      }
      decodeOptions.externalTileData = resolved;
    }
  }
  const genericPreparation = prepareGenericCompressedItemData(input, decodeOptions, signal);
  if (genericPreparation) await genericPreparation;
  signal?.throwIfAborted();
  if (execution === 'main') {
    const preparedOptions = await prepareAvcDecodeOptions(input, decodeOptions);
    return operation === 'hdr'
      ? decodeHDRSync(input, preparedOptions)
      : decodeHeic(input, preparedOptions);
  }
  if (execution !== 'worker') throw new HeicError('INVALID_OPTIONS', 'Unknown execution mode');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
    throw new HeicError('INVALID_OPTIONS', 'timeoutMs must be positive');
  if (!workerFactory && typeof Worker === 'undefined')
    throw new HeicError('WORKER_UNAVAILABLE', 'Worker unavailable; use execution: main');
  return new Promise<HeicImageData | HdrImage>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = workerFactory
        ? workerFactory()
        : new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch (cause) {
      reject(new HeicError('WORKER_FAILED', 'Could not create HEIC worker', { cause }));
      return;
    }
    let settled = false;
    const finish = (failed: boolean, result: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      worker.terminate();
      if (failed) reject(result);
      else resolve(result as HeicImageData | HdrImage);
    };
    const abort = () => finish(true, signal!.reason);
    const timer = setTimeout(
      () => finish(true, new HeicError('TIMEOUT', 'HEIC decoding timed out')),
      timeoutMs,
    );
    worker.onmessage = ({ data }) => {
      if (!data || typeof data !== 'object') {
        finish(true, new HeicError('WORKER_FAILED', 'Invalid worker response'));
        return;
      }
      if (Object.hasOwn(data, 'error')) {
        if (!data.error || typeof data.error.message !== 'string')
          finish(true, new HeicError('WORKER_FAILED', 'Invalid worker error response'));
        else finish(true, new HeicError(data.error.code ?? 'DECODE_FAILED', data.error.message));
      } else {
        const image = data.image;
        if (
          !image ||
          !(operation === 'hdr'
            ? image.data instanceof Float32Array
            : image.data instanceof Uint8Array) ||
          !Number.isSafeInteger(image.width) ||
          !Number.isSafeInteger(image.height) ||
          image.width <= 0 ||
          image.height <= 0 ||
          image.width * image.height > 50_000_000 ||
          image.data.length !== image.width * image.height * 4 ||
          !isHeifImageBitDepth(image.bitDepth) ||
          (image.bitDepthChroma !== undefined && !isHeifImageBitDepth(image.bitDepthChroma))
        )
          finish(true, new HeicError('WORKER_FAILED', 'Invalid worker image response'));
        else finish(false, image);
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      finish(true, new HeicError('WORKER_FAILED', event.message || 'HEIC worker failed'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) {
      abort();
      return;
    }
    try {
      const copy = new Uint8Array(input);
      worker.postMessage({ input: copy, options: decodeOptions, operation }, [copy.buffer]);
    } catch (cause) {
      finish(
        true,
        new HeicError('WORKER_FAILED', 'Could not send image to HEIC worker', { cause }),
      );
    }
  });
}

export function decode(
  source: HeicInput,
  options: AsyncDecodeOptions = {},
): Promise<HeicImageData> {
  return run(source, options, 'sdr') as Promise<HeicImageData>;
}

export function decodeHDR(
  source: HeicInput,
  options: AsyncDecodeOptions & HdrOptions = {},
): Promise<HdrImage> {
  return run(source, options, 'hdr') as Promise<HdrImage>;
}
