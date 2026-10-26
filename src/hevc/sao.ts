/**
 * Sample Adaptive Offset (8.7.3), the second in-loop filter. Runs per CTU on
 * the deblocked picture, reading a pre-SAO snapshot so neighbour lookups for
 * edge-offset classification never see already-offset samples.
 *
 * The per-CTU parameters (type, offsets, band position, edge class) were
 * parsed during slice decoding; here they are only applied.
 */
import type { DecodedPicture, SaoParams } from './picture.js';
import type { SpsInfo } from './sps.js';

function sign(v: number): number {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

/** Edge-offset neighbour offsets by SaoEoClass (0 horiz, 1 vert, 2/3 diag). */
const EO_CLASS = [
  { h: [-1, 1], v: [0, 0] },
  { h: [0, 0], v: [-1, 1] },
  { h: [-1, 1], v: [-1, 1] },
  { h: [1, -1], v: [-1, 1] },
];

function applyPlane(
  src: Uint8Array | Uint16Array,
  dst: Uint8Array | Uint16Array,
  width: number,
  height: number,
  ctbW: number,
  ctbH: number,
  widthInCtbs: number,
  heightInCtbs: number,
  sao: SaoParams[],
  cIdx: number,
  bitDepth: number,
  skip: (x: number, y: number) => boolean,
): void {
  const maxVal = (1 << bitDepth) - 1;
  const clip = (v: number): number => (v < 0 ? 0 : v > maxVal ? maxVal : v);
  const bandShift = bitDepth - 5;

  for (let cbY = 0; cbY < heightInCtbs; cbY++) {
    for (let cbX = 0; cbX < widthInCtbs; cbX++) {
      const params = sao[cbY * widthInCtbs + cbX];
      const type = params.typeIdx[cIdx];
      if (type === 0) continue;

      const xC = cbX * ctbW;
      const yC = cbY * ctbH;
      const w = Math.min(ctbW, width - xC);
      const h = Math.min(ctbH, height - yC);
      const off = params.offsets.subarray(cIdx * 4, cIdx * 4 + 4);

      if (type === 2) {
        const cls = EO_CLASS[params.eoClass[cIdx]];
        // Reordered offset table indexed by (edgeIdx + 2).
        const table = [off[0], off[1], 0, off[2], off[3]];
        for (let j = 0; j < h; j++) {
          for (let i = 0; i < w; i++) {
            const x = xC + i;
            const y = yC + j;
            if (skip(x, y)) continue;
            const x0 = x + cls.h[0];
            const y0 = y + cls.v[0];
            const x1 = x + cls.h[1];
            const y1 = y + cls.v[1];
            if (
              x0 < 0 ||
              y0 < 0 ||
              x0 >= width ||
              y0 >= height ||
              x1 < 0 ||
              y1 < 0 ||
              x1 >= width ||
              y1 >= height
            )
              continue;
            const cur = src[y * width + x];
            const edgeIdx = sign(cur - src[y0 * width + x0]) + sign(cur - src[y1 * width + x1]);
            dst[y * width + x] = clip(cur + table[edgeIdx + 2]);
          }
        }
      } else {
        const leftClass = params.bandPos[cIdx];
        const bandTable = new Int32Array(32);
        for (let k = 0; k < 4; k++) bandTable[(k + leftClass) & 31] = k + 1;
        for (let j = 0; j < h; j++) {
          for (let i = 0; i < w; i++) {
            if (skip(xC + i, yC + j)) continue;
            const idx = (yC + j) * width + (xC + i);
            const bandIdx = bandTable[src[idx] >> bandShift];
            if (bandIdx > 0) dst[idx] = clip(src[idx] + off[bandIdx - 1]);
          }
        }
      }
    }
  }
}

/** Apply SAO to a decoded picture, in place. */
export function applySao(pic: DecodedPicture, sps: SpsInfo, bitDepth = 8): void {
  if (!sps.sampleAdaptiveOffsetEnabled) return;
  if (!pic.sh.saoLuma && !pic.sh.saoChroma) return;

  const ctbSize = 1 << sps.log2CtbSize;
  const widthInCtbs = Math.ceil(pic.width / ctbSize);
  const heightInCtbs = Math.ceil(pic.height / ctbSize);
  const sub = sps.chromaFormatIdc === 3 ? 1 : 2;
  const cw = pic.width / sub;
  const ch = pic.height / sub;

  const bypass = (x: number, y: number) =>
    !!pic.bypassMap?.[(y >> 2) * (pic.width >> 2) + (x >> 2)];
  const bypassC = (x: number, y: number) => bypass(x * sub, y * sub);
  // Snapshot the deblocked planes; SAO reads these, writes into the originals.
  if (pic.sh.saoLuma) {
    const srcY = pic.y.slice();
    applyPlane(
      srcY,
      pic.y,
      pic.width,
      pic.height,
      ctbSize,
      ctbSize,
      widthInCtbs,
      heightInCtbs,
      pic.sao,
      0,
      bitDepth,
      bypass,
    );
  }
  if (pic.sh.saoChroma) {
    const srcCb = pic.cb.slice();
    const srcCr = pic.cr.slice();
    const cSize = ctbSize / sub;
    applyPlane(
      srcCb,
      pic.cb,
      cw,
      ch,
      cSize,
      cSize,
      widthInCtbs,
      heightInCtbs,
      pic.sao,
      1,
      bitDepth,
      bypassC,
    );
    applyPlane(
      srcCr,
      pic.cr,
      cw,
      ch,
      cSize,
      cSize,
      widthInCtbs,
      heightInCtbs,
      pic.sao,
      2,
      bitDepth,
      bypassC,
    );
  }
}
