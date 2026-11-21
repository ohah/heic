// Reproduce ohah/FFmpeg PR #25467 against this HEIF-wrapped HEVC decoder.
// The pinned reference planes come from x265's encoder reconstruction, not FFmpeg.
import { createHash } from 'node:crypto';
import { getHeicInfo } from '../src/container/heic';
import { getFtypInfo, parseISOBMFF } from '../src/container/heif';
import { decodeItemPlanes } from '../src/planes';
import { wrapHevc } from './lib/heif';

const source =
  'https://raw.githubusercontent.com/ohah/FFmpeg/df6c311a005073ab714089c5a7b727098e30bb1d/repro/hevc-qp74-75';
const vectors = [
  {
    qp: 74,
    hevcSha256: 'fe92b55f9fbc941b396a615a175ad6ebe95111b8cded2064a39e0c6583fa52fc',
    yuvSha256: '6626e6bcc749805e63cb286fc0dc243328c1604511ee890438cfacd0ad5d4201',
  },
  {
    qp: 75,
    hevcSha256: 'e899332464fcec03f84a54cbfda5fbb70001f7d846123000914d69a1dd89d3f7',
    yuvSha256: 'cddef7c1e197e3340c5885d1f9e518607f01989b671444821236a91ce906664f',
  },
] as const;

async function download(path: string, expectedSha256: string): Promise<Uint8Array> {
  const response = await fetch(`${source}/${path}`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actualSha256 = createHash('sha256').update(bytes).digest('hex');
  if (actualSha256 !== expectedSha256)
    throw new Error(`${path}: SHA-256 mismatch (${actualSha256})`);
  return bytes;
}

for (const vector of vectors) {
  const stem = `qp${vector.qp}`;
  const [stream, reference] = await Promise.all([
    download(`${stem}.hevc`, vector.hevcSha256),
    download(`${stem}.yuv`, vector.yuvSha256),
  ]);
  const heif = wrapHevc(stream, 128, 64, 12, 3);
  const boxes = parseISOBMFF(heif);
  const info = getHeicInfo(heif, boxes);
  const brand = getFtypInfo(heif)?.majorBrand;
  if (brand !== 'heix') throw new Error(`${stem}: expected HEIX brand, got ${brand}`);
  if (info.hvcC?.chromaFormatIdc !== 3)
    throw new Error(`${stem}: expected 4:4:4, got chroma_format_idc=${info.hvcC?.chromaFormatIdc}`);

  const planes = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
  const expected = Buffer.from(reference.buffer, reference.byteOffset, reference.byteLength);
  let sampleIndex = 0;
  let mismatches = 0;
  for (const plane of [planes.y, planes.cb, planes.cr]) {
    for (const sample of plane) {
      if (sample !== expected.readUInt16LE(sampleIndex * 2)) mismatches++;
      sampleIndex++;
    }
  }
  if (sampleIndex !== 24_576 || reference.byteLength !== sampleIndex * 2)
    throw new Error(`${stem}: unexpected sample count or reference size`);
  if (mismatches !== 0) throw new Error(`${stem}: ${mismatches}/${sampleIndex} samples differ`);
  console.log(`${stem}: ${sampleIndex} 12-bit 4:4:4 samples match x265 reconstruction (HEIX).`);
}
