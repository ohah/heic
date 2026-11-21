# HEVC weighted B prediction in 10-bit 4:2:2

This is a synthetic differential vector, not an ITU-T conformance stream. It
checks weighted B prediction across both active reference lists for the HEVC
Main 4:2:2 10 profile. The official H.265.1 `WP_B_Toshiba_3` vector in this
project covers weighted B prediction in 8-bit 4:2:0; the checked official
Main 4:2:2 10-bit A and B vectors do not enable `weighted_bipred_flag`.

`source.y4m` contains six 128×64 10-bit 4:2:2 frames with a changing luma and
chroma pattern. x265 4.3 encodes three weighted B pictures with different L0
and L1 list sizes. The saved `recon.y4m` contains the encoder reconstruction
in display order. `test/hevc-weighted-b-422.test.ts` checks all six decoded
Y/Cb/Cr frames against it and decodes the final coded picture through a
synthetic HEIF `pred` graph.

The vector was generated with x265 `4.3+1-e9b8812`:

```sh
x265 --input source.y4m --output weighted-b-422.hevc \
  --input-depth 10 --input-csp i422 --output-depth 10 \
  --qp 28 --preset medium --frame-threads 1 --bframes 3 \
  --keyint 6 --min-keyint 6 --no-scenecut --weightb \
  --recon recon.y4m --recon-depth 10 --log-level warning
```

SHA-256:

| File                  | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `source.y4m`          | `100d2f52c5710bb3be6a4621abe8fd5a2dbfee0da88bcea8fb9da670286e233f` |
| `weighted-b-422.hevc` | `e1e2b18132bf5acb9839371d9c0550a21069e80006e542384660f58a37c0772a` |
| `recon.y4m`           | `85d18cd49db923576071bacd82d667503d441eaafa43764a13c2405f7e424243` |
