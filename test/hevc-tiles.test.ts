import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'bun:test';
import { getHeicInfo, getItemPayload } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { splitLengthPrefixed, isSliceNal } from '../src/hevc/nal';
import { parsePps } from '../src/hevc/pps';
import { parseSliceHeader } from '../src/hevc/slice-header';
import { parseSps } from '../src/hevc/sps';
import { decodeItemPlanes } from '../src/planes';
import type { PpsInfo } from '../src/hevc/pps';
import { deriveTileLayout } from '../src/hevc/tiles';

const fixture = (name: string): Buffer =>
  readFileSync(join(import.meta.dir, 'fixtures', 'conformance', name));

it('derives non-uniform HEVC tile dimensions and both CTB scan maps', () => {
  const pps = {
    tilesEnabled: true,
    numTileColumns: 2,
    numTileRows: 2,
    uniformSpacing: false,
    tileColumnWidths: [2],
    tileRowHeights: [1],
  } as unknown as PpsInfo;
  const layout = deriveTileLayout(5, 4, pps);

  expect(layout.columnWidths).toEqual([2, 3]);
  expect(layout.rowHeights).toEqual([1, 3]);
  expect(Array.from(layout.rasterToTileScan)).toEqual([
    0, 1, 2, 3, 4, 5, 6, 11, 12, 13, 7, 8, 14, 15, 16, 9, 10, 17, 18, 19,
  ]);
  expect(Array.from(layout.tileScanToRaster)).toEqual([
    0, 1, 2, 3, 4, 5, 6, 10, 11, 15, 16, 7, 8, 9, 12, 13, 14, 17, 18, 19,
  ]);
  expect(Array.from(layout.tileIdByCtb)).toEqual([
    0, 0, 1, 1, 1, 2, 2, 3, 3, 3, 2, 2, 3, 3, 3, 2, 2, 3, 3, 3,
  ]);
});

it('decodes the official High Throughput vector with both tiles and WPP enabled', () => {
  const input = fixture('wpp-tiles-high-tp-8-i.heic');
  const boxes = parseISOBMFF(input);
  const info = getHeicInfo(input, boxes);
  const sps = parseSps(info.hvcC!.sps[0]);
  const pps = parsePps(info.hvcC!.pps[0]);
  const payload = getItemPayload(input, boxes, info.primaryItemId)!;
  const slices = splitLengthPrefixed(payload, info.hvcC!.nalLengthSize)
    .filter((nal) => isSliceNal(nal.type))
    .map((nal) => nal.data);

  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples, sps.bitDepthLuma]).toEqual([
    1024, 768, 8,
  ]);
  expect(info.hvcC!.generalProfileIdc).toBe(5);
  expect(sps.chromaFormatIdc).toBe(1);
  expect(pps.tilesEnabled).toBe(true);
  expect([pps.numTileColumns, pps.numTileRows]).toEqual([2, 1]);
  expect(pps.entropyCodingSyncEnabled).toBe(true);
  expect(slices).toHaveLength(1);
  expect(parseSliceHeader(slices[0], sps, pps).substreams).toHaveLength(24);

  const planes = decodeItemPlanes(input, boxes, info, info.primaryItemId);
  const actual = Buffer.concat([
    Buffer.from(planes.y),
    Buffer.from(planes.cb),
    Buffer.from(planes.cr),
  ]);
  const reference = fixture('wpp-tiles-high-tp-8-i.yuv');
  expect([planes.width, planes.height, planes.chromaFormatIdc]).toEqual([1024, 768, 1]);
  expect(actual).toEqual(reference);
  expect(createHash('md5').update(actual).digest('hex')).toBe('31ec266d850af20d08bd1c594bf9552c');
});

it('decodes the official 10-bit 4:2:2 High Throughput tiles+WPP vector', () => {
  const input = fixture('wpp-tiles-high-tp-10-422-i.heic');
  const boxes = parseISOBMFF(input);
  const info = getHeicInfo(input, boxes);
  const sps = parseSps(info.hvcC!.sps[0]);
  const pps = parsePps(info.hvcC!.pps[0]);
  const payload = getItemPayload(input, boxes, info.primaryItemId)!;
  const slices = splitLengthPrefixed(payload, info.hvcC!.nalLengthSize)
    .filter((nal) => isSliceNal(nal.type))
    .map((nal) => nal.data);

  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples, sps.bitDepthLuma]).toEqual([
    1920, 1080, 10,
  ]);
  expect(sps.chromaFormatIdc).toBe(2);
  expect(info.hvcC!.generalProfileIdc).toBe(5);
  expect(pps.tilesEnabled).toBe(true);
  expect([pps.numTileColumns, pps.numTileRows]).toEqual([2, 1]);
  expect(pps.entropyCodingSyncEnabled).toBe(true);
  expect(slices).toHaveLength(1);
  expect(parseSliceHeader(slices[0], sps, pps).substreams).toHaveLength(34);

  const planes = decodeItemPlanes(input, boxes, info, info.primaryItemId);
  const bytes = (plane: Uint8Array | Uint16Array) =>
    Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength);
  const actual = Buffer.concat([bytes(planes.y), bytes(planes.cb), bytes(planes.cr)]);
  const reference = fixture('wpp-tiles-high-tp-10-422-i.yuv');
  expect([planes.width, planes.height, planes.chromaFormatIdc]).toEqual([1920, 1080, 2]);
  expect(actual).toEqual(reference);
  expect(createHash('md5').update(actual).digest('hex')).toBe('9983e2ea1c4959a17ee45b5bd0d72198');
});
