import { describe, expect, it } from 'bun:test';
import { CabacContexts, CabacDecoder, CTX, NUM_CTX } from '../src/hevc/cabac';

describe('CABAC context initialization (9.3.2.2)', () => {
  it('computes pStateIdx/valMps from initValue at the slice QP', () => {
    const ctx = new CabacContexts();
    ctx.init(16);

    // initValue 139 (split_cu_flag[0]) at QP 16:
    // m = 8*5-45 = -5, n = 11*8-16 = 72, pre = ((-5*16)>>4)+72 = 67 -> MPS 1, state 3
    expect(ctx.valMps[CTX.SPLIT_CU]).toBe(1);
    expect(ctx.pState[CTX.SPLIT_CU]).toBe(3);

    // initValue 154 is the neutral value: pre = 64 -> MPS 1, state 0 at ANY QP
    expect(ctx.valMps[CTX.TQ_BYPASS]).toBe(1);
    expect(ctx.pState[CTX.TQ_BYPASS]).toBe(0);
    expect(ctx.valMps[CTX.CU_CHROMA_QP_OFFSET_FLAG]).toBe(1);
    expect(ctx.pState[CTX.CU_CHROMA_QP_OFFSET_FLAG]).toBe(0);

    // initValue 63 (intra_chroma_pred_mode) at QP 16:
    // m = 3*5-45 = -30, n = 15*8-16 = 104, pre = -30+104 = 74 -> MPS 1, state 10
    expect(ctx.valMps[CTX.INTRA_CHROMA_PRED_MODE]).toBe(1);
    expect(ctx.pState[CTX.INTRA_CHROMA_PRED_MODE]).toBe(10);

    // Table 9-29's transform-skip significant-coefficient contexts.
    expect(ctx.pState[CTX.SIG_COEFF + 42]).toBe(19); // initValue 141
    expect(ctx.pState[CTX.SIG_COEFF + 43]).toBe(25); // initValue 111

    const neutral = new CabacContexts();
    neutral.init(40);
    expect(neutral.valMps[CTX.TQ_BYPASS]).toBe(1);
    expect(neutral.pState[CTX.TQ_BYPASS]).toBe(0);
  });

  it('lays out the expected number of contexts', () => {
    expect(CTX.PALETTE_TRANSPOSE + 1).toBe(NUM_CTX);
    expect(NUM_CTX).toBe(187);
  });

  it('initializes P-slice skip and prediction contexts from initType 1 or 2', () => {
    const p = new CabacContexts();
    p.init(37, 1);
    // initValue 197 at QP 37 gives preCtxState 58 (MPS 0, state 5).
    expect(p.valMps[CTX.CU_SKIP]).toBe(0);
    expect(p.pState[CTX.CU_SKIP]).toBe(5);
    // initValue 149 at QP 37 gives preCtxState 24 (MPS 0, state 39).
    expect(p.valMps[CTX.PRED_MODE]).toBe(0);
    expect(p.pState[CTX.PRED_MODE]).toBe(39);
    expect(p.pState[CTX.REF_IDX]).toBe(7);
    expect(p.pState[CTX.REF_IDX + 1]).toBe(7);

    const pCabacInit = new CabacContexts();
    pCabacInit.init(37, 2);
    // cabac_init_flag swaps P to initType 2; its pred_mode initValue is 134.
    expect(pCabacInit.valMps[CTX.PRED_MODE]).toBe(0);
    expect(pCabacInit.pState[CTX.PRED_MODE]).toBe(43);
  });
});

