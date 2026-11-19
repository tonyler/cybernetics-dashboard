"""End-to-end: the real page against mocked cosmos.directory + chain REST APIs (see mock.py)."""
import asyncio, json, base64, sys
import pathlib
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tests'))
import mock
from playwright.async_api import async_playwright
URL = (ROOT / 'index.html').as_uri()
WALLET = """
window.keplr = {
  async enable(id) { window.__enabled = id; },
  async getKey(id) { return { bech32Address: 'cosmos1delegatoraddressxxxxxxxxxxxxxxxxxxxxx', pubKey: Uint8Array.from({length:33}, (_, i) => i + 1), isNanoLedger: false }; },
  async signDirect(id, signer, doc) { window.__signDoc = { id, signer, acc: String(doc.accountNumber), body: Array.from(doc.bodyBytes), auth: Array.from(doc.authInfoBytes) };
    return { signed: doc, signature: { signature: btoa(String.fromCharCode(...new Uint8Array(64).fill(7))) } }; }
};"""
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        for name, w, h, wallet in [('desk', 1280, 1000, False), ('mob', 390, 900, True)]:
            ctx = await b.new_context(viewport={'width': w, 'height': h})
            if wallet: await ctx.add_init_script(WALLET)
            pg = await ctx.new_page()
            errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
            posts = []
            async def route(r):
                if r.request.method == 'POST': posts.append((r.request.url, r.request.post_data))
                await mock.handle(r)
            await pg.route('**/*', lambda r: route(r) if not r.request.url.startswith('file:') else r.continue_())
            await pg.goto(URL); await pg.wait_for_function("!document.body.classList.contains('loading')", timeout=20000); await pg.wait_for_timeout(1500)
            d = await pg.evaluate("({chains: Object.keys(cybernetics.data.chains), failed: cybernetics.data.failed, n: cybernetics.data.events.length})")
            print(name, 'chains', d, 'errors', errs)
            print('  total staked:', await pg.evaluate("document.querySelector('#perfValue .sr')?.textContent || document.querySelector('#perfValue').textContent"))
            c = await pg.evaluate("(() => { const c = cybernetics.data.chains.cosmos; return {apr: c.apr.toFixed(2), unb: c.unbonding, acct: c.account, gas: c.gasPrice, keplr: c.keplrUrl} })()")
            print('  cosmos:', c)
            await pg.click('button[data-value="explorer"]'); await pg.wait_for_timeout(800)
            await pg.click('[data-value="redelegation"]'); await pg.wait_for_timeout(300)
            rows = await pg.evaluate("[...document.querySelectorAll('#rows .row')].map(r => [r.querySelector('.title').textContent, r.querySelector('.peer').textContent, r.querySelector('div.num').textContent])")
            for r in rows: print('   ', r)
            await pg.click('button[data-value="inflows"]'); await pg.wait_for_timeout(1000)
            print('  net 30D:', await pg.evaluate("document.querySelector('#netValue .sr')?.textContent"), '| list rows:', await pg.locator('#flowRows .row').count())
            await pg.click('button[data-value="uptime"]'); await pg.wait_for_timeout(2500)
            up = await pg.evaluate("[...document.querySelectorAll('.up-row')].map(r => [r.dataset.chain, r.querySelector('.up-pct').textContent, r.querySelectorAll('i.ok').length, r.querySelectorAll('i.miss').length, r.querySelector('.up-window').textContent])")
            for r in up: print('  uptime', r)
            await pg.click('button[data-value="stake"]'); await pg.click('#switchBtn'); await pg.click('#menu [data-value="cosmos"]'); await pg.wait_for_timeout(900)
            mode = await pg.evaluate("[document.getElementById('go').dataset.mode, document.getElementById('go').textContent.trim(), document.getElementById('go').getAttribute('href')]")
            print('  stake button:', mode, '| APR shown:', await pg.evaluate("document.querySelector('#pApr .sr')?.textContent"))
            if wallet:
                await pg.click('#go'); await pg.wait_for_timeout(600)
                print('  after connect:', await pg.inner_text('#go'), '|', (await pg.inner_text('#walletRow')).replace('\n', ' '))
                await pg.click('#maxBtn'); await pg.wait_for_timeout(200)
                print('  max fills:', await pg.input_value('#amount'))
                await pg.fill('#amount', '12.5'); await pg.wait_for_timeout(200)
                print('  before click:', await pg.inner_text('#go'))
                await pg.click('#go'); await pg.wait_for_timeout(1500)
                print('  status:', await pg.inner_text('#stakeStatus'), '| link:', await pg.evaluate("document.querySelector('#stakeStatus a')?.href"))
                sd = await pg.evaluate("window.__signDoc"); print('  signed for', sd['id'], 'account#', sd['acc'])
                for u, body in posts: print('  POST', u.split('cosmos.directory')[1], (body or '')[:60])
                # decode broadcast tx and verify it contains our MsgDelegate
                txb = base64.b64decode(json.loads([b for u, b in posts if u.endswith('/txs')][0])['tx_bytes'])
                print('  broadcast has MsgDelegate:', b'/cosmos.staking.v1beta1.MsgDelegate' in txb, '| validator:', mock.COSMOS_VAL.encode() in txb, '| 12500000uatom:', b'12500000' in txb, '| memo:', b'Staked with The Cybernetics' in txb)
            print('  page errors:', errs)
            await ctx.close()
        await b.close()
