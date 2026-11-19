// Fetch APRs displayed on the Keplr Dashboard by the self-hosted Playwright service.
const KEPLR_PAGES = Object.freeze({
  cosmos:'cosmos-hub', osmosis:'osmosis', juno:'juno',
  chihuahua:'chihuahua', nolus:'nolus', dymension:'dymension'
});
export function parseRemoteApr(payload, id, now = Date.now()) {
  const item = payload?.networks?.[id];
  if (!Object.hasOwn(KEPLR_PAGES, id) || !item)
    throw Error('No Keplr APR for '+id);
  const isKeplr = item.source === 'keplr-dashboard' &&
    item.sourceUrl === 'https://wallet.keplr.app/chains/' + KEPLR_PAGES[id];
  const isNolusFallback = id === 'nolus' && item.source === 'staking-explorer' &&
    item.sourceUrl === 'https://staking-explorer.com/explorer/nolus';
  if ((!isKeplr && !isNolusFallback) ||
      item.unit !== 'percent' || item.basis !== 'network-staking')
    throw Error('Unrecognized staking APR source for '+id);
  // null is NOT 0: missing Keplr rates must never become 0% via Number(null).
  if (item.apr === null || item.apr === undefined || item.apr === '')
    throw Error('Unavailable Keplr APR for '+id);
  const value=Number(item.apr), t=Date.parse(item.fetchedAt || '');
  if (!Number.isFinite(value) || value<0 || value>1000)
    throw Error('Invalid Keplr APR for '+id);
  if (!Number.isFinite(t) || t>now+60000 || now-t>24*3600000)
    throw Error('Stale Keplr APR for '+id);
  if (!['ok','stale'].includes(item.status))
    throw Error('Keplr APR status invalid for '+id);
  return {netApr:value, source:item.source, asOf:item.fetchedAt, status:item.status};
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
