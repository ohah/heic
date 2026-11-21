import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { decodeHeic, decodeHeicAuxiliaryPlanes } from '../src/decoder';
import { getHeicInfo } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { decodeLayeredHevcPicture } from '../src/hevc/layered-picture';
import { isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal';
import { parseLayeredVps } from '../src/hevc/vps';
import { decodeItemPlanes } from '../src/planes';
import type { Planes } from '../src/planes';
import { box, buildHeif, full, u16, u32 } from './helpers/heif';

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

function makeLhevcConfiguration(nals: ReturnType<typeof splitAnnexB>): Uint8Array {
  const arrays = [32, 33, 34].map((nalType) => {
    const parameterSets = nals.filter((nal) => nal.type === nalType);
    return Buffer.concat([
      Buffer.from([0x80 | nalType]),
      u16(parameterSets.length),
      ...parameterSets.flatMap((nal) => [u16(nal.data.length), nal.data]),
    ]);
  });
  return Buffer.concat([Buffer.from([1, 0xf0, 0, 0xfc, 0xcf, arrays.length]), ...arrays]);
}

function makeMvHevcOinf(directlyDependent = true): Uint8Array {
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
  bits.write(0, 8); // max_temporal_id
  bits.write(2, 8); // num_layers_in_output_layer_set
  for (const layerId of [0, 1]) {
    bits.write(1, 8); // ptl_idx
    bits.write(layerId, 6);
    bits.write(1, 1); // is_output_layer
    bits.write(0, 1); // is_alternate_output_layer
  }
  bits.write(0, 16); // min_pic_width
  bits.write(0, 16); // min_pic_height
  bits.write(1024, 16); // max_pic_width
  bits.write(768, 16); // max_pic_height
  bits.write(1, 2); // max_chroma_format
  bits.write(0, 3); // max_bit_depth_minus8
  bits.write(0, 1); // reserved
  bits.write(0, 1); // frame_rate_info_flag
  bits.write(0, 1); // bit_rate_info_flag
  bits.write(1, 8); // max_layer_id
  bits.write(1, 8); // layer_id
  bits.write(directlyDependent ? 1 : 0, 8); // num_directly_dependent_layers
  if (directlyDependent) bits.write(0, 8); // direct_dependency_layer_id
  bits.write(1, 8); // dimension identifier
  return bits.finish();
}

function makeThreeViewMvHevcOinf(): Uint8Array {
  const bits = new BitWriter();
  bits.write(0, 8); // FullBox version
  bits.write(0, 24); // FullBox flags
  bits.write(0x4000, 16); // one scalability dimension
  bits.write(0, 2); // reserved
  bits.write(2, 6); // profile_tier_level_count
  for (const profileIdc of [1, 2]) {
    bits.write(0, 2); // general_profile_space
    bits.write(0, 1); // general_tier_flag
    bits.write(profileIdc, 5);
    bits.write(0, 32); // general_profile_compatibility_flags
    bits.write(0, 48); // general_constraint_indicator_flags
    bits.write(120, 8); // general_level_idc
  }
  bits.write(1, 16); // operating_point_count
  bits.write(3, 16); // three-view output layer set
  bits.write(0, 8); // max_temporal_id
  bits.write(3, 8); // num_layers_in_output_layer_set
  for (const layerId of [0, 1, 2]) {
    bits.write(layerId === 0 ? 1 : 2, 8); // ptl_idx
    bits.write(layerId, 6);
    bits.write(1, 1); // is_output_layer
    bits.write(0, 1); // is_alternate_output_layer
  }
  bits.write(0, 16); // min_pic_width
  bits.write(0, 16); // min_pic_height
  bits.write(1024, 16); // max_pic_width
  bits.write(768, 16); // max_pic_height
  bits.write(1, 2); // max_chroma_format
  bits.write(0, 3); // max_bit_depth_minus8
  bits.write(0, 1); // reserved
  bits.write(0, 1); // frame_rate_info_flag
  bits.write(0, 1); // bit_rate_info_flag
  bits.write(2, 8); // dependency-entry count
  for (const layerId of [1, 2]) {
    bits.write(layerId, 8);
    bits.write(1, 8); // num_directly_dependent_layers
    bits.write(0, 8); // direct_dependency_layer_id: both side views depend on base layer 0
    bits.write(layerId, 8); // view dimension identifier
  }
  return bits.finish();
}

function makeDepthMvHevcOinf(): Uint8Array {
  const bits = new BitWriter();
  bits.write(0, 8); // FullBox version
  bits.write(0, 24); // FullBox flags
  bits.write(0x4000, 16); // one view-dimension scalability flag
  bits.write(0, 2); // reserved
  bits.write(2, 6); // profile_tier_level_count
  for (const profileIdc of [1, 6]) {
    bits.write(0, 2); // general_profile_space
    bits.write(0, 1); // general_tier_flag
    bits.write(profileIdc, 5);
    bits.write(0, 32); // general_profile_compatibility_flags
    bits.write(0, 48); // general_constraint_indicator_flags
    bits.write(153, 8); // general_level_idc: 5.1
  }
  bits.write(1, 16); // operating_point_count
  bits.write(1, 16); // output_layer_set_idx
  bits.write(0, 8); // max_temporal_id
  bits.write(6, 8); // six layers in the output layer set
  for (const layerId of [0, 1, 2, 3, 4, 5]) {
    bits.write(layerId < 3 ? 1 : 2, 8); // PTL index
    bits.write(layerId, 6);
    bits.write(layerId === 5 ? 1 : 0, 1); // only depth view 2 is selected for output
    bits.write(0, 1); // is_alternate_output_layer
  }
  bits.write(0, 16); // min_pic_width
  bits.write(0, 16); // min_pic_height
  bits.write(1024, 16); // max_pic_width
  bits.write(768, 16); // max_pic_height
  bits.write(1, 2); // max_chroma_format
  bits.write(0, 3); // max_bit_depth_minus8
  bits.write(0, 1); // reserved
  bits.write(0, 1); // frame_rate_info_flag
  bits.write(0, 1); // bit_rate_info_flag
  bits.write(5, 8); // dependency entries for non-base layers
  const dependencies = new Map([
    [1, [0]],
    [2, [0, 1]],
    [3, []],
    [4, [3]],
    [5, [3, 4]],
  ]);
  for (const [layerId, referenceLayerIds] of dependencies) {
    bits.write(layerId, 8);
    bits.write(referenceLayerIds.length, 8);
    for (const referenceLayerId of referenceLayerIds) bits.write(referenceLayerId, 8);
    bits.write(layerId % 3, 8); // view dimension identifier
  }
  return bits.finish();
}

function makeBaseMvHevcOinf(): Uint8Array {
  const bits = new BitWriter();
  bits.write(0, 8); // FullBox version
  bits.write(0, 24); // FullBox flags
  bits.write(0x4000, 16); // one view-dimension scalability flag
  bits.write(0, 2); // reserved
  bits.write(1, 6); // profile_tier_level_count
  bits.write(0, 2); // general_profile_space
  bits.write(0, 1); // general_tier_flag
  bits.write(1, 5); // general_profile_idc: Main
  bits.write(0, 32); // general_profile_compatibility_flags
  bits.write(0, 48); // general_constraint_indicator_flags
  bits.write(153, 8); // general_level_idc: 5.1
  bits.write(1, 16); // operating_point_count
  bits.write(1, 16); // output_layer_set_idx
  bits.write(0, 8); // max_temporal_id
  bits.write(1, 8); // one layer in the output layer set
  bits.write(1, 8); // PTL index
  bits.write(0, 6); // base layer ID
  bits.write(1, 1); // is_output_layer
  bits.write(0, 1); // is_alternate_output_layer
  bits.write(0, 16); // min_pic_width
  bits.write(0, 16); // min_pic_height
  bits.write(1024, 16); // max_pic_width
  bits.write(768, 16); // max_pic_height
  bits.write(1, 2); // max_chroma_format
  bits.write(0, 3); // max_bit_depth_minus8
  bits.write(0, 1); // reserved
  bits.write(0, 1); // frame_rate_info_flag
  bits.write(0, 1); // bit_rate_info_flag
  bits.write(0, 8); // no non-base layer dependency entries
  return bits.finish();
}

function lengthPrefix(nals: readonly { data: Uint8Array }[]): Uint8Array {
  return Buffer.concat(nals.flatMap((nal) => [u32(nal.data.length), nal.data]));
}

function decodedPictureHash(nal: Uint8Array): string[] | null {
  const rbsp = toRbsp(nal);
  let position = 0;
  while (position < rbsp.length) {
    let payloadType = 0;
    while (position < rbsp.length && rbsp[position] === 255) {
      payloadType += 255;
      position++;
    }
    if (position >= rbsp.length) return null;
    payloadType += rbsp[position++];

    let payloadSize = 0;
    while (position < rbsp.length && rbsp[position] === 255) {
      payloadSize += 255;
      position++;
    }
    if (position >= rbsp.length) return null;
    payloadSize += rbsp[position++];
    const payload = rbsp.subarray(position, position + payloadSize);
    if (payload.length !== payloadSize) return null;
    position += payloadSize;

    if (payloadType !== 132) continue;
    if (payload[0] !== 0 || payload.length !== 49)
      throw new Error('MVHEVCS_B decoded_picture_hash must contain three MD5 values');
    return [0, 1, 2].map((component) =>
      Buffer.from(payload.subarray(1 + component * 16, 17 + component * 16)).toString('hex'),
    );
  }
  return null;
}

it('decodes both views of the official MVHEVCS_A vector to its H.265.1 output hashes', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvhevcs-a-qualcomm-3.bit', import.meta.url)),
  );
  const nals = splitAnnexB(bytes);
  const parameterSets = nals.filter((nal) => [32, 33, 34].includes(nal.type));
  const slices = nals.filter((nal) => isSliceNal(nal.type));
  expect(slices).toHaveLength(96);

  const history = new Map<number, Planes[]>([
    [0, []],
    [1, []],
  ]);
  const outputByLayer = new Map<number, Map<number, Planes>>([
    [0, new Map()],
    [1, new Map()],
  ]);

  for (let index = 0; index < slices.length; index += 2) {
    const accessUnit = slices.slice(index, index + 2);
    expect(accessUnit.map((nal) => nal.layerId)).toEqual([0, 1]);
    const decodedLayers = new Map<number, Planes>();
    const temporalReferences = new Map<number, readonly Planes[]>([
      [0, history.get(0)!],
      [1, history.get(1)!],
    ]);

    decodeLayeredHevcPicture(
      [...parameterSets, ...accessUnit],
      [0, 1],
      1,
      undefined,
      temporalReferences,
      decodedLayers,
    );

    for (const layerId of [0, 1]) {
      const planes = decodedLayers.get(layerId);
      if (!planes || planes.pictureOrderCnt === undefined)
        throw new Error(`official MVHEVCS_A access unit ${index / 2} omitted layer ${layerId}`);
      history.get(layerId)!.push(planes);
      outputByLayer.get(layerId)!.set(planes.pictureOrderCnt, planes);
    }
  }

  const expectedMd5 = new Map([
    [0, '2a453ecf60a17a684dca4c51b11ae16e'],
    [1, '1a4e8e78b1526fe17b35f73144d25649'],
  ]);
  for (const layerId of [0, 1]) {
    const frames = [...outputByLayer.get(layerId)!.entries()].sort(([pocA], [pocB]) => pocA - pocB);
    expect(frames).toHaveLength(48);
    const hash = createHash('md5');
    for (const [, planes] of frames) {
      hash.update(planes.y);
      hash.update(planes.cb);
      hash.update(planes.cr);
    }
    expect(hash.digest('hex')).toBe(expectedMd5.get(layerId));
  }
}, 20_000);

