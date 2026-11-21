import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { decodeHeic, getHeicMetadata } from '../src/decoder';
import { getHeicInfo } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { box, buildHeif, codedFixture, full, u32 } from './helpers/heif';

const alphaConfiguration = new Uint8Array(
  readFileSync(new URL('./fixtures/conformance/mini-alpha-L_8.hvcc', import.meta.url)),
);
const alphaData = new Uint8Array(
  readFileSync(new URL('./fixtures/conformance/mini-alpha-L_8.hevc', import.meta.url)),
);

function rref(types: readonly string[]): Uint8Array {
  return full(
    'rref',
    0,
    Buffer.from([types.length]),
    ...types.map((type) => Buffer.from(type, 'ascii')),
  );
}

describe('HEIF RequiredReferenceTypesProperty', () => {
  it('processes a required dimg reference on an identity-derived image', () => {
    const source = codedFixture(),
      baseline = decodeHeic(buildHeif([source], source.id)),
      identity = {
        id: 2,
        type: 'iden',
        data: new Uint8Array(),
        properties: [rref(['dimg'])],
        refs: [{ type: 'dimg', to: [source.id] }],
      },
      input = buildHeif([source, identity], identity.id);

    expect(getHeicInfo(input, parseISOBMFF(input)).derivedItems).toEqual([source.id]);
    expect(decodeHeic(input).data).toEqual(baseline.data);
  });

  it('processes required auxiliary and premultiplication references', () => {
    const source = codedFixture(),
      primary = {
        ...source,
        properties: [...source.properties, rref(['auxl', 'prem'])],
        refs: [{ type: 'prem', to: [2] }],
      },
      alpha = {
        id: 2,
        type: 'hvc1',
        data: alphaData,
        properties: [
          box('hvcC', alphaConfiguration),
          full('ispe', 0, u32(128), u32(128)),
          full('pixi', 0, Buffer.from([1, 8])),
          full('auxC', 0, Buffer.from('urn:mpeg:hevc:2015:auxid:1\0')),
        ],
        refs: [{ type: 'auxl', to: [source.id] }],
      },
      input = buildHeif([primary, alpha], source.id),
      metadata = getHeicMetadata(input);

    expect(metadata).toMatchObject({ hasAlpha: true, premultipliedAlpha: true });
    expect(decodeHeic(input).hasAlpha).toBe(true);
  });

  it('processes a required tbas reference with its rloc property', () => {
    const source = codedFixture(),
      located = {
        ...source,
        properties: [...source.properties, full('rloc', 0, u32(11), u32(20)), rref(['tbas'])],
        refs: [{ type: 'tbas', to: [2] }],
      },
      target = { ...codedFixture(), id: 2 },
      input = buildHeif([located, target], source.id);

    expect(getHeicMetadata(input).relativeLocation).toEqual({
      horizontalOffset: 11,
      verticalOffset: 20,
      relatedItemId: target.id,
    });
  });

  it('rejects missing and unknown required references', () => {
    const source = codedFixture(),
      identity = {
        id: 2,
        type: 'iden',
        data: new Uint8Array(),
        properties: [rref(['dimg'])],
        refs: [],
      },
      missing = buildHeif([source, identity], identity.id),
      unknownIdentity = { ...identity, properties: [rref(['zzzz'])] },
      unknown = buildHeif([source, unknownIdentity], identity.id);

    expect(() => getHeicInfo(missing, parseISOBMFF(missing))).toThrow(
      'rref requires a missing dimg reference',
    );
    expect(() => getHeicInfo(unknown, parseISOBMFF(unknown))).toThrow(
      'required image reference type zzzz is not supported',
    );
  });

  it('enforces the pred-only declaration for predictively coded items', () => {
    const source = codedFixture(),
      predicted = {
        ...source,
        id: 2,
        properties: [...source.properties, rref(['pred', 'dimg'])],
        refs: [
          { type: 'pred', to: [source.id] },
          { type: 'dimg', to: [source.id] },
        ],
      },
      input = buildHeif([source, predicted], predicted.id);

    expect(() => getHeicInfo(input, parseISOBMFF(input))).toThrow(
      'predictively coded image must require only pred references',
    );
  });
});
