import { expect, it } from 'bun:test';
import { cropPlanesToDefaultDisplayWindow, type Planes } from '../src/planes';
import { parseSps, resolveSpsScalingListData } from '../src/hevc/sps';
import type { HevcRepresentationFormat, LayeredVpsInfo } from '../src/hevc/vps';

class BitWriter {
  private readonly bits: number[] = [];

  write(value: number, width: number): void {
    for (let i = width - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }

  ue(value: number): void {
    const codeNum = value + 1;
    const width = Math.floor(Math.log2(codeNum));
    for (let i = 0; i < width; i++) this.bits.push(0);
    this.write(codeNum, width + 1);
  }

  toNal(layerId: number): Uint8Array {
    this.write(1, 1); // rbsp_stop_one_bit
    while (this.bits.length & 7) this.write(0, 1);
    const rbsp = new Uint8Array(this.bits.length >> 3);
    for (let i = 0; i < this.bits.length; i++) rbsp[i >> 3] |= this.bits[i] << (7 - (i & 7));

    const escaped: number[] = [];
    let zeroCount = 0;
    for (const byte of rbsp) {
      if (zeroCount >= 2 && byte <= 3) {
        escaped.push(3);
        zeroCount = 0;
      }
      escaped.push(byte);
      zeroCount = byte === 0 ? zeroCount + 1 : 0;
    }
    const nalHeader = [(33 << 1) | ((layerId >> 5) & 1), ((layerId & 31) << 3) | 1];
    return Uint8Array.from([...nalHeader, ...escaped]);
  }
}

function representationFormat(
  index: number,
  width: number,
  height: number,
): HevcRepresentationFormat {
  return {
    index,
    width,
    height,
    chromaFormatIdc: 1,
    separateColourPlane: false,
    bitDepthLuma: 8,
    bitDepthChroma: 8,
    cropLeft: 0,
    cropRight: 0,
    cropTop: 0,
    cropBottom: 0,
  };
}

function makeVps(maxSubLayersMinus1 = 0): LayeredVpsInfo {
  return {
    vpsId: 0,
    maxSubLayersMinus1,
    temporalIdNested: true,
    layerIds: [0, 1],
    referenceLayerIds: [[], [0]],
    representationFormatIndices: [0, 0],
    representationFormats: [representationFormat(0, 512, 256), representationFormat(1, 400, 200)],
  };
}

function makeLayeredSps(
  updateRepFormat: boolean,
  scalingListEnabled: boolean,
  scalingListRefLayerId = 0,
  includeVuiHrd = false,
  rangeExtension = false,
  extensionBits = 0,
  extensionDataFlags: readonly number[] = [],
  log2MinLumaCodingBlockSizeMinus3 = 0,
): Uint8Array {
  const writer = new BitWriter();
  writer.write(0, 4); // sps_video_parameter_set_id
  writer.write(7, 3); // sps_ext_or_max_sub_layers_minus1 => MultiLayerExtSpsFlag
  writer.ue(1); // sps_seq_parameter_set_id
  writer.write(Number(updateRepFormat), 1);
  if (updateRepFormat) writer.write(1, 8); // sps_rep_format_idx
  writer.ue(4); // log2_max_pic_order_cnt_lsb_minus4 => 8-bit POC LSB
  writer.ue(log2MinLumaCodingBlockSizeMinus3); // log2_min_luma_coding_block_size_minus3
  writer.ue(3); // log2_diff_max_min_luma_coding_block_size
  writer.ue(0); // log2_min_luma_transform_block_size_minus2
  writer.ue(3); // log2_diff_max_min_luma_transform_block_size
  writer.ue(0); // max_transform_hierarchy_depth_inter
  writer.ue(0); // max_transform_hierarchy_depth_intra
  writer.write(Number(scalingListEnabled), 1);
  if (scalingListEnabled) {
    writer.write(1, 1); // sps_infer_scaling_list_flag
    writer.write(scalingListRefLayerId, 6); // sps_scaling_list_ref_layer_id
  }
  writer.write(0, 1); // amp_enabled_flag
  writer.write(1, 1); // sample_adaptive_offset_enabled_flag
  writer.write(0, 1); // pcm_enabled_flag
  writer.ue(0); // num_short_term_ref_pic_sets
  writer.write(0, 1); // long_term_ref_pics_present_flag
  writer.write(0, 1); // sps_temporal_mvp_enabled_flag
  writer.write(1, 1); // strong_intra_smoothing_enabled_flag
  writer.write(Number(includeVuiHrd), 1); // vui_parameters_present_flag
  if (includeVuiHrd) {
    writer.write(0, 8); // VUI flags before timing info
    writer.write(1, 1); // vui_timing_info_present_flag
    writer.write(1, 32); // vui_num_units_in_tick
    writer.write(25, 32); // vui_time_scale
    writer.write(0, 1); // vui_poc_proportional_to_timing_flag
    writer.write(1, 1); // vui_hrd_parameters_present_flag
    writer.write(0, 1); // nal_hrd_parameters_present_flag
    writer.write(0, 1); // vcl_hrd_parameters_present_flag
    for (let i = 0; i <= 1; i++) {
      writer.write(1, 1); // fixed_pic_rate_general_flag
      writer.ue(0); // elemental_duration_in_tc_minus1
    }
  }
  writer.write(1, 1); // sps_extension_present_flag
  writer.write(Number(rangeExtension), 1); // sps_range_extension_flag
  writer.write(1, 1); // sps_multilayer_extension_flag
  writer.write(0, 1); // sps_3d_extension_flag
  writer.write(0, 1); // sps_scc_extension_flag
  writer.write(extensionBits, 5); // Reserved SPS extension bits
  if (rangeExtension) writer.write(1 << 4, 9); // extended_precision_processing_flag
  writer.write(1, 1); // inter_view_mv_vert_constraint_flag
  for (const flag of extensionDataFlags) writer.write(flag, 1); // ignored sps_extension_data_flag
  return writer.toNal(1);
}

it('parses the remaining Annex F SPS syntax using VPS representation fields', () => {
  const sps = parseSps(makeLayeredSps(false, false), { layeredVps: makeVps() });
  expect(sps).toMatchObject({
    layerId: 1,
    videoParameterSetId: 0,
    spsId: 1,
    multiLayerExtSps: true,
    representationFormatIndex: 0,
    chromaFormatIdc: 1,
    width: 512,
    height: 256,
    picWidthInLumaSamples: 512,
    picHeightInLumaSamples: 256,
    bitDepthLuma: 8,
    bitDepthChroma: 8,
    log2MaxPicOrderCntLsb: 8,
    log2CtbSize: 6,
    scalingListInferred: false,
    scalingListRefLayerId: null,
  });
});

it('requires coded dimensions to align to the SPS minimum coding block size', () => {
  const vps = makeVps();
  const misalignedVps: LayeredVpsInfo = {
    ...vps,
    representationFormats: vps.representationFormats.map((format, index) =>
      index === 0 ? { ...format, width: format.width + 8 } : format,
    ),
  };

  expect(() =>
    parseSps(makeLayeredSps(false, false, 0, false, false, 0, [], 1), {
      allowBaseLayerMultilayerExtension: true,
      layeredVps: misalignedVps,
    }),
  ).toThrow('coded dimensions are not multiples of the minimum luma coding block size');
});

it('uses an SPS-selected VPS representation and records inherited scaling-list source', () => {
  const sps = parseSps(makeLayeredSps(true, true), { layeredVps: makeVps() });
  expect(sps).toMatchObject({
    representationFormatIndex: 1,
    width: 400,
    height: 200,
    scalingListEnabled: true,
    scalingListData: null,
    scalingListInferred: true,
    scalingListRefLayerId: 0,
  });
});

it('uses the VPS temporal sub-layer count when skipping inherited SPS HRD timing', () => {
  const sps = parseSps(makeLayeredSps(false, false, 0, true), {
    layeredVps: makeVps(1),
  });
  expect(sps.log2CtbSize).toBe(6);
  expect(sps.multiLayerExtSps).toBe(true);
  expect(sps.vuiPresent).toBe(true);
});

it('parses range and multilayer SPS extensions in Annex F syntax order', () => {
  const sps = parseSps(makeLayeredSps(false, false, 0, false, true), {
    layeredVps: makeVps(),
  });
  expect(sps.rangeFlags).toBe(1 << 4);
  expect(sps.extendedPrecisionProcessingEnabled).toBe(true);
});

it('requires the active VPS to resolve a multilayer SPS representation', () => {
  expect(() => parseSps(makeLayeredSps(false, false))).toThrow(/requires its active VPS/);
  expect(() =>
    parseSps(makeLayeredSps(false, false), {
      layeredVps: { ...makeVps(), vpsId: 1 },
    }),
  ).toThrow(/different VPS/);
});

it('rejects a scaling-list reference that is not a VPS layer', () => {
  expect(() => parseSps(makeLayeredSps(false, true, 2), { layeredVps: makeVps() })).toThrow(
    /scaling-list reference layer is absent/,
  );
});

function makeBaseSps(
  scalingListEnabled: boolean,
  vuiChromaLocations?: [number, number],
  chromaFormatIdc = 1,
  vuiDefaultDisplayWindow?: [number, number, number, number],
  extension4bits?: number,
  extensionDataFlags: readonly number[] = [],
): Uint8Array {
  const writer = new BitWriter();
  writer.write(0, 4); // sps_video_parameter_set_id
  writer.write(0, 3); // sps_max_sub_layers_minus1
  writer.write(1, 1); // sps_temporal_id_nesting_flag
  writer.write(0, 2); // general_profile_space
  writer.write(0, 1); // general_tier_flag
  writer.write(1, 5); // general_profile_idc
  writer.write(0, 32); // general_profile_compatibility_flags
  writer.write(0, 32); // general constraint flags
  writer.write(0, 16);
  writer.write(120, 8); // general_level_idc
  writer.ue(0); // sps_seq_parameter_set_id
  writer.ue(chromaFormatIdc);
  writer.ue(512); // pic_width_in_luma_samples
  writer.ue(256); // pic_height_in_luma_samples
  writer.write(0, 1); // conformance_window_flag
  writer.ue(0); // bit_depth_luma_minus8
  writer.ue(0); // bit_depth_chroma_minus8
  writer.ue(4); // log2_max_pic_order_cnt_lsb_minus4
  writer.write(1, 1); // sps_sub_layer_ordering_info_present_flag
  writer.ue(0); // sps_max_dec_pic_buffering_minus1
  writer.ue(0); // sps_max_num_reorder_pics
  writer.ue(0); // sps_max_latency_increase_plus1
  writer.ue(0); // log2_min_luma_coding_block_size_minus3
  writer.ue(3); // log2_diff_max_min_luma_coding_block_size
  writer.ue(0); // log2_min_luma_transform_block_size_minus2
  writer.ue(3); // log2_diff_max_min_luma_transform_block_size
  writer.ue(0); // max_transform_hierarchy_depth_inter
  writer.ue(0); // max_transform_hierarchy_depth_intra
  writer.write(Number(scalingListEnabled), 1); // scaling_list_enabled_flag
  if (scalingListEnabled) writer.write(0, 1); // default scaling_list_data
  writer.write(0, 1); // amp_enabled_flag
  writer.write(1, 1); // sample_adaptive_offset_enabled_flag
  writer.write(0, 1); // pcm_enabled_flag
  writer.ue(0); // num_short_term_ref_pic_sets
  writer.write(0, 1); // long_term_ref_pics_present_flag
  writer.write(0, 1); // sps_temporal_mvp_enabled_flag
  writer.write(1, 1); // strong_intra_smoothing_enabled_flag
  const vuiPresent = vuiChromaLocations !== undefined || vuiDefaultDisplayWindow !== undefined;
  writer.write(Number(vuiPresent), 1); // vui_parameters_present_flag
  if (vuiPresent) {
    writer.write(0, 1); // aspect_ratio_info_present_flag
    writer.write(0, 1); // overscan_info_present_flag
    writer.write(0, 1); // video_signal_type_present_flag
    writer.write(Number(vuiChromaLocations !== undefined), 1); // chroma_loc_info_present_flag
    if (vuiChromaLocations) {
      writer.ue(vuiChromaLocations[0]); // chroma_sample_loc_type_top_field
      writer.ue(vuiChromaLocations[1]); // chroma_sample_loc_type_bottom_field
    }
    writer.write(0, 1); // neutral_chroma_indication_flag
    writer.write(0, 1); // field_seq_flag
    writer.write(0, 1); // frame_field_info_present_flag
    writer.write(Number(vuiDefaultDisplayWindow !== undefined), 1); // default_display_window_flag
    if (vuiDefaultDisplayWindow) for (const offset of vuiDefaultDisplayWindow) writer.ue(offset);
    writer.write(0, 1); // vui_timing_info_present_flag
    writer.write(0, 1); // bitstream_restriction_flag
  }
  writer.write(Number(extension4bits !== undefined), 1); // sps_extension_present_flag
  if (extension4bits !== undefined) {
    writer.write(0, 4); // range, multilayer, 3D, SCC extension flags
    writer.write(extension4bits, 4); // sps_extension_4bits
    for (const flag of extensionDataFlags) writer.write(flag, 1); // ignored extension data
  }
  return writer.toNal(0);
}

it('allows reserved base-layer SPS extension bits and ignores extension data flags', () => {
  const sps = parseSps(makeBaseSps(false, undefined, 1, undefined, 0b1010, [1, 0, 1, 1]));
  expect([sps.width, sps.height]).toEqual([512, 256]);
  expect(sps.rangeFlags).toBe(0);
  expect(sps.screenContentExtension).toBeNull();
});

it('allows reserved enhancement-layer SPS extension bits and ignores extension data flags', () => {
  const sps = parseSps(makeLayeredSps(false, false, 0, false, false, 0b10101, [1, 0, 1]), {
    layeredVps: makeVps(),
  });
  expect([sps.width, sps.height]).toEqual([512, 256]);
  expect(sps.multiLayerExtSps).toBe(true);
});

it('parses only a single usable 4:2:0 SPS VUI chroma location', () => {
  expect(parseSps(makeBaseSps(false, [0, 0])).chromaSampleLocation).toEqual({ x: 0, y: 0.5 });
  expect(parseSps(makeBaseSps(false, [3, 3])).chromaSampleLocation).toEqual({ x: 0.5, y: 0 });
  expect(parseSps(makeBaseSps(false, [1, 2])).chromaSampleLocation).toBeUndefined();
  expect(parseSps(makeBaseSps(false, [3, 3], 2)).chromaSampleLocation).toBeUndefined();
  expect(parseSps(makeBaseSps(false, [6, 6])).chromaSampleLocation).toBeUndefined();
  expect(parseSps(makeBaseSps(false, [6, 6], 2)).chromaSampleLocation).toBeUndefined();
  expect(() => parseSps(makeBaseSps(false, [7, 7]))).toThrow('invalid VUI chroma sample location');
});

it('retains and bounds-checks the SPS VUI default display window', () => {
  const sps = parseSps(makeBaseSps(false, undefined, 1, [1, 2, 3, 4]));
  expect(sps.defaultDisplayWindow).toEqual({ left: 1, right: 2, top: 3, bottom: 4 });
  // The VUI window is metadata; SPS width/height remain the conformance crop.
  expect(sps.width).toBe(512);
  expect(sps.height).toBe(256);
  expect(parseSps(makeBaseSps(false)).defaultDisplayWindow).toBeNull();
  expect(() => parseSps(makeBaseSps(false, undefined, 1, [128, 128, 0, 0]))).toThrow(
    'SPS crop or default display window is out of bounds',
  );
});

it('applies default display offsets after the conformance crop using chroma units', () => {
  const parsed = parseSps(makeBaseSps(false, undefined, 1, [1, 1, 1, 1]));
  const sps = {
    ...parsed,
    picWidthInLumaSamples: 8,
    picHeightInLumaSamples: 6,
    width: 8,
    height: 6,
  };
  const planes: Planes = {
    chromaFormatIdc: 1,
    hasExternalInterMotion: false,
    y: Uint8Array.from({ length: 48 }, (_, i) => i),
    cb: Uint8Array.from({ length: 12 }, (_, i) => 50 + i),
    cr: Uint8Array.from({ length: 12 }, (_, i) => 100 + i),
    width: 8,
    height: 6,
  };

  const cropped = cropPlanesToDefaultDisplayWindow(planes, sps);
  expect([cropped.width, cropped.height]).toEqual([4, 2]);
  expect(cropped.y).toEqual(Uint8Array.from([18, 19, 20, 21, 26, 27, 28, 29]));
  expect(cropped.cb).toEqual(Uint8Array.from([55, 56]));
  expect(cropped.cr).toEqual(Uint8Array.from([105, 106]));

  const planes422: Planes = {
    ...planes,
    chromaFormatIdc: 2,
    cb: Uint8Array.from({ length: 24 }, (_, i) => 50 + i),
    cr: Uint8Array.from({ length: 24 }, (_, i) => 100 + i),
  };
  const chroma422 = cropPlanesToDefaultDisplayWindow(planes422, {
    ...sps,
    chromaFormatIdc: 2,
  });
  expect([chroma422.width, chroma422.height]).toEqual([4, 4]);
  expect(chroma422.cb).toEqual(Uint8Array.from([55, 56, 59, 60, 63, 64, 67, 68]));
});

it('resolves inferred SPS scaling lists from the active reference-layer SPS', () => {
  const vps = makeVps();
  const baseSps = parseSps(makeBaseSps(true));
  const enhancementSps = parseSps(makeLayeredSps(false, true), { layeredVps: vps });

  expect(enhancementSps.scalingListData).toBeNull();
  const resolved = resolveSpsScalingListData(enhancementSps, new Map([[0, baseSps]]), vps);
  expect(resolved.scalingListInferred).toBe(true);
  expect(resolved.scalingListData).toEqual(baseSps.scalingListData);
  expect(resolved.scalingListData?.lists[1][0][63]).toBe(115);
  expect(enhancementSps.scalingListData).toBeNull();
});

it('does not resolve SPS scaling lists from a missing or nonconforming active reference SPS', () => {
  const vps = makeVps();
  const enhancementSps = parseSps(makeLayeredSps(false, true), { layeredVps: vps });
  const baseWithoutScaling = parseSps(makeBaseSps(false));

  expect(() => resolveSpsScalingListData(enhancementSps, new Map(), vps)).toThrow(
    /active SPS for scaling-list reference layer 0 is unavailable/,
  );
  expect(() =>
    resolveSpsScalingListData(enhancementSps, new Map([[0, baseWithoutScaling]]), vps),
  ).toThrow(/must enable and explicitly resolve scaling lists/);
});
