// The session daemon: holds the Doppler token and the typed API passphrases for one session,
// starts session profiles for host-side brokers, enforces each profile's local role on every
// call, and stops everything when the session ends.
//
// Control protocol (newline-delimited JSON over a 0600 Unix socket; requests carry an `id`):
//   ping | status | stop | hello {host} | connect {exchange, role} | disconnect {alias}
//   passphrase {exchange, value}   from `fundkit passphrase` only, never from a host broker
//   rpc {alias, msg, call?}        JSON-RPC to a profile the caller owns; `call` is
//                                  {channel: 'read'|'write', uid?} for tools/call
// The daemon pushes {t:'rpc', alias, msg}, {t:'exit', alias, ...} and {t:'end', reason}.

import fs from 'node:fs';
import net from 'node:net';
import {
  aliasFor,
  dopplerNames,
  exchangeLabel,
  isRole,
  needsPassphrase,
  normalizeExchange,
  passphraseEnvName,
  ROLE_NAMES,
} from '../exchanges.mjs';
import { onJsonLines, writeJsonLine } from '../ndjson.mjs';
import { ccxtServerPath, ensurePrivateDir, profilesDir, runDir, socketPath } from '../paths.mjs';
import { authorizeCall, describeRole, extractUid, venueScopeNotes } from '../policy.mjs';
import { requestSession } from '../control.mjs';
import { delay } from '../util.mjs';
import { PassphraseStore } from './passphrases.mjs';
import { ProfileProcess } from './profile.mjs';

const END_GRACE_MS = 3000;
const DEPOSIT_ONLY_TRANSFER_CAP = 10;
const HOST_NAME_LIMIT = 60;
/** JSON-RPC methods a broker may send to a profile besides tools/call and responses. */
const FORWARDED_METHODS = new Set([
  'initialize',
  'notifications/initialized',
  'tools/list',
  'ping',
  'notifications/cancelled',
]);

/** One connection on the control socket: a host-side broker or a one-shot CLI request. */
class ControlClient {
  constructor(socket) {
    this.socket = socket;
    this.name = 'host';
    this.attached = false;
    this.aliases = new Set();
  }

  send(message) {
    writeJsonLine(this.socket, message);
  }
}

/** A running profile, its owner and what its key check showed. */
class ProfileEntry {
  constructor(profile, owner) {
    this.profile = profile;
    this.owner = owner;
    this.uid = null;
    /** JSON-RPC request id -> UID field, for key checks in flight */
    this.uidCaptures = new Map();
  }
}

/** A refused tools/call, answered as an MCP tool error so the host shows the reason. */
function toolError(id, { code, message }) {
  const text = JSON.stringify({ error: code, message }, null, 2);
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
}

export class SessionDaemon {
  #doppler;
  #passphrases;
  #options;
  #log;
  #server = null;
  #ttlTimer = null;
  #clients = new Set();
  /** @type {Map<string, ProfileEntry>} */
  #profiles = new Map();
  /** exchange -> the UID its key checks showed; one Doppler config is one account per exchange */
  #accountUids = new Map();
  #accountConflicts = new Set();
  #ending = false;

