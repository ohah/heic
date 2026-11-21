import { expect, it } from 'bun:test';
import { parsePps, resolvePpsScalingListData } from '../src/hevc/pps';
import { defaultScalingListData } from '../src/hevc/scaling';
import type { SpsInfo } from '../src/hevc/sps';
import type { LayeredVpsInfo } from '../src/hevc/vps';

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

  se(value: number): void {
    this.ue(value <= 0 ? -2 * value : 2 * value - 1);
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
    return Uint8Array.from([
      (34 << 1) | ((layerId >> 5) & 1),
      ((layerId & 31) << 3) | 1,
      ...escaped,
    ]);
  }
}

function makeVps(referenceLayerIds: number[][] = [[], [0]]): LayeredVpsInfo {
  return {
    vpsId: 0,
    maxSubLayersMinus1: 0,
    temporalIdNested: true,
    layerIds: referenceLayerIds.map((_, index) => index),
    referenceLayerIds,
    representationFormatIndices: Array<number>(referenceLayerIds.length).fill(0),
    representationFormats: [],
  };
}

function makePps(
  options: {
    ppsId?: number;
    layerId?: number;
    multilayerExtension?: boolean;
    inferScalingList?: boolean;
    scalingListDataPresent?: boolean;
    referenceLayerId?: number;
    referenceLocationOffsets?: boolean;
    colourMapping?: boolean;
    colourMappingRefLayerId?: number;
    colourMappingOctantDepth?: number;
    colourMappingYPartNumLog2?: number;
    colourMappingUDelta?: number;
    extension4bits?: number;
    extensionDataFlags?: readonly number[];
  } = {},
): Uint8Array {
  const {
    ppsId = 1,
    layerId = 1,
    multilayerExtension = true,
    inferScalingList = true,
    scalingListDataPresent = false,
    referenceLayerId = 0,
    referenceLocationOffsets = false,
    colourMapping = false,
    colourMappingRefLayerId = 0,
    colourMappingOctantDepth = 1,
    colourMappingYPartNumLog2 = 0,
    colourMappingUDelta = -1,
    extension4bits = 0,
    extensionDataFlags = [],
  } = options;
  const w = new BitWriter();
  w.ue(ppsId); // pps_pic_parameter_set_id
  w.ue(1); // pps_seq_parameter_set_id
  w.write(0, 1); // dependent_slice_segments_enabled_flag
  w.write(0, 1); // output_flag_present_flag
  w.write(0, 3); // num_extra_slice_header_bits
  w.write(0, 1); // sign_data_hiding_enabled_flag
  w.write(0, 1); // cabac_init_present_flag
  w.ue(0); // num_ref_idx_l0_default_active_minus1
  w.ue(0); // num_ref_idx_l1_default_active_minus1
  w.se(0); // init_qp_minus26
  w.write(0, 1); // constrained_intra_pred_flag
  w.write(0, 1); // transform_skip_enabled_flag
  w.write(0, 1); // cu_qp_delta_enabled_flag
  w.se(0); // cb_qp_offset
  w.se(0); // cr_qp_offset
  w.write(0, 1); // slice_chroma_qp_offsets_present_flag
  w.write(0, 1); // weighted_pred_flag
  w.write(0, 1); // weighted_bipred_flag
  w.write(0, 1); // transquant_bypass_enabled_flag
  w.write(0, 1); // tiles_enabled_flag
  w.write(0, 1); // entropy_coding_sync_enabled_flag
  w.write(1, 1); // loop_filter_across_slices_enabled_flag
  w.write(0, 1); // deblocking_filter_control_present_flag
  w.write(Number(scalingListDataPresent), 1); // pps_scaling_list_data_present_flag
  if (scalingListDataPresent) {
    for (let sizeId = 0; sizeId < 4; sizeId++) {
      for (let matrixId = 0; matrixId < 6; matrixId += sizeId === 3 ? 3 : 1) {
        w.write(0, 1); // scaling_list_pred_mode_flag
        w.ue(0); // scaling_list_pred_matrix_id_delta -> default list
      }
    }
  }
  w.write(0, 1); // lists_modification_present_flag
  w.ue(0); // log2_parallel_merge_level_minus2
  w.write(0, 1); // slice_segment_header_extension_present_flag
  w.write(1, 1); // pps_extension_present_flag
  w.write(0, 1); // pps_range_extension_flag
  w.write(Number(multilayerExtension), 1); // pps_multilayer_extension_flag
  w.write(0, 1); // pps_3d_extension_flag
  w.write(0, 1); // pps_scc_extension_flag
  w.write(extension4bits, 4); // pps_extension_4bits
  if (multilayerExtension) {
    w.write(0, 1); // poc_reset_info_present_flag
    w.write(Number(inferScalingList), 1); // pps_infer_scaling_list_flag
    if (inferScalingList) w.write(referenceLayerId, 6); // pps_scaling_list_ref_layer_id
    w.ue(Number(referenceLocationOffsets)); // num_ref_loc_offsets
    if (referenceLocationOffsets) {
      w.write(0, 6); // ref_loc_offset_layer_id
      w.write(1, 1); // scaled_ref_layer_offset_present_flag
      for (const offset of [-1, 2, -3, 4]) w.se(offset);
      w.write(1, 1); // ref_region_offset_present_flag
      for (const offset of [1, -2, 3, -4]) w.se(offset);
      w.write(1, 1); // resample_phase_set_present_flag
      for (const phase of [0, 1, 2, 3]) w.ue(phase);
    }
    w.write(Number(colourMapping), 1); // colour_mapping_enabled_flag
    if (colourMapping) {
      w.ue(0); // num_cm_ref_layers_minus1
      w.write(colourMappingRefLayerId, 6); // cm_ref_layer_id[0]
      w.write(colourMappingOctantDepth, 2); // cm_octant_depth
      w.write(colourMappingYPartNumLog2, 2); // cm_y_part_num_log2
      w.ue(0); // luma_bit_depth_cm_input_minus8: 8-bit
      w.ue(0); // chroma_bit_depth_cm_input_minus8: 8-bit
      w.ue(2); // luma_bit_depth_cm_output_minus8: 10-bit
      w.ue(2); // chroma_bit_depth_cm_output_minus8: 10-bit
      w.write(2, 2); // cm_res_quant_bits
      w.write(1, 2); // cm_delta_flc_bits_minus1: 2 bits
      w.se(colourMappingUDelta); // cm_adapt_threshold_u_delta
      w.se(2); // cm_adapt_threshold_v_delta
      w.write(1, 1); // root split_octant_flag
      for (let octant = 0; octant < 8; octant++) {
        for (let cell = 0; cell < 4; cell++) {
          const coded = octant === 0 && cell === 0;
          w.write(Number(coded), 1); // coded_res_flag
          if (coded) {
            w.ue(0); // Y res_coeff_q
            w.write(0, 4); // Y res_coeff_r; CMResLSBits = 4
            w.ue(2); // Cb res_coeff_q
            w.write(5, 4); // Cb res_coeff_r
            w.write(1, 1); // Cb res_coeff_sign_flag
            w.ue(0); // Cr res_coeff_q
            w.write(0, 4); // Cr res_coeff_r
          }
        }
      }
    }
  }
  for (const flag of extensionDataFlags) w.write(flag, 1); // ignored pps_extension_data_flag
  return w.toNal(layerId);
}

