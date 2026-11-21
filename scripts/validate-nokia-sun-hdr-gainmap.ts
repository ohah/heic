// Validate Nokia's published HDR gain-map sample without storing its image data.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { decodeHDRSync } from '../src/hdr';
import { getHeicInfo, getItemPayload } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { splitLengthPrefixed } from '../src/hevc/nal';
import { parseSps } from '../src/hevc/sps';
import { decodeItemPlanes } from '../src/planes';

const source =
  'https://raw.githubusercontent.com/nokiatech/heif/f01283f3e64ccc6e6ab489bd556d454879069185/content/personal/sun_hdr_full_gainmap.heic';
const expectedFileSha256 = '615f4d13dcb2680c54556846c5e9b0aebeb1842a422ed5f5b5e87c35edb1b6c4';
const vectors = [
  {
    id: 1002,
    chromaFormatIdc: 3,
    rangeFlags: 0,
    yuvSha256: '4133ca730b2eba7e639735cd015c543fb6d132c29feae4d96d067dfaa3239d0a',
  },
  {
    id: 1005,
    chromaFormatIdc: 0,
    rangeFlags: 486,
    yuvSha256: '9d8ac90b390a74fb024d2e6f8e9f0d2ec13f7e4eb7329bfb7765888bd3c131b3',
  },
] as const;

const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`Nokia HDR sample: HTTP ${response.status}`);
const input = new Uint8Array(await response.arrayBuffer());
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
if (hash(input) !== expectedFileSha256)
  throw new Error(`Nokia HDR sample: file SHA-256 mismatch (${hash(input)})`);

const boxes = parseISOBMFF(input);
const root = getHeicInfo(input, boxes);
if (
  root.primaryItemType !== 'tmap' ||
  root.width !== 256 ||
  root.height !== 256 ||
  root.derivedItems.join(',') !== '1002,1005'
)
  throw new Error('Nokia HDR sample: unexpected tone-map item or references');

for (const vector of vectors) {
  const info = getHeicInfo(input, boxes, vector.id);
  const config = info.hvcC;
  const payload = getItemPayload(input, boxes, vector.id);
  if (!config || !payload) throw new Error(`Item ${vector.id}: missing HEVC configuration or data`);
  const sps = parseSps(config.sps[0]);
  if (
    info.width !== 256 ||
    info.height !== 256 ||
    sps.bitDepthLuma !== 10 ||
    sps.chromaFormatIdc !== vector.chromaFormatIdc ||
    sps.rangeFlags !== vector.rangeFlags
  )
    throw new Error(`Item ${vector.id}: unexpected SPS/image configuration`);

  const nals = splitLengthPrefixed(payload, config.nalLengthSize);
  const units = [...config.vps, ...config.sps, ...config.pps, ...nals.map((nal) => nal.data)];
  const stream = Buffer.concat(
    units.flatMap((unit) => [Buffer.from([0, 0, 0, 1]), Buffer.from(unit)]),
  );
  const planes = decodeItemPlanes(input, boxes, info, vector.id);
  const samples = [planes.y, planes.cb, planes.cr].filter((plane) => plane.length > 0);
  const reconstructed = Buffer.alloc(samples.reduce((sum, plane) => sum + plane.length * 2, 0));
  let offset = 0;
  for (const plane of samples)
    for (const sample of plane) {
      reconstructed.writeUInt16LE(sample, offset);
      offset += 2;
    }

  const pixelFormat =
    sps.chromaFormatIdc === 0
      ? 'gray10le'
      : sps.chromaFormatIdc === 3
        ? 'yuv444p10le'
        : 'yuv420p10le';
  const reference = execFileSync(
    process.env.HEIC_FFMPEG ?? 'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'hevc',
      '-i',
      'pipe:0',
      '-frames:v',
      '1',
      '-pix_fmt',
      pixelFormat,
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    { input: stream, maxBuffer: 16 * 1024 * 1024 },
  );
  const actualSha256 = hash(reconstructed);
  if (!reconstructed.equals(reference) || actualSha256 !== vector.yuvSha256)
    throw new Error(`Item ${vector.id}: Y/Cb/Cr differs from FFmpeg 9.0.1 (${actualSha256})`);
  console.log(
    `Item ${vector.id}: ${samples.reduce((sum, plane) => sum + plane.length, 0)} 10-bit samples match FFmpeg 9.0.1 (rangeFlags=${sps.rangeFlags}).`,
  );
}

const toneMap = getItemPayload(input, boxes, root.primaryItemId);
if (!toneMap || toneMap[0] !== 0)
  throw new Error('Nokia HDR sample: expected ToneMapImage version 0');
const versions = new DataView(toneMap.buffer, toneMap.byteOffset, toneMap.byteLength);
const minimumVersion = versions.getUint16(1),
  writerVersion = versions.getUint16(3);
if (minimumVersion !== 512 || writerVersion !== 0)
  throw new Error(
    `Nokia HDR sample: expected minimum_version 512 / writer_version 0, got ${minimumVersion} / ${writerVersion}`,
  );

const baseOnly = decodeHDRSync(input, { displayHeadroom: 1 });
const highHeadroom = decodeHDRSync(input, { displayHeadroom: 4 });
if (
  baseOnly.source !== 'pq' ||
  highHeadroom.source !== 'pq' ||
  baseOnly.headroom !== highHeadroom.headroom ||
  !baseOnly.data.every(Number.isFinite) ||
  baseOnly.data.some((sample, index) => sample !== highHeadroom.data[index])
)
  throw new Error(
    'Nokia HDR sample: unsupported gain-map minimum version did not fall back to base',
  );

console.log(
  `ToneMapImage v0 / minimum_version ${minimumVersion} / writer_version ${writerVersion}: HDR decoding falls back to the base PQ image; the metadata version is not defined by ISO 21496-1:2025.`,
);
