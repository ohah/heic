// External fixture bytes remain outside the repository and npm package.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { decodeHeic, getHeicMetadata, decodeHDRSync } from '../src';
import { parseISOBMFF, findBox, parseIinf } from '../src/container/heif';
import { parsePitm } from '../src/container/heic';
const output = process.env.HEIC_CORPUS_DIR ?? '/tmp/heic-external-corpus';
await mkdir(output, { recursive: true });
const manifest = JSON.parse(
  await readFile(new URL('../test/corpus-manifest.json', import.meta.url), 'utf8'),
);
const results = [];
for (const [index, item] of manifest.entries()) {
  const path = join(output, item.name);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch {
    const response = await fetch(item.source);
    if (!response.ok) throw Error(`Fixture download failed: ${item.name} (${response.status})`);
    bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(path, bytes);
  }
  if (createHash('sha256').update(bytes).digest('hex') !== item.sha256)
    throw Error('Fixture checksum mismatch: ' + item.name);
  const started = performance.now();
  let meta: any,
    classification = 'hevc-still';
  try {
    const m = getHeicMetadata(bytes);
    meta = {
      width: m.width,
      height: m.height,
      type: m.primaryItemType,
      alpha: m.hasAlpha,
      chroma: m.sps?.chromaFormatIdc,
      bitDepth: m.sps?.bitDepthLuma,
      transforms: m.transforms,
    };
  } catch {
    try {
      const boxes = parseISOBMFF(bytes);
      if (!findBox(boxes, 'meta') && findBox(boxes, 'moov')) classification = 'timed-sequence';
      else {
        const metaBox = findBox(boxes, 'meta'),
          iinf = metaBox?.children && findBox(metaBox.children, 'iinf'),
          pitm = metaBox?.children && findBox(metaBox.children, 'pitm');
        const items = iinf ? parseIinf(iinf.data) : [],
          primary = pitm ? items.find((entry) => entry.itemId === parsePitm(pitm.data)) : undefined;
        if (primary && ['vvc1', 'av01', 'avc1', 'jpeg', 'j2k1'].includes(primary.itemType))
          classification = 'other-codec-' + primary.itemType;
      }
    } catch {}
  }
  try {
    const image = decodeHeic(bytes);
    let invariant = true;
    if (item.name.includes('__L_') || item.name.includes('__LA_'))
      for (let i = 0; i < image.data.length; i += 4)
        if (image.data[i] !== image.data[i + 1] || image.data[i] !== image.data[i + 2]) {
          invariant = false;
          break;
        }
    let hdr: any;
    // Real Apple gain maps and the explicit PQ/HLG/ISO samples get an HDR check.
    if (
      meta?.type === 'tmap' ||
      item.name.includes('HEIC_HDR') ||
      item.name.includes('coffee') ||
      item.name.includes('mug') ||
      item.name.includes('kahvihuone')
    ) {
      try {
        const d = decodeHDRSync(bytes);
        let peak = 0,
          finite = true;
        for (let i = 0; i < d.data.length; i++) {
          if (!Number.isFinite(d.data[i])) finite = false;
          if (i % 4 !== 3) peak = Math.max(peak, d.data[i]);
        }
        hdr = {
          status: 'decoded',
          source: d.source,
          headroom: d.headroom,
          sourceHeadroom: d.sourceHeadroom,
          peak,
          finite,
        };
      } catch (error: any) {
        hdr = { status: 'rejected', code: error.code, error: error.message };
      }
    }
    results.push({
      ...item,
      classification,
      meta,
      status: invariant ? 'decoded' : 'invariant-failed',
      width: image.width,
      height: image.height,
      bitDepth: image.bitDepth,
      hasAlpha: image.hasAlpha,
      hdr,
      ms: performance.now() - started,
    });
  } catch (error: any) {
    results.push({
      ...item,
      classification,
      meta,
      status: 'rejected',
      code: error.code,
      error: error.message,
      ms: performance.now() - started,
    });
  }
  console.log(JSON.stringify({ index: index + 1, ...results.at(-1) }));
  await writeFile(join(output, 'results.partial.json'), JSON.stringify(results, null, 2));
}
await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
console.log('All external fixtures attempted:', results.length);
// Rejections are retained, not converted to passing expectations after the fact.
if (results.some((row) => row.status === 'invariant-failed')) process.exitCode = 1;
