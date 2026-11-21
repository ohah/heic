import { HeicError } from '../errors.js';

export interface TiledImageConfiguration {
  tileWidth: number;
  tileHeight: number;
  extraDimensionSizes: number[];
  tileItemType: string | null;
  propertyIndexes: number[];
  essentialIndexes: number[];
}

export interface TiledDataReference {
  externalTileUrls: boolean;
  inputItemCount: number;
  offsetFieldLength: 32 | 40 | 48 | 64;
  sizeFieldLength: 0 | 24 | 32 | 64;
  sequentialOrder: boolean;
  tileOffsetTableStart: number | null;
  tileOffsetTableSize: number | null;
  directoryIdStart: number | null;
  directoryIdEnd: number | null;
  tileIdStart: number | null;
  baseUrl: string | null;
  urlExtension: string | null;
  tileItemRequestTemplate: string | null;
}

export interface TiledItemRange {
  offset: number;
  length: number;
}

export interface TiledImageDimensions {
  rows: number;
  columns: number;
  extraDimensionSizes: readonly number[];
}

function invalid(message: string): never {
  throw new HeicError('INVALID_CONTAINER', `heic: ${message}`);
}

function unsupported(message: string): never {
  throw new HeicError('UNSUPPORTED_FEATURE', `heic: ${message}`);
}

function uint(data: Uint8Array, offset: number, bytes: number): number {
  if (!Number.isInteger(offset) || offset < 0 || offset + bytes > data.length)
    invalid('truncated tiled-image field');
  let value = 0n;
  for (let i = 0; i < bytes; i++) value = (value << 8n) | BigInt(data[offset + i]);
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new HeicError('RESOURCE_LIMIT', 'heic: tiled-image offset exceeds safe integer range');
  return Number(value);
}

