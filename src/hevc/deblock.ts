/** In-loop deblocking filter (8.7.2), including SCC IBC boundary strengths. */
import type { DecodedPicture } from './picture.js';
import type { PpsInfo } from './pps.js';
import type { SliceHeader } from './slice-header.js';
import { chromaSubsampling } from './chroma.js';

/** Table 8-23 beta' by Q. */
const BETA_TABLE = new Int32Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
  20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 58, 60, 62, 64,
]);

/** Table 8-23 tC' by Q. */
const TC_TABLE = new Int32Array([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3,
  3, 3, 4, 4, 4, 5, 5, 6, 6, 7, 8, 9, 10, 11, 13, 14, 16, 18, 20, 22, 24,
]);

/** Table 8-10 chroma QP mapping (4:2:0). */
const TAB8_22 = [29, 30, 31, 32, 33, 33, 34, 34, 35, 35, 36, 36, 37, 37];
function table8_22(qPi: number): number {
  if (qPi < 30) return qPi;
  if (qPi >= 43) return qPi - 6;
  return TAB8_22[qPi - 30];
}

function clip3(lo: number, hi: number, v: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Apply the deblocking filter to a decoded picture, in place. */
export function deblockPicture(
  pic: DecodedPicture,
  pps: PpsInfo,
  bitDepthLuma = 8,
  bitDepthChroma = bitDepthLuma,
): void {
  const shift = bitDepthLuma - 8;
  const maxVal = (1 << bitDepthLuma) - 1;

  const { y, cb, cr, width, height, tuEdgesY, qpMap } = pic;
  const { log2CtbSize, widthInCtbs, sliceIdByCtb, sliceHeaders } = pic;
  const sliceAt = (x: number, sampleY: number): { id: number; header: SliceHeader } => {
    const addr = (sampleY >> log2CtbSize) * widthInCtbs + (x >> log2CtbSize);
    const id = sliceIdByCtb[addr];
    return { id, header: sliceHeaders[id] ?? pic.sh };
  };
  const filterHeaderAtEdge = (
    px: number,
    py: number,
    qx: number,
    qy: number,
  ): SliceHeader | null => {
    const p = sliceAt(px, py);
    const q = sliceAt(qx, qy);
    const pTile = pic.tileIdByCtb[(py >> log2CtbSize) * widthInCtbs + (px >> log2CtbSize)];
    const qTile = pic.tileIdByCtb[(qy >> log2CtbSize) * widthInCtbs + (qx >> log2CtbSize)];
    if (
      q.header.deblockingDisabled ||
      (pTile !== qTile && !pps.loopFilterAcrossTilesEnabled) ||
      (p.id !== q.id && !q.header.loopFilterAcrossSlices)
    )
      return null;
    return q.header;
  };
  const bypass = (px: number, py: number) =>
    !!pic.bypassMap?.[(py >> 2) * (width >> 2) + (px >> 2)];
  const palette = (px: number, py: number) =>
    !!pic.paletteMap[(py >> 2) * (width >> 2) + (px >> 2)];
  const skipFilter = (px: number, py: number) => bypass(px, py) || palette(px, py);
  const bwY = width >> 2;
  const qw = width >> 3;
  const clip = (v: number): number => (v < 0 ? 0 : v > maxVal ? maxVal : v);
  const qpAt = (px: number, py: number): number => qpMap[(py >> 3) * qw + (px >> 3)];
  const boundaryStrength = (vertical: boolean, ex: number, ey: number): number => {
    const px = vertical ? ex - 1 : ex;
    const py = vertical ? ey : ey - 1;
    const pIndex = (py >> 2) * bwY + (px >> 2);
    const qIndex = (ey >> 2) * bwY + (ex >> 2);
    if (!pic.interMap[pIndex] || !pic.interMap[qIndex]) return 2;

    const edgeBit = vertical ? 1 : 2;
    if (
      (pic.transformEdgesY[qIndex] & edgeBit) !== 0 &&
      (pic.cbfYMap[pIndex] !== 0 || pic.cbfYMap[qIndex] !== 0)
    )
      return 1;
    // H.265 8.7.2.4 compares the referenced pictures without regard to list
    // index. Bi-predicted blocks can therefore match either straight or
    // crossed list assignments, including when both lists name one picture.
    const pFlags = pic.motionPredFlags[pIndex] || 1;
    const qFlags = pic.motionPredFlags[qIndex] || 1;
    const pCount = Number((pFlags & 1) !== 0) + Number((pFlags & 2) !== 0);
    const qCount = Number((qFlags & 1) !== 0) + Number((qFlags & 2) !== 0);
    if (pCount !== qCount) return 1;
    const pRefs = [pic.motionRefPoc[pIndex], pic.motionRefPocL1[pIndex]];
    const qRefs = [pic.motionRefPoc[qIndex], pic.motionRefPocL1[qIndex]];
    const pRefLayers = [pic.motionRefLayerId[pIndex], pic.motionRefLayerIdL1[pIndex]];
    const qRefLayers = [pic.motionRefLayerId[qIndex], pic.motionRefLayerIdL1[qIndex]];
    const pX = [pic.motionXQpel[pIndex], pic.motionXQpelL1[pIndex]];
    const pY = [pic.motionYQpel[pIndex], pic.motionYQpelL1[pIndex]];
    const qX = [pic.motionXQpel[qIndex], pic.motionXQpelL1[qIndex]];
    const qY = [pic.motionYQpel[qIndex], pic.motionYQpelL1[qIndex]];
    const pLists = (pFlags & 1 ? [0] : []).concat(pFlags & 2 ? [1] : []);
    const qLists = (qFlags & 1 ? [0] : []).concat(qFlags & 2 ? [1] : []);
    // Multiview pictures can share a POC while remaining distinct references.
    const sameReference = (pList: number, qList: number): boolean =>
      pRefs[pList] === qRefs[qList] && pRefLayers[pList] === qRefLayers[qList];
    const pUsesSameReferenceTwice =
      pRefs[pLists[0]] === pRefs[pLists[1]] && pRefLayers[pLists[0]] === pRefLayers[pLists[1]];
    const qUsesSameReferenceTwice =
      qRefs[qLists[0]] === qRefs[qLists[1]] && qRefLayers[qLists[0]] === qRefLayers[qLists[1]];
    const matchesBelowThreshold = (pList: number, qList: number): boolean =>
      Math.abs(pX[pList] - qX[qList]) < 4 && Math.abs(pY[pList] - qY[qList]) < 4;

    if (pCount === 1) {
      const pList = pLists[0];
      const qList = qLists[0];
      return !sameReference(pList, qList) || !matchesBelowThreshold(pList, qList) ? 1 : 0;
    }

    const [pList0, pList1] = pLists;
    const [qList0, qList1] = qLists;
    if (pUsesSameReferenceTwice || qUsesSameReferenceTwice) {
      if (pUsesSameReferenceTwice && qUsesSameReferenceTwice && sameReference(pList0, qList0)) {
        const straightVectors =
          matchesBelowThreshold(pList0, qList0) && matchesBelowThreshold(pList1, qList1);
        const crossedVectors =
          matchesBelowThreshold(pList0, qList1) && matchesBelowThreshold(pList1, qList0);
        if (straightVectors || crossedVectors) return 0;
      }
      return 1;
    }
    const straightReferences = sameReference(pList0, qList0) && sameReference(pList1, qList1);
    const crossedReferences = sameReference(pList0, qList1) && sameReference(pList1, qList0);
    const straightVectors =
      matchesBelowThreshold(pList0, qList0) && matchesBelowThreshold(pList1, qList1);
    const crossedVectors =
      matchesBelowThreshold(pList0, qList1) && matchesBelowThreshold(pList1, qList0);
    return (straightReferences && straightVectors) || (crossedReferences && crossedVectors) ? 0 : 1;
  };

  // --- luma, both passes ---
  for (let pass = 0; pass < 2; pass++) {
    const vertical = pass === 0;
    // Vertical edges step x by 8 (skip picture left border), y by 4.
    // Horizontal edges step y by 8 (skip top border), x by 4.
    const xStart = vertical ? 8 : 0;
    const yStart = vertical ? 0 : 8;
    const xStep = vertical ? 8 : 4;
    const yStep = vertical ? 4 : 8;

    for (let ey = yStart; ey < height; ey += yStep) {
      for (let ex = xStart; ex < width; ex += xStep) {
        const edgeBlock = tuEdgesY[(ey >> 2) * bwY + (ex >> 2)];
        if (vertical ? !(edgeBlock & 1) : !(edgeBlock & 2)) continue;
        const bs = boundaryStrength(vertical, ex, ey);
        if (bs === 0) continue;

        const filterHeader = filterHeaderAtEdge(
          vertical ? ex - 1 : ex,
          vertical ? ey : ey - 1,
          ex,
          ey,
        );
        if (!filterHeader) continue;
        const betaOffset = filterHeader.betaOffsetDiv2 * 2;
        const tcOffset = filterHeader.tcOffsetDiv2 * 2;

        const qpQ = qpAt(ex, ey);
        const qpP = vertical ? qpAt(ex - 1, ey) : qpAt(ex, ey - 1);
        const qpL = (qpQ + qpP + 1) >> 1;
        const beta = BETA_TABLE[clip3(0, 51, qpL + betaOffset)] << shift;
        const tc = TC_TABLE[clip3(0, 53, qpL + 2 * (bs - 1) + tcOffset)] << shift;
        if (beta === 0) continue;

        // Sample accessors: p is the decreasing side, q the increasing side.
        const p = (k: number, i: number): number =>
          vertical ? y[(ey + k) * width + (ex - 1 - i)] : y[(ey - 1 - i) * width + (ex + k)];
        const q = (k: number, i: number): number =>
          vertical ? y[(ey + k) * width + (ex + i)] : y[(ey + i) * width + (ex + k)];

        const dp0 = Math.abs(p(0, 2) - 2 * p(0, 1) + p(0, 0));
        const dp3 = Math.abs(p(3, 2) - 2 * p(3, 1) + p(3, 0));
        const dq0 = Math.abs(q(0, 2) - 2 * q(0, 1) + q(0, 0));
        const dq3 = Math.abs(q(3, 2) - 2 * q(3, 1) + q(3, 0));
        const dpq0 = dp0 + dq0;
        const dpq3 = dp3 + dq3;
        const d = dpq0 + dpq3;
        if (d >= beta) continue;

        const dp = dp0 + dp3;
        const dq = dq0 + dq3;
        const dSam0 =
          2 * dpq0 < beta >> 2 &&
          Math.abs(p(0, 3) - p(0, 0)) + Math.abs(q(0, 0) - q(0, 3)) < beta >> 3 &&
          Math.abs(p(0, 0) - q(0, 0)) < (5 * tc + 1) >> 1;
        const dSam3 =
          2 * dpq3 < beta >> 2 &&
          Math.abs(p(3, 3) - p(3, 0)) + Math.abs(q(3, 0) - q(3, 3)) < beta >> 3 &&
          Math.abs(p(3, 0) - q(3, 0)) < (5 * tc + 1) >> 1;
        const dE = dSam0 && dSam3 ? 2 : 1;
        const dEp = dp < (beta + (beta >> 1)) >> 3 ? 1 : 0;
        const dEq = dq < (beta + (beta >> 1)) >> 3 ? 1 : 0;

        const setP = (k: number, i: number, v: number): void => {
          if (skipFilter(vertical ? ex - 1 - i : ex + k, vertical ? ey + k : ey - 1 - i)) return;
          if (vertical) y[(ey + k) * width + (ex - 1 - i)] = v;
          else y[(ey - 1 - i) * width + (ex + k)] = v;
        };
        const setQ = (k: number, i: number, v: number): void => {
          if (skipFilter(vertical ? ex + i : ex + k, vertical ? ey + k : ey + i)) return;
          if (vertical) y[(ey + k) * width + (ex + i)] = v;
          else y[(ey + i) * width + (ex + k)] = v;
        };

        for (let k = 0; k < 4; k++) {
          const p0 = p(k, 0);
          const p1 = p(k, 1);
          const p2 = p(k, 2);
          const p3 = p(k, 3);
          const q0 = q(k, 0);
          const q1 = q(k, 1);
          const q2 = q(k, 2);
          const q3 = q(k, 3);

          if (dE === 2) {
            setP(
              k,
              0,
              clip3(p0 - 2 * tc, p0 + 2 * tc, (p2 + 2 * p1 + 2 * p0 + 2 * q0 + q1 + 4) >> 3),
            );
            setP(k, 1, clip3(p1 - 2 * tc, p1 + 2 * tc, (p2 + p1 + p0 + q0 + 2) >> 2));
            setP(k, 2, clip3(p2 - 2 * tc, p2 + 2 * tc, (2 * p3 + 3 * p2 + p1 + p0 + q0 + 4) >> 3));
            setQ(
              k,
              0,
              clip3(q0 - 2 * tc, q0 + 2 * tc, (p1 + 2 * p0 + 2 * q0 + 2 * q1 + q2 + 4) >> 3),
            );
            setQ(k, 1, clip3(q1 - 2 * tc, q1 + 2 * tc, (p0 + q0 + q1 + q2 + 2) >> 2));
            setQ(k, 2, clip3(q2 - 2 * tc, q2 + 2 * tc, (p0 + q0 + q1 + 3 * q2 + 2 * q3 + 4) >> 3));
          } else {
            let delta = (9 * (q0 - p0) - 3 * (q1 - p1) + 8) >> 4;
            if (Math.abs(delta) < tc * 10) {
              delta = clip3(-tc, tc, delta);
              setP(k, 0, clip(p0 + delta));
              setQ(k, 0, clip(q0 - delta));
              if (dEp === 1) {
                const dp2 = clip3(-(tc >> 1), tc >> 1, (((p2 + p0 + 1) >> 1) - p1 + delta) >> 1);
                setP(k, 1, clip(p1 + dp2));
              }
              if (dEq === 1) {
                const dq2 = clip3(-(tc >> 1), tc >> 1, (((q2 + q0 + 1) >> 1) - q1 - delta) >> 1);
                setQ(k, 1, clip(q1 + dq2));
              }
            }
          }
        }
      }
    }
  }

  if (cb.length === 0) return;

  // --- chroma, both passes (only boundary strength 2 is filtered) ---
  const sub = chromaSubsampling(pic.chromaFormatIdc);
  const cw = Math.ceil(width / sub.width);
  const ch = Math.ceil(height / sub.height);
  const cShift = bitDepthChroma - 8;
  const cMax = (1 << bitDepthChroma) - 1;
  const clipC = (v: number): number => (v < 0 ? 0 : v > cMax ? cMax : v);

  for (let pass = 0; pass < 2; pass++) {
    const vertical = pass === 0;
    const plane = [cb, cr];

    // Chroma edges lie on the 8-chroma-sample grid (= 16 luma).
    const cxStart = vertical ? 8 : 0;
    const cyStart = vertical ? 0 : 8;
    const cxStep = vertical ? 8 : 4;
    const cyStep = vertical ? 4 : 8;

    for (let cy = cyStart; cy < ch; cy += cyStep) {
      for (let cx = cxStart; cx < cw; cx += cxStep) {
        const lx = cx * sub.width;
        const ly = cy * sub.height;
        const filterHeader = filterHeaderAtEdge(
          vertical ? lx - 1 : lx,
          vertical ? ly : ly - 1,
          lx,
          ly,
        );
        if (!filterHeader) continue;
        const tcOffset = filterHeader.tcOffsetDiv2 * 2;
        const edgeBlock = tuEdgesY[(ly >> 2) * bwY + (lx >> 2)];
        if (vertical ? !(edgeBlock & 1) : !(edgeBlock & 2)) continue;

        for (let c = 0; c < 2; c++) {
          const cPlane = plane[c];
          const chromaOffset = c === 0 ? filterHeader.cbQpOffset : filterHeader.crQpOffset;

          for (let k = 0; k < 4; k++) {
            const lumaX = vertical ? lx : lx + k * sub.width;
            const lumaY = vertical ? ly + k * sub.height : ly;
            if (boundaryStrength(vertical, lumaX, lumaY) !== 2) continue;

            const qpQ = qpAt(lumaX, lumaY);
            const qpP = vertical ? qpAt(lumaX - 1, lumaY) : qpAt(lumaX, lumaY - 1);
            const qpAvg = (qpQ + qpP + 1) >> 1;
            const qPi = clip3(-6 * (bitDepthChroma - 8), 57, qpAvg + chromaOffset);
            const qpC = pic.chromaFormatIdc === 1 ? table8_22(qPi) : Math.min(qPi, 51);
            const tc = TC_TABLE[clip3(0, 53, qpC + 2 + tcOffset)] << cShift;
            if (tc === 0) continue;

            // p1 p0 | q0 q1 straddling the edge; k walks along it.
            const iP0 = vertical ? (cy + k) * cw + (cx - 1) : (cy - 1) * cw + (cx + k);
            const iP1 = vertical ? (cy + k) * cw + (cx - 2) : (cy - 2) * cw + (cx + k);
            const iQ0 = vertical ? (cy + k) * cw + cx : cy * cw + (cx + k);
            const iQ1 = vertical ? (cy + k) * cw + (cx + 1) : (cy + 1) * cw + (cx + k);
            const p0 = cPlane[iP0];
            const p1 = cPlane[iP1];
            const q0 = cPlane[iQ0];
            const q1 = cPlane[iQ1];
            const delta = clip3(-tc, tc, ((q0 - p0) * 4 + p1 - q1 + 4) >> 3);
            if (!skipFilter((iP0 % cw) * sub.width, Math.floor(iP0 / cw) * sub.height))
              cPlane[iP0] = clipC(p0 + delta);
            if (!skipFilter((iQ0 % cw) * sub.width, Math.floor(iQ0 / cw) * sub.height))
              cPlane[iQ0] = clipC(q0 - delta);
          }
        }
      }
    }
  }
}
