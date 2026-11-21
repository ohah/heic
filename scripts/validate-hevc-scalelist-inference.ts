import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { isSliceNal, splitAnnexB, type NalUnit } from '../src/hevc/nal';
import { readSlicePpsId } from '../src/hevc/parameter-sets';
import { parsePps, resolvePpsScalingListData, type PpsInfo } from '../src/hevc/pps';
import { parseSps, resolveSpsScalingListData, type SpsInfo } from '../src/hevc/sps';
import { parseLayeredVps } from '../src/hevc/vps';

const baseUrl =
  'https://www.itu.int/wftp3/av-arch/jctvc-site/bitstream_exchange/draft_conformance/SHVC';

const vectors = [
  {
    archiveName: 'PPSSLIST_A_Sony_2',
    bitstreamSha256: 'b6d29ff39dbfc0a954df4b18db1c1e39404cafd4eaa1e3652fd837faa0f55882',
    archiveSha256: 'cd418751260d8c9f8621a80457c1f19db10c3c205c24b4cfc0e2a4f7182a2fee',
    inferredKind: 'PPS',
  },
  {
    archiveName: 'SPSSLIST_A_Sony_2',
    bitstreamSha256: 'a2d95d2483487f87a3fae263820585dc0ced031a26e1bfdddac4213e626a0006',
    archiveSha256: 'ba466304f1707f5ede0a1bd14a53f193c1cd2d9b6f456deb1065e43f94cd422e',
    inferredKind: 'SPS',
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

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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
  check(eocd >= 0, 'ZIP end record was not found');

  const entryCount = archive.readUInt16LE(eocd + 10);
  const directorySize = archive.readUInt32LE(eocd + 12);
  let p = archive.readUInt32LE(eocd + 16);
  check(p + directorySize <= archive.length, 'ZIP directory exceeds the archive');
  for (let i = 0; i < entryCount; i++) {
    check(archive.readUInt32LE(p) === 0x02014b50, `Invalid ZIP directory entry ${i}`);
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
  check(archive.readUInt32LE(p) === 0x04034b50, `Invalid local header for ${entry.name}`);
  const nameLength = archive.readUInt16LE(p + 26);
  const extraLength = archive.readUInt16LE(p + 28);
  const name = archive.toString('utf8', p + 30, p + 30 + nameLength);
  check(name === entry.name, `ZIP member name mismatch: ${entry.name}`);
  const start = p + 30 + nameLength + extraLength;
  const compressed = archive.subarray(start, start + entry.compressedSize);
  check(compressed.length === entry.compressedSize, `Truncated ZIP member: ${entry.name}`);
  const bytes =
    entry.method === 0
      ? Buffer.from(compressed)
      : entry.method === 8
        ? inflateRawSync(compressed)
        : (() => {
            throw new Error(`Unsupported ZIP compression method ${entry.method}`);
          })();
  check(bytes.length === entry.size, `Unexpected uncompressed size: ${entry.name}`);
  return bytes;
}

async function fetchVector(archiveName: string): Promise<Buffer> {
  const vector = vectors.find((candidate) => candidate.archiveName === archiveName);
  check(vector, `Unknown vector ${archiveName}`);
  const response = await fetch(`${baseUrl}/${archiveName}.zip`, {
    signal: AbortSignal.timeout(30_000),
  });
  check(response.ok, `${archiveName}: HTTP ${response.status}`);
  const archive = Buffer.from(await response.arrayBuffer());
  check(sha256(archive) === vector.archiveSha256, `${archiveName}: ZIP SHA-256 mismatch`);
  const bitstreamName = `${archiveName}/${archiveName}.bit`;
  const bitstream = extractZipEntry(archive, findZipEntry(archive, bitstreamName));
  check(sha256(bitstream) === vector.bitstreamSha256, `${archiveName}: bitstream SHA-256 mismatch`);
  return bitstream;
}

function parseParameterSets(nals: NalUnit[], vps: ReturnType<typeof parseLayeredVps>) {
  const spsByLayer = new Map<number, SpsInfo>();
  const ppsByLayer = new Map<number, PpsInfo>();
  for (const nal of nals) {
    if (nal.type === 33) {
      assert(!spsByLayer.has(nal.layerId), `duplicate SPS for layer ${nal.layerId}`);
      spsByLayer.set(
        nal.layerId,
        parseSps(nal.data, {
          allowBaseLayerMultilayerExtension: true,
          layeredVps: vps,
        }),
      );
    } else if (nal.type === 34) {
      assert(!ppsByLayer.has(nal.layerId), `duplicate PPS for layer ${nal.layerId}`);
      ppsByLayer.set(
        nal.layerId,
        parsePps(nal.data, {
          allowBaseLayerMultilayerExtension: true,
          allowMultilayerExtension: true,
          layeredVps: vps,
        }),
      );
    }
  }
  assert.deepEqual([...spsByLayer.keys()].sort(), [0, 1], 'expected one SPS per layer');
  assert.deepEqual([...ppsByLayer.keys()].sort(), [0, 1], 'expected one PPS per layer');
  return { spsByLayer, ppsByLayer };
}

for (const vector of vectors) {
  const stream = await fetchVector(vector.archiveName);
  const nals = splitAnnexB(stream);
  const vpsNals = nals.filter((nal) => nal.type === 32);
  assert(vpsNals.length > 0, `${vector.archiveName}: VPS is missing`);
  const vps = parseLayeredVps(vpsNals[0].data);
  assert.deepEqual(vps.layerIds, [0, 1], `${vector.archiveName}: unexpected layer ids`);
  assert(
    vps.referenceLayerIds?.[1].includes(0),
    `${vector.archiveName}: layer 1 must depend on layer 0`,
  );

  const { spsByLayer, ppsByLayer } = parseParameterSets(nals, vps);
  const baseSps = spsByLayer.get(0)!;
  const enhancementSps = spsByLayer.get(1)!;
  const basePps = ppsByLayer.get(0)!;
  const enhancementPps = ppsByLayer.get(1)!;
  for (const layerId of [0, 1]) {
    const slice = nals.find((nal) => nal.layerId === layerId && isSliceNal(nal.type));
    assert(slice, `${vector.archiveName}: layer ${layerId} slice is missing`);
    const activePps = ppsByLayer.get(layerId)!;
    const activeSps = spsByLayer.get(layerId)!;
    assert.equal(readSlicePpsId(slice.data), activePps.ppsId);
    assert.equal(activePps.spsId, activeSps.spsId);
  }
  assert.equal(baseSps.width, 960);
  assert.equal(baseSps.height, 540);
  assert.equal(enhancementSps.width, 1280);
  assert.equal(enhancementSps.height, 720);

  if (vector.inferredKind === 'SPS') {
    assert.equal(enhancementSps.scalingListInferred, true);
    assert.equal(enhancementSps.scalingListRefLayerId, 0);
    const resolved = resolveSpsScalingListData(enhancementSps, spsByLayer, vps);
    assert.deepEqual(resolved.scalingListData, baseSps.scalingListData);
    console.log(
      `${vector.archiveName}: SPS scaling list inferred from layer 0; resolved matrix matches the active base-layer SPS.`,
    );
  } else {
    assert.equal(enhancementPps.scalingListInferred, true);
    assert.equal(enhancementPps.scalingListRefLayerId, 0);
    assert.equal(basePps.scalingListDataPresent, true);
    const resolved = resolvePpsScalingListData(enhancementPps, ppsByLayer, spsByLayer, vps);
    assert.deepEqual(resolved, basePps.scalingListData);
    console.log(
      `${vector.archiveName}: PPS scaling list inferred from layer 0; resolved matrix matches the active base-layer PPS.`,
    );
  }
}
