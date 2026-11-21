import { HeicError } from '../errors.js';

/**
 * CABAC entropy decoding (9.3): the binary arithmetic decoder engine,
 * context-model storage with the I-slice (initType 0) initialization values
 * from Tables 9-5..9-32, and WPP context snapshot/restore.
 */

/** Table 9-46: rangeTabLps[pStateIdx][qRangeIdx]. */
const RANGE_TAB_LPS = new Uint8Array([
  128, 176, 208, 240, 128, 167, 197, 227, 128, 158, 187, 216, 123, 150, 178, 205, 116, 142, 169,
  195, 111, 135, 160, 185, 105, 128, 152, 175, 100, 122, 144, 166, 95, 116, 137, 158, 90, 110, 130,
  150, 85, 104, 123, 142, 81, 99, 117, 135, 77, 94, 111, 128, 73, 89, 105, 122, 69, 85, 100, 116,
  66, 80, 95, 110, 62, 76, 90, 104, 59, 72, 86, 99, 56, 69, 81, 94, 53, 65, 77, 89, 51, 62, 73, 85,
  48, 59, 69, 80, 46, 56, 66, 76, 43, 53, 63, 72, 41, 50, 59, 69, 39, 48, 56, 65, 37, 45, 54, 62,
  35, 43, 51, 59, 33, 41, 48, 56, 32, 39, 46, 53, 30, 37, 43, 50, 29, 35, 41, 48, 27, 33, 39, 45,
  26, 31, 37, 43, 24, 30, 35, 41, 23, 28, 33, 39, 22, 27, 32, 37, 21, 26, 30, 35, 20, 24, 29, 33,
  19, 23, 27, 31, 18, 22, 26, 30, 17, 21, 25, 28, 16, 20, 23, 27, 15, 19, 22, 25, 14, 18, 21, 24,
  14, 17, 20, 23, 13, 16, 19, 22, 12, 15, 18, 21, 12, 14, 17, 20, 11, 14, 16, 19, 11, 13, 15, 18,
  10, 12, 15, 17, 10, 12, 14, 16, 9, 11, 13, 15, 9, 11, 12, 14, 8, 10, 12, 14, 8, 9, 11, 13, 7, 9,
  11, 12, 7, 9, 10, 12, 7, 8, 10, 11, 6, 8, 9, 11, 6, 7, 9, 10, 6, 7, 8, 9, 2, 2, 2, 2,
]);

/** Table 9-47: state transition on an LPS decode. */
const TRANS_IDX_LPS = new Uint8Array([
  0, 0, 1, 2, 2, 4, 4, 5, 6, 7, 8, 9, 9, 11, 11, 12, 13, 13, 15, 15, 16, 16, 18, 18, 19, 19, 21, 21,
  22, 22, 23, 24, 24, 25, 26, 26, 27, 27, 28, 29, 29, 30, 30, 30, 31, 32, 32, 33, 33, 33, 34, 34,
  35, 35, 35, 36, 36, 36, 37, 37, 37, 38, 38, 63,
]);

// Context table layout: one flat array, sections per syntax element.
let n = 0;
function section(count: number): number {
  const at = n;
  n += count;
  return at;
}

export const CTX = {
  SAO_MERGE: section(1),
  SAO_TYPE_IDX: section(1),
  SPLIT_CU: section(3),
  TQ_BYPASS: section(1),
  PART_MODE: section(4),
  PREV_INTRA_LUMA_PRED: section(1),
  INTRA_CHROMA_PRED_MODE: section(1),
  SPLIT_TRANSFORM: section(3),
  CBF_LUMA: section(2),
  CBF_CHROMA: section(5),
  TRANSFORM_SKIP: section(2),
  EXPLICIT_RDPCM_FLAG: section(2),
  EXPLICIT_RDPCM_DIR: section(2),
  CU_QP_DELTA: section(2),
  CU_CHROMA_QP_OFFSET_FLAG: section(1),
  CU_CHROMA_QP_OFFSET_IDX: section(1),
  COLOUR_TRANSFORM_FLAG: section(1),
  MERGE_FLAG: section(1),
  MERGE_INDEX: section(1),
  INTER_PRED_IDC: section(5),
  REF_IDX: section(2),
  REF_IDX_L1: section(2),
  MVD: section(2),
  MVP_INDEX: section(1),
  ROOT_CBF: section(1),
  LAST_SIG_X: section(18),
  LAST_SIG_Y: section(18),
  CODED_SUB_BLOCK: section(4),
  SIG_COEFF: section(44),
  GREATER1: section(24),
  GREATER2: section(6),
  LOG2_RES_SCALE_ABS: section(8),
  RES_SCALE_SIGN: section(2),
  CU_SKIP: section(3),
  PRED_MODE: section(1),
  PALETTE_MODE: section(1),
  PALETTE_RUN_PREFIX: section(8),
  COPY_ABOVE_PALETTE: section(1),
  PALETTE_TRANSPOSE: section(1),
} as const;

