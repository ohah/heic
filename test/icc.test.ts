import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { decode, decodeHDR } from '../src/async.js';
import { decodeHeic, getHeicMetadata } from '../src/decoder.js';
import { decodeHDRSync } from '../src/hdr.js';
import { parseISOBMFF } from '../src/container/heif.js';
import { getHeicInfo } from '../src/container/heic.js';
import { parseMiniImage } from '../src/container/mini.js';
import { createRenderContext, decodeNative } from '../src/render.js';
import { getRgbToXyzD65Matrix } from '../src/color-matrix.js';
import {
  apply3,
  D65_FROM_D50,
  iccToLinearSrgb,
  linearSrgbToSrgb,
  multiply3,
  parseIccProfile,
  SRGB_FROM_XYZ,
} from '../src/icc.js';
import { box, buildHeif, codedFixture, full, isoMetadata, nclx, u32 } from './helpers/heif.js';

const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
const p3Icc = getHeicMetadata(fixture('iphone-grid.heic')).icc!,
  cvdLutIcc = fixture('icc/CVDlut-deutan.icc');
const miniSource = fixture('conformance/mini-C71.heic'),
  miniBox = parseISOBMFF(miniSource).find((entry) => entry.type === 'mini')!,
  c71 = parseMiniImage(miniBox.data, 0x68656963);

function patternedHeif(profile: Uint8Array, type: 'prof' | 'rICC'): Uint8Array {
  const base = codedFixture(8, 'pattern'),
    withoutColor = base.properties.filter(
      (property) => property.toString('ascii', 4, 8) !== 'colr',
    );
  return buildHeif(
    [
      {
        ...base,
        properties: [...withoutColor, box('colr', Buffer.from(type), profile)],
      },
    ],
    base.id,
  );
}

function c71WithIcc(profile: Uint8Array): Uint8Array {
  return buildHeif(
    [
      {
        id: 1,
        type: 'hvc1',
        data: c71.itemData,
        properties: [
          box('hvcC', c71.codecConfig),
          full('ispe', 0, u32(c71.width), u32(c71.height)),
          box('colr', Buffer.from('prof'), profile),
        ],
      },
    ],
    1,
  );
}

function p3WithCurve(curve: 'linear' | 'gamma'): Uint8Array {
  const profile = p3Icc.slice(),
    view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength),
    tableCount = view.getUint32(128);
  let curveOffset = -1;
  for (let i = 0; i < tableCount; i++) {
    const entry = 132 + i * 12,
      name = String.fromCharCode(...profile.subarray(entry, entry + 4));
    if (name === 'rTRC') curveOffset = view.getUint32(entry + 4);
    if (name === 'rTRC' || name === 'gTRC' || name === 'bTRC') view.setUint32(entry + 8, 16);
  }
  if (curveOffset < 0) throw new Error('Display P3 profile has no TRC');
  profile.fill(0, curveOffset, curveOffset + 32);
  profile.set(new TextEncoder().encode('curv'), curveOffset);
  if (curve === 'linear') {
    view.setUint32(curveOffset + 8, 2);
    view.setUint16(curveOffset + 12, 0);
    view.setUint16(curveOffset + 14, 65535);
  } else {
    view.setUint32(curveOffset + 8, 1);
    view.setUint16(curveOffset + 12, 563); // ICC u8Fixed8 gamma 2.19921875
  }
  return profile;
}

function cvdSaturationProfile(): Uint8Array {
  const profile = cvdLutIcc.slice(),
    view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength);
  let perceptualOffset = -1,
    relativeOffset = -1;
  for (let index = 0; index < view.getUint32(128); index++) {
    const entry = 132 + index * 12,
      name = String.fromCharCode(...profile.subarray(entry, entry + 4));
    if (name === 'A2B0') perceptualOffset = entry;
    if (name === 'A2B1') relativeOffset = entry;
  }
  if (perceptualOffset < 0 || relativeOffset < 0)
    throw new Error('CVD ICC fixture must contain A2B0 and A2B1');
  profile.set(new TextEncoder().encode('A2B2'), perceptualOffset);
  profile.set(new TextEncoder().encode('A2B0'), relativeOffset);
  return profile;
}

function grayInputProfile(
  pcs: 'XYZ ' | 'Lab ' = 'XYZ ',
  additionalTags: readonly (readonly [string, Buffer])[] = [],
): Uint8Array {
  const ascii = (value: string) => Buffer.from(value, 'ascii'),
    fixed = (value: number) => {
      const bytes = Buffer.alloc(4);
      bytes.writeInt32BE(Math.round(value * 65536));
      return bytes;
    },
    mluc = (value: string) => {
      const text = Buffer.from([...value].flatMap((character) => [0, character.charCodeAt(0)])),
        record = Buffer.concat([Buffer.from('enUS'), u32(text.length), u32(28)]);
      return Buffer.concat([ascii('mluc'), Buffer.alloc(4), u32(1), u32(12), record, text]);
    },
    textTag = (value: string) =>
      Buffer.concat([ascii('text'), Buffer.alloc(4), ascii(`${value}\0`)]),
    xyzTag = (values: number[]) =>
      Buffer.concat([ascii('XYZ '), Buffer.alloc(4), ...values.map(fixed)]),
    curve = Buffer.concat([ascii('curv'), Buffer.alloc(4), u32(1), Buffer.from([2, 51])]),
    tags = [
      ['desc', mluc('Synthetic gray input')],
      ['cprt', textTag('ICC test profile')],
      ['wtpt', xyzTag([0.9642, 1, 0.8249])],
      ['kTRC', curve],
      ...additionalTags,
    ] as const,
    tableEnd = 132 + tags.length * 12,
    profile = Buffer.alloc(
      tableEnd + tags.reduce((size, [, data]) => size + ((data.length + 3) & ~3), 0),
    );
  profile.writeUInt32BE(profile.length, 0);
  profile.set([4, 48, 0, 0], 8);
  profile.write('scnr', 12, 'ascii');
  profile.write('GRAY', 16, 'ascii');
  profile.write(pcs, 20, 'ascii');
  profile.write('acsp', 36, 'ascii');
  fixed(0.9642).copy(profile, 68);
  fixed(1).copy(profile, 72);
  fixed(0.8249).copy(profile, 76);
  profile.writeUInt32BE(tags.length, 128);
  let offset = tableEnd;
  for (let index = 0; index < tags.length; index++) {
    const [name, data] = tags[index],
      entry = 132 + index * 12;
    profile.write(name, entry, 'ascii');
    profile.writeUInt32BE(offset, entry + 4);
    profile.writeUInt32BE(data.length, entry + 8);
    data.copy(profile, offset);
    offset += (data.length + 3) & ~3;
  }
  return new Uint8Array(profile);
}

function grayA2bProfile(kind: 'mft1' | 'mft2' | 'mAB'): Uint8Array {
  const lut = (() => {
    if (kind === 'mAB') {
      const tag = Buffer.alloc(112),
        aOffset = 32,
        clutOffset = 44,
        bOffset = 76;
      tag.write('mAB ', 0, 'ascii');
      tag.writeUInt8(1, 8);
      tag.writeUInt8(3, 9);
      tag.writeUInt32BE(bOffset, 12);
      tag.writeUInt32BE(clutOffset, 24);
      tag.writeUInt32BE(aOffset, 28);
      tag.write('curv', aOffset, 'ascii');
      tag.writeUInt32BE(0, aOffset + 8);
      tag.writeUInt8(2, clutOffset);
      tag.writeUInt8(2, clutOffset + 16);
      for (const [gridIndex, lightness] of [0, 1].map((index) => [index, 0.2 + index * 0.6])) {
        const offset = clutOffset + 20 + gridIndex * 6;
        tag.writeUInt16BE(Math.round(lightness * 65_535), offset);
        tag.writeUInt16BE(0x8080, offset + 2);
        tag.writeUInt16BE(0x8080, offset + 4);
      }
      for (let channel = 0; channel < 3; channel++) {
        const offset = bOffset + channel * 12;
        tag.write('curv', offset, 'ascii');
        tag.writeUInt32BE(0, offset + 8);
      }
      return tag;
    }

    const precision = kind === 'mft1' ? 1 : 2,
      headerLength = precision === 1 ? 48 : 52,
      entries = precision === 1 ? 256 : 17,
      maximum = precision === 1 ? 255 : 65_535,
      labScale = precision === 1 ? 255 : 65_280,
      tag = Buffer.alloc(
        headerLength + entries * precision + 6 * precision + 3 * entries * precision,
      ),
      writeSample = (offset: number, value: number) => {
        if (precision === 1) tag.writeUInt8(Math.round(value), offset);
        else tag.writeUInt16BE(Math.round(value), offset);
      };
    tag.write(kind, 0, 'ascii');
    tag.writeUInt8(1, 8);
    tag.writeUInt8(3, 9);
    tag.writeUInt8(2, 10);
    for (const [index, value] of [1, 0, 0, 0, 1, 0, 0, 0, 1].entries())
      tag.writeInt32BE(value * 65_536, 12 + index * 4);
    if (precision === 2) {
      tag.writeUInt16BE(entries, 48);
      tag.writeUInt16BE(entries, 50);
    }
    let offset = headerLength;
    for (let entry = 0; entry < entries; entry++)
      writeSample(offset + entry * precision, (entry / (entries - 1)) * maximum);
    offset += entries * precision;
    for (const lightness of [0.2, 0.8]) {
      writeSample(offset, lightness * labScale);
      writeSample(offset + precision, precision === 1 ? 128 : 0x8000);
      writeSample(offset + precision * 2, precision === 1 ? 128 : 0x8000);
      offset += precision * 3;
    }
    for (let channel = 0; channel < 3; channel++)
      for (let entry = 0; entry < entries; entry++)
        writeSample(
          offset + (channel * entries + entry) * precision,
          (entry / (entries - 1)) * maximum,
        );
    return tag;
  })();
  return grayInputProfile('Lab ', [['A2B0', lut]]);
}

