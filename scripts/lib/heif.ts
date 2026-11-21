import { splitAnnexB, toRbsp } from '../../src/hevc/nal';
const u16 = (n: number) => {
  const b = Buffer.alloc(2);
  b.writeUInt16BE(n);
  return b;
};
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const box = (name: string, ...parts: Uint8Array[]) => {
  const data = Buffer.concat(parts);
  return Buffer.concat([u32(data.length + 8), Buffer.from(name), data]);
};
const full = (name: string, version: number, ...parts: Uint8Array[]) =>
  box(name, Buffer.from([version, 0, 0, 0]), ...parts);

export function wrapHevc(
  stream: Uint8Array,
  w: number,
  h: number,
  depth: number,
  chroma = 1,
  chromaDepth = depth,
): Buffer {
  const nals = splitAnnexB(stream);
  const config = Buffer.alloc(23);
  config[0] = 1;
  const sps = nals.find((n) => n.type === 33);
  if (!sps) throw new Error('HEVC stream has no SPS');
  const spsRbsp = toRbsp(sps.data);
  if (spsRbsp.length < 13) throw new Error('HEVC SPS profile_tier_level is truncated');
  const profileIdc = spsRbsp[1] & 0x1f;
  // ISO/IEC 23008-12 Annex B.4.1.1 reserves `heic` for Main/Main Still
  // Picture. Main 10 and Range Extensions (including 4:2:2) use `heix`.
  const isMainStillProfile = (profileIdc === 1 || profileIdc === 3) && depth === 8 && chroma === 1;
  const brand = isMainStillProfile ? 'heic' : 'heix';
  config.set(spsRbsp.subarray(1, 13), 1);
  config[13] = 0xf0;
  config[15] = 0xfc;
  config[16] = 0xfc | chroma;
  config[17] = 0xf8 | (depth - 8);
  config[18] = 0xf8 | (chromaDepth - 8);
  config[21] = ((((spsRbsp[0] >> 1) & 7) + 1) << 3) | ((spsRbsp[0] & 1) << 2) | 3;
  config[22] = 3;
  const arrays = [32, 33, 34].map((type) => {
    const list = nals.filter((n) => n.type === type);
    return Buffer.concat([
      Buffer.from([0x80 | type]),
      u16(list.length),
      ...list.flatMap((n) => [u16(n.data.length), n.data]),
    ]);
  });
  const hvcc = box('hvcC', config, ...arrays);
  const slices = nals.filter((n) => n.type < 32);
  const payload = Buffer.concat(slices.flatMap((n) => [u32(n.data.length), n.data]));
  const ftyp = box('ftyp', Buffer.from(brand), u32(0), Buffer.from(brand + 'mif1'));
  const meta = (offset: number) =>
    full(
      'meta',
      0,
      full('hdlr', 0, u32(0), Buffer.from('pict'), Buffer.alloc(12), Buffer.from([0])),
      full('pitm', 0, u16(1)),
      full(
        'iinf',
        0,
        u16(1),
        full('infe', 2, u16(1), u16(0), Buffer.from('hvc1'), Buffer.from([0])),
      ),
      full(
        'iloc',
        0,
        Buffer.from([0x44, 0]),
        u16(1),
        u16(1),
        u16(0),
        u16(1),
        u32(offset),
        u32(payload.length),
      ),
      box(
        'iprp',
        box(
          'ipco',
          full('ispe', 0, u32(w), u32(h)),
          full('pixi', 0, Buffer.from(chroma ? [3, depth, chromaDepth, chromaDepth] : [1, depth])),
          hvcc,
        ),
        full('ipma', 0, u32(1), u16(1), Buffer.from([3, 1, 2, 0x83])),
      ),
    );
  return Buffer.concat([ftyp, meta(ftyp.length + meta(0).length + 8), box('mdat', payload)]);
}