export const NUM_CTX = n;

/**
 * initValue per context for I slices (initType 0), concatenated in the CTX
 * layout order above. Sources: H.265 Tables 9-5..9-42 / HM INIT_* row 0.
 */
const INIT_VALUES_I = new Uint8Array([
  // SAO_MERGE, SAO_TYPE_IDX
  153, 200,
  // SPLIT_CU
  139, 141, 157,
  // TQ_BYPASS, PART_MODE, PREV_INTRA_LUMA_PRED, INTRA_CHROMA_PRED_MODE
  154, 184, 154, 154, 154, 184, 63,
  // SPLIT_TRANSFORM
  153, 138, 138,
  // CBF_LUMA
  111, 141,
  // CBF_CHROMA (5th entry is the RExt filler)
  94, 138, 182, 154, 154,
  // TRANSFORM_SKIP (luma, chroma)
  139, 139,
  // EXPLICIT_RDPCM_FLAG, EXPLICIT_RDPCM_DIR (luma, chroma)
  139, 139, 139, 139,
  // CU_QP_DELTA
  154, 154,
  // CU_CHROMA_QP_OFFSET_FLAG, CU_CHROMA_QP_OFFSET_IDX, COLOUR_TRANSFORM_FLAG
  154, 154, 154,
  // MERGE_FLAG, MERGE_INDEX, INTER_PRED_IDC, REF_IDX_L0/L1, MVD, MVP_INDEX, ROOT_CBF (CNU for I slices)
  154,
  154, 154, 154, 154, 154, 154, 154, 154, 154, 154, 154, 154, 154, 154,
  // LAST_SIG_X (15 luma + 3 chroma)
  110, 110, 124, 125, 140, 153, 125, 127, 140, 109, 111, 143, 127, 111, 79, 108, 123, 63,
  // LAST_SIG_Y
  110, 110, 124, 125, 140, 153, 125, 127, 140, 109, 111, 143, 127, 111, 79, 108, 123, 63,
  // CODED_SUB_BLOCK (2 luma + 2 chroma)
  91, 171, 134, 141,
  // SIG_COEFF (27 luma + 15 chroma + 2 transform-skip contexts)
  111, 111, 125, 110, 110, 94, 124, 108, 124, 107, 125, 141, 179, 153, 125, 107, 125, 141, 179, 153,
  125, 107, 125, 141, 179, 153, 125, 140, 139, 182, 182, 152, 136, 152, 136, 153, 136, 139, 111,
  136, 139, 111, 141, 111,
  // GREATER1 (16 luma + 8 chroma)
  140, 92, 137, 138, 140, 152, 138, 139, 153, 74, 149, 92, 139, 107, 122, 152, 140, 179, 166, 182,
  140, 227, 122, 197,
  // GREATER2 (4 luma + 2 chroma)
  138, 153, 136, 167, 152, 152,
  // LOG2_RES_SCALE_ABS, RES_SCALE_SIGN
  154, 154, 154, 154, 154, 154, 154, 154, 154, 154,
  // P-slice and SCC contexts are unused for I slices; CNU initializes to 154.
  // CU_SKIP, PRED_MODE, PALETTE_MODE
  154, 154, 154, 154, 154,
  // PALETTE_RUN_PREFIX, shared COPY_ABOVE/final-run, PALETTE_TRANSPOSE
  154, 154, 154, 154, 154, 154, 154, 154, 154, 154,
]);

