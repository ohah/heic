# Validation record

Run date: 2026-10-26. This is an implementation/coverage record, not a HEIF or HEVC conformance certificate.

## External images

All 136 files in `test/corpus-manifest.json` were attempted, with source URL, byte count and SHA256 verification. Results: **102 decoded; 34 rejected**. Rejections are not decode passes. External image bytes remain under `/tmp` and are not committed or packaged.

Sources: Nokia HEIF gallery/conformance, the original Nokia HEIF conformance repository, and pillow-heif tests. Source commits are pinned in the manifest. All 20 pillow-heif monochrome/RGB/alpha 8/10/12-bit fixtures, including 29×100 images, decoded.

| File                                                                | Result   | Detail                                                        |
| ------------------------------------------------------------------- | -------- | ------------------------------------------------------------- |
| nokia-content__cc0__3A_HEIC_HDR.heic                                | decoded  | 8256×5504, 10-bit                                             |
| nokia-content__cc0__3B_HEIC_SDR.heic                                | decoded  | 8256×5504, 10-bit                                             |
| nokia-content__conformance__C001.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C002.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C003.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C004.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C005.heic                               | decoded  | 128×72, 8-bit                                                 |
| nokia-content__conformance__C006.heic                               | rejected | hevc-still: heic: item 1005 carries no coded slices           |
| nokia-content__conformance__C007.heic                               | decoded  | 2560×1440, 8-bit                                              |
| nokia-content__conformance__C008.heic                               | decoded  | 720×1280, 8-bit                                               |
| nokia-content__conformance__C009.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C010.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C011.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C012.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C013.heic                               | decoded  | 300×300, 8-bit                                                |
| nokia-content__conformance__C014.heic                               | decoded  | 300×300, 8-bit                                                |
| nokia-content__conformance__C015.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C016.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C017.heic                               | decoded  | 640×360, 8-bit                                                |
| nokia-content__conformance__C018.heic                               | decoded  | 640×360, 8-bit                                                |
| nokia-content__conformance__C019.heic                               | decoded  | 640×360, 8-bit                                                |
| nokia-content__conformance__C020.heic                               | decoded  | 640×360, 8-bit                                                |
| nokia-content__conformance__C021.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C022.heic                               | decoded  | 1440×960, 8-bit                                               |
| nokia-content__conformance__C023.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C024.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C025.heic                               | decoded  | 128×72, 8-bit                                                 |
| nokia-content__conformance__C026.heic                               | rejected | timed-sequence: heic: timed image sequences are not supported |
| nokia-content__conformance__C027.heic                               | rejected | timed-sequence: heic: timed image sequences are not supported |
| nokia-content__conformance__C028.heic                               | rejected | timed-sequence: heic: timed image sequences are not supported |
| nokia-content__conformance__C029.heic                               | rejected | timed-sequence: heic: timed image sequences are not supported |
| nokia-content__conformance__C030.heic                               | rejected | timed-sequence: heic: timed image sequences are not supported |
| nokia-content__conformance__C031.heic                               | rejected | timed-sequence: heic: timed image sequences are not supported |
| nokia-content__conformance__C032.heic                               | rejected | timed-sequence: heic: timed image sequences are not supported |
| nokia-content__conformance__C034.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C036.heic                               | rejected | timed-sequence: heic: timed image sequences are not supported |
| nokia-content__conformance__C037.heic                               | rejected | timed-sequence: heic: timed image sequences are not supported |
| nokia-content__conformance__C038.heic                               | rejected | timed-sequence: heic: timed image sequences are not supported |
| nokia-content__conformance__C039.heic                               | decoded  | 150×150, 8-bit                                                |
| nokia-content__conformance__C040.heic                               | decoded  | 1024×576, 8-bit                                               |
| nokia-content__conformance__C041.heic                               | rejected | timed-sequence: heic: timed image sequences are not supported |
| nokia-content__conformance__C042.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C043.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C044.heic                               | rejected | hevc-still: heic: unsupported essential property rref         |
| nokia-content__conformance__C045.heic                               | decoded  | 1024×768, 8-bit                                               |
| nokia-content__conformance__C046.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C047.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C048.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C049.heic                               | decoded  | 1920×1080, 8-bit                                              |
| nokia-content__conformance__C050.heic                               | decoded  | 1280×960, 8-bit                                               |
| nokia-content__conformance__C051.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C052.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__C053.heic                               | decoded  | 1024×512, 8-bit                                               |
| nokia-content__conformance__C71.heic                                | rejected | hevc-still: heic: not a HEIC file                             |
| nokia-content__conformance__MIAF001.heic                            | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__MIAF002.heic                            | decoded  | 2048×2048, 10-bit                                             |
| nokia-content__conformance__MIAF003.heic                            | decoded  | 2048×2048, 8-bit                                              |
| nokia-content__conformance__MIAF004.heic                            | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__MIAF005.heic                            | decoded  | 1280×720, 8-bit                                               |
| nokia-content__conformance__MIAF006.heic                            | decoded  | 1920×1440, 8-bit                                              |
| nokia-content__conformance__MIAF007.heic                            | decoded  | 360×640, 8-bit                                                |
| nokia-content__conformance__multilayer001.heic                      | rejected | hevc-still: heic: multilayer HEVC NAL units are not supported |
| nokia-content__conformance__multilayer002.heic                      | rejected | hevc-still: heic: multilayer HEVC NAL units are not supported |
| nokia-content__conformance__multilayer003.heic                      | decoded  | 1024×512, 8-bit                                               |
| nokia-content__conformance__multilayer004.heic                      | rejected | other-codec-avc1: heic: unsupported essential property avcC   |
| nokia-content__conformance__multilayer005.heic                      | rejected | hevc-still: heic: unsupported SPS extension                   |
| nokia-content__imagecompression__big_tree.heic                      | decoded  | 6088×4550, 10-bit                                             |
| nokia-content__nokia__XD64.heic                                     | rejected | hevc-still: heic: invalid auxiliary image descriptor          |
| nokia-content__nokia__alpha_1440x960.heic                           | decoded  | 1440×960, 8-bit                                               |
| nokia-content__nokia__autumn_1440x960.heic                          | decoded  | 1440×960, 8-bit                                               |
| nokia-content__nokia__bird_burst.heic                               | decoded  | 1280×720, 8-bit                                               |
| nokia-content__nokia__bothie_1440x960.heic                          | decoded  | 1440×960, 8-bit                                               |
| nokia-content__nokia__candle_animation.heic                         | decoded  | 256×144, 8-bit                                                |
| nokia-content__nokia__cheers_1440x960.heic                          | decoded  | 1440×960, 8-bit                                               |
| nokia-content__nokia__compare_still_1.heic                          | decoded  | 1440×960, 8-bit                                               |
| nokia-content__nokia__compare_still_2.heic                          | decoded  | 1440×960, 8-bit                                               |
| nokia-content__nokia__compare_still_3.heic                          | decoded  | 1440×960, 8-bit                                               |
| nokia-content__nokia__crowd_1440x960.heic                           | decoded  | 1440×960, 8-bit                                               |
| nokia-content__nokia__grid_960x640.heic                             | decoded  | 960×640, 8-bit                                                |
| nokia-content__nokia__lights_1440x960.heic                          | decoded  | 1440×960, 8-bit                                               |
| nokia-content__nokia__meadow.heic                                   | decoded  | 5472×3648, 8-bit                                              |
| nokia-content__nokia__meadow.heif                                   | rejected | other-codec-vvc1: heic: not a HEIC file                       |
| nokia-content__nokia__meadow_2k_vvc.heif                            | rejected | other-codec-vvc1: heic: not a HEIC file                       |
| nokia-content__nokia__old_bridge_1440x960.heic                      | decoded  | 1440×960, 8-bit                                               |
| nokia-content__nokia__overlay_1000x680.heic                         | decoded  | 1000×680, 8-bit                                               |
| nokia-content__nokia__rally_burst.heic                              | decoded  | 1280×720, 8-bit                                               |
| nokia-content__nokia__random_collection_1440x960.heic               | decoded  | 1440×960, 8-bit                                               |
| nokia-content__nokia__sea1_animation.heic                           | decoded  | 256×144, 8-bit                                                |
| nokia-content__nokia__season_collection_1440x960.heic               | decoded  | 1440×960, 8-bit                                               |
| nokia-content__nokia__ski_jump_1440x960.heic                        | decoded  | 1440×960, 8-bit                                               |
| nokia-content__nokia__spring_1440x960.heic                          | decoded  | 1440×960, 8-bit                                               |
| nokia-content__nokia__starfield_animation.heic                      | decoded  | 256×144, 8-bit                                                |
| nokia-content__nokia__stereo_1200x800.heic                          | decoded  | 1200×800, 8-bit                                               |
| nokia-content__nokia__summer_1440x960.heic                          | decoded  | 1440×960, 8-bit                                               |
| nokia-content__nokia__surfer_1440x960.heic                          | decoded  | 1440×960, 8-bit                                               |
| nokia-content__nokia__winter_1440x960.heic                          | decoded  | 1440×960, 8-bit                                               |
| nokia-content__personal__brutal-jurmala.heif                        | rejected | other-codec-vvc1: heic: not a HEIC file                       |
| nokia-content__personal__coffee-room.heic                           | decoded  | 3024×4032, 8-bit                                              |
| nokia-content__personal__felines-old-factory.heif                   | rejected | other-codec-vvc1: heic: not a HEIC file                       |
| nokia-content__personal__kahvihuone2.heic                           | decoded  | 3024×4032, 8-bit                                              |
| nokia-content__personal__lahde.heif                                 | rejected | other-codec-vvc1: heic: not a HEIC file                       |
| nokia-content__personal__mr-victory.heif                            | rejected | other-codec-vvc1: heic: not a HEIC file                       |
| nokia-content__personal__mug.heic                                   | decoded  | 3024×4032, 8-bit                                              |
| nokia-content__personal__mug2.heic                                  | decoded  | 3024×4032, 8-bit                                              |
| nokia-content__personal__shades.heic                                | decoded  | 3024×3024, 8-bit                                              |
| nokia-content__personal__sun_hdr_full_gainmap.heic                  | decoded  | 256×256, 10-bit                                               |
| nokia-content__personal__vintage-supercar.heif                      | rejected | other-codec-vvc1: heic: not a HEIC file                       |
| nokia-content__pixabay__661512-finland-1493058.heif                 | rejected | other-codec-vvc1: heic: not a HEIC file                       |
| nokia-content__pixabay__ltapsah-road-6594010.heif                   | rejected | other-codec-vvc1: heic: not a HEIC file                       |
| nokia-content__pixabay__nord-bei-nordost-turku-2810087.heif         | rejected | other-codec-vvc1: heic: not a HEIC file                       |
| nokia-content__unsplash__bricks.heif                                | rejected | other-codec-vvc1: heic: not a HEIC file                       |
| nokia-content__unsplash__bricksQP26.heif                            | rejected | other-codec-vvc1: heic: not a HEIC file                       |
| nokia-content__unsplash__sini-tiainen-oXEfEJ-hE7Q-unsplash (1).heif | rejected | other-codec-vvc1: heic: not a HEIC file                       |
| nokia-content__unsplash__tapio-haaja-DTgvAa5pKO4-unsplash.heif      | rejected | other-codec-vvc1: heic: not a HEIC file                       |
| nokia-content__unsplash__tapio-haaja-z9LKMs0P3bo-unsplash.heif      | rejected | other-codec-vvc1: heic: not a HEIC file                       |
| pillow-tests__images__heif__RGB_8__128x128.heif                     | decoded  | 128×128, 8-bit                                                |
| pillow-tests__images__heif__RGB_8__29x100.heif                      | decoded  | 29×100, 8-bit                                                 |
| pillow-tests__images__heif__RGB_10__128x128.heif                    | decoded  | 128×128, 10-bit                                               |
| pillow-tests__images__heif__RGB_10__29x100.heif                     | decoded  | 29×100, 10-bit                                                |
| pillow-tests__images__heif__RGB_12__128x128.heif                    | decoded  | 128×128, 12-bit                                               |
| pillow-tests__images__heif__RGB_12__29x100.heif                     | decoded  | 29×100, 12-bit                                                |
| pillow-tests__images__heif__RGBA_8__128x128.heif                    | decoded  | 128×128, 8-bit                                                |
| pillow-tests__images__heif__RGBA_8__29x100.heif                     | decoded  | 29×100, 8-bit                                                 |
| pillow-tests__images__heif__RGBA_10__128x128.heif                   | decoded  | 128×128, 10-bit                                               |
| pillow-tests__images__heif__RGBA_10__29x100.heif                    | decoded  | 29×100, 10-bit                                                |
| pillow-tests__images__heif__RGBA_12__128x128.heif                   | decoded  | 128×128, 12-bit                                               |
| pillow-tests__images__heif__RGBA_12__29x100.heif                    | decoded  | 29×100, 12-bit                                                |
| pillow-tests__images__heif__L_8__128x128.heif                       | decoded  | 128×128, 8-bit                                                |
| pillow-tests__images__heif__L_8__29x100.heif                        | decoded  | 29×100, 8-bit                                                 |
| pillow-tests__images__heif__L_10__128x128.heif                      | decoded  | 128×128, 10-bit                                               |
| pillow-tests__images__heif__L_10__29x100.heif                       | decoded  | 29×100, 10-bit                                                |
| pillow-tests__images__heif__L_12__128x128.heif                      | decoded  | 128×128, 12-bit                                               |
| pillow-tests__images__heif__L_12__29x100.heif                       | decoded  | 29×100, 12-bit                                                |
| pillow-tests__images__heif__LA_8__128x128.heif                      | decoded  | 128×128, 8-bit                                                |
| pillow-tests__images__heif__LA_8__29x100.heif                       | decoded  | 29×100, 8-bit                                                 |
| nokia-original-conformance__C006.heic                               | decoded  | 1280×720, 8-bit                                               |

