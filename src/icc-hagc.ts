import { HeicError } from './errors.js';
import { getRgbToXyzD65Matrix } from './color-matrix.js';

export type IccHagcMixingType = 0 | 1 | 2 | 3;

export interface IccHagcComponentMixing {
  type: IccHagcMixingType;
  /** Red, green, blue, maximum, minimum, and per-component weights. */
  coefficients: readonly [number, number, number, number, number, number];
}

export interface IccHagcControlPoint {
  x: number;
  y: number;
  slope: number;
}

export interface IccHagcAlternateImage {
  headroom: number;
  componentMixing: IccHagcComponentMixing;
  controlPoints: readonly IccHagcControlPoint[];
  usesPchipSlopes: boolean;
}

export interface IccHagcToneMap {
  baselineHeadroom: number;
  chromaticities: readonly [number, number, number, number, number, number, number, number];
  referenceWhiteToneMapping: boolean;
  alternateImages: readonly IccHagcAlternateImage[];
}

export interface IccHeadroomAdaptiveGainCurve {
  applicationVersion: number;
  minimumApplicationVersion: number;
  referenceWhiteNits: number;
  hasCustomReferenceWhite: boolean;
  toneMap: IccHagcToneMap | null;
}

function malformed(): never {
  throw new HeicError('INVALID_CONTAINER', 'heic: malformed ICC HAGC tag');
}

