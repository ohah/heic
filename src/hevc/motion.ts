type MotionFilter = { firstTap: number; coefficients: readonly number[] };

/**
 * H.265 8.5.3.2.1 integer-resolution motion-vector derivation.
 * The predictor is in quarter-luma-sample units; the MVD is in luma samples.
 */
export function deriveIntegerMotionVectorComponent(mvpQpel: number, mvd: number): number {
  const qpel = ((mvpQpel >> 2) + mvd) << 2;
  const unsigned = ((qpel % 0x1_0000) + 0x1_0000) % 0x1_0000;
  return unsigned >= 0x8000 ? unsigned - 0x1_0000 : unsigned;
}

/** H.265 8.5.3.2.2: integer mode rounds a merge candidate down to full-pel precision. */
export function quantizeMotionVectorToIntegerPel(mvQpel: number): number {
  return (mvQpel >> 2) << 2;
}

const LUMA_FILTERS: readonly (MotionFilter | null)[] = [
  null,
  { firstTap: -3, coefficients: [-1, 4, -10, 58, 17, -5, 1] },
  { firstTap: -3, coefficients: [-1, 4, -11, 40, 40, -11, 4, -1] },
  { firstTap: -2, coefficients: [1, -5, 17, 58, -10, 4, -1] },
];

const CHROMA_FILTERS: readonly (MotionFilter | null)[] = [
  null,
  { firstTap: -1, coefficients: [-2, 58, 10, -2] },
  { firstTap: -1, coefficients: [-4, 54, 16, -2] },
  { firstTap: -1, coefficients: [-6, 46, 28, -4] },
  { firstTap: -1, coefficients: [-4, 36, 36, -4] },
  { firstTap: -1, coefficients: [-4, 28, 46, -6] },
  { firstTap: -1, coefficients: [-2, 16, 54, -4] },
  { firstTap: -1, coefficients: [-2, 10, 58, -2] },
];

function clipCoordinate(value: number, limit: number): number {
  return Math.max(0, Math.min(limit - 1, value));
}

function filterAxis(
  plane: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  horizontal: boolean,
  filter: MotionFilter,
  shift: number,
): number {
  let sum = 0;
  for (let i = 0; i < filter.coefficients.length; i++) {
    const offset = filter.firstTap + i;
    const sx = clipCoordinate(x + (horizontal ? offset : 0), width);
    const sy = clipCoordinate(y + (horizontal ? 0 : offset), height);
    sum += filter.coefficients[i] * plane[sy * width + sx];
  }
  return sum >> shift;
}

function interpolate(
  plane: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  fracX: number,
  fracY: number,
  bitDepth: number,
  filters: readonly (MotionFilter | null)[],
  retainInternalPrecision = false,
): number {
  const maxValue = (1 << bitDepth) - 1;
  const shift1 = Math.min(4, bitDepth - 8);
  const shift3 = Math.max(2, 14 - bitDepth);
  const horizontal = filters[fracX];
  const vertical = filters[fracY];
  let value: number;

  if (fracX === 0 && fracY === 0) {
    value = plane[clipCoordinate(y, height) * width + clipCoordinate(x, width)];
    return retainInternalPrecision ? value << shift3 : value;
  } else if (fracY === 0) {
    value = filterAxis(plane, width, height, x, y, true, horizontal!, shift1);
  } else if (fracX === 0) {
    value = filterAxis(plane, width, height, x, y, false, vertical!, shift1);
  } else {
    let sum = 0;
    for (let i = 0; i < vertical!.coefficients.length; i++) {
      const offset = vertical!.firstTap + i;
      const horizontalValue = filterAxis(
        plane,
        width,
        height,
        x,
        y + offset,
        true,
        horizontal!,
        shift1,
      );
      sum += vertical!.coefficients[i] * horizontalValue;
    }
    value = sum >> 6;
  }

  if (retainInternalPrecision) return value;
  value = (value + (1 << (shift3 - 1))) >> shift3;
  return Math.max(0, Math.min(maxValue, value));
}

/** H.265 8.5.3.3.3.2 quarter-luma-sample interpolation. */
export function interpolateLumaSample(
  plane: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  fracX: number,
  fracY: number,
  bitDepth: number,
): number {
  return interpolate(plane, width, height, x, y, fracX, fracY, bitDepth, LUMA_FILTERS);
}

/**
 * H.265 8.5.3.3.3.2 interpolation output before the weighted-sample stage.
 * Integer positions are shifted by shift3, just like fractional positions.
 */
export function interpolateLumaPredictionSample(
  plane: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  fracX: number,
  fracY: number,
  bitDepth: number,
): number {
  return interpolate(plane, width, height, x, y, fracX, fracY, bitDepth, LUMA_FILTERS, true);
}

/** H.265 8.5.3.3.3.3 eighth-chroma-sample interpolation. */
export function interpolateChromaSample(
  plane: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  fracX: number,
  fracY: number,
  bitDepth: number,
): number {
  return interpolate(plane, width, height, x, y, fracX, fracY, bitDepth, CHROMA_FILTERS);
}

/** H.265 8.5.3.3.3.3 chroma interpolation output before weighted prediction. */
export function interpolateChromaPredictionSample(
  plane: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
  fracX: number,
  fracY: number,
  bitDepth: number,
): number {
  return interpolate(plane, width, height, x, y, fracX, fracY, bitDepth, CHROMA_FILTERS, true);
}
