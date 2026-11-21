// Validate HEIF `exbl` external-base-layer decoding against the official
// H.265.1 HYBRID_A_QUALCOMM_1 vector.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { decodeHeic } from '../src/decoder';
import { decode } from '../src/async';
import { getHeicInfo, type HvcCConfig } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { splitAnnexB, type NalUnit, toRbsp } from '../src/hevc/nal';
import { parseSps } from '../src/hevc/sps';
import { parseLayeredVps } from '../src/hevc/vps';
import { decodeItemPlanes, type Planes } from '../src/planes';
import { box, buildHeif, full, u16, u32 } from '../test/helpers/heif';

const archiveUrl =
  'https://www.itu.int/wftp3/av-arch/jctvc-site/bitstream_exchange/draft_conformance/SHVC/HYBRID_A_QUALCOMM_1.zip';
const archiveSha256 = 'f22bee7b0fec0536df5a44983122d82e547625bdcdbf1ccd877142f1523a8962';
const bitstreamSha256 = 'b92f76fec3e159e0fad9326741df700f6a55421892f3f673f319b47cf9138288';
const baseSequenceMd5 = 'fa64947a1e83e915d250c5164bfaafb3';
const baseFrameFixtureSha256 = '3da5626daa68b3d5b2a2882a8e729284ab75988f3474aa9a35df99f2ab8dfe2b';
const expectedLayer1Poc0Md5 = [
  '905abaa49827d368585af61dc5647c30',
  'c17c85c0cd5d09e75f05c57b2c6eef82',
  'ad74ca8ec35ae9b79550ef162102173a',
];

type ZipEntry = {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
};

function digest(bytes: Uint8Array, algorithm: 'md5' | 'sha256'): string {
  return createHash(algorithm).update(bytes).digest('hex');
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
    if (name === expectedName)
      return {
        name,
        method: archive.readUInt16LE(p + 10),
        compressedSize: archive.readUInt32LE(p + 20),
        size: archive.readUInt32LE(p + 24),
        localOffset: archive.readUInt32LE(p + 42),
      };
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
  bits.write(0x4000, 16); // spatial scalability dimension
  bits.write(0, 2); // reserved
  bits.write(2, 6); // profile_tier_level_count
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
  bits.write(0, 3); // max_bit_depth_minus8
  bits.write(0, 1); // reserved
  bits.write(0, 1); // frame_rate_info_flag
  bits.write(0, 1); // bit_rate_info_flag
  bits.write(1, 8); // max_layer_count
  bits.write(1, 8); // enhancement layer id
  bits.write(1, 8); // dependency count
  bits.write(0, 8); // base layer dependency
  bits.write(1, 8); // spatial scalability dimension id
  return bits.finish();
}

function makeLhvC(nals: readonly NalUnit[]): Uint8Array {
  const parameterSets = new Map<number, Uint8Array[]>();
  for (const nal of nals) {
    if (![32, 33, 34].includes(nal.type)) continue;
    const list = parameterSets.get(nal.type) ?? [];
    list.push(nal.data);
    parameterSets.set(nal.type, list);
  }
  const arrays = [...parameterSets].map(([type, units]) =>
    Buffer.concat([
      Buffer.from([0x80 | type]),
      u16(units.length),
      ...units.flatMap((unit) => [u16(unit.length), unit]),
    ]),
  );
  return Buffer.concat([Buffer.from([1, 0xf0, 0, 0xfc, 0xe7, arrays.length]), ...arrays]);
}

