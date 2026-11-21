import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { decodeHeic } from '../src/decoder.js';
import { decodeHDRSync } from '../src/hdr.js';
import { iccToLinearSrgb, linearSrgbToSrgb, parseIccProfile } from '../src/icc.js';
import { createIccHagcToneMap } from '../src/icc-hagc.js';
import { createRenderContext, decodeNative } from '../src/render.js';
import { box, buildHeif, codedFixture, u32 } from './helpers/heif.js';

const ascii = (value: string) => Buffer.from(value, 'ascii'),
  u16 = (value: number) => Buffer.from([value >>> 8, value & 0xff]),
  fixed = (value: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32BE(Math.round(value * 65_536));
    return bytes;
  };

function identityMft2A2b0(): Buffer {
  const tag = Buffer.alloc(124);
  tag.write('mft2', 0, 'ascii');
  tag.set([3, 3, 2], 8);
  for (let index = 0; index < 9; index++) fixed(index % 4 === 0 ? 1 : 0).copy(tag, 12 + index * 4);
  tag.writeUInt16BE(2, 48);
  tag.writeUInt16BE(2, 50);
  let offset = 52;
  for (let channel = 0; channel < 3; channel++) {
    u16(0).copy(tag, offset);
    u16(65_535).copy(tag, offset + 2);
    offset += 4;
  }
  for (let red = 0; red < 2; red++)
    for (let green = 0; green < 2; green++)
      for (let blue = 0; blue < 2; blue++)
        for (const value of [red, green, blue]) {
          u16(value ? 65_535 : 0).copy(tag, offset);
          offset += 2;
        }
  for (let channel = 0; channel < 3; channel++) {
    u16(0).copy(tag, offset);
    u16(65_535).copy(tag, offset + 2);
    offset += 4;
  }
  return tag;
}

function hagcTag(payload: Uint8Array): Buffer {
  return Buffer.concat([ascii('hagc'), Buffer.alloc(4), u32(payload.length), Buffer.from(payload)]);
}

function iccProfile(
  payload?: Uint8Array,
  transfer = 8,
  withSdrA2b0 = false,
  profileClass = 'mntr',
): Uint8Array {
  const xyz = (values: readonly number[]) =>
      Buffer.concat([ascii('XYZ '), Buffer.alloc(4), ...values.map(fixed)]),
    curve = Buffer.concat([ascii('curv'), Buffer.alloc(4), u32(0)]),
    cicp = Buffer.concat([ascii('cicp'), Buffer.alloc(4), Buffer.from([1, transfer, 0, 1])]),
    tags: [string, Buffer][] = [
      ['cicp', cicp],
      ['rXYZ', xyz([0.436, 0.222, 0.014])],
      ['gXYZ', xyz([0.385, 0.717, 0.097])],
      ['bXYZ', xyz([0.144, 0.061, 0.714])],
      ['rTRC', curve],
      ['gTRC', curve],
      ['bTRC', curve],
    ];
  if (withSdrA2b0) tags.push(['A2B0', identityMft2A2b0()]);
  if (payload) tags.push(['HAGC', hagcTag(payload)]);
  const tableEnd = 132 + tags.length * 12,
    profileLength = tableEnd + tags.reduce((size, [, tag]) => size + ((tag.length + 3) & ~3), 0),
    profile = Buffer.alloc(profileLength);
  profile.writeUInt32BE(profileLength, 0);
  profile.set([4, 64, 0, 0], 8);
  profile.write(profileClass, 12, 'ascii');
  profile.write('RGB ', 16, 'ascii');
  profile.write('XYZ ', 20, 'ascii');
  profile.write('acsp', 36, 'ascii');
  profile.writeUInt32BE(tags.length, 128);
  let offset = tableEnd;
  for (let index = 0; index < tags.length; index++) {
    const [name, tag] = tags[index]!,
      entry = 132 + index * 12;
    profile.write(name, entry, 'ascii');
    profile.writeUInt32BE(offset, entry + 4);
    profile.writeUInt32BE(tag.length, entry + 8);
    tag.copy(profile, offset);
    offset += (tag.length + 3) & ~3;
  }
  return profile;
}

