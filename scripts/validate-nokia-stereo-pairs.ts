// Validate ordered HEIF `ster` groups against FFmpeg's decoded YUV planes.
import { createHash } from 'node:crypto';
import { decodeHeicStereoPairs } from '../src/decoder';
import { getHeicInfo } from '../src/container/heic';
import { findBox, parseISOBMFF } from '../src/container/heif';
import { decodeItemPlanes } from '../src/planes';

const source =
  'https://raw.githubusercontent.com/nokiatech/heif/f01283f3e64ccc6e6ab489bd556d454879069185/content/nokia';
const fileSha256 = '6ddd7929f30d7e521bd34f24bf302962e3f956dd8f5e65f792006395630b8e33';
const expectedPairs = [
  {
    groupId: 1012,
    leftItemId: 1002,
    rightItemId: 1008,
    width: 1200,
    height: 800,
    leftYuvSha256: 'a2f40b91a4cf460ca74cc3bbf77f4223753630b5ed26c98cbdaed531cd23efed',
    rightYuvSha256: 'cfb8430ff631e0ea0b4a564a2a90ab390663f322d35c029484eb01c502d88159',
  },
  {
    groupId: 1013,
    leftItemId: 1005,
    rightItemId: 1011,
    width: 480,
    height: 320,
    leftYuvSha256: 'f7480482d1ca92f7279cdffc4d78a8a574f66ad79b282fcce327181dad4de493',
    rightYuvSha256: '170d8fc05908fa65ab6b3a2af527da44a85b059cd2b00e00cb2134e2aa071e21',
  },
] as const;

const response = await fetch(`${source}/stereo_1200x800.heic`, {
  signal: AbortSignal.timeout(30_000),
});
if (!response.ok) throw new Error(`stereo_1200x800.heic: HTTP ${response.status}`);
const file = new Uint8Array(await response.arrayBuffer());
const actualFileSha256 = createHash('sha256').update(file).digest('hex');
if (actualFileSha256 !== fileSha256)
  throw new Error(`stereo_1200x800.heic: file SHA-256 mismatch (${actualFileSha256})`);

const boxes = parseISOBMFF(file);
const info = getHeicInfo(file, boxes);
if (
  info.primaryItemType !== 'hvc1' ||
  info.width !== 1200 ||
  info.height !== 800 ||
  info.stereoPairs?.length !== expectedPairs.length
)
  throw new Error('stereo_1200x800.heic: unexpected HEIF stereo metadata');

const grpl = findBox(findBox(boxes, 'meta')?.children ?? [], 'grpl');
const stereoGroupCount = grpl?.children?.filter((group) => group.type === 'ster').length ?? 0;
if (stereoGroupCount !== expectedPairs.length)
  throw new Error(`expected ${expectedPairs.length} ster groups, found ${stereoGroupCount}`);

const decodedPairs = decodeHeicStereoPairs(file);
if (decodedPairs.length !== expectedPairs.length)
  throw new Error(`expected ${expectedPairs.length} decoded pairs, found ${decodedPairs.length}`);

for (let index = 0; index < expectedPairs.length; index++) {
  const expected = expectedPairs[index];
  const metadata = info.stereoPairs![index];
  const decoded = decodedPairs[index];
  if (
    metadata.groupId !== expected.groupId ||
    metadata.leftItemId !== expected.leftItemId ||
    metadata.rightItemId !== expected.rightItemId ||
    decoded.leftItemId !== expected.leftItemId ||
    decoded.rightItemId !== expected.rightItemId
  )
    throw new Error(`ster group ${index}: left/right item order mismatch`);
  if (
    decoded.left.width !== expected.width ||
    decoded.left.height !== expected.height ||
    decoded.right.width !== expected.width ||
    decoded.right.height !== expected.height ||
    decoded.left.data.length !== expected.width * expected.height * 4 ||
    decoded.right.data.length !== expected.width * expected.height * 4
  )
    throw new Error(`ster group ${expected.groupId}: public RGBA decode dimensions mismatch`);

  for (const [itemId, side, expectedYuvSha256] of [
    [expected.leftItemId, 'left', expected.leftYuvSha256],
    [expected.rightItemId, 'right', expected.rightYuvSha256],
  ] as const) {
    const itemInfo = getHeicInfo(file, boxes, itemId);
    const planes = decodeItemPlanes(file, boxes, itemInfo, itemId);
    const actualYuvSha256 = createHash('sha256')
      .update(planes.y)
      .update(planes.cb)
      .update(planes.cr)
      .digest('hex');
    if (actualYuvSha256 !== expectedYuvSha256)
      throw new Error(`item ${itemId} (${side}): FFmpeg Y/Cb/Cr hash mismatch`);
  }
  console.log(
    `ster ${expected.groupId}: left ${expected.leftItemId} / right ${expected.rightItemId}, ${expected.width}x${expected.height}; both Y/Cb/Cr planes match FFmpeg 9.0.1.`,
  );
}
