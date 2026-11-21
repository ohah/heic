import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { getHeicInfo } from '../src/container/heic.js';
import { parseISOBMFF } from '../src/container/heif.js';
import { deblockPicture } from '../src/hevc/deblock.js';
import { isSliceNal, splitAnnexB } from '../src/hevc/nal.js';
import { PictureDecoder } from '../src/hevc/picture.js';
import { parsePps } from '../src/hevc/pps.js';
import { applySao } from '../src/hevc/sao.js';
import { parseSliceHeader, SLICE_TYPE_P } from '../src/hevc/slice-header.js';
import {
  buildReferenceList0,
  derivePictureOrderCnt,
  type PictureReference,
} from '../src/hevc/reference-list.js';
import { parseSps } from '../src/hevc/sps.js';
import { decodeItemPlanes } from '../src/planes.js';
import { wrapHevcPredChain } from '../scripts/lib/heif.js';

it('decodes the official AMVP_A_MTK_4 vector with temporal MVP from inter-P references', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/amvp-a-mtk-4.bit', import.meta.url)),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    'dcbc3c321e66f8d4b06481ffbdb2e02214d83f60db5868823938715cfd275371',
  );
  const nals = splitAnnexB(bytes);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official AMVP_A stream is missing its SPS or PPS');

  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples, sps.bitDepthLuma]).toEqual([
    416, 240, 8,
  ]);
  expect(sps.temporalMvpEnabled).toBe(true);

  const pictures: Uint8Array[][] = [];
  let picture: Uint8Array[] | undefined;
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic && picture) {
      pictures.push(picture);
      picture = undefined;
    }
    if (!picture) picture = [];
    picture.push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }
  if (picture) pictures.push(picture);

  const references: PictureReference[] = [];
  const frames: {
    poc: number;
    y: Uint8Array | Uint16Array;
    cb: Uint8Array | Uint16Array;
    cr: Uint8Array | Uint16Array;
  }[] = [];
  let previousTid0Poc: number | null = null;
  let pPictureCount = 0;
  let interPredictedCollocatedCount = 0;
  for (const pictureNals of pictures) {
    const header = parseSliceHeader(pictureNals[0], sps, pps);
    const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
    const referenceList =
      header.sliceType === SLICE_TYPE_P ? buildReferenceList0(sps, header, poc, references) : [];
    if (header.sliceType === SLICE_TYPE_P) {
      pPictureCount++;
      expect(header.sliceTemporalMvpEnabled).toBe(true);
      expect(header.collocatedRefIdx).toBe(0);
      if (referenceList[header.collocatedRefIdx]?.hasExternalInterMotion)
        interPredictedCollocatedCount++;
    }

    const decoded = new PictureDecoder(sps, pps, referenceList, poc).decode(pictureNals);
    deblockPicture(decoded, pps, sps.bitDepthLuma);
    applySao(decoded, sps, sps.bitDepthLuma);
    frames.push({ poc, y: decoded.y, cb: decoded.cb, cr: decoded.cr });
    references.push({
      ...decoded,
      pictureOrderCntLsb: header.pictureOrderCntLsb ?? 0,
      pictureOrderCnt: poc,
      isLongTermReference: false,
    });
    if ((pictureNals[0][1] & 7) - 1 === 0) previousTid0Poc = poc;
  }

  expect(pictures).toHaveLength(30);
  expect(pPictureCount).toBe(29);
  expect(interPredictedCollocatedCount).toBeGreaterThan(0);

  const hash = createHash('md5');
  for (const frame of frames.sort((a, b) => a.poc - b.poc)) {
    hash.update(Buffer.from(frame.y));
    hash.update(Buffer.from(frame.cb));
    hash.update(Buffer.from(frame.cr));
  }
  expect(hash.digest('hex')).toBe('5dd1b1099391ad659225fbf94965a6c7');
});

it('carries collocated motion maps through HEIF pred item dependencies', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/amvp-a-mtk-4.bit', import.meta.url)),
  );
  const nals = splitAnnexB(bytes);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  if (!spsNal || !ppsNal) throw new Error('official AMVP_A stream is missing its SPS or PPS');
  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);

  const pictures: Uint8Array[][] = [];
  let picture: Uint8Array[] | undefined;
  let previousHeader: ReturnType<typeof parseSliceHeader> | undefined;
  for (const nal of nals) {
    if (!isSliceNal(nal.type)) continue;
    const header = parseSliceHeader(nal.data, sps, pps, previousHeader);
    if (header.firstSliceInPic && picture) {
      pictures.push(picture);
      picture = undefined;
    }
    if (!picture) picture = [];
    picture.push(nal.data);
    if (!header.dependentSliceSegment) previousHeader = header;
  }
  if (picture) pictures.push(picture);

  const headers = pictures.map((pictureNals) => parseSliceHeader(pictureNals[0], sps, pps));
  const pocs: number[] = [];
  let previousTid0Poc: number | null = null;
  for (let i = 0; i < headers.length; i++) {
    const poc = derivePictureOrderCnt(sps, headers[i], previousTid0Poc);
    pocs.push(poc);
    if ((pictures[i][0][1] & 7) - 1 === 0) previousTid0Poc = poc;
  }
  const itemIdByPoc = new Map(pocs.map((poc, index) => [poc, index + 1]));
  const dependencies = headers.map((header, index) => {
    if (header.sliceType !== SLICE_TYPE_P) return [];
    if (header.longTermRefPics.length !== 0)
      throw new Error('AMVP_A integration prefix unexpectedly uses long-term references');
    const rps = header.shortTermRefPicSet;
    if (!rps) throw new Error('P picture has no short-term RPS');
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
      if (!itemId || itemId > index)
        throw new Error(`P picture ${index + 1} has an unavailable dependency at POC ${poc}`);
      return itemId;
    });
  });

  const parameters = nals
    .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
    .map((nal) => nal.data);
  const toAnnexB = (entries: Uint8Array[]): Buffer =>
    Buffer.concat(entries.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), Buffer.from(nal)]));
  const itemStreams = pictures.map((pictureNals, index) =>
    toAnnexB(index === 0 ? [...parameters, ...pictureNals] : pictureNals),
  );
  const heif = wrapHevcPredChain(itemStreams, dependencies, 416, 240, 8, 1);
  const boxes = parseISOBMFF(heif);
  const info = getHeicInfo(heif, boxes);
  const planes = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
  expect(planes.pictureOrderCnt).toBe(29);
  expect(planes.hasExternalInterMotion).toBe(true);

  const hash = createHash('md5');
  hash.update(Buffer.from(planes.y));
  hash.update(Buffer.from(planes.cb));
  hash.update(Buffer.from(planes.cr));
  expect(hash.digest('hex')).toBe('c8fd1d83c8652669dcd9e3a02dde3aee');
});
