import { HeicError } from '../errors.js';
import type { ISOBMFFBox } from './heif.js';

export type GenericCompressionType = 'defl' | 'zlib' | 'brot';
export type CompressedUnitType = 0 | 1 | 2 | 3 | 4;

export interface GenericCompressedUnit {
  offset: number;
  size: number;
}

export interface GenericCompressionConfiguration {
  compressionType: GenericCompressionType;
  compressedUnitType: CompressedUnitType;
  /** Ordered byte ranges from the item's compressed payload, when `icef` is present. */
  compressedUnits?: readonly GenericCompressedUnit[];
}

export const MAX_GENERIC_DECOMPRESSED_BYTES = 256 * 1024 * 1024;
const MAX_GENERIC_COMPRESSED_UNITS = 65_536;

function invalid(message: string): never {
  throw new HeicError('INVALID_CONTAINER', `heic: ${message}`);
}

function unsupported(message: string): never {
  throw new HeicError('UNSUPPORTED_FEATURE', `heic: ${message}`);
}

function u32(data: Uint8Array, offset: number): number {
  return (
    data[offset] * 0x1000000 + (data[offset + 1] << 16) + (data[offset + 2] << 8) + data[offset + 3]
  );
}

function fourcc(value: number): string {
  return String.fromCharCode(
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  );
}

function parseCompressedUnits(data: Uint8Array): GenericCompressedUnit[] {
  if (data.length < 9) invalid('truncated icef property');
  if (data[0] !== 0 || data[1] !== 0 || data[2] !== 0 || data[3] !== 0)
    unsupported('only icef version 0 with zero flags is supported');

  const codes = data[4],
    offsetCode = (codes >>> 5) & 7,
    sizeCode = (codes >>> 2) & 7;
  if ((codes & 3) !== 0) invalid('icef reserved bits shall be zero');
  if (offsetCode > 4 || sizeCode > 4) unsupported('unsupported icef offset or size code');

  const offsetBytes = [0, 2, 3, 4, 8][offsetCode],
    sizeBytes = [1, 2, 3, 4, 8][sizeCode],
    count = u32(data, 5),
    recordBytes = offsetBytes + sizeBytes;
  if (count > MAX_GENERIC_COMPRESSED_UNITS)
    throw new HeicError('RESOURCE_LIMIT', 'heic: icef compressed-unit count exceeds 65536');
  if (count > Math.floor((data.length - 9) / recordBytes))
    invalid('icef declares more compressed units than its data contains');
  if (9 + count * recordBytes !== data.length) invalid('icef property has trailing data');

  const units: GenericCompressedUnit[] = [];
  let cursor = 9,
    impliedOffset = 0;
  const readValue = (byteCount: number): number => {
    let value = 0;
    for (let index = 0; index < byteCount; index++) {
      value = value * 256 + data[cursor++];
      if (!Number.isSafeInteger(value)) invalid('icef value exceeds the safe integer range');
    }
    return value;
  };

  for (let index = 0; index < count; index++) {
    const offset = offsetBytes === 0 ? impliedOffset : readValue(offsetBytes),
      size = readValue(sizeBytes);
    if (!Number.isSafeInteger(offset + size)) invalid('icef compressed-unit range is too large');
    units.push({ offset, size });
    if (offsetBytes === 0) impliedOffset += size;
  }
  return units;
}

export function parseGenericCompressionConfiguration(
  properties: readonly ISOBMFFBox[],
): GenericCompressionConfiguration | undefined {
  const cmpC = properties.filter((property) => property.type === 'cmpC');
  if (cmpC.length > 1) invalid('unci item has duplicate cmpC properties');
  if (cmpC.length === 0) {
    if (properties.some((property) => property.type === 'icef'))
      invalid('icef requires a cmpC property');
    return undefined;
  }

  const data = cmpC[0].data;
  if (data.length !== 9) invalid('invalid cmpC property size');
  if (data[0] !== 0 || data[1] !== 0 || data[2] !== 0 || data[3] !== 0)
    unsupported('only cmpC version 0 with zero flags is supported');

  const icef = properties.filter((property) => property.type === 'icef');
  if (icef.length > 1) invalid('unci item has duplicate icef properties');

  const compressionType = fourcc(u32(data, 4));
  if (compressionType !== 'defl' && compressionType !== 'zlib' && compressionType !== 'brot')
    unsupported(`cmpC compression type ${compressionType} is not supported`);
  if (data[8] > 4) unsupported(`cmpC compressed unit type ${data[8]} is not supported`);

  return {
    compressionType,
    compressedUnitType: data[8] as CompressedUnitType,
    ...(icef.length === 1 ? { compressedUnits: parseCompressedUnits(icef[0].data) } : {}),
  };
}

interface NodeZlib {
  inflateRawSync(input: Uint8Array, options: { maxOutputLength: number }): Uint8Array;
  inflateSync(input: Uint8Array, options: { maxOutputLength: number }): Uint8Array;
  brotliDecompressSync(input: Uint8Array, options: { maxOutputLength: number }): Uint8Array;
}

