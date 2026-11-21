// Validate Annex H inter-layer sample and motion-map resampling against
// official SHVC reference-offset, phase, and non-identity motion vectors.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { getHeicInfo } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { buildTiledTileUrl, getTiledImageTileIndices } from '../src/container/tili';
import { decodeLayeredHevcPicture } from '../src/hevc/layered-picture';
import { BitReader, isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal';
import { parsePps } from '../src/hevc/pps';
import { parseSliceHeader, SLICE_TYPE_P } from '../src/hevc/slice-header';
import { parseSps } from '../src/hevc/sps';
import { parseLayeredVps } from '../src/hevc/vps';
import { chromaSubsampling } from '../src/hevc/chroma';
import { cropPlanes, decodeItemPlanes, stitchTiledImage, type Planes } from '../src/planes';
import { decodeHeic, getHeicMetadata } from '../src/decoder';
import { box, buildHeif, full, type Item, u16, u32 } from '../test/helpers/heif';

const baseUrl =
  'https://www.itu.int/wftp3/av-arch/jctvc-site/bitstream_exchange/draft_conformance/SHVC';

function firstAccessUnit(nals: ReturnType<typeof splitAnnexB>) {
  const result: ReturnType<typeof splitAnnexB> = [];
  const seenFirstSliceByLayer = new Set<number>();
  for (const nal of nals) {
    if ([32, 33, 34].includes(nal.type)) {
      result.push(nal);
      continue;
    }
    if (nal.type > 31) continue;
    const reader = new BitReader(toRbsp(nal.data));
    const firstSliceSegment = reader.readBit() === 1;
    if (firstSliceSegment && seenFirstSliceByLayer.has(nal.layerId)) break;
    if (firstSliceSegment) seenFirstSliceByLayer.add(nal.layerId);
    if (seenFirstSliceByLayer.has(nal.layerId)) result.push(nal);
  }
  return result;
}

function accessUnits(nals: ReturnType<typeof splitAnnexB>) {
  const parameterSets = nals.filter((nal) => [32, 33, 34].includes(nal.type));
  const groups: ReturnType<typeof splitAnnexB>[] = [];
  const seenLayerIds = new Set<number>();
  let slices: ReturnType<typeof splitAnnexB> = [];
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const reader = new BitReader(toRbsp(nal.data));
    const firstSliceSegment = reader.readBit() === 1;
    if (firstSliceSegment && seenLayerIds.has(nal.layerId)) {
      groups.push([...parameterSets, ...slices]);
      slices = [];
      seenLayerIds.clear();
    }
    if (firstSliceSegment) seenLayerIds.add(nal.layerId);
    slices.push(nal);
  }
  if (slices.length > 0) groups.push([...parameterSets, ...slices]);
  return groups;
}

