import test from 'node:test';
import assert from 'node:assert/strict';
import {parseRemoteApr,fetchRemoteApr} from '../scripts/remote-apr.mjs';

const NOW=Date.parse('2026-11-19T16:00:00Z');
const URLS={
 cosmos:'https://rest.cosmos.directory/cosmoshub/cosmos/mint/v1beta1/annual_provisions',
 osmosis:'https://wallet.keplr.app/chains/osmosis',
 juno:'https://rest.cosmos.directory/juno/cosmos/mint/v1beta1/annual_provisions',
 chihuahua:'https://rest.cosmos.directory/chihuahua/cosmos/mint/v1beta1/annual_provisions',
 nolus:'https://app.nolus.io/api/governance/apr',
 dymension:'https://rest.cosmos.directory/dymension/cosmos/mint/v1beta1/annual_provisions'
};
const SOURCES={cosmos:'cosmos-sdk-rest',osmosis:'keplr-dashboard',juno:'cosmos-sdk-rest',
 chihuahua:'cosmos-sdk-rest',nolus:'nolus-official-api',dymension:'cosmos-sdk-rest'};
const item=(id,gross=20)=>({
 apr:gross*0.95,grossStakerApr:gross,unit:'percent',basis:'network-staking',
 source:SOURCES[id],sourceUrl:URLS[id],
 aprType:'estimated-cybernetics-5-percent-net-staking-apr',
 validator:'Cybernetics',validatorCommission:0.05,
 onchain:{validator:'Cybernetics',validatorCommission:0.05,commissionIncluded:true},
 fetchedAt:'2026-11-19T15:55:00Z',status:'ok'
});

test('reads collector Cybernetics net APR without another commission deduction',()=>{
 const v=parseRemoteApr({networks:{cosmos:item('cosmos',19.75326367959863)}},'cosmos',NOW);
 assert.ok(Math.abs(v.netApr-18.7656004956187)<1e-10);
 assert.ok(Math.abs(v.grossApr-19.75326367959863)<1e-10);
});

test('valid zero-reward native HUAHUA remains zero',()=>{
 const v=parseRemoteApr({networks:{chihuahua:item('chihuahua',0)}},'chihuahua',NOW);
 assert.equal(v.netApr,0);assert.equal(v.grossApr,0);
});

test('rejects legacy gross APR, malformed source, and stale results',()=>{
 assert.throws(()=>parseRemoteApr({networks:{cosmos:{...item('cosmos'),aprType:'estimated-network-net-delegator-apr'}}},'cosmos',NOW));
 assert.throws(()=>parseRemoteApr({networks:{nolus:{...item('nolus'),source:'staking-explorer'}}},'nolus',NOW));
 assert.throws(()=>parseRemoteApr({networks:{osmosis:{...item('osmosis'),status:'stale'}}},'osmosis',NOW));
 assert.throws(()=>parseRemoteApr({networks:{osmosis:{...item('osmosis'),grossStakerApr:null}}},'osmosis',NOW));
 assert.throws(()=>parseRemoteApr({networks:{osmosis:{...item('osmosis'),apr:19.5}}},'osmosis',NOW));
 assert.throws(()=>parseRemoteApr({networks:{osmosis:{...item('osmosis'),fetchedAt:'2026-11-01T00:00:00Z'}}},'osmosis',NOW));
});

test('supports all six sources with partial freshness',async()=>{
 const networks=Object.fromEntries(Object.keys(URLS).map(id=>[id,item(id)]));
 networks.juno.status='stale';
 const fetchFn=async()=>({ok:true,json:async()=>({networks})});
 const out=await fetchRemoteApr('https://tonyler.is-not-a.dev/scraper/api',{fetchFn,now:NOW});
 assert.equal(Object.keys(out).length,6);
 assert.equal(out.cosmos.netApr,19);
 assert.equal(out.nolus.netApr,19);
 assert.equal(out.juno,null);
});
