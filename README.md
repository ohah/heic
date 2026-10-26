# @ohah/heic

Pure TypeScript HEIC/HEIF still-image decoding. MIT. No WebAssembly, native modules, runtime dependencies, libheif, or libde265.

**Early implementation, not a drop-in replacement for every HEIC decoder.** Based on the MIT-licensed [ts-heic](https://github.com/stacksjs/ts-heic) implementation; see [NOTICE](NOTICE). This project adds 8/10/12-bit monochrome, 4:2:0 and 4:4:4 reconstruction, auxiliary alpha, HDR reconstruction, resource limits, and a browser worker API. It is not published to npm yet.

## Usage

Build with `bun install --ignore-scripts && bun run build`.

```ts
import { decode, decodeHeic } from '@ohah/heic';

const input = new Uint8Array(await file.arrayBuffer());
const image = await decode(input, { execution: 'worker' }); // default
const onMain = await decode(input, { execution: 'main' });
const sync = decodeHeic(input); // synchronous main-thread API
// image: { width, height, data: Uint8Array (RGBA8), bitDepth, hasAlpha }
```

The original input is neither detached nor changed. `bitDepth` describes the **source**; output pixels are RGBA8. No HEIC encoding is provided.

### Workers, cancellation, and limits

```ts
const controller = new AbortController();
const image = await decode(input, {
  execution: 'worker',
  signal: controller.signal,
  timeoutMs: 30_000,
  maxPixels: 20_000_000,
  // Optional if your bundler needs an explicit worker entry:
  workerFactory: () =>
    new Worker(new URL('@ohah/heic/worker', import.meta.url), { type: 'module' }),
});
// Your cancel UI can call controller.abort() while decoding is pending.
```

Each worker request owns a dedicated worker, terminated on success, error, cancellation, or timeout. Workers are not silently replaced with main-thread decoding. Browsers must permit the worker script under their CSP. The default worker URL is relative to the built module; package consumers should test their bundler or provide `workerFactory`.

`execution: 'main'` blocks the calling thread. An already-aborted signal is checked before it starts; once synchronous main-thread decoding starts, cancellation/timers cannot interrupt it. `timeoutMs` applies only to workers. Environments without browser Workers can explicitly use `main` or `decodeHeic`.

Input limit: 64 MiB. Output/padded-grid limit: 50 million pixels, lowerable through `maxPixels`. Decoding has additional memory overhead; these limits do not guarantee a device has sufficient memory.

## HDR and alpha

```ts
import { decodeHDR, decodeHDRSync, HeicError } from '@ohah/heic';
const hdr = await decodeHDR(file, { execution: 'worker' });
// Float32Array RGBA, linear-sRGB. RGB may exceed 1 or be negative after gamut conversion.
// Alpha remains 0..1. Default: full stored gain-map headroom.
const previewTarget = decodeHDRSync(input, { displayHeadroom: 4 });
```

PQ/HLG reconstruction follows BT.2100. PQ reference white defaults to 203 nits; HLG display peak defaults to 1000 nits. Apple gain maps and ISO version-0 gain maps are reconstructed in linear light. Matrix/TRC RGB ICC profiles and supported CICP metadata are applied by the HDR API. LUT ICC profiles are rejected. `decodeHeic`/`decode` return RGBA8, without HDR tone mapping or general ICC color management. Use `decodeHDR` for explicit linear color processing.

Auxiliary alpha is resolved from `auxl` references and `auxC` descriptors. Premultiplied sources are converted to straight alpha. The browser demo shows alpha over a checkerboard and offers an explicitly labeled SDR Reinhard preview of HDR data; it does not validate physical HDR display output.

## Supported scope and remaining work

- Intra-coded HEVC still images: monochrome, 4:2:0 and 4:4:4, 8/10/12-bit. Color planes must have matching depth.
- HEIF image grids, identity/overlay images, integer clean aperture, rotation and mirroring.
- Scaling lists, WPP, transform skip, transquant bypass, QP changes, deblocking and SAO.
- BT.601/709/2020 YUV matrices, identity matrix and full/limited range.
- Auxiliary alpha and the HDR paths described above.

**Not full HEIF/HEVC conformance.** Remaining unsupported features include 4:2:2, separate color planes, multilayer HEVC, inter prediction/timed sequences, multi-slice images, HEVC internal tiles, PCM, PPS extensions, most active range-extension tools, fractional clean aperture, SlimHEIF `mini` containers, and older gain-map metadata versions. Unknown essential properties and required decoding features are rejected. The external corpus still contains valid HEVC files requiring these features; a rejection is not counted as a successful decode.

Stable decoder failures use `HeicError.code` (for example `INVALID_CONTAINER`, `INVALID_BITSTREAM`, `UNSUPPORTED_FEATURE`, `RESOURCE_LIMIT`, `WORKER_FAILED`, `TIMEOUT`). Cancellation preserves `AbortSignal.reason`, including falsy values, instead of wrapping it as a decoding error.

## API reference

### Decode entry points

| API                              | Input                                                  | Options                           | Result                                               |
| -------------------------------- | ------------------------------------------------------ | --------------------------------- | ---------------------------------------------------- |
| `decode(source, options?)`       | `Uint8Array`, `ArrayBuffer`, `Blob` (including `File`) | `AsyncDecodeOptions`              | `Promise<HeicImageData>`                             |
| `decodeHeic(input, options?)`    | `Uint8Array` (including Node `Buffer`)                 | `DecodeOptions`                   | `HeicImageData`, synchronous                         |
| `decodeHDR(source, options?)`    | `HeicInput`, same as `decode`                          | `AsyncDecodeOptions & HdrOptions` | `Promise<HdrImage>`                                  |
| `decodeHDRSync(input, options?)` | `Uint8Array`                                           | `HdrOptions`                      | `HdrImage`, synchronous                              |
| `isHeic(input)`                  | `Uint8Array`                                           | —                                 | `boolean`; container/codec identification only       |
| `getHeicMetadata(input)`         | `Uint8Array`                                           | —                                 | `HeicMetadata`; parses without reconstructing pixels |

`isHeic` returning true does **not** guarantee that the file is valid or uses supported coding tools. `getHeicMetadata` can throw for malformed or unsupported metadata; its dimensions and transforms describe the container, not necessarily the final oriented/cropped output. Decode the image to obtain the final `width` and `height`.

```ts
import { readFile } from 'node:fs/promises';
import { decodeHeic, decodeHDR } from '@ohah/heic';

const input = await readFile('photo.heic');
const rgba = decodeHeic(input);
const linear = await decodeHDR(input, { execution: 'main' });
// Node: explicitly use main; the default API expects browser Workers.
```

### Options and defaults

| Option               | Type                                         | Default                                | Behavior                                                                                                                                                               |
| -------------------- | -------------------------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxPixels`          | positive safe integer, at most `50_000_000`  | `50_000_000`                           | Limits decoded/intermediate image allocation, including padded grids; independent of input byte size.                                                                  |
| `applyTransforms`    | `boolean`                                    | `true`                                 | Applies container clean aperture and display rotation/mirror; false keeps the image before these container transforms. HEVC conformance-window cropping still applies. |
| `execution`          | `'worker' \| 'main'`                         | `'worker'`                             | Async entry points only. `main` blocks before its Promise resolves.                                                                                                    |
| `signal`             | `AbortSignal`                                | none                                   | Async entry points only. Already-aborted signals reject before decode; in-flight interruption requires a worker.                                                       |
| `timeoutMs`          | finite number `> 0`, at most `2_147_483_647` | `30_000`                               | Worker only; terminates the worker. Synchronous main-thread work cannot be interrupted.                                                                                |
| `workerFactory`      | `() => Worker`                               | module worker next to built `index.js` | Async entry points only. Supply a module worker running the exported worker entry.                                                                                     |
| `displayHeadroom`    | number `>= 1` (also accepts `Infinity`)      | full stored gain-map headroom          | HDR entry points only. Target display/base-white ratio for gain maps; capped at the stored ratio. `1` requests the SDR end of the reconstruction.                      |
| `referenceWhiteNits` | finite number `>= 1`                         | `203`                                  | HDR entry points only. Reference white for PQ/HLG, in cd/m².                                                                                                           |
| `displayPeakNits`    | finite number `>= 1`                         | `1000`                                 | HDR entry points only. Reference display peak for HLG, in cd/m².                                                                                                       |

`DecodeOptions` contains `maxPixels` and `applyTransforms`. `AsyncDecodeOptions` extends it with execution/cancellation/worker options. `HdrOptions` extends it with the three HDR options. Input size is independently capped at 64 MiB. Intermediate rendering has additional allocation/depth/work limits, so a file below the byte/pixel ceilings can still be rejected. The caller's input is neither detached nor modified.

### Output data

```ts
interface HeicImageData {
  width: number;
  height: number;
  data: Uint8Array; // row-major RGBA8; length = width * height * 4
  hasAlpha: boolean;
  bitDepth: 8 | 10 | 12; // source depth, not RGBA8 output depth
}

interface HdrImage {
  width: number;
  height: number;
  data: Float32Array; // row-major straight-alpha RGBA
  hasAlpha: boolean;
  bitDepth: 8 | 10 | 12;
  colorSpace: 'linear-srgb';
  headroom: number; // headroom represented by this result
  sourceHeadroom: number; // stored/derived source headroom before target limiting
  source: 'sdr' | 'pq' | 'hlg' | 'apple-gainmap' | 'iso-gainmap';
}
```

HDR RGB is linear-light sRGB, normalized to reference white: values may exceed `1` and gamut conversion can produce negative values. Alpha remains `0..1`. An SDR source passed to the HDR API is linearized and returns `source: 'sdr'`. Passing HDR floats directly to an 8-bit `ImageData` loses the HDR information; apply a chosen display transform/tone map first. `decode` does not implement general ICC color management or HDR tone mapping.

### Browser rendering and JPEG encoding

The library decodes pixels; use the browser canvas encoder if you need a JPEG/PNG Blob. This example uses the RGBA8 path. Transparent pixels are composited over white for JPEG, which has no alpha channel.

```ts
import { decode } from '@ohah/heic';

async function toJpeg(file: File): Promise<Blob> {
  const image = await decode(file);
  const raster = document.createElement('canvas');
  raster.width = image.width;
  raster.height = image.height;
  const rasterContext = raster.getContext('2d');
  if (!rasterContext) throw new Error('Canvas 2D unavailable');
  rasterContext.putImageData(
    new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
    0,
    0,
  );
  const output = document.createElement('canvas');
  output.width = image.width;
  output.height = image.height;
  const context = output.getContext('2d');
  if (!context) throw new Error('Canvas 2D unavailable');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, output.width, output.height);
  context.drawImage(raster, 0, 0);
  return new Promise((resolve, reject) => {
    output.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('JPEG encoding failed'))),
      'image/jpeg',
      0.9,
    );
  });
}
```

JPEG quality is a browser encoder setting, not a decoder option. This example does not resize or guarantee a target byte size. Do not use it as a substitute for an explicit HDR-to-SDR rendering policy when converting HDR photos.

### Cancellation and errors

```ts
import { decode, HeicError } from '@ohah/heic';

