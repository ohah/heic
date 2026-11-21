/** Read the ids at the start of HEVC PPS and slice-header syntax. */
import { HeicError } from '../errors.js';
import { BitReader, toRbsp } from './nal.js';
import { skipProfileTierLevel } from './sps.js';

export interface PpsParameterSetIds {
  ppsId: number;
  spsId: number;
}

export interface ActiveParameterSetNals {
  pps: Uint8Array;
  sps: Uint8Array;
  ppsId: number;
  spsId: number;
}

function checkNalHeader(nal: Uint8Array, expectedType: number, label: string): void {
  if (
    nal.length < 3 ||
    nal[0] & 0x80 ||
    !(nal[1] & 0x07) ||
    ((nal[0] >> 1) & 0x3f) !== expectedType
  )
    throw new HeicError('INVALID_BITSTREAM', `heic: invalid ${label} NAL unit`);
}

/** Read pps_pic_parameter_set_id and pps_seq_parameter_set_id only. */
export function readPpsParameterSetIds(nal: Uint8Array): PpsParameterSetIds {
  checkNalHeader(nal, 34, 'PPS');
  const r = new BitReader(toRbsp(nal));
  const ppsId = r.ue();
  const spsId = r.ue();
  if (ppsId > 63 || spsId > 15)
    throw new HeicError('INVALID_BITSTREAM', 'heic: PPS or SPS id exceeds its HEVC range');
  return { ppsId, spsId };
}

/** Read sps_seq_parameter_set_id without parsing an inactive SPS record. */
export function readSpsParameterSetId(nal: Uint8Array): number {
  checkNalHeader(nal, 33, 'SPS');
  const layerId = ((nal[0] & 1) << 5) | (nal[1] >> 3);
  const r = new BitReader(toRbsp(nal));
  r.readBits(4); // sps_video_parameter_set_id
  const maxSubLayersMinus1 = r.readBits(3);
  if (layerId !== 0 && maxSubLayersMinus1 === 7) {
    const spsId = r.ue();
    if (spsId > 15) throw new HeicError('INVALID_BITSTREAM', 'heic: SPS id exceeds the HEVC range');
    return spsId;
  }
  if (maxSubLayersMinus1 > 6)
    throw new HeicError('INVALID_BITSTREAM', 'heic: reserved SPS sub-layer count');
  r.readBit(); // sps_temporal_id_nesting_flag
  skipProfileTierLevel(r, maxSubLayersMinus1);
  const spsId = r.ue();
  if (spsId > 15) throw new HeicError('INVALID_BITSTREAM', 'heic: SPS id exceeds the HEVC range');
  return spsId;
}

/** Resolve the active PPS and its referenced SPS from one coded slice. */
export function selectActiveHevcParameterSetNals(
  slice: Uint8Array,
  ppsNals: readonly Uint8Array[],
  spsNals: readonly Uint8Array[],
  label = 'HEVC item',
): ActiveParameterSetNals {
  const ppsId = readSlicePpsId(slice);
  const ppsMatches = ppsNals
    .map((nal) => ({ nal, ...readPpsParameterSetIds(nal) }))
    .filter((entry) => entry.ppsId === ppsId);
  if (ppsMatches.length === 0)
    throw new HeicError(
      'INVALID_CONTAINER',
      `heic: ${label} slice references PPS ${ppsId}, which is missing from hvcC`,
    );
  const ppsNal = ppsMatches[0].nal;
  if (ppsMatches.some((entry) => !sameBytes(entry.nal, ppsNal)))
    throw new HeicError('UNSUPPORTED_FEATURE', `heic: ${label} has ambiguous PPS ${ppsId} in hvcC`);
  const spsId = ppsMatches[0].spsId;
  const spsMatches = spsNals.filter((nal) => readSpsParameterSetId(nal) === spsId);
  if (spsMatches.length === 0)
    throw new HeicError(
      'INVALID_CONTAINER',
      `heic: ${label} PPS ${ppsId} references SPS ${spsId}, which is missing from hvcC`,
    );
  const spsNal = spsMatches[0];
  if (spsMatches.some((nal) => !sameBytes(nal, spsNal)))
    throw new HeicError('UNSUPPORTED_FEATURE', `heic: ${label} has ambiguous SPS ${spsId} in hvcC`);
  return { pps: ppsNal, sps: spsNal, ppsId, spsId };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

/** Read slice_pic_parameter_set_id without assuming any active PPS syntax. */
export function readSlicePpsId(nal: Uint8Array): number {
  if (nal.length < 3 || nal[0] & 0x80 || !(nal[1] & 0x07))
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid slice NAL unit');
  const nalType = (nal[0] >> 1) & 0x3f;
  if (!((nalType >= 0 && nalType <= 9) || (nalType >= 16 && nalType <= 21)))
    throw new HeicError('INVALID_BITSTREAM', 'heic: expected a coded slice NAL unit');

  const r = new BitReader(toRbsp(nal));
  r.readBit(); // first_slice_segment_in_pic_flag
  if (nalType >= 16 && nalType <= 23) r.readBit(); // no_output_of_prior_pics_flag
  const ppsId = r.ue();
  if (ppsId > 63)
    throw new HeicError('INVALID_BITSTREAM', 'heic: slice PPS id exceeds its HEVC range');
  return ppsId;
}
