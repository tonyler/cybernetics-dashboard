// The collector already provides Cybernetics' estimated NET staking APR.
// Never apply validator commission a second time in the dashboard snapshot.
const CHAINS = Object.freeze(['cosmos','osmosis','juno','chihuahua','nolus','dymension']);
const EXPECTED_SOURCE = Object.freeze({
  cosmos:'cosmos-sdk-rest', osmosis:'keplr-dashboard',
  juno:'cosmos-sdk-rest', chihuahua:'cosmos-sdk-rest',
  nolus:'nolus-official-api', dymension:'cosmos-sdk-rest'
});
const EXPECTED_URL = Object.freeze({
  cosmos:'https://rest.cosmos.directory/cosmoshub/cosmos/mint/v1beta1/annual_provisions',
  osmosis:'https://wallet.keplr.app/chains/osmosis',
  juno:'https://rest.cosmos.directory/juno/cosmos/mint/v1beta1/annual_provisions',
  chihuahua:'https://rest.cosmos.directory/chihuahua/cosmos/mint/v1beta1/annual_provisions',
  nolus:'https://app.nolus.io/api/governance/apr',
  dymension:'https://rest.cosmos.directory/dymension/cosmos/mint/v1beta1/annual_provisions'
});
export function parseRemoteApr(payload, id, now = Date.now()) {
  const item=payload?.networks?.[id];
  if(!CHAINS.includes(id) || !item) throw Error('Missing collector APR for '+id);
  if(item.source !== EXPECTED_SOURCE[id] || item.sourceUrl !== EXPECTED_URL[id] ||
     item.unit !== 'percent' || item.basis !== 'network-staking')
    throw Error('Unrecognized APR source for '+id);
  // Require explicit proof that the published APR already includes the
  // Cybernetics validator commission. This guards against double deductions
  // or accidentally using a legacy gross/nominal cache entry.
  if(item.aprType !== 'estimated-cybernetics-5-percent-net-staking-apr' ||
     item.validator !== 'Cybernetics' || item.validatorCommission !== 0.05 ||
     item.onchain?.validator !== 'Cybernetics' ||
     item.onchain?.validatorCommission !== 0.05 ||
     item.onchain?.commissionIncluded !== true)
    throw Error('Collector APR is not verified Cybernetics net APR for '+id);
  if (item.apr === null || item.apr === undefined || item.apr === '')
    throw Error('Unavailable APR for '+id);
  const netApr=Number(item.apr), grossApr=item.grossStakerApr;
  const t=Date.parse(item.fetchedAt || '');
  if(!Number.isFinite(netApr) || netApr<0 || netApr>1000)
    throw Error('Invalid net APR for '+id);
  if(typeof grossApr !== 'number' || !Number.isFinite(grossApr) ||
     grossApr<0 || grossApr>1000 ||
     Math.abs(netApr-grossApr*0.95)>Math.max(1e-6, grossApr*1e-8))
    throw Error('Invalid gross/net APR relationship for '+id);
  if(!Number.isFinite(t) || t>now+60000 || now-t>24*3600000)
    throw Error('Stale collector APR for '+id);
  if(item.status!=='ok') throw Error('Collector APR is not fresh for '+id);
  return {netApr, grossApr, source:item.source, asOf:item.fetchedAt, status:item.status};
}
export async function fetchRemoteApr(url,{fetchFn=fetch,now=Date.now()}={}) {
  if(!/^https:\/\//.test(url) &&
     !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(url))
    throw Error('APR API must use HTTPS (localhost excepted)');
  const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(),9000);
  try {
    const response=await fetchFn(url,{signal:ctl.signal,headers:{Accept:'application/json'}});
    if(!response.ok)throw Error('APR collector HTTP '+response.status);
    const payload=await response.json();
    return Object.fromEntries(CHAINS.map(id=>{
      try {return [id,parseRemoteApr(payload,id,now)];}
      catch {return [id,null];}
    }));
  } finally {clearTimeout(timer);}
}
