#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { makeDeps, resume, start } from './app.js';
import { preflight } from './flow.js';
import { parseState, summarize, formatState } from './state.js';

const USAGE = `fundkit — USDT (BSC) from OKX Wallet (mobile) to your own Bybit account

  fundkit preflight --amount <USDT> [--target UNIFIED|FUND]
  fundkit start     --amount <USDT> [--target UNIFIED|FUND]
  fundkit resume    --state '<FUNDKIT_STATE line>' [--reattempt] [--tx <hash>]
  fundkit status    --state '<FUNDKIT_STATE line>'

Credentials and settings come from the environment (.env in cwd is loaded, or run via
'doppler run -- fundkit ...'): BYBIT_API_KEY, BYBIT_API_SECRET, BYBIT_BASE_URL,
BSC_RPC_URLS, PUBLIC_BASE_URL (https), PORT. See .env.example.`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      amount: { type: 'string' },
      target: { type: 'string', default: 'UNIFIED' },
      state: { type: 'string' },
      reattempt: { type: 'boolean', default: false },
      tx: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const cmd = positionals[0];
  if (!cmd || values.help) return console.log(USAGE);
  if (existsSync('.env') && !process.env.FUNDKIT_NO_DOTENV) process.loadEnvFile('.env');
  if (!['UNIFIED', 'FUND'].includes(values.target)) throw new Error('--target must be UNIFIED or FUND');

  if (cmd === 'status') return console.log(summarize(parseState(values.state)));
  const deps = makeDeps();
  if (cmd === 'preflight') {
    if (!values.amount) throw new Error('--amount is required');
    await deps.bybit.syncTime().catch(() => {});
    const pre = await preflight({ bybit: deps.bybit, rpcs: deps.rpcs, amount: values.amount, target: values.target });
    return console.log(JSON.stringify(pre, null, 2));
  }
  let final;
  if (cmd === 'start') {
    if (!values.amount) throw new Error('--amount is required');
    final = await start({ amount: values.amount, target: values.target }, deps);
  } else if (cmd === 'resume') {
    final = await resume(parseState(values.state), { reattempt: values.reattempt, txHash: values.tx }, deps);
  } else {
    throw new Error(`unknown command ${cmd}\n\n${USAGE}`);
  }
  console.log('\n' + summarize(final));
  console.log(formatState(final));
  process.exitCode = final.phase === 'done' ? 0 : final.phase === 'needs_attention' ? 2 : 3;
}

main().catch((err) => {
  console.error(`error: ${err.message}`);
  process.exitCode = 1;
});
