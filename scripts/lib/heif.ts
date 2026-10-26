import { splitAnnexB } from "../../src/hevc/nal";
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
): Buffer {
  const nals = splitAnnexB(stream);
  const config = Buffer.alloc(23);
  config[0] = 1;
  config[1] = depth === 12 ? 4 : depth === 10 ? 2 : 1;
  config[12] = 120;
  config[13] = 0xf0;
  config[15] = 0xfc;
  config[16] = 0xfc | chroma;
  config[17] = 0xf8 | (depth - 8);
  config[18] = 0xf8 | (depth - 8);
  config[21] = 3;
  config[22] = 3;
  const arrays = [32, 33, 34].map((type) => {
    const list = nals.filter((n) => n.type === type);
    return Buffer.concat([
      Buffer.from([0x80 | type]),
      u16(list.length),
      ...list.flatMap((n) => [u16(n.data.length), n.data]),
    ]);
  });
  const hvcc = box("hvcC", config, ...arrays);
  const slices = nals.filter((n) => n.type < 32);
  const payload = Buffer.concat(slices.flatMap((n) => [u32(n.data.length), n.data]));
  const ftyp = box("ftyp", Buffer.from("heic"), u32(0), Buffer.from("heicmif1"));
  const meta = (offset: number) =>
    full(
      "meta",
      0,
      full("hdlr", 0, u32(0), Buffer.from("pict"), Buffer.alloc(12), Buffer.from([0])),
      full("pitm", 0, u16(1)),
      full(
        "iinf",
        0,
        u16(1),
        full("infe", 2, u16(1), u16(0), Buffer.from("hvc1"), Buffer.from([0])),
      ),
      full(
        "iloc",
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
        "iprp",
        box(
          "ipco",
          full("ispe", 0, u32(w), u32(h)),
          full("pixi", 0, Buffer.from(chroma ? [3, depth, depth, depth] : [1, depth])),
          hvcc,
        ),
        full("ipma", 0, u32(1), u16(1), Buffer.from([3, 1, 2, 0x83])),
      ),
    );
  return Buffer.concat([ftyp, meta(ftyp.length + meta(0).length + 8), box("mdat", payload)]);
}