const controller = new AbortController();
const pending = decode(file, { signal: controller.signal, timeoutMs: 10_000 });
// While pending, your UI can call controller.abort().
try {
  const image = await pending;
  console.log(image.width, image.height);
} catch (error) {
  if (controller.signal.aborted && error === controller.signal.reason) {
    // Cancelled by this caller. The reason can be any value, including 0/false/null.
  } else if (error instanceof HeicError) {
    console.error(error.code, error.message);
  } else {
    throw error;
  }
}
```

| `HeicErrorCode`       | Meaning                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `INVALID_INPUT`       | Unsupported input value or failed Blob read.                       |
| `INVALID_OPTIONS`     | Invalid pixel, HDR or worker option.                               |
| `UNSUPPORTED_FORMAT`  | Input not identified as a supported HEVC-in-HEIF container.        |
| `UNSUPPORTED_FEATURE` | Recognized format uses an unimplemented coding/rendering feature.  |
| `INVALID_CONTAINER`   | Invalid HEIF boxes, item references, properties or metadata.       |
| `INVALID_BITSTREAM`   | Invalid/truncated HEVC or inconsistent coded picture.              |
| `RESOURCE_LIMIT`      | Byte, pixel, nesting or work limit exceeded.                       |
| `DECODE_FAILED`       | Other decoder failure normalized by the decode entry point.        |
| `WORKER_UNAVAILABLE`  | Browser Worker API absent and no factory supplied.                 |
| `WORKER_FAILED`       | Worker creation, messaging, loading or response validation failed. |
| `TIMEOUT`             | Worker timeout expired.                                            |

Use codes, not message parsing. Cancellation propagates the exact signal reason rather than a `HeicError`. Low-level parsing/color APIs below may also throw ordinary `Error` or `RangeError`; decode entry points normalize decoder failures. Worker execution cannot silently fall back to the main thread. Each request owns and terminates its worker, so high concurrency allocates multiple decoders; limit simultaneous requests on memory-constrained devices.

### Metadata and low-level exports

Most applications only need the decode entry points. These lower-level exports expose container/codec structures for inspection and development; they do not add support for coding tools rejected by the decoder. Signatures and every structure field are included in the package's generated `.d.ts` files.

```ts
import { isHeic, getHeicMetadata } from '@ohah/heic';

