# The Cybernetics · Validator dashboard

Live dashboard for The Cybernetics validator across Cosmos networks: total stake, daily staker and
operator rewards, delegation inflows/outflows, on-chain activity, and in-page staking.

Static site. No build step, no server, no API keys, no dependencies.

## How it works

```
GitHub Action, every 15 min          visitors
scripts/snapshot.mjs ──► data/snapshot.json ──► index.html   (one static file, same for everyone)
  └─ data.js ──► public Cosmos APIs
```

The snapshot job fetches everything once and publishes it with the site, so visitors never call the chain
APIs. 100 visitors = 100 downloads of one cached file, zero load on public nodes. Each run starts from the
previous snapshot, fetches only newer transactions, and records that day's stake and price, so history keeps
growing (at real daily prices) even after public nodes prune old transactions.

Only two things talk to the chains from the browser: the Uptime tab's live block grid (tiny requests, only
while it's open) and the visitor's own wallet when they stake.

## Publish

1. **Settings → Pages → Source: GitHub Actions.**
2. Push to `main` (or Actions → *Snapshot and deploy* → Run workflow). The site redeploys every 15 minutes.
3. Optional: add a free CoinGecko demo key as the repository secret `COINGECKO_API_KEY` (Settings → Secrets and
   variables → Actions) if the public price API ever rate-limits the job.

GitHub pauses scheduled workflows in repositories with no activity for 60 days; re-enable it under Actions if so.

## Run locally

```sh
node scripts/snapshot.mjs        # writes data/snapshot.json (optional)
python3 -m http.server 8000      # then open http://localhost:8000
```

Without a snapshot the page reads the chains itself (slower, same result).

## Files

| File | What it is |
|---|---|
| `config.js` | **The only file to edit.** Validator identity and the list of networks. |
| `data.js` | Fetches live data from public Cosmos APIs and shapes it into `{ chains, events, daily }`. |
| `wallet.js` | Stake: connect Keplr / Leap, show balance, build + sign + broadcast a delegation. Ledger and Ethermint keys (Dymension) supported. On phones without an extension it reopens the page in the Keplr app. |
| `index.html` | The UI: markup, styles, rendering, state. |
| `scripts/snapshot.mjs` | The snapshot job (runs `data.js` in Node). |
| `.github/workflows/snapshot.yml` | Runs the job every 15 min and deploys the site with the fresh snapshot. |
| `assets/` | Brand mark, wordmark, network icons. |
| `tests/` | Encoding test (vs CosmJS) and an offline end-to-end test with mocked chain APIs. |

## Adding or fixing a network

Add an entry to `config.js` with the network's chain-registry name (for example `stargaze`). If you know
the validator address, set `valoper`; otherwise it is found by Keybase identity or moniker. A network
where the validator can't be found is hidden automatically.

## Where the numbers come from

