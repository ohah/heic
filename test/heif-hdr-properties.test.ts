import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { decodeHeic, getHeicMetadata } from '../src/decoder';
import { getHeicInfo, getItemPayload, parseIpma } from '../src/container/heic';
import { findBox, parseISOBMFF } from '../src/container/heif';
import { box, buildHeif, full, u16, u32 } from './helpers/heif';

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

function signed32(value: number): Uint8Array {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
}

const hdrProperties = () => [
  box('clli', u16(1000), u16(400)),
  box(
    'mdcv',
    u16(8500),
    u16(39850),
    u16(6550),
    u16(2300),
    u16(35400),
    u16(14600),
    u16(15635),
    u16(16450),
    u32(10_000_000),
    u32(50),
  ),
  box(
    'cclv',
    Buffer.from([0x3c]),
    signed32(1_000_000),
    signed32(2_000_000),
    signed32(-1_000_000),
    signed32(2_500_000),
    signed32(3_000_000),
    signed32(4_000_000),
    u32(10),
    u32(20),
    u32(15),
  ),
  box('amve', u32(20_000), u16(34_000), u16(16_000)),
  full('reve', 0, u32(5000), u16(3127), u16(3290), u32(10000), u16(3127), u16(3290)),
  full('ndwt', 0, u32(2_030_000)),
];

describe('HEIF HDR descriptive item properties', () => {
  it('exposes all six properties while preserving official HEVC pixels', () => {
    const item = rewrappedOfficialItem();
    const baseline = buildHeif([item], item.id);
    const withHdrProperties = buildHeif(
      [{ ...item, properties: [...item.properties, ...hdrProperties()] }],
      item.id,
    );

    expect(getHeicMetadata(baseline).heifHdrProperties).toBeUndefined();
    expect(getHeicMetadata(withHdrProperties).heifHdrProperties).toEqual({
      contentLightLevelInfo: {
        maxContentLightLevel: 1000,
        maxPicAverageLightLevel: 400,
      },
      masteringDisplayColourVolume: {
        displayPrimaries: [
          { x: 8500, y: 39850 },
          { x: 6550, y: 2300 },
          { x: 35400, y: 14600 },
        ],
        whitePoint: { x: 15635, y: 16450 },
        maxDisplayMasteringLuminance: 10_000_000,
        minDisplayMasteringLuminance: 50,
      },
      contentColourVolume: {
        primaries: [
          { x: 1_000_000, y: 2_000_000 },
          { x: -1_000_000, y: 2_500_000 },
          { x: 3_000_000, y: 4_000_000 },
        ],
        minLuminanceValue: 10,
        maxLuminanceValue: 20,
        averageLuminanceValue: 15,
      },
      ambientViewingEnvironment: {
        ambientIlluminance: 20_000,
        ambientLightX: 34_000,
        ambientLightY: 16_000,
      },
      referenceViewingEnvironment: {
        surroundLuminance: 5000,
        surroundLightX: 3127,
        surroundLightY: 3290,
        peripheryLuminance: 10_000,
        peripheryLightX: 3127,
        peripheryLightY: 3290,
      },
      nominalDiffuseWhiteLuminance: 2_030_000,
    });
    expect(decodeHeic(withHdrProperties)).toEqual(decodeHeic(baseline));
  });

  it('rejects duplicate properties, invalid sizes, and reserved header values', () => {
    const item = rewrappedOfficialItem();
    const invalidPropertySets = [
      [...hdrProperties(), box('clli', u16(1), u16(2))],
      [box('clli', u16(1))],
      [box('mdcv', u32(1))],
      [box('cclv', Buffer.from([0x80]))],
      [box('cclv', Buffer.from([0]))],
      [box('cclv', Buffer.from([0x20]), Buffer.alloc(4))],
      [box('amve', u32(0), u16(1), u16(1))],
      [full('reve', 0, u32(1), u16(10_001), u16(1), u32(1), u16(1), u16(1))],
      [full('reve', 1, u32(1), u16(1), u16(1), u32(1), u16(1), u16(1))],
      [full('ndwt', 0, u32(1), u32(2))],
    ];

    for (const properties of invalidPropertySets) {
      const input = buildHeif(
        [{ ...item, properties: [...item.properties, ...properties] }],
        item.id,
      );
      expect(() => getHeicMetadata(input)).toThrow();
    }
  });
});
