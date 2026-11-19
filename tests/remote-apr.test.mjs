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

// Shapes published by /scraper/api since the collector switched sources (Nov 2026).
const live={
  cosmos:{source:'cosmos-sdk-rest',sourceUrl:'https://rest.cosmos.directory/cosmoshub/cosmos/mint/v1beta1/annual_provisions',apr:18.78,grossStakerApr:19.77},
  chihuahua:{source:'cosmos-sdk-rest',sourceUrl:'https://rest.cosmos.directory/chihuahua/cosmos/mint/v1beta1/annual_provisions',apr:0,grossStakerApr:0},
  nolus:{source:'nolus-official-api',sourceUrl:'https://app.nolus.io/api/governance/apr',apr:4.45,grossStakerApr:4.68},
  osmosis:{source:'keplr-dashboard',sourceUrl:'https://wallet.keplr.app/chains/osmosis',apr:6.08,grossStakerApr:6.4}
};
const liveItem=id=>({...live[id],unit:'percent',basis:'network-staking',fetchedAt:'2026-11-19T11:50:00Z',status:'ok'});
test('accepts cosmos-sdk-rest and nolus-official-api sources',()=>{
  for (const id of Object.keys(live))
    assert.equal(parseRemoteApr({networks:{[id]:liveItem(id)}},id,NOW).grossApr,live[id].grossStakerApr);
});
test('uses grossStakerApr so commission is not deducted twice',()=>{
  const r=parseRemoteApr({networks:{osmosis:liveItem('osmosis')}},'osmosis',NOW);
  assert.equal(r.grossApr,6.4);
});
test('null grossStakerApr is unavailable, not 0 and not the net apr',()=>{
  assert.throws(()=>parseRemoteApr({networks:{nolus:{...liveItem('nolus'),grossStakerApr:null}}},'nolus',NOW));
});
test('new sources still require their exact URL',()=>{
  assert.throws(()=>parseRemoteApr({networks:{cosmos:{...liveItem('cosmos'),sourceUrl:'https://rest.cosmos.directory/juno/cosmos/mint/v1beta1/annual_provisions'}}},'cosmos',NOW));
  assert.throws(()=>parseRemoteApr({networks:{cosmos:{...liveItem('cosmos'),source:'nolus-official-api',sourceUrl:'https://app.nolus.io/api/governance/apr'}}},'cosmos',NOW));
});
