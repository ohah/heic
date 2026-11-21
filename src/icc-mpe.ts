import { HeicError } from './errors.js';

interface ProcessingElement {
  inputChannels: number;
  outputChannels: number;
  interpolationWorkPerPixel?: number;
  apply(input: readonly number[]): number[];
}

type CurveSegment =
  | { kind: 'formula'; evaluate(value: number): number }
  | { kind: 'sampled'; samples: number[] };

const MAX_MPE_ELEMENTS = 256,
  MAX_MPE_CHANNELS = 16,
  MAX_MPE_CLUT_INTERPOLATION_WORK = 1_000_000_000,
  MAX_MPE_CURVE_SEGMENTS = 4096,
  MAX_MPE_SAMPLES = 65_536;

function malformed(): never {
  throw new HeicError('INVALID_CONTAINER', 'heic: malformed ICC multi-process transform');
}

function unsupported(message: string): never {
  throw new HeicError('UNSUPPORTED_FEATURE', `heic: ${message}`);
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

function float32(view: DataView, offset: number): number {
  if (offset < 0 || offset + 4 > view.byteLength) malformed();
  const value = view.getFloat32(offset);
  if (!Number.isFinite(value)) malformed();
  return value;
}

function subview(view: DataView, offset: number, length: number): DataView {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > view.byteLength
  )
    malformed();
  return new DataView(view.buffer, view.byteOffset + offset, length);
}

function requireZeroPadding(view: DataView, contentLength: number): void {
  if (contentLength > view.byteLength || view.byteLength - contentLength > 3) malformed();
  for (let offset = contentLength; offset < view.byteLength; offset++)
    if (view.getUint8(offset) !== 0) malformed();
}

function parseCurveFormula(view: DataView): CurveSegment {
  if (view.byteLength < 12 || signature(view, 0) !== 'parf' || view.getUint32(4) !== 0) malformed();
  if (view.getUint16(10) !== 0) malformed();
  const kind = view.getUint16(8),
    parameterCount = kind === 0 ? 4 : kind === 1 || kind === 2 ? 5 : 0;
  if (!parameterCount) unsupported('ICC MPE formula curve type is not supported');
  const length = 12 + parameterCount * 4;
  requireZeroPadding(view, length);
  const parameters = Array.from({ length: parameterCount }, (_, index) =>
    float32(view, 12 + index * 4),
  );
  if (kind === 0) {
    const [gamma, a, b, c] = parameters;
    return {
      kind: 'formula',
      evaluate: (value) => (a! * value + b!) ** gamma! + c!,
    };
  }
  if (kind === 1) {
    const [gamma, a, b, c, d] = parameters;
    return {
      kind: 'formula',
      evaluate: (value) => a! * Math.log10(b! * value ** gamma! + c!) + d!,
    };
  }
  const [a, b, c, d, e] = parameters;
  return {
    kind: 'formula',
    evaluate: (value) => a! * b! ** (c! * value + d!) + e!,
  };
}

function parseCurveSegment(view: DataView): CurveSegment {
  const type = signature(view, 0);
  if (type === 'parf') return parseCurveFormula(view);
  if (type !== 'samf') return unsupported('ICC MPE curve segment type is not supported');
  if (view.byteLength < 12 || view.getUint32(4) !== 0) malformed();
  const count = view.getUint32(8),
    length = 12 + count * 4;
  if (count < 1 || !Number.isSafeInteger(length)) malformed();
  if (count > MAX_MPE_SAMPLES)
    unsupported('ICC MPE sampled curves exceed the supported sample limit');
  requireZeroPadding(view, length);
  return {
    kind: 'sampled',
    samples: Array.from({ length: count }, (_, index) => float32(view, 12 + index * 4)),
  };
}

