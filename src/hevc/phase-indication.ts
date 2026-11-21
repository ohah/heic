import type { HevcPhaseIndication } from './sei.js';

/**
 * Align an RGBA raster to the H.274 phase-indication sample positions.
 * Bilinear interpolation and edge replication are this renderer's display
 * policy; the bitstream signals sample positions but does not require a filter.
 */
export function applyHevcPhaseIndication(
  data: Uint16Array | Float32Array,
  width: number,
  height: number,
  phase: HevcPhaseIndication,
): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    data.length !== width * height * 4
  )
    throw new RangeError('invalid RGBA raster for HEVC phase indication');

  const horizontal = 0.5 - phase.horizontalPhaseNum / (phase.horizontalPhaseDenMinus1 + 1),
    vertical = 0.5 - phase.verticalPhaseNum / (phase.verticalPhaseDenMinus1 + 1);
  if (horizontal !== 0) resampleAxis(data, width, height, horizontal, true);
  if (vertical !== 0) resampleAxis(data, width, height, vertical, false);
}

function resampleAxis(
  data: Uint16Array | Float32Array,
  width: number,
  height: number,
  delta: number,
  horizontal: boolean,
): void {
  const length = horizontal ? width : height,
    lineCount = horizontal ? height : width,
    start = delta > 0 ? 0 : length - 1,
    end = delta > 0 ? length : -1,
    step = delta > 0 ? 1 : -1;

  for (let line = 0; line < lineCount; line++)
    for (let position = start; position !== end; position += step) {
      const source = position + delta,
        sourceFloor = Math.floor(source),
        lower = Math.max(0, Math.min(length - 1, sourceFloor)),
        upper = Math.max(0, Math.min(length - 1, sourceFloor + 1)),
        fraction = Math.max(0, Math.min(1, source - sourceFloor)),
        destinationOffset = (horizontal ? line * width + position : position * width + line) * 4,
        lowerOffset = (horizontal ? line * width + lower : lower * width + line) * 4,
        upperOffset = (horizontal ? line * width + upper : upper * width + line) * 4;
      for (let channel = 0; channel < 4; channel++) {
        const value =
          data[lowerOffset + channel] * (1 - fraction) + data[upperOffset + channel] * fraction;
        data[destinationOffset + channel] =
          data instanceof Float32Array ? value : Math.round(value);
      }
    }
}
