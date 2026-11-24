#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { makeDeps, resume, start } from './app.js';
import { SafeError, safeError } from './errors.js';
import { preflight } from './flow.js';
import { formatState, parseState, summarize } from './state.js';

const USAGE = `fundkit — USDT (BSC) from OKX Wallet (mobile) to your own Bybit account

  fundkit preflight --amount <USDT> [--target UNIFIED|FUND] [--confirm-fund-credit]
  fundkit start     --amount <USDT> [--target UNIFIED|FUND] [--confirm-fund-credit]
  fundkit resume    --state '<FUNDKIT_STATE line>' [--tx <hash>] [--reattempt] [--retry-transfer]
                    [--confirm-fund-credit] [--recheck]
  fundkit status    --state '<FUNDKIT_STATE line>'

--confirm-fund-credit: you checked in the Bybit app that on-chain deposits are credited to the
Funding account (Bybit's default; no auto-transfer). Required for --target UNIFIED, because Bybit's
API does not report which account a deposit lands in.

Credentials and settings come from the environment (.env in cwd is loaded, or run via
'doppler run -- fundkit ...'): BYBIT_API_KEY, BYBIT_API_SECRET, BYBIT_BASE_URL (official hosts only),
BSC_RPC_URLS (>= 2 independent https), PUBLIC_BASE_URL (https), PORT, FUNDKIT_STATE_KEY (optional).`;

const EXIT = { done: 0, needs_attention: 2 };

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      amount: { type: 'string' },
      target: { type: 'string', default: 'UNIFIED' },
      state: { type: 'string' },
      reattempt: { type: 'boolean', default: false },
      'retry-transfer': { type: 'boolean', default: false },
      'confirm-fund-credit': { type: 'boolean', default: false },
      recheck: { type: 'boolean', default: false },
      tx: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const cmd = positionals[0];
  if (!cmd || values.help) return console.log(USAGE);
  if (existsSync('.env') && !process.env.FUNDKIT_NO_DOTENV) process.loadEnvFile('.env');
  if (!['UNIFIED', 'FUND'].includes(values.target)) throw new SafeError('--target must be UNIFIED or FUND');

  const deps = makeDeps();
  if (cmd === 'status') {
    const { state, authentic } = parseState(values.state, deps.stateKey);
    console.log(summarize(state));
    return console.log(authentic ? 'authentic: yes' : 'authentic: NO (edited, or other credentials) — recovery only');
  }
  if (cmd === 'preflight') {
    if (!values.amount) throw new SafeError('--amount is required');
    await deps.bybit.syncTime().catch(() => {});
    const pre = await preflight({
      bybit: deps.bybit,
      rpcs: deps.rpcs,
      amount: values.amount,
      target: values.target,
      fundCreditConfirmed: values['confirm-fund-credit'],
    });
    return console.log(JSON.stringify(pre, null, 2));
  }
  let final;
  let recovery = false;
  if (cmd === 'start') {
    if (!values.amount) throw new SafeError('--amount is required');
    final = await start({ amount: values.amount, target: values.target, confirmFundCredit: values['confirm-fund-credit'] }, deps);
  } else if (cmd === 'resume') {
    ({ state: final, recovery } = await resume(
      values.state,
      {
        reattempt: values.reattempt,
        txHash: values.tx,
        retryTransfer: values['retry-transfer'],
        confirmFundCredit: values['confirm-fund-credit'],
        recheck: values.recheck,
      },
      deps,
    ));
  } else {
    throw new SafeError(`unknown command ${cmd}\n\n${USAGE}`);
  }
  console.log('\n' + summarize(final));
  if (recovery) {
    console.log('(recovery only: no new state line; keep the previous one)');
    process.exitCode = 2;
    return;
  }
  console.log(formatState(final, deps.stateKey));
  process.exitCode = EXIT[final.phase] ?? 3;
}

main().catch((err) => {
  console.error(`error: ${err?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? err.message : safeError(err)}`);
  process.exitCode = 1;
});