function parseCurve(view: DataView): (value: number) => number {
  if (view.byteLength < 12 || signature(view, 0) !== 'curf' || view.getUint32(4) !== 0) malformed();
  const segmentCount = view.getUint16(8),
    breakPointTableEnd = 12 + Math.max(0, segmentCount - 1) * 4;
  if (segmentCount < 1 || view.getUint16(10) !== 0) malformed();
  if (segmentCount > MAX_MPE_CURVE_SEGMENTS)
    unsupported('ICC MPE curves exceed the supported segment limit');
  if (breakPointTableEnd > view.byteLength) malformed();
  const breakPoints = Array.from({ length: segmentCount - 1 }, (_, index) =>
    float32(view, 12 + index * 4),
  );
  for (let index = 1; index < breakPoints.length; index++)
    if (breakPoints[index]! < breakPoints[index - 1]!) malformed();

  const segments: CurveSegment[] = [];
  let cursor = breakPointTableEnd;
  for (let index = 0; index < segmentCount; index++) {
    if (cursor + 12 > view.byteLength) malformed();
    const type = signature(view, cursor),
      length =
        type === 'parf'
          ? 12 + (view.getUint16(cursor + 8) === 0 ? 4 : 5) * 4
          : type === 'samf'
            ? 12 + view.getUint32(cursor + 8) * 4
            : 0;
    if (length === 0 || cursor + length > view.byteLength) malformed();
    const segment = parseCurveSegment(subview(view, cursor, length));
    if ((index === 0 || index === segmentCount - 1) && segment.kind !== 'formula') malformed();
    segments.push(segment);
    cursor += length;
  }
  requireZeroPadding(view, cursor);

  const evaluateSegment = (index: number, value: number): number => {
    const segment = segments[index]!;
    if (segment.kind === 'formula') return segment.evaluate(value);
    const lower = breakPoints[index - 1]!,
      upper = breakPoints[index]!,
      priorValue = evaluateSegment(index - 1, lower),
      position = ((value - lower) / (upper - lower)) * segment.samples.length;
    if (position <= 1) return priorValue + (segment.samples[0]! - priorValue) * position;
    const samplePosition = position - 1,
      lowerIndex = Math.min(segment.samples.length - 1, Math.floor(samplePosition)),
      upperIndex = Math.min(segment.samples.length - 1, lowerIndex + 1),
      fraction = samplePosition - lowerIndex;
    return segment.samples[lowerIndex]! * (1 - fraction) + segment.samples[upperIndex]! * fraction;
  };

  return (value) => {
    let index = 0;
    while (index < breakPoints.length && value > breakPoints[index]!) index++;
    const result = evaluateSegment(index, value);
    if (!Number.isFinite(result)) malformed();
    return result;
  };
}

function readPositions(
  view: DataView,
  count: number,
  tableEnd: number,
): { offset: number; size: number }[] {
  const tableEndExpected = 12 + count * 8;
  if (tableEnd !== tableEndExpected || tableEnd > view.byteLength) malformed();
  return Array.from({ length: count }, (_, index) => {
    const offset = view.getUint32(12 + index * 8),
      size = view.getUint32(16 + index * 8);
    if (offset < tableEnd || offset % 4 !== 0 || size < 4 || offset + size > view.byteLength)
      malformed();
    return { offset, size };
  });
}

function parseCurveSet(view: DataView): ProcessingElement {
  if (view.byteLength < 12 || view.getUint32(4) !== 0) malformed();
  const inputChannels = view.getUint16(8),
    outputChannels = view.getUint16(10);
  if (inputChannels < 1 || outputChannels !== inputChannels) malformed();
  if (inputChannels > MAX_MPE_CHANNELS)
    unsupported('ICC MPE curve sets exceed the supported channel limit');
  const tableEnd = 12 + inputChannels * 8,
    positions = readPositions(view, inputChannels, tableEnd),
    curves = positions.map(({ offset, size }) => parseCurve(subview(view, offset, size)));
  if (positions[0]!.offset !== tableEnd) malformed();
  return {
    inputChannels,
    outputChannels,
    apply(input) {
      if (input.length !== inputChannels) malformed();
      return input.map((value, index) => {
        const result = curves[index]!(value);
        if (!Number.isFinite(result)) malformed();
        return result;
      });
    },
  };
}

