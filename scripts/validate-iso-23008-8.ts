import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { wrapHevc } from './lib/heif';
import { decodeHeic } from '../src/decoder';
import { getHeicInfo } from '../src/container/heic';
import { getFtypInfo, parseISOBMFF } from '../src/container/heif';
import { isSliceNal, splitAnnexB, toRbsp, type NalUnit } from '../src/hevc/nal';
import { decodeItemPlanes } from '../src/planes';
import { parseSps } from '../src/hevc/sps';

// ISO/IEC 23008-8:2018 ed. 2 publishes this vector inside a nested ZIP in a
// 319 MB archive. Read only the ZIP directory and the selected nested member.
const archiveUrl = 'https://standards.iso.org/iso-iec/23008/-8/ed-2/en/ISO_IEC_23008-8_Ed-2.zip';
const archiveSize = 319_335_067;
const archiveEtag = 'W/"319335067-1583161505864"';
const archiveTailSize = 1 << 20;
const variant = process.env.HEVC_ISO_VECTOR === '444' ? '444' : '422';
const is444 = variant === '444';
const archiveMemberOverride = process.env.HEVC_ISO_ARCHIVE_MEMBER;
const isCustomVector = archiveMemberOverride !== undefined;
const vectorArchiveName =
  archiveMemberOverride ??
  (is444 ? 'RExt/GENERAL_12b_444_RExt_Sony_2.zip' : 'RExt/GENERAL_12b_422_RExt_Sony_1.zip');
const vectorName =
  vectorArchiveName
    .split('/')
    .at(-1)
    ?.replace(/\.zip$/, '') ?? '';
const expectedBitstreamMd5 =
  process.env.HEVC_ISO_EXPECTED_BITSTREAM_MD5 ??
  (isCustomVector
    ? ''
    : is444
      ? 'ae9b5d4d495daa81e22479f3d8248956'
      : 'b5ea5de0b515631b37ace763c6cd3a07');
const expectedBitstreamSha256 =
  process.env.HEVC_ISO_EXPECTED_BITSTREAM_SHA256 ??
  (isCustomVector
    ? ''
    : is444
      ? '197023ccc20fd340c108646fd06b08b92fc29a613609714f6983e15d3770d669'
      : 'a3f534275c0c3d317a3dafc30a3e0eb89d3e7d6aa2f2c0df0e9d27712354700d');
const expectedCcpFrameMd5 = [
  '1e8fae11d4af2c57681034a36fd4c40f',
  'c68e9d738a12e2131dc3b945fed9e84e',
];
const expected444FrameMd5 = [
  '8e49e6ac0bf503b0fa8606ca68031cf2',
  '1297e7bc3f457a277b7b1ab496099f49',
  'bed045d5d862f6314fcde370463ae45b',
  '4a432df1e121df772e7878cdee3733b4',
  '0558d605cc28404c21b57211bbf7c831',
  '8396c58740604dd7cdf3b348fe2e83ce',
  '1d5bc5b2b6f828e848fd47d6f6a30fdf',
  '12a37d2f23578a14d531b79f82257fe0',
  ...Array<string>(2).fill(''),
  '29f1d4f39320b315379f9e8d3683c994',
  '6643556bccc56db92b9a509c0cd03302',
  ...expectedCcpFrameMd5,
];
const validateRotationPair = process.env.HEVC_ISO_REXT_ROTATION === '1';
const validateContextPair = process.env.HEVC_ISO_REXT_CONTEXT === '1';
const validateRdpcmPair = process.env.HEVC_ISO_REXT_RDPCM === '1';
const validatePersistentRicePair = process.env.HEVC_ISO_REXT_RICE === '1';
const validateExtendedPrecision = process.env.HEVC_ISO_REXT_EXTENDED_PRECISION === '1';
const decodeAllFrames = process.env.HEVC_ISO_ALL_FRAMES === '1';
assert(
  Number(validateRotationPair) +
    Number(validateContextPair) +
    Number(validateRdpcmPair) +
    Number(validatePersistentRicePair) +
    Number(validateExtendedPrecision) <=
    1,
  'Select one Range Extension vector pair',
);
assert(!validateRotationPair || is444, 'The transform-skip rotation vector is 4:4:4');
assert(!validateContextPair || is444, 'The transform-skip context vector is 4:4:4');
assert(!validateRdpcmPair || is444, 'The implicit RDPCM vector is 4:4:4');
assert(!validatePersistentRicePair || is444, 'The persistent Rice adaptation vector is 4:4:4');
assert(
  !validateExtendedPrecision || isCustomVector,
  'Extended precision uses a selected REXT vector',
);

interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function md5(data: Uint8Array): string {
  return createHash('md5').update(data).digest('hex');
}

function sha256(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function parseZipDirectory(archive: Buffer, baseOffset = 0): Map<string, ZipEntry> {
  let eocd = -1;
  const searchStart = Math.max(0, archive.length - 65_557);
  for (let p = archive.length - 22; p >= searchStart; p--) {
    if (archive.readUInt32LE(p) === 0x06054b50) {
      eocd = p;
      break;
    }
  }
  assert(eocd >= 0, 'ZIP end record was not found in the fetched range');
  const entryCount = archive.readUInt16LE(eocd + 10);
  const directorySize = archive.readUInt32LE(eocd + 12);
  const directoryOffset = archive.readUInt32LE(eocd + 16);
  const directoryStart = directoryOffset - baseOffset;
  assert(directoryStart >= 0, 'ZIP directory begins before the fetched range');
  assert(
    directoryStart + directorySize <= archive.length,
    'ZIP directory exceeds the fetched range',
  );

  const entries = new Map<string, ZipEntry>();
  let p = directoryStart;
  for (let i = 0; i < entryCount; i++) {
    assert(archive.readUInt32LE(p) === 0x02014b50, `Invalid ZIP directory entry ${i}`);
    const method = archive.readUInt16LE(p + 10);
    const crc = archive.readUInt32LE(p + 16);
    const compressedSize = archive.readUInt32LE(p + 20);
    const size = archive.readUInt32LE(p + 24);
    const nameLength = archive.readUInt16LE(p + 28);
    const extraLength = archive.readUInt16LE(p + 30);
    const commentLength = archive.readUInt16LE(p + 32);
    const localOffset = archive.readUInt32LE(p + 42);
    const name = archive.toString('utf8', p + 46, p + 46 + nameLength);
    entries.set(name, { name, method, crc, compressedSize, size, localOffset });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function decompressZipEntry(archive: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localOffset;
  assert(archive.readUInt32LE(p) === 0x04034b50, `Invalid local ZIP header for ${entry.name}`);
  const nameLength = archive.readUInt16LE(p + 26);
  const extraLength = archive.readUInt16LE(p + 28);
  const localName = archive.toString('utf8', p + 30, p + 30 + nameLength);
  assert(localName === entry.name, `ZIP entry name mismatch for ${entry.name}`);
  const start = p + 30 + nameLength + extraLength;
  const compressed = archive.subarray(start, start + entry.compressedSize);
  assert(compressed.length === entry.compressedSize, `Truncated ZIP entry ${entry.name}`);
  const data =
    entry.method === 0
      ? Buffer.from(compressed)
      : entry.method === 8
        ? inflateRawSync(compressed)
        : (() => {
            throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
          })();
  assert(data.length === entry.size, `Unexpected uncompressed size for ${entry.name}`);
  return data;
}

async function fetchRange(start: number, end: number): Promise<Buffer> {
  const response = await fetch(archiveUrl, { headers: { Range: `bytes=${start}-${end}` } });
  assert(response.status === 206, `ISO server did not honor byte range (${response.status})`);
  const contentRange = response.headers.get('content-range');
  assert(
    contentRange === `bytes ${start}-${end}/${archiveSize}`,
    `Unexpected Content-Range: ${contentRange}`,
  );
  const data = Buffer.from(await response.arrayBuffer());
  assert(data.length === end - start + 1, 'ISO server returned a truncated byte range');
  return data;
}

async function fetchZipEntry(entry: ZipEntry): Promise<Buffer> {
  const header = await fetchRange(entry.localOffset, entry.localOffset + 29);
  assert(header.readUInt32LE(0) === 0x04034b50, `Invalid local ZIP header for ${entry.name}`);
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const compressed = await fetchRange(dataStart, dataStart + entry.compressedSize - 1);
  const data =
    entry.method === 0
      ? compressed
      : entry.method === 8
        ? inflateRawSync(compressed)
        : (() => {
            throw new Error(`Unsupported ZIP compression method ${entry.method} for ${entry.name}`);
          })();
  assert(data.length === entry.size, `Unexpected uncompressed size for ${entry.name}`);
  return data;
}

function frameGroups(stream: Uint8Array): NalUnit[][] {
  const params = new Map<number, NalUnit>();
  const frames: NalUnit[][] = [];
  let current: NalUnit[] | null = null;
  for (const nal of splitAnnexB(stream)) {
    if (nal.type >= 32 && nal.type <= 34) {
      params.set(nal.type, nal);
      continue;
    }
    if (!isSliceNal(nal.type)) continue;
    if ((toRbsp(nal.data)[0] & 0x80) !== 0) {
      current = [...params.values(), nal];
      frames.push(current);
    } else {
      assert(current, 'A continuation slice appeared before the first slice of a picture');
      current.push(nal);
    }
  }
  return frames;
}

function littleEndian(samples: Uint8Array | Uint16Array): Buffer {
  if (samples instanceof Uint8Array && !(samples instanceof Uint16Array))
    return Buffer.from(samples);
  const values = samples as Uint16Array;
  const bytes = Buffer.allocUnsafe(values.length * 2);
  for (let i = 0; i < values.length; i++) bytes.writeUInt16LE(values[i], i * 2);
  return bytes;
}

const head = await fetch(archiveUrl, { method: 'HEAD' });
assert(head.ok, `ISO vector archive HEAD failed (${head.status})`);
assert(
  head.headers.get('content-length') === String(archiveSize),
  'ISO vector archive size changed',
);
assert(head.headers.get('etag') === archiveEtag, 'ISO vector archive ETag changed');

const tailStart = archiveSize - archiveTailSize;
const tail = await fetchRange(tailStart, archiveSize - 1);
const archiveEntries = parseZipDirectory(tail, tailStart);
const nestedEntry = archiveEntries.get(vectorArchiveName);
assert(nestedEntry, `Official vector archive is missing ${vectorArchiveName}`);
const nestedZip = await fetchZipEntry(nestedEntry);
const vectorEntries = parseZipDirectory(nestedZip);
const bitEntry = vectorEntries.get(`${vectorName}/${vectorName}.bit`);
const md5Entry = vectorEntries.get(`${vectorName}/${vectorName}.md5`);
assert(bitEntry && md5Entry, 'Official vector ZIP does not contain the bitstream and checksums');
const bitstream = decompressZipEntry(nestedZip, bitEntry);
const checksumText = decompressZipEntry(nestedZip, md5Entry).toString('utf8');
if (expectedBitstreamMd5)
  assert(md5(bitstream) === expectedBitstreamMd5, 'Official vector bitstream MD5 changed');
if (expectedBitstreamSha256)
  assert(
    sha256(bitstream) === expectedBitstreamSha256,
    'Official vector bitstream SHA-256 changed',
  );
const expectedOutputMd5 = checksumText.match(/^([\da-f]{32})\s+\S+_rec\.yuv$/m)?.[1];
assert(expectedOutputMd5, 'Official vector reconstruction MD5 was not found');
const frames = frameGroups(bitstream);

if (process.env.HEVC_ISO_LIST_RANGE_FLAGS === '1') {
  for (const [index, frameNals] of frames.entries()) {
    const spsNal = frameNals.find((nal) => nal.type === 33);
    assert(spsNal, `Official vector picture ${index + 1} has no SPS`);
    const sps = parseSps(spsNal.data);
    console.log(
      `frame ${index + 1}: chromaFormatIdc=${sps.chromaFormatIdc} separateColourPlane=${sps.separateColourPlane} bitDepth=${sps.bitDepthLuma} rangeFlags=${sps.rangeFlags} (0x${sps.rangeFlags.toString(16)})`,
    );
  }
  process.exit(0);
}

const selectedFrameIndexes = decodeAllFrames
  ? frames.map((_, index) => index)
  : validateRotationPair
    ? [2, 3]
    : validateContextPair
      ? [4, 5]
      : validateRdpcmPair
        ? [6, 7]
        : validatePersistentRicePair
          ? [10, 11]
          : is444
            ? [12, 13]
            : [0, 1];
const output: Buffer[] = [];
const frameHashes: string[] = [];
let extendedPrecisionFrameCount = 0;
for (const [index, frameNals] of frames.entries()) {
  // Focused checks select pairs for individual FFmpeg comparisons; the all-
  // frames mode also checks the complete official reconstruction checksum.
  if (!selectedFrameIndexes.includes(index)) continue;
  const annexB = Buffer.concat(
    frameNals.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), Buffer.from(nal.data)]),
  );
  const spsNal = frameNals.find((nal) => nal.type === 33);
  assert(spsNal, 'Official vector picture has no SPS');
  const sps = parseSps(spsNal.data);
  if (validateRotationPair)
    assert(sps.transformSkipRotationEnabled, 'The official rotation pair must enable its SPS tool');
  if (validateContextPair)
    assert(sps.transformSkipContextEnabled, 'The official context pair must enable its SPS tool');
  if (validateRdpcmPair)
    assert(sps.implicitRdpcmEnabled, 'The official RDPCM pair must enable its SPS tool');
  if (validatePersistentRicePair)
    assert(
      sps.persistentRiceAdaptationEnabled,
      'The official persistent Rice pair must enable its SPS tool',
    );
  if (validateExtendedPrecision && sps.extendedPrecisionProcessingEnabled)
    extendedPrecisionFrameCount++;
  const heif = wrapHevc(
    annexB,
    sps.picWidthInLumaSamples,
    sps.picHeightInLumaSamples,
    sps.bitDepthLuma,
    sps.chromaFormatIdc,
  );
  assert(getFtypInfo(heif)?.majorBrand === 'heix', '12-bit HEIF item must use the HEIX brand');
  const boxes = parseISOBMFF(heif);
  const info = getHeicInfo(heif, boxes);
  assert(
    info.hvcC?.generalProfileIdc === 4 && info.hvcC.chromaFormatIdc === (is444 ? 3 : 2),
    'Unexpected HEVC profile',
  );
  const planes = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
  assert(
    planes.width === sps.picWidthInLumaSamples &&
      planes.height === sps.picHeightInLumaSamples &&
      planes.chromaFormatIdc === (is444 ? 3 : 2),
    'Unexpected decoded format',
  );
  const rendered = decodeHeic(heif, { applyTransforms: false });
  assert(
    rendered.width === sps.picWidthInLumaSamples &&
      rendered.height === sps.picHeightInLumaSamples &&
      rendered.bitDepth === sps.bitDepthLuma,
    'Unexpected public HEIF render dimensions or source bit depth',
  );
  const frameBytes = Buffer.concat([
    littleEndian(planes.y),
    littleEndian(planes.cb),
    littleEndian(planes.cr),
  ]);
  output.push(frameBytes);
  frameHashes.push(md5(frameBytes));
  const frameMd5 = md5(frameBytes);
  if (is444 && !isCustomVector)
    if (expected444FrameMd5[index])
      assert(
        frameMd5 === expected444FrameMd5[index],
        `Official 4:4:4 frame ${index + 1} differs from FFmpeg reference: ${frameMd5}`,
      );
  console.log(
    `frame ${index + 1}: ${planes.width}x${planes.height} 12-bit 4:${planes.chromaFormatIdc === 2 ? '2:2' : '4:4'}${sps.extendedPrecisionProcessingEnabled ? ' extended-precision' : ''} public-render=${rendered.width}x${rendered.height}/${rendered.bitDepth}-bit md5=${frameMd5}`,
  );
}

