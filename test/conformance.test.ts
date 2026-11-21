import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'bun:test';
import {
  decodeHeic,
  decodeHDRSync,
  getHeicMetadata,
  getItemPayload,
  parseISOBMFF,
  splitLengthPrefixed,
  isSliceNal,
  parsePps,
  PictureDecoder,
} from '../src';
import { getColorTransferFunction } from '../src/color-transfer';
import { deblockPicture } from '../src/hevc/deblock';
import { applySao } from '../src/hevc/sao';
import { box, buildHeif, codedFixture, u16 } from './helpers/heif';

const nclxMatrix = (matrix: number, fullRange = true, transfer = 13, primaries = 1) =>
  box(
    'colr',
    Buffer.from('nclx'),
    u16(primaries),
    u16(transfer),
    u16(matrix),
    Buffer.from([fullRange ? 128 : 0]),
  );

for (const depth of [8, 10, 12])
  for (const pattern of ['pattern', 'gradient', 'chroma444']) {
    it(`${depth}-bit ${pattern}: all reconstructed samples equal FFmpeg reference`, () => {
      const prefix = join(import.meta.dir, 'fixtures', 'conformance', `${pattern}-${depth}`);
      const input = buildHeif([codedFixture(depth, pattern)], 1);
      const metadata = getHeicMetadata(input);
      const pps = parsePps(metadata.hvcC!.pps[0]);
      const payload = getItemPayload(input, parseISOBMFF(input), metadata.primaryItemId)!;
      const slices = splitLengthPrefixed(payload, metadata.hvcC!.nalLengthSize)
        .filter((n) => isSliceNal(n.type))
        .map((n) => n.data);
      const pic = new PictureDecoder(metadata.sps!, pps).decode(slices);
      deblockPicture(pic, pps, depth);
      applySao(pic, metadata.sps!, depth);
      const reference = readFileSync(prefix + '.yuv');
      let i = 0;
      for (const plane of [pic.y, pic.cb, pic.cr])
        for (const sample of plane) {
          expect(sample).toBe(depth === 8 ? reference[i++] : reference.readUInt16LE(i++ * 2));
        }
      const image = decodeHeic(input);
      expect(image.bitDepth).toBe(depth);
      expect(image.data.length).toBe(image.width * image.height * 4);
    });
  }

it('renders FCC and SMPTE 240M CICP matrices on 4:2:0, 4:2:2 and 4:4:4 HEIF items', () => {
  for (const pattern of ['pattern', 'chroma422', 'chroma444']) {
    const source = codedFixture(8, pattern);
    const isColorProperty = (property: Uint8Array) =>
      property.length >= 8 &&
      property[4] === 0x63 &&
      property[5] === 0x6f &&
      property[6] === 0x6c &&
      property[7] === 0x72;
    const properties = source.properties.filter((property) => !isColorProperty(property));
    const images = [4, 7].map((matrix) => {
      const input = buildHeif(
        [{ ...source, properties: [...properties, nclxMatrix(matrix)] }],
        source.id,
      );
      return decodeHeic(input).data;
    });
    expect(images[0]).not.toEqual(images[1]);
    if (pattern === 'pattern') {
      expect(Array.from(images[0].subarray(0, 4))).toEqual([127, 15, 243, 255]);
      expect(Array.from(images[1].subarray(0, 4))).toEqual([134, 34, 247, 255]);
    } else if (pattern === 'chroma422') {
      expect(Array.from(images[0].subarray(0, 4))).toEqual([126, 17, 240, 255]);
      expect(Array.from(images[1].subarray(0, 4))).toEqual([132, 35, 244, 255]);
    } else {
      expect(Array.from(images[0].subarray(0, 4))).toEqual([0, 0, 121, 255]);
      expect(Array.from(images[1].subarray(0, 4))).toEqual([0, 0, 124, 255]);
    }
  }
});