function parseMatrix(view: DataView): ProcessingElement {
  if (view.byteLength < 12 || signature(view, 0) !== 'matf' || view.getUint32(4) !== 0) malformed();
  const inputChannels = view.getUint16(8),
    outputChannels = view.getUint16(10),
    requiredLength = 12 + 4 * outputChannels * (inputChannels + 1);
  if (inputChannels < 1 || outputChannels < 1 || !Number.isSafeInteger(requiredLength)) malformed();
  if (inputChannels > MAX_MPE_CHANNELS || outputChannels > MAX_MPE_CHANNELS)
    unsupported('ICC MPE matrices exceed the supported channel limit');
  requireZeroPadding(view, requiredLength);
  const matrix = Array.from({ length: outputChannels * inputChannels }, (_, index) =>
      float32(view, 12 + index * 4),
    ),
    offsets = Array.from({ length: outputChannels }, (_, index) =>
      float32(view, 12 + (outputChannels * inputChannels + index) * 4),
    );
  return {
    inputChannels,
    outputChannels,
    apply(input) {
      if (input.length !== inputChannels) malformed();
      return offsets.map((offset, output) => {
        let result = offset;
        for (let channel = 0; channel < inputChannels; channel++)
          result += matrix[output * inputChannels + channel]! * input[channel]!;
        if (!Number.isFinite(result)) malformed();
        return result;
      });
    },
  };
}

function parseClut(view: DataView): ProcessingElement {
  if (view.byteLength < 28 || signature(view, 0) !== 'clut' || view.getUint32(4) !== 0) malformed();
  const inputChannels = view.getUint16(8),
    outputChannels = view.getUint16(10);
  if (inputChannels < 1 || outputChannels < 1) malformed();
  if (inputChannels > MAX_MPE_CHANNELS || outputChannels > MAX_MPE_CHANNELS)
    unsupported('ICC MPE CLUTs exceed the supported channel limit');
  const grids = Array.from({ length: inputChannels }, (_, index) => view.getUint8(12 + index)),
    unusedGrids = Array.from({ length: 16 - inputChannels }, (_, index) =>
      view.getUint8(12 + inputChannels + index),
    );
  if (grids.some((grid) => grid < 2) || unusedGrids.some((grid) => grid !== 0)) malformed();
  const gridPoints = grids.reduce((product, grid) => product * grid, 1),
    dataLength = gridPoints * outputChannels * 4,
    requiredLength = 28 + dataLength;
  if (!Number.isSafeInteger(requiredLength) || requiredLength > view.byteLength) malformed();
  requireZeroPadding(view, requiredLength);
  const corners = 2 ** inputChannels,
    interpolationWorkPerPixel = corners * (2 * inputChannels + outputChannels) + 6 * inputChannels;
  if (!Number.isSafeInteger(interpolationWorkPerPixel))
    unsupported('ICC MPE CLUT interpolation work exceeds the supported limit');
  const strides: number[] = [];
  let stride = 1;
  for (const grid of grids) {
    strides.push(stride);
    stride *= grid;
  }

  return {
    inputChannels,
    outputChannels,
    interpolationWorkPerPixel,
    apply(input) {
      if (input.length !== inputChannels) malformed();
      const positions = input.map(
          (value, axis) => Math.max(0, Math.min(1, value)) * (grids[axis]! - 1),
        ),
        lower = positions.map(Math.floor),
        upper = lower.map((value, axis) => Math.min(grids[axis]! - 1, value + 1)),
        fractions = positions.map((value, axis) => value - lower[axis]!),
        output = Array.from({ length: outputChannels }, () => 0);
      for (let corner = 0; corner < 2 ** inputChannels; corner++) {
        const weight = fractions.reduce(
          (result, fraction, axis) => result * (corner & (1 << axis) ? fraction : 1 - fraction),
          1,
        );
        if (weight === 0) continue;
        const point = grids.reduce(
          (index, _, axis) =>
            index + (corner & (1 << axis) ? upper[axis]! : lower[axis]!) * strides[axis]!,
          0,
        );
        for (let channel = 0; channel < outputChannels; channel++) {
          const sample = float32(view, 28 + (point * outputChannels + channel) * 4);
          output[channel]! += sample * weight;
        }
      }
      if (output.some((value) => !Number.isFinite(value))) malformed();
      return output;
    },
  };
}

