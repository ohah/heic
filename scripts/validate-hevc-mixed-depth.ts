import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { BitReader, splitLengthPrefixed, toRbsp } from '../src/hevc/nal';
import { getHeicInfo, getItemPayload } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { decodeItemPlanes } from '../src/planes';
import { parseSps } from '../src/hevc/sps';
import { decodeHeic } from '../src/decoder';
import { decodeHDRSync } from '../src/hdr';
import { wrapHevc } from './lib/heif';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function skipProfileTierLevel(r: BitReader, maxSubLayersMinus1: number): void {
  r.readBits(2 + 1 + 5);
  r.readBits(32 + 32 + 16 + 8);
  const profilePresent: boolean[] = [];
  const levelPresent: boolean[] = [];
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    profilePresent.push(r.readBit() === 1);
    levelPresent.push(r.readBit() === 1);
  }
  if (maxSubLayersMinus1 > 0) r.readBits((8 - maxSubLayersMinus1) * 2);
  for (let i = 0; i < maxSubLayersMinus1; i++) {
    if (profilePresent[i]) r.readBits(32 + 32 + 24);
    if (levelPresent[i]) r.readBits(8);
  }
}

function ueBits(value: number): string {
  const binary = (value + 1).toString(2);
  return '0'.repeat(binary.length - 1) + binary;
}

function escapeRbsp(rbsp: Uint8Array): Uint8Array {
  const out: number[] = [];
  let zeros = 0;
  for (const byte of rbsp) {
    if (zeros >= 2 && byte <= 3) {
      out.push(3);
      zeros = 0;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Uint8Array.from(out);
}

function patchChromaDepth(nal: Uint8Array, chromaDepth: number): Uint8Array {
  const rbsp = toRbsp(nal);
  const r = new BitReader(rbsp);
  r.readBits(4);
  const maxSubLayersMinus1 = r.readBits(3);
  r.readBit();
  skipProfileTierLevel(r, maxSubLayersMinus1);
  r.ue(); // sps_seq_parameter_set_id
  const chromaFormat = r.ue();
  if (chromaFormat === 3) r.readBit();
  r.ue(); // pic_width_in_luma_samples
  r.ue(); // pic_height_in_luma_samples
  if (r.readBit()) {
    r.ue();
    r.ue();
    r.ue();
    r.ue();
  }
  r.ue(); // bit_depth_luma_minus8
  const fieldStart = r.bitPosition;
  const currentDepthMinus8 = r.ue();
  assert(currentDepthMinus8 === 2, 'official vector is not 10-bit chroma');
  const fieldEnd = r.bitPosition;
  const bits = Array.from(rbsp, (byte) => byte.toString(2).padStart(8, '0')).join('');
  const stopBit = bits.lastIndexOf('1');
  assert(stopBit >= fieldEnd, 'SPS rbsp_trailing_bits are malformed');
  const body = bits.slice(0, fieldStart) + ueBits(chromaDepth - 8) + bits.slice(fieldEnd, stopBit);
  const pad = (8 - ((body.length + 1) % 8)) % 8;
  const outputBits = body + '1' + '0'.repeat(pad);
  const outputRbsp = new Uint8Array(outputBits.length / 8);
  for (let i = 0; i < outputRbsp.length; i++)
    outputRbsp[i] = Number.parseInt(outputBits.slice(i * 8, i * 8 + 8), 2);
  const header = nal.subarray(0, 2);
  const escaped = escapeRbsp(outputRbsp);
  return Uint8Array.from([...header, ...escaped]);
}

function sampleValues(bytes: Uint8Array): Uint16Array {
  assert(bytes.byteLength % 2 === 0, 'reference contains a partial 16-bit sample');
  const out = new Uint16Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint16(i * 2, true);
  return out;
}

const sourceFixturePath = resolve('test/fixtures/conformance/pcm-rext-422-10.heic');
const source = new Uint8Array(readFileSync(sourceFixturePath));
const sourceBoxes = parseISOBMFF(source);
const sourceInfo = getHeicInfo(source, sourceBoxes);
assert(sourceInfo.hvcC, 'official source fixture has no hvcC');
const sourcePayload = getItemPayload(source, sourceBoxes, sourceInfo.primaryItemId);
assert(sourcePayload, 'official source fixture has no HEVC payload');
const sourceNals = splitLengthPrefixed(sourcePayload, sourceInfo.hvcC.nalLengthSize);
const sps = sourceInfo.hvcC.sps[0];
const mixedSps = patchChromaDepth(sps, 8);
const spsInfo = getHeicInfo(source, sourceBoxes).hvcC!;
const parameterSets = [
  ...spsInfo.vps,
  mixedSps,
  ...spsInfo.pps,
  ...sourceNals.filter((nal) => nal.type < 32).map((nal) => nal.data),
];
const annexB = Buffer.concat(
  parameterSets.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), Buffer.from(nal)]),
);
const mixed = wrapHevc(annexB, sourceInfo.width, sourceInfo.height, 10, 2, 8);
const boxes = parseISOBMFF(mixed);
const info = getHeicInfo(mixed, boxes);
assert(info.hvcC, 'mixed-depth item has no hvcC');
const spsParsed = parseSps(info.hvcC.sps[0]);
assert(
  spsParsed.bitDepthLuma === 10 && spsParsed.bitDepthChroma === 8,
  'SPS patch did not produce a 10-bit luma / 8-bit chroma vector',
);
const actual = decodeItemPlanes(mixed, boxes, info, info.primaryItemId);
assert(actual.y instanceof Uint16Array, 'luma plane should retain 10-bit storage');
assert(
  actual.cb instanceof Uint8Array && actual.cr instanceof Uint8Array,
  'chroma planes should use 8-bit storage',
);
const rgba = decodeHeic(mixed);
assert(
  rgba.bitDepth === 10 &&
    rgba.bitDepthChroma === 8 &&
    rgba.data.length === actual.width * actual.height * 4,
  'RGBA decode did not preserve the separate source depths',
);
const hdr = decodeHDRSync(mixed);
assert(
  hdr.bitDepth === 10 &&
    hdr.bitDepthChroma === 8 &&
    hdr.data.length === actual.width * actual.height * 4,
  'HDR decode did not preserve the separate source depths',
);