it('decodes an MV-HEVC output layer through an lhv1 HEIF item', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvhevcs-a-qualcomm-3.bit', import.meta.url)),
  );
  const nals = splitAnnexB(bytes);
  const parameterSets = nals.filter((nal) => [32, 33, 34].includes(nal.type));
  const accessUnit = nals.filter((nal) => isSliceNal(nal.type)).slice(0, 2);
  expect(accessUnit.map((nal) => nal.layerId)).toEqual([0, 1]);

  const input = buildHeif(
    [
      {
        id: 1,
        type: 'lhv1',
        data: lengthPrefix(accessUnit),
        properties: [
          box('lhvC', makeLhevcConfiguration(nals)),
          box('oinf', makeMvHevcOinf()),
          full('tols', 0, u16(1)),
          box('lsel', u16(1)),
          full('ispe', 0, u32(1024), u32(768)),
        ],
      },
    ],
    1,
  );
  const boxes = parseISOBMFF(input);
  const info = getHeicInfo(input, boxes, 1);
  const decodedLayers = new Map<number, Planes>();
  const expected = decodeLayeredHevcPicture(
    [...parameterSets, ...accessUnit],
    [0, 1],
    1,
    undefined,
    new Map(),
    decodedLayers,
  );
  const outputLayer = decodeItemPlanes(input, boxes, info, 1);
  const image = decodeHeic(input, { applyTransforms: false });

  expect(info.lhevc?.requiredLayerIds).toEqual([0, 1]);
  expect(outputLayer.y).toEqual(expected.y);
  expect(outputLayer.cb).toEqual(expected.cb);
  expect(outputLayer.cr).toEqual(expected.cr);
  expect(image.width).toBe(1024);
  expect(image.height).toBe(768);
}, 20_000);