function fourCC(data: Uint8Array, offset: number): string {
  if (offset < 0 || offset + 4 > data.length) invalid('truncated tiled-image item type');
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

function parseTilePropertyAssociation(
  data: Uint8Array,
  offset: number,
): { propertyIndexes: number[]; essentialIndexes: number[]; nextOffset: number } {
  if (offset + 12 > data.length) invalid('truncated tipa box');
  const boxSize = uint(data, offset, 4);
  if (boxSize < 12 || boxSize > data.length - offset || fourCC(data, offset + 4) !== 'tipa')
    invalid('invalid tipa box');
  const body = offset + 8;
  const version = data[body];
  const flags = (data[body + 1] << 16) | (data[body + 2] << 8) | data[body + 3];
  if (version !== 0 || flags & ~1)
    unsupported('unsupported tile property association version or flags');
  const count = data[body + 4];
  const wideIndexes = !!(flags & 1);
  const bytesPerAssociation = wideIndexes ? 2 : 1;
  if (body + 5 + count * bytesPerAssociation !== offset + boxSize)
    invalid('tipa association count does not match its box size');
  const propertyIndexes: number[] = [];
  const essentialIndexes: number[] = [];
  let p = body + 5;
  for (let i = 0; i < count; i++) {
    let value: number;
    let index: number;
    let essential: boolean;
    if (wideIndexes) {
      value = uint(data, p, 2);
      p += 2;
      essential = !!(value & 0x8000);
      index = value & 0x7fff;
    } else {
      value = data[p++];
      essential = !!(value & 0x80);
      index = value & 0x7f;
    }
    if (index === 0) {
      if (essential) invalid('tile property index zero cannot be essential');
      continue;
    }
    propertyIndexes.push(index);
    if (essential) essentialIndexes.push(index);
  }
  return { propertyIndexes, essentialIndexes, nextOffset: offset + boxSize };
}

export function parseTiledImageConfiguration(
  data: Uint8Array,
  externalTileUrls = false,
): TiledImageConfiguration {
  if (data.length < 13) invalid('truncated tilC property');
  const version = data[0];
  const flags = (data[1] << 16) | (data[2] << 8) | data[3];
  if (version !== 0 || flags !== 0) unsupported('unsupported tilC version or flags');
  const tileWidth = uint(data, 4, 4);
  const tileHeight = uint(data, 8, 4);
  const dimensionCount = data[12];
  if (tileWidth === 0 || tileHeight === 0) invalid('tilC tile dimensions must be non-zero');
  let p = 13;
  if (p + dimensionCount * 4 > data.length) invalid('truncated tilC dimensions');
  const extraDimensionSizes: number[] = [];
  for (let i = 0; i < dimensionCount; i++, p += 4) {
    const dimensionSize = uint(data, p, 4);
    if (dimensionSize === 0) invalid('tilC extra dimension must be non-zero');
    extraDimensionSizes.push(dimensionSize);
  }
  let tileItemType: string | null = null;
  let propertyIndexes: number[] = [];
  let essentialIndexes: number[] = [];
  if (!externalTileUrls && p < data.length) {
    if (p + 4 > data.length) invalid('truncated tilC tile_item_type');
    tileItemType = fourCC(data, p);
    p += 4;
    const association = parseTilePropertyAssociation(data, p);
    if (association.nextOffset !== data.length) invalid('trailing data in tilC property');
    propertyIndexes = association.propertyIndexes;
    essentialIndexes = association.essentialIndexes;
  } else if (externalTileUrls && p !== data.length)
    invalid('external tilC must not contain tile properties');
  return {
    tileWidth,
    tileHeight,
    extraDimensionSizes,
    tileItemType,
    propertyIndexes,
    essentialIndexes,
  };
}

export function parseTiledDataReference(data: Uint8Array): TiledDataReference {
  if (data.length < 9) invalid('truncated deti box');
  const version = data[0];
  const flags = (data[1] << 16) | (data[2] << 8) | data[3];
  if (version !== 0 || flags & ~0xff) unsupported('unsupported deti version or flags');
  const offsetLengths = [32, 40, 48, 64] as const;
  const sizeLengths = [0, 24, 32, 64] as const;
  const offsetFieldLength = offsetLengths[flags & 3];
  const sizeFieldLength = sizeLengths[(flags >>> 2) & 3];
  const sequentialOrder = !!(flags & 0x10);
  const itemCountLength = [1, 2, 4, 8][(flags >>> 5) & 3];
  const externalTileUrls = !!(flags & 0x80);
  let p = 4;
  if (p + itemCountLength > data.length) invalid('truncated deti input count');
  const inputItemCount = uint(data, p, itemCountLength);
  p += itemCountLength;
  let tileOffsetTableStart: number | null = null;
  let tileOffsetTableSize: number | null = null;
  let directoryIdStart: number | null = null;
  let directoryIdEnd: number | null = null;
  let tileIdStart: number | null = null;
  let baseUrl: string | null = null;
  let urlExtension: string | null = null;
  let tileItemRequestTemplate: string | null = null;
  if (externalTileUrls) {
    if (p >= data.length) invalid('truncated deti URL fields');
    const reservedAndDirectoryFlag = data[p++];
    if (reservedAndDirectoryFlag & 0xfe) invalid('non-zero reserved deti URL bits');
    const hasDirectoryIds = !!(reservedAndDirectoryFlag & 1);
    if (hasDirectoryIds) {
      if (p + 4 > data.length) invalid('truncated deti directory IDs');
      directoryIdStart = uint(data, p, 2);
      directoryIdEnd = uint(data, p + 2, 2);
      p += 4;
      if (directoryIdEnd < directoryIdStart) invalid('deti directory ID range is reversed');
    }
    if (p + 8 > data.length) invalid('truncated deti tile ID');
    tileIdStart = uint(data, p, 8);
    p += 8;
    const strings: string[] = [];
    for (let i = 0; i < 3; i++) {
      const end = data.indexOf(0, p);
      if (end < 0) invalid('unterminated deti URL string');
      if (end - p > 4096)
        throw new HeicError('RESOURCE_LIMIT', 'heic: deti URL field exceeds 4096 bytes');
      try {
        strings.push(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(p, end)));
      } catch {
        invalid('deti URL field is not valid UTF-8');
      }
      p = end + 1;
    }
    [baseUrl, urlExtension, tileItemRequestTemplate] = strings;
  } else {
    const offsetFieldBytes = offsetFieldLength / 8;
    if (p + offsetFieldBytes + 4 > data.length) invalid('truncated deti offset table location');
    tileOffsetTableStart = uint(data, p, offsetFieldBytes);
    p += offsetFieldBytes;
    tileOffsetTableSize = uint(data, p, 4);
    p += 4;
  }
  if (p !== data.length) invalid('trailing data in deti box');
  return {
    externalTileUrls,
    inputItemCount,
    offsetFieldLength,
    sizeFieldLength,
    sequentialOrder,
    tileOffsetTableStart,
    tileOffsetTableSize,
    directoryIdStart,
    directoryIdEnd,
    tileIdStart,
    baseUrl,
    urlExtension,
    tileItemRequestTemplate,
  };
}

