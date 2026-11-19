/*
  Snapshot job: fetch everything once, write data/snapshot.json. Every visitor reads that file.
  Runs in GitHub Actions every 15 minutes (.github/workflows/snapshot.yml); also runs locally:

    node scripts/snapshot.mjs

  Incremental: starts from the previous snapshot (the deployed one, or the local file) and only fetches
  transactions newer than it already has. Each run also records today's stake and price per network,
  so the history keeps real values even after public nodes prune old transactions.

  Env: SITE_URL   deployed site, to read the previous snapshot from (set by the workflow)
       OUT        output path (default data/snapshot.json)
       COINGECKO_API_KEY  optional CoinGecko demo key (repository secret), for higher rate limits
       API_BASE   test-only: route all API calls to a local mock
*/
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.resolve(ROOT, process.env.OUT || 'data/snapshot.json');
const HISTORY_DAYS = 400;

// Run the browser files as-is: config.js and data.js expect `window`.
globalThis.window = globalThis;
const run = file => vm.runInThisContext(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
run('config.js');
const CFG = window.CYBERNETICS;
if (process.env.API_BASE) {
  const b = process.env.API_BASE.replace(/\/$/, '');
  CFG.api = { chains: `${b}/chains/`, validators: `${b}/validators/chains/`, rest: `${b}/rest/`, rpc: `${b}/rpc/` };
}
const COINGECKO = process.env.API_BASE ? process.env.API_BASE.replace(/\/$/, '') + '/coingecko/api/v3' : 'https://api.coingecko.com/api/v3';
run('data.js');
const D = window.CyberneticsData;

// Previous snapshot: the local file (restored by the workflow's cache), else the deployed one.
async function previous() {
  try { return JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
  if (process.env.SITE_URL) {
    try {
      const r = await fetch(new URL('data/snapshot.json', process.env.SITE_URL), { cache: 'no-store' });
      if (r.ok) return await r.json();
    } catch {}
  }
  return null;
}

const prev = await previous();
const days = CFG.history?.days ?? 90;
const chains = { ...(prev?.chains || {}) };          // keep last known values for a network that fails this run
const events = new Map((prev?.events || []).map(e => [e.key, e]));
const coverage = { ...(prev?.coverage || {}) }, completeNow = new Set(), fresh = new Set();
console.log(prev ? `previous snapshot: ${prev.generatedAt}, ${prev.events.length} events` : 'no previous snapshot: full fetch');

await D.load({
  since: coverage,
  onChain: c => { chains[c.id] = c; fresh.add(c.id); console.log(`  ${c.id}: ${c.tokens.toLocaleString('en-US')} ${c.token}`); },
  onEvents: (c, list, complete) => { for (const e of list) events.set(e.key, e); if (complete) completeNow.add(c.id); },
  onFail: () => {}
});
if (!fresh.size) { console.error('No network could be reached; keeping the previous snapshot.'); process.exit(1); }

// Official uptime over each chain's slashing window.
const uptime = { ...(prev?.uptime || {}) };
await Promise.all([...fresh].map(async id => {
  try { uptime[id] = await D.signingStats(chains[id]); } catch (err) { console.warn(`  ${id}: uptime failed (${err.message})`); }
}));

/* ── Prices (CoinGecko) ──
   Current USD price for every network in one request; once a day, 90 days of daily prices per token,
   so each day's stake and rewards are valued at that day's price. */
const today = new Date().toISOString().slice(0, 10), history = { ...(prev?.history || {}) };
const cgHeaders = process.env.COINGECKO_API_KEY ? { 'x-cg-demo-api-key': process.env.COINGECKO_API_KEY } : {};
const cg = async p => { const r = await fetch(COINGECKO + p, { headers: cgHeaders }); if (!r.ok) throw new Error(`CoinGecko ${r.status}`); return r.json(); };
const ids = [...new Set([...fresh].map(id => chains[id].coingeckoId).filter(Boolean))];
try {
  const now = await cg(`/simple/price?ids=${ids.join(',')}&vs_currencies=usd`);
  for (const id of fresh) { const p = now[chains[id].coingeckoId]?.usd; if (p) chains[id].price = p; }
} catch (err) { console.warn(`  prices: ${err.message} (keeping cosmos.directory prices)`); }
// Daily price history: refreshed once a day per token, at most 2 tokens per run (the free API is strict);
// a refused request (429) just waits for the next run.
const priceHistoryDay = { ...(prev?.priceHistoryDay || {}) };
let fetchedHistory = 0;
for (const id of fresh) {
  const coin = chains[id].coingeckoId;
  if (!coin || priceHistoryDay[coin] === today || fetchedHistory >= 2) continue;
  if (fetchedHistory) await new Promise(r => setTimeout(r, process.env.API_BASE ? 0 : 8000));
  fetchedHistory++;
  try {
    const { prices } = await cg(`/coins/${coin}/market_chart?vs_currency=usd&days=${days}&interval=daily`);
    for (const [ms, usd] of prices) { const d = new Date(ms).toISOString().slice(0, 10); (history[d] ??= {})[id] = { ...(history[d]?.[id] || {}), price: usd }; }
    priceHistoryDay[coin] = today;
    console.log(`  ${id}: ${prices.length} days of prices`);
  } catch (err) { console.warn(`  ${id}: price history ${err.message}, retrying next run`); break; }
}

/* ── Measured APR ──
   Follow one real delegation per network: the growth of its pending rewards between runs, divided by its stake
   and the time elapsed, is what delegators actually earn (after commission, fees included). Pairs where the
   stake changed or rewards were withdrawn are skipped; the rate is averaged over the last 24 hours. */
const aprState = { ...(prev?.aprState || {}) };
await Promise.all([...fresh].map(async id => {
  const c = chains[id], st = aprState[id] ??= { probe: null, samples: [] };
  try {
    if (!st.probe) {
      const r = await D.rest(c, `/cosmos/staking/v1beta1/validators/${c.valoper}/delegations?pagination.limit=20`);
      const best = (r.delegation_responses || []).sort((a, b) => Number(b.balance.amount) - Number(a.balance.amount))[0];
      if (!best) throw new Error('no delegations');
      st.probe = best.delegation.delegator_address; st.samples = [];
    }
    const [del, rew] = await Promise.all([
      D.rest(c, `/cosmos/staking/v1beta1/validators/${c.valoper}/delegations/${st.probe}`),
      D.rest(c, `/cosmos/distribution/v1beta1/delegators/${st.probe}/rewards/${c.valoper}`)
    ]);
    const stake = Number(del.delegation_response.balance.amount);
    const reward = Number((rew.rewards || []).find(x => x.denom === c.denom)?.amount || 0);
    if (!stake) { st.probe = null; throw new Error('probe delegation gone'); }
    st.samples = [...st.samples, { t: Date.now(), stake, reward }].filter(x => Date.now() - x.t < 26 * 3600e3);
    let earned = 0, stakeTime = 0;
    for (let i = 1; i < st.samples.length; i++) {
      const a = st.samples[i - 1], b = st.samples[i];
      if (b.stake !== a.stake || b.reward < a.reward) continue;
      earned += b.reward - a.reward; stakeTime += a.stake * (b.t - a.t);
    }
    if (stakeTime > 0) {
      c.aprEstimated = c.apr;
      c.apr = earned / stakeTime * 365 * 864e5 * 100;
      c.aprMeasured = true;
    }
  } catch (err) { console.warn(`  ${id}: measured APR ${err.message}`); }
  if (!c.aprMeasured && prev?.chains?.[id]?.aprMeasured) { c.apr = prev.chains[id].apr; c.aprMeasured = true; }   // keep last good value
  console.log(`  ${id}: APR ${c.apr == null ? '—' : c.apr.toFixed(2) + '%'}${c.aprMeasured ? ' (measured)' : ' (estimated)'}, $${c.price}`);
}));

// Today's stake, per network (prices per day come from CoinGecko above).
history[today] = { ...(history[today] || {}) };
for (const id of fresh) history[today][id] = { ...(history[today][id] || {}), tokens: chains[id].tokens, price: chains[id].price };
for (const d of Object.keys(history)) if (Date.now() - Date.parse(d) > HISTORY_DAYS * 864e5) delete history[d];

const keepFrom = Date.now() - (days + 7) * 864e5;
const list = [...events.values()].filter(e => Date.parse(e.date) >= keepFrom).sort((a, b) => b.date.localeCompare(a.date));
for (const id of completeNow) coverage[id] = { complete: true, newest: list.find(e => e.chain === id && e.type !== 'unbonded')?.date };

const skip = new Set(['names', 'hexAddress', 'valcons', 'legacySearch', 'peer']);
const snapshot = { generatedAt: new Date().toISOString(), chains, events: list, coverage, uptime, history, aprState, priceHistoryDay };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(snapshot, (k, v) => skip.has(k) ? undefined : v));
console.log(`wrote ${path.relative(ROOT, OUT)}: ${Object.keys(chains).length} networks, ${list.length} events, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
