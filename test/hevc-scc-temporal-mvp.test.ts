import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { applySao } from '../src/hevc/sao';
import { deblockPicture } from '../src/hevc/deblock';
import { BitReader, isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal';
import { PictureDecoder } from '../src/hevc/picture';
import { parsePps } from '../src/hevc/pps';
import {
  buildBReferenceLists,
  buildReferenceList0,
  createCurrentPictureReference,
  derivePictureOrderCnt,
  type PictureReference,
} from '../src/hevc/reference-list';
import { parseSliceHeader, SLICE_TYPE_B, SLICE_TYPE_P } from '../src/hevc/slice-header';
import { parseSps } from '../src/hevc/sps';

type Vector = {
  name: string;
  fileName: string;
  bitstreamSha256: string;
  yuvMd5: string;
  intraBoundaryFilteringDisabled: boolean;
  chromaFormatIdc: number;
};

const vectors: Vector[] = [
  {
    name: 'IBF_Disabled_A_MediaTek_2',
    fileName: 'ibf-disabled-a-mediatek-2.bit',
    bitstreamSha256: 'dd2676efc9c2b25412b24fc0853a1598ac665265ab399c72894a067f40df8120',
    yuvMd5: 'cf2d0bf228b256b8f70fe4b4d2e7f90d',
    intraBoundaryFilteringDisabled: false,
    chromaFormatIdc: 3,
  },
  {
    name: 'IBF_Disabled_B_MediaTek_2',
    fileName: 'ibf-disabled-b-mediatek-2.bit',
    bitstreamSha256: '84fda06d890ea83b35b3a7374c28f8188ee7452a1fecba794e649632b13fd4a9',
    yuvMd5: '44bcdae6a7357c23f10dea63769e7598',
    intraBoundaryFilteringDisabled: true,
    chromaFormatIdc: 1,
  },
];

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function md5(bytes: Uint8Array): string {
  return createHash('md5').update(bytes).digest('hex');
}

describe('HEVC SCC temporal MVP with current-picture-only collocated motion', () => {
  for (const vector of vectors) {
    it(`matches the full official ${vector.name} reconstruction`, () => {
      const bytes = new Uint8Array(
        readFileSync(new URL(`./fixtures/conformance/${vector.fileName}`, import.meta.url)),
      );
      expect(sha256(bytes)).toBe(vector.bitstreamSha256);

      const nals = splitAnnexB(bytes);
      const spsNal = nals.find((nal) => nal.type === 33);
      if (!spsNal) throw new Error(`${vector.name} has no SPS`);
      const sps = parseSps(spsNal.data);
      const ppsById = new Map(
        nals
          .filter((nal) => nal.type === 34)
          .map((nal) => {
            const pps = parsePps(nal.data);
            return [pps.ppsId, pps] as const;
          }),
      );

      expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples]).toEqual([1280, 720]);
      expect(sps.chromaFormatIdc).toBe(vector.chromaFormatIdc);
      expect([sps.bitDepthLuma, sps.bitDepthChroma]).toEqual([8, 8]);
      expect(sps.screenContentExtension?.intraBoundaryFilteringDisabled).toBe(
        vector.intraBoundaryFilteringDisabled,
      );

      type PictureGroup = {
        ppsId: number;
        pps: ReturnType<typeof parsePps>;
        slices: Uint8Array[];
      };
      const pictures: PictureGroup[] = [];
      let current: PictureGroup | null = null;
      let previousIndependentHeader: ReturnType<typeof parseSliceHeader> | undefined;

      for (const nal of nals) {
        if (!isSliceNal(nal.type)) continue;
        const reader = new BitReader(toRbsp(nal.data));
        reader.readBit(); // first_slice_segment_in_pic_flag
        if (nal.type >= 16 && nal.type <= 23) reader.readBit(); // no_output_of_prior_pics_flag
        const ppsId = reader.ue();
        const pps = ppsById.get(ppsId);
        if (!pps) throw new Error(`${vector.name} references missing PPS ${ppsId}`);
        const header = parseSliceHeader(nal.data, sps, pps, previousIndependentHeader);
        if (header.firstSliceInPic) {
          current = { ppsId, pps, slices: [] };
          pictures.push(current);
        }
        if (!current || current.ppsId !== ppsId)
          throw new Error(`${vector.name} has a slice segment without its picture/PPS`);
        current.slices.push(nal.data);
        if (!header.dependentSliceSegment) previousIndependentHeader = header;
      }

      expect(pictures).toHaveLength(33);
      const references: PictureReference[] = [];
      const decodedPictures: {
        poc: number;
        planes: readonly Uint8Array[];
        header: ReturnType<typeof parseSliceHeader>;
        collocatedHasExternalMotion: boolean | null;
        collocatedHasInterMotion: boolean | null;
      }[] = [];
      let previousTid0Poc: number | null = null;
      const sliceCounts = { predictive: 0, bidirectional: 0 };

      for (const entry of pictures) {
        const header = parseSliceHeader(entry.slices[0], sps, entry.pps);
        const poc = derivePictureOrderCnt(sps, header, previousTid0Poc);
        let list0: PictureReference[] = [];
        let list1: PictureReference[] = [];
        let collocated: PictureReference | null = null;

        if (header.sliceType === SLICE_TYPE_P) {
          sliceCounts.predictive++;
          list0 = buildReferenceList0(sps, header, poc, references);
        } else {
          expect(header.sliceType).toBe(SLICE_TYPE_B);
          sliceCounts.bidirectional++;
          const lists = buildBReferenceLists(
            sps,
            header,
            poc,
            references,
            header.currentPictureReferenceEnabled
              ? createCurrentPictureReference(sps, poc)
              : undefined,
          );
          list0 = [...lists.l0];
          list1 = [...lists.l1];
          const collocatedList = header.collocatedFromL0 ? list0 : list1;
          collocated = collocatedList[header.collocatedRefIdx] ?? null;
        }

        if (poc === 16) {
          expect(header.sliceType).toBe(SLICE_TYPE_B);
          expect(header.sliceTemporalMvpEnabled).toBe(true);
          expect(header.currentPictureReferenceEnabled).toBe(true);
          expect(collocated?.pictureOrderCnt).toBe(0);
          expect(collocated?.hasExternalInterMotion).toBe(false);
          expect(collocated?.interMap?.some((value) => value === 1)).toBe(true);
        }

        const picture = new PictureDecoder(sps, entry.pps, list0, poc, list1).decode(entry.slices);
        deblockPicture(picture, entry.pps, sps.bitDepthLuma, sps.bitDepthChroma);
        applySao(picture, sps, sps.bitDepthLuma, sps.bitDepthChroma);
        decodedPictures.push({
          poc,
          planes: [picture.y, picture.cb, picture.cr],
          header,
          collocatedHasExternalMotion: collocated?.hasExternalInterMotion ?? null,
          collocatedHasInterMotion: collocated?.interMap?.some((value) => value === 1) ?? null,
        });
        references.push({
          ...picture,
          chromaFormatIdc: sps.chromaFormatIdc,
          bitDepthLuma: sps.bitDepthLuma,
          bitDepthChroma: sps.bitDepthChroma,
          pictureOrderCntLsb: header.pictureOrderCntLsb ?? 0,
          pictureOrderCnt: poc,
          isLongTermReference: false,
        });
        if (((entry.slices[0][1] ?? 0) & 7) - 1 === 0) previousTid0Poc = poc;
      }

      expect(sliceCounts).toEqual({ predictive: 2, bidirectional: 31 });
      expect(decodedPictures.find((picture) => picture.poc === 16)).toMatchObject({
        collocatedHasExternalMotion: false,
        collocatedHasInterMotion: true,
      });
      const displayOrderYuv = Buffer.concat(
        decodedPictures
          .slice()
          .sort((left, right) => left.poc - right.poc)
          .flatMap((picture) => picture.planes.map((plane) => Buffer.from(plane))),
      );
      expect(md5(displayOrderYuv)).toBe(vector.yuvMd5);
    });
  }
});