function legacyLutProfile(kind: 'mft1' | 'mft2'): Uint8Array {
  const precision = kind === 'mft1' ? 1 : 2,
    gridPoints = 2,
    entries = precision === 1 ? 256 : 17,
    maximum = precision === 1 ? 255 : 65_535,
    lut = Buffer.alloc(
      (precision === 1 ? 48 : 52) +
        3 * entries * precision +
        gridPoints ** 3 * 3 * precision +
        3 * entries * precision,
    ),
    writeSample = (target: Buffer, offset: number, value: number) => {
      const sample = Math.round(value);
      if (precision === 1) target.writeUInt8(sample, offset);
      else target.writeUInt16BE(sample, offset);
    };
  lut.write(kind, 0, 'ascii');
  lut.writeUInt8(3, 8);
  lut.writeUInt8(3, 9);
  lut.writeUInt8(gridPoints, 10);
  for (const [index, value] of [1, 0, 0, 0, 1, 0, 0, 0, 1].entries())
    lut.writeInt32BE(value * 65_536, 12 + index * 4);
  if (precision === 2) {
    lut.writeUInt16BE(entries, 48);
    lut.writeUInt16BE(entries, 50);
  }

  const headerLength = precision === 1 ? 48 : 52;
  let cursor = headerLength;
  for (let channel = 0; channel < 3; channel++) {
    for (let entry = 0; entry < entries; entry++) {
      const input = entry / (entries - 1),
        output = channel === 0 ? input ** 2 : channel === 2 ? Math.sqrt(input) : input;
      writeSample(lut, cursor, output * maximum);
      cursor += precision;
    }
  }

  // ICC LUT dimensions are ordered with the first channel varying slowest.
  for (let red = 0; red < gridPoints; red++) {
    for (let green = 0; green < gridPoints; green++) {
      for (let blue = 0; blue < gridPoints; blue++) {
        const lab = [
          0.15 + 0.5 * red + 0.25 * green + 0.1 * blue,
          0.45 + 0.12 * red - 0.16 * green + 0.06 * blue,
          0.55 - 0.14 * red + 0.08 * green + 0.25 * blue,
        ];
        for (const value of lab) {
          writeSample(lut, cursor, value * (precision === 1 ? 255 : 65_280));
          cursor += precision;
        }
      }
    }
  }

  for (let channel = 0; channel < 3; channel++) {
    for (let entry = 0; entry < entries; entry++) {
      const input = entry / (entries - 1),
        output = channel === 0 ? Math.sqrt(input) : channel === 2 ? input ** 2 : input;
      writeSample(lut, cursor, output * maximum);
      cursor += precision;
    }
  }

  const ascii = (value: string) => Buffer.from(value, 'ascii'),
    fixed = (value: number) => {
      const bytes = Buffer.alloc(4);
      bytes.writeInt32BE(Math.round(value * 65_536));
      return bytes;
    },
    name = ascii('Synthetic legacy LUT input'),
    description = Buffer.concat([
      ascii('desc'),
      Buffer.alloc(4),
      u32(name.length + 1),
      name,
      Buffer.from([0]),
      u32(0),
      u32(0),
      Buffer.alloc(2 + 1 + 67),
    ]),
    copyright = Buffer.concat([ascii('text'), Buffer.alloc(4), ascii('ICC test profile\0')]),
    whitePoint = Buffer.concat([
      ascii('XYZ '),
      Buffer.alloc(4),
      fixed(0.9642),
      fixed(1),
      fixed(0.8249),
    ]),
    tags = [
      ['desc', description],
      ['cprt', copyright],
      ['wtpt', whitePoint],
      ['A2B0', lut],
    ] as const,
    tableEnd = 132 + tags.length * 12,
    profile = Buffer.alloc(
      tableEnd + tags.reduce((size, [, data]) => size + ((data.length + 3) & ~3), 0),
    );

  profile.writeUInt32BE(profile.length, 0);
  profile.set([2, 16, 0, 0], 8);
  profile.write('scnr', 12, 'ascii');
  profile.write('RGB ', 16, 'ascii');
  profile.write('Lab ', 20, 'ascii');
  profile.write('acsp', 36, 'ascii');
  fixed(0.9642).copy(profile, 68);
  fixed(1).copy(profile, 72);
  fixed(0.8249).copy(profile, 76);
  profile.write('TEST', 80, 'ascii');
  profile.writeUInt32BE(tags.length, 128);
  let offset = tableEnd;
  for (let index = 0; index < tags.length; index++) {
    const [signature, data] = tags[index],
      entry = 132 + index * 12;
    profile.write(signature, entry, 'ascii');
    profile.writeUInt32BE(offset, entry + 4);
    profile.writeUInt32BE(data.length, entry + 8);
    data.copy(profile, offset);
    offset += (data.length + 3) & ~3;
  }
  return new Uint8Array(profile);
}

function xyzLutProfile(
  kind: 'mft1' | 'mft2' | 'mAB',
  profileClass: 'scnr' | 'mntr' = 'scnr',
): Uint8Array {
  const fixed = (value: number) => {
      const bytes = Buffer.alloc(4);
      bytes.writeInt32BE(Math.round(value * 65_536));
      return bytes;
    },
    lut = (() => {
      if (kind === 'mAB') {
        const tag = Buffer.alloc(68);
        tag.write('mAB ', 0, 'ascii');
        tag.writeUInt8(3, 8);
        tag.writeUInt8(3, 9);
        tag.writeUInt32BE(32, 12); // Three identity B curves, with all other elements absent.
        for (let channel = 0; channel < 3; channel++) {
          const offset = 32 + channel * 12;
          tag.write('curv', offset, 'ascii');
          tag.writeUInt32BE(0, offset + 8);
        }
        return tag;
      }

      const precision = kind === 'mft1' ? 1 : 2,
        entries = precision === 1 ? 256 : 2,
        maximum = precision === 1 ? 255 : 65_535,
        headerLength = precision === 1 ? 48 : 52,
        tag = Buffer.alloc(
          headerLength + 3 * entries * precision + 8 * 3 * precision + 3 * entries * precision,
        ),
        writeSample = (offset: number, value: number) => {
          const sample = Math.round(value * maximum);
          if (precision === 1) tag.writeUInt8(sample, offset);
          else tag.writeUInt16BE(sample, offset);
        };
      tag.write(kind, 0, 'ascii');
      tag.writeUInt8(3, 8);
      tag.writeUInt8(3, 9);
      tag.writeUInt8(2, 10);
      for (const [index, value] of [1, 0, 0, 0, 1, 0, 0, 0, 1].entries())
        tag.writeInt32BE(value * 65_536, 12 + index * 4);
      if (precision === 2) {
        tag.writeUInt16BE(entries, 48);
        tag.writeUInt16BE(entries, 50);
      }
      let offset = headerLength;
      for (let channel = 0; channel < 3; channel++)
        for (let entry = 0; entry < entries; entry++) {
          writeSample(offset, entry / (entries - 1));
          offset += precision;
        }
      for (let red = 0; red < 2; red++)
        for (let green = 0; green < 2; green++)
          for (let blue = 0; blue < 2; blue++)
            for (const value of [red, green, blue]) {
              writeSample(offset, value);
              offset += precision;
            }
      for (let channel = 0; channel < 3; channel++)
        for (let entry = 0; entry < entries; entry++) {
          writeSample(offset, entry / (entries - 1));
          offset += precision;
        }
      return tag;
    })(),
    name = Buffer.from('Synthetic XYZ LUT input'),
    description = Buffer.concat([
      Buffer.from('desc'),
      Buffer.alloc(4),
      u32(name.length + 1),
      name,
      Buffer.from([0]),
      u32(0),
      u32(0),
      Buffer.alloc(70),
    ]),
    copyright = Buffer.concat([
      Buffer.from('text'),
      Buffer.alloc(4),
      Buffer.from('ICC test profile\0'),
    ]),
    whitePoint = Buffer.concat([
      Buffer.from('XYZ '),
      Buffer.alloc(4),
      fixed(0.9642),
      fixed(1),
      fixed(0.8249),
    ]),
    tags = [
      ['desc', description],
      ['cprt', copyright],
      ['wtpt', whitePoint],
      ['A2B0', lut],
    ] as const,
    tableEnd = 132 + tags.length * 12,
    profile = Buffer.alloc(
      tableEnd + tags.reduce((size, [, data]) => size + ((data.length + 3) & ~3), 0),
    );

  profile.writeUInt32BE(profile.length, 0);
  profile.set([4, 64, 0, 0], 8);
  profile.write(profileClass, 12, 'ascii');
  profile.write('RGB ', 16, 'ascii');
  profile.write('XYZ ', 20, 'ascii');
  profile.write('acsp', 36, 'ascii');
  fixed(0.9642).copy(profile, 68);
  fixed(1).copy(profile, 72);
  fixed(0.8249).copy(profile, 76);
  profile.writeUInt32BE(tags.length, 128);
  let offset = tableEnd;
  for (let index = 0; index < tags.length; index++) {
    const [signature, data] = tags[index],
      entry = 132 + index * 12;
    profile.write(signature, entry, 'ascii');
    profile.writeUInt32BE(offset, entry + 4);
    profile.writeUInt32BE(data.length, entry + 8);
    data.copy(profile, offset);
    offset += (data.length + 3) & ~3;
  }
  return new Uint8Array(profile);
}

