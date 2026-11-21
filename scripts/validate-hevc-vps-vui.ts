import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { splitAnnexB } from '../src/hevc/nal';
import { parseLayeredVps } from '../src/hevc/vps';

const baseUrl =
  'https://www.itu.int/wftp3/av-arch/jctvc-site/bitstream_exchange/draft_conformance/SHVC';

const vectors = [
  {
    archiveName: 'VUI_A_QUALCOMM_1',
    archiveSha256: '7db1296bce52d79131b3a9c1136bb7e6112886026612c2b1fc0d783639591385',
    bitstreamSha256: '46e0abd7f4fbd8a750f8f366b2e2fcbbba452f5c790d88a9b12bad8fd00455c7',
    feature: 'vps-vui',
  },
  {
    archiveName: 'VUI_B_QUALCOMM_1',
    archiveSha256: 'b4f9124ba37bfdbe6db4f8a1de7301a9b547151c56bc540d7edac5d30d50187f',
    bitstreamSha256: '170f30eca150f9d884340ba172815b28cc4e6449b0087cb647f0370113b7e0f2',
    feature: 'tiles',
  },
  {
    archiveName: 'VUI_C_QUALCOMM_1',
    archiveSha256: 'b963e02ab657bf34f345d7d03294b21663a47e208c44255779caa29b8c333671',
    bitstreamSha256: '13ec03e0a31199331b900cd0c41c9568a9a395a7b3c4d98e155740df2a5cbcc5',
    feature: 'wpp',
  },
] as const;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function findZipEntry(archive: Buffer, expectedName: string): ZipEntry {
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
  let p = archive.readUInt32LE(eocd + 16);
  assert(p + directorySize <= archive.length, 'ZIP directory exceeds the archive');
  for (let i = 0; i < entryCount; i++) {
    assert.equal(archive.readUInt32LE(p), 0x02014b50, `Invalid ZIP directory entry ${i}`);
    const nameLength = archive.readUInt16LE(p + 28);
    const extraLength = archive.readUInt16LE(p + 30);
    const commentLength = archive.readUInt16LE(p + 32);
    const name = archive.toString('utf8', p + 46, p + 46 + nameLength);
    if (name === expectedName) {
      return {
        name,
        method: archive.readUInt16LE(p + 10),
        compressedSize: archive.readUInt32LE(p + 20),
        size: archive.readUInt32LE(p + 24),
        localOffset: archive.readUInt32LE(p + 42),
      };
    }
    p += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`ZIP member not found: ${expectedName}`);
}

function extractZipEntry(archive: Buffer, entry: ZipEntry): Buffer {
  const p = entry.localOffset;
  assert.equal(archive.readUInt32LE(p), 0x04034b50, `Invalid local header for ${entry.name}`);
  const nameLength = archive.readUInt16LE(p + 26);
  const extraLength = archive.readUInt16LE(p + 28);
  const name = archive.toString('utf8', p + 30, p + 30 + nameLength);
  assert.equal(name, entry.name, `ZIP member name mismatch: ${entry.name}`);
  const start = p + 30 + nameLength + extraLength;
  const compressed = archive.subarray(start, start + entry.compressedSize);
  assert.equal(compressed.length, entry.compressedSize, `Truncated ZIP member: ${entry.name}`);
  const bytes =
    entry.method === 0
      ? Buffer.from(compressed)
      : entry.method === 8
        ? inflateRawSync(compressed)
        : (() => {
            throw new Error(`Unsupported ZIP compression method ${entry.method}`);
          })();
  assert.equal(bytes.length, entry.size, `Unexpected uncompressed size: ${entry.name}`);
  return bytes;
}

async function fetchVector(vector: (typeof vectors)[number]): Promise<Buffer> {
  const response = await fetch(`${baseUrl}/${vector.archiveName}.zip`, {
    signal: AbortSignal.timeout(30_000),
  });
  assert(response.ok, `${vector.archiveName}: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  assert.equal(
    sha256(archive),
    vector.archiveSha256,
    `${vector.archiveName}: ZIP SHA-256 mismatch`,
  );
  const bitstreamName = `${vector.archiveName}.bit`;
  const bitstream = extractZipEntry(archive, findZipEntry(archive, bitstreamName));
  assert.equal(
    sha256(bitstream),
    vector.bitstreamSha256,
    `${vector.archiveName}: bitstream SHA-256 mismatch`,
  );
  return bitstream;
}

for (const vector of vectors) {
  const nals = splitAnnexB(await fetchVector(vector));
  const vpsNals = nals.filter((nal) => nal.type === 32);
  assert(vpsNals.length > 0, `${vector.archiveName}: VPS is missing`);
  for (const nal of vpsNals) {
    const vps = parseLayeredVps(nal.data);
    assert.deepEqual(vps.layerIds, [0, 1], `${vector.archiveName}: unexpected layer ids`);
    assert(vps.vui, `${vector.archiveName}: VPS VUI was not parsed`);
    if (vector.feature === 'tiles') {
      assert.equal(
        vps.vui.tilesNotInUse,
        false,
        `${vector.archiveName}: tile syntax was not parsed`,
      );
      assert(
        vps.vui.tilesInUse.some(Boolean),
        `${vector.archiveName}: no layer tile flag was read`,
      );
    } else if (vector.feature === 'wpp') {
      assert.equal(vps.vui.wppNotInUse, false, `${vector.archiveName}: WPP syntax was not parsed`);
      assert(vps.vui.wppInUse.some(Boolean), `${vector.archiveName}: no layer WPP flag was read`);
    }
  }
  console.log(
    `${vector.archiveName}: ${vpsNals.length} official VPS VUI record(s) parsed through Annex F VUI and RBSP trailing bits.`,
  );
}
