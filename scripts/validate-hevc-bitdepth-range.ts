import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getHeicInfo, getItemPayload } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { decodeHDRSync } from '../src/hdr';
import { BitReader, splitLengthPrefixed, toRbsp } from '../src/hevc/nal';
import { parseSps } from '../src/hevc/sps';
import { decodeHeic } from '../src/decoder';
import { decodeItemPlanes } from '../src/planes';
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

function patchSpsDepth(nal: Uint8Array, lumaDepth: number, chromaDepth: number): Uint8Array {
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

  const lumaStart = r.bitPosition;
  const oldLuma = r.ue();
  const lumaEnd = r.bitPosition;
  const chromaStart = r.bitPosition;
  const oldChroma = r.ue();
  const chromaEnd = r.bitPosition;
  assert(oldLuma === 4 && oldChroma === 4, 'official source must be 12-bit luma and chroma');

  const bits = Array.from(rbsp, (byte) => byte.toString(2).padStart(8, '0')).join('');
  const stopBit = bits.lastIndexOf('1');
  assert(stopBit >= chromaEnd, 'SPS rbsp_trailing_bits are malformed');
  const body =
    bits.slice(0, lumaStart) +
    ueBits(lumaDepth - 8) +
    bits.slice(lumaEnd, chromaStart) +
    ueBits(chromaDepth - 8) +
    bits.slice(chromaEnd, stopBit);
  const pad = (8 - ((body.length + 1) % 8)) % 8;
  const outputBits = body + '1' + '0'.repeat(pad);
  const outputRbsp = new Uint8Array(outputBits.length / 8);
  for (let i = 0; i < outputRbsp.length; i++)
    outputRbsp[i] = Number.parseInt(outputBits.slice(i * 8, i * 8 + 8), 2);
  return Uint8Array.from([...nal.subarray(0, 2), ...escapeRbsp(outputRbsp)]);
}

function sampleValues(bytes: Uint8Array): Uint16Array {
  assert(bytes.byteLength % 2 === 0, 'reference contains a partial 16-bit sample');
  const out = new Uint16Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < out.length; i++) out[i] = view.getUint16(i * 2, true);
  return out;
}

function hmOutputSamples(bytes: Uint8Array, bitDepth: number): Uint16Array {
  return bitDepth === 8 ? Uint16Array.from(bytes) : sampleValues(bytes);
}

function toAnnexB(nals: readonly Uint8Array[]): Buffer {
  return Buffer.concat(nals.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), Buffer.from(nal)]));
}

const decoder = process.env.HEVC_HM_DECODER;
assert(decoder, 'Set HEVC_HM_DECODER to the official HM TAppDecoder executable');

const source = new Uint8Array(
  readFileSync(resolve('test/fixtures/conformance/pcm-rext-444-12.heic')),
);
const boxes = parseISOBMFF(source);
const info = getHeicInfo(source, boxes);
assert(info.hvcC?.chromaFormatIdc === 3, 'official source must be 4:4:4');
assert(info.hvcC.bitDepthLumaMinus8 + 8 === 12, 'official source must be 12-bit');
const payload = getItemPayload(source, boxes, info.primaryItemId);
assert(payload, 'official source has no HEVC payload');
const sourceNals = splitLengthPrefixed(payload, info.hvcC.nalLengthSize);
const sourceElementaryStream = toAnnexB([
  ...info.hvcC.vps,
  ...info.hvcC.sps,
  ...info.hvcC.pps,
  ...sourceNals.filter((nal) => nal.type < 32).map((nal) => nal.data),
]);

