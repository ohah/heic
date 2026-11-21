import { HeicError } from '../errors.js';
import type { ISOBMFFBox } from './heif.js';

/** Parsed `prdi` step grouping for a derived HEIF image item. */
export interface ProgressiveDerivedImageInfo {
  /** The complete 24-bit ItemFullProperty flags field. */
  flags: number;
  /** Candidate input images follow the derived item's `dimg` reference order. */
  itemReferenceOrder: boolean;
  /** Every rendering step consumes exactly one candidate input image. */
  oneItemPerStep: boolean;
  /** Alternative-group members and thumbnails may also be candidates. */
  alternativeIsCandidate: boolean;
  /** Effective step count, resolving the `dimg`-count inference when needed. */
  stepCount: number;
  /** True when the property omits `step_count` and it is inferred from `dimg`. */
  stepCountInferred: boolean;
  /** Effective candidate count for each step, including inferred values of 1. */
  itemCounts: number[];
}

const FLAG_ITEM_REFERENCE_ORDER = 0x000001;
const FLAG_ONE_ITEM_PER_STEP = 0x000002;
const FLAG_ALTERNATIVE_IS_CANDIDATE = 0x000004;

function invalid(message: string): never {
  throw new HeicError('INVALID_CONTAINER', `heic: ${message}`);
}

function unsupported(message: string): never {
  throw new HeicError('UNSUPPORTED_FEATURE', `heic: ${message}`);
}

function readU16(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > data.length) return invalid('truncated prdi property');
  return (data[offset] << 8) | data[offset + 1];
}

/** Parse ISO/IEC 23008-12 §6.5.37 ProgressiveDerivedImageItemInformationProperty. */
export function parseProgressiveDerivedImageInfo(
  properties: readonly ISOBMFFBox[],
  itemType: string,
  dimgInputCount: number,
): ProgressiveDerivedImageInfo | undefined {
  const matches = properties.filter((property) => property.type === 'prdi');
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) invalid('duplicate prdi properties');
  if (!['grid', 'iden', 'iovl', 'tmap'].includes(itemType))
    invalid('prdi property is associated with a non-derived image item');
  if (!Number.isInteger(dimgInputCount) || dimgInputCount <= 0 || dimgInputCount > 0xffff)
    invalid('prdi property has no valid dimg input list');

  const data = matches[0].data;
  if (data.length < 4) invalid('truncated prdi FullBox header');
  const version = data[0];
  const flags = (data[1] << 16) | (data[2] << 8) | data[3];
  if (version !== 0) unsupported(`unsupported prdi version ${version}`);
  if (flags & ~(FLAG_ITEM_REFERENCE_ORDER | FLAG_ONE_ITEM_PER_STEP | FLAG_ALTERNATIVE_IS_CANDIDATE))
    unsupported('unsupported prdi flags');

  const oneItemPerStep = (flags & FLAG_ONE_ITEM_PER_STEP) !== 0;
  const alternativeIsCandidate = (flags & FLAG_ALTERNATIVE_IS_CANDIDATE) !== 0;
  const stepCountInferred = oneItemPerStep && !alternativeIsCandidate;
  let offset = 4;
  const stepCount = stepCountInferred ? dimgInputCount : readU16(data, offset);
  if (!stepCountInferred) offset += 2;
  // §6.5.37.3 reserves zero for future use; one means progressive rendering
  // is not desired, while values above one specify progressive steps.
  if (stepCount === 0) invalid('prdi step_count is reserved to be nonzero');

  const itemCounts: number[] = [];
  if (oneItemPerStep) {
    for (let step = 0; step < stepCount; step++) itemCounts.push(1);
  } else {
    for (let step = 0; step < stepCount; step++) {
      itemCounts.push(readU16(data, offset));
      offset += 2;
    }
  }
  if (offset !== data.length) invalid('unexpected trailing prdi data');

  return {
    flags,
    itemReferenceOrder: (flags & FLAG_ITEM_REFERENCE_ORDER) !== 0,
    oneItemPerStep,
    alternativeIsCandidate,
    stepCount,
    stepCountInferred,
    itemCounts,
  };
}
