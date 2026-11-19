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
       NUMIA_API_KEY     optional Numia key for higher rate limits
       API_BASE   test-only: route all API calls to a local mock
*/
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { externalApr, chooseApr } from './provider-apr.mjs';

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
const chains = Object.fromEntries(Object.entries(prev?.chains || {}).map(([id, c]) => [id, { ...c }])); // preserve previous APR metadata for safe fallback
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
// Do not carry pre-migration measured APRs forward for networks that failed to refresh.
for (const [id, c] of Object.entries(chains)) {
  delete c.aprMeasured;
  delete c.aprEstimated;
  if (!fresh.has(id)) { c.apr = null; c.chainApr = null; }
}

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

/* ── Staking APR sources ──
   Osmosis: Numia total staking APR (revenue + inflation, as published).
   Nolus: official app staking APR. Others: cosmos.directory provider APR.
   Do not use inflation-based fallbacks for Osmosis or Nolus. */
await Promise.all(['osmosis', 'nolus'].filter(id => chains[id]).map(async id => {
  let reading = null, error = null;
  try {
    // APR APIs are independent of chain REST freshness. A cached validator
    // still deserves an APR refresh when its on-chain endpoint is temporarily down.
    reading = await externalApr(id, {
      base: process.env.API_BASE?.replace(/\/$/, '') || '',
      numiaKey: process.env.NUMIA_API_KEY || ''
    });
  } catch (err) {
    error = err.message;
    console.warn(`  ${id}: external APR unavailable (${error})`);
  }
  chains[id] = chooseApr(id, chains[id], prev?.chains?.[id], reading);
  chains[id].aprCheckedAt = new Date().toISOString();
  chains[id].aprError = error;
  if (chains[id].apr == null) console.warn(`  ${id}: no verified staking APR; not publishing a misleading 0%`);
}));
for (const id of fresh) {
  const c = chains[id];
  console.log(`  ${id}: APR ${c.apr == null ? '— (provider unavailable)' : c.apr.toFixed(2) + '%'} (${c.aprSource || 'cosmos.directory'}), ${c.price}`);
}

// Today's stake, per network (prices per day come from CoinGecko above).
history[today] = { ...(history[today] || {}) };
for (const id of fresh) history[today][id] = { ...(history[today][id] || {}), tokens: chains[id].tokens, price: chains[id].price };
for (const d of Object.keys(history)) if (Date.now() - Date.parse(d) > HISTORY_DAYS * 864e5) delete history[d];

const keepFrom = Date.now() - (days + 7) * 864e5;
const list = [...events.values()].filter(e => Date.parse(e.date) >= keepFrom).sort((a, b) => b.date.localeCompare(a.date));
for (const id of completeNow) coverage[id] = { complete: true, newest: list.find(e => e.chain === id && e.type !== 'unbonded')?.date };

const skip = new Set(['names', 'hexAddress', 'valcons', 'legacySearch', 'peer']);
const snapshot = { generatedAt: new Date().toISOString(), chains, events: list, coverage, uptime, history, priceHistoryDay };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(snapshot, (k, v) => skip.has(k) ? undefined : v));
console.log(`wrote ${path.relative(ROOT, OUT)}: ${Object.keys(chains).length} networks, ${list.length} events, ${(fs.statSync(OUT).size / 1024).toFixed(0)} KB`);
