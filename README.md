# The Cybernetics · Validator dashboard

Live dashboard for The Cybernetics validator across Cosmos networks: total stake, daily staker and
operator rewards, delegation inflows/outflows, on-chain activity, and in-page staking.

Static site. No build step, no backend, no API keys, no dependencies.

## Run

```sh
python3 -m http.server 8000      # then open http://localhost:8000
```

Opening `index.html` directly also works. To publish, enable **GitHub Pages** (Settings → Pages → Deploy from branch → `main` / root).

## Files

| File | What it is |
|---|---|
| `config.js` | **The only file to edit.** Validator identity and the list of networks. |
| `data.js` | Fetches live data from public Cosmos APIs and shapes it into `{ chains, events, daily }`. |
| `wallet.js` | Stake: connect Keplr / Leap, show balance, build + sign + broadcast a delegation. Ledger and Ethermint keys (Dymension) supported. On phones without an extension it reopens the page in the Keplr app. |
| `index.html` | The UI: markup, styles, rendering, state. |
| `assets/` | Brand mark, wordmark, network icons. |
| `tests/` | Encoding test (vs CosmJS) and an offline end-to-end test with mocked chain APIs. |

## Adding or fixing a network

Add an entry to `config.js` with the network's chain-registry name (for example `stargaze`). If you know
the validator address, set `valoper`; otherwise it is found by Keybase identity or moniker. A network
where the validator can't be found is hidden automatically.

## Where the numbers come from

| Shown | Source |
|---|---|
| Total staked | Validator `tokens` (chain REST) × USD price (cosmos.directory / CoinGecko) |
| APR | cosmos.directory `calculated_apr` × (1 − validator commission) |
| Staker / operator rewards per day | stake × chain APR ÷ 365, split by commission |
| Delegations, undelegations, redelegations | On-chain transaction search (`delegate`, `unbond`, `redelegate` events); counterparty names from the chain's full validator set |
| Unbonding complete | `completion_time` of each undelegation (falls back to the chain's unbonding period) |
| Votes | `proposal_vote` events from the validator's own account |
| Uptime grid | Last 50 block commits (RPC `/commit`): signed if the validator's precommit is present |
| Uptime % | Slashing `missed_blocks_counter` over `signed_blocks_window` |
| Live updates | Uptime every 6 s while the tab is open, new transactions every 60 s |

### Loading

Each network appears as soon as its stake/APR/price arrive (two small requests). Transactions stream in
afterwards, newest page first, then the rest of the history. The last result is kept in `localStorage`
(`cyb.cache.v1`, up to 7 days old), so a return visit paints instantly and refreshes in the background.

### Known limits

- **History depth** is whatever public nodes keep indexed: up to `history.pages × 100` transactions per event
  type (set in `config.js`). For full multi-year history, point `data.js` at an indexer.
- **Past values** are rebuilt from today's stake minus later flows, valued at **today's** price. Slashing isn't modelled.
- Public endpoints come and go. If a network fails to load it's left out and logged in the console as `[cybernetics]`.

## Tests

```sh
npm install && npm test          # transaction encoding matches CosmJS byte-for-byte
pip install playwright && playwright install chromium
python3 tests/e2e.py             # whole page against mocked chain APIs (3 SDK response formats, wallet flow, offline)
```

## For agents

State lives in the URL hash (`#view=inflows&chain=osmosis&day=2026-11-02`). In the console,
`cybernetics.state`, `cybernetics.set(key, value)` and `cybernetics.data` expose everything rendered.
