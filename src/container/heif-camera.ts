import { HeicError } from '../errors.js';
import type { ISOBMFFBox } from './heif.js';

export interface HeifCameraExtrinsics {
  version: number;
  flags: number;
  /** Position in the HEIF world coordinate system, in micrometres. */
  positionMicrometers?: { x: number; y: number; z: number };
  /** Raw signed quaternion x/y/z values for version 0. */
  quaternionComponents?: [number, number, number];
  /** Version-1 yaw, pitch, and roll values from ISO/IEC 23090-7, in degrees. */
  rotationAnglesDegrees?: { yaw: number; pitch: number; roll: number };
  /** World coordinate-system identifier; absent flags infer identifier 0. */
  coordinateSystemId?: number;
  /** Exact property payload, including the FullBox header. */
  raw: Uint8Array;
}

export interface HeifCameraIntrinsics {
  version: number;
  flags: number;
  /** Raw dimension-normalized signed values from the property. */
  focalLengthX?: number;
  principalPointX?: number;
  principalPointY?: number;
  focalLengthY?: number;
  skewFactor?: number;
  denominatorShift?: number;
  skewDenominatorShift?: number;
  /** Intrinsic matrix evaluated against the post-transform output extent, in pixels. */
  matrix?: [[number, number, number], [number, number, number], [number, number, number]];
  /** Exact property payload, including the FullBox header. */
  raw: Uint8Array;
}

function invalid(message: string): never {
  throw new HeicError('INVALID_CONTAINER', `heic: ${message}`);
}

function fullBox(data: Uint8Array, label: string): { version: number; flags: number } {
  if (data.length < 4) invalid(`truncated ${label} camera property`);
  return {
    version: data[0],
    flags: (data[1] << 16) | (data[2] << 8) | data[3],
  };
}

function signed32(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > data.length) invalid('truncated camera property field');
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getInt32(offset);
}

function signed16(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > data.length) invalid('truncated camera property field');
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getInt16(offset);
}

function unsigned32(data: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > data.length) invalid('truncated camera property field');
  return new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(offset);
}

function parseCameraExtrinsics(property: ISOBMFFBox): HeifCameraExtrinsics {
  const { version, flags } = fullBox(property.data, 'cmex'),
    result: HeifCameraExtrinsics = {
      version,
      flags,
      raw: property.data,
    };
  if (version > 1) return result;
  if (flags & ~0x3f) invalid('cmex has nonzero reserved flags');

  let offset = 4;
  result.positionMicrometers = { x: 0, y: 0, z: 0 };
  for (const [flag, axis] of [
    [0x01, 'x'],
    [0x02, 'y'],
    [0x04, 'z'],
  ] as const) {
    if (flags & flag) {
      result.positionMicrometers[axis] = signed32(property.data, offset);
      offset += 4;
    }
  }

  if (flags & 0x08) {
    if (version === 1) {
      const yaw = signed32(property.data, offset),
        pitch = signed32(property.data, offset + 4),
        roll = signed32(property.data, offset + 8);
      if (yaw < -180 || yaw >= 180 || pitch < -90 || pitch > 90 || roll < -180 || roll >= 180)
        invalid('cmex version-1 rotation angle is out of range');
      result.rotationAnglesDegrees = { yaw, pitch, roll };
      offset += 12;
    } else if (flags & 0x10) {
      result.quaternionComponents = [
        signed32(property.data, offset),
        signed32(property.data, offset + 4),
        signed32(property.data, offset + 8),
      ];
      offset += 12;
    } else {
      result.quaternionComponents = [
        signed16(property.data, offset),
        signed16(property.data, offset + 2),
        signed16(property.data, offset + 4),
      ];
      offset += 6;
    }
  }

  result.coordinateSystemId = flags & 0x20 ? unsigned32(property.data, offset) : 0;
  if (flags & 0x20) offset += 4;
  if (offset !== property.data.length) invalid('cmex has an unexpected trailing payload');
  return result;
}

