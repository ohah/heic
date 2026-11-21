import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'bun:test';
import { getHeicInfo, getItemPayload } from '../src/container/heic';
import { findBox, parseISOBMFF } from '../src/container/heif';
import { buildTiledTileUrl } from '../src/container/tili';
import { decodeHeic } from '../src/decoder';
import { decode, decodeHDR } from '../src/async';
import { decodeHDRSync } from '../src/hdr';
import {
  cropPlanes,
  cropReferencePlanesForTile,
  decodeHevcPayload,
  decodeItemPlanes,
  stitchGrid,
  stitchTiledImage,
  type Planes,
} from '../src/planes';
import { isSliceNal, splitAnnexB } from '../src/hevc/nal';
import { parsePps } from '../src/hevc/pps';
import { parseSps } from '../src/hevc/sps';
import {
  buildBReferenceLists,
  derivePictureOrderCnt,
  type PictureReference,
} from '../src/hevc/reference-list';
import {
  parseSliceHeader,
  SLICE_TYPE_B,
  SLICE_TYPE_I,
  SLICE_TYPE_P,
} from '../src/hevc/slice-header';
import { wrapHevcPredChain } from '../scripts/lib/heif';
import { box, buildHeif, full, type Item, u16, u32 } from './helpers/heif';

const fixture = (name: string): Buffer =>
  readFileSync(join(import.meta.dir, 'fixtures', 'conformance', name));

function annexB(nals: readonly Uint8Array[]): Buffer {
  return Buffer.concat(nals.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), Buffer.from(nal)]));
}

function createOneTilePredImage(
  referencePayload: Uint8Array,
  predictedPayload: Uint8Array,
  hvcCData: Uint8Array,
  imageWidth = 416,
  imageHeight = 240,
): Uint8Array {
  const imageIspe = full('ispe', 0, u32(imageWidth), u32(imageHeight));
  const pixi = full('pixi', 0, Buffer.from([3, 8, 8, 8]));
  const hvcC = box('hvcC', hvcCData);
  const tileIspe = full('ispe', 0, u32(imageWidth), u32(imageHeight));
  const tipa = full('tipa', 0, Buffer.from([3, 0x86, 0x85, 0x88]));
  const tilC = full(
    'tilC',
    0,
    u32(imageWidth),
    u32(imageHeight),
    Buffer.from([0]),
    Buffer.from('hvc1'),
    tipa,
  );
  const rref = full('rref', 0, Buffer.from([1]), Buffer.from('pred'));
  const deti = box('deti', Buffer.from([0, 0, 0, 0x18]), Buffer.from([1]), u32(0), u32(8));
  const tileData = Buffer.alloc(8 + predictedPayload.length);
  tileData.writeUInt32BE(8, 0);
  tileData.writeUInt32BE(predictedPayload.length, 4);
  Buffer.from(predictedPayload).copy(tileData, 8);

  return buildHeif(
    [
      {
        id: 1,
        type: 'hvc1',
        data: referencePayload,
        properties: [imageIspe, pixi, hvcC],
      },
      {
        id: 2,
        type: 'tili',
        data: tileData,
        properties: [imageIspe, pixi, hvcC, tilC, tileIspe, rref],
        propertyAssociationIndexes: [0, 1, 3, 5],
        dataReference: deti,
        refs: [{ type: 'pred', to: [1] }],
      },
    ],
    2,
  );
}

it('parses all 18 weighted-B RPS and active-list patterns in the official WP_B vector', () => {
  const nals = splitAnnexB(fixture('wp-b-toshiba-3.bit'));
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official WP_B stream is missing its SPS or PPS');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const headers: ReturnType<typeof parseSliceHeader>[] = [];
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic) headers.push(header);
    if (!header.dependentSliceSegment) previousHeader = header;
  }
  expect(headers).toHaveLength(256);

  const representativePictures = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 249, 250, 251, 252, 253, 254, 255,
  ];
  const signatures = new Set(
    representativePictures.map((index) => {
      const header = headers[index];
      if (!header || header.sliceType !== SLICE_TYPE_B)
        throw new Error(`WP_B picture ${index} is not a B picture`);
      const rps = header.shortTermRefPicSet;
      if (!rps) throw new Error(`WP_B B picture ${index} has no short-term RPS`);
      return JSON.stringify({
        s0: rps.deltaPocS0.map((delta, i) => [delta, rps.usedByCurrPicS0[i]]),
        s1: rps.deltaPocS1.map((delta, i) => [delta, rps.usedByCurrPicS1[i]]),
        l0: header.numRefIdxL0ActiveMinus1 + 1,
        l1: header.numRefIdxL1ActiveMinus1 + 1,
      });
    }),
  );
  expect(signatures.size).toBe(18);
});

it('decodes all 18 weighted-B patterns as grid tili items with one shared pred cache', () => {
  const nals = splitAnnexB(fixture('wp-b-toshiba-3.bit'));
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official WP_B stream is missing its SPS or PPS');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const pictures: Uint8Array[][] = [];
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps);
    if (header.firstSliceInPic) pictures.push([]);
    if (pictures.length === 0) throw new Error('WP_B slice appeared before its first picture');
    pictures[pictures.length - 1].push(nal.data);
  }
  expect(pictures).toHaveLength(256);

  const records: {
    header: ReturnType<typeof parseSliceHeader>;
    poc: number;
    temporalId: number;
  }[] = [];
  const predReferenceIds: number[][] = [];
  let previousTid0Poc: number | null = null;
  let previousTid0Index: number | null = null;
  for (const [index, picture] of pictures.entries()) {
    const header = parseSliceHeader(picture[0], sps, pps);
    const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
    const temporalId = (picture[0][1] & 7) - 1;
    const dependencies = new Set<number>();
    if (header.sliceType !== SLICE_TYPE_I) {
      const rps = header.shortTermRefPicSet;
      if (!rps) throw new Error(`WP_B POC ${poc} has no short-term RPS`);
      for (const [deltas, usedFlags] of [
        [rps.deltaPocS0, rps.usedByCurrPicS0],
        [rps.deltaPocS1, rps.usedByCurrPicS1],
      ] as const) {
        for (let refIndex = 0; refIndex < deltas.length; refIndex++) {
          if (!usedFlags[refIndex]) continue;
          const referenceIndex = records.findIndex(
            (record) => record.poc === poc + deltas[refIndex],
          );
          if (referenceIndex < 0 || referenceIndex >= index)
            throw new Error(`WP_B POC ${poc} lacks a prior RPS reference`);
          dependencies.add(referenceIndex + 1);
        }
      }
      if (header.longTermRefPics.some((reference) => reference.usedByCurrPic))
        throw new Error('WP_B vector unexpectedly uses long-term references');
      if (previousTid0Index !== null) dependencies.add(previousTid0Index + 1);
    }
    predReferenceIds.push([...dependencies].sort((a, b) => a - b));
    records.push({ header, poc, temporalId });
    if (temporalId === 0) {
      previousTid0Poc = poc;
      previousTid0Index = index;
    }
  }

  const expectedPictures = new Map([
    [1, { poc: 8, l0: 1, l1: 1, hash: '9fbc5687eea4832bef8cf12b7607c78e' }],
    [2, { poc: 4, l0: 2, l1: 2, hash: '7995de7e7378bc80b9f002276fa06976' }],
    [3, { poc: 2, l0: 2, l1: 2, hash: 'ae09c54021d09cf1f75b9edf720d52ff' }],
    [4, { poc: 1, l0: 2, l1: 2, hash: '4775711a2d3d111b3e4dc6893c8d674c' }],
    [5, { poc: 3, l0: 2, l1: 2, hash: '4881cbbcbad1113ce7c02690cc7fa31e' }],
    [6, { poc: 6, l0: 2, l1: 2, hash: 'ec76ebfdd58a67998713877f5db30739' }],
    [7, { poc: 5, l0: 2, l1: 2, hash: '454cbec39d5f1e1a3dd3e3fa02214b6b' }],
    [8, { poc: 7, l0: 2, l1: 2, hash: '9b52446c79f70407cdb47e542742fcb8' }],
    [9, { poc: 16, l0: 4, l1: 4, hash: 'c1e79bd02b724aa8eef15cfdd77689b4' }],
    [10, { poc: 12, l0: 2, l1: 2, hash: '5c3cbd322973c051684205dabe6abd85' }],
    [11, { poc: 10, l0: 2, l1: 2, hash: 'dd3da4c13e363814ae091cc5336e9608' }],
    [249, { poc: 252, l0: 2, l1: 2, hash: '183c36e7586e7250ed9209cf8e41a0c3' }],
    [250, { poc: 250, l0: 2, l1: 2, hash: 'b6421d520cbdc66ff75d54fc4e7e9f51' }],
    [251, { poc: 249, l0: 2, l1: 2, hash: '322cafda65ffcddc15f44c3e30121ee5' }],
    [252, { poc: 251, l0: 2, l1: 2, hash: '84e91b719e47cc43913733ef805dc2f6' }],
    [253, { poc: 254, l0: 2, l1: 2, hash: 'd8495d50fd9dddb8b681c1dd6fa82d15' }],
    [254, { poc: 253, l0: 2, l1: 2, hash: 'd72c015f9cf847f3ad6cad66af85c392' }],
    [255, { poc: 255, l0: 2, l1: 2, hash: '9b6c692126708c1a5cac40170c45b087' }],
  ] as const);
  const targetIndexes = [...expectedPictures.keys()];
  const width = sps.picWidthInLumaSamples;
  const height = sps.picHeightInLumaSamples;
  const imageIspe = full('ispe', 0, u32(width), u32(height));
  const tileIspe = full('ispe', 0, u32(width), u32(height));
  const pixi = full('pixi', 0, Buffer.from([3, 8, 8, 8]));
  const parameterSets = nals
    .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
    .map((nal) => nal.data);
  const streams = pictures.map((picture, index) =>
    annexB([...(index === 0 ? parameterSets : []), ...picture]),
  );
  const baseline = wrapHevcPredChain(
    streams,
    predReferenceIds,
    width,
    height,
    sps.bitDepthLuma,
    sps.chromaFormatIdc,
  );
  const baselineBoxes = parseISOBMFF(baseline);
  const hvcCBox = findBox(baselineBoxes, 'hvcC');
  if (!hvcCBox) throw new Error('baseline HEIF chain is missing hvcC');
  const hvcC = box('hvcC', hvcCBox.data);
  const rref = full('rref', 0, Buffer.from([1]), Buffer.from('pred'));
  const inFileTileData = box(
    'deti',
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from([1]),
    u32(0),
    u32(8),
  );
  const tiliItems: Item[] = targetIndexes.map((rootIndex, ordinal) => {
    const expected = expectedPictures.get(rootIndex)!;
    const root = records[rootIndex];
    if (!root) throw new Error(`WP_B root picture ${rootIndex} is missing`);
    expect(root.poc).toBe(expected.poc);
    expect(root.header.sliceType).toBe(SLICE_TYPE_B);
    expect([
      root.header.numRefIdxL0ActiveMinus1 + 1,
      root.header.numRefIdxL1ActiveMinus1 + 1,
    ]).toEqual([expected.l0, expected.l1]);
    const payload = getItemPayload(baseline, baselineBoxes, rootIndex + 1);
    if (!payload) throw new Error(`baseline HEIF chain item ${rootIndex + 1} has no payload`);
    const propertyStart = ordinal * 6 + 1;
    const tipa = full(
      'tipa',
      0,
      Buffer.from([
        3,
        0x80 | (propertyStart + 2),
        0x80 | (propertyStart + 1),
        0x80 | (propertyStart + 4),
      ]),
    );
    const tilC = full(
      'tilC',
      0,
      u32(width),
      u32(height),
      Buffer.from([0]),
      Buffer.from('hvc1'),
      tipa,
    );
    const dependencies = predReferenceIds[rootIndex];
    return {
      id: 257 + ordinal,
      type: 'tili',
      data: createTileData(payload, 1),
      properties: [imageIspe, pixi, hvcC, tilC, tileIspe, rref],
      propertyAssociationIndexes: [0, 1, 3, 5],
      dataReference: inFileTileData,
      refs: [{ type: 'pred', to: dependencies }],
    };
  });
  const baseItems: Item[] = pictures.map((_, index) => {
    const dependencies = predReferenceIds[index];
    const payload = getItemPayload(baseline, baselineBoxes, index + 1);
    if (!payload) throw new Error(`baseline HEIF chain item ${index + 1} has no payload`);
    return {
      id: index + 1,
      type: 'hvc1',
      data: payload,
      properties: dependencies.length ? [imageIspe, pixi, hvcC, rref] : [imageIspe, pixi, hvcC],
      ...(dependencies.length ? { refs: [{ type: 'pred', to: dependencies }] } : {}),
    };
  });
  const gridId = 275;
  const gridItem: Item = {
    id: gridId,
    type: 'grid',
    data: Buffer.concat([
      Buffer.from([0, 0, 0, targetIndexes.length - 1]),
      u16(width * targetIndexes.length),
      u16(height),
    ]),
    properties: [full('ispe', 0, u32(width * targetIndexes.length), u32(height))],
    refs: [{ type: 'dimg', to: tiliItems.map((item) => item.id) }],
  };
  const input = buildHeif([...tiliItems, ...baseItems, gridItem], gridId);
  const boxes = parseISOBMFF(input);
  const info = getHeicInfo(input, boxes);
  expect(info.grid?.tileItemIds).toEqual(tiliItems.map((item) => item.id));
  if (!info.grid) throw new Error('weighted-B test HEIF is missing its grid metadata');
  const stitched = stitchGrid(input, boxes, info, info.grid);
  expect([stitched.width, stitched.height]).toEqual([width * targetIndexes.length, height]);
  const gridWidth = stitched.width;
  const chromaWidth = Math.ceil(width / 2);
  const chromaHeight = Math.ceil(height / 2);
  const gridChromaWidth = Math.ceil(gridWidth / 2);
  for (const [ordinal, rootIndex] of targetIndexes.entries()) {
    const expected = expectedPictures.get(rootIndex)!;
    const tileY = new Uint8Array(width * height);
    const tileCb = new Uint8Array(chromaWidth * chromaHeight);
    const tileCr = new Uint8Array(chromaWidth * chromaHeight);
    for (let row = 0; row < height; row++)
      tileY.set(
        stitched.y.subarray(
          row * gridWidth + ordinal * width,
          row * gridWidth + (ordinal + 1) * width,
        ),
        row * width,
      );
    for (let row = 0; row < chromaHeight; row++) {
      const start = row * gridChromaWidth + ordinal * chromaWidth;
      tileCb.set(stitched.cb.subarray(start, start + chromaWidth), row * chromaWidth);
      tileCr.set(stitched.cr.subarray(start, start + chromaWidth), row * chromaWidth);
    }
    const hash = createHash('md5');
    hash.update(tileY);
    hash.update(tileCb);
    hash.update(tileCr);
    expect(hash.digest('hex')).toBe(expected.hash);
  }
  const rendered = decodeHeic(input);
  expect([rendered.width, rendered.height]).toEqual([width * targetIndexes.length, height]);
  expect(rendered.data).toHaveLength(width * targetIndexes.length * height * 4);
}, 120_000);

function createTileData(
  payload: Uint8Array,
  columns: number,
  emptyIndexes: readonly number[] = [],
): Buffer {
  const tableBytes = columns * 8;
  const empty = new Set(emptyIndexes);
  const data = Buffer.alloc(tableBytes + payload.length * (columns - empty.size));
  let offset = tableBytes;
  for (let column = 0; column < columns; column++) {
    if (empty.has(column)) {
      data.writeUInt32BE(0xffff_ffff, column * 8);
      data.writeUInt32BE(0, column * 8 + 4);
      continue;
    }
    data.writeUInt32BE(offset, column * 8);
    data.writeUInt32BE(payload.length, column * 8 + 4);
    Buffer.from(payload).copy(data, offset);
    offset += payload.length;
  }
  return data;
}

