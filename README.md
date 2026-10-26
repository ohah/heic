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
controller.abort();
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

## License

MIT. Retain the license and notices when redistributing. The software license does not grant rights to HEVC standard-essential patents.
