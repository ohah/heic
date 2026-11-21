import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { splitAnnexB } from '../src/hevc/nal';
import {
  getDirectDependencyPredictionCapabilities,
  getVpsVideoSignalInfoForSps,
  parseLayeredVps,
  selectLayerRepresentationFormat,
} from '../src/hevc/vps';

it('derives inter-layer sample and motion prediction flags from dependency types', () => {
  expect([0, 1, 2, 3, 4, 5, 6].map(getDirectDependencyPredictionCapabilities)).toEqual([
    { samplePredictionEnabled: true, motionPredictionEnabled: false },
    { samplePredictionEnabled: false, motionPredictionEnabled: true },
    { samplePredictionEnabled: true, motionPredictionEnabled: true },
    { samplePredictionEnabled: false, motionPredictionEnabled: false },
    { samplePredictionEnabled: true, motionPredictionEnabled: false },
    { samplePredictionEnabled: false, motionPredictionEnabled: true },
    { samplePredictionEnabled: true, motionPredictionEnabled: true },
  ]);
});

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

  alignOnes(): void {
    while (this.bits.length & 7) this.bits.push(1);
  }

  trailingBits(): void {
    this.bits.push(1);
    while (this.bits.length & 7) this.bits.push(0);
  }

  toBytes(): Uint8Array {
    while (this.bits.length & 7) this.bits.push(0);
    const bytes = new Uint8Array(this.bits.length >> 3);
    for (let i = 0; i < this.bits.length; i++) bytes[i >> 3] |= this.bits[i] << (7 - (i & 7));
    return bytes;
  }
}

