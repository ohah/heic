import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { wrapHevcPredItems } from './lib/heif';
import { getHeicInfo } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { isSliceNal, splitAnnexB, toRbsp, type NalUnit } from '../src/hevc/nal';
import { parsePps } from '../src/hevc/pps';
import { parseSliceHeader, SLICE_TYPE_I, SLICE_TYPE_P } from '../src/hevc/slice-header';
import { parseSps } from '../src/hevc/sps';
import { decodeItemPlanes } from '../src/planes';

// ISO/IEC 23008-8 Ed. 2 publishes WP_A_Toshiba_3 in a nested ZIP inside its
// 319 MB archive. The bitstream is downloaded by byte range and never stored.
const archiveUrl = 'https://standards.iso.org/iso-iec/23008/-8/ed-2/en/ISO_IEC_23008-8_Ed-2.zip';
const archiveSize = 319_335_067;
const archiveEtag = 'W/"319335067-1583161505864"';
const main10 = process.env.HEVC_WEIGHTED_PRED_MAIN10 === '1';
const vectorName = main10 ? 'WP_A_MAIN10_Toshiba_3' : 'WP_A_Toshiba_3';
const expectedBitstreamMd5 = main10
  ? '5adf44f076d9fbf19db3455bedef8d88'
  : '158312a1a35ef4b20cb4aeee48549c03';
const expectedBitDepth = main10 ? 10 : 8;
// FFmpeg 9.0.1 framemd5 for pictures 0 and 1 of the official vectors.
const ffmpegFrameMd5 = main10
  ? ['9fc40d8b604ba244bb169c29d92510c4', 'f8b487da202c9a78f99f6485e1f58590']
  : ['966ff57d4c37a080de839bdab75f570f', '27c43b8a997961ad8c199ca4cd01179e'];

interface ZipEntry {
  name: string;
  method: number;
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

function parseZipDirectory(archive: Buffer, baseOffset = 0): Map<string, ZipEntry> {
  let eocd = -1;
  const searchStart = Math.max(0, archive.length - 65_557);
  for (let p = archive.length - 22; p >= searchStart; p--) {
    if (archive.readUInt32LE(p) === 0x06054b50) {
      eocd = p;
      break;
    }
  }
  assert(eocd >= 0, 'ZIP end record was not found');
  const entryCount = archive.readUInt16LE(eocd + 10);
  const directorySize = archive.readUInt32LE(eocd + 12);
  const directoryStart = archive.readUInt32LE(eocd + 16) - baseOffset;
  assert(
    directoryStart >= 0 && directoryStart + directorySize <= archive.length,
    'Invalid ZIP directory range',
  );

  const entries = new Map<string, ZipEntry>();
  let p = directoryStart;
  for (let i = 0; i < entryCount; i++) {
    assert(archive.readUInt32LE(p) === 0x02014b50, `Invalid ZIP directory entry ${i}`);
    const nameLength = archive.readUInt16LE(p + 28);
    const extraLength = archive.readUInt16LE(p + 30);
    const commentLength = archive.readUInt16LE(p + 32);
    const name = archive.toString('utf8', p + 46, p + 46 + nameLength);
    entries.set(name, {
      name,
      method: archive.readUInt16LE(p + 10),
      compressedSize: archive.readUInt32LE(p + 20),
      size: archive.readUInt32LE(p + 24),
      localOffset: archive.readUInt32LE(p + 42),
    });
    p += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function inflateZipEntry(
  archive: Buffer,
  entry: ZipEntry,
  localOffset = entry.localOffset,
): Buffer {
  assert(
    archive.readUInt32LE(localOffset) === 0x04034b50,
    `Invalid local ZIP header for ${entry.name}`,
  );
  const nameLength = archive.readUInt16LE(localOffset + 26);
  const extraLength = archive.readUInt16LE(localOffset + 28);
  const localName = archive.toString('utf8', localOffset + 30, localOffset + 30 + nameLength);
  assert(localName === entry.name, `ZIP entry name mismatch for ${entry.name}`);
  const start = localOffset + 30 + nameLength + extraLength;
  const compressed = archive.subarray(start, start + entry.compressedSize);
  assert(compressed.length === entry.compressedSize, `Truncated ZIP entry ${entry.name}`);
  const data =
    entry.method === 0
      ? Buffer.from(compressed)
      : entry.method === 8
        ? inflateRawSync(compressed)
        : (() => {
            throw new Error(`Unsupported ZIP compression method ${entry.method}`);
          })();
  assert(data.length === entry.size, `Unexpected uncompressed size for ${entry.name}`);
  return data;
}

async function fetchRange(start: number, end: number): Promise<Buffer> {
  const response = await fetch(archiveUrl, { headers: { Range: `bytes=${start}-${end}` } });
  assert(response.status === 206, `ISO archive range request failed (${response.status})`);
  assert(
    response.headers.get('content-range') === `bytes ${start}-${end}/${archiveSize}`,
    `Unexpected archive Content-Range: ${response.headers.get('content-range')}`,
  );
  const data = Buffer.from(await response.arrayBuffer());
  assert(data.length === end - start + 1, 'ISO archive returned a truncated byte range');
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
            throw new Error(`Unsupported ZIP compression method ${entry.method}`);
          })();
  assert(data.length === entry.size, `Unexpected uncompressed size for ${entry.name}`);
  return data;
}

function frameGroups(stream: Uint8Array): NalUnit[][] {
  const parameters = new Map<number, NalUnit>();
  const frames: NalUnit[][] = [];
  let current: NalUnit[] | null = null;
  for (const nal of splitAnnexB(stream)) {
    if (nal.type >= 32 && nal.type <= 34) {
      parameters.set(nal.type, nal);
      continue;
    }
    if (!isSliceNal(nal.type)) continue;
    if ((toRbsp(nal.data)[0] & 0x80) !== 0) {
      current = [...parameters.values(), nal];
      frames.push(current);
    } else {
      assert(current, 'A continuation slice appeared before the first slice of a picture');
      current.push(nal);
    }
  }
  return frames;
}

function annexB(nals: NalUnit[]): Buffer {
  return Buffer.concat(nals.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), Buffer.from(nal.data)]));
}