function matrixProfileWithA2B1(): Uint8Array {
  const source = xyzLutProfile('mAB'),
    sourceView = new DataView(source.buffer, source.byteOffset, source.byteLength),
    sourceCount = sourceView.getUint32(128);
  let lut: Buffer | null = null;
  for (let index = 0; index < sourceCount; index++) {
    const entry = 132 + index * 12;
    if (String.fromCharCode(...source.subarray(entry, entry + 4)) === 'A2B0') {
      const offset = sourceView.getUint32(entry + 4),
        length = sourceView.getUint32(entry + 8);
      lut = Buffer.from(source.subarray(offset, offset + length));
      break;
    }
  }
  if (!lut) throw new Error('synthetic XYZ profile has no A2B0 transform');

  const baseView = new DataView(p3Icc.buffer, p3Icc.byteOffset, p3Icc.byteLength),
    baseCount = baseView.getUint32(128),
    tags: [string, Buffer][] = [];
  for (let index = 0; index < baseCount; index++) {
    const entry = 132 + index * 12,
      signature = String.fromCharCode(...p3Icc.subarray(entry, entry + 4)),
      offset = baseView.getUint32(entry + 4),
      length = baseView.getUint32(entry + 8);
    if (signature !== 'A2B0' && signature !== 'A2B1')
      tags.push([signature, Buffer.from(p3Icc.subarray(offset, offset + length))]);
  }
  tags.push(['A2B1', lut]);
  const tableEnd = 132 + tags.length * 12,
    profile = Buffer.alloc(
      tableEnd + tags.reduce((size, [, data]) => size + ((data.length + 3) & ~3), 0),
    );
  profile.set(p3Icc.subarray(0, 128));
  profile.writeUInt32BE(profile.length, 0);
  profile.set([4, 64, 0, 0], 8);
  profile.writeUInt32BE(tags.length, 128);
  let offset = tableEnd;
  for (let index = 0; index < tags.length; index++) {
    const [signature, data] = tags[index],
      entry = 132 + index * 12;
    profile.write(signature, entry, 'ascii');
    profile.writeUInt32BE(offset, entry + 4);
    profile.writeUInt32BE(data.length, entry + 8);
    data.copy(profile, offset);
    offset += (data.length + 3) & ~3;
  }
  return new Uint8Array(profile);
}

function withIccTags(
  source: Uint8Array,
  replacements: readonly (readonly [string, Buffer])[],
): Uint8Array {
  const view = new DataView(source.buffer, source.byteOffset, source.byteLength),
    replacementNames = new Set(replacements.map(([name]) => name)),
    tags: [string, Buffer][] = [];
  for (let index = 0; index < view.getUint32(128); index++) {
    const entry = 132 + index * 12,
      name = String.fromCharCode(...source.subarray(entry, entry + 4));
    if (!replacementNames.has(name)) {
      const offset = view.getUint32(entry + 4),
        length = view.getUint32(entry + 8);
      tags.push([name, Buffer.from(source.subarray(offset, offset + length))]);
    }
  }
  tags.push(...replacements.map(([name, tag]) => [name, Buffer.from(tag)] as [string, Buffer]));
  const tableEnd = 132 + tags.length * 12,
    profile = Buffer.alloc(
      tableEnd + tags.reduce((size, [, data]) => size + ((data.length + 3) & ~3), 0),
    );
  profile.set(source.subarray(0, 128));
  profile.writeUInt32BE(profile.length, 0);
  profile.set([4, 64, 0, 0], 8);
  profile.writeUInt32BE(tags.length, 128);
  let offset = tableEnd;
  for (let index = 0; index < tags.length; index++) {
    const [name, data] = tags[index],
      entry = 132 + index * 12;
    profile.write(name, entry, 'ascii');
    profile.writeUInt32BE(offset, entry + 4);
    profile.writeUInt32BE(data.length, entry + 8);
    data.copy(profile, offset);
    offset += (data.length + 3) & ~3;
  }
  return new Uint8Array(profile);
}

function mpeTag(
  elements: readonly Buffer[],
  inputChannels: number,
  outputChannels: number,
): Buffer {
  const tableEnd = 16 + elements.length * 8,
    tag = Buffer.alloc(
      tableEnd + elements.reduce((size, element) => size + ((element.length + 3) & ~3), 0),
    );
  tag.write('mpet', 0, 'ascii');
  tag.writeUInt16BE(inputChannels, 8);
  tag.writeUInt16BE(outputChannels, 10);
  tag.writeUInt32BE(elements.length, 12);
  let offset = tableEnd;
  for (let index = 0; index < elements.length; index++) {
    const element = elements[index]!;
    tag.writeUInt32BE(offset, 16 + index * 8);
    tag.writeUInt32BE(element.length, 20 + index * 8);
    element.copy(tag, offset);
    offset += (element.length + 3) & ~3;
  }
  return tag;
}

function mpeCurveSet(curve: Buffer): Buffer {
  const curveSet = Buffer.alloc(36 + curve.length * 3);
  curveSet.write('cvst', 0, 'ascii');
  curveSet.writeUInt16BE(3, 8);
  curveSet.writeUInt16BE(3, 10);
  let offset = 36;
  for (let channel = 0; channel < 3; channel++) {
    curveSet.writeUInt32BE(offset, 12 + channel * 8);
    curveSet.writeUInt32BE(curve.length, 16 + channel * 8);
    curve.copy(curveSet, offset);
    offset += curve.length;
  }
  return curveSet;
}

function mpeFormulaSegment(kind: 0 | 1 | 2, parameters: readonly number[]): Buffer {
  const segment = Buffer.alloc(12 + parameters.length * 4);
  segment.write('parf', 0, 'ascii');
  segment.writeUInt16BE(kind, 8);
  parameters.forEach((value, index) => segment.writeFloatBE(value, 12 + index * 4));
  return segment;
}

function mpePiecewiseCurve(segments: readonly Buffer[], breakPoints: readonly number[]): Buffer {
  const headerSize = 12 + breakPoints.length * 4,
    curve = Buffer.alloc(headerSize + segments.reduce((sum, segment) => sum + segment.length, 0));
  curve.write('curf', 0, 'ascii');
  curve.writeUInt16BE(segments.length, 8);
  breakPoints.forEach((value, index) => curve.writeFloatBE(value, 12 + index * 4));
  let offset = headerSize;
  for (const segment of segments) {
    segment.copy(curve, offset);
    offset += segment.length;
  }
  return curve;
}

function mpeSampledSegment(samples: readonly number[]): Buffer {
  const segment = Buffer.alloc(12 + samples.length * 4);
  segment.write('samf', 0, 'ascii');
  segment.writeUInt32BE(samples.length, 8);
  samples.forEach((value, index) => segment.writeFloatBE(value, 12 + index * 4));
  return segment;
}

function mpeAcsElement(type: 'bACS' | 'eACS'): Buffer {
  const element = Buffer.alloc(16);
  element.write(type, 0, 'ascii');
  element.writeUInt16BE(3, 8);
  element.writeUInt16BE(3, 10);
  return element;
}

function mpePowerCurveSet(gamma: number): Buffer {
  const curve = mpePiecewiseCurve([mpeFormulaSegment(0, [gamma, 1, 0, 0])], []);
  return mpeCurveSet(curve);
}

function mpeD50WhiteMatrix(scale = 1): Buffer {
  const matrix = Buffer.alloc(60);
  matrix.write('matf', 0, 'ascii');
  matrix.writeUInt16BE(3, 8);
  matrix.writeUInt16BE(3, 10);
  [0.9642 * scale, 0, 0, 0, scale, 0, 0, 0, 0.8249 * scale, 0, 0, 0].forEach((value, index) =>
    matrix.writeFloatBE(value, 12 + index * 4),
  );
  return matrix;
}

function mpeMatrix(inputChannels: number, rows: readonly (readonly number[])[]): Buffer {
  const outputChannels = rows.length,
    matrix = Buffer.alloc(12 + 4 * outputChannels * (inputChannels + 1));
  matrix.write('matf', 0, 'ascii');
  matrix.writeUInt16BE(inputChannels, 8);
  matrix.writeUInt16BE(outputChannels, 10);
  let offset = 12;
  for (const row of rows) {
    if (row.length !== inputChannels) throw new Error('MPE matrix row has the wrong width');
    for (const coefficient of row) {
      matrix.writeFloatBE(coefficient, offset);
      offset += 4;
    }
  }
  offset += outputChannels * 4;
  return matrix;
}

function mpeBinaryClut(
  inputChannels: number,
  outputChannels: number,
  evaluate: (coordinates: readonly number[]) => readonly number[],
): Buffer {
  const pointCount = 2 ** inputChannels,
    clut = Buffer.alloc(28 + pointCount * outputChannels * 4);
  clut.write('clut', 0, 'ascii');
  clut.writeUInt16BE(inputChannels, 8);
  clut.writeUInt16BE(outputChannels, 10);
  clut.fill(2, 12, 12 + inputChannels);
  let offset = 28;
  for (let point = 0; point < pointCount; point++) {
    const values = evaluate(
      Array.from({ length: inputChannels }, (_, axis) => (point >> axis) & 1),
    );
    if (values.length !== outputChannels) throw new Error('MPE CLUT row has the wrong width');
    for (const value of values) {
      clut.writeFloatBE(value, offset);
      offset += 4;
    }
  }
  return clut;
}

function mpeNeutralLabMatrix(lightness: number): Buffer {
  const matrix = Buffer.alloc(60);
  matrix.write('matf', 0, 'ascii');
  matrix.writeUInt16BE(3, 8);
  matrix.writeUInt16BE(3, 10);
  matrix.writeFloatBE(lightness, 48);
  return matrix;
}

function mpeIdentityClut(): Buffer {
  const clut = Buffer.alloc(28 + 2 ** 3 * 3 * 4);
  clut.write('clut', 0, 'ascii');
  clut.writeUInt16BE(3, 8);
  clut.writeUInt16BE(3, 10);
  clut.set([2, 2, 2], 12);
  let offset = 28;
  for (let blue = 0; blue < 2; blue++)
    for (let green = 0; green < 2; green++)
      for (let red = 0; red < 2; red++)
        for (const value of [red, green, blue]) {
          clut.writeFloatBE(value, offset);
          offset += 4;
        }
  return clut;
}

