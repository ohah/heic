import { describe, expect, it } from 'bun:test';
import type { ISOBMFFBox, ItemLocation, ItemLocationExtent } from '../src/container/heif';
import { getItemPayload } from '../src/container/heic';

interface ReferenceSpec {
  fromItemId: number;
  toItemIds: number[];
}

function makeIloc(items: ItemLocation[], indexSize: 0 | 4 = 4): Uint8Array {
  const size =
    8 + items.reduce((total, item) => total + 12 + item.extents.length * (indexSize + 8), 0);
  const data = new Uint8Array(size);
  const view = new DataView(data.buffer);
  data[0] = 1;
  data[4] = 0x44; // 4-byte extent offsets and lengths
  data[5] = 0x40 | indexSize; // 4-byte base offsets and optional extent indices
  view.setUint16(6, items.length);
  let offset = 8;
  for (const item of items) {
    view.setUint16(offset, item.itemId);
    view.setUint16(offset + 2, item.constructionMethod);
    view.setUint16(offset + 4, item.dataReferenceIndex);
    view.setUint32(offset + 6, item.baseOffset);
    view.setUint16(offset + 10, item.extents.length);
    offset += 12;
    for (const extent of item.extents) {
      if (indexSize > 0) {
        view.setUint32(offset, extent.extentIndex ?? 0);
        offset += indexSize;
      }
      view.setUint32(offset, extent.extentOffset);
      view.setUint32(offset + 4, extent.extentLength);
      offset += 8;
    }
  }
  return data;
}

function makeIref(references: ReferenceSpec[]): ISOBMFFBox {
  const children = references.map(({ fromItemId, toItemIds }) => {
    const data = new Uint8Array(4 + toItemIds.length * 2);
    const view = new DataView(data.buffer);
    view.setUint16(0, fromItemId);
    view.setUint16(2, toItemIds.length);
    toItemIds.forEach((id, index) => view.setUint16(4 + index * 2, id));
    return { type: 'iloc', size: data.length + 8, offset: 0, data };
  });
  return { type: 'iref', size: 0, offset: 0, data: new Uint8Array(4), children };
}

function makeBoxes(
  items: ItemLocation[],
  references: ReferenceSpec[],
  indexSize: 0 | 4 = 4,
): ISOBMFFBox[] {
  const metaChildren: ISOBMFFBox[] = [
    { type: 'iloc', size: 0, offset: 0, data: makeIloc(items, indexSize) },
    { type: 'iinf', size: 0, offset: 0, data: Uint8Array.from([0, 0, 0, 0, 0, 0]) },
    makeIref(references),
  ];
  return [{ type: 'meta', size: 0, offset: 0, data: new Uint8Array(), children: metaChildren }];
}

function location(
  itemId: number,
  constructionMethod: number,
  baseOffset: number,
  extents: ItemLocationExtent[],
): ItemLocation {
  return { itemId, constructionMethod, dataReferenceIndex: 0, baseOffset, extents };
}

describe('iloc construction method 2', () => {
  it('selects referenced items, concatenates extents, and resolves nested item offsets', () => {
    const buffer = new Uint8Array(64);
    buffer.set(new TextEncoder().encode('AB'), 10);
    buffer.set(new TextEncoder().encode('CD'), 20);
    buffer.set(new TextEncoder().encode('WXYZ'), 30);
    const items = [
      location(10, 0, 0, [
        { extentIndex: 0, extentOffset: 10, extentLength: 2 },
        { extentIndex: 0, extentOffset: 20, extentLength: 2 },
      ]),
      location(11, 0, 0, [{ extentIndex: 0, extentOffset: 30, extentLength: 4 }]),
      location(12, 2, 1, [
        { extentIndex: 1, extentOffset: 0, extentLength: 2 },
        { extentIndex: 2, extentOffset: 1, extentLength: 2 },
      ]),
      location(13, 2, 0, [{ extentIndex: 1, extentOffset: 1, extentLength: 2 }]),
    ];
    const boxes = makeBoxes(items, [
      { fromItemId: 12, toItemIds: [10, 11] },
      { fromItemId: 13, toItemIds: [12] },
    ]);

    expect(Buffer.from(getItemPayload(buffer, boxes, 12)!).toString()).toBe('BCYZ');
    expect(Buffer.from(getItemPayload(buffer, boxes, 13)!).toString()).toBe('CY');
  });

  it('implies reference index one and the remaining source length for a single extent', () => {
    const buffer = new Uint8Array(16);
    buffer.set(new TextEncoder().encode('ABCD'), 8);
    const boxes = makeBoxes(
      [
        location(20, 0, 0, [{ extentOffset: 8, extentLength: 4 }]),
        location(21, 2, 0, [{ extentOffset: 2, extentLength: 0 }]),
      ],
      [{ fromItemId: 21, toItemIds: [20] }],
      0,
    );

    expect(Buffer.from(getItemPayload(buffer, boxes, 21)!).toString()).toBe('CD');
  });

  it('rejects missing references, reserved indices, and source ranges outside the item', () => {
    const buffer = new Uint8Array(16);
    buffer.set(new TextEncoder().encode('DATA'), 8);
    const source = location(30, 0, 0, [{ extentIndex: 0, extentOffset: 8, extentLength: 4 }]);

    const missingReference = makeBoxes(
      [location(31, 2, 0, [{ extentIndex: 1, extentOffset: 0, extentLength: 1 }])],
      [],
    );
    expect(() => getItemPayload(buffer, missingReference, 31)).toThrow('extent reference index');

    const reservedIndex = makeBoxes(
      [source, location(32, 2, 0, [{ extentIndex: 0, extentOffset: 0, extentLength: 1 }])],
      [{ fromItemId: 32, toItemIds: [30] }],
    );
    expect(() => getItemPayload(buffer, reservedIndex, 32)).toThrow('extent reference index');

    const outOfBounds = makeBoxes(
      [source, location(33, 2, 0, [{ extentIndex: 1, extentOffset: 3, extentLength: 2 }])],
      [{ fromItemId: 33, toItemIds: [30] }],
    );
    expect(() => getItemPayload(buffer, outOfBounds, 33)).toThrow('referenced item bounds');
  });

  it('rejects cyclic item-offset references', () => {
    const buffer = new Uint8Array(16);
    const boxes = makeBoxes(
      [
        location(40, 2, 0, [{ extentIndex: 1, extentOffset: 0, extentLength: 1 }]),
        location(41, 2, 0, [{ extentIndex: 1, extentOffset: 0, extentLength: 1 }]),
      ],
      [
        { fromItemId: 40, toItemIds: [41] },
        { fromItemId: 41, toItemIds: [40] },
      ],
    );

    expect(() => getItemPayload(buffer, boxes, 40)).toThrow('cyclic item-offset reference');
  });
});
