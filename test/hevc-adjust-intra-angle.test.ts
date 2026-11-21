import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { decodeHeic } from '../src/decoder';
import { getHeicInfo } from '../src/container/heic';
import { getFtypInfo, parseISOBMFF } from '../src/container/heif';
import { BitReader, isSliceNal, splitAnnexB, toRbsp } from '../src/hevc/nal';
import { parseSps } from '../src/hevc/sps';
import { decodeItemPlanes } from '../src/planes';
import { wrapHevc } from '../scripts/lib/heif';

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

function pictureGroups(nals: ReturnType<typeof splitAnnexB>) {
  const groups: ReturnType<typeof splitAnnexB>[] = [];
  let current: ReturnType<typeof splitAnnexB> = [];
  for (const nal of nals) {
    if (isSliceNal(nal.type)) {
      const firstSlice = new BitReader(toRbsp(nal.data)).readBit() === 1;
      if (firstSlice && current.some((entry) => isSliceNal(entry.type))) {
        groups.push(current);
        current = [];
      }
      current.push(nal);
    } else if (current.some((entry) => isSliceNal(entry.type))) {
      current.push(nal);
    }
  }
  if (current.some((entry) => isSliceNal(entry.type))) groups.push(current);
  return groups;
}

function planeMd5(plane: Uint8Array | Uint16Array): string {
  return createHash('md5')
    .update(Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength))
    .digest('hex');
}

it('decodes all chroma intra modes in the official 4:2:2 angle-adjustment vector', () => {
  const bytes = new Uint8Array(
    readFileSync(
      new URL('./fixtures/conformance/adjust-ipred-angle-a-mitsubishi-2.bit', import.meta.url),
    ),
  );
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    '54b72f9b2f5bd7c25049a63fd4289ab19735af5b30c2105dedd7aa5ae90a72e8',
  );

  const nals = splitAnnexB(bytes);
  const parameterSets = nals.filter((nal) => [32, 33, 34].includes(nal.type));
  const spsNal = nals.find((nal) => nal.type === 33);
  if (!spsNal) throw new Error('official angle-adjustment vector has no SPS');
  const sps = parseSps(spsNal.data);
  expect([sps.width, sps.height, sps.bitDepthLuma, sps.chromaFormatIdc]).toEqual([
    1920, 1080, 10, 2,
  ]);

  const groups = pictureGroups(nals);
  expect(groups).toHaveLength(3);
  const sequenceHash = createHash('md5');
  let firstHeif: Uint8Array | undefined;

  for (const [pictureIndex, group] of groups.entries()) {
    const slices = group.filter((nal) => isSliceNal(nal.type));
    const expected = group
      .filter((nal) => nal.type === 40)
      .map((nal) => decodedPictureHash(nal.data))
      .find((hash): hash is string[] => hash !== null);
    if (!expected)
      throw new Error(
        `official angle-adjustment picture ${pictureIndex} has no decoded_picture_hash`,
      );

    const itemStream = Buffer.concat(
      [...parameterSets, ...slices].flatMap((nal) => [
        Buffer.from([0, 0, 0, 1]),
        Buffer.from(nal.data),
      ]),
    );
    const input = wrapHevc(
      itemStream,
      sps.width,
      sps.height,
      sps.bitDepthLuma,
      sps.chromaFormatIdc,
      sps.bitDepthChroma,
    );
    firstHeif ??= input;

    const boxes = parseISOBMFF(input);
    const info = getHeicInfo(input, boxes);
    expect(getFtypInfo(input)?.majorBrand).toBe('heix');
    expect(info.hvcC).toMatchObject({ chromaFormatIdc: 2, bitDepthLumaMinus8: 2 });

    const planes = decodeItemPlanes(input, boxes, info, info.primaryItemId);
    const actual = [planes.y, planes.cb, planes.cr].map(planeMd5);
    expect(actual).toEqual(expected);
    for (const plane of [planes.y, planes.cb, planes.cr])
      sequenceHash.update(Buffer.from(plane.buffer, plane.byteOffset, plane.byteLength));
  }

  expect(sequenceHash.digest('hex')).toBe('b045776950c2e06d35348bd03268c07f');
  if (!firstHeif) throw new Error('official angle-adjustment HEIF wrapper was not built');
  const image = decodeHeic(firstHeif);
  expect([image.width, image.height, image.data.length]).toEqual([1920, 1080, 1920 * 1080 * 4]);
}, 30_000);