function withCicp(profile: Uint8Array, primaries: number, transfer: number): Uint8Array {
  const view = new DataView(profile.buffer, profile.byteOffset, profile.byteLength),
    count = view.getUint32(128),
    tags: [string, Buffer][] = [];
  for (let index = 0; index < count; index++) {
    const entry = 132 + index * 12,
      signature = String.fromCharCode(...profile.subarray(entry, entry + 4)),
      offset = view.getUint32(entry + 4),
      length = view.getUint32(entry + 8);
    if (signature !== 'cicp')
      tags.push([signature, Buffer.from(profile.subarray(offset, offset + length))]);
  }
  tags.push([
    'cicp',
    Buffer.concat([Buffer.from('cicp'), Buffer.alloc(4), Buffer.from([primaries, transfer, 0, 0])]),
  ]);
  const tableEnd = 132 + tags.length * 12,
    result = Buffer.alloc(
      tableEnd + tags.reduce((size, [, data]) => size + ((data.length + 3) & ~3), 0),
    );
  result.set(profile.subarray(0, 128));
  result.writeUInt32BE(result.length, 0);
  result.set([4, 64, 0, 0], 8); // ICC.1:2022 v4.4 defines the CICP tag.
  result.writeUInt32BE(tags.length, 128);
  let offset = tableEnd;
  for (let index = 0; index < tags.length; index++) {
    const [signature, data] = tags[index],
      entry = 132 + index * 12;
    result.write(signature, entry, 'ascii');
    result.writeUInt32BE(offset, entry + 4);
    result.writeUInt32BE(data.length, entry + 8);
    data.copy(result, offset);
    offset += (data.length + 3) & ~3;
  }
  return new Uint8Array(result);
}

function isoGainMapWithBaseProfile(
  profile: Uint8Array,
  useBase = true,
): {
  input: Uint8Array;
  baseInput: Uint8Array;
} {
  const base = codedFixture(8, 'pattern'),
    baseProperties = base.properties.filter(
      (property) => property.toString('ascii', 4, 8) !== 'colr',
    ),
    gain = { ...codedFixture(8, 'pattern'), id: 2 },
    metadata = isoMetadata(),
    tmap = {
      id: 3,
      type: 'tmap',
      data: metadata,
      properties: [
        full('ispe', 0, u32(64), u32(64)),
        useBase ? nclx() : box('colr', Buffer.from('prof'), profile),
      ],
      refs: [{ type: 'dimg', to: [base.id, gain.id] }],
    };
  if (!useBase) metadata[5] &= ~64;
  const selectedBase = useBase
    ? { ...base, properties: [...baseProperties, box('colr', Buffer.from('prof'), profile)] }
    : base;
  return {
    input: buildHeif([selectedBase, gain, tmap], tmap.id),
    baseInput: buildHeif([selectedBase], selectedBase.id),
  };
}

function isoGainMapWithGrayBase(useBase: boolean): {
  input: Uint8Array;
  baseInput: Uint8Array;
} {
  const base = {
      id: 1,
      type: 'hvc1',
      data: fixture('conformance/mini-alpha-L_8.hevc'),
      properties: [
        box('hvcC', fixture('conformance/mini-alpha-L_8.hvcc')),
        full('ispe', 0, u32(128), u32(128)),
        box('colr', Buffer.from('prof'), grayInputProfile()),
      ],
    },
    gain = { ...codedFixture(8, 'pattern'), id: 2 },
    metadata = isoMetadata();
  if (!useBase) metadata[5] &= ~64;
  const tmap = {
    id: 3,
    type: 'tmap',
    data: metadata,
    properties: [full('ispe', 0, u32(128), u32(128)), nclx()],
    refs: [{ type: 'dimg', to: [base.id, gain.id] }],
  };
  return {
    input: buildHeif([base, gain, tmap], tmap.id),
    baseInput: buildHeif([base], base.id),
  };
}

function invert3(matrix: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = matrix,
    A = e * i - f * h,
    B = f * g - d * i,
    C = d * h - e * g,
    determinant = a * A + b * B + c * C;
  return [
    A,
    c * h - b * i,
    b * f - c * e,
    B,
    a * i - c * g,
    c * d - a * f,
    C,
    b * g - a * h,
    a * e - b * d,
  ].map((value) => value / determinant);
}

function monochromeHeif(profile?: Uint8Array, iccType: 'prof' | 'rICC' = 'rICC'): Uint8Array {
  const properties = [
    box('hvcC', fixture('conformance/mini-alpha-L_8.hvcc')),
    full('ispe', 0, u32(128), u32(128)),
  ];
  if (profile) properties.push(box('colr', Buffer.from(iccType), profile));
  return buildHeif(
    [
      {
        id: 1,
        type: 'hvc1',
        data: fixture('conformance/mini-alpha-L_8.hevc'),
        properties,
      },
    ],
    1,
  );
}