function createTwoTilePredImage(
  referencePayload: Uint8Array,
  predictedPayload: Uint8Array,
  hvcCData: Uint8Array,
  tileWidth = 416,
  tileHeight = 240,
  bitDepth = 8,
): Uint8Array {
  const imageWidth = tileWidth * 2;
  const imageHeight = tileHeight;
  const imageIspe = full('ispe', 0, u32(imageWidth), u32(imageHeight));
  const tileIspe = full('ispe', 0, u32(tileWidth), u32(tileHeight));
  const pixi = full('pixi', 0, Buffer.from([3, bitDepth, bitDepth, bitDepth]));
  const hvcC = box('hvcC', hvcCData);
  const baseTileAssociation = full('tipa', 0, Buffer.from([3, 0x83, 0x82, 0x85]));
  const predTileAssociation = full('tipa', 0, Buffer.from([3, 0x88, 0x87, 0x8a]));
  const baseTilC = full(
    'tilC',
    0,
    u32(tileWidth),
    u32(tileHeight),
    Buffer.from([0]),
    Buffer.from('hvc1'),
    baseTileAssociation,
  );
  const predTilC = full(
    'tilC',
    0,
    u32(tileWidth),
    u32(tileHeight),
    Buffer.from([0]),
    Buffer.from('hvc1'),
    predTileAssociation,
  );
  const rref = full('rref', 0, Buffer.from([1]), Buffer.from('pred'));
  const deti = box('deti', Buffer.from([0, 0, 0, 0x18]), Buffer.from([2]), u32(0), u32(16));

  return buildHeif(
    [
      {
        id: 1,
        type: 'tili',
        data: createTileData(referencePayload, 2),
        properties: [imageIspe, pixi, hvcC, baseTilC, tileIspe],
        propertyAssociationIndexes: [0, 1, 3],
        dataReference: deti,
      },
      {
        id: 2,
        type: 'tili',
        data: createTileData(predictedPayload, 2),
        properties: [imageIspe, pixi, hvcC, predTilC, tileIspe, rref],
        propertyAssociationIndexes: [0, 1, 3, 5],
        dataReference: deti,
        refs: [{ type: 'pred', to: [1] }],
      },
    ],
    2,
  );
}

function createShiftedOneTilePredImage(
  referencePayload: Uint8Array,
  predictedPayload: Uint8Array,
  hvcCData: Uint8Array,
  tileWidth: number,
  tileHeight: number,
  bitDepth: number,
  relativeOffsetX = tileWidth,
  parentColumns = 2,
  emptyParentTileIndexes: readonly number[] = [],
): Uint8Array {
  const imageIspe = (width: number) => full('ispe', 0, u32(width), u32(tileHeight));
  const tileIspe = full('ispe', 0, u32(tileWidth), u32(tileHeight));
  const pixi = full('pixi', 0, Buffer.from([3, bitDepth, bitDepth, bitDepth]));
  const hvcC = box('hvcC', hvcCData);
  const baseTileAssociation = full('tipa', 0, Buffer.from([3, 0x83, 0x82, 0x85]));
  const predTileAssociation = full('tipa', 0, Buffer.from([3, 0x88, 0x87, 0x8a]));
  const baseTilC = full(
    'tilC',
    0,
    u32(tileWidth),
    u32(tileHeight),
    Buffer.from([0]),
    Buffer.from('hvc1'),
    baseTileAssociation,
  );
  const predTilC = full(
    'tilC',
    0,
    u32(tileWidth),
    u32(tileHeight),
    Buffer.from([0]),
    Buffer.from('hvc1'),
    predTileAssociation,
  );
  const predictedDataReference = box(
    'deti',
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from([1]),
    u32(0),
    u32(8),
  );
  const rref = full('rref', 0, Buffer.from([1]), Buffer.from('pred'));
  const rloc = full('rloc', 0, u32(relativeOffsetX), u32(0));

  return buildHeif(
    [
      {
        id: 1,
        type: 'tili',
        data: createTileData(referencePayload, parentColumns, emptyParentTileIndexes),
        properties: [imageIspe(tileWidth * parentColumns), pixi, hvcC, baseTilC, tileIspe],
        propertyAssociationIndexes: [0, 1, 3],
        dataReference: box(
          'deti',
          Buffer.from([0, 0, 0, 0x18]),
          Buffer.from([parentColumns]),
          u32(0),
          u32(parentColumns * 8),
        ),
      },
      {
        id: 2,
        type: 'tili',
        data: createTileData(predictedPayload, 1),
        properties: [imageIspe(tileWidth), pixi, hvcC, predTilC, tileIspe, rref, rloc],
        propertyAssociationIndexes: [0, 1, 3, 5, 6],
        dataReference: predictedDataReference,
        refs: [
          { type: 'pred', to: [1] },
          { type: 'tbas', to: [1] },
        ],
      },
    ],
    2,
  );
}

function createNestedShiftedConformancePredImage(
  referencePayload: Uint8Array,
  parentPredictedPayload: Uint8Array,
  childPredictedPayload: Uint8Array,
  hvcCData: Uint8Array,
  relativeOffsetX = 2,
  relativeOffsetY = 0,
): Uint8Array {
  const imageIspe = (width: number, height: number) => full('ispe', 0, u32(width), u32(height));
  const tileIspe = full('ispe', 0, u32(412), u32(236));
  const pixi = full('pixi', 0, Buffer.from([3, 8, 8, 8]));
  const hvcC = box('hvcC', hvcCData);
  const baseTileAssociation = full('tipa', 0, Buffer.from([3, 0x83, 0x82, 0x85]));
  const predTileAssociation = full('tipa', 0, Buffer.from([3, 0x88, 0x87, 0x8a]));
  const baseTilC = full(
    'tilC',
    0,
    u32(412),
    u32(236),
    Buffer.from([0]),
    Buffer.from('hvc1'),
    baseTileAssociation,
  );
  const predTilC = full(
    'tilC',
    0,
    u32(412),
    u32(236),
    Buffer.from([0]),
    Buffer.from('hvc1'),
    predTileAssociation,
  );
  const dataReference = (count: number) =>
    box('deti', Buffer.from([0, 0, 0, 0x18]), Buffer.from([count]), u32(0), u32(count * 8));
  const rref = full('rref', 0, Buffer.from([1]), Buffer.from('pred'));
  const rloc = full('rloc', 0, u32(relativeOffsetX), u32(relativeOffsetY));
  return buildHeif(
    [
      {
        id: 1,
        type: 'tili',
        data: createTileData(referencePayload, 4),
        properties: [imageIspe(824, 472), pixi, hvcC, baseTilC, tileIspe],
        propertyAssociationIndexes: [0, 1, 3],
        dataReference: dataReference(4),
      },
      {
        id: 2,
        type: 'tili',
        data: createTileData(parentPredictedPayload, 4),
        properties: [imageIspe(824, 472), pixi, hvcC, predTilC, tileIspe, rref],
        propertyAssociationIndexes: [0, 1, 3, 5],
        dataReference: dataReference(4),
        refs: [{ type: 'pred', to: [1] }],
      },
      {
        id: 3,
        type: 'tili',
        data: createTileData(childPredictedPayload, 1),
        properties: [imageIspe(412, 236), pixi, hvcC, predTilC, tileIspe, rref, rloc],
        propertyAssociationIndexes: [0, 1, 3, 5, 6],
        dataReference: dataReference(1),
        refs: [
          { type: 'pred', to: [2] },
          { type: 'tbas', to: [2] },
        ],
      },
    ],
    3,
  );
}

function createShiftedExternalOneTilePredImage(
  referencePayload: Uint8Array,
  externalTileDataReference: Uint8Array,
  hvcCData: Uint8Array,
  tileWidth: number,
  tileHeight: number,
  bitDepth: number,
  relativeOffsetX = tileWidth,
): Uint8Array {
  const imageIspe = (width: number) => full('ispe', 0, u32(width), u32(tileHeight));
  const tileIspe = full('ispe', 0, u32(tileWidth), u32(tileHeight));
  const pixi = full('pixi', 0, Buffer.from([3, bitDepth, bitDepth, bitDepth]));
  const hvcC = box('hvcC', hvcCData);
  const baseTileAssociation = full('tipa', 0, Buffer.from([3, 0x83, 0x82, 0x85]));
  const baseTilC = full(
    'tilC',
    0,
    u32(tileWidth),
    u32(tileHeight),
    Buffer.from([0]),
    Buffer.from('hvc1'),
    baseTileAssociation,
  );
  const externalTilC = full('tilC', 0, u32(tileWidth), u32(tileHeight), Buffer.from([0]));
  const internalDataReference = box(
    'deti',
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from([2]),
    u32(0),
    u32(16),
  );
  const rref = full('rref', 0, Buffer.from([1]), Buffer.from('pred'));
  const rloc = full('rloc', 0, u32(relativeOffsetX), u32(0));
  return buildHeif(
    [
      {
        id: 1,
        type: 'tili',
        data: createTileData(referencePayload, 2),
        properties: [imageIspe(tileWidth * 2), pixi, hvcC, baseTilC, tileIspe],
        propertyAssociationIndexes: [0, 1, 3],
        dataReference: internalDataReference,
      },
      {
        id: 2,
        type: 'tili',
        data: new Uint8Array(0),
        properties: [imageIspe(tileWidth), pixi, externalTilC, rref, rloc],
        propertyAssociationIndexes: [0, 1, 2, 3, 4],
        dataReference: externalTileDataReference,
        refs: [
          { type: 'pred', to: [1] },
          { type: 'tbas', to: [1] },
        ],
      },
    ],
    2,
  );
}

function placeMotionMapOnRight<T extends Uint8Array | Int32Array | Float64Array>(
  source: T,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetX: number,
): T {
  const length = targetWidth * sourceHeight;
  const target =
    source instanceof Uint8Array
      ? (new Uint8Array(length) as T)
      : source instanceof Int32Array
        ? (new Int32Array(length) as T)
        : (new Float64Array(length) as T);
  for (let row = 0; row < sourceHeight; row++)
    target.set(
      source.subarray(row * sourceWidth, (row + 1) * sourceWidth),
      row * targetWidth + targetX,
    );
  return target;
}

function createTwoTileMultiRefPredImage(
  referencePayload: Uint8Array,
  futurePredPayload: Uint8Array,
  predictedPayload: Uint8Array,
  hvcCData: Uint8Array,
  tileWidth = 416,
  tileHeight = 240,
  bitDepth = 8,
): Uint8Array {
  const imageWidth = tileWidth * 2;
  const imageHeight = tileHeight;
  const imageIspe = full('ispe', 0, u32(imageWidth), u32(imageHeight));
  const tileIspe = full('ispe', 0, u32(tileWidth), u32(tileHeight));
  const pixi = full('pixi', 0, Buffer.from([3, bitDepth, bitDepth, bitDepth]));
  const hvcC = box('hvcC', hvcCData);
  const baseTileAssociation = full('tipa', 0, Buffer.from([3, 0x83, 0x82, 0x85]));
  const predTileAssociation = full('tipa', 0, Buffer.from([3, 0x88, 0x87, 0x8a]));
  const baseTilC = full(
    'tilC',
    0,
    u32(tileWidth),
    u32(tileHeight),
    Buffer.from([0]),
    Buffer.from('hvc1'),
    baseTileAssociation,
  );
  const predTilC = full(
    'tilC',
    0,
    u32(tileWidth),
    u32(tileHeight),
    Buffer.from([0]),
    Buffer.from('hvc1'),
    predTileAssociation,
  );
  const internalTileDataReference = box(
    'deti',
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from([2]),
    u32(0),
    u32(16),
  );
  const rref = full('rref', 0, Buffer.from([1]), Buffer.from('pred'));

  return buildHeif(
    [
      {
        id: 1,
        type: 'tili',
        data: createTileData(referencePayload, 2),
        properties: [imageIspe, pixi, hvcC, baseTilC, tileIspe],
        propertyAssociationIndexes: [0, 1, 3],
        dataReference: internalTileDataReference,
      },
      {
        id: 2,
        type: 'tili',
        data: createTileData(futurePredPayload, 2),
        properties: [imageIspe, pixi, hvcC, predTilC, tileIspe, rref],
        propertyAssociationIndexes: [0, 1, 3, 5],
        dataReference: internalTileDataReference,
        refs: [{ type: 'pred', to: [1] }],
      },
      {
        id: 3,
        type: 'tili',
        data: createTileData(predictedPayload, 2),
        properties: [imageIspe, pixi, hvcC, predTilC, tileIspe, rref],
        propertyAssociationIndexes: [0, 1, 3, 5],
        dataReference: internalTileDataReference,
        refs: [{ type: 'pred', to: [1, 2] }],
      },
    ],
    3,
  );
}

function createTwoTilePredChain(
  codedPictures: readonly Uint8Array[],
  predReferenceIds: readonly (readonly number[])[],
  hvcCData: Uint8Array,
  tileWidth: number,
  tileHeight: number,
  bitDepth: number,
): Uint8Array {
  if (codedPictures.length === 0 || codedPictures.length !== predReferenceIds.length)
    throw new Error('two-tile HEIF pred chain has mismatched picture and reference counts');
  const imageIspe = full('ispe', 0, u32(tileWidth * 2), u32(tileHeight));
  const tileIspe = full('ispe', 0, u32(tileWidth), u32(tileHeight));
  const pixi = full('pixi', 0, Buffer.from([3, bitDepth, bitDepth, bitDepth]));
  const hvcC = box('hvcC', hvcCData);
  const baseTileAssociation = full('tipa', 0, Buffer.from([3, 0x83, 0x82, 0x85]));
  const predTileAssociation = full('tipa', 0, Buffer.from([3, 0x88, 0x87, 0x8a]));
  const rref = full('rref', 0, Buffer.from([1]), Buffer.from('pred'));
  const internalTileDataReference = box(
    'deti',
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from([2]),
    u32(0),
    u32(16),
  );
  const items: Item[] = codedPictures.map((payload, index) => {
    const references = predReferenceIds[index]!;
    if (references.some((referenceId) => referenceId < 1 || referenceId > index))
      throw new Error(`two-tile HEIF item ${index + 1} has a forward pred reference`);
    const hasReferences = references.length > 0;
    const tilC = full(
      'tilC',
      0,
      u32(tileWidth),
      u32(tileHeight),
      Buffer.from([0]),
      Buffer.from('hvc1'),
      hasReferences ? predTileAssociation : baseTileAssociation,
    );
    const properties = hasReferences
      ? [imageIspe, pixi, hvcC, tilC, tileIspe, rref]
      : [imageIspe, pixi, hvcC, tilC, tileIspe];
    return {
      id: index + 1,
      type: 'tili',
      data: createTileData(payload, 2),
      properties,
      propertyAssociationIndexes: hasReferences ? [0, 1, 3, 5] : [0, 1, 3],
      dataReference: internalTileDataReference,
      ...(hasReferences ? { refs: [{ type: 'pred' as const, to: [...references] }] } : {}),
    };
  });
  return buildHeif(items, items.length);
}

function createTwoTileExternalPredChain(
  codedPictures: readonly Uint8Array[],
  predReferenceIds: readonly (readonly number[])[],
  hvcCData: Uint8Array,
  externalTileDataReference: Uint8Array,
  tileWidth: number,
  tileHeight: number,
  bitDepth: number,
): Uint8Array {
  if (codedPictures.length < 2 || codedPictures.length !== predReferenceIds.length)
    throw new Error(
      'external two-tile HEIF pred chain needs matched reference and target pictures',
    );
  const imageIspe = full('ispe', 0, u32(tileWidth * 2), u32(tileHeight));
  const tileIspe = full('ispe', 0, u32(tileWidth), u32(tileHeight));
  const pixi = full('pixi', 0, Buffer.from([3, bitDepth, bitDepth, bitDepth]));
  const hvcC = box('hvcC', hvcCData);
  const baseTileAssociation = full('tipa', 0, Buffer.from([3, 0x83, 0x82, 0x85]));
  const predTileAssociation = full('tipa', 0, Buffer.from([3, 0x88, 0x87, 0x8a]));
  const externalTilC = full('tilC', 0, u32(tileWidth), u32(tileHeight), Buffer.from([0]));
  const rref = full('rref', 0, Buffer.from([1]), Buffer.from('pred'));
  const internalTileDataReference = box(
    'deti',
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from([2]),
    u32(0),
    u32(16),
  );
  const targetIndex = codedPictures.length - 1;
  const items: Item[] = codedPictures.map((payload, index) => {
    const references = predReferenceIds[index]!;
    if (references.some((referenceId) => referenceId < 1 || referenceId > index))
      throw new Error(`external two-tile HEIF item ${index + 1} has a forward pred reference`);
    if (index === targetIndex) {
      if (references.length === 0)
        throw new Error('external two-tile HEIF target has no pred references');
      return {
        id: index + 1,
        type: 'tili',
        data: new Uint8Array(0),
        properties: [imageIspe, pixi, externalTilC, rref],
        propertyAssociationIndexes: [0, 1, 2, 3],
        dataReference: externalTileDataReference,
        refs: [{ type: 'pred', to: [...references] }],
      };
    }
    const hasReferences = references.length > 0;
    const tilC = full(
      'tilC',
      0,
      u32(tileWidth),
      u32(tileHeight),
      Buffer.from([0]),
      Buffer.from('hvc1'),
      hasReferences ? predTileAssociation : baseTileAssociation,
    );
    return {
      id: index + 1,
      type: 'tili',
      data: createTileData(payload, 2),
      properties: hasReferences
        ? [imageIspe, pixi, hvcC, tilC, tileIspe, rref]
        : [imageIspe, pixi, hvcC, tilC, tileIspe],
      propertyAssociationIndexes: hasReferences ? [0, 1, 3, 5] : [0, 1, 3],
      dataReference: internalTileDataReference,
      ...(hasReferences ? { refs: [{ type: 'pred' as const, to: [...references] }] } : {}),
    };
  });
  return buildHeif(items, items.length);
}

