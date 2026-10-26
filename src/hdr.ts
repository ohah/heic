import { HeicError, asHeicError } from "./errors.js";
import { isHeic, type DecodeOptions } from "./decoder.js";
import {
  createRenderContext,
  decodeNative,
  type NativeImage,
  type RenderContext,
} from "./render.js";
import { getHeicInfo, getItemPayload, parseIref } from "./container/heic.js";
import { findBox, parseIinf } from "./container/heif.js";

export interface HdrOptions extends DecodeOptions {
  /** Target display/base-white ratio for gain maps. Omit for full stored headroom. */
  displayHeadroom?: number;
  /** Reference white luminance for PQ/HLG. Default 203 cd/m². */
  referenceWhiteNits?: number;
  /** HLG reference display peak. Default 1000 cd/m². */
  displayPeakNits?: number;
}
export interface HdrImage {
  width: number;
  height: number;
  bitDepth: 8 | 10 | 12;
  data: Float32Array;
  hasAlpha: boolean;
  colorSpace: "linear-srgb";
  headroom: number;
  sourceHeadroom: number;
  source: "sdr" | "pq" | "hlg" | "apple-gainmap" | "iso-gainmap";
}

export const srgbToLinear = (v: number) =>
  v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
export const rec709ToLinear = (v: number) =>
  v < 0.081 ? v / 4.5 : ((v + 0.099) / 1.099) ** (1 / 0.45);
/** ITU-R BT.2100-3 Table 4, normalized to reference white. */
export function pqToLinear(v: number, white = 203): number {
  const n = Math.max(0, v) ** (1 / (2523 / 32)),
    m1 = 2610 / 16384;
  return (
    ((Math.max(n - 3424 / 4096, 0) / (2413 / 128 - (2392 / 128) * n)) ** (1 / m1) * 10000) / white
  );
}
export function hlgInverseOetf(v: number): number {
  const a = 0.17883277,
    b = 1 - 4 * a,
    c = 0.5 - a * Math.log(4 * a);
  return v <= 0.5 ? (v * v) / 3 : (Math.exp((v - c) / a) + b) / 12;
}
const SRGB_FROM_XYZ = [
  3.24096994, -1.53738318, -0.49861076, -0.96924364, 1.8759675, 0.04155506, 0.05563008, -0.20397696,
  1.05697151,
];
const D65_FROM_D50 = [
  0.9555766, -0.0230393, 0.0631636, -0.0282895, 1.0099416, 0.0210077, 0.0122982, -0.020483,
  1.3299098,
];
const XYZ_FROM_P3 = [
  0.48657095, 0.26566769, 0.19821729, 0.22897456, 0.69173852, 0.07928691, 0, 0.04511338, 1.04394437,
];
const XYZ_FROM_2020 = [
  0.63695805, 0.1446169, 0.16888098, 0.26270021, 0.67799807, 0.05930172, 0, 0.02807269, 1.06098506,
];
const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const multiply = (a: number[], b: number[]) =>
  Array.from(
    { length: 9 },
    (_, i) =>
      a[Math.floor(i / 3) * 3] * b[i % 3] +
      a[Math.floor(i / 3) * 3 + 1] * b[3 + (i % 3)] +
      a[Math.floor(i / 3) * 3 + 2] * b[6 + (i % 3)],
  );