describe('ICC image color management', () => {
  it('converts an embedded Display P3 profile to sRGB like LittleCMS', () => {
    const profile = parseIccProfile(p3Icc),
      convert = (rgb: [number, number, number]) =>
        linearSrgbToSrgb(
          iccToLinearSrgb(profile, rgb.map((value) => value / 255) as [number, number, number]),
        ).map((value) => Math.round(value * 255));

    expect(convert([184, 97, 41])).toEqual([197, 91, 17]);
    expect(convert([128, 128, 128])).toEqual([128, 128, 128]);
    expect(convert([128, 0, 255])).toEqual([141, 0, 255]);
  });

  it('reads sampled and single-gamma ICC curve tags', () => {
    const linear = parseIccProfile(p3WithCurve('linear')),
      gamma = parseIccProfile(p3WithCurve('gamma'));

    expect(linear.curves.map((curve) => curve(0.25))).toEqual([0.25, 0.25, 0.25]);
    expect(gamma.curves[0](0.5)).toBeCloseTo(0.5 ** (563 / 256), 8);
  });

  it('applies a Display P3 profile in the public decoder path', () => {
    const input = patternedHeif(p3Icc, 'prof'),
      raw = decodeNative(
        createRenderContext(input, { applyTransforms: false }),
        undefined,
        false,
        false,
      ),
      decoded = decodeHeic(input, { applyTransforms: false }),
      hdr = decodeHDRSync(input, { applyTransforms: false });

    expect(getHeicMetadata(input)).toMatchObject({ icc: p3Icc, iccType: 'prof' });
    expect(Array.from(raw.data.slice(0, 3))).toEqual([128, 0, 255]);
    expect(Array.from(decoded.data.slice(0, 4))).toEqual([141, 0, 255, 255]);
    expect(Array.from(decoded.data.slice(1000 * 4, 1000 * 4 + 4))).toEqual([236, 129, 0, 255]);
    expect(hdr.colorSpace).toBe('linear-srgb');
    expect(hdr.data.every(Number.isFinite)).toBe(true);
  });

  it('selects intent-appropriate ICC A2B LUTs with Lab PCS', () => {
    const profile = parseIccProfile(cvdLutIcc, undefined, 'perceptual'),
      relativeProfile = parseIccProfile(cvdLutIcc),
      reference: [number, number, number][] = [
        [128, 0, 255],
        [128, 128, 128],
        [255, 0, 0],
        [0, 255, 0],
        [0, 0, 255],
        [255, 255, 255],
        [0, 0, 0],
      ],
      lcms = [
        [81, 80, 255],
        [130, 130, 130],
        [147, 147, 0],
        [217, 217, 55],
        [38, 39, 255],
        [255, 255, 255],
        [41, 41, 41],
      ];
    // LittleCMS 2.19.1 `transicc -t0 -o '*sRGB'`, rounded to 8-bit values.
    expect(profile.transformToLinearSrgb).toBeDefined();
    for (let i = 0; i < reference.length; i++) {
      const actual = linearSrgbToSrgb(
        iccToLinearSrgb(
          profile,
          reference[i].map((value) => value / 255) as [number, number, number],
        ),
      ).map((value) => Math.round(value * 255));
      for (let channel = 0; channel < 3; channel++)
        expect(Math.abs(actual[channel] - lcms[i][channel])).toBeLessThanOrEqual(4);
    }

    const relativeSamples: [number, number, number][] = [
        [32, 64, 96],
        [64, 96, 128],
        [96, 128, 160],
        [128, 160, 192],
        [160, 192, 224],
        [24, 128, 72],
        [80, 40, 160],
        [200, 100, 50],
      ],
      relativeLcms = [
        [32, 64, 97],
        [64, 96, 129],
        [96, 128, 161],
        [128, 160, 193],
        [160, 192, 225],
        [28, 128, 71],
        [81, 40, 163],
        [200, 100, 49],
      ];
    // LittleCMS 2.19.1 `transicc -t1 -o '*sRGB'`; default decoding selects A2B1.
    for (let i = 0; i < relativeSamples.length; i++) {
      const actual = linearSrgbToSrgb(
        iccToLinearSrgb(
          relativeProfile,
          relativeSamples[i].map((value) => value / 255) as [number, number, number],
        ),
      ).map((value) => Math.round(value * 255));
      for (let channel = 0; channel < 3; channel++)
        expect(Math.abs(actual[channel] - relativeLcms[i][channel])).toBeLessThanOrEqual(1);
    }

    const input = patternedHeif(cvdLutIcc, 'prof'),
      decoded = decodeHeic(input, { applyTransforms: false }),
      hdr = decodeHDRSync(input, { applyTransforms: false }),
      expectedLinear = iccToLinearSrgb(relativeProfile, [128 / 255, 0, 1]),
      expectedSdr = linearSrgbToSrgb(expectedLinear).map((value) => Math.round(value * 255));
    expect(getHeicMetadata(input)).toMatchObject({ icc: cvdLutIcc, iccType: 'prof' });
    expect(Array.from(decoded.data.slice(0, 4))).toEqual([...expectedSdr, 255]);
    for (let channel = 0; channel < 3; channel++)
      expect(hdr.data[channel]).toBeCloseTo(expectedLinear[channel], 6);

    const officialInput = c71WithIcc(cvdLutIcc),
      officialRaw = decodeNative(
        createRenderContext(officialInput, { applyTransforms: false }),
        undefined,
        false,
        false,
      ),
      officialDecoded = decodeHeic(officialInput, { applyTransforms: false });
    for (const pixel of [0, 1, 17, 127, 128, 4095, 8192, 16383]) {
      const offset = pixel * 4,
        expected = linearSrgbToSrgb(
          iccToLinearSrgb(relativeProfile, [
            officialRaw.data[offset] / 255,
            officialRaw.data[offset + 1] / 255,
            officialRaw.data[offset + 2] / 255,
          ]),
        ).map((value) => Math.round(value * 255));
      expect(Array.from(officialDecoded.data.subarray(offset, offset + 3))).toEqual(expected);
    }

    const unsupportedRelative = cvdLutIcc.slice(),
      view = new DataView(
        unsupportedRelative.buffer,
        unsupportedRelative.byteOffset,
        unsupportedRelative.byteLength,
      );
    for (let index = 0; index < view.getUint32(128); index++) {
      const entry = 132 + index * 12;
      if (String.fromCharCode(...unsupportedRelative.subarray(entry, entry + 4)) === 'A2B1') {
        unsupportedRelative.set(new TextEncoder().encode('mpet'), view.getUint32(entry + 4));
        break;
      }
    }
    const fallback = parseIccProfile(unsupportedRelative),
      perceptual = iccToLinearSrgb(profile, [128 / 255, 0, 1]);
    expect(iccToLinearSrgb(fallback, [128 / 255, 0, 1])).toEqual(perceptual);
  });

  it('applies ICC.1 MPE device-to-PCS curve, matrix, and CLUT transforms', () => {
    const whiteMatrix = multiply3(SRGB_FROM_XYZ, D65_FROM_D50),
      mpeBase = xyzLutProfile('mAB'),
      relativeIcc = withIccTags(mpeBase, [
        [
          'D2B1',
          mpeTag(
            [
              mpeAcsElement('bACS'),
              mpePowerCurveSet(2),
              mpeAcsElement('eACS'),
              mpeD50WhiteMatrix(),
            ],
            3,
            3,
          ),
        ],
      ]),
      relativeProfile = parseIccProfile(relativeIcc),
      relative = iccToLinearSrgb(relativeProfile, [0.5, 0.5, 0.5]),
      expectedRelative = apply3(whiteMatrix, [0.9642 * 0.25, 0.25, 0.8249 * 0.25]);
    expect(relativeProfile.transformToLinearSrgb).toBeDefined();
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs(relative[channel] - expectedRelative[channel])).toBeLessThan(1e-6);

    const input = patternedHeif(relativeIcc, 'prof'),
      raw = decodeNative(
        createRenderContext(input, { applyTransforms: false }),
        undefined,
        false,
        false,
      ),
      rendered = decodeHeic(input, { applyTransforms: false }),
      expectedPixel = linearSrgbToSrgb(
        iccToLinearSrgb(relativeProfile, [raw.data[0] / 255, raw.data[1] / 255, raw.data[2] / 255]),
      ).map((value) => Math.round(value * 255));
    expect(Array.from(rendered.data.slice(0, 4))).toEqual([...expectedPixel, 255]);

    const perceptualIcc = withIccTags(mpeBase, [
        ['D2B0', mpeTag([mpePowerCurveSet(3), mpeD50WhiteMatrix()], 3, 3)],
      ]),
      perceptual = iccToLinearSrgb(
        parseIccProfile(perceptualIcc, undefined, 'perceptual'),
        [0.5, 0.5, 0.5],
      ),
      expectedPerceptual = apply3(whiteMatrix, [0.9642 * 0.125, 0.125, 0.8249 * 0.125]);
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs(perceptual[channel] - expectedPerceptual[channel])).toBeLessThan(1e-6);

    const clutIcc = withIccTags(mpeBase, [['D2B2', mpeTag([mpeIdentityClut()], 3, 3)]]),
      sample: [number, number, number] = [0.25, 0.5, 0.75],
      clutOutput = iccToLinearSrgb(parseIccProfile(clutIcc, undefined, 'saturation'), sample),
      expectedClut = apply3(whiteMatrix, sample);
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs(clutOutput[channel] - expectedClut[channel])).toBeLessThan(1e-6);

    const fiveDimensionalMpe = withIccTags(mpeBase, [
        [
          'D2B1',
          mpeTag(
            [
              mpeMatrix(3, [
                [1, 0, 0],
                [0, 1, 0],
                [0, 0, 1],
                [0.5, 0.5, 0],
                [0, 0.5, 0.5],
              ]),
              mpeBinaryClut(5, 3, ([r, g, b, rg, gb]) => [
                (r! + rg!) / 2,
                (g! + gb!) / 2,
                (b! + rg! + gb!) / 3,
              ]),
              mpeD50WhiteMatrix(),
            ],
            3,
            3,
          ),
        ],
      ]),
      fiveDimensionalOutput = iccToLinearSrgb(parseIccProfile(fiveDimensionalMpe), sample),
      fiveDimensionalPcs = [0.3125, 0.5625, 7 / 12] as const,
      expectedFiveDimensional = apply3(whiteMatrix, [
        0.9642 * fiveDimensionalPcs[0],
        fiveDimensionalPcs[1],
        0.8249 * fiveDimensionalPcs[2],
      ]);
    for (let channel = 0; channel < 3; channel++)
      expect(
        Math.abs(fiveDimensionalOutput[channel] - expectedFiveDimensional[channel]),
      ).toBeLessThan(1e-6);

    const mABBase = xyzLutProfile('mAB'),
      channelAxes = [
        [0, 3, 6, 9, 12, 15],
        [1, 4, 7, 10, 13],
        [2, 5, 8, 11, 14],
      ] as const,
      sixteenDimensionalMpe = withIccTags(mpeBase, [
        [
          'D2B1',
          mpeTag(
            [
              mpeMatrix(
                3,
                Array.from({ length: 16 }, (_, axis) => [
                  Number(axis % 3 === 0),
                  Number(axis % 3 === 1),
                  Number(axis % 3 === 2),
                ]),
              ),
              mpeBinaryClut(16, 3, (values) =>
                channelAxes.map(
                  (axes) => axes.reduce((sum, axis) => sum + values[axis]!, 0) / axes.length,
                ),
              ),
              mpeD50WhiteMatrix(),
            ],
            3,
            3,
          ),
        ],
      ]),
      sixteenDimensionalOutput = iccToLinearSrgb(
        parseIccProfile(sixteenDimensionalMpe, undefined, 'relative', { imagePixels: 435 }),
        sample,
      ),
      expectedSixteenDimensional = apply3(whiteMatrix, [
        0.9642 * sample[0],
        sample[1],
        0.8249 * sample[2],
      ]);
    for (let channel = 0; channel < 3; channel++)
      expect(
        Math.abs(sixteenDimensionalOutput[channel] - expectedSixteenDimensional[channel]),
      ).toBeLessThan(1e-6);
    expect(
      iccToLinearSrgb(
        parseIccProfile(sixteenDimensionalMpe, undefined, 'relative', { imagePixels: 436 }),
        sample,
      ),
    ).toEqual(iccToLinearSrgb(parseIccProfile(mABBase), sample));

    const unknownElement = Buffer.alloc(12);
    unknownElement.write('test', 0, 'ascii');
    unknownElement.writeUInt16BE(3, 8);
    unknownElement.writeUInt16BE(3, 10);
    const unsupportedMpe = withIccTags(mABBase, [['D2B0', mpeTag([unknownElement], 3, 3)]]),
      fallback = iccToLinearSrgb(parseIccProfile(unsupportedMpe, undefined, 'perceptual'), sample),
      a2b0 = iccToLinearSrgb(parseIccProfile(mABBase), sample);
    expect(fallback).toEqual(a2b0);

    const sixDimensionalMpe = withIccTags(mABBase, [
        [
          'D2B0',
          mpeTag(
            [
              mpeMatrix(3, [
                [1, 0, 0],
                [0, 1, 0],
                [0, 0, 1],
                [1, 0, 0],
                [0, 1, 0],
                [0, 0, 1],
              ]),
              mpeBinaryClut(6, 3, (values) => values.slice(0, 3)),
              mpeD50WhiteMatrix(),
            ],
            3,
            3,
          ),
        ],
      ]),
      sixDimensionalProfile = parseIccProfile(sixDimensionalMpe, undefined, 'perceptual', {
        imagePixels: 10_000,
      });
    const sixDimensionalOutput = iccToLinearSrgb(sixDimensionalProfile, sample),
      expectedSixDimensional = apply3(whiteMatrix, [
        0.9642 * sample[0],
        sample[1],
        0.8249 * sample[2],
      ]);
    for (let channel = 0; channel < 3; channel++)
      expect(
        Math.abs(sixDimensionalOutput[channel] - expectedSixDimensional[channel]),
      ).toBeLessThan(1e-6);
    expect(
      iccToLinearSrgb(
        parseIccProfile(sixDimensionalMpe, undefined, 'perceptual', { imagePixels: 1_100_000 }),
        sample,
      ),
    ).toEqual(a2b0);

    const overLimitMpe = withIccTags(mABBase, [
      [
        'D2B0',
        mpeTag(
          Array.from({ length: 257 }, () => mpeAcsElement('bACS')),
          3,
          3,
        ),
      ],
    ]);
    expect(iccToLinearSrgb(parseIccProfile(overLimitMpe, undefined, 'perceptual'), sample)).toEqual(
      a2b0,
    );
  });

  it('selects ICC-absolute D2B3 transforms and converts media-relative fallbacks', () => {
    const base = xyzLutProfile('mAB'),
      whitePoint = Buffer.alloc(20);
    whitePoint.write('XYZ ', 0, 'ascii');
    [0.9642 * 2, 2, 0.8249 * 2].forEach((value, index) =>
      whitePoint.writeInt32BE(Math.round(value * 65_536), 8 + index * 4),
    );

    const d2b3Icc = withIccTags(base, [
        ['wtpt', whitePoint],
        ['D2B3', mpeTag([mpeD50WhiteMatrix(0.25)], 3, 3)],
      ]),
      d2b3Profile = parseIccProfile(d2b3Icc, 'prof', 'absolute'),
      sample: [number, number, number] = [0.5, 0.5, 0.5],
      d2b3Output = iccToLinearSrgb(d2b3Profile, sample);
    for (const value of d2b3Output) expect(value).toBeCloseTo(0.125, 3);

    const relativeIcc = withIccTags(base, [
        ['wtpt', whitePoint],
        ['D2B1', mpeTag([mpeD50WhiteMatrix(0.25)], 3, 3)],
      ]),
      relativeProfile = parseIccProfile(relativeIcc, 'prof', 'relative'),
      absoluteFallback = parseIccProfile(relativeIcc, 'prof', 'absolute'),
      relativeOutput = iccToLinearSrgb(relativeProfile, sample),
      fallbackOutput = iccToLinearSrgb(absoluteFallback, sample);
    for (const value of relativeOutput) expect(value).toBeCloseTo(0.125, 3);
    for (const value of fallbackOutput) expect(value).toBeCloseTo(0.25, 3);

    const matrixIcc = withIccTags(p3Icc, [['wtpt', whitePoint]]),
      matrixRelative = iccToLinearSrgb(parseIccProfile(matrixIcc), sample),
      matrixAbsolute = iccToLinearSrgb(parseIccProfile(matrixIcc, 'prof', 'absolute'), sample),
      grayIcc = withIccTags(grayInputProfile('Lab '), [['wtpt', whitePoint]]),
      grayRelative = iccToLinearSrgb(parseIccProfile(grayIcc), [sample[0], 0, 0]),
      grayAbsolute = iccToLinearSrgb(parseIccProfile(grayIcc, 'prof', 'absolute'), [
        sample[0],
        0,
        0,
      ]);
    for (let channel = 0; channel < 3; channel++) {
      expect(matrixAbsolute[channel]).toBeCloseTo(matrixRelative[channel] * 2, 4);
      expect(grayAbsolute[channel]).toBeCloseTo(grayRelative[channel] * 2, 4);
    }

    const input = patternedHeif(d2b3Icc, 'prof'),
      raw = decodeNative(
        createRenderContext(input, { applyTransforms: false }),
        undefined,
        false,
        false,
      ),
      expected = iccToLinearSrgb(d2b3Profile, [
        raw.data[0] / 255,
        raw.data[1] / 255,
        raw.data[2] / 255,
      ]),
      hdr = decodeHDRSync(input, { applyTransforms: false, iccRenderingIntent: 'absolute' });
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs(hdr.data[channel] - expected[channel])).toBeLessThan(1e-6);
  });

  it('evaluates ICC MPE formula types 1 and 2 and sampled curve segments', () => {
    const base = xyzLutProfile('mAB'),
      whiteMatrix = multiply3(SRGB_FROM_XYZ, D65_FROM_D50),
      input: [number, number, number] = [0.5, 0.5, 0.5],
      identity = mpeFormulaSegment(0, [1, 1, 0, 0]),
      cases: [1 | 2, number[], number][] = [
        [1, [1, 1, 1, 1, 0], Math.log10(1.5)],
        [2, [1, 2, 1, -1, 0], 2 ** -0.5],
      ];

    for (const [kind, parameters, curveValue] of cases) {
      const curve = mpePiecewiseCurve(
          [identity, mpeFormulaSegment(kind, parameters), identity],
          [0.25, 0.75],
        ),
        icc = withIccTags(base, [
          ['D2B1', mpeTag([mpeCurveSet(curve), mpeD50WhiteMatrix()], 3, 3)],
        ]),
        actual = iccToLinearSrgb(parseIccProfile(icc), input),
        expected = apply3(whiteMatrix, [0.9642 * curveValue, curveValue, 0.8249 * curveValue]);
      for (let channel = 0; channel < 3; channel++)
        expect(Math.abs(actual[channel] - expected[channel])).toBeLessThan(1e-6);
    }

    const sampledCurve = mpePiecewiseCurve(
        [identity, mpeSampledSegment([0.4, 0.8]), identity],
        [0.25, 0.75],
      ),
      sampledIcc = withIccTags(base, [
        ['D2B1', mpeTag([mpeCurveSet(sampledCurve), mpeD50WhiteMatrix()], 3, 3)],
      ]),
      sampledProfile = parseIccProfile(sampledIcc);
    for (const [value, curveValue] of [
      [0.5, 0.4],
      [0.625, 0.6],
    ] as const) {
      const actual = iccToLinearSrgb(sampledProfile, [value, value, value]),
        expected = apply3(whiteMatrix, [0.9642 * curveValue, curveValue, 0.8249 * curveValue]);
      for (let channel = 0; channel < 3; channel++)
        expect(Math.abs(actual[channel] - expected[channel])).toBeLessThan(1e-6);
    }

    const labBase = base.slice();
    labBase.set(Buffer.from('Lab '), 20);
    const labIcc = withIccTags(labBase, [['D2B1', mpeTag([mpeNeutralLabMatrix(50)], 3, 3)]]),
      labOutput = iccToLinearSrgb(parseIccProfile(labIcc), input),
      labY = ((50 + 16) / 116) ** 3,
      expectedLab = apply3(whiteMatrix, [0.9642 * labY, labY, 0.8249 * labY]);
    for (let channel = 0; channel < 3; channel++)
      expect(Math.abs(labOutput[channel] - expectedLab[channel])).toBeLessThan(1e-6);

    const truncatedCurve = Buffer.alloc(16);
    truncatedCurve.write('curf', 0, 'ascii');
    truncatedCurve.writeUInt16BE(1, 8);
    truncatedCurve.write('parf', 12, 'ascii');
    const malformedIcc = withIccTags(base, [['D2B1', mpeTag([mpeCurveSet(truncatedCurve)], 3, 3)]]);
    let malformedError: unknown;
    try {
      parseIccProfile(malformedIcc);
    } catch (error) {
      malformedError = error;
    }
    expect(malformedError).toMatchObject({ code: 'INVALID_CONTAINER' });
  });

  it('selects ICC A2B2 saturation transforms in SDR and HDR decoding', async () => {
    const icc = cvdSaturationProfile(),
      profile = parseIccProfile(icc, undefined, 'saturation'),
      samples: [number, number, number][] = [
        [32, 64, 96],
        [64, 96, 128],
        [96, 128, 160],
        [128, 160, 192],
        [200, 100, 50],
      ],
      // LittleCMS 2.19.1 `transicc -t2 -o '*sRGB'` on the retagged CVD profile.
      lcms = [
        [70, 69, 102],
        [95, 94, 132],
        [124, 123, 162],
        [154, 153, 193],
        [141, 141, 54],
      ];

    expect(profile.transformToLinearSrgb).toBeDefined();
    for (let index = 0; index < samples.length; index++) {
      const actual = linearSrgbToSrgb(
        iccToLinearSrgb(
          profile,
          samples[index].map((value) => value / 255) as [number, number, number],
        ),
      ).map((value) => Math.round(value * 255));
      for (let channel = 0; channel < 3; channel++)
        expect(Math.abs(actual[channel] - lcms[index][channel])).toBeLessThanOrEqual(2);
    }

    const fallback = parseIccProfile(cvdLutIcc, undefined, 'saturation'),
      perceptual = parseIccProfile(cvdLutIcc, undefined, 'perceptual'),
      sample: [number, number, number] = [32 / 255, 64 / 255, 96 / 255];
    expect(iccToLinearSrgb(fallback, sample)).toEqual(iccToLinearSrgb(perceptual, sample));

    const input = patternedHeif(icc, 'prof'),
      raw = decodeNative(
        createRenderContext(input, { applyTransforms: false }),
        undefined,
        false,
        false,
      ),
      relative = decodeHeic(input, { applyTransforms: false }),
      saturated = decodeHeic(input, {
        applyTransforms: false,
        iccRenderingIntent: 'saturation',
      }),
      hdr = decodeHDRSync(input, {
        applyTransforms: false,
        iccRenderingIntent: 'saturation',
      }),
      expectedLinear = iccToLinearSrgb(profile, [
        raw.data[0] / 255,
        raw.data[1] / 255,
        raw.data[2] / 255,
      ]),
      expectedSdr = linearSrgbToSrgb(expectedLinear).map((value) => Math.round(value * 255));
    expect(Array.from(saturated.data.slice(0, 4))).toEqual([...expectedSdr, 255]);
    expect(Array.from(relative.data.slice(0, 3))).not.toEqual(expectedSdr);
    for (let channel = 0; channel < 3; channel++)
      expect(hdr.data[channel]).toBeCloseTo(expectedLinear[channel], 6);

    const asyncSdr = await decode(input, {
        execution: 'main',
        applyTransforms: false,
        iccRenderingIntent: 'saturation',
      }),
      asyncHdr = await decodeHDR(input, {
        execution: 'main',
        applyTransforms: false,
        iccRenderingIntent: 'saturation',
      });
    expect(Array.from(asyncSdr.data)).toEqual(Array.from(saturated.data));
    expect(Array.from(asyncHdr.data)).toEqual(Array.from(hdr.data));
  });

  it('uses A2B1 on matrix/TRC profiles and falls back to matrix/TRC when A2B1 is unsupported', () => {
    const icc = matrixProfileWithA2B1(),
      relative = parseIccProfile(icc),
      perceptual = parseIccProfile(icc, undefined, 'perceptual'),
      matrix = parseIccProfile(p3Icc),
      lut = parseIccProfile(xyzLutProfile('mAB')),
      sample: [number, number, number] = [0.5, 0.25, 0.75];
    expect(iccToLinearSrgb(relative, sample)).toEqual(iccToLinearSrgb(lut, sample));
    expect(iccToLinearSrgb(perceptual, sample)).toEqual(iccToLinearSrgb(matrix, sample));

    const unsupportedA2B1 = icc.slice(),
      view = new DataView(
        unsupportedA2B1.buffer,
        unsupportedA2B1.byteOffset,
        unsupportedA2B1.byteLength,
      );
    for (let index = 0; index < view.getUint32(128); index++) {
      const entry = 132 + index * 12;
      if (String.fromCharCode(...unsupportedA2B1.subarray(entry, entry + 4)) === 'A2B1') {
        unsupportedA2B1.set(new TextEncoder().encode('mpet'), view.getUint32(entry + 4));
        break;
      }
    }
    expect(iccToLinearSrgb(parseIccProfile(unsupportedA2B1), sample)).toEqual(
      iccToLinearSrgb(matrix, sample),
    );
  });

  it('decodes the 16-bit XYZ PCS used by mAB and mft2 input LUTs', () => {
    const samples: [number, number, number][] = [
        [0, 0, 0],
        [0.5, 0.5, 0.5],
        [1, 1, 1],
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      // LittleCMS 2.19 RGB-double sRGB outputs converted back to linear values.
      reference = [
        [0, 0, 0],
        [1.0262834, 0.970815, 1.2487237],
        [2.0525351, 1.9416002, 2.4974095],
        [6.2682777, -1.9574672, 0.1439257],
        [-3.2343684, 3.8322018, -0.4579808],
        [-0.9813732, 0.0668658, 2.8114648],
      ];

    for (const kind of ['mft2', 'mAB'] as const) {
      const profileClass = kind === 'mAB' ? 'mntr' : 'scnr',
        icc = xyzLutProfile(kind, profileClass),
        profile = parseIccProfile(icc);
      expect(profile.transformToLinearSrgb).toBeDefined();
      for (let index = 0; index < samples.length; index++) {
        const actual = iccToLinearSrgb(profile, samples[index]);
        for (let channel = 0; channel < 3; channel++)
          expect(Math.abs(actual[channel] - reference[index][channel])).toBeLessThan(0.002);
      }

      const input = patternedHeif(icc, 'prof'),
        raw = decodeNative(
          createRenderContext(input, { applyTransforms: false }),
          undefined,
          false,
          false,
        ),
        hdr = decodeHDRSync(input, { applyTransforms: false }),
        expected = iccToLinearSrgb(profile, [
          raw.data[0] / 255,
          raw.data[1] / 255,
          raw.data[2] / 255,
        ]);
      expect(getHeicMetadata(input)).toMatchObject({ icc, iccType: 'prof' });
      for (let channel = 0; channel < 3; channel++)
        expect(Math.abs(hdr.data[channel] - expected[channel])).toBeLessThan(0.00001);
    }

    expect(() => parseIccProfile(xyzLutProfile('mft1'))).toThrow(
      'implementation-specific encoding',
    );
  });

  for (const { kind, lcms } of [
    {
      kind: 'mft1' as const,
      lcms: [
        [174, 141, 111],
        [143, 176, 151],
        [132, 196, 255],
        [0, 178, 198],
        [136, 117, 58],
        [246, 255, 231],
        [0, 100, 174],
      ],
    },
    {
      kind: 'mft2' as const,
      lcms: [
        [175, 142, 112],
        [143, 176, 152],
        [133, 195, 255],
        [0, 178, 200],
        [136, 117, 58],
        [246, 255, 233],
        [0, 100, 174],
      ],
    },
  ]) {
    it(`applies an ICC ${kind} RGB A2B0 LUT with legacy Lab PCS encoding`, () => {
      const icc = legacyLutProfile(kind),
        profile = parseIccProfile(icc),
        samples: [number, number, number][] = [
          [128 / 255, 0, 1],
          [128 / 255, 128 / 255, 128 / 255],
          [1, 0, 0],
          [0, 1, 0],
          [0, 0, 1],
          [1, 1, 1],
          [0, 0, 0],
        ];
      expect(profile.transformToLinearSrgb).toBeDefined();
      let restrictedError: unknown;
      try {
        parseIccProfile(icc, 'rICC');
      } catch (error) {
        restrictedError = error;
      }
      expect(restrictedError).toMatchObject({ code: 'INVALID_CONTAINER' });

      // Reference values are LittleCMS 2.19 `transicc -t1 -o '*sRGB'`,
      // rounded and clipped to 8-bit codes from a synthetic ICC LUT profile.
      for (let index = 0; index < samples.length; index++) {
        const actual = linearSrgbToSrgb(iccToLinearSrgb(profile, samples[index])).map((value) =>
          Math.round(value * 255),
        );
        for (let channel = 0; channel < 3; channel++)
          expect(Math.abs(actual[channel] - lcms[index][channel])).toBeLessThanOrEqual(4);
      }

      const input = patternedHeif(icc, 'prof'),
        raw = decodeNative(
          createRenderContext(input, { applyTransforms: false }),
          undefined,
          false,
          false,
        ),
        decoded = decodeHeic(input, { applyTransforms: false }),
        hdr = decodeHDRSync(input, { applyTransforms: false });
      expect(getHeicMetadata(input)).toMatchObject({ icc, iccType: 'prof' });
      const expectedFirstPixel = linearSrgbToSrgb(
        iccToLinearSrgb(profile, [raw.data[0] / 255, raw.data[1] / 255, raw.data[2] / 255]),
      ).map((value) => Math.round(value * 255));
      expect(Array.from(decoded.data.slice(0, 4))).toEqual([...expectedFirstPixel, 255]);
      const expectedHdr = iccToLinearSrgb(profile, [
        raw.data[0] / 255,
        raw.data[1] / 255,
        raw.data[2] / 255,
      ]);
      for (let channel = 0; channel < 3; channel++)
        expect(hdr.data[channel]).toBeCloseTo(expectedHdr[channel], 6);

      const officialInput = c71WithIcc(icc),
        officialRaw = decodeNative(
          createRenderContext(officialInput, { applyTransforms: false }),
          undefined,
          false,
          false,
        ),
        officialDecoded = decodeHeic(officialInput, { applyTransforms: false });
      for (const pixel of [0, 1, 17, 127, 128, 4095, 8192, 16383]) {
        const offset = pixel * 4,
          expected = linearSrgbToSrgb(
            iccToLinearSrgb(profile, [
              officialRaw.data[offset] / 255,
              officialRaw.data[offset + 1] / 255,
              officialRaw.data[offset + 2] / 255,
            ]),
          ).map((value) => Math.round(value * 255));
        expect(Array.from(officialDecoded.data.subarray(offset, offset + 3))).toEqual(expected);
      }
    });
  }

  it('applies ISO gain maps in base and alternate RGB LUT ICC spaces with CICP primaries', () => {
    const icc = withCicp(cvdLutIcc, 12, 13),
      p3ToSrgb = multiply3(SRGB_FROM_XYZ, [...getRgbToXyzD65Matrix(12)!]),
      srgbToP3 = invert3(p3ToSrgb);
    for (const useBase of [true, false]) {
      const { input, baseInput } = isoGainMapWithBaseProfile(icc, useBase),
        context = createRenderContext(input),
        info = getHeicInfo(input, context.boxes),
        gain = decodeNative(context, info.derivedItems[1], false, false),
        base = decodeHDRSync(baseInput, { applyTransforms: false }),
        decoded = decodeHDRSync(input, { displayHeadroom: 4, applyTransforms: false }),
        max = 2 ** gain.bitDepth - 1;
      expect(decoded.source).toBe('iso-gainmap');
      for (const pixel of [0, 1, 17, 127, 511, 1024, 2048, 4095]) {
        const offset = pixel * 4,
          gainValue = gain.data[offset] / max,
          multiplier = 2 ** (2 * gainValue),
          baseRgb = [base.data[offset], base.data[offset + 1], base.data[offset + 2]],
          working = apply3(srgbToP3, baseRgb),
          expected = apply3(
            p3ToSrgb,
            working.map((value) => value * multiplier),
          );
        for (let channel = 0; channel < 3; channel++)
          expect(Math.abs(decoded.data[offset + channel] - expected[channel])).toBeLessThan(1e-4);
      }
    }
  });

  it('requires CICP primaries when an RGB LUT ICC profile selects the gain-map space', () => {
    for (const useBase of [true, false]) {
      const { input } = isoGainMapWithBaseProfile(cvdLutIcc, useBase);
      expect(() => decodeHDRSync(input, { displayHeadroom: 4 })).toThrow(
        'does not signal usable RGB color primaries',
      );
    }
  });

  it('applies a monochrome ICC baseline in a separately signaled alternate RGB space', () => {
    const { input, baseInput } = isoGainMapWithGrayBase(false),
      base = decodeHDRSync(baseInput, { applyTransforms: false }),
      decoded = decodeHDRSync(input, { displayHeadroom: 4, applyTransforms: false });
    expect(decoded.source).toBe('iso-gainmap');
    expect(decoded.data.every(Number.isFinite)).toBe(true);
    expect(decoded.data.some((value, index) => index % 4 !== 3 && value > base.data[index])).toBe(
      true,
    );
  });

  it('requires RGB primaries when a monochrome ICC baseline selects the gain-map space', () => {
    const { input } = isoGainMapWithGrayBase(true);
    expect(() => decodeHDRSync(input, { displayHeadroom: 4 })).toThrow(
      'requires RGB color primaries',
    );
  });

  it('rejects invalid legacy LUT table dimensions and non-identity RGB matrices', () => {
    const a2bOffset = (icc: Uint8Array) => {
      const view = new DataView(icc.buffer, icc.byteOffset, icc.byteLength),
        count = view.getUint32(128);
      for (let index = 0; index < count; index++) {
        const entry = 132 + index * 12;
        if (String.fromCharCode(...icc.subarray(entry, entry + 4)) === 'A2B0')
          return view.getUint32(entry + 4);
      }
      throw new Error('synthetic ICC profile has no A2B0 tag');
    };

    const badEntryCount = legacyLutProfile('mft2'),
      badEntryOffset = a2bOffset(badEntryCount),
      badEntryView = new DataView(
        badEntryCount.buffer,
        badEntryCount.byteOffset,
        badEntryCount.byteLength,
      );
    badEntryView.setUint16(badEntryOffset + 48, 1);
    let entryCountError: unknown;
    try {
      parseIccProfile(badEntryCount);
    } catch (error) {
      entryCountError = error;
    }
    expect(entryCountError).toMatchObject({ code: 'INVALID_CONTAINER' });

    const badMatrix = legacyLutProfile('mft1'),
      matrixOffset = a2bOffset(badMatrix),
      matrixView = new DataView(badMatrix.buffer, badMatrix.byteOffset, badMatrix.byteLength);
    matrixView.setInt32(matrixOffset + 12, 65_537);
    let matrixError: unknown;
    try {
      parseIccProfile(badMatrix);
    } catch (error) {
      matrixError = error;
    }
    expect(matrixError).toMatchObject({ code: 'INVALID_CONTAINER' });
  });

  it('keeps LUT profiles out of restricted rICC and requires A2B0 for LUT-only profiles', () => {
    let restrictedError: unknown;
    try {
      parseIccProfile(cvdLutIcc, 'rICC');
    } catch (error) {
      restrictedError = error;
    }
    expect(restrictedError).toMatchObject({ code: 'INVALID_CONTAINER' });

    const relativeOnly = cvdLutIcc.slice(),
      tableCount = new DataView(
        relativeOnly.buffer,
        relativeOnly.byteOffset,
        relativeOnly.byteLength,
      ).getUint32(128);
    for (let i = 0; i < tableCount; i++) {
      const entry = 132 + i * 12;
      if (String.fromCharCode(...relativeOnly.subarray(entry, entry + 4)) === 'A2B0') {
        relativeOnly.set(new TextEncoder().encode('ZZZZ'), entry);
        break;
      }
    }
    let relativeError: unknown;
    try {
      parseIccProfile(relativeOnly);
    } catch (error) {
      relativeError = error;
    }
    expect(relativeError).toMatchObject({ code: 'UNSUPPORTED_FEATURE' });
  });

  it('accepts an RGB input matrix profile in the restricted rICC form', () => {
    const restricted = p3Icc.slice();
    restricted.set(new TextEncoder().encode('scnr'), 12);
    const input = patternedHeif(restricted, 'rICC'),
      decoded = decodeHeic(input, { applyTransforms: false });

    expect(getHeicMetadata(input).iccType).toBe('rICC');
    expect(Array.from(decoded.data.slice(0, 4))).toEqual([141, 0, 255, 255]);
  });

  it('applies a restricted monochrome grayTRC profile to a monochrome HEVC image', () => {
    const icc = grayInputProfile(),
      input = monochromeHeif(icc),
      source = decodeHeic(monochromeHeif()),
      decoded = decodeHeic(input, { applyTransforms: false }),
      hdr = decodeHDRSync(input, { applyTransforms: false });

    expect(getHeicMetadata(input)).toMatchObject({ icc, iccType: 'rICC' });
    expect(decoded.width).toBe(128);
    expect(hdr.colorSpace).toBe('linear-srgb');
    expect(hdr.data.every(Number.isFinite)).toBe(true);
    for (const pixel of [0, 1, 17, 127, 128, 4095, 8192, 16383]) {
      const encoded = source.data[pixel * 4] / 255,
        linear = encoded ** (563 / 256),
        expected = Math.round(
          (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055) * 255,
        ),
        actual = decoded.data.subarray(pixel * 4, pixel * 4 + 4);
      expect(Array.from(actual)).toEqual([expected, expected, expected, 255]);
    }
  });

  it('applies a monochrome grayTRC profile whose PCS is Lab', () => {
    const icc = grayInputProfile('Lab '),
      profile = parseIccProfile(icc),
      samples = [0, 64, 128, 255].map((value) => value / 255),
      lcmsSrgb = [0, 16, 53, 255];

    expect(profile.channelModel).toBe('GRAY');
    expect(profile.transformToLinearSrgb).toBeDefined();
    for (let index = 0; index < samples.length; index++) {
      const actual = linearSrgbToSrgb(
        iccToLinearSrgb(profile, [samples[index], samples[index], samples[index]]),
      ).map((value) => Math.round(value * 255));
      // LittleCMS 2.19, using ICC F.2 grayTRC mapping to the PCSLAB white axis.
      expect(actual).toEqual([lcmsSrgb[index], lcmsSrgb[index], lcmsSrgb[index]]);
    }

    const input = monochromeHeif(icc, 'prof'),
      source = decodeHeic(monochromeHeif()),
      decoded = decodeHeic(input, { applyTransforms: false }),
      hdr = decodeHDRSync(input, { applyTransforms: false });
    expect(getHeicMetadata(input)).toMatchObject({ icc, iccType: 'prof' });
    expect(hdr.colorSpace).toBe('linear-srgb');
    expect(hdr.data.every(Number.isFinite)).toBe(true);
    for (const pixel of [0, 1, 17, 127, 128, 4095, 8192, 16383]) {
      const value = source.data[pixel * 4] / 255,
        expected = linearSrgbToSrgb(iccToLinearSrgb(profile, [value, value, value])).map(
          (channel) => Math.round(channel * 255),
        ),
        actual = decoded.data.subarray(pixel * 4, pixel * 4 + 4);
      expect(Array.from(actual)).toEqual([...expected, 255]);
    }
  });

  it('applies monochrome A2B0 mft1, mft2, and mAB transforms', () => {
    const source = decodeHeic(monochromeHeif()),
      samples = [0, 64, 128, 191, 255],
      // LittleCMS 2.19.1 transicc -t1 -o '*sRGB' on the synthetic gray Lab profiles.
      lcmsBytes = [48, 82, 119, 158, 198];

    for (const kind of ['mft1', 'mft2', 'mAB'] as const) {
      const icc = grayA2bProfile(kind),
        profile = parseIccProfile(icc),
        actualSamples = samples.map((value) =>
          linearSrgbToSrgb(iccToLinearSrgb(profile, [value / 255, value / 255, value / 255])).map(
            (channel) => Math.round(channel * 255),
          ),
        );

      expect(profile.channelModel).toBe('GRAY');
      expect(profile.transformToLinearSrgb).toBeDefined();
      for (let sample = 0; sample < lcmsBytes.length; sample++)
        for (const channel of actualSamples[sample])
          expect(Math.abs(channel - lcmsBytes[sample])).toBeLessThanOrEqual(1);

      const input = monochromeHeif(icc, 'prof'),
        decoded = decodeHeic(input, { applyTransforms: false }),
        hdr = decodeHDRSync(input, { applyTransforms: false });
      expect(getHeicMetadata(input)).toMatchObject({ icc, iccType: 'prof' });
      expect(hdr.colorSpace).toBe('linear-srgb');
      for (const pixel of [0, 1, 17, 127, 128, 4095, 8192, 16383]) {
        const value = source.data[pixel * 4] / 255,
          linear = iccToLinearSrgb(profile, [value, value, value]),
          expected = linearSrgbToSrgb(linear).map((channel) => Math.round(channel * 255)),
          actual = decoded.data.subarray(pixel * 4, pixel * 4 + 4),
          hdrActual = hdr.data.subarray(pixel * 4, pixel * 4 + 3);
        expect(Array.from(actual)).toEqual([...expected, 255]);
        for (let channel = 0; channel < 3; channel++)
          expect(hdrActual[channel]).toBeCloseTo(linear[channel], 5);
      }
    }
  });

  it('rejects an RGB-only CICP tag in a grayscale ICC profile', () => {
    const invalid = grayInputProfile(),
      view = new DataView(invalid.buffer, invalid.byteOffset, invalid.byteLength),
      count = view.getUint32(128);
    for (let i = 0; i < count; i++) {
      const entry = 132 + i * 12;
      if (String.fromCharCode(...invalid.subarray(entry, entry + 4)) === 'kTRC') {
        invalid.set(new TextEncoder().encode('cicp'), entry);
        const offset = view.getUint32(entry + 4);
        invalid.set(new TextEncoder().encode('cicp'), offset);
        view.setUint32(offset + 8, 1);
        break;
      }
    }
    let error: unknown;
    try {
      decodeHeic(monochromeHeif(invalid), { applyTransforms: false });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'INVALID_CONTAINER' });
  });

  it('rejects an unrestricted display profile mislabeled as rICC', () => {
    const input = patternedHeif(p3Icc, 'rICC');
    let error: unknown;
    try {
      decodeHeic(input, { applyTransforms: false });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'INVALID_CONTAINER' });
  });

  it('rejects a profile with a truncated colorant tag', () => {
    const malformed = p3Icc.slice(),
      view = new DataView(malformed.buffer, malformed.byteOffset, malformed.byteLength);
    view.setUint32(132 + 4, malformed.length - 8);
    view.setUint32(132 + 8, 20);
    let error: unknown;
    try {
      parseIccProfile(malformed);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'INVALID_CONTAINER' });
  });

  it('rejects profile classes outside the supported input/display subset', () => {
    const unsupported = p3Icc.slice();
    unsupported.set(new TextEncoder().encode('prtr'), 12);
    let error: unknown;
    try {
      parseIccProfile(unsupported);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: 'UNSUPPORTED_FEATURE' });
  });
});
