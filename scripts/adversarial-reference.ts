// Independent encoder/reference tools are for development only, never bundled.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { wrapHevc } from "./lib/heif";
import {
  getHeicMetadata,
  parsePps,
  PictureDecoder,
  getItemPayload,
  parseISOBMFF,
  splitLengthPrefixed,
  isSliceNal,
  decodeHeic,
} from "../src";
import { deblockPicture } from "../src/hevc/deblock";
import { applySao } from "../src/hevc/sao";

const chroma = Number(process.env.HEIC_CHROMA ?? 1);
if (![0, 1, 3].includes(chroma)) throw Error("Unsupported test chroma");
const factor = chroma === 3 ? 3 : chroma === 0 ? 1 : 1.5;
const out = "/tmp/heic-adversarial-reference-" + chroma;
mkdirSync(out, { recursive: true });
const results = [];
for (let round = 1; round <= 20; round++) {
  const cases = [];
  for (const depth of [8, 10, 12]) {
    const w = round % 2 ? 256 : round * 8 + 66,
      h = round % 2 ? 128 : round * 8 + 58;
    const stem = join(out, `round-${round}-${depth}`);
    const bytes = Buffer.alloc(w * h * factor * (depth === 8 ? 1 : 2));
    let i = 0;
    let seed = round * 7919 + depth;
    for (let sample = 0; sample < w * h * factor; sample++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      const val =
        sample < w * h && sample % w < w / 3 ? (sample % 17) << (depth - 5) : seed >>> (32 - depth);
      if (depth === 8) bytes[i++] = val;
      else {
        bytes.writeUInt16LE(val, i);
        i += 2;
      }
    }
    writeFileSync(stem + ".raw", bytes);
    const pix = `${chroma === 0 ? "gray" : chroma === 3 ? "yuv444p" : "yuv420p"}${depth === 8 ? "" : `${depth}le`}`;
    const qp = [0, 7, 19, 32, 45][(round - 1) % 5];
    const params = `keyint=1:${round % 2 ? `crf=${qp}:aq-mode=2` : `qp=${qp}`}:log-level=error:pools=1:frame-threads=1:wpp=${round % 2}:sao=${round % 3 ? 1 : 0}:deblock=${round % 4 ? 1 : 0}:signhide=${round % 2}:scaling-list=default:tskip=1${round > 10 && round % 3 === 0 ? ":lossless=1" : ""}`;
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "rawvideo",
      "-pixel_format",
      pix,
      "-video_size",
      `${w}x${h}`,
      "-i",
      stem + ".raw",
      "-frames:v",
      "1",
      "-c:v",
      "libx265",
      "-x265-params",
      params,
      "-f",
      "hevc",
      "-y",
      stem + ".hevc",
    ]);
    writeFileSync(
      stem + ".heic",
      wrapHevc(new Uint8Array(readFileSync(stem + ".hevc")), w, h, depth, chroma),
    );
    execFileSync(process.env.HEIC_FFMPEG_REFERENCE ?? "ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      stem + ".hevc",
      "-frames:v",
      "1",
      "-pix_fmt",
      pix,
      "-f",
      "rawvideo",
      "-y",
      stem + ".yuv",
    ]);
    try {
      const input = new Uint8Array(readFileSync(stem + ".heic"));
      const m = getHeicMetadata(input);
      const pps = parsePps(m.hvcC!.pps[0]);
      const sps = m.sps!;
      const payload = getItemPayload(input, parseISOBMFF(input), m.primaryItemId)!;
      const pic = new PictureDecoder(sps, pps).decode(
        splitLengthPrefixed(payload, m.hvcC!.nalLengthSize)
          .filter((n) => isSliceNal(n.type))
          .map((n) => n.data),
      );
      deblockPicture(pic, pps, depth);
      applySao(pic, sps, depth);
      const ref = readFileSync(stem + ".yuv");
      let k = 0,
        differences = 0,
        maxDelta = 0;
      for (const [c, plane] of [pic.y, pic.cb, pic.cr].entries()) {
        const sub = chroma === 1 ? 2 : 1,
          pw = c ? w / sub : w,
          ph = c ? h / sub : h,
          stride = c ? pic.width / sub : pic.width;
        for (let y = 0; y < ph; y++)
          for (let x = 0; x < pw; x++) {
            const expected = depth === 8 ? ref[k++] : ref.readUInt16LE(k++ * 2);
            const actual =
              plane[
                (y + (c ? sps.cropTop : sps.cropTop * (chroma === 1 ? 2 : 1))) * stride +
                  x +
                  (c ? sps.cropLeft : sps.cropLeft * (chroma === 1 ? 2 : 1))
              ];
            if (actual !== expected) {
              differences++;
              maxDelta = Math.max(maxDelta, Math.abs(actual - expected));
            }
          }
      }
      const image = decodeHeic(input);
      cases.push({
        depth,
        w,
        h,
        qp,
        wpp: pps.entropyCodingSyncEnabled,
        differences,
        maxDelta,
        width: image.width,
        height: image.height,
        pass:
          differences === 0 &&
          image.width === w &&
          image.height === h &&
          pps.entropyCodingSyncEnabled === !!(round % 2),
      });
    } catch (error) {
      cases.push({ depth, w, h, qp, pass: false, error: String(error) });
    }
  }
  results.push({ round, cases });
  console.log(JSON.stringify(results.at(-1)));
}
writeFileSync(out + "/results.json", JSON.stringify(results, null, 2));
if (results.some((r) => r.cases.some((c) => !c.pass))) process.exitCode = 1;