const apply = (m: number[], v: number[]) => [
  m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
  m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
  m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
];
function primaryMatrix(primaries: number): number[] {
  if (primaries === 1 || primaries === 2) return IDENTITY;
  if (primaries === 12) return multiply(SRGB_FROM_XYZ, XYZ_FROM_P3);
  if (primaries === 9) return multiply(SRGB_FROM_XYZ, XYZ_FROM_2020);
  throw new HeicError("UNSUPPORTED_FEATURE", "heic: HDR color primaries are not supported");
}
function iccProfile(bytes: Uint8Array): {
  transfer: number | null;
  primaries: number | null;
  matrix: number[];
  curves: ((v: number) => number)[];
} {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    text = new TextDecoder();
  const fail = () => {
    throw new HeicError("INVALID_CONTAINER", "heic: malformed ICC profile");
  };
  if (
    bytes.length < 132 ||
    text.decode(bytes.subarray(36, 40)) !== "acsp" ||
    text.decode(bytes.subarray(16, 20)) !== "RGB "
  )
    fail();
  const count = v.getUint32(128);
  if (count > 4096 || 132 + count * 12 > bytes.length) fail();
  const tags = new Map<string, DataView>();
  for (let i = 0; i < count; i++) {
    const p = 132 + i * 12,
      offset = v.getUint32(p + 4),
      length = v.getUint32(p + 8);
    if (offset + length > bytes.length || length < 8) fail();
    tags.set(
      text.decode(bytes.subarray(p, p + 4)),
      new DataView(bytes.buffer, bytes.byteOffset + offset, length),
    );
  }
  const cicp = tags.get("cicp"),
    transfer = cicp && cicp.byteLength >= 12 ? cicp.getUint8(9) : null,
    primaries = cicp && cicp.byteLength >= 12 ? cicp.getUint8(8) : null;
  const matrix: number[] = [];
  for (const tag of ["rXYZ", "gXYZ", "bXYZ"]) {
    const t = tags.get(tag);
    if (!t || t.byteLength < 20)
      throw new HeicError("UNSUPPORTED_FEATURE", "heic: ICC LUT profiles are not supported");
    matrix.push(t.getInt32(8) / 65536, t.getInt32(12) / 65536, t.getInt32(16) / 65536);
  }
  const xyz = [
    matrix[0],
    matrix[3],
    matrix[6],
    matrix[1],
    matrix[4],
    matrix[7],
    matrix[2],
    matrix[5],
    matrix[8],
  ];
  const curves = ["rTRC", "gTRC", "bTRC"].map((name) => {
    const t = tags.get(name);
    if (!t || t.byteLength < 12) fail();
    const type = String.fromCharCode(...Array.from({ length: 4 }, (_, i) => t!.getUint8(i)));
    if (type === "para") {
      const kind = t!.getUint16(8),
        n = [1, 3, 4, 5, 7][kind];
      if (!n || t!.byteLength < 12 + 4 * n)
        throw new HeicError("UNSUPPORTED_FEATURE", "heic: ICC parametric curve is not supported");
      const p = Array.from({ length: n }, (_, i) => t!.getInt32(12 + 4 * i) / 65536),
        [g, a, b, c, d, e, f] = p;
      return (x: number) =>
        kind === 0
          ? x ** g
          : kind === 1
            ? x >= -b / a
              ? (a * x + b) ** g
              : 0
            : kind === 2
              ? x >= -b / a
                ? (a * x + b) ** g + c
                : c
              : kind === 3
                ? x >= d
                  ? (a * x + b) ** g
                  : c * x
                : x >= d
                  ? (a * x + b) ** g + e
                  : c * x + f;
    }
    if (type === "curv") {
      const n = t!.getUint32(8);
      if (n > 65536 || 12 + 2 * n > t!.byteLength) fail();
      if (n === 0) return (x: number) => x;
      if (n === 1) {
        const gamma = t!.getUint16(12) / 256;
        return (x: number) => x ** gamma;
      }
      return (x: number) => {
        const f = Math.max(0, Math.min(n - 1, x * (n - 1))),
          lo = Math.floor(f),
          hi = Math.min(n - 1, lo + 1);
        return (
          (t!.getUint16(12 + 2 * lo) * (hi - f) +
            t!.getUint16(12 + 2 * hi) * (f - lo) +
            (lo === hi ? t!.getUint16(12 + 2 * lo) : 0)) /
          65535
        );
      };
    }
    throw new HeicError("UNSUPPORTED_FEATURE", "heic: ICC tone response curve is not supported");
  });
  return {
    transfer,
    primaries,
    matrix: multiply(SRGB_FROM_XYZ, multiply(D65_FROM_D50, xyz)),
    curves,
  };
}

