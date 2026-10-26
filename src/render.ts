import { HeicError } from "./errors.js";
import { getHeicInfo, getItemPayload, type HeicInfo } from "./container/heic.js";
import { parseISOBMFF, type ISOBMFFBox } from "./container/heif.js";
import { decodeItemPlanes, cropPlanes, stitchGrid, type Planes } from "./planes.js";
import { parseSps } from "./hevc/sps.js";
import type { DecodeOptions, HeicImageData } from "./decoder.js";

export interface NativeImage {
  width: number;
  height: number;
  bitDepth: 8 | 10 | 12;
  data: Uint16Array;
  hasAlpha: boolean;
  info: HeicInfo;
}
export interface RenderContext {
  input: Uint8Array;
  boxes: ISOBMFFBox[];
  options: DecodeOptions;
  stack: Set<number>;
  decodedPixels: number;
}
export const createRenderContext = (
  input: Uint8Array,
  options: DecodeOptions = {},
): RenderContext => ({
  input,
  boxes: parseISOBMFF(input),
  options,
  stack: new Set(),
  decodedPixels: 0,
});

function checkSize(ctx: RenderContext, w: number, h: number) {
  const pixels = w * h,
    limit = ctx.options.maxPixels ?? 50_000_000;
  if (!Number.isSafeInteger(pixels) || w <= 0 || h <= 0 || pixels > limit || pixels > 50_000_000)
    throw new HeicError("RESOURCE_LIMIT", "heic: derived image exceeds maxPixels");
  ctx.decodedPixels += pixels;
  if (ctx.decodedPixels > 200_000_000)
    throw new HeicError("RESOURCE_LIMIT", "heic: derived decode work exceeds 200 million pixels");
}

function planePixels(
  planes: Planes,
  depth: 8 | 10 | 12,
  color: NonNullable<HeicInfo["color"]>,
  auxiliary: boolean,
): Uint16Array {
  const { width: w, height: h } = planes,
    max = 2 ** depth - 1,
    factor = 2 ** (depth - 8),
    out = new Uint16Array(w * h * 4);
  const matrix = color.matrix,
    kr = matrix === 1 ? 0.2126 : matrix === 9 ? 0.2627 : 0.299,
    kb = matrix === 1 ? 0.0722 : matrix === 9 ? 0.0593 : 0.114;
  if (!auxiliary && planes.cb.length && ![0, 1, 2, 5, 6, 9].includes(matrix))
    throw new HeicError("UNSUPPORTED_FEATURE", "heic: unsupported YCbCr matrix");
  const ys = color.fullRange ? 1 : max / (219 * factor),
    cs = color.fullRange ? 1 : max / (224 * factor),
    offset = color.fullRange ? 0 : 16 * factor;
  const clip = (v: number) => Math.max(0, Math.min(max, Math.round(v)));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x,
        o = i * 4;
      if (auxiliary || !planes.cb.length) {
        out[o] =
          out[o + 1] =
          out[o + 2] =
            auxiliary ? planes.y[i] : clip((planes.y[i] - offset) * ys);
      } else {
        const ci = planes.chromaFormatIdc === 3 ? i : (y >> 1) * Math.ceil(w / 2) + (x >> 1),
          lum = (planes.y[i] - offset) * ys,
          u = (planes.cb[ci] - 128 * factor) * cs,
          v = (planes.cr[ci] - 128 * factor) * cs;
        if (matrix === 0 && planes.chromaFormatIdc === 3) {
          out[o] = clip((planes.cr[ci] - offset) * ys);
          out[o + 1] = clip(lum);
          out[o + 2] = clip((planes.cb[ci] - offset) * ys);
          out[o + 3] = max;
          continue;
        }
        out[o] = clip(lum + 2 * (1 - kr) * v);
        out[o + 1] = clip(
          lum -
            ((2 * kb * (1 - kb)) / (1 - kr - kb)) * u -
            ((2 * kr * (1 - kr)) / (1 - kr - kb)) * v,
        );
        out[o + 2] = clip(lum + 2 * (1 - kb) * u);
      }
      out[o + 3] = max;
    }
  return out;
}