function makeHvcC(nals: readonly NalUnit[]): { data: Uint8Array; config: HvcCConfig } {
  const parameterSets = new Map<number, Uint8Array[]>();
  for (const nal of nals) {
    if (![32, 33, 34].includes(nal.type)) continue;
    const list = parameterSets.get(nal.type) ?? [];
    list.push(nal.data);
    parameterSets.set(nal.type, list);
  }
  const spsNal = parameterSets.get(33)?.[0];
  assert(spsNal, 'lossless external-base fixture has no SPS');
  const sps = parseSps(spsNal);
  const rbsp = toRbsp(spsNal);
  const header = Buffer.alloc(23);
  header[0] = 1;
  header.set(rbsp.subarray(1, 13), 1);
  header[13] = 0xf0;
  header[15] = 0xfc;
  header[16] = 0xfc | sps.chromaFormatIdc;
  header[17] = 0xf8 | (sps.bitDepthLuma - 8);
  header[18] = 0xf8 | (sps.bitDepthChroma - 8);
  header[21] = ((((rbsp[0] >> 1) & 7) + 1) << 3) | ((rbsp[0] & 1) << 2) | 3;
  header[22] = parameterSets.size;
  const arrays = [...parameterSets].map(([type, units]) =>
    Buffer.concat([
      Buffer.from([0x80 | type]),
      u16(units.length),
      ...units.flatMap((unit) => [u16(unit.length), unit]),
    ]),
  );
  const data = Buffer.concat([header, ...arrays]);
  return {
    data,
    config: {
      configurationVersion: 1,
      generalProfileIdc: rbsp[1] & 0x1f,
      generalLevelIdc: rbsp[12],
      chromaFormatIdc: sps.chromaFormatIdc,
      bitDepthLumaMinus8: sps.bitDepthLuma - 8,
      bitDepthChromaMinus8: sps.bitDepthChroma - 8,
      nalLengthSize: 4,
      vps: parameterSets.get(32) ?? [],
      sps: parameterSets.get(33) ?? [],
      pps: parameterSets.get(34) ?? [],
    },
  };
}

function md5Planes(planes: Planes): string[] {
  return [planes.y, planes.cb, planes.cr].map((plane) => digest(plane, 'md5'));
}

function makeHybridHeif(
  baseNals: readonly NalUnit[],
  enhancementNals: readonly NalUnit[],
  baseYuvFrame: Uint8Array,
  externalBaseUrl?: string,
  baseItemType: 'hvc1' | 'avc1' = 'hvc1',
): Uint8Array {
  const baseConfig = makeHvcC(baseNals);
  const basePayload = Buffer.concat(
    baseNals
      .filter((nal) => nal.type < 32)
      .map((nal) => Buffer.concat([u32(nal.data.length), nal.data])),
  );
  const enhancementPayload = Buffer.concat(
    enhancementNals
      .filter((nal) => nal.type < 32)
      .map((nal) => Buffer.concat([u32(nal.data.length), nal.data])),
  );
  const basePicture = {
    id: 2,
    type: baseItemType,
    data: baseItemType === 'hvc1' ? basePayload : new Uint8Array(),
    properties: [
      ...(baseItemType === 'hvc1'
        ? [box('hvcC', baseConfig.data)]
        : [
            // The injected-plane path does not parse this synthetic AVC base.
            // Keep a structurally complete AVCDecoderConfigurationRecord.
            box(
              'avcC',
              Buffer.from([
                1, 0x42, 0xc0, 0x1e, 0xff, 0xe1, 0, 13, 0x67, 0x42, 0xc0, 0x1e, 0xda, 0x02, 0x80,
                0xb7, 0xfe, 0x05, 0x05, 0x05, 0x02, 1, 0, 4, 0x68, 0xce, 0x3c, 0x80,
              ]),
            ),
          ]),
      full('ispe', 0, u32(1280), u32(720)),
      full('pixi', 0, Buffer.from([3, 8, 8, 8])),
    ],
    ...(externalBaseUrl
      ? { dataReference: full('url ', 0, Buffer.from(`${externalBaseUrl}\0`)) }
      : {}),
  };
  const enhancementPicture = {
    id: 1,
    type: 'lhv1',
    data: enhancementPayload,
    properties: [
      box('lhvC', makeLhvC(enhancementNals)),
      box('oinf', makeOinf()),
      box('tols', Buffer.from([0, 0, 0, 0, 0, 1])),
      full('ispe', 0, u32(1920), u32(1080)),
      full('pixi', 0, Buffer.from([3, 8, 8, 8])),
      full('rref', 0, Buffer.from([1]), Buffer.from('exbl')),
    ],
    refs: [{ type: 'exbl', to: [2] }],
  };
  const heif = Buffer.from(buildHeif([basePicture, enhancementPicture], 1));
  // The Scalable Main image item uses the HEVC extended brand.
  heif.set(Buffer.from('heix'), 8);
  heif.set(Buffer.from('heixmif1'), 16);
  assert.equal(baseYuvFrame.length, (1280 * 720 * 3) / 2);
  return heif;
}

