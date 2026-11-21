import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { getHeicMetadata } from '../src/decoder';
import { getHeicInfo, getItemPayload, parseIpma } from '../src/container/heic';
import { findBox, parseISOBMFF } from '../src/container/heif';
import { box, buildHeif, u16 } from './helpers/heif';

const officialInput = new Uint8Array(
  readFileSync(new URL('./fixtures/conformance/pcm-rext-422-10.heic', import.meta.url)),
);

function rewrappedOfficialItem() {
  const boxes = parseISOBMFF(officialInput);
  const info = getHeicInfo(officialInput, boxes);
  const meta = findBox(boxes, 'meta')!;
  const iprp = findBox(meta.children!, 'iprp')!;
  const ipco = findBox(iprp.children!, 'ipco')!;
  const ipma = findBox(iprp.children!, 'ipma')!;
  const association = parseIpma(ipma.data).find((entry) => entry.itemId === info.primaryItemId)!;
  const properties = association.propertyIndexes
    .map((index) => ipco.children![index - 1])
    .filter((property) => property.type !== 'colr')
    .map((property) => box(property.type, property.data));
  const data = getItemPayload(officialInput, boxes, info.primaryItemId)!;
  return {
    id: info.primaryItemId,
    type: info.primaryItemType,
    data,
    properties,
  };
}

const nclx = box('colr', Buffer.from('nclx'), u16(9), u16(16), u16(9), Buffer.from([0x80])),
  profData = Uint8Array.from([1, 2, 3, 4]),
  restrictedData = Uint8Array.from([5, 6, 7]),
  prof = box('colr', Buffer.from('prof'), profData),
  rICC = box('colr', Buffer.from('rICC'), restrictedData);

function itemWithColorProperties(colorProperties: Uint8Array[]) {
  const item = rewrappedOfficialItem();
  return buildHeif([{ ...item, properties: [...item.properties, ...colorProperties] }], item.id);
}

describe('HEIF colour information properties', () => {
  it('keeps nclx and both ICC forms independent of property order', () => {
    const first = getHeicMetadata(itemWithColorProperties([nclx, rICC, prof])),
      reordered = getHeicMetadata(itemWithColorProperties([prof, nclx, rICC]));

    for (const metadata of [first, reordered]) {
      expect(metadata.color).toEqual({ primaries: 9, transfer: 16, matrix: 9, fullRange: true });
      expect(metadata.iccProfiles).toEqual([
        { type: 'prof', data: profData },
        { type: 'rICC', data: restrictedData },
      ]);
      expect(metadata.iccType).toBe('prof');
      expect(metadata.icc).toEqual(profData);
    }
  });

  it('rejects duplicate properties of one colour type but allows distinct types', () => {
    for (const duplicate of [
      [nclx, nclx],
      [prof, prof],
      [rICC, rICC],
    ]) {
      const input = itemWithColorProperties(duplicate);
      expect(() => getHeicMetadata(input)).toThrow('duplicate colr property');
    }

    const valid = itemWithColorProperties([nclx, prof, rICC]);
    expect(() => getHeicMetadata(valid)).not.toThrow();
  });

  it('rejects a truncated colour type field', () => {
    const malformed = box('colr', Buffer.from([0x6e, 0x63]));
    const input = itemWithColorProperties([malformed]);
    expect(() => getHeicMetadata(input)).toThrow('truncated color information type');
  });
});
