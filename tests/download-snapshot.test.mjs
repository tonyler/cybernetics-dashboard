import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import http from 'node:http';

test('snapshot downloader uses one own API call and validates full payload',async()=>{
 const today=new Date().toISOString();
 const payload={generatedAt:today,chains:{cosmos:{apr:15}},events:[],history:{},coverage:{},uptime:{},uptimeBlocks:{cosmos:{latest:100,blocks:{100:true}}}};
 let calls=0;
 const server=http.createServer((req,res)=>{
   calls++;
   assert.equal(req.url,'/scraper/snapshot');
   res.setHeader('content-type','application/json');res.end(JSON.stringify(payload));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'snapshot-download-'));
 try{
   const port=server.address().port;
   const {spawn}=await import('node:child_process');
   const code=await new Promise(resolve=>{
     const child=spawn(process.execPath,['scripts/download-snapshot.mjs'],{
       cwd:new URL('../',import.meta.url),env:{...process.env,
       SNAPSHOT_API_URL:'http://127.0.0.1:'+port+'/scraper/snapshot',OUT:path.join(dir,'snapshot.json')}
     });
     child.on('close',resolve);
   });
   assert.equal(code,0);
   assert.equal(calls,1);
   assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'snapshot.json'))).chains.cosmos.apr,15);
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});}
});