asyncio.run(main())


async def speed():
    """Stake must appear before slow history finishes; a return visit must paint from the browser cache."""
    import time as _t
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(viewport={'width': 1280, 'height': 900}); pg = await ctx.new_page()
        async def slow(r):
            if '/cosmos/tx/v1beta1/txs' in r.request.url: await asyncio.sleep(4)
            await mock.handle(r)
        await pg.route('**/*', lambda r: slow(r) if not r.request.url.startswith('file:') else r.continue_())
        t0 = _t.time(); await pg.goto(URL)
        await pg.wait_for_function("document.querySelector('#perfValue .sr')?.textContent?.startsWith('$')", timeout=20000)
        first = _t.time() - t0
        await pg.wait_for_function("!document.body.classList.contains('loading')", timeout=60000)
        done = _t.time() - t0
        print(f'speed: total staked shown after {first:.1f}s, full history after {done:.1f}s', 'OK' if first < done - 3 else 'FAIL')
        await pg.unroute('**/*'); await pg.route('**/*', lambda r: r.abort() if not r.request.url.startswith('file:') else r.continue_())
        t0 = _t.time(); await pg.goto(URL + '#view=explorer'); await pg.wait_for_timeout(600)
        rows = await pg.locator('#rows .row').count()
        print(f'cache: offline return visit shows {rows} rows within 0.6s', 'OK' if rows else 'FAIL')
        await b.close()
asyncio.run(speed())


async def history():
    """Pages back until ~90 days are covered; a return visit only fetches what's new."""
    async with async_playwright() as p:
        b = await p.chromium.launch(); ctx = await b.new_context(); pg = await ctx.new_page()
        await pg.route('**/*', lambda r: mock.handle(r) if not r.request.url.startswith('file:') else r.continue_())
        mock.search_calls.clear()
        await pg.goto(URL); await pg.wait_for_function("!document.body.classList.contains('loading')", timeout=60000); await pg.wait_for_timeout(500)
        oldest = await pg.evaluate("(Date.now() - Date.parse(cybernetics.data.events.filter(e => e.chain === 'cosmos').at(-1).date)) / 864e5")
        days_with_flow = await pg.evaluate("cybernetics.data.daily.filter(d => d.flows.cosmos).length")
        pages = max(pg_ for n, k, pg_ in mock.search_calls if n == 'cosmoshub' and k == 'delegate.validator')
        print(f'history: oldest Cosmos event {oldest:.0f} days ago, {days_with_flow} of 90 days have flows, {pages} pages fetched',
              'OK' if oldest >= 89 and days_with_flow >= 85 else 'FAIL')
        mock.search_calls.clear()
        await pg.reload(); await pg.wait_for_function("!document.body.classList.contains('loading')", timeout=60000)
        again = [c for c in mock.search_calls if c[0] == 'cosmoshub' and c[1] == 'delegate.validator']
        days2 = await pg.evaluate("cybernetics.data.daily.filter(d => d.flows.cosmos).length")
        print(f'return visit: {len(again)} Cosmos delegation page(s) fetched, history still {days2} days', 'OK' if len(again) <= 2 and days2 >= 85 else 'FAIL')
        await b.close()
asyncio.run(history())
