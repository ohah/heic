import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'bun:test';
import { decodeHeic } from '../src/decoder';
import { getHeicInfo } from '../src/container/heic';
import { parseISOBMFF } from '../src/container/heif';
import { deblockPicture } from '../src/hevc/deblock';
import { BitReader, isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal';
import { parsePps } from '../src/hevc/pps';
import { PictureDecoder, type ReferenceImage } from '../src/hevc/picture';
import { buildReferenceList0, derivePictureOrderCnt } from '../src/hevc/reference-list';
import { applySao } from '../src/hevc/sao';
import { parseSliceHeader, SLICE_TYPE_I, SLICE_TYPE_P } from '../src/hevc/slice-header';
import { parseSps } from '../src/hevc/sps';
import { decodeItemPlanes } from '../src/planes';
import { wrapHevcPredChain } from '../scripts/lib/heif';

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

function annexB(nals: readonly Uint8Array[]): Buffer {
  return Buffer.concat(nals.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), Buffer.from(nal)]));
}

const vectors = [
  {
    name: '10-bit 4:2:2 High Throughput',
    fileName: 'wpp-tiles-high-tp-10-422-sequence.bit',
    sha256: '25dbd378d19e10b020f413213a3ca183ff4c5132500ddecf84d7d9d22218f301',
    width: 1920,
    height: 1080,
    chromaFormatIdc: 2,
    bitDepth: 10,
    cabacBypassAlignment: false,
    extendedPrecisionProcessing: false,
    sequenceMd5: '32e6b91c9497e161fe66c1fbd3cec51e',
  },
  {
    name: 'CABAC bypass-aligned High Throughput 4:4:4 14 profile',
    fileName: 'wpp-tiles-high-tp-bypass-align-1-sequence.bit',
    sha256: 'bdc2868a887a56a58aaef4046f4341525c320616834189c9e2d2f582e08340c7',
    width: 1024,
    height: 768,
    chromaFormatIdc: 1,
    bitDepth: 8,
    cabacBypassAlignment: true,
    extendedPrecisionProcessing: false,
    sequenceMd5: '5347f09153fd54b24a37427ca0bd9b30',
  },
  {
    name: 'CABAC bypass alignment disabled, High Throughput 4:4:4 14 profile',
    fileName: 'wpp-tiles-high-tp-bypass-align-0-sequence.bit',
    sha256: '00075c57f3c1e17619904b60c5352c52814eaff495012df453763fe7a5dcb9f2',
    width: 1024,
    height: 768,
    chromaFormatIdc: 1,
    bitDepth: 8,
    cabacBypassAlignment: false,
    extendedPrecisionProcessing: false,
    sequenceMd5: 'e134676d233f3f5b49ab4c252d5d18be',
  },
  {
    name: 'extended precision, High Throughput 4:4:4 14 profile',
    fileName: 'wpp-tiles-high-tp-extprec-1-sequence.bit',
    sha256: 'be5be06a8dd2c873e8b386b4e4eab2f45713277f1d6f2e6bde5c96e6d7426af4',
    width: 1024,
    height: 768,
    chromaFormatIdc: 1,
    bitDepth: 8,
    cabacBypassAlignment: false,
    extendedPrecisionProcessing: true,
    sequenceMd5: '95f0019aed6c9c845fe5e2088aefdc39',
  },
];