  /**
   * @param {import('../doppler.mjs').DopplerClient} doppler
   * @param {object} options  ttlMs, writes, maxTransfer, maxDaily, keep, wrapped, debug,
   *                          provisioning (Set of exchanges), passphrases (Map typed up front),
   *                          identity, log(line), onEnd(reason)
   */
  constructor(doppler, options) {
    this.#doppler = doppler;
    this.#options = options;
    this.#log = options.log;
    this.#passphrases = new PassphraseStore({
      canPrompt: !options.wrapped,
      log: options.log,
      initial: options.passphrases,
    });
    this.started = Date.now();
    this.expires = this.started + options.ttlMs;
  }

  info() {
    return {
      state: 'active',
      started: new Date(this.started).toISOString(),
      expires: new Date(this.expires).toISOString(),
      doppler: this.#options.identity,
      writes: this.#options.writes,
      maxTransferValue: this.#options.maxTransfer,
      maxDailyValue: this.#options.maxDaily ?? null,
      provisioning: [...this.#options.provisioning],
      profiles: [...this.#profiles.values()].map(({ profile, uid }) => ({
        alias: profile.alias,
        exchange: profile.exchange,
        role: profile.role,
        dryRun: profile.dryRun,
        uid,
      })),
    };
  }

  /** Open the control socket; fails if another session already answers on it. */
  async listen() {
    ensurePrivateDir(runDir());
    const path = socketPath();
    if (fs.existsSync(path)) {
      if (await requestSession({ t: 'ping' }, { path })) {
        throw new Error('a fundkit session is already running (fundkit stop ends it)');
      }
      fs.unlinkSync(path);
    }
    this.#server = net.createServer((socket) => this.#accept(socket));
    const previousUmask = process.umask(0o077);
    try {
      await new Promise((resolve, reject) => {
        this.#server.once('error', reject);
        this.#server.listen(path, resolve);
      });
    } finally {
      process.umask(previousUmask);
    }
    fs.chmodSync(path, 0o600);
    this.#ttlTimer = setTimeout(() => this.end('session time limit reached'), this.#options.ttlMs);
    this.#ttlTimer.unref();
  }

  #accept(socket) {
    const client = new ControlClient(socket);
    this.#clients.add(client);
    onJsonLines(socket, (message) => {
      this.#handle(client, message).catch((error) =>
        client.send({
          t: 'error',
          id: message.id,
          code: 'INTERNAL',
          message: String(error?.message ?? error),
        }),
      );
    });
    const onGone = () => this.#detach(client);
    socket.on('close', onGone);
    socket.on('error', onGone);
  }

  #detach(client) {
    if (!this.#clients.delete(client)) return;
    for (const alias of client.aliases) this.#stopProfile(alias, 'host session closed');
    if (!client.attached) return;
    this.#log(`host session ${client.name} detached`);
    const anotherHostAttached = [...this.#clients].some((other) => other.attached);
    if (!this.#options.keep && !this.#options.wrapped && !anotherHostAttached) {
      this.end('the host session ended');
    }
  }

  async #handle(client, message) {
    const { id } = message;
    switch (message.t) {
      case 'ping':
        return client.send({ t: 'pong', id });
      case 'status':
        return client.send({ t: 'status', id, session: this.info() });
      case 'stop':
        client.send({ t: 'stopping', id });
        return this.end('fundkit stop');
      case 'hello':
        client.attached = true;
        client.name = String(message.host ?? 'host')
          .slice(0, HOST_NAME_LIMIT)
          .replace(/[^\w .\-/()]/g, '');
        this.#log(`host session ${client.name} attached`);
        return client.send({ t: 'hello', id, session: this.info() });
      case 'connect':
        return this.#connect(client, message);
      case 'disconnect':
        if (client.aliases.has(message.alias)) this.#stopProfile(message.alias, 'disconnected by the host');
        return client.send({ t: 'disconnected', id, alias: message.alias });
      case 'passphrase':
        return this.#storePassphrase(client, message);
      case 'rpc':
        return this.#forward(client, message);
      default:
        return client.send({ t: 'error', id, code: 'BAD_REQUEST', message: 'unknown message' });
    }
  }

  // ------------------------------------------------------------------ passphrases

  #storePassphrase(client, { id, exchange: name, value }) {
    const fail = (code, text) => client.send({ t: 'error', id, code, message: text });
    // A host broker never carries a passphrase; only the operator's `fundkit passphrase` does.
    if (client.attached) return fail('BAD_REQUEST', 'passphrases are accepted only from fundkit passphrase');
    const exchange = normalizeExchange(name);
    if (!exchange || !needsPassphrase(exchange)) {
      return fail('NO_PASSPHRASE', 'this exchange takes no API passphrase');
    }
    if (typeof value !== 'string' || value.length === 0) {
      return fail('EMPTY', 'empty passphrase, nothing kept');
    }
    const { replaced } = this.#passphrases.set(exchange, value);
    const running = [...this.#profiles.values()]
      .filter(({ profile }) => profile.exchange === exchange)
      .map(({ profile }) => profile.alias);
    this.#log(
      `${exchangeLabel(exchange)} passphrase ${replaced ? 'replaced' : 'kept'} from another terminal`,
    );
    return client.send({ t: 'passphrase-stored', id, exchange, replaced, running });
  }

  /** null when the passphrase is there (or not needed); otherwise the error to return. */
  #passphraseProblem(exchange, alias) {
    if (!needsPassphrase(exchange)) return null;
    const label = exchangeLabel(exchange);
    const status = this.#passphrases.takeStatus(exchange);
    if (status === 'present') return null;
    const elsewhere = `in another terminal on this machine run: fundkit passphrase ${exchange}`;
    if (status === 'cancelled' || status === 'timed-out') {
      return {
        code: status === 'cancelled' ? 'PASSPHRASE_CANCELLED' : 'PASSPHRASE_TIMEOUT',
        message: `the operator did not enter the ${label} API passphrase (${status}); nothing was started`,
        userStep:
          `Only if the user still wants ${label}: call fundkit_connect again (the session terminal asks ` +
          `once more), or ${elsewhere}.`,
      };
    }
    const prompting = status === 'prompting' || this.#passphrases.prompt(exchange, alias);
    return {
      code: 'PASSPHRASE_NEEDED',
      message: `${label} needs its API passphrase, which is not stored in Doppler; nothing was started`,
      userStep: prompting
        ? `Switch to the terminal where fundkit session runs: it now asks for the ${label} API passphrase ` +
          '(hidden input). Type it there, never in this chat, then say you are done.'
        : `The session terminal runs the host, so it cannot ask now: ${elsewhere}, type the ${label} API ` +
          'passphrase there (hidden), then say you are done. Next time: fundkit session --passphrase ' +
          `${exchange} -- <host>.`,
    };
  }

  // ------------------------------------------------------------------ connect

  async #connect(client, message) {
    const { id } = message;
    const fail = (code, text, extra = {}) => client.send({ t: 'error', id, code, message: text, ...extra });

    const exchange = normalizeExchange(message.exchange);
    if (!exchange) {
      return fail('UNKNOWN_EXCHANGE', `unsupported exchange: ${String(message.exchange).slice(0, 40)}`);
    }
    const { role } = message;
    if (!isRole(role)) return fail('UNKNOWN_ROLE', `role must be one of ${ROLE_NAMES.join(', ')}`);

    const alias = aliasFor(exchange, role);
    const existing = this.#profiles.get(alias);
    if (existing) {
      if (existing.owner !== client) {
        return fail('ALIAS_IN_USE', `${alias} is connected to another host session`);
      }
      const { dryRun } = existing.profile;
      return client.send({ t: 'connected', id, alias, exchange, role, dryRun, already: true });
    }

    const serverPath = ccxtServerPath();
    if (!serverPath || !fs.existsSync(serverPath)) {
      return fail('SERVER_NOT_INSTALLED', 'pinned ccxt-mcp not found; run fundkit install');
    }

    const names = dopplerNames(exchange);
    let fetched;
    try {
      fetched = await this.#doppler.fetchSecrets(names);
    } catch (error) {
      return this.#fetchFailed(fail, alias, error);
    }
    if (this.#ending) {
      fetched.clear();
      return fail('SESSION_ENDED', 'the session is ending');
    }
    const passphraseProblem = this.#passphraseProblem(exchange, alias);
    if (passphraseProblem) {
      fetched.clear();
      const { code, message: text, ...extra } = passphraseProblem;
      return fail(code, text, extra);
    }

    const credentials = new Map(fetched);
    fetched.clear();
    const passphraseEnv = passphraseEnvName(exchange);
    if (passphraseEnv) credentials.set(passphraseEnv, this.#passphrases.get(exchange));

    const { profile } = this.#startProfile({ client, alias, exchange, role, credentials, serverPath });
    this.#log(
      `${alias} connected for ${client.name} (${exchange}, ${role}, dryRun ${profile.dryRun}); ` +
        `fetched ${names.join(', ')}${passphraseEnv ? '; passphrase from the private terminal' : ''}`,
    );
    client.send({
      t: 'connected',
      id,
      alias,
      exchange,
      role,
      dryRun: profile.dryRun,
      configPath: profile.configPath,
      fetched: names,
      ...this.#connectFacts(exchange, role, alias, Boolean(passphraseEnv)),
    });
  }

  /** What the agent must tell the user about a new profile: account, key and role scope. */
  #connectFacts(exchange, role, alias, withPassphrase) {
    const sameAccountAs = [...this.#profiles.values()]
      .map(({ profile }) => profile)
      .filter((other) => other.exchange === exchange && other.alias !== alias)
      .map((other) => other.alias);
    const names = dopplerNames(exchange);
    return {
      account: {
        credentials: withPassphrase ? [...names, 'API passphrase (private terminal, memory only)'] : names,
        sameAccountAs,
        note:
          `One Doppler config holds one ${exchangeLabel(exchange)} account: every ${exchange} role in this ` +
          'session uses this same key, so all of them must show the same UID.',
      },
      keyCapability:
        'Not verified by fundkit. The key may hold withdrawal or transfer rights on the exchange; report ' +
        'what the venue key check shows, and call the key read-only only if the check shows that.',
      roleScope: describeRole(role),
      venueScope: venueScopeNotes(exchange),
    };
  }

  #fetchFailed(fail, alias, error) {
    switch (error.code) {
      case 'TOKEN_REJECTED':
        fail(error.code, `${error.message}. The session has ended; start a new one with: fundkit session`);
        this.#log(`Doppler rejected the token while fetching for ${alias}`);
        return this.end('Doppler rejected the token');
      case 'MISSING_SECRETS':
        this.#log(`${alias}: missing in Doppler: ${error.missing.join(', ')}`);
        return fail(error.code, error.message, { missing: error.missing });
      default:
        return fail(error.code ?? 'DOPPLER_ERROR', error.message);
    }
  }

  #accountFor(role) {
    if (role === 'deposit-only') {
      return { funds: 'live', maxTransferValue: DEPOSIT_ONLY_TRANSFER_CAP, confirm: 'always', dryRun: true };
    }
    const { writes, maxTransfer, maxDaily } = this.#options;
    return {
      funds: 'live',
      maxTransferValue: maxTransfer,
      ...(maxDaily ? { maxDailyValue: maxDaily } : {}),
      confirm: 'always',
      dryRun: !writes,
    };
  }

  #startProfile({ client, alias, exchange, role, credentials, serverPath }) {
    let entry = null;
    const profile = new ProfileProcess({
      alias,
      exchange,
      role,
      account: { exchange, ...this.#accountFor(role) },
      serverPath,
      credentials,
      alsoRedact: [...this.#doppler.valuesToRedact(), ...this.#passphrases.values()],
      onMessage: (msg) => this.#fromProfile(entry, msg),
      onStderr: (text) => {
        if (this.#options.debug) this.#log(`${alias} stderr: ${text}`);
      },
      onExit: (code, signal) => {
        if (this.#profiles.get(alias) === entry) this.#profiles.delete(alias);
        client.aliases.delete(alias);
        client.send({ t: 'exit', alias, code, signal });
        this.#log(`${alias} stopped`);
      },
    });
    entry = new ProfileEntry(profile, client);
    this.#profiles.set(alias, entry);
    client.aliases.add(alias);
    return entry;
  }

  // ------------------------------------------------------------------ calls

  #forward(client, { alias, msg, call }) {
    const entry = this.#profiles.get(alias);
    if (entry?.owner !== client || !msg || typeof msg !== 'object') return;
    if (msg.method === 'tools/call') {
      const decision = authorizeCall({
        profile: entry.profile,
        channel: call?.channel === 'write' ? 'write' : 'read',
        tool: String(msg.params?.name ?? ''),
        args: msg.params?.arguments ?? {},
        expectedUid: call?.uid,
        identity: { uid: entry.uid, conflict: this.#accountConflicts.has(entry.profile.exchange) },
        provisioning: this.#options.provisioning,
      });
      if (!decision.allowed) {
        this.#log(`${alias}: refused ${msg.params?.name} (${decision.code})`);
        client.send({ t: 'rpc', alias, msg: toolError(msg.id, decision) });
        return;
      }
      if (decision.capturesUid) entry.uidCaptures.set(msg.id, decision.capturesUid);
    } else if (msg.method !== undefined && !FORWARDED_METHODS.has(msg.method)) {
      if (msg.id !== undefined) {
        const error = { code: -32601, message: `${msg.method} is not forwarded by fundkit` };
        client.send({ t: 'rpc', alias, msg: { jsonrpc: '2.0', id: msg.id, error } });
      }
      return;
    }
    entry.profile.send(msg);
  }

  #fromProfile(entry, msg) {
    const isResponse = msg.method === undefined && msg.id !== undefined;
    if (isResponse && entry.uidCaptures.has(msg.id)) {
      const field = entry.uidCaptures.get(msg.id);
      entry.uidCaptures.delete(msg.id);
      const uid = extractUid(msg.result, field);
      if (uid) this.#recordUid(entry, uid);
    }
    entry.owner.send({ t: 'rpc', alias: entry.profile.alias, msg });
  }

  #recordUid(entry, uid) {
    const { exchange, alias } = entry.profile;
    entry.uid = uid;
    const known = this.#accountUids.get(exchange);
    if (known === undefined) {
      this.#accountUids.set(exchange, uid);
    } else if (known !== uid) {
      this.#accountConflicts.add(exchange);
      this.#log(
        `${alias}: key check shows another ${exchange} UID than before in this session; holding ${exchange}`,
      );
    }
  }

  #stopProfile(alias, reason) {
    const entry = this.#profiles.get(alias);
    if (!entry) return;
    this.#log(`${alias}: ${reason}`);
    entry.profile.stop();
  }

  /** End the session: drop the token and passphrases, stop every profile, remove socket and files. */
  async end(reason) {
    if (this.#ending) return;
    this.#ending = true;
    this.#doppler.drop();
    this.#passphrases.clear();
    this.#log(`session ended: ${reason}`);
    clearTimeout(this.#ttlTimer);
    for (const client of this.#clients) client.send({ t: 'end', reason });

    const profiles = [...this.#profiles.values()].map(({ profile }) => profile);
    for (const profile of profiles) this.#stopProfile(profile.alias, 'session ending');
    await Promise.race([Promise.all(profiles.map((profile) => profile.exited)), delay(END_GRACE_MS)]);
    for (const profile of profiles) {
      profile.kill();
      profile.removeConfig();
    }

    this.#server?.close();
    fs.rmSync(socketPath(), { force: true });
    fs.rmSync(profilesDir(), { recursive: true, force: true });
    for (const client of this.#clients) client.socket.end();
    this.#options.onEnd?.(reason);
  }
}
