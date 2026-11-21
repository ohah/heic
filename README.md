# @ohah/heic

TypeScript HEIC/HEIF still-image decoding with a bundled MIT-licensed WebAssembly AVC decoder. No native modules, external runtime dependencies, libheif, or libde265.

**Early implementation, not a drop-in replacement for every HEIC decoder.** Based on the MIT-licensed [ts-heic](https://github.com/stacksjs/ts-heic) implementation; see [NOTICE](NOTICE). This project supports 8–15-bit monochrome and 4:2:0/4:2:2/4:4:4 HEVC reconstruction, auxiliary alpha, HDR reconstruction, and progressive 8-bit 4:2:0 AVC through the bundled Hibernia WebAssembly decoder. Other AVC profiles and tools remain unsupported. Published as [`@ohah/heic`](https://www.npmjs.com/package/@ohah/heic).

## Usage

Install the released package:

```sh
npm install @ohah/heic
# or: pnpm add @ohah/heic
# or: bun add @ohah/heic
```

To build from source, run `bun install --ignore-scripts && bun run build`.

```ts
import { decode, decodeHeic } from '@ohah/heic';

const input = new Uint8Array(await file.arrayBuffer());
const image = await decode(input, { execution: 'worker' }); // default
const onMain = await decode(input, { execution: 'main' });
const sync = decodeHeic(input); // Node.js can synchronously decode supported AVC items
// image: { width, height, data: Uint8Array (RGBA8), bitDepth, hasAlpha }
```

The original input is neither detached nor changed. `bitDepth` describes the **source**; output pixels are RGBA8. No HEIC encoding is provided.

For a primary uncompressed (`unci`) item, `decodeHeicUncompressedComponents` returns each configured component as raw numeric data. Complex samples are interleaved real/imaginary pairs; the regular RGBA decoder rejects them because `unci` defines no color conversion for complex values.

```ts
import { decodeHeicUncompressedComponents } from '@ohah/heic';

const raw = decodeHeicUncompressedComponents(input);
const complex = raw.components.find((component) => component.componentFormat === 2);
// complex.data: Float64Array [real0, imaginary0, real1, imaginary1, ...]
```

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

In Node, use `execution: 'main'`; browser Workers are not available by default. `decodeHeic` can synchronously decode supported AVC image items in Node.js 20.16 or newer by loading the bundled WebAssembly file locally. Browser callers should use async `decode()`, which loads the decoder asynchronously. Older Node releases can use async `decode()` or provide caller-decoded planes through `externalBaseLayerPlanes`.

Input limit: 64 MiB. Output/padded-grid limit: 50 million pixels, lowerable through `maxPixels`. Decoding has additional memory overhead; these limits do not guarantee a device has sufficient memory.

## HDR and alpha

```ts
import { decodeHDR, decodeHDRSync, HeicError } from '@ohah/heic';
const hdr = await decodeHDR(file, { execution: 'worker' });
// Float32Array RGBA, linear-sRGB. RGB may exceed 1 or be negative after gamut conversion.
// Alpha remains 0..1. Default: full stored gain-map or ICC HAGC headroom.
const previewTarget = decodeHDRSync(input, { displayHeadroom: 4 });
```

PQ/HLG reconstruction follows BT.2100. PQ reference white defaults to 203 nits; HLG display peak defaults to 1000 nits. Apple gain maps and ISO version-0 gain maps are reconstructed in linear light. ICC HAGC tags on supported RGB profiles apply SMPTE ST 2094-50 tone mapping for CICP linear, PQ, and HLG transfer codes; the HAGC reference-white value overrides the default unless `referenceWhiteNits` is supplied. `displayHeadroom` selects a target across the stored HAGC headroom range. Matrix/TRC RGB and monochrome ICC profiles, RGB and monochrome scanner/display profiles using ICC `A2B1`/`A2B0` `mAB` or `mft2` transforms with Lab or 16-bit XYZ PCS, `mft1` transforms with Lab PCS, and supported CICP metadata are applied by the HDR API. The `iccRenderingIntent` option selects relative colorimetry (`A2B1`, default), perceptual (`A2B0`), saturation (`A2B2`), or ICC-absolute colorimetry (`D2B3`); absolute intent falls back through media-relative transforms with media-white-point scaling, then `A2B0` and a complete matrix/TRC transform. HDR conversion supports H.273 primaries 1, 4–12, and 22, and defined transfer codes 1 and 4–18; unspecified transfer code 2 uses the library's sRGB application default. Extended-range transfers 11/12 and non-identity-matrix transfer 13 retain values outside the nominal RGB range in linear HDR output. Cinema transfer 17 uses 48 nits nominal white and scales to the configured reference white. An ISO gain map can use an RGB LUT ICC profile for its application space when the selected colorimetry provides supported RGB primaries. A monochrome ICC baseline can use a separately signaled alternate RGB space; selecting a monochrome ICC profile as the gain-map application space is unsupported because it provides no RGB primaries. LUT ICC profiles without usable primaries remain unsupported. ICC `D2B0`/`D2B1`/`D2B2`/`D2B3` MPE transforms are supported through HEIF `prof` for RGB and monochrome images when they use `cvst` formula curves or sampled middle segments, `matf` matrices, CLUTs with up to 16 input dimensions subject to a per-image interpolation-work limit, and pass-through `bACS`/`eACS` elements; other MPE elements remain unsupported. `decodeHeic`/`decode` return RGBA8 and apply the supported SDR ICC transforms described below; for HDR ICC profiles with HAGC and `A2B0`, they use that tag as the legacy SDR rendering. They do not apply HDR tone mapping. Use `decodeHDR` for explicit linear color processing and dynamic HAGC rendering.

Auxiliary alpha is resolved from `auxl` references and `auxC` descriptors. Premultiplied sources are converted to straight alpha. The browser demo shows alpha over a checkerboard and offers an explicitly labeled SDR Reinhard preview of HDR data; it does not validate physical HDR display output.

## Supported scope and remaining work

The official SCC `DPB_Loop_Filters_A_MediaTek_2` vector now validates all 10
pictures, including POC 7 with six active L0 references and both SAO and
deblocking disabled; a synthetic HEIF `pred` graph also checks POC 7 and 9.

- HEVC still images: monochrome, 4:2:0, 4:2:2 and 4:4:4, with independently signalled 8–15-bit luma and chroma depths, independent and dependent I-slice segments, WPP synchronization, internal tiles, and official High Throughput tiles+WPP sequences for 10-bit 4:2:2 and 8-bit 4:2:0 streams declared under 4:4:4 10/14 profiles, including CABAC bypass-alignment and extended-precision combinations. PCM coding and selected SCC palette initialization from SPS and PPS are also supported, including an explicit empty PPS initializer. Synthetic x265 references check the 12-bit internal inverse-quantization endpoints qP 74/75 in 4:2:0, 4:2:2 and 4:4:4. Selected P- and B-slice `pred` paths are sample-validated: Nokia C044, official single-reference weighted-P vectors plus a synthetic multi-reference weighted-P case and a synthetic 10-bit 4:2:2 weighted-B case, all 256 pictures of the official `WP_B_Toshiba_3` sequence plus its final primary image through a synthetic HEIF `pred` graph, all pictures of official multi-reference `RPS_A`, `RPS_B`, `RPS_C`, and `RPS_F` vectors, both pictures of the official SCC `Slice_ACT_QP_Offsets_A_Qualcomm_2` stream, all nine pictures of each official SCC `MVRESIDC_A_MS_2` and `MVRESIDC_C_MS_3` integer-MV vector, all three pictures of the SCC `Bipred_8by8_A_Qualcomm_2` vector, and all 33 pictures of each SCC `IBF_Disabled_A/B_MediaTek_2` vector. Synthetic HEIF `pred` graphs also validate the last B picture from RPS_A/B/F. The Bipred vector also validates the SCC 8×8 bi-to-uni restriction through a synthetic three-item HEIF `pred` graph. The IBF vectors validate B-slice temporal MVP when the collocated P picture contains only current-picture-reference motion. The official 33-picture SCC `PPI_A_InterDigital_2` and `PPI_B_InterDigital_2` streams (each 3 P and 30 B pictures) match all embedded component hashes; synthetic HEIF `pred` graphs validate each stream's primary image, and PPI_A also covers multiple PPS records.
- Generic HEIF uncompressed image items (`unci`): unsigned 8–16-bit and signed 2–16-bit integer samples, plus IEEE 754 floating-point samples at 16/32/64/128/256-bit widths, for monochrome, RGB, and 4:4:4/4:2:2/4:2:0/4:1:1 YCbCr, with per-component visual depths and inline alpha. Signed samples are mapped from their two's-complement range to display code values with zero at the midpoint. Linear float samples retain values above 1 in `decodeHDR`; the SDR API clips them to its 8-bit output range. Packed non-byte-aligned samples, aligned component words up to 255 bytes, and block-pixel/block-component layouts are supported for integer and IEEE 754 floating-point samples; block-component packing also works with subsampled YCbCr through component interleave; subsampled images use component or mixed interleave; 4:2:2 and 4:1:1 also support Multi-Y interleave, while full-resolution components also support pixel, row, or tile-component interleave. The predefined `rgb3` configuration decodes packed 8-bit RGB, and the version-1 `yv20` profile decodes 8-bit planar Y, V, U 4:2:0. Pixel-interleaved layouts can use `pixel_size` to pad each pixel to a fixed byte extent; supported layouts can also use configured row and tile alignment under ISO/IEC 23001-17:2024/Amd 2:2025. Generic compression supports `defl` (raw DEFLATE), `zlib`, and `brot` (Brotli), with full-item and indexed compressed units through `icef`, bounded to 256 MiB decompressed per item; synchronous decompression uses Node.js, while async decoding uses the platform's `DecompressionStream` where available and Node.js fallback. Indexed units are reassembled in their declared order before full-image decoding. Complex components use `component_format = 2` with 32/64/128/256 total bits and are available as raw real/imaginary pairs through `decodeHeicUncompressedComponents`; the RGBA decoder does not invent a color mapping. This path does not decode HEVC; its synthetic coverage and unsupported layouts are recorded in [the validation record](docs/VALIDATION.md#uncompressed-heif-image-items-unci).
- All nine pictures in the official `Main_422_10_A_RExt_Sony_2` sequence now match their untiled HEIF `pred` outputs through synthetic two-column in-file `hvc1` `tili` graphs; all eight B pictures also match through external-tile `tili`. POC 4 exercises two active references per list. POC 8 and POC 4 match through the public synchronous `decodeHeic` path, and POC 8 also covers asynchronous `decode()`. The HEVC vector is official, while the HEIF wrappers are synthetic. See [the validation record](docs/VALIDATION.md#main-422-10-bit-b-pictures-through-heif-tili).
- SCC IBC also decodes with palette mode disabled: a synthetic HM-16.15+SCM-8.5 still item matches all three encoder reconstruction planes and passes the public `decodeHeic` path. The official SCC corpus has no vector for this flag combination; see [the validation record](docs/VALIDATION.md#scc-ibc-with-palette-mode-disabled).
- Main Still Picture profile intra prediction is validated against the official H.265.1 `IPRED_B_Nokia_3` vector: all Y/Cb/Cr samples match its published reconstruction hash through a synthetic `heic` item, and the public decoder returns the expected 1920×1080 image. See [the validation record](docs/VALIDATION.md#main-still-picture-intra-prediction).
- The official Range Extensions `ADJUST_IPRED_ANGLE_A` vector validates all chroma intra modes at three block sizes for 10-bit 4:2:2; all three pictures match embedded component hashes and the archive YUV MD5 through synthetic `heix` items. See [the validation record](docs/VALIDATION.md#rext-intra-chroma-prediction-angle).
- The official 8-bit and 10-bit 4:4:4 `CCP_RExt_QCOM_1` vectors exercise cross-component prediction over one I and eight B pictures; both full display-order YUV MD5s and final pictures through synthetic HEIF `pred` chains are checked. A separate 12-bit vector also exercises CCP. See [the validation record](docs/VALIDATION.md#hevc-44-cross-component-prediction).
- The complete official 10-bit 4:2:2 High Throughput tiles+WPP P sequence matches all three decoded-picture-hash SEIs and the archive YUV MD5; all three access units also match through a synthetic HEIF `pred` chain. See [the validation record](docs/VALIDATION.md#high-throughput-tiles-and-wpp-sequences).
- HEVC SPS and Annex F VPS VUI syntax, including HRD, color signal, default-display-window metadata, tile and WPP metadata. VPS video-signal records and their inferred or signalled per-layer indices are parsed, then applied to eligible selected non-base L-HEVC layers under Annex F inference rules, with specified HEIF color declarations retaining precedence. For 4:2:0, a shared SPS chroma sample location is used during RGB reconstruction; timing and layer scheduling values do not affect still-image pixels. The default display window is exposed through `getHeicMetadata().sps`; `applyDefaultDisplayWindow: true` applies it to a single coded HEVC item without a container clean aperture. Grid and `tili` geometry remains controlled by its container properties.
- HEIF item payload extents using `iloc` construction methods 0, 1, and 2, including referenced-item selection, recursive item offsets, multi-extent concatenation, and cycle/range checks. Item-offset chains are limited to 32 levels and assembled item data to 64 MiB.
- HEIF image grids, identity/overlay images, clean aperture with fractional resampling, rational image scaling, rotation and mirroring.
- HEIF `pasp` pixel aspect ratio metadata through `getHeicMetadata().pixelAspectRatio`; absent properties report 1:1. Decoded RGBA retains the coded pixel dimensions, so display code can apply the reported spacing ratio.
- HEIF `rloc` relative offsets with their `tbas` related-item reference, exposed through `getHeicMetadata().relativeLocation`.
- HEIF HDR item properties `clli`, `mdcv`, `cclv`, `amve`, `reve`, and `ndwt` are exposed as coded values through `getHeicMetadata().heifHdrProperties`. The compact `mini` equivalents are exposed as `getHeicMetadata().miniHdrProperties.baseImage` and `.toneMappedImage`. These descriptive values do not change decoded pixels or trigger display adaptation.
- HEIF `colr` properties preserve CICP `nclx` independently from ICC profiles. `getHeicMetadata().iccProfiles` returns every declared `prof`/`rICC` form regardless of association order; when both exist, the existing decoder profile fields select `prof` first.
- HEIF camera properties expose `cmex` pose records and `cmin` intrinsic calibration through `getHeicMetadata()`. Version-0 `cmex` quaternion components and version-1 yaw/pitch/roll angles are returned in their coded forms. Intrinsic matrices use the output dimensions after associated transforms. These descriptive properties do not change decoded pixels.
- HEIF `prdi` progressive-derived-image metadata exposes the effective step count, per-step input counts, and defined ordering flags through `getHeicMetadata().progressiveDerivedImage`. The decoder returns the final image and does not present intermediate progressive-rendering steps.
- HEIF `ster` groups whose left and right views are supported image items, through `decodeHeicStereoPairs`, including bounded `lhv1` still-picture cases.
- HEVC-coded HEIF auxiliary images through `decodeHeicAuxiliaryPlanes()`, which returns original Y/Cb/Cr sample planes and bit depths for items such as depth maps. It applies the HEVC conformance window and reports container transforms without applying them. Recognized depth-representation and alpha-channel SEIs from the HEVC `auxC` subtype are exposed as coded metadata. `interpretHevcDepthSample()` maps one coded luma sample to normalized inverse-Z, Z, or disparity and returns a physical Z/disparity value when both corresponding bounds are specified; H.274 leaves Z units unspecified. It does not perform view synthesis. `decodeHeic` and `decodeHDR` apply alpha transparent/opaque values, clipping and increment flags, and the premultiplied-black signal during composition; the raw auxiliary planes remain unchanged.
- ISO/IEC 23008-12:2025/Amd 2 `tili` images with independent `hvc1` or `lhv1` HEVC tiles in-file, plus in-file and external `hvc1`, `lhv1`, and supported progressive 8-bit 4:2:0 `avc1` tiles. L-HEVC `pred` references resolve per layer on matching grids and on origin-aligned child grids covered by the parent, including per-layer sample-grid-aligned `rloc` shifts to a `tbas` parent, even when the shifted region crosses a tile boundary, and different extra-dimension shapes at the same selected coordinate, for in-file and external tiles. This includes selectable 2D planes from extra dimensions, tile offset tables, padded-edge cropping, and deterministic black fill for empty in-file tiles. Official SHVC vectors validate independent and temporally predicted `lhv1` decoding through synthetic `tili` wrappers.
- ISO/IEC 23008-12:2025/Amd 2 per-channel `pixi` metadata, including channel identifiers, component formats, per-channel chroma sample locations, and UTF-8 labels; uncompressed signed component formats are cross-checked against `uncC`, while HEVC remains unsigned-only.
- Scaling lists, WPP, transform skip (including 4×4 intra rotation, context selection and implicit intra RDPCM), persistent Rice adaptation, CABAC bypass alignment, extended-precision transforms, transquant bypass, QP changes, chroma QP offset lists, deblocking, scaled SAO, and 4:4:4 cross-component prediction for chroma modes derived from luma.
- BT.601/709/2020 NCL and BT.2020 constant-luminance, H.273 chromaticity-derived NCL/CL, SMPTE ST 2085, BT.2100 ICtCp PQ/HLG, IPT-C2, FCC, SMPTE 240M, YCgCo/YCgCo-R/Re/Ro matrices, identity matrix and full/limited range.
- Auxiliary alpha and the HDR paths described above.
- HEVC HDR SEI metadata: mastering-display colour volume, content-light level, alternative transfer characteristics, ambient viewing environment, and content colour volume are exposed as coded values through `getHeicMetadata().hevcHdrSei`. Alternative transfer characteristics is used when the HEIF `nclx` transfer is absent or unspecified; a specified `nclx` transfer keeps precedence. Ambient and content-volume metadata remain descriptive and do not trigger display adaptation or gamut mapping.
- HEVC display-orientation SEI messages are exposed in bitstream order through `getHeicMetadata().hevcDisplayOrientation`, including cancellation, persistence, and the H.274 transform code. Decoding applies the active transform by default before HEIF item transforms; set `applyHevcDisplayOrientation: false` to leave it unapplied. Cross-spec composition order is an implementation choice because H.274 and HEIF do not establish precedence between these transform sources.
- HEVC `phase_indication` SEI messages expose their coded horizontal and vertical sample-position ratios through `getHeicMetadata().hevcPhaseIndication`. Set `applyHevcPhaseIndication: true` to align the raster using the last message, bilinear interpolation, and edge replication; it is off by default because the interpolation filter is a renderer policy. [ITU-T H.265 V11, D.4.3](https://www.itu.int/rec/T-REC-H.265-202601-I/en) · [ITU-T H.274 V4, §8.29](https://www.itu.int/rec/T-REC-H.274-202601-I/en)
- HEVC film-grain characteristics SEI messages are exposed as coded model metadata through `getHeicMetadata().hevcFilmGrainCharacteristics`, including cancellation, component intervals, persistence, and the H.274 V4 optional spatial-resolution extension. Grain synthesis is a separate optional display process and is not applied by this decoder.
- HEVC `tone_mapping_info` SEI messages expose all five H.265 models through `getHeicMetadata().hevcToneMappingInfo`. `decodeHeic`/`decode` can apply models 0–3 to RGB code values with `applyHevcToneMapping: true`; use `hevcToneMapId` to select among active IDs. Mapping stays off by default. Model 4 carries luminance metadata and has no per-sample curve to apply. [ITU-T H.265, D.3.15](https://www.itu.int/rec/T-REC-H.265-202601-I/en)
- HEVC `knee_function_info` SEI messages expose the coded luminance ranges and knee points through `getHeicMetadata().hevcKneeFunctionInfo`. `decodeHeic`/`decode` can apply the active piecewise-linear curve to normalized linear RGB with `applyHevcKneeFunction: true`; `hevcKneeFunctionId` selects among active IDs. Mapping stays off by default. [ITU-T H.265, D.3.32](https://www.itu.int/rec/T-REC-H.265-202601-I/en)
- HEVC `colour_remapping_info` SEI messages expose their signal description, bit depths, pre/post LUT pivots, matrix, and cancellation order through `getHeicMetadata().hevcColourRemappingInfo`. `decodeHeic`/`decode` can apply the active mapping with `applyHevcColourRemapping: true`; `hevcColourRemapId` selects an ID. Mapping stays off by default, and `decodeHDR` rejects this RGBA8 display option. [ITU-T H.265, D.3.33](https://www.itu.int/rec/T-REC-H.265-202601-I/en)
- HEVC `chroma_resampling_filter_hint` SEI messages expose filter selectors, target format, and coefficients through `getHeicMetadata().hevcChromaResamplingFilterHint`. `decodeHeic`, `decode`, and `decodeHDR` can apply the H.265 D.20/D.21 chroma resampling filters with `applyHevcChromaResamplingFilterHint: true`; this is off by default. Field-sequence pictures are rejected. [ITU-T H.265, D.3.31](https://www.itu.int/rec/T-REC-H.265-202601-I/en)
- HEVC `post_filter_hint` SEI messages expose filter/correlation matrices through `getHeicMetadata().hevcPostFilterHint`. `decodeHeic`, `decode`, and `decodeHDR` can opt in with `applyHevcPostFilterHint`; the last type-0 2D FIR or type-1 separable FIR is applied to cropped Y/Cb/Cr planes before color conversion. Coefficients use the signalled 16-bit precision, edge samples are replicated, intermediate type-1 results stay unclipped, and final samples are rounded and clipped to component depth. A rendering-work limit bounds the opt-in convolution. Type-2 cross-correlation hints remain metadata-only because they require deriving an implementation-specific Wiener filter. Filtering is off by default. [ITU-T H.265 V11, D.3.14](https://www.itu.int/rec/T-REC-H.265-202601-I/en)
- HEVC still images, progressive 8-bit 4:2:0 AVC still images, and explicit uncompressed `yv20` integer images in the `mif3`/`mini` low-overhead container. The structural brand is accepted as either the major or a compatible brand, and the expanded-file brand can be carried in `minor_version`. HEVC mini items include signalled chroma locations, ICC and Exif/XMP metadata, alpha, and integer ISO gain-map HDR, for the version-0 subset described in the validation record.
- Official Nokia multilayer HEIF samples `multilayer001/002/005`: selected L-HEVC enhancement items decode through the public API and their dimensions are checked; independent enhancement-layer pixel references are unavailable.

- The official MVHEVCS_H_LGE_3 vector matches the H.265.1 display-order YUV hashes for all three views over 50 pictures. Its three-view IBP prediction structure is covered; timed multiview sequences remain outside the still-image API.

**Not full HEIF/HEVC conformance.** L-HEVC item metadata (`lhvC`, `oinf`, `tols`, and `lsel`) is parsed, including the selected output layer and its dependency closure. The selected enhancement-layer SPS is chosen through its slice-to-PPS-to-SPS ids and parsed through the common SPS fields, using the active VPS for omitted representation values and sub-layer count. SPS scaling-list inference resolves from the active SPS in its reference layer; Annex F PPS scaling-list inference and reference-location syntax are parsed, and the effective-list resolver follows the active reference-layer PPS/SPS. The official ITU-T H.265.1 SHVC vectors for PPS and SPS scaling-list inference are covered; these are raw HEVC streams, not HEIF items. No current Nokia multilayer sample in the checked set exercises these inference flags. The layered VPS parser preserves HEIM multiview view IDs and their layer mapping. The official `MVHEVCS_A` vector validates Annex G inter-view reconstruction for both views over all 48 pictures, with display-order YUV hashes matching the H.265.1 archive; its first access unit also decodes through a synthetic `lhv1` HEIF item and the public `decodeHeic` path. The official `MVHEVCS_B` vector matches all 64 inter-view pictures against embedded component hashes, and `MVHEVCS_C_Sony_3` matches both independent same-resolution views over 30 pictures with display-order hashes, including through a synthetic `lhv1` item selecting layer 1, and `MVHEVCS_D` matches both views over 25 pictures at different spatial resolutions; `MVHEVCS_E_Qualcomm_3` matches both views over 48 random-access hierarchical-B pictures with inter-view prediction, and `MVHEVCS_F_Qualcomm_3` matches both views over 48 pictures with inter-view prediction limited to IDR/CRA access units, and `MVHEVCS_G_NTT_3` matches all three views over 49 pictures in the random-access PIP structure; its first access unit also decodes through synthetic three-layer `lhv1` items selecting either side view. The official MVHEVCS_I_Nokia_3 vector matches all six texture/depth layers against its archive YUV hashes, and layer 5's depth output is available through `decodeHeicAuxiliaryPlanes` in a synthetic `lhv1`/`auxl` item. The official H.265.1 MV-HEVC conformance set (MVHEVCS_A–I) is covered by the checks above; arbitrary MV-HEVC streams and timed multiview sequences remain unverified or unsupported. VPS VUI timing, HRD scheduling, alignment, tile and WPP constraints remain descriptive metadata; per-layer color signal is applied to eligible selected L-HEVC output under Annex F inference rules. The official CGS_A–F vectors validate PPS colour mapping and sample-exact enhancement-layer reconstruction across split and leaf-root colour-map trees, 8→10-bit/10→10-bit mappings, and combined 2× spatial upsampling; each vector also decodes and renders from a synthetic `lhv1` HEIF item. Official SCREFOFF_A and RESPHASE_A vectors validate Annex H sample resampling with reference offsets and non-trivial luma/chroma phases; each first access unit also decodes from a synthetic `lhv1` HEIF item. The official MVD_A_NOKIA_1 vector validates layer 2 with one motion-only dependency (layer 0) and one sample-only dependency (layer 1); the same access unit renders from a synthetic three-layer `lhv1` item. The official MVD_A_NOKIA_1 stream now validates layers 0–2 at POC 0–3 through the layered decoder, and a synthetic four-item HEIF `pred` chain reproduces layer 2 at POC 3. Direct `lhv1` still items support bounded temporal P/B references resolved through their per-layer `pred` items; timed HEVC sequences remain unsupported. B-slice current-picture references are now included in both active reference lists when signalled, but the official SHVC corpus still has no vector for end-to-end L-HEVC IBC pixel validation. The official CONFCROP_C_VIDYO_3 POC 0 vector validates non-identity reference-layer motion/mode resampling from P-coded layer 1 to layer 2, including sample-exact OPL hashes through a synthetic lhv1 item. P/B current-picture list ordering is implemented, but the scanned official SHVC first access units contain no L-HEVC IBC vector for end-to-end pixel validation. `decodeHeicStereoPairs` handles supported `hvc1` pairs and bounded `lhv1` still-picture cases. Nokia multilayer005's `lhv1` item and its `ster` pair render at the expected dimensions, but no independent pixel reference is available for that enhancement layer. Primary layer-0 `hvc1` images from Nokia multilayer001/002/005 and selected-layer SPS metadata from multilayer005 are covered in the [validation record](docs/VALIDATION.md#hevc-base-layer-decoding-in-multilayer-heif-items). Inter-picture prediction has bounded validation for weighted-P, multi-reference P, temporal-MVP P, `MVRESIDC_B_MS_2`, `PPI_A_InterDigital_2`, `PPI_B_InterDigital_2`, the official Main 4:2:2 10-bit B-picture sequence, and the official 10-bit 4:2:2 High Throughput tiles+WPP P-sequence cases; other prediction combinations remain unverified. Timed sequences are unsupported. The standalone official Main 4:2:2 10-bit still vector matches its archive YUV hash through a synthetic HEIF item and passes public `decodeHeic` dimension/depth checks; see [Main 4:2:2 10-bit vectors](docs/VALIDATION.md#main-422-10-bit-b-picture-sequence). PPS extension coverage is bounded: selected Range Extension features, Annex F scaling-list inference/reference-location syntax, and CGS_A–F colour mapping are implemented for the cases above; other extension tools remain unsupported or unverified. The official SCC corpus has no external-reference integer-MV P vector; a synthetic HM-SCM stream now checks that single-list P derivation through HEIF `pred` items, while official conformance remains unverified. See [validation notes](docs/VALIDATION.md#integer-mv-resolution-control). See [single-reference weighted P](docs/VALIDATION.md#weighted-p-prediction-in-heif-pred-items), [multi-reference RPS](docs/VALIDATION.md#multiple-reference-rps-and-l0-selection), [temporal MVP](docs/VALIDATION.md#temporal-mvp-from-inter-predicted-p-references), [weighted B](docs/VALIDATION.md#weighted-b-prediction), and [integer-MV resolution control](docs/VALIDATION.md#integer-mv-resolution-control). The `tili` path supports 2D tile planes, including selection by extra-dimension coordinates. In-file tiles support HEVC `hvc1`/`lhv1`, progressive 8-bit 4:2:0 AVC `avc1`, and uncompressed `unci`; external HEIF tile files support HEVC, progressive 8-bit 4:2:0 AVC, and uncompressed `unci` image items. External HEIF tile files are recursively rendered; verified cases include monochrome HEVC alpha, identity derivation, display rotation, nested in-file `tili`, and ISO gain-map `tmap` items in SDR and HDR output. In-file `hvc1` tiles support item-level P-slice `pred` references; validation covers one- and two-tile images with one direct reference, using official RPS_C access units inside synthetic HEIF wrappers. In-file `lhv1` tiles decode independent still-image access units with inter-layer prediction. `lhv1` `tili` items support temporal references through per-layer HEIF `pred` graphs on matching grids and on origin-aligned child grids covered by the parent, provided tile sizes and selected extra-dimension coordinates match. The official MVD_A_NOKIA_1 vector validates a synthetic two-column POC 0→1 chain tile by tile; a synthetic two-column-parent to one-column-child case validates the aligned mapping. For matching grids or origin-aligned parent coverage, same-coordinate L-HEVC references also support different extra-dimension sizes when dimension counts and tile dimensions match; Offsets that do not map integrally to each L-HEVC layer sample and chroma grid remain unsupported; source tile boundaries used by motion maps must align to the 4×4 map grid. Reordered mappings remain unverified. The matching-grid two-tile test repeats the same pictures in both columns. A separate external-tile case validates a multi-reference P picture using parent `pred` images; its external tile files carry matching local reference chains, which are checked against the parent tile regions. In-file and external two-tile B decoding from the official `WP_B_Toshiba_3` vector now covers POCs 1, 2, 3, 5, 6, 7, 10, 12, and 16 across nine RPS/list patterns; these match per-frame FFmpeg hashes. Existing POC 8 (one POC 0 reference) and POC 4 (two active references per list, L0 POCs 0/8 and L1 POCs 8/0) checks remain. Other B tile/list combinations remain unverified. The official `CONFWIN_A_Sony_1` vector also validates a single conformance-window-cropped inter-coded tile (416×240 coded, 412×236 output) in both in-file and external wrappers, with sample-exact Y/Cb/Cr against FFmpeg 9.0.1 and matching synchronous/asynchronous SDR and linear-HDR output. The same vector also validates matching-grid two-tile P prediction in both storage modes: each tile retains its coded 416×240 reference samples while the visible output is cropped to 412×236 per tile. HVC1 references reuse a parent coded tile only when the parent and child grids, selected tile indexes, coded dimensions, bit depth, and chroma format match. For uncropped multi-tile children, the fallback can crop the parent canvas at the child tile origin when that region is covered; conformance-cropped multi-tile children require the coded-tile path. In-file `hvc1` prediction uses an integer, chroma-aligned `rloc` offset to select the region in its `pred`/`tbas` parent; see [the shifted-reference validation](docs/VALIDATION.md#rloc-offset-for-an-hevc-tili-prediction). Shifted conformance-cropped HVC1 references map across the visible tile grid and source SPS crops for the tested in-file and external paths, including 2D seams with a non-4×4 motion-map origin; other crop layouts and reordered mappings remain unverified. Other tile codecs remain unsupported; see [the bounded validation record](docs/VALIDATION.md#iso-heif-tiled-image-item-tili-2026-11-12). Remaining SCC gaps include combinations not represented by the verified official PPI, ACT/IBC, and 8×8 bi-prediction vectors. Mixed current/external P-slice reconstruction now has a 12-picture synthetic HM-SCM differential check through HEIF `pred` items; the scanned official SCC vectors still contain no mixed-reference P reconstruction vector. Floating-point mini images and gain maps remain unsupported. The generic minor-version-0 `mif3` path supports explicit uncompressed `unci` images using the integer `yv20` profile. The `avic` mini subset supports progressive integer 8-bit 4:2:0 AVC images, alpha items, and integer gain maps with 8-bit 4:2:0 samples; other mini codec configurations remain unsupported. Integer version-0 HEVC and uncompressed YV20 mini gain-map HDR are supported. Unknown ToneMapImage versions and gain-map metadata minimum versions fall back to the base image without applying the gain map. Mixed current-picture and external P references have list construction and per-reference prediction paths. A synthetic HM-SCM stream checks mixed-reference P reconstruction through HEIF `pred` items; see [validation notes](docs/VALIDATION.md#scc-mixed-reference-p-slices-through-heif-pred-items-2026-11-15). The official SCC vectors still do not include such a reconstruction vector. SCC SPS/PPS syntax and selected coding tools are implemented; the official vectors listed in [validation notes](docs/VALIDATION.md#scc-palette-decoding) are bounded evidence, not full SCC conformance. H.265 separate-plane syntax is present, but current profile constraints and scanned vectors do not establish a valid-profile HEIC decoding gap; see [validation notes](docs/VALIDATION.md#separate-plane-syntax-and-profile-scope). Unknown essential properties and required decoding features are rejected. The 2026-11-15 run of all 136 pinned external containers rejected no valid HEVC still image; its remaining rejections are malformed files, AVC/VVC items, or timed sequences outside this decoder's still-image scope. See the [pinned corpus results](docs/VALIDATION.md#external-images). This does not establish full HEVC/HEIF conformance.

Stable decoder failures use `HeicError.code` (for example `INVALID_CONTAINER`, `INVALID_BITSTREAM`, `UNSUPPORTED_FEATURE`, `RESOURCE_LIMIT`, `WORKER_FAILED`, `TIMEOUT`). Cancellation preserves `AbortSignal.reason`, including falsy values, instead of wrapping it as a decoding error.

The official HYBRID_A_QUALCOMM_1 POC 0 vector checks the HEIF `exbl` external-base path in both same-file and URL-backed wrappers: the `hvc1` base planes match the official YUV, and all three enhancement-plane hashes match the OPL record. URL-backed decoding accepts caller-supplied complete resources and applies the referenced `iloc` extents; it performs no automatic network requests. Both the async API and Node.js synchronous `decodeHeic` decode supported progressive 8-bit 4:2:0 `avc1` items and use them as `exbl` bases. Other AVC profiles and temporal decoding are not covered. Caller-provided planes from an external AVC decoder remain available through `externalBaseLayerPlanes`. See [the validation record](docs/VALIDATION.md#external-base-layer-item-through-exbl).

## API reference

### Decode entry points

| API                                          | Input                                                  | Options                           | Result                                               |
| -------------------------------------------- | ------------------------------------------------------ | --------------------------------- | ---------------------------------------------------- |
| `decode(source, options?)`                   | `Uint8Array`, `ArrayBuffer`, `Blob` (including `File`) | `AsyncDecodeOptions`              | `Promise<HeicImageData>`                             |
| `decodeHeic(input, options?)`                | `Uint8Array` (including Node `Buffer`)                 | `DecodeOptions`                   | `HeicImageData`, synchronous                         |
| `decodeHeicStereoPairs(input, options?)`     | `Uint8Array` (including Node `Buffer`)                 | `DecodeOptions`                   | `HeicStereoPair[]`, synchronous                      |
| `decodeHeicAuxiliaryPlanes(input, options?)` | `Uint8Array` (including Node `Buffer`)                 | `DecodeOptions`                   | `HeicAuxiliaryPlanes[]`, synchronous                 |
| `decodeHDR(source, options?)`                | `HeicInput`, same as `decode`                          | `AsyncDecodeOptions & HdrOptions` | `Promise<HdrImage>`                                  |
| `decodeHDRSync(input, options?)`             | `Uint8Array`                                           | `HdrOptions`                      | `HdrImage`, synchronous                              |
| `isHeic(input)`                              | `Uint8Array`                                           | —                                 | `boolean`; container/codec identification only       |
| `getHeicMetadata(input)`                     | `Uint8Array`                                           | —                                 | `HeicMetadata`; parses without reconstructing pixels |

`decodeHeicStereoPairs` decodes every `ster` group in left/right item order. Each referenced item must use a supported image format; bounded `lhv1` still-picture cases are supported as described above. `isHeic` returning true does **not** guarantee that the file is valid or uses supported coding tools. `getHeicMetadata` can throw for malformed or unsupported metadata; its dimensions and transforms describe the container, not necessarily the final transformed output. Decode the image to obtain the final `width` and `height`.

`decodeHeicAuxiliaryPlanes` decodes the primary image's associated `hvc1`/`lhv1` auxiliary items and preserves their stored sample bit depths. The returned planes have the HEVC conformance window applied; HEIF clean aperture, scale, rotation, and mirror transforms remain in the returned metadata. When present, recognized H.274 depth-representation and alpha-channel messages are returned in `hevcAuxiliarySei` as coded values, in NAL order. `maxPixels` limits the aggregate luma dimensions decoded by this call. The API exposes raw sample planes and metadata; it does not convert depth samples to physical distances or alter the returned alpha planes using ACI.

```ts
import { readFile } from 'node:fs/promises';
import { decodeHeic, decodeHDR } from '@ohah/heic';

const input = await readFile('photo.heic');
const rgba = decodeHeic(input);
const linear = await decodeHDR(input, { execution: 'main' });
// Node: explicitly use main; the default API expects browser Workers.
```

### Options and defaults

| Option                                | Type                                        | Default       | Behavior                                                                                                                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `itemId`                              | positive safe integer                       | primary item  | Decodes this HEIF image item instead of the primary item.                                                                                                                                                                                                      |
| `maxPixels`                           | positive safe integer, at most `50_000_000` | `50_000_000`  | Limits decoded/intermediate image allocation, including padded grids; independent of input byte size.                                                                                                                                                          |
| `applyTransforms`                     | `boolean`                                   | `true`        | Applies HEIF container clean aperture, rational scaling and display rotation/mirror; false skips those container transforms. `applyHevcDisplayOrientation` is controlled independently. HEVC conformance-window cropping still applies.                        |
| `applyHevcDisplayOrientation`         | `boolean`                                   | `true`        | Applies the active H.274 display-orientation SEI transform before HEIF item transforms.                                                                                                                                                                        |
| `applyDefaultDisplayWindow`           | `boolean`                                   | `false`       | Applies the SPS VUI display window to one coded HEVC item when no container clean aperture is present. Grid and `tili` geometry remains controlled by its container properties.                                                                                |
| `applyHevcToneMapping`                | `boolean`                                   | `false`       | Applies an active H.265 `tone_mapping_info` model 0–3 to RGB code values. `decodeHDR` rejects this RGBA8 display option.                                                                                                                                       |
| `hevcToneMapId`                       | nonnegative integer                         | latest active | Selects a `tone_map_id`; requires `applyHevcToneMapping: true`.                                                                                                                                                                                                |
| `applyHevcKneeFunction`               | `boolean`                                   | `false`       | Applies an active H.265 `knee_function_info` curve in normalized linear RGB. SMPTE ST 2085 XYZ output and unsupported transfer functions are rejected. `decodeHDR` rejects this RGBA8 display option.                                                          |
| `hevcKneeFunctionId`                  | nonnegative integer                         | latest active | Selects a `knee_function_id`; requires `applyHevcKneeFunction: true`.                                                                                                                                                                                          |
| `applyHevcColourRemapping`            | `boolean`                                   | `false`       | Applies an active H.265 `colour_remapping_info` before RGB conversion. A signalled matrix triggers 4:4:4 chroma reconstruction; `decodeHDR` rejects this RGBA8 display option.                                                                                 |
| `hevcColourRemapId`                   | nonnegative integer                         | latest active | Selects a `colour_remap_id`; requires `applyHevcColourRemapping: true`.                                                                                                                                                                                        |
| `applyHevcChromaResamplingFilterHint` | `boolean`                                   | `false`       | Applies the active H.265 `chroma_resampling_filter_hint` before RGB conversion. Supports field-based filtering for frames and individual field-sequence pictures; paired-field frame-based filtering is unavailable for a standalone still item.               |
| `applyHevcPostFilterHint`             | `boolean`                                   | `false`       | Applies the last H.265 type-0 2D or type-1 separable FIR hint to cropped Y/Cb/Cr planes. Type-2 cross-correlation hints stay metadata-only. Uses Q16 coefficients, edge replication, and final rounding/clipping as renderer policy.                           |
| `iccRenderingIntent`                  | `IccRenderingIntent`                        | `'relative'`  | Selects the ICC input transform: relative (`A2B1`), perceptual (`A2B0`), saturation (`A2B2`), or absolute (`D2B3`). Absolute intent uses media-relative transforms with white-point scaling when `D2B3` is absent; unsupported transforms fall back to `A2B0`. |

For HEIF `iscl` image scaling, output dimensions follow the signalled rational width and height ratios, rounded up as specified. The standard does not prescribe a sample reconstruction filter; this renderer uses bilinear interpolation.
| `execution` | `'worker' \| 'main'` | `'worker'` | Async entry points only. `main` blocks before its Promise resolves. |
| `signal` | `AbortSignal` | none | Async entry points only. Already-aborted signals reject before decode; in-flight interruption requires a worker. |
| `timeoutMs` | finite number `> 0`, at most `2_147_483_647` | `30_000` | Worker only; terminates the worker. Synchronous main-thread work cannot be interrupted. |
| `workerFactory` | `() => Worker` | module worker next to built `index.js` | Async entry points only. Supply a module worker running the exported worker entry. |
| `externalTileData` | `Record<string, Uint8Array>` | none | `tili` external tiles only. Key by the exact URL; useful for synchronous decoding or preloaded worker resources. No network requests are made automatically. |
| `externalItemData` | `Record<number, Uint8Array>` | none | External item resources keyed by HEIF item ID. Supply the complete URL- or URN-referenced resource; the decoder applies that item's `iloc` extents. Capped at 64 MiB total. No network requests are made automatically. |
| `externalBaseLayerPlanes` | `Record<number, ExternalBaseLayerPlanes>` | none | Supply caller-decoded planes for `avc1` items, keyed by HEIF item ID. The bundled decoder handles supported progressive 8-bit 4:2:0 AVC items; this option supports external AVC decoders and environments where synchronous WebAssembly initialization is unavailable. |
| `extraDimensionIndexes` | `readonly number[]` | all zeros | Selects one 2D plane from a multidimensional `tili` item. Provide one zero-based coordinate for each `extraDimensionSizes` entry in `getHeicMetadata`. |
| `resolveExternalTile` | `(url, signal?) => Uint8Array \| Promise<Uint8Array>` | none | Async entry points only. Loads external `tili` tiles before decode; caller controls network access and credentials. |
| `resolveExternalItem` | `(reference, itemId, signal?) => Uint8Array \| Promise<Uint8Array>` | none | Async entry points only. Loads URL/URN resources for the primary item and its direct `exbl` base item. The `reference` is an `ExternalItemDataReference`; the caller controls resource lookup and credentials. |
| `displayHeadroom` | number `>= 1` (also accepts `Infinity`) | full stored gain-map/HAGC headroom | HDR entry points only. Target display/base-white ratio for gain maps and ICC HAGC; capped to the stored range. `1` requests the SDR end of the reconstruction. |
| `referenceWhiteNits` | finite number `>= 1` | `203` | HDR entry points only. Reference white for PQ/HLG, in cd/m². |
| `displayPeakNits` | finite number `>= 1` | `1000` | HDR entry points only. Reference display peak for HLG, in cd/m². |

`DecodeOptions` contains the options above plus optional preloaded external tile/item bytes and `extraDimensionIndexes`. `AsyncDecodeOptions` extends it with execution/cancellation/worker options and optional caller-supplied tile/item resolvers. `HdrOptions` extends it with the three HDR options; the HEVC tone and knee mapping options apply only to RGBA8 decode. Input size is independently capped at 64 MiB; external tile and item resources are each capped at 64 MiB total. Intermediate rendering has additional allocation/depth/work limits, so a file below the byte/pixel ceilings can still be rejected. The caller's input is neither detached nor modified.

For multidimensional `tili` items, `getHeicMetadata(input).tiledImage.extraDimensionSizes` lists the extra dimensions. Each decode returns one 2D plane; `extraDimensionIndexes` selects its zero-based coordinate in each dimension, defaulting to the first plane.

For external `tili` files, `getHeicMetadata(input).tiledImage.dataReference` exposes the parsed URL fields. Use `buildTiledTileUrl(reference, tileIndex)` to obtain the exact URL keys. A synchronous decode accepts `{ externalTileData: { [url]: bytes } }`; `decode` and `decodeHDR` can instead accept a `resolveExternalTile` callback. External tile files are decoded as HEIF images, including supported identity derivations, nested in-file `tili` images, display transforms, monochrome HEVC alpha, and ISO gain-map `tmap` items. HDR decoding reconstructs each tile's gain map before stitching the linear-light output. External `tili` metadata reports `bitDepth: 0` until tile bytes are decoded because each external file carries its own codec configuration.

For externally referenced `iloc` resources, `getHeicMetadata(input).externalBaseLayerItemId` identifies an `exbl` base item when present. Supply its complete external resource with `externalItemData: { [itemId]: bytes }` for synchronous decoding, or use `resolveExternalItem(reference, itemId, signal)` with `decode`/`decodeHDR`. `ExternalItemDataReference` is `{ type: 'url', url }` or `{ type: 'urn', name, location? }`. The caller resolves the resource and credentials; `@ohah/heic` does not fetch automatically.

### Output data

```ts
interface HeicImageData {
  width: number;
  height: number;
  data: Uint8Array; // row-major RGBA8; length = width * height * 4
  hasAlpha: boolean;
  bitDepth: HeifImageBitDepth; // HEVC 8..15; unsigned `unci` 8..16; signed `unci` 2..16
  bitDepthChroma?: HeifImageBitDepth; // present only when it differs from luma
}

interface HdrImage {
  width: number;
  height: number;
  data: Float32Array; // row-major straight-alpha RGBA
  hasAlpha: boolean;
  bitDepth: HeifImageBitDepth;
  bitDepthChroma?: HeifImageBitDepth;
  colorSpace: 'linear-srgb';
  headroom: number; // headroom represented by this result
  sourceHeadroom: number; // stored/derived source headroom before target limiting
  source: 'sdr' | 'pq' | 'hlg' | 'apple-gainmap' | 'iso-gainmap' | 'icc-hagc';
}
```

HDR RGB is linear-light sRGB, normalized to reference white: values may exceed `1` and gamut conversion can produce negative values. Alpha remains `0..1`. An SDR source passed to the HDR API is linearized and returns `source: 'sdr'`. Passing HDR floats directly to an 8-bit `ImageData` loses the HDR information; apply a chosen display transform/tone map first. For SDR images, `decode` converts RGB matrix/TRC and monochrome `grayTRC` profiles with XYZ or Lab PCS to sRGB using relative colorimetry. RGB and monochrome scanner/display profiles can also use `A2B1`/`A2B0` `mAB`, `mft1`, or `mft2` transforms with Lab PCS; set `iccRenderingIntent: 'saturation'` to select `A2B2`, `iccRenderingIntent: 'perceptual'` to select `A2B0`, or `iccRenderingIntent: 'absolute'` to select `D2B3` and use media-white-point scaling with relative transforms when it is absent. `mAB` and `mft2` also support 16-bit XYZ PCS. The latter is decoded using ICC's `u1Fixed15` scale, where code `0x8000` represents XYZ 1.0. The `mAB` subset supports one or three input channels, three output channels, 8- or 16-bit CLUT data, and ICC `curv`/`para` curves; the legacy `mft1`/`mft2` subset supports one-channel monochrome or three-channel RGB input and three output channels, with the ICC-defined one-dimensional tables and one- or three-dimensional CLUT. `mft1` with XYZ PCS is rejected because the ICC specification does not define an 8-bit XYZ PCS encoding. Matrix/TRC input/display profiles are supported in `prof`; the restricted `rICC` form accepts only RGB matrix/TRC or monochrome input profiles and rejects LUT transforms. unrecognized MPE elements, other device color spaces, RGB Lab PCS matrix/TRC profiles, profiles lacking both an `A2B0` LUT and a complete matrix/TRC fallback remain unsupported unless an intent-matched `D2B` MPE transform handles the selected intent. `decode` does not tone map HDR.

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

| Export                                                    | Purpose / contract                                                                                                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseISOBMFF(input)`                                     | Returns an `ISOBMFFBox[]` tree. Boxes expose `type`, `size`, `offset`, `data` and optional `children`.                                                                                                                                                                                                                                                                                                                                    |
| `findBox(boxes, type)`, `findAllBoxes(boxes, type)`       | Recursive lookup; first match or `undefined`, or all matching boxes.                                                                                                                                                                                                                                                                                                                                                                      |
| `getFtypInfo(input)`, `validateFtyp(input)`               | Read major/compatible brands, or check the leading file-type box. A valid `ftyp` does not imply a decodable file.                                                                                                                                                                                                                                                                                                                         |
| `getHeicInfo(input, boxes, itemId?)`                      | Resolve primary or selected item's properties, dimensions, codec configuration, grid, alpha, derived items and transforms.                                                                                                                                                                                                                                                                                                                |
| `getItemPayload(input, boxes, itemId)`                    | Assemble item bytes from its extents; returns `Uint8Array` or `null` when not found.                                                                                                                                                                                                                                                                                                                                                      |
| `parsePitm(data)`                                         | Parse primary item ID from a full-box body.                                                                                                                                                                                                                                                                                                                                                                                               |
| `parseIpma(data)`                                         | Parse property associations from a full-box body, preserving essential properties.                                                                                                                                                                                                                                                                                                                                                        |
| `parseIref(box)`                                          | Parse item references from an `iref` box.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `parseHvcC(data)`                                         | Parse HEVC configuration, NAL length prefix size and parameter-set arrays.                                                                                                                                                                                                                                                                                                                                                                |
| `parseGridBody(data)`                                     | Parse grid rows, columns and output size; item IDs/tile size require container references.                                                                                                                                                                                                                                                                                                                                                |
| `splitAnnexB(stream)`                                     | Split start-code-prefixed HEVC into `NalUnit[]`.                                                                                                                                                                                                                                                                                                                                                                                          |
| `splitLengthPrefixed(payload, nalLengthSize)`             | Split HEIF HEVC payload, using an integer prefix size `1..4`.                                                                                                                                                                                                                                                                                                                                                                             |
| `toRbsp(nal)`                                             | Remove the NAL header and emulation-prevention bytes.                                                                                                                                                                                                                                                                                                                                                                                     |
| `isSliceNal(type)`, `NalType`                             | Recognize supported slice-type ranges; named HEVC NAL constants.                                                                                                                                                                                                                                                                                                                                                                          |
| `BitReader`                                               | Construct from `Uint8Array`; `readBit()`, `readBits(n)`, `ue()`, `se()` and `bitPosition`.                                                                                                                                                                                                                                                                                                                                                |
| `parseSps(nal)`, `parsePps(nal)`                          | Parse full SPS/PPS NAL payloads, including their NAL headers.                                                                                                                                                                                                                                                                                                                                                                             |
| `PictureDecoder`                                          | `new PictureDecoder(sps, pps).decode(sliceNals)` reconstructs coded planes before deblocking/SAO, HEIF assembly, crop and RGB rendering. This low-level result is not the final image.                                                                                                                                                                                                                                                    |
| `yuv420ToRgba(y, cb, cr, width, height, options?)`        | Convert planar 4:2:0 to RGBA8. Chroma dimensions are `ceil(width/2) × ceil(height/2)`; nearest-sample upsampling. Defaults: 8-bit, BT.601 matrix (`6`), full range. Supports matrix codes `1`, `4–15`, and `16/17`; code `8` is YCgCo, codes `16/17` are YCgCo-Re/Ro with RGB precision derived from luma depth. Set `bitDepthChroma` for code 8's unequal-depth form and `transferCharacteristics` for codes `10`, `13`, `14`, and `15`. |
| `applyOrientation(rgba, width, height, rotation, mirror)` | RGBA8 quarter-turns counterclockwise, then mirror: `0` vertical axis, `1` horizontal axis, `null` none. Returns `OrientedImage`.                                                                                                                                                                                                                                                                                                          |
| `interpretHevcDepthSample(sample, bitDepth, info)`        | Apply H.274 depth-representation semantics to one decoded auxiliary luma sample. Returns a normalized value and physical Z/disparity when both bounds are specified.                                                                                                                                                                                                                                                                      |

All exported TypeScript types are grouped below. Some describe low-level codec syntax rather than end-user options.

| Types                                                                 | Contents                                                                                                                   |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `HeicInput`, `DecodeOptions`, `AsyncDecodeOptions`, `HdrOptions`      | Accepted inputs/options documented above.                                                                                  |
| `IccRenderingIntent`                                                  | ICC input-profile rendering intent (`relative`, `perceptual`, `saturation`, or `absolute`).                                |
| `HeicImageData`, `HdrImage`, `HeicErrorCode`                          | Output and failure contracts documented above.                                                                             |
| `HeicMetadata`                                                        | Extends `HeicInfo` with parsed primary/first-tile `sps` (or null) and `sliceNalCount`.                                     |
| `HeicInfo`, `GridInfo`, `HvcCConfig`                                  | Item selection, color/ICC metadata, mini Exif/XMP payloads, transforms, references, grid geometry and HEVC parameter sets. |
| `ISOBMFFBox`, `FileTypeInfo`                                          | Container tree and file-type brands.                                                                                       |
| `NalUnit`, `SpsInfo`, `PpsInfo`, `VuiColorInfo`                       | HEVC NAL payloads, parameter sets and color signaling.                                                                     |
| `DecodedPicture`, `SaoParams`                                         | Reconstructed YUV planes and in-loop-filter syntax/bookkeeping.                                                            |
| `HevcDepthRepresentationInformation`, `HevcDepthSampleInterpretation` | Coded H.274 depth-representation metadata and interpreted single-sample result.                                            |
| `HevcDisplayOrientation`                                              | Coded H.274 display transform messages, including cancellation and persistence.                                            |
| `ColorOptions`, `OrientedImage`                                       | Raw 4:2:0 conversion options and transformed RGBA8 result.                                                                 |

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
HEIC_CHROMA=2 bun scripts/adversarial-reference.ts
HEIC_CHROMA=3 bun scripts/adversarial-reference.ts
bun run validate:hevc-qp-boundary
bun run validate:iso-hevc-422
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

The registry can scan a newly submitted version before exposing its tarball. A successful publish command alone is not an installation check. After publication, verify the exact version with `npm view @ohah/heic@<version> version` and a fresh install. A temporary `0.0.0-stage` placeholder alone does not establish that the maintainer must approve a staged package; check the actual staging queue before requesting approval.

## License

MIT. Retain the license and notices when redistributing. The software license does not grant rights to HEVC standard-essential patents.
