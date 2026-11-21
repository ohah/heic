import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { getHeicInfo } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { deblockPicture } from '../src/hevc/deblock';
import { BitReader, isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal';
import { PictureDecoder } from '../src/hevc/picture';
import { parsePps } from '../src/hevc/pps';
import { applySao } from '../src/hevc/sao';
import {
  buildBReferenceLists,
  buildReferenceList0,
  createCurrentPictureReference,
  derivePictureOrderCnt,
  type PictureReference,
} from '../src/hevc/reference-list';
import {
  parseSliceHeader,
  SLICE_TYPE_B,
  SLICE_TYPE_I,
  SLICE_TYPE_P,
} from '../src/hevc/slice-header';
import { parseSps } from '../src/hevc/sps';
import { decodeItemPlanes } from '../src/planes';
import { wrapHevcPredChain } from './lib/heif';

const bytes = new Uint8Array(
  readFileSync(new URL('../test/fixtures/conformance/ppi-b-interdigital-2.bit', import.meta.url)),
);
const md5 = (data: Uint8Array) => createHash('md5').update(data).digest('hex');
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const fail = (message: string): never => {
  throw new Error(`PPI_B_InterDigital_2: ${message}`);
};

const nals = splitAnnexB(bytes);
if (md5(bytes) !== '8248cf62d300020045645507c03d8ec5')
  fail('official bitstream MD5 does not match the pinned vector');
if (sha256(bytes) !== '01c43d5a39084c770745d9cda812265015dc8fd38287a28365f3063dfe0d41e6')
  fail('official bitstream SHA-256 does not match the pinned vector');
const spsNal = nals.find((nal) => nal.type === 33);
if (!spsNal) fail('official bitstream has no SPS');
const sps = parseSps(spsNal.data);
const ppsById = new Map(
  nals
    .filter((nal) => nal.type === 34)
    .map((nal) => {
      const pps = parsePps(nal.data);
      return [pps.ppsId, pps] as const;
    }),
);

type PictureGroup = {
  ppsId: number;
  header: ReturnType<typeof parseSliceHeader>;
  slices: Uint8Array[];
  expectedPlaneMd5s: string[] | null;
};
const pictures: PictureGroup[] = [];
let current: PictureGroup | null = null;
let previousIndependentHeader: ReturnType<typeof parseSliceHeader> | undefined;

function readDecodedPictureHash(nal: Uint8Array): string[] | null {
  const rbsp = toRbsp(nal);
  let offset = 0;
  while (offset < rbsp.length) {
    let payloadType = 0;
    while (offset < rbsp.length && rbsp[offset] === 0xff) {
      payloadType += 255;
      offset++;
    }
    if (offset >= rbsp.length) break;
    payloadType += rbsp[offset++];

    let payloadSize = 0;
    while (offset < rbsp.length && rbsp[offset] === 0xff) {
      payloadSize += 255;
      offset++;
    }
    if (offset >= rbsp.length) break;
    payloadSize += rbsp[offset++];
    const payload = rbsp.subarray(offset, offset + payloadSize);
    if (payload.length !== payloadSize) fail('truncated SEI payload');
    offset += payloadSize;

    if (payloadType !== 132) continue;
    if (payload[0] !== 0 || payload.length !== 49)
      fail(`expected a three-plane MD5 decoded_picture_hash, got type ${payload[0]}`);
    return [0, 1, 2].map((plane) =>
      Buffer.from(payload.subarray(1 + plane * 16, 1 + (plane + 1) * 16)).toString('hex'),
    );
  }
  return null;
}

for (const nal of nals) {
  if (isSliceNal(nal.type)) {
    const reader = new BitReader(toRbsp(nal.data));
    reader.readBit(); // first_slice_segment_in_pic_flag
    if (nal.type >= 16 && nal.type <= 23) reader.readBit(); // no_output_of_prior_pics_flag
    const ppsId = reader.ue();
    const pps = ppsById.get(ppsId);
    if (!pps) fail(`slice references missing PPS ${ppsId}`);
    const header = parseSliceHeader(nal.data, sps, pps, previousIndependentHeader);
    if (header.firstSliceInPic) {
      current = { ppsId, header, slices: [], expectedPlaneMd5s: null };
      pictures.push(current);
    }
    if (!current || current.ppsId !== ppsId)
      fail('slice segment appeared without its picture header/PPS');
    current.slices.push(nal.data);
    if (!header.dependentSliceSegment) previousIndependentHeader = header;
  } else if (current && nal.type === 40) {
    const hashes = readDecodedPictureHash(nal.data);
    if (hashes) current.expectedPlaneMd5s = hashes;
  }
}

if (pictures.length !== 33) fail(`expected 33 pictures, found ${pictures.length}`);

const references: PictureReference[] = [];
const decodedFrames: { poc: number; hashes: string[] }[] = [];
let previousTid0Poc: number | null = null;
const sliceCounts = { intra: 0, predictive: 0, bidirectional: 0 };

for (const [index, entry] of pictures.entries()) {
  const { header, slices, expectedPlaneMd5s } = entry;
  if (!expectedPlaneMd5s) fail(`POC ${header.pictureOrderCntLsb} has no decoded_picture_hash SEI`);
  const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
  let referenceList0: readonly PictureReference[] = [];
  let referenceList1: readonly PictureReference[] = [];

  if (header.sliceType === SLICE_TYPE_I) {
    sliceCounts.intra++;
  } else if (header.sliceType === SLICE_TYPE_P) {
    sliceCounts.predictive++;
    referenceList0 = buildReferenceList0(sps, header, poc, references);
  } else if (header.sliceType === SLICE_TYPE_B) {
    sliceCounts.bidirectional++;
    const lists = buildBReferenceLists(
      sps,
      header,
      poc,
      references,
      header.currentPictureReferenceEnabled ? createCurrentPictureReference(sps, poc) : undefined,
    );
    referenceList0 = lists.l0;
    referenceList1 = lists.l1;
  } else {
    fail(`POC ${poc} has unsupported slice type ${header.sliceType}`);
  }

  let decoded;
  try {
    decoded = new PictureDecoder(
      sps,
      ppsById.get(entry.ppsId)!,
      referenceList0,
      poc,
      referenceList1,
    ).decode(slices);
  } catch (error) {
    throw new Error(`PPI_B picture ${index + 1} (POC ${poc}) failed: ${String(error)}`, {
      cause: error,
    });
  }
  const pps = ppsById.get(entry.ppsId)!;
  deblockPicture(decoded, pps, sps.bitDepthLuma, sps.bitDepthChroma);
  applySao(decoded, sps, sps.bitDepthLuma, sps.bitDepthChroma);

  const actualPlaneMd5s = [decoded.y, decoded.cb, decoded.cr].map((plane) =>
    md5(Buffer.from(plane)),
  );
  if (JSON.stringify(actualPlaneMd5s) !== JSON.stringify(expectedPlaneMd5s))
    fail(
      `POC ${poc} hash mismatch; expected ${expectedPlaneMd5s.join('/')}, got ${actualPlaneMd5s.join('/')}`,
    );

  decodedFrames.push({ poc, hashes: actualPlaneMd5s });
  references.push({
    ...decoded,
    pictureOrderCntLsb: header.pictureOrderCntLsb ?? 0,
    pictureOrderCnt: poc,
    isLongTermReference: false,
  });
  if ((slices[0][1] & 7) - 1 === 0) previousTid0Poc = poc;
  console.log(`picture ${index + 1}/33 POC ${poc}: all three component hashes match`);
}

if (sliceCounts.intra !== 0 || sliceCounts.predictive !== 3 || sliceCounts.bidirectional !== 30)
  fail(`unexpected slice types: ${JSON.stringify(sliceCounts)}`);
console.log(
  `Official PPI_B: 33/33 pictures match decoded_picture_hash SEIs (${sliceCounts.predictive} P, ${sliceCounts.bidirectional} B).`,
);

const itemIdByPoc = new Map(decodedFrames.map((frame, index) => [frame.poc, index + 1]));
const maxPocLsb = 1 << sps.log2MaxPicOrderCntLsb;
const predReferenceIds = pictures.map((picture, index) => {
  const currentPoc = decodedFrames[index].poc;
  const referencesPoc: number[] = [];
  const rps = picture.header.shortTermRefPicSet;
  if (rps) {
    for (let i = 0; i < rps.deltaPocS0.length; i++)
      if (rps.usedByCurrPicS0[i]) referencesPoc.push(currentPoc + rps.deltaPocS0[i]);
    for (let i = 0; i < rps.deltaPocS1.length; i++)
      if (rps.usedByCurrPicS1[i]) referencesPoc.push(currentPoc + rps.deltaPocS1[i]);
  }
  for (const reference of picture.header.longTermRefPics) {
    if (!reference.usedByCurrPic) continue;
    if (reference.deltaPocMsbPresent) {
      referencesPoc.push(
        currentPoc -
          reference.deltaPocMsbCycle * maxPocLsb -
          (currentPoc & (maxPocLsb - 1)) +
          reference.pocLsb,
      );
    } else {
      const matches = decodedFrames
        .slice(0, index)
        .filter((frame) => (frame.poc & (maxPocLsb - 1)) === reference.pocLsb);
      if (matches.length !== 1)
        fail(`item ${index + 1} has ambiguous long-term POC LSB ${reference.pocLsb}`);
      referencesPoc.push(matches[0].poc);
    }
  }

  const ids = [...new Set(referencesPoc)].map((poc) => {
    const itemId = itemIdByPoc.get(poc);
    if (!itemId || itemId > index)
      fail(`item ${index + 1} requires unavailable prior reference POC ${poc}`);
    return itemId;
  });
  return ids.sort((a, b) => a - b);
});

const startCode = Buffer.from([0, 0, 0, 1]);
const parameterSets = nals.filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34);
const itemStreams = pictures.map((picture, index) =>
  Buffer.concat(
    (index === 0
      ? [...parameterSets.map((nal) => nal.data), ...picture.slices]
      : picture.slices
    ).flatMap((data) => [startCode, Buffer.from(data)]),
  ),
);
const heif = wrapHevcPredChain(
  itemStreams,
  predReferenceIds,
  sps.picWidthInLumaSamples,
  sps.picHeightInLumaSamples,
  sps.bitDepthLuma,
  sps.chromaFormatIdc,
);
const boxes = parseISOBMFF(heif);
const info = getHeicInfo(heif, boxes);
const primary = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
const primaryPoc = decodedFrames.at(-1)!.poc;
const expectedPrimary = decodedFrames.at(-1)!.hashes;
const actualPrimary = [primary.y, primary.cb, primary.cr].map((plane) => md5(Buffer.from(plane)));
if (JSON.stringify(actualPrimary) !== JSON.stringify(expectedPrimary))
  fail(
    `HEIF pred-chain primary POC ${primaryPoc} mismatch; expected ${expectedPrimary.join('/')}, got ${actualPrimary.join('/')}`,
  );
console.log(
  `HEIF pred-chain primary item ${info.primaryItemId} (POC ${primaryPoc}) matches its official component hashes; ${predReferenceIds.reduce((sum, ids) => sum + ids.length, 0)} item-reference edges.`,
);
