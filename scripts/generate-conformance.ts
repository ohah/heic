// Development-only reference tooling. ffmpeg/libx265 are NOT runtime dependencies.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { wrapHevc } from './lib/heif';
const out = process.argv[2] ?? '/tmp/heic-conformance';
mkdirSync(out, { recursive: true });
for (const depth of [8, 10, 12]) {
  for (const [name, source, qp] of [
    ['pattern', 'testsrc2=size=64x64:rate=1', 22],
    ['gradient', 'gradients=size=96x64:rate=1:c0=black:c1=white', 0],
  ] as const) {
    const stem = `${out}/${name}-${depth}`;
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      source,
      '-frames:v',
      '1',
      '-pix_fmt',
      `yuv420p${depth === 8 ? '' : `${depth}le`}`,
      '-c:v',
      'libx265',
      '-x265-params',
      `keyint=1:qp=${qp}:log-level=error:pools=none`,
      '-f',
      'hevc',
      '-y',
      stem + '.hevc',
    ]);
    const w = name === 'pattern' ? 64 : 96,
      h = 64;
    writeFileSync(
      stem + '.heic',
      wrapHevc(new Uint8Array(readFileSync(stem + '.hevc')), w, h, depth, 1),
    );
    execFileSync('ffmpeg', [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      stem + '.hevc',
      '-frames:v',
      '1',
      '-pix_fmt',
      `yuv420p${depth === 8 ? '' : `${depth}le`}`,
      '-f',
      'rawvideo',
      '-y',
      stem + '.yuv',
    ]);
  }
}

// A compact 4:2:2 case exercises the separate upper/lower chroma TU syntax.
const chroma422 = `${out}/chroma422-8`;
execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=64x64:rate=1',
  '-frames:v',
  '1',
  '-pix_fmt',
  'yuv422p',
  '-c:v',
  'libx265',
  '-x265-params',
  'keyint=1:qp=22:log-level=error:pools=none',
  '-f',
  'hevc',
  '-y',
  chroma422 + '.hevc',
]);
writeFileSync(
  chroma422 + '.heic',
  wrapHevc(new Uint8Array(readFileSync(chroma422 + '.hevc')), 64, 64, 8, 2),
);
execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-i',
  chroma422 + '.hevc',
  '-frames:v',
  '1',
  '-pix_fmt',
  'yuv422p',
  '-f',
  'rawvideo',
  '-y',
  chroma422 + '.yuv',
]);
console.log(out);
