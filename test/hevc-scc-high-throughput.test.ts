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
import { parseSliceHeader, SLICE_TYPE_B, SLICE_TYPE_P } from '../src/hevc/slice-header';
import { parseSps } from '../src/hevc/sps';

type Vector = {
  name: string;
  fileName: string;
  sha256: string;
  width: number;
  height: number;
  bitDepth: number;
  cabacBypassAlignment: boolean;
  sliceTypes: number[];
  pictureOrderCounts: number[];
};

const vectors: Vector[] = [
  {
    name: 'HT_A_SCC_Apple_2',
    fileName: 'ht-a-scc-apple-2.bit',
    sha256: '1046c59afbba3092bea44d2f9aeec060762e776a79bdfeb93804e17a1d0d1c85',
    width: 1920,
    height: 1080,
    bitDepth: 10,
    cabacBypassAlignment: false,
    sliceTypes: [SLICE_TYPE_P, SLICE_TYPE_B, SLICE_TYPE_B],
    pictureOrderCounts: [0, 2, 1],
  },
  {
    name: 'HT_B_SCC_Apple_3',
    fileName: 'ht-b-scc-apple-3.bit',
    sha256: '625df3b76a68ae86ced006a0122a041b230e5a2834ed163ecb20114e796923fc',
    width: 1280,
    height: 720,
    bitDepth: 8,
    cabacBypassAlignment: true,
    sliceTypes: [SLICE_TYPE_P, SLICE_TYPE_P, SLICE_TYPE_P],
    pictureOrderCounts: [0, 1, 2],
  },
];

type PictureGroup = {
  header: ReturnType<typeof parseSliceHeader>;
  independentHeader: ReturnType<typeof parseSliceHeader>;
  pps: ReturnType<typeof parsePps>;
  slices: Uint8Array[];
  expectedPlaneMd5s: string[] | null;
};

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
      throw new Error('decoded_picture_hash must contain three MD5 values');
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

describe('HEVC SCC high-throughput profiles', () => {
  for (const vector of vectors) {
    it(`matches all official pictures in ${vector.name}`, () => {
      const bytes = new Uint8Array(
        readFileSync(new URL(`./fixtures/conformance/${vector.fileName}`, import.meta.url)),
      );
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(vector.sha256);

      const nals = splitAnnexB(bytes);
      const spsNal = nals.find((nal) => nal.type === 33);
      if (!spsNal) throw new Error(`${vector.name} is missing its SPS`);
      const sps = parseSps(spsNal.data);
      const ppsById = new Map(
        nals
          .filter((nal) => nal.type === 34)
          .map((nal) => {
            const pps = parsePps(nal.data);
            return [pps.ppsId, pps] as const;
          }),
      );

      const pictures: PictureGroup[] = [];
      let current: PictureGroup | null = null;
      for (const nal of nals) {
        if (isSliceNal(nal.type)) {
          const bits = new BitReader(toRbsp(nal.data));
          bits.readBit();
          if (nal.type >= 16 && nal.type <= 23) bits.readBit();
          const pps = ppsById.get(bits.ue());
          if (!pps) throw new Error(`${vector.name} references a missing PPS`);
          const header = parseSliceHeader(nal.data, sps, pps, current?.independentHeader);
          if (header.firstSliceInPic) {
            current = {
              header,
              independentHeader: header,
              pps,
              slices: [],
              expectedPlaneMd5s: null,
            };
            pictures.push(current);
          }
          if (!current)
            throw new Error(`${vector.name} has a slice before its first picture slice`);
          if (!header.dependentSliceSegment) current.independentHeader = header;
          current.slices.push(nal.data);
        } else if (current && nal.type === 40) {
          current.expectedPlaneMd5s = decodedPictureHash(nal.data) ?? current.expectedPlaneMd5s;
        }
      }

      expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples]).toEqual([
        vector.width,
        vector.height,
      ]);
      expect(sps.chromaFormatIdc).toBe(3);
      expect([sps.bitDepthLuma, sps.bitDepthChroma]).toEqual([vector.bitDepth, vector.bitDepth]);
      expect(sps.cabacBypassAlignmentEnabled).toBe(vector.cabacBypassAlignment);
      expect(sps.extendedPrecisionProcessingEnabled).toBe(false);
      expect(pictures).toHaveLength(3);
      expect(pictures.map(({ header }) => header.sliceType)).toEqual(vector.sliceTypes);
      expect(pictures.every(({ pps }) => pps.tilesEnabled && pps.entropyCodingSyncEnabled)).toBe(
        true,
      );

      const references: ReferenceImage[] = [];
      let previousTid0Poc: number | null = null;
      const pictureOrderCounts: number[] = [];
      for (const entry of pictures) {
        const poc = derivePictureOrderCnt(sps, entry.header, previousTid0Poc);
        let list0: ReferenceImage[] = [];
        let list1: ReferenceImage[] = [];
        if (entry.header.sliceType === SLICE_TYPE_P) {
          list0 = buildReferenceList0(sps, entry.header, poc, references);
        } else {
          const lists = buildBReferenceLists(
            sps,
            entry.header,
            poc,
            references,
            entry.header.currentPictureReferenceEnabled
              ? createCurrentPictureReference(sps, poc)
              : undefined,
          );
          list0 = lists.l0;
          list1 = lists.l1;
        }

        const picture = new PictureDecoder(sps, entry.pps, list0, poc, list1).decode(entry.slices);
        deblockPicture(picture, entry.pps, sps.bitDepthLuma, sps.bitDepthChroma);
        applySao(picture, sps, sps.bitDepthLuma, sps.bitDepthChroma);
        expect(entry.expectedPlaneMd5s, `${vector.name} POC ${poc} checksum SEI`).not.toBeNull();
        expect(planeMd5s([picture.y, picture.cb, picture.cr]), `${vector.name} POC ${poc}`).toEqual(
          entry.expectedPlaneMd5s,
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
      expect(pictureOrderCounts).toEqual(vector.pictureOrderCounts);
    });
  }
});
