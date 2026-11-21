import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'bun:test';
import { getHeicInfo, getItemPayload, parseIpma } from '../src/container/heic';
import { parseISOBMFF, findBox } from '../src/container/heif';
import {
  buildTiledTileUrl,
  getTiledImageTileIndices,
  parseTiledDataReference,
  parseTiledImageConfiguration,
  parseTiledItemRanges,
} from '../src/container/tili';
import { decodeHeic, getHeicMetadata } from '../src/decoder';
import { decodeItemPlanes, stitchTiledImage } from '../src/planes';
import { decode, decodeHDR } from '../src/async';
import { decodeHDRSync } from '../src/hdr';
import { parseMiniImage } from '../src/container/mini';
import { buildHeif, codedFixture, isoMetadata } from './helpers/heif';

const fixture = (name: string): Buffer =>
  readFileSync(join(import.meta.dir, 'fixtures', 'conformance', name));

function u16(value: number): Buffer {
  const out = Buffer.alloc(2);
  out.writeUInt16BE(value);
  return out;
}

function u32(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

function u64(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
}

function box(type: string, payload: Uint8Array): Buffer {
  const out = Buffer.alloc(8 + payload.length);
  out.writeUInt32BE(out.length, 0);
  out.write(type, 4, 4, 'ascii');
  Buffer.from(payload).copy(out, 8);
  return out;
}

function fullBox(type: string, payload: Uint8Array, version = 0, flags = 0): Buffer {
  const header = Buffer.from([version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]);
  return box(type, Buffer.concat([header, Buffer.from(payload)]));
}

function alphaChannelSubtype(): Buffer {
  const fields: [number, number][] = [
    [0, 1],
    [0, 3],
    [0, 3],
    [255, 9],
    [0, 9],
    [0, 1],
    [0, 1],
  ];
  const bits: number[] = [];
  for (const [value, width] of fields)
    for (let bit = width - 1; bit >= 0; bit--) bits.push((value >>> bit) & 1);
  bits.push(1);
  while (bits.length % 8) bits.push(0);
  const payload = Buffer.alloc(bits.length / 8);
  for (let index = 0; index < bits.length; index++)
    payload[index >> 3] |= bits[index] << (7 - (index & 7));

  const rbsp = Buffer.from([165, payload.length, ...payload, 0x80]),
    escaped: number[] = [];
  let zeroes = 0;
  for (const byte of rbsp) {
    if (zeroes >= 2 && byte <= 3) {
      escaped.push(3);
      zeroes = 0;
    }
    escaped.push(byte);
    zeroes = byte === 0 ? zeroes + 1 : 0;
  }
  const nal = Buffer.concat([Buffer.from([39 << 1, 1]), Buffer.from(escaped)]),
    lengthPrefixed = Buffer.concat([u32(nal.length), nal]);
  return Buffer.concat([u32(lengthPrefixed.length), lengthPrefixed]);
}

function repeatPlane(
  plane: Uint8Array | Uint16Array,
  tileWidth: number,
  tileHeight: number,
  columns: number,
  rows: number,
): Uint8Array | Uint16Array {
  const width = tileWidth * columns;
  const height = tileHeight * rows;
  const Output = plane instanceof Uint16Array ? Uint16Array : Uint8Array;
  const output = new Output(width * height);
  for (let tileY = 0; tileY < rows; tileY++) {
    for (let tileX = 0; tileX < columns; tileX++) {
      for (let y = 0; y < tileHeight; y++) {
        const source = plane.subarray(y * tileWidth, (y + 1) * tileWidth);
        output.set(source, (tileY * tileHeight + y) * width + tileX * tileWidth);
      }
    }
  }
  return output;
}

function bytes(plane: Uint8Array | Uint16Array): Buffer {
  return Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength);
}

function planeRegion(
  plane: Uint8Array | Uint16Array,
  planeWidth: number,
  x: number,
  y: number,
  width: number,
  height: number,
): Uint8Array | Uint16Array {
  const Output = plane instanceof Uint16Array ? Uint16Array : Uint8Array;
  const output = new Output(width * height);
  for (let row = 0; row < height; row++)
    output.set(
      plane.subarray((y + row) * planeWidth + x, (y + row) * planeWidth + x + width),
      row * width,
    );
  return output;
}