it('decodes both different-resolution views of official MVHEVCS_D', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvhevcs-d-ntt-3.bit', import.meta.url)),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    '63748a77948e4d3669b04a65eee04025eb8a92feb3a03a365260ce4145ee9e49',
  );

  const nals = splitAnnexB(bytes);
  const parameterSets = nals.filter((nal) => [32, 33, 34].includes(nal.type));
  const slices = nals.filter((nal) => isSliceNal(nal.type));
  expect(slices).toHaveLength(50);

  const history = new Map<number, Planes[]>([
    [0, []],
    [1, []],
  ]);
  const outputByLayer = new Map<number, Map<number, Planes>>([
    [0, new Map()],
    [1, new Map()],
  ]);

  for (let index = 0; index < slices.length; index += 2) {
    const accessUnit = slices.slice(index, index + 2);
    expect(accessUnit.map((nal) => nal.layerId)).toEqual([0, 1]);

    const decodedLayers = new Map<number, Planes>();
    decodeLayeredHevcPicture(
      [...parameterSets, ...accessUnit],
      [0, 1],
      1,
      undefined,
      new Map([
        [0, history.get(0)!],
        [1, history.get(1)!],
      ]),
      decodedLayers,
    );

    for (const layerId of [0, 1]) {
      const planes = decodedLayers.get(layerId);
      if (!planes || planes.pictureOrderCnt === undefined)
        throw new Error(`official MVHEVCS_D access unit ${index / 2} omitted layer ${layerId}`);
      expect([planes.width, planes.height]).toEqual(layerId === 0 ? [1024, 768] : [512, 384]);
      history.get(layerId)!.push(planes);
      outputByLayer.get(layerId)!.set(planes.pictureOrderCnt, planes);
    }
  }

  const expectedMd5 = new Map([
    [0, 'f16251dba49bcdd1b335a5d3606f6934'],
    [1, '057324b23febaaa790b948cca009178b'],
  ]);
  for (const layerId of [0, 1]) {
    const frames = [...outputByLayer.get(layerId)!.entries()].sort(([pocA], [pocB]) => pocA - pocB);
    expect(frames.map(([poc]) => poc)).toEqual(Array.from({ length: 25 }, (_, poc) => poc));
    const hash = createHash('md5');
    for (const [, planes] of frames) {
      hash.update(planes.y);
      hash.update(planes.cb);
      hash.update(planes.cr);
    }
    expect(hash.digest('hex')).toBe(expectedMd5.get(layerId));
  }
}, 30_000);

