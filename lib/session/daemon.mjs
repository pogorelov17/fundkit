// The session daemon: holds the Doppler token for one session, starts session profiles on
// request from host-side brokers, and stops everything when the session ends.
//
// Control protocol (newline-delimited JSON over a 0600 Unix socket, one request per `id`):
//   ping | status | stop | hello {host} | connect {exchange, role} | disconnect {alias}
//   rpc {alias, msg}   JSON-RPC to a profile the caller owns (no reply on the control channel)
// The daemon pushes {t:'rpc', alias, msg}, {t:'exit', alias, ...} and {t:'end', reason}.

import fs from 'node:fs';
import net from 'node:net';
import { aliasFor, credentialNames, isRole, normalizeExchange, ROLE_NAMES } from '../exchanges.mjs';
import { onJsonLines, writeJsonLine } from '../ndjson.mjs';
import { ccxtServerPath, ensurePrivateDir, profilesDir, runDir, socketPath } from '../paths.mjs';
import { requestSession } from '../control.mjs';
import { delay } from '../util.mjs';
import { ProfileProcess } from './profile.mjs';

const END_GRACE_MS = 3000;
const DEPOSIT_ONLY_TRANSFER_CAP = 10;
const HOST_NAME_LIMIT = 60;

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

export class SessionDaemon {
  #doppler;
  #options;
  #log;
  #server = null;
  #ttlTimer = null;
  #clients = new Set();
  /** @type {Map<string, {profile: ProfileProcess, owner: ControlClient}>} */
  #profiles = new Map();
  #ending = false;

  /**
   * @param {import('../doppler.mjs').DopplerClient} doppler
   * @param {object} options  ttlMs, writes, maxTransfer, maxDaily, keep, wrapped, debug,
   *                          identity, log(line), onEnd(reason)
   */
  constructor(doppler, options) {
    this.#doppler = doppler;
    this.#options = options;
    this.#log = options.log;
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
      profiles: [...this.#profiles.values()].map(({ profile }) => ({
        alias: profile.alias,
        exchange: profile.exchange,
        role: profile.role,
        dryRun: profile.dryRun,
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
      case 'rpc':
        return this.#forward(client, message);
      default:
        return client.send({ t: 'error', id, code: 'BAD_REQUEST', message: 'unknown message' });
    }
  }

  #forward(client, { alias, msg }) {
    const entry = this.#profiles.get(alias);
    if (entry?.owner === client) entry.profile.send(msg);
  }

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
      const { profile } = existing;
      return client.send({
        t: 'connected',
        id,
        alias,
        exchange,
        role,
        dryRun: profile.dryRun,
        already: true,
      });
    }

    const serverPath = ccxtServerPath();
    if (!serverPath || !fs.existsSync(serverPath)) {
      return fail('SERVER_NOT_INSTALLED', 'pinned ccxt-mcp not found; run fundkit install');
    }

    const names = credentialNames(exchange, role);
    const dopplerNames = names.map((name) => name.doppler);
    let fetched;
    try {
      fetched = await this.#doppler.fetchSecrets(dopplerNames);
    } catch (error) {
      return this.#connectFailed(fail, alias, exchange, names, error);
    }
    if (this.#ending) {
      fetched.clear();
      return fail('SESSION_ENDED', 'the session is ending');
    }

    const credentials = new Map(names.map((name) => [name.env, fetched.get(name.doppler)]));
    fetched.clear();
    const profile = this.#startProfile({ client, alias, exchange, role, credentials });
    this.#log(
      `${alias} connected for ${client.name} (${exchange}, ${role}, dryRun ${profile.dryRun}); ` +
        `fetched ${dopplerNames.join(', ')}`,
    );
    client.send({
      t: 'connected',
      id,
      alias,
      exchange,
      role,
      dryRun: profile.dryRun,
      configPath: profile.configPath,
      fetched: dopplerNames,
    });
  }

  #connectFailed(fail, alias, exchange, names, error) {
    switch (error.code) {
      case 'TOKEN_REJECTED':
        fail(error.code, `${error.message}. The session has ended; start a new one with: fundkit session`);
        this.#log(`Doppler rejected the token while fetching for ${alias}`);
        return this.end('Doppler rejected the token');
      case 'MISSING_SECRETS': {
        this.#log(`${alias}: missing in Doppler: ${error.missing.join(', ')}`);
        const passphrase = names.find((name) => name.env.endsWith('_PASSWORD'));
        const missesPassphrase = passphrase && error.missing.includes(passphrase.doppler);
        const hint = missesPassphrase
          ? ` (${exchange} needs its API passphrase as ${passphrase.doppler})`
          : '';
        return fail(error.code, error.message + hint, { missing: error.missing });
      }
      default:
        return fail(error.code ?? 'DOPPLER_ERROR', error.message);
    }
  }

  #accountFor(role) {
    const { writes, maxTransfer, maxDaily } = this.#options;
    if (role === 'deposit-only') {
      return {
        funds: 'live',
        maxTransferValue: DEPOSIT_ONLY_TRANSFER_CAP,
        confirm: 'always',
        dryRun: true,
      };
    }
    return {
      funds: 'live',
      maxTransferValue: maxTransfer,
      ...(maxDaily ? { maxDailyValue: maxDaily } : {}),
      confirm: 'always',
      dryRun: !writes,
    };
  }

  #startProfile({ client, alias, exchange, role, credentials }) {
    const account = { exchange, ...this.#accountFor(role) };
    const profile = new ProfileProcess({
      alias,
      exchange,
      role,
      account,
      serverPath: ccxtServerPath(),
      credentials,
      alsoRedact: this.#doppler.valuesToRedact(),
      onMessage: (msg) => client.send({ t: 'rpc', alias, msg }),
      onStderr: (text) => {
        if (this.#options.debug) this.#log(`${alias} stderr: ${text}`);
      },
      onExit: (code, signal) => {
        if (this.#profiles.get(alias)?.profile === profile) this.#profiles.delete(alias);
        client.aliases.delete(alias);
        client.send({ t: 'exit', alias, code, signal });
        this.#log(`${alias} stopped`);
      },
    });
    this.#profiles.set(alias, { profile, owner: client });
    client.aliases.add(alias);
    return profile;
  }

  #stopProfile(alias, reason) {
    const entry = this.#profiles.get(alias);
    if (!entry) return;
    this.#log(`${alias}: ${reason}`);
    entry.profile.stop();
  }

  /** End the session: drop the token, stop every profile, remove the socket and the files. */
  async end(reason) {
    if (this.#ending) return;
    this.#ending = true;
    this.#doppler.drop();
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
