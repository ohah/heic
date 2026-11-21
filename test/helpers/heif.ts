// Small standards-shaped containers for codec/derived-image regression tests.
import { readFileSync } from 'node:fs';
import { parseISOBMFF, findBox } from '../../src/container/heif';
import { getItemPayload, parseHvcC, parsePitm } from '../../src/container/heic';
import { toRbsp } from '../../src/hevc/nal';
import { parseSps } from '../../src/hevc/sps';
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
  /** Zero-based indexes into `properties` associated with this item. */
  propertyAssociationIndexes?: readonly number[];
  dataReference?: Uint8Array;
  /** `iloc` offset used when `dataReference` points to an external `url ` entry. */
  externalDataOffset?: number;
  refs?: { type: string; to: number[] }[];
}
export function codedFixture(depth = 8, pattern = 'pattern'): Item {
  const input = new Uint8Array(
      readFileSync(new URL(`../fixtures/conformance/${pattern}-${depth}.heic`, import.meta.url)),
    ),
    boxes = parseISOBMFF(input),
    meta = findBox(boxes, 'meta')!,
    iprp = findBox(meta.children!, 'iprp')!,
    props = findBox(iprp.children!, 'ipco')!.children!,
    primaryItemId = parsePitm(findBox(meta.children!, 'pitm')!.data),
    data = getItemPayload(input, boxes, primaryItemId)!;
  return {
    id: primaryItemId,
    type: 'hvc1',
    data,
    properties: props.map((p) => {
      if (p.type !== 'hvcC') return box(p.type, p.data);
      // The tiny pattern fixtures predate hvcC/pixi depth cross-checking and
      // carry placeholder configuration bytes. Repair their record from SPS.
      const configuration = Buffer.from(p.data),
        hvcC = parseHvcC(p.data),
        sps = hvcC.sps[0],
        parsedSps = parseSps(sps),
        rbsp = toRbsp(sps);
      configuration.set(rbsp.subarray(1, 13), 1);
      configuration[16] = (configuration[16] & 0xfc) | parsedSps.chromaFormatIdc;
      configuration[17] = (configuration[17] & 0xf8) | (parsedSps.bitDepthLuma - 8);
      configuration[18] = (configuration[18] & 0xf8) | (parsedSps.bitDepthChroma - 8);
      configuration[21] = ((((rbsp[0] >> 1) & 7) + 1) << 3) | ((rbsp[0] & 1) << 2) | 3;
      return box('hvcC', configuration);
    }),
  };
}
export function buildHeif(
  items: Item[],
  primary: number,
  entityGroups: Uint8Array[] = [],
): Uint8Array {
  const hasUncompressedItem = items.some((item) => item.type === 'unci');
  const needsExtendedBrand = items.some((item) => {
    const hvcCProperty = item.properties.find(
      (property) => property.length >= 8 && property.toString('ascii', 4, 8) === 'hvcC',
    );
    if (!hvcCProperty) return false;
    const config = parseHvcC(hvcCProperty.subarray(8));
    return (
      config.chromaFormatIdc !== 1 ||
      config.bitDepthLumaMinus8 !== 0 ||
      config.bitDepthChromaMinus8 !== 0 ||
      ![1, 3].includes(config.generalProfileIdc)
    );
  });
  const brand = hasUncompressedItem ? 'mif1' : needsExtendedBrand ? 'heix' : 'heic';
  const ftyp = box('ftyp', Buffer.from(brand), u32(0), Buffer.from(brand + 'mif1'));
  const properties = items.flatMap((i) => i.properties),
    associations: Uint8Array[] = [];
  const useWideAssociations = properties.length > 0x7f;
  if (useWideAssociations && properties.length > 0x7fff)
    throw new Error('buildHeif property association index exceeds the 15-bit limit');
  let propertyIndex = 1;
  for (const item of items) {
    const firstPropertyIndex = propertyIndex;
    propertyIndex += item.properties.length;
    const localIndexes =
      item.propertyAssociationIndexes ?? item.properties.map((_, index) => index);
    if (
      localIndexes.some(
        (index) => !Number.isInteger(index) || index < 0 || index >= item.properties.length,
      )
    )
      throw new Error('buildHeif property association index is out of range');
    if (localIndexes.length > 0xff)
      throw new Error('buildHeif property association count exceeds the 8-bit limit');
    const indexes = localIndexes.map((index) => firstPropertyIndex + index);
    associations.push(
      Buffer.concat([
        useWideAssociations ? u32(item.id) : u16(item.id),
        Buffer.from([indexes.length]),
        ...indexes.map((index) =>
          useWideAssociations ? u16(0x8000 | index) : Buffer.from([0x80 | index]),
        ),
      ]),
    );
  }
  const iprp = box(
    'iprp',
    box('ipco', ...properties),
    box(
      'ipma',
      Buffer.from([useWideAssociations ? 1 : 0, 0, 0, useWideAssociations ? 1 : 0]),
      u32(items.length),
      ...associations,
    ),
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
  const dataReferences = [
    ...new Set(items.flatMap((item) => (item.dataReference ? [item.dataReference] : []))),
  ];
  const dataReferenceIndexes = new Map(
    dataReferences.map((reference, index) => [reference, index + 1]),
  );
  const dinf = dataReferences.length
    ? box('dinf', full('dref', 0, u32(dataReferences.length), ...dataReferences))
    : null;
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
          const externalReference =
            item.dataReference !== undefined &&
            item.dataReference.length >= 8 &&
            ['url ', 'urn '].includes(String.fromCharCode(...item.dataReference.subarray(4, 8)));
          const entry = Buffer.concat([
            u16(item.id),
            u16(item.dataReference ? dataReferenceIndexes.get(item.dataReference)! : 0),
            u16(1),
            u32(externalReference ? (item.externalDataOffset ?? 0) : offset),
            u32(item.data.length),
          ]);
          offset += item.data.length;
          return entry;
        }),
      ),
      iprp,
      ...(dinf ? [dinf] : []),
      iref,
      ...(entityGroups.length > 0 ? [box('grpl', ...entityGroups)] : []),
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
export function isoFixture(depth = 8, metadata = isoMetadata()): Uint8Array {
  const base = codedFixture(depth),
    gain = { ...codedFixture(depth), id: 2 },
    tmap: Item = {
      id: 3,
      type: 'tmap',
      data: metadata,
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