function linearize(image: NativeImage, options: HdrOptions): HdrImage {
  const profile = image.info.icc ? iccProfile(image.info.icc) : null,
    transfer = profile?.transfer ?? image.info.color?.transfer ?? 13,
    primaries = profile?.primaries ?? image.info.color?.primaries ?? 1,
    max = 2 ** image.bitDepth - 1,
    white = options.referenceWhiteNits ?? 203,
    peak = options.displayPeakNits ?? 1000;
  const matrix = profile && !profile.transfer ? profile.matrix : primaryMatrix(primaries),
    out = new Float32Array(image.data.length);
  const gamma = 1.2 + 0.42 * Math.log10(peak / 1000);
  for (let i = 0; i < image.data.length; i += 4) {
    let rgb = [image.data[i] / max, image.data[i + 1] / max, image.data[i + 2] / max];
    if (transfer === 16) rgb = rgb.map((v) => pqToLinear(v, white));
    else if (transfer === 18) {
      rgb = rgb.map(hlgInverseOetf);
      const luminance = 0.2627 * rgb[0] + 0.678 * rgb[1] + 0.0593 * rgb[2],
        scale = luminance > 0 ? (luminance ** (gamma - 1) * peak) / white : 0;
      rgb = rgb.map((v) => v * scale);
    } else if (profile) rgb = rgb.map((v, c) => profile.curves[c](v));
    else if (transfer === 13 || transfer === 2) rgb = rgb.map(srgbToLinear);
    else if (transfer === 1 || transfer === 6 || transfer === 14 || transfer === 15)
      rgb = rgb.map(rec709ToLinear);
    else if (transfer !== 8)
      throw new HeicError("UNSUPPORTED_FEATURE", "heic: transfer function is not supported");
    rgb = apply(matrix, rgb);
    if (rgb.some((v) => !Number.isFinite(v)))
      throw new HeicError("INVALID_CONTAINER", "heic: non-finite HDR color value");
    out[i] = rgb[0];
    out[i + 1] = rgb[1];
    out[i + 2] = rgb[2];
    out[i + 3] = image.data[i + 3] / max;
  }
  return {
    width: image.width,
    height: image.height,
    bitDepth: image.bitDepth,
    data: out,
    hasAlpha: image.hasAlpha,
    colorSpace: "linear-srgb",
    headroom: transfer === 16 ? 10000 / white : transfer === 18 ? peak / white : 1,
    sourceHeadroom: transfer === 16 ? 10000 / white : transfer === 18 ? peak / white : 1,
    source: transfer === 16 ? "pq" : transfer === 18 ? "hlg" : "sdr",
  };
}