function yuvMd5(planes: {
  y: Uint8Array | Uint16Array;
  cb: Uint8Array | Uint16Array;
  cr: Uint8Array | Uint16Array;
}): string {
  const toBytes = (plane: Uint8Array | Uint16Array) => {
    if (plane instanceof Uint16Array) {
      const bytes = Buffer.allocUnsafe(plane.length * 2);
      for (let i = 0; i < plane.length; i++) bytes.writeUInt16LE(plane[i], i * 2);
      return bytes;
    }
    return Buffer.from(plane);
  };
  return md5(Buffer.concat([toBytes(planes.y), toBytes(planes.cb), toBytes(planes.cr)]));
}

async function fetchBitstream(): Promise<Buffer> {
  if (main10) {
    const url =
      'https://www.itu.int/wftp3/av-arch/jctvc-site/bitstream_exchange/draft_conformance/HEVC_v1/WP_A_MAIN10_Toshiba_3.zip';
    const response = await fetch(url);
    assert(response.ok, `ITU Main10 vector ZIP failed (${response.status})`);
    const zip = Buffer.from(await response.arrayBuffer());
    const entries = parseZipDirectory(zip);
    const entry = entries.get(`${vectorName}/${vectorName}.bit`);
    assert(entry, `${vectorName} ZIP is missing its bitstream`);
    return inflateZipEntry(zip, entry);
  }

  const head = await fetch(archiveUrl, { method: 'HEAD' });
  assert(head.ok, `ISO archive HEAD failed (${head.status})`);
  assert(head.headers.get('content-length') === String(archiveSize), 'ISO archive size changed');
  assert(head.headers.get('etag') === archiveEtag, 'ISO archive ETag changed');
  const tailStart = archiveSize - (1 << 20);
  const archiveEntries = parseZipDirectory(await fetchRange(tailStart, archiveSize - 1), tailStart);
  const nestedEntry = archiveEntries.get('HEVC_v1/WP_A_Toshiba_3.zip');
  assert(nestedEntry, 'ISO archive is missing WP_A_Toshiba_3.zip');
  const nestedZip = await fetchZipEntry(nestedEntry);
  const vectorEntries = parseZipDirectory(nestedZip);
  const bitEntry =
    vectorEntries.get(`${vectorName}.bit`) ?? vectorEntries.get(`${vectorName}/${vectorName}.bit`);
  assert(bitEntry, `${vectorName} ZIP is missing its bitstream`);
  return inflateZipEntry(nestedZip, bitEntry);
}