function makeTwoLayerVps(
  withVui = false,
  withBspHrd = false,
  videoSignalInfoIdxPresent = true,
  baseLayerInternal = true,
): Uint8Array {
  const w = new BitWriter();
  const profileTierLevel = (profilePresent: boolean): void => {
    if (profilePresent) {
      w.write(0, 2); // general_profile_space
      w.write(0, 1); // general_tier_flag
      w.write(1, 5); // general_profile_idc
      w.write(0, 32); // general_profile_compatibility_flags
      w.write(0, 32); // general constraint flags
      w.write(0, 16);
    }
    w.write(120, 8); // general_level_idc
  };

  w.write(0, 4); // vps_video_parameter_set_id
  w.write(Number(baseLayerInternal), 1); // vps_base_layer_internal_flag
  w.write(1, 1); // vps_base_layer_available_flag
  w.write(1, 6); // vps_max_layers_minus1
  w.write(0, 3); // vps_max_sub_layers_minus1
  w.write(1, 1); // vps_temporal_id_nesting_flag
  w.write(0xffff, 16); // vps_reserved_0xffff_16bits
  profileTierLevel(true);
  w.write(1, 1); // vps_sub_layer_ordering_info_present_flag
  w.ue(0);
  w.ue(0);
  w.ue(0);
  w.write(1, 6); // vps_max_layer_id
  w.ue(1); // vps_num_layer_sets_minus1
  w.write(1, 1); // layer_id 0 belongs to set 1
  w.write(1, 1); // layer_id 1 belongs to set 1
  w.write(0, 1); // vps_timing_info_present_flag
  w.write(1, 1); // vps_extension_flag
  w.alignOnes();

  if (baseLayerInternal) profileTierLevel(false); // base layer PTL in vps_extension
  w.write(0, 1); // splitting_flag
  w.write(0, 16); // no scalability dimensions
  w.write(0, 1); // vps_nuh_layer_id_present_flag
  w.write(0, 4); // view_id_len
  w.write(1, 1); // layer 1 directly depends on layer 0
  w.write(0, 1); // vps_sub_layers_max_minus1_present_flag
  w.write(0, 1); // max_tid_ref_present_flag
  w.write(0, 1); // default_ref_layers_active_flag
  w.ue(1); // vps_num_profile_tier_level_minus1
  if (!baseLayerInternal) {
    w.write(0, 1); // profile_present_flag for enhancement-layer PTL
    profileTierLevel(false);
  }
  w.ue(0); // num_add_olss
  w.write(1, 2); // default_output_layer_idc: highest layer only
  w.write(0, 1); // profile_tier_level_idx for necessary base layer
  w.write(0, 1); // profile_tier_level_idx for necessary enhancement layer
  w.write(0, 1); // alt_output_layer_flag
  w.ue(0); // vps_num_rep_formats_minus1
  w.write(512, 16); // pic_width_vps_in_luma_samples
  w.write(256, 16); // pic_height_vps_in_luma_samples
  w.write(1, 1); // chroma_and_bit_depth_vps_present_flag
  w.write(1, 2); // chroma_format_vps_idc: 4:2:0
  w.write(0, 4); // bit_depth_vps_luma_minus8
  w.write(0, 4); // bit_depth_vps_chroma_minus8
  w.write(0, 1); // conformance_window_vps_flag

  w.write(1, 1); // max_one_active_ref_layer_flag
  w.write(0, 1); // vps_poc_lsb_aligned_flag
  w.write(0, 1); // sub_layer_flag_info_present_flag for OLS 1
  if (baseLayerInternal) w.ue(0); // base-layer max_vps_dec_pic_buffering_minus1
  w.ue(0); // enhancement-layer max_vps_dec_pic_buffering_minus1
  w.ue(0); // max_vps_num_reorder_pics
  w.ue(0); // max_vps_latency_increase_plus1
  w.ue(0); // direct_dep_type_len_minus2
  w.write(0, 1); // direct_dependency_all_layers_flag
  if (baseLayerInternal) w.write(0, 2); // direct_dependency_type[1][0]
  w.ue(0); // vps_non_vui_extension_length
  w.write(Number(withVui), 1); // vps_vui_present_flag
  if (withVui) {
    w.alignOnes(); // vps_vui_alignment_bit_equal_to_one
    w.write(0, 1); // cross_layer_pic_type_aligned_flag
    w.write(1, 1); // cross_layer_irap_aligned_flag
    w.write(1, 1); // all_layers_idr_aligned_flag
    w.write(1, 1); // bit_rate_present_vps_flag
    w.write(1, 1); // pic_rate_present_vps_flag
    const rates = baseLayerInternal
      ? [
          [11, 22],
          [33, 44],
        ]
      : [[33, 44]];
    for (const [averageBitRate, maximumBitRate] of rates) {
      w.write(1, 1); // bit_rate_present_flag
      w.write(1, 1); // pic_rate_present_flag
      w.write(averageBitRate, 16);
      w.write(maximumBitRate, 16);
      w.write(1, 2); // constant_pic_rate_idc
      w.write(50, 16); // avg_pic_rate
    }
    w.write(Number(videoSignalInfoIdxPresent), 1); // video_signal_info_idx_present_flag
    if (videoSignalInfoIdxPresent) w.write(1, 4); // vps_num_video_signal_info_minus1
    const signals = baseLayerInternal
      ? [
          [5, 1, 9, 16, 9],
          [2, 0, 1, 1, 1],
        ]
      : [[2, 0, 1, 1, 1]];
    for (let i = 0; i < signals.length; i++) {
      const [format, fullRange, primaries, transfer, matrix] = signals[i];
      w.write(format, 3); // video_vps_format[i]
      w.write(fullRange, 1); // video_full_range_vps_flag[i]
      w.write(primaries, 8); // colour_primaries_vps[i]
      w.write(transfer, 8); // transfer_characteristics_vps[i]
      w.write(matrix, 8); // matrix_coeffs_vps[i]
    }
    if (videoSignalInfoIdxPresent) {
      w.write(0, 4); // vps_video_signal_info_idx[0]
      w.write(1, 4); // vps_video_signal_info_idx[1]
    }
    w.write(0, 1); // tiles_not_in_use_flag
    if (baseLayerInternal) {
      w.write(1, 1); // tiles_in_use_flag[0]
      w.write(1, 1); // loop_filter_not_across_tiles_flag[0]
      w.write(1, 1); // tiles_in_use_flag[1]
      w.write(0, 1); // loop_filter_not_across_tiles_flag[1]
      w.write(1, 1); // tile_boundaries_aligned_flag[1][0]
    } else {
      w.write(1, 1); // tiles_in_use_flag[1]
      w.write(0, 1); // loop_filter_not_across_tiles_flag[1]
    }
    w.write(0, 1); // wpp_not_in_use_flag
    if (baseLayerInternal) {
      w.write(1, 1); // wpp_in_use_flag[0]
      w.write(0, 1); // wpp_in_use_flag[1]
    } else w.write(0, 1); // wpp_in_use_flag[1]
    w.write(0, 1); // single_layer_for_non_irap_flag
    w.write(1, 1); // higher_layer_irap_skip_flag
    w.write(1, 1); // ilp_restricted_ref_layers_flag
    if (baseLayerInternal) {
      w.ue(1); // min_spatial_segment_offset_plus1[1][0]
      w.write(1, 1); // ctu_based_offset_enabled_flag[1][0]
      w.ue(2); // min_horizontal_ctu_offset_plus1[1][0]
    }
    w.write(Number(withBspHrd), 1); // vps_vui_bsp_hrd_present_flag
    if (withBspHrd) {
      w.ue(1); // vps_num_add_hrd_params
      w.ue(0); // num_sub_layer_hrd_minus1
      w.write(0, 1); // nal_hrd_parameters_present_flag
      w.write(0, 1); // vcl_hrd_parameters_present_flag
      w.write(1, 1); // fixed_pic_rate_general_flag
      w.ue(0); // elemental_duration_in_tc_minus1
      w.ue(0); // cpb_cnt_minus1
      w.ue(0); // num_signalled_partitioning_schemes[1]
      w.ue(0); // num_bsp_schedules_minus1[1][0][0]
      w.ue(0); // bsp_sched_idx for partition 0
      w.ue(0); // bsp_sched_idx for partition 1
    }
  }
  w.write(0, 1); // vps_extension2_flag
  w.trailingBits();

  const rbsp = w.toBytes();
  return Uint8Array.from([0x40, 0x01, ...rbsp]); // VPS NAL header
}