function wrapAsTili(
  tilePayload: Uint8Array,
  hvcC: Uint8Array,
  bitDepth: number,
  imageWidth = 832,
  imageHeight = 480,
  emptyTileIndex: number | null = null,
  tileWidth = 416,
  tileHeight = 240,
  majorBrand = 'heix',
  extraDimensionSizes: number[] = [],
  emptyTileIndexes: number[] = [],
): Buffer {
  const columns = 2;
  const rows = 2;
  const tileCount =
    columns * rows * extraDimensionSizes.reduce((product, size) => product * size, 1);
  const emptyIndexes = new Set(emptyTileIndexes);
  if (emptyTileIndex !== null) emptyIndexes.add(emptyTileIndex);
  const itemData = Buffer.alloc(
    tileCount * 8 + (tileCount - emptyIndexes.size) * tilePayload.length,
  );
  let offset = tileCount * 8;
  for (let i = 0; i < tileCount; i++) {
    if (emptyIndexes.has(i)) {
      itemData.writeUInt32BE(0xffff_ffff, i * 8);
      itemData.writeUInt32BE(0, i * 8 + 4);
      continue;
    }
    itemData.writeUInt32BE(offset, i * 8);
    itemData.writeUInt32BE(tilePayload.length, i * 8 + 4);
    Buffer.from(tilePayload).copy(itemData, offset);
    offset += tilePayload.length;
  }

  const ftyp = box(
    'ftyp',
    Buffer.concat([Buffer.from(majorBrand), u32(0), Buffer.from(`mif1${majorBrand}`)]),
  );
  const ispe = fullBox('ispe', Buffer.concat([u32(imageWidth), u32(imageHeight)]));
  const tileIspe = fullBox('ispe', Buffer.concat([u32(tileWidth), u32(tileHeight)]));
  const pixi = fullBox('pixi', Buffer.from([3, bitDepth, bitDepth, bitDepth]));
  const tileAssociation = fullBox('tipa', Buffer.from([3, 0x83, 0x82, 0x85]));
  const tilC = fullBox(
    'tilC',
    Buffer.concat([
      u32(tileWidth),
      u32(tileHeight),
      Buffer.from([extraDimensionSizes.length]),
      ...extraDimensionSizes.map(u32),
      Buffer.from('hvc1'),
      tileAssociation,
    ]),
  );
  const ipco = box('ipco', Buffer.concat([ispe, pixi, box('hvcC', hvcC), tilC, tileIspe]));
  const ipma = fullBox('ipma', Buffer.concat([u32(1), u16(1), Buffer.from([2, 0x81, 0x84])]));
  const iprp = box('iprp', Buffer.concat([ipco, ipma]));
  const infe = fullBox(
    'infe',
    Buffer.concat([u16(1), u16(0), Buffer.from('tili'), Buffer.from([0])]),
    2,
  );
  const iinf = fullBox('iinf', Buffer.concat([u16(1), infe]));
  const pitm = fullBox('pitm', u16(1));
  const deti = fullBox(
    'deti',
    Buffer.concat([Buffer.from([tileCount]), u32(0), u32(tileCount * 8)]),
    0,
    0x18,
  );
  const dref = fullBox('dref', Buffer.concat([u32(1), deti]));
  const dinf = box('dinf', dref);
  const makeIloc = (dataOffset: number) =>
    fullBox(
      'iloc',
      Buffer.concat([
        Buffer.from([0x44, 0]),
        u16(1), // item_count
        u16(1), // item_ID
        u16(0), // construction_method = file offset
        u16(1), // data_reference_index -> deti
        u16(1), // extent_count
        u32(dataOffset),
        u32(itemData.length),
      ]),
      1,
    );

  const makeMeta = (dataOffset: number) =>
    box('meta', Buffer.concat([Buffer.alloc(4), pitm, makeIloc(dataOffset), iinf, dinf, iprp]));
  const meta = makeMeta(ftyp.length + makeMeta(0).length + 8);
  const fileOffset = ftyp.length + meta.length + 8;
  const finalMeta = makeMeta(fileOffset);
  return Buffer.concat([ftyp, finalMeta, box('mdat', itemData)]);
}

function wrapAsExternalTili(
  tileWidth: number,
  tileHeight: number,
  columns: number,
  rows: number,
  options: {
    directoryIds?: [number, number];
    tileIdStart?: number;
    extraDimensionSizes?: number[];
  } = {},
): Buffer {
  const imageWidth = tileWidth * columns;
  const imageHeight = tileHeight * rows;
  const extraDimensionSizes = options.extraDimensionSizes ?? [];
  const count = columns * rows * extraDimensionSizes.reduce((product, size) => product * size, 1);
  const { directoryIds, tileIdStart = 1000 } = options;
  const directoryFields = directoryIds
    ? Buffer.concat([Buffer.from([1]), u16(directoryIds[0]), u16(directoryIds[1])])
    : Buffer.from([0]);
  const deti = fullBox(
    'deti',
    Buffer.concat([
      Buffer.from([count]),
      directoryFields,
      u64(tileIdStart),
      Buffer.from('https://cdn.example.invalid/tiles/'),
      Buffer.from([0]),
      Buffer.from('v1'),
      Buffer.from([0]),
      Buffer.from('$tileID$.heic'),
      Buffer.from([0]),
    ]),
    0,
    0x80,
  );
  const dref = fullBox('dref', Buffer.concat([u32(1), deti]));
  const ispe = fullBox('ispe', Buffer.concat([u32(imageWidth), u32(imageHeight)]));
  const tilC = fullBox(
    'tilC',
    Buffer.concat([
      u32(tileWidth),
      u32(tileHeight),
      Buffer.from([extraDimensionSizes.length]),
      ...extraDimensionSizes.map(u32),
    ]),
  );
  const ipco = box('ipco', Buffer.concat([ispe, tilC]));
  const ipma = fullBox('ipma', Buffer.concat([u32(1), u16(1), Buffer.from([2, 0x81, 0x82])]));
  const iprp = box('iprp', Buffer.concat([ipco, ipma]));
  const infe = fullBox(
    'infe',
    Buffer.concat([u16(1), u16(0), Buffer.from('tili'), Buffer.from([0])]),
    2,
  );
  const iinf = fullBox('iinf', Buffer.concat([u16(1), infe]));
  const pitm = fullBox('pitm', u16(1));
  const iloc = fullBox(
    'iloc',
    Buffer.concat([Buffer.from([0x44, 0]), u16(1), u16(1), u16(0), u16(1), u16(0)]),
    1,
  );
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('mif1'), u32(0), Buffer.from('mif1')]));
  const makeMeta = () =>
    box('meta', Buffer.concat([Buffer.alloc(4), pitm, iloc, iinf, box('dinf', dref), iprp]));
  return Buffer.concat([ftyp, makeMeta()]);
}

