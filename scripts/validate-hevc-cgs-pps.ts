// Validate Annex F PPS parsing and Annex H pixel reconstruction against the
// official SHVC CGS_A-F conformance vectors.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { parsePps } from '../src/hevc/pps';
import { parseLayeredVps } from '../src/hevc/vps';
import { isSliceNal, splitAnnexB } from '../src/hevc/nal';
import { decodeLayeredHevcPicture } from '../src/hevc/layered-picture';
import { getHeicInfo } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { cropPlanes, decodeItemPlanes } from '../src/planes';
import { parseSps } from '../src/hevc/sps';
import { decodeHeic } from '../src/decoder';
import { box, buildHeif, full, u16, u32 } from '../test/helpers/heif';

const baseUrl =
  'https://www.itu.int/wftp3/av-arch/jctvc-site/bitstream_exchange/draft_conformance/SHVC';
let archiveName = 'CGS_A_TECHNICOLOR_1';
const archiveSha256 = 'f1526b6b87877326ab84d90b23f68707b6ba99152375710863d3f96530bb2e7b';
const bitstreamSha256 = '7b12434844a9efee81a4cdf4d9a01bdc41f0434a1f145868638de0d4f144937e';

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
  assert.notEqual(eocd, -1, 'ZIP end record was not found');

  const entryCount = archive.readUInt16LE(eocd + 10);
  const directorySize = archive.readUInt32LE(eocd + 12);
  let p = archive.readUInt32LE(eocd + 16);
  assert(p + directorySize <= archive.length, 'ZIP directory exceeds the archive');
  for (let i = 0; i < entryCount; i++) {
    assert.equal(archive.readUInt32LE(p), 0x02014b50, `invalid ZIP directory entry ${i}`);
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
  assert.equal(archive.readUInt32LE(p), 0x04034b50, `invalid ZIP local header for ${entry.name}`);
  const nameLength = archive.readUInt16LE(p + 26);
  const extraLength = archive.readUInt16LE(p + 28);
  const name = archive.toString('utf8', p + 30, p + 30 + nameLength);
  assert.equal(name, entry.name, `ZIP member name mismatch: ${entry.name}`);
  const start = p + 30 + nameLength + extraLength;
  const compressed = archive.subarray(start, start + entry.compressedSize);
  assert.equal(compressed.length, entry.compressedSize, `truncated ZIP member: ${entry.name}`);
  const bytes =
    entry.method === 0
      ? Buffer.from(compressed)
      : entry.method === 8
        ? inflateRawSync(compressed)
        : (() => {
            throw new Error(`unsupported ZIP compression method ${entry.method}`);
          })();
  assert.equal(bytes.length, entry.size, `unexpected uncompressed size: ${entry.name}`);
  return bytes;
}

const response = await fetch(`${baseUrl}/${archiveName}.zip`, {
  signal: AbortSignal.timeout(30_000),
});
assert(response.ok, `${archiveName}: HTTP ${response.status}`);
let archive = Buffer.from(await response.arrayBuffer());
assert.equal(sha256(archive), archiveSha256, `${archiveName}: archive SHA-256 mismatch`);
const stream = extractZipEntry(archive, findZipEntry(archive, `${archiveName}.bit`));
assert.equal(sha256(stream), bitstreamSha256, `${archiveName}: bitstream SHA-256 mismatch`);

let nals = splitAnnexB(stream);
const vpsNal = nals.find((nal) => nal.type === 32);
assert(vpsNal, `${archiveName}: VPS is missing`);
const vps = parseLayeredVps(vpsNal.data);
assert.deepEqual(vps.layerIds, [0, 1], `${archiveName}: unexpected layer ids`);
assert(vps.referenceLayerIds?.[1].includes(0), `${archiveName}: layer 1 must depend on layer 0`);

const ppsByLayer = new Map<number, ReturnType<typeof parsePps>>();
for (const nal of nals) {
  if (nal.type !== 34) continue;
  assert(!ppsByLayer.has(nal.layerId), `${archiveName}: duplicate PPS for layer ${nal.layerId}`);
  ppsByLayer.set(
    nal.layerId,
    parsePps(nal.data, {
      allowBaseLayerMultilayerExtension: true,
      allowMultilayerExtension: true,
      layeredVps: vps,
    }),
  );
}
assert.deepEqual(
  [...ppsByLayer.keys()].sort(),
  [0, 1],
  `${archiveName}: expected PPS for both layers`,
);