/** Build a two-item HEIF whose primary HEVC item uses `pred` to reference the first item. */
export function wrapHevcPredItems(
  referenceStream: Uint8Array,
  primaryStream: Uint8Array,
  w: number,
  h: number,
  depth: number,
  chroma = 1,
): Buffer {
  const referenceNals = splitAnnexB(referenceStream);
  const primaryNals = splitAnnexB(primaryStream);
  const sps = referenceNals.find((n) => n.type === 33);
  if (!sps) throw new Error('HEVC pred reference stream has no SPS');
  const spsRbsp = toRbsp(sps.data);
  if (spsRbsp.length < 13) throw new Error('HEVC SPS profile_tier_level is truncated');
  const profileIdc = spsRbsp[1] & 0x1f;
  const isMainStillProfile = (profileIdc === 1 || profileIdc === 3) && depth === 8 && chroma === 1;
  const brand = isMainStillProfile ? 'heic' : 'heix';

  const config = Buffer.alloc(23);
  config[0] = 1;
  config.set(spsRbsp.subarray(1, 13), 1);
  config[13] = 0xf0;
  config[15] = 0xfc;
  config[16] = 0xfc | chroma;
  config[17] = 0xf8 | (depth - 8);
  config[18] = 0xf8 | (depth - 8);
  config[21] = ((((sps.data[0] >> 1) & 7) + 1) << 3) | ((sps.data[0] & 1) << 2) | 3;
  config[22] = 3;
  const arrays = [32, 33, 34].map((type) => {
    const list = referenceNals.filter((n) => n.type === type);
    return Buffer.concat([
      Buffer.from([0x80 | type]),
      u16(list.length),
      ...list.flatMap((n) => [u16(n.data.length), n.data]),
    ]);
  });
  const hvcc = box('hvcC', config, ...arrays);
  const itemPayload = (nals: typeof referenceNals) =>
    Buffer.concat(nals.filter((n) => n.type < 32).flatMap((n) => [u32(n.data.length), n.data]));
  const referencePayload = itemPayload(referenceNals);
  const primaryPayload = itemPayload(primaryNals);
  const rref = full('rref', 0, Buffer.from([1]), Buffer.from('pred'));
  const meta = (referenceOffset: number, primaryOffset: number) =>
    full(
      'meta',
      0,
      full('hdlr', 0, u32(0), Buffer.from('pict'), Buffer.alloc(12), Buffer.from([0])),
      full('pitm', 0, u16(2)),
      full(
        'iinf',
        0,
        u16(2),
        full('infe', 2, u16(1), u16(0), Buffer.from('hvc1'), Buffer.from([0])),
        full('infe', 2, u16(2), u16(0), Buffer.from('hvc1'), Buffer.from([0])),
      ),
      full(
        'iloc',
        0,
        Buffer.from([0x44, 0]),
        u16(2),
        u16(1),
        u16(0),
        u16(1),
        u32(referenceOffset),
        u32(referencePayload.length),
        u16(2),
        u16(0),
        u16(1),
        u32(primaryOffset),
        u32(primaryPayload.length),
      ),
      full('iref', 0, box('pred', u16(2), u16(1), u16(1))),
      box(
        'iprp',
        box(
          'ipco',
          full('ispe', 0, u32(w), u32(h)),
          full('pixi', 0, Buffer.from(chroma ? [3, depth, depth, depth] : [1, depth])),
          hvcc,
          rref,
        ),
        full(
          'ipma',
          0,
          u32(2),
          u16(1),
          Buffer.from([3, 1, 2, 3]),
          u16(2),
          Buffer.from([4, 1, 2, 3, 0x84]),
        ),
      ),
    );

  const ftyp = box('ftyp', Buffer.from(brand), u32(0), Buffer.from(brand + 'mif1'));
  const placeholderMeta = meta(0, 0);
  const mdatPayloadOffset = ftyp.length + placeholderMeta.length + 8;
  const referenceOffset = mdatPayloadOffset;
  const primaryOffset = referenceOffset + referencePayload.length;
  return Buffer.concat([
    ftyp,
    meta(referenceOffset, primaryOffset),
    box('mdat', referencePayload, primaryPayload),
  ]);
}

