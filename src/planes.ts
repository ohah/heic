import { HeicError } from './errors.js';
import type { GridInfo, HeicInfo } from './container/heic.js';
import { getItemPayload, getHeicInfo } from './container/heic.js';
import type { ISOBMFFBox } from './container/heif.js';
import { parseSps } from './hevc/sps.js';
import { parsePps } from './hevc/pps.js';
import { PictureDecoder } from './hevc/picture.js';
import { splitLengthPrefixed, isSliceNal } from './hevc/nal.js';
import { deblockPicture } from './hevc/deblock.js';
import { applySao } from './hevc/sao.js';
export interface Planes {
  chromaFormatIdc: number;
  y: Uint8Array | Uint16Array;
  cb: Uint8Array | Uint16Array;
  cr: Uint8Array | Uint16Array;
  width: number;
  height: number;
}

export function decodeItemPlanes(
  buffer: Uint8Array,
  boxes: ISOBMFFBox[],
  info: HeicInfo,
  itemId: number,
): Planes {
  const payload = getItemPayload(buffer, boxes, itemId);
  if (!payload) throw new Error(`heic: item ${itemId} has no payload`);
  const nals = splitLengthPrefixed(payload, info.hvcC!.nalLengthSize);
  const slices = nals.filter((n) => isSliceNal(n.type)).map((n) => n.data);
  if (slices.length === 0)
    throw new HeicError('INVALID_BITSTREAM', `heic: item ${itemId} carries no coded slices`);

  const config = getHeicInfo(buffer, boxes, itemId).hvcC ?? info.hvcC!;
  const sps = parseSps(config.sps[0]);
  const pps = parsePps(config.pps[0]);
  const pic = new PictureDecoder(sps, pps).decode(slices);
  // In-loop filters run on the fully reconstructed tile: deblock first, then
  // SAO reads the deblocked samples (8.7).
  deblockPicture(pic, pps, sps.bitDepthLuma);
  applySao(pic, sps, sps.bitDepthLuma);
  return {
    y: pic.y,
    cb: pic.cb,
    cr: pic.cr,
    width: pic.width,
    height: pic.height,
    chromaFormatIdc: sps.chromaFormatIdc,
  };
}

export function stitchGrid(
  buffer: Uint8Array,
  boxes: ISOBMFFBox[],
  info: HeicInfo,
  grid: GridInfo,
): Planes {
  const Samples = parseSps(info.hvcC!.sps[0]).bitDepthLuma === 8 ? Uint8Array : Uint16Array;
  if (grid.tileItemIds.length !== grid.rows * grid.columns || grid.tileItemIds.length > 4096)
    throw new Error('heic: invalid or oversized grid');
  const tileW = grid.tileWidth;
  const tileH = grid.tileHeight;
  const canvasW = grid.columns * tileW;
  const canvasH = grid.rows * tileH;
  if (!Number.isSafeInteger(canvasW * canvasH) || canvasW * canvasH > 50_000_000)
    throw new RangeError('heic: padded grid exceeds pixel limit');
  const y = new Samples(canvasW * canvasH);
  const chromaFormatIdc = parseSps(info.hvcC!.sps[0]).chromaFormatIdc,
    sub = chromaFormatIdc === 3 ? 1 : 2;
  const chroma = chromaFormatIdc !== 0;
  const cb = new Samples(chroma ? (canvasW / sub) * (canvasH / sub) : 0);
  const cr = new Samples(cb.length);

  for (let t = 0; t < grid.tileItemIds.length; t++) {
    const itemId = grid.tileItemIds[t],
      tileInfo = getHeicInfo(buffer, boxes, itemId),
      tileSps = parseSps(tileInfo.hvcC!.sps[0]);
    const raw = decodeItemPlanes(buffer, boxes, info, itemId),
      tileSub = tileSps.chromaFormatIdc === 1 ? 2 : 1;
    const tile = cropPlanes(
      raw,
      tileSub * tileSps.cropLeft,
      tileSub * tileSps.cropTop,
      tileSps.width,
      tileSps.height,
    );
    if (tile.width !== tileW || tile.height !== tileH)
      throw new Error(
        `heic: tile ${t} is ${tile.width}x${tile.height}, expected ${tileW}x${tileH}`,
      );
    const tx = (t % grid.columns) * tileW;
    const ty = Math.floor(t / grid.columns) * tileH;
    for (let row = 0; row < tileH; row++)
      y.set(tile.y.subarray(row * tileW, (row + 1) * tileW), (ty + row) * canvasW + tx);
    const cTileW = tileW / sub;
    const cCanvasW = canvasW / sub;
    for (let row = 0; cb.length && row < tileH / sub; row++) {
      const src = row * cTileW;
      const dst = (ty / sub + row) * cCanvasW + tx / sub;
      cb.set(tile.cb.subarray(src, src + cTileW), dst);
      cr.set(tile.cr.subarray(src, src + cTileW), dst);
    }
  }
  return { y, cb, cr, width: canvasW, height: canvasH, chromaFormatIdc };
}

export function cropPlanes(
  planes: Planes,
  x0: number,
  y0: number,
  width: number,
  height: number,
): Planes {
  if (
    ![x0, y0, width, height].every(Number.isSafeInteger) ||
    x0 < 0 ||
    y0 < 0 ||
    width <= 0 ||
    height <= 0 ||
    x0 + width > planes.width ||
    y0 + height > planes.height
  )
    throw new RangeError('heic: invalid crop bounds');
  if (x0 === 0 && y0 === 0 && width === planes.width && height === planes.height) return planes;
  const Samples = planes.y instanceof Uint16Array ? Uint16Array : Uint8Array;
  const y = new Samples(width * height);
  const sub = planes.chromaFormatIdc === 3 ? 1 : 2;
  const cw = Math.ceil(width / sub);
  const ch = Math.ceil(height / sub);
  const cb = new Samples(planes.cb.length ? cw * ch : 0);
  const cr = new Samples(cb.length);
  for (let row = 0; row < height; row++) {
    const src = (y0 + row) * planes.width + x0;
    y.set(planes.y.subarray(src, src + width), row * width);
  }
  const srcCw = Math.ceil(planes.width / sub);
  for (let row = 0; cb.length && row < ch; row++) {
    const src = (Math.floor(y0 / sub) + row) * srcCw + Math.floor(x0 / sub);
    cb.set(planes.cb.subarray(src, src + cw), row * cw);
    cr.set(planes.cr.subarray(src, src + cw), row * cw);
  }
  return { y, cb, cr, width, height, chromaFormatIdc: planes.chromaFormatIdc };
}
