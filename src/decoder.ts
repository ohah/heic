import { decodeItemPlanes, cropPlanes, stitchGrid } from "./planes.js";
import type { Planes } from "./planes.js";
import { decodeRendered } from "./render.js";
import { HeicError, asHeicError } from "./errors.js";
/**
 * Public HEIC decoding API: container walk, HEVC intra decode of every tile,
 * grid stitching, conformance-window crop, YCbCr to RGBA conversion, and the
 * irot/imir display transforms.
 */
import type { GridInfo, HeicInfo } from "./container/heic.js";
import type { SpsInfo } from "./hevc/sps.js";
import { applyOrientation, yuv420ToRgba } from "./color.js";
import { getHeicInfo, getItemPayload } from "./container/heic.js";
import { getFtypInfo, parseISOBMFF, findBox, parseIinf } from "./container/heif.js";
import { deblockPicture } from "./hevc/deblock.js";
import { isSliceNal, splitLengthPrefixed } from "./hevc/nal.js";
import { PictureDecoder } from "./hevc/picture.js";
import { parsePps } from "./hevc/pps.js";
import { applySao } from "./hevc/sao.js";
import { parseSps } from "./hevc/sps.js";

export interface HeicMetadata extends HeicInfo {
  /** Parsed from the primary item's SPS; cross-checks the container. */
  sps: SpsInfo | null;
  /** Coded slice NAL count of the primary (or first tile) item. */
  sliceNalCount: number;
}

/** Whether a buffer looks like a HEIC/HEIF file. */
export function isHeic(buffer: Uint8Array): boolean {
  const ftyp = getFtypInfo(buffer);
  if (!ftyp) return false;

  const brands = [ftyp.majorBrand, ...ftyp.compatibleBrands];
  if (
    brands.some((brand) =>
      ["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs"].includes(brand),
    )
  )
    return true;
  // Generic HEIF brands do not identify the codec. Inspect item declarations,
  // rather than interpreting AVIF/VVC containers as HEVC from their extension.
  if (!brands.some((brand) => ["mif1", "mif2"].includes(brand))) return false;
  try {
    const boxes = parseISOBMFF(buffer);
    const meta = findBox(boxes, "meta");
    const iinf = meta?.children && findBox(meta.children, "iinf");
    return !!iinf && parseIinf(iinf.data).some((item) => item.itemType === "hvc1");
  } catch {
    return false;
  }
}

/**
 * Parse everything knowable without entropy-decoding pixels: dimensions,
 * grid layout, rotation/mirror, bit depth, and the HEVC parameter sets.
 */
export function getHeicMetadata(buffer: Uint8Array): HeicMetadata {
  if (!isHeic(buffer)) throw new Error("heic: not a HEIC file (ftyp brand mismatch)");

  const boxes = parseISOBMFF(buffer);
  const info = getHeicInfo(buffer, boxes);

  let sps: SpsInfo | null = null;
  let sliceNalCount = 0;

  if (info.hvcC) {
    if (info.hvcC.sps.length > 0) sps = parseSps(info.hvcC.sps[0]);

    const codedItemId = info.grid ? info.grid.tileItemIds[0] : info.primaryItemId;
    const payload = getItemPayload(buffer, boxes, codedItemId);
    if (payload) {
      const nals = splitLengthPrefixed(payload, info.hvcC.nalLengthSize);
      sliceNalCount = nals.filter((n) => isSliceNal(n.type)).length;
    }
  }

  return { ...info, sps, sliceNalCount };
}

export interface HeicImageData {
  data: Uint8Array;
  width: number;
  height: number;
  hasAlpha: boolean;
  bitDepth: 8 | 10 | 12;
}

export interface DecodeOptions {
  /** Maximum output or padded-grid pixel count. Default/hard ceiling: 50 million. */
  maxPixels?: number;

  /**
   * Apply the irot/imir display transforms (default true). When false the
   * pixels stay in coded orientation.
   */
  applyTransforms?: boolean;
}