describe('HEVC High Throughput sequences', () => {
  for (const vector of vectors) {
    it(`reconstructs all official tiles+WPP pictures in ${vector.name}`, () => {
      const bytes = new Uint8Array(
        readFileSync(new URL(`./fixtures/conformance/${vector.fileName}`, import.meta.url)),
      );
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(vector.sha256);

      const nals = splitAnnexB(bytes);
      const spsNal = nals.find((nal) => nal.type === 33);
      if (!spsNal) throw new Error(`official ${vector.name} stream has no SPS`);
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
        header: ReturnType<typeof parseSliceHeader>;
        independentHeader: ReturnType<typeof parseSliceHeader>;
        pps: ReturnType<typeof parsePps>;
        slices: Uint8Array[];
        expectedPlaneMd5s: string[] | null;
      };
      const pictures: PictureGroup[] = [];
      let current: PictureGroup | null = null;
      for (const nal of nals) {
        if (isSliceNal(nal.type)) {
          const reader = new BitReader(toRbsp(nal.data));
          reader.readBit();
          if (nal.type >= 16 && nal.type <= 23) reader.readBit();
          const pps = ppsById.get(reader.ue());
          if (!pps)
            throw new Error('official 4:2:2 High Throughput slice references a missing PPS');
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
          if (!current) throw new Error('official 4:2:2 slice precedes the first picture slice');
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
      expect([sps.chromaFormatIdc, sps.bitDepthLuma, sps.bitDepthChroma]).toEqual([
        vector.chromaFormatIdc,
        vector.bitDepth,
        vector.bitDepth,
      ]);
      expect(sps.cabacBypassAlignmentEnabled).toBe(vector.cabacBypassAlignment);
      expect(sps.extendedPrecisionProcessingEnabled).toBe(vector.extendedPrecisionProcessing);
      expect(pictures).toHaveLength(3);
      expect(pictures.map(({ header }) => header.sliceType)).toEqual([
        SLICE_TYPE_I,
        SLICE_TYPE_P,
        SLICE_TYPE_P,
      ]);
      expect(pictures.every(({ pps }) => pps.tilesEnabled && pps.entropyCodingSyncEnabled)).toBe(
        true,
      );

      const references: ReferenceImage[] = [];
      let previousTid0Poc: number | null = null;
      const pictureOrderCounts: number[] = [];
      const outputPlanes: (Uint8Array | Uint16Array)[][] = [];
      const reconstructedPlaneMd5s: string[][] = [];
      for (const entry of pictures) {
        const poc = derivePictureOrderCnt(sps, entry.header, previousTid0Poc);
        const list0 =
          entry.header.sliceType === SLICE_TYPE_P
            ? buildReferenceList0(sps, entry.header, poc, references)
            : [];
        const picture = new PictureDecoder(sps, entry.pps, list0, poc).decode(entry.slices);
        deblockPicture(picture, entry.pps, sps.bitDepthLuma, sps.bitDepthChroma);
        applySao(picture, sps, sps.bitDepthLuma, sps.bitDepthChroma);
        expect(entry.expectedPlaneMd5s, `POC ${poc} decoded_picture_hash`).not.toBeNull();
        expect(planeMd5s([picture.y, picture.cb, picture.cr]), `POC ${poc}`).toEqual(
          entry.expectedPlaneMd5s,
        );

        reconstructedPlaneMd5s.push(planeMd5s([picture.y, picture.cb, picture.cr]));
        outputPlanes.push([picture.y, picture.cb, picture.cr]);
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
      const planeBytes = (plane: Uint8Array | Uint16Array) =>
        Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength);
      const sequence = Buffer.concat(outputPlanes.flatMap((planes) => planes.map(planeBytes)));
      expect(createHash('md5').update(sequence).digest('hex')).toBe(vector.sequenceMd5);

      const parameterSets = nals
        .filter((nal) => nal.type === 32 || nal.type === 33 || nal.type === 34)
        .map((nal) => nal.data);
      const itemStreams = pictures.map((picture, index) =>
        annexB([...(index === 0 ? parameterSets : []), ...picture.slices]),
      );
      const syntheticHeif = wrapHevcPredChain(
        itemStreams,
        [[], [1], [1, 2]],
        sps.width,
        sps.height,
        sps.bitDepthLuma,
        sps.chromaFormatIdc,
      );
      const boxes = parseISOBMFF(syntheticHeif);
      const heifPlaneMd5s = [1, 2, 3].map((itemId) => {
        const itemInfo = getHeicInfo(syntheticHeif, boxes, itemId);
        const decoded = decodeItemPlanes(syntheticHeif, boxes, itemInfo, itemId);
        return planeMd5s([decoded.y, decoded.cb, decoded.cr]);
      });
      expect(heifPlaneMd5s).toEqual(reconstructedPlaneMd5s);
      const rendered = decodeHeic(syntheticHeif);
      expect([rendered.width, rendered.height, rendered.bitDepth]).toEqual([
        vector.width,
        vector.height,
        vector.bitDepth,
      ]);
    });
  }
});