/** Build a HEIF item chain with one `pred` dependency list for each item. */
export function wrapHevcPredChain(
  streams: readonly Uint8Array[],
  predReferenceIds: readonly (readonly number[])[],
  w: number,
  h: number,
  depth: number,
  chroma = 1,
): Buffer {
  if (
    streams.length === 0 ||
    streams.length !== predReferenceIds.length ||
    streams.length > 0xffff ||
    predReferenceIds.some((ids, index) =>
      ids.some((id) => !Number.isInteger(id) || id < 1 || id >= index + 1),
    )
  )
    throw new Error('invalid HEIF pred chain');

  const itemNals = streams.map((stream) => splitAnnexB(stream));
  const referenceNals = itemNals[0];
  const sps = referenceNals.find((nal) => nal.type === 33);
  if (!sps) throw new Error('HEVC pred chain has no SPS in its first item');
  const spsRbsp = toRbsp(sps.data);
  if (spsRbsp.length < 13) throw new Error('HEVC SPS profile_tier_level is truncated');
  const profileIdc = spsRbsp[1] & 0x1f;
  const isMainStillProfile = (profileIdc === 1 || profileIdc === 3) && depth === 8 && chroma === 1;
  const brand = isMainStillProfile ? 'heic' : 'heix';

  const config = Buffer.alloc(23);
  config[0] = 1;
  config.set(spsRbsp.subarray(1, 13), 1);
  config[13] = 0xf0;
  config[15] = 0xfc;
  config[16] = 0xfc | chroma;
  config[17] = 0xf8 | (depth - 8);
  config[18] = 0xf8 | (depth - 8);
  config[21] = ((((sps.data[0] >> 1) & 7) + 1) << 3) | ((sps.data[0] & 1) << 2) | 3;
  config[22] = 3;
  const arrays = [32, 33, 34].map((type) => {
    const list = referenceNals.filter((nal) => nal.type === type);
    return Buffer.concat([
      Buffer.from([0x80 | type]),
      u16(list.length),
      ...list.flatMap((nal) => [u16(nal.data.length), nal.data]),
    ]);
  });
  const hvcc = box('hvcC', config, ...arrays);
  const payloads = itemNals.map((nals) =>
    Buffer.concat(
      nals.filter((nal) => nal.type < 32).flatMap((nal) => [u32(nal.data.length), nal.data]),
    ),
  );
  const rref = full('rref', 0, Buffer.from([1]), Buffer.from('pred'));
  const meta = (offsets: readonly number[]) => {
    const itemLocations = offsets.flatMap((offset, index) => [
      u16(index + 1),
      u16(0),
      u16(1),
      u32(offset),
      u32(payloads[index].length),
    ]);
    const predBoxes = predReferenceIds.flatMap((ids, index) =>
      ids.length ? [box('pred', u16(index + 1), u16(ids.length), ...ids.map((id) => u16(id)))] : [],
    );
    const itemInfo = streams.map((_, index) =>
      full('infe', 2, u16(index + 1), u16(0), Buffer.from('hvc1'), Buffer.from([0])),
    );
    const associations = streams.flatMap((_, index) => {
      const properties = predReferenceIds[index].length ? [1, 2, 3, 0x84] : [1, 2, 3];
      return [u16(index + 1), Buffer.from([properties.length, ...properties])];
    });
    return full(
      'meta',
      0,
      full('hdlr', 0, u32(0), Buffer.from('pict'), Buffer.alloc(12), Buffer.from([0])),
      full('pitm', 0, u16(streams.length)),
      full('iinf', 0, u16(streams.length), ...itemInfo),
      full('iloc', 0, Buffer.from([0x44, 0]), u16(streams.length), ...itemLocations),
      full('iref', 0, ...predBoxes),
      box(
        'iprp',
        box(
          'ipco',
          full('ispe', 0, u32(w), u32(h)),
          full('pixi', 0, Buffer.from(chroma ? [3, depth, depth, depth] : [1, depth])),
          hvcc,
          rref,
        ),
        full('ipma', 0, u32(streams.length), ...associations),
      ),
    );
  };

  const ftyp = box('ftyp', Buffer.from(brand), u32(0), Buffer.from(brand + 'mif1'));
  const placeholderMeta = meta(streams.map(() => 0));
  let payloadOffset = ftyp.length + placeholderMeta.length + 8;
  const offsets = payloads.map((payload) => {
    const offset = payloadOffset;
    payloadOffset += payload.length;
    return offset;
  });
  return Buffer.concat([ftyp, meta(offsets), box('mdat', ...payloads)]);
}
