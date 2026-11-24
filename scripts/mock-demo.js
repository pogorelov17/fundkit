#!/usr/bin/env node
// End-to-end mock run: prints exactly what a real run prints (link, QR, FUNDKIT_STATE lines),
// with a simulated phone approving the transfer. No network, no keys, no money.
import { start } from '../src/app.js';
import { summarize } from '../src/state.js';
import { phone, setup } from '../test/harness.js';

const env = await setup();
env.deps.cfg.pollMs = 200;
const out = (l) => {
  env.out(l);
  console.log(l);
};
try {
  const [final, ph] = await Promise.all([
    start({ amount: process.argv[2] || '25' }, { ...env.deps }, out),
    phone(env).then((r) => {
      console.log(`\n[mock phone] connected ${r.from}, sent ${r.txHash}\n`);
      return r;
    }),
  ]);
  console.log('\n' + summarize(final));
  console.log(`\n[mock bybit] FUND=${env.bybitMock.balances.FUND} UNIFIED=${env.bybitMock.balances.UNIFIED} transfers=${env.bybitMock.transferCalls}`);
  if (final.phase !== 'done' || !ph.txHash) process.exitCode = 1;
} finally {
  await env.close();
}
