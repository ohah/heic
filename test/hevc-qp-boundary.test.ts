import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { decodeHeic } from '../src/decoder';
import { getHeicInfo } from '../src/container/heic';
import { getFtypInfo, parseISOBMFF } from '../src/container/heif';
import { decodeLayeredHevcPicture } from '../src/hevc/layered-picture';
import { BitReader, splitAnnexB, toRbsp } from '../src/hevc/nal';
import { decodeItemPlanes } from '../src/planes';
import { wrapHevc, wrapHevcPredChain } from '../scripts/lib/heif';

function md5(data: Uint8Array): string {
  return createHash('md5').update(data).digest('hex');
}

function planesBytes(planes: {
  y: Uint8Array | Uint16Array;
  cb: Uint8Array | Uint16Array;
  cr: Uint8Array | Uint16Array;
}): Buffer {
  return Buffer.concat(
    [planes.y, planes.cb, planes.cr].map((plane) =>
      Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength),
    ),
  );
}

function asAnnexB(nals: readonly Uint8Array[]): Buffer {
  return Buffer.concat(nals.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), Buffer.from(nal)]));
}

function ueBits(value: number): string {
  const binary = (value + 1).toString(2);
  return '0'.repeat(binary.length - 1) + binary;
}

function escapeRbsp(rbsp: Uint8Array): Uint8Array {
  const escaped: number[] = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      escaped.push(3);
      zeros = 0;
    }
    escaped.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(escaped);
}

function rbspBits(rbsp: Uint8Array): string {
  return Array.from(rbsp, (byte) => byte.toString(2).padStart(8, '0')).join('');
}

function bitsToRbsp(bits: string): Uint8Array {
  if (bits.length % 8 !== 0) throw new Error('RBSP bits must be byte aligned');
  const rbsp = new Uint8Array(bits.length / 8);
  for (let i = 0; i < rbsp.length; i++) rbsp[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return rbsp;
}

function patchMax12Constraint(nal: Uint8Array, ptlStart: number): Uint8Array {
  const bits = rbspBits(toRbsp(nal));
  // profile_space/tier/profile_idc, compatibility flags, then four source flags.
  const max12Flag = ptlStart + 8 + 32 + 4;
  if (bits[max12Flag] !== '1') throw new Error('expected max-12-bit constraint flag');
  const patched = bits.slice(0, max12Flag) + '0' + bits.slice(max12Flag + 1);
  return Uint8Array.from([...nal.subarray(0, 2), ...escapeRbsp(bitsToRbsp(patched))]);
}

function patchVpsMax12Constraint(nal: Uint8Array): Uint8Array {
  // The VPS header fields and reserved 0xffff occupy the first 32 RBSP bits.
  return patchMax12Constraint(nal, 32);
}

function patchSpsFor15Bit(nal: Uint8Array): Uint8Array {
  const rbsp = toRbsp(nal);
  const reader = new BitReader(rbsp);
  reader.readBits(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = reader.readBits(3);
  reader.readBit(); // sps_temporal_id_nesting_flag
  const ptlStart = reader.bitPosition;
  reader.readBits(2 + 1 + 5 + 32);
  reader.readBits(48); // general_constraint_indicator_flags
  reader.readBits(8); // general_level_idc
  const profilePresent: boolean[] = [];
  const levelPresent: boolean[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profilePresent.push(reader.readBit() === 1);
    levelPresent.push(reader.readBit() === 1);
  }
  if (maxSubLayersMinus1 > 0) reader.readBits((8 - maxSubLayersMinus1) * 2);
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (profilePresent[i]) reader.readBits(32 + 32 + 24);
    if (levelPresent[i]) reader.readBits(8);
  }
  reader.ue(); // sps_seq_parameter_set_id
  const chromaFormat = reader.ue();
  if (chromaFormat === 3) reader.readBit();
  reader.ue(); // pic_width_in_luma_samples
  reader.ue(); // pic_height_in_luma_samples
  if (reader.readBit()) {
    reader.ue();
    reader.ue();
    reader.ue();
    reader.ue();
  }

  const lumaStart = reader.bitPosition;
  const oldLuma = reader.ue();
  const lumaEnd = reader.bitPosition;
  const chromaStart = reader.bitPosition;
  const oldChroma = reader.ue();
  const chromaEnd = reader.bitPosition;
  if (oldLuma !== 4 || oldChroma !== 4)
    throw new Error('source SPS must signal 12-bit luma and chroma');

  let bits = rbspBits(rbsp);
  const max12Flag = ptlStart + 8 + 32 + 4;
  if (bits[max12Flag] !== '1') throw new Error('expected max-12-bit SPS constraint flag');
  bits = bits.slice(0, max12Flag) + '0' + bits.slice(max12Flag + 1);
  const stopBit = bits.lastIndexOf('1');
  if (stopBit < chromaEnd) throw new Error('SPS rbsp_trailing_bits are malformed');
  const body =
    bits.slice(0, lumaStart) +
    ueBits(7) +
    bits.slice(lumaEnd, chromaStart) +
    ueBits(7) +
    bits.slice(chromaEnd, stopBit);
  const padding = (8 - ((body.length + 1) % 8)) % 8;
  const patchedRbsp = bitsToRbsp(body + '1' + '0'.repeat(padding));
  return Uint8Array.from([...nal.subarray(0, 2), ...escapeRbsp(patchedRbsp)]);
}

function readLeSamples(bytes: Uint8Array): Uint16Array {
  if (bytes.byteLength % 2 !== 0) throw new Error('reference has a partial 16-bit sample');
  const samples = new Uint16Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < samples.length; i++) samples[i] = view.getUint16(i * 2, true);
  return samples;
}