const bitstream = await fetchBitstream();
assert(md5(bitstream) === expectedBitstreamMd5, `Official ${vectorName} bitstream MD5 changed`);

const frames = frameGroups(bitstream);
assert(frames.length === 256, `Expected 256 ${vectorName} pictures, got ${frames.length}`);
const firstVcl = (frame: NalUnit[]) => frame.find((nal) => isSliceNal(nal.type));
const referenceNal = firstVcl(frames[0]);
const primaryNal = firstVcl(frames[1]);
assert(referenceNal && primaryNal, `${vectorName} first two pictures have no VCL NAL`);
const spsNal = frames[0].find((nal) => nal.type === 33);
const ppsNal = frames[0].find((nal) => nal.type === 34);
assert(spsNal && ppsNal, `${vectorName} vector is missing SPS/PPS`);
const sps = parseSps(spsNal.data);
const pps = parsePps(ppsNal.data);
assert(sps.bitDepthLuma === expectedBitDepth, `${vectorName} bit depth changed`);
const referenceHeader = parseSliceHeader(referenceNal.data, sps, pps);
const primaryHeader = parseSliceHeader(primaryNal.data, sps, pps);
assert(
  referenceHeader.sliceType === SLICE_TYPE_I,
  `${vectorName} first picture must be intra-coded`,
);
assert(primaryHeader.sliceType === SLICE_TYPE_P, `${vectorName} second picture must be P-coded`);
assert(
  pps.weightedPred && primaryHeader.weightedPrediction,
  `${vectorName} second picture must signal weighted P prediction`,
);
assert(
  primaryHeader.weightedPrediction.l0.some(
    (entry) =>
      entry.lumaWeight !== 1 << primaryHeader.weightedPrediction!.lumaLog2WeightDenom ||
      entry.lumaOffset !== 0 ||
      entry.chromaWeight.some(
        (weight) => weight !== 1 << primaryHeader.weightedPrediction!.chromaLog2WeightDenom,
      ) ||
      entry.chromaOffset.some((offset) => offset !== 0),
  ),
  `${vectorName} second picture does not exercise a non-default prediction weight or offset`,
);

const heif = wrapHevcPredItems(
  annexB(frames[0]),
  annexB(frames[1]),
  sps.picWidthInLumaSamples,
  sps.picHeightInLumaSamples,
  sps.bitDepthLuma,
  sps.chromaFormatIdc,
);
const boxes = parseISOBMFF(heif);
const primaryInfo = getHeicInfo(heif, boxes);
assert(
  primaryInfo.primaryItemId === 2 &&
    primaryInfo.predReferenceItemIds?.[0] === 1 &&
    primaryInfo.bitDepth === expectedBitDepth,
  'Synthetic HEIF pred reference is invalid',
);
const decoded = [
  decodeItemPlanes(heif, boxes, getHeicInfo(heif, boxes, 1), 1),
  decodeItemPlanes(heif, boxes, primaryInfo, 2),
];
for (let i = 0; i < decoded.length; i++) {
  const actual = yuvMd5(decoded[i]);
  assert(actual === ffmpegFrameMd5[i], `WP_A picture ${i} differs from FFmpeg 9.0.1: ${actual}`);
  console.log(
    `${vectorName} picture ${i}: ${decoded[i].width}x${decoded[i].height} ${expectedBitDepth}-bit 4:2:0 matches FFmpeg 9.0.1 framemd5 ${actual}.`,
  );
}
console.log(
  `${vectorName}: first I/P HEIF pred pair exercises explicit weighted P prediction and matches FFmpeg.`,
);
