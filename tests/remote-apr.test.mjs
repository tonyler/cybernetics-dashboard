import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRemoteApr,fetchRemoteApr} from '../scripts/remote-apr.mjs';

const NOW=Date.parse('2026-11-19T12:00:00Z');
const item=(id,apr=5.2)=>({
  apr,unit:'percent',basis:'network-staking',source:'keplr-dashboard',
  sourceUrl:'https://wallet.keplr.app/chains/'+(id==='cosmos'?'cosmos-hub':id),
  fetchedAt:'2026-11-19T11:50:00Z',status:'ok'
});
test('reads exactly the reported Keplr APR',()=>{
  assert.equal(parseRemoteApr({networks:{osmosis:item('osmosis')}},'osmosis',NOW).netApr,5.2);
  assert.equal(parseRemoteApr({networks:{nolus:item('nolus',0)}},'nolus',NOW).netApr,0);
});
test('missing/null APR never becomes 0',()=>{
  assert.throws(()=>parseRemoteApr({networks:{osmosis:item('osmosis',null)}},'osmosis',NOW));
});
test('rejects mismatched page, old data and invalid units',()=>{
  assert.throws(()=>parseRemoteApr({networks:{osmosis:{...item('osmosis'),sourceUrl:'https://x'}}},'osmosis',NOW));
  assert.throws(()=>parseRemoteApr({networks:{osmosis:{...item('osmosis'),fetchedAt:'2026-11-01T00:00:00Z'}}},'osmosis',NOW));
  assert.throws(()=>parseRemoteApr({networks:{osmosis:{...item('osmosis'),unit:'fraction'}}},'osmosis',NOW));
});
test('JSON API supports all six chains and partial data',async()=>{
  const networks=Object.fromEntries(['cosmos','osmosis','juno','chihuahua','nolus','dymension'].map(id=>[id,item(id)]));
  delete networks.juno;
  const fetchFn=async()=>({ok:true,json:async()=>({networks})});
  const results=await fetchRemoteApr('https://tonyler.is-not-a.dev/scraper/api',{fetchFn,now:NOW});
  assert.equal(Object.keys(results).length,6);
  assert.equal(results.osmosis.netApr,5.2);
  assert.equal(results.juno,null);
});