if (isHeic(input)) {
  const metadata = getHeicMetadata(input);
  console.log(metadata.primaryItemId, metadata.primaryItemType);
  console.log(metadata.grid, metadata.transforms, metadata.hasAlpha);
  console.log(metadata.sps?.bitDepthLuma, metadata.sliceNalCount);
}
```

| Export                                                    | Purpose / contract                                                                                                                                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseISOBMFF(input)`                                     | Returns an `ISOBMFFBox[]` tree. Boxes expose `type`, `size`, `offset`, `data` and optional `children`.                                                                                                                 |
| `findBox(boxes, type)`, `findAllBoxes(boxes, type)`       | Recursive lookup; first match or `undefined`, or all matching boxes.                                                                                                                                                   |
| `getFtypInfo(input)`, `validateFtyp(input)`               | Read major/compatible brands, or check the leading file-type box. A valid `ftyp` does not imply a decodable file.                                                                                                      |
| `getHeicInfo(input, boxes, itemId?)`                      | Resolve primary or selected item's properties, dimensions, codec configuration, grid, alpha, derived items and transforms.                                                                                             |
| `getItemPayload(input, boxes, itemId)`                    | Assemble item bytes from its extents; returns `Uint8Array` or `null` when not found.                                                                                                                                   |
| `parsePitm(data)`                                         | Parse primary item ID from a full-box body.                                                                                                                                                                            |
| `parseIpma(data)`                                         | Parse property associations from a full-box body, preserving essential properties.                                                                                                                                     |
| `parseIref(box)`                                          | Parse item references from an `iref` box.                                                                                                                                                                              |
| `parseHvcC(data)`                                         | Parse HEVC configuration, NAL length prefix size and parameter-set arrays.                                                                                                                                             |
| `parseGridBody(data)`                                     | Parse grid rows, columns and output size; item IDs/tile size require container references.                                                                                                                             |
| `splitAnnexB(stream)`                                     | Split start-code-prefixed HEVC into `NalUnit[]`.                                                                                                                                                                       |
| `splitLengthPrefixed(payload, nalLengthSize)`             | Split HEIF HEVC payload, using an integer prefix size `1..4`.                                                                                                                                                          |
| `toRbsp(nal)`                                             | Remove the NAL header and emulation-prevention bytes.                                                                                                                                                                  |
| `isSliceNal(type)`, `NalType`                             | Recognize supported slice-type ranges; named HEVC NAL constants.                                                                                                                                                       |
| `BitReader`                                               | Construct from `Uint8Array`; `readBit()`, `readBits(n)`, `ue()`, `se()` and `bitPosition`.                                                                                                                             |
| `parseSps(nal)`, `parsePps(nal)`                          | Parse full SPS/PPS NAL payloads, including their NAL headers.                                                                                                                                                          |
| `PictureDecoder`                                          | `new PictureDecoder(sps, pps).decode(sliceNals)` reconstructs coded planes before deblocking/SAO, HEIF assembly, crop and RGB rendering. This low-level result is not the final image.                                 |
| `yuv420ToRgba(y, cb, cr, width, height, options?)`        | Convert planar 4:2:0 to RGBA8. Chroma dimensions are `ceil(width/2) × ceil(height/2)`; nearest-sample upsampling. Defaults: 8-bit, BT.601 matrix (`6`), full range. Matrix `1` selects BT.709 and `9` selects BT.2020. |
| `applyOrientation(rgba, width, height, rotation, mirror)` | RGBA8 quarter-turns counterclockwise, then mirror: `0` vertical axis, `1` horizontal axis, `null` none. Returns `OrientedImage`.                                                                                       |

