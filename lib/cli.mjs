// Command dispatch for bin/fundkit.mjs.

import { Broker } from './broker/broker.mjs';
import { VERSION } from './constants.mjs';
import { requestSession, sessionStatus } from './control.mjs';
import { runInstallCommand } from './install.mjs';
import { runPassphraseCommand } from './passphrase-command.mjs';
import { runSessionCommand } from './session/command.mjs';
import { runDaemonCommand } from './session/headless.mjs';
import { runUnlockCommand } from './unlock.mjs';

const USAGE = `usage:
  fundkit install [--app-dir DIR] [--no-claude] [--no-codex] [--no-skills]
  fundkit session [--writes --max-transfer USD] [--max-daily USD] [--ttl 8h] [--keep]
                  [--passphrase okx,bitget,kucoin] [--allow-provisioning gate,whitebit] [-- host-command]
  fundkit passphrase okx|bitget|kucoin
  fundkit unlock --token-file PATH [--ttl 8h]          (host-delivered secret file, single use)
  fundkit unlock --passphrase okx|bitget|kucoin --secret-file PATH
  fundkit status | stop | mcp
`;

async function runStatusCommand() {
  const session = await sessionStatus();
  if (!session) {
    process.stdout.write('no fundkit session\n');
    return 1;
  }
  const { state, expires, doppler, writes, maxTransferValue, profiles } = session;
  process.stdout.write(
    `${JSON.stringify({ state, expires, doppler, writes, maxTransferValue, profiles }, null, 2)}\n`,
  );
  return 0;
}

async function runStopCommand() {
  const reply = await requestSession({ t: 'stop' });
  process.stdout.write(reply ? 'fundkit session stopping\n' : 'no fundkit session\n');
  return reply ? 0 : 1;
}

/**
 * Run one command. Resolves with the process exit code, or null for `mcp`, which keeps
 * serving until the host closes its stdin.
 */
export async function main(argv) {
  const [command, ...rest] = argv;
  switch (command) {
    case 'mcp':
      new Broker().start();
      return null;
    case 'session':
      return runSessionCommand(rest);
    case 'install':
      return runInstallCommand(rest);
    case 'passphrase':
      return runPassphraseCommand(rest);
    case 'unlock':
      return runUnlockCommand(rest);
    case 'daemon':
      return runDaemonCommand(rest);
    case 'status':
      return runStatusCommand();
    case 'stop':
      return runStopCommand();
    case '--version':
      process.stdout.write(`${VERSION}\n`);
      return 0;
    default:
      process.stdout.write(USAGE);
      return command ? 2 : 0;
  }
}