const cachedArchivePath = process.env.HEVC_EXBL_ARCHIVE;
let archive: Buffer;
if (cachedArchivePath) {
  archive = readFileSync(cachedArchivePath);
} else {
  const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(360_000) });
  assert(response.ok, `HYBRID_A_QUALCOMM_1: HTTP ${response.status}`);
  archive = Buffer.from(await response.arrayBuffer());
}
assert.equal(digest(archive, 'sha256'), archiveSha256, 'official archive SHA-256 mismatch');
const bitstream = extractZipEntry(archive, findZipEntry(archive, 'HYBRID_A_QUALCOMM_1.bit'));
const baseSequence = extractZipEntry(archive, findZipEntry(archive, 'BaseLayerSequence.yuv'));
const expectedOpl = extractZipEntry(
  archive,
  findZipEntry(archive, 'HYBRID_A_QUALCOMM_1-OLS1.opl'),
).toString('ascii');
assert.equal(digest(bitstream, 'sha256'), bitstreamSha256, 'official bitstream SHA-256 mismatch');
assert.equal(digest(baseSequence, 'md5'), baseSequenceMd5, 'official base sequence MD5 mismatch');
assert.match(expectedOpl, /1\s+0\s+MD5:905abaa49827d368585af61dc5647c30/);

const baseFixture = new Uint8Array(
  readFileSync(
    new URL('../test/fixtures/regressions/hevc-exbl/base-layer-frame-0.hevc', import.meta.url),
  ),
);
assert.equal(
  digest(baseFixture, 'sha256'),
  baseFrameFixtureSha256,
  'lossless base-layer fixture SHA-256 mismatch',
);
const baseNals = splitAnnexB(baseFixture);
const baseFrameSize = (1280 * 720 * 3) / 2;
const baseFrame = baseSequence.subarray(0, baseFrameSize);
const baseChromaPlaneSize = 640 * 360;
const basePlanes: Planes = {
  y: baseFrame.subarray(0, 1280 * 720),
  cb: baseFrame.subarray(1280 * 720, 1280 * 720 + baseChromaPlaneSize),
  cr: baseFrame.subarray(1280 * 720 + baseChromaPlaneSize),
  width: 1280,
  height: 720,
  chromaFormatIdc: 1,
  bitDepthLuma: 8,
  bitDepthChroma: 8,
};
const baseItemPayload = Buffer.concat(
  baseNals
    .filter((nal) => nal.type < 32)
    .map((nal) => Buffer.concat([u32(nal.data.length), nal.data])),
);
const baseOnlyHeif = Buffer.from(
  buildHeif(
    [
      {
        id: 2,
        type: 'hvc1',
        data: baseItemPayload,
        properties: [
          box('hvcC', makeHvcC(baseNals).data),
          full('ispe', 0, u32(1280), u32(720)),
          full('pixi', 0, Buffer.from([3, 8, 8, 8])),
        ],
      },
    ],
    2,
  ),
);
const baseOnlyBoxes = parseISOBMFF(baseOnlyHeif);
const decodedBase = decodeItemPlanes(
  baseOnlyHeif,
  baseOnlyBoxes,
  getHeicInfo(baseOnlyHeif, baseOnlyBoxes, 2),
  2,
);
assert.equal(
  Buffer.compare(Buffer.from(decodedBase.y), Buffer.from(basePlanes.y)),
  0,
  'external-base HEVC item luma differs from official POC 0',
);
assert.equal(
  Buffer.compare(Buffer.from(decodedBase.cb), Buffer.from(basePlanes.cb)),
  0,
  `external-base HEVC item Cb differs from official POC 0 (decoded ${digest(decodedBase.cb, 'md5')}, official ${digest(basePlanes.cb, 'md5')})`,
);
assert.equal(
  Buffer.compare(Buffer.from(decodedBase.cr), Buffer.from(basePlanes.cr)),
  0,
  `external-base HEVC item Cr differs from official POC 0 (decoded ${digest(decodedBase.cr, 'md5')}, official ${digest(basePlanes.cr, 'md5')})`,
);