function makeInitValues(initType: 1 | 2): Uint8Array {
  const values = INIT_VALUES_I.slice();
  const set = (offset: number, entries: number[]): void => values.set(entries, offset);

  // H.265 Tables 9-5..9-37, initType 1 (P) and 2 (B).
  set(CTX.SAO_TYPE_IDX, initType === 1 ? [185] : [160]);
  set(CTX.SPLIT_CU, [107, 139, 126]);
  set(CTX.CU_SKIP, [197, 185, 201]);
  set(CTX.PRED_MODE, [initType === 1 ? 149 : 134]);
  set(CTX.PART_MODE, [154, 139, 154, 154]);
  set(CTX.MERGE_FLAG, [initType === 1 ? 110 : 154]);
  set(CTX.MERGE_INDEX, [initType === 1 ? 122 : 137]);
  set(CTX.INTER_PRED_IDC, [95, 79, 63, 31, 31]);
  set(CTX.REF_IDX, [153, 153]);
  set(CTX.REF_IDX_L1, [153, 153]);
  set(CTX.MVD, initType === 1 ? [140, 198] : [169, 198]);
  set(CTX.MVP_INDEX, [168]);
  set(CTX.ROOT_CBF, [initType === 1 ? 79 : 79]);
  set(CTX.PREV_INTRA_LUMA_PRED, [initType === 1 ? 154 : 183]);
  set(CTX.INTRA_CHROMA_PRED_MODE, [152]);
  set(CTX.SPLIT_TRANSFORM, initType === 1 ? [124, 138, 94] : [224, 167, 122]);
  set(CTX.CBF_LUMA, [153, 111]);
  set(CTX.CBF_CHROMA, initType === 1 ? [149, 107, 167, 154, 154] : [149, 92, 167, 154, 154]);
  set(CTX.EXPLICIT_RDPCM_FLAG, [139, 139]);
  set(CTX.EXPLICIT_RDPCM_DIR, [139, 139]);
  set(
    CTX.LAST_SIG_X,
    initType === 1
      ? [125, 110, 94, 110, 95, 79, 125, 111, 110, 78, 110, 111, 111, 95, 94, 108, 123, 108]
      : [125, 110, 124, 110, 95, 94, 125, 111, 111, 79, 125, 126, 111, 111, 79, 108, 123, 93],
  );
  set(
    CTX.LAST_SIG_Y,
    initType === 1
      ? [125, 110, 94, 110, 95, 79, 125, 111, 110, 78, 110, 111, 111, 95, 94, 108, 123, 108]
      : [125, 110, 124, 110, 95, 94, 125, 111, 111, 79, 125, 126, 111, 111, 79, 108, 123, 93],
  );
  set(CTX.CODED_SUB_BLOCK, [121, 140, 61, 154]);
  set(
    CTX.SIG_COEFF,
    initType === 1
      ? [
          155, 154, 139, 153, 139, 123, 123, 63, 153, 166, 183, 140, 136, 153, 154, 166, 183, 140,
          136, 153, 154, 166, 183, 140, 136, 153, 154, 170, 153, 123, 123, 107, 121, 107, 121, 167,
          151, 183, 140, 151, 183, 140, 140, 140,
        ]
      : [
          170, 154, 139, 153, 139, 123, 123, 63, 124, 166, 183, 140, 136, 153, 154, 166, 183, 140,
          136, 153, 154, 166, 183, 140, 136, 153, 154, 170, 153, 138, 138, 122, 121, 122, 121, 167,
          151, 183, 140, 151, 183, 140, 140, 140,
        ],
  );
  set(
    CTX.GREATER1,
    initType === 1
      ? [
          154, 196, 196, 167, 154, 152, 167, 182, 182, 134, 149, 136, 153, 121, 136, 137, 169, 194,
          166, 167, 154, 167, 137, 182,
        ]
      : [
          154, 196, 167, 167, 154, 152, 167, 182, 182, 134, 149, 136, 153, 121, 136, 122, 169, 208,
          166, 167, 154, 152, 167, 182,
        ],
  );
  set(CTX.GREATER2, initType === 1 ? [107, 167, 91, 122, 107, 167] : [107, 167, 91, 107, 107, 167]);

  // Tables 9-38 and 9-40..9-42 use initValue 154 for all three init types.
  return values;
}

const INIT_VALUES_BY_TYPE = [INIT_VALUES_I, makeInitValues(1), makeInitValues(2)];

/** CABAC context state: probability index + MPS per context. */
export class CabacContexts {
  pState: Uint8Array;
  valMps: Uint8Array;
  /** H.265 persistent Rice adaptation state, one counter per sub-block type. */
  statCoeff: Uint8Array;

  constructor() {
    this.pState = new Uint8Array(NUM_CTX);
    this.valMps = new Uint8Array(NUM_CTX);
    this.statCoeff = new Uint8Array(4);
  }

  /** 9.3.2.2 initialization from initValue at the slice QP and initType. */
  init(sliceQpY: number, initType = 0): void {
    const qp = Math.min(51, Math.max(0, sliceQpY));
    const initValues = INIT_VALUES_BY_TYPE[initType];
    if (!initValues) throw new RangeError(`heic: invalid CABAC initType ${initType}`);
    this.statCoeff.fill(0);
    for (let i = 0; i < NUM_CTX; i++) {
      const initValue = initValues[i];
      const m = (initValue >> 4) * 5 - 45;
      const nOff = ((initValue & 15) << 3) - 16;
      let preCtxState = ((m * qp) >> 4) + nOff;
      preCtxState = Math.min(126, Math.max(1, preCtxState));
      if (preCtxState <= 63) {
        this.valMps[i] = 0;
        this.pState[i] = 63 - preCtxState;
      } else {
        this.valMps[i] = 1;
        this.pState[i] = preCtxState - 64;
      }
    }
  }

  /** Snapshot for WPP row synchronization. */
  save(): { pState: Uint8Array; valMps: Uint8Array; statCoeff: Uint8Array } {
    return {
      pState: this.pState.slice(),
      valMps: this.valMps.slice(),
      statCoeff: this.statCoeff.slice(),
    };
  }