const lumaCount = actual.width * actual.height;
const chromaCount = Math.ceil(actual.width / 2) * actual.height;
const officialReference = sampleValues(
  new Uint8Array(readFileSync(resolve('test/fixtures/conformance/pcm-rext-422-10.yuv'))),
);
assert(
  officialReference.length === lumaCount + 2 * chromaCount,
  'unexpected official reference size',
);
const mismatchCount = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let count = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) count++;
  return count;
};

const decoder = process.env.HEVC_HM_DECODER;
assert(decoder, 'Set HEVC_HM_DECODER to the official HM TAppDecoder executable');
const sourceNalsForReference = [
  ...sourceInfo.hvcC.vps,
  ...sourceInfo.hvcC.sps,
  ...sourceInfo.hvcC.pps,
  ...sourceNals.filter((nal) => nal.type < 32).map((nal) => nal.data),
];
const sourceAnnexB = Buffer.concat(
  sourceNalsForReference.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), Buffer.from(nal)]),
);
const tempDirectory = mkdtempSync(join(tmpdir(), 'heic-mixed-depth-'));
const sourceBitstreamPath = join(tempDirectory, 'source.hevc');
const mixedPath = join(tempDirectory, 'mixed.hevc');
const sourceOutputPath = join(tempDirectory, 'source.yuv');
const mixedOutputPath = join(tempDirectory, 'mixed.yuv');
try {
  writeFileSync(sourceBitstreamPath, sourceAnnexB);
  writeFileSync(mixedPath, annexB);
  execFileSync(decoder, ['-b', sourceBitstreamPath, '-o', sourceOutputPath], { stdio: 'ignore' });
  execFileSync(decoder, ['-b', mixedPath, '-o', mixedOutputPath], { stdio: 'ignore' });
  const sourceHm = sampleValues(new Uint8Array(readFileSync(sourceOutputPath)));
  const mixedHm = sampleValues(new Uint8Array(readFileSync(mixedOutputPath)));
  assert(sourceHm.length === officialReference.length, 'unexpected HM source reference size');
  assert(mixedHm.length === officialReference.length, 'unexpected HM mixed-depth output size');
  const sourceReferenceMismatches = mismatchCount(sourceHm, officialReference);
  assert(
    sourceReferenceMismatches === 0,
    'HM source decode disagrees with the published YUV reference',
  );
  const expectedCb = mixedHm.subarray(lumaCount, lumaCount + chromaCount);
  const expectedCr = mixedHm.subarray(lumaCount + chromaCount);
  const lumaMismatches = mismatchCount(actual.y, mixedHm.subarray(0, lumaCount));
  const cbMismatches = mismatchCount(actual.cb, expectedCb);
  const crMismatches = mismatchCount(actual.cr, expectedCr);
  assert(
    lumaMismatches === 0 && cbMismatches === 0 && crMismatches === 0,
    'mixed-depth decode differs from the official HM reconstruction',
  );
  console.log({
    source: 'ITU-T RExt IPCM_A_RExt_NEC_2, derived with 10-bit luma and 8-bit chroma',
    dimensions: `${actual.width}x${actual.height}`,
    bitDepthLuma: spsParsed.bitDepthLuma,
    bitDepthChroma: spsParsed.bitDepthChroma,
    samples: { y: lumaCount, cb: chromaCount, cr: chromaCount },
    sourceReferenceMismatches,
    mixedDepthMismatches: { y: lumaMismatches, cb: cbMismatches, cr: crMismatches },
  });
} finally {
  rmSync(tempDirectory, { recursive: true });
}