function transform(image: NativeImage): NativeImage {
  let result = image;
  for (const step of image.info.transforms) {
    if (step.type === "clap") {
      const w = step.width,
        h = step.height,
        left = (result.width - w) / 2 + step.horizontalOffset,
        top = (result.height - h) / 2 + step.verticalOffset;
      if (![w, h, left, top].every(Number.isInteger))
        throw new HeicError(
          "UNSUPPORTED_FEATURE",
          "heic: fractional clean aperture resampling is not supported",
        );
      if (
        w <= 0 ||
        h <= 0 ||
        left < 0 ||
        top < 0 ||
        left + w > result.width ||
        top + h > result.height
      )
        throw new HeicError("INVALID_CONTAINER", "heic: clean aperture is out of bounds");
      const out = new Uint16Array(w * h * 4);
      for (let y = 0; y < h; y++)
        out.set(
          result.data.subarray(
            ((top + y) * result.width + left) * 4,
            ((top + y) * result.width + left + w) * 4,
          ),
          y * w * 4,
        );
      result = { ...result, width: w, height: h, data: out };
      continue;
    }
    const rotate = step.type === "irot" ? step.value : 0,
      mirror = step.type === "imir" ? step.value : null;
    if (!rotate && mirror === null) continue;
    const w = rotate % 2 ? result.height : result.width,
      h = rotate % 2 ? result.width : result.height,
      out = new Uint16Array(result.data.length);
    for (let y = 0; y < result.height; y++)
      for (let x = 0; x < result.width; x++) {
        let dx = x,
          dy = y;
        if (rotate === 1) {
          dx = y;
          dy = result.width - 1 - x;
        } else if (rotate === 2) {
          dx = result.width - 1 - x;
          dy = result.height - 1 - y;
        } else if (rotate === 3) {
          dx = result.height - 1 - y;
          dy = x;
        }
        if (mirror === 0) dx = w - 1 - dx;
        else if (mirror === 1) dy = h - 1 - dy;
        out.set(
          result.data.subarray((y * result.width + x) * 4, (y * result.width + x) * 4 + 4),
          (dy * w + dx) * 4,
        );
      }
    result = { ...result, width: w, height: h, data: out };
  }
  return result;
}

export function decodeNative(
  ctx: RenderContext,
  itemId?: number,
  auxiliary = false,
  transforms = ctx.options.applyTransforms !== false,
): NativeImage {
  const { input, boxes } = ctx,
    info = getHeicInfo(input, boxes, itemId),
    id = info.primaryItemId;
  if (ctx.stack.has(id) || ctx.stack.size >= 32)
    throw new HeicError("INVALID_CONTAINER", "heic: cyclic or deeply nested derived image");
  ctx.stack.add(id);
  try {
    let image: NativeImage;
    if (info.primaryItemType === "iden" || info.primaryItemType === "tmap") {
      if (info.derivedItems.length !== (info.primaryItemType === "iden" ? 1 : 2))
        throw new HeicError("INVALID_CONTAINER", "heic: invalid derived image references");
      const base = decodeNative(ctx, info.derivedItems[0], auxiliary, false);
      image = {
        ...base,
        info: { ...info, color: info.color ?? base.info.color, icc: info.icc ?? base.info.icc },
      };
    } else if (info.primaryItemType === "iovl") image = decodeOverlay(ctx, info);
    else {
      if (!info.hvcC)
        throw new HeicError(
          "UNSUPPORTED_FEATURE",
          "heic: unsupported derived item " + info.primaryItemType,
        );
      const sps = parseSps(info.hvcC.sps[0]),
        depth = sps.bitDepthLuma as 8 | 10 | 12;
      let planes: Planes;
      if (info.grid) {
        checkSize(
          ctx,
          info.grid.columns * info.grid.tileWidth,
          info.grid.rows * info.grid.tileHeight,
        );
        planes = cropPlanes(
          stitchGrid(input, boxes, info, info.grid),
          0,
          0,
          info.grid.outputWidth,
          info.grid.outputHeight,
        );
      } else {
        checkSize(ctx, sps.picWidthInLumaSamples, sps.picHeightInLumaSamples);
        const subW = sps.chromaFormatIdc === 1 ? 2 : 1,
          subH = subW;
        planes = cropPlanes(
          decodeItemPlanes(input, boxes, info, id),
          subW * sps.cropLeft,
          subH * sps.cropTop,
          sps.width,
          sps.height,
        );
      }
      const declared = info.color;
      const color = {
        primaries:
          declared?.primaries !== undefined && declared.primaries !== 2
            ? declared.primaries
            : (sps.color?.colourPrimaries ?? 2),
        transfer:
          declared?.transfer !== undefined && declared.transfer !== 2
            ? declared.transfer
            : (sps.color?.transferCharacteristics ?? 2),
        matrix:
          declared?.matrix !== undefined && declared.matrix !== 2
            ? declared.matrix
            : (sps.color?.matrixCoeffs ?? 6),
        fullRange: declared?.fullRange ?? sps.color?.videoFullRange ?? false,
      };
      image = {
        width: planes.width,
        height: planes.height,
        bitDepth: depth,
        data: planePixels(planes, depth, color, auxiliary),
        hasAlpha: false,
        info: { ...info, color },
      };
    }
    if (info.alphaItemId !== null && !auxiliary) {
      // Alpha is combined in reconstructed coordinates, then the colour item's
      // display transforms are applied once to the combined RGBA raster.
      const alpha = decodeNative(ctx, info.alphaItemId, true, false),
        max = 2 ** image.bitDepth - 1,
        amax = 2 ** alpha.bitDepth - 1;
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++) {
          const ai =
            (Math.min(alpha.height - 1, Math.floor((y * alpha.height) / image.height)) *
              alpha.width +
              Math.min(alpha.width - 1, Math.floor((x * alpha.width) / image.width))) *
            4;
          const o = (y * image.width + x) * 4,
            a = alpha.data[ai] / amax;
          image.data[o + 3] = Math.round(a * max);
          if (info.premultipliedAlpha)
            for (let c = 0; c < 3; c++)
              image.data[o + c] = a ? Math.min(max, Math.round(image.data[o + c] / a)) : 0;
        }
      image.hasAlpha = true;
    }
    return transforms ? transform(image) : image;
  } finally {
    ctx.stack.delete(id);
  }
}

