import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'bun:test';
import { decodeHeic, decodeHDRSync, getHeicMetadata } from '../src';
import { pqToLinear, hlgInverseOetf, parseIsoGainMap } from '../src/hdr';
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
        base = decodeHDRSync(
          new Uint8Array(
            readFileSync(new URL(`./fixtures/conformance/pattern-${depth}.heic`, import.meta.url)),
          ),
        ),
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
it('applies clean aperture before subsequent display transforms and rejects fractional resampling', () => {
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
  const fractional = box('clap', ratio(31), ratio(16), ratio(0), ratio(0));
  expect(() =>
    decodeHeic(buildHeif([{ ...base, properties: [...base.properties, fractional] }], 1)),
  ).toThrow('fractional');
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
