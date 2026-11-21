import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'bun:test';
import { getHeicInfo, getItemPayload } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { deblockPicture } from '../src/hevc/deblock';
import { isSliceNal, splitLengthPrefixed } from '../src/hevc/nal';
import { PictureDecoder } from '../src/hevc/picture';
import { parsePps } from '../src/hevc/pps';
import { applySao } from '../src/hevc/sao';
import { parseSliceHeader } from '../src/hevc/slice-header';
import { parseSps } from '../src/hevc/sps';
import { decodeHeic } from '../src/decoder';

const fixture = (name: string): Buffer =>
  readFileSync(join(import.meta.dir, 'fixtures', 'conformance', name));

it('decodes all independent slices in the official H.265.1 SLICES_A first picture', () => {
  const input = fixture('slices-rovi3-i.heic');
  const boxes = parseISOBMFF(input);
  const info = getHeicInfo(input, boxes);
  const sps = parseSps(info.hvcC!.sps[0]);
  const pps = parsePps(info.hvcC!.pps[0]);
  const payload = getItemPayload(input, boxes, info.primaryItemId)!;
  const slices = splitLengthPrefixed(payload, info.hvcC!.nalLengthSize)
    .filter((nal) => isSliceNal(nal.type))
    .map((nal) => nal.data);

  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples]).toEqual([640, 480]);
  expect(pps.tilesEnabled).toBe(false);
  expect(pps.entropyCodingSyncEnabled).toBe(false);
  expect(slices).toHaveLength(20);

  const pic = new PictureDecoder(sps, pps).decode(slices);
  expect(pic.sliceHeaders.map((header) => header.segmentAddress)).toEqual(
    Array.from({ length: 20 }, (_, i) => i * 4),
  );
  deblockPicture(pic, pps);
  applySao(pic, sps);

  const actual = Buffer.concat([Buffer.from(pic.y), Buffer.from(pic.cb), Buffer.from(pic.cr)]);
  const reference = fixture('slices-rovi3-i.yuv');
  expect(actual).toEqual(reference);
  expect(createHash('md5').update(actual).digest('hex')).toBe('7d8c9abc18315e2ea057d47245438bab');

  const image = decodeHeic(input);
  expect([image.width, image.height, image.bitDepth]).toEqual([640, 480, 8]);
});

it('decodes dependent I-slice segments in the official H.265.1 DSLICE_A first picture', () => {
  const input = fixture('dependent-slices-hhi5-i.heic');
  const boxes = parseISOBMFF(input);
  const info = getHeicInfo(input, boxes);
  const sps = parseSps(info.hvcC!.sps[0]);
  const pps = parsePps(info.hvcC!.pps[0]);
  const payload = getItemPayload(input, boxes, info.primaryItemId)!;
  const slices = splitLengthPrefixed(payload, info.hvcC!.nalLengthSize)
    .filter((nal) => isSliceNal(nal.type))
    .map((nal) => nal.data);

  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples]).toEqual([1920, 1080]);
  expect(pps.dependentSliceSegmentsEnabled).toBe(true);
  expect(pps.tilesEnabled).toBe(false);
  expect(pps.entropyCodingSyncEnabled).toBe(false);
  expect(slices).toHaveLength(17);

  let independentHeader: ReturnType<typeof parseSliceHeader> | undefined;
  const segmentHeaders = slices.map((nal) => {
    const header = parseSliceHeader(nal, sps, pps, independentHeader);
    if (!header.dependentSliceSegment) independentHeader = header;
    return header;
  });
  expect(() => parseSliceHeader(slices[1], sps, pps)).toThrow(
    'heic: dependent slice segment has no preceding independent slice header',
  );
  expect(segmentHeaders.map((header) => header.segmentAddress)).toEqual([
    0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360, 390, 420, 450, 480,
  ]);
  expect(segmentHeaders.filter((header) => !header.dependentSliceSegment)).toHaveLength(3);
  expect(segmentHeaders.filter((header) => header.dependentSliceSegment)).toHaveLength(14);
  expect(segmentHeaders.map((header) => header.sliceQpY)).toEqual(Array(17).fill(32));

  const pic = new PictureDecoder(sps, pps).decode(slices);
  expect(pic.sliceHeaders.map((header) => header.segmentAddress)).toEqual([0, 180, 360]);
  expect(pic.sliceIdByCtb.slice(0, 180).every((sliceId) => sliceId === 0)).toBe(true);
  expect(pic.sliceIdByCtb.slice(180, 360).every((sliceId) => sliceId === 1)).toBe(true);
  expect(pic.sliceIdByCtb.slice(360).every((sliceId) => sliceId === 2)).toBe(true);
  deblockPicture(pic, pps);
  applySao(pic, sps);

  const actual = Buffer.concat([Buffer.from(pic.y), Buffer.from(pic.cb), Buffer.from(pic.cr)]);
  const reference = fixture('dependent-slices-hhi5-i.yuv');
  expect(actual).toEqual(reference);
  expect(createHash('md5').update(actual).digest('hex')).toBe('7a7bedeed541f7f5185d33139b378fb1');

  const image = decodeHeic(input);
  expect([image.width, image.height, image.bitDepth]).toEqual([1920, 1080, 8]);
});

