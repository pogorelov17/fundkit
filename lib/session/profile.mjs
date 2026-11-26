// One session profile: a pinned ccxt-mcp process for one exchange account in one local role.
// Its credentials exist only in that process's environment; everything it prints is redacted
// before it leaves the session.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PASSED_ENV_NAMES } from '../constants.mjs';
import { onLines, parseJson } from '../ndjson.mjs';
import { ensurePrivateDir, profilesDir, writePrivateFile } from '../paths.mjs';
import { createRedactor } from '../redact.mjs';

const KILL_GRACE_MS = 2000;
const STDERR_LOG_LIMIT = 500;

/** The ccxt-mcp config for one account; it never holds credentials. */
function profileConfig(alias, account) {
  return {
    settings: { strictPermissions: true, hideDisabledTools: true },
    accounts: { [alias]: account },
  };
}

function minimalEnvironment() {
  const env = {};
  for (const name of PASSED_ENV_NAMES) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

export class ProfileProcess {
  #child;
  #redact;
  #exited;

  /**
   * @param {object} spec
   * @param {string} spec.alias
   * @param {string} spec.exchange
   * @param {string} spec.role
   * @param {object} spec.account       ccxt-mcp account entry (limits, dryRun), no credentials
   * @param {string} spec.serverPath    pinned ccxt-mcp entry point
   * @param {Map<string,string>} spec.credentials  environment name -> value; emptied here
   * @param {string[]} spec.alsoRedact  further values to redact (the service token)
   * @param {(message: object) => void} spec.onMessage  redacted JSON-RPC from the server
   * @param {(code: number|null, signal: string|null) => void} spec.onExit
   * @param {(line: string) => void} [spec.onStderr]
   */
  constructor(spec) {
    this.alias = spec.alias;
    this.exchange = spec.exchange;
    this.role = spec.role;
    this.dryRun = spec.account.dryRun;
    this.configDir = path.join(profilesDir(), spec.alias);
    this.configPath = path.join(this.configDir, 'config.json');

    ensurePrivateDir(profilesDir());
    ensurePrivateDir(this.configDir);
    writePrivateFile(
      this.configPath,
      `${JSON.stringify(profileConfig(spec.alias, spec.account), null, 2)}\n`,
    );

    const env = { ...minimalEnvironment(), CCXT_MCP_CONFIG: this.configPath };
    const secretValues = [...spec.credentials.values()];
    for (const [name, value] of spec.credentials) env[name] = value;
    spec.credentials.clear();

    this.#child = spawn(process.execPath, [spec.serverPath], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    for (const name of Object.keys(env)) env[name] = null;
    this.#redact = createRedactor([...secretValues, ...spec.alsoRedact]);
    secretValues.length = 0;

    this.#exited = new Promise((resolve) => this.#child.once('exit', resolve));
    this.#child.on('error', () => {
      // A failed spawn also emits 'exit'; that path reports it.
    });
    onLines(this.#child.stdout, (line) => {
      const message = parseJson(this.#redact(line));
      if (message !== undefined) spec.onMessage(message);
    });
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (text) => {
      spec.onStderr?.(this.#redact(text).trim().slice(0, STDERR_LOG_LIMIT));
    });
    this.#child.once('exit', (code, signal) => {
      this.#redact = null;
      this.removeConfig();
      spec.onExit(code, signal);
    });
  }

  get running() {
    return this.#child.exitCode === null && this.#child.signalCode === null;
  }

  /** Resolves once the process has exited. */
  get exited() {
    return this.#exited;
  }

  send(message) {
    if (this.#child.stdin.writable) this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  /** Ask the server to stop, and kill it if it has not within the grace period. */
  stop() {
    if (!this.running) return;
    this.#child.stdin.end();
    this.#child.kill('SIGTERM');
    setTimeout(() => this.kill(), KILL_GRACE_MS).unref();
  }

  kill() {
    if (this.running) this.#child.kill('SIGKILL');
  }

  removeConfig() {
    fs.rmSync(this.configDir, { recursive: true, force: true });
  }
}