function parseElement(view: DataView): ProcessingElement {
  if (view.byteLength < 12) malformed();
  const type = signature(view, 0);
  if (type === 'cvst') return parseCurveSet(view);
  if (type === 'matf') return parseMatrix(view);
  if (type === 'clut') return parseClut(view);
  if (type === 'bACS' || type === 'eACS') {
    if (
      view.byteLength < 16 ||
      view.getUint32(4) !== 0 ||
      view.getUint16(8) < 1 ||
      view.getUint16(8) !== view.getUint16(10)
    )
      malformed();
    const channels = view.getUint16(8);
    if (channels > MAX_MPE_CHANNELS)
      unsupported('ICC MPE pass-through elements exceed the supported channel limit');
    return {
      inputChannels: channels,
      outputChannels: channels,
      apply: (input) => [...input],
    };
  }
  return unsupported(`ICC MPE processing element ${type} is not supported`);
}

/** Parse ICC.1 multi-process elements for a device-to-PCS transform. */
export function parseIccMpeInputProfile(
  tag: DataView,
  expectedInputChannels: number,
  imagePixels?: number,
): (input: readonly number[]) => [number, number, number] {
  if (tag.byteLength < 24 || signature(tag, 0) !== 'mpet' || tag.getUint32(4) !== 0) malformed();
  const inputChannels = tag.getUint16(8),
    outputChannels = tag.getUint16(10),
    elementCount = tag.getUint32(12),
    tableEnd = 16 + elementCount * 8;
  if (elementCount < 1 || !Number.isSafeInteger(tableEnd) || tableEnd > tag.byteLength) malformed();
  if (elementCount > MAX_MPE_ELEMENTS)
    unsupported('ICC MPE transforms exceed the supported processing-element limit');
  if (inputChannels !== expectedInputChannels || outputChannels !== 3) malformed();
  const positions = Array.from({ length: elementCount }, (_, index) => {
    const offset = tag.getUint32(16 + index * 8),
      size = tag.getUint32(20 + index * 8);
    if (offset < tableEnd || offset % 4 !== 0 || size < 12 || offset + size > tag.byteLength)
      malformed();
    return { offset, size };
  });
  if (positions[0]!.offset !== tableEnd) malformed();
  const elements = positions.map(({ offset, size }) => parseElement(subview(tag, offset, size)));
  if (imagePixels !== undefined) {
    if (!Number.isSafeInteger(imagePixels) || imagePixels < 1)
      throw new HeicError('INVALID_OPTIONS', 'heic: invalid ICC image pixel count');
    const workPerPixel = elements.reduce(
      (sum, element) => sum + (element.interpolationWorkPerPixel ?? 0),
      0,
    );
    if (
      !Number.isSafeInteger(workPerPixel) ||
      workPerPixel > MAX_MPE_CLUT_INTERPOLATION_WORK / imagePixels
    )
      unsupported('ICC MPE transform exceeds the per-image interpolation work limit');
  }
  let currentChannels = inputChannels;
  for (const element of elements) {
    if (element.inputChannels !== currentChannels) malformed();
    currentChannels = element.outputChannels;
  }
  if (currentChannels !== outputChannels) malformed();

  return (input) => {
    if (input.length !== inputChannels) malformed();
    let values = [...input];
    for (const element of elements) values = element.apply(values);
    if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) malformed();
    return values as [number, number, number];
  };
}
