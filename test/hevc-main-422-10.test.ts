import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { getHeicInfo } from '../src/container/heic.js';
import { getFtypInfo, parseISOBMFF } from '../src/container/heif.js';
import { decodeHeic } from '../src/decoder.js';
import { deblockPicture } from '../src/hevc/deblock.js';
import { BitReader, isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal.js';
import { parsePps } from '../src/hevc/pps.js';
import { PictureDecoder, type ReferenceImage } from '../src/hevc/picture.js';
import { buildBReferenceLists, derivePictureOrderCnt } from '../src/hevc/reference-list.js';
import { applySao } from '../src/hevc/sao.js';
import { parseSliceHeader, SLICE_TYPE_B, SLICE_TYPE_I } from '../src/hevc/slice-header.js';
import { parseSps } from '../src/hevc/sps.js';
import { decodeItemPlanes } from '../src/planes.js';
import { wrapHevc, wrapHevcPredChain } from '../scripts/lib/heif.js';

function asAnnexB(nals: readonly Uint8Array[]): Buffer {
  return Buffer.concat(nals.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), Buffer.from(nal)]));
}

function planeMd5s(planes: readonly (Uint8Array | Uint16Array)[]): string[] {
  return planes.map((plane) =>
    createHash('md5')
      .update(Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength))
      .digest('hex'),
  );
}

function decodedPictureHash(nal: Uint8Array): string[] | null {
  const rbsp = toRbsp(nal);
  let position = 0;
  while (position < rbsp.length) {
    let payloadType = 0;
    while (position < rbsp.length && rbsp[position] === 255) {
      payloadType += 255;
      position++;
    }
    if (position >= rbsp.length) return null;
    payloadType += rbsp[position++]!;

    let payloadSize = 0;
    while (position < rbsp.length && rbsp[position] === 255) {
      payloadSize += 255;
      position++;
    }
    if (position >= rbsp.length) return null;
    payloadSize += rbsp[position++]!;
    const payload = rbsp.subarray(position, position + payloadSize);
    if (payload.length !== payloadSize) throw new Error('truncated decoded_picture_hash SEI');
    position += payloadSize;

    if (payloadType !== 132) continue;
    if (payload[0] !== 0 || payload.length !== 49)
      throw new Error('expected a three-plane MD5 decoded_picture_hash');
    return [0, 1, 2].map((component) =>
      Buffer.from(payload.subarray(1 + component * 16, 17 + component * 16)).toString('hex'),
    );
  }
  return null;
}