it('parses an Annex F VPS representation and selects it for a dependent layer', () => {
  const vps = parseLayeredVps(makeTwoLayerVps());
  expect(vps.layerIds).toEqual([0, 1]);
  expect(vps.representationFormatIndices).toEqual([0, 0]);
  expect(vps.representationFormats).toEqual([
    {
      index: 0,
      width: 512,
      height: 256,
      chromaFormatIdc: 1,
      separateColourPlane: false,
      bitDepthLuma: 8,
      bitDepthChroma: 8,
      cropLeft: 0,
      cropRight: 0,
      cropTop: 0,
      cropBottom: 0,
    },
  ]);
  expect(selectLayerRepresentationFormat(vps, 1, false, null)).toEqual(
    vps.representationFormats[0],
  );
});

it('parses Annex F VPS VUI color, tile, wavefront, and layer restriction fields', () => {
  const vps = parseLayeredVps(makeTwoLayerVps(true));
  expect(vps.vui).toMatchObject({
    crossLayerPicTypeAligned: false,
    crossLayerIrapAligned: true,
    allLayersIdrAligned: true,
    bitRateAndPictureRate: [
      {
        layerSetIndex: 0,
        subLayerIndex: 0,
        averageBitRate: 11,
        maximumBitRate: 22,
        constantPictureRateIdc: 1,
        averagePictureRate: 50,
      },
      {
        layerSetIndex: 1,
        subLayerIndex: 0,
        averageBitRate: 33,
        maximumBitRate: 44,
        constantPictureRateIdc: 1,
        averagePictureRate: 50,
      },
    ],
    videoSignalInfo: [
      {
        videoFormat: 5,
        fullRange: true,
        colourPrimaries: 9,
        transferCharacteristics: 16,
        matrixCoefficients: 9,
      },
      {
        videoFormat: 2,
        fullRange: false,
        colourPrimaries: 1,
        transferCharacteristics: 1,
        matrixCoefficients: 1,
      },
    ],
    videoSignalInfoIndices: [0, 1],
    tilesNotInUse: false,
    tilesInUse: [true, true],
    loopFilterNotAcrossTiles: [true, false],
    tileBoundariesAligned: [
      [false, false],
      [true, false],
    ],
    wppNotInUse: false,
    wppInUse: [true, false],
    singleLayerForNonIrap: false,
    higherLayerIrapSkip: true,
    interLayerRestrictedRefLayers: true,
    bitstreamPartitionHrdPresent: false,
  });
});