function makeExternalTileDataReference(tileCount: number, tileIdStart: number): Uint8Array {
  const tileId = Buffer.alloc(8);
  tileId.writeBigUInt64BE(BigInt(tileIdStart));
  return box(
    'deti',
    Buffer.from([0, 0, 0, 0x80]),
    Buffer.from([tileCount, 0]),
    tileId,
    Buffer.from('https://cdn.example.invalid/pred-tiles/'),
    Buffer.from([0]),
    Buffer.from('v1'),
    Buffer.from([0]),
    Buffer.from('$tileID$.heic'),
    Buffer.from([0]),
  );
}

function createExternalOneTilePredImage(
  referencePayload: Uint8Array,
  externalTileDataReference: Uint8Array,
  imageWidth: number,
  imageHeight: number,
  hvcCData: Uint8Array,
): Uint8Array {
  const imageIspe = full('ispe', 0, u32(imageWidth), u32(imageHeight));
  const pixi = full('pixi', 0, Buffer.from([3, 8, 8, 8]));
  const hvcC = box('hvcC', hvcCData);
  const externalTilC = full('tilC', 0, u32(imageWidth), u32(imageHeight), Buffer.from([0]));
  const rref = full('rref', 0, Buffer.from([1]), Buffer.from('pred'));
  return buildHeif(
    [
      {
        id: 1,
        type: 'hvc1',
        data: referencePayload,
        properties: [imageIspe, pixi, hvcC],
      },
      {
        id: 2,
        type: 'tili',
        data: new Uint8Array(0),
        properties: [imageIspe, pixi, externalTilC, rref],
        propertyAssociationIndexes: [0, 1, 2, 3],
        dataReference: externalTileDataReference,
        refs: [{ type: 'pred', to: [1] }],
      },
    ],
    2,
  );
}

function makeConformanceWindowPredChain() {
  const nals = splitAnnexB(fixture('confwin-a-sony-1.bit'));
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official CONFWIN_A stream is missing its SPS or PPS');
  const sps = parseSps(spsNal.data);
  if (
    sps.picWidthInLumaSamples !== 416 ||
    sps.picHeightInLumaSamples !== 240 ||
    sps.width !== 412 ||
    sps.height !== 236 ||
    sps.defaultDisplayWindow !== null
  )
    throw new Error('official CONFWIN_A vector changed its coded/display dimensions');
  const pps = parsePps(ppsNal.data);
  const pictures: Uint8Array[][] = [];
  let picture: Uint8Array[] = [];
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic && picture.length > 0) {
      pictures.push(picture);
      picture = [];
    }
    picture.push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }
  if (picture.length > 0) pictures.push(picture);
  if (pictures.length !== 60)
    throw new Error(`expected 60 official pictures, got ${pictures.length}`);
  const predictedHeader = parseSliceHeader(pictures[1][0], sps, pps);
  if (
    predictedHeader.sliceType !== SLICE_TYPE_P ||
    predictedHeader.pictureOrderCntLsb !== 2 ||
    predictedHeader.numRefIdxL0ActiveMinus1 !== 0
  )
    throw new Error('official CONFWIN_A picture 1 is no longer the expected POC 2 P picture');

  const parameterSets = nals
    .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
    .map((nal) => nal.data);
  const referenceStream = annexB([...parameterSets, ...pictures[0]]);
  const predictedStream = annexB(pictures[1]);
  const baseline = wrapHevcPredChain(
    [referenceStream, predictedStream],
    [[], [1]],
    sps.width,
    sps.height,
    sps.bitDepthLuma,
    sps.chromaFormatIdc,
  );
  const boxes = parseISOBMFF(baseline);
  const hvcC = findBox(boxes, 'hvcC');
  const referencePayload = getItemPayload(baseline, boxes, 1);
  const predictedPayload = getItemPayload(baseline, boxes, 2);
  if (!hvcC || !referencePayload || !predictedPayload)
    throw new Error('synthetic CONFWIN_A HEIF chain is missing coded item data');
  return {
    baseline,
    boxes,
    hvcC: hvcC.data,
    referencePayload,
    predictedPayload,
    pictures,
    referenceStream,
  };
}

it('keeps the official conformance crop when default-window application is requested without a VUI window', () => {
  const { baseline } = makeConformanceWindowPredChain();
  expect(decodeHeic(baseline, { applyDefaultDisplayWindow: true })).toEqual(decodeHeic(baseline));
});

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex');
}

function createExternalTwoTileMultiRefPredImage(
  referencePayload: Uint8Array,
  futurePredPayload: Uint8Array,
  hvcCData: Uint8Array,
  externalTileDataReference: Uint8Array,
  tileWidth = 416,
  tileHeight = 240,
  bitDepth = 8,
): Uint8Array {
  const imageWidth = tileWidth * 2;
  const imageHeight = tileHeight;
  const imageIspe = full('ispe', 0, u32(imageWidth), u32(imageHeight));
  const tileIspe = full('ispe', 0, u32(tileWidth), u32(tileHeight));
  const pixi = full('pixi', 0, Buffer.from([3, bitDepth, bitDepth, bitDepth]));
  const hvcC = box('hvcC', hvcCData);
  const baseTileAssociation = full('tipa', 0, Buffer.from([3, 0x83, 0x82, 0x85]));
  const predTileAssociation = full('tipa', 0, Buffer.from([3, 0x88, 0x87, 0x8a]));
  const baseTilC = full(
    'tilC',
    0,
    u32(tileWidth),
    u32(tileHeight),
    Buffer.from([0]),
    Buffer.from('hvc1'),
    baseTileAssociation,
  );
  const predTilC = full(
    'tilC',
    0,
    u32(tileWidth),
    u32(tileHeight),
    Buffer.from([0]),
    Buffer.from('hvc1'),
    predTileAssociation,
  );
  const externalTilC = full('tilC', 0, u32(tileWidth), u32(tileHeight), Buffer.from([0]));
  const internalTileDataReference = box(
    'deti',
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from([2]),
    u32(0),
    u32(16),
  );
  const rref = full('rref', 0, Buffer.from([1]), Buffer.from('pred'));

  return buildHeif(
    [
      {
        id: 1,
        type: 'tili',
        data: createTileData(referencePayload, 2),
        properties: [imageIspe, pixi, hvcC, baseTilC, tileIspe],
        propertyAssociationIndexes: [0, 1, 3],
        dataReference: internalTileDataReference,
      },
      {
        id: 2,
        type: 'tili',
        data: createTileData(futurePredPayload, 2),
        properties: [imageIspe, pixi, hvcC, predTilC, tileIspe, rref],
        propertyAssociationIndexes: [0, 1, 3, 5],
        dataReference: internalTileDataReference,
        refs: [{ type: 'pred', to: [1] }],
      },
      {
        id: 3,
        type: 'tili',
        data: new Uint8Array(0),
        properties: [imageIspe, pixi, externalTilC, rref],
        propertyAssociationIndexes: [0, 1, 2, 3],
        dataReference: externalTileDataReference,
        refs: [{ type: 'pred', to: [1, 2] }],
      },
    ],
    3,
  );
}

function createExternalTwoTilePredImage(
  referencePayload: Uint8Array,
  hvcCData: Uint8Array,
  externalTileDataReference: Uint8Array,
  tileWidth = 416,
  tileHeight = 240,
  bitDepth = 8,
): Uint8Array {
  const imageWidth = tileWidth * 2;
  const imageHeight = tileHeight;
  const imageIspe = full('ispe', 0, u32(imageWidth), u32(imageHeight));
  const tileIspe = full('ispe', 0, u32(tileWidth), u32(tileHeight));
  const pixi = full('pixi', 0, Buffer.from([3, bitDepth, bitDepth, bitDepth]));
  const hvcC = box('hvcC', hvcCData);
  const baseTileAssociation = full('tipa', 0, Buffer.from([3, 0x83, 0x82, 0x85]));
  const baseTilC = full(
    'tilC',
    0,
    u32(tileWidth),
    u32(tileHeight),
    Buffer.from([0]),
    Buffer.from('hvc1'),
    baseTileAssociation,
  );
  const externalTilC = full('tilC', 0, u32(tileWidth), u32(tileHeight), Buffer.from([0]));
  const internalTileDataReference = box(
    'deti',
    Buffer.from([0, 0, 0, 0x18]),
    Buffer.from([2]),
    u32(0),
    u32(16),
  );
  const rref = full('rref', 0, Buffer.from([1]), Buffer.from('pred'));

  return buildHeif(
    [
      {
        id: 1,
        type: 'tili',
        data: createTileData(referencePayload, 2),
        properties: [imageIspe, pixi, hvcC, baseTilC, tileIspe],
        propertyAssociationIndexes: [0, 1, 3],
        dataReference: internalTileDataReference,
      },
      {
        id: 2,
        type: 'tili',
        data: new Uint8Array(0),
        properties: [imageIspe, pixi, externalTilC, rref],
        propertyAssociationIndexes: [0, 1, 2, 3],
        dataReference: externalTileDataReference,
        refs: [{ type: 'pred', to: [1] }],
      },
    ],
    2,
  );
}

function repeatHorizontalRows<
  T extends Uint8Array | Uint16Array | Int32Array | Float32Array | Float64Array,
>(source: T, rowWidth: number, height: number): T {
  const Constructor = source.constructor as { new (length: number): T };
  const output = new Constructor(source.length * 2);
  for (let row = 0; row < height; row++) {
    const inputOffset = row * rowWidth;
    const outputOffset = row * rowWidth * 2;
    const samples = source.subarray(inputOffset, inputOffset + rowWidth);
    output.set(samples, outputOffset);
    output.set(samples, outputOffset + rowWidth);
  }
  return output;
}

function expectedCroppedTiliReference(
  source: Planes,
  parentColumns: number,
  parentRows: number,
  displayOriginX: number,
  displayOriginY: number,
  outputWidth: number,
  outputHeight: number,
): Planes {
  const sps = source.sourceSps;
  if (!sps) throw new Error('cropped tili reference expectation has no source SPS');
  const subWidth = sps.chromaFormatIdc === 1 || sps.chromaFormatIdc === 2 ? 2 : 1;
  const subHeight = sps.chromaFormatIdc === 1 ? 2 : 1;
  const copy = (
    samples: Uint8Array | Uint16Array,
    planeWidth: number,
    planeHeight: number,
    width: number,
    height: number,
    sampleSubWidth: number,
    sampleSubHeight: number,
  ) => {
    const visibleTileWidth = sps.width / sampleSubWidth;
    const visibleTileHeight = sps.height / sampleSubHeight;
    const cropLeft = sampleSubWidth === 1 ? subWidth * sps.cropLeft : sps.cropLeft;
    const cropTop = sampleSubHeight === 1 ? subHeight * sps.cropTop : sps.cropTop;
    const output =
      samples instanceof Uint16Array
        ? new Uint16Array(width * height)
        : new Uint8Array(width * height);
    for (let row = 0; row < height; row++) {
      const displayY = displayOriginY / sampleSubHeight + row;
      const tileRow = Math.max(
        0,
        Math.min(parentRows - 1, Math.floor(displayY / visibleTileHeight)),
      );
      const codedY = displayY - tileRow * visibleTileHeight + cropTop;
      if (codedY < 0 || codedY >= planeHeight)
        throw new Error('expected cropped tili reference row exceeds source tile');
      for (let column = 0; column < width; column++) {
        const displayX = displayOriginX / sampleSubWidth + column;
        const tileColumn = Math.max(
          0,
          Math.min(parentColumns - 1, Math.floor(displayX / visibleTileWidth)),
        );
        const codedX = displayX - tileColumn * visibleTileWidth + cropLeft;
        if (codedX < 0 || codedX >= planeWidth)
          throw new Error('expected cropped tili reference column exceeds source tile');
        output[row * width + column] = samples[codedY * planeWidth + codedX];
      }
    }
    return output;
  };
  const motionFields = [
    'interMap',
    'motionIsExternal',
    'motionPredFlags',
    'motionRefIdxL0',
    'motionXQpel',
    'motionYQpel',
    'motionRefPoc',
    'motionRefLongTerm',
    'motionRefLayerId',
    'motionXQpelL1',
    'motionYQpelL1',
    'motionRefIdxL1',
    'motionRefPocL1',
    'motionRefLongTermL1',
    'motionRefLayerIdL1',
  ] as const;
  const motionMaps: Partial<Pick<Planes, (typeof motionFields)[number]>> = {};
  const outputMapWidth = Math.ceil(outputWidth / 4);
  const outputMapHeight = Math.ceil(outputHeight / 4);
  for (const field of motionFields) {
    const sourceMap = source[field] as Uint8Array | Int32Array | Float64Array | undefined;
    if (!sourceMap) continue;
    const outputMap =
      sourceMap instanceof Int32Array
        ? new Int32Array(outputMapWidth * outputMapHeight)
        : sourceMap instanceof Float64Array
          ? new Float64Array(outputMapWidth * outputMapHeight)
          : new Uint8Array(outputMapWidth * outputMapHeight);
    for (let row = 0; row < outputMapHeight; row++) {
      const displayY = displayOriginY + row * 4;
      const tileRow = Math.max(0, Math.min(parentRows - 1, Math.floor(displayY / sps.height)));
      const codedY = displayY - tileRow * sps.height + subHeight * sps.cropTop;
      for (let column = 0; column < outputMapWidth; column++) {
        const displayX = displayOriginX + column * 4;
        const tileColumn = Math.max(
          0,
          Math.min(parentColumns - 1, Math.floor(displayX / sps.width)),
        );
        const codedX = displayX - tileColumn * sps.width + subWidth * sps.cropLeft;
        const sourceMapX = Math.floor(codedX / 4);
        const sourceMapY = Math.floor(codedY / 4);
        const sourceMapWidth = source.width / 4;
        const sourceMapHeight = source.height / 4;
        if (
          sourceMapX < 0 ||
          sourceMapY < 0 ||
          sourceMapX >= sourceMapWidth ||
          sourceMapY >= sourceMapHeight
        )
          throw new Error('expected cropped tili motion map exceeds source tile');
        outputMap[row * outputMapWidth + column] =
          sourceMap[sourceMapY * sourceMapWidth + sourceMapX];
      }
    }
    Object.assign(motionMaps, { [field]: outputMap });
  }
  return {
    ...source,
    ...motionMaps,
    y: copy(source.y, source.width, source.height, outputWidth, outputHeight, 1, 1),
    cb: copy(
      source.cb,
      source.width / subWidth,
      source.height / subHeight,
      outputWidth / subWidth,
      outputHeight / subHeight,
      subWidth,
      subHeight,
    ),
    cr: copy(
      source.cr,
      source.width / subWidth,
      source.height / subHeight,
      outputWidth / subWidth,
      outputHeight / subHeight,
      subWidth,
      subHeight,
    ),
    width: outputWidth,
    height: outputHeight,
  };
}