it('parses internal and external tili declarations per the 2026 syntax', () => {
  const internalTipa = fullBox('tipa', Buffer.from([0]));
  const internal = Buffer.concat([
    Buffer.alloc(4),
    u32(128),
    u32(64),
    Buffer.from([0]),
    Buffer.from('hvc1'),
    internalTipa,
  ]);
  expect(parseTiledImageConfiguration(internal)).toMatchObject({
    tileWidth: 128,
    tileHeight: 64,
    tileItemType: 'hvc1',
    propertyIndexes: [],
  });

  const external = Buffer.concat([Buffer.alloc(4), u32(128), u32(64), Buffer.from([0])]);
  expect(parseTiledImageConfiguration(external)).toMatchObject({
    tileWidth: 128,
    tileHeight: 64,
    tileItemType: null,
    propertyIndexes: [],
  });

  const externalReference = parseTiledDataReference(
    Buffer.concat([
      Buffer.from([0, 0, 0, 0x80, 1, 0]),
      u64(1000),
      Buffer.from('https://cdn.example.invalid/tiles/'),
      Buffer.from([0]),
      Buffer.from('v1'),
      Buffer.from([0]),
      Buffer.from('$tileID$.heic'),
      Buffer.from([0]),
    ]),
  );
  expect(externalReference).toMatchObject({
    externalTileUrls: true,
    inputItemCount: 1,
    tileIdStart: 1000,
    baseUrl: 'https://cdn.example.invalid/tiles/',
    urlExtension: 'v1',
    tileItemRequestTemplate: '$tileID$.heic',
  });
  expect(buildTiledTileUrl(externalReference, 0)).toBe(
    'https://cdn.example.invalid/tiles/v1/1000.heic',
  );

  const directoryReference = parseTiledDataReference(
    Buffer.concat([
      Buffer.from([0, 0, 0, 0x80, 4, 1]),
      u16(10),
      u16(11),
      u64(1000),
      Buffer.from('https://cdn.example.invalid/tiles/'),
      Buffer.from([0]),
      Buffer.from('v1'),
      Buffer.from([0]),
      Buffer.from('$tileID$.heic'),
      Buffer.from([0]),
    ]),
  );
  expect(buildTiledTileUrl(directoryReference, 3)).toBe(
    'https://cdn.example.invalid/tiles/v1/11/1003.heic',
  );
});

it('parses 15-bit tile property association indexes', () => {
  const tipa = fullBox(
    'tipa',
    Buffer.concat([Buffer.from([3]), u16(0x8081), u16(0x8082), u16(0x8085)]),
    0,
    1,
  );
  const internal = Buffer.concat([
    Buffer.alloc(4),
    u32(128),
    u32(64),
    Buffer.from([0]),
    Buffer.from('hvc1'),
    tipa,
  ]);
  expect(parseTiledImageConfiguration(internal)).toMatchObject({
    tileWidth: 128,
    tileHeight: 64,
    tileItemType: 'hvc1',
    propertyIndexes: [129, 130, 133],
    essentialIndexes: [129, 130, 133],
  });
});

it('writes and reads 15-bit HEIF property association indexes', () => {
  const base = codedFixture();
  const wideItem = {
    ...base,
    properties: [
      ...Array.from({ length: 128 }, () => box('free', new Uint8Array(0))),
      ...base.properties,
    ],
    propertyAssociationIndexes: [128, 129, 130],
  };
  const widePropertyBytes = buildHeif([wideItem], wideItem.id);
  const boxes = parseISOBMFF(widePropertyBytes);
  const meta = findBox(boxes, 'meta')!;
  const iprp = findBox(meta.children!, 'iprp')!;
  const ipma = findBox(iprp.children!, 'ipma')!;

  expect(ipma.data[0]).toBe(1);
  expect(ipma.data[3]).toBe(1);
  expect(parseIpma(ipma.data)).toEqual([
    {
      itemId: wideItem.id,
      propertyIndexes: [129, 130, 131],
      essentialIndexes: [129, 130, 131],
    },
  ]);
  expect(getHeicInfo(bytes, boxes)).toMatchObject({
    primaryItemId: wideItem.id,
    width: 64,
    height: 64,
  });
});

