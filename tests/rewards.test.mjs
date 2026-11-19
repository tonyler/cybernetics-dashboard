import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const ctx = {window: {}};
vm.runInNewContext(fs.readFileSync(new URL('config.js', root), 'utf8'), ctx);
vm.runInNewContext(fs.readFileSync(new URL('data.js', root), 'utf8'), ctx);
const {buildDaily} = ctx.window.CyberneticsData;
const today = new Date(); today.setUTCHours(0,0,0,0);
const day = n => new Date(+today+n*86400000).toISOString().slice(0,10);
const chain = {id:'cosmos',tokens:1000,price:2,chainApr:0.20,apr:18,commission:0.10};
const close = (a,b) => assert.ok(Math.abs(a-b)<1e-10, String(a)+' != '+String(b));

test('daily gross reward splits between delegators and validator commission', () => {
  const history={[day(0)]:{cosmos:{tokens:1000,price:2,chainApr:0.20}}};
  const item=buildDaily({cosmos:chain},[],history).at(-1);
  close(item.stakerRewards.cosmos, 1000*0.20*(1-0.10)/365*2);
  close(item.operatorRewards.cosmos, 1000*0.20*0.10/365*2);
  close(item.stakerRewards.cosmos+item.operatorRewards.cosmos, 1000*0.20/365*2);
});

test('prior days use observed historical APR and price, never today APR', () => {
  const history={
    [day(-1)]:{cosmos:{tokens:500,price:4,chainApr:0.10}},
    [day(0)]:{cosmos:{tokens:1000,price:2,chainApr:0.20}}
  };
  const series=buildDaily({cosmos:chain},[],history);
  close(series.at(-2).stakerRewards.cosmos,500*0.10*0.90/365*4);
  close(series.at(-1).stakerRewards.cosmos,1000*0.20*0.90/365*2);
  // Before APR tracking, use the current published APR as an estimate.
  close(series.at(-3).stakerRewards.cosmos,1000*.20*.90/365*2);
  close(series.at(-3).operatorRewards.cosmos,1000*.20*.10/365*2);
});

test('commission of 100% correctly assigns gross rewards to operator', () => {
  const item=buildDaily({cosmos:{...chain,commission:1}},[],{[day(0)]:{cosmos:{chainApr:0.2}}}).at(-1);
  close(item.stakerRewards.cosmos,0);
  close(item.operatorRewards.cosmos,1000*.2/365*2);
});

test('missing APR is unknown, not zero earnings', () => {
  const series=buildDaily({cosmos:{...chain,apr:null,chainApr:null}},[],{});
  assert.equal(series.at(-1).stakerRewards.cosmos,null);
  assert.equal(series.at(-1).operatorRewards.cosmos,null);
});

test('a genuine recorded zero APR remains zero earnings', () => {
  const series=buildDaily({cosmos:chain},[],{[day(0)]:{cosmos:{chainApr:0}}});
  close(series.at(-1).stakerRewards.cosmos,0);
  close(series.at(-1).operatorRewards.cosmos,0);
});


test('backfills earlier chart days from last recorded APR if current rate is unavailable', () => {
  const c = {...chain,chainApr:null,apr:null};
  const h = {[day(-1)]:{cosmos:{chainApr:0.12}}};
  const series=buildDaily({cosmos:c},[],h);
  close(series.at(-3).stakerRewards.cosmos,1000*.12*.90/365*2);
  close(series.at(-2).stakerRewards.cosmos,1000*.12*.90/365*2);
});

test('the current APR produces nonempty chart history without daily APR records', () => {
  const series=buildDaily({cosmos:chain},[],{});
  assert.ok(series.every(d => d.stakerRewards.cosmos > 0));
  assert.ok(series.every(d => d.operatorRewards.cosmos > 0));
});
