/**
 * Public HEIC decoding API: container walk, HEVC intra decode of every tile,
 * grid stitching, conformance-window crop, YCbCr to RGBA conversion, and the
 * irot/imir display transforms.
 */
import type { GridInfo, HeicInfo } from './container/heic.js'
import type { SpsInfo } from './hevc/sps.js'
import { applyOrientation, yuv420ToRgba } from './color.js'
import { getHeicInfo, getItemPayload } from './container/heic.js'
import { getFtypInfo, parseISOBMFF } from './container/heif.js'
import { deblockPicture } from './hevc/deblock.js'
import { isSliceNal, splitLengthPrefixed } from './hevc/nal.js'
import { PictureDecoder } from './hevc/picture.js'
import { parsePps } from './hevc/pps.js'
import { applySao } from './hevc/sao.js'
import { parseSps } from './hevc/sps.js'

export interface HeicMetadata extends HeicInfo {
  /** Parsed from the primary item's SPS; cross-checks the container. */
  sps: SpsInfo | null
  /** Coded slice NAL count of the primary (or first tile) item. */
  sliceNalCount: number
}

/** Whether a buffer looks like a HEIC/HEIF file. */
export function isHeic(buffer: Uint8Array): boolean {
  const ftyp = getFtypInfo(buffer)
  if (!ftyp)
    return false

  const brands = [ftyp.majorBrand, ...ftyp.compatibleBrands]
  return brands.some(brand => ['heic', 'heix', 'hevc', 'hevx'].includes(brand))
}

/**
 * Parse everything knowable without entropy-decoding pixels: dimensions,
 * grid layout, rotation/mirror, bit depth, and the HEVC parameter sets.
 */
export function getHeicMetadata(buffer: Uint8Array): HeicMetadata {
  if (!isHeic(buffer))
    throw new Error('heic: not a HEIC file (ftyp brand mismatch)')

  const boxes = parseISOBMFF(buffer)
  const info = getHeicInfo(buffer, boxes)

  let sps: SpsInfo | null = null
  let sliceNalCount = 0

  if (info.hvcC) {
    if (info.hvcC.sps.length > 0)
      sps = parseSps(info.hvcC.sps[0])

    const codedItemId = info.grid ? info.grid.tileItemIds[0] : info.primaryItemId
    const payload = getItemPayload(buffer, boxes, codedItemId)
    if (payload) {
      const nals = splitLengthPrefixed(payload, info.hvcC.nalLengthSize)
      sliceNalCount = nals.filter(n => isSliceNal(n.type)).length
    }
  }

  return { ...info, sps, sliceNalCount }
}

export interface HeicImageData {
  data: Uint8Array
  width: number
  height: number
  hasAlpha: boolean
  bitDepth: 8 | 10 | 12
}

export interface DecodeOptions {
  /** Maximum output or padded-grid pixel count. Default/hard ceiling: 50 million. */
  maxPixels?: number

  /**
   * Apply the irot/imir display transforms (default true). When false the
   * pixels stay in coded orientation.
   */
  applyTransforms?: boolean
}

interface Planes {
  y: Uint8Array | Uint16Array
  cb: Uint8Array | Uint16Array
  cr: Uint8Array | Uint16Array
  width: number
  height: number
}

function decodeItemPlanes(
  buffer: Uint8Array,
  boxes: ReturnType<typeof parseISOBMFF>,
  info: HeicInfo,
  itemId: number,
): Planes {
  const payload = getItemPayload(buffer, boxes, itemId)
  if (!payload)
    throw new Error(`heic: item ${itemId} has no payload`)
  const nals = splitLengthPrefixed(payload, info.hvcC!.nalLengthSize)
  const slices = nals.filter(n => isSliceNal(n.type)).map(n => n.data)
  if (slices.length === 0)
    throw new Error(`heic: item ${itemId} carries no coded slices`)

  const sps = parseSps(info.hvcC!.sps[0])
  const pps = parsePps(info.hvcC!.pps[0])
  const pic = new PictureDecoder(sps, pps).decode(slices)
  // In-loop filters run on the fully reconstructed tile: deblock first, then
  // SAO reads the deblocked samples (8.7).
  deblockPicture(pic, pps, sps.bitDepthLuma)
  applySao(pic, sps, sps.bitDepthLuma)
  return { y: pic.y, cb: pic.cb, cr: pic.cr, width: pic.width, height: pic.height }
}

