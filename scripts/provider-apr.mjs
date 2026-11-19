/* External published staking APRs only. No APR extrapolation from inflation or rewards. */
const DAY = 86400000;
const MAX_SOURCE_AGE = 7 * DAY;
const MAX_CACHED_AGE = 3 * DAY;

const positivePercent = v => {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') throw Error('missing staking APR');
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > 1000) throw Error('missing or invalid positive staking APR');
  return n;
};

// Numia publishes each daily staking APR under OSMO and total; its own
// osmoscope integration gives priority to OSMO when both are present.
// Skip a zero-only reading: it must not overwrite a verified fee-funded APR.
export function numiaApr(rows, now = Date.now()) {
  if (!Array.isArray(rows)) throw Error('Numia APR must be an array');
  const dates = new Map();
  for (const r of rows) {
    if (r?.symbol !== 'OSMO' && r?.symbol !== 'total') continue;
    const date = String(r.labels || '').slice(0, 10);
    const time = Date.parse(date + 'T00:00:00Z');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time) ||
        time > now + DAY || now - time > MAX_SOURCE_AGE) continue;
    const val = Number(r.apr);
    if (!Number.isFinite(val) || val <= 0 || val > 1000) continue;
    if (r.symbol === 'OSMO' || !dates.has(date)) dates.set(date, {grossApr:val, source:'numia', asOf:date});
  }
  const date = [...dates.keys()].sort().at(-1);
  if (!date) throw Error('Numia returned no recent positive OSMO staking APR');
  return dates.get(date);
}

// Nolus official governance API: accept a direct APR, in fraction or percent
// units. Do not accidentally read a separate inflation or lending APR.
export function nolusApr(payload) {
  const value = payload?.apr ?? payload?.stakingApr ?? payload?.staking_apr;
  const n = positivePercent(value);
  return {grossApr: n <= 1 ? n * 100 : n, source:'nolus'};
}

// Public third-party Nolus staking explorer reports distribution-derived APR,
// not inflation-derived APR. Only used when the official app API fails.
export function stakingExplorerApr(html, chain) {
  if (typeof html !== 'string') throw Error('invalid explorer HTML');
  const start = html.search(new RegExp(chain + '\\s+staking APR', 'i'));
  if (start < 0) throw Error('explorer missing '+chain+' staking APR heading');
  const section = html.slice(start, start + 1800)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const found = section.match(/\bAPR\s+(\d+(?:\.\d+)?)\s*%/i);
  if (!found) throw Error('explorer has no explicit staking APR');
  return {grossApr: positivePercent(found[1]), source:'staking-explorer'};
}
export const nolusExplorerApr = html => stakingExplorerApr(html, 'Nolus');

async function request(url, {fetchFn, format='json', headers={}}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetchFn(url, {signal:ctl.signal, headers:{Accept:format==='json'?'application/json':'text/html',...headers}});
    if (!r.ok) throw Error('HTTP '+r.status+' from '+new URL(url).host);
    return format==='json' ? r.json() : r.text();
  } finally { clearTimeout(timer); }
}

export async function externalApr(id, {fetchFn=fetch, now=Date.now(), base='', numiaKey=''}={}) {
  if (id==='osmosis') {
    const end = new Date(now).toISOString().slice(0,10);
    const start = new Date(now-14*DAY).toISOString().slice(0,10);
    const url = (base?base+'/numia/apr':'https://public-osmosis-api.numia.xyz/apr')
      +'?start_date='+start+'&end_date='+end;
    try {
      return numiaApr(await request(url,{fetchFn,headers:numiaKey?{Authorization:'Bearer '+numiaKey}:{}}),now);
    } catch (primaryError) {
      const fallback = base?base+'/staking-explorer/osmosis':'https://staking-explorer.com/explorer/osmosis';
      try { return stakingExplorerApr(await request(fallback,{fetchFn,format:'text'}), 'Osmosis'); }
      catch (secondaryError) { throw Error('Numia: '+primaryError.message+'; staking explorer: '+secondaryError.message); }
    }
  }
  if (id==='nolus') {
    const url = base?base+'/nolus/api/governance/apr':'https://app.nolus.io/api/governance/apr';
    try {
      return nolusApr(await request(url,{fetchFn}));
    } catch (primaryError) {
      const fallback = base?base+'/staking-explorer/nolus':'https://staking-explorer.com/explorer/nolus';
      try { return nolusExplorerApr(await request(fallback,{fetchFn,format:'text'})); }
      catch (secondaryError) {
        throw Error('Nolus official: '+primaryError.message+'; staking explorer: '+secondaryError.message);
      }
    }
  }
  throw Error('unsupported external APR network: '+id);
}

export function chooseApr(id,current,previous,reading,now=Date.now()) {
  if (!['osmosis','nolus'].includes(id)) return current;
  const expected = id==='osmosis'?['numia','staking-explorer']:['nolus','staking-explorer'];
  const c={...current,apr:null,chainApr:null,aprSource:null,aprFetchedAt:null,aprAsOf:null};
  if (reading && expected.includes(reading.source) && Number.isFinite(reading.grossApr) && reading.grossApr>0) {
    c.chainApr=reading.grossApr/100;
    c.apr=reading.grossApr*(1-c.commission);
    c.aprSource=reading.source;
    c.aprFetchedAt=new Date(now).toISOString();
    c.aprAsOf=reading.asOf||c.aprFetchedAt;
    return c;
  }
  const age=now-Date.parse(previous?.aprFetchedAt||'');
  if (expected.includes(previous?.aprSource) && Number.isFinite(age) && age>=0 &&
      age<MAX_CACHED_AGE && Number.isFinite(previous.chainApr) && previous.chainApr>0) {
    c.chainApr=previous.chainApr;
    c.apr=previous.chainApr*100*(1-c.commission);
    c.aprSource=previous.aprSource;
    c.aprFetchedAt=previous.aprFetchedAt;
    c.aprAsOf=previous.aprAsOf||previous.aprFetchedAt;
  }
  return c;
}
