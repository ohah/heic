import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { deblockPicture } from '../src/hevc/deblock';
import { BitReader, isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal';
import { applySao } from '../src/hevc/sao';
import { parsePps } from '../src/hevc/pps';
import { PictureDecoder, type ReferenceImage } from '../src/hevc/picture';
import {
  buildBReferenceLists,
  buildReferenceList0,
  createCurrentPictureReference,
  derivePictureOrderCnt,
} from '../src/hevc/reference-list';
import { parseSliceHeader, SLICE_TYPE_P } from '../src/hevc/slice-header';
import { parseSps } from '../src/hevc/sps';

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
    payloadType += rbsp[position++];

    let payloadSize = 0;
    while (position < rbsp.length && rbsp[position] === 255) {
      payloadSize += 255;
      position++;
    }
    if (position >= rbsp.length) return null;
    payloadSize += rbsp[position++];
    const payload = rbsp.subarray(position, position + payloadSize);
    if (payload.length !== payloadSize) return null;
    position += payloadSize;

    if (payloadType !== 132) continue;
    if (payload[0] !== 0 || payload.length !== 49)
      throw new Error('HT_C decoded_picture_hash SEI must contain three MD5 values');
    return [0, 1, 2].map((component) =>
      Buffer.from(payload.subarray(1 + component * 16, 17 + component * 16)).toString('hex'),
    );
  }
  return null;
}

function planeMd5s(planes: readonly (Uint8Array | Uint16Array)[]): string[] {
  return planes.map((plane) =>
    createHash('md5')
      .update(Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength))
      .digest('hex'),
  );
}

describe('HEVC SCC HT_C tiles and IBC', () => {
  it('matches all three official pictures with tiles, WPP, palette state and current-picture prediction', () => {
    const bytes = new Uint8Array(
      readFileSync(new URL('./fixtures/conformance/ht-c-scc-apple-3.bit', import.meta.url)),
    );
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(
      'b1b142921525da460c9df428ba7adba437f26c415e12a040e9de2ee348677cf0',
    );

    const nals = splitAnnexB(bytes);
    const spsNal = nals.find((nal) => nal.type === 33);
    if (!spsNal) throw new Error('HT_C stream is missing its SPS');
    const sps = parseSps(spsNal.data);
    const ppsById = new Map(
      nals
        .filter((nal) => nal.type === 34)
        .map((nal) => {
          const pps = parsePps(nal.data);
          return [pps.ppsId, pps] as const;
        }),
    );

    const pictures: {
      header: ReturnType<typeof parseSliceHeader>;
      independentHeader: ReturnType<typeof parseSliceHeader>;
      pps: ReturnType<typeof parsePps>;
      slices: Uint8Array[];
      expected: string[] | null;
    }[] = [];
    let current: (typeof pictures)[number] | null = null;

    for (const nal of nals) {
      if (isSliceNal(nal.type)) {
        const bits = new BitReader(toRbsp(nal.data));
        bits.readBit();
        if (nal.type >= 16 && nal.type <= 23) bits.readBit();
        const pps = ppsById.get(bits.ue());
        if (!pps) throw new Error('HT_C stream references a missing PPS');
        const header = parseSliceHeader(nal.data, sps, pps, current?.independentHeader);
        if (header.firstSliceInPic) {
          current = { header, independentHeader: header, pps, slices: [], expected: null };
          pictures.push(current);
        }
        if (!current) throw new Error('HT_C slice precedes the first picture slice');
        if (!header.dependentSliceSegment) current.independentHeader = header;
        current.slices.push(nal.data);
      } else if (current && nal.type === 40) {
        current.expected = decodedPictureHash(nal.data) ?? current.expected;
      }
    }

    expect(pictures).toHaveLength(3);
    expect(pictures.map((picture) => picture.header.sliceType)).toEqual([
      SLICE_TYPE_P,
      SLICE_TYPE_P,
      SLICE_TYPE_P,
    ]);
    expect(sps.chromaFormatIdc).toBe(3);
    expect(sps.bitDepthLuma).toBe(8);
    expect(sps.screenContentExtension?.currPicRefEnabled).toBe(true);
    expect(pictures.every((picture) => picture.pps.tilesEnabled)).toBe(true);
    expect(pictures.every((picture) => picture.pps.entropyCodingSyncEnabled)).toBe(true);

    const references: ReferenceImage[] = [];
    let previousTid0Poc: number | null = null;
    const pictureOrderCounts: number[] = [];
    for (const entry of pictures) {
      const poc = derivePictureOrderCnt(sps, entry.header, previousTid0Poc);
      const currentPicture = entry.header.currentPictureReferenceEnabled
        ? createCurrentPictureReference(sps, poc)
        : undefined;
      let list0: ReferenceImage[] = [];
      let list1: ReferenceImage[] = [];
      if (entry.header.sliceType === SLICE_TYPE_P)
        list0 = buildReferenceList0(sps, entry.header, poc, references);
      else if (entry.header.sliceType === SLICE_TYPE_B) {
        const lists = buildBReferenceLists(sps, entry.header, poc, references, currentPicture);
        list0 = lists.l0;
        list1 = lists.l1;
      }

      const picture = new PictureDecoder(sps, entry.pps, list0, poc, list1).decode(entry.slices);
      deblockPicture(picture, entry.pps, sps.bitDepthLuma, sps.bitDepthChroma);
      applySao(picture, sps, sps.bitDepthLuma, sps.bitDepthChroma);
      expect(entry.expected, `HT_C POC ${poc} has a decoded_picture_hash`).not.toBeNull();
      expect(planeMd5s([picture.y, picture.cb, picture.cr]), `HT_C POC ${poc}`).toEqual(
        entry.expected,
      );

      references.push({
        ...picture,
        chromaFormatIdc: sps.chromaFormatIdc,
        bitDepthLuma: sps.bitDepthLuma,
        bitDepthChroma: sps.bitDepthChroma,
        pictureOrderCntLsb: entry.header.pictureOrderCntLsb ?? 0,
        pictureOrderCnt: poc,
        isLongTermReference: false,
      });
      pictureOrderCounts.push(poc);
      if (((entry.slices[0]?.[1] ?? 0) & 7) - 1 === 0) previousTid0Poc = poc;
    }
    expect(pictureOrderCounts).toEqual([0, 1, 2]);
  });
});