function signature(view: DataView, offset: number): string {
  if (offset < 0 || offset + 4 > view.byteLength) malformed();
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

class BitReader {
  private position = 0;

  constructor(private readonly view: DataView) {}

  read(count: number): number {
    if (
      !Number.isInteger(count) ||
      count < 0 ||
      count > 16 ||
      this.position + count > this.view.byteLength * 8
    )
      malformed();
    let value = 0;
    for (let bit = 0; bit < count; bit++, this.position++)
      value =
        (value << 1) |
        ((this.view.getUint8(this.position >>> 3) >>> (7 - (this.position & 7))) & 1);
    return value;
  }

  readU16(): number {
    return this.read(16);
  }
}

const clamp = (value: number, lower: number, upper: number) =>
  Math.max(lower, Math.min(upper, value));
const sign = (value: number) => (value < 0 ? -1 : value > 0 ? 1 : 0);

function pchipSlopes(points: readonly { x: number; y: number }[]): number[] {
  const count = points.length;
  if (count === 1) return [0];
  const intervals = Array.from(
      { length: count - 1 },
      (_, index) => points[index + 1]!.x - points[index]!.x,
    ),
    slopes = intervals.map((width, index) =>
      width === 0 ? 0 : (points[index + 1]!.y - points[index]!.y) / width,
    );
  return Array.from({ length: count }, (_, index) => {
    if (
      index > 0 &&
      index + 1 < count &&
      points[index - 1]!.x < points[index]!.x &&
      points[index]!.x < points[index + 1]!.x
    ) {
      const before = intervals[index - 1]!,
        after = intervals[index]!,
        priorSlope = slopes[index - 1]!,
        nextSlope = slopes[index]!;
      if (sign(priorSlope) !== sign(nextSlope) || (priorSlope === 0 && nextSlope === 0)) return 0;
      return (
        (3 * (before + after) * priorSlope * nextSlope) /
        ((2 * before + after) * priorSlope + (before + 2 * after) * nextSlope)
      );
    }
    if (index === 0 && count > 1 && points[0]!.x < points[1]!.x) {
      if (count > 2 && points[1]!.x < points[2]!.x) {
        const width = intervals[0]!,
          nextWidth = intervals[1]!,
          slope = ((2 * width + nextWidth) * slopes[0]! - width * slopes[1]!) / (width + nextWidth);
        if (sign(slope) !== sign(slopes[0]!)) return 0;
        if (sign(slopes[0]!) !== sign(slopes[1]!) && Math.abs(slope) > 3 * Math.abs(slopes[0]!))
          return 3 * slopes[0]!;
        return slope;
      }
      return slopes[0]!;
    }
    if (index === count - 1 && count > 1 && points[index - 1]!.x < points[index]!.x) {
      if (count > 2 && points[index - 2]!.x < points[index - 1]!.x) {
        const width = intervals[index - 1]!,
          priorWidth = intervals[index - 2]!,
          slope =
            ((2 * width + priorWidth) * slopes[index - 1]! - width * slopes[index - 2]!) /
            (width + priorWidth);
        if (sign(slope) !== sign(slopes[index - 1]!)) return 0;
        if (
          sign(slopes[index - 1]!) !== sign(slopes[index - 2]!) &&
          Math.abs(slope) > 3 * Math.abs(slopes[index - 1]!)
        )
          return 3 * slopes[index - 1]!;
        return slope;
      }
      return slopes[index - 1]!;
    }
    return 0;
  });
}

function componentMixing(reader: BitReader): IccHagcComponentMixing {
  const type = reader.read(2) as IccHagcMixingType;
  if (type !== 3) {
    if (reader.read(6) !== 0) malformed();
    if (type === 0) return { type, coefficients: [0, 0, 0, 1, 0, 0] };
    if (type === 1) return { type, coefficients: [0, 0, 0, 0, 0, 1] };
    return { type, coefficients: [1 / 6, 1 / 6, 1 / 6, 1 / 2, 0, 0] };
  }
  const flags = Array.from({ length: 6 }, () => reader.read(1) !== 0),
    values = flags.map((present) =>
      present ? Math.min(reader.readU16(), 50_000) / 50_000 : 0,
    ) as [number, number, number, number, number, number];
  if (values.reduce((total, value) => total + value, 0) <= 0) malformed();
  return { type, coefficients: values };
}

function parseGainCurve(
  reader: BitReader,
  baselineHeadroom: number,
  alternateHeadroom: number,
  shared?: { pointCount: number; usePchip: boolean; x: number[] },
): {
  curve: IccHagcAlternateImage['controlPoints'];
  pointCount: number;
  usePchip: boolean;
  x: number[];
} {
  let pointCount: number, usePchip: boolean, x: number[];
  if (!shared) {
    pointCount = reader.read(5) + 1;
    usePchip = reader.read(1) !== 0;
    if (reader.read(2) !== 0) malformed();
    x = Array.from({ length: pointCount }, () => Math.min(reader.readU16(), 64_000) / 1_000);
  } else {
    ({ pointCount, usePchip, x } = shared);
  }

  const direction = baselineHeadroom < alternateHeadroom ? 1 : -1,
    y = Array.from(
      { length: pointCount },
      () => direction * (Math.min(reader.readU16(), 60_000) / 10_000),
    ),
    specifiedSlopes = usePchip
      ? null
      : Array.from({ length: pointCount }, () => {
          const theta = clamp(reader.readU16(), 1, 35_999);
          return Math.tan(((theta - 18_000) * Math.PI) / 36_000);
        }),
    points = x.map((value, index) => ({ x: value, y: y[index]! }));
  for (let index = 1; index < points.length; index++)
    if (
      points[index]!.x < points[index - 1]!.x ||
      (points[index]!.x === points[index - 1]!.x && points[index]!.y !== points[index - 1]!.y)
    )
      malformed();
  const slopes = specifiedSlopes ?? pchipSlopes(points);
  if (slopes.some((value) => !Number.isFinite(value))) malformed();
  return {
    curve: points.map(({ x: pointX, y: pointY }, index) => ({
      x: pointX,
      y: pointY,
      slope: slopes[index]!,
    })),
    pointCount,
    usePchip,
    x,
  };
}

const BT709: IccHagcToneMap['chromaticities'] = [0.64, 0.33, 0.3, 0.6, 0.15, 0.06, 0.3127, 0.329],
  ST2113: IccHagcToneMap['chromaticities'] = [0.68, 0.32, 0.265, 0.69, 0.15, 0.06, 0.3127, 0.329],
  BT2020: IccHagcToneMap['chromaticities'] = [
    0.708, 0.292, 0.17, 0.797, 0.131, 0.046, 0.3127, 0.329,
  ];

function bezierGainCurve(
  xKnee: number,
  yKnee: number,
  xMax: number,
  yMax: number,
  compression: number,
): IccHagcControlPoint[] {
  const xMid = (1 - compression) * xKnee + (compression * (xKnee * yMax)) / yKnee,
    yMid = (1 - compression) * yKnee + compression * yMax,
    ax = xKnee - 2 * xMid + xMax,
    bx = 2 * xMid - 2 * xKnee,
    ay = yKnee - 2 * yMid + yMax,
    by = 2 * yMid - 2 * yKnee;
  return Array.from({ length: 8 }, (_, index) => {
    const t = index / 7,
      x = ax * t * t + bx * t + xKnee,
      y = ay * t * t + by * t + yKnee,
      dyDx = (2 * ay * t + by) / (2 * ax * t + bx),
      gain = Math.log2(y / x),
      slope = (x * dyDx - y) / (Math.LN2 * x * y);
    return { x, y: gain, slope };
  });
}

function referenceWhiteToneMap(baselineHeadroom: number): IccHagcToneMap {
  const normalization = Math.log2(1_000 / 203),
    scaledHeadroom = Math.min(baselineHeadroom / normalization, 1),
    alternateHeadrooms = baselineHeadroom === 0 ? [] : [0, Math.log2(8 / 3) * scaledHeadroom],
    alternateImages = alternateHeadrooms.map((headroom, index) => {
      const white = index === 0 ? 1 - 0.5 * scaledHeadroom : 1,
        points = bezierGainCurve(1, white, 2 ** baselineHeadroom, 2 ** headroom, 0.65);
      return {
        headroom,
        componentMixing: { type: 0 as const, coefficients: [0, 0, 0, 1, 0, 0] as const },
        controlPoints: points,
        usesPchipSlopes: false,
      };
    });
  return {
    baselineHeadroom,
    chromaticities: BT2020,
    referenceWhiteToneMapping: true,
    alternateImages,
  };
}

/** Parse an ICC.1 HAGC tag. A null result means its minimum application version is unknown. */
export function parseIccHagcTag(tag: DataView): IccHeadroomAdaptiveGainCurve | null {
  if (tag.byteLength < 12 || signature(tag, 0) !== 'hagc' || tag.getUint32(4) !== 0) malformed();
  const metadataSize = tag.getUint32(8),
    trailingBytes = tag.byteLength - 12 - metadataSize;
  if (metadataSize > tag.byteLength - 12 || trailingBytes < 0 || trailingBytes > 3) malformed();
  for (let offset = 12 + metadataSize; offset < tag.byteLength; offset++)
    if (tag.getUint8(offset) !== 0) malformed();
  const metadata = new DataView(tag.buffer, tag.byteOffset + 12, metadataSize),
    reader = new BitReader(metadata),
    applicationVersion = reader.read(3),
    minimumApplicationVersion = reader.read(3);
  if (reader.read(2) !== 0) malformed();
  if (minimumApplicationVersion !== 0) return null;

  const hasCustomReferenceWhite = reader.read(1) !== 0,
    hasAdaptiveToneMap = reader.read(1) !== 0;
  if (reader.read(6) !== 0) malformed();
  const customReferenceWhite = hasCustomReferenceWhite ? reader.readU16() : null,
    referenceWhiteNits =
      customReferenceWhite === null
        ? 203
        : Math.min(clamp(customReferenceWhite, 1, 50_000), 50_000) / 5;
  if (!hasAdaptiveToneMap)
    return {
      applicationVersion,
      minimumApplicationVersion,
      referenceWhiteNits,
      hasCustomReferenceWhite,
      toneMap: null,
    };

  const baselineHeadroom = Math.min(reader.readU16(), 60_000) / 10_000,
    referenceWhiteToneMapping = reader.read(1) !== 0;
  if (baselineHeadroom > 6) malformed();
  let toneMap: IccHagcToneMap;
  if (referenceWhiteToneMapping) {
    if (reader.read(7) !== 0) malformed();
    toneMap = referenceWhiteToneMap(baselineHeadroom);
  } else {
    const encodedCount = reader.read(3),
      alternateCount = Math.min(encodedCount, 4),
      chromaticityMode = reader.read(2),
      hasCommonMixing = reader.read(1) !== 0,
      hasCommonCurve = reader.read(1) !== 0;
    let chromaticities: IccHagcToneMap['chromaticities'];
    if (chromaticityMode === 0) chromaticities = BT709;
    else if (chromaticityMode === 1) chromaticities = ST2113;
    else if (chromaticityMode === 2) chromaticities = BT2020;
    else
      chromaticities = Array.from(
        { length: 8 },
        () => Math.min(reader.readU16(), 50_000) / 50_000,
      ) as unknown as IccHagcToneMap['chromaticities'];

    let priorMixing: IccHagcComponentMixing | undefined,
      priorCurve: { pointCount: number; usePchip: boolean; x: number[] } | undefined;
    const alternateImages: IccHagcAlternateImage[] = [];
    for (let index = 0; index < alternateCount; index++) {
      const headroom = Math.min(reader.readU16(), 60_000) / 10_000;
      if (
        headroom > 6 ||
        headroom === baselineHeadroom ||
        (index > 0 && headroom <= alternateImages[index - 1]!.headroom)
      )
        malformed();
      const mixing = index > 0 && hasCommonMixing ? priorMixing! : componentMixing(reader);
      priorMixing ??= mixing;
      const parsedCurve = parseGainCurve(
        reader,
        baselineHeadroom,
        headroom,
        index > 0 && hasCommonCurve ? priorCurve : undefined,
      );
      priorCurve ??= {
        pointCount: parsedCurve.pointCount,
        usePchip: parsedCurve.usePchip,
        x: parsedCurve.x,
      };
      alternateImages.push({
        headroom,
        componentMixing: mixing,
        controlPoints: parsedCurve.curve,
        usesPchipSlopes: parsedCurve.usePchip,
      });
    }
    if (
      chromaticities.some((value, index) => {
        const isX = index % 2 === 0,
          coordinateIndex = Math.floor(index / 2) * 2;
        return (
          value < 0 ||
          value > 1 ||
          (!isX && value === 0) ||
          (isX && value + chromaticities[coordinateIndex + 1]! > 1)
        );
      })
    )
      malformed();
    gainApplicationMatrix(chromaticities);
    toneMap = {
      baselineHeadroom,
      chromaticities,
      referenceWhiteToneMapping: false,
      alternateImages,
    };
  }
  return {
    applicationVersion,
    minimumApplicationVersion,
    referenceWhiteNits,
    hasCustomReferenceWhite,
    toneMap,
  };
}

type Matrix3 = readonly [number, number, number, number, number, number, number, number, number];

function multiply3(left: Matrix3, right: Matrix3): Matrix3 {
  return Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3),
      column = index % 3;
    return (
      left[row * 3]! * right[column]! +
      left[row * 3 + 1]! * right[3 + column]! +
      left[row * 3 + 2]! * right[6 + column]!
    );
  }) as unknown as Matrix3;
}