it('crops tili pred references and their motion maps to the tile origin', () => {
  const reference = {
    y: Uint8Array.from({ length: 64 }, (_, index) => index),
    cb: Uint8Array.from({ length: 16 }, (_, index) => index),
    cr: Uint8Array.from({ length: 16 }, (_, index) => 100 + index),
    width: 8,
    height: 8,
    chromaFormatIdc: 1,
    hasExternalInterMotion: true,
    interMap: Uint8Array.from([0, 1, 2, 3]),
    motionXQpel: Int32Array.from([10, 11, 12, 13]),
    motionYQpel: Int32Array.from([20, 21, 22, 23]),
    motionRefPoc: Float64Array.from([30, 31, 32, 33]),
    pictureOrderCntLsb: 7,
    pictureOrderCnt: 23,
    temporalId: 0,
  };

  const tile = cropReferencePlanesForTile(reference, 4, 4, 4, 4);

  expect([tile.width, tile.height]).toEqual([4, 4]);
  expect(tile.y).toEqual(
    Uint8Array.from([36, 37, 38, 39, 44, 45, 46, 47, 52, 53, 54, 55, 60, 61, 62, 63]),
  );
  expect(tile.cb).toEqual(Uint8Array.from([10, 11, 14, 15]));
  expect(tile.cr).toEqual(Uint8Array.from([110, 111, 114, 115]));
  expect(tile.interMap).toEqual(Uint8Array.from([3]));
  expect(tile.motionXQpel).toEqual(Int32Array.from([13]));
  expect(tile.motionYQpel).toEqual(Int32Array.from([23]));
  expect(tile.motionRefPoc).toEqual(Float64Array.from([33]));
  expect(tile).toMatchObject({
    pictureOrderCntLsb: 7,
    pictureOrderCnt: 23,
    temporalId: 0,
  });

  const shiftedTile = cropReferencePlanesForTile(reference, 2, 2, 4, 4);
  expect(shiftedTile.interMap).toEqual(Uint8Array.from([0]));
  expect(shiftedTile.motionXQpel).toEqual(Int32Array.from([10]));
  expect(shiftedTile.motionYQpel).toEqual(Int32Array.from([20]));
});

it('decodes a single-tile in-file tili P item against its HEIF pred reference', () => {
  const nals = splitAnnexB(fixture('rps-c-ericsson-5.bit'));
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official RPS_C stream is missing its SPS or PPS');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const pictures: Uint8Array[][] = [];
  let picture: Uint8Array[] = [];
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic && picture.length > 0) {
      pictures.push(picture);
      picture = [];
    }
    picture.push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }
  if (picture.length > 0) pictures.push(picture);
  expect(pictures.length).toBeGreaterThanOrEqual(2);

  const secondHeader = parseSliceHeader(pictures[1][0], sps, pps);
  expect(secondHeader.sliceType).toBe(SLICE_TYPE_P);
  expect(secondHeader.pictureOrderCntLsb).toBe(16);
  expect(secondHeader.numRefIdxL0ActiveMinus1).toBe(0);

  const parameterSets = nals
    .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
    .map((nal) => nal.data);
  const referenceStream = annexB([...parameterSets, ...pictures[0]]);
  const predictedStream = annexB(pictures[1]);
  const baseline = wrapHevcPredChain([referenceStream, predictedStream], [[], [1]], 416, 240, 8, 1);
  const baselineBoxes = parseISOBMFF(baseline);
  const hvcC = findBox(baselineBoxes, 'hvcC');
  if (!hvcC) throw new Error('baseline HEIF is missing hvcC');
  const referencePayload = getItemPayload(baseline, baselineBoxes, 1);
  const predictedPayload = getItemPayload(baseline, baselineBoxes, 2);
  if (!referencePayload || !predictedPayload)
    throw new Error('baseline HEIF is missing a coded item payload');

  const baselineInfo = getHeicInfo(baseline, baselineBoxes, 2);
  const expectedPlanes = decodeItemPlanes(baseline, baselineBoxes, baselineInfo, 2);
  const tiled = createOneTilePredImage(referencePayload, predictedPayload, hvcC.data);
  const tiledBoxes = parseISOBMFF(tiled);
  const tiledInfo = getHeicInfo(tiled, tiledBoxes);
  expect(tiledInfo.primaryItemType).toBe('tili');
  expect(tiledInfo.predReferenceItemIds).toEqual([1]);
  expect(tiledInfo.tiledImage).toMatchObject({
    rows: 1,
    columns: 1,
    tileWidth: 416,
    tileHeight: 240,
  });

  const actualPlanes = decodeItemPlanes(tiled, tiledBoxes, tiledInfo, tiledInfo.primaryItemId);
  expect(actualPlanes.y).toEqual(expectedPlanes.y);
  expect(actualPlanes.cb).toEqual(expectedPlanes.cb);
  expect(actualPlanes.cr).toEqual(expectedPlanes.cr);
  expect(actualPlanes.pictureOrderCnt).toBe(expectedPlanes.pictureOrderCnt);
  expect(actualPlanes.temporalId).toBe(expectedPlanes.temporalId);
  expect(actualPlanes.motionXQpel).toEqual(expectedPlanes.motionXQpel);
  expect(actualPlanes.motionYQpel).toEqual(expectedPlanes.motionYQpel);

  expect(decodeHeic(tiled).data).toEqual(decodeHeic(baseline).data);
  expect(decodeHDRSync(tiled).data).toEqual(decodeHDRSync(baseline).data);
});

it('uses rloc to select a shifted reference region for a predicted tili tile', () => {
  const nals = splitAnnexB(fixture('rps-c-ericsson-5.bit'));
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official RPS_C stream is missing its SPS or PPS');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const pictures: Uint8Array[][] = [];
  let picture: Uint8Array[] = [];
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic && picture.length > 0) {
      pictures.push(picture);
      picture = [];
    }
    picture.push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }
  if (picture.length > 0) pictures.push(picture);
  const parameterSets = nals
    .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
    .map((nal) => nal.data);
  const baseline = wrapHevcPredChain(
    [annexB([...parameterSets, ...pictures[0]]), annexB(pictures[1])],
    [[], [1]],
    416,
    240,
    8,
    1,
  );
  const baselineBoxes = parseISOBMFF(baseline);
  const hvcC = findBox(baselineBoxes, 'hvcC');
  if (!hvcC) throw new Error('RPS_C baseline is missing hvcC');
  const referencePlanes = decodeItemPlanes(
    baseline,
    baselineBoxes,
    getHeicInfo(baseline, baselineBoxes, 1),
    1,
  );
  const expectedPlanes = decodeItemPlanes(
    baseline,
    baselineBoxes,
    getHeicInfo(baseline, baselineBoxes, 2),
    2,
  );
  const shifted = createShiftedOneTilePredImage(
    getItemPayload(baseline, baselineBoxes, 1)!,
    getItemPayload(baseline, baselineBoxes, 2)!,
    hvcC.data,
    416,
    240,
    8,
  );
  const shiftedBoxes = parseISOBMFF(shifted);
  const shiftedInfo = getHeicInfo(shifted, shiftedBoxes, 2);
  expect(shiftedInfo.predReferenceItemIds).toEqual([1]);
  expect(shiftedInfo.relativeLocation).toEqual({
    horizontalOffset: 416,
    verticalOffset: 0,
    relatedItemId: 1,
  });

  // First exercise the public item-reference recursion with a valid two-tile
  // parent; both source tiles intentionally carry the official same picture.
  const decoded = decodeItemPlanes(shifted, shiftedBoxes, shiftedInfo, 2);
  expect(decoded.y).toEqual(expectedPlanes.y);
  expect(decoded.cb).toEqual(expectedPlanes.cb);
  expect(decoded.cr).toEqual(expectedPlanes.cr);

  // Make the left half adversarial while retaining the official POC 0 picture
  // in the right half. This forces the child tile to honor its rloc offset.
  const canvasY = new Uint8Array(832 * 240).fill(0xff);
  const canvasCb = new Uint8Array(416 * 120).fill(0xff);
  const canvasCr = new Uint8Array(416 * 120).fill(0xff);
  for (let row = 0; row < 240; row++)
    canvasY.set(referencePlanes.y.subarray(row * 416, (row + 1) * 416), row * 832 + 416);
  for (let row = 0; row < 120; row++) {
    canvasCb.set(referencePlanes.cb.subarray(row * 208, (row + 1) * 208), row * 416 + 208);
    canvasCr.set(referencePlanes.cr.subarray(row * 208, (row + 1) * 208), row * 416 + 208);
  }
  const offsetReference: Planes = {
    ...referencePlanes,
    width: 832,
    y: canvasY,
    cb: canvasCb,
    cr: canvasCr,
  };
  const motionMapFields = [
    'interMap',
    'motionIsExternal',
    'motionPredFlags',
    'motionRefIdxL0',
    'motionXQpel',
    'motionYQpel',
    'motionRefPoc',
    'motionRefLongTerm',
    'motionRefLayerId',
    'motionXQpelL1',
    'motionYQpelL1',
    'motionRefIdxL1',
    'motionRefPocL1',
    'motionRefLongTermL1',
  ] as const;
  for (const field of motionMapFields) {
    const source = referencePlanes[field];
    if (!source) continue;
    Object.assign(offsetReference, {
      [field]: placeMotionMapOnRight(source, 104, 60, 208, 104),
    });
  }
  const shiftedInfoPlanes = stitchTiledImage(
    shifted,
    shiftedBoxes,
    shiftedInfo,
    shiftedInfo.tiledImage!,
    undefined,
    undefined,
    [offsetReference],
  );
  expect(shiftedInfoPlanes.y).toEqual(expectedPlanes.y);
  expect(shiftedInfoPlanes.cb).toEqual(expectedPlanes.cb);
  expect(shiftedInfoPlanes.cr).toEqual(expectedPlanes.cr);

  // Chroma-aligned rloc offsets need not be aligned to the 4x4 motion-map
  // grid. The temporal MVP positions are 16-luma aligned, so offset 418
  // selects the same 4x4 cells as floor(418 / 4) plus the local map position.
  const nonAlignedOffset = 418;
  const shiftedByTwo = createShiftedOneTilePredImage(
    getItemPayload(baseline, baselineBoxes, 1)!,
    getItemPayload(baseline, baselineBoxes, 2)!,
    hvcC.data,
    416,
    240,
    8,
    nonAlignedOffset,
    3,
  );
  const nonAlignedReference: Planes = {
    ...referencePlanes,
    width: 1248,
    y: new Uint8Array(1248 * 240).fill(0xff),
    cb: new Uint8Array(624 * 120).fill(0xff),
    cr: new Uint8Array(624 * 120).fill(0xff),
  };
  for (let row = 0; row < 240; row++)
    nonAlignedReference.y.set(
      referencePlanes.y.subarray(row * 416, (row + 1) * 416),
      row * 1248 + nonAlignedOffset,
    );
  for (let row = 0; row < 120; row++) {
    nonAlignedReference.cb.set(
      referencePlanes.cb.subarray(row * 208, (row + 1) * 208),
      row * 624 + nonAlignedOffset / 2,
    );
    nonAlignedReference.cr.set(
      referencePlanes.cr.subarray(row * 208, (row + 1) * 208),
      row * 624 + nonAlignedOffset / 2,
    );
  }
  for (const field of motionMapFields) {
    const source = referencePlanes[field];
    if (!source) continue;
    Object.assign(nonAlignedReference, {
      [field]: placeMotionMapOnRight(source, 104, 60, 312, Math.floor(nonAlignedOffset / 4)),
    });
  }
  const shiftedByTwoBoxes = parseISOBMFF(shiftedByTwo);
  const shiftedByTwoInfo = getHeicInfo(shiftedByTwo, shiftedByTwoBoxes, 2);
  expect(shiftedByTwoInfo.relativeLocation?.horizontalOffset).toBe(nonAlignedOffset);
  const shiftedByTwoPlanes = stitchTiledImage(
    shiftedByTwo,
    shiftedByTwoBoxes,
    shiftedByTwoInfo,
    shiftedByTwoInfo.tiledImage!,
    undefined,
    undefined,
    [nonAlignedReference],
  );
  expect(shiftedByTwoPlanes.y).toEqual(expectedPlanes.y);
  expect(shiftedByTwoPlanes.cb).toEqual(expectedPlanes.cb);
  expect(shiftedByTwoPlanes.cr).toEqual(expectedPlanes.cr);

  const shiftedExternal = createShiftedExternalOneTilePredImage(
    getItemPayload(baseline, baselineBoxes, 1)!,
    makeExternalTileDataReference(1, 2100),
    hvcC.data,
    416,
    240,
    8,
  );
  const shiftedExternalBoxes = parseISOBMFF(shiftedExternal);
  const shiftedExternalInfo = getHeicInfo(shiftedExternal, shiftedExternalBoxes, 2);
  const externalTileReference = shiftedExternalInfo.tiledImage!.dataReference;
  const externalTileData = {
    [buildTiledTileUrl(externalTileReference, 0)]: baseline,
  };
  const shiftedExternalPlanes = stitchTiledImage(
    shiftedExternal,
    shiftedExternalBoxes,
    shiftedExternalInfo,
    shiftedExternalInfo.tiledImage!,
    externalTileData,
    undefined,
    [offsetReference],
  );
  expect(shiftedExternalPlanes.y).toEqual(expectedPlanes.y);
  expect(shiftedExternalPlanes.cb).toEqual(expectedPlanes.cb);
  expect(shiftedExternalPlanes.cr).toEqual(expectedPlanes.cr);

  const chromaMisaligned = createShiftedOneTilePredImage(
    getItemPayload(baseline, baselineBoxes, 1)!,
    getItemPayload(baseline, baselineBoxes, 2)!,
    hvcC.data,
    416,
    240,
    8,
    415,
  );
  const chromaMisalignedBoxes = parseISOBMFF(chromaMisaligned);
  const chromaMisalignedInfo = getHeicInfo(chromaMisaligned, chromaMisalignedBoxes, 2);
  expect(() =>
    stitchTiledImage(
      chromaMisaligned,
      chromaMisalignedBoxes,
      chromaMisalignedInfo,
      chromaMisalignedInfo.tiledImage!,
      undefined,
      undefined,
      [offsetReference],
    ),
  ).toThrow('not aligned to the chroma sample grid');
});

it('decodes a conformance-window cropped inter-coded in-file tili tile', async () => {
  const chain = makeConformanceWindowPredChain();
  const baselineInfo = getHeicInfo(chain.baseline, chain.boxes, 2);
  const referenceRaw = decodeItemPlanes(chain.baseline, chain.boxes, baselineInfo, 1);
  const expectedRaw = decodeItemPlanes(chain.baseline, chain.boxes, baselineInfo, 2);
  const expectedVisible = cropPlanes(expectedRaw, 2, 2, 412, 236);
  const tiled = createOneTilePredImage(
    chain.referencePayload,
    chain.predictedPayload,
    chain.hvcC,
    412,
    236,
  );
  const tiledBoxes = parseISOBMFF(tiled);
  const tiledInfo = getHeicInfo(tiled, tiledBoxes);
  expect(tiledInfo.tiledImage).toMatchObject({
    rows: 1,
    columns: 1,
    tileWidth: 412,
    tileHeight: 236,
  });
  expect([referenceRaw.width, referenceRaw.height]).toEqual([416, 240]);

  const actual = decodeItemPlanes(tiled, tiledBoxes, tiledInfo, tiledInfo.primaryItemId);
  expect([actual.width, actual.height]).toEqual([412, 236]);
  expect(actual.y).toEqual(expectedVisible.y);
  expect(actual.cb).toEqual(expectedVisible.cb);
  expect(actual.cr).toEqual(expectedVisible.cr);
  expect(actual.pictureOrderCnt).toBe(expectedRaw.pictureOrderCnt);
  expect(actual.pictureOrderCntLsb).toBe(expectedRaw.pictureOrderCntLsb);
  expect(actual.temporalId).toBe(expectedRaw.temporalId);
  if (!tiledInfo.hvcC) throw new Error('cropped tili item is missing its HEVC configuration');
  expect(() =>
    decodeHevcPayload(
      chain.predictedPayload,
      tiledInfo.hvcC!,
      [actual],
      'cropped tili reference regression',
    ),
  ).toThrow(/does not cover the coded picture dimensions/);
  expect([md5(actual.y), md5(actual.cb), md5(actual.cr)]).toEqual([
    '0dd05fb3395f7002bc3b389334639edd',
    'f187dbd0639cfc59b43c09b89a1fd15e',
    '74e3a2806dcb3931e18e48751a26882a',
  ]);
  expect(decodeHeic(tiled).data).toEqual(decodeHeic(chain.baseline).data);
  expect(decodeHDRSync(tiled).data).toEqual(decodeHDRSync(chain.baseline).data);
  expect((await decode(tiled, { execution: 'main' })).data).toEqual(
    (await decode(chain.baseline, { execution: 'main' })).data,
  );
  expect((await decodeHDR(tiled, { execution: 'main' })).data).toEqual(
    (await decodeHDR(chain.baseline, { execution: 'main' })).data,
  );
});