it('decodes both same-resolution simulcast views in official MVHEVCS_C', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvhevcs-c-sony-3.bit', import.meta.url)),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    '336285436cf02ccff6af42f49786d7b4744ae5494b1a585120a6225e44fde9e7',
  );

  const nals = splitAnnexB(bytes);
  const parameterSets = nals.filter((nal) => [32, 33, 34].includes(nal.type));
  const slices = nals.filter((nal) => isSliceNal(nal.type));
  expect(slices).toHaveLength(60);

  const history = new Map<number, Planes[]>([
    [0, []],
    [1, []],
  ]);
  const outputByLayer = new Map<number, Map<number, Planes>>([
    [0, new Map()],
    [1, new Map()],
  ]);

  for (let index = 0; index < slices.length; index += 2) {
    const accessUnit = slices.slice(index, index + 2);
    expect(accessUnit.map((nal) => nal.layerId)).toEqual([0, 1]);

    const decodedLayers = new Map<number, Planes>();
    decodeLayeredHevcPicture(
      [...parameterSets, ...accessUnit],
      [0, 1],
      1,
      undefined,
      new Map([
        [0, history.get(0)!],
        [1, history.get(1)!],
      ]),
      decodedLayers,
    );

    for (const layerId of [0, 1]) {
      const planes = decodedLayers.get(layerId);
      if (!planes || planes.pictureOrderCnt === undefined)
        throw new Error(`official MVHEVCS_C access unit ${index / 2} omitted layer ${layerId}`);
      expect([planes.width, planes.height]).toEqual([1024, 768]);
      history.get(layerId)!.push(planes);
      outputByLayer.get(layerId)!.set(planes.pictureOrderCnt, planes);
    }
  }

  const expectedMd5 = new Map([
    [0, '6b5d705225c00d0cc196fe0a2fadd925'],
    [1, 'e1cfc2a8ba3d72dd6c294f6511e8a362'],
  ]);
  for (const layerId of [0, 1]) {
    const frames = [...outputByLayer.get(layerId)!.entries()].sort(([pocA], [pocB]) => pocA - pocB);
    expect(frames.map(([poc]) => poc)).toEqual(Array.from({ length: 30 }, (_, poc) => poc));
    const hash = createHash('md5');
    for (const [, planes] of frames) {
      hash.update(planes.y);
      hash.update(planes.cb);
      hash.update(planes.cr);
    }
    expect(hash.digest('hex')).toBe(expectedMd5.get(layerId));
  }

  const firstAccessUnit = slices.slice(0, 2);
  const input = buildHeif(
    [
      {
        id: 1,
        type: 'lhv1',
        data: lengthPrefix(firstAccessUnit),
        properties: [
          box('lhvC', makeLhevcConfiguration(nals)),
          box('oinf', makeMvHevcOinf(false)),
          full('tols', 0, u16(1)),
          box('lsel', u16(1)),
          full('ispe', 0, u32(1024), u32(768)),
        ],
      },
    ],
    1,
  );
  const boxes = parseISOBMFF(input);
  const info = getHeicInfo(input, boxes, 1);
  const selectedPlanes = decodeItemPlanes(input, boxes, info, 1);
  const image = decodeHeic(input, { applyTransforms: false });
  const expectedLayers = new Map<number, Planes>();
  decodeLayeredHevcPicture(
    [...parameterSets, ...firstAccessUnit],
    [0, 1],
    1,
    undefined,
    new Map(),
    expectedLayers,
  );

  expect(info.lhevc?.requiredLayerIds).toEqual([1]);
  expect(selectedPlanes.y).toEqual(expectedLayers.get(1)?.y);
  expect(selectedPlanes.cb).toEqual(expectedLayers.get(1)?.cb);
  expect(selectedPlanes.cr).toEqual(expectedLayers.get(1)?.cr);
  expect(image.width).toBe(1024);
  expect(image.height).toBe(768);
}, 30_000);

it('decodes all-intra inter-view prediction in official MVHEVCS_B', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvhevcs-b-sharp-3.bit', import.meta.url)),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    'bd34a09a13754b290c435f34744c53d41dec004b5796e03520b19f2c5d088696',
  );

  const nals = splitAnnexB(bytes);
  const parameterSets = nals.filter((nal) => [32, 33, 34].includes(nal.type));
  const slices = nals.filter((nal) => isSliceNal(nal.type));
  expect(slices).toHaveLength(128);

  const expectedByLayer = new Map<number, string[][]>([
    [0, []],
    [1, []],
  ]);
  for (const nal of nals) {
    if (nal.type !== 40) continue;
    const hashes = decodedPictureHash(nal.data);
    if (hashes) expectedByLayer.get(nal.layerId)?.push(hashes);
  }
  expect(expectedByLayer.get(0)).toHaveLength(64);
  expect(expectedByLayer.get(1)).toHaveLength(64);

  const history = new Map<number, Planes[]>([
    [0, []],
    [1, []],
  ]);
  for (let index = 0; index < slices.length; index += 2) {
    const accessUnit = slices.slice(index, index + 2);
    expect(accessUnit.map((nal) => nal.layerId)).toEqual([0, 1]);
    const decodedLayers = new Map<number, Planes>();
    decodeLayeredHevcPicture(
      [...parameterSets, ...accessUnit],
      [0, 1],
      1,
      undefined,
      new Map([
        // MVHEVCS_B codes every base-view picture as I; only the P-coded
        // enhancement view needs prior POC state for its inter-view slices.
        [0, []],
        [1, history.get(1)!],
      ]),
      decodedLayers,
    );

    for (const layerId of [0, 1]) {
      const planes = decodedLayers.get(layerId);
      if (!planes || planes.pictureOrderCnt === undefined)
        throw new Error(`official MVHEVCS_B access unit ${index / 2} omitted layer ${layerId}`);
      if (layerId === 1) {
        expect(planes.pictureOrderCnt).toBe(index / 2);
        const base = decodedLayers.get(0)!;
        expect([planes.width, planes.height]).toEqual([base.width, base.height]);
      }
      const actualHashes = [planes.y, planes.cb, planes.cr].map((plane) =>
        createHash('md5').update(plane).digest('hex'),
      );
      expect(actualHashes).toEqual(expectedByLayer.get(layerId)![index / 2]);
      if (layerId === 1) history.get(layerId)!.push(planes);
    }
  }
}, 30_000);

