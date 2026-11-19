/*
  Data layer: live validator data from public Cosmos APIs. No backend, no API keys.

    chains.cosmos.directory/<chain>              chain id, token, decimals, APR, unbonding time, USD price, fees
    validators.cosmos.directory/chains/<chain>   finds the validator by Keybase identity / moniker (only if not pinned)
    rest.cosmos.directory/<chain>                validator stake + commission, transaction search, slashing (uptime window)
    rpc.cosmos.directory/<chain>                 block commits (which validators signed each block)

  Output (what index.html renders):
    chains  { [id]: { name, token, icon, apr, chainApr, commission, unbonding, tokens, price, decimals, denom,
                      chainId, registry, valoper, account, rpc, gasPrice, wallet, keplrUrl } }
    events  [{ key, type, dir?, peer?, peerName?, chain, text, detail, date, hash, amount, unbondsAt? }]   newest first
            type: delegation | undelegation | redelegation (dir: in|out) | unbonded | vote
    daily   [{ date, flows, staked, stakerRewards, operatorRewards }]   oldest first; each is { [chainId]: USD }

  Used by the server-side snapshot generator (scripts/snapshot.mjs) every 15 min.
  GitHub Actions downloads the completed dataset via /scraper/snapshot and
  publishes data/snapshot.json. Browsers use this module only for derived
  chart calculations, not for automatic calls to chain APIs.

  Notes
    - Daily history uses the snapshot's recorded stake + price per day; before that, it is rebuilt from
      current stake minus later net flows, valued at today's price.
    - Rewards per day = stake × chain APR / 365, split by commission (operator) and the rest (stakers).
    - History goes back config.history.days (default 90), limited by what public nodes keep indexed.
*/
(() => {
  'use strict';
  const CFG = window.CYBERNETICS;
  const API = Object.assign({
    chains: 'https://chains.cosmos.directory/',
    validators: 'https://validators.cosmos.directory/chains/',
    rest: 'https://rest.cosmos.directory/',
    rpc: 'https://rpc.cosmos.directory/'
  }, CFG.api);                                          // overridable (tests, self-hosted proxies)
  const DAY = 864e5, LIMIT = 100;
  const FLOW_TYPES = ['delegation', 'undelegation', 'redelegation'];

  async function get(url, ms = 20000) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`${res.status} ${url}`);
      return await res.json();
    } finally { clearTimeout(timer); }
  }

  /* ── bech32: same key, different prefix (valoper → account) ── */
  const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  function polymod(values) {
    const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= G[i];
    }
    return chk;
  }
  function bech32(hrp, words) {
    const expanded = [...[...hrp].map(c => c.charCodeAt(0) >> 5), 0, ...[...hrp].map(c => c.charCodeAt(0) & 31)];
    const mod = polymod([...expanded, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
    const checksum = Array.from({ length: 6 }, (_, i) => (mod >> (5 * (5 - i))) & 31);
    return hrp + '1' + [...words, ...checksum].map(d => CHARSET[d]).join('');
  }
  const withPrefix = (address, hrp) => bech32(hrp, [...address.slice(address.lastIndexOf('1') + 1, -6)].map(c => CHARSET.indexOf(c)));
  function toWords(bytes) {
    const out = []; let acc = 0, bits = 0;
    for (const b of bytes) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); } }
    if (bits) out.push((acc << (5 - bits)) & 31);
    return out;
  }

  /* ── Formatting shared with the UI ── */
  const fmtAmount = v => {
    const a = Math.abs(v);
    return a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a.toLocaleString('en-US', { maximumFractionDigits: a < 10 ? 2 : 0 });
  };
  const signed = (v, token) => (v < 0 ? '−' : '+') + fmtAmount(v) + ' ' + token;
  const gasString = (price, denom) => (+price).toFixed(12).replace(/\.?0+$/, '') + denom;

  /* ── Transaction search (SDK ≥0.50 uses `query`, older nodes `events`) ── */
  // Pages newest → oldest. Stops at the end of results, at a tx older than `stopBefore`, or after `maxPages`.
  // complete = nothing older is needed (or exists); false = stopped early (page cap or a node error mid-way).
  async function search(chain, query, { start = 1, maxPages = 1, stopBefore = 0 } = {}) {
    const base = `${API.rest}${chain.registry}/cosmos/tx/v1beta1/txs?order_by=ORDER_BY_DESC&`;
    const q = encodeURIComponent(query), txs = [];
    for (let page = start; page < start + maxPages; page++) {
      let res;
      try {
        if (chain.legacySearch !== true) {
          try { res = await get(`${base}query=${q}&page=${page}&limit=${LIMIT}`); chain.legacySearch = false; }
          catch (err) { if (chain.legacySearch === false) throw err; chain.legacySearch = true; }
        }
        if (chain.legacySearch) res = await get(`${base}events=${q}&pagination.offset=${(page - 1) * LIMIT}&pagination.limit=${LIMIT}`);
      } catch (err) {
        if (page === start) throw err;
        return { txs, complete: false };          // keep what we have; a later visit continues
      }
      const batch = res.tx_responses || [];
      txs.push(...batch);
      if (batch.length < LIMIT) return { txs, complete: true };
      if (stopBefore && Date.parse(batch.at(-1).timestamp) < stopBefore) return { txs, complete: true };
    }
    return { txs, complete: false };
  }

  // Events of a tx with plain attributes (older nodes base64-encode tx-level events).
  const unb64 = s => { try { const d = atob(s); return /^[\x20-\x7e]*$/.test(d) ? d : s; } catch { return s; } };
  function txEvents(tx) {
    const raw = tx.logs?.some(l => l.events?.length) ? tx.logs.flatMap(l => l.events) : (tx.events || []);
    return raw.map(e => {
      const attrs = {};
      for (const a of e.attributes || []) {
        let k = a.key || '', v = a.value ?? '';
        if (!/^[a-z_]+$/.test(k) && /^[a-z_]+$/.test(unb64(k))) { k = unb64(k); v = unb64(v); }
        attrs[k] = v;
      }
      return { type: e.type, attrs };
    });
  }
  const baseUnits = s => { const m = /^(\d+)/.exec(String(s || '').trim()); return m ? Number(m[1]) : 0; };
  function voteText(option) {
    const o = String(option || '').toUpperCase();
    const name = /VETO|"?OPTION"?:\s*4\b|^4$/.test(o) ? 'no with veto' : /ABSTAIN|:\s*2\b|^2$/.test(o) ? 'abstain'
      : /\bNO\b|_NO\b|:\s*3\b|^3$/.test(o) ? 'no' : 'yes';
    return 'Voted ' + name;
  }

  // The five searches behind a validator's activity. `done` remembers which have reached far enough back.
  async function chainEvents(c, { start = 1, maxPages = 1, stopBefore = 0, done = {} } = {}) {
    const queries = {
      del: `delegate.validator='${c.valoper}'`, unb: `unbond.validator='${c.valoper}'`,
      rin: `redelegate.destination_validator='${c.valoper}'`, rout: `redelegate.source_validator='${c.valoper}'`,
      own: `message.sender='${c.account}'`
    };
    const results = await Promise.all(Object.entries(queries).map(async ([k, q]) => {
      if (done[k]) return [];
      try { const r = await search(c, q, { start, maxPages, stopBefore }); if (r.complete) done[k] = true; return r.txs; }
      catch { return []; }
    }));
    const [del, unb, rin, rout, own] = results;
    const out = new Map();
    const amountOf = a => baseUnits(a.amount) / 10 ** c.decimals;
    const add = (tx, i, ev) => {
      const key = `${c.id}:${tx.txhash}:${i}`;
      if (!out.has(key)) out.set(key, { key, chain: c.id, hash: tx.txhash, date: new Date(tx.timestamp).toISOString(), ...ev });
    };
    const scan = (txs, fromOwnAccount) => txs.forEach(tx => {
      if (tx.code) return;
      txEvents(tx).forEach((e, i) => {
        const a = e.attrs;
        if (e.type === 'delegate' && a.validator === c.valoper) {
          const v = amountOf(a);
          add(tx, i, { type: 'delegation', amount: v, text: 'Delegation', detail: signed(v, c.token) });
        } else if (e.type === 'unbond' && a.validator === c.valoper) {
          const v = -amountOf(a);
          add(tx, i, { type: 'undelegation', amount: v, text: 'Undelegation', detail: signed(v, c.token),
            unbondsAt: a.completion_time ? new Date(a.completion_time).toISOString() : undefined });
        } else if (e.type === 'redelegate' && (a.destination_validator === c.valoper || a.source_validator === c.valoper)) {
          const incoming = a.destination_validator === c.valoper, v = (incoming ? 1 : -1) * amountOf(a);
          add(tx, i, { type: 'redelegation', dir: incoming ? 'in' : 'out', amount: v, detail: signed(v, c.token),
            peer: incoming ? a.source_validator : a.destination_validator });
        } else if (e.type === 'proposal_vote' && fromOwnAccount && (!a.voter || a.voter === c.account)) {
          add(tx, i, { type: 'vote', amount: 0, text: voteText(a.option), detail: 'Proposal #' + (a.proposal_id || '?') });
        }
      });
    });
    scan(del); scan(unb); scan(rin); scan(rout); scan(own, true);
    const events = [...out.values()];
    events.complete = Object.keys(queries).every(k => done[k]);
    return events;
  }

  // Every validator's name on a chain, in one paginated request (all bond statuses), cached.
  async function validatorNames(c) {
    if (c.names) return c.names;
    const names = new Map();
    let key = '';
    for (let i = 0; i < 10; i++) {
      const r = await get(`${API.rest}${c.registry}/cosmos/staking/v1beta1/validators?pagination.limit=500` +
        (key ? `&pagination.key=${encodeURIComponent(key)}` : ''), 30000);
      for (const v of r.validators || []) names.set(v.operator_address, v.description?.moniker?.trim());
      key = r.pagination?.next_key;
      if (!key) break;
    }
    return (c.names = names);
  }

  async function nameRedelegationPeers(c, events, monikers) {
    const peers = [...new Set(events.filter(e => e.type === 'redelegation').map(e => e.peer))];
    if (!peers.length) return;
    let names = monikers;
    if (!names || peers.some(p => !names.get(p))) names = await validatorNames(c).catch(() => monikers || new Map());
    // Anything still unknown (e.g. a validator that has since been removed): ask for it directly.
    const missing = peers.filter(p => !names.get(p));
    await Promise.all(missing.map(p => get(`${API.rest}${c.registry}/cosmos/staking/v1beta1/validators/${p}`)
      .then(r => names.set(p, r.validator?.description?.moniker?.trim())).catch(() => {})));
    for (const e of events) if (e.type === 'redelegation') {
      e.text = 'Redelegation';
      e.peerName = names.get(e.peer) || (e.peer.slice(0, 10) + '…' + e.peer.slice(-4));
    }
  }

  // An undelegation's tokens are released when its unbonding period ends.
  function completedUnbondings(c, events) {
    const now = Date.now();
    return events.filter(e => e.type === 'undelegation').map(e => {
      const at = e.unbondsAt ? +new Date(e.unbondsAt) : +new Date(e.date) + c.unbonding * DAY;
      e.unbondsAt = new Date(at).toISOString();
      return at <= now && { key: e.key + ':done', type: 'unbonded', chain: c.id, hash: e.hash, amount: e.amount,
        text: 'Unbonding complete', detail: e.detail, date: new Date(at).toISOString() };
    }).filter(Boolean);
  }

  async function chainInfo(cfg) {
    const meta = (await get(API.chains + cfg.registry)).chain;
    let valoper = cfg.valoper, monikers = null;
    if (!valoper) {
      const list = (await get(API.validators + cfg.registry, 40000)).validators || [];
      const me = list.find(v => (v.identity || v.description?.identity) === CFG.identity)
        || list.find(v => (v.moniker || v.description?.moniker) === CFG.moniker);
      if (!me) throw new Error(`${CFG.moniker} not found on ${cfg.registry}`);
      valoper = me.operator_address || me.address;
      monikers = new Map(list.map(v => [v.operator_address || v.address, v.moniker || v.description?.moniker]));
    }
    const { validator: v } = await get(`${API.rest}${cfg.registry}/cosmos/staking/v1beta1/validators/${valoper}`);
    const decimals = meta.decimals ?? 6;
    const commission = Number(v.commission?.commission_rates?.rate ?? 0);
    const providedApr = meta.params?.calculated_apr ?? meta.params?.estimated_apr;
    const chainApr = providedApr != null && Number.isFinite(Number(providedApr)) && Number(providedApr) >= 0
      ? Number(providedApr) : null;
    const prices = meta.prices?.coingecko || {};
    const fee = (meta.fees?.fee_tokens || []).find(f => f.denom === meta.denom) || {};
    const c = {
      id: cfg.id, registry: cfg.registry, name: cfg.name || meta.pretty_name, icon: cfg.icon,
      token: meta.symbol, denom: meta.denom, decimals, chainId: meta.chain_id, valoper,
      account: withPrefix(valoper, meta.bech32_prefix),
      prefix: meta.bech32_prefix, consensusKey: v.consensus_pubkey?.key, active: v.status === 'BOND_STATUS_BONDED',
      tokens: Number(v.tokens) / 10 ** decimals, commission, chainApr,
      apr: chainApr == null ? null : chainApr * (1 - commission) * 100,     // provider APR, net of validator commission
      price: prices[meta.display]?.usd ?? prices[String(meta.symbol).toLowerCase()]?.usd ?? 0,
      coingeckoId: cfg.coingecko || meta.coingecko_id || null,
      unbonding: Math.round((meta.params?.unbonding_time ?? 21 * 86400) / 86400),
      rpc: API.rpc + cfg.registry,
      gasPrice: cfg.gasPrice || gasString(fee.average_gas_price ?? fee.low_gas_price ?? fee.fixed_min_gas_price ?? 0.025, meta.denom),
      wallet: cfg.wallet !== false,
      jailed: !!v.jailed,
      keplrUrl: `https://wallet.keplr.app/chains/${cfg.keplr || cfg.registry}?modal=validator&chain=${meta.chain_id}&validator_address=${valoper}`,
      txBase: `https://www.mintscan.io/${cfg.mintscan || cfg.registry}/tx/`
    };
    return { chain: c, monikers };
  }

  // history[YYYY-MM-DD][chainId] = { tokens?, price? } from the snapshot job (recorded stake; CoinGecko daily price).
  // Where present that day uses them; otherwise stake is rebuilt from today's minus later flows, at today's price.
  function buildDaily(chains, events, history = {}) {
    const days = CFG.history?.days ?? 90;
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const daily = Array.from({ length: days }, (_, i) => ({
      date: new Date(+today - (days - 1 - i) * DAY).toISOString(),
      flows: {}, staked: {}, stakerRewards: {}, operatorRewards: {}
    }));
    for (const c of Object.values(chains)) {
      const net = new Array(days).fill(0);            // tokens per day
      for (const e of events) {
        if (e.chain !== c.id || !FLOW_TYPES.includes(e.type)) continue;
        const d = new Date(e.date); d.setUTCHours(0, 0, 0, 0);
        const i = days - 1 - Math.round((+today - +d) / DAY);
        if (i >= 0 && i < days) net[i] += e.amount;
      }
      // Current published APR is the projection baseline for dates without
      // historical APR observations. This restores the pre-tracking charts while
      // retaining each day's recorded APR when it exists. Never write the
      // fallback into history: estimated backfills are not observed APRs.
      const currentApr = c.chainApr != null && Number.isFinite(c.chainApr) && c.chainApr >= 0
        ? c.chainApr : null;
      const recordedApr = daily.map(d => history[d.date.slice(0, 10)]?.[c.id]?.chainApr)
        .filter(v => v != null && Number.isFinite(v) && v >= 0);
      const baselineApr = currentApr ?? recordedApr.at(-1) ?? null;
      let later = 0;                                   // net flow after day i
      for (let i = days - 1; i >= 0; i--) {
        const rec = history[daily[i].date.slice(0, 10)]?.[c.id];
        const staked = rec?.tokens ?? Math.max(0, c.tokens - later), price = rec?.price ?? c.price;
        // Prefer the APR observed on this date; otherwise estimate using the
        // latest published/recorded APR. Backfilled rewards are estimates only.
        const grossApr = rec?.chainApr ?? baselineApr;
        const hasApr = grossApr != null && Number.isFinite(grossApr) && grossApr >= 0;
        const grossDaily = hasApr ? staked * grossApr / 365 : null;
        const stakers = grossDaily == null ? null : grossDaily * (1 - c.commission);
        const operator = grossDaily == null ? null : grossDaily * c.commission;
        daily[i].flows[c.id] = net[i] * price;
        daily[i].staked[c.id] = staked * price;
        daily[i].stakerRewards[c.id] = stakers == null ? null : stakers * price;
        daily[i].operatorRewards[c.id] = operator == null ? null : operator * price;
        later += net[i];
      }
    }
    return daily;
  }

  /* Streams results so the page fills in as soon as anything is known:
       onChain(chain)                    stake, APR, price… (fast: two small requests)
       onEvents(chain, events, complete) newest page first, then older pages in chunks until `history.days` back
       onFail(chainId, error)            network left out
     since[chainId] = { newest, complete } from a previous visit: if that history was complete, only newer
     transactions are fetched. */
  async function load({ onChain, onEvents, onFail, since = {} } = {}) {
    const days = CFG.history?.days ?? 90, cap = CFG.history?.maxPages ?? 40, CHUNK = 4;
    await Promise.all(CFG.chains.map(async cfg => {
      let info;
      try { info = await chainInfo(cfg); onChain?.(info.chain); }
      catch (err) { console.warn('[cybernetics]', cfg.id, err.message); onFail?.(cfg.id, err); return; }
      const c = info.chain, prev = since[cfg.id];
      const stopBefore = prev?.complete && prev.newest ? Date.parse(prev.newest) : Date.now() - days * DAY;
      const done = {};
      const emit = async events => {
        await nameRedelegationPeers(c, events, info.monikers);
        onEvents?.(c, [...events, ...completedUnbondings(c, events)], events.complete);
      };
      try {
        await emit(await chainEvents(c, { start: 1, maxPages: 1, stopBefore, done }));
        for (let start = 2; start <= cap && Object.keys(done).length < 5; start += CHUNK)
          await emit(await chainEvents(c, { start, maxPages: CHUNK, stopBefore, done }));
      } catch (err) { console.warn('[cybernetics]', cfg.id, 'history', err.message); }
    }));
  }

  // Newest events for one chain (first page only), for live updates.
  async function recent(c) {
    const events = await chainEvents(c, { maxPages: 1 });
    await nameRedelegationPeers(c, events, null);
    return events;
  }

  /* ── Uptime ──
     A block is "signed" when the validator's precommit is in that block's commit. The validator is
     identified there by the first 20 bytes of sha256(consensus public key). */
  async function signer(c) {
    if (!c.hexAddress) {
      const key = Uint8Array.from(atob(c.consensusKey), ch => ch.charCodeAt(0));
      const addr = new Uint8Array(await crypto.subtle.digest('SHA-256', key)).slice(0, 20);
      c.hexAddress = [...addr].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
      c.valcons = bech32(c.prefix + 'valcons', toWords(addr));
    }
    return c;
  }
  // { height, signed } for one block (latest when height is omitted). Small: header + signatures only.
  async function commit(c, height) {
    await signer(c);
    const r = await get(`${API.rpc}${c.registry}/commit${height ? '?height=' + height : ''}`, 10000);
    const sh = (r.result || r).signed_header;
    const sig = sh.commit.signatures.find(x => String(x.validator_address || '').toUpperCase() === c.hexAddress);
    const flag = sig?.block_id_flag;
    return { height: Number(sh.header.height), signed: !!sig && (Number(flag) === 2 || flag === 'BLOCK_ID_FLAG_COMMIT') };
  }
  // Official uptime: missed blocks within the chain's slashing window.
  async function signingStats(c) {
    await signer(c);
    const [info, params] = await Promise.all([
      get(`${API.rest}${c.registry}/cosmos/slashing/v1beta1/signing_infos/${c.valcons}`),
      get(`${API.rest}${c.registry}/cosmos/slashing/v1beta1/params`)
    ]);
    const window = Number(params.params.signed_blocks_window), missed = Number(info.val_signing_info.missed_blocks_counter);
    return { window, missed, uptime: window ? 1 - missed / window : null };
  }

  const rest = (c, path, ms) => get(`${API.rest}${c.registry}${path}`, ms);
  window.CyberneticsData = { load, recent, buildDaily, commit, signingStats, rest, FLOW_TYPES };
})();
