/* External, provider-published staking APRs. No reward sampling or inflation-derived estimates. */
const MAX_SOURCE_AGE = 3 * 86400e3;
const MAX_CACHED_AGE = 3 * 86400e3;

const finiteRate = value => {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') throw new Error('missing APR');
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1000) throw new Error('invalid APR');
  return n;
};

export function numiaApr(rows, now = Date.now()) {
  if (!Array.isArray(rows)) throw new Error('Numia APR must be an array');
  // Numia provides individual assets and a total. Use only the total OSMO staking APR,
  // which includes fee-funded rewards; never add components or select inflation alone.
  const candidates = rows.filter(r => r && (r.symbol === 'total' || r.symbol === 'OSMO'))
    .map(r => ({ date: String(r.labels || '').slice(0, 10), symbol: r.symbol, apr: r.apr }))
    .filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(Date.parse(r.date)));
  candidates.sort((a, b) => b.date.localeCompare(a.date) || (a.symbol === 'total' ? -1 : 1));
  const latest = candidates[0];
  if (!latest) throw new Error('Numia has no OSMO total APR');
  // A daily APR is dated to its observation day; allow Numia's next-day publication delay.
  const t = Date.parse(latest.date);
  if (t > now + 86400e3 || now - t > MAX_SOURCE_AGE) throw new Error('Numia APR is stale');
  return { grossApr: finiteRate(latest.apr), asOf: latest.date, source: 'numia' };
}

export function nolusApr(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid Nolus response');
  // The official app provides an APR, not an APY or the separate annual inflation field.
  const raw = finiteRate(payload.apr);
  // APIs commonly expose APR as a fraction (0.08) or percent (8).
  // A fractional rate converts to a display percentage; no yield is estimated locally.
  const grossApr = raw <= 1 ? raw * 100 : raw;
  return { grossApr, source: 'nolus' };
}

async function json(url, { fetchFn, headers = {} }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  try {
    const res = await fetchFn(url, { signal: ctl.signal, headers: { Accept: 'application/json', ...headers } });
    if (!res.ok) throw new Error('APR API HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function externalApr(id, { fetchFn = fetch, now = Date.now(), base = '', numiaKey = '' } = {}) {
  if (id === 'osmosis') {
    const end = new Date(now).toISOString().slice(0, 10);
    const start = new Date(now - 7 * 86400e3).toISOString().slice(0, 10);
    const url = (base ? base + '/numia/apr' : 'https://public-osmosis-api.numia.xyz/apr')
      + '?start_date=' + start + '&end_date=' + end;
    return numiaApr(await json(url, { fetchFn, headers: numiaKey ? { Authorization: 'Bearer ' + numiaKey } : {} }), now);
  }
  if (id === 'nolus') {
    const url = base ? base + '/nolus/api/governance/apr' : 'https://app.nolus.io/api/governance/apr';
    return nolusApr(await json(url, { fetchFn }));
  }
  throw new Error('unsupported external APR network: ' + id);
}

export function chooseApr(id, current, previous, reading, now = Date.now()) {
  if (!['osmosis', 'nolus'].includes(id)) return current;
  // These networks must NOT fall back to cosmos.directory's inflation-based APR.
  const c = { ...current, apr: null, chainApr: null, aprSource: id === 'osmosis' ? 'numia' : 'nolus',
    aprFetchedAt: null, aprAsOf: null };
  if (reading) {
    c.chainApr = reading.grossApr / 100;
    c.apr = reading.grossApr * (1 - c.commission);
    c.aprFetchedAt = new Date(now).toISOString();
    c.aprAsOf = reading.asOf || c.aprFetchedAt;
    return c;
  }
  // Carry forward only an APR previously fetched from the same external provider.
  const age = now - Date.parse(previous?.aprFetchedAt || '');
  if (previous?.aprSource === c.aprSource && Number.isFinite(age) && age >= 0 && age < MAX_CACHED_AGE &&
      Number.isFinite(previous.apr) && Number.isFinite(previous.chainApr)) {
    c.apr = previous.apr;
    c.chainApr = previous.chainApr;
    c.aprFetchedAt = previous.aprFetchedAt;
    c.aprAsOf = previous.aprAsOf || previous.aprFetchedAt;
  }
  return c;
}
