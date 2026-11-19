/*
  Stake: in-page delegation through a browser wallet (Keplr or Leap, which share the Keplr API).

  No dependencies. Builds the delegation transaction itself (≈60 lines of protobuf), asks the
  wallet to sign it, then broadcasts it through the chain's public REST endpoint.
    - Direct signing (SIGN_MODE_DIRECT) for normal wallets, Amino JSON for Ledger.
    - Gas is simulated on-chain (×1.4), with a safe fixed fallback.
    - The wallet may let the user change the fee; whatever it signs is what gets broadcast.
*/
(() => {
  'use strict';
  const REST = 'https://rest.cosmos.directory/';
  const provider = () => window.keplr || window.leap || null;

  /* ── Minimal protobuf writer ── */
  const utf8 = s => new TextEncoder().encode(s);
  function varint(n) {
    const out = [];
    n = BigInt(n);
    do { let b = Number(n & 0x7fn); n >>= 7n; if (n) b |= 0x80; out.push(b); } while (n);
    return out;
  }
  const concat = parts => { const len = parts.reduce((s, p) => s + p.length, 0), o = new Uint8Array(len); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
  const bytesField = (no, bytes) => bytes.length ? concat([Uint8Array.from(varint((no << 3) | 2)), Uint8Array.from(varint(bytes.length)), bytes]) : new Uint8Array();
  const strField = (no, s) => bytesField(no, utf8(s || ''));
  const intField = (no, n) => BigInt(n) ? Uint8Array.from([...varint(no << 3), ...varint(n)]) : new Uint8Array();
  const msg = (...fields) => concat(fields);

  const coin = c => msg(strField(1, c.denom), strField(2, c.amount));
  const any = (typeUrl, value) => msg(strField(1, typeUrl), bytesField(2, value));
  const msgDelegate = (delegator, validator, amount) =>
    any('/cosmos.staking.v1beta1.MsgDelegate', msg(strField(1, delegator), strField(2, validator), bytesField(3, coin(amount))));
  const txBody = (messages, memo) => msg(...messages.map(m => bytesField(1, m)), strField(2, memo));
  const pubKeyAny = key => any('/cosmos.crypto.secp256k1.PubKey', bytesField(1, key));
  const authInfo = (pubKey, sequence, mode, fee) => msg(
    bytesField(1, msg(bytesField(1, pubKeyAny(pubKey)), bytesField(2, bytesField(1, intField(1, mode))), intField(3, sequence))),
    bytesField(2, msg(...fee.amount.map(c => bytesField(1, coin(c))), intField(2, fee.gas))));
  const txRaw = (body, auth, signature) => msg(bytesField(1, body), bytesField(2, auth), bytesField(3, signature));

  const b64 = bytes => btoa(String.fromCharCode(...bytes));
  const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const DIRECT = 1, AMINO = 127;

  /* ── Helpers ── */
  // "12.5" → "12500000" for 6 decimals, exact (no floating point).
  function toBaseUnits(text, decimals) {
    const clean = String(text).replace(/[,\s]/g, '');
    if (!/^\d*\.?\d*$/.test(clean) || clean === '' || clean === '.') throw new Error('Enter an amount.');
    const [whole, frac = ''] = clean.split('.');
    const units = ((whole || '0') + frac.padEnd(decimals, '0').slice(0, decimals)).replace(/^0+/, '');
    if (!units) throw new Error('Enter an amount.');
    return units;
  }
  async function rest(chain, path, body) {
    const res = await fetch(REST + chain.registry + path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.message || `${res.status} ${path}`);
    return json;
  }
  // account_number / sequence, whatever the account type (base, vesting, …).
  function findAccount(o) {
    if (!o || typeof o !== 'object') return null;
    if ('account_number' in o) return { accountNumber: String(o.account_number), sequence: String(o.sequence || 0) };
    for (const v of Object.values(o)) { const r = findAccount(v); if (r) return r; }
    return null;
  }
  function feeFor(chain, gas) {
    const m = /^([\d.]+)(.+)$/.exec(chain.gasPrice) || [, '0.025', chain.denom];
    const [, price, denom] = m, [w, f = ''] = price.split('.');
    const scaled = BigInt(w + f) * BigInt(gas), div = 10n ** BigInt(f.length);
    return { amount: [{ denom, amount: String((scaled + div - 1n) / div) }], gas: String(gas) };
  }
  function friendly(err) {
    const m = String(err?.message || err);
    if (/reject|denied|cancel/i.test(m)) return 'Cancelled in wallet.';
    if (/insufficient/i.test(m)) return 'Not enough balance to cover the amount and fees.';
    if (/no chain info|not supported|unknown chain|There is no chain/i.test(m)) return 'Add this network to your wallet first.';
    return m.length > 160 ? m.slice(0, 160) + '…' : m;
  }

  async function delegate(chain, amountText) {
    const wallet = provider();
    if (!wallet) throw new Error('No Cosmos wallet found. Install Keplr or Leap.');
    try {
      const amount = { denom: chain.denom, amount: toBaseUnits(amountText, chain.decimals) };
      await wallet.enable(chain.chainId);
      const key = await wallet.getKey(chain.chainId);
      const delegator = key.bech32Address, pubKey = key.pubKey;
      const memo = window.CYBERNETICS?.memo || '';

      const { balance } = await rest(chain, `/cosmos/bank/v1beta1/balances/${delegator}/by_denom?denom=${encodeURIComponent(chain.denom)}`).catch(() => ({}));
      if (balance && BigInt(balance.amount) < BigInt(amount.amount)) throw new Error(`Not enough ${chain.token} in this wallet.`);
      const acct = findAccount(await rest(chain, `/cosmos/auth/v1beta1/accounts/${delegator}`));
      if (!acct) throw new Error('This wallet has no account on this network yet.');

      const body = txBody([msgDelegate(delegator, chain.valoper, amount)], memo);
      let gas = 300000;
      try {
        const sim = await rest(chain, '/cosmos/tx/v1beta1/simulate', {
          tx_bytes: b64(txRaw(body, authInfo(pubKey, acct.sequence, DIRECT, feeFor(chain, gas)), new Uint8Array(64)))
        });
        gas = Math.ceil(Number(sim.gas_info.gas_used) * 1.4);
      } catch { /* keep the fallback */ }
      const fee = feeFor(chain, gas);

      let tx;
      if (key.isNanoLedger) {
        const doc = {
          chain_id: chain.chainId, account_number: acct.accountNumber, sequence: acct.sequence, fee, memo,
          msgs: [{ type: 'cosmos-sdk/MsgDelegate', value: { delegator_address: delegator, validator_address: chain.valoper, amount } }]
        };
        const { signed, signature } = await wallet.signAmino(chain.chainId, delegator, doc);
        const v = signed.msgs[0].value;
        tx = txRaw(txBody([msgDelegate(v.delegator_address, v.validator_address, v.amount)], signed.memo),
          authInfo(pubKey, signed.sequence, AMINO, signed.fee), unb64(signature.signature));
      } else {
        const { signed, signature } = await wallet.signDirect(chain.chainId, delegator, {
          bodyBytes: body, authInfoBytes: authInfo(pubKey, acct.sequence, DIRECT, fee),
          chainId: chain.chainId, accountNumber: BigInt(acct.accountNumber)
        });
        tx = txRaw(signed.bodyBytes, signed.authInfoBytes, unb64(signature.signature));
      }

      const { tx_response: r } = await rest(chain, '/cosmos/tx/v1beta1/txs', { tx_bytes: b64(tx), mode: 'BROADCAST_MODE_SYNC' });
      if (r.code) throw new Error(r.raw_log || 'Transaction rejected.');
      return { hash: r.txhash, address: delegator };
    } catch (err) {
      throw new Error(friendly(err));
    }
  }

  window.CyberneticsWallet = {
    available: () => !!provider(),
    delegate,
    // exposed for tests / tooling
    _encode: { msgDelegate, txBody, authInfo, txRaw, feeFor, toBaseUnits }
  };
})();
