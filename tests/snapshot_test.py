"""The snapshot job end-to-end: node scripts/snapshot.mjs against the mock chain APIs, then the site served
over HTTP, checking that visitors read only data/snapshot.json and never call the chain APIs themselves."""
import asyncio, json, os, pathlib, subprocess, sys, threading, http.server, functools
ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'tests')); import mock
from playwright.async_api import async_playwright

HOSTS = {'coingecko': 'https://api.coingecko.com', 'chains': 'https://chains.cosmos.directory', 'validators': 'https://validators.cosmos.directory', 'rest': 'https://rest.cosmos.directory', 'rpc': 'https://rpc.cosmos.directory'}
class Fake:
    """Adapts mock.handle (written for Playwright routes) to a plain HTTP server."""
    def __init__(self, url, method, body): self.request = type('R', (), {'url': url, 'method': method, 'post_data': body})(); self.out = (404, b'{}')
    def fulfill(self, status=200, body='', **_): self.out = (status, body.encode())
    def continue_(self): pass
class Mock(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def serve(self, method):
        head, _, rest = self.path.lstrip('/').partition('/')
        url = HOSTS[head] + ('/chains/' if head == 'validators' else '/') + (rest.split('chains/', 1)[1] if head == 'validators' else rest)
        body = self.rfile.read(int(self.headers.get('content-length', 0))).decode() if method == 'POST' else None
        f = Fake(url, method, body); mock.handle(f)
        self.send_response(f.out[0]); self.send_header('content-type', 'application/json'); self.end_headers(); self.wfile.write(f.out[1])
    def do_GET(self): self.serve('GET')
    def do_POST(self): self.serve('POST')
def start(handler, port):
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), handler); threading.Thread(target=srv.serve_forever, daemon=True).start(); return srv

def snapshot():
    r = subprocess.run(['node', 'scripts/snapshot.mjs'], cwd=ROOT, capture_output=True, text=True, env={**os.environ, 'API_BASE': 'http://127.0.0.1:8765'})
    print('  ' + (r.stdout + r.stderr).strip().replace('\n', '\n  ')); assert r.returncode == 0

async def main():
    (ROOT / 'data' / 'snapshot.json').unlink(missing_ok=True)
    start(Mock, 8765)
    class Static(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **k): super().__init__(*a, directory=str(ROOT), **k)
        def log_message(self, *a): pass
    start(Static, 8766)
    print('run 1 (empty):'); mock.search_calls.clear(); snapshot(); first = max(c[2] for c in mock.search_calls)
    snap = json.loads((ROOT / 'data' / 'snapshot.json').read_text())
    print(f"  networks {list(snap['chains'])}, uptime {[round(u['uptime'] * 100, 2) for u in snap['uptime'].values()]}, history {len(snap['history'])} days")
    import time; time.sleep(2)
    print('run 2 (incremental):'); mock.search_calls.clear(); snapshot(); second = max(c[2] for c in mock.search_calls)
    snap = json.loads((ROOT / 'data' / 'snapshot.json').read_text())
    aprs = {k: round(c['apr'], 2) for k, c in snap['chains'].items()}
    priced = sorted(d for d, v in snap['history'].items() if all('price' in x for x in v.values()))
    print(f"measured APR {aprs} (mock pays 15%)", 'OK' if all(abs(a - 15) < 0.3 for a in aprs.values()) and all(c.get('aprMeasured') for c in snap['chains'].values()) else 'FAIL')
    print(f"CoinGecko: price now cosmos ${snap['chains']['cosmos']['price']}, daily prices for {len(priced)} days", 'OK' if snap['chains']['cosmos']['price'] == 4.4 and len(priced) >= 90 else 'FAIL')
    print(f'deepest page fetched: run 1 = {first}, run 2 = {second} (only what is new)', 'OK' if first > 5 and second == 1 else 'FAIL')

    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={'width': 1280, 'height': 900})
        chain_calls = []
        pg.on('request', lambda r: chain_calls.append(r.url) if 'cosmos.directory' in r.url else None)
        await pg.route('**/*', lambda r: mock.handle(r) if 'cosmos.directory' in r.request.url else r.continue_())
        await pg.goto('http://127.0.0.1:8766/'); await pg.wait_for_function("!document.body.classList.contains('loading')", timeout=20000)
        for v in ['explorer', 'inflows', 'charts']: await pg.click(f'button[data-value="{v}"]'); await pg.wait_for_timeout(300)
        staked = await pg.evaluate("document.querySelector('#perfValue .sr')?.textContent")
        print(f'visitor: total staked {staked}, {len(await pg.evaluate("cybernetics.data.events"))} events, chain API calls: {len(chain_calls)}', 'OK' if not chain_calls and staked else 'FAIL')
        await pg.click('button[data-value="uptime"]'); await pg.wait_for_timeout(2000)
        kinds = sorted({u.split('/')[2] for u in chain_calls})
        pct = await pg.evaluate("[...document.querySelectorAll('.up-pct')].map(e => e.textContent)")
        print(f'uptime tab: {pct}, calls only to {kinds}', 'OK' if kinds == ['rpc.cosmos.directory'] else 'FAIL')
        await b.close()
    (ROOT / 'data' / 'snapshot.json').unlink(missing_ok=True)
asyncio.run(main())