assert(
  frameHashes.length === selectedFrameIndexes.length,
  `Expected ${selectedFrameIndexes.length} decoded pictures, got ${frameHashes.length}`,
);
if (validateExtendedPrecision)
  assert(extendedPrecisionFrameCount > 0, 'No selected picture enables extended precision');
if (is444 && isCustomVector) {
  const actualOutputMd5 = md5(Buffer.concat(output));
  assert(
    actualOutputMd5 === expectedOutputMd5,
    `Official reconstruction MD5 mismatch: ${actualOutputMd5}`,
  );
  console.log(
    `ISO/IEC 23008-8 ${vectorName}: all ${frameHashes.length} pictures match official reconstruction MD5 ${expectedOutputMd5}.`,
  );
} else if (is444 && decodeAllFrames) {
  const actualOutputMd5 = md5(Buffer.concat(output));
  assert(
    actualOutputMd5 === expectedOutputMd5,
    `Official reconstruction MD5 mismatch: ${actualOutputMd5}`,
  );
  console.log(
    `ISO/IEC 23008-8 ${vectorName}: all ${frameHashes.length} pictures match official reconstruction MD5 ${expectedOutputMd5}.`,
  );
} else if (is444) {
  assert(
    expectedOutputMd5 === '0b81d1008ff671da0d930bd38ab3489c',
    `Official vector reconstruction checksum changed: ${expectedOutputMd5}`,
  );
  console.log(
    validateRotationPair
      ? `ISO/IEC 23008-8 ${vectorName}: pictures 3–4 with transform-skip rotation enabled match FFmpeg 9.0.1 per-picture MD5s.`
      : validateContextPair
        ? `ISO/IEC 23008-8 ${vectorName}: pictures 5–6 with transform-skip context selection enabled match FFmpeg 9.0.1 per-picture MD5s.`
        : validateRdpcmPair
          ? `ISO/IEC 23008-8 ${vectorName}: pictures 7–8 with implicit RDPCM enabled match FFmpeg 9.0.1 per-picture MD5s.`
          : validatePersistentRicePair
            ? `ISO/IEC 23008-8 ${vectorName}: pictures 11–12 with persistent Rice adaptation enabled match FFmpeg 9.0.1 per-picture MD5s.`
            : validateExtendedPrecision
              ? `ISO/IEC 23008-8 ${vectorName}: all ${frameHashes.length} pictures, including ${extendedPrecisionFrameCount} with extended precision enabled, match the official reconstruction MD5.`
              : `ISO/IEC 23008-8 ${vectorName}: sequence-6 pictures 13–14 match FFmpeg reference; frame 14 exercises 12-bit 4:4:4 cross-component prediction.`,
  );
} else {
  const actualOutputMd5 = md5(Buffer.concat(output));
  assert(
    actualOutputMd5 === expectedOutputMd5,
    `Official reconstruction MD5 mismatch: ${actualOutputMd5}`,
  );
  console.log(
    `ISO/IEC 23008-8 ${vectorName}: both pictures match official reconstruction MD5 ${expectedOutputMd5}.`,
  );
}
