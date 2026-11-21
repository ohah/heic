# Hibernia WebAssembly decoder

This directory contains the WebAssembly package generated from
[Djuffin/hibernia](https://github.com/Djuffin/hibernia) at commit
`0687cce7095998862d53b526ad2c41da43b90add`.

Hibernia is MIT licensed; see `LICENSE`. The generated Rust binding adds
copying accessors for decoded Y, U, and V planes so callers do not retain
pointers into WebAssembly memory. The decoder currently supports progressive,
8-bit 4:2:0 AVC only. See the upstream README for its unsupported H.264 tools.