it('maps extra tili dimension coordinates to their row-major tile ranges', () => {
  const image = { rows: 2, columns: 3, extraDimensionSizes: [2, 3] };
  expect(getTiledImageTileIndices(image, [1, 2])).toEqual([30, 31, 32, 33, 34, 35]);
  expect(getTiledImageTileIndices(image)).toEqual([0, 1, 2, 3, 4, 5]);
  expect(() => getTiledImageTileIndices(image, [2, 0])).toThrow(
    'extraDimensionIndexes[0] is outside its dimension size 2',
  );
});

it('decodes external HEVC tili tiles from caller-provided URL resources', async () => {
  const source = fixture('pcm-rext-422-10.heic');
  const tiled = wrapAsExternalTili(416, 240, 2, 2, { extraDimensionSizes: [2] });
  const metadata = getHeicMetadata(tiled);
  expect(metadata).toMatchObject({
    primaryItemType: 'tili',
    width: 832,
    height: 480,
    bitDepth: 0,
    tiledImage: {
      tileItemType: null,
      extraDimensionSizes: [2],
      dataReference: { externalTileUrls: true, inputItemCount: 8 },
    },
  });
  const selectedTileIndexes = getTiledImageTileIndices(metadata.tiledImage!, [1]);
  const urls = selectedTileIndexes.map((index) =>
    buildTiledTileUrl(metadata.tiledImage!.dataReference, index),
  );
  const resources = Object.fromEntries(urls.map((url) => [url, new Uint8Array(source)]));
  const sourceImage = decodeHeic(new Uint8Array(source));
  const expected = new Uint8Array(832 * 480 * 4);
  for (let tileY = 0; tileY < 2; tileY++)
    for (let tileX = 0; tileX < 2; tileX++)
      for (let y = 0; y < 240; y++)
        for (let x = 0; x < 416; x++) {
          const from = (y * 416 + x) * 4;
          const to = ((tileY * 240 + y) * 832 + tileX * 416 + x) * 4;
          expected.set(sourceImage.data.subarray(from, from + 4), to);
        }

  const sync = decodeHeic(new Uint8Array(tiled), {
    externalTileData: resources,
    extraDimensionIndexes: [1],
  });
  expect([sync.width, sync.height, sync.bitDepth]).toEqual([832, 480, 10]);
  expect(sync.data).toEqual(expected);

  const requested: string[] = [];
  const asyncImage = await decode(new Uint8Array(tiled), {
    extraDimensionIndexes: [1],
    resolveExternalTile: (url) => {
      requested.push(url);
      return resources[url];
    },
  });
  expect(requested.sort()).toEqual([...urls].sort());
  expect(asyncImage).toMatchObject({ width: 832, height: 480, bitDepth: 10 });
  expect(asyncImage.data).toEqual(expected);

  const hdr = decodeHDRSync(new Uint8Array(tiled), {
    externalTileData: resources,
    extraDimensionIndexes: [1],
  });
  const sourceHdr = decodeHDRSync(new Uint8Array(source));
  expect([hdr.width, hdr.height, hdr.bitDepth]).toEqual([832, 480, 10]);
  for (let tileY = 0; tileY < 2; tileY++)
    for (let tileX = 0; tileX < 2; tileX++)
      for (let y = 0; y < 240; y++) {
        const from = y * 416 * 4;
        const to = ((tileY * 240 + y) * 832 + tileX * 416) * 4;
        expect(hdr.data.subarray(to, to + 416 * 4)).toEqual(
          sourceHdr.data.subarray(from, from + 416 * 4),
        );
      }
});

