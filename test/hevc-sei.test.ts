import { expect, it } from 'bun:test';
import {
  applyOrientation,
  decode,
  decodeHDR,
  decodeHDRSync,
  decodeHeic,
  getHeicMetadata,
  parseHvcC,
} from '../src';
import { createRenderContext, decodeNative, transformRaster } from '../src/render';
import { getColorTransferFunction } from '../src/color-transfer';
import { parseHevcHdrSeiNals, parseHevcPictureTimingSeiNals } from '../src/hevc/sei';
import { applyHevcChromaResamplingFilterHint } from '../src/hevc/chroma-resampling';
import { applyHevcPostFilterHint } from '../src/hevc/post-filter';
import { applyHevcPhaseIndication } from '../src/hevc/phase-indication';
import { BitReader, toRbsp } from '../src/hevc/nal';
import { parseShortTermRefPicSet, skipProfileTierLevel } from '../src/hevc/sps';
import { parseScalingListData } from '../src/hevc/scaling';
import { compileHevcKneeFunction, mapHevcKneeFunction } from '../src/hevc/knee-function';
import { compileHevcToneMapping } from '../src/hevc/tone-mapping';
import { box, buildHeif, codedFixture } from './helpers/heif';

function writeExtendedValue(value: number): number[] {
  const bytes: number[] = [];
  while (value >= 255) {
    bytes.push(255);
    value -= 255;
  }
  bytes.push(value);
  return bytes;
}

function escapeRbsp(rbsp: Uint8Array): Buffer {
  const bytes: number[] = [];
  let zeroCount = 0;
  for (const byte of rbsp) {
    if (zeroCount >= 2 && byte <= 3) {
      bytes.push(3);
      zeroCount = 0;
    }
    bytes.push(byte);
    zeroCount = byte === 0 ? zeroCount + 1 : 0;
  }
  return Buffer.from(bytes);
}

function seiNal(nalType: 39 | 40, messages: { type: number; payload: Uint8Array }[]): Buffer {
  const rbsp = Buffer.concat([
    ...messages.map(({ type, payload }) =>
      Buffer.from([...writeExtendedValue(type), ...writeExtendedValue(payload.length), ...payload]),
    ),
    Buffer.from([0x80]),
  ]);
  return Buffer.concat([Buffer.from([nalType << 1, 1]), escapeRbsp(rbsp)]);
}

