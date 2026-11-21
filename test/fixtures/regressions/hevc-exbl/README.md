# L-HEVC external base-layer fixture

`base-layer-frame-0.hevc` is a lossless x265 encoding of the first 1280×720
4:2:0 frame in the official ITU-T H.265.1 `HYBRID_A_QUALCOMM_1`
`BaseLayerSequence.yuv`. It is a derived regression fixture, not an official
conformance bitstream.

The validator decodes this frame and compares its Y/Cb/Cr planes byte-for-byte
with the official YUV samples before using it as the external `exbl` base item.

- Fixture SHA-256: `3da5626daa68b3d5b2a2882a8e729284ab75988f3474aa9a35df99f2ab8dfe2b`
- Source vector: [official ITU-T H.265.1 archive](https://www.itu.int/wftp3/av-arch/jctvc-site/bitstream_exchange/draft_conformance/SHVC/HYBRID_A_QUALCOMM_1.zip)