function constantSdrHagc(): Buffer {
  return Buffer.from([
    0x00, // application version 0, minimum version 0
    0x40, // adaptive tone map present
    0x27,
    0x10, // baseline headroom: 1 stop
    0x10, // one alternate, BT.709 mixing/curve parameters
    0x00,
    0x00, // alternate headroom: SDR
    0x40, // component mixing type 1: per-component
    0x00, // one control point, explicit slope
    0x03,
    0xe8, // x = 1
    0x27,
    0x10, // y = -1 stop
    0x46,
    0x50, // slope angle = 180 degrees, i.e. zero slope
  ]);
}

function pchipSdrHagc(): Buffer {
  return Buffer.from([
    0x00,
    0x40,
    0x27,
    0x10,
    0x10,
    0x00,
    0x00, // baseline 1 stop; alternate SDR
    0x40, // per-component mixing
    0x0c, // two points, PCHIP slopes
    0x00,
    0x00,
    0x03,
    0xe8, // x = [0, 1]
    0x00,
    0x00,
    0x27,
    0x10, // y = [0, -1] stops
  ]);
}

function rwtmoHagc(): Buffer {
  return Buffer.from([0x00, 0x40, 0x4e, 0x20, 0x80]); // 2-stop baseline, use RWTMO
}

function customWhiteHagc(): Buffer {
  return Buffer.from([
    0x00,
    0xc0, // custom reference white and adaptive tone map
    0x03,
    0xe8, // custom reference white: 200 nits
    0x27,
    0x10, // baseline headroom: 1 stop
    0x80, // use RWTMO
  ]);
}

function interpolatedHagc(): Buffer {
  return Buffer.from([
    0x00,
    0x40,
    0x27,
    0x10,
    0x20, // baseline 1 stop, two alternates
    0x00,
    0x00, // SDR alternate
    0x40,
    0x00,
    0x03,
    0xe8,
    0x27,
    0x10,
    0x46,
    0x50, // constant -1 stop gain
    0x4e,
    0x20, // 2-stop alternate
    0x40,
    0x00,
    0x03,
    0xe8,
    0x27,
    0x10,
    0x46,
    0x50, // constant +1 stop gain
  ]);
}

function sharedParametersHagc(): Buffer {
  return Buffer.from([
    0x00,
    0x40,
    0x27,
    0x10,
    0x23, // two alternates, shared component mixing and X coordinates
    0x00,
    0x00, // SDR alternate
    0xe4, // type 3; red and max coefficients are present
    0xc3,
    0x50,
    0xc3,
    0x50, // both coefficients are 50000 / 50000
    0x00,
    0x03,
    0xe8, // one control point at x = 1
    0x27,
    0x10,
    0x46,
    0x50, // alternate 0 gain = -1
    0x4e,
    0x20, // alternate 1 headroom = 2 stops
    0x27,
    0x10,
    0x46,
    0x50, // alternate 1 gain = +1
  ]);
}

function patternedHeif(profile: Uint8Array): Uint8Array {
  const base = codedFixture(8, 'pattern'),
    withoutColor = base.properties.filter(
      (property) => property.toString('ascii', 4, 8) !== 'colr',
    );
  return buildHeif(
    [
      {
        ...base,
        properties: [...withoutColor, box('colr', ascii('prof'), Buffer.from(profile))],
      },
    ],
    base.id,
  );
}

