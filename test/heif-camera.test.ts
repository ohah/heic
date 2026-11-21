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
  const boxes = parseISOBMFF(officialInput),
    info = getHeicInfo(officialInput, boxes),
    meta = findBox(boxes, 'meta')!,
    iprp = findBox(meta.children!, 'iprp')!,
    ipco = findBox(iprp.children!, 'ipco')!,
    ipma = findBox(iprp.children!, 'ipma')!,
    association = parseIpma(ipma.data).find((entry) => entry.itemId === info.primaryItemId)!,
    properties = association.propertyIndexes
      .map((index) => ipco.children![index - 1])
      .filter(
        (property) => !['clap', 'irot', 'imir', 'iscl', 'cmex', 'cmin'].includes(property.type),
      )
      .map((property) => box(property.type, property.data)),
    data = getItemPayload(officialInput, boxes, info.primaryItemId)!;
  return {
    id: info.primaryItemId,
    type: info.primaryItemType,
    data,
    properties,
    width: info.width,
    height: info.height,
  };
}

function signed16(value: number): Uint8Array {
  const bytes = Buffer.alloc(2);
  bytes.writeInt16BE(value);
  return bytes;
}

function signed32(value: number): Uint8Array {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
}

function fullFlags(type: string, version: number, flags: number, ...parts: Uint8Array[]) {
  return box(
    type,
    Buffer.from([version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff]),
    ...parts,
  );
}

const cameraTransform = (rotation = 0) => box('irot', Buffer.from([rotation]));

function itemWithProperties(properties: Uint8Array[]) {
  const item = rewrappedOfficialItem();
  return buildHeif([{ ...item, properties: [...item.properties, ...properties] }], item.id);
}

describe('HEIF camera calibration properties', () => {
  it('parses multiple cmex properties and enforces their required coordinate ids', () => {
    const positionAndRotation = fullFlags(
        'cmex',
        0,
        0x01 | 0x04 | 0x08 | 0x20,
        signed32(-12),
        signed32(34),
        signed16(-4096),
        signed16(8192),
        signed16(0),
        u32(7),
      ),
      origin = fullFlags('cmex', 0, 0x20, u32(7)),
      input = itemWithProperties([positionAndRotation, origin]),
      metadata = getHeicMetadata(input);

    expect(metadata.cameraExtrinsics).toHaveLength(2);
    expect(metadata.cameraExtrinsics?.[0]).toMatchObject({
      version: 0,
      positionMicrometers: { x: -12, y: 0, z: 34 },
      quaternionComponents: [-4096, 8192, 0],
      coordinateSystemId: 7,
    });
    expect(metadata.cameraExtrinsics?.[1]).toMatchObject({
      positionMicrometers: { x: 0, y: 0, z: 0 },
      coordinateSystemId: 7,
    });
    expect(() =>
      getHeicMetadata(itemWithProperties([positionAndRotation, fullFlags('cmex', 0, 0)])),
    ).toThrow('every cmex must signal an id');
  });

  it('computes full and simplified cmin matrices in output-image pixel dimensions', () => {
    const item = rewrappedOfficialItem(),
      full = fullFlags(
        'cmin',
        0,
        1 | (8 << 8) | (5 << 16),
        signed32(256),
        signed32(128),
        signed32(64),
        signed32(512),
        signed32(32),
      ),
      rotated = buildHeif(
        [
          {
            ...item,
            properties: [...item.properties, full, cameraTransform(1)],
          },
        ],
        item.id,
      ),
      fullInfo = getHeicMetadata(rotated),
      outputWidth = item.height,
      outputHeight = item.width;

    expect(fullInfo.cameraIntrinsics).toMatchObject({
      version: 0,
      denominatorShift: 8,
      skewDenominatorShift: 5,
      matrix: [
        [(256 * outputWidth) / 256, 1, (128 * outputWidth) / 256],
        [0, (512 * outputHeight) / 256, (64 * outputHeight) / 256],
        [0, 0, 1],
      ],
    });

    const simplified = fullFlags('cmin', 0, 8 << 8, signed32(256), signed32(128), signed32(64));
    const simplifiedInfo = getHeicMetadata(itemWithProperties([simplified])).cameraIntrinsics!;
    expect(simplifiedInfo).toMatchObject({
      focalLengthX: 256,
      matrix: [
        [item.width, 0, item.width / 2],
        [0, item.width, item.height / 4],
        [0, 0, 1],
      ],
    });
    expect(simplifiedInfo).not.toHaveProperty('focalLengthY');
    expect(simplifiedInfo).not.toHaveProperty('skewFactor');
  });

  it('ignores camera properties that follow an image transform', () => {
    const item = rewrappedOfficialItem(),
      input = buildHeif(
        [
          {
            ...item,
            properties: [
              ...item.properties,
              cameraTransform(1),
              fullFlags('cmex', 0, 0),
              fullFlags('cmin', 0, 0, signed32(1), signed32(2), signed32(3)),
            ],
          },
        ],
        item.id,
      );
    expect(getHeicMetadata(input).cameraExtrinsics).toBeUndefined();
    expect(getHeicMetadata(input).cameraIntrinsics).toBeUndefined();
  });

  it('parses version-1 cmex rotation and leaves decoded pixels unchanged', () => {
    const baseline = itemWithProperties([]),
      cameraMetadata = itemWithProperties([
        fullFlags('cmex', 1, 0x08 | 0x20, signed32(-45), signed32(30), signed32(-5), u32(11)),
        fullFlags('cmin', 1, 0, Buffer.from([6, 7, 8, 9])),
        fullFlags('cmex', 2, 0x20, u32(12), Buffer.from([10, 11])),
      ]),
      metadata = getHeicMetadata(cameraMetadata);

    expect(metadata.cameraExtrinsics?.[0]).toMatchObject({
      version: 1,
      rotationAnglesDegrees: { yaw: -45, pitch: 30, roll: -5 },
      coordinateSystemId: 11,
    });
    expect(metadata.cameraExtrinsics?.[1]).toMatchObject({ version: 2, flags: 0x20 });
    expect(metadata.cameraIntrinsics).toMatchObject({ version: 1, raw: expect.any(Uint8Array) });
    expect(metadata.cameraIntrinsics?.matrix).toBeUndefined();
    expect(decodeHeic(cameraMetadata)).toEqual(decodeHeic(baseline));
  });

  it('rejects duplicate cmin properties, malformed lengths, and reserved flags', () => {
    const valid = fullFlags('cmin', 0, 0, signed32(1), signed32(2), signed32(3));
    for (const properties of [
      [valid, valid],
      [fullFlags('cmin', 0, 0, signed32(1), signed32(2))],
      [fullFlags('cmin', 0, 0x02, signed32(1), signed32(2), signed32(3))],
      [fullFlags('cmex', 0, 0x40)],
      [fullFlags('cmex', 0, 0x01, signed32(1), Buffer.from([0]))],
      [fullFlags('cmex', 1, 0x08, signed32(180), signed32(0), signed32(0))],
      [fullFlags('cmex', 1, 0x08, signed32(0), signed32(91), signed32(0))],
    ])
      expect(() => getHeicMetadata(itemWithProperties(properties))).toThrow();
  });
});