## Remaining failures

The rejected files include 15 VVC images, one AVC/multilayer file and 11 timed HEVC sequences. Seven still-image cases remain rejected, plus one decoded SDR image with incomplete HDR reconstruction:

- C006 in the gallery commit declares item 1005 as primary but that item contains only an SEI NAL and no coded picture. The separately pinned original C006 decodes. This distinction does not prove every conformance-file variant is malformed.
- C044 uses generic HEIF brands and requires `pred` references via an essential `rref` property. Generic-brand detection is fixed; reference-picture decoding remains unsupported.
- C71 uses a SlimHEIF `mini` container, not the supported `meta` item structure.
- multilayer001/002/005 require HEVC layer/extension support.
- XD64 has an `auxl` relation without the auxiliary descriptor needed to interpret it. The decoder rejects rather than inventing an alpha interpretation.
- sun_hdr_full_gainmap: its 10-bit 4:4:4 base is sample-exact against FFmpeg after fixes, but its monochrome gain-map bitstream uses range-extension tools (flags 486) and older gain-map metadata. Full HDR reconstruction of this file remains incomplete.

## Adversarial validation

- Unit suite: 20 rounds of nine negative/boundary cases, plus codec/container/HDR/alpha regressions. Each round covers forged association counts, truncated hvcC/NAL, invalid prefix length, falsy abort reasons, input limits, timer overflow, malformed worker messages, Blob read failures and pixel-limit boundaries.
- Synthetic reference suite: 20 varied rounds × 8/10/12-bit, for each of 4:2:0 and 4:4:4. Dimensions, seed, QP/CRF/AQ, WPP on/off (checked from the PPS), SAO, deblocking, sign hiding, transform skip, scaling lists and selected lossless encodes change by round.
- Browser suite: 20 rounds × 30 cases across 320/375/440/1024/1440 px viewports. Main/worker equality, 8/10/12-bit and 4:4:4, real iPhone grids, sliced views, concurrent requests, Blob/ArrayBuffer inputs, cancellation, timeouts, malformed messages, recovery, structured error parity, gain-map HDR and auxiliary alpha. Worker count must return to zero after each case.
- Package audit: npm tarball extraction, Node sync decoding and Rspack production bundle in Chromium, with default worker/main equality and structured failure. No runtime dependencies or source/tests are included in the tarball.

