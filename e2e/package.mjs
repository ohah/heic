// Optional consumer audit: RSPACK_MODULE=/path/to/@rspack/core/dist/index.js node e2e/package.mjs
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath, extname, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
const exec = promisify(execFile);
const root = resolvePath(import.meta.dirname, '..');
const output = await mkdtemp(join(tmpdir(), 'heic-consumer-'));
const { stdout } = await exec(
  'npm',
  ['pack', '--ignore-scripts', '--pack-destination', output, '--json'],
  { cwd: root },
);
const packed = JSON.parse(stdout)[0];
assert.ok(!packed.files.some(({ path }) => /^(src|test|node_modules)\//.test(path)));
const tarball = (await readdir(output)).find((name) => name.endsWith('.tgz'));
await mkdir(join(output, 'extracted'));
await exec('tar', ['-xzf', join(output, tarball), '-C', join(output, 'extracted')]);
const packageDir = join(output, 'extracted/package');
const metadata = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
assert.ok(!Object.keys(metadata.dependencies ?? {}).length, 'unexpected runtime dependency');
const module = await import(pathToFileURL(join(packageDir, 'dist/index.js')));
const input = new Uint8Array(
  await readFile(join(root, 'test/fixtures/conformance/pattern-12.heic')),
);
assert.equal(module.decodeHeic(input).bitDepth, 12);
const { rspack } = await import(
  process.env.RSPACK_MODULE ? pathToFileURL(process.env.RSPACK_MODULE).href : '@rspack/core'
);
await writeFile(
  join(output, 'entry.js'),
  `import { decode } from ${JSON.stringify(join(packageDir, 'dist/index.js'))};window.decodeHeicPackage=decode;`,
);
const compiler = rspack({
  mode: 'production',
  entry: join(output, 'entry.js'),
  output: { path: join(output, 'bundle'), filename: 'main.js', publicPath: '/' },
  devtool: false,
});
await new Promise((resolve, reject) =>
  compiler.run((error, stats) =>
    error || stats.hasErrors()
      ? reject(error ?? stats.toString({ all: false, errors: true }))
      : resolve(),
  ),
);
await new Promise((resolve, reject) =>
  compiler.close((error) => (error ? reject(error) : resolve())),
);
await writeFile(
  join(output, 'bundle/index.html'),
  '<!doctype html><title>Packaged HEIC consumer</title><script src="/main.js"></script>',
);
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/sample.heic') {
      res.end(input);
      return;
    }
    const path = resolvePath(output, 'bundle', '.' + (req.url === '/' ? '/index.html' : req.url));
    if (!path.startsWith(join(output, 'bundle') + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const content = await readFile(path);
    res.setHeader('content-type', extname(path) === '.js' ? 'text/javascript' : 'text/html');
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ab = async (...args) =>
  (
    await exec('agent-browser', ['--session', 'heic-packaged-consumer', ...args], {
      timeout: 40000,
    })
  ).stdout.trim();
try {
  await ab('open', `http://localhost:${server.address().port}/`);
  await ab('wait', '--fn', '!!window.decodeHeicPackage');
  const code = `(async()=>{const input=new Uint8Array(await(await fetch('/sample.heic')).arrayBuffer());const main=await window.decodeHeicPackage(input,{execution:'main'});const worker=await window.decodeHeicPackage(input);if(main.data.some((v,i)=>v!==worker.data[i]))throw Error('Pixels differ');try{await window.decodeHeicPackage(new Uint8Array([1]))}catch(e){return {width:worker.width,height:worker.height,bitDepth:worker.bitDepth,error:e.code}}throw Error('Invalid input accepted')})()`;
  const result = JSON.parse(await ab('eval', '-b', Buffer.from(code).toString('base64')));
  assert.deepEqual(result, { width: 64, height: 64, bitDepth: 12, error: 'UNSUPPORTED_FORMAT' });
  await writeFile(
    join(output, 'results.json'),
    JSON.stringify(
      { result, tarballBytes: packed.size, files: packed.files.length, runtimeDependencies: 0 },
      null,
      2,
    ),
  );
  console.log('PASS packed consumer / Rspack production worker+main:', output);
} finally {
  await ab('close');
  await new Promise((resolve) => server.close(resolve));
}
