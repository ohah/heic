import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { decodeHeic, getHeicMetadata } from '../src/decoder';
import { getHeicInfo, getItemPayload, parseIpma } from '../src/container/heic';
import { findBox, parseISOBMFF } from '../src/container/heif';
import { box, buildHeif, u32 } from './helpers/heif';

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
  return {
    id: info.primaryItemId,
    type: info.primaryItemType,
    data,
    properties,
  };
}

describe('HEIF pixel aspect ratio property', () => {
  it('exposes pasp spacing while preserving official HEVC samples', () => {
    const item = rewrappedOfficialItem();
    const baseline = buildHeif([item], item.id);
    const withPasp = buildHeif(
      [
        {
          ...item,
          properties: [...item.properties, box('pasp', u32(4), u32(3))],
        },
      ],
      item.id,
    );

    expect(getHeicInfo(baseline, parseISOBMFF(baseline)).pixelAspectRatio).toEqual({
      horizontalSpacing: 1,
      verticalSpacing: 1,
    });
    expect(getHeicMetadata(withPasp).pixelAspectRatio).toEqual({
      horizontalSpacing: 4,
      verticalSpacing: 3,
    });
    expect(decodeHeic(withPasp)).toEqual(decodeHeic(baseline));
  });

  it('rejects duplicate, truncated, or zero-spacing pasp properties', () => {
    const item = rewrappedOfficialItem();
    const invalidProperties = [
      [...item.properties, box('pasp', u32(4))],
      [...item.properties, box('pasp', u32(0), u32(3))],
      [...item.properties, box('pasp', u32(4), u32(3)), box('pasp', u32(1), u32(1))],
    ];

    for (const properties of invalidProperties) {
      const input = buildHeif([{ ...item, properties }], item.id);
      expect(() => getHeicMetadata(input)).toThrow();
    }
  });
});