/** Build the URL for one row-major tile described by a `deti` external URL entry. */
export function buildTiledTileUrl(reference: TiledDataReference, tileIndex: number): string {
  if (
    !reference.externalTileUrls ||
    reference.tileIdStart === null ||
    reference.baseUrl === null ||
    reference.urlExtension === null ||
    reference.tileItemRequestTemplate === null
  )
    invalid('deti does not contain external tile URLs');
  if (!Number.isSafeInteger(tileIndex) || tileIndex < 0 || tileIndex >= reference.inputItemCount)
    invalid('external tile index is out of range');

  let directory = '';
  if (reference.directoryIdStart !== null && reference.directoryIdEnd !== null) {
    const directoryCount = reference.directoryIdEnd - reference.directoryIdStart + 1;
    if (directoryCount < 1 || directoryCount > reference.inputItemCount)
      invalid('deti directory range cannot address its input tiles');
    const tilesPerDirectory = Math.floor(reference.inputItemCount / directoryCount);
    const directoryIndex = Math.min(
      directoryCount - 1,
      Math.floor(tileIndex / Math.max(1, tilesPerDirectory)),
    );
    directory = `${reference.directoryIdStart + directoryIndex}/`;
  }
  const tileId = reference.tileIdStart + tileIndex;
  if (!Number.isSafeInteger(tileId))
    throw new HeicError('RESOURCE_LIMIT', 'heic: deti tile ID exceeds safe integer range');
  const request = reference.tileItemRequestTemplate.replaceAll('$tileID$', String(tileId));
  return `${reference.baseUrl}${reference.urlExtension}${directory ? `/${directory}` : '/'}${request}`;
}

/** Select the row-major tile indexes for one 2D plane of a tiled hyperrectangle. */
export function getTiledImageTileIndices(
  image: TiledImageDimensions,
  extraDimensionIndexes?: readonly number[],
): number[] {
  const dimensions = image.extraDimensionSizes;
  const indexes = extraDimensionIndexes ?? dimensions.map(() => 0);
  if (indexes.length !== dimensions.length)
    throw new HeicError(
      'INVALID_OPTIONS',
      'heic: extraDimensionIndexes must provide one coordinate for each tili extra dimension',
    );
  let planeIndex = 0;
  for (let dimension = 0; dimension < dimensions.length; dimension++) {
    const size = dimensions[dimension];
    const index = indexes[dimension];
    if (!Number.isSafeInteger(size) || size <= 0)
      invalid('tili extra dimension size must be a positive integer');
    if (!Number.isSafeInteger(index) || index < 0 || index >= size)
      throw new HeicError(
        'INVALID_OPTIONS',
        `heic: extraDimensionIndexes[${dimension}] is outside its dimension size ${size}`,
      );
    planeIndex = planeIndex * size + index;
  }
  const spatialTileCount = image.rows * image.columns;
  if (
    !Number.isSafeInteger(spatialTileCount) ||
    spatialTileCount <= 0 ||
    !Number.isSafeInteger(planeIndex * spatialTileCount)
  )
    throw new HeicError('RESOURCE_LIMIT', 'heic: tili plane index exceeds safe integer range');
  const first = planeIndex * spatialTileCount;
  return Array.from({ length: spatialTileCount }, (_, index) => first + index);
}