/** Decode a HEIC file to RGBA pixels. */
function decodeInternal(buffer: Uint8Array, options: DecodeOptions): HeicImageData {
  if (!(buffer instanceof Uint8Array))
    throw new HeicError("INVALID_INPUT", "heic: expected Uint8Array");
  if (buffer.byteLength > 64 * 1024 * 1024)
    throw new HeicError("RESOURCE_LIMIT", "heic: input exceeds 64 MiB");
  if (!isHeic(buffer)) throw new HeicError("UNSUPPORTED_FORMAT", "heic: not a HEIC file");
  const maxPixels = options.maxPixels ?? 50_000_000;
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0 || maxPixels > 50_000_000)
    throw new HeicError("INVALID_OPTIONS", "heic: invalid maxPixels");
  const boxes = parseISOBMFF(buffer);
  const info = getHeicInfo(buffer, boxes);
  if (
    info.transforms.some((transform) => transform.type === "clap") ||
    info.hasAlpha ||
    ["iovl", "iden", "tmap"].includes(info.primaryItemType)
  )
    return decodeRendered(buffer, options);
  if (!info.hvcC)
    throw new HeicError("INVALID_CONTAINER", "heic: primary item has no HEVC configuration (hvcC)");

  if (info.hasAlpha)
    throw new HeicError("UNSUPPORTED_FEATURE", "heic: auxiliary alpha planes are not supported");
  const sps = parseSps(info.hvcC.sps[0]);
  if (sps.chromaFormatIdc !== 1) return decodeRendered(buffer, options);
  const matrix =
    info.color?.matrix !== undefined && info.color.matrix !== 2
      ? info.color.matrix
      : (sps.color?.matrixCoeffs ?? 6);
  if (![1, 2, 5, 6, 9].includes(matrix))
    throw new HeicError("UNSUPPORTED_FEATURE", "heic: color matrix is not supported");

  const pixels = info.grid
    ? info.grid.rows * info.grid.tileHeight * info.grid.columns * info.grid.tileWidth
    : sps.picWidthInLumaSamples * sps.picHeightInLumaSamples;
  if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > maxPixels)
    throw new HeicError("RESOURCE_LIMIT", "heic: image exceeds maxPixels");
  let planes: Planes;
  if (info.grid) {
    planes = stitchGrid(buffer, boxes, info, info.grid);
    planes = cropPlanes(planes, 0, 0, info.grid.outputWidth, info.grid.outputHeight);
  } else {
    planes = decodeItemPlanes(buffer, boxes, info, info.primaryItemId);
    // Conformance window (crop offsets are in chroma units for 4:2:0).
    const subW = sps.chromaFormatIdc === 1 || sps.chromaFormatIdc === 2 ? 2 : 1;
    const subH = sps.chromaFormatIdc === 1 ? 2 : 1;
    planes = cropPlanes(planes, subW * sps.cropLeft, subH * sps.cropTop, sps.width, sps.height);
  }

  const rgba = yuv420ToRgba(planes.y, planes.cb, planes.cr, planes.width, planes.height, {
    bitDepth: sps.bitDepthLuma as 8 | 10 | 12,
    matrixCoeffs: matrix,
    fullRange: info.color?.fullRange ?? sps.color?.videoFullRange ?? false,
  });

  let data = rgba;
  let width = planes.width;
  let height = planes.height;
  if (options.applyTransforms !== false && (info.rotation !== 0 || info.mirror !== null)) {
    const oriented = applyOrientation(rgba, width, height, info.rotation, info.mirror);
    data = oriented.data;
    width = oriented.width;
    height = oriented.height;
  }

  return { data, width, height, hasAlpha: false, bitDepth: sps.bitDepthLuma as 8 | 10 | 12 };
}

/** Synchronous decoding; unexpected implementation errors retain their cause. */
export function decodeHeic(buffer: Uint8Array, options: DecodeOptions = {}): HeicImageData {
  try {
    return decodeInternal(buffer, options);
  } catch (error) {
    throw asHeicError(error);
  }
}
