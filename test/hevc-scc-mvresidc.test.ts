import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { getHeicInfo } from '../src/container/heic.js';
import { parseISOBMFF } from '../src/container/heif.js';
import { deblockPicture } from '../src/hevc/deblock.js';
import { isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal.js';
import { applySao } from '../src/hevc/sao.js';
import { PictureDecoder, type ReferenceImage } from '../src/hevc/picture.js';
import {
  buildBReferenceLists,
  buildReferenceList0,
  createCurrentPictureReference,
  derivePictureOrderCnt,
} from '../src/hevc/reference-list.js';
import { parsePps } from '../src/hevc/pps.js';
import { parseSliceHeader, SLICE_TYPE_B, SLICE_TYPE_P } from '../src/hevc/slice-header.js';
import { parseSps } from '../src/hevc/sps.js';
import { decodeItemPlanes } from '../src/planes.js';
import { wrapHevcPredChain } from '../scripts/lib/heif.js';

const startCode = Buffer.from([0, 0, 0, 1]);

function asAnnexB(nal: Uint8Array): Buffer {
  return Buffer.concat([startCode, Buffer.from(nal)]);
}

function decodedPictureHash(nal: Uint8Array): string[] {
  const rbsp = toRbsp(nal);
  if (rbsp.length !== 52 || rbsp[0] !== 132 || rbsp[1] !== 49 || rbsp[2] !== 0 || rbsp[51] !== 128)
    throw new Error('official decoded_picture_hash SEI is malformed');
  return [rbsp.subarray(3, 19), rbsp.subarray(19, 35), rbsp.subarray(35, 51)].map((hash) =>
    Buffer.from(hash).toString('hex'),
  );
}

for (const vector of [
  {
    name: 'MVRESIDC_A',
    file: 'mvresidc-a-ms-2.bit',
    sha256: '0a540b3e27120085738975bd18431a5c04beea844ea5271157f9fe2ecf463460',
    motionVectorResolutionControlIdc: 0,
  },
  {
    name: 'MVRESIDC_C',
    file: 'mvresidc-c-ms-3.bit',
    sha256: 'cba0360cfacea5b9e3f859ab82700e5793cfb7344ed935e4c8c159c47cf8fa31',
    motionVectorResolutionControlIdc: 2,
  },
] as const) {
  it(`reconstructs every picture in the official ${vector.name} vector`, () => {
    const bytes = new Uint8Array(
      readFileSync(new URL(`./fixtures/conformance/${vector.file}`, import.meta.url)),
    );
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(vector.sha256);

    const nals = splitAnnexB(bytes);
    const spsNal = nals.find((nal) => nal.type === 33);
    const ppsNal = nals.find((nal) => nal.type === 34);
    const slices = nals.filter((nal) => isSliceNal(nal.type));
    if (!spsNal || !ppsNal || slices.length !== 9)
      throw new Error(`official ${vector.name} stream is missing its parameters or nine pictures`);

    const sps = parseSps(spsNal.data);
    const pps = parsePps(ppsNal.data);
    expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples, sps.chromaFormatIdc]).toEqual([
      1280, 720, 3,
    ]);
    expect(sps.screenContentExtension?.motionVectorResolutionControlIdc).toBe(
      vector.motionVectorResolutionControlIdc,
    );

    const headers = slices.map((slice) => parseSliceHeader(slice.data, sps, pps));
    expect(headers.map((header) => header.sliceType)).toEqual([
      SLICE_TYPE_P,
      ...Array<number>(8).fill(SLICE_TYPE_B),
    ]);
    if (vector.motionVectorResolutionControlIdc === 2)
      expect(headers.slice(1).map((header) => header.useIntegerMv)).toEqual([
        false,
        true,
        false,
        true,
        false,
        true,
        false,
        true,
      ]);

    const references: ReferenceImage[] = [];
    let previousTid0Poc: number | null = null;
    for (const [index, slice] of slices.entries()) {
      const header = headers[index];
      const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
      let list0: ReferenceImage[];
      let list1: ReferenceImage[] = [];
      if (header.sliceType === SLICE_TYPE_P) {
        list0 = buildReferenceList0(sps, header, poc, references);
      } else {
        const currentPicture = header.currentPictureReferenceEnabled
          ? createCurrentPictureReference(sps, poc)
          : undefined;
        const lists = buildBReferenceLists(sps, header, poc, references, currentPicture);
        list0 = lists.l0;
        list1 = lists.l1;
      }

      const picture = new PictureDecoder(sps, pps, list0, poc, list1).decode([slice.data]);
      deblockPicture(picture, pps, sps.bitDepthLuma, sps.bitDepthChroma);
      applySao(picture, sps, sps.bitDepthLuma, sps.bitDepthChroma);

      const sliceIndex = nals.indexOf(slice);
      const suffixSei = nals[sliceIndex + 1];
      if (!suffixSei || suffixSei.type !== 40)
        throw new Error(`official ${vector.name} POC ${poc} has no decoded_picture_hash SEI`);
      const expected = decodedPictureHash(suffixSei.data);
      const actual = [picture.y, picture.cb, picture.cr].map((plane) =>
        createHash('md5').update(Buffer.from(plane)).digest('hex'),
      );
      expect(actual, `official ${vector.name} POC ${poc}`).toEqual(expected);

      references.push({
        ...picture,
        chromaFormatIdc: sps.chromaFormatIdc,
        bitDepthLuma: sps.bitDepthLuma,
        bitDepthChroma: sps.bitDepthChroma,
        pictureOrderCntLsb: header.pictureOrderCntLsb ?? 0,
        pictureOrderCnt: poc,
        isLongTermReference: false,
      });
      if (((slice.data[1] ?? 0) & 7) - 1 === 0) previousTid0Poc = poc;
    }
  });
}

