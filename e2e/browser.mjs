import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const output = process.env.E2E_CAPTURE ?? "/tmp/ohah-heic-browser";
const rounds = Number(process.env.E2E_ROUNDS ?? 1);
await exec("bun", ["scripts/feature-fixtures.ts", output + "/fixtures"], { cwd: root });
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    if (req.url.startsWith("/features/")) {
      const name = req.url.slice("/features/".length);
      if (!/^(alpha|iso)-(8|10|12)\.heic$/.test(name)) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.end(await readFile(output + "/fixtures/" + name));
      return;
    }
    const path = resolve(
      root,
      "." + decodeURIComponent(new URL(req.url, "http://localhost").pathname),
    );
    if (!path.startsWith(root + sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    const body = await readFile(path);
    res.setHeader(
      "content-type",
      { ".js": "text/javascript", ".html": "text/html", ".heic": "image/heic" }[extname(path)] ??
        "application/octet-stream",
    );
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(3048, "127.0.0.1", r));
const ab = async (...args) =>
  (
    await exec("agent-browser", ["--session", "ohah-heic", ...args], {
      timeout: 60000,
      maxBuffer: 4 * 1024 * 1024,
    })
  ).stdout.trim();
const evaluate = async (code) =>
  JSON.parse(await ab("eval", "-b", Buffer.from(code).toString("base64")));
const cases = [
  ["8-bit 4:4:4", 8, "444"],
  ["10-bit 4:4:4", 10, "444"],
  ["12-bit 4:4:4", 12, "444"],
  ["8-bit equivalence", 8, "pattern"],
  ["10-bit equivalence", 10, "pattern"],
  ["12-bit equivalence", 12, "pattern"],
  ["8-bit gradient", 8, "gradient"],
  ["10-bit gradient", 10, "gradient"],
  ["12-bit gradient", 12, "gradient"],
  ["input subarray", 10, "subarray"],
  ["concurrent workers", 12, "concurrent"],
  ["abort before worker", 8, "abort-before"],
  ["abort in worker", 12, "abort-during"],
  ["worker timeout", 8, "timeout"],
  ["worker load failure", 8, "load-failure"],
  ["invalid bytes main", 8, "invalid-main"],
  ["invalid bytes worker", 8, "invalid-worker"],
  ["pixel limit main", 8, "limit-main"],
  ["pixel limit worker", 8, "limit-worker"],
  ["truncated stream", 12, "truncated"],
  ["invalid option", 8, "bad-option"],
  ["real iPhone main/worker equivalence", 8, "iphone"],
  ["recovery after worker errors", 12, "recovery"],
  ["Blob input", 10, "blob"],
  ["ArrayBuffer input", 12, "arraybuffer"],
  ["structured error parity", 8, "error-parity"],
  ["malformed worker response", 8, "bad-worker"],
  ["HDR gain-map main/worker equivalence", 12, "hdr"],
  ["auxiliary alpha main/worker equivalence", 8, "alpha"],
  ["HDR in-flight cancellation", 8, "hdr-abort"],
];
const results = [];
try {
  await ab("open", "http://localhost:3048/demo/index.html");
  await evaluate(
    `(()=>{const Native=Worker;window.__activeWorkers=0;window.Worker=class extends Native {constructor(...args){super(...args);this.ended=false;window.__activeWorkers++}terminate(){if(!this.ended){this.ended=true;window.__activeWorkers--}return super.terminate()}};return true})()`,
  );
  for (let round = 1; round <= rounds; round++) {
    await ab(
      "set",
      "viewport",
      String([320, 375, 440, 1024, 1440][(round - 1) % 5]),
      String(round % 2 ? 812 : 600),
    );
    for (const [i, [name, depth, scenario]] of cases.entries()) {
      const result = await evaluate(`(async()=>{
   const {decode,decodeHDR}=await import('/dist/index.js');
   const scenario=${JSON.stringify(scenario)},depth=${depth},round=${round};
   let input=new Uint8Array(await(await fetch(scenario==='hdr'?(round%5===1?'/test/fixtures/iphone-small.heic':'/features/iso-'+[8,10,12][(round-1)%3]+'.heic'):scenario==='alpha'?'/features/alpha-'+[8,10,12][(round-1)%3]+'.heic':scenario==='iphone'?'/test/fixtures/iphone-grid.heic':'/test/fixtures/conformance/'+(scenario==='444'?'chroma444':scenario==='gradient'?'gradient':'pattern')+'-'+depth+'.heic')).arrayBuffer());
   const expectError=async(fn,code)=>{try{await fn();return false}catch(error){if(code&&error?.code!==code)throw Error('Expected '+code+', got '+error?.code+': '+error);return true}};
   if(scenario==='hdr'||scenario==='alpha'){const fn=scenario==='hdr'?decodeHDR:decode;const main=await fn(input,{execution:'main'}),worker=await fn(input);if(main.data.length!==worker.data.length||main.data.some((v,i)=>v!==worker.data[i]))throw Error('Feature pixels differ');if(scenario==='hdr'&&(!['apple-gainmap','iso-gainmap'].includes(worker.source)||worker.colorSpace!=='linear-srgb'||!worker.data.some((v,i)=>i%4!==3&&v>1)))throw Error('HDR did not restore highlights');if(scenario==='alpha'&&(!worker.hasAlpha||!worker.data.some((v,i)=>i%4===3&&v<255)))throw Error('Alpha missing');return {width:worker.width,height:worker.height,bitDepth:worker.bitDepth,source:worker.source,identical:true}}
   if(scenario==='hdr-abort'){const c=new AbortController(),pending=decodeHDR(input,{signal:c.signal});c.abort(false);try{await pending;return false}catch(error){if(error!==false)throw Error('HDR abort reason lost');return true}}
   if(scenario==='abort-before'){const c=new AbortController();c.abort();return await expectError(()=>decode(input,{signal:c.signal}));}
   if(scenario==='abort-during'){const c=new AbortController();const p=decode(input,{signal:c.signal});c.abort(0);let rejected=false;try{await p}catch(error){if(error!==0)throw Error('Abort reason lost');rejected=true}return rejected;}
   if(scenario==='timeout')return await expectError(()=>decode(input,{timeoutMs:1,workerFactory:()=>new Worker(URL.createObjectURL(new Blob(['setInterval(()=>{},1000)'],{type:'text/javascript'})))}));
   if(scenario==='load-failure')return await expectError(()=>decode(input,{workerFactory:()=>new Worker('/missing-worker.js',{type:'module'})}),'WORKER_FAILED');
   if(scenario.startsWith('invalid-'))return await expectError(()=>decode(new Uint8Array([0,1,2]),{execution:scenario.endsWith('main')?'main':'worker'}),'UNSUPPORTED_FORMAT');
   if(scenario.startsWith('limit-'))return await expectError(()=>decode(input,{maxPixels:1,execution:scenario.endsWith('main')?'main':'worker'}),'RESOURCE_LIMIT');
   if(scenario==='truncated')return await expectError(()=>decode(input.subarray(0,input.length/2)));
   if(scenario==='bad-option')return await expectError(()=>decode(input,{timeoutMs:-1}),'INVALID_OPTIONS');
   if(scenario==='error-parity'){for(const execution of ['main','worker']){if(!await expectError(()=>decode(input,{execution,maxPixels:0}),'INVALID_OPTIONS'))return false}return true}
   if(scenario==='bad-worker'){const url=URL.createObjectURL(new Blob(['postMessage(null)'],{type:'text/javascript'}));try{return await expectError(()=>decode(input,{workerFactory:()=>new Worker(url)}),'WORKER_FAILED')}finally{URL.revokeObjectURL(url)}}
   if(scenario==='subarray'){const bytes=new Uint8Array(input.length+20);bytes.set(input,10);input=bytes.subarray(10,10+input.length);}
   const before=input.slice();
   const started=performance.now();const main=await decode(input,{execution:'main'});const mainMs=performance.now()-started;
   const w=performance.now();const worker=await decode(scenario==='blob'?new Blob([input],{type:'image/png'}):scenario==='arraybuffer'?input.slice().buffer:input);const workerMs=performance.now()-w;
   if(scenario==='concurrent'){const images=await Promise.all([decode(input),decode(input)]);if(images.some(x=>x.data.some((v,i)=>v!==main.data[i])))throw Error('Concurrent decode differs');}
   if(main.data.length!==worker.data.length||main.data.some((v,i)=>v!==worker.data[i])||input.some((v,i)=>v!==before[i]))throw Error('Pixels differ or input detached');
   if(main.bitDepth!==depth)throw Error('Wrong bit depth');
   return {width:main.width,height:main.height,bitDepth:main.bitDepth,mainMs,workerMs,identical:true};
  })()`);
      assert.ok(result, name);
      assert.equal(await evaluate("window.__activeWorkers"), 0, name + " leaked worker");
      results.push({ round, case: i + 1, name, result });
      console.log("PASS", round, i + 1, name);
    }
  }
  await ab("set", "viewport", "375", "812");
  await ab("upload", "#file", root + "/test/fixtures/conformance/pattern-12.heic");
  await ab("wait", "--fn", "!document.querySelector('canvas').hidden");
  await ab("screenshot", output + "/12-bit-worker.png");
  await ab("select", "#execution", "main");
  await ab("upload", "#file", root + "/test/fixtures/iphone-grid.heic");
  await ab("wait", "--fn", "document.querySelector('canvas').height===4032");
  await ab("screenshot", output + "/iphone-main.png");
  await ab("select", "#execution", "worker");
  await ab("upload", "#file", output + "/fixtures/alpha-12.heic");
  await ab("wait", "--fn", "document.querySelector('#status').textContent.includes('alpha') && !document.querySelector('canvas').hidden");
  await ab("screenshot", output + "/alpha-worker.png");
  await ab("set", "viewport", "1440", "1000");
  await ab("select", "#output", "hdr");
  await ab("upload", "#file", root + "/test/fixtures/iphone-small.heic");
  await ab("wait", "--fn", "document.querySelector('#status').textContent.includes('apple-gainmap') && !document.querySelector('canvas').hidden");
  await ab("screenshot", output + "/hdr-sdr-preview.png");
  await ab("upload", "#file", root + "/README.md");
  await ab("wait", "--fn", "document.querySelector('#status').textContent.includes('not a HEIC')");
  await ab("screenshot", output + "/invalid-input.png");
  await writeFile(output + "/results.json", JSON.stringify(results, null, 2));
} finally {
  await ab("close");
  await new Promise((r) => server.close(r));
}
