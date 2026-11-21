# ICC test profiles

`CVDlut-deutan.icc` is the ICC's published RGB input profile for the Viénot et
al. dichromat colour map. It is the official profile-library asset, unchanged.

- Source page: https://registry.color.org/profile-library/cvd
- Download: https://registry.color.org/profile-library/profiles/CVDlut-deutan.icc
- Size: 6,568 bytes
- SHA-256: `47225761e99dff203636117ed647511a7cfb3a28288d7c27ba25e0480544e34d`
- License: ICC profile terms permit copying, embedding, and distribution of
  ICC-owned profiles. See https://www.color.org/profileview/.

`AppleHagc.icc` is the Apple HAGC RGB/XYZ display profile in Google's `skcms`
test corpus, pinned to commit `074a8d439d75df5bff2746458306f7760ee74dd8`.

- Source: https://skia.googlesource.com/skcms/+/074a8d439d75df5bff2746458306f7760ee74dd8/profiles/misc/AppleHagc.icc
- Size: 26,540 bytes
- SHA-256: `cef4a6bcb6bacef4aded619d21449d853d93d1b4c85cd335f7bb07cd90d0f6b1`
- License: the upstream `skcms` BSD-3-Clause license, reproduced in
  [`skcms-LICENSE`](./skcms-LICENSE).

The profile's `A2B0` is a 13×13×13 `mAB` transform with XYZ PCS and an HAGC
tag. Tests exercise `decodeHeic`'s SDR compatibility rendering and verify that
HDR decoding follows the HAGC path. It is a real ICC profile in a synthetic
HEIF wrapper, not an official HEIF conformance vector.

The profile contains ICC v4 RGB `A2B0` and `A2B1` `mAB` transforms with Lab
PCS. Tests exercise the perceptual `A2B0` transform. Reference pixels were
generated with LittleCMS 2.19.1 `transicc`; this profile is not an HEIF or
HEVC conformance vector.