function metadata(ctx: RenderContext, itemId: number, type: string): Uint8Array[] {
  const meta = findBox(ctx.boxes, "meta")!,
    iinf = findBox(meta.children!, "iinf"),
    iref = findBox(meta.children!, "iref"),
    items = iinf ? parseIinf(iinf.data) : [],
    refs = iref ? parseIref(iref) : [];
  return refs
    .filter((ref) => ref.referenceType === "cdsc" && ref.toItemIds.includes(itemId))
    .flatMap((ref) =>
      items.find((item) => item.itemId === ref.fromItemId)?.itemType === type
        ? [getItemPayload(ctx.input, ctx.boxes, ref.fromItemId)!]
        : [],
    );
}
function appleHeadroom(payload: Uint8Array): number | null {
  // TIFF offsets are relative to the TIFF header; Apple's MakerNote uses its own origin.
  try {
    const pv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength),
      offset = 4 + pv.getUint32(0),
      tiff = payload.subarray(offset),
      v = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
    const little = v.getUint16(0) === 0x4949;
    if (v.getUint16(2, little) !== 42) return null;
    const find = (view: DataView, ifd: number, tag: number, le: boolean) => {
      const n = view.getUint16(ifd, le);
      if (n > 1024 || ifd + 2 + n * 12 > view.byteLength) return null;
      for (let i = 0; i < n; i++) {
        const p = ifd + 2 + i * 12;
        if (view.getUint16(p, le) === tag)
          return { type: view.getUint16(p + 2, le), count: view.getUint32(p + 4, le), at: p + 8 };
      }
      return null;
    };
    const exif = find(v, v.getUint32(4, little), 0x8769, little);
    if (!exif) return null;
    const note = find(v, v.getUint32(exif.at, little), 0x927c, little);
    if (!note) return null;
    const start = v.getUint32(note.at, little);
    if (start + note.count > v.byteLength) return null;
    const bytes = tiff.subarray(start, start + note.count);
    if (new TextDecoder().decode(bytes.subarray(0, 10)) !== "Apple iOS\0") return null;
    const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
      le = n.getUint16(12) === 0x4949;
    const real = (tag: number) => {
      const f = find(n, 14, tag, le);
      if (!f) return NaN;
      if (f.type === 11) return n.getFloat32(f.at, le);
      const p = n.getUint32(f.at, le);
      return f.type === 10
        ? n.getInt32(p, le) / n.getInt32(p + 4, le)
        : f.type === 5
          ? n.getUint32(p, le) / n.getUint32(p + 4, le)
          : NaN;
    };
    const a = real(33),
      b = real(48);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    const stops =
      a < 1
        ? b <= 0.01
          ? -20 * b + 1.8
          : -0.101 * b + 1.601
        : b <= 0.01
          ? -70 * b + 3
          : -0.303 * b + 2.303;
    const headroom = 2 ** Math.max(stops, 0);
    return Number.isFinite(headroom) ? headroom : null;
  } catch {
    return null;
  }
}
function sample(image: NativeImage, x: number, y: number, w: number, h: number, c: number): number {
  const fx = Math.max(0, Math.min(image.width - 1, ((x + 0.5) * image.width) / w - 0.5)),
    fy = Math.max(0, Math.min(image.height - 1, ((y + 0.5) * image.height) / h - 0.5)),
    x0 = Math.floor(fx),
    y0 = Math.floor(fy),
    x1 = Math.min(x0 + 1, image.width - 1),
    y1 = Math.min(y0 + 1, image.height - 1),
    a = fx - x0,
    b = fy - y0,
    max = 2 ** image.bitDepth - 1;
  const at = (px: number, py: number) => image.data[(py * image.width + px) * 4 + c] / max;
  return (
    (at(x0, y0) * (1 - a) + at(x1, y0) * a) * (1 - b) + (at(x0, y1) * (1 - a) + at(x1, y1) * a) * b
  );
}
export function decodeHDRSync(input: Uint8Array, options: HdrOptions = {}): HdrImage {
  try {
    if (!(input instanceof Uint8Array))
      throw new HeicError("INVALID_INPUT", "heic: expected Uint8Array");
    if (input.length > 64 * 1024 * 1024)
      throw new HeicError("RESOURCE_LIMIT", "heic: input exceeds 64 MiB");
    if (!isHeic(input)) throw new HeicError("UNSUPPORTED_FORMAT", "heic: not a HEIC file");
    for (const [name, value, min] of [
      ["displayHeadroom", options.displayHeadroom ?? Number.POSITIVE_INFINITY, 1],
      ["referenceWhiteNits", options.referenceWhiteNits ?? 203, 1],
      ["displayPeakNits", options.displayPeakNits ?? 1000, 1],
    ] as const)
      if (
        (!Number.isFinite(value) &&
          !(name === "displayHeadroom" && value === Number.POSITIVE_INFINITY)) ||
        value < min
      )
        throw new HeicError("INVALID_OPTIONS", "heic: invalid " + name);
    const maxPixels = options.maxPixels ?? 50_000_000;
    if (!Number.isSafeInteger(maxPixels) || maxPixels < 1 || maxPixels > 50_000_000)
      throw new HeicError("INVALID_OPTIONS", "heic: invalid maxPixels");
    const ctx = createRenderContext(input, options),
      info = getHeicInfo(input, ctx.boxes);
    if (info.primaryItemType === "tmap") return isoGainMap(ctx, info, options);
    const native = decodeNative(ctx),
      image = linearize(native, options),
      gain = info.auxiliaryImages.find(
        (aux) => aux.type === "urn:com:apple:photo:2020:aux:hdrgainmap",
      );
    if (gain) {
      const hasVersion = metadata(ctx, gain.itemId, "mime").some((bytes) =>
        new TextDecoder().decode(bytes).includes("HDRGainMapVersion"),
      );
      const headroom = metadata(ctx, info.primaryItemId, "Exif")
        .map(appleHeadroom)
        .find((value) => value !== null);
      if (!hasVersion || headroom === undefined || headroom === null)
        throw new HeicError("INVALID_CONTAINER", "heic: Apple gain-map metadata is incomplete");
      const map = decodeNative(ctx, gain.itemId, true),
        limit = Math.min(headroom, options.displayHeadroom ?? Number.POSITIVE_INFINITY);
      for (let y = 0; y < image.height; y++)
        for (let x = 0; x < image.width; x++) {
          // Apple published procedure specifies the inverse Rec.709 transfer.
          const factor =
              1 + (limit - 1) * rec709ToLinear(sample(map, x, y, image.width, image.height, 0)),
            i = (y * image.width + x) * 4;
          image.data[i] *= factor;
          image.data[i + 1] *= factor;
          image.data[i + 2] *= factor;
        }
      image.headroom = limit;
      image.sourceHeadroom = headroom;
      image.source = "apple-gainmap";
    }
    return image;
  } catch (error) {
    throw asHeicError(error);
  }
}