export function parseTiledItemRanges(
  data: Uint8Array,
  reference: TiledDataReference,
  tileCount: number,
): Array<TiledItemRange | null> {
  if (reference.externalTileUrls || reference.tileOffsetTableStart === null)
    unsupported('external tili tile URLs are not supported by the synchronous decoder');
  if (reference.inputItemCount !== tileCount)
    invalid('deti tile count does not match tilC dimensions');
  if (!Number.isSafeInteger(tileCount) || tileCount <= 0 || tileCount > 4_000_000)
    throw new HeicError('RESOURCE_LIMIT', 'heic: tili tile count exceeds the decoder limit');
  const tableStart = reference.tileOffsetTableStart;
  const tableSize = reference.tileOffsetTableSize!;
  const offsetBytes = reference.offsetFieldLength / 8;
  const sizeBytes = reference.sizeFieldLength / 8;
  const entryBytes = offsetBytes + sizeBytes;
  if (
    !Number.isSafeInteger(tableStart + tableSize) ||
    tableStart < 0 ||
    tableSize !== tileCount * entryBytes ||
    tableStart + tableSize > data.length
  )
    invalid('tili offset table exceeds item data or has an invalid size');

  const offsets = new Array<number | null>(tileCount);
  const sizes = new Array<number | null>(tileCount);
  let p = tableStart;
  for (let i = 0; i < tileCount; i++) {
    const offset = uint(data, p, offsetBytes);
    p += offsetBytes;
    if (offset === 0xffff_ffff) {
      offsets[i] = null;
      sizes[i] = null;
      if (sizeBytes > 0) p += sizeBytes;
      continue;
    }
    offsets[i] = offset;
    sizes[i] = sizeBytes > 0 ? uint(data, p, sizeBytes) : null;
    p += sizeBytes;
  }

  if (sizeBytes === 0) {
    const validOffsets = [
      ...new Set(offsets.filter((offset): offset is number => offset !== null)),
    ];
    if (reference.sequentialOrder) {
      let previous = -1;
      for (const offset of offsets) {
        if (offset === null) continue;
        if (offset <= previous) invalid('sequential tili offsets are not strictly ordered');
        previous = offset;
      }
    } else {
      validOffsets.sort((a, b) => a - b);
    }
    const nextOffset = new Map<number, number>();
    for (let i = 0; i < validOffsets.length; i++)
      nextOffset.set(validOffsets[i], validOffsets[i + 1] ?? data.length);
    for (let i = 0; i < offsets.length; i++) {
      const offset = offsets[i];
      if (offset === null) continue;
      const next = nextOffset.get(offset)!;
      if (next < offset) invalid('tili tile offsets are not ordered');
      sizes[i] = next - offset;
    }
  }

  const ranges = offsets.map((offset, i) => {
    if (offset === null) return null;
    const length = sizes[i]!;
    if (
      !Number.isSafeInteger(offset + length) ||
      offset < 0 ||
      length <= 0 ||
      offset + length > data.length
    )
      invalid(`tili tile ${i} data range exceeds item data`);
    if (offset < tableStart + tableSize && offset + length > tableStart)
      invalid(`tili tile ${i} data overlaps its offset table`);
    return { offset, length };
  });

  if (reference.sequentialOrder) {
    let previousOffset = -1;
    for (const range of ranges) {
      if (!range) continue;
      if (range.offset <= previousOffset)
        invalid('sequential tili offsets are not strictly ordered');
      previousOffset = range.offset;
    }
  }

  const orderedRanges = ranges
    .filter((range): range is TiledItemRange => range !== null)
    .sort((a, b) => a.offset - b.offset || a.length - b.length);
  let previous: TiledItemRange | null = null;
  for (const range of orderedRanges) {
    if (!previous) {
      previous = range;
      continue;
    }
    if (range.offset < previous.offset + previous.length) {
      const sharedDataBlock = range.offset === previous.offset && range.length === previous.length;
      if (!sharedDataBlock || reference.sequentialOrder) invalid('tili tile data ranges overlap');
      continue;
    }
    previous = range;
  }
  return ranges;
}
