// wallet.js builds transactions by hand. This proves the bytes match cosmjs-types (the canonical encoding).
import fs from 'fs';
import { MsgDelegate } from 'cosmjs-types/cosmos/staking/v1beta1/tx.js';
import { TxBody, AuthInfo, TxRaw, SignerInfo, Fee, ModeInfo } from 'cosmjs-types/cosmos/tx/v1beta1/tx.js';
import { PubKey } from 'cosmjs-types/cosmos/crypto/secp256k1/keys.js';
import { SignMode } from 'cosmjs-types/cosmos/tx/signing/v1beta1/signing.js';
globalThis.window = { CYBERNETICS: { memo: 'Staked with The Cybernetics' } };
globalThis.btoa = s => Buffer.from(s, 'binary').toString('base64'); globalThis.atob = s => Buffer.from(s, 'base64').toString('binary');
eval(fs.readFileSync(new URL('../wallet.js', import.meta.url), 'utf8'));
const E = window.CyberneticsWallet._encode;
const hex = b => Buffer.from(b).toString('hex');
const amount = { denom: 'uatom', amount: '12500000' };
const del = 'cosmos1abcdefghijklmnopqrstuvwxyz0123456789', val = 'cosmosvaloper18m9wncg0w74vusm4xu0mk6ha2lpdrqq7c9cjq3';
const pub = Uint8Array.from({ length: 33 }, (_, i) => (i * 7 + 2) & 255);
let ok = true; const check = (name, a, b) => { const same = hex(a) === hex(b); ok &&= same; console.log(same ? 'OK  ' : 'FAIL', name); if (!same) console.log(' mine', hex(a), '\n ref ', hex(b)); };

const refMsg = { typeUrl: '/cosmos.staking.v1beta1.MsgDelegate', value: MsgDelegate.encode(MsgDelegate.fromPartial({ delegatorAddress: del, validatorAddress: val, amount })).finish() };
const refBody = TxBody.encode(TxBody.fromPartial({ messages: [refMsg], memo: 'Staked with The Cybernetics' })).finish();
check('TxBody(MsgDelegate)', E.txBody([E.msgDelegate(del, val, amount)], 'Staked with The Cybernetics'), refBody);

for (const [seq, mode] of [[0, 1], [57, 1], [123456789, 127]]) {
  const fee = E.feeFor({ gasPrice: '0.025uatom', denom: 'uatom' }, 241337);
  const refAuth = AuthInfo.encode(AuthInfo.fromPartial({
    signerInfos: [SignerInfo.fromPartial({ publicKey: { typeUrl: '/cosmos.crypto.secp256k1.PubKey', value: PubKey.encode({ key: pub }).finish() },
      modeInfo: { single: { mode: mode === 1 ? SignMode.SIGN_MODE_DIRECT : SignMode.SIGN_MODE_LEGACY_AMINO_JSON } }, sequence: BigInt(seq) })],
    fee: Fee.fromPartial({ amount: fee.amount, gasLimit: BigInt(fee.gas) })
  })).finish();
  check(`AuthInfo(seq=${seq}, mode=${mode})`, E.authInfo(pub, seq, mode, fee), refAuth);
}
const sig = Uint8Array.from({ length: 64 }, (_, i) => i);
const refRaw = TxRaw.encode(TxRaw.fromPartial({ bodyBytes: refBody, authInfoBytes: Uint8Array.of(1, 2, 3), signatures: [sig] })).finish();
check('TxRaw', E.txRaw(refBody, Uint8Array.of(1, 2, 3), sig), refRaw);

const f = E.feeFor({ gasPrice: '0.025uatom', denom: 'uatom' }, 241337);
console.log('fee 241337 gas @0.025 =', JSON.stringify(f), f.amount[0].amount === '6034' ? 'OK' : 'FAIL');
const f2 = E.feeFor({ gasPrice: '20000000000adym', denom: 'adym' }, 200000);
console.log('fee big =', f2.amount[0].amount, f2.amount[0].amount === '4000000000000000' ? 'OK' : 'FAIL');
for (const [t, d, want] of [['12.5', 6, '12500000'], ['1,000', 6, '1000000000'], ['0.000001', 6, '1'], ['0.1234567', 6, '123456'], ['3', 18, '3000000000000000000']])
  console.log('toBaseUnits', t, d, E.toBaseUnits(t, d), E.toBaseUnits(t, d) === want ? 'OK' : 'FAIL');
for (const bad of ['', '.', 'abc', '0', '0.0000001']) { try { E.toBaseUnits(bad, 6); console.log('FAIL accepted', bad); } catch (e) { console.log('OK  rejects', JSON.stringify(bad), '→', e.message); } }
console.log(ok ? '\nALL ENCODINGS MATCH' : '\nMISMATCH');
process.exit(ok ? 0 : 1);