it('decodes the official MVHEVCS_E hierarchical-B inter-view sequence', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvhevcs-e-qualcomm-3.bit', import.meta.url)),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    'b83890b9691a496d37dae27dea81fd0ede1905e2a757d46646ce257e105de630',
  );

  const nals = splitAnnexB(bytes);
  const parameterSets = nals.filter((nal) => [32, 33, 34].includes(nal.type));
  const slices = nals.filter((nal) => isSliceNal(nal.type));
  expect(slices).toHaveLength(96);

  const history = new Map<number, Planes[]>([
    [0, []],
    [1, []],
  ]);
  const outputByLayer = new Map<number, Map<number, Planes>>([
    [0, new Map()],
    [1, new Map()],
  ]);

  for (let index = 0; index < slices.length; index += 2) {
    const accessUnit = slices.slice(index, index + 2);
    expect(accessUnit.map((nal) => nal.layerId)).toEqual([0, 1]);

    const decodedLayers = new Map<number, Planes>();
    // IDR/CRA pictures that are intra-coded need their POC LSB but have no
    // prediction references. Keep prior decoded pictures in the harness for
    // subsequent leading pictures, while passing an empty reference list to
    // the still-image helper for the random-access intra access unit.
    const isIrap = accessUnit.some((nal) => nal.type >= 16 && nal.type <= 23);
    decodeLayeredHevcPicture(
      [...parameterSets, ...accessUnit],
      [0, 1],
      1,
      undefined,
      isIrap
        ? new Map()
        : new Map([
            [0, history.get(0)!],
            [1, history.get(1)!],
          ]),
      decodedLayers,
    );

    for (const layerId of [0, 1]) {
      const planes = decodedLayers.get(layerId);
      if (!planes || planes.pictureOrderCnt === undefined)
        throw new Error(`official MVHEVCS_E access unit ${index / 2} omitted layer ${layerId}`);
      expect([planes.width, planes.height]).toEqual([1024, 768]);
      history.get(layerId)!.push(planes);
      outputByLayer.get(layerId)!.set(planes.pictureOrderCnt, planes);
    }
  }

  const expectedMd5 = new Map([
    [0, '96c07ed86f99e2e4bd3a9ce990c7c488'],
    [1, 'f8706d6ea10b9b68edfe9d9c699c70e2'],
  ]);
  for (const layerId of [0, 1]) {
    const frames = [...outputByLayer.get(layerId)!.entries()].sort(([pocA], [pocB]) => pocA - pocB);
    expect(frames.map(([poc]) => poc)).toEqual(Array.from({ length: 48 }, (_, poc) => poc));
    const hash = createHash('md5');
    for (const [, planes] of frames) {
      hash.update(planes.y);
      hash.update(planes.cb);
      hash.update(planes.cr);
    }
    expect(hash.digest('hex')).toBe(expectedMd5.get(layerId));
  }
}, 60_000);

