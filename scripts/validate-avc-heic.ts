import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { decode } from '../src/async.js';
import { prepareAvcDecodeOptions, parseAvcSps } from '../src/avc.js';
import { splitAnnexB } from '../src/hevc/nal.js';
import { box, buildHeif, full, u16, u32 } from '../test/helpers/heif.js';

const annexBPath = process.env.AVC_ANNEX_B,
  referencePath = process.env.AVC_YUV_REFERENCE;
if (!annexBPath || !referencePath)
  throw new Error('Set AVC_ANNEX_B and AVC_YUV_REFERENCE to H.264 and planar I420 files.');

const annexB = new Uint8Array(readFileSync(annexBPath)),
  reference = new Uint8Array(readFileSync(referencePath)),
  nals = splitAnnexB(annexB).map((entry) => entry.data),
  sps = nals.find((nal) => (nal[0] & 31) === 7),
  pps = nals.find((nal) => (nal[0] & 31) === 8);
if (!sps || !pps) throw new Error('AVC_ANNEX_B must include SPS and PPS NAL units.');

const parsedSps = parseAvcSps(sps),
  sampleNals = nals.filter((nal) => ![7, 8].includes(nal[0] & 31)),
  sample = Buffer.concat(sampleNals.flatMap((nal) => [u32(nal.length), nal])),
  avcCParts: Uint8Array[] = [
    Buffer.from([1, sps[1], sps[2], sps[3], 255, 225]),
    u16(sps.length),
    sps,
    Buffer.from([1]),
    u16(pps.length),
    pps,
  ];
if (parsedSps.profileIdc !== 66 && parsedSps.profileIdc !== 77 && parsedSps.profileIdc !== 100)
  throw new Error(`Reference profile ${parsedSps.profileIdc} is outside the bundled AVC subset.`);
if ([44, 83, 86, 100, 110, 118, 122, 128, 134, 135, 138, 139, 144, 244].includes(sps[1]))
  avcCParts.push(
    Buffer.from([
      0xfc | parsedSps.chromaFormatIdc,
      0xf8 | (parsedSps.bitDepthLuma - 8),
      0xf8 | (parsedSps.bitDepthChroma - 8),
      0,
    ]),
  );
const image = buildHeif(
  [
    {
      id: 11,
      type: 'avc1',
      data: sample,
      properties: [
        box('avcC', Buffer.concat(avcCParts)),
        full('ispe', 0, u32(parsedSps.displayWidth), u32(parsedSps.displayHeight)),
        full('pixi', 0, Buffer.from([3, parsedSps.bitDepthLuma, parsedSps.bitDepthChroma, 8])),
      ],
    },
  ],
  11,
);
if (process.env.AVC_WRAPPED_HEIF_OUTPUT) writeFileSync(process.env.AVC_WRAPPED_HEIF_OUTPUT, image);
const options = await prepareAvcDecodeOptions(image, {}),
  planes = options.externalBaseLayerPlanes?.[11];
if (!planes) throw new Error('AVC item was not routed through the bundled decoder.');
const chromaWidth = Math.ceil(planes.width / 2),
  chromaHeight = Math.ceil(planes.height / 2),
  expectedLength = planes.width * planes.height + 2 * chromaWidth * chromaHeight;
if (reference.length !== expectedLength)
  throw new Error(`I420 reference has ${reference.length} bytes; expected ${expectedLength}.`);
let mismatchedSamples = 0;
for (let index = 0; index < planes.y.length; index++)
  if (planes.y[index] !== reference[index]) mismatchedSamples++;
const cbOffset = planes.width * planes.height,
  crOffset = cbOffset + chromaWidth * chromaHeight;
for (let index = 0; index < planes.cb.length; index++)
  if (planes.cb[index] !== reference[cbOffset + index]) mismatchedSamples++;
for (let index = 0; index < planes.cr.length; index++)
  if (planes.cr[index] !== reference[crOffset + index]) mismatchedSamples++;
if (mismatchedSamples)
  throw new Error(`${mismatchedSamples} decoded Y/Cb/Cr samples differ from the reference.`);

const execution = process.env.AVC_EXECUTION === 'worker' ? 'worker' : 'main',
  rgba = await decode(image, { execution });
console.log(
  JSON.stringify({
    execution,
    profileIdc: parsedSps.profileIdc,
    size: [rgba.width, rgba.height],
    yuvBytes: expectedLength,
    mismatchedSamples,
    annexBSha256: createHash('sha256').update(annexB).digest('hex'),
    referenceSha256: createHash('sha256').update(reference).digest('hex'),
    wrappedHeifSha256: createHash('sha256').update(image).digest('hex'),
    rgbaBytes: rgba.data.length,
  }),
);