| Shown | Source |
|---|---|
| Total staked | Validator `tokens` (chain REST) × USD price |
| Prices | Self-hosted APR scraper at `tonyler.is-not-a.dev/scraper/api`, which batches CoinGecko token prices every 10 minutes and stores dated observations on the server. The dashboard's snapshot job uses its cached prices and `/scraper/history` daily prices, retaining prior snapshot history when unavailable. |
| APR | **External APIs only**: Osmosis uses Numia's published staking APR, Nolus uses the official Nolus governance APR API; both use rewards-based Staking Explorer as a fallback, and other networks use cosmos.directory `calculated_apr` (or `estimated_apr`). Delegator APR is displayed net of validator commission. Neither network falls back to inflation-derived APR. Zero or missing readings trigger the independent reward-distribution APR source; the last verified external APR is kept for at most 72 hours if both sources fail, then shown as unavailable. No local reward sampling. |
| Staker / operator rewards per day | **Estimated** from that date's recorded gross chain APR: daily gross tokens = validator stake × gross APR ÷ 365; stakers receive (1 − validator commission), operator commission is the remainder; each valued at that date's token price. Missing historical APRs display unavailable rather than invented zeros. |
| Delegations, undelegations, redelegations | On-chain transaction search (`delegate`, `unbond`, `redelegate` events); counterparty names from the chain's full validator set |
| Unbonding complete | `completion_time` of each undelegation (falls back to the chain's unbonding period) |
| Votes | `proposal_vote` events from the validator's own account |
| Uptime grid | Last 50 block commits (RPC `/commit`): signed if the validator's precommit is present |
| Uptime % | Slashing `missed_blocks_counter` over `signed_blocks_window` |
| Freshness | Snapshot every 15 min (the page re-checks every 5 min); Uptime grid live every 6 s while open |

### Known limits

- **History depth**: 90 days by default (`history.days`), capped at `history.maxPages × 100` transactions per
  event type, and limited by what public nodes keep indexed (some prune old transactions). For multi-year
  history, point `data.js` at an indexer.
- **Past values** use the stake, price, and gross APR recorded by the snapshot job each day. Days before staking APR tracking started have **unknown estimated rewards** (chart gaps, not zero). Missing historical stake/price may still be reconstructed from today's stake and later flows at today's price; these are estimates, not payouts.
- **APR is chain-wide**: the scraper's chain staking APR is treated as the pre-validator-commission rate, then adjusted for this validator's commission. Actual delegator and validator income can vary with reward composition, commission changes, performance, self-delegations, and distribution timing. The dashboard does not measure actual reward withdrawals.
- Public endpoints come and go. If a network fails to load it's left out and logged in the console as `[cybernetics]`.

## APR API sources

- Osmosis: `https://public-osmosis-api.numia.xyz/apr` (daily total staking APR, including protocol revenue; may appear a day late). Optional GitHub Actions secret: `NUMIA_API_KEY` for higher limits.
- Nolus: `https://app.nolus.io/api/governance/apr` (official APR read endpoint; no key).
- Secondary provider (Osmosis and Nolus): `https://staking-explorer.com/explorer/<network>` publishes distribution-based staking APR, used only if the primary source returns no usable positive rate.
- Other networks: Cosmos Directory. All displayed delegator APRs account for validator commission.
- If an APR endpoint is unavailable, the snapshot keeps a verified rate from either approved provider for up to 72 hours; it never substitutes inflation-only estimates. The snapshot records `aprSource`, `aprFetchedAt`, `aprAsOf`, `aprCheckedAt`, and `aprError` for diagnostics.

## Single server API: complete dashboard snapshot

All regular dashboard data collection now runs on the server hosting
`tonyler/Apr-scraper`. Every 15 minutes that service executes the existing
`scripts/snapshot.mjs` from a local checkout of this repository and exposes
`https://tonyler.is-not-a.dev/scraper/snapshot`. GitHub Actions downloads
**that one complete JSON snapshot every 15 minutes** and deploys it to
GitHub Pages. It no longer queries Cosmos, CoinGecko or external APR APIs.

Included: six validators' staking state and commissions, delegation and
transaction activity, recorded staking APRs and token prices, 90-day chart
history, slashing uptime statistics, and the last 50 signed-block flags
per network. The Uptime tab no longer polls RPC from each visitor's browser;
it refreshes on the published snapshot schedule. Wallet-initiated actions
still require interaction with the user's wallet and network.

Server update (required when snapshot-generator logic changes):

```bash
cd ~/apps/Apr-scraper
git pull origin main
sudo bash deploy/install-dashboard.sh
sudo systemctl restart keplr-apr-scraper
curl -s 'https://tonyler.is-not-a.dev/scraper/health' | python3 -m json.tool
curl -s 'https://tonyler.is-not-a.dev/scraper/snapshot' | python3 -m json.tool
```

The server retains the last validated snapshot when upstream collection
fails. GitHub Actions refuses malformed or overly stale snapshots rather
than replacing the published page with invalid data.
## Keplr staking APR collector

The collector is now also the **USD token-price and APR-history service**. Production GitHub Actions no longer calls CoinGecko directly: it reads `/scraper/api` for current prices and `/scraper/history?days=400` for recorded daily prices/APRs. The scraper polls prices every 10 minutes and stores up to 30 days of individual samples plus up to 400 days of daily records; older price backfill is attempted gradually subject to upstream availability. GitHub Pages visitors continue to read the already assembled static `data/snapshot.json`, not CoinGecko. Validator stake, transactions, and uptime still come from the existing Cosmos chain sources in the GitHub snapshot job. This doesn't change the page UI.


The snapshot also checks `https://tonyler.is-not-a.dev/scraper/api` for the six native chains. Its values are scraped directly from the **Staking APR** shown on each Keplr Dashboard chain page (not APY or inflation). Values are used as displayed, without another commission deduction. Missing or stale readings fall back to the previously configured APR sources. To override the URL, set `APR_COLLECTOR_URL` in the snapshot GitHub Actions environment. The collector runs separately from GitHub Pages in [tonyler/Apr-scraper](https://github.com/tonyler/Apr-scraper); the Pages site itself remains static. It must first be deployed behind HTTPS on the user's server.

## Tests

```sh
npm install && npm test
node --test tests/provider-apr.test.mjs tests/remote-apr.test.mjs          # transaction encoding matches CosmJS byte-for-byte
pip install playwright && playwright install chromium
python3 tests/snapshot_test.py   # snapshot job → site: incremental runs, visitors make zero chain API calls
python3 tests/e2e.py             # fallback mode against mocked chain APIs (3 SDK formats, wallet flow, uptime)
```

## For agents

State lives in the URL hash (`#view=inflows&chain=osmosis&day=2026-11-02`). In the console,
`cybernetics.state`, `cybernetics.set(key, value)` and `cybernetics.data` expose everything rendered.

## Cybernetics 5% net APR contract (collector integration)

The collector at `/scraper/api` returns `networks.<chain>.apr` **already net of Cybernetics' 5% validator commission** for all six chains. Do not multiply it by `(1 - commission)` again in the snapshot generator. `grossStakerApr` is the *pre*-validator-commission APR; use `grossStakerApr / 100` for `chainApr` and historical gross staker/operator reward estimates. The dashboard's display `chains[id].apr` receives the collector's net `apr` unchanged.

To prevent double deductions and mixing unrelated providers with these figures, `scripts/remote-apr.mjs` only accepts fresh `ok` readings carrying the explicit `aprType: "estimated-cybernetics-5-percent-net-staking-apr"`, matching Cybernetics commission metadata, and a consistent gross/net relationship. When those checks fail the existing provider fallback may be used; it is not silently treated as a Cybernetics-specific collector result.

**Deployment requires updating the server's checked-out dashboard source**, not just the `Apr-scraper` repository:

```sh
cd ~/apps/Apr-scraper
sudo bash deploy/install-dashboard.sh
sudo systemctl restart keplr-apr-scraper
curl -fsSL https://tonyler.is-not-a.dev/scraper/snapshot | jq '.chains.cosmos | {apr,chainApr,aprSource}'
```

After the VPS generates a fresh snapshot, the `Snapshot and deploy` GitHub Action downloads `/scraper/snapshot` on its 15-minute schedule and deploys GitHub Pages. The dashboard's APR and reward estimates should then reflect the corrected gross/net semantics.
