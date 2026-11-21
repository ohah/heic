import { describe, it, expect } from 'bun:test';
import { decodeHeic, decodeHDRSync, getHeicMetadata } from '../src';
import { pqToLinear, hlgInverseOetf, parseIsoGainMap } from '../src/hdr';
import { getColorTransferFunction } from '../src/color-transfer';
import {
  isoFixture,
  alphaFixture,
  isoMetadata,
  buildHeif,
  codedFixture,
  full,
  box,
  u16,
  u32,
  type Item,
} from './helpers/heif';

for (const depth of [8, 10, 12])
  describe(`${depth}-bit alpha and ISO gain map`, () => {
    it('decodes and keeps the auxiliary alpha raster', () => {
      const image = decodeHeic(alphaFixture(depth));
      expect(image.width).toBe(64);
      expect(image.hasAlpha).toBe(true);
      expect(image.data.some((v, i) => i % 4 === 3 && v !== 255)).toBe(true);
    });
    it('reconstructs ISO gain maps in linear RGB and respects display headroom', () => {
      const input = isoFixture(depth),
        base = decodeHDRSync(buildHeif([codedFixture(depth)], 1)),
        zero = decodeHDRSync(input, { displayHeadroom: 1 }),
        boost = decodeHDRSync(input, { displayHeadroom: 4 });
      expect(zero.source).toBe('iso-gainmap');
      expect(zero.headroom).toBe(1);
      expect(boost.headroom).toBe(4);
      for (let i = 0; i < base.data.length; i++)
        expect(Math.abs(zero.data[i] - base.data[i])).toBeLessThan(1e-6);
      expect(boost.data.some((v, i) => i % 4 !== 3 && v > zero.data[i])).toBe(true);
      expect([...boost.data].every(Number.isFinite)).toBe(true);
    });
  });
