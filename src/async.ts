import { decodeHDRSync, type HdrOptions, type HdrImage } from './hdr.js';
import { HeicError } from './errors.js';
import type { DecodeOptions, HeicImageData } from './decoder.js';
import { decodeHeic } from './decoder.js';

export type HeicInput = Uint8Array | ArrayBuffer | Blob;

export interface AsyncDecodeOptions extends DecodeOptions {
  /** Defaults to worker. main runs synchronously before resolving its Promise. */
  execution?: 'worker' | 'main';
  signal?: AbortSignal;
  /** Worker only: terminate decoding after this many milliseconds. Default 30s. */
  timeoutMs?: number;
  /** For bundlers/CSP policies that require a custom Worker entry point. */
  workerFactory?: () => Worker;
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
  if (execution === 'main')
    return operation === 'hdr'
      ? decodeHDRSync(input, decodeOptions)
      : decodeHeic(input, decodeOptions);
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
          ![8, 10, 12].includes(image.bitDepth)
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
