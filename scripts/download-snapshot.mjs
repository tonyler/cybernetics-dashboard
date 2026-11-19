/* GitHub Pages deployment reads ONE complete snapshot from our own server.
   No direct Cosmos/Keplr/CoinGecko API requests from GitHub Actions. */
import fs from 'node:fs';
import path from 'node:path';
const url=process.env.SNAPSHOT_API_URL || 'https://tonyler.is-not-a.dev/scraper/snapshot';
const output=path.resolve(process.env.OUT || 'data/snapshot.json');
if(!/^https:\/\//.test(url) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(url))
  throw Error('Snapshot API must be HTTPS (except localhost tests)');
const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),25000);
let payload;
try {
  const response=await fetch(url,{signal:ctl.signal,headers:{Accept:'application/json'},cache:'no-store'});
  if(!response.ok)throw Error('Own snapshot API returned HTTP '+response.status);
  const raw=await response.text();
  if(raw.length>20*1024*1024)throw Error('Snapshot larger than 20 MiB');
  payload=JSON.parse(raw);
} finally {clearTimeout(timer);}
if(!payload || typeof payload!=='object' || !payload.generatedAt ||
   !payload.chains || Object.keys(payload.chains).length<1 ||
   !Array.isArray(payload.events) || !payload.history || typeof payload.history!=='object' ||
   !payload.coverage || typeof payload.coverage!=='object' || !payload.uptime || typeof payload.uptime!=='object' ||
   !payload.uptimeBlocks || typeof payload.uptimeBlocks!=='object')
  throw Error('Invalid server snapshot shape');
const generated=Date.parse(payload.generatedAt);
if(!Number.isFinite(generated)||generated>Date.now()+60000||Date.now()-generated>2*3600000)
  throw Error('Server snapshot too old or invalid');
fs.mkdirSync(path.dirname(output),{recursive:true});
const temp=output+'.tmp';
fs.writeFileSync(temp,JSON.stringify(payload));
fs.renameSync(temp,output);
console.log('Downloaded complete snapshot from own API:',payload.generatedAt,
  Object.keys(payload.chains).length,'chains,',payload.events.length,'events');
