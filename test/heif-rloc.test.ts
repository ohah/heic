import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { getHeicMetadata } from '../src/decoder';
import { getHeicInfo, getItemPayload, parseIpma } from '../src/container/heic';
import { findBox, parseISOBMFF } from '../src/container/heif';
import { box, buildHeif, full, u32 } from './helpers/heif';

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
  const properties = association.propertyIndexes.map((index) => {
    const property = ipco.children![index - 1];
    return box(property.type, property.data);
  });
  const data = getItemPayload(officialInput, boxes, info.primaryItemId)!;
  return { id: info.primaryItemId, type: info.primaryItemType, data, properties };
}

function relatedLocationFile(
  properties: Uint8Array[],
  relatedIds: number[] = [202],
  includeBase = true,
) {
  const source = rewrappedOfficialItem();
  const primary = {
    ...source,
    id: 101,
    properties: [...source.properties, ...properties],
    refs: relatedIds.length ? [{ type: 'tbas', to: relatedIds }] : [],
  };
  const items = [primary];
  if (includeBase) items.push({ ...source, id: 202 });
  return buildHeif(items, primary.id);
}

describe('HEIF relative location property', () => {
  it('exposes offsets and the related base item named by tbas', () => {
    const input = relatedLocationFile([full('rloc', 0, u32(320), u32(240))]);
    expect(getHeicMetadata(input).relativeLocation).toEqual({
      horizontalOffset: 320,
      verticalOffset: 240,
      relatedItemId: 202,
    });
  });

  it('requires one existing tbas target and one valid rloc property', () => {
    const valid = full('rloc', 0, u32(0), u32(0));
    const invalidInputs = [
      relatedLocationFile([valid], [], true),
      relatedLocationFile([], [202], true),
      relatedLocationFile([valid], [101], true),
      relatedLocationFile([valid], [202, 203], true),
      relatedLocationFile([valid], [303], false),
      relatedLocationFile([valid, valid]),
      relatedLocationFile([full('rloc', 1, u32(1), u32(1))]),
      relatedLocationFile([box('rloc', Buffer.alloc(8))]),
    ];
    for (const input of invalidInputs) expect(() => getHeicMetadata(input)).toThrow();
  });
});