const tempDirectory = mkdtempSync(join(tmpdir(), 'heic-bitdepth-'));
const sourceBitstreamPath = join(tempDirectory, 'source-12bit.hevc');
const sourceOutputPath = join(tempDirectory, 'source-12bit.yuv');
const officialReference = sampleValues(
  new Uint8Array(readFileSync(resolve('test/fixtures/conformance/pcm-rext-444-12.yuv'))),
);
const candidates = [
  { luma: 8, chroma: 8 },
  { luma: 9, chroma: 9 },
  { luma: 11, chroma: 11 },
  { luma: 13, chroma: 13 },
  { luma: 14, chroma: 14 },
  { luma: 15, chroma: 15 },
  { luma: 9, chroma: 15 },
  { luma: 15, chroma: 9 },
];
try {
  writeFileSync(sourceBitstreamPath, sourceElementaryStream);
  execFileSync(decoder, ['-b', sourceBitstreamPath, '-o', sourceOutputPath], { stdio: 'ignore' });
  const sourceHm = sampleValues(new Uint8Array(readFileSync(sourceOutputPath)));
  assert(
    sourceHm.length === officialReference.length,
    'HM source reference has an unexpected size',
  );
  let sourceMismatches = 0;
  for (let i = 0; i < sourceHm.length; i++)
    if (sourceHm[i] !== officialReference[i]) sourceMismatches++;
  assert(
    sourceMismatches === 0,
    `${sourceMismatches} source samples differ from the official reference`,
  );

  for (const candidate of candidates) {
    const patchedSps = patchSpsDepth(info.hvcC.sps[0], candidate.luma, candidate.chroma);
    const elementaryStream = toAnnexB([
      ...info.hvcC.vps,
      patchedSps,
      ...info.hvcC.pps,
      ...sourceNals.filter((nal) => nal.type < 32).map((nal) => nal.data),
    ]);
    const derived = wrapHevc(
      elementaryStream,
      info.width,
      info.height,
      candidate.luma,
      3,
      candidate.chroma,
    );
    const derivedBoxes = parseISOBMFF(derived);
    const derivedInfo = getHeicInfo(derived, derivedBoxes);
    assert(derivedInfo.hvcC, 'derived HEIF item has no hvcC');
    const sps = parseSps(derivedInfo.hvcC.sps[0]);
    assert(
      sps.bitDepthLuma === candidate.luma && sps.bitDepthChroma === candidate.chroma,
      'SPS patch disagrees with requested component depths',
    );

    const decoded = decodeItemPlanes(derived, derivedBoxes, derivedInfo, derivedInfo.primaryItemId);
    assert(
      candidate.luma === 8 ? decoded.y instanceof Uint8Array : decoded.y instanceof Uint16Array,
      'luma sample storage does not match component depth',
    );
    assert(
      candidate.chroma === 8
        ? decoded.cb instanceof Uint8Array && decoded.cr instanceof Uint8Array
        : decoded.cb instanceof Uint16Array && decoded.cr instanceof Uint16Array,
      'chroma sample storage does not match component depth',
    );
    const rgba = decodeHeic(derived);
    assert(
      rgba.bitDepth === candidate.luma &&
        rgba.bitDepthChroma ===
          (candidate.luma === candidate.chroma ? undefined : candidate.chroma),
      'RGBA result lost component bit-depth metadata',
    );
    const hdr = decodeHDRSync(derived);
    assert(
      hdr.bitDepth === candidate.luma &&
        hdr.bitDepthChroma === (candidate.luma === candidate.chroma ? undefined : candidate.chroma),
      'HDR result lost component bit-depth metadata',
    );

    const bitstreamPath = join(tempDirectory, `derived-${candidate.luma}-${candidate.chroma}.hevc`);
    const outputPath = join(tempDirectory, `derived-${candidate.luma}-${candidate.chroma}.yuv`);
    writeFileSync(bitstreamPath, elementaryStream);
    execFileSync(decoder, ['-b', bitstreamPath, '-o', outputPath], { stdio: 'ignore' });
    const reference = hmOutputSamples(
      new Uint8Array(readFileSync(outputPath)),
      Math.max(candidate.luma, candidate.chroma),
    );
    let mismatches = 0;
    let sampleIndex = 0;
    for (const plane of [decoded.y, decoded.cb, decoded.cr]) {
      for (const sample of plane) {
        if (sample !== reference[sampleIndex]) mismatches++;
        sampleIndex++;
      }
    }
    assert(sampleIndex === reference.length, 'HM reference has an unexpected sample count');
    assert(mismatches === 0, `${mismatches}/${sampleIndex} samples differ from HM`);
    console.log({
      bitDepthLuma: candidate.luma,
      bitDepthChroma: candidate.chroma,
      samples: sampleIndex,
      mismatches,
    });
  }

  console.log({
    source: 'ITU-T RExt IPCM_B_RExt_NEC official 12-bit 4:4:4 reference',
    dimensions: `${info.width}x${info.height}`,
    officialReferenceMismatches: sourceMismatches,
    derivedVectors: candidates.length,
  });
} finally {
  rmSync(tempDirectory, { recursive: true });
}
