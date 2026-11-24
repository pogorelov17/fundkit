#!/usr/bin/env node
// End-to-end mock run: prints exactly what a real run prints (link, QR, FUNDKIT_STATE lines),
// with a simulated phone approving the transfer. No network, no keys, no money.
import { start } from '../src/app.js';
import { summarize } from '../src/state.js';
import { fromBaseUnits } from '../public/erc20.js';
import { phone, setup } from '../test/harness.js';

const env = await setup();
env.cfg.pollMs = 100;
const out = (l) => {
  env.out(l);
  console.log(l);
};
try {
  const [final, ph] = await Promise.all([
    start({ amount: process.argv[2] || '25', confirmFundCredit: true }, env.deps, out),
    phone(env).then((r) => {
      console.log(`\n[mock phone] connected ${r.from}, claimed the signing slot, sent ${r.txHash}\n`);
      return r;
    }),
  ]);
  console.log('\n' + summarize(final));
  const b = env.bybitMock.balances;
  console.log(`\n[mock bybit] FUND=${fromBaseUnits(b.FUND, 18)} UNIFIED=${fromBaseUnits(b.UNIFIED, 18)} transfers=${env.bybitMock.transferCalls}`);
  if (final.phase !== 'done' || !ph.txHash) process.exitCode = 1;
} finally {
  await env.close();
}
