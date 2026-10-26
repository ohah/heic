// Compare reconstructed codec samples against FFmpeg, before RGB/profile rendering.
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { getHeicInfo, getItemPayload } from "../src/container/heic";
import { parseISOBMFF } from "../src/container/heif";
import { parseSps } from "../src/hevc/sps";
import { splitLengthPrefixed } from "../src/hevc/nal";
import { decodeItemPlanes, cropPlanes } from "../src/planes";
const directory = process.env.HEIC_CORPUS_DIR ?? "/tmp/heic-external-corpus",
  output = "/tmp/heic-pixel-reference";
mkdirSync(output, { recursive: true });
const corpus = JSON.parse(readFileSync(directory + "/results.json", "utf8"));
if (
  corpus.length !==
  JSON.parse(readFileSync(new URL("../test/corpus-manifest.json", import.meta.url), "utf8")).length
)
  throw Error("Run the complete corpus first");
const results: any[] = [],
  seen = new Map<string, number>();
const selection = process.env.HEIC_REFERENCE_FILES?.split(",");
for (const file of corpus.filter((file: any) =>
  selection ? selection.some((name) => file.name.includes(name)) : file.status === "decoded",
)) {
  const input = new Uint8Array(readFileSync(directory + "/" + file.name)),
    boxes = parseISOBMFF(input),
    ids = new Set<number>();
  const visit = (id?: number, stack = new Set<number>()) => {
    const info = getHeicInfo(input, boxes, id);
    if (stack.has(info.primaryItemId)) throw Error("cycle");
    stack.add(info.primaryItemId);
    if (info.grid) for (const child of info.grid.tileItemIds) visit(child, new Set(stack));
    else if (info.hvcC) ids.add(info.primaryItemId);
    else for (const child of info.derivedItems) visit(child, new Set(stack));
    if (info.alphaItemId !== null) visit(info.alphaItemId, new Set(stack));
  };
  visit();
  for (const id of ids) {
    const info = getHeicInfo(input, boxes, id),
      config = info.hvcC!,
      sps = parseSps(config.sps[0]),
      payload = getItemPayload(input, boxes, id)!,
      nals = splitLengthPrefixed(payload, config.nalLengthSize);
    const units = [...config.vps, ...config.sps, ...config.pps, ...nals.map((n) => n.data)],
      hash = createHash("sha256");
    for (const unit of units) hash.update(unit);
    const digest = hash.digest("hex");
    if (seen.has(digest)) {
      results.push({
        file: file.name,
        id,
        deduplicatedFrom: seen.get(digest),
        status: "same-coded-picture",
      });
      continue;
    }
    seen.set(digest, results.length);
    try {
      const raw = decodeItemPlanes(input, boxes, info, id),
        sub = sps.chromaFormatIdc === 1 ? 2 : 1,
        decoded = cropPlanes(raw, sps.cropLeft * sub, sps.cropTop * sub, sps.width, sps.height);
      const stream = Buffer.concat(units.flatMap((unit) => [Buffer.from([0, 0, 0, 1]), unit]));
      const pixel =
        sps.chromaFormatIdc === 0
          ? `gray${sps.bitDepthLuma === 8 ? "" : sps.bitDepthLuma + "le"}`
          : `yuv${sps.chromaFormatIdc === 3 ? "444" : "420"}p${sps.bitDepthLuma === 8 ? "" : sps.bitDepthLuma + "le"}`;
      const reference = execFileSync(
          process.env.HEIC_FFMPEG ?? "ffmpeg",
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "hevc",
            "-i",
            "pipe:0",
            "-frames:v",
            "1",
            "-pix_fmt",
            pixel,
            "-f",
            "rawvideo",
            "pipe:1",
          ],
          {
            input: stream,
            timeout: 60000,
            maxBuffer: 384 * 1024 * 1024,
            stdio: ["pipe", "pipe", "pipe"],
          },
        ),
        bytes = sps.bitDepthLuma === 8 ? 1 : 2;
      const expected = (decoded.y.length + decoded.cb.length + decoded.cr.length) * bytes;
      if (reference.length !== expected)
        throw Error(`reference length ${reference.length} != ${expected}`);
      let p = 0,
        differences = 0,
        maxDelta = 0;
      for (const plane of [decoded.y, decoded.cb, decoded.cr])
        for (const value of plane) {
          const ref = bytes === 1 ? reference[p++] : reference.readUInt16LE(p++ * 2);
          if (value !== ref) {
            differences++;
            maxDelta = Math.max(maxDelta, Math.abs(value - ref));
          }
        }
      results.push({
        file: file.name,
        id,
        sha256: digest,
        status: differences ? "mismatch" : "exact",
        width: decoded.width,
        height: decoded.height,
        bitDepth: sps.bitDepthLuma,
        chroma: sps.chromaFormatIdc,
        samples: p,
        differences,
        maxDelta,
      });
    } catch (error) {
      results.push({ file: file.name, id, sha256: digest, status: "error", error: String(error) });
    }
    console.log(JSON.stringify(results.at(-1)));
    writeFileSync(output + "/results.json", JSON.stringify(results, null, 2));
  }
}
writeFileSync(output + "/results.json", JSON.stringify(results, null, 2));
for (const file of ["sample.hevc", "sample.yuv"])
  try {
    unlinkSync(output + "/" + file);
  } catch {}
console.log("Coded pictures visited:", results.length, "unique:", seen.size);
if (results.some((row) => row.status === "mismatch" || row.status === "error"))
  process.exitCode = 1;
