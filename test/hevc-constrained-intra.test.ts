import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { getHeicInfo } from '../src/container/heic.js';
import { parseISOBMFF } from '../src/container/heif.js';
import { deblockPicture } from '../src/hevc/deblock.js';
import { isSliceNal, splitAnnexB } from '../src/hevc/nal.js';
import { PictureDecoder, type DecodedPicture } from '../src/hevc/picture.js';
import { parsePps } from '../src/hevc/pps.js';
import { applySao } from '../src/hevc/sao.js';
import { parseSliceHeader, SLICE_TYPE_B, SLICE_TYPE_P } from '../src/hevc/slice-header.js';
import {
  buildBReferenceLists,
  buildReferenceList0,
  derivePictureOrderCnt,
  type PictureReference,
} from '../src/hevc/reference-list.js';
import { parseSps } from '../src/hevc/sps.js';
import { decodeItemPlanes } from '../src/planes.js';
import { wrapHevcPredChain } from '../scripts/lib/heif.js';

const fixture = new Uint8Array(
  readFileSync(new URL('./fixtures/conformance/cip-b-nec-3.bit', import.meta.url)),
);

interface DecodedFrame {
  poc: number;
  decoded: DecodedPicture;
}

function decodeOfficialCip(bytes: Uint8Array = fixture) {
  const nals = splitAnnexB(bytes);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official CIP stream is missing its SPS or PPS');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const pictures: Uint8Array[][] = [];
  let current: Uint8Array[] | undefined;
  let previousIndependentHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps, previousIndependentHeader);
    if (header.firstSliceInPic && current) {
      pictures.push(current);
      current = undefined;
    }
    if (!current) current = [];
    current.push(nal.data);
    if (!header.dependentSliceSegment) previousIndependentHeader = header;
  }
  if (current) pictures.push(current);

  const references: PictureReference[] = [];
  const frames: DecodedFrame[] = [];
  const headers = pictures.map((picture) => parseSliceHeader(picture[0], sps, pps));
  let previousTid0Poc: number | null = null;
  for (let index = 0; index < pictures.length; index++) {
    const header = headers[index];
    const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
    let referenceList0: readonly PictureReference[] = [];
    let referenceList1: readonly PictureReference[] = [];
    if (header.sliceType === SLICE_TYPE_P) {
      referenceList0 = buildReferenceList0(sps, header, poc, references);
    } else if (header.sliceType === SLICE_TYPE_B) {
      const lists = buildBReferenceLists(sps, header, poc, references);
      referenceList0 = lists.l0;
      referenceList1 = lists.l1;
    }
    const decoded = new PictureDecoder(sps, pps, referenceList0, poc, referenceList1).decode(
      pictures[index],
    );
    deblockPicture(decoded, pps, sps.bitDepthLuma);
    applySao(decoded, sps, sps.bitDepthLuma);
    frames.push({ poc, decoded });
    references.push({
      ...decoded,
      pictureOrderCntLsb: header.pictureOrderCntLsb ?? 0,
      pictureOrderCnt: poc,
      isLongTermReference: false,
    });
    if ((pictures[index][0][1] & 7) - 1 === 0) previousTid0Poc = poc;
  }
  return { nals, sps, pps, pictures, headers, frames, previousTid0Poc };
}

it('decodes the official H.265.1 CIP_B constrained-intra sequence sample-exactly', () => {
  expect(createHash('sha256').update(fixture).digest('hex')).toBe(
    '786e5bd6ac5418f1e4950fc9c5251826128b15d94eda29679b72a4f79d8a77f7',
  );
  const { sps, pps, pictures, headers, frames } = decodeOfficialCip();
  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples, sps.bitDepthLuma]).toEqual([
    416, 240, 8,
  ]);
  expect(pps.constrainedIntraPred).toBe(true);
  expect(pictures).toHaveLength(5);
  expect(headers.filter((header) => header.sliceType === SLICE_TYPE_P)).toHaveLength(4);

  const hash = createHash('md5');
  for (const { decoded } of frames.sort((a, b) => a.poc - b.poc)) {
    hash.update(Buffer.from(decoded.y));
    hash.update(Buffer.from(decoded.cb));
    hash.update(Buffer.from(decoded.cr));
  }
  expect(hash.digest('hex')).toBe('1315714c7b3f3237b469259f66d9b7aa');
});

