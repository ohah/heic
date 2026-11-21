// Differentially validate HEIF `pred` item decoding against FFmpeg 9.0.1.
// The Nokia sample is copyrighted, so the script downloads it transiently.
import { createHash } from 'node:crypto';
import { getHeicInfo } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { decodeItemPlanes } from '../src/planes';

const source =
  'https://raw.githubusercontent.com/nokiatech/heif_conformance/6ff1e33481d325296d8a787432453ef3fa91f591/conformance_files/C044.heic';
const expectedFileSha256 = '550443448520e724af11734f86d51e50a8e42e3f4b5ed47debc2c5d25fdb3190';
// Hash of frame 2 (item 1004) in the FFmpeg 9.0.1 8-bit yuv420p decode of
// C044's item 1002 then item 1004 as one HEVC stream.
const expectedPrimaryYuvSha256 = '1d152a724e2d89e4bbd8dd9c17fa8770871e5b84480c1220e3f5d12f95ffbad8';

const response = await fetch(source, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error(`C044.heic: HTTP ${response.status}`);
const file = new Uint8Array(await response.arrayBuffer());
const fileSha256 = createHash('sha256').update(file).digest('hex');
if (fileSha256 !== expectedFileSha256)
  throw new Error(`C044.heic: SHA-256 mismatch (${fileSha256})`);

const boxes = parseISOBMFF(file);
const info = getHeicInfo(file, boxes);
if (
  info.primaryItemId !== 1004 ||
  info.primaryItemType !== 'hvc1' ||
  info.width !== 1280 ||
  info.height !== 720 ||
  info.bitDepth !== 8 ||
  info.hvcC?.chromaFormatIdc !== 1 ||
  info.predReferenceItemIds?.length !== 1 ||
  info.predReferenceItemIds[0] !== 1002
)
  throw new Error('C044.heic: unexpected primary item, geometry, format, or pred reference');

const referenceInfo = getHeicInfo(file, boxes, 1002);
const reference = decodeItemPlanes(file, boxes, referenceInfo, 1002);
if (reference.hasExternalInterMotion)
  throw new Error('C044.heic: expected item 1002 to be intra-coded without external motion');

const planes = decodeItemPlanes(file, boxes, info, info.primaryItemId);
const decodedSha256 = createHash('sha256')
  .update(planes.y)
  .update(planes.cb)
  .update(planes.cr)
  .digest('hex');
if (decodedSha256 !== expectedPrimaryYuvSha256)
  throw new Error(`C044.heic: decoded Y/Cb/Cr SHA-256 mismatch (${decodedSha256})`);

console.log(
  'C044: item 1004 decoded from pred reference 1002; 1,382,400 8-bit 4:2:0 samples match FFmpeg 9.0.1.',
);
