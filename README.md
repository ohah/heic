# @ohah/heic

Pure TypeScript HEIC/HEIF still-image decoding. MIT. No WebAssembly, native modules, runtime dependencies, libheif, or libde265.

**Early implementation, not a drop-in replacement for every HEIC decoder.** Based on the MIT-licensed [ts-heic](https://github.com/stacksjs/ts-heic) implementation; see [NOTICE](NOTICE). This project adds 10/12-bit 4:2:0 reconstruction, resource limits, and a browser worker API. It is not published to npm yet.

## Usage

Build with `bun install --ignore-scripts && bun run build`.

```ts
import { decode, decodeHeic } from '@ohah/heic'

const input = new Uint8Array(await file.arrayBuffer())
const image = await decode(input, { execution: 'worker' }) // default
const onMain = await decode(input, { execution: 'main' })
const sync = decodeHeic(input) // synchronous main-thread API
// image: { width, height, data: Uint8Array (RGBA8), bitDepth, hasAlpha }
```

The original input is neither detached nor changed. `bitDepth` describes the **source**; output pixels are RGBA8. No HEIC encoding is provided.

### Workers, cancellation, and limits

```ts
const controller = new AbortController()
const image = await decode(input, {
  execution: 'worker',
  signal: controller.signal,
  timeoutMs: 30_000,
  maxPixels: 20_000_000,
  // Optional if your bundler needs an explicit worker entry:
  workerFactory: () => new Worker(
    new URL('@ohah/heic/worker', import.meta.url),
    { type: 'module' },
  ),
})
controller.abort()
```

Each worker request owns a dedicated worker, terminated on success, error, cancellation, or timeout. Workers are not silently replaced with main-thread decoding. Browsers must permit the worker script under their CSP. The default worker URL is relative to the built module; package consumers should test their bundler or provide `workerFactory`.

`execution: 'main'` blocks the calling thread. An already-aborted signal is checked before it starts; once synchronous main-thread decoding starts, cancellation/timers cannot interrupt it. `timeoutMs` applies only to workers. Environments without browser Workers can explicitly use `main` or `decodeHeic`.

Input limit: 64 MiB. Output/padded-grid limit: 50 million pixels, lowerable through `maxPixels`. Decoding has additional memory overhead; these limits do not guarantee a device has sufficient memory.

## Supported scope

- HEVC intra-coded still pictures, 4:2:0, matching 8/10/12-bit luma and chroma.
- Single images and tiled HEIF grids, conformance crop, rotation and mirroring.
- Scaling lists, WPP, quantization-group QP changes, deblocking and SAO.
- BT.601/BT.709 conversion and full/limited range to RGBA8.

Unsupported: 4:2:2/4:4:4, inter pictures/animation, alpha-plane reconstruction, PCM, transquant bypass, PPS extensions and active SPS range-extension coding tools. VUI HRD timing is rejected. ICC profiles, HDR gain maps, wide-gamut color management and HDR tone mapping are not implemented. Do not interpret RGBA8 output as a color-managed/HDR rendering.

## Validation

```sh
bun test             # 63 tests; inherited regressions + six reference vectors
bun run typecheck
bun run build
node e2e/browser.mjs  # requires agent-browser/Chromium; 20 adversarial cases
```

- Existing 8-bit iPhone single-image/grid captures: decoder regressions and browser main/worker pixel equality.
- **Synthetic** 8/10/12-bit pattern and gradient vectors: all reconstructed Y/Cb/Cr samples equal FFmpeg reference output. This is not a claim of full HEVC conformance or real-device 10/12-bit coverage.
- Browser cases: thread equality, sliced input views, concurrent workers, pre/in-flight aborts, timeout, missing worker, invalid/truncated files, resource limits and recovery.
- Browser screenshots/results go to `/tmp/ohah-heic-browser`, never into Git.

Regenerate the small synthetic reference vectors with:

```sh
bun scripts/generate-conformance.ts /tmp/heic-conformance
```

FFmpeg/libx265 are optional **development-only** reference tools. They are not shipped in this library or needed to decode files. The generator intentionally creates only 4:2:0 intra test vectors.

For the browser demo, run `bun run build`, serve this directory over HTTP, and open `/demo/index.html`. All conversion stays local.

## License

MIT. Retain the license and notices when redistributing. The software license does not grant rights to HEVC standard-essential patents.