it('stitches external HEVC tili tiles with auxiliary alpha in SDR and HDR output', async () => {
  const miniSource = fixture('mini-C71.heic');
  const miniBox = findBox(parseISOBMFF(miniSource), 'mini')!;
  const base = parseMiniImage(miniBox.data, 0x68656963);
  const alphaConfig = fixture('mini-alpha-L_8.hvcc');
  const alphaPayload = fixture('mini-alpha-L_8.hevc');
  const alphaReference = fixture('mini-alpha-L_8.y');
  const tileHeif = buildHeif(
    [
      {
        id: 1,
        type: 'hvc1',
        data: base.itemData,
        properties: [
          box('hvcC', base.codecConfig),
          fullBox('ispe', Buffer.concat([u32(base.width), u32(base.height)])),
        ],
      },
      {
        id: 2,
        type: 'hvc1',
        data: alphaPayload,
        properties: [
          box('hvcC', alphaConfig),
          fullBox('ispe', Buffer.concat([u32(128), u32(128)])),
          fullBox(
            'auxC',
            Buffer.concat([Buffer.from('urn:mpeg:hevc:2015:auxid:1\0'), alphaChannelSubtype()]),
          ),
        ],
        refs: [{ type: 'auxl', to: [1] }],
      },
    ],
    1,
  );
  const tiled = wrapAsExternalTili(base.width, base.height, 2, 2);
  const tiledInfo = getHeicMetadata(tiled);
  const tileIndexes = getTiledImageTileIndices(tiledInfo.tiledImage!);
  const urls = tileIndexes.map((index) =>
    buildTiledTileUrl(tiledInfo.tiledImage!.dataReference, index),
  );
  const tileBytes = new Uint8Array(tileHeif);
  const resources = Object.fromEntries(urls.map((url) => [url, tileBytes]));

  const tileSdr = decodeHeic(tileBytes);
  expect(tileSdr.hasAlpha).toBe(true);
  for (let y = 0; y < base.height; y++)
    for (let x = 0; x < base.width; x++) {
      const sourceAlpha =
        alphaReference[
          Math.floor((y * 128) / base.height) * 128 + Math.floor((x * 128) / base.width)
        ];
      expect(tileSdr.data[(y * base.width + x) * 4 + 3]).toBe(255 - sourceAlpha);
    }
  const tiledSdr = decodeHeic(new Uint8Array(tiled), { externalTileData: resources });
  expect([tiledSdr.width, tiledSdr.height, tiledSdr.hasAlpha]).toEqual([
    base.width * 2,
    base.height * 2,
    true,
  ]);
  const expectedSdr = new Uint8Array(tiledSdr.data.length);
  for (let tileY = 0; tileY < 2; tileY++)
    for (let tileX = 0; tileX < 2; tileX++)
      for (let y = 0; y < base.height; y++) {
        const from = y * base.width * 4;
        const to = ((tileY * base.height + y) * tiledSdr.width + tileX * base.width) * 4;
        expectedSdr.set(tileSdr.data.subarray(from, from + base.width * 4), to);
      }
  expect(tiledSdr.data).toEqual(expectedSdr);
  const asyncSdr = await decode(new Uint8Array(tiled), {
    execution: 'main',
    resolveExternalTile: (url) => resources[url],
  });
  expect(asyncSdr.data).toEqual(expectedSdr);

  const tileHdr = decodeHDRSync(tileBytes);
  for (let y = 0; y < base.height; y++)
    for (let x = 0; x < base.width; x++) {
      const sourceAlpha =
        alphaReference[
          Math.floor((y * 128) / base.height) * 128 + Math.floor((x * 128) / base.width)
        ];
      expect(tileHdr.data[(y * base.width + x) * 4 + 3]).toBeCloseTo((255 - sourceAlpha) / 255, 6);
    }
  const tiledHdr = decodeHDRSync(new Uint8Array(tiled), { externalTileData: resources });
  expect([tiledHdr.width, tiledHdr.height, tiledHdr.hasAlpha]).toEqual([
    base.width * 2,
    base.height * 2,
    true,
  ]);
  const expectedHdr = new Float32Array(tiledHdr.data.length);
  for (let tileY = 0; tileY < 2; tileY++)
    for (let tileX = 0; tileX < 2; tileX++)
      for (let y = 0; y < base.height; y++) {
        const from = y * base.width * 4;
        const to = ((tileY * base.height + y) * tiledHdr.width + tileX * base.width) * 4;
        expectedHdr.set(tileHdr.data.subarray(from, from + base.width * 4), to);
      }
  expect(tiledHdr.data).toEqual(expectedHdr);
});

it('renders externally referenced identity tiles with their display transform', () => {
  const miniSource = fixture('mini-C71.heic');
  const miniBox = findBox(parseISOBMFF(miniSource), 'mini')!;
  const base = parseMiniImage(miniBox.data, 0x68656963);
  const baseItem = {
    id: 1,
    type: 'hvc1',
    data: base.itemData,
    properties: [
      box('hvcC', base.codecConfig),
      fullBox('ispe', Buffer.concat([u32(base.width), u32(base.height)])),
    ],
  };
  const identityItem = {
    id: 2,
    type: 'iden',
    data: new Uint8Array(),
    properties: [
      fullBox('ispe', Buffer.concat([u32(base.width), u32(base.height)])),
      box('irot', Buffer.from([1])),
    ],
    refs: [{ type: 'dimg', to: [1] }],
  };
  const tileBytes = new Uint8Array(buildHeif([baseItem, identityItem], 2));
  const standalone = decodeHeic(tileBytes);
  expect([standalone.width, standalone.height]).toEqual([base.height, base.width]);
  const tiled = wrapAsExternalTili(standalone.width, standalone.height, 2, 2);
  const info = getHeicMetadata(tiled);
  const urls = getTiledImageTileIndices(info.tiledImage!).map((index) =>
    buildTiledTileUrl(info.tiledImage!.dataReference, index),
  );
  const resources = Object.fromEntries(urls.map((url) => [url, tileBytes]));
  const image = decodeHeic(new Uint8Array(tiled), { externalTileData: resources });
  expect([image.width, image.height, image.hasAlpha]).toEqual([
    standalone.width * 2,
    standalone.height * 2,
    false,
  ]);
  const expected = new Uint8Array(image.data.length);
  for (let tileY = 0; tileY < 2; tileY++)
    for (let tileX = 0; tileX < 2; tileX++)
      for (let y = 0; y < standalone.height; y++) {
        const from = y * standalone.width * 4;
        const to = ((tileY * standalone.height + y) * image.width + tileX * standalone.width) * 4;
        expected.set(standalone.data.subarray(from, from + standalone.width * 4), to);
      }
  expect(image.data).toEqual(expected);

  const standaloneHdr = decodeHDRSync(tileBytes);
  const tiledHdr = decodeHDRSync(new Uint8Array(tiled), { externalTileData: resources });
  expect([tiledHdr.width, tiledHdr.height]).toEqual([image.width, image.height]);
  const expectedHdr = new Float32Array(tiledHdr.data.length);
  for (let tileY = 0; tileY < 2; tileY++)
    for (let tileX = 0; tileX < 2; tileX++)
      for (let y = 0; y < standaloneHdr.height; y++) {
        const from = y * standaloneHdr.width * 4;
        const to =
          ((tileY * standaloneHdr.height + y) * tiledHdr.width + tileX * standaloneHdr.width) * 4;
        expectedHdr.set(standaloneHdr.data.subarray(from, from + standaloneHdr.width * 4), to);
      }
  expect(tiledHdr.data).toEqual(expectedHdr);
});

