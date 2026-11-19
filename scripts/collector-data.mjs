// Read cached public data from our own collector. No direct CoinGecko calls.
const NET_ONLY_SOURCES=['cosmos-sdk-rest','nolus-official-api'];
const APR_SOURCES=['keplr-dashboard','staking-explorer','cosmos-sdk-rest','nolus-official-api'];
export function validatePrices(payload, now=Date.now()) {
  const prices={};
  for(const [id,p] of Object.entries(payload?.prices || {})) {
    if (!p || typeof p.usd!=='number' || !Number.isFinite(p.usd) || p.usd<=0 ||
        p.source!=='coingecko' || p.currency!=='usd') continue;
    const age=now-Date.parse(p.fetchedAt || '');
    if (!Number.isFinite(age) || age < -60000 || age > 24*3600000) continue;
    prices[id]=p.usd;
  }
  return prices;
}
export function validateHistory(payload,now=Date.now()) {
  const out={};
  if (payload?.unit?.apr!=='percent' || payload?.unit?.price!=='usd') return out;
  for (const [day,networks] of Object.entries(payload.days || {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Date.parse(day)>now ||
        now-Date.parse(day)>400*86400000 || !networks || typeof networks !== 'object') continue;
    const dayRows={};
    for(const [id,rec] of Object.entries(networks)) {
      if (!rec || typeof rec!=='object') continue;
      const row={};
      if(typeof rec.price==='number' && Number.isFinite(rec.price) && rec.price>0 &&
         rec.priceSource==='coingecko') row.price=rec.price;
      // chainApr is the pre-commission network rate. The collector's newer sources
      // record `apr` net of commission, so use their grossStakerApr and skip records
      // that lack it rather than deducting commission twice. Legacy Keplr /
      // Staking Explorer records stored the gross rate in `apr`.
      const apr=typeof rec.grossStakerApr==='number' ? rec.grossStakerApr
        : NET_ONLY_SOURCES.includes(rec.aprSource) ? null : rec.apr;
      if(typeof apr==='number' && Number.isFinite(apr) && apr>=0 &&
         apr<=1000 && APR_SOURCES.includes(rec.aprSource)) {
        row.chainApr=apr/100;
        row.aprSource=rec.aprSource;
      }
      if(Object.keys(row).length) dayRows[id]=row;
    }
    if(Object.keys(dayRows).length) out[day]=dayRows;
  }
  return out;
}
export async function fetchCollectorData(url,{fetchFn=fetch,now=Date.now()}={}) {
  if(!/^https:\/\//.test(url) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(url))
    throw Error('Collector API must use HTTPS');
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),12000);
  try {
    const endpoint=new URL(url);
    const r=await fetchFn(endpoint,{signal:ctl.signal,headers:{Accept:'application/json'}});
    if(!r.ok) throw Error('Collector HTTP '+r.status);
    const data=await r.json();
    const historyUrl=new URL(endpoint);
    historyUrl.pathname=endpoint.pathname.replace(/\/(?:api)\/?$/,'/history');
    historyUrl.searchParams.set('days','400');
    const hr=await fetchFn(historyUrl,{signal:ctl.signal,headers:{Accept:'application/json'}});
    if(!hr.ok) throw Error('Collector history HTTP '+hr.status);
    return {prices:validatePrices(data,now),history:validateHistory(await hr.json(),now)};
  } finally {clearTimeout(timer);}
}
