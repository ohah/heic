import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { decodeHeic, decodeHeicAuxiliaryPlanes } from '../src/decoder';
import { decodeHDRSync } from '../src/hdr';
import { getHeicInfo, getItemPayload, parseHvcC, parseIpma } from '../src/container/heic';
import { findBox, parseISOBMFF } from '../src/container/heif';
import { hevcAlphaSampleToFactor } from '../src/hevc/heif-sei';
import { box, buildHeif, full, u32 } from './helpers/heif';

const officialInput = new Uint8Array(
  readFileSync(new URL('./fixtures/conformance/pcm-rext-422-10.heic', import.meta.url)),
);
const officialNalLengthSize = getHeicInfo(officialInput, parseISOBMFF(officialInput)).hvcC!
  .nalLengthSize;
const monochromeAlphaConfiguration = new Uint8Array(
  readFileSync(new URL('./fixtures/conformance/mini-alpha-L_8.hvcc', import.meta.url)),
);
const monochromeAlphaItem = new Uint8Array(
  readFileSync(new URL('./fixtures/conformance/mini-alpha-L_8.hevc', import.meta.url)),
);
const monochromeAlphaReference = new Uint8Array(
  readFileSync(new URL('./fixtures/conformance/mini-alpha-L_8.y', import.meta.url)),
);
const monochromeAlphaNalLengthSize = parseHvcC(monochromeAlphaConfiguration).nalLengthSize;

function bitPayload(fields: readonly [value: number, width: number][]): Buffer {
  const bits: number[] = [];
  for (const [value, width] of fields)
    for (let shift = width - 1; shift >= 0; shift--) bits.push((value >>> shift) & 1);
  bits.push(1); // payload_bit_equal_to_one
  while (bits.length % 8) bits.push(0);
  const payload = Buffer.alloc(bits.length / 8);
  bits.forEach((bit, index) => (payload[index >> 3] |= bit << (7 - (index & 7))));
  return payload;
}

function ue(value: number): [number, number][] {
  const code = value + 1,
    width = Math.floor(Math.log2(code)) + 1;
  return [...Array.from({ length: width - 1 }, () => [0, 1] as [number, number]), [code, width]];
}

function seiNal(payloadType: number, payload: Uint8Array): Buffer {
  const extended = (value: number) => {
    const bytes: number[] = [];
    while (value >= 255) {
      bytes.push(255);
      value -= 255;
    }
    bytes.push(value);
    return bytes;
  };
  const rbsp = Buffer.from([
    ...extended(payloadType),
    ...extended(payload.length),
    ...payload,
    0x80,
  ]);
  const escaped: number[] = [];
  let zeroes = 0;
  for (const byte of rbsp) {
    if (zeroes >= 2 && byte <= 3) {
      escaped.push(3);
      zeroes = 0;
    }
    escaped.push(byte);
    zeroes = byte === 0 ? zeroes + 1 : 0;
  }
  return Buffer.concat([Buffer.from([39 << 1, 1]), Buffer.from(escaped)]);
}

function auxiliarySubtype(nals: readonly Uint8Array[], nalLengthSize: number): Buffer {
  const records = nals.map((nal) => {
    const length = Buffer.alloc(nalLengthSize);
    for (let index = nalLengthSize - 1, remaining = nal.length; index >= 0; index--) {
      length[index] = remaining & 0xff;
      remaining = Math.floor(remaining / 256);
    }
    return Buffer.concat([length, Buffer.from(nal)]);
  });
  const contents = Buffer.concat(records),
    length = Buffer.alloc(4);
  length.writeUInt32BE(contents.length);
  return Buffer.concat([length, contents]);
}