const vectors = [
  {
    archiveName: 'SCREFOFF_A_QCOM_1',
    archiveSha256: 'c910cd9e553b3788fb642b47f81a9d3d7d1ad809d0fcc3fdd2c2261da7920264',
    bitstreamSha256: 'b0c7b9c19812dd0b77f7da79097ab27a4792ad233a4c61c787881679320ae404',
    expectedOffsets: {
      refLocLayerId: 0,
      scaledRefLayerOffsets: [140, 35, 140, 37],
      refRegionOffsets: null,
      resamplePhases: null,
    },
    levelIdc: 120,
    oplSeparator: '-',
    expectedBaseSize: [400, 400],
    expectedEnhancementSize: [960, 540],
    expectedCodedSize: [960, 544],
  },
  {
    archiveName: 'RESPHASE_A_SAMSUNG_2',
    archiveSha256: '61893f6f89cfeabaec72ad22135772480ffd9841f562346602b4488b6e612453',
    bitstreamSha256: '4e17907f4a4a0556ea9abd98f6ff5a95f1991b155eeca34d2a36a5d523fd7aeb',
    expectedOffsets: {
      refLocLayerId: 0,
      scaledRefLayerOffsets: [24, 24, 0, 0],
      refRegionOffsets: [13, 13, 0, 0],
      resamplePhases: [1, 4, 11, 13],
    },
    levelIdc: 123,
    oplSeparator: '_',
    expectedBaseSize: [1280, 720],
    expectedEnhancementSize: [1920, 1080],
    expectedCodedSize: [1920, 1080],
  },
] as const;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function findZipEntry(archive: Buffer, expectedName: string): ZipEntry {
  let eocd = -1;
  const searchStart = Math.max(0, archive.length - 65_557);
  for (let p = archive.length - 22; p >= searchStart; p--) {
    if (archive.readUInt32LE(p) === 0x06054b50) {
      eocd = p;
      break;
    }
  }
  assert.notEqual(eocd, -1, 'ZIP end record was not found');

  const entryCount = archive.readUInt16LE(eocd + 10);
  const directorySize = archive.readUInt32LE(eocd + 12);
  let p = archive.readUInt32LE(eocd + 16);
  assert(p + directorySize <= archive.length, 'ZIP directory exceeds the archive');
  for (let i = 0; i < entryCount; i++) {
    assert.equal(archive.readUInt32LE(p), 0x02014b50, `invalid ZIP directory entry ${i}`);
    const nameLength = archive.readUInt16LE(p + 28);
    const extraLength = archive.readUInt16LE(p + 30);
    const commentLength = archive.readUInt16LE(p + 32);
    const name = archive.toString('utf8', p + 46, p + 46 + nameLength);
    if (name === expectedName) {
      return {
        name,
        method: archive.readUInt16LE(p + 10),
        compressedSize: archive.readUInt32LE(p + 20),
        size: archive.readUInt32LE(p + 24),
        localOffset: archive.readUInt32LE(p + 42),
      };
    }
    p += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP member not found: ${expectedName}`);
}

function extractZipEntry(archive: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localOffset;
  assert.equal(archive.readUInt32LE(p), 0x04034b50, `invalid ZIP local header for ${entry.name}`);
  const nameLength = archive.readUInt16LE(p + 26);
  const extraLength = archive.readUInt16LE(p + 28);
  const name = archive.toString('utf8', p + 30, p + 30 + nameLength);
  assert.equal(name, entry.name, `ZIP member name mismatch: ${entry.name}`);
  const start = p + 30 + nameLength + extraLength;
  const compressed = archive.subarray(start, start + entry.compressedSize);
  assert.equal(compressed.length, entry.compressedSize, `truncated ZIP member: ${entry.name}`);
  const bytes =
    entry.method === 0
      ? Buffer.from(compressed)
      : entry.method === 8
        ? inflateRawSync(compressed)
        : (() => {
            throw new Error(`unsupported ZIP compression method ${entry.method}`);
          })();
  assert.equal(bytes.length, entry.size, `unexpected uncompressed size: ${entry.name}`);
  return bytes;
}

function expectedPlaneMd5(
  opl: string,
  archiveName: string,
  layerId: number,
  pictureOrderCnt = 0,
): string[] {
  const row =
    new RegExp(`^\\s*${layerId}\\s+${pictureOrderCnt}\\s+MD5:([^\\s]+)$`, 'm').exec(opl) ??
    new RegExp(
      `\\bPOC\\s+${pictureOrderCnt}\\s+LId:\\s*${layerId}\\b[^\\n]*\\[MD5:([0-9a-f,]+)`,
      'mi',
    ).exec(opl);
  assert(row, `${archiveName}: POC ${pictureOrderCnt} checksum is missing for layer ${layerId}`);
  return row[1].replace(/,$/, '').split(',');
}

function planeMd5(planes: {
  y: Uint8Array | Uint16Array;
  cb: Uint8Array | Uint16Array;
  cr: Uint8Array | Uint16Array;
}): string[] {
  return [planes.y, planes.cb, planes.cr].map((plane) =>
    createHash('md5')
      .update(Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength))
      .digest('hex'),
  );
}

function poisonFirstLhevcReferenceMargin(
  tiles: Map<number, Map<number, Planes>>,
  targetOffsetX: number,
  targetTileWidth: number,
): Map<number, Map<number, Planes>> {
  const result = new Map(tiles);
  const firstTile = tiles.get(0);
  assert(firstTile, 'L-HEVC tiled reference has no first spatial tile');
  const poisonedLayers = new Map<number, Planes>();
  for (const [layerId, planes] of firstTile) {
    const margin = (targetOffsetX * planes.width) / targetTileWidth;
    const sub = chromaSubsampling(planes.chromaFormatIdc);
    assert(Number.isSafeInteger(margin) && margin > 0 && margin < planes.width);
    assert.equal(margin % sub.width, 0);
    const y = planes.y.slice();
    const cb = planes.cb.slice();
    const cr = planes.cr.slice();
    for (let row = 0; row < planes.height; row++)
      y.fill(0, row * planes.width, row * planes.width + margin);
    const chromaWidth = planes.width / sub.width;
    const chromaMargin = margin / sub.width;
    for (let row = 0; row < planes.height / sub.height; row++) {
      cb.fill(0, row * chromaWidth, row * chromaWidth + chromaMargin);
      cr.fill(0, row * chromaWidth, row * chromaWidth + chromaMargin);
    }
    poisonedLayers.set(layerId, { ...planes, y, cb, cr });
  }
  result.set(0, poisonedLayers);
  return result;
}

function addEmptyLhevcMotionMaps(
  tiles: Map<number, Map<number, Planes>>,
): Map<number, Map<number, Planes>> {
  return new Map(
    [...tiles].map(([tileIndex, layers]) => [
      tileIndex,
      new Map(
        [...layers].map(([layerId, planes]) => {
          const mapSize = Math.ceil(planes.width / 4) * Math.ceil(planes.height / 4);
          return [
            layerId,
            {
              ...planes,
              interMap: new Uint8Array(mapSize),
              motionXQpel: new Int32Array(mapSize),
              motionYQpel: new Int32Array(mapSize),
              motionRefPoc: new Float64Array(mapSize),
              motionRefLongTerm: new Uint8Array(mapSize),
            },
          ];
        }),
      ),
    ]),
  );
}

class BitWriter {
  private readonly bits: number[] = [];

  write(value: number, width: number): void {
    for (let shift = width - 1; shift >= 0; shift--)
      this.bits.push(Math.floor(value / 2 ** shift) % 2);
  }

  finish(): Uint8Array {
    while (this.bits.length % 8) this.bits.push(0);
    const bytes = new Uint8Array(this.bits.length / 8);
    for (let i = 0; i < this.bits.length; i++) bytes[i >> 3] |= this.bits[i] << (7 - (i & 7));
    return bytes;
  }
}

function makeOinf(
  maxWidth: number,
  maxHeight: number,
  levelIdc: number,
  layerIds: readonly number[] = [0, 1],
  targetLayerId = 1,
  outputLayerSetIndex = 1,
  dependencies: ReadonlyMap<number, readonly number[]> = new Map([
    [0, []],
    [1, [0]],
  ]),
): Uint8Array {
  const bits = new BitWriter();
  bits.write(0, 8); // FullBox version
  bits.write(0, 24); // FullBox flags
  bits.write(0x4000, 16); // one scalability dimension
  bits.write(0, 2); // reserved
  bits.write(1, 6); // one profile_tier_level record
  bits.write(0, 2); // general_profile_space
  bits.write(0, 1); // general_tier_flag
  bits.write(1, 5); // general_profile_idc
  bits.write(0, 32); // general_profile_compatibility_flags
  bits.write(0, 48); // general_constraint_indicator_flags
  bits.write(levelIdc, 8); // general_level_idc
  bits.write(1, 16); // one operating point
  bits.write(outputLayerSetIndex, 16); // output_layer_set_idx
  bits.write(1, 8); // max_temporal_id
  bits.write(layerIds.length, 8);
  for (const layerId of layerIds) {
    bits.write(1, 8); // ptl_idx
    bits.write(layerId, 6);
    bits.write(Number(layerId === targetLayerId), 1);
    bits.write(0, 1); // is_alternate_output_layer
  }
  bits.write(0, 16); // min_pic_width
  bits.write(0, 16); // min_pic_height
  bits.write(maxWidth, 16); // max_pic_width
  bits.write(maxHeight, 16); // max_pic_height
  bits.write(1, 2); // max_chroma_format (4:2:0)
  bits.write(0, 3); // max_bit_depth_minus8
  bits.write(0, 1); // reserved
  bits.write(0, 1); // frame_rate_info_flag
  bits.write(0, 1); // bit_rate_info_flag
  const maxLayerId = Math.max(...layerIds);
  bits.write(maxLayerId, 8); // max_layer_id
  for (const layerId of layerIds.filter((id) => id > 0)) {
    const directDependencies = dependencies.get(layerId) ?? [];
    bits.write(layerId, 8);
    bits.write(directDependencies.length, 8);
    for (const dependencyId of directDependencies) bits.write(dependencyId, 8);
    bits.write(1, 8); // dimension identifier
  }
  return bits.finish();
}

function makeLhvC(accessUnitNals: ReturnType<typeof splitAnnexB>): Uint8Array {
  const parameterSets = new Map<number, Uint8Array[]>();
  for (const nal of accessUnitNals) {
    if (![32, 33, 34].includes(nal.type)) continue;
    const list = parameterSets.get(nal.type) ?? [];
    list.push(nal.data);
    parameterSets.set(nal.type, list);
  }
  const arrays = [...parameterSets].map(([type, units]) =>
    Buffer.concat([
      Buffer.from([0x80 | type]),
      u16(units.length),
      ...units.flatMap((unit) => [u16(unit.length), unit]),
    ]),
  );
  return Buffer.concat([Buffer.from([1, 0xf0, 0, 0xfc, 0xe7, arrays.length]), ...arrays]);
}

function makeLhevcHeif(
  accessUnitNals: ReturnType<typeof splitAnnexB>,
  slices: ReturnType<typeof splitAnnexB>,
  maxWidth: number,
  maxHeight: number,
  width: number,
  height: number,
  levelIdc: number,
  layerIds: readonly number[] = [0, 1],
  targetLayerId = 1,
  outputLayerSetIndex = 1,
  dependencies?: ReadonlyMap<number, readonly number[]>,
): Uint8Array {
  const itemPayload = Buffer.concat(
    slices.map((nal) => Buffer.concat([u32(nal.data.length), nal.data])),
  );
  return buildHeif(
    [
      {
        id: 1,
        type: 'lhv1',
        data: itemPayload,
        properties: [
          box('lhvC', makeLhvC(accessUnitNals)),
          box(
            'oinf',
            makeOinf(
              maxWidth,
              maxHeight,
              levelIdc,
              layerIds,
              targetLayerId,
              outputLayerSetIndex,
              dependencies,
            ),
          ),
          box(
            'tols',
            Buffer.from([0, 0, 0, 0, outputLayerSetIndex >> 8, outputLayerSetIndex & 0xff]),
          ),
          full('ispe', 0, u32(width), u32(height)),
          full('pixi', 0, Buffer.from([3, 8, 8, 8])),
          box(
            'colr',
            Buffer.concat([Buffer.from('nclx'), u16(1), u16(1), u16(1), Buffer.from([128])]),
          ),
        ],
      },
    ],
    1,
  );
}

function makeExternalLhevcTiliItem(
  id: number,
  width: number,
  height: number,
  tileIdStart: number,
  predReferenceItemIds: readonly number[] = [],
  columns = 1,
  rows = 1,
  extraDimensionSizes: readonly number[] = [],
  relativeLocation?: { horizontalOffset: number; verticalOffset: number },
): Item {
  if (relativeLocation && predReferenceItemIds.length === 0)
    throw new Error('an external L-HEVC relative location requires a prediction reference');
  const inputItemCount =
    columns * rows * extraDimensionSizes.reduce((count, size) => count * size, 1);
  const tileId = Buffer.alloc(8);
  tileId.writeBigUInt64BE(BigInt(tileIdStart));
  const deti = box(
    'deti',
    Buffer.from([0, 0, 0, 0x80]),
    Buffer.from([inputItemCount, 0]),
    tileId,
    Buffer.from('https://tiles.example.invalid/'),
    Buffer.from([0]),
    Buffer.from(''),
    Buffer.from([0]),
    Buffer.from('$tileID$.heic'),
    Buffer.from([0]),
  );
  const hasPredReferences = predReferenceItemIds.length > 0;
  return {
    id,
    type: 'tili',
    data: new Uint8Array(0),
    properties: [
      full('ispe', 0, u32(width * columns), u32(height * rows)),
      full(
        'tilC',
        0,
        u32(width),
        u32(height),
        Buffer.from([extraDimensionSizes.length]),
        ...extraDimensionSizes.map((size) => u32(size)),
      ),
      ...(hasPredReferences ? [full('rref', 0, Buffer.from([1]), Buffer.from('pred'))] : []),
      ...(relativeLocation
        ? [
            full(
              'rloc',
              0,
              u32(relativeLocation.horizontalOffset),
              u32(relativeLocation.verticalOffset),
            ),
          ]
        : []),
    ],
    propertyAssociationIndexes: [
      0,
      1,
      ...(hasPredReferences ? [2] : []),
      ...(relativeLocation ? [3] : []),
    ],
    dataReference: deti,
    ...(hasPredReferences || relativeLocation
      ? {
          refs: [
            ...(hasPredReferences ? [{ type: 'pred', to: [...predReferenceItemIds] }] : []),
            ...(relativeLocation ? [{ type: 'tbas', to: [predReferenceItemIds[0]!] }] : []),
          ],
        }
      : {}),
  };
}

function makeExternalLhevcTiliHeif(width: number, height: number): Uint8Array {
  return buildHeif([makeExternalLhevcTiliItem(1, width, height, 1)], 1);
}

function makeLhevcItem(
  id: number,
  accessUnit: ReturnType<typeof splitAnnexB>,
  maxWidth: number,
  maxHeight: number,
  width: number,
  height: number,
  levelIdc: number,
  layerIds: readonly number[],
  targetLayerId: number,
  outputLayerSetIndex: number,
  dependencies: ReadonlyMap<number, readonly number[]>,
  predReferenceItemIds: readonly number[] = [],
): Item {
  const slices = accessUnit.filter((nal) => isSliceNal(nal.type));
  const data = Buffer.concat(slices.map((nal) => Buffer.concat([u32(nal.data.length), nal.data])));
  const properties = [
    box('lhvC', makeLhvC(accessUnit)),
    box(
      'oinf',
      makeOinf(
        maxWidth,
        maxHeight,
        levelIdc,
        layerIds,
        targetLayerId,
        outputLayerSetIndex,
        dependencies,
      ),
    ),
    box('tols', Buffer.from([0, 0, 0, 0, outputLayerSetIndex >> 8, outputLayerSetIndex & 0xff])),
    full('ispe', 0, u32(width), u32(height)),
    full('pixi', 0, Buffer.from([3, 8, 8, 8])),
    box('colr', Buffer.concat([Buffer.from('nclx'), u16(1), u16(1), u16(1), Buffer.from([128])])),
  ];
  if (predReferenceItemIds.length > 0)
    properties.push(full('rref', 0, Buffer.from([1]), Buffer.from('pred')));
  return {
    id,
    type: 'lhv1',
    data,
    properties,
    ...(predReferenceItemIds.length > 0
      ? { refs: [{ type: 'pred', to: [...predReferenceItemIds] }] }
      : {}),
  };
}

function makeLhevcPredChainHeif(
  streamAccessUnits: readonly ReturnType<typeof splitAnnexB>[],
  maxWidth: number,
  maxHeight: number,
  width: number,
  height: number,
  levelIdc: number,
  layerIds: readonly number[],
  targetLayerId: number,
  outputLayerSetIndex: number,
  dependencies: ReadonlyMap<number, readonly number[]>,
): Uint8Array {
  const items: Item[] = streamAccessUnits.map((accessUnit, index) =>
    makeLhevcItem(
      index + 1,
      accessUnit,
      maxWidth,
      maxHeight,
      width,
      height,
      levelIdc,
      layerIds,
      targetLayerId,
      outputLayerSetIndex,
      dependencies,
      Array.from({ length: index }, (_, reference) => reference + 1),
    ),
  );
  return buildHeif(items, items.at(-1)!.id);
}

function makeLhevcPredTiliHeif(
  referenceAccessUnit: ReturnType<typeof splitAnnexB>,
  predictedAccessUnit: ReturnType<typeof splitAnnexB>,
  maxWidth: number,
  maxHeight: number,
  width: number,
  height: number,
  levelIdc: number,
  layerIds: readonly number[],
  targetLayerId: number,
  outputLayerSetIndex: number,
  dependencies: ReadonlyMap<number, readonly number[]>,
): Uint8Array {
  const tilePayload = Buffer.concat(
    predictedAccessUnit
      .filter((nal) => isSliceNal(nal.type))
      .map((nal) => Buffer.concat([u32(nal.data.length), nal.data])),
  );
  const tileData = Buffer.alloc(8 + tilePayload.length);
  tileData.writeUInt32BE(8, 0);
  tileData.writeUInt32BE(tilePayload.length, 4);
  tileData.set(tilePayload, 8);

  // The first item's six ipco properties occupy indexes 1–6. tipa indexes
  // below point to the second item's per-tile L-HEVC properties.
  const tipa = full('tipa', 0, Buffer.from([5, 0x89, 0x0a, 0x8b, 0x8c, 0x8d]));
  const tilC = full(
    'tilC',
    0,
    u32(width),
    u32(height),
    Buffer.from([0]),
    Buffer.from('lhv1'),
    tipa,
  );
  const deti = box('deti', Buffer.from([0, 0, 0, 0x18]), Buffer.from([1]), u32(0), u32(8));
  const tileItem: Item = {
    id: 2,
    type: 'tili',
    data: tileData,
    properties: [
      full('ispe', 0, u32(width), u32(height)),
      tilC,
      box('lhvC', makeLhvC(predictedAccessUnit)),
      box(
        'oinf',
        makeOinf(
          maxWidth,
          maxHeight,
          levelIdc,
          layerIds,
          targetLayerId,
          outputLayerSetIndex,
          dependencies,
        ),
      ),
      box('tols', Buffer.from([0, 0, 0, 0, outputLayerSetIndex >> 8, outputLayerSetIndex & 0xff])),
      full('pixi', 0, Buffer.from([3, 8, 8, 8])),
      box('colr', Buffer.concat([Buffer.from('nclx'), u16(1), u16(1), u16(1), Buffer.from([128])])),
      full('rref', 0, Buffer.from([1]), Buffer.from('pred')),
    ],
    propertyAssociationIndexes: [0, 1, 7],
    dataReference: deti,
    refs: [{ type: 'pred', to: [1] }],
  };
  const referenceItem = makeLhevcItem(
    1,
    referenceAccessUnit,
    maxWidth,
    maxHeight,
    width,
    height,
    levelIdc,
    layerIds,
    targetLayerId,
    outputLayerSetIndex,
    dependencies,
  );
  return buildHeif([referenceItem, tileItem], 2);
}

function makeLhevcMultiTilePredHeif(
  referenceAccessUnit: ReturnType<typeof splitAnnexB>,
  predictedAccessUnit: ReturnType<typeof splitAnnexB>,
  maxWidth: number,
  maxHeight: number,
  width: number,
  height: number,
  levelIdc: number,
  layerIds: readonly number[],
  targetLayerId: number,
  outputLayerSetIndex: number,
  dependencies: ReadonlyMap<number, readonly number[]>,
  referenceColumns = 2,
  predictedColumns = 2,
  referenceExtraDimensions: readonly number[] = [],
  predictedExtraDimensions: readonly number[] = [],
  relativeLocation?: { horizontalOffset: number; verticalOffset: number },
): Uint8Array {
  const encodeTileData = (
    accessUnit: ReturnType<typeof splitAnnexB>,
    columns: number,
    extraDimensions: readonly number[],
  ) => {
    const tilePayload = Buffer.concat(
      accessUnit
        .filter((nal) => isSliceNal(nal.type))
        .map((nal) => Buffer.concat([u32(nal.data.length), nal.data])),
    );
    const planeCount = extraDimensions.reduce((count, size) => count * size, 1);
    const tileCount = columns * planeCount;
    const tableSize = tileCount * 8;
    const data = Buffer.alloc(tableSize + tilePayload.length * tileCount);
    for (let tile = 0; tile < tileCount; tile++) {
      const offset = tableSize + tile * tilePayload.length;
      data.writeUInt32BE(offset, tile * 8);
      data.writeUInt32BE(tilePayload.length, tile * 8 + 4);
      tilePayload.copy(data, offset);
    }
    return data;
  };
  const makeItem = (
    id: number,
    accessUnit: ReturnType<typeof splitAnnexB>,
    propertyStart: number,
    pred: boolean,
    columns: number,
    extraDimensions: readonly number[],
  ): Item => {
    const lhvC = propertyStart + 2;
    const oinf = propertyStart + 3;
    const tols = propertyStart + 4;
    const pixi = propertyStart + 5;
    const colr = propertyStart + 6;
    const tileProperties = full(
      'tipa',
      0,
      Buffer.from([
        5,
        ...[lhvC, oinf, tols, pixi, colr].map((index) => {
          assert(index < 0x80, 'synthetic L-HEVC tili property index exceeds tipa range');
          return 0x80 | index;
        }),
      ]),
    );
    const tilC = full(
      'tilC',
      0,
      u32(width),
      u32(height),
      Buffer.from([extraDimensions.length]),
      ...extraDimensions.map((size) => u32(size)),
      Buffer.from('lhv1'),
      tileProperties,
    );
    const itemProperties = [
      full('ispe', 0, u32(width * columns), u32(height)),
      tilC,
      box('lhvC', makeLhvC(accessUnit)),
      box(
        'oinf',
        makeOinf(
          maxWidth,
          maxHeight,
          levelIdc,
          layerIds,
          targetLayerId,
          outputLayerSetIndex,
          dependencies,
        ),
      ),
      box('tols', Buffer.from([0, 0, 0, 0, outputLayerSetIndex >> 8, outputLayerSetIndex & 0xff])),
      full('pixi', 0, Buffer.from([3, 8, 8, 8])),
      box('colr', Buffer.concat([Buffer.from('nclx'), u16(1), u16(1), u16(1), Buffer.from([128])])),
      ...(pred ? [full('rref', 0, Buffer.from([1]), Buffer.from('pred'))] : []),
      ...(pred && relativeLocation
        ? [
            full(
              'rloc',
              0,
              u32(relativeLocation.horizontalOffset),
              u32(relativeLocation.verticalOffset),
            ),
          ]
        : []),
    ];
    const dataReference = box(
      'deti',
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from([columns * extraDimensions.reduce((count, size) => count * size, 1)]),
      u32(0),
      u32(columns * extraDimensions.reduce((count, size) => count * size, 1) * 8),
    );
    return {
      id,
      type: 'tili',
      data: encodeTileData(accessUnit, columns, extraDimensions),
      properties: itemProperties,
      propertyAssociationIndexes: pred ? [0, 1, 7, ...(relativeLocation ? [8] : [])] : [0, 1],
      dataReference,
      ...(pred
        ? {
            refs: [
              { type: 'pred', to: [id - 1] },
              ...(relativeLocation ? [{ type: 'tbas', to: [id - 1] }] : []),
            ],
          }
        : {}),
    } satisfies Item;
  };
  const propertiesPerItem = 7;
  const referenceItem = makeItem(
    1,
    referenceAccessUnit,
    1,
    false,
    referenceColumns,
    referenceExtraDimensions,
  );
  const predictedItem = makeItem(
    2,
    predictedAccessUnit,
    1 + propertiesPerItem,
    true,
    predictedColumns,
    predictedExtraDimensions,
  );
  return buildHeif([referenceItem, predictedItem], 2);
}

function makeLhevcTiliHeif(
  accessUnitNals: ReturnType<typeof splitAnnexB>,
  slices: ReturnType<typeof splitAnnexB>,
  maxWidth: number,
  maxHeight: number,
  width: number,
  height: number,
  levelIdc: number,
): Uint8Array {
  const tilePayload = Buffer.concat(
      slices.map((nal) => Buffer.concat([u32(nal.data.length), nal.data])),
    ),
    itemPayload = Buffer.alloc(8 + tilePayload.length);
  itemPayload.writeUInt32BE(8, 0);
  itemPayload.writeUInt32BE(tilePayload.length, 4);
  itemPayload.set(tilePayload, 8);

  const ftyp = box('ftyp', Buffer.concat([Buffer.from('heix'), u32(0), Buffer.from('mif1heix')])),
    pitm = full('pitm', 0, u16(1)),
    ispe = full('ispe', 0, u32(width), u32(height)),
    pixi = full('pixi', 0, Buffer.from([3, 8, 8, 8])),
    lhvC = box('lhvC', makeLhvC(accessUnitNals)),
    oinf = box('oinf', makeOinf(maxWidth, maxHeight, levelIdc)),
    tols = box('tols', Buffer.from([0, 0, 0, 0, 0, 1])),
    colr = box(
      'colr',
      Buffer.concat([Buffer.from('nclx'), u16(1), u16(1), u16(1), Buffer.from([128])]),
    ),
    tileProperties = [lhvC, oinf, tols, pixi, colr],
    tipa = full(
      'tipa',
      0,
      Buffer.from([
        tileProperties.length,
        0x83, // essential lhvC
        0x04, // non-essential oinf
        0x85, // essential tols
        0x86, // essential pixi
        0x87, // essential colr
      ]),
    ),
    tilC = full('tilC', 0, u32(width), u32(height), Buffer.from([0]), Buffer.from('lhv1'), tipa),
    ipco = box('ipco', ispe, tilC, ...tileProperties),
    ipma = full('ipma', 0, u32(1), u16(1), Buffer.from([2, 0x81, 0x82])),
    iprp = box('iprp', ipco, ipma),
    infe = full('infe', 2, u16(1), u16(0), Buffer.from('tili'), Buffer.from([0])),
    iinf = full('iinf', 0, u16(1), infe),
    deti = box('deti', Buffer.from([0, 0, 0, 0x18]), Buffer.from([1]), u32(0), u32(8)),
    dref = full('dref', 0, u32(1), deti),
    dinf = box('dinf', dref),
    makeIloc = (offset: number) =>
      full(
        'iloc',
        1,
        Buffer.from([0x44, 0]),
        u16(1),
        u16(1),
        u16(0),
        u16(1),
        u16(1),
        u32(offset),
        u32(itemPayload.length),
      ),
    makeMeta = (offset: number) =>
      box('meta', Buffer.alloc(4), pitm, makeIloc(offset), iinf, dinf, iprp),
    meta = makeMeta(ftyp.length + makeMeta(0).length + 8),
    fileOffset = ftyp.length + meta.length + 8;
  return Buffer.concat([ftyp, makeMeta(fileOffset), box('mdat', itemPayload)]);
}

for (const vector of vectors) {
  const response = await fetch(`${baseUrl}/${vector.archiveName}.zip`, {
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `${vector.archiveName}: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  assert.equal(
    sha256(archive),
    vector.archiveSha256,
    `${vector.archiveName}: archive SHA-256 mismatch`,
  );
  const stream = extractZipEntry(archive, findZipEntry(archive, `${vector.archiveName}.bit`));
  assert.equal(
    sha256(stream),
    vector.bitstreamSha256,
    `${vector.archiveName}: bitstream SHA-256 mismatch`,
  );

  const allNals = splitAnnexB(stream);
  const accessUnit = allNals.filter((nal) => [32, 33, 34].includes(nal.type) || nal.type === 19);
  const slices = accessUnit.filter((nal) => nal.type === 19);
  assert.deepEqual(
    slices.map((nal) => nal.layerId),
    [0, 1],
    `${vector.archiveName}: first access unit must contain one IDR slice per layer`,
  );

  const vpsNal = accessUnit.find((nal) => nal.type === 32);
  assert(vpsNal, `${vector.archiveName}: VPS is missing`);
  const vps = parseLayeredVps(vpsNal.data);
  assert.deepEqual(vps.layerIds, [0, 1], `${vector.archiveName}: unexpected layer ids`);
  assert.deepEqual(vps.directReferenceLayerIds?.[1], [0]);

  const targetPpsNal = accessUnit.find((nal) => nal.type === 34 && nal.layerId === 1);
  assert(targetPpsNal, `${vector.archiveName}: layer 1 PPS is missing`);
  const targetPps = parsePps(targetPpsNal.data, {
    allowMultilayerExtension: true,
    layeredVps: vps,
  });
  assert.deepEqual(targetPps.referenceLocationOffsets, [vector.expectedOffsets]);

  const baseSpsNal = accessUnit.find((nal) => nal.type === 33 && nal.layerId === 0);
  assert(baseSpsNal, `${vector.archiveName}: layer 0 SPS is missing`);
  const baseSps = parseSps(baseSpsNal.data, {
    allowBaseLayerMultilayerExtension: true,
    layeredVps: vps,
  });
  const targetSpsNal = accessUnit.find((nal) => nal.type === 33 && nal.layerId === 1);
  assert(targetSpsNal, `${vector.archiveName}: layer 1 SPS is missing`);
  const targetSps = parseSps(targetSpsNal.data, {
    allowBaseLayerMultilayerExtension: true,
    layeredVps: vps,
  });
  assert.deepEqual([baseSps.width, baseSps.height], vector.expectedBaseSize);
  assert.deepEqual([targetSps.width, targetSps.height], vector.expectedEnhancementSize);
  assert.deepEqual(
    [targetSps.picWidthInLumaSamples, targetSps.picHeightInLumaSamples],
    vector.expectedCodedSize,
  );

  const expectedBase = expectedPlaneMd5(
    extractZipEntry(
      archive,
      findZipEntry(archive, `${vector.archiveName}${vector.oplSeparator}OLS0.opl`),
    ).toString('ascii'),
    vector.archiveName,
    0,
  );
  const expectedEnhancement = expectedPlaneMd5(
    extractZipEntry(
      archive,
      findZipEntry(archive, `${vector.archiveName}${vector.oplSeparator}OLS1.opl`),
    ).toString('ascii'),
    vector.archiveName,
    1,
  );
  const basePicture = decodeLayeredHevcPicture(accessUnit, [0], 0);
  assert.deepEqual([basePicture.width, basePicture.height], vector.expectedBaseSize);
  assert.deepEqual(
    planeMd5(basePicture),
    expectedBase,
    `${vector.archiveName}: base-layer MD5 mismatch`,
  );

  const enhancementPicture = decodeLayeredHevcPicture(accessUnit, [0, 1], 1);
  assert.deepEqual([enhancementPicture.width, enhancementPicture.height], vector.expectedCodedSize);
  assert.deepEqual(
    planeMd5(enhancementPicture),
    expectedEnhancement,
    `${vector.archiveName}: resampled enhancement-layer MD5 mismatch`,
  );

  const heif = makeLhevcHeif(
    accessUnit,
    slices,
    targetSps.picWidthInLumaSamples,
    targetSps.picHeightInLumaSamples,
    targetSps.width,
    targetSps.height,
    vector.levelIdc,
  );
  const boxes = parseISOBMFF(heif);
  const info = getHeicInfo(heif, boxes);
  assert.equal(info.primaryItemType, 'lhv1');
  assert.deepEqual(info.lhevc?.requiredLayerIds, [0, 1]);
  const heifPicture = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
  assert.deepEqual(
    planeMd5(heifPicture),
    expectedEnhancement,
    `${vector.archiveName}: L-HEVC HEIF item resampling MD5 mismatch`,
  );
  const tili = makeLhevcTiliHeif(
    accessUnit,
    slices,
    targetSps.picWidthInLumaSamples,
    targetSps.picHeightInLumaSamples,
    targetSps.width,
    targetSps.height,
    vector.levelIdc,
  );
  const tiliBoxes = parseISOBMFF(tili);
  const tiliInfo = getHeicInfo(tili, tiliBoxes);
  assert.equal(tiliInfo.primaryItemType, 'tili');
  assert.equal(tiliInfo.tiledImage?.tileItemType, 'lhv1');
  assert.deepEqual(tiliInfo.lhevc?.requiredLayerIds, [0, 1]);
  const tiliMetadata = getHeicMetadata(tili);
  assert.deepEqual(
    [tiliMetadata.sps?.width, tiliMetadata.sps?.height],
    [targetSps.width, targetSps.height],
  );
  assert.equal(tiliMetadata.sliceNalCount, 1);
  const tiliPicture = decodeItemPlanes(tili, tiliBoxes, tiliInfo, tiliInfo.primaryItemId);
  const subsampling = chromaSubsampling(heifPicture.chromaFormatIdc);
  const expectedTiliPicture = cropPlanes(
    heifPicture,
    subsampling.width * targetSps.cropLeft,
    subsampling.height * targetSps.cropTop,
    targetSps.width,
    targetSps.height,
  );
  assert.deepEqual(
    planeMd5(tiliPicture),
    planeMd5(expectedTiliPicture),
    `${vector.archiveName}: L-HEVC tili resampling MD5 mismatch`,
  );
  const rendered = decodeHeic(heif);
  assert.deepEqual([rendered.width, rendered.height], vector.expectedEnhancementSize);
  assert.equal(rendered.bitDepth, 8);
  const renderedTili = decodeHeic(tili);
  assert.deepEqual(
    [renderedTili.width, renderedTili.height],
    [vector.expectedEnhancementSize[0], vector.expectedEnhancementSize[1]],
  );
  assert.deepEqual(renderedTili.data, rendered.data);

  const externalTili = makeExternalLhevcTiliHeif(targetSps.width, targetSps.height);
  const externalTiliBoxes = parseISOBMFF(externalTili);
  const externalTiliInfo = getHeicInfo(externalTili, externalTiliBoxes);
  assert.equal(externalTiliInfo.primaryItemType, 'tili');
  const externalTileUrl = buildTiledTileUrl(externalTiliInfo.tiledImage!.dataReference, 0);
  const externalTileResources = { [externalTileUrl]: heif };
  const externalTiliPicture = decodeItemPlanes(
    externalTili,
    externalTiliBoxes,
    externalTiliInfo,
    externalTiliInfo.primaryItemId,
    { externalTileData: externalTileResources },
  );
  assert.deepEqual(
    planeMd5(externalTiliPicture),
    planeMd5(expectedTiliPicture),
    `${vector.archiveName}: external L-HEVC tili resampling MD5 mismatch`,
  );
  const renderedExternalTili = decodeHeic(externalTili, {
    externalTileData: externalTileResources,
  });
  assert.deepEqual(renderedExternalTili.data, rendered.data);
  console.log(
    `${vector.archiveName}: L0/L1 POC 0 OPL checksums match; in-file and external lhv1-tili images reproduce L1.`,
  );
}

// This official SHVC vector is classified as a motion-vector-dependency case:
// layer 2 uses layer 0 for motion prediction only and layer 1 for sample
// prediction only. The layered still-image path validates all four access
// units, including the motion-only reference map and the resulting OPL hashes.
const multiReferenceVector = {
  archiveName: 'MVD_A_NOKIA_1',
  archiveSha256: '8be8b39435490ab380efdf20c917829f2644ed90c2bf3b60c2537551403905ed',
  bitstreamSha256: 'f5337c7d810200afaeebea7e34b8446351e61b3c0bf203d0fdfbb05668099529',
  layerIds: [0, 1, 2],
  targetLayerId: 2,
  outputLayerSetIndex: 2,
  levelIdc: 120,
  expectedSize: [1280, 720],
  dependencies: new Map<number, readonly number[]>([
    [0, []],
    [1, [0]],
    [2, [0, 1]],
  ]),
} as const;
const multiResponse = await fetch(`${baseUrl}/${multiReferenceVector.archiveName}.zip`, {
  signal: AbortSignal.timeout(30_000),
});
assert(multiResponse.ok, `${multiReferenceVector.archiveName}: HTTP ${multiResponse.status}`);
const multiArchive = Buffer.from(await multiResponse.arrayBuffer());
assert.equal(sha256(multiArchive), multiReferenceVector.archiveSha256);
const multiStream = extractZipEntry(
  multiArchive,
  findZipEntry(multiArchive, `${multiReferenceVector.archiveName}.bit`),
);
assert.equal(sha256(multiStream), multiReferenceVector.bitstreamSha256);
const multiNals = splitAnnexB(multiStream);
const multiAccessUnits = accessUnits(multiNals);
assert.equal(multiAccessUnits.length, 4, 'MVD_A_NOKIA_1: expected four access units');
const multiAccessUnit = multiAccessUnits[0];
const multiSlices = multiAccessUnit.filter((nal) => nal.type === 19);
assert.deepEqual(
  multiSlices.map((nal) => nal.layerId),
  multiReferenceVector.layerIds,
  'MVD_A_NOKIA_1: first access unit must contain one IDR slice per layer',
);
const multiVpsNal = multiAccessUnit.find((nal) => nal.type === 32);
assert(multiVpsNal, 'MVD_A_NOKIA_1: VPS is missing');
const multiVps = parseLayeredVps(multiVpsNal.data);
assert.deepEqual(multiVps.layerIds, multiReferenceVector.layerIds);
assert.deepEqual(multiVps.directReferenceLayerIds, [[], [0], [0, 1]]);
assert.deepEqual(multiVps.directDependencyTypes, [
  [null, null, null],
  [2, null, null],
  [1, 0, null],
]);
assert.equal(multiVps.maxOneActiveRefLayerFlag, false);
const multiTargetSpsNal = multiAccessUnit.find(
  (nal) => nal.type === 33 && nal.layerId === multiReferenceVector.targetLayerId,
);
const multiTargetPpsNal = multiAccessUnit.find(
  (nal) => nal.type === 34 && nal.layerId === multiReferenceVector.targetLayerId,
);
const multiTargetSlice = multiSlices.find(
  (nal) => nal.layerId === multiReferenceVector.targetLayerId,
);
assert(multiTargetSpsNal, 'MVD_A_NOKIA_1: target-layer SPS is missing');
assert(multiTargetPpsNal, 'MVD_A_NOKIA_1: target-layer PPS is missing');
assert(multiTargetSlice, 'MVD_A_NOKIA_1: target-layer slice is missing');
const multiTargetSps = parseSps(multiTargetSpsNal.data, {
  allowBaseLayerMultilayerExtension: true,
  layeredVps: multiVps,
});
const multiTargetPps = parsePps(multiTargetPpsNal.data, {
  allowMultilayerExtension: true,
  layeredVps: multiVps,
});
const targetLayerIndex = multiVps.layerIds.indexOf(multiReferenceVector.targetLayerId);
assert.notEqual(targetLayerIndex, -1);
const multiTargetHeader = parseSliceHeader(
  multiTargetSlice.data,
  multiTargetSps,
  multiTargetPps,
  undefined,
  {
    defaultRefLayersActiveFlag: multiVps.defaultRefLayersActiveFlag ?? false,
    directReferenceLayerIds: multiVps.directReferenceLayerIds![targetLayerIndex],
    maxOneActiveRefLayerFlag: multiVps.maxOneActiveRefLayerFlag ?? false,
    pocLsbNotPresentFlag: multiVps.pocLsbNotPresentFlags?.[targetLayerIndex] ?? false,
  },
);
assert.equal(multiTargetHeader.interLayerReferenceCount, 2);
assert.deepEqual(multiTargetHeader.interLayerReferenceLayerIds, [0, 1]);
assert.equal(multiTargetHeader.numRefIdxL0ActiveMinus1 + 1, 2);
const expectedMultiLayerHashesByPoc = multiReferenceVector.layerIds.map((layerId) => {
  const opl = extractZipEntry(
    multiArchive,
    findZipEntry(multiArchive, `${multiReferenceVector.archiveName}-OLS${layerId}.opl`),
  ).toString('ascii');
  return multiAccessUnits.map((_, poc) =>
    expectedPlaneMd5(opl, multiReferenceVector.archiveName, layerId, poc),
  );
});
const temporalReferencesByLayer = new Map<number, ReturnType<typeof decodeLayeredHevcPicture>[]>();
for (const layerId of multiReferenceVector.layerIds) temporalReferencesByLayer.set(layerId, []);
for (const [poc, accessUnit] of multiAccessUnits.entries()) {
  const layerOutputs = new Map<number, ReturnType<typeof decodeLayeredHevcPicture>>();
  const referencesForPicture = new Map<number, ReturnType<typeof decodeLayeredHevcPicture>[]>(
    multiReferenceVector.layerIds.map((layerId) => [
      layerId,
      temporalReferencesByLayer.get(layerId)!,
    ]),
  );
  const decoded = decodeLayeredHevcPicture(
    accessUnit,
    multiReferenceVector.layerIds,
    multiReferenceVector.targetLayerId,
    undefined,
    referencesForPicture,
    layerOutputs,
  );
  assert.equal(decoded.pictureOrderCnt, poc, `MVD_A_NOKIA_1: unexpected POC at access unit ${poc}`);
  assert.deepEqual([decoded.width, decoded.height], multiReferenceVector.expectedSize);
  for (const layerId of multiReferenceVector.layerIds) {
    const layer = layerOutputs.get(layerId);
    assert(layer, `MVD_A_NOKIA_1: layer ${layerId} was not retained at POC ${poc}`);
    assert.deepEqual(
      planeMd5(layer),
      expectedMultiLayerHashesByPoc[layerId][poc],
      `MVD_A_NOKIA_1: layer ${layerId} POC ${poc} checksum mismatch`,
    );
    temporalReferencesByLayer.get(layerId)!.push(layer);
  }
}

const multiHeif = makeLhevcPredChainHeif(
  multiAccessUnits,
  multiTargetSps.picWidthInLumaSamples,
  multiTargetSps.picHeightInLumaSamples,
  multiTargetSps.width,
  multiTargetSps.height,
  multiReferenceVector.levelIdc,
  multiReferenceVector.layerIds,
  multiReferenceVector.targetLayerId,
  multiReferenceVector.outputLayerSetIndex,
  multiReferenceVector.dependencies,
);
const multiBoxes = parseISOBMFF(multiHeif);
const multiInfo = getHeicInfo(multiHeif, multiBoxes);
assert.equal(multiInfo.primaryItemType, 'lhv1');
assert.deepEqual(multiInfo.lhevc?.requiredLayerIds, multiReferenceVector.layerIds);
assert.deepEqual(multiInfo.predReferenceItemIds, [1, 2, 3]);
const multiItemPicture = decodeItemPlanes(
  multiHeif,
  multiBoxes,
  multiInfo,
  multiInfo.primaryItemId,
);
assert.equal(multiItemPicture.pictureOrderCnt, 3);
assert.deepEqual(planeMd5(multiItemPicture), expectedMultiLayerHashesByPoc[2][3]);
const multiRendered = decodeHeic(multiHeif);
assert.deepEqual([multiRendered.width, multiRendered.height], multiReferenceVector.expectedSize);
assert.equal(multiRendered.bitDepth, 8);
const multiTili = makeLhevcPredTiliHeif(
  multiAccessUnits[0],
  multiAccessUnits[1],
  multiTargetSps.picWidthInLumaSamples,
  multiTargetSps.picHeightInLumaSamples,
  multiTargetSps.width,
  multiTargetSps.height,
  multiReferenceVector.levelIdc,
  multiReferenceVector.layerIds,
  multiReferenceVector.targetLayerId,
  multiReferenceVector.outputLayerSetIndex,
  multiReferenceVector.dependencies,
);
const multiTiliBoxes = parseISOBMFF(multiTili);
const multiTiliInfo = getHeicInfo(multiTili, multiTiliBoxes);
assert.equal(multiTiliInfo.primaryItemType, 'tili');
assert.equal(multiTiliInfo.tiledImage?.tileItemType, 'lhv1');
assert.deepEqual(multiTiliInfo.predReferenceItemIds, [1]);
const multiTiliPicture = decodeItemPlanes(
  multiTili,
  multiTiliBoxes,
  multiTiliInfo,
  multiTiliInfo.primaryItemId,
);
assert.equal(multiTiliPicture.pictureOrderCnt, 1);
assert.deepEqual(planeMd5(multiTiliPicture), expectedMultiLayerHashesByPoc[2][1]);
const multiTiliRendered = decodeHeic(multiTili);
assert.deepEqual(
  [multiTiliRendered.width, multiTiliRendered.height],
  multiReferenceVector.expectedSize,
);
const externalLhevcPredTili = buildHeif(
  [
    makeExternalLhevcTiliItem(1, multiTargetSps.width, multiTargetSps.height, 910),
    makeExternalLhevcTiliItem(2, multiTargetSps.width, multiTargetSps.height, 911, [1]),
  ],
  2,
);
const externalLhevcPredBoxes = parseISOBMFF(externalLhevcPredTili);
const externalLhevcPredInfo = getHeicInfo(externalLhevcPredTili, externalLhevcPredBoxes);
assert.deepEqual(externalLhevcPredInfo.predReferenceItemIds, [1]);
const externalLhevcReferenceInfo = getHeicInfo(externalLhevcPredTili, externalLhevcPredBoxes, 1);
const externalLhevcReferenceUrl = buildTiledTileUrl(
  externalLhevcReferenceInfo.tiledImage!.dataReference,
  0,
);
const externalLhevcPredUrl = buildTiledTileUrl(externalLhevcPredInfo.tiledImage!.dataReference, 0);
const externalLhevcTileFiles = multiAccessUnits.slice(0, 2).map((accessUnit) =>
  makeLhevcHeif(
    accessUnit,
    accessUnit.filter((nal) => isSliceNal(nal.type)),
    multiTargetSps.picWidthInLumaSamples,
    multiTargetSps.picHeightInLumaSamples,
    multiTargetSps.width,
    multiTargetSps.height,
    multiReferenceVector.levelIdc,
    multiReferenceVector.layerIds,
    multiReferenceVector.targetLayerId,
    multiReferenceVector.outputLayerSetIndex,
    multiReferenceVector.dependencies,
  ),
);
const externalLhevcResources = {
  [externalLhevcReferenceUrl]: externalLhevcTileFiles[0],
  [externalLhevcPredUrl]: externalLhevcTileFiles[1],
};
const externalLhevcPredPicture = decodeItemPlanes(
  externalLhevcPredTili,
  externalLhevcPredBoxes,
  externalLhevcPredInfo,
  externalLhevcPredInfo.primaryItemId,
  { externalTileData: externalLhevcResources },
);
assert.equal(externalLhevcPredPicture.pictureOrderCnt, 1);
assert.deepEqual(
  planeMd5(externalLhevcPredPicture),
  expectedMultiLayerHashesByPoc[2][1],
  'MVD_A_NOKIA_1: external L-HEVC tili POC 1 must use outer pred references per layer',
);
const externalLhevcPredRendered = decodeHeic(externalLhevcPredTili, {
  externalTileData: externalLhevcResources,
});
assert.deepEqual(
  externalLhevcPredRendered.data,
  multiTiliRendered.data,
  'MVD_A_NOKIA_1: external L-HEVC tili rendering must match in-file pred decoding',
);
const multiSpatialTili = makeLhevcMultiTilePredHeif(
  multiAccessUnits[0],
  multiAccessUnits[1],
  multiTargetSps.picWidthInLumaSamples,
  multiTargetSps.picHeightInLumaSamples,
  multiTargetSps.width,
  multiTargetSps.height,
  multiReferenceVector.levelIdc,
  multiReferenceVector.layerIds,
  multiReferenceVector.targetLayerId,
  multiReferenceVector.outputLayerSetIndex,
  multiReferenceVector.dependencies,
);
const multiSpatialTiliBoxes = parseISOBMFF(multiSpatialTili);
const multiSpatialTiliInfo = getHeicInfo(multiSpatialTili, multiSpatialTiliBoxes);
assert.equal(multiSpatialTiliInfo.primaryItemType, 'tili');
assert.deepEqual(
  [multiSpatialTiliInfo.tiledImage?.columns, multiSpatialTiliInfo.tiledImage?.rows],
  [2, 1],
);
const multiSpatialTiliPicture = decodeItemPlanes(
  multiSpatialTili,
  multiSpatialTiliBoxes,
  multiSpatialTiliInfo,
  multiSpatialTiliInfo.primaryItemId,
);
assert.equal(multiSpatialTiliPicture.pictureOrderCnt, 1);
assert.deepEqual(
  [multiSpatialTiliPicture.width, multiSpatialTiliPicture.height],
  [multiReferenceVector.expectedSize[0] * 2, multiReferenceVector.expectedSize[1]],
);
for (const tileX of [0, multiReferenceVector.expectedSize[0]]) {
  assert.deepEqual(
    planeMd5(
      cropPlanes(
        multiSpatialTiliPicture,
        tileX,
        0,
        multiReferenceVector.expectedSize[0],
        multiReferenceVector.expectedSize[1],
      ),
    ),
    expectedMultiLayerHashesByPoc[2][1],
    `MVD_A_NOKIA_1: multi-tile L-HEVC POC 1 tile at x=${tileX} checksum mismatch`,
  );
}
const multiSpatialTiliRendered = decodeHeic(multiSpatialTili);
assert.deepEqual(
  [multiSpatialTiliRendered.width, multiSpatialTiliRendered.height],
  [multiReferenceVector.expectedSize[0] * 2, multiReferenceVector.expectedSize[1]],
);
const multiLayerTileSps = multiReferenceVector.layerIds.map((layerId) => {
  const spsNal = multiAccessUnits[0].find((nal) => nal.type === 33 && nal.layerId === layerId);
  assert(spsNal, `MVD_A_NOKIA_1: layer ${layerId} SPS is missing`);
  return parseSps(spsNal.data, {
    allowBaseLayerMultilayerExtension: true,
    layeredVps: multiVps,
  });
});
const targetSubsampling = chromaSubsampling(multiTargetSps.chromaFormatIdc);
const shiftedRlocOffsetX = Array.from(
  { length: multiTargetSps.width - 1 },
  (_, index) => index + 1,
).find((offset) => {
  if (offset % targetSubsampling.width !== 0) return false;
  const layerOffsets = multiLayerTileSps.map((sps) => (offset * sps.width) / multiTargetSps.width);
  return (
    layerOffsets.every(
      (layerOffset, layer) =>
        Number.isSafeInteger(layerOffset) &&
        layerOffset % chromaSubsampling(multiLayerTileSps[layer].chromaFormatIdc).width === 0,
    ) && layerOffsets.some((layerOffset) => layerOffset % 4 !== 0)
  );
});
assert(shiftedRlocOffsetX, 'MVD_A_NOKIA_1: no non-4x4 chroma-aligned rloc offset is available');
const shiftedMultiLhevcTili = makeLhevcMultiTilePredHeif(
  multiAccessUnits[0],
  multiAccessUnits[1],
  multiTargetSps.picWidthInLumaSamples,
  multiTargetSps.picHeightInLumaSamples,
  multiTargetSps.width,
  multiTargetSps.height,
  multiReferenceVector.levelIdc,
  multiReferenceVector.layerIds,
  multiReferenceVector.targetLayerId,
  multiReferenceVector.outputLayerSetIndex,
  multiReferenceVector.dependencies,
  2,
  1,
  [],
  [],
  { horizontalOffset: shiftedRlocOffsetX, verticalOffset: 0 },
);
const shiftedMultiLhevcBoxes = parseISOBMFF(shiftedMultiLhevcTili);
const shiftedMultiLhevcInfo = getHeicInfo(shiftedMultiLhevcTili, shiftedMultiLhevcBoxes);
assert.deepEqual(shiftedMultiLhevcInfo.predReferenceItemIds, [1]);
assert.deepEqual(shiftedMultiLhevcInfo.relativeLocation, {
  horizontalOffset: shiftedRlocOffsetX,
  verticalOffset: 0,
  relatedItemId: 1,
});
const shiftedMultiLhevcPicture = decodeItemPlanes(
  shiftedMultiLhevcTili,
  shiftedMultiLhevcBoxes,
  shiftedMultiLhevcInfo,
  shiftedMultiLhevcInfo.primaryItemId,
);
assert.equal(shiftedMultiLhevcPicture.pictureOrderCnt, 1);

const shiftedMultiLhevcReferenceInfo = getHeicInfo(
  shiftedMultiLhevcTili,
  shiftedMultiLhevcBoxes,
  1,
);
const shiftedReferenceTileLayers = new Map<number, Map<number, Planes>>();
const shiftedReferencePlanes = stitchTiledImage(
  shiftedMultiLhevcTili,
  shiftedMultiLhevcBoxes,
  shiftedMultiLhevcReferenceInfo,
  shiftedMultiLhevcReferenceInfo.tiledImage!,
  undefined,
  undefined,
  [],
  [],
  undefined,
  [],
  shiftedReferenceTileLayers,
);
const poisonedShiftedReferenceTileLayers = poisonFirstLhevcReferenceMargin(
  shiftedReferenceTileLayers,
  shiftedRlocOffsetX,
  shiftedMultiLhevcReferenceInfo.tiledImage!.tileWidth,
);
const mappedPoisonedShiftedReferenceTileLayers = addEmptyLhevcMotionMaps(
  poisonedShiftedReferenceTileLayers,
);
const poisonedFirstReferenceLayers = mappedPoisonedShiftedReferenceTileLayers.get(0)!;
const shiftedReferenceLayout = {
  itemId: shiftedMultiLhevcReferenceInfo.primaryItemId,
  ...(shiftedMultiLhevcReferenceInfo.relativeLocation
    ? { relativeLocation: shiftedMultiLhevcReferenceInfo.relativeLocation }
    : {}),
  columns: shiftedMultiLhevcReferenceInfo.tiledImage!.columns,
  rows: shiftedMultiLhevcReferenceInfo.tiledImage!.rows,
  tileWidth: shiftedMultiLhevcReferenceInfo.tiledImage!.tileWidth,
  tileHeight: shiftedMultiLhevcReferenceInfo.tiledImage!.tileHeight,
  extraDimensionSizes: [...shiftedMultiLhevcReferenceInfo.tiledImage!.extraDimensionSizes],
  selectedExtraDimensionIndexes: [],
  selectedTileIndexes: getTiledImageTileIndices(shiftedMultiLhevcReferenceInfo.tiledImage!),
  tilesByIndex: mappedPoisonedShiftedReferenceTileLayers,
};
const shiftedDirectPicture = stitchTiledImage(
  shiftedMultiLhevcTili,
  shiftedMultiLhevcBoxes,
  shiftedMultiLhevcInfo,
  shiftedMultiLhevcInfo.tiledImage!,
  undefined,
  undefined,
  [shiftedReferencePlanes],
  [poisonedFirstReferenceLayers],
  undefined,
  [shiftedReferenceLayout],
);
assert.deepEqual(
  planeMd5(shiftedDirectPicture),
  planeMd5(shiftedMultiLhevcPicture),
  'MVD_A_NOKIA_1: L-HEVC rloc must skip the poisoned margin and stitch across the reference tile boundary',
);
const unshiftedInfo = { ...shiftedMultiLhevcInfo, relativeLocation: undefined };
const unshiftedDirectPicture = stitchTiledImage(
  shiftedMultiLhevcTili,
  shiftedMultiLhevcBoxes,
  unshiftedInfo,
  shiftedMultiLhevcInfo.tiledImage!,
  undefined,
  undefined,
  [shiftedReferencePlanes],
  [poisonedFirstReferenceLayers],
  undefined,
  [shiftedReferenceLayout],
);
assert.notDeepEqual(
  planeMd5(unshiftedDirectPicture),
  planeMd5(shiftedMultiLhevcPicture),
  'MVD_A_NOKIA_1: the adversarial margin must distinguish an origin reference from the rloc region',
);
const shiftedExternalLhevcTili = buildHeif(
  [
    makeExternalLhevcTiliItem(1, multiTargetSps.width, multiTargetSps.height, 940, [], 2),
    makeExternalLhevcTiliItem(2, multiTargetSps.width, multiTargetSps.height, 950, [1], 1, 1, [], {
      horizontalOffset: shiftedRlocOffsetX,
      verticalOffset: 0,
    }),
  ],
  2,
);
const shiftedExternalLhevcBoxes = parseISOBMFF(shiftedExternalLhevcTili);
const shiftedExternalLhevcInfo = getHeicInfo(shiftedExternalLhevcTili, shiftedExternalLhevcBoxes);
const shiftedExternalLhevcReferenceInfo = getHeicInfo(
  shiftedExternalLhevcTili,
  shiftedExternalLhevcBoxes,
  1,
);
const shiftedExternalLhevcResources: Record<string, Uint8Array> = {};
for (let tileIndex = 0; tileIndex < 2; tileIndex++)
  shiftedExternalLhevcResources[
    buildTiledTileUrl(shiftedExternalLhevcReferenceInfo.tiledImage!.dataReference, tileIndex)
  ] = externalLhevcTileFiles[0];
shiftedExternalLhevcResources[
  buildTiledTileUrl(shiftedExternalLhevcInfo.tiledImage!.dataReference, 0)
] = externalLhevcTileFiles[1];
const shiftedExternalLhevcPicture = decodeItemPlanes(
  shiftedExternalLhevcTili,
  shiftedExternalLhevcBoxes,
  shiftedExternalLhevcInfo,
  shiftedExternalLhevcInfo.primaryItemId,
  { externalTileData: shiftedExternalLhevcResources },
);
assert.equal(shiftedExternalLhevcPicture.pictureOrderCnt, 1);
assert.deepEqual(
  planeMd5(shiftedExternalLhevcPicture),
  planeMd5(shiftedMultiLhevcPicture),
  'MVD_A_NOKIA_1: in-file and external L-HEVC tili rloc results must match',
);
const shiftedExternalReferenceTileLayers = new Map<number, Map<number, Planes>>();
const shiftedExternalReferencePlanes = stitchTiledImage(
  shiftedExternalLhevcTili,
  shiftedExternalLhevcBoxes,
  shiftedExternalLhevcReferenceInfo,
  shiftedExternalLhevcReferenceInfo.tiledImage!,
  shiftedExternalLhevcResources,
  undefined,
  [],
  [],
  undefined,
  [],
  shiftedExternalReferenceTileLayers,
);
const poisonedShiftedExternalReferenceTileLayers = poisonFirstLhevcReferenceMargin(
  shiftedExternalReferenceTileLayers,
  shiftedRlocOffsetX,
  shiftedExternalLhevcReferenceInfo.tiledImage!.tileWidth,
);
const mappedPoisonedShiftedExternalReferenceTileLayers = addEmptyLhevcMotionMaps(
  poisonedShiftedExternalReferenceTileLayers,
);
const shiftedExternalReferenceLayout = {
  itemId: shiftedExternalLhevcReferenceInfo.primaryItemId,
  ...(shiftedExternalLhevcReferenceInfo.relativeLocation
    ? { relativeLocation: shiftedExternalLhevcReferenceInfo.relativeLocation }
    : {}),
  columns: shiftedExternalLhevcReferenceInfo.tiledImage!.columns,
  rows: shiftedExternalLhevcReferenceInfo.tiledImage!.rows,
  tileWidth: shiftedExternalLhevcReferenceInfo.tiledImage!.tileWidth,
  tileHeight: shiftedExternalLhevcReferenceInfo.tiledImage!.tileHeight,
  extraDimensionSizes: [...shiftedExternalLhevcReferenceInfo.tiledImage!.extraDimensionSizes],
  selectedExtraDimensionIndexes: [],
  selectedTileIndexes: getTiledImageTileIndices(shiftedExternalLhevcReferenceInfo.tiledImage!),
  tilesByIndex: mappedPoisonedShiftedExternalReferenceTileLayers,
};
const shiftedExternalDirectPicture = stitchTiledImage(
  shiftedExternalLhevcTili,
  shiftedExternalLhevcBoxes,
  shiftedExternalLhevcInfo,
  shiftedExternalLhevcInfo.tiledImage!,
  shiftedExternalLhevcResources,
  undefined,
  [shiftedExternalReferencePlanes],
  [mappedPoisonedShiftedExternalReferenceTileLayers.get(0)!],
  undefined,
  [shiftedExternalReferenceLayout],
);
assert.deepEqual(
  planeMd5(shiftedExternalDirectPicture),
  planeMd5(shiftedExternalLhevcPicture),
  'MVD_A_NOKIA_1: external L-HEVC rloc must skip the poisoned margin across a tile boundary',
);
const externalMultiLhevcPredTili = buildHeif(
  [
    makeExternalLhevcTiliItem(1, multiTargetSps.width, multiTargetSps.height, 920, [], 2),
    makeExternalLhevcTiliItem(2, multiTargetSps.width, multiTargetSps.height, 930, [1], 2),
  ],
  2,
);
const externalMultiLhevcBoxes = parseISOBMFF(externalMultiLhevcPredTili);
const externalMultiLhevcInfo = getHeicInfo(externalMultiLhevcPredTili, externalMultiLhevcBoxes);
const externalMultiLhevcReferenceInfo = getHeicInfo(
  externalMultiLhevcPredTili,
  externalMultiLhevcBoxes,
  1,
);
const externalMultiLhevcResources: Record<string, Uint8Array> = {};
for (let tileIndex = 0; tileIndex < 2; tileIndex++) {
  externalMultiLhevcResources[
    buildTiledTileUrl(externalMultiLhevcReferenceInfo.tiledImage!.dataReference, tileIndex)
  ] = externalLhevcTileFiles[0];
  externalMultiLhevcResources[
    buildTiledTileUrl(externalMultiLhevcInfo.tiledImage!.dataReference, tileIndex)
  ] = externalLhevcTileFiles[1];
}
const externalMultiLhevcPicture = decodeItemPlanes(
  externalMultiLhevcPredTili,
  externalMultiLhevcBoxes,
  externalMultiLhevcInfo,
  externalMultiLhevcInfo.primaryItemId,
  { externalTileData: externalMultiLhevcResources },
);
assert.equal(externalMultiLhevcPicture.pictureOrderCnt, 1);
assert.deepEqual(
  [externalMultiLhevcPicture.width, externalMultiLhevcPicture.height],
  [multiReferenceVector.expectedSize[0] * 2, multiReferenceVector.expectedSize[1]],
);
for (const tileX of [0, multiReferenceVector.expectedSize[0]])
  assert.deepEqual(
    planeMd5(
      cropPlanes(
        externalMultiLhevcPicture,
        tileX,
        0,
        multiReferenceVector.expectedSize[0],
        multiReferenceVector.expectedSize[1],
      ),
    ),
    expectedMultiLayerHashesByPoc[2][1],
    `MVD_A_NOKIA_1: external multi-tile L-HEVC POC 1 tile at x=${tileX} checksum mismatch`,
  );
const externalMultiLhevcRendered = decodeHeic(externalMultiLhevcPredTili, {
  externalTileData: externalMultiLhevcResources,
});
assert.deepEqual(externalMultiLhevcRendered.data, multiSpatialTiliRendered.data);
const multiGridTili = makeLhevcMultiTilePredHeif(
  multiAccessUnits[0],
  multiAccessUnits[1],
  multiTargetSps.picWidthInLumaSamples,
  multiTargetSps.picHeightInLumaSamples,
  multiTargetSps.width,
  multiTargetSps.height,
  multiReferenceVector.levelIdc,
  multiReferenceVector.layerIds,
  multiReferenceVector.targetLayerId,
  multiReferenceVector.outputLayerSetIndex,
  multiReferenceVector.dependencies,
  2,
  1,
);
const multiGridTiliBoxes = parseISOBMFF(multiGridTili);
const multiGridTiliInfo = getHeicInfo(multiGridTili, multiGridTiliBoxes);
assert.deepEqual(
  [multiGridTiliInfo.tiledImage?.columns, multiGridTiliInfo.predReferenceItemIds],
  [1, [1]],
);
const multiGridTiliPicture = decodeItemPlanes(
  multiGridTili,
  multiGridTiliBoxes,
  multiGridTiliInfo,
  multiGridTiliInfo.primaryItemId,
);
assert.equal(multiGridTiliPicture.pictureOrderCnt, 1);
assert.deepEqual(planeMd5(multiGridTiliPicture), expectedMultiLayerHashesByPoc[2][1]);
const multiGridTiliRendered = decodeHeic(multiGridTili);
assert.deepEqual(
  [multiGridTiliRendered.width, multiGridTiliRendered.height],
  multiReferenceVector.expectedSize,
);

const multiDimensionalGridTili = makeLhevcMultiTilePredHeif(
  multiAccessUnits[0],
  multiAccessUnits[1],
  multiTargetSps.picWidthInLumaSamples,
  multiTargetSps.picHeightInLumaSamples,
  multiTargetSps.width,
  multiTargetSps.height,
  multiReferenceVector.levelIdc,
  multiReferenceVector.layerIds,
  multiReferenceVector.targetLayerId,
  multiReferenceVector.outputLayerSetIndex,
  multiReferenceVector.dependencies,
  2,
  1,
  [2, 3],
  [3, 2],
);
const multiDimensionalGridBoxes = parseISOBMFF(multiDimensionalGridTili);
const multiDimensionalGridInfo = getHeicInfo(multiDimensionalGridTili, multiDimensionalGridBoxes);
assert.deepEqual(multiDimensionalGridInfo.tiledImage?.extraDimensionSizes, [3, 2]);
const multiDimensionalGridPicture = decodeItemPlanes(
  multiDimensionalGridTili,
  multiDimensionalGridBoxes,
  multiDimensionalGridInfo,
  multiDimensionalGridInfo.primaryItemId,
  { extraDimensionIndexes: [1, 0] },
);
assert.equal(multiDimensionalGridPicture.pictureOrderCnt, 1);
assert.deepEqual(
  planeMd5(multiDimensionalGridPicture),
  expectedMultiLayerHashesByPoc[2][1],
  'MVD_A_NOKIA_1: multi-tile L-HEVC temporal reference must map the selected extra-dimension plane',
);
const multiDimensionalGridRendered = decodeHeic(multiDimensionalGridTili, {
  extraDimensionIndexes: [1, 0],
});
assert.deepEqual(
  [multiDimensionalGridRendered.width, multiDimensionalGridRendered.height],
  multiReferenceVector.expectedSize,
);
const multiDimensionalSameGridTili = makeLhevcMultiTilePredHeif(
  multiAccessUnits[0],
  multiAccessUnits[1],
  multiTargetSps.picWidthInLumaSamples,
  multiTargetSps.picHeightInLumaSamples,
  multiTargetSps.width,
  multiTargetSps.height,
  multiReferenceVector.levelIdc,
  multiReferenceVector.layerIds,
  multiReferenceVector.targetLayerId,
  multiReferenceVector.outputLayerSetIndex,
  multiReferenceVector.dependencies,
  2,
  2,
  [2, 3],
  [3, 2],
);
const multiDimensionalSameGridBoxes = parseISOBMFF(multiDimensionalSameGridTili);
const multiDimensionalSameGridInfo = getHeicInfo(
  multiDimensionalSameGridTili,
  multiDimensionalSameGridBoxes,
);
assert.deepEqual(multiDimensionalSameGridInfo.tiledImage?.extraDimensionSizes, [3, 2]);
const multiDimensionalSameGridPicture = decodeItemPlanes(
  multiDimensionalSameGridTili,
  multiDimensionalSameGridBoxes,
  multiDimensionalSameGridInfo,
  multiDimensionalSameGridInfo.primaryItemId,
  { extraDimensionIndexes: [1, 0] },
);
assert.equal(multiDimensionalSameGridPicture.pictureOrderCnt, 1);
assert.deepEqual(
  [multiDimensionalSameGridPicture.width, multiDimensionalSameGridPicture.height],
  [multiReferenceVector.expectedSize[0] * 2, multiReferenceVector.expectedSize[1]],
);
for (const tileX of [0, multiReferenceVector.expectedSize[0]]) {
  assert.deepEqual(
    planeMd5(
      cropPlanes(
        multiDimensionalSameGridPicture,
        tileX,
        0,
        multiReferenceVector.expectedSize[0],
        multiReferenceVector.expectedSize[1],
      ),
    ),
    expectedMultiLayerHashesByPoc[2][1],
    `MVD_A_NOKIA_1: same-grid L-HEVC tile at x=${tileX} must map differing extra-dimension shapes by coordinate`,
  );
}
const multiDimensionalSameGridRendered = decodeHeic(multiDimensionalSameGridTili, {
  extraDimensionIndexes: [1, 0],
});
assert.deepEqual(
  [multiDimensionalSameGridRendered.width, multiDimensionalSameGridRendered.height],
  [multiReferenceVector.expectedSize[0] * 2, multiReferenceVector.expectedSize[1]],
);
const externalDifferentShapeTili = buildHeif(
  [
    makeExternalLhevcTiliItem(
      1,
      multiTargetSps.width,
      multiTargetSps.height,
      1500,
      [],
      2,
      1,
      [2, 3],
    ),
    makeExternalLhevcTiliItem(
      2,
      multiTargetSps.width,
      multiTargetSps.height,
      1600,
      [1],
      1,
      1,
      [3, 2],
    ),
  ],
  2,
);
const externalDifferentShapeBoxes = parseISOBMFF(externalDifferentShapeTili);
const externalDifferentShapeInfo = getHeicInfo(
  externalDifferentShapeTili,
  externalDifferentShapeBoxes,
  2,
);
const externalDifferentShapeReferenceInfo = getHeicInfo(
  externalDifferentShapeTili,
  externalDifferentShapeBoxes,
  1,
);
assert.deepEqual(externalDifferentShapeInfo.tiledImage?.extraDimensionSizes, [3, 2]);
assert.deepEqual(externalDifferentShapeReferenceInfo.tiledImage?.extraDimensionSizes, [2, 3]);
const externalDifferentShapeResources: Record<string, Uint8Array> = {};
for (const tileIndex of getTiledImageTileIndices(
  externalDifferentShapeReferenceInfo.tiledImage!,
  [1, 0],
))
  externalDifferentShapeResources[
    buildTiledTileUrl(externalDifferentShapeReferenceInfo.tiledImage!.dataReference, tileIndex)
  ] = externalLhevcTileFiles[0];
for (const tileIndex of getTiledImageTileIndices(externalDifferentShapeInfo.tiledImage!, [1, 0]))
  externalDifferentShapeResources[
    buildTiledTileUrl(externalDifferentShapeInfo.tiledImage!.dataReference, tileIndex)
  ] = externalLhevcTileFiles[1];
const externalDifferentShapePicture = decodeItemPlanes(
  externalDifferentShapeTili,
  externalDifferentShapeBoxes,
  externalDifferentShapeInfo,
  externalDifferentShapeInfo.primaryItemId,
  {
    externalTileData: externalDifferentShapeResources,
    extraDimensionIndexes: [1, 0],
  },
);
assert.equal(externalDifferentShapePicture.pictureOrderCnt, 1);
assert.deepEqual(
  planeMd5(externalDifferentShapePicture),
  expectedMultiLayerHashesByPoc[2][1],
  'MVD_A_NOKIA_1: external L-HEVC tili must map the selected coordinate across different grid shapes',
);
const externalDifferentShapeRendered = decodeHeic(externalDifferentShapeTili, {
  externalTileData: externalDifferentShapeResources,
  extraDimensionIndexes: [1, 0],
});
assert.deepEqual(
  externalDifferentShapeRendered.data,
  multiDimensionalGridRendered.data,
  'MVD_A_NOKIA_1: external and in-file differently shaped L-HEVC grids must render identically',
);
console.log(
  `MVD_A_NOKIA_1: layers 0/1/2 at POC 0–3 match OPL checksums; synthetic lhv1 pred chains reproduce POC 3, and in-file/external lhv1 tili covers matching, origin-aligned, sub-4x4 rloc x=${shiftedRlocOffsetX}, and same-coordinate extra-dimension mappings.`,
);

// Layer 1 is inter-predicted from layer 0, then the spatially upsampled layer
// 2 uses layer 1 as its inter-layer predictor. This exercises Annex H motion
// and mode resampling from a non-identity reference layer in a still AU.
const motionResamplingVector = {
  archiveName: 'CONFCROP_C_VIDYO_3',
  archiveSha256: 'a46f49f45041b957510e8b496ec7855470eeaae3d6500b17c50c2cb69da656a0',
  bitstreamSha256: 'c18571e4663246059de06c1aa348b7be636d7517ad0984b2ab5951d7719106df',
  layerIds: [0, 1, 2],
  targetLayerId: 2,
  outputLayerSetIndex: 2,
  levelIdc: 120,
  expectedTargetSize: [1920, 1080],
  expectedVisibleSize: [1760, 900],
  dependencies: new Map<number, readonly number[]>([
    [0, []],
    [1, [0]],
    [2, [1]],
  ]),
} as const;
const motionResponse = await fetch(`${baseUrl}/${motionResamplingVector.archiveName}.zip`, {
  signal: AbortSignal.timeout(30_000),
});
assert(motionResponse.ok, `${motionResamplingVector.archiveName}: HTTP ${motionResponse.status}`);
const motionArchive = Buffer.from(await motionResponse.arrayBuffer());
assert.equal(
  sha256(motionArchive),
  motionResamplingVector.archiveSha256,
  `${motionResamplingVector.archiveName}: archive SHA-256 mismatch`,
);
const motionStream = extractZipEntry(
  motionArchive,
  findZipEntry(motionArchive, `${motionResamplingVector.archiveName}.bit`),
);
assert.equal(
  sha256(motionStream),
  motionResamplingVector.bitstreamSha256,
  `${motionResamplingVector.archiveName}: bitstream SHA-256 mismatch`,
);
const motionAccessUnit = firstAccessUnit(splitAnnexB(motionStream));
const motionSlices = motionAccessUnit.filter((nal) => nal.type <= 31);
assert.deepEqual(
  [...new Set(motionSlices.map((nal) => nal.layerId))],
  motionResamplingVector.layerIds,
  `${motionResamplingVector.archiveName}: first AU layer set mismatch`,
);
const motionVpsNal = motionAccessUnit.find((nal) => nal.type === 32);
assert(motionVpsNal, `${motionResamplingVector.archiveName}: VPS is missing`);
const motionVps = parseLayeredVps(motionVpsNal.data);
assert.deepEqual(motionVps.layerIds, motionResamplingVector.layerIds);
assert.deepEqual(motionVps.directReferenceLayerIds, [[], [0], [1]]);

const motionLayer1SpsNal = motionAccessUnit.find((nal) => nal.type === 33 && nal.layerId === 1);
const motionTargetSpsNal = motionAccessUnit.find(
  (nal) => nal.type === 33 && nal.layerId === motionResamplingVector.targetLayerId,
);
const motionLayer1PpsNal = motionAccessUnit.find((nal) => nal.type === 34 && nal.layerId === 1);
const motionTargetPpsNal = motionAccessUnit.find(
  (nal) => nal.type === 34 && nal.layerId === motionResamplingVector.targetLayerId,
);
const motionLayer1Slice = motionSlices.find((nal) => nal.layerId === 1);
const motionTargetSlice = motionSlices.find(
  (nal) => nal.layerId === motionResamplingVector.targetLayerId,
);
assert(motionLayer1SpsNal && motionLayer1PpsNal && motionLayer1Slice);
assert(motionTargetSpsNal && motionTargetPpsNal && motionTargetSlice);
const motionLayer1Sps = parseSps(motionLayer1SpsNal.data, {
  allowBaseLayerMultilayerExtension: true,
  layeredVps: motionVps,
});
const motionLayer1Pps = parsePps(motionLayer1PpsNal.data, {
  allowMultilayerExtension: true,
  layeredVps: motionVps,
});
const motionTargetSps = parseSps(motionTargetSpsNal.data, {
  allowBaseLayerMultilayerExtension: true,
  layeredVps: motionVps,
});
const motionTargetPps = parsePps(motionTargetPpsNal.data, {
  allowMultilayerExtension: true,
  layeredVps: motionVps,
});
assert.deepEqual(
  [motionLayer1Sps.picWidthInLumaSamples, motionLayer1Sps.picHeightInLumaSamples],
  [1280, 720],
);
assert.deepEqual(
  [motionTargetSps.picWidthInLumaSamples, motionTargetSps.picHeightInLumaSamples],
  motionResamplingVector.expectedTargetSize,
);
const motionLayer1Header = parseSliceHeader(
  motionLayer1Slice.data,
  motionLayer1Sps,
  motionLayer1Pps,
  undefined,
  {
    defaultRefLayersActiveFlag: motionVps.defaultRefLayersActiveFlag ?? false,
    directReferenceLayerIds: motionVps.directReferenceLayerIds![1],
    maxOneActiveRefLayerFlag: motionVps.maxOneActiveRefLayerFlag ?? false,
    pocLsbNotPresentFlag: motionVps.pocLsbNotPresentFlags?.[1] ?? false,
  },
);
assert.equal(motionLayer1Header.sliceType, SLICE_TYPE_P);
const motionTargetHeader = parseSliceHeader(
  motionTargetSlice.data,
  motionTargetSps,
  motionTargetPps,
  undefined,
  {
    defaultRefLayersActiveFlag: motionVps.defaultRefLayersActiveFlag ?? false,
    directReferenceLayerIds: motionVps.directReferenceLayerIds![2],
    maxOneActiveRefLayerFlag: motionVps.maxOneActiveRefLayerFlag ?? false,
    pocLsbNotPresentFlag: motionVps.pocLsbNotPresentFlags?.[2] ?? false,
  },
);
assert.deepEqual(motionTargetHeader.interLayerReferenceLayerIds, [1]);
assert.equal(motionTargetHeader.sliceType, SLICE_TYPE_P);
assert.equal(
  motionTargetHeader.shortTermRefPicSet?.usedByCurrPicS0.some(Boolean) ?? false,
  false,
  'CONFCROP_C_VIDYO_3: layer 2 must not need a temporal L0 reference in POC 0',
);

const expectedMotionTarget = expectedPlaneMd5(
  extractZipEntry(
    motionArchive,
    findZipEntry(motionArchive, `${motionResamplingVector.archiveName}-OLS2.opl`),
  ).toString('ascii'),
  motionResamplingVector.archiveName,
  motionResamplingVector.targetLayerId,
);
const motionLayer1 = decodeLayeredHevcPicture(motionAccessUnit, [0, 1], 1);
assert.equal(motionLayer1.hasExternalInterMotion, true);
const resampledMotionPicture = decodeLayeredHevcPicture(
  motionAccessUnit,
  [0, 1, 2],
  motionResamplingVector.targetLayerId,
);
assert.deepEqual(
  planeMd5(resampledMotionPicture),
  expectedMotionTarget,
  'CONFCROP_C_VIDYO_3: Annex H motion-resampled layer 2 POC 0 checksum mismatch',
);

const motionHeif = makeLhevcHeif(
  motionAccessUnit,
  motionSlices,
  motionTargetSps.picWidthInLumaSamples,
  motionTargetSps.picHeightInLumaSamples,
  motionTargetSps.width,
  motionTargetSps.height,
  motionResamplingVector.levelIdc,
  motionResamplingVector.layerIds,
  motionResamplingVector.targetLayerId,
  motionResamplingVector.outputLayerSetIndex,
  motionResamplingVector.dependencies,
);
const motionHeifBoxes = parseISOBMFF(motionHeif);
const motionHeifInfo = getHeicInfo(motionHeif, motionHeifBoxes);
const motionHeifPicture = decodeItemPlanes(
  motionHeif,
  motionHeifBoxes,
  motionHeifInfo,
  motionHeifInfo.primaryItemId,
);
assert.deepEqual(planeMd5(motionHeifPicture), expectedMotionTarget);
const motionRendered = decodeHeic(motionHeif);
assert.deepEqual(
  [motionRendered.width, motionRendered.height],
  motionResamplingVector.expectedVisibleSize,
);
console.log(
  'CONFCROP_C_VIDYO_3: layer 1 motion is resampled into layer 2; POC 0 Y/Cb/Cr match official OPL hashes through raw L-HEVC and synthetic lhv1 paths.',
);