describe('official Main 4:2:2 10-bit sequence', () => {
  it('matches the full B-picture vector and decodes its pictures through HEIF pred items', () => {
    const bytes = new Uint8Array(
      readFileSync(
        new URL('./fixtures/conformance/main-422-10-a-rext-sony-2.bit', import.meta.url),
      ),
    );
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '4004fe9c86d10f36acc6e111b8e6a473351ceeceb6b0649f1d3efb442d27a231',
    );
    expect(createHash('md5').update(bytes).digest('hex')).toBe('f78efef52e7806d8bcd8d0cff202c07f');

    const nals = splitAnnexB(bytes);
    const spsNal = nals.find((nal) => nal.type === 33);
    if (!spsNal) throw new Error('Main 4:2:2 10-bit vector has no SPS');
    const sps = parseSps(spsNal.data);
    const ppsById = new Map(
      nals
        .filter((nal) => nal.type === 34)
        .map((nal) => {
          const pps = parsePps(nal.data);
          return [pps.ppsId, pps] as const;
        }),
    );
    type PictureEntry = {
      nal: Uint8Array;
      pps: ReturnType<typeof parsePps>;
      header: ReturnType<typeof parseSliceHeader>;
      expectedPlaneMd5s: string[] | null;
    };
    const pictures: PictureEntry[] = [];
    let current: PictureEntry | null = null;
    for (const nal of nals) {
      if (isSliceNal(nal.type)) {
        const reader = new BitReader(toRbsp(nal.data));
        reader.readBit();
        if (nal.type >= 16 && nal.type <= 23) reader.readBit();
        const pps = ppsById.get(reader.ue());
        if (!pps) throw new Error('Main 4:2:2 10-bit slice references a missing PPS');
        const header = parseSliceHeader(nal.data, sps, pps);
        if (!header.firstSliceInPic)
          throw new Error('Main 4:2:2 10-bit fixture unexpectedly has multiple slices per picture');
        current = { nal: nal.data, pps, header, expectedPlaneMd5s: null };
        pictures.push(current);
      } else if (nal.type === 40 && current) {
        current.expectedPlaneMd5s = decodedPictureHash(nal.data) ?? current.expectedPlaneMd5s;
      }
    }

    expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples]).toEqual([1920, 1080]);
    expect([sps.chromaFormatIdc, sps.bitDepthLuma, sps.bitDepthChroma]).toEqual([2, 10, 10]);
    expect(pictures).toHaveLength(9);
    expect(pictures.map(({ header }) => header.sliceType)).toEqual([
      SLICE_TYPE_I,
      ...Array<number>(8).fill(SLICE_TYPE_B),
    ]);
    expect(pictures[0]?.pps.transformSkipEnabled).toBe(true);
    expect(pictures[0]?.pps.chromaQpOffsetListEnabled).toBe(true);
    expect(pictures[0]?.pps.cbQpOffsetList).toEqual([6]);
    expect(pictures[0]?.pps.crQpOffsetList).toEqual([6]);

    let previousTid0Poc: number | null = null;
    const pictureOrderCounts = pictures.map(({ nal, header }) => {
      const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
      if (((nal[1] ?? 0) & 7) - 1 === 0) previousTid0Poc = poc;
      return poc;
    });
    expect(pictureOrderCounts).toEqual([0, 8, 4, 2, 1, 3, 6, 5, 7]);
    expect(pictures.filter(({ expectedPlaneMd5s }) => expectedPlaneMd5s !== null)).toHaveLength(8);

    const indexByPoc = new Map(pictureOrderCounts.map((poc, index) => [poc, index]));
    const dependencies = pictures.map(({ header }, index) => {
      const rps = header.shortTermRefPicSet;
      const dependencyPocs = new Set<number>();
      if (rps) {
        for (const [deltas, usedFlags] of [
          [rps.deltaPocS0, rps.usedByCurrPicS0],
          [rps.deltaPocS1, rps.usedByCurrPicS1],
        ] as const) {
          for (let referenceIndex = 0; referenceIndex < deltas.length; referenceIndex++) {
            if (usedFlags[referenceIndex])
              dependencyPocs.add(pictureOrderCounts[index]! + deltas[referenceIndex]!);
          }
        }
      }
      expect(header.longTermRefPics).toHaveLength(0);
      const referenceIndexes = [...dependencyPocs].map((poc) => {
        const referenceIndex = indexByPoc.get(poc);
        if (referenceIndex === undefined || referenceIndex >= index)
          throw new Error(
            `Main 4:2:2 10-bit POC ${pictureOrderCounts[index]} has invalid ref POC ${poc}`,
          );
        return referenceIndex;
      });
      return referenceIndexes.sort((left, right) => left - right);
    });

    const references: ReferenceImage[] = [];
    const decodedByPoc = new Map<number, (Uint8Array | Uint16Array)[]>();
    let checkedPictureHashes = 0;
    previousTid0Poc = null;
    for (const entry of pictures) {
      const poc = derivePictureOrderCnt(sps, entry.header, previousTid0Poc);
      const lists =
        entry.header.sliceType === SLICE_TYPE_B
          ? buildBReferenceLists(sps, entry.header, poc, references)
          : { l0: [], l1: [] };
      const picture = new PictureDecoder(sps, entry.pps, lists.l0, poc, lists.l1).decode([
        entry.nal,
      ]);
      deblockPicture(picture, entry.pps, sps.bitDepthLuma, sps.bitDepthChroma);
      applySao(picture, sps, sps.bitDepthLuma, sps.bitDepthChroma);
      const actualPlaneMd5s = planeMd5s([picture.y, picture.cb, picture.cr]);
      if (entry.expectedPlaneMd5s) {
        expect(actualPlaneMd5s, `POC ${poc} decoded_picture_hash`).toEqual(entry.expectedPlaneMd5s);
        checkedPictureHashes++;
      }
      decodedByPoc.set(poc, [picture.y, picture.cb, picture.cr]);
      references.push({
        ...picture,
        chromaFormatIdc: sps.chromaFormatIdc,
        bitDepthLuma: sps.bitDepthLuma,
        bitDepthChroma: sps.bitDepthChroma,
        pictureOrderCntLsb: entry.header.pictureOrderCntLsb ?? 0,
        pictureOrderCnt: poc,
        isLongTermReference: false,
      });
      if (((entry.nal[1] ?? 0) & 7) - 1 === 0) previousTid0Poc = poc;
    }
    expect(checkedPictureHashes).toBe(8);

    const displayOrderYuv = Buffer.concat(
      [...decodedByPoc.keys()]
        .sort((left, right) => left - right)
        .flatMap((poc) =>
          decodedByPoc
            .get(poc)!
            .map((plane) => Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength)),
        ),
    );
    expect(createHash('md5').update(displayOrderYuv).digest('hex')).toBe(
      '66530b83be6647f87efbb2b9ae6e1e28',
    );

    const parameterNals = nals
      .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
      .map((nal) => nal.data);
    const itemStreams = pictures.map(({ nal }, index) =>
      asAnnexB([...(index === 0 ? parameterNals : []), nal]),
    );
    const heif = wrapHevcPredChain(
      itemStreams,
      dependencies.map((indexes) => indexes.map((index) => index + 1)),
      sps.picWidthInLumaSamples,
      sps.picHeightInLumaSamples,
      sps.bitDepthLuma,
      sps.chromaFormatIdc,
    );
    const boxes = parseISOBMFF(heif);
    const primaryItem = getHeicInfo(heif, boxes);
    for (const [index] of pictures.entries()) {
      const itemId = index + 1;
      const itemInfo = getHeicInfo(heif, boxes, itemId);
      expect(itemInfo.predReferenceItemIds).toEqual(
        dependencies[index]?.map((referenceIndex) => referenceIndex + 1),
      );
    }

    const image = decodeHeic(heif, { applyTransforms: false });
    expect([image.width, image.height, image.bitDepth]).toEqual([1920, 1080, 10]);
    expect(primaryItem.predReferenceItemIds).toEqual(
      dependencies.at(-1)?.map((referenceIndex) => referenceIndex + 1),
    );
  }, 30_000);

  it('decodes the standalone official Main 4:2:2 10-bit still picture', () => {
    const bytes = new Uint8Array(
      readFileSync(
        new URL('./fixtures/conformance/main-422-10-b-rext-sony-2.bit', import.meta.url),
      ),
    );
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      '951acc9c846dcb9f8ccbdc0b6971a947144baed2d9021ae4be77bcce106bbe21',
    );
    expect(createHash('md5').update(bytes).digest('hex')).toBe('68d1ac2c930442a111fd76ffed732913');

    const nals = splitAnnexB(bytes);
    const spsNal = nals.find((nal) => nal.type === 33);
    if (!spsNal) throw new Error('Main 4:2:2 10-bit still vector has no SPS');
    const sps = parseSps(spsNal.data);
    expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples]).toEqual([2560, 1600]);
    expect([sps.chromaFormatIdc, sps.bitDepthLuma, sps.bitDepthChroma]).toEqual([2, 10, 10]);
    expect(nals.filter((nal) => isSliceNal(nal.type))).toHaveLength(1);

    const heif = wrapHevc(bytes, sps.width, sps.height, sps.bitDepthLuma, sps.chromaFormatIdc);
    expect(getFtypInfo(heif)?.majorBrand).toBe('heix');
    const boxes = parseISOBMFF(heif);
    const info = getHeicInfo(heif, boxes);
    const planes = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
    const decodedYuv = Buffer.concat(
      [planes.y, planes.cb, planes.cr].map((plane) =>
        Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength),
      ),
    );
    expect(createHash('md5').update(decodedYuv).digest('hex')).toBe(
      'fd163bcbdc24792a23781ee7aace74eb',
    );

    const image = decodeHeic(heif, { applyTransforms: false });
    expect([image.width, image.height, image.bitDepth]).toEqual([2560, 1600, 10]);

    // libheif 1.23.4 (`heif-convert -C nn`) RGBA8 reference samples; allow one
    // code value for implementation-specific fixed-point rounding.
    const renderSamples = [
      [0, 0, [78, 79, 66, 255]],
      [1, 0, [77, 78, 65, 255]],
      [2, 0, [77, 78, 65, 255]],
      [0, 1, [80, 79, 68, 255]],
      [127, 79, [201, 194, 172, 255]],
      [640, 400, [57, 54, 35, 255]],
      [1280, 800, [158, 156, 142, 255]],
      [1920, 1200, [149, 148, 138, 255]],
      [2559, 1599, [30, 48, 7, 255]],
    ] as const;
    for (const [x, y, expected] of renderSamples) {
      const offset = (y * image.width + x) * 4;
      for (let channel = 0; channel < 4; channel++)
        expect(Math.abs(image.data[offset + channel]! - expected[channel]!)).toBeLessThanOrEqual(1);
    }
  }, 30_000);
});