it('decodes official MVHEVCS_F with inter-view prediction limited to IRAP pictures', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvhevcs-f-qualcomm-3.bit', import.meta.url)),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    '6a09a8b5f2829d2d24fe13ce5ab5720154d3c8f2318cbf64bfd70ccae01b944a',
  );

  const nals = splitAnnexB(bytes);
  const parameterSets = nals.filter((nal) => [32, 33, 34].includes(nal.type));
  const slices = nals.filter((nal) => isSliceNal(nal.type));
  expect(slices).toHaveLength(96);

  const history = new Map<number, Planes[]>([
    [0, []],
    [1, []],
  ]);
  const outputByLayer = new Map<number, Map<number, Planes>>([
    [0, new Map()],
    [1, new Map()],
  ]);
  let irapAccessUnits = 0;
  let nonIrapAccessUnits = 0;

  for (let index = 0; index < slices.length; index += 2) {
    const accessUnit = slices.slice(index, index + 2);
    expect(accessUnit.map((nal) => nal.layerId)).toEqual([0, 1]);

    const isIrap = accessUnit.some((nal) => nal.type >= 16 && nal.type <= 23);
    if (isIrap) irapAccessUnits++;
    else nonIrapAccessUnits++;

    const decodedLayers = new Map<number, Planes>();
    decodeLayeredHevcPicture(
      [...parameterSets, ...accessUnit],
      [0, 1],
      1,
      undefined,
      isIrap
        ? new Map()
        : new Map([
            [0, history.get(0)!],
            [1, history.get(1)!],
          ]),
      decodedLayers,
    );

    for (const layerId of [0, 1]) {
      const planes = decodedLayers.get(layerId);
      if (!planes || planes.pictureOrderCnt === undefined)
        throw new Error(`official MVHEVCS_F access unit ${index / 2} omitted layer ${layerId}`);
      expect([planes.width, planes.height]).toEqual([1024, 768]);
      history.get(layerId)!.push(planes);
      outputByLayer.get(layerId)!.set(planes.pictureOrderCnt, planes);
    }
  }

  expect(irapAccessUnits).toBeGreaterThan(1);
  expect(nonIrapAccessUnits).toBeGreaterThan(0);
  const expectedMd5 = new Map([
    [0, '96c07ed86f99e2e4bd3a9ce990c7c488'],
    [1, '377275e59c2fbdaa28ca098f119943cc'],
  ]);
  for (const layerId of [0, 1]) {
    const frames = [...outputByLayer.get(layerId)!.entries()].sort(([pocA], [pocB]) => pocA - pocB);
    expect(frames.map(([poc]) => poc)).toEqual(Array.from({ length: 48 }, (_, poc) => poc));
    const hash = createHash('md5');
    for (const [, planes] of frames) {
      hash.update(planes.y);
      hash.update(planes.cb);
      hash.update(planes.cr);
    }
    expect(hash.digest('hex')).toBe(expectedMd5.get(layerId));
  }
}, 60_000);

it('decodes the official three-view MVHEVCS_G PIP random-access sequence', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvhevcs-g-ntt-3.bit', import.meta.url)),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    'b8912087e4731d1aa941f1fba95a56e3b464cbd24aa68803de51112d2d8c6985',
  );

  const nals = splitAnnexB(bytes);
  const parameterSets = nals.filter((nal) => [32, 33, 34].includes(nal.type));
  const slices = nals.filter((nal) => isSliceNal(nal.type));
  expect(slices).toHaveLength(147);

  const layerIds = [0, 1, 2];
  const history = new Map(layerIds.map((layerId) => [layerId, [] as Planes[]]));
  const outputByLayer = new Map(layerIds.map((layerId) => [layerId, new Map<number, Planes>()]));
  let irapAccessUnits = 0;

  for (let index = 0; index < slices.length; index += layerIds.length) {
    const accessUnit = slices.slice(index, index + layerIds.length);
    expect(accessUnit.map((nal) => nal.layerId)).toEqual(layerIds);

    const isIrap = accessUnit.some((nal) => nal.type >= 16 && nal.type <= 23);
    if (isIrap) irapAccessUnits++;

    const decodedLayers = new Map<number, Planes>();
    decodeLayeredHevcPicture(
      [...parameterSets, ...accessUnit],
      layerIds,
      2,
      undefined,
      isIrap ? new Map() : new Map(layerIds.map((layerId) => [layerId, history.get(layerId)!])),
      decodedLayers,
    );

    for (const layerId of layerIds) {
      const planes = decodedLayers.get(layerId);
      if (!planes || planes.pictureOrderCnt === undefined)
        throw new Error(`official MVHEVCS_G access unit ${index / 3} omitted layer ${layerId}`);
      expect([planes.width, planes.height]).toEqual([1024, 768]);
      history.get(layerId)!.push(planes);
      outputByLayer.get(layerId)!.set(planes.pictureOrderCnt, planes);
    }
  }

  expect(irapAccessUnits).toBeGreaterThan(1);
  const expectedMd5 = new Map([
    [0, '3bab3455424334d069ce5cce318872b2'],
    [1, 'ca16ff9a763c3af7bb9a5027a61319bc'],
    [2, '624652d2fa7cf8b1b93d32ac7af97758'],
  ]);
  for (const layerId of layerIds) {
    const frames = [...outputByLayer.get(layerId)!.entries()].sort(([pocA], [pocB]) => pocA - pocB);
    expect(frames.map(([poc]) => poc)).toEqual(Array.from({ length: 49 }, (_, poc) => poc));
    const hash = createHash('md5');
    for (const [, planes] of frames) {
      hash.update(planes.y);
      hash.update(planes.cb);
      hash.update(planes.cr);
    }
    expect(hash.digest('hex')).toBe(expectedMd5.get(layerId));
  }
}, 60_000);