it('parses Annex F PPS scaling-list inference and reference-location syntax', () => {
  const pps = parsePps(makePps({ referenceLocationOffsets: true }), {
    allowMultilayerExtension: true,
    layeredVps: makeVps(),
  });
  expect(pps).toMatchObject({
    layerId: 1,
    ppsId: 1,
    spsId: 1,
    multilayerExtension: true,
    pocResetInfoPresent: false,
    scalingListInferred: true,
    scalingListRefLayerId: 0,
    referenceLocationOffsets: [
      {
        refLocLayerId: 0,
        scaledRefLayerOffsets: [-1, 2, -3, 4],
        refRegionOffsets: [1, -2, 3, -4],
        resamplePhases: [0, 1, 2, 3],
      },
    ],
    colourMappingTable: null,
  });
});

it('parses Annex F PPS colour mapping table octants and residual values', () => {
  const pps = parsePps(makePps({ colourMapping: true }), {
    allowMultilayerExtension: true,
    layeredVps: makeVps(),
  });
  const table = pps.colourMappingTable;
  expect(table).not.toBeNull();
  expect(table).toMatchObject({
    numCmRefLayersMinus1: 0,
    cmRefLayerIds: [0],
    cmOctantDepth: 1,
    cmYPartNumLog2: 0,
    lumaBitDepthCmInput: 8,
    chromaBitDepthCmInput: 8,
    lumaBitDepthCmOutput: 10,
    chromaBitDepthCmOutput: 10,
    cmResQuantBits: 2,
    cmDeltaFlcBitsMinus1: 1,
    cmAdaptThresholdUDelta: -1,
    cmAdaptThresholdVDelta: 2,
  });
  expect(table!.octants.children).toHaveLength(8);
  expect(table!.octants.yParts).toEqual([]);
  expect(table!.octants.children[0]!.yParts[0]![0]).toEqual({
    components: [
      { resCoeffQ: 0, resCoeffR: 0, resCoeffSignFlag: null },
      { resCoeffQ: 2, resCoeffR: 5, resCoeffSignFlag: true },
      { resCoeffQ: 0, resCoeffR: 0, resCoeffSignFlag: null },
    ],
  });
  expect(table!.octants.children[0]!.yParts[0]![1]).toEqual({ components: null });
  expect(table!.octants.children.slice(1).every((octant) => octant.yParts.length === 1)).toBe(true);
});