function readY4mReference(
  path: URL,
  expectedChromaFormat: 1 | 2,
): { width: number; height: number; y: Uint16Array; cb: Uint16Array; cr: Uint16Array } {
  const bytes = Buffer.from(readFileSync(path));
  const headerEnd = bytes.indexOf(0x0a);
  expect(headerEnd).toBeGreaterThan(0);
  const header = bytes.subarray(0, headerEnd).toString('ascii').split(' ');
  expect(header[0]).toBe('YUV4MPEG2');
  const width = Number(header.find((field) => field.startsWith('W'))?.slice(1));
  const height = Number(header.find((field) => field.startsWith('H'))?.slice(1));
  expect(width).toBeGreaterThan(0);
  expect(height).toBeGreaterThan(0);
  expect(header).toContain(expectedChromaFormat === 2 ? 'C422p12' : 'C420p12');

  const frameHeaderEnd = bytes.indexOf(0x0a, headerEnd + 1);
  expect(frameHeaderEnd).toBeGreaterThan(headerEnd);
  expect(bytes.subarray(headerEnd + 1, frameHeaderEnd).toString('ascii')).toBe('FRAME');
  const samples = bytes.subarray(frameHeaderEnd + 1);
  const chromaWidth = width >> 1;
  const chromaHeight = expectedChromaFormat === 2 ? height : height >> 1;
  const planeSampleCounts = [width * height, chromaWidth * chromaHeight];
  const readPlane = (sampleCount: number, byteOffset: number): Uint16Array => {
    const plane = new Uint16Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) plane[i] = samples.readUInt16LE(byteOffset + i * 2);
    return plane;
  };
  const ySampleCount = planeSampleCounts[0]!;
  const chromaSampleCount = planeSampleCounts[1]!;
  expect(samples.length).toBe((ySampleCount + chromaSampleCount * 2) * 2);
  return {
    width,
    height,
    y: readPlane(ySampleCount, 0),
    cb: readPlane(chromaSampleCount, ySampleCount * 2),
    cr: readPlane(chromaSampleCount, (ySampleCount + chromaSampleCount) * 2),
  };
}