it('decodes an in-file tili image nested as each external tile', () => {
  const miniSource = fixture('mini-C71.heic');
  const miniBox = findBox(parseISOBMFF(miniSource), 'mini')!;
  const base = parseMiniImage(miniBox.data, 0x68656963);
  const nestedTile = wrapAsTili(
    base.itemData,
    base.codecConfig,
    8,
    base.width * 2,
    base.height * 2,
    null,
    base.width,
    base.height,
    'heic',
  );
  const standalone = decodeHeic(new Uint8Array(nestedTile));
  const tiled = wrapAsExternalTili(standalone.width, standalone.height, 2, 2);
  const info = getHeicMetadata(tiled);
  const urls = getTiledImageTileIndices(info.tiledImage!).map((index) =>
    buildTiledTileUrl(info.tiledImage!.dataReference, index),
  );
  const resources = Object.fromEntries(urls.map((url) => [url, new Uint8Array(nestedTile)]));
  const image = decodeHeic(new Uint8Array(tiled), { externalTileData: resources });
  expect([image.width, image.height]).toEqual([standalone.width * 2, standalone.height * 2]);
  const expected = new Uint8Array(image.data.length);
  for (let tileY = 0; tileY < 2; tileY++)
    for (let tileX = 0; tileX < 2; tileX++)
      for (let y = 0; y < standalone.height; y++) {
        const from = y * standalone.width * 4;
        const to = ((tileY * standalone.height + y) * image.width + tileX * standalone.width) * 4;
        expected.set(standalone.data.subarray(from, from + standalone.width * 4), to);
      }
  expect(image.data).toEqual(expected);
});

it('reconstructs ISO gain maps inside external tili tiles for SDR and HDR', async () => {
  const source = fixture('pcm-rext-422-10.heic'),
    sourceBoxes = parseISOBMFF(source),
    sourceInfo = getHeicInfo(source, sourceBoxes),
    sourceProperties = findBox(sourceBoxes, 'ipco')!.children!,
    codecProperties = sourceProperties
      .filter((property) => ['hvcC', 'ispe', 'pixi', 'colr'].includes(property.type))
      .map((property) => box(property.type, property.data)),
    derivedProperties = sourceProperties
      .filter((property) => ['ispe', 'pixi', 'colr'].includes(property.type))
      .map((property) => box(property.type, property.data)),
    picture = getItemPayload(source, sourceBoxes, sourceInfo.primaryItemId)!;
  if (!sourceInfo.hvcC) throw new Error('official 4:2:2 fixture has no HEVC configuration');
  const tileBytes = buildHeif(
      [
        { id: 1, type: 'hvc1', data: picture, properties: codecProperties },
        { id: 2, type: 'hvc1', data: picture, properties: codecProperties },
        {
          id: 3,
          type: 'tmap',
          data: isoMetadata(),
          properties: [...derivedProperties, box('irot', Buffer.from([1]))],
          refs: [{ type: 'dimg', to: [1, 2] }],
        },
      ],
      3,
    ),
    tileSdr = decodeHeic(tileBytes),
    tileHdr = decodeHDRSync(tileBytes),
    tiled = wrapAsExternalTili(tileSdr.width, tileSdr.height, 2, 2),
    tiledInfo = getHeicMetadata(tiled),
    urls = getTiledImageTileIndices(tiledInfo.tiledImage!).map((index) =>
      buildTiledTileUrl(tiledInfo.tiledImage!.dataReference, index),
    ),
    resources = Object.fromEntries(urls.map((url) => [url, tileBytes]));

  const tiledSdr = decodeHeic(new Uint8Array(tiled), { externalTileData: resources }),
    tiledHdr = decodeHDRSync(new Uint8Array(tiled), { externalTileData: resources });
  expect([tiledSdr.width, tiledSdr.height]).toEqual([tileSdr.width * 2, tileSdr.height * 2]);
  expect([tiledHdr.width, tiledHdr.height, tiledHdr.source]).toEqual([
    tileHdr.width * 2,
    tileHdr.height * 2,
    tileHdr.source,
  ]);
  for (let tileY = 0; tileY < 2; tileY++)
    for (let tileX = 0; tileX < 2; tileX++)
      for (let y = 0; y < tileSdr.height; y++) {
        const sdrFrom = y * tileSdr.width * 4,
          sdrTo = ((tileY * tileSdr.height + y) * tiledSdr.width + tileX * tileSdr.width) * 4,
          hdrFrom = y * tileHdr.width * 4,
          hdrTo = ((tileY * tileHdr.height + y) * tiledHdr.width + tileX * tileHdr.width) * 4;
        expect(tiledSdr.data.subarray(sdrTo, sdrTo + tileSdr.width * 4)).toEqual(
          tileSdr.data.subarray(sdrFrom, sdrFrom + tileSdr.width * 4),
        );
        expect(tiledHdr.data.subarray(hdrTo, hdrTo + tileHdr.width * 4)).toEqual(
          tileHdr.data.subarray(hdrFrom, hdrFrom + tileHdr.width * 4),
        );
      }

  const asyncHdr = await decodeHDR(new Uint8Array(tiled), {
    execution: 'main',
    resolveExternalTile: (url) => resources[url],
  });
  expect(asyncHdr.data).toEqual(tiledHdr.data);
});