it('decodes a conformance-window cropped inter-coded external tili tile', async () => {
  const chain = makeConformanceWindowPredChain();
  const baselineInfo = getHeicInfo(chain.baseline, chain.boxes, 2);
  const expectedRaw = decodeItemPlanes(chain.baseline, chain.boxes, baselineInfo, 2);
  const expectedVisible = cropPlanes(expectedRaw, 2, 2, 412, 236);
  const externalReference = makeExternalTileDataReference(1, 1);
  const tiled = createExternalOneTilePredImage(
    chain.referencePayload,
    externalReference,
    412,
    236,
    chain.hvcC,
  );
  const tiledBoxes = parseISOBMFF(tiled);
  const tiledInfo = getHeicInfo(tiled, tiledBoxes);
  const tileUrl = buildTiledTileUrl(tiledInfo.tiledImage!.dataReference, 0);
  const externalTileData = { [tileUrl]: chain.baseline };
  const tiledPlanes = decodeItemPlanes(tiled, tiledBoxes, tiledInfo, tiledInfo.primaryItemId, {
    externalTileData,
  });
  expect([tiledPlanes.width, tiledPlanes.height]).toEqual([412, 236]);
  expect(tiledPlanes.y).toEqual(expectedVisible.y);
  expect(tiledPlanes.cb).toEqual(expectedVisible.cb);
  expect(tiledPlanes.cr).toEqual(expectedVisible.cr);
  expect(tiledPlanes.pictureOrderCnt).toBe(expectedRaw.pictureOrderCnt);
  expect([md5(tiledPlanes.y), md5(tiledPlanes.cb), md5(tiledPlanes.cr)]).toEqual([
    '0dd05fb3395f7002bc3b389334639edd',
    'f187dbd0639cfc59b43c09b89a1fd15e',
    '74e3a2806dcb3931e18e48751a26882a',
  ]);
  expect(decodeHeic(tiled, { externalTileData }).data).toEqual(decodeHeic(chain.baseline).data);
  expect(decodeHDRSync(tiled, { externalTileData }).data).toEqual(
    decodeHDRSync(chain.baseline).data,
  );
  expect((await decode(tiled, { execution: 'main', externalTileData })).data).toEqual(
    (await decode(chain.baseline, { execution: 'main' })).data,
  );
  expect((await decodeHDR(tiled, { execution: 'main', externalTileData })).data).toEqual(
    (await decodeHDR(chain.baseline, { execution: 'main' })).data,
  );
});

it('decodes conformance-window cropped P references across in-file tili tiles', () => {
  const chain = makeConformanceWindowPredChain();
  const baselineInfo = getHeicInfo(chain.baseline, chain.boxes, 2);
  const expectedRaw = decodeItemPlanes(chain.baseline, chain.boxes, baselineInfo, 2);
  const expectedVisible = cropPlanes(expectedRaw, 2, 2, 412, 236);
  const tiled = createTwoTilePredImage(
    chain.referencePayload,
    chain.predictedPayload,
    chain.hvcC,
    412,
    236,
  );
  const tiledBoxes = parseISOBMFF(tiled);
  const tiledInfo = getHeicInfo(tiled, tiledBoxes);
  const actual = decodeItemPlanes(tiled, tiledBoxes, tiledInfo, tiledInfo.primaryItemId);

  expect([actual.width, actual.height]).toEqual([824, 236]);
  expect(actual.y).toEqual(repeatHorizontalRows(expectedVisible.y, 412, 236));
  expect(actual.cb).toEqual(repeatHorizontalRows(expectedVisible.cb, 206, 118));
  expect(actual.cr).toEqual(repeatHorizontalRows(expectedVisible.cr, 206, 118));
  expect(actual.pictureOrderCnt).toBe(expectedRaw.pictureOrderCnt);
  expect([md5(expectedVisible.y), md5(expectedVisible.cb), md5(expectedVisible.cr)]).toEqual([
    '0dd05fb3395f7002bc3b389334639edd',
    'f187dbd0639cfc59b43c09b89a1fd15e',
    '74e3a2806dcb3931e18e48751a26882a',
  ]);
  const expectedSdr = decodeHeic(chain.baseline).data;
  expect(decodeHeic(tiled).data).toEqual(repeatHorizontalRows(expectedSdr, 412 * 4, 236));
  const expectedHdr = decodeHDRSync(chain.baseline).data;
  expect(decodeHDRSync(tiled).data).toEqual(repeatHorizontalRows(expectedHdr, 412 * 4, 236));
});

it('decodes conformance-window cropped P references across external tili tiles', async () => {
  const chain = makeConformanceWindowPredChain();
  const baselineInfo = getHeicInfo(chain.baseline, chain.boxes, 2);
  const expectedRaw = decodeItemPlanes(chain.baseline, chain.boxes, baselineInfo, 2);
  const expectedVisible = cropPlanes(expectedRaw, 2, 2, 412, 236);
  const externalReference = makeExternalTileDataReference(2, 3100);
  const tiled = createExternalTwoTilePredImage(
    chain.referencePayload,
    chain.hvcC,
    externalReference,
    412,
    236,
  );
  const tiledBoxes = parseISOBMFF(tiled);
  const tiledInfo = getHeicInfo(tiled, tiledBoxes);
  const tileDataReference = tiledInfo.tiledImage!.dataReference;
  const externalTileData = {
    [buildTiledTileUrl(tileDataReference, 0)]: chain.baseline,
    [buildTiledTileUrl(tileDataReference, 1)]: chain.baseline,
  };
  const actual = decodeItemPlanes(tiled, tiledBoxes, tiledInfo, tiledInfo.primaryItemId, {
    externalTileData,
  });

  expect([actual.width, actual.height]).toEqual([824, 236]);
  expect(actual.y).toEqual(repeatHorizontalRows(expectedVisible.y, 412, 236));
  expect(actual.cb).toEqual(repeatHorizontalRows(expectedVisible.cb, 206, 118));
  expect(actual.cr).toEqual(repeatHorizontalRows(expectedVisible.cr, 206, 118));
  expect(actual.pictureOrderCnt).toBe(expectedRaw.pictureOrderCnt);
  const expectedSdr = decodeHeic(chain.baseline).data;
  const actualSdr = decodeHeic(tiled, { externalTileData }).data;
  expect(actualSdr).toEqual(repeatHorizontalRows(expectedSdr, 412 * 4, 236));
  const expectedHdr = decodeHDRSync(chain.baseline).data;
  const actualHdr = decodeHDRSync(tiled, { externalTileData }).data;
  expect(actualHdr).toEqual(repeatHorizontalRows(expectedHdr, 412 * 4, 236));
  expect((await decode(tiled, { execution: 'main', externalTileData })).data).toEqual(actualSdr);
  expect((await decodeHDR(tiled, { execution: 'main', externalTileData })).data).toEqual(actualHdr);
});

it('resolves shifted conformance-cropped references across coded in-file tili tiles', () => {
  const chain = makeConformanceWindowPredChain();
  const boxes = parseISOBMFF(chain.baseline);
  const info = getHeicInfo(chain.baseline, boxes, 1);
  const reference = decodeItemPlanes(chain.baseline, boxes, info, 1);
  const shiftedReference = expectedCroppedTiliReference(reference, 2, 1, 0, -2, 416, 240);
  if (!info.hvcC) throw new Error('cropped tili expectation is missing HEVC configuration');
  const expectedRaw = decodeHevcPayload(
    chain.predictedPayload,
    info.hvcC,
    [shiftedReference],
    'shifted cropped tili reference expectation',
  );
  const tiled = createShiftedOneTilePredImage(
    chain.referencePayload,
    chain.predictedPayload,
    chain.hvcC,
    412,
    236,
    8,
    2,
  );
  const tiledBoxes = parseISOBMFF(tiled);
  const tiledInfo = getHeicInfo(tiled, tiledBoxes, 2);
  const actual = decodeItemPlanes(tiled, tiledBoxes, tiledInfo, 2);
  const expected = cropPlanes(expectedRaw, 2, 2, 412, 236);

  expect([actual.width, actual.height]).toEqual([412, 236]);
  expect(actual.y).toEqual(expected.y);
  expect(actual.cb).toEqual(expected.cb);
  expect(actual.cr).toEqual(expected.cr);
});

it('does not require coded samples from an unrelated empty parent tile', () => {
  const chain = makeConformanceWindowPredChain();
  const tiled = createShiftedOneTilePredImage(
    chain.referencePayload,
    chain.predictedPayload,
    chain.hvcC,
    412,
    236,
    8,
    2,
    3,
    [2],
  );
  const boxes = parseISOBMFF(tiled);
  const info = getHeicInfo(tiled, boxes, 2);
  const actual = decodeItemPlanes(tiled, boxes, info, 2);
  const baselineBoxes = parseISOBMFF(chain.baseline);
  const baselineInfo = getHeicInfo(chain.baseline, baselineBoxes, 1);
  const reference = decodeItemPlanes(chain.baseline, baselineBoxes, baselineInfo, 1);
  const shiftedReference = expectedCroppedTiliReference(reference, 3, 1, 0, -2, 416, 240);
  if (!baselineInfo.hvcC) throw new Error('cropped tili expectation is missing HEVC configuration');
  const expectedRaw = decodeHevcPayload(
    chain.predictedPayload,
    baselineInfo.hvcC,
    [shiftedReference],
    'cropped tili reference with unrelated empty parent tile',
  );
  const expected = cropPlanes(expectedRaw, 2, 2, 412, 236);

  expect(actual.y).toEqual(expected.y);
  expect(actual.cb).toEqual(expected.cb);
  expect(actual.cr).toEqual(expected.cr);
});

it('maps cropped parent motion metadata across 2D seams at non-4x4 offsets', () => {
  const chain = makeConformanceWindowPredChain();
  const baselineBoxes = parseISOBMFF(chain.baseline);
  const baselineInfo = getHeicInfo(chain.baseline, baselineBoxes, 1);
  const poc2 = decodeItemPlanes(chain.baseline, baselineBoxes, baselineInfo, 2);
  if (!poc2.motionXQpel || !poc2.motionRefPoc)
    throw new Error('official CONFWIN_A POC 2 did not produce decoded motion maps');
  const poc4Stream = annexB(chain.pictures[3]);
  const threePictureChain = wrapHevcPredChain(
    [chain.referenceStream, annexB(chain.pictures[1]), poc4Stream],
    [[], [1], [2]],
    412,
    236,
    8,
    1,
  );
  const threePictureBoxes = parseISOBMFF(threePictureChain);
  const poc4Payload = getItemPayload(threePictureChain, threePictureBoxes, 3);
  if (!poc4Payload || !baselineInfo.hvcC)
    throw new Error('official CONFWIN_A POC 4 chain is missing coded data');
  const shiftedReference = expectedCroppedTiliReference(poc2, 2, 2, 2, 2, 416, 240);
  const expectedRaw = decodeHevcPayload(
    poc4Payload,
    baselineInfo.hvcC,
    [shiftedReference],
    'cropped tili POC 4 motion-map expectation',
  );
  const tiled = createNestedShiftedConformancePredImage(
    chain.referencePayload,
    chain.predictedPayload,
    poc4Payload,
    chain.hvcC,
    4,
    4,
  );
  const boxes = parseISOBMFF(tiled);
  const info = getHeicInfo(tiled, boxes, 3);
  const actual = decodeItemPlanes(tiled, boxes, info, 3);
  const expected = cropPlanes(expectedRaw, 2, 2, 412, 236);

  expect(actual.pictureOrderCnt).toBe(expectedRaw.pictureOrderCnt);
  expect(actual.y).toEqual(expected.y);
  expect(actual.cb).toEqual(expected.cb);
  expect(actual.cr).toEqual(expected.cr);
});

it('resolves shifted conformance-cropped references across coded external tili tiles', () => {
  const chain = makeConformanceWindowPredChain();
  const baselineBoxes = parseISOBMFF(chain.baseline);
  const baselineInfo = getHeicInfo(chain.baseline, baselineBoxes, 1);
  const reference = decodeItemPlanes(chain.baseline, baselineBoxes, baselineInfo, 1);
  const shiftedReference = expectedCroppedTiliReference(reference, 2, 1, 0, -2, 416, 240);
  if (!baselineInfo.hvcC) throw new Error('cropped external tile is missing HEVC configuration');
  const expectedRaw = decodeHevcPayload(
    chain.predictedPayload,
    baselineInfo.hvcC,
    [shiftedReference],
    'shifted cropped external tili reference expectation',
  );
  const externalTile = buildHeif(
    [
      {
        id: 1,
        type: 'hvc1',
        data: chain.predictedPayload,
        properties: [
          full('ispe', 0, u32(412), u32(236)),
          full('pixi', 0, Buffer.from([3, 8, 8, 8])),
          box('hvcC', chain.hvcC),
        ],
      },
    ],
    1,
  );
  const externalReference = makeExternalTileDataReference(1, 1);
  const tiled = createShiftedExternalOneTilePredImage(
    chain.referencePayload,
    externalReference,
    chain.hvcC,
    412,
    236,
    8,
    2,
  );
  const boxes = parseISOBMFF(tiled);
  const info = getHeicInfo(tiled, boxes, 2);
  const externalTileData = {
    [buildTiledTileUrl(info.tiledImage!.dataReference, 0)]: externalTile,
  };
  const actual = decodeItemPlanes(tiled, boxes, info, 2, { externalTileData });
  const expected = cropPlanes(expectedRaw, 2, 2, 412, 236);

  expect([actual.width, actual.height]).toEqual([412, 236]);
  expect(actual.y).toEqual(expected.y);
  expect(actual.cb).toEqual(expected.cb);
  expect(actual.cr).toEqual(expected.cr);
});

it('decodes every in-file tili P tile against the matching region of its pred image', () => {
  const nals = splitAnnexB(fixture('rps-c-ericsson-5.bit'));
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official RPS_C stream is missing its SPS or PPS');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const pictures: Uint8Array[][] = [];
  let picture: Uint8Array[] = [];
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic && picture.length > 0) {
      pictures.push(picture);
      picture = [];
    }
    picture.push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }
  if (picture.length > 0) pictures.push(picture);
  expect(pictures.length).toBeGreaterThanOrEqual(2);

  const parameterSets = nals
    .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
    .map((nal) => nal.data);
  const referenceStream = annexB([...parameterSets, ...pictures[0]]);
  const predictedStream = annexB(pictures[1]);
  const baseline = wrapHevcPredChain([referenceStream, predictedStream], [[], [1]], 416, 240, 8, 1);
  const baselineBoxes = parseISOBMFF(baseline);
  const hvcC = findBox(baselineBoxes, 'hvcC');
  if (!hvcC) throw new Error('baseline HEIF is missing hvcC');
  const tiled = createTwoTilePredImage(
    getItemPayload(baseline, baselineBoxes, 1)!,
    getItemPayload(baseline, baselineBoxes, 2)!,
    hvcC.data,
  );
  const tiledBoxes = parseISOBMFF(tiled);
  const tiledInfo = getHeicInfo(tiled, tiledBoxes);
  expect(tiledInfo.primaryItemType).toBe('tili');
  expect(tiledInfo.predReferenceItemIds).toEqual([1]);
  expect(tiledInfo.tiledImage).toMatchObject({
    rows: 1,
    columns: 2,
    tileWidth: 416,
    tileHeight: 240,
  });

  const expectedPlanes = decodeItemPlanes(
    baseline,
    baselineBoxes,
    getHeicInfo(baseline, baselineBoxes, 2),
    2,
  );
  const actualPlanes = decodeItemPlanes(tiled, tiledBoxes, tiledInfo, tiledInfo.primaryItemId);
  expect([actualPlanes.width, actualPlanes.height]).toEqual([832, 240]);
  expect(actualPlanes.y).toEqual(repeatHorizontalRows(expectedPlanes.y, 416, 240));
  expect(actualPlanes.cb).toEqual(repeatHorizontalRows(expectedPlanes.cb, 208, 120));
  expect(actualPlanes.cr).toEqual(repeatHorizontalRows(expectedPlanes.cr, 208, 120));
  expect(actualPlanes.pictureOrderCnt).toBe(expectedPlanes.pictureOrderCnt);
  expect(actualPlanes.pictureOrderCntLsb).toBe(expectedPlanes.pictureOrderCntLsb);
  expect(actualPlanes.temporalId).toBe(expectedPlanes.temporalId);

  const expectedMotion = expectedPlanes.motionXQpel;
  expect(expectedMotion).toBeDefined();
  expect(actualPlanes.motionXQpel).toEqual(repeatHorizontalRows(expectedMotion!, 104, 60));
  expect(actualPlanes.motionYQpel).toEqual(
    repeatHorizontalRows(expectedPlanes.motionYQpel!, 104, 60),
  );
  expect(actualPlanes.interMap).toEqual(repeatHorizontalRows(expectedPlanes.interMap!, 104, 60));

  const expectedSdr = decodeHeic(baseline).data;
  const tiledSdr = decodeHeic(tiled);
  expect([tiledSdr.width, tiledSdr.height]).toEqual([832, 240]);
  expect(tiledSdr.data).toEqual(repeatHorizontalRows(expectedSdr, 416 * 4, 240));
  const expectedHdr = decodeHDRSync(baseline).data;
  expect(decodeHDRSync(tiled).data).toEqual(repeatHorizontalRows(expectedHdr, 416 * 4, 240));
});