function expectQpBoundaryVector(
  qp: 74 | 75,
  chromaFormatIdc: 1 | 2,
  hevcSuffix: string,
  expectedHevcSha256: string,
  referenceSuffix: string,
  expectedReferenceSha256: string,
): void {
  const fixtureDirectory = new URL('./fixtures/regressions/hevc-qp422-boundary/', import.meta.url);
  const stream = new Uint8Array(
    readFileSync(new URL(`qp${qp}${hevcSuffix}.hevc`, fixtureDirectory)),
  );
  const referenceBytes = new Uint8Array(
    readFileSync(new URL(`qp${qp}${referenceSuffix}.y4m`, fixtureDirectory)),
  );
  expect(createHash('sha256').update(stream).digest('hex')).toBe(expectedHevcSha256);
  expect(createHash('sha256').update(referenceBytes).digest('hex')).toBe(expectedReferenceSha256);
  const reference = readY4mReference(
    new URL(`qp${qp}${referenceSuffix}.y4m`, fixtureDirectory),
    chromaFormatIdc,
  );

  const nals = splitAnnexB(stream);
  const decoded = decodeLayeredHevcPicture(nals, [0], 0);
  expect([decoded.width, decoded.height, decoded.chromaFormatIdc]).toEqual([
    reference.width,
    reference.height,
    chromaFormatIdc,
  ]);
  expect([decoded.bitDepthLuma, decoded.bitDepthChroma]).toEqual([12, 12]);
  expect(decoded.y).toEqual(reference.y);
  expect(decoded.cb).toEqual(reference.cb);
  expect(decoded.cr).toEqual(reference.cr);

  const heif = wrapHevcPredChain(
    [asAnnexB(nals.map((nal) => nal.data))],
    [[]],
    reference.width,
    reference.height,
    12,
    chromaFormatIdc,
  );
  expect(getFtypInfo(heif)?.majorBrand).toBe('heix');
  const boxes = parseISOBMFF(heif);
  const info = getHeicInfo(heif, boxes);
  const item = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
  expect([item.width, item.height, item.bitDepthLuma, item.bitDepthChroma]).toEqual([
    reference.width,
    reference.height,
    12,
    12,
  ]);
  expect(item.y).toEqual(reference.y);
  expect(item.cb).toEqual(reference.cb);
  expect(item.cr).toEqual(reference.cr);
  const rendered = decodeHeic(heif, { applyTransforms: false });
  expect([rendered.width, rendered.height, rendered.bitDepth, rendered.hasAlpha]).toEqual([
    reference.width,
    reference.height,
    12,
    false,
  ]);
  expect(rendered.data).toHaveLength(reference.width * reference.height * 4);
  for (let alpha = 3; alpha < rendered.data.length; alpha += 4)
    expect(rendered.data[alpha]).toBe(255);
}

it('decodes 12-bit 4:4:4 residuals at QP 74 and 75 through raw HEVC and HEIF', () => {
  const vectors = [
    {
      qp: 74,
      sha256: 'fe92b55f9fbc941b396a615a175ad6ebe95111b8cded2064a39e0c6583fa52fc',
      yuvMd5: 'dd156676d75cc4801291a3a4d52ab375',
    },
    {
      qp: 75,
      sha256: 'e899332464fcec03f84a54cbfda5fbb70001f7d846123000914d69a1dd89d3f7',
      yuvMd5: '28f5c39656c53f3dc6c147200e7223f2',
    },
  ];

  for (const { qp, sha256, yuvMd5 } of vectors) {
    const bytes = new Uint8Array(
      readFileSync(new URL(`./fixtures/conformance/hevc-12bit-444-qp${qp}.hevc`, import.meta.url)),
    );
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256);

    const nals = splitAnnexB(bytes);
    const decoded = decodeLayeredHevcPicture(nals, [0], 0);
    expect([decoded.width, decoded.height, decoded.chromaFormatIdc]).toEqual([128, 64, 3]);
    expect([decoded.bitDepthLuma, decoded.bitDepthChroma]).toEqual([12, 12]);
    expect(md5(planesBytes(decoded))).toBe(yuvMd5);

    const heif = wrapHevcPredChain([asAnnexB(nals.map((nal) => nal.data))], [[]], 128, 64, 12, 3);
    expect(getFtypInfo(heif)?.majorBrand).toBe('heix');
    const boxes = parseISOBMFF(heif);
    const info = getHeicInfo(heif, boxes);
    const item = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
    expect([item.width, item.height, item.bitDepthLuma, item.bitDepthChroma]).toEqual([
      128, 64, 12, 12,
    ]);
    expect(md5(planesBytes(item))).toBe(yuvMd5);
    const rendered = decodeHeic(heif, { applyTransforms: false });
    expect([rendered.width, rendered.height, rendered.bitDepth, rendered.hasAlpha]).toEqual([
      128,
      64,
      12,
      false,
    ]);
    expect(rendered.data).toHaveLength(128 * 64 * 4);
  }
}, 30_000);

it('decodes 12-bit 4:2:2 residuals at QP 74 and 75 against x265 reconstruction', () => {
  // For 12-bit 4:2:2, QpBdOffsetY/C is 24 and the zero-offset chroma mapping
  // keeps qPi 50/51, so Y, Cb, and Cr exercise qP′ 74/75.
  expectQpBoundaryVector(
    74,
    2,
    '',
    '333d81cdae7e968446fdadfdfa8747ef641bb87316509db0f48fad1f6218eba8',
    '',
    'e3c989492ca13184e162317b142df35ee0e6ea7285a9e05d7ba9e9d5199b9917',
  );
  expectQpBoundaryVector(
    75,
    2,
    '',
    '027241c69ce82f9531802ac9e228196af0a2dc725535e1f09af54bd761b253fb',
    '',
    'd630e075d22c00ef0697cdfe558e791ddbe972714bbf2d327f9a42a6f0a97fec',
  );
}, 30_000);

