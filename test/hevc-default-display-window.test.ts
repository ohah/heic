import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { decodeHeic } from '../src/decoder';
import { BitReader, isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal';
import { parsePps } from '../src/hevc/pps';
import { parseScalingListData } from '../src/hevc/scaling';
import { parseShortTermRefPicSet, parseSps, skipProfileTierLevel } from '../src/hevc/sps';
import { parseSliceHeader } from '../src/hevc/slice-header';
import { wrapHevc } from '../scripts/lib/heif';

const officialStream = new Uint8Array(
  readFileSync(new URL('./fixtures/conformance/confwin-a-sony-1.bit', import.meta.url)),
);

function bitAt(data: Uint8Array, index: number): number {
  return (data[index >> 3] >> (7 - (index & 7))) & 1;
}

function defaultDisplayWindowFlagPosition(nal: Uint8Array): number {
  const r = new BitReader(toRbsp(nal));
  r.readBits(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.readBits(3);
  if (maxSubLayersMinus1 > 6) throw new Error('unexpected multilayer SPS in CONFWIN_A');
  r.readBit(); // sps_temporal_id_nesting_flag
  skipProfileTierLevel(r, maxSubLayersMinus1);
  r.ue(); // sps_seq_parameter_set_id
  const chromaFormatIdc = r.ue();
  if (chromaFormatIdc === 3) r.readBit(); // separate_colour_plane_flag
  r.ue(); // pic_width_in_luma_samples
  r.ue(); // pic_height_in_luma_samples
  if (r.readBit()) for (let i = 0; i < 4; i++) r.ue(); // conformance window offsets
  r.ue(); // bit_depth_luma_minus8
  r.ue(); // bit_depth_chroma_minus8
  const log2MaxPicOrderCntLsb = r.ue() + 4;
  const orderingInfoPresent = r.readBit() === 1;
  for (let i = orderingInfoPresent ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
    r.ue();
    r.ue();
    r.ue();
  }
  for (let i = 0; i < 6; i++) r.ue(); // coding/transform block sizes and hierarchy depths
  if (r.readBit() && r.readBit()) parseScalingListData(r);
  r.readBit(); // amp_enabled_flag
  r.readBit(); // sample_adaptive_offset_enabled_flag
  if (r.readBit()) {
    r.readBits(8); // PCM sample bit depths
    r.ue(); // log2_min_pcm_luma_coding_block_size_minus3
    r.ue(); // log2_diff_max_min_pcm_luma_coding_block_size
    r.readBit(); // pcm_loop_filter_disabled_flag
  }
  const numShortTermRefPicSets = r.ue();
  const shortTermRefPicSets = [];
  for (let i = 0; i < numShortTermRefPicSets; i++)
    shortTermRefPicSets.push(
      parseShortTermRefPicSet(r, i, numShortTermRefPicSets, shortTermRefPicSets),
    );
  if (r.readBit()) {
    const count = r.ue();
    for (let i = 0; i < count; i++) {
      r.readBits(log2MaxPicOrderCntLsb);
      r.readBit();
    }
  }
  r.readBit(); // sps_temporal_mvp_enabled_flag
  r.readBit(); // strong_intra_smoothing_enabled_flag
  if (!r.readBit()) throw new Error('CONFWIN_A SPS has no VUI to extend');

  if (r.readBit()) {
    const aspectRatioIdc = r.readBits(8);
    if (aspectRatioIdc === 255) r.readBits(32);
  }
  if (r.readBit()) r.readBit(); // overscan_appropriate_flag
  if (r.readBit()) {
    r.readBits(3); // video_format
    r.readBit(); // video_full_range_flag
    if (r.readBit()) r.readBits(24); // colour description
  }
  if (r.readBit()) {
    r.ue(); // chroma_sample_loc_type_top_field
    r.ue(); // chroma_sample_loc_type_bottom_field
  }
  r.readBit(); // neutral_chroma_indication_flag
  r.readBit(); // field_seq_flag
  r.readBit(); // frame_field_info_present_flag
  return r.bitPosition;
}

function writeUnsignedExpGolomb(bits: number[], value: number): void {
  const codeNum = value + 1;
  const width = Math.floor(Math.log2(codeNum));
  for (let i = 0; i < width; i++) bits.push(0);
  for (let i = width; i >= 0; i--) bits.push((codeNum >> i) & 1);
}

function addDefaultDisplayWindow(
  nal: Uint8Array,
  offsets: readonly [number, number, number, number],
): Uint8Array {
  const rbsp = toRbsp(nal);
  let lastByte = rbsp.length - 1;
  while (lastByte >= 0 && rbsp[lastByte] === 0) lastByte--;
  if (lastByte < 0) throw new Error('CONFWIN_A SPS has no RBSP trailing bits');
  let trailingZeros = 0;
  while (((rbsp[lastByte] >> trailingZeros) & 1) === 0) trailingZeros++;
  const stopBitPosition = lastByte * 8 + 7 - trailingZeros;
  const flagPosition = defaultDisplayWindowFlagPosition(nal);
  if (flagPosition >= stopBitPosition || bitAt(rbsp, flagPosition) !== 0)
    throw new Error('CONFWIN_A SPS already has a default display window');

  const bits: number[] = [];
  for (let i = 0; i < stopBitPosition; i++) {
    bits.push(i === flagPosition ? 1 : bitAt(rbsp, i));
    if (i === flagPosition) for (const offset of offsets) writeUnsignedExpGolomb(bits, offset);
  }
  bits.push(1); // rbsp_stop_one_bit
  while (bits.length & 7) bits.push(0);
  const payload = new Uint8Array(bits.length >> 3);
  for (let i = 0; i < bits.length; i++) payload[i >> 3] |= bits[i] << (7 - (i & 7));

  const escaped: number[] = [];
  let zeroCount = 0;
  for (const byte of payload) {
    if (zeroCount >= 2 && byte <= 3) {
      escaped.push(3);
      zeroCount = 0;
    }
    escaped.push(byte);
    zeroCount = byte === 0 ? zeroCount + 1 : 0;
  }
  return Uint8Array.from([...nal.subarray(0, 2), ...escaped]);
}

function annexB(nals: readonly Uint8Array[]): Uint8Array {
  return Buffer.concat(nals.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), Buffer.from(nal)]));
}