const baseTable = ppsByLayer.get(0)!.colourMappingTable;
assert.equal(baseTable, null, `${archiveName}: base-layer PPS unexpectedly carries a colour table`);
const table = ppsByLayer.get(1)!.colourMappingTable;
assert(table, `${archiveName}: enhancement-layer PPS colour table is missing`);
assert.equal(table.numCmRefLayersMinus1, 0);
assert.deepEqual(table.cmRefLayerIds, [0]);
assert.equal(table.cmOctantDepth, 1);
assert.equal(table.lumaBitDepthCmInput, 8);
assert.equal(table.chromaBitDepthCmInput, 8);
assert.equal(table.lumaBitDepthCmOutput, 10);
assert.equal(table.chromaBitDepthCmOutput, 10);
assert.equal(table.octants.children.length, 8, `${archiveName}: root octant was not split`);
assert(
  table.octants.children.every((child) => child.children.length === 0 && child.yParts.length > 0),
  `${archiveName}: split octants were not parsed as leaves`,
);

function md5PlanarPicture(
  planes: {
    y: Uint8Array | Uint16Array;
    cb: Uint8Array | Uint16Array;
    cr: Uint8Array | Uint16Array;
  },
  bitDepth: number,
): string {
  const hash = createHash('md5');
  for (const plane of [planes.y, planes.cb, planes.cr]) {
    if (bitDepth <= 8) {
      hash.update(plane);
      continue;
    }
    const bytes = Buffer.alloc(plane.length * 2);
    for (let i = 0; i < plane.length; i++) bytes.writeUInt16LE(plane[i], i * 2);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function cropConformanceWindow(
  planes: Parameters<typeof cropPlanes>[0],
  sps: ReturnType<typeof parseSps>,
) {
  // The H.265.1 archive picture hashes are for output after the SPS window crop.
  const subWidth = sps.chromaFormatIdc === 1 || sps.chromaFormatIdc === 2 ? 2 : 1;
  const subHeight = sps.chromaFormatIdc === 1 ? 2 : 1;
  return cropPlanes(
    planes,
    subWidth * sps.cropLeft,
    subHeight * sps.cropTop,
    sps.width,
    sps.height,
  );
}

class BitWriter {
  private readonly bits: number[] = [];

  write(value: number, width: number): void {
    for (let shift = width - 1; shift >= 0; shift--)
      this.bits.push(Math.floor(value / 2 ** shift) % 2);
  }

  finish(): Uint8Array {
    while (this.bits.length % 8) this.bits.push(0);
    const bytes = new Uint8Array(this.bits.length / 8);
    for (let i = 0; i < this.bits.length; i++) bytes[i >> 3] |= this.bits[i] << (7 - (i & 7));
    return bytes;
  }
}

function makeOinf(): Uint8Array {
  const bits = new BitWriter();
  bits.write(0, 8); // FullBox version
  bits.write(0, 24); // FullBox flags
  bits.write(0x4000, 16); // one scalability dimension
  bits.write(0, 2); // reserved
  bits.write(2, 6); // two profile_tier_level entries
  for (const profileIdc of [1, 2]) {
    bits.write(0, 2); // general_profile_space
    bits.write(0, 1); // general_tier_flag
    bits.write(profileIdc, 5);
    bits.write(0, 32); // general_profile_compatibility_flags
    bits.write(0, 48); // general_constraint_indicator_flags
    bits.write(123, 8); // general_level_idc
  }
  bits.write(1, 16); // operating_point_count
  bits.write(1, 16); // output_layer_set_idx
  bits.write(1, 8); // max_temporal_id
  bits.write(2, 8); // num_layers_in_output_layer_set
  for (const [ptlIndex, layerId, isOutputLayer] of [
    [1, 0, 0],
    [2, 1, 1],
  ]) {
    bits.write(ptlIndex, 8);
    bits.write(layerId, 6);
    bits.write(isOutputLayer, 1);
    bits.write(0, 1); // is_alternate_output_layer
  }
  bits.write(0, 16); // min_pic_width
  bits.write(0, 16); // min_pic_height
  bits.write(1920, 16); // max_pic_width
  bits.write(1080, 16); // max_pic_height
  bits.write(1, 2); // max_chroma_format (4:2:0)
  bits.write(2, 3); // max_bit_depth_minus8
  bits.write(0, 1); // reserved
  bits.write(0, 1); // frame_rate_info_flag
  bits.write(0, 1); // bit_rate_info_flag
  bits.write(1, 8); // max_layer_count
  bits.write(1, 8); // enhancement layer id
  bits.write(1, 8); // dependency count
  bits.write(0, 8); // base layer dependency
  bits.write(1, 8); // scalability dimension id
  return bits.finish();
}

function makeLhvC(): Uint8Array {
  const parameterSets = new Map<number, Uint8Array[]>();
  for (const nal of nals) {
    if (![32, 33, 34].includes(nal.type)) continue;
    const list = parameterSets.get(nal.type) ?? [];
    list.push(nal.data);
    parameterSets.set(nal.type, list);
  }
  const arrays = [...parameterSets].map(([type, units]) =>
    Buffer.concat([
      Buffer.from([0x80 | type]), // array_completeness and NAL unit type
      u16(units.length),
      ...units.flatMap((unit) => [u16(unit.length), unit]),
    ]),
  );
  return Buffer.concat([Buffer.from([1, 0xf0, 0, 0xfc, 0xe7, arrays.length]), ...arrays]);
}

function makeLhevcHeif(): Uint8Array {
  const itemPayload = Buffer.concat(
    nals
      .filter((nal) => isSliceNal(nal.type))
      .map((nal) => Buffer.concat([u32(nal.data.length), nal.data])),
  );
  return buildHeif(
    [
      {
        id: 1,
        type: 'lhv1',
        data: itemPayload,
        properties: [
          box('lhvC', makeLhvC()),
          box('oinf', makeOinf()),
          box('tols', Buffer.from([0, 0, 0, 0, 0, 1])),
          full('ispe', 0, u32(1920), u32(1080)),
          full('pixi', 0, Buffer.from([3, 10, 10, 10])),
          box(
            'colr',
            Buffer.concat([Buffer.from('nclx'), u16(9), u16(16), u16(9), Buffer.from([128])]),
          ),
        ],
      },
    ],
    1,
  );
}

const baseExpectedMd5 = extractZipEntry(archive, findZipEntry(archive, `${archiveName}-l0.md5`))
  .toString('ascii')
  .trim();
const enhancementExpectedMd5 = extractZipEntry(
  archive,
  findZipEntry(archive, `${archiveName}-l1.md5`),
)
  .toString('ascii')
  .trim();
const basePicture = decodeLayeredHevcPicture(nals, [0], 0);
const baseActualMd5 = md5PlanarPicture(basePicture, basePicture.bitDepthLuma ?? 8);
assert.equal(baseActualMd5, baseExpectedMd5, `${archiveName}: base-layer picture hash mismatch`);

const enhancementPicture = decodeLayeredHevcPicture(nals, [0, 1], 1);
const enhancementActualMd5 = md5PlanarPicture(
  enhancementPicture,
  enhancementPicture.bitDepthLuma ?? 8,
);
assert.equal(
  enhancementActualMd5,
  enhancementExpectedMd5,
  `${archiveName}: enhancement-layer picture hash mismatch`,
);

const heif = makeLhevcHeif();
const boxes = parseISOBMFF(heif);
const info = getHeicInfo(heif, boxes);
assert.equal(info.primaryItemType, 'lhv1');
assert.deepEqual(info.lhevc?.requiredLayerIds, [0, 1]);
const heifPicture = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
assert.equal(
  md5PlanarPicture(heifPicture, heifPicture.bitDepthLuma ?? 8),
  enhancementExpectedMd5,
  `${archiveName}: L-HEVC HEIF item picture hash mismatch`,
);
const rendered = decodeHeic(heif);
assert.equal(rendered.width, 1920);
assert.equal(rendered.height, 1080);
assert.equal(rendered.bitDepth, 10);

console.log(
  `${archiveName}: official base/enhancement hashes match; the L-HEVC HEIF item also decodes and renders at 1920x1080 10-bit.`,
);

async function validateAdditionalCgsVector(vector: {
  archiveName: string;
  archiveSha256: string;
  bitstreamSha256: string;
  inputBitDepth: number;
  octantDepth: number;
  baseWidth?: number;
  baseHeight?: number;
  displayBaseHeight?: number;
}): Promise<void> {
  const cgsArchiveName = vector.archiveName;
  const cgsResponse = await fetch(`${baseUrl}/${cgsArchiveName}.zip`, {
    signal: AbortSignal.timeout(30_000),
  });
  assert(cgsResponse.ok, `${cgsArchiveName}: HTTP ${cgsResponse.status}`);
  const cgsArchive = Buffer.from(await cgsResponse.arrayBuffer());
  assert.equal(
    sha256(cgsArchive),
    vector.archiveSha256,
    `${cgsArchiveName}: archive SHA-256 mismatch`,
  );
  const cgsStream = extractZipEntry(cgsArchive, findZipEntry(cgsArchive, `${cgsArchiveName}.bit`));
  assert.equal(
    sha256(cgsStream),
    vector.bitstreamSha256,
    `${cgsArchiveName}: bitstream SHA-256 mismatch`,
  );
  const cgsNals = splitAnnexB(cgsStream);

  const cgsVpsNal = cgsNals.find((nal) => nal.type === 32);
  assert(cgsVpsNal, `${cgsArchiveName}: VPS is missing`);
  const cgsVps = parseLayeredVps(cgsVpsNal.data);
  assert.deepEqual(cgsVps.layerIds, [0, 1], `${cgsArchiveName}: unexpected layer ids`);
  assert(
    cgsVps.referenceLayerIds?.[1].includes(0),
    `${cgsArchiveName}: layer 1 must depend on layer 0`,
  );
  const cgsSpsByLayer = new Map<number, ReturnType<typeof parseSps>>();
  for (const nal of cgsNals) {
    if (nal.type !== 33) continue;
    cgsSpsByLayer.set(
      nal.layerId,
      parseSps(nal.data, {
        allowBaseLayerMultilayerExtension: true,
        layeredVps: cgsVps,
      }),
    );
  }

  const cgsPpsByLayer = new Map<number, ReturnType<typeof parsePps>>();
  for (const nal of cgsNals) {
    if (nal.type !== 34) continue;
    assert(
      !cgsPpsByLayer.has(nal.layerId),
      `${cgsArchiveName}: duplicate PPS for layer ${nal.layerId}`,
    );
    cgsPpsByLayer.set(
      nal.layerId,
      parsePps(nal.data, {
        allowBaseLayerMultilayerExtension: true,
        allowMultilayerExtension: true,
        layeredVps: cgsVps,
      }),
    );
  }
  assert.deepEqual(
    [...cgsPpsByLayer.keys()].sort(),
    [0, 1],
    `${cgsArchiveName}: expected PPS for both layers`,
  );
  assert.equal(cgsPpsByLayer.get(0)!.colourMappingTable, null);
  const cgsTable = cgsPpsByLayer.get(1)!.colourMappingTable;
  assert(cgsTable, `${cgsArchiveName}: enhancement-layer PPS colour table is missing`);
  assert.equal(cgsTable.numCmRefLayersMinus1, 0);
  assert.deepEqual(cgsTable.cmRefLayerIds, [0]);
  assert.equal(cgsTable.cmOctantDepth, vector.octantDepth);
  assert.equal(cgsTable.lumaBitDepthCmInput, vector.inputBitDepth);
  assert.equal(cgsTable.chromaBitDepthCmInput, vector.inputBitDepth);
  assert.equal(cgsTable.lumaBitDepthCmOutput, 10);
  assert.equal(cgsTable.chromaBitDepthCmOutput, 10);
  if (vector.octantDepth === 0) {
    assert.equal(
      cgsTable.octants.children.length,
      0,
      `${cgsArchiveName}: depth-zero root should be a leaf`,
    );
    assert(cgsTable.octants.yParts.length > 0, `${cgsArchiveName}: root leaf has no luma parts`);
  } else {
    assert.equal(
      cgsTable.octants.children.length,
      8,
      `${cgsArchiveName}: root octant was not split`,
    );
    assert(
      cgsTable.octants.children.every(
        (child) => child.children.length === 0 && child.yParts.length > 0,
      ),
      `${cgsArchiveName}: split octants were not parsed as leaves`,
    );
  }

  const cgsBaseExpectedMd5 = extractZipEntry(
    cgsArchive,
    findZipEntry(cgsArchive, `${cgsArchiveName}-l0.md5`),
  )
    .toString('ascii')
    .trim();
  const cgsEnhancementExpectedMd5 = extractZipEntry(
    cgsArchive,
    findZipEntry(cgsArchive, `${cgsArchiveName}-l1.md5`),
  )
    .toString('ascii')
    .trim();
  const cgsBasePicture = decodeLayeredHevcPicture(cgsNals, [0], 0);
  assert.equal(cgsBasePicture.width, vector.baseWidth ?? 1920);
  assert.equal(cgsBasePicture.height, vector.baseHeight ?? 1080);
  const cgsBaseSps = cgsSpsByLayer.get(0);
  assert(cgsBaseSps, `${cgsArchiveName}: base-layer SPS is missing`);
  assert.equal(cgsBaseSps.width, vector.baseWidth ?? 1920);
  assert.equal(cgsBaseSps.height, vector.displayBaseHeight ?? 1080);
  assert.equal(
    md5PlanarPicture(
      cropConformanceWindow(cgsBasePicture, cgsBaseSps),
      cgsBasePicture.bitDepthLuma ?? 8,
    ),
    cgsBaseExpectedMd5,
    `${cgsArchiveName}: base-layer picture hash mismatch`,
  );
  const cgsEnhancementPicture = decodeLayeredHevcPicture(cgsNals, [0, 1], 1);
  const cgsEnhancementSps = cgsSpsByLayer.get(1);
  assert(cgsEnhancementSps, `${cgsArchiveName}: enhancement-layer SPS is missing`);
  assert.equal(cgsEnhancementSps.width, 1920);
  assert.equal(cgsEnhancementSps.height, 1080);
  assert.equal(
    md5PlanarPicture(
      cropConformanceWindow(cgsEnhancementPicture, cgsEnhancementSps),
      cgsEnhancementPicture.bitDepthLuma ?? 8,
    ),
    cgsEnhancementExpectedMd5,
    `${cgsArchiveName}: enhancement-layer picture hash mismatch`,
  );

  const cgsHeif = makeLhevcHeif();
  const cgsBoxes = parseISOBMFF(cgsHeif);
  const cgsInfo = getHeicInfo(cgsHeif, cgsBoxes);
  assert.deepEqual(cgsInfo.lhevc?.requiredLayerIds, [0, 1]);
  const cgsHeifPicture = decodeItemPlanes(cgsHeif, cgsBoxes, cgsInfo, cgsInfo.primaryItemId);
  const cgsHeifSps = cgsSpsByLayer.get(1);
  assert(cgsHeifSps, `${cgsArchiveName}: HEIF output-layer SPS is missing`);
  assert.equal(
    md5PlanarPicture(
      cropConformanceWindow(cgsHeifPicture, cgsHeifSps),
      cgsHeifPicture.bitDepthLuma ?? 8,
    ),
    cgsEnhancementExpectedMd5,
    `${cgsArchiveName}: L-HEVC HEIF item picture hash mismatch`,
  );
  const cgsRendered = decodeHeic(cgsHeif);
  assert.equal(cgsRendered.width, 1920);
  assert.equal(cgsRendered.height, 1080);
  assert.equal(cgsRendered.bitDepth, 10);
  console.log(
    `${cgsArchiveName}: official base/enhancement hashes match; the L-HEVC HEIF item also decodes and renders at 1920x1080 10-bit.`,
  );
}

for (const vector of [
  {
    archiveName: 'CGS_B_TECHNICOLOR_1',
    archiveSha256: '6902a8c903a3f6d9b40f5a338dd820d43f68f8f57fc086bdc744fbce5b97d6aa',
    bitstreamSha256: 'd16b6fb26aed4d38b947a1d29c262415ac71d499a3dbd61018c06554d79f9585',
    inputBitDepth: 8,
    octantDepth: 0,
  },
  {
    archiveName: 'CGS_C_TECHNICOLOR_1',
    archiveSha256: '9326dc348ba3ef701ab5437f314390c8a64746ed15dbe3fdd5289f270befd370',
    bitstreamSha256: 'da10735b21b7aed6b9f076c4a5850d1427d571135d0e912152cc385715ce7bc5',
    inputBitDepth: 10,
    octantDepth: 1,
  },
  {
    archiveName: 'CGS_D_TECHNICOLOR_1',
    archiveSha256: '0843a5d40b58679379b25ddc24daaa22d47f7f5786c500494c375c684e25e30e',
    bitstreamSha256: 'abb05aa1121e8b5a29dee7b6456cb6c6c00d8d2e02f316bd7cec1d21315d7993',
    inputBitDepth: 10,
    octantDepth: 0,
  },
  {
    archiveName: 'CGS_E_TECHNICOLOR_1',
    archiveSha256: '507ed4d8a89235633921f44f7e7c7a14d498e576dfad9e798a6fa96a9230e3a7',
    bitstreamSha256: '84b6c61bbd3aa5e27792ad9e3b9cafa0999d755d3e81845768d39e86eab95ec3',
    inputBitDepth: 8,
    octantDepth: 1,
    baseWidth: 960,
    baseHeight: 544,
    displayBaseHeight: 540,
  },
  {
    archiveName: 'CGS_F_TECHNICOLOR_1',
    archiveSha256: 'cb8ff0e5879ac85723aeb3e2fce80651afc51a3a856c31e83d54bbc33412d4a8',
    bitstreamSha256: '22b64a3019f3e584942608c4092bbf4e1906fddd22df3c963853abf869bcfc08',
    inputBitDepth: 8,
    octantDepth: 0,
    baseWidth: 960,
    baseHeight: 544,
    displayBaseHeight: 540,
  },
]) {
  await validateAdditionalCgsVector(vector);
}