function rewrappedOfficialAuxiliary(
  auxiliaryType = 'urn:mpeg:mpegB:cicp:systems:auxiliary:depth',
  subtype?: Uint8Array,
): Uint8Array {
  const boxes = parseISOBMFF(officialInput),
    info = getHeicInfo(officialInput, boxes),
    meta = findBox(boxes, 'meta')!,
    iprp = findBox(meta.children!, 'iprp')!,
    ipco = findBox(iprp.children!, 'ipco')!,
    ipma = findBox(iprp.children!, 'ipma')!,
    association = parseIpma(ipma.data).find((entry) => entry.itemId === info.primaryItemId)!,
    properties = association.propertyIndexes.map((index) => {
      const property = ipco.children![index - 1];
      return box(property.type, property.data);
    }),
    data = getItemPayload(officialInput, boxes, info.primaryItemId)!;
  const primary = { id: 1, type: 'hvc1', data, properties };
  const depth = {
    id: 2,
    type: 'hvc1',
    data,
    properties: [
      ...properties,
      full('auxC', 0, Buffer.from(auxiliaryType + '\0'), ...(subtype ? [subtype] : [])),
    ],
    refs: [{ type: 'auxl', to: [primary.id] }],
  };
  return buildHeif([primary, depth], primary.id);
}

function monochromeAlphaHeif(subtype?: Uint8Array): Uint8Array {
  const properties = [
    box('hvcC', monochromeAlphaConfiguration),
    full('ispe', 0, u32(128), u32(128)),
    full('pixi', 0, Buffer.from([1, 8])),
  ];
  const primary = {
    id: 1,
    type: 'hvc1',
    data: monochromeAlphaItem,
    properties,
  };
  const alpha = {
    id: 2,
    type: 'hvc1',
    data: monochromeAlphaItem,
    properties: [
      ...properties,
      full('auxC', 0, Buffer.from('urn:mpeg:hevc:2015:auxid:1\0'), ...(subtype ? [subtype] : [])),
    ],
    refs: [{ type: 'auxl', to: [primary.id] }],
  };
  return buildHeif([primary, alpha], primary.id);
}