const hybridNals = splitAnnexB(bitstream);
const vpsNal = hybridNals.find((nal) => nal.type === 32);
assert(vpsNal, 'official hybrid bitstream has no VPS');
const layer1Sps = hybridNals.find((nal) => nal.type === 33 && nal.layerId === 1);
assert(layer1Sps, 'official hybrid bitstream has no layer-1 SPS');
const layer1Pps = hybridNals.find((nal) => nal.type === 34 && nal.layerId === 1);
assert(layer1Pps, 'official hybrid bitstream has no layer-1 PPS');
const firstEnhancementSlice = hybridNals.find((nal) => nal.type === 19 && nal.layerId === 1);
assert(firstEnhancementSlice, 'official hybrid vector has no layer-1 POC 0 IRAP picture');
const firstEnhancementNalIndex = hybridNals.indexOf(firstEnhancementSlice);
const firstSuffixSei = hybridNals[firstEnhancementNalIndex + 1];
const firstAccessUnit = [
  vpsNal,
  layer1Sps,
  layer1Pps,
  firstEnhancementSlice,
  ...(firstSuffixSei?.type === 40 ? [firstSuffixSei] : []),
];
const hybridVps = parseLayeredVps(vpsNal.data);
assert.equal(hybridVps.baseLayerInternal, false);
assert.equal(hybridVps.baseLayerAvailable, true);
assert.deepEqual(hybridVps.layerIds, [0, 1]);
const sps = parseSps(layer1Sps.data, { layeredVps: hybridVps });
assert.equal(sps.width, 1920);
assert.equal(sps.height, 1080);

const heif = makeHybridHeif(baseNals, firstAccessUnit, baseFrame);
const boxes = parseISOBMFF(heif);
const info = getHeicInfo(heif, boxes);
assert.equal(info.primaryItemType, 'lhv1');
assert.equal(info.externalBaseLayerItemId, 2);
assert.deepEqual(info.lhevc?.requiredLayerIds, [0, 1]);
const decoded = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
assert.deepEqual(md5Planes(decoded), expectedLayer1Poc0Md5);
const rendered = decodeHeic(heif);
assert.equal(rendered.width, 1920);
assert.equal(rendered.height, 1080);

const avcBaseHeif = makeHybridHeif(baseNals, firstAccessUnit, baseFrame, undefined, 'avc1');
const avcBaseBoxes = parseISOBMFF(avcBaseHeif);
const avcBaseInfo = getHeicInfo(avcBaseHeif, avcBaseBoxes, 1);
assert.equal(avcBaseInfo.primaryItemType, 'lhv1');
assert.equal(avcBaseInfo.externalBaseLayerItemId, 2);
const suppliedAvcBasePlanes = decodeItemPlanes(avcBaseHeif, avcBaseBoxes, avcBaseInfo, 1, {
  externalBaseLayerPlanes: { 2: basePlanes },
});
assert.deepEqual(md5Planes(suppliedAvcBasePlanes), expectedLayer1Poc0Md5);
const suppliedAvcBaseImage = decodeHeic(avcBaseHeif, {
  itemId: 1,
  externalBaseLayerPlanes: { 2: basePlanes },
});
assert.equal(suppliedAvcBaseImage.width, rendered.width);
assert.equal(suppliedAvcBaseImage.height, rendered.height);
assert.deepEqual(suppliedAvcBaseImage.data, rendered.data);

const externalBaseUrl = 'assets/hybrid-base-layer.hevc';
const externalBaseHeif = makeHybridHeif(baseNals, firstAccessUnit, baseFrame, externalBaseUrl);
const externalBaseBoxes = parseISOBMFF(externalBaseHeif);
const externalBaseInfo = getHeicInfo(externalBaseHeif, externalBaseBoxes);
const externalItemData = { [externalBaseInfo.externalBaseLayerItemId!]: baseItemPayload };
const externalBasePlanes = decodeItemPlanes(
  externalBaseHeif,
  externalBaseBoxes,
  externalBaseInfo,
  externalBaseInfo.primaryItemId,
  { externalItemData },
);
assert.deepEqual(md5Planes(externalBasePlanes), expectedLayer1Poc0Md5);
const externalRendered = decodeHeic(externalBaseHeif, { externalItemData });
assert.deepEqual(externalRendered.data, rendered.data);
let resolverCalled = false;
const externalAsyncRendered = await decode(externalBaseHeif, {
  execution: 'main',
  resolveExternalItem: (reference, itemId) => {
    assert.deepEqual(reference, { type: 'url', url: externalBaseUrl });
    assert.equal(itemId, externalBaseInfo.externalBaseLayerItemId);
    resolverCalled = true;
    return baseItemPayload;
  },
});
assert.equal(resolverCalled, true);
assert.deepEqual(externalAsyncRendered.data, rendered.data);

console.log(
  'HYBRID_A_QUALCOMM_1 POC 0: in-file and URL-backed hvc1 exbl bases, plus caller-supplied avc1 base planes, match the official OPL enhancement hashes; public decode output matches.',
);