it('follows BT.2100 PQ calibration points and HLG signal breakpoints', () => {
  expect(pqToLinear(0)).toBe(0);
  expect(pqToLinear(1, 100)).toBeCloseTo(100, 7);
  // ST 2084 reference code values: 100 nits at ~0.508078, 1000 nits at ~0.751827.
  expect(pqToLinear(0.5080784215, 100)).toBeCloseTo(1, 7);
  expect(pqToLinear(0.7518270962, 100)).toBeCloseTo(10, 6);
  expect(hlgInverseOetf(0)).toBe(0);
  expect(hlgInverseOetf(0.5)).toBeCloseTo(1 / 12, 8);
  expect(hlgInverseOetf(1)).toBeCloseTo(1, 6);
});
it('linearizes additional H.273 SDR transfer codes in HDR output', () => {
  const base = codedFixture(10, 'pcm-rext-422'),
    properties = base.properties.filter((property) => property.toString('ascii', 4, 8) !== 'colr');
  for (const transfer of [1, 4, 5, 6, 7, 8, 9, 10, 14, 15, 17]) {
    const color = box(
        'colr',
        Buffer.from('nclx'),
        u16(1),
        u16(transfer),
        u16(6),
        Buffer.from([128]),
      ),
      input = buildHeif([{ ...base, properties: [...properties, color] }], base.id),
      sdr = decodeHeic(input),
      hdr = decodeHDRSync(input);
    expect(hdr.source).toBe('sdr');
    expect([...hdr.data].every(Number.isFinite)).toBe(true);
    const transferFunction = getColorTransferFunction(transfer)!;
    const referenceScale = transfer === 17 ? 48 / 203 : 1;
    for (let i = 0; i < sdr.data.length; i += 4)
      for (let channel = 0; channel < 3; channel++)
        expect(
          Math.abs(
            hdr.data[i + channel] -
              transferFunction.toLinear(sdr.data[i + channel] / 255) * referenceScale,
          ),
        ).toBeLessThan(0.02); // The public SDR result quantizes the official 10-bit source to RGBA8.
    if (transfer === 17) expect(hdr.headroom).toBeCloseTo(52.37 / 203, 12);
  }
});
it('linearizes PQ and HLG HDR images for all defined H.273 colour-primary codes', () => {
  const base = codedFixture(),
    properties = base.properties.filter((property) => property.toString('ascii', 4, 8) !== 'colr');
  for (const primaries of [1, 2, 4, 5, 6, 7, 8, 9, 10, 11, 12, 22])
    for (const transfer of [16, 18]) {
      const color = box(
          'colr',
          Buffer.from('nclx'),
          u16(primaries),
          u16(transfer),
          u16(6),
          Buffer.from([128]),
        ),
        input = buildHeif([{ ...base, properties: [...properties, color] }], base.id),
        hdr = decodeHDRSync(input);
      expect(hdr.source).toBe(transfer === 16 ? 'pq' : 'hlg');
      expect([...hdr.data].every(Number.isFinite)).toBe(true);
    }
});
it('preserves extended H.273 gamut values in linear HDR output', () => {
  const base = codedFixture(),
    properties = base.properties.filter((property) => property.toString('ascii', 4, 8) !== 'colr');
  for (const transfer of [11, 12, 13]) {
    const color = box('colr', Buffer.from('nclx'), u16(1), u16(transfer), u16(6), Buffer.from([0])),
      transform = transfer === 11 ? [box('irot', Buffer.from([1]))] : [],
      input = buildHeif([{ ...base, properties: [...properties, color, ...transform] }], base.id),
      sdr = decodeHeic(input),
      hdr = decodeHDRSync(input);
    expect(hdr.source).toBe('sdr');
    expect([...hdr.data].every(Number.isFinite)).toBe(true);
    expect(hdr.data.some((value) => value < 0)).toBe(true);
    expect(hdr.data.some((value) => value > 1)).toBe(true);
    expect([...sdr.data].every((value) => value >= 0 && value <= 255)).toBe(true);
    if (transfer === 11) {
      expect(hdr.width).toBe(64);
      expect(hdr.height).toBe(64);
    }
  }
});
it('rejects malformed or unsupported ISO gain-map metadata with stable codes', () => {
  for (const payload of [new Uint8Array(), isoMetadata().subarray(0, 20)])
    expect(() => parseIsoGainMap(payload)).toThrow();
  const zeroDenominator = isoMetadata();
  zeroDenominator.fill(0, 10, 14);
  expect(() => parseIsoGainMap(zeroDenominator)).toThrow('denominator');
  const reserved = isoMetadata();
  reserved[5] |= 1;
  expect(() => parseIsoGainMap(reserved)).toThrow('flags');
});
it('falls back to the base image for unknown tone-map and gain-map minimum versions', () => {
  const baseInput = buildHeif([codedFixture()], 1),
    baseSdr = decodeHeic(baseInput),
    baseHdr = decodeHDRSync(baseInput),
    futureVersions = [
      (() => {
        const data = new Uint8Array(isoMetadata());
        data[0] = 1; // ToneMapImage version
        return data;
      })(),
      (() => {
        const data = new Uint8Array(isoMetadata());
        data[2] = 1; // minimum_version = 1
        data[4] = 1; // writer_version must be >= minimum_version
        return data;
      })(),
      (() => {
        const data = new Uint8Array(isoMetadata());
        data[1] = 2; // minimum_version = 512, as in Nokia sun_hdr_full_gainmap
        data[3] = 2; // writer_version = 512, satisfying writer_version >= minimum_version
        return data;
      })(),
    ];
  for (const metadata of futureVersions) {
    const input = isoFixture(8, metadata),
      sdr = decodeHeic(input),
      hdr = decodeHDRSync(input);
    expect(sdr.data).toEqual(baseSdr.data);
    expect(hdr.source).toBe('sdr');
    expect(hdr.headroom).toBe(1);
    expect(hdr.data).toEqual(baseHdr.data);
  }
});
it('ignores ISO gain-map extension bytes when minimum_version is supported', () => {
  const metadata = new Uint8Array([...isoMetadata(), 0x12, 0x34]);
  metadata[4] = 1; // writer_version = 1; minimum_version remains 0
  const base = decodeHDRSync(buildHeif([codedFixture()], 1));
  const reference = decodeHDRSync(isoFixture(8, isoMetadata()), { displayHeadroom: 4 });
  const extended = decodeHDRSync(isoFixture(8, metadata), { displayHeadroom: 4 });

  expect(extended.source).toBe('iso-gainmap');
  expect(extended.data).toEqual(reference.data);
  expect(extended.data).not.toEqual(base.data);
});
it('identifies auxiliary alpha by auxl references and auxC type, not item type', () => {
  expect(getHeicMetadata(alphaFixture()).hasAlpha).toBe(true);
  const base = codedFixture(),
    depth = {
      ...codedFixture(),
      id: 2,
      properties: [
        ...codedFixture().properties,
        full('auxC', 0, Buffer.from('urn:mpeg:hevc:2015:auxid:2\0')),
      ],
      refs: [{ type: 'auxl', to: [1] }],
    };
  expect(getHeicMetadata(buildHeif([base, depth], 1)).hasAlpha).toBe(false);
});
it('rejects duplicate alpha descriptors and recursive identity references', () => {
  const base = codedFixture(),
    aux = (id: number): Item => ({
      ...codedFixture(),
      id,
      properties: [
        ...codedFixture().properties,
        full('auxC', 0, Buffer.from('urn:mpeg:hevc:2015:auxid:1\0')),
      ],
      refs: [{ type: 'auxl', to: [1] }],
    });
  expect(() => decodeHeic(buildHeif([base, aux(2), aux(3)], 1))).toThrow('duplicate');
  const identity: Item = {
    id: 2,
    type: 'iden',
    data: new Uint8Array(),
    properties: [full('ispe', 0, u32(64), u32(64))],
    refs: [{ type: 'dimg', to: [2] }],
  };
  expect(() => decodeHeic(buildHeif([base, identity], 2))).toThrow('cyclic');
});
it('composites an overlay with negative offsets and opaque/transparent fills', () => {
  const base = codedFixture(),
    payload = Buffer.concat([
      Buffer.from([0, 0]),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u16(64),
      u16(64),
      Buffer.from([255, 248]),
      u16(0),
    ]);
  const overlay: Item = {
    id: 2,
    type: 'iovl',
    data: payload,
    properties: [full('ispe', 0, u32(64), u32(64))],
    refs: [{ type: 'dimg', to: [1] }],
  };
  const image = decodeHeic(buildHeif([base, overlay], 2));
  expect(image.hasAlpha).toBe(true);
  expect(image.data[63 * 4 + 3]).toBe(0);
});
it('applies integer and fractional clean aperture before subsequent display transforms', () => {
  const base = codedFixture(),
    ratio = (n: number, d = 1) => Buffer.concat([u32(n), u32(d)]);
  const crop = box('clap', ratio(32), ratio(16), ratio(0), ratio(0));
  const result = decodeHeic(
    buildHeif(
      [{ ...base, properties: [...base.properties, crop, box('irot', Buffer.from([1]))] }],
      1,
    ),
  );
  expect(result.width).toBe(16);
  expect(result.height).toBe(32);
  const raw = decodeHeic(buildHeif([{ ...base, properties: [...base.properties, crop] }], 1), {
    applyTransforms: false,
  });
  expect(raw.width).toBe(64);
  expect(raw.height).toBe(64);

  const width = 63 / 2,
    height = 31 / 2,
    rasterWidth = Math.round(width),
    rasterHeight = Math.round(height),
    horizontalOffset = 1 / 4,
    verticalOffset = -1 / 4,
    fractional = box('clap', ratio(63, 2), ratio(31, 2), ratio(1, 4), ratio(-1, 4)),
    source = decodeHeic(buildHeif([base], 1), { applyTransforms: false }),
    left = (source.width - width) / 2 + horizontalOffset,
    top = (source.height - height) / 2 + verticalOffset,
    position = (start: number, extent: number, index: number, count: number) =>
      count === 1 ? start + (extent - 1) / 2 : start + (index * (extent - 1)) / (count - 1),
    sample = (x: number, y: number, channel: number) => {
      const x0 = Math.floor(x),
        y0 = Math.floor(y),
        x1 = Math.min(source.width - 1, x0 + 1),
        y1 = Math.min(source.height - 1, y0 + 1),
        fx = x - x0,
        fy = y - y0,
        at = (sx: number, sy: number) => source.data[(sy * source.width + sx) * 4 + channel],
        upper = at(x0, y0) * (1 - fx) + at(x1, y0) * fx,
        lower = at(x0, y1) * (1 - fx) + at(x1, y1) * fx;
      return Math.round(upper * (1 - fy) + lower * fy);
    },
    cropped = new Uint8Array(rasterWidth * rasterHeight * 4);
  for (let y = 0; y < rasterHeight; y++)
    for (let x = 0; x < rasterWidth; x++) {
      const sx = position(left, width, x, rasterWidth),
        sy = position(top, height, y, rasterHeight),
        offset = (y * rasterWidth + x) * 4;
      for (let channel = 0; channel < 4; channel++)
        cropped[offset + channel] = sample(sx, sy, channel);
    }
  const expected = new Uint8Array(cropped.length);
  for (let y = 0; y < rasterHeight; y++)
    for (let x = 0; x < rasterWidth; x++) {
      const dx = y,
        dy = rasterWidth - 1 - x,
        sourceOffset = (y * rasterWidth + x) * 4,
        destOffset = (dy * rasterHeight + dx) * 4;
      expected.set(cropped.subarray(sourceOffset, sourceOffset + 4), destOffset);
    }
  const fractionalResult = decodeHeic(
    buildHeif(
      [{ ...base, properties: [...base.properties, fractional, box('irot', Buffer.from([1]))] }],
      1,
    ),
  );
  expect(fractionalResult.width).toBe(rasterHeight);
  expect(fractionalResult.height).toBe(rasterWidth);
  expect(fractionalResult.data).toEqual(expected);
});
it('rejects unknown essential properties instead of silently rendering them', () => {
  const base = codedFixture();
  expect(() =>
    decodeHeic(
      buildHeif([{ ...base, properties: [...base.properties, box('zzzz', Buffer.from([1]))] }], 1),
    ),
  ).toThrow('essential property');
});

it('recognizes HEVC declared in generic HEIF brands without accepting foreign codecs', () => {
  const data = buildHeif([codedFixture()], 1);
  const original = decodeHeic(data);
  const generic = new Uint8Array(data);
  // Replace all codec-specific brand declarations in the ftyp box only.
  const ftypSize = new DataView(generic.buffer, generic.byteOffset).getUint32(0);
  for (let i = 8; i + 4 <= ftypSize; i += 4) {
    const brand = new TextDecoder().decode(generic.subarray(i, i + 4));
    if (brand === 'heic') generic.set(new TextEncoder().encode('mif2'), i);
  }
  const decoded = decodeHeic(generic);
  expect(decoded.data).toEqual(original.data);
});