## Reference-tool defect: FFmpeg 8.1.1

One high-QP 12-bit 4:4:4 input initially disagreed with unmodified FFmpeg: 65,469 chroma samples differed. H.265 8.6.3 requires quotient/remainder by six through QP 75. FFmpeg 8.1.1 `libavcodec/hevc/cabac.c` declares 76-entry `rem6`/`div6` arrays but supplies only 74 initializers, so QP 74/75 use implicit zero values. Source: https://github.com/FFmpeg/FFmpeg/blob/n8.1.1/libavcodec/hevc/cabac.c .

For validation only, a local FFmpeg 8.1.1 build appends remainder values 2,3 and quotient values 12,12. The original failing input then matches this decoder across all 98,304 Y/Cb/Cr samples. Independently, an x265 12-bit encoder API reconstruction matches this decoder for all 98,304 samples of a separately encoded input; the corrected FFmpeg output has the same SHA256 as that encoder reconstruction. Unmodified FFmpeg disagreement is retained as a reference-tool exception, not hidden as a passing unmodified-reference test. No FFmpeg/libde265 code or binary is incorporated into the library.

Set `HEIC_FFMPEG_REFERENCE` to the corrected development executable for `scripts/adversarial-reference.ts`; generation still uses the installed FFmpeg/libx265. `HEIC_FFMPEG` selects the reference executable for `scripts/reference-corpus.ts`.