it('rejects reserved Annex F colour mapping octant dimensions and layer ids', () => {
  expect(() =>
    parsePps(makePps({ colourMapping: true, colourMappingOctantDepth: 2 }), {
      allowMultilayerExtension: true,
    }),
  ).toThrow(/invalid PPS colour mapping octant dimensions/);
  expect(() =>
    parsePps(makePps({ colourMapping: true, colourMappingYPartNumLog2: 3 }), {
      allowMultilayerExtension: true,
    }),
  ).toThrow(/invalid PPS colour mapping octant dimensions/);
  expect(() =>
    parsePps(makePps({ colourMapping: true, colourMappingRefLayerId: 63 }), {
      allowMultilayerExtension: true,
    }),
  ).toThrow(/invalid or duplicate PPS colour mapping reference layer/);
  expect(() =>
    parsePps(makePps({ colourMapping: true, colourMappingRefLayerId: 1 }), {
      allowMultilayerExtension: true,
      layeredVps: makeVps(),
    }),
  ).toThrow(/not a direct reference layer/);
  expect(() =>
    parsePps(makePps({ colourMapping: true, ppsId: 8 }), {
      allowMultilayerExtension: true,
    }),
  ).toThrow(/forbidden for PPS ids/);
  expect(() =>
    parsePps(makePps({ colourMapping: true, colourMappingUDelta: 128 }), {
      allowMultilayerExtension: true,
    }),
  ).toThrow(/adaptation threshold is out of range/);
});

it('rejects unsupported or nonconforming PPS scaling-list inference', () => {
  expect(() => parsePps(makePps())).toThrow(/unsupported PPS extension/);
  expect(() =>
    parsePps(makePps({ layerId: 0 }), { allowBaseLayerMultilayerExtension: true }),
  ).toThrow(/inference is forbidden/);
  expect(() =>
    parsePps(makePps({ referenceLayerId: 0 }), {
      allowMultilayerExtension: true,
      layeredVps: makeVps([[], []]),
    }),
  ).toThrow(/not a reference layer/);
  expect(() =>
    parsePps(makePps({ referenceLayerId: 63 }), { allowMultilayerExtension: true }),
  ).toThrow(/reference layer is reserved/);
});

it('allows reserved PPS extension bits and ignores their extension data flags', () => {
  const pps = parsePps(
    makePps({
      layerId: 0,
      multilayerExtension: false,
      extension4bits: 0b1010,
      extensionDataFlags: [1, 0, 1, 1],
    }),
  );
  expect(pps.layerId).toBe(0);
  expect(pps.multilayerExtension).toBe(false);
});

it('rejects PPS-inferred lists when the same PPS carries explicit scaling-list data', () => {
  expect(() =>
    parsePps(makePps({ scalingListDataPresent: true }), { allowMultilayerExtension: true }),
  ).toThrow(/inference is forbidden/);
});

function scalingSps(layerId: number, scalingListData = defaultScalingListData()): SpsInfo {
  return {
    layerId,
    spsId: 1,
    scalingListEnabled: true,
    scalingListInferred: false,
    scalingListRefLayerId: null,
    scalingListData,
  } as SpsInfo;
}

it('resolves PPS scaling-list inference from the active reference-layer PPS', () => {
  const vps = makeVps();
  const referenceSps = scalingSps(0);
  const targetSps = scalingSps(1);
  const referencePps = parsePps(
    makePps({ layerId: 0, inferScalingList: false, scalingListDataPresent: true }),
    { allowBaseLayerMultilayerExtension: true },
  );
  const targetPps = parsePps(makePps(), { allowMultilayerExtension: true, layeredVps: vps });

  expect(
    resolvePpsScalingListData(
      targetPps,
      new Map([
        [0, referencePps],
        [1, targetPps],
      ]),
      new Map([
        [0, referenceSps],
        [1, targetSps],
      ]),
      vps,
    ),
  ).toEqual(referencePps.scalingListData);
});

it('uses the active SPS scaling lists when the active PPS does not infer or override them', () => {
  const vps = makeVps();
  const activeSps = scalingSps(1);
  const activePps = parsePps(makePps({ inferScalingList: false, multilayerExtension: false }), {
    allowMultilayerExtension: true,
  });
  expect(
    resolvePpsScalingListData(activePps, new Map([[1, activePps]]), new Map([[1, activeSps]]), vps),
  ).toEqual(activeSps.scalingListData);
});

it('rejects PPS inference when the active reference PPS also infers lists', () => {
  const vps = makeVps([[], [0], [0, 1]]);
  const basePps = parsePps(
    makePps({ layerId: 0, inferScalingList: false, multilayerExtension: false }),
    { allowBaseLayerMultilayerExtension: true },
  );
  const inferredReferencePps = parsePps(makePps(), {
    allowMultilayerExtension: true,
    layeredVps: vps,
  });
  const targetPps = parsePps(makePps({ layerId: 2, referenceLayerId: 1 }), {
    allowMultilayerExtension: true,
    layeredVps: vps,
  });
  expect(() =>
    resolvePpsScalingListData(
      targetPps,
      new Map([
        [0, basePps],
        [1, inferredReferencePps],
        [2, targetPps],
      ]),
      new Map([
        [0, scalingSps(0)],
        [1, scalingSps(1)],
        [2, scalingSps(2)],
      ]),
      vps,
    ),
  ).toThrow(/must not itself infer/);
});