it('infers tile sizes from arbitrary-order offsets when size fields are omitted', () => {
  const itemData = Buffer.alloc(20);
  itemData.writeUInt32BE(16, 0);
  itemData.writeUInt32BE(0xffff_ffff, 4);
  itemData.writeUInt32BE(12, 8);
  itemData.set([10, 11, 12, 13], 12);
  itemData.set([20, 21, 22, 23], 16);
  const reference = parseTiledDataReference(
    Buffer.concat([Buffer.from([0, 0, 0, 0]), Buffer.from([3]), u32(0), u32(12)]),
  );
  expect(parseTiledItemRanges(itemData, reference, 3)).toEqual([
    { offset: 16, length: 4 },
    null,
    { offset: 12, length: 4 },
  ]);

  const sequentialReference = parseTiledDataReference(
    Buffer.concat([Buffer.from([0, 0, 0, 0x10, 3]), u32(0), u32(12)]),
  );
  expect(() => parseTiledItemRanges(itemData, sequentialReference, 3)).toThrow(
    'sequential tili offsets are not strictly ordered',
  );
});

it('decodes a selected 2D plane from an in-file multidimensional tili item', () => {
  const source = fixture('pcm-rext-422-10.heic');
  const sourceBoxes = parseISOBMFF(source);
  const sourceInfo = getHeicInfo(source, sourceBoxes);
  const sourceHvcC = findBox(sourceBoxes, 'hvcC')!;
  const sourcePayload = getItemPayload(source, sourceBoxes, sourceInfo.primaryItemId)!;
  const tiled = wrapAsTili(
    sourcePayload,
    sourceHvcC.data,
    10,
    800,
    470,
    null,
    416,
    240,
    'heix',
    [2],
    [0, 1, 2, 3],
  );
  const info = getHeicInfo(tiled, parseISOBMFF(tiled));
  expect(info.tiledImage).toMatchObject({
    rows: 2,
    columns: 2,
    extraDimensionSizes: [2],
    dataReference: { inputItemCount: 8 },
  });

  const emptyPlane = decodeHeic(tiled, { extraDimensionIndexes: [0] });
  expect([...emptyPlane.data.filter((_, index) => index % 4 !== 3)]).toEqual(
    new Array(800 * 470 * 3).fill(0),
  );
  expect(decodeHeic(tiled).data).toEqual(emptyPlane.data);

  const selectedPlane = decodeHeic(tiled, { extraDimensionIndexes: [1] });
  const sourceImage = decodeHeic(source);
  const expected = new Uint8Array(selectedPlane.width * selectedPlane.height * 4);
  for (let y = 0; y < selectedPlane.height; y++)
    for (let x = 0; x < selectedPlane.width; x++) {
      const from = ((y % sourceImage.height) * sourceImage.width + (x % sourceImage.width)) * 4;
      const to = (y * selectedPlane.width + x) * 4;
      expected.set(sourceImage.data.subarray(from, from + 4), to);
    }
  expect(selectedPlane.data).toEqual(expected);
  expect(() => decodeHeic(tiled, { extraDimensionIndexes: [2] })).toThrow(
    'extraDimensionIndexes[0] is outside its dimension size 2',
  );
});

