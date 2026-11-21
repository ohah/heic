import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'bun:test';
import { getHeicInfo } from '../src/container/heic.js';
import { parseISOBMFF } from '../src/container/heif.js';
import { isSliceNal, splitAnnexB } from '../src/hevc/nal.js';
import { parsePps } from '../src/hevc/pps.js';
import { parseSliceHeader, SLICE_TYPE_P } from '../src/hevc/slice-header.js';
import { parseSps } from '../src/hevc/sps.js';
import { decodeHeic } from '../src/decoder.js';
import { decodeItemPlanes } from '../src/planes.js';
import { wrapHevc } from '../scripts/lib/heif.js';

const fixture = new Uint8Array(
  readFileSync(
    new URL('./fixtures/generated/scc-ibc-no-palette-hm-scm-16.15-scm-8.5.hevc', import.meta.url),
  ),
);

it('decodes an HM-SCM IBC still image with palette mode disabled', () => {
  expect(createHash('sha256').update(fixture).digest('hex')).toBe(
    'b07de56010730ebe6b5625c53199f1628df28ac9d5a4c46e085b080d824e4c98',
  );

  const nals = splitAnnexB(fixture);
  const spsNal = nals.find((nal) => nal.type === 33);
  const ppsNal = nals.find((nal) => nal.type === 34);
  const slices = nals.filter((nal) => isSliceNal(nal.type));
  if (!spsNal || !ppsNal || slices.length !== 1)
    throw new Error('synthetic HM-SCM fixture must contain one picture and its parameter sets');

  const sps = parseSps(spsNal.data);
  const pps = parsePps(ppsNal.data);
  const header = parseSliceHeader(slices[0].data, sps, pps);
  expect([sps.picWidthInLumaSamples, sps.picHeightInLumaSamples, sps.chromaFormatIdc]).toEqual([
    128, 128, 1,
  ]);
  expect(sps.screenContentExtension).toMatchObject({
    currPicRefEnabled: true,
    paletteModeEnabled: false,
  });
  expect(pps.screenContentExtension?.currPicRefEnabled).toBe(true);
  expect(header.sliceType).toBe(SLICE_TYPE_P);
  expect(header.currentPictureReferenceEnabled).toBe(true);

  const heif = wrapHevc(fixture, 128, 128, 8, 1);
  const boxes = parseISOBMFF(heif);
  const info = getHeicInfo(heif, boxes);
  expect(info.primaryItemType).toBe('hvc1');
  expect(info.width).toBe(128);
  expect(info.height).toBe(128);

  const planes = decodeItemPlanes(heif, boxes, info, info.primaryItemId);
  expect(planes.interMap?.reduce((count, value) => count + (value === 1 ? 1 : 0), 0)).toBe(1020);
  expect(planes.motionIsExternal?.reduce((count, value) => count + value, 0)).toBe(0);
  expect(
    [planes.y, planes.cb, planes.cr].map((plane) => createHash('md5').update(plane).digest('hex')),
  ).toEqual([
    '15f05566bc3d2a77adef18ffee54349a',
    '4cc6a2a18f429a06bf382e89690e9caf',
    'd87adca7674985819f7f9d4b06b0177c',
  ]);

  const rgba = decodeHeic(heif);
  expect([rgba.width, rgba.height, rgba.data.length]).toEqual([128, 128, 128 * 128 * 4]);
});