it('selects both side views of a synthetic three-view lhv1 HEIF item', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvhevcs-g-ntt-3.bit', import.meta.url)),
  );
  const nals = splitAnnexB(bytes);
  const parameterSets = nals.filter((nal) => [32, 33, 34].includes(nal.type));
  const accessUnit = nals.filter((nal) => isSliceNal(nal.type)).slice(0, 3);
  expect(accessUnit.map((nal) => nal.layerId)).toEqual([0, 1, 2]);

  const rawLayers = new Map<number, Planes>();
  decodeLayeredHevcPicture(
    [...parameterSets, ...accessUnit],
    [0, 1, 2],
    2,
    undefined,
    new Map(),
    rawLayers,
  );

  for (const [targetLayerId, expectedDependencies] of [
    [1, [0, 1]],
    [2, [0, 2]],
  ] as const) {
    const input = buildHeif(
      [
        {
          id: 1,
          type: 'lhv1',
          data: lengthPrefix(accessUnit),
          properties: [
            box('lhvC', makeLhevcConfiguration(nals)),
            box('oinf', makeThreeViewMvHevcOinf()),
            full('tols', 0, u16(3)),
            box('lsel', u16(targetLayerId)),
            full('ispe', 0, u32(1024), u32(768)),
          ],
        },
      ],
      1,
    );
    const boxes = parseISOBMFF(input);
    const info = getHeicInfo(input, boxes, 1);
    const output = decodeItemPlanes(input, boxes, info, 1);
    const image = decodeHeic(input, { applyTransforms: false });
    const expected = rawLayers.get(targetLayerId);
    if (!expected) throw new Error(`raw MVHEVCS_G output omitted layer ${targetLayerId}`);

    expect(info.lhevc?.requiredLayerIds).toEqual(expectedDependencies);
    expect(output.y).toEqual(expected.y);
    expect(output.cb).toEqual(expected.cb);
    expect(output.cr).toEqual(expected.cr);
    expect([image.width, image.height]).toEqual([1024, 768]);
  }
}, 30_000);

it('decodes the official three-view MVHEVCS_H IBP random-access sequence', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvhevcs-h-lge-3.bit', import.meta.url)),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    'beeba333856b8301ef938c4b503a98bb21ffcf28dd8f940785135acd877afda5',
  );

  const nals = splitAnnexB(bytes);
  const parameterSets = nals.filter((nal) => [32, 33, 34].includes(nal.type));
  const slices = nals.filter((nal) => isSliceNal(nal.type));
  expect(slices).toHaveLength(150);

  const layerIds = [0, 1, 2];
  const history = new Map(layerIds.map((layerId) => [layerId, [] as Planes[]]));
  const outputByLayer = new Map(layerIds.map((layerId) => [layerId, new Map<number, Planes>()]));
  let irapAccessUnits = 0;

  for (let index = 0; index < slices.length; index += layerIds.length) {
    const accessUnit = slices.slice(index, index + layerIds.length);
    expect(accessUnit.map((nal) => nal.layerId)).toEqual(layerIds);

    const isIrap = accessUnit.some((nal) => nal.type >= 16 && nal.type <= 23);
    if (isIrap) irapAccessUnits++;

    const decodedLayers = new Map<number, Planes>();
    decodeLayeredHevcPicture(
      [...parameterSets, ...accessUnit],
      layerIds,
      2,
      undefined,
      isIrap ? new Map() : new Map(layerIds.map((layerId) => [layerId, history.get(layerId)!])),
      decodedLayers,
    );

    for (const layerId of layerIds) {
      const planes = decodedLayers.get(layerId);
      if (!planes || planes.pictureOrderCnt === undefined)
        throw new Error(`official MVHEVCS_H access unit ${index / 3} omitted layer ${layerId}`);
      expect([planes.width, planes.height]).toEqual([1920, 1088]);
      history.get(layerId)!.push(planes);
      outputByLayer.get(layerId)!.set(planes.pictureOrderCnt, planes);
    }
  }

  expect(irapAccessUnits).toBeGreaterThan(1);
  const expectedMd5 = new Map([
    [0, '927abd6fb088c9e834fb76724f2aaf6d'],
    [1, '872587282d60082e88da458903b1f951'],
    [2, 'e3a1467c098b4a7141edf9782d31957f'],
  ]);
  for (const layerId of layerIds) {
    const frames = [...outputByLayer.get(layerId)!.entries()].sort(([pocA], [pocB]) => pocA - pocB);
    expect(frames.map(([poc]) => poc)).toEqual(Array.from({ length: 50 }, (_, poc) => poc));
    const hash = createHash('md5');
    for (const [, planes] of frames) {
      hash.update(planes.y);
      hash.update(planes.cb);
      hash.update(planes.cr);
    }
    expect(hash.digest('hex')).toBe(expectedMd5.get(layerId));
  }
}, 120_000);