function lengthPrefixed(nal: Uint8Array, lengthSize: number): Buffer {
  const length = Buffer.alloc(lengthSize);
  for (let index = lengthSize - 1, remaining = nal.length; index >= 0; index--) {
    length[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.concat([length, Buffer.from(nal)]);
}

function hvcCProperty(item: ReturnType<typeof codedFixture>): Uint8Array {
  const property = item.properties.find(
    (candidate) => candidate.toString('ascii', 4, 8) === 'hvcC',
  );
  if (!property) throw new Error('fixture has no hvcC property');
  return property;
}

function hvcCWithSei(
  item: ReturnType<typeof codedFixture>,
  seiNals: Uint8Array | readonly Uint8Array[],
): Uint8Array {
  const property = hvcCProperty(item);
  const configuration = Buffer.from(property.subarray(8)),
    grouped = new Map<number, Uint8Array[]>();
  for (const nal of Array.isArray(seiNals) ? seiNals : [seiNals]) {
    const type = (nal[0] >> 1) & 0x3f,
      group = grouped.get(type) ?? [];
    group.push(nal);
    grouped.set(type, group);
  }
  const arrays = [...grouped].map(([type, nals]) =>
    Buffer.concat([
      Buffer.from([0x80 | type, nals.length >> 8, nals.length & 0xff]),
      ...nals.flatMap((nal) => [
        Buffer.from([nal.length >> 8, nal.length & 0xff]),
        Buffer.from(nal),
      ]),
    ]),
  );
  const updated = Buffer.concat([
    configuration.subarray(0, 22),
    Buffer.from([configuration[22] + arrays.length]),
    configuration.subarray(23),
    ...arrays,
  ]);
  return box('hvcC', updated);
}

function spsVuiFlagBitPosition(nal: Uint8Array): number {
  const reader = new BitReader(toRbsp(nal));
  reader.readBits(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = reader.readBits(3);
  reader.readBit(); // sps_temporal_id_nesting_flag
  skipProfileTierLevel(reader, maxSubLayersMinus1);
  reader.ue(); // sps_seq_parameter_set_id
  if (reader.ue() === 3) reader.readBit(); // chroma_format_idc / separate_colour_plane_flag
  reader.ue(); // pic_width_in_luma_samples
  reader.ue(); // pic_height_in_luma_samples
  if (reader.readBit()) for (let i = 0; i < 4; i++) reader.ue();
  reader.ue(); // bit_depth_luma_minus8
  reader.ue(); // bit_depth_chroma_minus8
  const log2MaxPicOrderCntLsb = reader.ue() + 4;
  const orderingInfoPresent = reader.readBit() === 1;
  for (let i = orderingInfoPresent ? 0 : maxSubLayersMinus1; i <= maxSubLayersMinus1; i++) {
    reader.ue();
    reader.ue();
    reader.ue();
  }
  for (let i = 0; i < 6; i++) reader.ue();
  if (reader.readBit() && reader.readBit()) parseScalingListData(reader);
  reader.readBit(); // amp_enabled_flag
  reader.readBit(); // sample_adaptive_offset_enabled_flag
  if (reader.readBit()) {
    reader.readBits(8); // PCM sample bit depths
    reader.ue();
    reader.ue();
    reader.readBit();
  }
  const setCount = reader.ue(),
    sets = [];
  for (let i = 0; i < setCount; i++) sets.push(parseShortTermRefPicSet(reader, i, setCount, sets));
  if (reader.readBit()) {
    const longTermCount = reader.ue();
    if (longTermCount > 32) throw new Error('unexpected long-term SPS reference count');
    for (let index = 0; index < longTermCount; index++) {
      reader.readBits(log2MaxPicOrderCntLsb);
      reader.readBit();
    }
  }
  reader.readBit(); // sps_temporal_mvp_enabled_flag
  reader.readBit(); // strong_intra_smoothing_enabled_flag
  return reader.bitPosition;
}

function addFieldSequenceVui(nal: Uint8Array): Buffer {
  const rbsp = toRbsp(nal),
    flagPosition = spsVuiFlagBitPosition(nal),
    bits: number[] = [];
  const readBit = (position: number) => (rbsp[position >> 3] >> (7 - (position & 7))) & 1;
  if (readBit(flagPosition) !== 0) throw new Error('fixture SPS already has VUI parameters');
  for (let position = 0; position < rbsp.length * 8; position++) {
    if (position === flagPosition) {
      bits.push(1); // vui_parameters_present_flag
      bits.push(0, 0, 0, 0, 0, 1, 1, 0, 0, 0);
      // No aspect ratio, overscan, colour signal, or chroma location;
      // field sequence with picture structure; no display window, timing, or restrictions.
    } else bits.push(readBit(position));
  }
  const patchedRbsp = Buffer.alloc(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => {
    patchedRbsp[index >> 3] |= bit << (7 - (index & 7));
  });
  return Buffer.concat([Buffer.from(nal.subarray(0, 2)), escapeRbsp(patchedRbsp)]);
}

function hvcCWithFieldSequenceSpsAndSei(
  item: ReturnType<typeof codedFixture>,
  patchedSps: Uint8Array,
  seiNals: readonly Uint8Array[],
): Uint8Array {
  const configuration = Buffer.from(hvcCProperty(item).subarray(8)),
    arrays: Buffer[] = [];
  let offset = 23,
    foundSps = false;
  for (let array = 0; array < configuration[22]; array++) {
    const header = configuration[offset++],
      count = configuration.readUInt16BE(offset);
    offset += 2;
    const nals: Uint8Array[] = [];
    for (let index = 0; index < count; index++) {
      const length = configuration.readUInt16BE(offset);
      offset += 2;
      const nal = configuration.subarray(offset, offset + length);
      offset += length;
      if (((nal[0] >> 1) & 0x3f) === 33 && !foundSps) {
        nals.push(patchedSps);
        foundSps = true;
      } else nals.push(nal);
    }
    arrays.push(
      Buffer.concat([
        Buffer.from([header, count >> 8, count & 0xff]),
        ...nals.flatMap((nal) => [
          Buffer.from([nal.length >> 8, nal.length & 0xff]),
          Buffer.from(nal),
        ]),
      ]),
    );
  }
  if (!foundSps) throw new Error('fixture hvcC has no SPS array');
  const seiTypes = new Map<number, Uint8Array[]>();
  for (const nal of seiNals) {
    const type = (nal[0] >> 1) & 0x3f,
      group = seiTypes.get(type) ?? [];
    group.push(nal);
    seiTypes.set(type, group);
  }
  for (const [type, nals] of seiTypes)
    arrays.push(
      Buffer.concat([
        Buffer.from([0x80 | type, nals.length >> 8, nals.length & 0xff]),
        ...nals.flatMap((nal) => [
          Buffer.from([nal.length >> 8, nal.length & 0xff]),
          Buffer.from(nal),
        ]),
      ]),
    );
  const header = Buffer.from(configuration.subarray(0, 23));
  header[22] = arrays.length;
  return box('hvcC', Buffer.concat([header, ...arrays]));
}

function masteringDisplayPayload(): Buffer {
  const values = [
    13_250,
    34_500, // primary 0
    7_500,
    3_000, // primary 1
    34_000,
    16_000, // primary 2
    15_635,
    16_450, // white point
  ];
  const coordinates = Buffer.alloc(values.length * 2);
  values.forEach((value, index) => coordinates.writeUInt16BE(value, index * 2));
  const luminance = Buffer.alloc(8);
  luminance.writeUInt32BE(10_000_000, 0);
  luminance.writeUInt32BE(50, 4);
  return Buffer.concat([coordinates, luminance]);
}

function contentLightPayload(): Buffer {
  const payload = Buffer.alloc(4);
  payload.writeUInt16BE(1_000, 0);
  payload.writeUInt16BE(400, 2);
  return payload;
}

function contentColourPayload(): Buffer {
  const bits: number[] = [];
  const append = (value: number, width: number) => {
    const unsigned = value >>> 0;
    for (let bit = width - 1; bit >= 0; bit--) bits.push((unsigned >>> bit) & 1);
  };
  append(0, 1); // ccv_cancel_flag
  append(1, 1); // ccv_persistence_flag
  append(1, 1); // ccv_primaries_present_flag
  append(1, 1); // ccv_min_luminance_value_present_flag
  append(1, 1); // ccv_max_luminance_value_present_flag
  append(1, 1); // ccv_avg_luminance_value_present_flag
  append(0, 2); // ccv_reserved_zero_2bits
  for (const value of [-100, 20_000, 150, 30_000, 20_000, 10_000]) append(value, 32);
  append(500, 32);
  append(10_000_000, 32);
  append(2_000_000, 32);
  append(1, 1); // payload_bit_equal_to_one
  while (bits.length % 8) append(0, 1);
  const payload = Buffer.alloc(bits.length / 8);
  bits.forEach((bit, index) => {
    payload[index >> 3] |= bit << (7 - (index & 7));
  });
  return payload;
}

function ambientViewingPayload(): Buffer {
  const payload = Buffer.alloc(8);
  payload.writeUInt32BE(100_000, 0);
  payload.writeUInt16BE(15_635, 4);
  payload.writeUInt16BE(16_450, 6);
  return payload;
}

function displayOrientationPayload(
  transformType: number,
  persistence = false,
  reservedZeroBits = 0,
): Buffer {
  return Buffer.from([(persistence ? 0x40 : 0) | (transformType << 3) | reservedZeroBits]);
}

function filmGrainPayload(pictureWidth = 64, pictureHeight = 32): Buffer {
  const bits: number[] = [];
  const append = (value: number, bitCount: number) => {
    for (let bit = bitCount - 1; bit >= 0; bit--) bits.push((value >>> bit) & 1);
  };
  const appendUe = (value: number) => {
    const code = value + 1,
      codeWidth = Math.floor(Math.log2(code)) + 1;
    append(0, codeWidth - 1);
    append(code, codeWidth);
  };
  const appendSe = (value: number) => appendUe(value > 0 ? value * 2 - 1 : -value * 2);
  const finish = () => {
    append(1, 1); // payload_bit_equal_to_one
    while (bits.length % 8) append(0, 1);
    const payload = Buffer.alloc(bits.length / 8);
    bits.forEach((bit, index) => {
      payload[index >> 3] |= bit << (7 - (index & 7));
    });
    return payload;
  };

  append(0, 1); // fg_characteristics_cancel_flag
  append(1, 2); // fg_model_id: auto-regression
  append(1, 1); // fg_separate_colour_description_present_flag
  append(2, 3); // fg_bit_depth_luma_minus8
  append(1, 3); // fg_bit_depth_chroma_minus8
  append(1, 1); // fg_full_range_flag
  append(9, 8); // fg_colour_primaries
  append(16, 8); // fg_transfer_characteristics
  append(9, 8); // fg_matrix_coeffs
  append(1, 2); // fg_blending_mode_id
  append(6, 4); // fg_log2_scale_factor
  append(1, 1); // luma model present
  append(0, 1); // Cb model absent
  append(1, 1); // Cr model present
  append(1, 8); // luma: two intensity intervals
  append(2, 3); // luma: three model values per interval
  append(0, 8);
  append(99, 8);
  appendSe(-3);
  appendSe(0);
  appendSe(5);
  append(100, 8);
  append(255, 8);
  appendSe(7);
  appendSe(-8);
  appendSe(1);
  append(0, 8); // Cr: one intensity interval
  append(0, 3); // Cr: one model value
  append(0, 8);
  append(255, 8);
  appendSe(-2);
  append(1, 1); // fg_characteristics_persistence_flag
  append(1, 1); // fg_spatial_resolution_present_flag (H.274 V4)
  appendUe(pictureWidth);
  appendUe(pictureHeight);
  return finish();
}

function filmGrainInvalidModelCountPayload(): Buffer {
  const bits: number[] = [];
  const append = (value: number, width: number) => {
    for (let bit = width - 1; bit >= 0; bit--) bits.push((value >>> bit) & 1);
  };
  append(0, 1); // not canceled
  append(0, 2); // frequency filtering
  append(0, 1); // use sequence colour description
  append(0, 2); // blending mode
  append(0, 4); // scale factor
  append(1, 1); // Y model present
  append(0, 1); // Cb absent
  append(0, 1); // Cr absent
  append(0, 8); // one intensity interval
  append(6, 3); // reserved: num_model_values_minus1 exceeds 5
  append(1, 1);
  while (bits.length % 8) append(0, 1);
  const payload = Buffer.alloc(bits.length / 8);
  bits.forEach((bit, index) => {
    payload[index >> 3] |= bit << (7 - (index & 7));
  });
  return payload;
}

function toneMappingPayload(
  modelId: number,
  options: {
    id?: number;
    codedDataBitDepth?: number;
    targetBitDepth?: number;
    minValue?: number;
    maxValue?: number;
    cameraIsoSpeedIdc?: number;
    cameraIsoSpeedValue?: number;
    exposureIndexIdc?: number;
    exposureIndexValue?: number;
  } = {},
): Buffer {
  const bits: number[] = [],
    codedDataBitDepth = options.codedDataBitDepth ?? 10,
    targetBitDepth = options.targetBitDepth ?? 3;
  const append = (value: number, bitCount: number) => {
    for (let bit = bitCount - 1; bit >= 0; bit--) bits.push((value >>> bit) & 1);
  };
  const appendUe = (value: number) => {
    const code = value + 1,
      codeWidth = Math.floor(Math.log2(code)) + 1;
    append(0, codeWidth - 1);
    append(code, codeWidth);
  };
  const finish = () => {
    append(1, 1); // payload_bit_equal_to_one
    while (bits.length % 8) append(0, 1);
    const payload = Buffer.alloc(bits.length / 8);
    bits.forEach((bit, index) => {
      payload[index >> 3] |= bit << (7 - (index & 7));
    });
    return payload;
  };

  appendUe(options.id ?? 7); // tone_map_id
  append(0, 1); // tone_map_cancel_flag
  append(1, 1); // tone_map_persistence_flag
  append(codedDataBitDepth, 8);
  append(targetBitDepth, 8);
  appendUe(modelId);
  if (modelId === 0) {
    append(options.minValue ?? 10, 32);
    append(options.maxValue ?? 1000, 32);
  } else if (modelId === 1) {
    append(50, 32);
    append(20, 32);
  } else if (modelId === 2) {
    const codeWidth = ((codedDataBitDepth + 7) >> 3) << 3;
    for (let index = 0; index < 1 << targetBitDepth; index++) append(index * 10, codeWidth);
  } else if (modelId === 3) {
    const codedWidth = ((codedDataBitDepth + 7) >> 3) << 3,
      targetWidth = ((targetBitDepth + 7) >> 3) << 3;
    append(2, 16); // num_pivots
    append(1, codedWidth);
    append(2, targetWidth);
    append(100, codedWidth);
    append(150, targetWidth);
  } else if (modelId === 4) {
    const cameraIsoSpeedIdc = options.cameraIsoSpeedIdc ?? 255,
      exposureIndexIdc = options.exposureIndexIdc ?? 255;
    append(cameraIsoSpeedIdc, 8);
    if (cameraIsoSpeedIdc === 255) append(options.cameraIsoSpeedValue ?? 400, 32);
    append(exposureIndexIdc, 8);
    if (exposureIndexIdc === 255) append(options.exposureIndexValue ?? 200, 32);
    append(1, 1); // exposure compensation sign
    append(3, 16);
    append(2, 16);
    append(1000, 32);
    append(2000, 32);
    append(64, 16);
    append(940, 16);
    append(1023, 16);
  }
  return finish();
}

function toneMappingCancellationPayload(id = 7): Buffer {
  const bits: number[] = [];
  const append = (value: number, width: number) => {
    for (let bit = width - 1; bit >= 0; bit--) bits.push(Math.floor(value / 2 ** bit) % 2);
  };
  const code = id + 1,
    width = Math.floor(Math.log2(code)) + 1;
  append(0, width - 1);
  append(code, width);
  append(1, 1); // tone_map_cancel_flag
  append(1, 1); // payload_bit_equal_to_one
  while (bits.length % 8) append(0, 1);
  const payload = Buffer.alloc(bits.length / 8);
  bits.forEach((bit, index) => {
    payload[index >> 3] |= bit << (7 - (index & 7));
  });
  return payload;
}

function kneeFunctionPayload(
  options: {
    id?: number;
    cancelled?: boolean;
    pointCountMinus1?: number;
    points?: readonly (readonly [number, number])[];
  } = {},
): Buffer {
  const bits: number[] = [];
  const append = (value: number, bitCount: number) => {
    for (let bit = bitCount - 1; bit >= 0; bit--) bits.push((value >>> bit) & 1);
  };
  const appendUe = (value: number) => {
    const code = value + 1,
      codeWidth = Math.floor(Math.log2(code)) + 1;
    append(0, codeWidth - 1);
    append(code, codeWidth);
  };
  const finish = () => {
    append(1, 1); // payload_bit_equal_to_one
    while (bits.length % 8) append(0, 1);
    const payload = Buffer.alloc(bits.length / 8);
    bits.forEach((bit, index) => {
      payload[index >> 3] |= bit << (7 - (index & 7));
    });
    return payload;
  };

  appendUe(options.id ?? 3); // knee_function_id
  append(options.cancelled ? 1 : 0, 1);
  if (!options.cancelled) {
    const points = options.points ?? [
      [128, 96],
      [512, 400],
      [896, 700],
    ];
    append(1, 1); // knee_function_persistence_flag
    append(10_000, 32); // input_d_range
    append(203, 32); // input_disp_luminance
    append(4_000, 32); // output_d_range
    append(100, 32); // output_disp_luminance
    appendUe(options.pointCountMinus1 ?? points.length - 1);
    for (const [input, output] of points) {
      append(input, 10);
      append(output, 10);
    }
  }
  return finish();
}

function colourRemappingPayload(
  options: {
    id?: number;
    cancelled?: boolean;
    persistence?: boolean;
    videoSignalInfo?: {
      fullRange: boolean;
      primaries: number;
      transferFunction: number;
      matrixCoefficients: number;
    };
    inputBitDepth?: number;
    outputBitDepth?: number;
    preLuts?: readonly { numValMinus1: number; points: readonly (readonly [number, number])[] }[];
    matrix?: { log2Denom: number; coefficients: readonly (readonly number[])[] };
    postLuts?: readonly { numValMinus1: number; points: readonly (readonly [number, number])[] }[];
  } = {},
): Buffer {
  const bits: number[] = [];
  const append = (value: number, width: number) => {
    for (let bit = width - 1; bit >= 0; bit--) bits.push(Math.floor(value / 2 ** bit) % 2);
  };
  const appendUe = (value: number) => {
    const code = value + 1,
      width = Math.floor(Math.log2(code)) + 1;
    append(0, width - 1);
    append(code, width);
  };
  const appendSe = (value: number) => appendUe(value > 0 ? value * 2 - 1 : -value * 2);
  const finish = () => {
    append(1, 1); // payload_bit_equal_to_one
    while (bits.length % 8) append(0, 1);
    const payload = Buffer.alloc(bits.length / 8);
    bits.forEach((bit, index) => {
      payload[index >> 3] |= bit << (7 - (index & 7));
    });
    return payload;
  };

  appendUe(options.id ?? 42);
  append(options.cancelled ? 1 : 0, 1);
  if (options.cancelled) return finish();

  append(options.persistence === false ? 0 : 1, 1);
  append(options.videoSignalInfo ? 1 : 0, 1);
  if (options.videoSignalInfo) {
    append(options.videoSignalInfo.fullRange ? 1 : 0, 1);
    append(options.videoSignalInfo.primaries, 8);
    append(options.videoSignalInfo.transferFunction, 8);
    append(options.videoSignalInfo.matrixCoefficients, 8);
  }
  const inputBitDepth = options.inputBitDepth ?? 10,
    outputBitDepth = options.outputBitDepth ?? 12,
    emptyLut = { numValMinus1: 0, points: [] } as const,
    preLuts = options.preLuts ?? [emptyLut, emptyLut, emptyLut],
    postLuts = options.postLuts ?? [emptyLut, emptyLut, emptyLut];
  append(inputBitDepth, 8);
  append(outputBitDepth, 8);
  const appendLuts = (
    luts: readonly { numValMinus1: number; points: readonly (readonly [number, number])[] }[],
    codedDepth: number,
    targetDepth: number,
  ) => {
    const codedWidth = ((codedDepth + 7) >> 3) << 3,
      targetWidth = ((targetDepth + 7) >> 3) << 3;
    for (const lut of luts) {
      append(lut.numValMinus1, 8);
      for (const [coded, target] of lut.points) {
        append(coded, codedWidth);
        append(target, targetWidth);
      }
    }
  };
  appendLuts(preLuts, inputBitDepth, outputBitDepth);
  append(options.matrix ? 1 : 0, 1);
  if (options.matrix) {
    append(options.matrix.log2Denom, 4);
    for (const row of options.matrix.coefficients)
      for (const coefficient of row) appendSe(coefficient);
  }
  appendLuts(postLuts, outputBitDepth, outputBitDepth);
  return finish();
}

function chromaResamplingFilterPayload(
  options: {
    verticalFilterIdc?: number;
    horizontalFilterIdc?: number;
    fieldProcessing?: boolean;
    targetFormatIdc?: number;
    verticalFilters?: readonly {
      tapLengthMinus1: number;
      coefficients: readonly number[];
    }[];
    horizontalFilters?: readonly {
      tapLengthMinus1: number;
      coefficients: readonly number[];
    }[];
  } = {},
): Buffer {
  const bits: number[] = [];
  const append = (value: number, width: number) => {
    for (let bit = width - 1; bit >= 0; bit--) bits.push(Math.floor(value / 2 ** bit) % 2);
  };
  const appendUe = (value: number) => {
    const code = value + 1,
      width = Math.floor(Math.log2(code)) + 1;
    append(0, width - 1);
    append(code, width);
  };
  const appendSe = (value: number) => appendUe(value > 0 ? value * 2 - 1 : -value * 2);
  const appendFilters = (
    filters: readonly { tapLengthMinus1: number; coefficients: readonly number[] }[] | undefined,
  ) => {
    if (!filters) return;
    appendUe(filters.length);
    for (const filter of filters) {
      appendUe(filter.tapLengthMinus1);
      filter.coefficients.forEach(appendSe);
    }
  };

  const verticalFilterIdc = options.verticalFilterIdc ?? 1,
    horizontalFilterIdc = options.horizontalFilterIdc ?? 0;
  append(verticalFilterIdc, 8);
  append(horizontalFilterIdc, 8);
  append(options.fieldProcessing ? 1 : 0, 1);
  if (verticalFilterIdc === 1 || horizontalFilterIdc === 1) appendUe(options.targetFormatIdc ?? 1);
  if (verticalFilterIdc === 1) appendFilters(options.verticalFilters ?? []);
  if (horizontalFilterIdc === 1) appendFilters(options.horizontalFilters ?? []);
  append(1, 1); // payload_bit_equal_to_one
  while (bits.length % 8) append(0, 1);
  const payload = Buffer.alloc(bits.length / 8);
  bits.forEach((bit, index) => {
    payload[index >> 3] |= bit << (7 - (index & 7));
  });
  return payload;
}

function postFilterHintPayload(
  sizeY: number,
  sizeX: number,
  type: number,
  components: readonly (readonly (readonly number[])[])[],
): Buffer {
  const bits: number[] = [];
  const append = (value: number, width: number) => {
    for (let bit = width - 1; bit >= 0; bit--) bits.push(Math.floor(value / 2 ** bit) % 2);
  };
  const appendUe = (value: number) => {
    const code = value + 1,
      width = Math.floor(Math.log2(code)) + 1;
    append(0, width - 1);
    append(code, width);
  };
  const appendSe = (value: number) => appendUe(value > 0 ? value * 2 - 1 : -value * 2);
  appendUe(sizeY);
  appendUe(sizeX);
  append(type, 2);
  for (const component of components) for (const row of component) row.forEach(appendSe);
  append(1, 1); // payload_bit_equal_to_one
  while (bits.length % 8) append(0, 1);
  const payload = Buffer.alloc(bits.length / 8);
  bits.forEach((bit, index) => {
    payload[index >> 3] |= bit << (7 - (index & 7));
  });
  return payload;
}

it('parses HDR static-metadata SEI from hvcC and image-item NAL units', () => {
  const source = codedFixture(12, 'pcm-rext-444');
  const configuration = parseHvcC(hvcCProperty(source).subarray(8));
  const prefix = seiNal(39, [
    { type: 147, payload: Buffer.from([16]) },
    { type: 148, payload: ambientViewingPayload() },
    { type: 149, payload: contentColourPayload() },
    { type: 47, payload: displayOrientationPayload(4, true) },
  ]);
  const suffix = seiNal(40, [
    { type: 137, payload: masteringDisplayPayload() },
    { type: 144, payload: contentLightPayload() },
  ]);
  const item = {
    ...source,
    data: Buffer.concat([
      Buffer.from(source.data),
      lengthPrefixed(suffix, configuration.nalLengthSize),
    ]),
    properties: source.properties.map((property) =>
      property.toString('ascii', 4, 8) === 'hvcC' ? hvcCWithSei(source, [prefix]) : property,
    ),
  };
  const baseline = buildHeif([source], source.id);
  const input = buildHeif([item], source.id);

  expect(parseHvcC(hvcCWithSei(source, [prefix]).subarray(8)).seiNals).toHaveLength(1);
  expect(getHeicMetadata(input).hevcHdrSei).toEqual({
    masteringDisplayColourVolume: {
      displayPrimaries: [
        { x: 13_250, y: 34_500 },
        { x: 7_500, y: 3_000 },
        { x: 34_000, y: 16_000 },
      ],
      whitePoint: { x: 15_635, y: 16_450 },
      maxDisplayMasteringLuminance: 10_000_000,
      minDisplayMasteringLuminance: 50,
    },
    contentLightLevelInfo: {
      maxContentLightLevel: 1_000,
      maxPicAverageLightLevel: 400,
    },
    alternativeTransferCharacteristics: { preferredTransferCharacteristics: 16 },
    ambientViewingEnvironment: {
      ambientIlluminance: 100_000,
      ambientLightX: 15_635,
      ambientLightY: 16_450,
    },
    contentColourVolume: {
      persistence: true,
      primaries: [
        { x: -100, y: 20_000 },
        { x: 150, y: 30_000 },
        { x: 20_000, y: 10_000 },
      ],
      minLuminanceValue: 500,
      maxLuminanceValue: 10_000_000,
      averageLuminanceValue: 2_000_000,
    },
  });
  expect(getHeicMetadata(input).hevcDisplayOrientation).toEqual([
    { cancelled: false, persistence: true, transformType: 4 },
  ]);
  const baselineImage = decodeHeic(baseline),
    expectedOrientation = applyOrientation(
      baselineImage.data,
      baselineImage.width,
      baselineImage.height,
      1,
      0,
    ),
    orientedImage = decodeHeic(input);
  expect(orientedImage.width).toBe(expectedOrientation.width);
  expect(orientedImage.height).toBe(expectedOrientation.height);
  expect(orientedImage.data).toEqual(expectedOrientation.data);
  expect(decodeHeic(input, { applyHevcDisplayOrientation: false }).data).toEqual(
    baselineImage.data,
  );
  expect(decodeHeic(input, { applyTransforms: false }).data).toEqual(expectedOrientation.data);

  const nclx = Buffer.alloc(11);
  nclx.write('nclx', 0, 'ascii');
  nclx.writeUInt16BE(2, 4);
  nclx.writeUInt16BE(16, 6);
  nclx.writeUInt16BE(6, 8);
  nclx[10] = 0;
  const equivalentTransfer = buildHeif(
    [{ ...source, properties: [...source.properties, box('colr', nclx)] }],
    source.id,
  );
  const actualHdr = decodeHDRSync(input, { applyHevcDisplayOrientation: false }).data,
    equivalentHdr = decodeHDRSync(equivalentTransfer).data;
  expect(actualHdr.every((value, index) => value === equivalentHdr[index])).toBe(true);
});

it('exposes and optionally applies H.274 phase indication through SDR and HDR decode', async () => {
  const source = codedFixture(12, 'pcm-rext-444');
  const phase = Buffer.from([1, 3, 1, 1]);
  const input = buildHeif(
    [
      {
        ...source,
        properties: source.properties.map((property) =>
          property.toString('ascii', 4, 8) === 'hvcC'
            ? hvcCWithSei(source, seiNal(39, [{ type: 212, payload: phase }]))
            : property,
        ),
      },
    ],
    source.id,
  );

  expect(parseHevcHdrSeiNals([seiNal(39, [{ type: 212, payload: phase }])])).toEqual({
    phaseIndication: [
      {
        horizontalPhaseNum: 1,
        horizontalPhaseDenMinus1: 3,
        verticalPhaseNum: 1,
        verticalPhaseDenMinus1: 1,
      },
    ],
  });
  expect(getHeicMetadata(input).hevcPhaseIndication).toEqual([
    {
      horizontalPhaseNum: 1,
      horizontalPhaseDenMinus1: 3,
      verticalPhaseNum: 1,
      verticalPhaseDenMinus1: 1,
    },
  ]);
  expect(decodeHeic(input).data).toEqual(decodeHeic(buildHeif([source], source.id)).data);
  const aligned = decodeHeic(input, { applyHevcPhaseIndication: true });
  expect(aligned.data).not.toEqual(decodeHeic(input).data);
  expect((await decode(input, { execution: 'main', applyHevcPhaseIndication: true })).data).toEqual(
    aligned.data,
  );
  const alignedHdr = decodeHDRSync(input, { applyHevcPhaseIndication: true });
  expect(alignedHdr.data).not.toEqual(decodeHDRSync(input).data);
  expect(
    (await decodeHDR(input, { execution: 'main', applyHevcPhaseIndication: true })).data,
  ).toEqual(alignedHdr.data);
  expect(() =>
    parseHevcHdrSeiNals([seiNal(39, [{ type: 212, payload: Buffer.from([2, 0, 0, 0]) }])]),
  ).toThrow('invalid horizontal phase_indication ratio');
  expect(() =>
    parseHevcHdrSeiNals([seiNal(39, [{ type: 212, payload: Buffer.from([0, 0, 2, 0]) }])]),
  ).toThrow('invalid vertical phase_indication ratio');
  expect(() =>
    parseHevcHdrSeiNals([seiNal(39, [{ type: 212, payload: Buffer.from([0, 0, 0]) }])]),
  ).toThrow('invalid phase_indication SEI payload size');
});

it('aligns RGBA samples to H.274 phase ratios with bilinear interpolation and edge replication', () => {
  const horizontal = Uint16Array.from([0, 10, 20, 30, 10, 20, 30, 40, 20, 30, 40, 50]);
  applyHevcPhaseIndication(horizontal, 3, 1, {
    horizontalPhaseNum: 0,
    horizontalPhaseDenMinus1: 0,
    verticalPhaseNum: 1,
    verticalPhaseDenMinus1: 1,
  });
  expect(horizontal).toEqual(Uint16Array.from([5, 15, 25, 35, 15, 25, 35, 45, 20, 30, 40, 50]));

  const vertical = Float32Array.from([2, 4, 6, 1, 4, 6, 8, 1, 6, 8, 10, 1]);
  applyHevcPhaseIndication(vertical, 1, 3, {
    horizontalPhaseNum: 1,
    horizontalPhaseDenMinus1: 1,
    verticalPhaseNum: 0,
    verticalPhaseDenMinus1: 0,
  });
  expect(vertical).toEqual(Float32Array.from([3, 5, 7, 1, 5, 7, 9, 1, 6, 8, 10, 1]));

  const centered = Uint16Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
  applyHevcPhaseIndication(centered, 2, 1, {
    horizontalPhaseNum: 1,
    horizontalPhaseDenMinus1: 1,
    verticalPhaseNum: 1,
    verticalPhaseDenMinus1: 1,
  });
  expect(centered).toEqual(Uint16Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
});

it('exposes H.274 film-grain model metadata without synthesizing grain', () => {
  const source = codedFixture(12, 'pcm-rext-444');
  const configuration = parseHvcC(hvcCProperty(source).subarray(8));
  const prefix = seiNal(39, [{ type: 19, payload: filmGrainPayload() }]);
  const suffix = seiNal(40, [{ type: 19, payload: Buffer.from([0xc0]) }]);
  const item = {
    ...source,
    data: Buffer.concat([
      Buffer.from(source.data),
      lengthPrefixed(suffix, configuration.nalLengthSize),
    ]),
    properties: source.properties.map((property) =>
      property.toString('ascii', 4, 8) === 'hvcC' ? hvcCWithSei(source, prefix) : property,
    ),
  };
  const baseline = buildHeif([source], source.id),
    input = buildHeif([item], source.id);

  expect(getHeicMetadata(input).hevcFilmGrainCharacteristics).toEqual([
    {
      cancelled: false,
      modelId: 1,
      separateColourDescriptionPresent: true,
      colourDescription: {
        bitDepthLumaMinus8: 2,
        bitDepthChromaMinus8: 1,
        fullRange: true,
        colourPrimaries: 9,
        transferCharacteristics: 16,
        matrixCoefficients: 9,
      },
      blendingModeId: 1,
      log2ScaleFactor: 6,
      componentModels: [
        {
          intensityIntervals: [
            { lowerBound: 0, upperBound: 99, modelValues: [-3, 0, 5] },
            { lowerBound: 100, upperBound: 255, modelValues: [7, -8, 1] },
          ],
        },
        null,
        { intensityIntervals: [{ lowerBound: 0, upperBound: 255, modelValues: [-2] }] },
      ],
      persistence: true,
      spatialResolution: { width: 64, height: 32 },
    },
    { cancelled: true },
  ]);
  expect(decodeHeic(input).data).toEqual(decodeHeic(baseline).data);
});

it('rejects malformed H.274 film-grain payloads and invalid V4 dimensions', () => {
  expect(() =>
    parseHevcHdrSeiNals([seiNal(39, [{ type: 19, payload: Buffer.from([0]) }])]),
  ).toThrow('truncated bitstream');
  expect(() =>
    parseHevcHdrSeiNals([seiNal(39, [{ type: 19, payload: filmGrainInvalidModelCountPayload() }])]),
  ).toThrow('num_model_values_minus1 is out of range');
  expect(() =>
    parseHevcHdrSeiNals([seiNal(39, [{ type: 19, payload: filmGrainPayload(0, 32) }])]),
  ).toThrow('spatial resolution is out of range');
});

it('parses H.265 tone-mapping models and applies model 3 only when requested', async () => {
  const messages = [0, 1, 2, 3, 4].map((modelId) => ({
    type: 23,
    payload: toneMappingPayload(modelId),
  }));
  messages.push({ type: 23, payload: toneMappingCancellationPayload() });
  const parsed = parseHevcHdrSeiNals([seiNal(39, messages)]);
  expect(parsed?.toneMappingInfo).toEqual([
    {
      cancelled: false,
      toneMapId: 7,
      persistence: true,
      codedDataBitDepth: 10,
      targetBitDepth: 3,
      model: { modelId: 0, minValue: 10, maxValue: 1000 },
    },
    {
      cancelled: false,
      toneMapId: 7,
      persistence: true,
      codedDataBitDepth: 10,
      targetBitDepth: 3,
      model: { modelId: 1, sigmoidMidpoint: 50, sigmoidWidth: 20 },
    },
    {
      cancelled: false,
      toneMapId: 7,
      persistence: true,
      codedDataBitDepth: 10,
      targetBitDepth: 3,
      model: { modelId: 2, startOfCodedIntervals: [0, 10, 20, 30, 40, 50, 60, 70] },
    },
    {
      cancelled: false,
      toneMapId: 7,
      persistence: true,
      codedDataBitDepth: 10,
      targetBitDepth: 3,
      model: {
        modelId: 3,
        pivots: [
          { codedValue: 1, targetValue: 2 },
          { codedValue: 100, targetValue: 150 },
        ],
      },
    },
    {
      cancelled: false,
      toneMapId: 7,
      persistence: true,
      codedDataBitDepth: 10,
      targetBitDepth: 3,
      model: {
        modelId: 4,
        cameraIsoSpeedIdc: 255,
        cameraIsoSpeedValue: 400,
        exposureIndexIdc: 255,
        exposureIndexValue: 200,
        exposureCompensationNegative: true,
        exposureCompensationNumerator: 3,
        exposureCompensationDenominatorIdc: 2,
        referenceScreenLuminanceWhite: 1000,
        extendedRangeWhiteLevel: 2000,
        nominalBlackLevelCodeValue: 64,
        nominalWhiteLevelCodeValue: 940,
        extendedWhiteLevelCodeValue: 1023,
      },
    },
    { cancelled: true, toneMapId: 7 },
  ]);

  const source = codedFixture(12, 'pcm-rext-444');
  const appliedMessage = {
    type: 23,
    payload: toneMappingPayload(3, { targetBitDepth: 8 }),
  };
  const property = hvcCWithSei(source, seiNal(39, [appliedMessage]));
  const input = buildHeif(
    [
      {
        ...source,
        properties: source.properties.map((candidate) =>
          candidate.toString('ascii', 4, 8) === 'hvcC' ? property : candidate,
        ),
      },
    ],
    source.id,
  );
  const baseline = buildHeif([source], source.id);
  const toneMapping = getHeicMetadata(input).hevcToneMappingInfo?.[0];
  expect(toneMapping).toEqual({
    ...parsed?.toneMappingInfo?.[3],
    targetBitDepth: 8,
    model: {
      modelId: 3,
      pivots: [
        { codedValue: 1, targetValue: 2 },
        { codedValue: 100, targetValue: 150 },
      ],
    },
  });
  const baselineImage = decodeHeic(baseline),
    native = decodeNative(createRenderContext(baseline)),
    selectedMapping = toneMapping;
  expect(decodeHeic(input).data).toEqual(baselineImage.data);
  expect(decodeHeic(input, { applyHevcToneMapping: false }).data).toEqual(baselineImage.data);

  if (!selectedMapping || selectedMapping.cancelled) throw new Error('expected tone mapping data');
  const lut = compileHevcToneMapping(selectedMapping);
  if (!lut) throw new Error('expected a model 3 tone mapping LUT');
  const nativeMax = 2 ** native.bitDepth - 1,
    expected = new Uint8Array(native.data.length);
  for (let index = 0; index < native.data.length; index += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const sample = Math.max(0, Math.min(nativeMax, native.data[index + channel])),
        coded = Math.round((sample * lut.codedMax) / nativeMax);
      expected[index + channel] = Math.round((lut.values[coded] * 255) / lut.targetMax);
    }
    expected[index + 3] = Math.round((native.data[index + 3] * 255) / nativeMax);
  }
  expect(decodeHeic(input, { applyHevcToneMapping: true }).data).toEqual(expected);
  expect(decodeHeic(input, { applyHevcToneMapping: true, hevcToneMapId: 7 }).data).toEqual(
    expected,
  );
  expect((await decode(input, { execution: 'main', applyHevcToneMapping: true })).data).toEqual(
    expected,
  );
  expect((await decode(input, { applyHevcToneMapping: true })).data).toEqual(expected);
  expect(() => decodeHDRSync(input, { applyHevcToneMapping: true })).toThrow(
    'only to RGBA8 decode',
  );
  expect(() => decodeHeic(input, { applyHevcToneMapping: true, hevcToneMapId: 8 })).toThrow(
    'no active tone_mapping_info',
  );
});

it('ignores reserved tone-mapping models and rejects invalid linear ranges', () => {
  expect(
    parseHevcHdrSeiNals([
      seiNal(39, [
        { type: 23, payload: toneMappingPayload(5) },
        { type: 23, payload: toneMappingPayload(0, { codedDataBitDepth: 7 }) },
      ]),
    ]),
  ).toBeUndefined();
  expect(
    parseHevcHdrSeiNals([
      seiNal(39, [
        { type: 23, payload: toneMappingPayload(0, { targetBitDepth: 17 }) },
        { type: 23, payload: toneMappingPayload(4, { cameraIsoSpeedIdc: 31 }) },
        { type: 23, payload: toneMappingPayload(4, { exposureIndexIdc: 254 }) },
      ]),
    ]),
  ).toBeUndefined();
  expect(() =>
    parseHevcHdrSeiNals([
      seiNal(39, [{ type: 23, payload: toneMappingPayload(0, { minValue: 100, maxValue: 10 }) }]),
    ]),
  ).toThrow('max_value precedes min_value');
  expect(() =>
    parseHevcHdrSeiNals([
      seiNal(39, [{ type: 23, payload: toneMappingPayload(4, { cameraIsoSpeedValue: 0 }) }]),
    ]),
  ).toThrow('extended ISO value shall not be zero');
});

it('ignores reserved tone-mapping and knee-function identifiers', () => {
  const reservedIds = [256, 511, 0x8000_0000, 0xffff_fffe],
    ignoredMessages = reservedIds.flatMap((id) => [
      { type: 23, payload: toneMappingCancellationPayload(id) },
      { type: 23, payload: toneMappingPayload(0, { id }) },
      { type: 141, payload: kneeFunctionPayload({ id, cancelled: true }) },
      { type: 141, payload: kneeFunctionPayload({ id }) },
    ]);
  expect(parseHevcHdrSeiNals([seiNal(39, ignoredMessages)])).toBeUndefined();

  const parsed = parseHevcHdrSeiNals([
    seiNal(39, [
      { type: 23, payload: toneMappingCancellationPayload(512) },
      { type: 23, payload: toneMappingCancellationPayload(0x7fff_ffff) },
      { type: 141, payload: kneeFunctionPayload({ id: 512, cancelled: true }) },
      { type: 141, payload: kneeFunctionPayload({ id: 0x7fff_ffff, cancelled: true }) },
    ]),
  ]);
  expect(parsed?.toneMappingInfo).toEqual([
    { cancelled: true, toneMapId: 512 },
    { cancelled: true, toneMapId: 0x7fff_ffff },
  ]);
  expect(parsed?.kneeFunctionInfo).toEqual([
    { cancelled: true, kneeFunctionId: 512 },
    { cancelled: true, kneeFunctionId: 0x7fff_ffff },
  ]);
});

it('exposes H.265 knee-function metadata without applying its curve', () => {
  const kneeMessage = { type: 141, payload: kneeFunctionPayload() },
    cancellationMessage = { type: 141, payload: kneeFunctionPayload({ cancelled: true }) };
  const parsed = parseHevcHdrSeiNals([seiNal(39, [kneeMessage, cancellationMessage])]);
  expect(parsed?.kneeFunctionInfo).toEqual([
    {
      cancelled: false,
      kneeFunctionId: 3,
      persistence: true,
      inputDynamicRange: 10_000,
      inputDisplayLuminance: 203,
      outputDynamicRange: 4_000,
      outputDisplayLuminance: 100,
      points: [
        { input: 128, output: 96 },
        { input: 512, output: 400 },
        { input: 896, output: 700 },
      ],
    },
    { cancelled: true, kneeFunctionId: 3 },
  ]);

  const source = codedFixture(12, 'pcm-rext-444');
  const input = buildHeif(
    [
      {
        ...source,
        properties: source.properties.map((property) =>
          property.toString('ascii', 4, 8) === 'hvcC'
            ? hvcCWithSei(source, seiNal(39, [kneeMessage]))
            : property,
        ),
      },
    ],
    source.id,
  );
  expect(getHeicMetadata(input).hevcKneeFunctionInfo).toEqual([parsed?.kneeFunctionInfo?.[0]]);
  expect(decodeHeic(input).data).toEqual(decodeHeic(buildHeif([source], source.id)).data);
});

it('rejects knee-function point counts that cannot fit in the SEI payload', () => {
  expect(() =>
    parseHevcHdrSeiNals([
      seiNal(39, [
        { type: 141, payload: kneeFunctionPayload({ pointCountMinus1: 99, points: [] }) },
      ]),
    ]),
  ).toThrow('point count exceeds its payload size');
  expect(() =>
    parseHevcHdrSeiNals([
      seiNal(39, [{ type: 141, payload: kneeFunctionPayload({ pointCountMinus1: 999 }) }]),
    ]),
  ).toThrow('num_knee_points_minus1 is out of range');
  for (const [points, message] of [
    [[[0, 1]], 'input_knee_point is out of range'],
    [[[200, 1001]], 'output_knee_point is out of range'],
    [
      [
        [200, 100],
        [199, 101],
      ],
      'input_knee_point is not increasing',
    ],
    [
      [
        [200, 100],
        [300, 99],
      ],
      'output_knee_point is decreasing',
    ],
  ] as const) {
    expect(() =>
      parseHevcHdrSeiNals([
        seiNal(39, [
          {
            type: 141,
            payload: kneeFunctionPayload({
              points: points as readonly (readonly [number, number])[],
            }),
          },
        ]),
      ]),
    ).toThrow(message);
  }
});

it('applies an active H.265 knee function in linear RGB only when requested', async () => {
  const source = codedFixture(12, 'pcm-rext-444'),
    message = { type: 141, payload: kneeFunctionPayload() },
    property = hvcCWithSei(source, seiNal(39, [message])),
    input = buildHeif(
      [
        {
          ...source,
          properties: source.properties.map((candidate) =>
            candidate.toString('ascii', 4, 8) === 'hvcC' ? property : candidate,
          ),
        },
      ],
      source.id,
    ),
    baseline = buildHeif([source], source.id),
    metadata = getHeicMetadata(input),
    mapping = metadata.hevcKneeFunctionInfo?.[0],
    baselineImage = decodeHeic(baseline),
    native = decodeNative(createRenderContext(baseline));
  expect(mapping?.cancelled).toBe(false);
  expect(decodeHeic(input).data).toEqual(baselineImage.data);
  expect(decodeHeic(input, { applyHevcKneeFunction: false }).data).toEqual(baselineImage.data);

  if (!mapping || mapping.cancelled) throw new Error('expected active knee-function data');
  const transfer = getColorTransferFunction(2),
    lut = compileHevcKneeFunction(mapping),
    nativeMax = 2 ** native.bitDepth - 1,
    expected = new Uint8Array(native.data.length);
  if (!transfer) throw new Error('expected the default sRGB transfer function');
  expect(decodeHeic(baseline, { applyHevcKneeFunction: true }).data).toEqual(baselineImage.data);
  for (let index = 0; index < native.data.length; index += 4) {
    for (let channel = 0; channel < 3; channel++) {
      const encoded = Math.max(0, Math.min(1, native.data[index + channel] / nativeMax)),
        linear = transfer.toLinear(encoded),
        mapped = mapHevcKneeFunction(lut, linear);
      expected[index + channel] = Math.round(transfer.fromLinear(mapped) * 255);
    }
    expected[index + 3] = Math.round((native.data[index + 3] * 255) / nativeMax);
  }

  expect(decodeHeic(input, { applyHevcKneeFunction: true }).data).toEqual(expected);
  expect(decodeHeic(input, { applyHevcKneeFunction: true, hevcKneeFunctionId: 3 }).data).toEqual(
    expected,
  );
  expect((await decode(input, { execution: 'main', applyHevcKneeFunction: true })).data).toEqual(
    expected,
  );
  expect((await decode(input, { applyHevcKneeFunction: true })).data).toEqual(expected);
  expect(() => decodeHDRSync(input, { applyHevcKneeFunction: true })).toThrow(
    'only to RGBA8 decode',
  );
  expect(() => decodeHeic(input, { applyHevcKneeFunction: true, hevcKneeFunctionId: 4 })).toThrow(
    'no active knee_function_info',
  );
  expect(() => decodeHeic(input, { hevcKneeFunctionId: 3 })).toThrow('invalid hevcKneeFunctionId');
});

it('exposes H.265 colour-remapping metadata without changing decoded pixels', () => {
  const preLuts = [
      {
        numValMinus1: 2,
        points: [
          [10, 20],
          [500, 1000],
          [1000, 4000],
        ],
      },
      { numValMinus1: 0, points: [] },
      {
        numValMinus1: 1,
        points: [
          [32, 64],
          [900, 3500],
        ],
      },
    ] as const,
    postLuts = [
      {
        numValMinus1: 1,
        points: [
          [0, 0],
          [4095, 4095],
        ],
      },
      { numValMinus1: 0, points: [] },
      {
        numValMinus1: 1,
        points: [
          [64, 32],
          [4000, 3900],
        ],
      },
    ] as const,
    message = {
      type: 142,
      payload: colourRemappingPayload({
        id: 42,
        persistence: true,
        videoSignalInfo: {
          fullRange: true,
          primaries: 9,
          transferFunction: 16,
          matrixCoefficients: 9,
        },
        inputBitDepth: 10,
        outputBitDepth: 12,
        preLuts,
        matrix: {
          log2Denom: 10,
          coefficients: [
            [1024, 0, -1],
            [0, 1024, 0],
            [3, -4, 1024],
          ],
        },
        postLuts,
      }),
    },
    cancellation = {
      type: 142,
      payload: colourRemappingPayload({ id: 42, cancelled: true }),
    },
    parsed = parseHevcHdrSeiNals([seiNal(39, [message, cancellation])]);
  expect(parsed?.colourRemappingInfo).toEqual([
    {
      cancelled: false,
      colourRemapId: 42,
      persistence: true,
      videoSignalInfo: {
        fullRange: true,
        primaries: 9,
        transferFunction: 16,
        matrixCoefficients: 9,
      },
      inputBitDepth: 10,
      outputBitDepth: 12,
      preLuts: [
        {
          numValMinus1: 2,
          points: [
            { codedValue: 10, targetValue: 20 },
            { codedValue: 500, targetValue: 1000 },
            { codedValue: 1000, targetValue: 4000 },
          ],
        },
        { numValMinus1: 0, points: [] },
        {
          numValMinus1: 1,
          points: [
            { codedValue: 32, targetValue: 64 },
            { codedValue: 900, targetValue: 3500 },
          ],
        },
      ],
      matrix: {
        log2Denom: 10,
        coefficients: [
          [1024, 0, -1],
          [0, 1024, 0],
          [3, -4, 1024],
        ],
      },
      postLuts: [
        {
          numValMinus1: 1,
          points: [
            { codedValue: 0, targetValue: 0 },
            { codedValue: 4095, targetValue: 4095 },
          ],
        },
        { numValMinus1: 0, points: [] },
        {
          numValMinus1: 1,
          points: [
            { codedValue: 64, targetValue: 32 },
            { codedValue: 4000, targetValue: 3900 },
          ],
        },
      ],
    },
    { cancelled: true, colourRemapId: 42 },
  ]);

  const source = codedFixture(12, 'pcm-rext-444');
  const input = buildHeif(
    [
      {
        ...source,
        properties: source.properties.map((property) =>
          property.toString('ascii', 4, 8) === 'hvcC'
            ? hvcCWithSei(source, seiNal(39, [message]))
            : property,
        ),
      },
    ],
    source.id,
  );
  expect(getHeicMetadata(input).hevcColourRemappingInfo).toEqual([
    parsed?.colourRemappingInfo?.[0],
  ]);
  expect(decodeHeic(input).data).toEqual(decodeHeic(buildHeif([source], source.id)).data);
});

it('applies H.265 colour remapping only when requested', async () => {
  const source = codedFixture(12, 'pcm-rext-444'),
    message = {
      type: 142,
      payload: colourRemappingPayload({
        id: 42,
        inputBitDepth: 10,
        outputBitDepth: 16,
        videoSignalInfo: {
          fullRange: true,
          primaries: 1,
          transferFunction: 1,
          matrixCoefficients: 6,
        },
        matrix: {
          log2Denom: 0,
          coefficients: [
            [0, 0, 1],
            [0, 1, 0],
            [1, 0, 0],
          ],
        },
      }),
    },
    property = hvcCWithSei(source, seiNal(39, [message])),
    input = buildHeif(
      [
        {
          ...source,
          properties: source.properties.map((candidate) =>
            candidate.toString('ascii', 4, 8) === 'hvcC' ? property : candidate,
          ),
        },
      ],
      source.id,
    ),
    baseline = buildHeif([source], source.id),
    baselineImage = decodeHeic(baseline),
    mapped = decodeHeic(input, { applyHevcColourRemapping: true });

  expect(decodeHeic(input).data).toEqual(baselineImage.data);
  expect(decodeHeic(input, { applyHevcColourRemapping: false }).data).toEqual(baselineImage.data);
  expect(mapped.data).not.toEqual(baselineImage.data);
  expect(decodeHeic(input, { applyHevcColourRemapping: true, hevcColourRemapId: 42 }).data).toEqual(
    mapped.data,
  );
  expect((await decode(input, { execution: 'main', applyHevcColourRemapping: true })).data).toEqual(
    mapped.data,
  );
  expect((await decode(input, { applyHevcColourRemapping: true })).data).toEqual(mapped.data);
  expect(decodeHeic(baseline, { applyHevcColourRemapping: true }).data).toEqual(baselineImage.data);
  expect(() => decodeHDRSync(input, { applyHevcColourRemapping: true })).toThrow(
    'only to RGBA8 decode',
  );
  expect(() =>
    decodeHeic(input, { applyHevcColourRemapping: true, hevcColourRemapId: 43 }),
  ).toThrow('no active colour_remapping_info');
  expect(() => decodeHeic(input, { hevcColourRemapId: 42 })).toThrow('invalid hevcColourRemapId');

  const source422 = codedFixture(10, 'pcm-rext-422'),
    subsampledMessage = {
      type: 142,
      payload: colourRemappingPayload({
        id: 42,
        inputBitDepth: 10,
        outputBitDepth: 10,
        videoSignalInfo: {
          fullRange: true,
          primaries: 1,
          transferFunction: 1,
          matrixCoefficients: 6,
        },
        matrix: {
          log2Denom: 0,
          coefficients: [
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
          ],
        },
      }),
    },
    subsampledInput = buildHeif(
      [
        {
          ...source422,
          properties: source422.properties.map((candidate) =>
            candidate.toString('ascii', 4, 8) === 'hvcC'
              ? hvcCWithSei(source422, seiNal(39, [subsampledMessage]))
              : candidate,
          ),
        },
      ],
      source422.id,
    );
  expect(decodeHeic(subsampledInput, { applyHevcColourRemapping: true }).data).not.toEqual(
    decodeHeic(buildHeif([source422], source422.id)).data,
  );

  const noMatrixMessage = {
      type: 142,
      payload: colourRemappingPayload({
        id: 51,
        inputBitDepth: 10,
        outputBitDepth: 10,
        preLuts: [
          {
            numValMinus1: 1,
            points: [
              [0, 0],
              [1023, 0],
            ],
          },
          { numValMinus1: 0, points: [] },
          { numValMinus1: 0, points: [] },
        ],
      }),
    },
    noMatrixInput = buildHeif(
      [
        {
          ...source,
          properties: source.properties.map((candidate) =>
            candidate.toString('ascii', 4, 8) === 'hvcC'
              ? hvcCWithSei(source, seiNal(39, [noMatrixMessage]))
              : candidate,
          ),
        },
      ],
      source.id,
    );
  expect(decodeHeic(noMatrixInput, { applyHevcColourRemapping: true }).data).not.toEqual(
    baselineImage.data,
  );
});

it('ignores reserved colour-remapping identifiers, depths, and LUT sizes', () => {
  expect(
    parseHevcHdrSeiNals([
      seiNal(39, [
        { type: 142, payload: colourRemappingPayload({ id: 256, cancelled: true }) },
        { type: 142, payload: colourRemappingPayload({ id: 511, cancelled: true }) },
        { type: 142, payload: colourRemappingPayload({ id: 0x8000_0000, cancelled: true }) },
        { type: 142, payload: colourRemappingPayload({ id: 256 }) },
        { type: 142, payload: colourRemappingPayload({ id: 0xffff_fffe }) },
        { type: 142, payload: colourRemappingPayload({ inputBitDepth: 7 }) },
        { type: 142, payload: colourRemappingPayload({ outputBitDepth: 17 }) },
        {
          type: 142,
          payload: colourRemappingPayload({
            preLuts: [
              { numValMinus1: 33, points: [] },
              { numValMinus1: 0, points: [] },
              { numValMinus1: 0, points: [] },
            ],
          }),
        },
      ]),
    ]),
  ).toBeUndefined();

  const parsed = parseHevcHdrSeiNals([
    seiNal(39, [
      { type: 142, payload: colourRemappingPayload({ id: 512, cancelled: true }) },
      { type: 142, payload: colourRemappingPayload({ id: 0x7fff_ffff, cancelled: true }) },
    ]),
  ]);
  expect(parsed?.colourRemappingInfo).toEqual([
    { cancelled: true, colourRemapId: 512 },
    { cancelled: true, colourRemapId: 0x7fff_ffff },
  ]);
});

it('rejects malformed colour-remapping coefficients and truncated LUTs', () => {
  const empty = { numValMinus1: 0, points: [] } as const;
  expect(() =>
    parseHevcHdrSeiNals([
      seiNal(39, [
        {
          type: 142,
          payload: colourRemappingPayload({
            matrix: {
              log2Denom: 0,
              coefficients: [
                [32_768, 0, 0],
                [0, 1, 0],
                [0, 0, 1],
              ],
            },
          }),
        },
      ]),
    ]),
  ).toThrow('colour_remap_coeffs is out of range');
  expect(() =>
    parseHevcHdrSeiNals([
      seiNal(39, [
        {
          type: 142,
          payload: colourRemappingPayload({
            preLuts: [{ numValMinus1: 32, points: [] }, empty, empty],
          }),
        },
      ]),
    ]),
  ).toThrow('LUT points exceed their payload size');
});

it('exposes H.265 chroma-resampling filter hints as optional display metadata', () => {
  const payload = chromaResamplingFilterPayload({
      verticalFilterIdc: 1,
      horizontalFilterIdc: 1,
      fieldProcessing: true,
      targetFormatIdc: 3,
      verticalFilters: [
        { tapLengthMinus1: 2, coefficients: [-2_147_483_647, 0, 2_147_483_647] },
        { tapLengthMinus1: 0, coefficients: [-1] },
        { tapLengthMinus1: 1, coefficients: [7, -7] },
      ],
      horizontalFilters: [
        { tapLengthMinus1: 0, coefficients: [1] },
        { tapLengthMinus1: 1, coefficients: [50, -50] },
        { tapLengthMinus1: 2, coefficients: [-2, 10, 64] },
      ],
    }),
    parsed = parseHevcHdrSeiNals([seiNal(39, [{ type: 140, payload }])]);
  expect(parsed?.chromaResamplingFilterHint).toEqual([
    {
      verticalFilterIdc: 1,
      horizontalFilterIdc: 1,
      verticalFilteringFieldProcessing: true,
      targetFormatIdc: 3,
      verticalFilters: [
        { tapLengthMinus1: 2, coefficients: [-2_147_483_647, 0, 2_147_483_647] },
        { tapLengthMinus1: 0, coefficients: [-1] },
        { tapLengthMinus1: 1, coefficients: [7, -7] },
      ],
      horizontalFilters: [
        { tapLengthMinus1: 0, coefficients: [1] },
        { tapLengthMinus1: 1, coefficients: [50, -50] },
        { tapLengthMinus1: 2, coefficients: [-2, 10, 64] },
      ],
    },
  ]);

  const source = codedFixture(10, 'pcm-rext-422'),
    imageHint = chromaResamplingFilterPayload({
      verticalFilterIdc: 1,
      horizontalFilterIdc: 0,
      targetFormatIdc: 1,
      verticalFilters: [
        { tapLengthMinus1: 1, coefficients: [2, -1] },
        { tapLengthMinus1: 0, coefficients: [1] },
      ],
    }),
    input = buildHeif(
      [
        {
          ...source,
          properties: source.properties.map((property) =>
            property.toString('ascii', 4, 8) === 'hvcC'
              ? hvcCWithSei(source, seiNal(39, [{ type: 140, payload: imageHint }]))
              : property,
          ),
        },
      ],
      source.id,
    );
  expect(getHeicMetadata(input).hevcChromaResamplingFilterHint).toEqual(
    parseHevcHdrSeiNals([seiNal(39, [{ type: 140, payload: imageHint }])])
      ?.chromaResamplingFilterHint,
  );
  expect(decodeHeic(input).data).toEqual(decodeHeic(buildHeif([source], source.id)).data);
});

it('extracts per-access-unit field structure from picture-timing SEI', () => {
  const topField = seiNal(39, [{ type: 1, payload: Buffer.from([0x16]) }]);
  expect(parseHevcPictureTimingSeiNals([topField], true)).toEqual({
    picStruct: 1,
    sourceScanType: 1,
    duplicate: true,
  });
  expect(parseHevcPictureTimingSeiNals([topField], false)).toBeUndefined();
  expect(() =>
    parseHevcPictureTimingSeiNals([seiNal(39, [{ type: 1, payload: Buffer.from([0xd0]) }])], true),
  ).toThrow('picture_timing pic_struct is reserved');
  expect(() =>
    parseHevcPictureTimingSeiNals(
      [
        seiNal(39, [{ type: 1, payload: Buffer.from([0x10]) }]),
        seiNal(39, [{ type: 1, payload: Buffer.from([0x20]) }]),
      ],
      true,
    ),
  ).toThrow('multiple picture_timing SEI messages');
});

it('uses picture-timing parity for field-sequence CRFH in a still HEVC item', () => {
  const source = codedFixture(10, 'pcm-rext-422'),
    configuration = parseHvcC(hvcCProperty(source).subarray(8)),
    patchedSps = addFieldSequenceVui(configuration.sps[0]),
    imageHint = chromaResamplingFilterPayload({
      verticalFilterIdc: 1,
      horizontalFilterIdc: 0,
      fieldProcessing: true,
      targetFormatIdc: 1,
      verticalFilters: [
        { tapLengthMinus1: 1, coefficients: [1, 3] },
        { tapLengthMinus1: 0, coefficients: [1] },
        { tapLengthMinus1: 0, coefficients: [1] },
      ],
    }),
    configurationSei = seiNal(39, [{ type: 140, payload: imageHint }]),
    makeInput = (picStruct: 1 | 2) => {
      const pictureTiming = seiNal(39, [{ type: 1, payload: Buffer.from([(picStruct << 4) | 1]) }]);
      return buildHeif(
        [
          {
            ...source,
            data: Buffer.concat([
              lengthPrefixed(pictureTiming, configuration.nalLengthSize),
              Buffer.from(source.data),
            ]),
            properties: source.properties.map((property) =>
              property.toString('ascii', 4, 8) === 'hvcC'
                ? hvcCWithFieldSequenceSpsAndSei(source, patchedSps, [configurationSei])
                : property,
            ),
          },
        ],
        source.id,
      );
    },
    topInput = makeInput(1),
    bottomInput = makeInput(2);

  expect(getHeicMetadata(topInput).hevcPictureTiming).toEqual({
    picStruct: 1,
    sourceScanType: 0,
    duplicate: false,
  });
  expect(getHeicMetadata(bottomInput).hevcPictureTiming?.picStruct).toBe(2);
  expect(decodeHeic(topInput, { applyHevcChromaResamplingFilterHint: true }).data).not.toEqual(
    decodeHeic(bottomInput, { applyHevcChromaResamplingFilterHint: true }).data,
  );
});

it('applies H.265 horizontal and vertical CRFH upsampling filters on request', () => {
  const horizontal = applyHevcChromaResamplingFilterHint(
      {
        chromaFormatIdc: 2,
        bitDepthLuma: 8,
        bitDepthChroma: 8,
        hasExternalInterMotion: false,
        y: new Uint8Array(4),
        cb: new Uint8Array([10, 50]),
        cr: new Uint8Array([20, 60]),
        width: 4,
        height: 1,
      },
      {
        verticalFilterIdc: 0,
        horizontalFilterIdc: 1,
        verticalFilteringFieldProcessing: false,
        targetFormatIdc: 3,
        horizontalFilters: [
          { tapLengthMinus1: 0, coefficients: [1] },
          { tapLengthMinus1: 0, coefficients: [1] },
          { tapLengthMinus1: 1, coefficients: [1, 1] },
        ],
      },
    ),
    horizontalNon420SampleLocation = applyHevcChromaResamplingFilterHint(
      {
        chromaFormatIdc: 2,
        bitDepthLuma: 8,
        bitDepthChroma: 8,
        hasExternalInterMotion: false,
        y: new Uint8Array(4),
        cb: new Uint8Array([10, 50]),
        cr: new Uint8Array([20, 60]),
        width: 4,
        height: 1,
      },
      {
        verticalFilterIdc: 0,
        horizontalFilterIdc: 1,
        verticalFilteringFieldProcessing: false,
        targetFormatIdc: 3,
        horizontalFilters: [
          { tapLengthMinus1: 0, coefficients: [1] },
          { tapLengthMinus1: 0, coefficients: [1] },
          { tapLengthMinus1: 1, coefficients: [1, 1] },
        ],
      },
      5,
    ),
    horizontalDownNon420SampleLocation = applyHevcChromaResamplingFilterHint(
      {
        chromaFormatIdc: 3,
        bitDepthLuma: 8,
        bitDepthChroma: 8,
        hasExternalInterMotion: false,
        y: new Uint8Array(4),
        cb: new Uint8Array([10, 20, 30, 40]),
        cr: new Uint8Array([20, 30, 40, 50]),
        width: 4,
        height: 1,
      },
      {
        verticalFilterIdc: 0,
        horizontalFilterIdc: 1,
        verticalFilteringFieldProcessing: false,
        targetFormatIdc: 2,
        horizontalFilters: [
          { tapLengthMinus1: 0, coefficients: [1] },
          { tapLengthMinus1: 0, coefficients: [1] },
          { tapLengthMinus1: 1, coefficients: [1, 1] },
        ],
      },
      5,
    ),
    fixedHorizontal = applyHevcChromaResamplingFilterHint(
      {
        chromaFormatIdc: 2,
        bitDepthLuma: 8,
        bitDepthChroma: 8,
        hasExternalInterMotion: false,
        y: new Uint8Array(4),
        cb: new Uint8Array([10, 50]),
        cr: new Uint8Array([20, 60]),
        width: 4,
        height: 1,
      },
      {
        verticalFilterIdc: 0,
        horizontalFilterIdc: 2,
        verticalFilteringFieldProcessing: false,
        targetFormatIdc: 3,
      },
    ),
    fixedHorizontalDown = applyHevcChromaResamplingFilterHint(
      {
        chromaFormatIdc: 3,
        bitDepthLuma: 8,
        bitDepthChroma: 8,
        hasExternalInterMotion: false,
        y: new Uint8Array(4),
        cb: new Uint8Array([10, 20, 30, 40]),
        cr: new Uint8Array([20, 30, 40, 50]),
        width: 4,
        height: 1,
      },
      {
        verticalFilterIdc: 0,
        horizontalFilterIdc: 2,
        verticalFilteringFieldProcessing: false,
        targetFormatIdc: 2,
      },
    ),
    fixedVertical = applyHevcChromaResamplingFilterHint(
      {
        chromaFormatIdc: 1,
        bitDepthLuma: 8,
        bitDepthChroma: 8,
        hasExternalInterMotion: false,
        y: new Uint8Array(8),
        cb: new Uint8Array([10, 50]),
        cr: new Uint8Array([20, 60]),
        width: 2,
        height: 4,
      },
      {
        verticalFilterIdc: 2,
        horizontalFilterIdc: 0,
        verticalFilteringFieldProcessing: false,
        targetFormatIdc: 2,
      },
    ),
    fieldVertical = applyHevcChromaResamplingFilterHint(
      {
        chromaFormatIdc: 1,
        bitDepthLuma: 8,
        bitDepthChroma: 8,
        hasExternalInterMotion: false,
        y: new Uint8Array(16),
        cb: new Uint8Array([10, 20, 30, 40]),
        cr: new Uint8Array([15, 25, 35, 45]),
        width: 2,
        height: 8,
      },
      {
        verticalFilterIdc: 1,
        horizontalFilterIdc: 0,
        verticalFilteringFieldProcessing: true,
        targetFormatIdc: 2,
        verticalFilters: [
          { tapLengthMinus1: 0, coefficients: [1] },
          { tapLengthMinus1: 0, coefficients: [1] },
          { tapLengthMinus1: 0, coefficients: [1] },
        ],
      },
    ),
    fieldSequenceTop = applyHevcChromaResamplingFilterHint(
      {
        chromaFormatIdc: 1,
        bitDepthLuma: 8,
        bitDepthChroma: 8,
        hasExternalInterMotion: false,
        y: new Uint8Array(8),
        cb: new Uint8Array([10, 50]),
        cr: new Uint8Array([20, 60]),
        width: 2,
        height: 4,
      },
      {
        verticalFilterIdc: 1,
        horizontalFilterIdc: 0,
        verticalFilteringFieldProcessing: true,
        targetFormatIdc: 2,
        verticalFilters: [
          { tapLengthMinus1: 0, coefficients: [1] },
          { tapLengthMinus1: 1, coefficients: [1, 3] },
          { tapLengthMinus1: 0, coefficients: [1] },
        ],
      },
      0,
      0,
    ),
    fieldSequenceBottom = applyHevcChromaResamplingFilterHint(
      {
        chromaFormatIdc: 1,
        bitDepthLuma: 8,
        bitDepthChroma: 8,
        hasExternalInterMotion: false,
        y: new Uint8Array(8),
        cb: new Uint8Array([10, 50]),
        cr: new Uint8Array([20, 60]),
        width: 2,
        height: 4,
      },
      {
        verticalFilterIdc: 1,
        horizontalFilterIdc: 0,
        verticalFilteringFieldProcessing: true,
        targetFormatIdc: 2,
        verticalFilters: [
          { tapLengthMinus1: 0, coefficients: [1] },
          { tapLengthMinus1: 1, coefficients: [1, 3] },
          { tapLengthMinus1: 0, coefficients: [1] },
        ],
      },
      0,
      1,
    ),
    downVertical = applyHevcChromaResamplingFilterHint(
      {
        chromaFormatIdc: 2,
        bitDepthLuma: 8,
        bitDepthChroma: 8,
        hasExternalInterMotion: false,
        y: new Uint8Array(8),
        cb: new Uint8Array([10, 50, 90, 130]),
        cr: new Uint8Array([20, 60, 100, 140]),
        width: 2,
        height: 4,
      },
      {
        verticalFilterIdc: 1,
        horizontalFilterIdc: 0,
        verticalFilteringFieldProcessing: false,
        targetFormatIdc: 1,
        verticalFilters: [
          { tapLengthMinus1: 1, coefficients: [1, 1] },
          { tapLengthMinus1: 0, coefficients: [1] },
        ],
      },
    ),
    vertical = applyHevcChromaResamplingFilterHint(
      {
        chromaFormatIdc: 1,
        bitDepthLuma: 8,
        bitDepthChroma: 8,
        hasExternalInterMotion: false,
        y: new Uint8Array(8),
        cb: new Uint8Array([10, 50]),
        cr: new Uint8Array([20, 60]),
        width: 2,
        height: 4,
      },
      {
        verticalFilterIdc: 1,
        horizontalFilterIdc: 0,
        verticalFilteringFieldProcessing: false,
        targetFormatIdc: 2,
        verticalFilters: [
          { tapLengthMinus1: 0, coefficients: [1] },
          { tapLengthMinus1: 1, coefficients: [1, 3] },
        ],
      },
    );

  expect(horizontal.planes.chromaFormatIdc).toBe(3);
  expect([...horizontal.planes.cb]).toEqual([10, 30, 50, 50]);
  expect([...horizontal.planes.cr]).toEqual([20, 40, 60, 60]);
  expect([...horizontalNon420SampleLocation.planes.cb]).toEqual([...horizontal.planes.cb]);
  expect([...horizontalNon420SampleLocation.planes.cr]).toEqual([...horizontal.planes.cr]);
  expect([...horizontalDownNon420SampleLocation.planes.cb]).toEqual([10, 30]);
  expect([...horizontalDownNon420SampleLocation.planes.cr]).toEqual([20, 40]);
  expect(horizontalDownNon420SampleLocation.chromaSampleLocation).toEqual({ x: 0, y: 0 });
  expect([...fixedHorizontal.planes.cb]).toEqual([10, 30, 50, 50]);
  expect([...fixedHorizontal.planes.cr]).toEqual([20, 40, 60, 60]);
  expect([...fixedHorizontalDown.planes.cb]).toEqual([10, 31]);
  expect([...fixedHorizontalDown.planes.cr]).toEqual([20, 41]);
  expect([...fixedVertical.planes.cb]).toEqual([45, 15, 49, 55]);
  expect([...fixedVertical.planes.cr]).toEqual([55, 25, 59, 65]);
  expect([...fieldVertical.planes.cb]).toEqual([10, 20, 10, 20, 30, 40, 30, 40]);
  expect([...fieldVertical.planes.cr]).toEqual([15, 25, 15, 25, 35, 45, 35, 45]);
  expect([...fieldSequenceTop.planes.cb]).toEqual([40, 10, 50, 50]);
  expect([...fieldSequenceBottom.planes.cb]).toEqual([20, 10, 50, 50]);
  expect(downVertical.planes.chromaFormatIdc).toBe(1);
  expect([...downVertical.planes.cb]).toEqual([30, 110]);
  expect([...downVertical.planes.cr]).toEqual([40, 120]);
  expect(downVertical.chromaSampleLocation).toEqual({ x: 0, y: 0.5 });
  expect(vertical.planes.chromaFormatIdc).toBe(2);
  expect([...vertical.planes.cb]).toEqual([40, 20, 50, 50]);
  expect([...vertical.planes.cr]).toEqual([50, 30, 60, 60]);
  expect(vertical.chromaSampleLocation).toEqual({ x: 0, y: 0 });
});

it('applies CRFH through the public decoder only when enabled', async () => {
  const source = codedFixture(10, 'pcm-rext-422'),
    imageHint = chromaResamplingFilterPayload({
      verticalFilterIdc: 0,
      horizontalFilterIdc: 1,
      targetFormatIdc: 3,
      horizontalFilters: [
        { tapLengthMinus1: 0, coefficients: [1] },
        { tapLengthMinus1: 0, coefficients: [1] },
        { tapLengthMinus1: 1, coefficients: [1, 7] },
      ],
    }),
    input = buildHeif(
      [
        {
          ...source,
          properties: source.properties.map((property) =>
            property.toString('ascii', 4, 8) === 'hvcC'
              ? hvcCWithSei(source, seiNal(39, [{ type: 140, payload: imageHint }]))
              : property,
          ),
        },
      ],
      source.id,
    ),
    baseline = decodeHeic(buildHeif([source], source.id));

  expect(decodeHeic(input).data).toEqual(baseline.data);
  expect(decodeHeic(input, { applyHevcChromaResamplingFilterHint: true }).data).not.toEqual(
    baseline.data,
  );
  expect((await decode(input, { applyHevcChromaResamplingFilterHint: true })).data).not.toEqual(
    baseline.data,
  );
  expect(decodeHDRSync(input, { applyHevcChromaResamplingFilterHint: true }).data).not.toEqual(
    decodeHDRSync(buildHeif([source], source.id)).data,
  );
});

it('requires repeated chroma-resampling filter hints in one stream to agree', () => {
  const first = chromaResamplingFilterPayload({
      verticalFilters: [
        { tapLengthMinus1: 0, coefficients: [1] },
        { tapLengthMinus1: 0, coefficients: [2] },
      ],
    }),
    same = chromaResamplingFilterPayload({
      verticalFilters: [
        { tapLengthMinus1: 0, coefficients: [1] },
        { tapLengthMinus1: 0, coefficients: [2] },
      ],
    }),
    different = chromaResamplingFilterPayload({
      verticalFilters: [
        { tapLengthMinus1: 0, coefficients: [1] },
        { tapLengthMinus1: 0, coefficients: [3] },
      ],
    });
  expect(
    parseHevcHdrSeiNals([
      seiNal(39, [
        { type: 140, payload: first },
        { type: 140, payload: same },
      ]),
    ])?.chromaResamplingFilterHint,
  ).toHaveLength(2);
  expect(() =>
    parseHevcHdrSeiNals([
      seiNal(39, [
        { type: 140, payload: first },
        { type: 140, payload: different },
      ]),
    ]),
  ).toThrow('conflicting chroma_resampling_filter_hint SEI messages');
});

it('ignores reserved chroma-resampling filter IDs and rejects invalid bounds', () => {
  expect(
    parseHevcHdrSeiNals([
      seiNal(39, [
        {
          type: 140,
          payload: chromaResamplingFilterPayload({ verticalFilterIdc: 3, horizontalFilterIdc: 0 }),
        },
      ]),
    ]),
  ).toBeUndefined();
  expect(() =>
    parseHevcHdrSeiNals([
      seiNal(39, [{ type: 140, payload: chromaResamplingFilterPayload({ verticalFilterIdc: 0 }) }]),
    ]),
  ).toThrow('cannot leave both directions unspecified');
  expect(() =>
    parseHevcHdrSeiNals([
      seiNal(39, [
        {
          type: 140,
          payload: chromaResamplingFilterPayload({
            targetFormatIdc: 4,
            verticalFilters: [
              { tapLengthMinus1: 0, coefficients: [1] },
              { tapLengthMinus1: 0, coefficients: [1] },
            ],
          }),
        },
      ]),
    ]),
  ).toThrow('target_format_idc is out of range');
  expect(() =>
    parseHevcHdrSeiNals([
      seiNal(39, [
        {
          type: 140,
          payload: chromaResamplingFilterPayload({
            verticalFilters: Array.from({ length: 4 }, () => ({
              tapLengthMinus1: 0,
              coefficients: [1],
            })),
          }),
        },
      ]),
    ]),
  ).toThrow('num_vertical_filters is out of range');
  expect(() =>
    parseHevcHdrSeiNals([
      seiNal(39, [
        {
          type: 140,
          payload: chromaResamplingFilterPayload({
            verticalFilters: [
              { tapLengthMinus1: 32, coefficients: [1] },
              { tapLengthMinus1: 0, coefficients: [1] },
            ],
          }),
        },
      ]),
    ]),
  ).toThrow('vertical tap length is out of range');
  expect(() =>
    parseHevcHdrSeiNals(
      [
        seiNal(39, [
          {
            type: 140,
            payload: chromaResamplingFilterPayload({
              targetFormatIdc: 2,
              verticalFilters: Array.from({ length: 3 }, () => ({
                tapLengthMinus1: 0,
                coefficients: [1],
              })),
            }),
          },
        ]),
      ],
      1,
      0,
    ),
  ).toThrow('invalid vertical filter count');
  expect(() =>
    parseHevcHdrSeiNals(
      [
        seiNal(39, [
          {
            type: 140,
            payload: chromaResamplingFilterPayload({
              targetFormatIdc: 2,
              verticalFilters: [
                { tapLengthMinus1: 0, coefficients: [1] },
                { tapLengthMinus1: 0, coefficients: [1] },
              ],
            }),
          },
        ]),
      ],
      1,
      0,
      1,
    ),
  ).toThrow('matching top and bottom chroma locations');
});

it('exposes H.265 post-filter hints as coded matrices and leaves default pixels unchanged', () => {
  const components = [
      [
        [-2_147_483_647, 0, 2_147_483_647],
        [-3, 5, -7],
      ],
      [
        [1, -2, 3],
        [4, -5, 6],
      ],
      [
        [-1, 2, -3],
        [-4, 5, -6],
      ],
    ] as const,
    payload = postFilterHintPayload(2, 3, 0, components),
    nal = seiNal(39, [{ type: 22, payload }]);
  expect(parseHevcHdrSeiNals([nal], 2)?.postFilterHint).toEqual([
    {
      filterHintSizeY: 2,
      filterHintSizeX: 3,
      filterHintType: 0,
      filterHintValues: components,
    },
  ]);

  const monochrome = postFilterHintPayload(1, 2, 2, [[[10, -20]]]);
  expect(
    parseHevcHdrSeiNals([seiNal(39, [{ type: 22, payload: monochrome }])], 0)?.postFilterHint,
  ).toEqual([
    {
      filterHintSizeY: 1,
      filterHintSizeX: 2,
      filterHintType: 2,
      filterHintValues: [[[10, -20]]],
    },
  ]);

  const source = codedFixture(10, 'pcm-rext-422'),
    publicPayload = postFilterHintPayload(1, 1, 0, [[[1]], [[-2]], [[3]]]),
    input = buildHeif(
      [
        {
          ...source,
          properties: source.properties.map((property) =>
            property.toString('ascii', 4, 8) === 'hvcC'
              ? hvcCWithSei(source, seiNal(39, [{ type: 22, payload: publicPayload }]))
              : property,
          ),
        },
      ],
      source.id,
    );
  expect(getHeicMetadata(input).hevcPostFilterHint).toEqual(
    parseHevcHdrSeiNals([seiNal(39, [{ type: 22, payload: publicPayload }])], 2)?.postFilterHint,
  );
  expect(decodeHeic(input).data).toEqual(decodeHeic(buildHeif([source], source.id)).data);
});

it('applies 2D and separable 1D post-filter FIR hints to native sample planes', () => {
  const source = {
      chromaFormatIdc: 0,
      bitDepthLuma: 8,
      bitDepthChroma: 8,
      hasExternalInterMotion: false,
      y: new Uint8Array([10, 20, 30, 40, 50, 60]),
      cb: new Uint8Array(),
      cr: new Uint8Array(),
      width: 3,
      height: 2,
    },
    twoDimensional = applyHevcPostFilterHint(source, {
      filterHintSizeY: 1,
      filterHintSizeX: 2,
      filterHintType: 0,
      filterHintValues: [[[32_768, 32_768]]],
    }),
    separable = applyHevcPostFilterHint(source, {
      filterHintSizeY: 2,
      filterHintSizeX: 3,
      filterHintType: 1,
      filterHintValues: [
        [
          [0, 32_768, 32_768],
          [32_768, 32_768, 0],
        ],
      ],
    });

  expect([...twoDimensional.y]).toEqual([10, 15, 25, 40, 45, 55]);
  expect([...separable.y]).toEqual([15, 25, 30, 30, 40, 45]);
  expect([...source.y]).toEqual([10, 20, 30, 40, 50, 60]);
});

it('bounds post-filter hint convolution work', () => {
  const side = 1500,
    source = {
      chromaFormatIdc: 0,
      bitDepthLuma: 8,
      bitDepthChroma: 8,
      hasExternalInterMotion: false,
      y: new Uint8Array(side * side),
      cb: new Uint8Array(),
      cr: new Uint8Array(),
      width: side,
      height: side,
    };
  expect(() =>
    applyHevcPostFilterHint(source, {
      filterHintSizeY: 15,
      filterHintSizeX: 15,
      filterHintType: 0,
      filterHintValues: [Array.from({ length: 15 }, () => new Array(15).fill(0))],
    }),
  ).toThrow('post-filter hint exceeds the rendering work limit');
});

it('opts into post-filter FIR hints through sync, async, and HDR rendering', async () => {
  const source = codedFixture(10, 'pcm-rext-422'),
    payload = postFilterHintPayload(1, 2, 0, [
      [[32_768, 32_768]],
      [[32_768, 32_768]],
      [[32_768, 32_768]],
    ]),
    input = buildHeif(
      [
        {
          ...source,
          properties: source.properties.map((property) =>
            property.toString('ascii', 4, 8) === 'hvcC'
              ? hvcCWithSei(source, seiNal(39, [{ type: 22, payload }]))
              : property,
          ),
        },
      ],
      source.id,
    ),
    baselineInput = buildHeif([source], source.id),
    options = { applyHevcPostFilterHint: true } as const;

  expect(decodeHeic(input).data).toEqual(decodeHeic(baselineInput).data);
  expect(decodeHeic(input, options).data).not.toEqual(decodeHeic(baselineInput).data);
  expect((await decode(input, options)).data).not.toEqual((await decode(baselineInput)).data);
  expect(decodeHDRSync(input, options).data).not.toEqual(decodeHDRSync(baselineInput).data);
  expect((await decodeHDR(input, options)).data).not.toEqual((await decodeHDR(baselineInput)).data);
});

it('ignores reserved post-filter hints and rejects invalid matrices', () => {
  expect(
    parseHevcHdrSeiNals([
      seiNal(39, [{ type: 22, payload: postFilterHintPayload(16, 16, 3, []) }]),
    ]),
  ).toBeUndefined();
  expect(() =>
    parseHevcHdrSeiNals(
      [seiNal(39, [{ type: 22, payload: postFilterHintPayload(0, 1, 0, []) }])],
      1,
    ),
  ).toThrow('filter_hint_size_y is out of range');
  expect(() =>
    parseHevcHdrSeiNals(
      [seiNal(39, [{ type: 22, payload: postFilterHintPayload(1, 16, 0, []) }])],
      1,
    ),
  ).toThrow('filter_hint_size_x is out of range');
  expect(() =>
    parseHevcHdrSeiNals(
      [seiNal(39, [{ type: 22, payload: postFilterHintPayload(1, 1, 1, [[[1]]]) }])],
      1,
    ),
  ).toThrow('type 1 requires filter_hint_size_y to equal 2');
  expect(() =>
    parseHevcHdrSeiNals(
      [seiNal(39, [{ type: 22, payload: postFilterHintPayload(15, 15, 0, []) }])],
      1,
    ),
  ).toThrow('values exceed their payload size');
});

it('parses all display-orientation transform codes and preserves cancellation order', () => {
  const messages = Array.from({ length: 8 }, (_, transformType) => ({
    type: 47,
    payload: displayOrientationPayload(transformType, transformType % 2 === 1, 7),
  }));
  messages.push({ type: 47, payload: Buffer.from([0xc0]) });

  expect(parseHevcHdrSeiNals([seiNal(39, messages)])?.displayOrientation).toEqual([
    ...Array.from({ length: 8 }, (_, transformType) => ({
      cancelled: false,
      persistence: transformType % 2 === 1,
      transformType,
    })),
    { cancelled: true },
  ]);
});

it('renders all H.274 display-orientation codes and composes them before HEIF transforms', () => {
  const source = codedFixture(12, 'pcm-rext-444'),
    baseline = decodeHeic(buildHeif([source], source.id)),
    // H.274 V4 Table 19: rotations are counter-clockwise; mirror 0 is horizontal.
    transforms: { rotation: number; mirror: number | null }[] = [
      { rotation: 0, mirror: null },
      { rotation: 0, mirror: 0 },
      { rotation: 2, mirror: null },
      { rotation: 2, mirror: 0 },
      { rotation: 1, mirror: 0 },
      { rotation: 1, mirror: null },
      { rotation: 3, mirror: 0 },
      { rotation: 3, mirror: null },
    ];

  for (const [transformType, transform] of transforms.entries()) {
    const prefix = seiNal(39, [
        { type: 47, payload: displayOrientationPayload(transformType, false) },
      ]),
      item = {
        ...source,
        properties: source.properties.map((property) =>
          property.toString('ascii', 4, 8) === 'hvcC' ? hvcCWithSei(source, [prefix]) : property,
        ),
      },
      decoded = decodeHeic(buildHeif([item], source.id)),
      expected = applyOrientation(
        baseline.data,
        baseline.width,
        baseline.height,
        transform.rotation,
        transform.mirror,
      );

    expect(decoded.width).toBe(expected.width);
    expect(decoded.height).toBe(expected.height);
    expect(decoded.data).toEqual(expected.data);
  }

  const cancelledPrefix = seiNal(39, [
      { type: 47, payload: displayOrientationPayload(4, true) },
      { type: 47, payload: Buffer.from([0xc0]) },
    ]),
    cancelledItem = {
      ...source,
      properties: source.properties.map((property) =>
        property.toString('ascii', 4, 8) === 'hvcC'
          ? hvcCWithSei(source, [cancelledPrefix])
          : property,
      ),
    };
  expect(decodeHeic(buildHeif([cancelledItem], source.id)).data).toEqual(baseline.data);

  const mirrorPrefix = seiNal(39, [{ type: 47, payload: displayOrientationPayload(1, false) }]),
    composedItem = {
      ...source,
      properties: [
        ...source.properties.map((property) =>
          property.toString('ascii', 4, 8) === 'hvcC'
            ? hvcCWithSei(source, [mirrorPrefix])
            : property,
        ),
        box('irot', Buffer.from([1])),
      ],
    },
    mirrored = applyOrientation(baseline.data, baseline.width, baseline.height, 0, 0),
    expected = applyOrientation(mirrored.data, mirrored.width, mirrored.height, 1, null),
    composedInput = buildHeif([composedItem], source.id),
    decoded = decodeHeic(composedInput);
  expect(decoded.width).toBe(expected.width);
  expect(decoded.height).toBe(expected.height);
  expect(decoded.data).toEqual(expected.data);

  const orientationOnly = decodeHeic(composedInput, { applyTransforms: false }),
    containerOnly = decodeHeic(composedInput, { applyHevcDisplayOrientation: false }),
    expectedContainerOnly = applyOrientation(
      baseline.data,
      baseline.width,
      baseline.height,
      1,
      null,
    );
  expect(orientationOnly.width).toBe(mirrored.width);
  expect(orientationOnly.height).toBe(mirrored.height);
  expect(orientationOnly.data).toEqual(mirrored.data);
  expect(containerOnly.width).toBe(expectedContainerOnly.width);
  expect(containerOnly.height).toBe(expectedContainerOnly.height);
  expect(containerOnly.data).toEqual(expectedContainerOnly.data);
});

it('applies display orientation through async SDR and HDR entry points', async () => {
  const source = codedFixture(12, 'pcm-rext-444'),
    baselineInput = buildHeif([source], source.id),
    orientationNal = seiNal(39, [{ type: 47, payload: displayOrientationPayload(4, true) }]),
    orientedItem = {
      ...source,
      properties: source.properties.map((property) =>
        property.toString('ascii', 4, 8) === 'hvcC'
          ? hvcCWithSei(source, [orientationNal])
          : property,
      ),
    },
    input = buildHeif([orientedItem], source.id),
    baselineSdr = decodeHeic(baselineInput),
    expectedSdr = applyOrientation(baselineSdr.data, baselineSdr.width, baselineSdr.height, 1, 0),
    syncSdr = decodeHeic(input),
    asyncSdr = await decode(input, { execution: 'main' });
  expect(asyncSdr.width).toBe(syncSdr.width);
  expect(asyncSdr.height).toBe(syncSdr.height);
  expect(asyncSdr.data).toEqual(syncSdr.data);
  expect(syncSdr.data).toEqual(expectedSdr.data);

  const baselineHdr = decodeHDRSync(baselineInput),
    expectedHdr = transformRaster(
      baselineHdr.data,
      baselineHdr.width,
      baselineHdr.height,
      [
        { type: 'irot', value: 1 },
        { type: 'imir', value: 0 },
      ],
      createRenderContext(baselineInput),
    ),
    syncHdr = decodeHDRSync(input),
    asyncHdr = await decodeHDR(input, { execution: 'main' });
  expect(syncHdr.width).toBe(expectedHdr.width);
  expect(syncHdr.height).toBe(expectedHdr.height);
  expect(syncHdr.data).toEqual(expectedHdr.data);
  expect(asyncHdr.width).toBe(syncHdr.width);
  expect(asyncHdr.height).toBe(syncHdr.height);
  expect(asyncHdr.data).toEqual(syncHdr.data);
});

it('rejects malformed and conflicting HDR static-metadata SEI messages', () => {
  const malformed = seiNal(39, [{ type: 137, payload: Buffer.alloc(23) }]);
  expect(() => parseHevcHdrSeiNals([malformed])).toThrow('invalid mastering_display_colour_volume');

  const first = masteringDisplayPayload();
  const conflicting = Buffer.from(first);
  conflicting.writeUInt32BE(9_000_000, 16);
  const duplicate = seiNal(40, [
    { type: 137, payload: first },
    { type: 137, payload: conflicting },
  ]);
  expect(() => parseHevcHdrSeiNals([duplicate])).toThrow(
    'conflicting mastering_display_colour_volume',
  );

  expect(() =>
    parseHevcHdrSeiNals([seiNal(39, [{ type: 148, payload: Buffer.alloc(8) }])]),
  ).toThrow('ambient_illuminance shall not be zero');
  expect(() =>
    parseHevcHdrSeiNals([seiNal(40, [{ type: 149, payload: Buffer.from([1]) }])]),
  ).toThrow('content_colour_volume has no values');

  const canceled = seiNal(39, [
    { type: 149, payload: contentColourPayload() },
    { type: 149, payload: Buffer.from([0xc0]) },
  ]);
  expect(parseHevcHdrSeiNals([canceled])).toEqual({ contentColourVolume: null });
});

it('ignores short non-SEI NAL units while rejecting truncated SEI headers', () => {
  const endOfSequence = Uint8Array.from([37 << 1, 1]);
  expect(parseHevcHdrSeiNals([endOfSequence])).toBeUndefined();
  expect(() => parseHevcHdrSeiNals([Uint8Array.from([39 << 1, 1])])).toThrow(
    'truncated HEVC SEI NAL unit',
  );
  expect(() => parseHevcHdrSeiNals([Uint8Array.from([37 << 1])])).toThrow(
    'truncated HEVC NAL header',
  );
});
