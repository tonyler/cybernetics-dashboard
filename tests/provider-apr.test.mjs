import test from 'node:test';
import assert from 'node:assert/strict';
import { numiaApr, nolusApr, nolusExplorerApr, chooseApr, externalApr } from '../scripts/provider-apr.mjs';

const NOW = Date.parse('2026-11-19T12:00:00Z');
test('Numia uses newest total staking APR, not earlier inflation-only components', () => {
  const rows = [
    {symbol:'total',labels:'2026-11-17 00:00:00',apr:3.25},
    {symbol:'OSMO',labels:'2026-11-18 00:00:00',apr:5.2},
    {symbol:'total',labels:'2026-11-18 00:00:00',apr:5.2}
  ];
  assert.deepEqual(numiaApr(rows,NOW), {grossApr:5.2,asOf:'2026-11-18',source:'numia'});
});
test('Numia rejects missing or stale data', () => {
  assert.throws(() => numiaApr([{symbol:'ATOM',labels:'2026-11-18',apr:9}],NOW));
  assert.throws(() => numiaApr([{symbol:'total',labels:'2026-11-01',apr:9}],NOW),/stale/);
  assert.throws(() => numiaApr([{symbol:'total',labels:'2026-11-18',apr:-1}],NOW),/recent positive/);
  assert.throws(() => numiaApr([{symbol:'total',labels:'2026-11-18',apr:0}],NOW),/recent positive/);
});
test('Nolus only accepts explicit external APR and normalizes display units', () => {
  assert.equal(nolusApr({apr:0.045,annualInflation:0}).grossApr,4.5);
  assert.equal(nolusApr({apr:4.5}).grossApr,4.5);
  assert.throws(()=>nolusApr({annualInflation:8}));
  assert.throws(()=>nolusApr({apr:'not available'}));
});
test('Numia ignores a zero reading when a recent fee-funded APR exists', () => {
  const rows=[
    {symbol:'OSMO',labels:'2026-11-18 00:00:00',apr:0},
    {symbol:'total',labels:'2026-11-17 00:00:00',apr:4.25}
  ];
  assert.equal(numiaApr(rows,NOW).grossApr,4.25);
});
test('Nolus explorer fallback parses only staking APR, not APY or inflation', () => {
  const html='<h4>Nolus staking APR</h4><h3>APR 4.78%</h3><h4>Staking APY</h4><h3>APY 4.90%</h3>';
  assert.deepEqual(nolusExplorerApr(html),{grossApr:4.78,source:'staking-explorer'});
  assert.throws(()=>nolusExplorerApr('<h3>APR 8%</h3>'));
});
test('Nolus falls back when official endpoint returns zero or HTTP error', async () => {
  const fetchFn=async url=>url.includes('governance')
    ? {ok:true,json:async()=>({apr:0})}
    : {ok:true,text:async()=>'<h4>Nolus staking APR</h4><h3>APR 4.78%</h3>'};
  const v=await externalApr('nolus',{fetchFn,now:NOW,base:'http://mock'});
  assert.equal(v.grossApr,4.78);
  assert.equal(v.source,'staking-explorer');
});
test('External providers replace inflation APR and apply validator commission', () => {
  const prior = {apr:0,chainApr:0,commission:0.05};
  const r = chooseApr('osmosis',prior,null,{grossApr:5.2,source:'numia',asOf:'2026-11-18'},NOW);
  assert.ok(Math.abs(r.apr-4.94)<1e-10);
  assert.ok(Math.abs(r.chainApr-0.052)<1e-10);
  assert.equal(r.aprSource,'numia');
  assert.equal(r.aprAsOf,'2026-11-18');
});
test('No fallback to cosmos.directory or unverified old APR', () => {
  const current={apr:0,chainApr:0,commission:0.05};
  const old={apr:8,chainApr:.08,aprSource:'cosmos.directory',aprFetchedAt:'2026-11-19T11:00:00Z'};
  assert.equal(chooseApr('nolus',current,old,null,NOW).apr,null);
  assert.equal(chooseApr('osmosis',current,{apr:0,chainApr:0,aprSource:'numia',aprFetchedAt:'2026-11-19T11:00:00Z'},null,NOW).apr,null);
  const verified={...old,aprSource:'nolus'};
  assert.ok(Math.abs(chooseApr('nolus',current,verified,null,NOW).apr-7.6)<1e-10);
  assert.equal(chooseApr('nolus',current,{...verified,aprFetchedAt:'2026-11-10T00:00:00Z'},null,NOW).apr,null);
});
test('A failed chain snapshot preserves only a fresh, verified external APR', () => {
  const original = {apr:4.94,chainApr:0.052,commission:0.05,aprSource:'numia',
    aprFetchedAt:'2026-11-19T10:00:00Z',aprAsOf:'2026-11-18'};
  const updated = chooseApr('osmosis',{...original,apr:null,chainApr:null},original,null,NOW);
  assert.ok(Math.abs(updated.apr - 4.94) < 1e-10);
  assert.equal(updated.aprSource,'numia');
});

test('Integration routes each chain to the appropriate provider', async () => {
  const urls=[];
  const fetchFn=async url=>{
    urls.push(url);
    return {ok:true,json:async()=>url.includes('numia')?[{symbol:'total',labels:'2026-11-18 00:00:00',apr:5.2}]:{apr:0.045}};
  };
  assert.equal((await externalApr('osmosis',{fetchFn,now:NOW,base:'http://mock'})).grossApr,5.2);
  assert.equal((await externalApr('nolus',{fetchFn,now:NOW,base:'http://mock'})).grossApr,4.5);
  assert.match(urls[0],/\/numia\/apr\?start_date=/);
  assert.equal(urls[1],'http://mock/nolus/api/governance/apr');
});