  restore(snapshot: { pState: Uint8Array; valMps: Uint8Array; statCoeff: Uint8Array }): void {
    this.pState.set(snapshot.pState);
    this.valMps.set(snapshot.valMps);
    this.statCoeff.set(snapshot.statCoeff);
  }
}

/**
 * The binary arithmetic decoding engine (9.3.4.3), reading one byte-aligned
 * substream. Context state lives in a shared CabacContexts so WPP rows can
 * hand state across engines.
 */
export class CabacDecoder {
  private data: Uint8Array;
  private bytePos = 0;
  private bitsLeft = 0;
  private cache = 0;
  private range = 510;
  private offset = 0;

  constructor(
    data: Uint8Array,
    public ctx: CabacContexts,
  ) {
    this.data = data;
    this.offset = this.readBits(9);
  }

  private readBit(): number {
    if (this.bitsLeft === 0) {
      // Past the end, feed zeros (only reachable on the final alignment bits).
      this.cache = this.bytePos < this.data.length ? this.data[this.bytePos++] : 0;
      this.bitsLeft = 8;
    }
    this.bitsLeft--;
    return (this.cache >> this.bitsLeft) & 1;
  }

  private readBits(count: number): number {
    let v = 0;
    for (let i = 0; i < count; i++) v = (v << 1) | this.readBit();
    return v;
  }

  /**
   * Consume the zero bits that align pcm_sample() to the next byte (7.3.8.5).
   * DecodeTerminate( pcm_flag ) deliberately does not renormalize, so the
   * logical bit cursor here ends immediately after the flag's final input bit.
   */
  alignPcmSamples(): void {
    while (((this.bytePos * 8 - this.bitsLeft) & 7) !== 0) {
      if (this.readBit() !== 0)
        throw new HeicError('INVALID_BITSTREAM', 'heic: non-zero pcm_alignment_zero_bit');
    }
  }

  /** Read one unsigned PCM sample directly from the byte-aligned RBSP data. */
  readPcmSample(bitDepth: number): number {
    const available = this.data.length * 8 - (this.bytePos * 8 - this.bitsLeft);
    if (available < bitDepth)
      throw new HeicError('INVALID_BITSTREAM', 'heic: truncated PCM sample data');
    return this.readBits(bitDepth);
  }

  /** Reinitialize only the arithmetic engine after PCM; context state persists. */
  restartAfterPcm(): void {
    const available = this.data.length * 8 - (this.bytePos * 8 - this.bitsLeft);
    if (available < 9)
      throw new HeicError('INVALID_BITSTREAM', 'heic: truncated CABAC data after PCM samples');
    this.range = 510;
    this.offset = this.readBits(9);
  }

  /** 9.3.4.3.2 DecodeDecision. */
  decodeBin(ctxIdx: number): number {
    const pState = this.ctx.pState[ctxIdx];
    const lpsRange = RANGE_TAB_LPS[(pState << 2) | ((this.range >> 6) & 3)];
    this.range -= lpsRange;

    let bin: number;
    if (this.offset >= this.range) {
      // LPS path
      bin = 1 - this.ctx.valMps[ctxIdx];
      this.offset -= this.range;
      this.range = lpsRange;
      if (pState === 0) this.ctx.valMps[ctxIdx] = 1 - this.ctx.valMps[ctxIdx];
      this.ctx.pState[ctxIdx] = TRANS_IDX_LPS[pState];
    } else {
      // MPS path
      bin = this.ctx.valMps[ctxIdx];
      if (pState < 62) this.ctx.pState[ctxIdx] = pState + 1;
    }

    while (this.range < 256) {
      this.range <<= 1;
      this.offset = (this.offset << 1) | this.readBit();
    }
    return bin;
  }

  /** 9.3.4.3.4 DecodeBypass. */
  decodeBypass(): number {
    this.offset = (this.offset << 1) | this.readBit();
    if (this.offset >= this.range) {
      this.offset -= this.range;
      return 1;
    }
    return 0;
  }

  /** 9.3.4.3.6: align before bypass-coded coefficient signs/remaining levels. */
  alignBypass(): void {
    this.range = 256;
  }

  decodeBypassBits(count: number): number {
    let v = 0;
    for (let i = 0; i < count; i++) v = (v << 1) | this.decodeBypass();
    return v;
  }

  /** 9.3.4.3.5 DecodeTerminate (end_of_slice / end_of_subset). */
  decodeTerminate(): number {
    this.range -= 2;
    if (this.offset >= this.range) {
      return 1;
    }
    while (this.range < 256) {
      this.range <<= 1;
      this.offset = (this.offset << 1) | this.readBit();
    }
    return 0;
  }
}