it('expands limited-range identity-matrix RGB on all 4:4:4 components', () => {
  const source = codedFixture(8, 'chroma444');
  const properties = source.properties.filter(
    (property) =>
      property.length < 8 ||
      property[4] !== 0x63 ||
      property[5] !== 0x6f ||
      property[6] !== 0x6c ||
      property[7] !== 0x72,
  );
  const makeInput = (fullRange: boolean) =>
    buildHeif(
      [{ ...source, properties: [...properties, nclxMatrix(0, fullRange, 1, 1)] }],
      source.id,
    );
  const fullRange = decodeHeic(makeInput(true)).data,
    limitedInput = makeInput(false),
    limitedRange = decodeHeic(limitedInput).data,
    hdr = decodeHDRSync(limitedInput).data,
    transfer = getColorTransferFunction(1)!;
  for (let i = 0; i < fullRange.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const expected = Math.max(
        0,
        Math.min(255, Math.round(((fullRange[i + c] - 16) * 255) / 219)),
      );
      expect(limitedRange[i + c]).toBe(expected);
    }
    expect(limitedRange[i + 3]).toBe(255);
  }
  for (let i = 0; i < limitedRange.length; i += 4 * 31)
    for (let c = 0; c < 3; c++)
      expect(hdr[i + c]).toBeCloseTo(transfer.toLinear(limitedRange[i + c] / 255), 6);
});

it('renders constant-luminance CICP metadata with additional defined transfers in HEIF items', () => {
  const source = codedFixture(10, 'pattern');
  const properties = source.properties.filter(
    (property) =>
      property.length < 8 ||
      property[4] !== 0x63 ||
      property[5] !== 0x6f ||
      property[6] !== 0x6c ||
      property[7] !== 0x72,
  );
  for (const matrix of [10, 13])
    for (const transfer of [4, 5, 7, 9, 10, 17]) {
      const input = buildHeif(
        [{ ...source, properties: [...properties, nclxMatrix(matrix, true, transfer, 9)] }],
        source.id,
      );
      const image = decodeHeic(input);
      expect(image.data.length).toBe(image.width * image.height * 4);
    }
});

it('renders equal-depth YCgCo CICP samples on 4:2:0, 4:2:2 and 4:4:4 HEIF items', () => {
  for (const [pattern, expected] of [
    ['pattern', [17, 169, 0, 255]],
    ['chroma422', [18, 167, 0, 255]],
    ['chroma444', [0, 68, 0, 255]],
  ] as const) {
    const source = codedFixture(8, pattern);
    const properties = source.properties.filter(
      (property) =>
        property.length < 8 ||
        property[4] !== 0x63 ||
        property[5] !== 0x6f ||
        property[6] !== 0x6c ||
        property[7] !== 0x72,
    );
    const input = buildHeif([{ ...source, properties: [...properties, nclxMatrix(8)] }], source.id);
    expect(Array.from(decodeHeic(input).data.subarray(0, 4))).toEqual(expected);
  }
});

it('renders YCgCo-Re/Ro CICP matrices on 4:2:0, 4:2:2 and 4:4:4 HEIF items', () => {
  for (const [pattern, depth] of [
    ['pattern', 10],
    ['chroma422', 8],
    ['chroma444', 10],
  ] as const) {
    const source = codedFixture(depth, pattern);
    const properties = source.properties.filter(
      (property) =>
        property.length < 8 ||
        property[4] !== 0x63 ||
        property[5] !== 0x6f ||
        property[6] !== 0x6c ||
        property[7] !== 0x72,
    );
    const images = [16, 17].map((matrix) =>
      decodeHeic(
        buildHeif([{ ...source, properties: [...properties, nclxMatrix(matrix)] }], source.id),
      ),
    );
    for (const image of images) {
      expect(image.bitDepth).toBe(depth);
      expect(image.data.length).toBe(image.width * image.height * 4);
    }
    expect(images[0].data).not.toEqual(images[1].data);
  }
});

it('renders BT.2020 constant-luminance CICP on 4:2:0, 4:2:2 and 4:4:4 HEIF items', () => {
  for (const pattern of ['pattern', 'chroma422', 'chroma444']) {
    const source = codedFixture(8, pattern);
    const properties = source.properties.filter(
      (property) =>
        property.length < 8 ||
        property[4] !== 0x63 ||
        property[5] !== 0x6f ||
        property[6] !== 0x6c ||
        property[7] !== 0x72,
    );
    const input = buildHeif(
      [{ ...source, properties: [...properties, nclxMatrix(10, true, 14)] }],
      source.id,
    );
    const hlgInput = buildHeif(
      [{ ...source, properties: [...properties, nclxMatrix(10, true, 18)] }],
      source.id,
    );
    const nclInput = buildHeif(
      [{ ...source, properties: [...properties, nclxMatrix(9)] }],
      source.id,
    );
    const image = decodeHeic(input);
    expect(image.data.length).toBe(image.width * image.height * 4);
    expect(image.data).not.toEqual(decodeHeic(hlgInput).data);
    expect(image.data).not.toEqual(decodeHeic(nclInput).data);
  }
});