it('decodes weighted B slices across in-file tili tiles', async () => {
  const nals = splitAnnexB(fixture('wp-b-toshiba-3.bit'));
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official WP_B stream is missing its SPS or PPS');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const pictures: Uint8Array[][] = [];
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic) pictures.push([]);
    if (pictures.length === 0) throw new Error('WP_B slice appeared before its first picture');
    pictures[pictures.length - 1].push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }
  expect(pictures.length).toBe(256);

  const bHeader = parseSliceHeader(pictures[1][0], sps, pps);
  expect(bHeader.sliceType).toBe(SLICE_TYPE_B);
  expect(bHeader.pictureOrderCntLsb).toBe(8);
  expect([bHeader.numRefIdxL0ActiveMinus1, bHeader.numRefIdxL1ActiveMinus1]).toEqual([0, 0]);
  expect(bHeader.weightedPrediction).toMatchObject({
    l0: [{ lumaWeight: 118 }],
    l1: [{ lumaWeight: 117 }],
  });

  const parameterSets = nals
    .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
    .map((nal) => nal.data);
  const referenceStream = annexB([...parameterSets, ...pictures[0]]);
  const bStream = annexB(pictures[1]);
  const baseline = wrapHevcPredChain([referenceStream, bStream], [[], [1]], 416, 240, 8, 1);
  const baselineBoxes = parseISOBMFF(baseline);
  const hvcC = findBox(baselineBoxes, 'hvcC');
  if (!hvcC) throw new Error('baseline HEIF is missing hvcC');
  const tiled = createTwoTilePredImage(
    getItemPayload(baseline, baselineBoxes, 1)!,
    getItemPayload(baseline, baselineBoxes, 2)!,
    hvcC.data,
  );
  const tiledBoxes = parseISOBMFF(tiled);
  const tiledInfo = getHeicInfo(tiled, tiledBoxes);
  expect(tiledInfo.primaryItemType).toBe('tili');
  expect(tiledInfo.predReferenceItemIds).toEqual([1]);

  const expectedPlanes = decodeItemPlanes(
    baseline,
    baselineBoxes,
    getHeicInfo(baseline, baselineBoxes, 2),
    2,
  );
  const actualPlanes = decodeItemPlanes(tiled, tiledBoxes, tiledInfo, tiledInfo.primaryItemId);
  expect([actualPlanes.width, actualPlanes.height]).toEqual([832, 240]);
  expect(actualPlanes.y).toEqual(repeatHorizontalRows(expectedPlanes.y, 416, 240));
  expect(actualPlanes.cb).toEqual(repeatHorizontalRows(expectedPlanes.cb, 208, 120));
  expect(actualPlanes.cr).toEqual(repeatHorizontalRows(expectedPlanes.cr, 208, 120));
  expect(actualPlanes.pictureOrderCnt).toBe(expectedPlanes.pictureOrderCnt);
  expect(actualPlanes.pictureOrderCntLsb).toBe(expectedPlanes.pictureOrderCntLsb);
  expect(actualPlanes.temporalId).toBe(expectedPlanes.temporalId);
  expect(actualPlanes.motionXQpel).toEqual(
    repeatHorizontalRows(expectedPlanes.motionXQpel!, 104, 60),
  );
  expect(actualPlanes.motionYQpel).toEqual(
    repeatHorizontalRows(expectedPlanes.motionYQpel!, 104, 60),
  );
  expect(actualPlanes.interMap).toEqual(repeatHorizontalRows(expectedPlanes.interMap!, 104, 60));

  const expectedSdr = decodeHeic(baseline).data;
  expect(decodeHeic(tiled).data).toEqual(repeatHorizontalRows(expectedSdr, 416 * 4, 240));
  const expectedHdr = decodeHDRSync(baseline).data;
  expect(decodeHDRSync(tiled).data).toEqual(repeatHorizontalRows(expectedHdr, 416 * 4, 240));
  const asyncSdr = await decode(tiled, { execution: 'main' });
  expect(asyncSdr.data).toEqual(decodeHeic(tiled).data);
  const asyncHdr = await decodeHDR(tiled, { execution: 'main' });
  expect(asyncHdr.data).toEqual(decodeHDRSync(tiled).data);
});

it('decodes weighted B slices across external tili tiles', async () => {
  const nals = splitAnnexB(fixture('wp-b-toshiba-3.bit'));
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official WP_B stream is missing its SPS or PPS');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const pictures: Uint8Array[][] = [];
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic) pictures.push([]);
    if (pictures.length === 0) throw new Error('WP_B slice appeared before its first picture');
    pictures[pictures.length - 1].push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }
  expect(pictures.length).toBe(256);
  const bHeader = parseSliceHeader(pictures[1][0], sps, pps);
  expect(bHeader.sliceType).toBe(SLICE_TYPE_B);
  expect(bHeader.pictureOrderCntLsb).toBe(8);

  const parameterSets = nals
    .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
    .map((nal) => nal.data);
  const referenceStream = annexB([...parameterSets, ...pictures[0]]);
  const bStream = annexB(pictures[1]);
  const baseline = wrapHevcPredChain([referenceStream, bStream], [[], [1]], 416, 240, 8, 1);
  const baselineBoxes = parseISOBMFF(baseline);
  const hvcC = findBox(baselineBoxes, 'hvcC');
  if (!hvcC) throw new Error('baseline HEIF is missing hvcC');
  const tiled = createExternalTwoTilePredImage(
    getItemPayload(baseline, baselineBoxes, 1)!,
    hvcC.data,
    makeExternalTileDataReference(2, 2200),
  );
  const tiledBoxes = parseISOBMFF(tiled);
  const tiledInfo = getHeicInfo(tiled, tiledBoxes);
  expect(tiledInfo.primaryItemType).toBe('tili');
  expect(tiledInfo.predReferenceItemIds).toEqual([1]);
  const tileDataReference = tiledInfo.tiledImage!.dataReference;
  const externalTileData = {
    [buildTiledTileUrl(tileDataReference, 0)]: baseline,
    [buildTiledTileUrl(tileDataReference, 1)]: baseline,
  };

  const expectedPlanes = decodeItemPlanes(
    baseline,
    baselineBoxes,
    getHeicInfo(baseline, baselineBoxes, 2),
    2,
  );
  const actualPlanes = decodeItemPlanes(tiled, tiledBoxes, tiledInfo, tiledInfo.primaryItemId, {
    externalTileData,
  });
  expect([actualPlanes.width, actualPlanes.height]).toEqual([832, 240]);
  expect(actualPlanes.y).toEqual(repeatHorizontalRows(expectedPlanes.y, 416, 240));
  expect(actualPlanes.cb).toEqual(repeatHorizontalRows(expectedPlanes.cb, 208, 120));
  expect(actualPlanes.cr).toEqual(repeatHorizontalRows(expectedPlanes.cr, 208, 120));
  expect(actualPlanes.pictureOrderCnt).toBe(expectedPlanes.pictureOrderCnt);
  expect(actualPlanes.pictureOrderCntLsb).toBe(expectedPlanes.pictureOrderCntLsb);
  expect(actualPlanes.temporalId).toBe(expectedPlanes.temporalId);
  expect(actualPlanes.motionXQpel).toEqual(
    repeatHorizontalRows(expectedPlanes.motionXQpel!, 104, 60),
  );
  expect(actualPlanes.motionYQpel).toEqual(
    repeatHorizontalRows(expectedPlanes.motionYQpel!, 104, 60),
  );
  expect(actualPlanes.interMap).toEqual(repeatHorizontalRows(expectedPlanes.interMap!, 104, 60));

  const expectedSdr = decodeHeic(baseline).data;
  const tiledSdr = decodeHeic(tiled, { externalTileData });
  expect(tiledSdr.data).toEqual(repeatHorizontalRows(expectedSdr, 416 * 4, 240));
  const expectedHdr = decodeHDRSync(baseline).data;
  const tiledHdr = decodeHDRSync(tiled, { externalTileData });
  expect(tiledHdr.data).toEqual(repeatHorizontalRows(expectedHdr, 416 * 4, 240));
  expect((await decode(tiled, { execution: 'main', externalTileData })).data).toEqual(
    tiledSdr.data,
  );
  expect((await decodeHDR(tiled, { execution: 'main', externalTileData })).data).toEqual(
    tiledHdr.data,
  );
});