it('decodes the final constrained-intra P picture through a HEIF pred item chain', () => {
  const { nals, sps, pps, pictures, headers, frames } = decodeOfficialCip();
  const pocs = frames.map(({ poc }) => poc);
  const itemIdByPoc = new Map(pocs.map((poc, index) => [poc, index + 1]));
  const dependencies = headers.map((header, index) => {
    if (header.sliceType !== SLICE_TYPE_P) return [];
    const rps = header.shortTermRefPicSet;
    if (!rps) throw new Error('CIP_B P picture has no short-term RPS');
    const referencePocs = [
      ...rps.deltaPocS0.flatMap((delta, i) =>
        rps.usedByCurrPicS0[i] ? [pocs[index] + delta] : [],
      ),
      ...rps.deltaPocS1.flatMap((delta, i) =>
        rps.usedByCurrPicS1[i] ? [pocs[index] + delta] : [],
      ),
    ];
    return [...new Set(referencePocs)].map((poc) => {
      const itemId = itemIdByPoc.get(poc);
      if (!itemId || itemId > index + 1)
        throw new Error(`CIP_B P picture ${index + 1} has an unavailable POC ${poc}`);
      return itemId;
    });
  });
  const parameters = nals
    .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
    .map((nal) => nal.data);
  const toAnnexB = (units: readonly Uint8Array[]) =>
    Buffer.concat(units.flatMap((unit) => [Buffer.from([0, 0, 0, 1]), Buffer.from(unit)]));
  const streams = pictures.map((picture, index) =>
    toAnnexB([...(index === 0 ? parameters : []), ...picture]),
  );
  const heif = wrapHevcPredChain(
    streams,
    dependencies,
    sps.picWidthInLumaSamples,
    sps.picHeightInLumaSamples,
    sps.bitDepthLuma,
    sps.chromaFormatIdc,
  );
  const boxes = parseISOBMFF(heif);
  const info = getHeicInfo(heif, boxes);
  const planes = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
  const finalFrame = frames.reduce((latest, frame) => (frame.poc > latest.poc ? frame : latest));
  expect(planes.pictureOrderCnt).toBe(finalFrame.poc);
  expect(
    Buffer.concat([Buffer.from(planes.y), Buffer.from(planes.cb), Buffer.from(planes.cr)]),
  ).toEqual(
    Buffer.concat([
      Buffer.from(finalFrame.decoded.y),
      Buffer.from(finalFrame.decoded.cb),
      Buffer.from(finalFrame.decoded.cr),
    ]),
  );
  expect(pps.constrainedIntraPred).toBe(true);
});

it('matches the other official constrained-intra profile vectors', () => {
  const cases = [
    {
      file: 'cip-a-panasonic-3.bit',
      sha256: '19f6a710e8b2c66f393392af24c11e5fbba10a5c9f6f28c8b26949942f384c1c',
      yuvMd5: '4cbf601ba98d63f642defab5eaa12c8d',
      slicesPerPicture: [1, 1],
    },
    {
      file: 'cip-c-panasonic-2.bit',
      sha256: '1a696ecc7520b23c89ac6daca7ab1f1f325a01dc01845ba352528be775456ed5',
      yuvMd5: 'ed985932fef2aa8a74ded970070bdab2',
      slicesPerPicture: [3, 3],
    },
  ];

  for (const vector of cases) {
    const bytes = new Uint8Array(
      readFileSync(new URL(`./fixtures/conformance/${vector.file}`, import.meta.url)),
    );
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(vector.sha256);
    const { sps, pps, headers, pictures, frames } = decodeOfficialCip(bytes);
    expect(pps.constrainedIntraPred).toBe(true);
    expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples, sps.bitDepthLuma]).toEqual([
      416, 240, 8,
    ]);
    expect(headers).toHaveLength(2);
    expect(pictures.map((picture) => picture.length)).toEqual(vector.slicesPerPicture);
    expect(headers.filter((header) => header.sliceType === SLICE_TYPE_P)).toHaveLength(0);
    expect(headers.filter((header) => header.sliceType === SLICE_TYPE_B)).toHaveLength(1);
    const hash = createHash('md5');
    for (const { decoded } of frames.sort((a, b) => a.poc - b.poc)) {
      hash.update(Buffer.from(decoded.y));
      hash.update(Buffer.from(decoded.cb));
      hash.update(Buffer.from(decoded.cr));
    }
    expect(hash.digest('hex')).toBe(vector.yuvMd5);
  }
});