it('stitches a 2x2 tili from the official 10-bit 4:2:2 HEVC vector', () => {
  const source = fixture('pcm-rext-422-10.heic');
  const sourceBoxes = parseISOBMFF(source);
  const sourceInfo = getHeicInfo(source, sourceBoxes);
  const sourceHvcC = findBox(sourceBoxes, 'hvcC')!;
  const sourcePayload = getItemPayload(source, sourceBoxes, sourceInfo.primaryItemId)!;
  const reference = decodeItemPlanes(source, sourceBoxes, sourceInfo, sourceInfo.primaryItemId);
  const tiled = wrapAsTili(sourcePayload, sourceHvcC.data, 10, 800, 470);
  const boxes = parseISOBMFF(tiled);
  const info = getHeicInfo(tiled, boxes);

  expect(info.tiledImage).toMatchObject({ rows: 2, columns: 2, tileWidth: 416, tileHeight: 240 });
  expect(getHeicMetadata(tiled)).toMatchObject({ width: 800, height: 470, bitDepth: 10 });

  const stitched = stitchTiledImage(tiled, boxes, info, info.tiledImage!);
  expect([stitched.width, stitched.height, stitched.chromaFormatIdc]).toEqual([832, 480, 2]);
  expect(bytes(stitched.y)).toEqual(bytes(repeatPlane(reference.y, 416, 240, 2, 2)));
  expect(bytes(stitched.cb)).toEqual(bytes(repeatPlane(reference.cb, 208, 240, 2, 2)));
  expect(bytes(stitched.cr)).toEqual(bytes(repeatPlane(reference.cr, 208, 240, 2, 2)));

  const image = decodeHeic(tiled);
  expect([image.width, image.height, image.bitDepth]).toEqual([800, 470, 10]);
  const referenceImage = decodeHeic(source);
  const expectedRgba = new Uint8Array(image.width * image.height * 4);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const sourceOffset =
        ((y % referenceImage.height) * referenceImage.width + (x % referenceImage.width)) * 4;
      const outputOffset = (y * image.width + x) * 4;
      expectedRgba.set(referenceImage.data.subarray(sourceOffset, sourceOffset + 4), outputOffset);
    }
  }
  expect(image.data).toEqual(expectedRgba);
});

it('renders an empty tili tile as neutral black', () => {
  const source = fixture('pcm-rext-422-10.heic');
  const sourceBoxes = parseISOBMFF(source);
  const sourceInfo = getHeicInfo(source, sourceBoxes);
  const sourceHvcC = findBox(sourceBoxes, 'hvcC')!;
  const sourcePayload = getItemPayload(source, sourceBoxes, sourceInfo.primaryItemId)!;
  const tiled = wrapAsTili(sourcePayload, sourceHvcC.data, 10, 832, 480, 0);
  const boxes = parseISOBMFF(tiled);
  const info = getHeicInfo(tiled, boxes);
  expect(getHeicMetadata(tiled).sliceNalCount).toBeGreaterThan(0);
  const planes = stitchTiledImage(tiled, boxes, info, info.tiledImage!);
  const emptyLumaTile = planeRegion(planes.y, 832, 0, 0, 416, 240);
  const emptyCbTile = planeRegion(planes.cb, 416, 0, 0, 208, 240);
  const emptyCrTile = planeRegion(planes.cr, 416, 0, 0, 208, 240);

  expect([...new Set(emptyLumaTile)]).toEqual([64]);
  expect([...new Set(emptyCbTile)]).toEqual([512]);
  expect([...new Set(emptyCrTile)]).toEqual([512]);
});

it('decodes an in-file 4:2:0 tili through the synchronous HEVC path', () => {
  const source = fixture('slices-rovi3-i.heic');
  const sourceBoxes = parseISOBMFF(source);
  const sourceInfo = getHeicInfo(source, sourceBoxes);
  const sourceHvcC = findBox(sourceBoxes, 'hvcC')!;
  const sourcePayload = getItemPayload(source, sourceBoxes, sourceInfo.primaryItemId)!;
  const reference = decodeItemPlanes(source, sourceBoxes, sourceInfo, sourceInfo.primaryItemId);
  const tiled = wrapAsTili(sourcePayload, sourceHvcC.data, 8, 1280, 960, null, 640, 480, 'heic');
  const boxes = parseISOBMFF(tiled);
  const info = getHeicInfo(tiled, boxes);

  expect(info.hvcC?.chromaFormatIdc).toBe(1);
  const stitched = stitchTiledImage(tiled, boxes, info, info.tiledImage!);
  expect([stitched.width, stitched.height, stitched.chromaFormatIdc]).toEqual([1280, 960, 1]);
  expect(bytes(stitched.y)).toEqual(bytes(repeatPlane(reference.y, 640, 480, 2, 2)));
  expect(bytes(stitched.cb)).toEqual(bytes(repeatPlane(reference.cb, 320, 240, 2, 2)));
  expect(bytes(stitched.cr)).toEqual(bytes(repeatPlane(reference.cr, 320, 240, 2, 2)));
  const image = decodeHeic(tiled);
  expect([image.width, image.height, image.bitDepth]).toEqual([1280, 960, 8]);
  const referenceImage = decodeHeic(source);
  const expectedRgba = new Uint8Array(image.width * image.height * 4);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const sourceOffset =
        ((y % referenceImage.height) * referenceImage.width + (x % referenceImage.width)) * 4;
      const outputOffset = (y * image.width + x) * 4;
      expectedRgba.set(referenceImage.data.subarray(sourceOffset, sourceOffset + 4), outputOffset);
    }
  }
  expect(image.data).toEqual(expectedRgba);
});