function stitchGrid(
  buffer: Uint8Array,
  boxes: ReturnType<typeof parseISOBMFF>,
  info: HeicInfo,
  grid: GridInfo,
): Planes {
  const Samples = parseSps(info.hvcC!.sps[0]).bitDepthLuma === 8 ? Uint8Array : Uint16Array
  if (grid.tileItemIds.length !== grid.rows * grid.columns || grid.tileItemIds.length > 4096)
    throw new Error("heic: invalid or oversized grid")
  const tileW = grid.tileWidth
  const tileH = grid.tileHeight
  const canvasW = grid.columns * tileW
  const canvasH = grid.rows * tileH
  if (!Number.isSafeInteger(canvasW * canvasH) || canvasW * canvasH > 50_000_000)
    throw new RangeError("heic: padded grid exceeds pixel limit")
  const y = new Samples(canvasW * canvasH)
  const cb = new Samples((canvasW >> 1) * (canvasH >> 1))
  const cr = new Samples((canvasW >> 1) * (canvasH >> 1))

  for (let t = 0; t < grid.tileItemIds.length; t++) {
    const tile = decodeItemPlanes(buffer, boxes, info, grid.tileItemIds[t])
    if (tile.width !== tileW || tile.height !== tileH)
      throw new Error(`heic: tile ${t} is ${tile.width}x${tile.height}, expected ${tileW}x${tileH}`)
    const tx = (t % grid.columns) * tileW
    const ty = Math.floor(t / grid.columns) * tileH
    for (let row = 0; row < tileH; row++)
      y.set(tile.y.subarray(row * tileW, (row + 1) * tileW), (ty + row) * canvasW + tx)
    const cTileW = tileW >> 1
    const cCanvasW = canvasW >> 1
    for (let row = 0; row < tileH >> 1; row++) {
      const src = row * cTileW
      const dst = ((ty >> 1) + row) * cCanvasW + (tx >> 1)
      cb.set(tile.cb.subarray(src, src + cTileW), dst)
      cr.set(tile.cr.subarray(src, src + cTileW), dst)
    }
  }
  return { y, cb, cr, width: canvasW, height: canvasH }
}

function cropPlanes(planes: Planes, x0: number, y0: number, width: number, height: number): Planes {
  if (![x0,y0,width,height].every(Number.isSafeInteger) || x0 < 0 || y0 < 0 || width <= 0 || height <= 0 || x0 + width > planes.width || y0 + height > planes.height)
    throw new RangeError("heic: invalid crop bounds")
  if (x0 === 0 && y0 === 0 && width === planes.width && height === planes.height)
    return planes
  const Samples = planes.y instanceof Uint16Array ? Uint16Array : Uint8Array
  const y = new Samples(width * height)
  const cw = Math.ceil(width / 2)
  const ch = Math.ceil(height / 2)
  const cb = new Samples(cw * ch)
  const cr = new Samples(cw * ch)
  for (let row = 0; row < height; row++) {
    const src = (y0 + row) * planes.width + x0
    y.set(planes.y.subarray(src, src + width), row * width)
  }
  const srcCw = Math.ceil(planes.width / 2)
  for (let row = 0; row < ch; row++) {
    const src = ((y0 >> 1) + row) * srcCw + (x0 >> 1)
    cb.set(planes.cb.subarray(src, src + cw), row * cw)
    cr.set(planes.cr.subarray(src, src + cw), row * cw)
  }
  return { y, cb, cr, width, height }
}

/** Decode a HEIC file to RGBA pixels. */
export function decodeHeic(buffer: Uint8Array, options: DecodeOptions = {}): HeicImageData {
  if (!(buffer instanceof Uint8Array) || buffer.byteLength > 64 * 1024 * 1024 || !isHeic(buffer))
    throw new Error("heic: expected a HEIC file up to 64 MiB")
  const maxPixels = options.maxPixels ?? 50_000_000
  if (!Number.isSafeInteger(maxPixels) || maxPixels <= 0 || maxPixels > 50_000_000) throw new RangeError("heic: invalid maxPixels")
  const boxes = parseISOBMFF(buffer)
  const info = getHeicInfo(buffer, boxes)
  if (!info.hvcC)
    throw new Error('heic: primary item has no HEVC configuration (hvcC)')

  const sps = parseSps(info.hvcC.sps[0])

  const pixels = info.grid ? info.grid.rows * info.grid.tileHeight * info.grid.columns * info.grid.tileWidth : sps.picWidthInLumaSamples * sps.picHeightInLumaSamples
  if (!Number.isSafeInteger(pixels) || pixels <= 0 || pixels > maxPixels) throw new RangeError("heic: image exceeds maxPixels")
  let planes: Planes
  if (info.grid) {
    planes = stitchGrid(buffer, boxes, info, info.grid)
    planes = cropPlanes(planes, 0, 0, info.grid.outputWidth, info.grid.outputHeight)
  }
  else {
    planes = decodeItemPlanes(buffer, boxes, info, info.primaryItemId)
    // Conformance window (crop offsets are in chroma units for 4:2:0).
    const subW = sps.chromaFormatIdc === 1 || sps.chromaFormatIdc === 2 ? 2 : 1
    const subH = sps.chromaFormatIdc === 1 ? 2 : 1
    planes = cropPlanes(planes, subW * sps.cropLeft, subH * sps.cropTop, sps.width, sps.height)
  }

  const rgba = yuv420ToRgba(planes.y, planes.cb, planes.cr, planes.width, planes.height, {
    bitDepth: sps.bitDepthLuma as 8 | 10 | 12,
    matrixCoeffs: sps.color?.matrixCoeffs ?? 6,
    fullRange: sps.color?.videoFullRange ?? true,
  })

  let data = rgba
  let width = planes.width
  let height = planes.height
  if (options.applyTransforms !== false && (info.rotation !== 0 || info.mirror !== null)) {
    const oriented = applyOrientation(rgba, width, height, info.rotation, info.mirror)
    data = oriented.data
    width = oriented.width
    height = oriented.height
  }

  return { data, width, height, hasAlpha: false, bitDepth: sps.bitDepthLuma as 8 | 10 | 12 }
}
