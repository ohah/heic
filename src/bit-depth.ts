/** Bit depths representable by the HEVCDecoderConfigurationRecord in HEIF. */
export type HeifHevcBitDepth = 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;

/** Decoded integer image depths, including signed 2–7-bit and 16-bit ISO uncompressed components. */
export type HeifImageBitDepth = 2 | 3 | 4 | 5 | 6 | 7 | HeifHevcBitDepth | 16;

export function isHeifHevcBitDepth(value: number): value is HeifHevcBitDepth {
  return Number.isInteger(value) && value >= 8 && value <= 15;
}

export function isHeifImageBitDepth(value: number): value is HeifImageBitDepth {
  return Number.isInteger(value) && value >= 2 && value <= 16;
}