it('decodes the mixed-reference B picture through a synthetic HEIF pred graph', () => {
  const bytes = new Uint8Array(
    readFileSync(new URL('./fixtures/conformance/mvresidc-b-ms-2.bit', import.meta.url)),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    'c7e21066c689bf0ccb80b60cb03663862777a45f0e68d40ed4e8fcf81287cf9e',
  );
  const nals = splitAnnexB(bytes);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  const slices = nals.filter((nal) => isSliceNal(nal.type));
  if (!spsNal || !ppsNal || slices.length !== 9)
    throw new Error('official MVRESIDC_B stream is missing its parameters or nine pictures');

  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const headers = slices.map((slice) => parseSliceHeader(slice.data, sps, pps));
  const pocs: number[] = [];
  let previousTid0Poc: number | null = null;
  for (const [index, header] of headers.entries()) {
    const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
    pocs.push(poc);
    if (((slices[index].data[1] ?? 0) & 7) - 1 === 0) previousTid0Poc = poc;
  }
  expect(pocs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);

  const itemIdByPoc = new Map(pocs.map((poc, index) => [poc, index + 1]));
  const predReferences = headers.map((header, index) => {
    const currentPoc = pocs[index];
    const rps = header.shortTermRefPicSet;
    const referencePocs: number[] = [];
    if (rps) {
      for (let i = 0; i < rps.deltaPocS0.length; i++)
        if (rps.usedByCurrPicS0[i]) referencePocs.push(currentPoc + rps.deltaPocS0[i]);
      for (let i = 0; i < rps.deltaPocS1.length; i++)
        if (rps.usedByCurrPicS1[i]) referencePocs.push(currentPoc + rps.deltaPocS1[i]);
    }
    if (header.longTermRefPics.length !== 0)
      throw new Error('official MVRESIDC_B vector unexpectedly uses long-term references');
    return [...new Set(referencePocs)]
      .map((poc) => {
        const itemId = itemIdByPoc.get(poc);
        if (!itemId || itemId > index)
          throw new Error(`MVRESIDC_B item ${index + 1} requires unavailable POC ${poc}`);
        return itemId;
      })
      .sort((a, b) => a - b);
  });
  expect(predReferences[8]).toEqual([1, 5, 7, 8]);

  const parameterNals = nals
    .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
    .map((nal) => asAnnexB(nal.data));
  const streams = slices.map((slice, index) =>
    Buffer.concat([...(index === 0 ? parameterNals : []), asAnnexB(slice.data)]),
  );
  const heif = wrapHevcPredChain(
    streams,
    predReferences,
    sps.picWidthInLumaSamples,
    sps.picHeightInLumaSamples,
    sps.bitDepthLuma,
    sps.chromaFormatIdc,
  );
  const boxes = parseISOBMFF(heif);
  const info = getHeicInfo(heif, boxes);
  expect(info.primaryItemId).toBe(9);
  const planes = decodeItemPlanes(heif, boxes, info, info.primaryItemId);

  const finalSlice = slices.at(-1)!;
  const suffixSei = nals[nals.indexOf(finalSlice) + 1];
  if (!suffixSei || suffixSei.type !== 40)
    throw new Error('official MVRESIDC_B POC 8 has no decoded_picture_hash SEI');
  const actual = [planes.y, planes.cb, planes.cr].map((plane) =>
    createHash('md5').update(Buffer.from(plane)).digest('hex'),
  );
  expect(actual).toEqual(decodedPictureHash(suffixSei.data));
  expect(headers[8].currentPictureReferenceEnabled).toBe(true);
  expect(headers[8].numRefIdxL0ActiveMinus1).toBe(4);
  const l0ReferenceIndexes = new Set(planes.motionRefIdxL0 ?? []);
  expect(l0ReferenceIndexes.has(4)).toBe(true); // current picture occupies the final L0 entry
  expect([...l0ReferenceIndexes].some((index) => index >= 0 && index < 4)).toBe(true);
  expect([...new Set(planes.motionRefIdxL1 ?? [])].every((index) => index >= 0 && index < 4)).toBe(
    true,
  );
});