All exported TypeScript types are grouped below. Some describe low-level codec syntax rather than end-user options.

| Types                                                            | Contents                                                                                           |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `HeicInput`, `DecodeOptions`, `AsyncDecodeOptions`, `HdrOptions` | Accepted inputs/options documented above.                                                          |
| `HeicImageData`, `HdrImage`, `HeicErrorCode`                     | Output and failure contracts documented above.                                                     |
| `HeicMetadata`                                                   | Extends `HeicInfo` with parsed primary/first-tile `sps` (or null) and `sliceNalCount`.             |
| `HeicInfo`, `GridInfo`, `HvcCConfig`                             | Item selection, color/ICC metadata, transforms, references, grid geometry and HEVC parameter sets. |
| `ISOBMFFBox`, `FileTypeInfo`                                     | Container tree and file-type brands.                                                               |
| `NalUnit`, `SpsInfo`, `PpsInfo`, `VuiColorInfo`                  | HEVC NAL payloads, parameter sets and color signaling.                                             |
| `DecodedPicture`, `SaoParams`                                    | Reconstructed YUV planes and in-loop-filter syntax/bookkeeping.                                    |
| `ColorOptions`, `OrientedImage`                                  | Raw 4:2:0 conversion options and transformed RGBA8 result.                                         |

