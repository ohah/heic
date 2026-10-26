// Small standards-shaped containers for codec/derived-image regression tests.
import { readFileSync } from 'node:fs';
import { parseISOBMFF, findBox } from '../../src/container/heif';
import { getHeicInfo, getItemPayload } from '../../src/container/heic';
export const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
export const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
};
export const box = (type: string, ...parts: Uint8Array[]) => {
  const data = Buffer.concat(parts);
  return Buffer.concat([u32(data.length + 8), Buffer.from(type), data]);
};
export const full = (type: string, version: number, ...parts: Uint8Array[]) =>
  box(type, Buffer.from([version, 0, 0, 0]), ...parts);
export interface Item {
  id: number;
  type: string;
  data: Uint8Array;
  properties: Uint8Array[];
  refs?: { type: string; to: number[] }[];
}
export function codedFixture(depth = 8): Item {
  const input = new Uint8Array(
      readFileSync(new URL(`../fixtures/conformance/pattern-${depth}.heic`, import.meta.url)),
    ),
    boxes = parseISOBMFF(input),
    m = getHeicInfo(input, boxes),
    meta = findBox(boxes, 'meta')!,
    iprp = findBox(meta.children!, 'iprp')!,
    props = findBox(iprp.children!, 'ipco')!.children!;
  return {
    id: 1,
    type: 'hvc1',
    data: getItemPayload(input, boxes, m.primaryItemId)!,
    properties: props.map((p) => box(p.type, p.data)),
  };
}
export function buildHeif(items: Item[], primary: number): Uint8Array {
  const ftyp = box('ftyp', Buffer.from('heic'), u32(0), Buffer.from('heicmif1'));
  const properties = items.flatMap((i) => i.properties),
    associations: Uint8Array[] = [];
  let propertyIndex = 1;
  for (const item of items) {
    const indexes = item.properties.map(() => 0x80 | propertyIndex++);
    associations.push(Buffer.concat([u16(item.id), Buffer.from([indexes.length, ...indexes])]));
  }
  const iprp = box(
    'iprp',
    box('ipco', ...properties),
    full('ipma', 0, u32(items.length), ...associations),
  );
  const iinf = full(
    'iinf',
    0,
    u16(items.length),
    ...items.map((item) =>
      full('infe', 2, u16(item.id), u16(0), Buffer.from(item.type), Buffer.from([0])),
    ),
  );
  const iref = full(
    'iref',
    0,
    ...items.flatMap((item) =>
      (item.refs ?? []).map((ref) =>
        box(ref.type, u16(item.id), u16(ref.to.length), ...ref.to.map(u16)),
      ),
    ),
  );
  const meta = (start: number) => {
    let offset = start;
    return full(
      'meta',
      0,
      full('hdlr', 0, u32(0), Buffer.from('pict'), Buffer.alloc(13)),
      full('pitm', 0, u16(primary)),
      iinf,
      full(
        'iloc',
        0,
        Buffer.from([0x44, 0]),
        u16(items.length),
        ...items.map((item) => {
          const entry = Buffer.concat([
            u16(item.id),
            u16(0),
            u16(1),
            u32(offset),
            u32(item.data.length),
          ]);
          offset += item.data.length;
          return entry;
        }),
      ),
      iprp,
      iref,
    );
  };
  return Buffer.concat([
    ftyp,
    meta(ftyp.length + meta(0).length + 8),
    box('mdat', ...items.map((item) => item.data)),
  ]);
}
export const nclx = () =>
  box('colr', Buffer.from('nclx'), u16(1), u16(13), u16(6), Buffer.from([128]));
export function isoMetadata(multichannel = false): Uint8Array {
  const ratio = (n: number) => Buffer.concat([u32(n), u32(1)]);
  return Buffer.concat([
    Buffer.from([0, 0, 0, 0, 0, multichannel ? 0xc0 : 0x40]),
    ratio(0),
    ratio(2),
    ...Array.from({ length: multichannel ? 3 : 1 }, () =>
      Buffer.concat([ratio(0), ratio(2), ratio(1), ratio(0), ratio(0)]),
    ),
  ]);
}
export function isoFixture(depth = 8): Uint8Array {
  const base = codedFixture(depth),
    gain = { ...codedFixture(depth), id: 2 },
    tmap: Item = {
      id: 3,
      type: 'tmap',
      data: isoMetadata(),
      properties: [full('ispe', 0, u32(64), u32(64)), nclx()],
      refs: [{ type: 'dimg', to: [1, 2] }],
    };
  return buildHeif([base, gain, tmap], 3);
}
export function alphaFixture(depth = 8): Uint8Array {
  const color = codedFixture(depth),
    alpha = {
      ...codedFixture(depth),
      id: 2,
      properties: [
        ...codedFixture(depth).properties,
        full('auxC', 0, Buffer.from('urn:mpeg:hevc:2015:auxid:1\0')),
      ],
      refs: [{ type: 'auxl', to: [1] }],
    };
  return buildHeif([color, alpha], 1);
}