function apply3(matrix: Matrix3, rgb: readonly [number, number, number]): [number, number, number] {
  return [
    matrix[0] * rgb[0] + matrix[1] * rgb[1] + matrix[2] * rgb[2],
    matrix[3] * rgb[0] + matrix[4] * rgb[1] + matrix[5] * rgb[2],
    matrix[6] * rgb[0] + matrix[7] * rgb[1] + matrix[8] * rgb[2],
  ];
}

function inverse3([a, b, c, d, e, f, g, h, i]: Matrix3): Matrix3 {
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(determinant) || determinant === 0) malformed();
  return [
    (e * i - f * h) / determinant,
    (c * h - b * i) / determinant,
    (b * f - c * e) / determinant,
    (f * g - d * i) / determinant,
    (a * i - c * g) / determinant,
    (c * d - a * f) / determinant,
    (d * h - e * g) / determinant,
    (b * g - a * h) / determinant,
    (a * e - b * d) / determinant,
  ];
}

function gainApplicationMatrix(chromaticities: IccHagcToneMap['chromaticities']): Matrix3 {
  const [xr, yr, xg, yg, xb, yb, xw, yw] = chromaticities,
    zFromXy = (x: number, y: number) => (1 - x - y) / y,
    unscaled: Matrix3 = [
      xr / yr,
      xg / yg,
      xb / yb,
      1,
      1,
      1,
      zFromXy(xr, yr),
      zFromXy(xg, yg),
      zFromXy(xb, yb),
    ],
    white: [number, number, number] = [xw / yw, 1, zFromXy(xw, yw)],
    unscaledInverse = inverse3(unscaled),
    scale = apply3(unscaledInverse, white);
  if (scale.some((value) => !Number.isFinite(value) || value <= 0)) malformed();
  const native: Matrix3 = [
      unscaled[0] * scale[0],
      unscaled[1] * scale[1],
      unscaled[2] * scale[2],
      scale[0],
      scale[1],
      scale[2],
      unscaled[6] * scale[0],
      unscaled[7] * scale[1],
      unscaled[8] * scale[2],
    ],
    bradford: Matrix3 = [0.8951, 0.2664, -0.1614, -0.7502, 1.7135, 0.0367, 0.0389, -0.0685, 1.0296],
    bradfordInverse = inverse3(bradford),
    d65: [number, number, number] = [0.3127 / 0.329, 1, (1 - 0.3127 - 0.329) / 0.329],
    sourceLms = apply3(bradford, white),
    targetLms = apply3(bradford, d65),
    adaptationScale = sourceLms.map((value, index) => targetLms[index]! / value),
    adaptation = multiply3(
      bradfordInverse,
      multiply3(
        [adaptationScale[0]!, 0, 0, 0, adaptationScale[1]!, 0, 0, 0, adaptationScale[2]!],
        bradford,
      ),
    );
  if (adaptationScale.some((value) => !Number.isFinite(value))) malformed();
  return multiply3(adaptation, native);
}