describe('CABAC arithmetic engine (9.3.4.3)', () => {
  it('decodes bypass bins by doubling the offset against the range', () => {
    const ctx = new CabacContexts();
    ctx.init(16);
    // First 9 bits = 0b100000000 = 256; range starts at 510.
    const d = new CabacDecoder(new Uint8Array([0x80, 0x00, 0x00]), ctx);
    // 256*2 = 512 >= 510 -> 1 (offset becomes 2), then 4, 8, ... all < 510 -> 0
    expect(d.decodeBypass()).toBe(1);
    expect(d.decodeBypass()).toBe(0);
    expect(d.decodeBypass()).toBe(0);
    expect(d.decodeBypassBits(3)).toBe(0);
  });

  it('sets the arithmetic range to 256 for aligned bypass bins', () => {
    const ctx = new CabacContexts();
    ctx.init(16);
    // Initial offset is 255; the remaining stream bits are zero. After
    // alignment, two bypass bins are one. Without alignment, the second is 0.
    const d = new CabacDecoder(new Uint8Array([0x7f, 0x80, 0x00]), ctx);
    d.alignBypass();
    expect(d.decodeBypass()).toBe(1);
    expect(d.decodeBypass()).toBe(1);
  });

  it('decodes terminate bins against range - 2', () => {
    const ctx = new CabacContexts();
    ctx.init(16);
    const one = new CabacDecoder(new Uint8Array([0xff, 0x80]), ctx); // offset 511
    expect(one.decodeTerminate()).toBe(1);

    const zero = new CabacDecoder(new Uint8Array([0x00, 0x00]), ctx); // offset 0
    expect(zero.decodeTerminate()).toBe(0);
  });

  it('walks the LPS range table and state machine on context bins', () => {
    const ctx = new CabacContexts();
    ctx.init(16);
    const d = new CabacDecoder(new Uint8Array([0x00, 0x00, 0x00]), ctx);
    // split_cu[0]: state 3, MPS 1. qRangeIdx = (510>>6)&3 = 3 -> LPS 205.
    // range 510-205 = 305 > offset 0 -> MPS bin (1), state -> 4.
    expect(d.decodeBin(CTX.SPLIT_CU)).toBe(1);
    expect(ctx.pState[CTX.SPLIT_CU]).toBe(4);
    // qRangeIdx = (305>>6)&3 = 0 -> LPS 116; range 189 -> MPS bin, renorm to 378.
    expect(d.decodeBin(CTX.SPLIT_CU)).toBe(1);
    expect(ctx.pState[CTX.SPLIT_CU]).toBe(5);
  });

  it('flips MPS only when the LPS is decoded at state 0', () => {
    const ctx = new CabacContexts();
    ctx.init(16);
    // TQ_BYPASS is neutral: state 0, MPS 1. Force an LPS with a huge offset.
    const d = new CabacDecoder(new Uint8Array([0xff, 0xff, 0xff, 0xff]), ctx);
    // offset 511, range 510: qRangeIdx 3 -> LPS(state 0) = 240, range 270.
    // 511 >= 270 -> LPS: bin = 0, MPS flips to 0, state stays transIdxLps[0]=0.
    expect(d.decodeBin(CTX.TQ_BYPASS)).toBe(0);
    expect(ctx.valMps[CTX.TQ_BYPASS]).toBe(0);
    expect(ctx.pState[CTX.TQ_BYPASS]).toBe(0);
  });

  it('save/restore snapshots context state for WPP', () => {
    const ctx = new CabacContexts();
    ctx.init(16);
    ctx.statCoeff.set([1, 7, 12, 31]);
    const snapshot = ctx.save();
    ctx.statCoeff.fill(0);
    const d = new CabacDecoder(new Uint8Array([0x5a, 0x3c, 0x99]), ctx);
    for (let i = 0; i < 8; i++) d.decodeBin(CTX.SIG_COEFF + i);
    expect(ctx.pState.join()).not.toBe(snapshot.pState.join());
    ctx.restore(snapshot);
    expect(ctx.pState.join()).toBe(snapshot.pState.join());
    expect(ctx.valMps.join()).toBe(snapshot.valMps.join());
    expect(ctx.statCoeff.join()).toBe('1,7,12,31');
  });

  it('initializes persistent Rice adaptation state to zero', () => {
    const ctx = new CabacContexts();
    ctx.statCoeff.set([1, 7, 12, 31]);
    ctx.init(16);
    expect(ctx.statCoeff.join()).toBe('0,0,0,0');
  });
});