it('decodes official 10-bit 4:2:2 B pictures across in-file and external tili tiles', async () => {
  const nals = splitAnnexB(fixture('main-422-10-a-rext-sony-2.bit'));
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official Main 4:2:2 stream is missing SPS/PPS');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  expect([sps.chromaFormatIdc, sps.bitDepthLuma, sps.bitDepthChroma]).toEqual([2, 10, 10]);

  const pictures: Uint8Array[][] = [];
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic) pictures.push([]);
    if (pictures.length === 0)
      throw new Error('Main 4:2:2 slice appeared before its first picture');
    pictures[pictures.length - 1]!.push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }
  expect(pictures).toHaveLength(9);

  const bHeader = parseSliceHeader(pictures[1]![0]!, sps, pps);
  expect(bHeader.sliceType).toBe(SLICE_TYPE_B);
  expect(bHeader.pictureOrderCntLsb).toBe(8);
  expect([bHeader.numRefIdxL0ActiveMinus1, bHeader.numRefIdxL1ActiveMinus1]).toEqual([0, 0]);

  const parameterSets = nals
    .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
    .map((nal) => nal.data);
  const baseline = wrapHevcPredChain(
    [annexB([...parameterSets, ...pictures[0]!]), annexB(pictures[1]!)],
    [[], [1]],
    sps.picWidthInLumaSamples,
    sps.picHeightInLumaSamples,
    sps.bitDepthLuma,
    sps.chromaFormatIdc,
  );
  const baselineBoxes = parseISOBMFF(baseline);
  const hvcC = findBox(baselineBoxes, 'hvcC');
  if (!hvcC) throw new Error('Main 4:2:2 HEIF chain is missing hvcC');
  const referencePayload = getItemPayload(baseline, baselineBoxes, 1),
    predictedPayload = getItemPayload(baseline, baselineBoxes, 2);
  if (!referencePayload || !predictedPayload)
    throw new Error('Main 4:2:2 HEIF chain is missing a coded picture');

  const tileWidth = sps.picWidthInLumaSamples,
    tileHeight = sps.picHeightInLumaSamples,
    tiled = createTwoTilePredImage(
      referencePayload,
      predictedPayload,
      hvcC.data,
      tileWidth,
      tileHeight,
      sps.bitDepthLuma,
    ),
    tiledBoxes = parseISOBMFF(tiled),
    tiledInfo = getHeicInfo(tiled, tiledBoxes),
    expectedPlanes = decodeItemPlanes(
      baseline,
      baselineBoxes,
      getHeicInfo(baseline, baselineBoxes, 2),
      2,
    ),
    actualPlanes = decodeItemPlanes(tiled, tiledBoxes, tiledInfo, tiledInfo.primaryItemId);

  expect(tiledInfo.predReferenceItemIds).toEqual([1]);
  expect([actualPlanes.width, actualPlanes.height]).toEqual([tileWidth * 2, tileHeight]);
  expect(actualPlanes.y).toEqual(repeatHorizontalRows(expectedPlanes.y, tileWidth, tileHeight));
  expect(actualPlanes.cb).toEqual(
    repeatHorizontalRows(expectedPlanes.cb, tileWidth / 2, tileHeight),
  );
  expect(actualPlanes.cr).toEqual(
    repeatHorizontalRows(expectedPlanes.cr, tileWidth / 2, tileHeight),
  );
  expect(actualPlanes.pictureOrderCnt).toBe(expectedPlanes.pictureOrderCnt);

  const expectedRgba = decodeHeic(baseline),
    actualRgba = decodeHeic(tiled);
  expect([actualRgba.width, actualRgba.height, actualRgba.bitDepth]).toEqual([
    tileWidth * 2,
    tileHeight,
    10,
  ]);
  expect(actualRgba.data).toEqual(
    repeatHorizontalRows(expectedRgba.data, tileWidth * 4, tileHeight),
  );

  const externalTiled = createExternalTwoTilePredImage(
    referencePayload,
    hvcC.data,
    makeExternalTileDataReference(2, 2600),
    tileWidth,
    tileHeight,
    sps.bitDepthLuma,
  );
  const externalBoxes = parseISOBMFF(externalTiled);
  const externalInfo = getHeicInfo(externalTiled, externalBoxes);
  expect(externalInfo.predReferenceItemIds).toEqual([1]);
  const tileDataReference = externalInfo.tiledImage!.dataReference;
  const externalTileData = {
    [buildTiledTileUrl(tileDataReference, 0)]: baseline,
    [buildTiledTileUrl(tileDataReference, 1)]: baseline,
  };
  const externalPlanes = decodeItemPlanes(
    externalTiled,
    externalBoxes,
    externalInfo,
    externalInfo.primaryItemId,
    { externalTileData },
  );
  expect([externalPlanes.width, externalPlanes.height]).toEqual([tileWidth * 2, tileHeight]);
  expect(externalPlanes.y).toEqual(repeatHorizontalRows(expectedPlanes.y, tileWidth, tileHeight));
  expect(externalPlanes.cb).toEqual(
    repeatHorizontalRows(expectedPlanes.cb, tileWidth / 2, tileHeight),
  );
  expect(externalPlanes.cr).toEqual(
    repeatHorizontalRows(expectedPlanes.cr, tileWidth / 2, tileHeight),
  );
  expect(externalPlanes.pictureOrderCnt).toBe(expectedPlanes.pictureOrderCnt);
  expect(decodeHeic(externalTiled, { externalTileData }).data).toEqual(
    repeatHorizontalRows(expectedRgba.data, tileWidth * 4, tileHeight),
  );
  const repeatedRgba = repeatHorizontalRows(expectedRgba.data, tileWidth * 4, tileHeight);
  expect((await decode(tiled, { execution: 'main' })).data).toEqual(repeatedRgba);
  expect((await decode(externalTiled, { execution: 'main', externalTileData })).data).toEqual(
    repeatedRgba,
  );

  const poc4Baseline = wrapHevcPredChain(
    [annexB([...parameterSets, ...pictures[0]!]), annexB(pictures[1]!), annexB(pictures[2]!)],
    [[], [1], [1, 2]],
    tileWidth,
    tileHeight,
    sps.bitDepthLuma,
    sps.chromaFormatIdc,
  );
  const poc4Boxes = parseISOBMFF(poc4Baseline);
  const poc4HvcC = findBox(poc4Boxes, 'hvcC');
  if (!poc4HvcC) throw new Error('POC 4 Main 4:2:2 HEIF chain is missing hvcC');
  const poc4Expected = decodeItemPlanes(
    poc4Baseline,
    poc4Boxes,
    getHeicInfo(poc4Baseline, poc4Boxes, 3),
    3,
  );
  expect(poc4Expected.pictureOrderCnt).toBe(4);
  const poc4ReferencePayload = getItemPayload(poc4Baseline, poc4Boxes, 1);
  const poc8ReferencePayload = getItemPayload(poc4Baseline, poc4Boxes, 2);
  const poc4PredictedPayload = getItemPayload(poc4Baseline, poc4Boxes, 3);
  if (!poc4ReferencePayload || !poc8ReferencePayload || !poc4PredictedPayload)
    throw new Error('POC 4 Main 4:2:2 HEIF chain is missing a coded picture');

  const poc4Tiled = createTwoTileMultiRefPredImage(
    poc4ReferencePayload,
    poc8ReferencePayload,
    poc4PredictedPayload,
    poc4HvcC.data,
    tileWidth,
    tileHeight,
    sps.bitDepthLuma,
  );
  const poc4TiledBoxes = parseISOBMFF(poc4Tiled);
  const poc4TiledInfo = getHeicInfo(poc4Tiled, poc4TiledBoxes);
  expect(poc4TiledInfo.predReferenceItemIds).toEqual([1, 2]);
  const poc4TiledPlanes = decodeItemPlanes(
    poc4Tiled,
    poc4TiledBoxes,
    poc4TiledInfo,
    poc4TiledInfo.primaryItemId,
  );
  expect(poc4TiledPlanes.pictureOrderCnt).toBe(4);
  expect(poc4TiledPlanes.y).toEqual(repeatHorizontalRows(poc4Expected.y, tileWidth, tileHeight));
  expect(poc4TiledPlanes.cb).toEqual(
    repeatHorizontalRows(poc4Expected.cb, tileWidth / 2, tileHeight),
  );
  expect(poc4TiledPlanes.cr).toEqual(
    repeatHorizontalRows(poc4Expected.cr, tileWidth / 2, tileHeight),
  );
  const poc4Rgba = decodeHeic(poc4Baseline).data;
  expect(decodeHeic(poc4Tiled).data).toEqual(
    repeatHorizontalRows(poc4Rgba, tileWidth * 4, tileHeight),
  );

  const poc4ExternalTiled = createExternalTwoTileMultiRefPredImage(
    poc4ReferencePayload,
    poc8ReferencePayload,
    poc4HvcC.data,
    makeExternalTileDataReference(2, 2700),
    tileWidth,
    tileHeight,
    sps.bitDepthLuma,
  );
  const poc4ExternalBoxes = parseISOBMFF(poc4ExternalTiled);
  const poc4ExternalInfo = getHeicInfo(poc4ExternalTiled, poc4ExternalBoxes);
  expect(poc4ExternalInfo.predReferenceItemIds).toEqual([1, 2]);
  const poc4ExternalTileReference = poc4ExternalInfo.tiledImage!.dataReference;
  const poc4ExternalTileData = {
    [buildTiledTileUrl(poc4ExternalTileReference, 0)]: poc4Baseline,
    [buildTiledTileUrl(poc4ExternalTileReference, 1)]: poc4Baseline,
  };
  const poc4ExternalPlanes = decodeItemPlanes(
    poc4ExternalTiled,
    poc4ExternalBoxes,
    poc4ExternalInfo,
    poc4ExternalInfo.primaryItemId,
    { externalTileData: poc4ExternalTileData },
  );
  expect(poc4ExternalPlanes.pictureOrderCnt).toBe(4);
  expect(poc4ExternalPlanes.y).toEqual(repeatHorizontalRows(poc4Expected.y, tileWidth, tileHeight));
  expect(poc4ExternalPlanes.cb).toEqual(
    repeatHorizontalRows(poc4Expected.cb, tileWidth / 2, tileHeight),
  );
  expect(poc4ExternalPlanes.cr).toEqual(
    repeatHorizontalRows(poc4Expected.cr, tileWidth / 2, tileHeight),
  );
  expect(decodeHeic(poc4ExternalTiled, { externalTileData: poc4ExternalTileData }).data).toEqual(
    repeatHorizontalRows(poc4Rgba, tileWidth * 4, tileHeight),
  );

  const sequenceHeaders = pictures.map((picture) => parseSliceHeader(picture[0]!, sps, pps));
  let previousTid0Poc: number | null = null;
  const pictureOrderCounts = pictures.map((picture, index) => {
    const header = sequenceHeaders[index]!;
    const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
    if (((picture[0]![1] ?? 0) & 7) - 1 === 0) previousTid0Poc = poc;
    return poc;
  });
  expect(pictureOrderCounts).toEqual([0, 8, 4, 2, 1, 3, 6, 5, 7]);
  const indexByPoc = new Map(pictureOrderCounts.map((poc, index) => [poc, index]));
  const dependencies = sequenceHeaders.map((header, index) => {
    const dependencyPocs = new Set<number>();
    const rps = header.shortTermRefPicSet;
    if (rps) {
      for (const [deltas, usedByCurrPic] of [
        [rps.deltaPocS0, rps.usedByCurrPicS0],
        [rps.deltaPocS1, rps.usedByCurrPicS1],
      ] as const) {
        for (let referenceIndex = 0; referenceIndex < deltas.length; referenceIndex++) {
          if (usedByCurrPic[referenceIndex])
            dependencyPocs.add(pictureOrderCounts[index]! + deltas[referenceIndex]!);
        }
      }
    }
    const referenceIndexes = [...dependencyPocs].map((poc) => {
      const referenceIndex = indexByPoc.get(poc);
      if (referenceIndex === undefined || referenceIndex >= index)
        throw new Error(
          `Main 4:2:2 POC ${pictureOrderCounts[index]} has invalid reference POC ${poc}`,
        );
      return referenceIndex;
    });
    return referenceIndexes.sort((left, right) => left - right);
  });
  const sequenceStreams = pictures.map((picture, index) =>
    annexB([...(index === 0 ? parameterSets : []), ...picture]),
  );
  const sequenceBaseline = wrapHevcPredChain(
    sequenceStreams,
    dependencies.map((indexes) => indexes.map((index) => index + 1)),
    tileWidth,
    tileHeight,
    sps.bitDepthLuma,
    sps.chromaFormatIdc,
  );
  const sequenceBoxes = parseISOBMFF(sequenceBaseline);
  const sequenceInfo = getHeicInfo(sequenceBaseline, sequenceBoxes);
  expect(sequenceInfo.primaryItemId).toBe(pictures.length);
  const sequencePayloads = pictures.map((_, index) => {
    const payload = getItemPayload(sequenceBaseline, sequenceBoxes, index + 1);
    if (!payload) throw new Error(`Main 4:2:2 HEIF chain item ${index + 1} has no payload`);
    return payload;
  });
  const sequenceHvcC = findBox(sequenceBoxes, 'hvcC');
  if (!sequenceHvcC) throw new Error('Main 4:2:2 HEIF sequence is missing hvcC');
  const sequenceReferenceIds = dependencies.map((indexes) => indexes.map((index) => index + 1));

  const sequenceTiled = createTwoTilePredChain(
    sequencePayloads,
    sequenceReferenceIds,
    sequenceHvcC.data,
    tileWidth,
    tileHeight,
    sps.bitDepthLuma,
  );
  const sequenceTiledBoxes = parseISOBMFF(sequenceTiled);
  const sequenceTiledInfo = getHeicInfo(sequenceTiled, sequenceTiledBoxes);
  expect(sequenceTiledInfo.primaryItemId).toBe(pictures.length);
  for (let index = 0; index < pictures.length; index++) {
    const itemId = index + 1;
    const expectedInfo = getHeicInfo(sequenceBaseline, sequenceBoxes, itemId);
    const actualInfo = getHeicInfo(sequenceTiled, sequenceTiledBoxes, itemId);
    expect(actualInfo.predReferenceItemIds ?? []).toEqual(sequenceReferenceIds[index]);
    const expected = decodeItemPlanes(sequenceBaseline, sequenceBoxes, expectedInfo, itemId);
    const actual = decodeItemPlanes(sequenceTiled, sequenceTiledBoxes, actualInfo, itemId);
    expect([actual.width, actual.height]).toEqual([tileWidth * 2, tileHeight]);
    expect(actual.pictureOrderCnt).toBe(pictureOrderCounts[index]);
    expect(actual.y).toEqual(repeatHorizontalRows(expected.y, tileWidth, tileHeight));
    expect(actual.cb).toEqual(repeatHorizontalRows(expected.cb, tileWidth / 2, tileHeight));
    expect(actual.cr).toEqual(repeatHorizontalRows(expected.cr, tileWidth / 2, tileHeight));
  }

  for (const targetIndex of [3, 4, 5, 6, 7, 8]) {
    const prefixStreams = sequenceStreams.slice(0, targetIndex + 1);
    const prefixReferenceIds = sequenceReferenceIds.slice(0, targetIndex + 1);
    const prefixBaseline = wrapHevcPredChain(
      prefixStreams,
      prefixReferenceIds,
      tileWidth,
      tileHeight,
      sps.bitDepthLuma,
      sps.chromaFormatIdc,
    );
    const prefixBoxes = parseISOBMFF(prefixBaseline);
    const prefixInfo = getHeicInfo(prefixBaseline, prefixBoxes);
    const expected = decodeItemPlanes(
      prefixBaseline,
      prefixBoxes,
      prefixInfo,
      prefixInfo.primaryItemId,
    );
    expect(expected.pictureOrderCnt).toBe(pictureOrderCounts[targetIndex]);
    const prefixPayloads = prefixStreams.map((_, index) => {
      const payload = getItemPayload(prefixBaseline, prefixBoxes, index + 1);
      if (!payload) throw new Error(`Main 4:2:2 prefix item ${index + 1} has no payload`);
      return payload;
    });
    const prefixHvcC = findBox(prefixBoxes, 'hvcC');
    if (!prefixHvcC) throw new Error('Main 4:2:2 prefix HEIF is missing hvcC');
    const prefixExternalTiled = createTwoTileExternalPredChain(
      prefixPayloads,
      prefixReferenceIds,
      prefixHvcC.data,
      makeExternalTileDataReference(2, 3000 + targetIndex * 2),
      tileWidth,
      tileHeight,
      sps.bitDepthLuma,
    );
    const prefixExternalBoxes = parseISOBMFF(prefixExternalTiled);
    const prefixExternalInfo = getHeicInfo(prefixExternalTiled, prefixExternalBoxes);
    expect(prefixExternalInfo.predReferenceItemIds).toEqual(prefixReferenceIds.at(-1));
    const prefixTileDataReference = prefixExternalInfo.tiledImage!.dataReference;
    const prefixExternalTileData = {
      [buildTiledTileUrl(prefixTileDataReference, 0)]: prefixBaseline,
      [buildTiledTileUrl(prefixTileDataReference, 1)]: prefixBaseline,
    };
    const actual = decodeItemPlanes(
      prefixExternalTiled,
      prefixExternalBoxes,
      prefixExternalInfo,
      prefixExternalInfo.primaryItemId,
      { externalTileData: prefixExternalTileData },
    );
    expect(actual.pictureOrderCnt).toBe(expected.pictureOrderCnt);
    expect(actual.y).toEqual(repeatHorizontalRows(expected.y, tileWidth, tileHeight));
    expect(actual.cb).toEqual(repeatHorizontalRows(expected.cb, tileWidth / 2, tileHeight));
    expect(actual.cr).toEqual(repeatHorizontalRows(expected.cr, tileWidth / 2, tileHeight));
  }
}, 600_000);

it('decodes a multi-reference weighted B picture across in-file and external tili tiles', () => {
  const nals = splitAnnexB(fixture('wp-b-toshiba-3.bit'));
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official WP_B stream is missing its SPS or PPS');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const pictures: Uint8Array[][] = [];
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic) pictures.push([]);
    if (pictures.length === 0) throw new Error('WP_B slice appeared before its first picture');
    pictures[pictures.length - 1].push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }
  expect(pictures).toHaveLength(256);

  const bHeader = parseSliceHeader(pictures[2][0], sps, pps);
  expect(bHeader.sliceType).toBe(SLICE_TYPE_B);
  expect(bHeader.pictureOrderCntLsb).toBe(4);
  expect([bHeader.numRefIdxL0ActiveMinus1, bHeader.numRefIdxL1ActiveMinus1]).toEqual([1, 1]);
  expect(bHeader.weightedPrediction?.l0).toHaveLength(2);
  expect(bHeader.weightedPrediction?.l1).toHaveLength(2);

  const parameterSets = nals
    .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
    .map((nal) => nal.data);
  const streams = [
    annexB([...parameterSets, ...pictures[0]]),
    annexB(pictures[1]),
    annexB(pictures[2]),
  ];
  const baseline = wrapHevcPredChain(
    streams,
    [[], [1], [1, 2]],
    sps.picWidthInLumaSamples,
    sps.picHeightInLumaSamples,
    sps.bitDepthLuma,
    sps.chromaFormatIdc,
  );
  const baselineBoxes = parseISOBMFF(baseline);
  const hvcC = findBox(baselineBoxes, 'hvcC');
  if (!hvcC) throw new Error('baseline HEIF is missing hvcC');
  const reference0 = decodeItemPlanes(
    baseline,
    baselineBoxes,
    getHeicInfo(baseline, baselineBoxes, 1),
    1,
  );
  const reference8 = decodeItemPlanes(
    baseline,
    baselineBoxes,
    getHeicInfo(baseline, baselineBoxes, 2),
    2,
  );
  const referencePictures: PictureReference[] = [reference0, reference8].map((reference) => ({
    ...reference,
    pictureOrderCntLsb: reference.pictureOrderCntLsb!,
    pictureOrderCnt: reference.pictureOrderCnt!,
    isLongTermReference: false,
  }));
  const bReferenceLists = buildBReferenceLists(sps, bHeader, 4, referencePictures);
  expect(bReferenceLists.l0.map((reference) => reference.pictureOrderCnt)).toEqual([0, 8]);
  expect(bReferenceLists.l1.map((reference) => reference.pictureOrderCnt)).toEqual([8, 0]);
  const expectedPlanes = decodeItemPlanes(
    baseline,
    baselineBoxes,
    getHeicInfo(baseline, baselineBoxes, 3),
    3,
  );
  expect(expectedPlanes.pictureOrderCnt).toBe(4);
  // POC 4 is zero-based display-frame index 4 in FFmpeg 9.0.1's output.
  expect([md5(expectedPlanes.y), md5(expectedPlanes.cb), md5(expectedPlanes.cr)]).toEqual([
    'b3f35603b1f3e617ae148545e88b1372',
    'f0a85efad61b134a1039d08868aa6a6a',
    'ca0a43ec536ad8ee747377d65c204c72',
  ]);

  const expectRepeatedPlanes = (actual: ReturnType<typeof decodeItemPlanes>) => {
    expect([actual.width, actual.height]).toEqual([832, 240]);
    expect(actual.y).toEqual(repeatHorizontalRows(expectedPlanes.y, 416, 240));
    expect(actual.cb).toEqual(repeatHorizontalRows(expectedPlanes.cb, 208, 120));
    expect(actual.cr).toEqual(repeatHorizontalRows(expectedPlanes.cr, 208, 120));
    expect(actual.pictureOrderCnt).toBe(expectedPlanes.pictureOrderCnt);
    expect(actual.pictureOrderCntLsb).toBe(expectedPlanes.pictureOrderCntLsb);
    expect(actual.temporalId).toBe(expectedPlanes.temporalId);
    expect(actual.motionXQpel).toEqual(repeatHorizontalRows(expectedPlanes.motionXQpel!, 104, 60));
    expect(actual.motionYQpel).toEqual(repeatHorizontalRows(expectedPlanes.motionYQpel!, 104, 60));
    expect(actual.interMap).toEqual(repeatHorizontalRows(expectedPlanes.interMap!, 104, 60));
  };

  const inFileTiled = createTwoTileMultiRefPredImage(
    getItemPayload(baseline, baselineBoxes, 1)!,
    getItemPayload(baseline, baselineBoxes, 2)!,
    getItemPayload(baseline, baselineBoxes, 3)!,
    hvcC.data,
  );
  const inFileBoxes = parseISOBMFF(inFileTiled);
  const inFileInfo = getHeicInfo(inFileTiled, inFileBoxes);
  expect(inFileInfo.predReferenceItemIds).toEqual([1, 2]);
  expectRepeatedPlanes(
    decodeItemPlanes(inFileTiled, inFileBoxes, inFileInfo, inFileInfo.primaryItemId),
  );

  const externalTiled = createExternalTwoTileMultiRefPredImage(
    getItemPayload(baseline, baselineBoxes, 1)!,
    getItemPayload(baseline, baselineBoxes, 2)!,
    hvcC.data,
    makeExternalTileDataReference(2, 2300),
  );
  const externalBoxes = parseISOBMFF(externalTiled);
  const externalInfo = getHeicInfo(externalTiled, externalBoxes);
  expect(externalInfo.predReferenceItemIds).toEqual([1, 2]);
  const tileDataReference = externalInfo.tiledImage!.dataReference;
  const externalTileData = {
    [buildTiledTileUrl(tileDataReference, 0)]: baseline,
    [buildTiledTileUrl(tileDataReference, 1)]: baseline,
  };
  expectRepeatedPlanes(
    decodeItemPlanes(externalTiled, externalBoxes, externalInfo, externalInfo.primaryItemId, {
      externalTileData,
    }),
  );
});