function nodeZlib(): NodeZlib | null {
  const runtime = (
    globalThis as typeof globalThis & {
      process?: { getBuiltinModule?: (name: string) => unknown };
    }
  ).process;
  return (runtime?.getBuiltinModule?.('node:zlib') ??
    runtime?.getBuiltinModule?.('zlib') ??
    null) as NodeZlib | null;
}

function normalizeOutput(output: Uint8Array, maxOutputBytes: number): Uint8Array {
  if (output.byteLength > maxOutputBytes)
    throw new HeicError(
      'RESOURCE_LIMIT',
      'heic: generic-compressed item exceeds the decompressed size limit',
    );
  return new Uint8Array(output.buffer, output.byteOffset, output.byteLength).slice();
}

function decompressWithNode(
  payload: Uint8Array,
  configuration: GenericCompressionConfiguration,
  maxOutputBytes: number,
): Uint8Array | null {
  const zlib = nodeZlib();
  if (!zlib) return null;
  try {
    const output =
      configuration.compressionType === 'defl'
        ? zlib.inflateRawSync(payload, { maxOutputLength: Math.max(1, maxOutputBytes) })
        : configuration.compressionType === 'zlib'
          ? zlib.inflateSync(payload, { maxOutputLength: Math.max(1, maxOutputBytes) })
          : zlib.brotliDecompressSync(payload, {
              maxOutputLength: Math.max(1, maxOutputBytes),
            });
    return normalizeOutput(output, maxOutputBytes);
  } catch (cause) {
    if (cause instanceof HeicError) throw cause;
    if (
      cause &&
      typeof cause === 'object' &&
      'code' in cause &&
      cause.code === 'ERR_BUFFER_TOO_LARGE'
    )
      throw new HeicError(
        'RESOURCE_LIMIT',
        'heic: generic-compressed item exceeds the decompressed size limit',
        { cause },
      );
    throw new HeicError('INVALID_CONTAINER', 'heic: invalid generic-compressed item data', {
      cause,
    });
  }
}

function getCompressedUnits(
  payload: Uint8Array,
  configuration: GenericCompressionConfiguration,
): readonly Uint8Array[] {
  if (!configuration.compressedUnits) return [payload];
  return configuration.compressedUnits.map(({ offset, size }) => {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset > payload.length ||
      size > payload.length - offset
    )
      invalid('icef compressed-unit range exceeds the item payload');
    return payload.subarray(offset, offset + size);
  });
}

function concatenate(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** Synchronous decompression for the Node API; browsers can use the async decoder. */
export function decompressGenericItemPayloadSync(
  payload: Uint8Array,
  configuration: GenericCompressionConfiguration,
): Uint8Array {
  const units = getCompressedUnits(payload, configuration),
    chunks: Uint8Array[] = [];
  let total = 0;
  for (const unit of units) {
    const remaining = MAX_GENERIC_DECOMPRESSED_BYTES - total,
      output = decompressWithNode(unit, configuration, remaining);
    if (!output) unsupported('synchronous generic decompression requires Node.js');
    chunks.push(output);
    total += output.byteLength;
  }
  return concatenate(chunks, total);
}

async function decompressUnit(
  payload: Uint8Array,
  configuration: GenericCompressionConfiguration,
  maxOutputBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const nodeOutput = () => decompressWithNode(payload, configuration, maxOutputBytes);
  signal?.throwIfAborted();
  if (typeof DecompressionStream === 'undefined') {
    const output = nodeOutput();
    if (output) return output;
    unsupported(`no ${configuration.compressionType} decompressor is available`);
  }

  const format =
    configuration.compressionType === 'defl'
      ? 'deflate-raw'
      : configuration.compressionType === 'zlib'
        ? 'deflate'
        : 'brotli';
  let stream: DecompressionStream;
  try {
    stream = new DecompressionStream(format as CompressionFormat);
  } catch (cause) {
    const output = nodeOutput();
    if (output) return output;
    throw new HeicError(
      'UNSUPPORTED_FEATURE',
      `heic: no ${configuration.compressionType} decompressor is available`,
      { cause },
    );
  }

  const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(payload);
        controller.close();
      },
    }),
    reader = source
      .pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
      .getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      signal?.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxOutputBytes)
        throw new HeicError(
          'RESOURCE_LIMIT',
          'heic: generic-compressed item exceeds the decompressed size limit',
        );
      chunks.push(value);
    }
  } catch (cause) {
    await reader.cancel(cause).catch(() => undefined);
    if (cause instanceof HeicError) throw cause;
    throw new HeicError('INVALID_CONTAINER', 'heic: invalid generic-compressed item data', {
      cause,
    });
  }
  return concatenate(chunks, total);
}

export async function decompressGenericItemPayload(
  payload: Uint8Array,
  configuration: GenericCompressionConfiguration,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const units = getCompressedUnits(payload, configuration),
    chunks: Uint8Array[] = [];
  let total = 0;
  for (const unit of units) {
    const output = await decompressUnit(
      unit,
      configuration,
      MAX_GENERIC_DECOMPRESSED_BYTES - total,
      signal,
    );
    chunks.push(output);
    total += output.byteLength;
  }
  return concatenate(chunks, total);
}
