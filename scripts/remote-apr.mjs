// Consume the public APR collector operated by the validator. Never invent rates.
const SOURCE_URLS = {
  osmosis: 'https://staking-explorer.com/explorer/osmosis',
  nolus: 'https://staking-explorer.com/explorer/nolus'
};
export function parseRemoteApr(payload, id, now = Date.now()) {
  const item = payload?.networks?.[id];
  if (!SOURCE_URLS[id] || !item) throw Error('Missing external APR for ' + id);
  if (item.source !== 'staking-explorer' || item.sourceUrl !== SOURCE_URLS[id] ||
      item.unit !== 'percent' || item.basis !== 'network-staking') throw Error('Unrecognized APR source for ' + id);
  const value = Number(item.apr), time = Date.parse(item.fetchedAt || '');
  if (!Number.isFinite(value) || value <= 0 || value > 500) throw Error('Invalid staking APR for ' + id);
  if (!Number.isFinite(time) || time > now + 60000 || now - time > 72 * 3600000) throw Error('Stale staking APR for ' + id);
  // Staking Explorer reports a network-level distribution-based delegator rate.
  // Treat it as an externally reported net network APR, not a gross inflation APR.
  return { netApr: value, source: 'self-hosted-staking-explorer', asOf: item.fetchedAt };
}
export async function fetchRemoteApr(url, {fetchFn = fetch, now = Date.now()} = {}) {
  if (!/^https:\/\//.test(url) && !/^http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?\//.test(url)) {
    throw Error('APR API must use HTTPS (except localhost tests)');
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const response = await fetchFn(url, {signal: ctl.signal, headers: {Accept: 'application/json'}});
    if (!response.ok) throw Error('APR collector HTTP ' + response.status);
    const payload = await response.json();
    return Object.fromEntries(['osmosis', 'nolus'].map(id => {
      try { return [id, parseRemoteApr(payload, id, now)]; }
      catch { return [id, null]; }
    }));
  } finally { clearTimeout(timer); }
}
