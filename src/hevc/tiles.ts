import { HeicError } from '../errors.js';
import type { PpsInfo } from './pps.js';

export interface TileLayout {
  columns: number;
  rows: number;
  columnWidths: number[];
  rowHeights: number[];
  columnBoundaries: number[];
  rowBoundaries: number[];
  /** CTB raster-scan address to tile-scan address. */
  rasterToTileScan: Uint32Array;
  /** Tile-scan address to CTB raster-scan address. */
  tileScanToRaster: Uint32Array;
  /** Tile index for each CTB in raster order. */
  tileIdByCtb: Uint32Array;
}

function makeBoundaries(sizes: number[], total: number, axis: string): number[] {
  const boundaries = [0];
  let position = 0;
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size <= 0)
      throw new HeicError('INVALID_BITSTREAM', `heic: invalid HEVC tile ${axis} size`);
    position += size;
    boundaries.push(position);
  }
  if (position !== total)
    throw new HeicError(
      'INVALID_BITSTREAM',
      `heic: HEVC tile ${axis} sizes do not cover the picture`,
    );
  return boundaries;
}

/** Derive the H.265 6.5.1 CTB raster/tile scan maps for a PPS. */
export function deriveTileLayout(
  widthInCtbs: number,
  heightInCtbs: number,
  pps: PpsInfo,
): TileLayout {
  const columns = pps.tilesEnabled ? pps.numTileColumns : 1;
  const rows = pps.tilesEnabled ? pps.numTileRows : 1;
  const totalCtbs = widthInCtbs * heightInCtbs;
  if (
    !Number.isSafeInteger(widthInCtbs) ||
    !Number.isSafeInteger(heightInCtbs) ||
    widthInCtbs <= 0 ||
    heightInCtbs <= 0 ||
    !Number.isSafeInteger(totalCtbs) ||
    totalCtbs <= 0 ||
    !Number.isSafeInteger(columns) ||
    !Number.isSafeInteger(rows) ||
    columns <= 0 ||
    rows <= 0 ||
    columns > widthInCtbs ||
    rows > heightInCtbs ||
    columns * rows > totalCtbs
  )
    throw new HeicError('INVALID_BITSTREAM', 'heic: invalid HEVC tile grid dimensions');

  const columnWidths = pps.uniformSpacing
    ? Array.from(
        { length: columns },
        (_, i) =>
          Math.floor(((i + 1) * widthInCtbs) / columns) - Math.floor((i * widthInCtbs) / columns),
      )
    : [
        ...pps.tileColumnWidths,
        widthInCtbs - pps.tileColumnWidths.reduce((sum, width) => sum + width, 0),
      ];
  const rowHeights = pps.uniformSpacing
    ? Array.from(
        { length: rows },
        (_, i) =>
          Math.floor(((i + 1) * heightInCtbs) / rows) - Math.floor((i * heightInCtbs) / rows),
      )
    : [
        ...pps.tileRowHeights,
        heightInCtbs - pps.tileRowHeights.reduce((sum, height) => sum + height, 0),
      ];

  if (columnWidths.length !== columns || rowHeights.length !== rows)
    throw new HeicError('INVALID_BITSTREAM', 'heic: incomplete HEVC tile dimensions');
  const columnBoundaries = makeBoundaries(columnWidths, widthInCtbs, 'column');
  const rowBoundaries = makeBoundaries(rowHeights, heightInCtbs, 'row');
  const rasterToTileScan = new Uint32Array(totalCtbs);
  const tileScanToRaster = new Uint32Array(totalCtbs);
  const tileIdByCtb = new Uint32Array(totalCtbs);

  let tileScanAddr = 0;
  let tileId = 0;
  for (let tileY = 0; tileY < rows; tileY++) {
    for (let tileX = 0; tileX < columns; tileX++, tileId++) {
      for (let y = rowBoundaries[tileY]; y < rowBoundaries[tileY + 1]; y++) {
        for (let x = columnBoundaries[tileX]; x < columnBoundaries[tileX + 1]; x++) {
          const rasterAddr = y * widthInCtbs + x;
          rasterToTileScan[rasterAddr] = tileScanAddr;
          tileScanToRaster[tileScanAddr++] = rasterAddr;
          tileIdByCtb[rasterAddr] = tileId;
        }
      }
    }
  }

  if (tileScanAddr !== totalCtbs)
    throw new HeicError('INVALID_BITSTREAM', 'heic: HEVC tile scan does not cover the picture');
  return {
    columns,
    rows,
    columnWidths,
    rowHeights,
    columnBoundaries,
    rowBoundaries,
    rasterToTileScan,
    tileScanToRaster,
    tileIdByCtb,
  };
}