## Standards and observed rendering differences

- ITU-T H.265 V11 (2026-01): transform-skip syntax/scaling, transquant bypass, monochrome syntax, CRA RPS syntax, 4:4:4 chroma prediction/transform syntax and significance contexts, 32×32 chroma scaling lists, reference smoothing, range and filtering. https://www.itu.int/rec/T-REC-H.265-202601-I/en
- ITU-R BT.2100-3: PQ/HLG transfer and calibration. https://www.itu.int/rec/R-REC-BT.2100-3-202502-I/en
- Apple documented gain-map procedure and HDR metadata. https://developer.apple.com/documentation/appkit/applying-apple-hdr-effect-to-your-photos
- Nokia HEIF technical documentation for primary/derived/auxiliary images. https://nokiatech.github.io/heif/technical.html
- ISO gain-map version-0 metadata was cross-checked against Google libultrahdr. The complete current ISO HEIF document was not obtained, so this work does not claim a complete ISO document audit.

Codec reference comparisons measure reconstructed YUV before RGB upsampling, ICC conversion and display rendering. Exact YUV equality does not imply exact rendered RGB equality.

macOS ImageIO selected a different master/thumbnail/pre-derived image than the declared primary in four gallery cases (C005, C040, bird_burst, rally_burst). Dimensions and metadata were compared; these differences are recorded rather than silently changing primary selection.