it('decodes texture and auxiliary-depth layers of the official MVHEVCS_I vector', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvhevcs-i-nokia-3.bit', import.meta.url)),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    'daa8857e6cb34ca3f56554b0fcd12eb939a3e484156e25982c5e5c22cd71ba14',
  );

  const nals = splitAnnexB(bytes);
  const parameterSets = nals.filter((nal) => [32, 33, 34].includes(nal.type));
  const slices = nals.filter((nal) => isSliceNal(nal.type));
  const layerIds = [0, 1, 2, 3, 4, 5];
  expect(slices).toHaveLength(54);

  const vpsNal = nals.find((nal) => nal.type === 32);
  if (!vpsNal) throw new Error('official MVHEVCS_I vector has no VPS');
  const vps = parseLayeredVps(vpsNal.data);
  expect(vps.views).toEqual([
    { viewOrderIndex: 0, viewId: 0, layerIds: [0, 3] },
    { viewOrderIndex: 1, viewId: 2, layerIds: [1, 4] },
    { viewOrderIndex: 2, viewId: 1, layerIds: [2, 5] },
  ]);
  expect(vps.directReferenceLayerIds).toEqual([[], [0], [0, 1], [], [3], [3, 4]]);

  const history = new Map(layerIds.map((layerId) => [layerId, [] as Planes[]]));
  const outputByLayer = new Map(layerIds.map((layerId) => [layerId, new Map<number, Planes>()]));
  let firstAccessUnitLayers: Map<number, Planes> | null = null;

  for (let index = 0; index < slices.length; index += layerIds.length) {
    const accessUnit = slices.slice(index, index + layerIds.length);
    expect(accessUnit.map((nal) => nal.layerId)).toEqual(layerIds);
    const isIrap = accessUnit.some((nal) => nal.type >= 16 && nal.type <= 23);
    const decodedLayers = new Map<number, Planes>();
    decodeLayeredHevcPicture(
      [...parameterSets, ...accessUnit],
      layerIds,
      5,
      undefined,
      isIrap ? new Map() : new Map(layerIds.map((layerId) => [layerId, history.get(layerId)!])),
      decodedLayers,
    );

    if (index === 0) firstAccessUnitLayers = decodedLayers;
    for (const layerId of layerIds) {
      const planes = decodedLayers.get(layerId);
      if (!planes || planes.pictureOrderCnt === undefined)
        throw new Error(
          `official MVHEVCS_I access unit ${index / layerIds.length} omitted layer ${layerId}`,
        );
      expect([planes.width, planes.height, planes.chromaFormatIdc, planes.bitDepthLuma]).toEqual([
        1024, 768, 1, 8,
      ]);
      history.get(layerId)!.push(planes);
      outputByLayer.get(layerId)!.set(planes.pictureOrderCnt, planes);
    }
  }

  const expectedMd5 = new Map([
    [0, 'ae8c055003352954d9e599cdc9008a9b'],
    [1, 'f20e9e1cf6638bd66c09e4e3715b1040'],
    [2, 'bf983ee75dd8d0cfc5cd6e55258388d5'],
    [3, '349a6c09fdcb7269e36f059e41b90729'],
    [4, '6fd79629683c4e1c5f5474481bb15f56'],
    [5, 'ef6f199c9790b568705ec46be5ab0c62'],
  ]);
  for (const layerId of layerIds) {
    const frames = [...outputByLayer.get(layerId)!.entries()].sort(([pocA], [pocB]) => pocA - pocB);
    expect(frames.map(([poc]) => poc)).toEqual(Array.from({ length: 9 }, (_, poc) => poc));
    const hash = createHash('md5');
    for (const [, planes] of frames) {
      hash.update(planes.y);
      hash.update(planes.cb);
      hash.update(planes.cr);
    }
    expect(hash.digest('hex')).toBe(expectedMd5.get(layerId));
  }

  const depthLayer = firstAccessUnitLayers?.get(5);
  if (!depthLayer) throw new Error('first MVHEVCS_I access unit omitted depth layer 5');
  const input = buildHeif(
    [
      {
        id: 1,
        type: 'lhv1',
        data: lengthPrefix(slices.slice(0, layerIds.length)),
        properties: [
          box('lhvC', makeLhevcConfiguration(nals)),
          box('oinf', makeDepthMvHevcOinf()),
          full('tols', 0, u16(1)),
          full('ispe', 0, u32(1024), u32(768)),
        ],
      },
    ],
    1,
  );
  const boxes = parseISOBMFF(input);
  const info = getHeicInfo(input, boxes, 1);
  const output = decodeItemPlanes(input, boxes, info, 1);
  const image = decodeHeic(input, { applyTransforms: false });
  expect(info.lhevc?.requiredLayerIds).toEqual([3, 4, 5]);
  expect(output.y).toEqual(depthLayer.y);
  expect(output.cb).toEqual(depthLayer.cb);
  expect(output.cr).toEqual(depthLayer.cr);
  expect([image.width, image.height]).toEqual([1024, 768]);

  const auxiliaryInput = buildHeif(
    [
      {
        id: 1,
        type: 'lhv1',
        data: lengthPrefix(slices.slice(0, layerIds.length)),
        properties: [
          box('lhvC', makeLhevcConfiguration(nals)),
          box('oinf', makeBaseMvHevcOinf()),
          full('tols', 0, u16(1)),
          full('ispe', 0, u32(1024), u32(768)),
        ],
      },
      {
        id: 2,
        type: 'lhv1',
        data: lengthPrefix(slices.slice(0, layerIds.length)),
        properties: [
          box('lhvC', makeLhevcConfiguration(nals)),
          box('oinf', makeDepthMvHevcOinf()),
          full('tols', 0, u16(1)),
          full('ispe', 0, u32(1024), u32(768)),
          full('auxC', 0, Buffer.from('urn:mpeg:mpegB:cicp:systems:auxiliary:depth\0')),
        ],
        refs: [{ type: 'auxl', to: [1] }],
      },
    ],
    1,
  );
  const auxiliaryPlanes = decodeHeicAuxiliaryPlanes(auxiliaryInput);
  expect(auxiliaryPlanes).toHaveLength(1);
  expect(auxiliaryPlanes[0]).toMatchObject({
    itemId: 2,
    type: 'urn:mpeg:mpegB:cicp:systems:auxiliary:depth',
    width: 1024,
    height: 768,
    chromaFormatIdc: 1,
    bitDepthLuma: 8,
    bitDepthChroma: 8,
  });
  expect(auxiliaryPlanes[0].y).toEqual(depthLayer.y);
  expect(auxiliaryPlanes[0].cb).toEqual(depthLayer.cb);
  expect(auxiliaryPlanes[0].cr).toEqual(depthLayer.cr);
}, 120_000);
