import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { decodeHeic, getHeicMetadata } from '../src/decoder.js';
import { getHeicInfo, getItemPayload, parseIpma } from '../src/container/heic.js';
import { findBox, parseISOBMFF } from '../src/container/heif.js';
import { buildHeif, box, full, u16, u32, type Item } from './helpers/heif.js';

const officialInput = new Uint8Array(
  readFileSync(new URL('./fixtures/conformance/pcm-rext-422-10.heic', import.meta.url)),
);
const officialBoxes = parseISOBMFF(officialInput);
const officialInfo = getHeicInfo(officialInput, officialBoxes);
const metaBox = findBox(officialBoxes, 'meta')!;
const iprpBox = findBox(metaBox.children!, 'iprp')!;
const ipcoBox = findBox(iprpBox.children!, 'ipco')!;
const ipmaBox = findBox(iprpBox.children!, 'ipma')!;
const association = parseIpma(ipmaBox.data).find(
  (entry) => entry.itemId === officialInfo.primaryItemId,
)!;
const source: Item = {
  id: officialInfo.primaryItemId,
  type: officialInfo.primaryItemType,
  data: getItemPayload(officialInput, officialBoxes, officialInfo.primaryItemId)!,
  properties: association.propertyIndexes.map((index) => {
    const property = ipcoBox.children![index - 1];
    return box(property.type, property.data);
  }),
};

function gridWithProperties(properties: Uint8Array[], includeAlternative = false): Uint8Array {
  const tileA: Item = { ...source, id: 1 },
    tileB: Item = { ...source, id: 2 },
    alternative: Item = { ...source, id: 4 },
    grid: Item = {
      id: 3,
      type: 'grid',
      // One row, two columns, each using the official 416x240 vector.
      data: Buffer.concat([
        Buffer.from([0, 0, 0, 1]),
        u16(officialInfo.width * 2),
        u16(officialInfo.height),
      ]),
      properties: [
        box(
          'ispe',
          Buffer.from([0, 0, 0, 0]),
          u32(officialInfo.width * 2),
          u32(officialInfo.height),
        ),
        ...properties,
      ],
      refs: [{ type: 'dimg', to: [1, 2] }],
    };
  return buildHeif(
    includeAlternative ? [tileA, tileB, alternative, grid] : [tileA, tileB, grid],
    grid.id,
    includeAlternative ? [full('altr', 0, u32(1), u32(2), u32(tileA.id), u32(alternative.id))] : [],
  );
}

function gridWithPrdi(property: Uint8Array): Uint8Array {
  return gridWithProperties([property]);
}

function prdi(flags: number, ...body: Uint8Array[]): Uint8Array {
  return box(
    'prdi',
    Buffer.from([0, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]),
    ...body,
  );
}

describe('HEIF progressive derived image information', () => {
  it('parses inferred one-item steps and leaves final grid pixels unchanged', () => {
    const input = gridWithPrdi(prdi(0x02));
    expect(getHeicMetadata(input).progressiveDerivedImage).toEqual({
      flags: 0x02,
      itemReferenceOrder: false,
      oneItemPerStep: true,
      alternativeIsCandidate: false,
      stepCount: 2,
      stepCountInferred: true,
      itemCounts: [1, 1],
    });
    expect(decodeHeic(input)).toEqual(decodeHeic(gridWithProperties([])));
  });

  it('parses explicit step grouping and alternative candidate counts', () => {
    const explicit = getHeicMetadata(
      gridWithPrdi(prdi(0x01, u16(2), u16(2), u16(1))),
    ).progressiveDerivedImage;
    expect(explicit).toEqual({
      flags: 0x01,
      itemReferenceOrder: true,
      oneItemPerStep: false,
      alternativeIsCandidate: false,
      stepCount: 2,
      stepCountInferred: false,
      itemCounts: [2, 1],
    });

    const alternatives = getHeicMetadata(
      gridWithProperties([prdi(0x06, u16(3))], true),
    ).progressiveDerivedImage;
    expect(alternatives).toMatchObject({
      stepCount: 3,
      stepCountInferred: false,
      oneItemPerStep: true,
      alternativeIsCandidate: true,
      itemCounts: [1, 1, 1],
    });
  });

  it('rejects malformed, duplicated, and wrongly associated properties', () => {
    const invalidProperties = [
      prdi(0, u16(0)),
      prdi(0, u16(2), u16(1)),
      prdi(0x08),
      prdi(0, u16(1), u16(1), Buffer.from([0])),
    ];
    for (const property of invalidProperties)
      expect(() => getHeicMetadata(gridWithPrdi(property))).toThrow();

    const duplicate = gridWithProperties([prdi(0, u16(1)), prdi(0, u16(1))]);
    expect(() => getHeicMetadata(duplicate)).toThrow('duplicate prdi');
    const coded = { ...source, properties: [...source.properties, prdi(0, u16(1))] };
    expect(() => getHeicMetadata(buildHeif([coded], coded.id))).toThrow();
  });
});
