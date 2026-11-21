import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { decodeHDRSync } from '../src';
import { decodeHeic, getHeicMetadata } from '../src/decoder';
import { getHeicInfo, getItemPayload, parseIpma } from '../src/container/heic';
import { findBox, parseISOBMFF } from '../src/container/heif';
import { box, buildHeif, full, u16 } from './helpers/heif';

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

const iscl = (widthN: number, widthD: number, heightN: number, heightD: number) =>
  full('iscl', 0, u16(widthN), u16(widthD), u16(heightN), u16(heightD));

describe('HEIF image scaling property', () => {
  it('applies rational scaling in property order with ceiling output dimensions', () => {
    const item = rewrappedOfficialItem();
    const baseline = buildHeif([item], item.id);
    const sourceInfo = getHeicMetadata(baseline);
    const scaledFirst = buildHeif(
      [
        {
          ...item,
          properties: [...item.properties, iscl(2, 3, 3, 2), box('irot', Buffer.from([1]))],
        },
      ],
      item.id,
    );
    const scaledAfterRotation = buildHeif(
      [
        {
          ...item,
          properties: [...item.properties, box('irot', Buffer.from([1])), iscl(2, 3, 3, 2)],
        },
      ],
      item.id,
    );
    const raw = decodeHeic(scaledFirst, { applyTransforms: false });
    const scaledImage = decodeHeic(scaledFirst);
    const scaledHdrImage = decodeHDRSync(scaledFirst);
    const rotatedThenScaledImage = decodeHeic(scaledAfterRotation);
    const scaledWidth = Math.ceil((sourceInfo.width * 2) / 3);
    const scaledHeight = Math.ceil((sourceInfo.height * 3) / 2);

    expect(getHeicMetadata(scaledFirst).transforms).toEqual([
      {
        type: 'iscl',
        targetWidthNumerator: 2,
        targetWidthDenominator: 3,
        targetHeightNumerator: 3,
        targetHeightDenominator: 2,
      },
      { type: 'irot', value: 1 },
    ]);
    expect(raw.width).toBe(sourceInfo.width);
    expect(raw.height).toBe(sourceInfo.height);
    expect(raw.data).toEqual(decodeHeic(baseline).data);
    expect(scaledImage.width).toBe(scaledHeight);
    expect(scaledImage.height).toBe(scaledWidth);
    expect(scaledHdrImage.width).toBe(scaledHeight);
    expect(scaledHdrImage.height).toBe(scaledWidth);
    expect(rotatedThenScaledImage.width).toBe(Math.ceil((sourceInfo.height * 2) / 3));
    expect(rotatedThenScaledImage.height).toBe(Math.ceil((sourceInfo.width * 3) / 2));
  });

  it('rejects duplicate properties, nonzero full-box headers, and zero ratios', () => {
    const item = rewrappedOfficialItem();
    const invalidProperties = [
      [iscl(1, 1, 1, 1), iscl(2, 1, 2, 1)],
      [box('iscl', Buffer.alloc(8))],
      [full('iscl', 1, u16(1), u16(1), u16(1), u16(1))],
      [iscl(0, 1, 1, 1)],
      [iscl(1, 0, 1, 1)],
      [iscl(1, 1, 0, 1)],
      [iscl(1, 1, 1, 0)],
    ];

    for (const properties of invalidProperties) {
      const input = buildHeif(
        [{ ...item, properties: [...item.properties, ...properties] }],
        item.id,
      );
      expect(() => getHeicMetadata(input)).toThrow();
    }
  });

  it('enforces maxPixels for the scaled output', () => {
    const item = rewrappedOfficialItem();
    const input = buildHeif(
      [{ ...item, properties: [...item.properties, iscl(2, 1, 2, 1)] }],
      item.id,
    );
    const info = getHeicMetadata(input);
    expect(() => decodeHeic(input, { maxPixels: info.width * info.height + 1 })).toThrow(
      'maxPixels',
    );
  });
});