function gainCurve(points: readonly IccHagcControlPoint[], value: number): number {
  if (value < points[0]!.x) return points[0]!.y;
  for (let index = 0; index < points.length; index++)
    if (value === points[index]!.x) return points[index]!.y;
  for (let index = 0; index + 1 < points.length; index++) {
    const left = points[index]!,
      right = points[index + 1]!;
    if (left.x < value && value < right.x) {
      const width = right.x - left.x,
        leftSlope = width * left.slope,
        rightSlope = width * right.slope,
        t = (value - left.x) / width,
        c3 = 2 * left.y + leftSlope - 2 * right.y + rightSlope,
        c2 = -3 * left.y + 3 * right.y - 2 * leftSlope - rightSlope,
        c1 = leftSlope,
        c0 = left.y;
      return c3 * t ** 3 + c2 * t ** 2 + c1 * t + c0;
    }
  }
  const last = points[points.length - 1]!;
  if (value <= last.x) return last.y;
  if (last.x === 0) return Number.NEGATIVE_INFINITY;
  return last.y + Math.log2(last.x / value);
}

function gainForAlternate(
  alternate: IccHagcAlternateImage,
  rgb: readonly [number, number, number],
): [number, number, number] {
  const [red, green, blue, maximum, minimum, component] = alternate.componentMixing.coefficients,
    max = Math.max(...rgb),
    min = Math.min(...rgb),
    common = rgb[0] * red + rgb[1] * green + rgb[2] * blue + max * maximum + min * minimum,
    mixed = rgb.map(
      (value) =>
        (value * component + common) / (red + green + blue + maximum + minimum + component),
    ) as [number, number, number];
  return mixed.map((value) => gainCurve(alternate.controlPoints, value)) as [
    number,
    number,
    number,
  ];
}