interface IsoGainMetadata {
  base: number;
  alternate: number;
  multichannel: boolean;
  useBase: boolean;
  min: number[];
  max: number[];
  gamma: number[];
  baseOffset: number[];
  alternateOffset: number[];
}
export function parseIsoGainMap(data: Uint8Array): IsoGainMetadata {
  if (data.length > 4096)
    throw new HeicError("RESOURCE_LIMIT", "heic: ISO gain-map metadata exceeds 4096 bytes");
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let p = 0;
  const need = (n: number) => {
    if (p + n > data.length)
      throw new HeicError("INVALID_CONTAINER", "heic: truncated ISO gain-map metadata");
  };
  const u8 = () => {
      need(1);
      return v.getUint8(p++);
    },
    u16 = () => {
      need(2);
      const n = v.getUint16(p);
      p += 2;
      return n;
    };
  if (u8() !== 0 || u16() !== 0)
    throw new HeicError("UNSUPPORTED_FEATURE", "heic: unsupported ISO gain-map metadata version");
  u16(); // writer version is informative; minimum reader version was checked above.
  const flags = u8();
  if (flags & 63)
    throw new HeicError("UNSUPPORTED_FEATURE", "heic: unsupported ISO gain-map flags");
  const ratio = (signed = false) => {
    need(8);
    const n = signed ? v.getInt32(p) : v.getUint32(p),
      d = v.getUint32(p + 4);
    p += 8;
    if (d === 0) throw new HeicError("INVALID_CONTAINER", "heic: zero gain-map denominator");
    return n / d;
  };
  const base = ratio(),
    alternate = ratio(),
    multichannel = !!(flags & 128),
    useBase = !!(flags & 64),
    min: number[] = [],
    max: number[] = [],
    gamma: number[] = [],
    baseOffset: number[] = [],
    alternateOffset: number[] = [];
  if (base === alternate || base >= 127 || alternate >= 127)
    throw new HeicError("INVALID_CONTAINER", "heic: invalid gain-map headroom");
  for (let c = 0; c < (multichannel ? 3 : 1); c++) {
    min.push(ratio(true));
    max.push(ratio(true));
    gamma.push(ratio());
    baseOffset.push(ratio(true));
    alternateOffset.push(ratio(true));
    if (max[c] < min[c] || gamma[c] <= 0)
      throw new HeicError("INVALID_CONTAINER", "heic: invalid ISO gain-map channel parameters");
  }
  if (p !== data.length)
    throw new HeicError("INVALID_CONTAINER", "heic: trailing ISO gain-map metadata");
  if (!multichannel)
    for (let c = 1; c < 3; c++)
      for (const array of [min, max, gamma, baseOffset, alternateOffset]) array[c] = array[0];
  return { base, alternate, multichannel, useBase, min, max, gamma, baseOffset, alternateOffset };
}
function inverse(m: number[]): number[] {
  const [a, b, c, d, e, f, g, h, i] = m,
    A = e * i - f * h,
    B = f * g - d * i,
    C = d * h - e * g,
    det = a * A + b * B + c * C;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-10)
    throw new HeicError("INVALID_CONTAINER", "heic: singular color matrix");
  return [
    A,
    c * h - b * i,
    b * f - c * e,
    B,
    a * i - c * g,
    c * d - a * f,
    C,
    b * g - a * h,
    a * e - b * d,
  ].map((v) => v / det);
}
function isoGainMap(
  ctx: RenderContext,
  info: ReturnType<typeof getHeicInfo>,
  options: HdrOptions,
): HdrImage {
  const payload = getItemPayload(ctx.input, ctx.boxes, info.primaryItemId);
  if (!payload || info.derivedItems.length !== 2)
    throw new HeicError(
      "INVALID_CONTAINER",
      "heic: ISO tone map must reference base and gain-map images",
    );
  const meta = parseIsoGainMap(payload),
    base = decodeNative(ctx, info.derivedItems[0]),
    map = decodeNative(ctx, info.derivedItems[1]),
    image = linearize(base, options);
  // Gain maps are applied in the selected image's linear color space, before
  // the final conversion to linear sRGB. Single-channel maps share the gain.
  let matrix: number[];
  if (meta.useBase) {
    const profile = base.info.icc ? iccProfile(base.info.icc) : null;
    matrix =
      profile && !profile.transfer
        ? profile.matrix
        : primaryMatrix(profile?.primaries ?? base.info.color?.primaries ?? 1);
  } else {
    if (!info.color && !info.icc)
      throw new HeicError(
        "UNSUPPORTED_FEATURE",
        "heic: ISO alternate working color space is unspecified",
      );
    const profile = info.icc ? iccProfile(info.icc) : null;
    matrix =
      profile && !profile.transfer
        ? profile.matrix
        : primaryMatrix(profile?.primaries ?? info.color?.primaries ?? 1);
  }
  const inv = inverse(matrix),
    target = Math.min(
      Math.max(
        Math.log2(options.displayHeadroom ?? Number.POSITIVE_INFINITY),
        Math.min(meta.base, meta.alternate),
      ),
      Math.max(meta.base, meta.alternate),
    ),
    progress = (target - meta.base) / (meta.alternate - meta.base),
    weight = meta.alternate > meta.base ? progress : -progress;
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const i = (y * image.width + x) * 4,
        working = apply(inv, [image.data[i], image.data[i + 1], image.data[i + 2]]);
      if (weight !== 0)
        for (let c = 0; c < 3; c++) {
          const encoded = sample(map, x, y, image.width, image.height, meta.multichannel ? c : 0),
            gain = meta.min[c] + (meta.max[c] - meta.min[c]) * encoded ** (1 / meta.gamma[c]);
          working[c] =
            (working[c] + meta.baseOffset[c]) * 2 ** (gain * weight) - meta.alternateOffset[c];
        }
      const rgb = apply(matrix, working);
      if (rgb.some((v) => !Number.isFinite(v)))
        throw new HeicError("INVALID_CONTAINER", "heic: non-finite gain-map output");
      image.data[i] = rgb[0];
      image.data[i + 1] = rgb[1];
      image.data[i + 2] = rgb[2];
    }
  image.source = "iso-gainmap";
  image.headroom = 2 ** target;
  image.sourceHeadroom = 2 ** Math.max(meta.base, meta.alternate);
  return image;
}