it('decodes a four-reference weighted B picture through in-file and external tili pred chains', () => {
  const nals = splitAnnexB(fixture('wp-b-toshiba-3.bit'));
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official WP_B stream is missing its SPS or PPS');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const pictures: Uint8Array[][] = [];
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic) pictures.push([]);
    if (pictures.length === 0) throw new Error('WP_B slice appeared before its first picture');
    pictures[pictures.length - 1].push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }
  expect(pictures).toHaveLength(256);

  const expectedPictures = new Map([
    [3, { poc: 2, l0: 2, l1: 2, hash: 'ae09c54021d09cf1f75b9edf720d52ff' }],
    [4, { poc: 1, l0: 2, l1: 2, hash: '4775711a2d3d111b3e4dc6893c8d674c' }],
    [5, { poc: 3, l0: 2, l1: 2, hash: '4881cbbcbad1113ce7c02690cc7fa31e' }],
    [6, { poc: 6, l0: 2, l1: 2, hash: 'ec76ebfdd58a67998713877f5db30739' }],
    [7, { poc: 5, l0: 2, l1: 2, hash: '454cbec39d5f1e1a3dd3e3fa02214b6b' }],
    [8, { poc: 7, l0: 2, l1: 2, hash: '9b52446c79f70407cdb47e542742fcb8' }],
    [9, { poc: 16, l0: 4, l1: 4, hash: 'c1e79bd02b724aa8eef15cfdd77689b4' }],
    [10, { poc: 12, l0: 2, l1: 2, hash: '5c3cbd322973c051684205dabe6abd85' }],
    [11, { poc: 10, l0: 2, l1: 2, hash: 'dd3da4c13e363814ae091cc5336e9608' }],
  ] as const);
  for (const rootIndex of expectedPictures.keys()) {
    const records: {
      header: ReturnType<typeof parseSliceHeader>;
      poc: number;
      temporalId: number;
      previousTid0Index: number | null;
    }[] = [];
    const predReferenceIds: number[][] = [];
    let previousTid0Poc: number | null = null;
    let previousTid0Index: number | null = null;
    for (const [index, picture] of pictures.slice(0, rootIndex + 1).entries()) {
      const header = parseSliceHeader(picture[0], sps, pps);
      const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
      const temporalId = (picture[0][1] & 7) - 1;
      const dependencies = new Set<number>();
      if (header.sliceType !== SLICE_TYPE_I) {
        const rps = header.shortTermRefPicSet;
        if (!rps) throw new Error(`WP_B POC ${poc} has no short-term RPS`);
        for (const [deltas, usedFlags] of [
          [rps.deltaPocS0, rps.usedByCurrPicS0],
          [rps.deltaPocS1, rps.usedByCurrPicS1],
        ] as const) {
          for (let refIndex = 0; refIndex < deltas.length; refIndex++) {
            if (!usedFlags[refIndex]) continue;
            const referenceIndex = records.findIndex(
              (record) => record.poc === poc + deltas[refIndex],
            );
            if (referenceIndex < 0 || referenceIndex >= index)
              throw new Error(
                `WP_B POC ${poc} lacks a prior RPS reference ${poc + deltas[refIndex]}`,
              );
            dependencies.add(referenceIndex + 1);
          }
        }
        if (header.longTermRefPics.some((reference) => reference.usedByCurrPic))
          throw new Error('WP_B vector unexpectedly uses long-term references');
        if (previousTid0Index !== null) dependencies.add(previousTid0Index + 1);
      }
      predReferenceIds.push([...dependencies].sort((a, b) => a - b));
      records.push({ header, poc, temporalId, previousTid0Index });
      if (temporalId === 0) {
        previousTid0Poc = poc;
        previousTid0Index = index;
      }
    }

    const root = records[rootIndex];
    if (!root) throw new Error('WP_B four-reference picture is missing');
    const expectedPicture = expectedPictures.get(rootIndex)!;
    expect(root.poc).toBe(expectedPicture.poc);
    expect(root.header.sliceType).toBe(SLICE_TYPE_B);
    expect([root.header.numRefIdxL0ActiveMinus1, root.header.numRefIdxL1ActiveMinus1]).toEqual([
      expectedPicture.l0 - 1,
      expectedPicture.l1 - 1,
    ]);

    const parameterSets = nals
      .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
      .map((nal) => nal.data);
    const streams = pictures
      .slice(0, rootIndex + 1)
      .map((picture, index) => annexB([...(index === 0 ? parameterSets : []), ...picture]));
    const baseline = wrapHevcPredChain(
      streams,
      predReferenceIds,
      sps.picWidthInLumaSamples,
      sps.picHeightInLumaSamples,
      sps.bitDepthLuma,
      sps.chromaFormatIdc,
    );
    const baselineBoxes = parseISOBMFF(baseline);
    const baselineInfo = getHeicInfo(baseline, baselineBoxes, rootIndex + 1);
    const expectedPlanes = decodeItemPlanes(baseline, baselineBoxes, baselineInfo, rootIndex + 1);
    expect(expectedPlanes.pictureOrderCnt).toBe(root.poc);
    const expectedHash = createHash('md5');
    expectedHash.update(Buffer.from(expectedPlanes.y));
    expectedHash.update(Buffer.from(expectedPlanes.cb));
    expectedHash.update(Buffer.from(expectedPlanes.cr));
    // These are per-frame hashes from FFmpeg 9.0.1 decoding the official vector.
    expect(expectedHash.digest('hex')).toBe(expectedPicture.hash);

    const hvcCBox = findBox(baselineBoxes, 'hvcC');
    if (!hvcCBox) throw new Error('baseline HEIF chain is missing hvcC');
    const width = sps.picWidthInLumaSamples;
    const height = sps.picHeightInLumaSamples;
    const tileWidth = width;
    const imageIspe = full('ispe', 0, u32(tileWidth * 2), u32(height));
    const tileIspe = full('ispe', 0, u32(tileWidth), u32(height));
    const pixi = full('pixi', 0, Buffer.from([3, 8, 8, 8]));
    const hvcC = box('hvcC', hvcCBox.data);
    const rref = full('rref', 0, Buffer.from([1]), Buffer.from('pred'));
    const deti = box('deti', Buffer.from([0, 0, 0, 0x18]), Buffer.from([2]), u32(0), u32(16));
    const tiledItems: Item[] = [];
    const propertyStarts: number[] = [];
    let propertyCount = 0;
    for (const [index, dependencies] of predReferenceIds.entries()) {
      const propertyStart = propertyCount + 1;
      propertyStarts.push(propertyStart);
      const previousIndex = records[index].previousTid0Index;
      const tipa =
        previousIndex === null
          ? full('tipa', 0, Buffer.from([3, 0x83, 0x82, 0x85]))
          : full(
              'tipa',
              0,
              Buffer.from([
                3,
                0x80 | (propertyStarts[previousIndex] + 2),
                0x80 | (propertyStarts[previousIndex] + 1),
                0x80 | (propertyStarts[previousIndex] + 4),
              ]),
            );
      const tilC = full(
        'tilC',
        0,
        u32(tileWidth),
        u32(height),
        Buffer.from([0]),
        Buffer.from('hvc1'),
        tipa,
      );
      const properties =
        dependencies.length === 0
          ? [imageIspe, pixi, hvcC, tilC, tileIspe]
          : [imageIspe, pixi, hvcC, tilC, tileIspe, rref];
      const payload = getItemPayload(baseline, baselineBoxes, index + 1);
      if (!payload) throw new Error(`baseline HEIF chain item ${index + 1} has no payload`);
      tiledItems.push({
        id: index + 1,
        type: 'tili',
        data: createTileData(payload, 2),
        properties,
        propertyAssociationIndexes: dependencies.length === 0 ? [0, 1, 3] : [0, 1, 3, 5],
        dataReference: deti,
        ...(dependencies.length > 0 ? { refs: [{ type: 'pred', to: dependencies }] } : {}),
      });
      propertyCount += properties.length;
    }

    const tiled = buildHeif(tiledItems, rootIndex + 1);
    const tiledBoxes = parseISOBMFF(tiled);
    const tiledInfo = getHeicInfo(tiled, tiledBoxes);
    expect(tiledInfo.primaryItemType).toBe('tili');
    expect(tiledInfo.predReferenceItemIds).toEqual(predReferenceIds[rootIndex]);
    const actualPlanes = decodeItemPlanes(tiled, tiledBoxes, tiledInfo, tiledInfo.primaryItemId);
    expect([actualPlanes.width, actualPlanes.height]).toEqual([width * 2, height]);
    expect(actualPlanes.pictureOrderCnt).toBe(expectedPlanes.pictureOrderCnt);
    expect(actualPlanes.y).toEqual(repeatHorizontalRows(expectedPlanes.y, width, height));
    expect(actualPlanes.cb).toEqual(
      repeatHorizontalRows(expectedPlanes.cb, width >> 1, height >> 1),
    );
    expect(actualPlanes.cr).toEqual(
      repeatHorizontalRows(expectedPlanes.cr, width >> 1, height >> 1),
    );
    expect(actualPlanes.motionXQpel).toEqual(
      repeatHorizontalRows(expectedPlanes.motionXQpel!, width >> 2, height >> 2),
    );
    expect(actualPlanes.motionYQpel).toEqual(
      repeatHorizontalRows(expectedPlanes.motionYQpel!, width >> 2, height >> 2),
    );
    expect(actualPlanes.interMap).toEqual(
      repeatHorizontalRows(expectedPlanes.interMap!, width >> 2, height >> 2),
    );
    expect(decodeHeic(tiled).data).toEqual(
      repeatHorizontalRows(decodeHeic(baseline).data, width * 4, height),
    );

    const externalTileDeti = makeExternalTileDataReference(2, 2400);
    const externalTiled = buildHeif(
      [
        ...tiledItems.slice(0, rootIndex),
        {
          id: rootIndex + 1,
          type: 'tili',
          data: new Uint8Array(0),
          properties: [
            imageIspe,
            pixi,
            full('tilC', 0, u32(tileWidth), u32(height), Buffer.from([0])),
            rref,
          ],
          propertyAssociationIndexes: [0, 1, 2, 3],
          dataReference: externalTileDeti,
          refs: [{ type: 'pred', to: predReferenceIds[rootIndex] }],
        },
      ],
      rootIndex + 1,
    );
    const externalBoxes = parseISOBMFF(externalTiled);
    const externalInfo = getHeicInfo(externalTiled, externalBoxes);
    expect(externalInfo.predReferenceItemIds).toEqual(predReferenceIds[rootIndex]);
    const externalTileDataReference = externalInfo.tiledImage?.dataReference;
    if (!externalTileDataReference) throw new Error('external tili item has no parsed deti URL');
    const externalTiles = {
      [buildTiledTileUrl(externalTileDataReference, 0)]: baseline,
      [buildTiledTileUrl(externalTileDataReference, 1)]: baseline,
    };
    const externalPlanes = decodeItemPlanes(
      externalTiled,
      externalBoxes,
      externalInfo,
      externalInfo.primaryItemId,
      { externalTileData: externalTiles },
    );
    expect(externalPlanes.pictureOrderCnt).toBe(expectedPlanes.pictureOrderCnt);
    expect(externalPlanes.y).toEqual(repeatHorizontalRows(expectedPlanes.y, width, height));
    expect(externalPlanes.cb).toEqual(
      repeatHorizontalRows(expectedPlanes.cb, width >> 1, height >> 1),
    );
    expect(externalPlanes.cr).toEqual(
      repeatHorizontalRows(expectedPlanes.cr, width >> 1, height >> 1),
    );
    expect(decodeHeic(externalTiled, { externalTileData: externalTiles }).data).toEqual(
      repeatHorizontalRows(decodeHeic(baseline).data, width * 4, height),
    );
  }
}, 120_000);

it('decodes external tili P tiles against multi-reference pred images', async () => {
  const nals = splitAnnexB(fixture('rps-c-ericsson-5.bit'));
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official RPS_C stream is missing its SPS or PPS');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const pictures: Uint8Array[][] = [];
  let picture: Uint8Array[] = [];
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic && picture.length > 0) {
      pictures.push(picture);
      picture = [];
    }
    picture.push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }
  if (picture.length > 0) pictures.push(picture);
  expect(pictures.length).toBeGreaterThanOrEqual(3);

  const thirdHeader = parseSliceHeader(pictures[2][0], sps, pps);
  expect(thirdHeader.sliceType).toBe(SLICE_TYPE_P);
  expect(thirdHeader.pictureOrderCntLsb).toBe(8);
  expect(thirdHeader.numRefIdxL0ActiveMinus1).toBe(1);
  expect(thirdHeader.shortTermRefPicSet?.deltaPocS0).toEqual([-8]);
  expect(thirdHeader.shortTermRefPicSet?.deltaPocS1).toEqual([8]);
  expect(thirdHeader.shortTermRefPicSet?.usedByCurrPicS0).toEqual([true]);
  expect(thirdHeader.shortTermRefPicSet?.usedByCurrPicS1).toEqual([true]);

  const parameterSets = nals
    .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
    .map((nal) => nal.data);
  const baseline = wrapHevcPredChain(
    [annexB([...parameterSets, ...pictures[0]]), annexB(pictures[1]), annexB(pictures[2])],
    [[], [1], [1, 2]],
    416,
    240,
    8,
    1,
  );
  const baselineBoxes = parseISOBMFF(baseline);
  const hvcC = findBox(baselineBoxes, 'hvcC');
  if (!hvcC) throw new Error('baseline HEIF is missing hvcC');
  const tiled = createExternalTwoTileMultiRefPredImage(
    getItemPayload(baseline, baselineBoxes, 1)!,
    getItemPayload(baseline, baselineBoxes, 2)!,
    hvcC.data,
    makeExternalTileDataReference(2, 2100),
  );
  const tiledBoxes = parseISOBMFF(tiled);
  const tiledInfo = getHeicInfo(tiled, tiledBoxes);
  expect(tiledInfo.primaryItemType).toBe('tili');
  expect(tiledInfo.predReferenceItemIds).toEqual([1, 2]);
  expect(tiledInfo.tiledImage).toMatchObject({
    rows: 1,
    columns: 2,
    tileWidth: 416,
    tileHeight: 240,
  });

  const externalTileFile = wrapHevcPredChain(
    [annexB([...parameterSets, ...pictures[0]]), annexB(pictures[1]), annexB(pictures[2])],
    [[], [1], [1, 2]],
    416,
    240,
    8,
    1,
  );
  const reference = tiledInfo.tiledImage!.dataReference;
  const externalTileData: Record<string, Uint8Array> = {
    [buildTiledTileUrl(reference, 0)]: externalTileFile,
    [buildTiledTileUrl(reference, 1)]: externalTileFile,
  };
  const expectedPlanes = decodeItemPlanes(
    baseline,
    baselineBoxes,
    getHeicInfo(baseline, baselineBoxes, 3),
    3,
  );
  const actualPlanes = decodeItemPlanes(tiled, tiledBoxes, tiledInfo, tiledInfo.primaryItemId, {
    externalTileData,
  });
  expect([actualPlanes.width, actualPlanes.height]).toEqual([832, 240]);
  expect(actualPlanes.y).toEqual(repeatHorizontalRows(expectedPlanes.y, 416, 240));
  expect(actualPlanes.cb).toEqual(repeatHorizontalRows(expectedPlanes.cb, 208, 120));
  expect(actualPlanes.cr).toEqual(repeatHorizontalRows(expectedPlanes.cr, 208, 120));
  expect(actualPlanes.pictureOrderCnt).toBe(expectedPlanes.pictureOrderCnt);
  expect(actualPlanes.pictureOrderCntLsb).toBe(expectedPlanes.pictureOrderCntLsb);
  expect(actualPlanes.temporalId).toBe(expectedPlanes.temporalId);
  expect(actualPlanes.motionXQpel).toEqual(
    repeatHorizontalRows(expectedPlanes.motionXQpel!, 104, 60),
  );
  expect(actualPlanes.motionYQpel).toEqual(
    repeatHorizontalRows(expectedPlanes.motionYQpel!, 104, 60),
  );
  expect(actualPlanes.interMap).toEqual(repeatHorizontalRows(expectedPlanes.interMap!, 104, 60));

  const expectedSdr = decodeHeic(baseline).data;
  const tiledSdr = decodeHeic(tiled, { externalTileData });
  expect(tiledSdr.data).toEqual(repeatHorizontalRows(expectedSdr, 416 * 4, 240));
  const expectedHdr = decodeHDRSync(baseline).data;
  const tiledHdr = decodeHDRSync(tiled, { externalTileData });
  expect(tiledHdr.data).toEqual(repeatHorizontalRows(expectedHdr, 416 * 4, 240));
  const asyncSdr = await decode(tiled, { execution: 'main', externalTileData });
  expect(asyncSdr.data).toEqual(tiledSdr.data);
  const resolvedSdr = await decode(tiled, {
    execution: 'main',
    resolveExternalTile: async (url) => externalTileData[url],
  });
  expect(resolvedSdr.data).toEqual(tiledSdr.data);
  const asyncHdr = await decodeHDR(tiled, { execution: 'main', externalTileData });
  expect(asyncHdr.data).toEqual(tiledHdr.data);
});