describe('ICC Headroom Adaptive Gain Curve', () => {
  it('parses a versioned HAGC payload and maps the HDR baseline to its SDR alternate', () => {
    const hagc = constantSdrHagc(),
      profile = parseIccProfile(new Uint8Array(iccProfile(hagc))),
      metadata = profile.headroomAdaptiveGainCurve;
    expect(metadata).toMatchObject({
      applicationVersion: 0,
      minimumApplicationVersion: 0,
      referenceWhiteNits: 203,
      hasCustomReferenceWhite: false,
      toneMap: {
        baselineHeadroom: 1,
        chromaticities: [0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329],
        referenceWhiteToneMapping: false,
        alternateImages: [
          {
            headroom: 0,
            componentMixing: { type: 1, coefficients: [0, 0, 0, 0, 0, 1] },
            controlPoints: [{ x: 1, y: -1, slope: 0 }],
            usesPchipSlopes: false,
          },
        ],
      },
    });

    const sdrInput = patternedHeif(new Uint8Array(iccProfile(hagc, 16, true))),
      sdrProfile = parseIccProfile(new Uint8Array(iccProfile(hagc, 16, true))),
      raw = decodeNative(
        createRenderContext(sdrInput, { applyTransforms: false }),
        undefined,
        false,
        false,
      ),
      sdr = decodeHeic(sdrInput),
      expected = linearSrgbToSrgb(
        iccToLinearSrgb(sdrProfile, [raw.data[0]! / 255, raw.data[1]! / 255, raw.data[2]! / 255]),
      ).map((value) => Math.round(value * 255)),
      baseline = decodeHDRSync(patternedHeif(new Uint8Array(iccProfile())), {
        displayHeadroom: 1,
      }),
      mapped = decodeHDRSync(patternedHeif(new Uint8Array(iccProfile(hagc, 8, true))), {
        displayHeadroom: 1,
      });
    expect(Array.from(sdr.data.slice(0, 3))).toEqual(expected);
    expect(mapped.source).toBe('icc-hagc');
    expect(mapped.headroom).toBe(1);
    expect(mapped.sourceHeadroom).toBe(2);
    for (let index = 0; index < baseline.data.length; index += 4) {
      expect(mapped.data[index]).toBeCloseTo(baseline.data[index]! * 0.5, 5);
      expect(mapped.data[index + 1]).toBeCloseTo(baseline.data[index + 1]! * 0.5, 5);
      expect(mapped.data[index + 2]).toBeCloseTo(baseline.data[index + 2]! * 0.5, 5);
      expect(mapped.data[index + 3]).toBe(baseline.data[index + 3]);
    }
  });

  it('computes PCHIP slopes and evaluates the normative cubic gain curve', () => {
    const parsed = parseIccProfile(new Uint8Array(iccProfile(pchipSdrHagc()))),
      toneMap = parsed.headroomAdaptiveGainCurve!.toneMap!,
      curve = toneMap.alternateImages[0]!.controlPoints;
    expect(curve.map(({ slope }) => slope)).toEqual([-1, -1]);
    const transform = createIccHagcToneMap(toneMap, 1),
      output = transform.apply([0.5, 0.5, 0.5]);
    expect(output[0]).toBeCloseTo(0.5 * 2 ** -0.5, 12);
    expect(output[1]).toBeCloseTo(output[0], 12);
    expect(output[2]).toBeCloseTo(output[0], 12);
  });

  it('interpolates per-channel gains across adjacent alternate headrooms', () => {
    const toneMap = parseIccProfile(new Uint8Array(iccProfile(interpolatedHagc())))
        .headroomAdaptiveGainCurve!.toneMap!,
      transform = createIccHagcToneMap(toneMap, 2 ** 0.5),
      output = transform.apply([1, 1, 1]);
    expect(transform.targetHeadroom).toBeCloseTo(0.5, 12);
    expect(output[0]).toBeCloseTo(2 ** -0.5, 12);
    expect(output[1]).toBeCloseTo(output[0], 12);
    expect(output[2]).toBeCloseTo(output[0], 12);
  });

  it('reuses shared component-mixing and gain-curve parameters across alternates', () => {
    const toneMap = parseIccProfile(new Uint8Array(iccProfile(sharedParametersHagc())))
      .headroomAdaptiveGainCurve!.toneMap!;
    expect(toneMap.alternateImages[1]!.componentMixing).toEqual(
      toneMap.alternateImages[0]!.componentMixing,
    );
    expect(toneMap.alternateImages[1]!.controlPoints.map(({ x }) => x)).toEqual([1]);
    expect(toneMap.alternateImages[1]!.controlPoints[0]!.y).toBe(1);
  });

  it('expands Reference White Tone Mapping metadata using the SMPTE RWTMO definition', () => {
    const toneMap = parseIccProfile(new Uint8Array(iccProfile(rwtmoHagc())))
      .headroomAdaptiveGainCurve!.toneMap!;
    expect(toneMap.referenceWhiteToneMapping).toBe(true);
    expect(toneMap.chromaticities).toEqual([
      0.708, 0.292, 0.17, 0.797, 0.131, 0.046, 0.3127, 0.329,
    ]);
    expect(toneMap.alternateImages.map(({ headroom }) => headroom)).toEqual([
      0,
      Math.log2(8 / 3) * Math.min(2 / Math.log2(1_000 / 203), 1),
    ]);
    expect(toneMap.alternateImages.every(({ controlPoints }) => controlPoints.length === 8)).toBe(
      true,
    );
    const output = createIccHagcToneMap(toneMap, 1).apply([1, 0.5, 0.25]);
    expect(output.every(Number.isFinite)).toBe(true);
  });

  it('uses the embedded custom HDR reference white unless the caller overrides it', () => {
    const baseline = decodeHDRSync(patternedHeif(new Uint8Array(iccProfile(undefined, 16)))),
      embeddedWhite = decodeHDRSync(
        patternedHeif(new Uint8Array(iccProfile(customWhiteHagc(), 16))),
      ),
      callerWhite = decodeHDRSync(
        patternedHeif(new Uint8Array(iccProfile(customWhiteHagc(), 16))),
        { referenceWhiteNits: 400 },
      ),
      callerWhiteWithA2b0 = decodeHDRSync(
        patternedHeif(new Uint8Array(iccProfile(customWhiteHagc(), 16, true))),
        { referenceWhiteNits: 400 },
      ),
      index = Array.from(baseline.data).findIndex(
        (value, position) => position % 4 === 0 && value > 0,
      );
    expect(index).toBeGreaterThanOrEqual(0);
    expect(embeddedWhite.data[index]).toBeCloseTo(baseline.data[index]! * (203 / 200), 5);
    expect(callerWhite.data[index]).toBeCloseTo(baseline.data[index]! * (203 / 400), 5);
    expect(callerWhiteWithA2b0.data[index]).toBeCloseTo(callerWhite.data[index]!, 5);
  });

  it('ignores unknown minimum application versions and rejects reserved-bit violations', () => {
    const unknownVersion = constantSdrHagc();
    unknownVersion[0] = 0x04; // minimum_application_version = 1
    expect(
      parseIccProfile(new Uint8Array(iccProfile(unknownVersion))).headroomAdaptiveGainCurve,
    ).toBeUndefined();

    const malformed = constantSdrHagc();
    malformed[1] |= 1;
    expect(() => parseIccProfile(new Uint8Array(iccProfile(malformed)))).toThrow(
      'malformed ICC HAGC tag',
    );
  });

  it('accepts ICC ColorSpace profiles carrying HAGC', () => {
    expect(
      parseIccProfile(new Uint8Array(iccProfile(constantSdrHagc(), 8, false, 'spac')))
        .headroomAdaptiveGainCurve?.toneMap?.baselineHeadroom,
    ).toBe(1);
  });

  it('uses the Apple HAGC A2B0 SDR compatibility transform in decodeHeic', () => {
    const profileBytes = new Uint8Array(
        readFileSync(new URL('./fixtures/icc/AppleHagc.icc', import.meta.url)),
      ),
      input = patternedHeif(profileBytes),
      parsed = parseIccProfile(profileBytes),
      raw = decodeNative(
        createRenderContext(input, { applyTransforms: false }),
        undefined,
        false,
        false,
      ),
      sdr = decodeHeic(input),
      hdr = decodeHDRSync(input, { displayHeadroom: 1 });

    expect(parsed.hdrSdrCompatibilityTransform).toBe(true);
    expect(Array.from(raw.data.slice(0, 3))).toEqual([128, 0, 255]);
    // LittleCMS 2.19 transicc's 8-bit A2B0 result is [99, 0, 255]; the
    // bounded trilinear CLUT path differs by at most two code values here.
    for (const [actual, reference] of [
      [sdr.data[0]!, 99],
      [sdr.data[1]!, 0],
      [sdr.data[2]!, 255],
    ]) {
      expect(Math.abs(actual - reference)).toBeLessThanOrEqual(2);
    }
    expect(hdr.source).toBe('icc-hagc');
  });
});
