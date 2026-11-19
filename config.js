/*
  The Cybernetics dashboard: the only file you need to edit.

  Each network is described by its cosmos.directory / chain-registry name. Everything else
  (chain id, token, decimals, APR, unbonding time, price, fees, endpoints) is read live.

  valoper  Optional. Pin the validator address. If omitted, the validator is found by `identity`
           (Keybase) or `moniker`. A network where it can't be found is simply left out.
  keplr    Network slug on wallet.keplr.app, used when no browser wallet is installed.
  mintscan Network slug on mintscan.io, used for transaction links.
  wallet   false = open Keplr's dashboard instead of signing in-page (e.g. EVM-key chains).
  gasPrice Optional override, e.g. '0.03uatom'. Default: the chain registry's average gas price.
*/
window.CYBERNETICS = {
  identity: 'AB3DA9B8891D4F85',
  moniker: 'The_Cybernetics',
  memo: 'Staked with The Cybernetics',
  history: { days: 90, pages: 3 },           // up to pages × 100 transactions per event type
  chains: [
    { id: 'cosmos',    registry: 'cosmoshub', name: 'Cosmos Hub', icon: 'assets/chains/cosmos.webp',    keplr: 'cosmos-hub', mintscan: 'cosmos',
      valoper: 'cosmosvaloper18m9wncg0w74vusm4xu0mk6ha2lpdrqq7c9cjq3' },
    { id: 'osmosis',   registry: 'osmosis',   name: 'Osmosis',    icon: 'assets/chains/osmosis.webp',   keplr: 'osmosis',    mintscan: 'osmosis',
      valoper: 'osmovaloper10w06wvmdd4xn7hr76gzrv570f7q5uweem5jcd7' },
    { id: 'juno',      registry: 'juno',      name: 'Juno',       icon: 'assets/chains/juno.webp',      keplr: 'juno',       mintscan: 'juno',
      valoper: 'junovaloper1yfx5x9cs3nvncprlw0kuw2cgs9qq38uqnwfhd8' },
    { id: 'nolus',     registry: 'nolus',     name: 'Nolus',      icon: 'assets/chains/nolus.webp',     keplr: 'nolus',      mintscan: 'nolus',
      valoper: 'nolusvaloper106sz33gddhvve5r3hq4hvyzxakd7ntw9duc6c5' },
    { id: 'chihuahua', registry: 'chihuahua', name: 'Chihuahua',  icon: 'assets/chains/chihuahua.webp', keplr: 'chihuahua',  mintscan: 'chihuahua',
      valoper: 'chihuahuavaloper1cjnwtpj27hpd3ztyuf43um5jgew63p9nh4jjd3' },
    { id: 'dymension', registry: 'dymension', name: 'Dymension',  icon: 'assets/chains/dymension.webp', keplr: 'dymension',  mintscan: 'dymension',
      valoper: 'dymvaloper1x4dhky07zxuaew2ru7tgvtd68vjk3x56w5p5lh', wallet: false }
  ]
};