describe('HEIF auxiliary image sample planes', () => {
  it('decodes an associated depth item and preserves the official 10-bit HEVC samples', () => {
    const input = rewrappedOfficialAuxiliary(),
      decoded = decodeHeicAuxiliaryPlanes(input);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]).toMatchObject({
      itemId: 2,
      type: 'urn:mpeg:mpegB:cicp:systems:auxiliary:depth',
      width: 416,
      height: 240,
      chromaFormatIdc: 2,
      bitDepthLuma: 10,
      bitDepthChroma: 10,
    });
    expect(decoded[0].y).toBeInstanceOf(Uint16Array);
    const planeBytes = (plane: Uint8Array | Uint16Array) =>
      Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength);
    const actual = Buffer.concat([
      planeBytes(decoded[0].y),
      planeBytes(decoded[0].cb),
      planeBytes(decoded[0].cr),
    ]);
    const expected = readFileSync(
      new URL('./fixtures/conformance/pcm-rext-422-10.yuv', import.meta.url),
    );
    expect(actual).toEqual(expected);
  });

  it('returns an empty list when the primary image has no auxiliary items', () => {
    expect(decodeHeicAuxiliaryPlanes(officialInput)).toEqual([]);
  });

  it('parses depth representation SEI from the HEVC auxC subtype', () => {
    const depthValue = (sign: number, exponent: number, width: number, mantissa: number) =>
        [
          [sign, 1],
          [exponent, 7],
          [width - 1, 5],
          [mantissa, width],
        ] as [number, number][],
      depthPayload = bitPayload([
        [1, 1], // z_near_flag
        [1, 1], // z_far_flag
        [1, 1], // d_min_flag
        [1, 1], // d_max_flag
        ...ue(3), // depth_representation_type: nonlinear
        ...ue(5), // disparity_ref_view_id
        ...depthValue(0, 1, 1, 1),
        ...depthValue(1, 2, 2, 2),
        ...depthValue(0, 3, 3, 5),
        ...depthValue(1, 4, 4, 10),
        ...ue(1), // depth_nonlinear_representation_num_minus1
        ...ue(0),
        ...ue(4),
      ]),
      reservedDepthPayload = bitPayload([
        [0, 4], // no optional depth values
        ...ue(4), // reserved representation type
        [0b10101, 5], // ignored by H.274 for types 4–15
      ]),
      input = rewrappedOfficialAuxiliary(
        'urn:mpeg:hevc:2015:auxid:2',
        auxiliarySubtype(
          [seiNal(177, depthPayload), seiNal(177, reservedDepthPayload)],
          officialNalLengthSize,
        ),
      ),
      decoded = decodeHeicAuxiliaryPlanes(input);

    expect(decoded[0].hevcAuxiliarySei).toEqual({
      depthRepresentationInfo: [
        {
          representationType: 3,
          disparityReferenceViewId: 5,
          zNear: { sign: false, exponent: 1, mantissaLength: 1, mantissa: 1 },
          zFar: { sign: true, exponent: 2, mantissaLength: 2, mantissa: 2 },
          dMin: { sign: false, exponent: 3, mantissaLength: 3, mantissa: 5 },
          dMax: { sign: true, exponent: 4, mantissaLength: 4, mantissa: 10 },
          nonlinearRepresentationModels: [0, 4],
        },
        { representationType: 4 },
      ],
      alphaChannelInfo: [],
    });
  });

  it('rejects depth representation values outside H.274 bounds', () => {
    const payloads: [Buffer, string][] = [
      [bitPayload([[0, 4], ...ue(16)]), 'depth_representation_type is out of range'],
      [
        bitPayload([[0, 4], ...ue(3), ...ue(63)]),
        'depth nonlinear representation model count is out of range',
      ],
      [
        bitPayload([[0, 4], ...ue(3), ...ue(0), ...ue(65_536)]),
        'depth nonlinear representation model is out of range',
      ],
      [
        bitPayload([[0, 1], [0, 1], [1, 1], [0, 1], ...ue(1), ...ue(1024)]),
        'disparity_ref_view_id is out of range',
      ],
    ];

    for (const [payload, message] of payloads) {
      const input = rewrappedOfficialAuxiliary(
        'urn:mpeg:hevc:2015:auxid:2',
        auxiliarySubtype([seiNal(177, payload)], officialNalLengthSize),
      );
      expect(() => decodeHeicAuxiliaryPlanes(input)).toThrow(message);
    }
  });

  it('parses alpha channel SEI while preserving its coded interpretation values', () => {
    const alphaPayload = bitPayload([
        [0, 1], // alpha_channel_cancel_flag
        [1, 3], // alpha_channel_use_idc
        [2, 3], // alpha_channel_bit_depth_minus8: 10-bit
        [0, 11], // alpha_transparent_value
        [1024, 11], // alpha_opaque_value (one past 10-bit maximum)
        [1, 1], // alpha_channel_incr_flag
        [1, 1], // alpha_channel_clip_flag
        [1, 1], // alpha_channel_clip_type_flag
      ]),
      cancelledAlphaPayload = bitPayload([[1, 1]]),
      input = rewrappedOfficialAuxiliary(
        'urn:mpeg:hevc:2015:auxid:1',
        auxiliarySubtype(
          [seiNal(165, alphaPayload), seiNal(165, cancelledAlphaPayload)],
          officialNalLengthSize,
        ),
      );

    expect(decodeHeicAuxiliaryPlanes(input)[0].hevcAuxiliarySei).toEqual({
      depthRepresentationInfo: [],
      alphaChannelInfo: [
        {
          cancelled: false,
          useIdc: 1,
          bitDepth: 10,
          transparentValue: 0,
          opaqueValue: 1024,
          increment: true,
          clip: true,
          clipType: 1,
        },
        { cancelled: true },
      ],
    });
  });

  it('applies alpha channel interpretation during SDR and HDR composition', () => {
    const alphaPayload = bitPayload([
        [0, 1], // alpha_channel_cancel_flag
        [0, 3], // alpha_channel_use_idc: straight alpha
        [0, 3], // alpha_channel_bit_depth_minus8: 8-bit
        [255, 9], // alpha_transparent_value
        [0, 9], // alpha_opaque_value
        [0, 1], // alpha_channel_incr_flag
        [0, 1], // alpha_channel_clip_flag
      ]),
      subtype = auxiliarySubtype([seiNal(165, alphaPayload)], monochromeAlphaNalLengthSize),
      input = monochromeAlphaHeif(subtype),
      raw = decodeHeicAuxiliaryPlanes(input)[0],
      image = decodeHeic(input),
      hdr = decodeHDRSync(input);

    expect(raw.y).toEqual(monochromeAlphaReference);
    expect(image).toMatchObject({ width: 128, height: 128, hasAlpha: true });
    expect(hdr).toMatchObject({ width: 128, height: 128, hasAlpha: true });
    for (let index = 0; index < monochromeAlphaReference.length; index++) {
      const inverted = 255 - monochromeAlphaReference[index];
      expect(image.data[index * 4 + 3]).toBe(inverted);
      expect(hdr.data[index * 4 + 3]).toBeCloseTo(inverted / 255, 6);
    }
  });

  it('uses the ACI premultiplied-black signal when returning straight SDR RGBA', () => {
    const alphaPayload = bitPayload([
        [0, 1],
        [1, 3], // alpha_channel_use_idc: premultiplied black
        [0, 3],
        [0, 9],
        [255, 9],
        [0, 1],
        [0, 1],
      ]),
      input = monochromeAlphaHeif(
        auxiliarySubtype([seiNal(165, alphaPayload)], monochromeAlphaNalLengthSize),
      ),
      image = decodeHeic(input);

    for (let index = 0; index < monochromeAlphaReference.length; index++) {
      const sample = monochromeAlphaReference[index];
      expect(image.data[index * 4 + 3]).toBe(sample);
      for (let channel = 0; channel < 3; channel++)
        expect(image.data[index * 4 + channel]).toBe(sample === 0 ? 0 : 255);
    }
  });

  it('applies ACI clipping before incrementing samples', () => {
    const midpointClip = {
        cancelled: false,
        useIdc: 0,
        transparentValue: 0,
        opaqueValue: 4,
        increment: true,
        clip: true,
        clipType: 0,
      },
      rangeClip = { ...midpointClip, clipType: 1 },
      unclipped = { ...midpointClip, clip: false };
    expect(hevcAlphaSampleToFactor(2, midpointClip)).toBe(0);
    expect(hevcAlphaSampleToFactor(3, midpointClip)).toBe(1.25);
    expect(hevcAlphaSampleToFactor(5, rangeClip)).toBe(1.25);
    expect(hevcAlphaSampleToFactor(5, unclipped)).toBe(1.5);
  });

  it('ignores reserved use_idc and cancelled ACI messages during compositing', () => {
    const payloadFor = (useIdc: number) =>
        bitPayload([
          [0, 1],
          [useIdc, 3],
          [0, 3],
          [255, 9],
          [0, 9],
          [0, 1],
          [0, 1],
        ]),
      cancelledPayload = bitPayload([[1, 1]]),
      reservedInput = monochromeAlphaHeif(
        auxiliarySubtype([seiNal(165, payloadFor(3))], monochromeAlphaNalLengthSize),
      ),
      cancelledInput = monochromeAlphaHeif(
        auxiliarySubtype(
          [seiNal(165, payloadFor(0)), seiNal(165, cancelledPayload)],
          monochromeAlphaNalLengthSize,
        ),
      );

    for (const input of [reservedInput, cancelledInput]) {
      const image = decodeHeic(input);
      for (let index = 0; index < monochromeAlphaReference.length; index++)
        expect(image.data[index * 4 + 3]).toBe(monochromeAlphaReference[index]);
    }
  });

  it('rejects ACI bit depth that disagrees with the coded images', () => {
    const payload = bitPayload([
        [0, 1],
        [0, 3],
        [1, 3], // 9-bit auxiliary luma declaration
        [0, 10],
        [512, 10],
        [0, 1],
        [0, 1],
      ]),
      input = monochromeAlphaHeif(
        auxiliarySubtype([seiNal(165, payload)], monochromeAlphaNalLengthSize),
      );
    expect(() => decodeHeic(input)).toThrow(
      'alpha_channel_bit_depth does not match the primary and auxiliary images',
    );
  });

  it('rejects truncated HEVC auxiliary subtype data', () => {
    expect(() =>
      decodeHeicAuxiliaryPlanes(
        rewrappedOfficialAuxiliary('urn:mpeg:hevc:2015:auxid:2', Buffer.from([0, 0])),
      ),
    ).toThrow('truncated HEVC auxiliary subtype');

    const mismatchedLength = Buffer.alloc(4);
    mismatchedLength.writeUInt32BE(1);
    expect(() =>
      decodeHeicAuxiliaryPlanes(
        rewrappedOfficialAuxiliary('urn:mpeg:hevc:2015:auxid:2', mismatchedLength),
      ),
    ).toThrow('invalid HEVC auxiliary subtype length');
  });
});
