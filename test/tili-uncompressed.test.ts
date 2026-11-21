import { expect, it } from 'bun:test';
import { decodeHeic, getHeicMetadata, isHeic } from '../src/decoder';
import { buildHeif, box, full, u16, u32 } from './helpers/heif';

function u64(value: number): Buffer {
  const data = Buffer.alloc(8);
  data.writeBigUInt64BE(BigInt(value));
  return data;
}

function uncompressedRgbImage(samples: Uint8Array): Uint8Array {
  const uncCData = Buffer.concat([
    u32(0),
    u32(3),
    u16(0),
    Buffer.from([7, 0, 0]),
    u16(1),
    Buffer.from([7, 0, 0]),
    u16(2),
    Buffer.from([7, 0, 0]),
    Buffer.from([0, 1, 0, 0]),
    u32(3),
    u32(0),
    u32(0),
    u32(0),
    u32(0),
  ]);
  return buildHeif(
    [
      {
        id: 1,
        type: 'unci',
        data: samples,
        properties: [
          full('ispe', 0, u32(2), u32(1)),
          box('cmpd', u32(3), u16(4), u16(5), u16(6)),
          full('uncC', 0, uncCData),
          full('pixi', 0, Buffer.from([3, 8, 8, 8])),
        ],
      },
    ],
    1,
  );
}

function externalUncompressedRgbTili(): Uint8Array {
  const tileWidth = 2,
    tileHeight = 1,
    baseUrl = 'https://tiles.example.invalid/rgb/',
    urlExtension = 'v1',
    tileTemplate = '$tileID$.heic',
    deti = box(
      'deti',
      Buffer.from([0, 0, 0, 0x80]),
      Buffer.from([2, 0]),
      u64(9000),
      Buffer.from(baseUrl),
      Buffer.from([0]),
      Buffer.from(urlExtension),
      Buffer.from([0]),
      Buffer.from(tileTemplate),
      Buffer.from([0]),
    ),
    image = Buffer.from(
      buildHeif(
        [
          {
            id: 1,
            type: 'tili',
            data: new Uint8Array(),
            properties: [
              full('ispe', 0, u32(tileWidth * 2), u32(tileHeight)),
              full('tilC', 0, u32(tileWidth), u32(tileHeight), Buffer.from([0])),
            ],
            dataReference: deti,
          },
        ],
        1,
      ),
    );
  image.write('mif1', 8, 'ascii');
  image.write('mif1mif1', 16, 'ascii');
  return image;
}

function uncompressedRgbTili(tiles: readonly Uint8Array[]): Uint8Array {
  const tileWidth = 2,
    tileHeight = 1,
    width = tileWidth * tiles.length,
    tileCount = tiles.length,
    offsetTableSize = tileCount * 8,
    itemData = Buffer.alloc(offsetTableSize + tiles.reduce((sum, tile) => sum + tile.length, 0));
  let dataOffset = offsetTableSize;
  for (let index = 0; index < tileCount; index++) {
    const tile = Buffer.from(tiles[index]);
    itemData.writeUInt32BE(dataOffset, index * 8);
    itemData.writeUInt32BE(tile.length, index * 8 + 4);
    tile.copy(itemData, dataOffset);
    dataOffset += tile.length;
  }

  const cmpd = box('cmpd', u32(3), u16(4), u16(5), u16(6));
  const uncCData = Buffer.concat([
    u32(0), // custom profile
    u32(3),
    u16(0),
    Buffer.from([7, 0, 0]), // 8-bit R
    u16(1),
    Buffer.from([7, 0, 0]), // 8-bit G
    u16(2),
    Buffer.from([7, 0, 0]), // 8-bit B
    Buffer.from([0, 1, 0, 0]), // 4:4:4 sampling, pixel interleave
    u32(3), // three bytes per pixel
    u32(0), // row alignment
    u32(0), // tile alignment
    u32(0), // one tile column in the uncompressed payload
    u32(0), // one tile row in the uncompressed payload
  ]);
  const tilePropertyIndexes = [3, 4, 5, 6];
  const tipa = full(
    'tipa',
    0,
    Buffer.concat([
      Buffer.from([tilePropertyIndexes.length]),
      ...tilePropertyIndexes.map((index) => Buffer.from([0x80 | index])),
    ]),
  );
  const properties = [
    full('ispe', 0, u32(width), u32(tileHeight)),
    full('tilC', 0, u32(tileWidth), u32(tileHeight), Buffer.from([0]), Buffer.from('unci'), tipa),
    full('ispe', 0, u32(tileWidth), u32(tileHeight)),
    cmpd,
    full('uncC', 0, uncCData),
    full('pixi', 0, Buffer.from([3, 8, 8, 8])),
  ];
  const deti = box(
    'deti',
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from([tileCount]),
    u32(0),
    u32(offsetTableSize),
  );
  return buildHeif(
    [
      {
        id: 1,
        type: 'tili',
        data: itemData,
        properties,
        propertyAssociationIndexes: [0, 1],
        dataReference: deti,
      },
    ],
    1,
  );
}

it('decodes in-file uncompressed RGB tiles through the public HEIC renderer', () => {
  const image = uncompressedRgbTili([
      Buffer.from([255, 0, 0, 0, 255, 0]),
      Buffer.from([0, 0, 255, 255, 255, 255]),
    ]),
    metadata = getHeicMetadata(image),
    decoded = decodeHeic(image);
  expect(metadata).toMatchObject({ width: 4, height: 1, bitDepth: 8, primaryItemType: 'tili' });
  expect(Array.from(decoded.data)).toEqual([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
  ]);

  const genericHeif = Buffer.from(image);
  genericHeif.write('mif1', 8, 'ascii');
  genericHeif.write('mif1mif1', 16, 'ascii');
  expect(isHeic(genericHeif)).toBe(true);
  expect(Array.from(decodeHeic(genericHeif).data)).toEqual(Array.from(decoded.data));
});

it('decodes external uncompressed HEIF tile files through the public renderer', () => {
  const image = externalUncompressedRgbTili(),
    tile0 = uncompressedRgbImage(Buffer.from([255, 0, 0, 0, 255, 0])),
    tile1 = uncompressedRgbImage(Buffer.from([0, 0, 255, 255, 255, 255])),
    decoded = decodeHeic(image, {
      externalTileData: {
        'https://tiles.example.invalid/rgb/v1/9000.heic': tile0,
        'https://tiles.example.invalid/rgb/v1/9001.heic': tile1,
      },
    });
  expect(isHeic(image)).toBe(true);
  expect(decoded.width).toBe(4);
  expect(decoded.height).toBe(1);
  expect(Array.from(decoded.data)).toEqual([
    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
  ]);
});
