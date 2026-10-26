import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const output = '/tmp/ohah-heic-browser';
await mkdir(output, { recursive: true });
const server = createServer(async (req,res)=>{
 try {
  const path=resolve(root,'.'+decodeURIComponent(new URL(req.url,'http://localhost').pathname));
  if(!path.startsWith(root+sep)){res.writeHead(403);res.end();return;}
  const body=await readFile(path);res.setHeader('content-type',({'.js':'text/javascript','.html':'text/html','.heic':'image/heic'})[extname(path)]??'application/octet-stream');res.end(body);
 }catch{res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(3048,'127.0.0.1',r));
const ab=async(...args)=>(await exec('agent-browser',['--session','ohah-heic',...args],{timeout:60000,maxBuffer:4*1024*1024})).stdout.trim();
const evaluate=async(code)=>JSON.parse(await ab('eval','-b',Buffer.from(code).toString('base64')));
const cases=[
 ['8-bit equivalence',8,'pattern'],['10-bit equivalence',10,'pattern'],['12-bit equivalence',12,'pattern'],
 ['8-bit gradient',8,'gradient'],['10-bit gradient',10,'gradient'],['12-bit gradient',12,'gradient'],
 ['input subarray',10,'subarray'],['concurrent workers',12,'concurrent'],['abort before worker',8,'abort-before'],
 ['abort in worker',12,'abort-during'],['worker timeout',8,'timeout'],['worker load failure',8,'load-failure'],
 ['invalid bytes main',8,'invalid-main'],['invalid bytes worker',8,'invalid-worker'],['pixel limit main',8,'limit-main'],
 ['pixel limit worker',8,'limit-worker'],['truncated stream',12,'truncated'],['invalid option',8,'bad-option'],
 ['real iPhone main/worker equivalence',8,'iphone'],['recovery after worker errors',12,'recovery']
];
const results=[];
try {
 await ab('open','http://localhost:3048/demo/index.html');
 for(const [i,[name,depth,scenario]] of cases.entries()){
  const result=await evaluate(`(async()=>{
   const {decode}=await import('/dist/index.js');
   const scenario=${JSON.stringify(scenario)},depth=${depth};
   let input=new Uint8Array(await(await fetch(scenario==='iphone'?'/test/fixtures/iphone-grid.heic':'/test/fixtures/conformance/'+(scenario==='gradient'?'gradient':'pattern')+'-'+depth+'.heic')).arrayBuffer());
   const expectError=async(fn)=>{try{await fn();return false}catch{return true}};
   if(scenario==='abort-before'){const c=new AbortController();c.abort();return await expectError(()=>decode(input,{signal:c.signal}));}
   if(scenario==='abort-during'){const c=new AbortController();const p=decode(input,{signal:c.signal});c.abort();return await expectError(()=>p);}
   if(scenario==='timeout')return await expectError(()=>decode(input,{timeoutMs:1,workerFactory:()=>new Worker(URL.createObjectURL(new Blob(['setInterval(()=>{},1000)'],{type:'text/javascript'})))}));
   if(scenario==='load-failure')return await expectError(()=>decode(input,{workerFactory:()=>new Worker('/missing-worker.js',{type:'module'})}));
   if(scenario.startsWith('invalid-'))return await expectError(()=>decode(new Uint8Array([0,1,2]),{execution:scenario.endsWith('main')?'main':'worker'}));
   if(scenario.startsWith('limit-'))return await expectError(()=>decode(input,{maxPixels:1,execution:scenario.endsWith('main')?'main':'worker'}));
   if(scenario==='truncated')return await expectError(()=>decode(input.subarray(0,input.length/2)));
   if(scenario==='bad-option')return await expectError(()=>decode(input,{timeoutMs:-1}));
   if(scenario==='subarray'){const bytes=new Uint8Array(input.length+20);bytes.set(input,10);input=bytes.subarray(10,10+input.length);}
   const before=input.slice();
   const started=performance.now();const main=await decode(input,{execution:'main'});const mainMs=performance.now()-started;
   const w=performance.now();const worker=await decode(input);const workerMs=performance.now()-w;
   if(scenario==='concurrent'){const images=await Promise.all([decode(input),decode(input)]);if(images.some(x=>x.data.some((v,i)=>v!==main.data[i])))throw Error('Concurrent decode differs');}
   if(main.data.length!==worker.data.length||main.data.some((v,i)=>v!==worker.data[i])||input.some((v,i)=>v!==before[i]))throw Error('Pixels differ or input detached');
   if(main.bitDepth!==depth)throw Error('Wrong bit depth');
   return {width:main.width,height:main.height,bitDepth:main.bitDepth,mainMs,workerMs,identical:true};
  })()`);
  assert.ok(result, name);
  results.push({round:i+1,name,result});console.log('PASS',i+1,name);
 }
 await ab('set','viewport','375','812');
 await ab('upload','#file',root+'/test/fixtures/conformance/pattern-12.heic');
 await ab('wait','--fn',"!document.querySelector('canvas').hidden");
 await ab('screenshot',output+'/12-bit-worker.png');
 await ab('select','#execution','main');
 await ab('upload','#file',root+'/test/fixtures/iphone-grid.heic');
 await ab('wait','--fn',"document.querySelector('canvas').height===4032");
 await ab('screenshot',output+'/iphone-main.png');
 await writeFile(output+'/results.json',JSON.stringify(results,null,2));
} finally {await ab('close');await new Promise(r=>server.close(r));}