it('decodes 12-bit 4:2:0 residuals at QP 74 and 75 against x265 reconstruction', () => {
  // 4:2:0 still exercises luma qP′ 74/75; Table 8-10 maps chroma qPi 50/51
  // to 44/45 before adding the 24-point bit-depth offset (qP′ 68/69).
  expectQpBoundaryVector(
    74,
    1,
    '-420',
    '58a604ea7cde61c48998080060e568c13160c6333ca343e4b1f806c187806973',
    '-420',
    'd02b18429778dfce22a0ca1e53ef8dd45fc52af55f9933f33c8a650b94cb8757',
  );
  expectQpBoundaryVector(
    75,
    1,
    '-420',
    'e1eaafbcd07817b7cda56c1a6a82cf06bdf6747233145d4d25928dbccdbbc4c9',
    '-420',
    'acd14315d1a856cf82176eff4d3982f08fc9d92c3b651e81c0e66bf13a038fae',
  );
}, 30_000);

it('decodes 15-bit residuals at the maximum qP prime 92 and 93 against HM 19.0', () => {
  const vectors = [
    {
      qp: 74,
      sourceSha256: 'fe92b55f9fbc941b396a615a175ad6ebe95111b8cded2064a39e0c6583fa52fc',
      referenceSha256: '8e9cd75345ecbc962f69549c0b7cb35e1248230ec2c98926aa5e3b599885d8ad',
    },
    {
      qp: 75,
      sourceSha256: 'e899332464fcec03f84a54cbfda5fbb70001f7d846123000914d69a1dd89d3f7',
      referenceSha256: 'd3f1752b1ef794cee72d26042e88a929abae727c3244f9acd248c2829bf28802',
    },
  ];
  const fixtureDirectory = new URL('./fixtures/regressions/hevc-qp-max-15bit/', import.meta.url);

  for (const { qp, sourceSha256, referenceSha256 } of vectors) {
    const source = new Uint8Array(
      readFileSync(new URL(`./fixtures/conformance/hevc-12bit-444-qp${qp}.hevc`, import.meta.url)),
    );
    expect(createHash('sha256').update(source).digest('hex')).toBe(sourceSha256);
    const sourceNals = splitAnnexB(source);
    const patchedNals = sourceNals.map((nal) => {
      if (nal.type === 32) return patchVpsMax12Constraint(nal.data);
      if (nal.type === 33) return patchSpsFor15Bit(nal.data);
      return nal.data;
    });
    expect(patchedNals.some((nal) => ((nal[0]! >> 1) & 0x3f) === 32)).toBe(true);
    expect(patchedNals.some((nal) => ((nal[0]! >> 1) & 0x3f) === 33)).toBe(true);
    const rawHevc = asAnnexB(patchedNals);
    const expectedBytes = new Uint8Array(
      readFileSync(new URL(`qp${qp}-15bit-hm19.yuv`, fixtureDirectory)),
    );
    expect(createHash('sha256').update(expectedBytes).digest('hex')).toBe(referenceSha256);
    const expected = readLeSamples(expectedBytes);

    const decoded = decodeLayeredHevcPicture(splitAnnexB(rawHevc), [0], 0);
    expect([decoded.width, decoded.height, decoded.chromaFormatIdc]).toEqual([128, 64, 3]);
    expect([decoded.bitDepthLuma, decoded.bitDepthChroma]).toEqual([15, 15]);
    expect(readLeSamples(planesBytes(decoded))).toEqual(expected);

    const heif = wrapHevc(rawHevc, 128, 64, 15, 3, 15);
    expect(getFtypInfo(heif)?.majorBrand).toBe('heix');
    const boxes = parseISOBMFF(heif);
    const info = getHeicInfo(heif, boxes);
    const item = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
    expect([item.width, item.height, item.bitDepthLuma, item.bitDepthChroma]).toEqual([
      128, 64, 15, 15,
    ]);
    expect(readLeSamples(planesBytes(item))).toEqual(expected);
    const rendered = decodeHeic(heif, { applyTransforms: false });
    expect([rendered.width, rendered.height, rendered.bitDepth, rendered.hasAlpha]).toEqual([
      128,
      64,
      15,
      false,
    ]);
    expect(rendered.data).toHaveLength(128 * 64 * 4);
  }
}, 30_000);