function parseCameraIntrinsics(
  property: ISOBMFFBox,
  width: number,
  height: number,
): HeifCameraIntrinsics {
  const { version, flags } = fullBox(property.data, 'cmin');
  if (version !== 0)
    return {
      version,
      flags,
      raw: property.data,
    };
  if (flags & ~0x1f1f01) invalid('cmin has nonzero reserved flags');

  const hasFullIntrinsics = (flags & 1) !== 0,
    expectedLength = hasFullIntrinsics ? 24 : 16;
  if (property.data.length !== expectedLength) invalid('cmin has an invalid payload length');

  const focalLengthX = signed32(property.data, 4),
    principalPointX = signed32(property.data, 8),
    principalPointY = signed32(property.data, 12),
    focalLengthY = hasFullIntrinsics ? signed32(property.data, 16) : undefined,
    skewFactor = hasFullIntrinsics ? signed32(property.data, 20) : undefined,
    denominatorShift = (flags >>> 8) & 0x1f,
    skewDenominatorShift = (flags >>> 16) & 0x1f,
    denominator = 2 ** denominatorShift,
    skewDenominator = 2 ** skewDenominatorShift,
    fx = (focalLengthX * width) / denominator,
    fy = hasFullIntrinsics ? (focalLengthY! * height) / denominator : fx,
    cx = (principalPointX * width) / denominator,
    cy = (principalPointY * height) / denominator,
    skew = hasFullIntrinsics ? skewFactor! / skewDenominator : 0;

  return {
    version,
    flags,
    focalLengthX,
    principalPointX,
    principalPointY,
    ...(focalLengthY !== undefined ? { focalLengthY } : {}),
    ...(skewFactor !== undefined ? { skewFactor } : {}),
    denominatorShift,
    skewDenominatorShift,
    ...(width > 0 && height > 0
      ? {
          matrix: [
            [fx, skew, cx],
            [0, fy, cy],
            [0, 0, 1],
          ] as [[number, number, number], [number, number, number], [number, number, number]],
        }
      : {}),
    raw: property.data,
  };
}

export function parseHeifCameraProperties(
  properties: readonly ISOBMFFBox[],
  width: number,
  height: number,
  transforms: readonly CameraImageTransform[],
): {
  cameraExtrinsics?: HeifCameraExtrinsics[];
  cameraIntrinsics?: HeifCameraIntrinsics;
} {
  const transformIndex = properties.findIndex((property) =>
      ['clap', 'irot', 'imir', 'iscl'].includes(property.type),
    ),
    descriptiveProperties = transformIndex < 0 ? properties : properties.slice(0, transformIndex),
    extrinsics = descriptiveProperties.filter((property) => property.type === 'cmex'),
    intrinsics = descriptiveProperties.filter((property) => property.type === 'cmin');
  if (intrinsics.length > 1) invalid('duplicate cmin camera intrinsics property');
  if (
    extrinsics.length > 1 &&
    extrinsics.some((property) => !(fullBox(property.data, 'cmex').flags & 0x20))
  )
    invalid('every cmex must signal an id when multiple extrinsics properties are present');

  let outputWidth = width,
    outputHeight = height;
  for (const transform of transforms) {
    if (transform.type === 'iscl') {
      outputWidth = Math.floor(
        (outputWidth * transform.targetWidthNumerator + transform.targetWidthDenominator - 1) /
          transform.targetWidthDenominator,
      );
      outputHeight = Math.floor(
        (outputHeight * transform.targetHeightNumerator + transform.targetHeightDenominator - 1) /
          transform.targetHeightDenominator,
      );
    } else if (transform.type === 'clap') {
      outputWidth = Math.max(1, Math.round(transform.width));
      outputHeight = Math.max(1, Math.round(transform.height));
    } else if (transform.type === 'irot' && transform.value % 2) {
      [outputWidth, outputHeight] = [outputHeight, outputWidth];
    }
  }

  const cameraExtrinsics = extrinsics.map(parseCameraExtrinsics),
    cameraIntrinsics = intrinsics[0]
      ? parseCameraIntrinsics(intrinsics[0], outputWidth, outputHeight)
      : undefined;
  return {
    ...(cameraExtrinsics.length ? { cameraExtrinsics } : {}),
    ...(cameraIntrinsics ? { cameraIntrinsics } : {}),
  };
}

type CameraImageTransform =
  | {
      type: 'irot' | 'imir';
      value: number;
    }
  | {
      type: 'clap';
      width: number;
      height: number;
      horizontalOffset: number;
      verticalOffset: number;
    }
  | {
      type: 'iscl';
      targetWidthNumerator: number;
      targetWidthDenominator: number;
      targetHeightNumerator: number;
      targetHeightDenominator: number;
    };
