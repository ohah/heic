# 15-bit maximum-qP regression references

These references extend the project QP-boundary streams in
`test/fixtures/conformance/hevc-12bit-444-qp74.hevc` and `qp75.hevc` to the
15-bit sample depth representable by HEIF `hvcC`. They are derived regression
vectors, not separately published H.265.1 conformance vectors.

The test patches each source SPS from 12-bit to 15-bit and clears the
`general_max_12bit_constraint_flag` in both VPS and SPS profile-tier-level
syntax. The resulting streams use the same coded residuals and exercise
15-bit qP-prime 92 and 93, respectively. Their 128×64 Y/Cb/Cr output is checked
sample-for-sample against the official HHI HM 19.0 reference decoder at commit
`92d95ddd2995d0ae3149d3dac1e573e96460b821`, built with `HIGH_BITDEPTH=ON`.

The source vectors are 12-bit x265 project regressions; their SHA-256 hashes
are checked in `test/hevc-qp-boundary.test.ts`. The reference outputs are raw
little-endian 16-bit planar YUV:

| File                  | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `qp74-15bit-hm19.yuv` | `8e9cd75345ecbc962f69549c0b7cb35e1248230ec2c98926aa5e3b599885d8ad` |
| `qp75-15bit-hm19.yuv` | `d3f1752b1ef794cee72d26042e88a929abae727c3244f9acd248c2829bf28802` |

The focused test validates raw HEVC reconstruction, HEIF `heix` item-plane
decoding, and the public `decodeHeic` rendering entry point.