function firstAccessUnit(nals: ReturnType<typeof splitAnnexB>): Uint8Array[] {
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official CONFWIN_A stream is missing parameter sets');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const slices: Uint8Array[] = [];
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic && slices.length > 0) break;
    slices.push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }
  if (slices.length === 0) throw new Error('official CONFWIN_A stream has no coded picture');
  return slices;
}

it('applies an opted-in VUI display window after the official conformance crop', () => {
  const nals = splitAnnexB(officialStream);
  const spsNal = nals.find((nal) => nal.type === 33);
  if (!spsNal) throw new Error('official CONFWIN_A stream is missing its SPS');
  const sourceSps = parseSps(spsNal.data);
  expect([sourceSps.width, sourceSps.height]).toEqual([412, 236]);
  expect(sourceSps.defaultDisplayWindow).toBeNull();

  const patchedSpsNal = addDefaultDisplayWindow(spsNal.data, [1, 1, 1, 1]);
  expect(parseSps(patchedSpsNal).defaultDisplayWindow).toEqual({
    left: 1,
    right: 1,
    top: 1,
    bottom: 1,
  });
  const parameters = nals.filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34);
  const pictures = firstAccessUnit(nals);
  const baseStream = annexB([...parameters.map((nal) => nal.data), ...pictures]);
  const patchedStream = annexB([
    ...parameters.map((nal) => (nal.type === 33 ? patchedSpsNal : nal.data)),
    ...pictures,
  ]);
  const baseInput = wrapHevc(
    baseStream,
    sourceSps.width,
    sourceSps.height,
    sourceSps.bitDepthLuma,
    sourceSps.chromaFormatIdc,
  );
  const patchedInput = wrapHevc(
    patchedStream,
    sourceSps.width,
    sourceSps.height,
    sourceSps.bitDepthLuma,
    sourceSps.chromaFormatIdc,
  );
  const base = decodeHeic(baseInput);
  expect(decodeHeic(patchedInput)).toEqual(base);

  const cropped = decodeHeic(patchedInput, { applyDefaultDisplayWindow: true });
  expect([cropped.width, cropped.height]).toEqual([408, 232]);
  const expected = new Uint8Array(cropped.data.length);
  for (let y = 0; y < cropped.height; y++) {
    const sourceStart = ((y + 2) * base.width + 2) * 4;
    expected.set(
      base.data.subarray(sourceStart, sourceStart + cropped.width * 4),
      y * cropped.width * 4,
    );
  }
  expect(cropped.data).toEqual(expected);
});