it('decodes dependent I-slice segments with WPP in the official H.265.1 DSLICE_B first picture', () => {
  const input = fixture('dependent-slices-hhi5-wpp-i.heic');
  const boxes = parseISOBMFF(input);
  const info = getHeicInfo(input, boxes);
  const sps = parseSps(info.hvcC!.sps[0]);
  const pps = parsePps(info.hvcC!.pps[0]);
  const payload = getItemPayload(input, boxes, info.primaryItemId)!;
  const slices = splitLengthPrefixed(payload, info.hvcC!.nalLengthSize)
    .filter((nal) => isSliceNal(nal.type))
    .map((nal) => nal.data);

  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples]).toEqual([1920, 1080]);
  expect(pps.dependentSliceSegmentsEnabled).toBe(true);
  expect(pps.tilesEnabled).toBe(false);
  expect(pps.entropyCodingSyncEnabled).toBe(true);
  expect(slices).toHaveLength(34);

  let independentHeader: ReturnType<typeof parseSliceHeader> | undefined;
  const segmentHeaders = slices.map((nal) => {
    const header = parseSliceHeader(nal, sps, pps, independentHeader);
    if (!header.dependentSliceSegment) independentHeader = header;
    return header;
  });
  expect(segmentHeaders.map((header) => header.segmentAddress)).toEqual([
    0, 20, 30, 50, 60, 80, 90, 110, 120, 140, 150, 170, 180, 200, 210, 230, 240, 260, 270, 290, 300,
    320, 330, 350, 360, 380, 390, 410, 420, 440, 450, 470, 480, 500,
  ]);
  expect(segmentHeaders.filter((header) => !header.dependentSliceSegment)).toHaveLength(1);
  expect(segmentHeaders.filter((header) => header.dependentSliceSegment)).toHaveLength(33);
  expect(segmentHeaders.map((header) => header.sliceQpY)).toEqual(Array(34).fill(32));

  const pic = new PictureDecoder(sps, pps).decode(slices);
  expect(pic.sliceHeaders.map((header) => header.segmentAddress)).toEqual([0]);
  expect(pic.sliceIdByCtb.every((sliceId) => sliceId === 0)).toBe(true);
  deblockPicture(pic, pps);
  applySao(pic, sps);

  const actual = Buffer.concat([Buffer.from(pic.y), Buffer.from(pic.cb), Buffer.from(pic.cr)]);
  const reference = fixture('dependent-slices-hhi5-wpp-i.yuv');
  expect(actual).toEqual(reference);
  expect(createHash('md5').update(actual).digest('hex')).toBe('8e42babd2fe7effd44ced73b07bd8a38');

  const image = decodeHeic(input);
  expect([image.width, image.height, image.bitDepth]).toEqual([1920, 1080, 8]);
});

it('decodes dependent I-slice segments across tiles in the official H.265.1 DSLICE_C first picture', () => {
  const input = fixture('dependent-slices-hhi5-tiles-i.heic');
  const boxes = parseISOBMFF(input);
  const info = getHeicInfo(input, boxes);
  const sps = parseSps(info.hvcC!.sps[0]);
  const pps = parsePps(info.hvcC!.pps[0]);
  const payload = getItemPayload(input, boxes, info.primaryItemId)!;
  const slices = splitLengthPrefixed(payload, info.hvcC!.nalLengthSize)
    .filter((nal) => isSliceNal(nal.type))
    .map((nal) => nal.data);

  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples]).toEqual([1920, 1080]);
  expect(pps.dependentSliceSegmentsEnabled).toBe(true);
  expect(pps.tilesEnabled).toBe(true);
  expect([pps.numTileColumns, pps.numTileRows]).toEqual([3, 2]);
  expect(pps.uniformSpacing).toBe(true);
  expect(pps.entropyCodingSyncEnabled).toBe(false);
  expect(pps.loopFilterAcrossTilesEnabled).toBe(true);
  expect(slices).toHaveLength(15);

  let independentHeader: ReturnType<typeof parseSliceHeader> | undefined;
  const segmentHeaders = slices.map((nal) => {
    const header = parseSliceHeader(nal, sps, pps, independentHeader);
    if (!header.dependentSliceSegment) independentHeader = header;
    return header;
  });
  expect(segmentHeaders.map((header) => header.segmentAddress)).toEqual([
    0, 120, 10, 130, 20, 140, 240, 360, 480, 250, 370, 490, 260, 380, 500,
  ]);
  expect(segmentHeaders.every((header) => header.substreams.length === 1)).toBe(true);
  expect(segmentHeaders.filter((header) => !header.dependentSliceSegment)).toHaveLength(1);
  expect(segmentHeaders.filter((header) => header.dependentSliceSegment)).toHaveLength(14);

  const pic = new PictureDecoder(sps, pps).decode(slices);
  expect(pic.sliceHeaders.map((header) => header.segmentAddress)).toEqual([0]);
  expect(pic.tileIdByCtb[0]).toBe(0);
  expect(pic.tileIdByCtb[10]).toBe(1);
  expect(pic.tileIdByCtb[20]).toBe(2);
  expect(pic.tileIdByCtb[240]).toBe(3);
  expect(pic.tileIdByCtb[250]).toBe(4);
  expect(pic.tileIdByCtb[260]).toBe(5);
  expect(pic.sliceIdByCtb.every((sliceId) => sliceId === 0)).toBe(true);
  deblockPicture(pic, pps);
  applySao(pic, sps);

  const actual = Buffer.concat([Buffer.from(pic.y), Buffer.from(pic.cb), Buffer.from(pic.cr)]);
  const reference = fixture('dependent-slices-hhi5-tiles-i.yuv');
  expect(actual).toEqual(reference);
  expect(createHash('md5').update(actual).digest('hex')).toBe('4e5d361c106f68be001dd453fbbf2936');

  const image = decodeHeic(input);
  expect([image.width, image.height, image.bitDepth]).toEqual([1920, 1080, 8]);
});
