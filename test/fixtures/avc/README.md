`mini-16x16.264` is a one-frame 16×16 8-bit 4:2:0 stream generated locally
with FFmpeg/libx264. `mini-16x16.yuv` is its planar I420 output from FFmpeg.
`mini-16x16.heic` is a synthetic HEIF `avc1` item containing the same picture,
wrapped by `scripts/validate-avc-heic.ts`.