/** Prepare the SMPTE ST 2094-50 HAGC transform for a display headroom ratio. */
export function createIccHagcToneMap(
  toneMap: IccHagcToneMap,
  targetHeadroomRatio: number,
): {
  targetHeadroom: number;
  maximumHeadroom: number;
  apply(rgb: readonly [number, number, number]): [number, number, number];
} {
  const baseline = toneMap.baselineHeadroom,
    allHeadrooms = [baseline, ...toneMap.alternateImages.map((image) => image.headroom)],
    minimumHeadroom = Math.min(...allHeadrooms),
    maximumHeadroom = Math.max(...allHeadrooms),
    requested = Math.log2(targetHeadroomRatio),
    targetHeadroom = clamp(requested, minimumHeadroom, maximumHeadroom),
    applicationToXyz = gainApplicationMatrix(toneMap.chromaticities),
    srgbToXyz = getRgbToXyzD65Matrix(1) as Matrix3,
    srgbToApplication = multiply3(inverse3(applicationToXyz), srgbToXyz),
    applicationToSrgb = multiply3(inverse3(srgbToXyz), applicationToXyz),
    knots = [
      ...toneMap.alternateImages.map((alternate) => ({
        headroom: alternate.headroom,
        evaluate: (rgb: readonly [number, number, number]) => gainForAlternate(alternate, rgb),
      })),
      {
        headroom: baseline,
        evaluate: (_rgb: readonly [number, number, number]) =>
          [0, 0, 0] as [number, number, number],
      },
    ].sort((left, right) => left.headroom - right.headroom);
  if (!Number.isFinite(requested) && requested !== Number.POSITIVE_INFINITY) malformed();
  const lowerIndex = Math.max(0, knots.findIndex((knot) => knot.headroom >= targetHeadroom) - 1),
    lower = knots[lowerIndex]!,
    upper = knots[Math.min(knots.length - 1, lowerIndex + 1)]!,
    exact = knots.find((knot) => knot.headroom === targetHeadroom),
    weight =
      exact || upper.headroom === lower.headroom
        ? 0
        : (targetHeadroom - lower.headroom) / (upper.headroom - lower.headroom);
  return {
    targetHeadroom,
    maximumHeadroom,
    apply(rgb) {
      const input = apply3(srgbToApplication, rgb),
        lowerGain = (exact ?? lower).evaluate(input),
        upperGain = exact ? lowerGain : upper.evaluate(input),
        output = input.map((value, channel) => {
          const gain =
            exact || weight === 0
              ? lowerGain[channel]!
              : weight === 1
                ? upperGain[channel]!
                : lowerGain[channel]! * (1 - weight) + upperGain[channel]! * weight;
          return value * 2 ** gain;
        }) as [number, number, number],
        converted = apply3(applicationToSrgb, output);
      if (converted.some((value) => !Number.isFinite(value)))
        throw new HeicError('INVALID_CONTAINER', 'heic: non-finite ICC HAGC output');
      return converted;
    },
  };
}