The `@ohah/heic/worker` package export is a worker entry script. Load it as a module worker; it is not a second decoding API to import on the main thread. A Rspack production bundle is covered by the package consumer test. Other bundlers/CSP deployments should verify the emitted worker URL or provide `workerFactory`.

## Validation

See [the validation record](docs/VALIDATION.md) for exact coverage, remaining failures, source versions and independent reference differences.

```sh
bun test
bun run lint
bun run format:check
bun run typecheck
bun run build
E2E_ROUNDS=20 node e2e/browser.mjs
bun scripts/corpus.ts
bun scripts/reference-corpus.ts
HEIC_CHROMA=1 bun scripts/adversarial-reference.ts
HEIC_CHROMA=3 bun scripts/adversarial-reference.ts
```

External fixtures are downloaded to `/tmp/heic-external-corpus`, checked against the SHA256 manifest, and never shipped in the npm package. Browser screenshots/results are saved under `/tmp`, never committed. FFmpeg/libx265 are optional development reference tools, not runtime dependencies. `ts-jpeg` is a development-only decoder for the inherited JPEG-reference test.

Run `bun run format` to apply formatting and `bun run lint:fix` for safe lint fixes. CI checks both lint and formatting.

For the browser demo, build, serve this directory over HTTP, and open `/demo/index.html`. Conversion stays local.

## Release automation

GitHub Actions uses `.github/workflows/release.yml` and the `npm` deployment environment. Its `NPM_TOKEN` environment secret supplies npm authentication; secret values are never committed. The environment permits `main` and `v*` tags.

- Pull requests changing release configuration validate the build, tests and packaged file allowlist without accessing publishing secrets.
- Run **npm Release → Run workflow → main**, with `dry_run: true` (default), to validate the package, npm authentication and `npm publish --dry-run`. This does not publish a version.
- To release, merge a `package.json` version change, then push the matching `v<version>` tag from a commit contained in `main`. A mismatched version/tag fails validation.
- Stable versions use the `latest` dist-tag; prerelease versions use `next`. Actual publication uploads only the audited tarball, with public access and provenance.
- A manual run with `dry_run: false` also publishes the selected main/tag version. npm versions are immutable; do not republish an existing version.

See [the Korean maintainer release guide](docs/RELEASING.md) for setup and checks. The npm token must be permitted to publish `@ohah/heic`; authentication and dry-run success alone do not prove write permission for the first real publish.

## License

MIT. Retain the license and notices when redistributing. The software license does not grant rights to HEVC standard-essential patents.