Apple HDR comparison in extended linear sRGB was not pixel-identical: a 1536×2048 iPhone image had RGB MAE approximately 0.0190 (max 0.2745); a 3024×4032 image at its full stored headroom 5.6187 had MAE approximately 0.0393 (max 0.2204). At requested headroom 4, the latter differs more because ImageIO reconstructed full source headroom. These comparisons include differing upsampling/color/gain-map choices. Default headroom now uses the full stored value. Physical HDR display behavior has not been validated.

The demo is an independent library test harness. No actual Payhere development API or authenticated chatbot upload has been verified by these tests.

## Final recorded checks

- Typecheck/build passed; 261 unit tests passed (260-test full run plus the isolated normative scaling-list regression, then combined verification).
- Chromium: 600/600 adversarial checks; a separate 30-case run captured SDR, alpha, HDR-to-SDR preview and invalid-input states.
- 4:2:0 synthetic suite: 60/60 sample-exact; 4:4:4: 60/60 sample-exact with the documented FFmpeg reference correction.
- External coded pictures visited: 350; 48 duplicates; 301 unique pictures sample-exact (370,473,736 samples); one gain-map picture explicitly unsupported (range flags 486). This is not a 302/302 success claim.
- External containers: 102/136 SDR decodes, 34 rejected, and one of the 102 has a separate HDR failure.
- Packaged Node/Rspack production browser consumer passed; zero runtime dependencies.
