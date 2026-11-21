# HEVC multi-reference weighted P regression vector

This is a synthetic 128×64, 8-bit 4:2:0, three-picture project vector generated with x265 `4.3+1-e9b8812`. It is not an official conformance vector. Its POC 2 picture has two active L0 references with different weight entries, selects both reference indices in its inter blocks, and reconstructs sample-exactly against x265's saved Y4M output. The focused test also places the pictures in a synthetic HEIF `pred` graph and checks POC 2 through public `decodeItemPlanes`.

For each component plane, with component index `p`, component coordinates `(x, y)`,

```text
A = 40 + ((7*x + 11*y + 3*(x XOR y) + 19*p) mod 120)
B = 52 + ((13*x + 17*y + 3*x*y + 31*p) mod 140)
```

POC 0 is `A`; POC 1 is `B`; POC 2 uses `A + 10` above the component midline and `B - 10` below it. Chroma planes use their 4:2:0 dimensions.

The three pictures were encoded with weighted P prediction, four maximum L0 references, no B pictures, and fixed QP 28:

```sh
x265 --input source.y4m --output weighted-p-multiref.hevc \
  --input-depth 8 --input-csp i420 --output-depth 8 --qp 28 \
  --ipratio 1.0 --pbratio 1.0 --aq-mode 0 --no-cutree \
  --keyint 30 --min-keyint 30 --bframes 0 --ref 4 --weightp \
  --scenecut 0 --no-open-gop --repeat-headers \
  --recon recon.y4m --recon-depth 8 --log-level error
```

For POC 2, the active L0 order is POC 1 then POC 0. The table entries have luma weights/offsets `(31, -6)` and `(32, 0)`; the decoded motion map selects both entries. The test compares all 36,864 reconstructed Y/Cb/Cr samples and the public HEIF item output with `recon.y4m`.

| File                       | SHA-256                                                            |
| -------------------------- | ------------------------------------------------------------------ |
| `source.y4m`               | `8f0e49aef5ec5046dd6417f8b9f9ca9879f53af1dfa4a94307e8517968deffc2` |
| `weighted-p-multiref.hevc` | `8a8198de23dc4ab0b4c1887aa6912320528e703501a3ee115c7c9758013632c1` |
| `recon.y4m`                | `ea152845db378a77a71900ceaaf5eaa33792424cbcf743ca61b0e7b5a9d29a36` |