function decodeOverlay(ctx: RenderContext, info: HeicInfo): NativeImage {
  const bytes = getItemPayload(ctx.input, ctx.boxes, info.primaryItemId);
  if (!bytes || bytes.length < 14 || bytes[0] !== 0 || bytes[1] & ~1)
    throw new HeicError("INVALID_CONTAINER", "heic: invalid overlay header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    wide = !!(bytes[1] & 1),
    size = wide ? 4 : 2;
  const width = wide ? view.getUint32(10) : view.getUint16(10),
    height = wide ? view.getUint32(14) : view.getUint16(12),
    header = 10 + 2 * size;
  if (bytes.length !== header + info.derivedItems.length * 2 * size)
    throw new HeicError("INVALID_CONTAINER", "heic: overlay offset count mismatch");
  checkSize(ctx, width, height);
  // Overlay fill values are normalized unsigned 16-bit samples (HEIF iovl).
  const depth = ([8, 10, 12].includes(info.bitDepth) ? info.bitDepth : 8) as 8 | 10 | 12,
    max = 2 ** depth - 1,
    data = new Uint16Array(width * height * 4);
  for (let i = 0; i < width * height; i++)
    for (let c = 0; c < 4; c++)
      data[i * 4 + c] = Math.round((view.getUint16(2 + 2 * c) * max) / 65535);
  let hasAlpha = view.getUint16(8) < 65535;
  for (const [index, id] of info.derivedItems.entries()) {
    const src = decodeNative(ctx, id),
      smax = 2 ** src.bitDepth - 1,
      p = header + index * 2 * size,
      x0 = wide ? view.getInt32(p) : view.getInt16(p),
      y0 = wide ? view.getInt32(p + size) : view.getInt16(p + size);
    hasAlpha ||= src.hasAlpha;
    for (let y = Math.max(0, -y0); y < Math.min(src.height, height - y0); y++)
      for (let x = Math.max(0, -x0); x < Math.min(src.width, width - x0); x++) {
        const si = (y * src.width + x) * 4,
          di = ((y + y0) * width + x + x0) * 4,
          a = src.data[si + 3] / smax,
          b = data[di + 3] / max,
          outA = a + b * (1 - a);
        for (let c = 0; c < 3; c++)
          data[di + c] = outA
            ? Math.round(
                (((src.data[si + c] / smax) * a + (data[di + c] / max) * b * (1 - a)) / outA) * max,
              )
            : 0;
        data[di + 3] = Math.round(outA * max);
      }
  }
  return { width, height, data, bitDepth: depth, hasAlpha, info };
}

export function decodeRendered(input: Uint8Array, options: DecodeOptions): HeicImageData {
  const native = decodeNative(createRenderContext(input, options)),
    max = 2 ** native.bitDepth - 1,
    data = new Uint8Array(native.data.length);
  for (let i = 0; i < data.length; i++) data[i] = Math.round((native.data[i] * 255) / max);
  return {
    width: native.width,
    height: native.height,
    data,
    bitDepth: native.bitDepth,
    hasAlpha: native.hasAlpha,
  };
}
