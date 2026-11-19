// Fetch APRs displayed on the Keplr Dashboard by the self-hosted Playwright service.
const KEPLR_PAGES = Object.freeze({
  cosmos:'cosmos-hub', osmosis:'osmosis', juno:'juno',
  chihuahua:'chihuahua', nolus:'nolus', dymension:'dymension'
});
// Chain-registry names used in the scraper's cosmos-sdk-rest source URLs.
const REGISTRY = Object.freeze({
  cosmos:'cosmoshub', osmosis:'osmosis', juno:'juno',
  chihuahua:'chihuahua', nolus:'nolus', dymension:'dymension'
});
// Every source the scraper may publish, and the exact URL each must point at.
function allowedSources(id) {
  const ok = {
    'keplr-dashboard': 'https://wallet.keplr.app/chains/' + KEPLR_PAGES[id],
    'cosmos-sdk-rest': 'https://rest.cosmos.directory/' + REGISTRY[id] + '/cosmos/mint/v1beta1/annual_provisions'
  };
  if (id === 'nolus') {
    ok['staking-explorer'] = 'https://staking-explorer.com/explorer/nolus';
    ok['nolus-official-api'] = 'https://app.nolus.io/api/governance/apr';
  }
  return ok;
}
const pct = v => v === null || v === undefined || v === '' ? null : Number(v);
export function parseRemoteApr(payload, id, now = Date.now()) {
  const item = payload?.networks?.[id];
  if (!Object.hasOwn(KEPLR_PAGES, id) || !item)
    throw Error('No Keplr APR for '+id);
  const expectedUrl = allowedSources(id)[item.source];
  if (!expectedUrl || item.sourceUrl !== expectedUrl ||
      item.unit !== 'percent' || item.basis !== 'network-staking')
    throw Error('Unrecognized staking APR source for '+id);
  // The scraper's `apr` is already net of the validator commission; `grossStakerApr`
  // is the network rate before commission. Older payloads only had `apr` (gross).
  // null is NOT 0: missing rates must never become 0% via Number(null).
  const hasGross = Object.hasOwn(item, 'grossStakerApr');
  const gross = pct(hasGross ? item.grossStakerApr : item.apr);
  if (gross === null) throw Error('Unavailable Keplr APR for '+id);
  const t=Date.parse(item.fetchedAt || '');
  if (!Number.isFinite(gross) || gross<0 || gross>1000)
    throw Error('Invalid Keplr APR for '+id);
  if (!Number.isFinite(t) || t>now+60000 || now-t>24*3600000)
    throw Error('Stale Keplr APR for '+id);
  if (!['ok','stale'].includes(item.status))
    throw Error('Keplr APR status invalid for '+id);
  // netApr kept as an alias for callers that predate grossApr.
  return {grossApr:gross, netApr:gross, source:item.source, asOf:item.fetchedAt, status:item.status};
}
export async function fetchRemoteApr(url,{fetchFn=fetch,now=Date.now()}={}) {
  if (!/^https:\/\//.test(url) &&
      !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(url))
    throw Error('APR API must use HTTPS (localhost excepted)');
  const ctl=new AbortController(), timer=setTimeout(()=>ctl.abort(),9000);
  try {
    const response=await fetchFn(url,{signal:ctl.signal,headers:{Accept:'application/json'}});
    if (!response.ok) throw Error('Keplr APR collector HTTP '+response.status);
    const payload=await response.json();
    return Object.fromEntries(Object.keys(KEPLR_PAGES).map(id=>{
      try {return [id,parseRemoteApr(payload,id,now)];}
      catch {return [id,null];}
    }));
  } finally {clearTimeout(timer);}
}
