import test from 'node:test';
import assert from 'node:assert/strict';
import {validatePrices,validateHistory,fetchCollectorData} from '../scripts/collector-data.mjs';

const now=Date.parse('2026-11-19T12:30:00Z');
test('accepts recent cached USD prices and rejects null/stale prices',()=>{
  const prices=validatePrices({prices:{
    cosmos:{usd:10,currency:'usd',source:'coingecko',fetchedAt:'2026-11-19T12:20:00Z'},
    nolus:{usd:0,currency:'usd',source:'coingecko',fetchedAt:'2026-11-19T12:20:00Z'},
    juno:{usd:2,currency:'usd',source:'coingecko',fetchedAt:'2026-11-17T12:20:00Z'}
  }},now);
  assert.deepEqual(prices,{cosmos:10});
});
test('history is sourced and converts reported APR percent to fractional chain APR',()=>{
  const rows=validateHistory({unit:{apr:'percent',price:'usd'},days:{
    '2026-11-18':{nolus:{apr:4.78,aprSource:'staking-explorer',price:.12,priceSource:'coingecko'}},
    '2026-11-19':{osmosis:{apr:12,aprSource:'keplr-dashboard',price:2,priceSource:'unknown'}}
  }},now);
  assert.equal(rows['2026-11-18'].nolus.chainApr,.0478);
  assert.equal(rows['2026-11-18'].nolus.price,.12);
  assert.equal(rows['2026-11-19'].osmosis.chainApr,.12);
  assert.equal(rows['2026-11-19'].osmosis.price,undefined);
});
test('fetches only scraper API and history, no CoinGecko browser calls',async()=>{
  const urls=[];
  const mock=async url=>{
    urls.push(String(url));
    return {ok:true,json:async()=>urls.length===1?
      {prices:{cosmos:{usd:8,currency:'usd',source:'coingecko',fetchedAt:'2026-11-19T12:20:00Z'}}}:
      {unit:{apr:'percent',price:'usd'},days:{'2026-11-18':{cosmos:{price:7,priceSource:'coingecko'}}}}};
  };
  const out=await fetchCollectorData('https://tonyler.is-not-a.dev/scraper/api',{fetchFn:mock,now});
  assert.equal(out.prices.cosmos,8);
  assert.equal(out.history['2026-11-18'].cosmos.price,7);
  assert.ok(urls[0].endsWith('/scraper/api'));
  assert.ok(urls[1].includes('/scraper/history?days=400'));
});
