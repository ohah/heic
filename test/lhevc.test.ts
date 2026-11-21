import { describe, expect, it } from 'bun:test';
import {
  parseLayerSelector,
  parseLhevcDecoderConfigurationRecord,
  parseOperatingPointsInfo,
  parseTargetOutputLayerSet,
  resolveLhevcOutput,
} from '../src/container/lhevc';
import { getHeicInfo } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { parseLayeredSpsHeader } from '../src/hevc/sps';
import { box, buildHeif, codedFixture, full, u16, u32 } from './helpers/heif';

class BitWriter {
  private readonly bits: number[] = [];

  write(value: number, width: number): void {
    for (let shift = width - 1; shift >= 0; shift--)
      this.bits.push(Math.floor(value / 2 ** shift) % 2);
  }

  finish(): Uint8Array {
    while (this.bits.length % 8) this.bits.push(0);
    const bytes = new Uint8Array(this.bits.length / 8);
    for (let i = 0; i < this.bits.length; i++) bytes[i >> 3] |= this.bits[i] << (7 - (i & 7));
    return bytes;
  }
}

function makeOinf(frameRateInfo = false): Uint8Array {
  const bits = new BitWriter();
  bits.write(0, 8); // FullBox version
  bits.write(0, 24); // FullBox flags
  bits.write(0x4000, 16); // one scalability dimension
  bits.write(0, 2); // reserved
  bits.write(1, 6); // profile_tier_level_count
  bits.write(0, 2); // general_profile_space
  bits.write(0, 1); // general_tier_flag
  bits.write(1, 5); // general_profile_idc
  bits.write(0, 32); // general_profile_compatibility_flags
  bits.write(0, 48); // general_constraint_indicator_flags
  bits.write(120, 8); // general_level_idc
  bits.write(1, 16); // operating_point_count
  bits.write(1, 16); // output_layer_set_idx
  bits.write(1, 8); // max_temporal_id
  bits.write(2, 8); // num_layers_in_output_layer_set
  for (const layerId of [0, 1]) {
    bits.write(1, 8); // ptl_idx
    bits.write(layerId, 6);
    bits.write(1, 1); // is_output_layer
    bits.write(0, 1); // is_alternate_output_layer
  }
  bits.write(0, 16); // min_pic_width
  bits.write(0, 16); // min_pic_height
  bits.write(512, 16); // max_pic_width
  bits.write(256, 16); // max_pic_height
  bits.write(1, 2); // max_chroma_format
  bits.write(0, 3); // max_bit_depth_minus8
  bits.write(0, 1); // reserved
  bits.write(frameRateInfo ? 1 : 0, 1);
  bits.write(0, 1); // bit_rate_info_flag
  if (frameRateInfo) {
    bits.write(30 * 256, 16);
    bits.write(0, 6);
    bits.write(1, 2);
  }
  bits.write(1, 8); // max_layer_id
  bits.write(1, 8); // layer_id
  bits.write(1, 8); // num_directly_dependent_layers
  bits.write(0, 8); // direct_dependency_layer_id
  bits.write(1, 8); // dimension identifier
  return bits.finish();
}

describe('L-HEVC HEIF properties', () => {
  it('parses lhvC without mistaking it for hvcC', () => {
    const record = Uint8Array.from([
      1,
      0xf0,
      0x00,
      0xfc,
      0xe7,
      1, // v1, reserved bits, 4-byte NAL lengths, one array
      0xa1,
      0,
      1, // complete SPS array with one NAL
      0,
      2,
      0x42,
      0x09, // SPS at layer 1, temporal_id_plus1 1
    ]);
    const parsed = parseLhevcDecoderConfigurationRecord(record);
    expect(parsed.nalLengthSize).toBe(4);
    expect(parsed.arrays[0].nalUnits[0]).toMatchObject({ nalUnitType: 33, layerId: 1 });
  });

  it('reads the tols FullBox header before its 16-bit OLS index', () => {
    expect(parseTargetOutputLayerSet(Uint8Array.from([0, 0, 0, 0, 0, 1]))).toBe(1);
    expect(() => parseTargetOutputLayerSet(Uint8Array.from([0, 1]))).toThrow(
      'heic: invalid tols property length',
    );
    expect(() => parseTargetOutputLayerSet(Uint8Array.from([0, 0, 0, 1, 0, 1]))).toThrow(
      'heic: invalid tols FullBox version or flags',
    );
  });

  it('parses OLS membership and resolves base-layer dependencies', () => {
    const info = parseOperatingPointsInfo(makeOinf());
    expect(parseLayerSelector(Uint8Array.from([0, 1]))).toBe(1);
    expect(resolveLhevcOutput(info, 1, 1).requiredLayerIds).toEqual([0, 1]);
    expect(info.layerDependencies[0].dependsOnLayerIds).toEqual([0]);
  });

  it('rejects rate-info flags forbidden by the HEIF oinf constraints', () => {
    expect(() => parseOperatingPointsInfo(makeOinf(true))).toThrow(
      'oinf frame-rate info is prohibited for HEIF items',
    );
  });

  it('processes a required exbl reference on a scalably coded image item', () => {
    const base = codedFixture(),
      lhvC = Uint8Array.from([
        1, 0xf0, 0x00, 0xfc, 0xe7, 1, 0xa1, 0, 1, 0, 4, 0x42, 0x09, 0x0e, 0x85,
      ]),
      enhancement = {
        id: 2,
        type: 'lhv1',
        data: new Uint8Array(),
        properties: [
          box('lhvC', lhvC),
          box('oinf', makeOinf()),
          full('tols', 0, u16(1)),
          box('lsel', u16(1)),
          full('ispe', 0, u32(512), u32(256)),
          full('pixi', 0, Buffer.from([3, 8, 8, 8])),
          full('rref', 0, Buffer.from([1]), Buffer.from('exbl')),
        ],
        refs: [{ type: 'exbl', to: [base.id] }],
      },
      input = buildHeif([base, enhancement], enhancement.id),
      info = getHeicInfo(input, parseISOBMFF(input));

    expect(info.externalBaseLayerItemId).toBe(base.id);
    expect(info.lhevc?.targetLayerId).toBe(1);
  });

  it('parses the Annex F layer-1 SPS prefix separately from VPS format resolution', () => {
    // vps_id=0, sps_ext_or_max_sub_layers_minus1=7, sps_id=1,
    // update_rep_format_flag=0, log2_max_pic_order_cnt_lsb_minus4=4.
    const spsNal = Uint8Array.from([0x42, 0x09, 0x0e, 0x85]);
    expect(parseLayeredSpsHeader(spsNal)).toEqual({
      layerId: 1,
      videoParameterSetId: 0,
      spsExtOrMaxSubLayersMinus1: 7,
      spsId: 1,
      updateRepFormatFlag: false,
      spsRepFormatIndex: null,
      log2MaxPicOrderCntLsb: 8,
    });
  });
});