it('infers VPS video-signal information for the active Annex F layer', () => {
  const vps = parseLayeredVps(makeTwoLayerVps(true));
  expect(
    getVpsVideoSignalInfoForSps(vps, {
      layerId: 1,
      multiLayerExtSps: false,
      vuiPresent: false,
    }),
  ).toEqual(vps.vui!.videoSignalInfo[1]);
  expect(
    getVpsVideoSignalInfoForSps(vps, {
      layerId: 0,
      multiLayerExtSps: false,
      vuiPresent: true,
    }),
  ).toBeNull();

  const independentLayerVps = { ...vps, directReferenceLayerIds: [[], []] };
  expect(
    getVpsVideoSignalInfoForSps(independentLayerVps, {
      layerId: 1,
      multiLayerExtSps: false,
      vuiPresent: true,
    }),
  ).toBeNull();
  expect(
    getVpsVideoSignalInfoForSps(independentLayerVps, {
      layerId: 1,
      multiLayerExtSps: true,
      vuiPresent: true,
    }),
  ).toEqual(vps.vui!.videoSignalInfo[1]);
  expect(
    getVpsVideoSignalInfoForSps(independentLayerVps, {
      layerId: 1,
      multiLayerExtSps: true,
      vuiPresent: false,
    }),
  ).toBeNull();
});

it('reads VPS video-signal records when their layer-index flag is absent', () => {
  const vps = parseLayeredVps(makeTwoLayerVps(true, false, false));
  expect(vps.vui).toMatchObject({
    videoSignalInfoIdxPresent: false,
    videoSignalInfo: [
      {
        videoFormat: 5,
        fullRange: true,
        colourPrimaries: 9,
        transferCharacteristics: 16,
        matrixCoefficients: 9,
      },
      {
        videoFormat: 2,
        fullRange: false,
        colourPrimaries: 1,
        transferCharacteristics: 1,
        matrixCoefficients: 1,
      },
    ],
    videoSignalInfoIndices: [0, 1],
  });
});

it('maps absent VPS signal indices densely when the base layer is external', () => {
  const vps = parseLayeredVps(makeTwoLayerVps(true, false, false, false));
  expect(vps.baseLayerInternal).toBe(false);
  expect(vps.vui).toMatchObject({
    videoSignalInfoIdxPresent: false,
    videoSignalInfo: [
      {
        videoFormat: 2,
        fullRange: false,
        colourPrimaries: 1,
        transferCharacteristics: 1,
        matrixCoefficients: 1,
      },
    ],
    videoSignalInfoIndices: [0, 0],
  });
});

it('consumes VPS VUI bitstream-partition HRD schedules', () => {
  const vps = parseLayeredVps(makeTwoLayerVps(true, true));
  expect(vps.vui?.bitstreamPartitionHrdPresent).toBe(true);
});

it('retains view identities and layer mapping from the official MV-HEVC conformance VPS', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvhevcs-a-qualcomm-3.bit', import.meta.url)),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    'f9358ead8ba3f7433713f4429d20ba7c75878a2a19090730026bb0926a2e9fa2',
  );
  const nals = splitAnnexB(bytes);
  const vpsNal = nals.find((nal) => nal.type === 32);
  if (!vpsNal) throw new Error('official MVHEVCS_A vector has no VPS');

  const vps = parseLayeredVps(vpsNal.data);
  expect(vps.representationFormats[0]).toMatchObject({ width: 1024, height: 768 });
  expect(vps.views).toEqual([
    { viewOrderIndex: 0, viewId: 1, layerIds: [0] },
    { viewOrderIndex: 1, viewId: 0, layerIds: [1] },
  ]);
  expect(vps.directReferenceLayerIds).toEqual([[], [0]]);
});

it('parses sample and motion dependency types from official MVHEVCS_H', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvhevcs-h-lge-3.bit', import.meta.url)),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    'beeba333856b8301ef938c4b503a98bb21ffcf28dd8f940785135acd877afda5',
  );
  const vpsNal = splitAnnexB(bytes).find((nal) => nal.type === 32);
  if (!vpsNal) throw new Error('official MVHEVCS_H vector has no VPS');

  const vps = parseLayeredVps(vpsNal.data);
  expect(vps.directReferenceLayerIds).toEqual([[], [0], [0, 1]]);
  expect(vps.directDependencyTypes).toEqual([
    [null, null, null],
    [2, null, null],
    [2, 2, null],
  ]);
});
