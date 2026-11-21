/** Sampling geometry for HEVC chroma_format_idc (H.265 6.2). */
export interface ChromaSubsampling {
  width: number;
  height: number;
}

export interface ChromaSampleLocation {
  x: 0 | 0.5;
  y: 0 | 0.5 | 1;
}

/** Position of the top-left chroma sample from HEVC/HEIF location codes. */
export function chromaSampleLocationFromCode(
  subsamplingType: number,
  location: number,
): ChromaSampleLocation | null {
  if (location < 0 || location > 5) return null;
  if (subsamplingType === 0) return { x: 0, y: 0 };
  if (subsamplingType === 1) return { x: location % 2 === 0 ? 0 : 0.5, y: 0 };
  if (subsamplingType === 2) {
    const locations: ChromaSampleLocation[] = [
      { x: 0, y: 0.5 },
      { x: 0.5, y: 0.5 },
      { x: 0, y: 0 },
      { x: 0.5, y: 0 },
      { x: 0, y: 1 },
      { x: 0.5, y: 1 },
    ];
    return locations[location];
  }
  return null;
}

export function chromaSubsampling(chromaFormatIdc: number): ChromaSubsampling {
  switch (chromaFormatIdc) {
    case 0:
    case 3:
      return { width: 1, height: 1 };
    case 1:
      return { width: 2, height: 2 };
    case 2:
      return { width: 2, height: 1 };
    // ISO/IEC 23001-17 sampling type 3 is 4:1:1. HEVC SPS syntax only uses 0–3.
    case 4:
      return { width: 4, height: 1 };
    default:
      throw new RangeError(`heic: invalid chroma_format_idc ${chromaFormatIdc}`);
  }
}