it('renders BT.2100 ICtCp PQ/HLG CICP on 4:2:0, 4:2:2 and 4:4:4 HEIF items', () => {
  for (const pattern of ['pattern', 'chroma422', 'chroma444']) {
    const source = codedFixture(8, pattern);
    const properties = source.properties.filter(
      (property) =>
        property.length < 8 ||
        property[4] !== 0x63 ||
        property[5] !== 0x6f ||
        property[6] !== 0x6c ||
        property[7] !== 0x72,
    );
    const makeInput = (transfer: number) =>
      buildHeif(
        [{ ...source, properties: [...properties, nclxMatrix(14, true, transfer)] }],
        source.id,
      );
    const pq = decodeHeic(makeInput(16)),
      hlg = decodeHeic(makeInput(18));
    expect(pq.data.length).toBe(pq.width * pq.height * 4);
    expect(hlg.data.length).toBe(hlg.width * hlg.height * 4);
    expect(pq.data).not.toEqual(hlg.data);
  }
});

it('renders chromaticity-derived CICP matrices 12 and 13 on 4:2:0, 4:2:2 and 4:4:4 items', () => {
  for (const pattern of ['pattern', 'chroma422', 'chroma444']) {
    const source = codedFixture(8, pattern);
    const properties = source.properties.filter(
      (property) =>
        property.length < 8 ||
        property[4] !== 0x63 ||
        property[5] !== 0x6f ||
        property[6] !== 0x6c ||
        property[7] !== 0x72,
    );
    const makeInput = (matrix: number, transfer: number) =>
      buildHeif(
        [{ ...source, properties: [...properties, nclxMatrix(matrix, true, transfer, 4)] }],
        source.id,
      );
    const ncl = decodeHeic(makeInput(12, 13)),
      cl = decodeHeic(makeInput(13, 14));
    expect(ncl.data.length).toBe(ncl.width * ncl.height * 4);
    expect(cl.data.length).toBe(cl.width * cl.height * 4);
    expect(ncl.data).not.toEqual(cl.data);
  }
});

it('renders SMPTE ST 2085 and IPT-C2 CICP matrices on 4:2:0, 4:2:2 and 4:4:4 items', () => {
  for (const pattern of ['pattern', 'chroma422', 'chroma444']) {
    const source = codedFixture(8, pattern);
    const properties = source.properties.filter(
      (property) =>
        property.length < 8 ||
        property[4] !== 0x63 ||
        property[5] !== 0x6f ||
        property[6] !== 0x6c ||
        property[7] !== 0x72,
    );
    const makeInput = (matrix: number, transfer: number) =>
      buildHeif(
        [{ ...source, properties: [...properties, nclxMatrix(matrix, true, transfer)] }],
        source.id,
      );
    const xyz = decodeHeic(makeInput(11, 13)),
      ipt = decodeHeic(makeInput(15, 16));
    expect(xyz.data.length).toBe(xyz.width * xyz.height * 4);
    expect(ipt.data.length).toBe(ipt.width * ipt.height * 4);
    expect(xyz.data).not.toEqual(ipt.data);
  }
});

it('expands limited-range YCgCo on a 4:2:0 HEIF item', () => {
  const source = codedFixture(8, 'pattern');
  const properties = source.properties.filter(
    (property) =>
      property.length < 8 ||
      property[4] !== 0x63 ||
      property[5] !== 0x6f ||
      property[6] !== 0x6c ||
      property[7] !== 0x72,
  );
  const input = buildHeif(
    [{ ...source, properties: [...properties, nclxMatrix(8, false)] }],
    source.id,
  );
  expect(Array.from(decodeHeic(input).data.subarray(0, 4))).toEqual([1, 178, 0, 255]);
});
