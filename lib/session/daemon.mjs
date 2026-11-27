// The session daemon: holds the credentials of one session (a Doppler Service Token with the
// typed API passphrases, and/or manual credential sets entered in private cards), starts session
// profiles for host-side brokers, enforces each profile's local role on every call, and stops
// everything when the session ends.
//
// Control protocol (newline-delimited JSON over a 0600 Unix socket; requests carry an `id`):
//   ping | status | stop | hello {host} | disconnect {alias}
//   connect {exchange, role, credentials?, viaPlan?, resume?}
//                                  credentials: a manual set id (lib/session/vault.mjs); without
//                                  one, or for an exchange the set lacks, Doppler is used
//   passphrase {exchange, value}   from `fundkit passphrase` only, never from a host broker
//   token {value}                  from `fundkit unlock` only, never from a host broker
//   credentials-status {exchanges, credentials?}
//   credentials-start {provider: 'doppler'|'manual', exchanges, credentials?, resume?}
//   secret-file {stepId, file}     the path of a host-delivered secret file; the daemon itself
//                                  reads it once and deletes it (a broker never carries a value)
//   secret-cancel {stepId}
//   plan-register {plan}           a prepared transfer: {planId, exchange, to, credentials?,
//                                  argsHash, cap, expiresAt}
//   connect {exchange, planId}     the plan's single-use source profile (dryRun off, capped at the
//                                  plan's amount); it forwards the key check and exactly one
//                                  withdraw whose arguments hash to argsHash (channel 'plan')
//   rpc {alias, msg, call?}        JSON-RPC to a profile the caller owns; `call` is
//                                  {channel: 'read'|'write'} for tools/call (an older caller's
//                                  `uid` there is ignored: fundkit binds no account UID)
// The daemon pushes {t:'rpc', alias, msg}, {t:'exit', alias, ...} and {t:'end', reason}.

import fs from 'node:fs';
import net from 'node:net';
import { SERVICE_TOKEN_PATTERN } from '../constants.mjs';
import { fieldLabel, fieldProblem, manualFields } from '../credentials.mjs';
import { DopplerClient } from '../doppler.mjs';
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
import { consumeSecretFile } from '../handoff.mjs';
import { onJsonLines, writeJsonLine } from '../ndjson.mjs';
import { ccxtServerPath, ensurePrivateDir, profilesDir, runDir, socketPath } from '../paths.mjs';
import { claimDispatch, hashOf, isPlanId, planAlias } from '../plans.mjs';
import { authorizeCall, describeRole, hasKeyCheck, isKeyCheckCall, venueScopeNotes } from '../policy.mjs';
import { requestSession } from '../control.mjs';
import { boundedEnv, delay } from '../util.mjs';
import { manualSecretStep, passphraseSecretStep, tokenSecretStep } from '../secret-step.mjs';
import { PassphraseStore } from './passphrases.mjs';
import { ProfileProcess } from './profile.mjs';
import { CredentialVault } from './vault.mjs';

const END_GRACE_MS = 3000;
const DEPOSIT_ONLY_TRANSFER_CAP = 10;
const HOST_NAME_LIMIT = 60;
const PLAN_MAX_LIFETIME_MS = 30 * 60_000;
// One private card may take this long; tests may shorten it (never lengthen).
const SECRET_STEP_TTL_MS = boundedEnv('FUNDKIT_SECRET_STEP_TTL_MS', 10 * 60_000, 1000, 10 * 60_000);
// A manual credential set lives at most this long (and never beyond the session).
const CREDENTIAL_TTL_MS = boundedEnv('FUNDKIT_CREDENTIAL_TTL_MS', 8 * 3_600_000, 1000, 8 * 3_600_000);
// A background session that holds no credential (a card was cancelled, refused or never
// answered) ends after this grace, so a choice made right after a cancel still finds it.
const IDLE_GRACE_MS = boundedEnv('FUNDKIT_IDLE_GRACE_MS', 10 * 60_000, 500, 10 * 60_000);
const MAX_EXCHANGES = 8;
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

/** A running profile, its owner and whether its key check has succeeded. */
class ProfileEntry {
  constructor(profile, owner, source) {
    this.profile = profile;
    this.owner = owner;
    /** where its credentials came from: {kind: 'doppler'} or {kind: 'manual', scopeId, tag} */
    this.source = source;
    this.keyChecked = false;
    /** the registered plan, on a plan's single-use source profile only */
    this.plan = null;
    /** JSON-RPC request ids of key checks in flight */
    this.keyChecksInFlight = new Set();
  }
}

/** A refused tools/call, answered as an MCP tool error so the host shows the reason. */
function toolError(id, { code, message }) {
  const text = JSON.stringify({ error: code, message }, null, 2);
  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: true } };
}

/** True when a ccxt-mcp tool response says the exchange rejected the credentials. */
function isAuthFailure(msg) {
  if (!msg.result?.isError) return false;
  let body;
  try {
    body = JSON.parse(msg.result.content?.[0]?.text ?? 'null') ?? {};
  } catch {
    return false;
  }
  const code = typeof body.error === 'string' ? body.error : (body.error?.code ?? body.code);
  return code === 'AUTH_FAILED';
}

/** A list of supported exchanges from a request, or null when any name is not one. */
function exchangeList(names) {
  if (!Array.isArray(names) || names.length === 0 || names.length > MAX_EXCHANGES) return null;
  const list = names.map(normalizeExchange);
  return list.every(Boolean) ? [...new Set(list)] : null;
}

/** A resume call with a manual credential set named in its arguments. */
function withCredentials(resume, credentials) {
  if (!resume) return null;
  return { tool: resume.tool, arguments: { ...resume.arguments, credentials } };
}

function sourceKey(source) {
  return source.kind === 'manual' ? `manual:${source.scopeId}` : 'doppler';
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
  /** @type {Map<string, object>} registered plans, in memory only: a restart forgets them */
  #plans = new Map();
  /** aliases whose credentials are being fetched */
  #connecting = new Set();
  /** @type {CredentialVault} manual credential sets and open secret steps */
  #vault;
  /** exchange -> the open Doppler-path passphrase step, so concurrent connects share one card */
  #passphraseSteps = new Map();
  #idleTimer = null;
  #ending = false;

  /**
   * @param {import('../doppler.mjs').DopplerClient|null} doppler  null: a background session
   *                          that starts without Doppler (manual credentials, or a token later)
   * @param {object} options  ttlMs, writes, maxTransfer, maxDaily, keep, wrapped, headless, debug,
   *                          provisioning (Set of exchanges), passphrases (Map typed up front),
   *                          identity, log(line), onEnd(reason)
   */
  constructor(doppler, options) {
    this.#doppler = doppler;
    this.#options = options;
    this.#log = options.log;
    this.#passphrases = new PassphraseStore({
      canPrompt: !options.wrapped && !options.headless,
      log: options.log,
      initial: options.passphrases,
    });
    this.started = Date.now();
    this.expires = this.started + options.ttlMs;
    this.#vault = new CredentialVault({
      stepTtlMs: SECRET_STEP_TTL_MS,
      scopeTtlMs: CREDENTIAL_TTL_MS,
      onExpire: (what) => this.#onExpired(what),
    });
  }

  info() {
    return {
      state: 'active',
      started: new Date(this.started).toISOString(),
      expires: new Date(this.expires).toISOString(),
      doppler: this.#doppler ? (this.#options.identity ?? null) : null,
      manual: this.#vault.summary(),
      writes: this.#options.writes,
      maxTransferValue: this.#options.maxTransfer,
      maxDailyValue: this.#options.maxDaily ?? null,
      provisioning: [...this.#options.provisioning],
      profiles: [...this.#profiles.values()].map(({ profile, keyChecked, source }) => ({
        alias: profile.alias,
        exchange: profile.exchange,
        role: profile.role,
        dryRun: profile.dryRun,
        credentials: source.kind,
        keyChecked,
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
    this.#endIfIdle();
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
      case 'token':
        return this.#storeToken(client, message);
      case 'credentials-status':
        return this.#credentialsStatus(client, message);
      case 'credentials-start':
        return this.#credentialsStart(client, message);
      case 'secret-file':
        return this.#secretFile(client, message);
      case 'secret-cancel':
        return this.#secretCancel(client, message);
      case 'plan-register':
        return this.#registerPlan(client, message);
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
  #passphraseProblem(exchange, alias, resume) {
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
    if (this.#options.headless) {
      const open = this.#passphraseSteps.get(exchange);
      const step =
        open && this.#vault.peek(open.id)
          ? open
          : this.#vault.issue({ kind: 'doppler-passphrase', exchange, exchanges: [exchange], resume });
      this.#passphraseSteps.set(exchange, step);
      return {
        code: 'PASSPHRASE_NEEDED',
        message: `${label} needs its API passphrase, which is not stored in Doppler; nothing was started`,
        secretStep: passphraseSecretStep(step),
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

  // ------------------------------------------------------------------ credentials

  /** Where `exchange`'s credentials come from for a caller: its manual set first, then Doppler. */
  #sourceFor(exchange, credentials) {
    const scope = this.#vault.scope(credentials);
    if (scope && this.#vault.hasVenue(scope, exchange)) {
      return { kind: 'manual', scope, scopeId: scope.id, tag: scope.tag };
    }
    return this.#doppler ? { kind: 'doppler' } : null;
  }

  #credentialsStatus(client, { id, exchanges, credentials }) {
    const list = exchangeList(exchanges);
    if (!list) return client.send({ t: 'error', id, code: 'BAD_REQUEST', message: 'name 1 to 8 exchanges' });
    const sources = {};
    const missing = [];
    for (const exchange of list) {
      const source = this.#sourceFor(exchange, credentials);
      sources[exchange] = source?.kind ?? null;
      if (!source) missing.push(exchange);
    }
    const scope = this.#vault.scope(credentials);
    return client.send({
      t: 'credentials-status',
      id,
      doppler: Boolean(this.#doppler),
      credentials: scope ? 'active' : credentials ? 'unknown' : 'none',
      sources,
      missing,
    });
  }

  /** The operator chose a provider: open its first card, or say nothing is missing. */
  #credentialsStart(client, { id, provider, exchanges, credentials, resume }) {
    const fail = (code, text) => client.send({ t: 'error', id, code, message: text });
    if (!client.attached) return fail('BAD_REQUEST', 'credentials are started only by a host broker');
    if (this.#ending) return fail('SESSION_ENDED', 'the session is ending');
    const list = exchangeList(exchanges);
    if (!list) return fail('UNKNOWN_EXCHANGE', 'name 1 to 8 supported exchanges');
    if (provider === 'doppler') {
      if (this.#doppler) {
        return client.send({ t: 'credentials-ready', id, provider, already: true, resume: resume ?? null });
      }
      const step = this.#vault.issue({ kind: 'doppler-token', exchanges: list, resume });
      this.#log(`Doppler Service Token card opened for ${list.join(', ')}`);
      return client.send({ t: 'secret-step', id, provider, step: tokenSecretStep(step) });
    }
    if (provider !== 'manual') return fail('BAD_REQUEST', 'provider must be doppler or manual');
    const scope = this.#vault.openScope(credentials, { notAfter: this.expires });
    const needed = this.#vault.missing(scope, list);
    const next = this.#vault.nextField(scope, needed);
    if (!next) {
      return client.send({
        t: 'credentials-ready',
        id,
        provider,
        already: true,
        credentials: scope.id,
        resume: withCredentials(resume, scope.id),
      });
    }
    const step =
      this.#vault.pendingStep(scope, next) ??
      this.#vault.issue({ kind: 'manual', ...next, scope, exchanges: needed, resume });
    this.#log(`manual entry ${scope.tag} opened for ${needed.join(', ')}`);
    return client.send({
      t: 'secret-step',
      id,
      provider,
      credentials: scope.id,
      step: manualSecretStep(step, { remaining: needed }),
    });
  }

  /**
   * A host delivered a secret file for a step. The daemon reads and deletes it itself; the broker
   * only relayed the path. A file for a used, cancelled or expired step is deleted unused when it
   * passes the delivery checks; anything else is left untouched.
   */
  async #secretFile(client, { id, stepId, file }) {
    const fail = (code, text, extra = {}) => client.send({ t: 'error', id, code, message: text, ...extra });
    if (!client.attached) return fail('BAD_REQUEST', 'secret files are submitted only by a host broker');
    const step = this.#vault.peek(stepId);
    if (!step) return this.#lateFile(fail, stepId, file);
    const keepSpaces = step.kind === 'doppler-passphrase' || step.field === 'passphrase';
    let buffer;
    try {
      buffer = consumeSecretFile(file, { keepSpaces, delivery: { notBefore: step.issuedAt } });
    } catch (error) {
      // The step stays open: the agent may submit the right file for it.
      return fail(error.code ?? 'FILE_UNSAFE', error.message, { retry: this.#present(step) });
    }
    const taken = this.#vault.take(stepId);
    let value = buffer.toString('utf8');
    buffer.fill(0);
    if (!taken || taken.expired) {
      value = null;
      return fail('STEP_EXPIRED', 'this card expired before its value arrived; it was deleted unused', {
        retryChoice: true,
        exchanges: step.exchanges,
        resume: step.resume,
      });
    }
    try {
      if (step.kind === 'doppler-token') return await this.#acceptToken(client, id, step, value, fail);
      if (step.kind === 'doppler-passphrase') return this.#acceptPassphrase(client, id, step, value, fail);
      return this.#acceptField(client, id, step, value, fail);
    } finally {
      value = null;
    }
  }

  #lateFile(fail, stepId, file) {
    const retired = this.#vault.retired(stepId);
    if (!retired) {
      return fail(
        'STEP_UNKNOWN',
        'this session never issued that step (it may have restarted); the file was not read or removed',
      );
    }
    let wiped = false;
    try {
      consumeSecretFile(file, { keepSpaces: true, delivery: { notBefore: retired.step.issuedAt } }).fill(0);
      wiped = true;
    } catch {
      // Not a delivery for this step: leave it alone.
    }
    const code = { used: 'STEP_USED', cancelled: 'STEP_CANCELLED', expired: 'STEP_EXPIRED' }[retired.why];
    return fail(
      code,
      `this card is ${retired.why}; ${wiped ? 'the file was deleted unused' : 'nothing was read'}`,
      {
        retryChoice: retired.why !== 'used',
        exchanges: retired.step.exchanges,
        resume: retired.step.resume,
      },
    );
  }

  /** The step as the agent sees it, for a retry of the same card. */
  #present(step) {
    if (step.kind === 'doppler-token') return tokenSecretStep(step);
    if (step.kind === 'doppler-passphrase') return passphraseSecretStep(step);
    const scope = this.#vault.scopeOf(step);
    return manualSecretStep(step, { remaining: this.#vault.missing(scope, step.exchanges) });
  }

  async #acceptToken(client, id, step, value, fail) {
    const retry = { retryChoice: true, exchanges: step.exchanges, resume: step.resume };
    if (!SERVICE_TOKEN_PATTERN.test(value)) {
      return fail(
        'TOKEN_FORMAT',
        'the value is not a Doppler Service Token (dp.st.…); it was deleted and not sent anywhere',
        retry,
      );
    }
    if (this.#doppler) {
      return client.send({
        t: 'credentials-ready',
        id,
        provider: 'doppler',
        already: true,
        resume: step.resume,
      });
    }
    const doppler = new DopplerClient(value);
    let identity;
    try {
      identity = await doppler.identify();
    } catch (error) {
      doppler.drop();
      this.#log(`Doppler Service Token from a card refused (${error.code ?? 'error'})`);
      fail(error.code ?? 'DOPPLER_ERROR', `${error.message}. Nothing was kept.`, retry);
      return this.#endIfIdle();
    }
    if (this.#ending || this.#doppler) {
      doppler.drop();
      if (this.#ending) return fail('SESSION_ENDED', 'the session is ending');
      return client.send({
        t: 'credentials-ready',
        id,
        provider: 'doppler',
        already: true,
        resume: step.resume,
      });
    }
    this.#doppler = doppler;
    this.#options.identity = identity;
    this.#log(`Doppler connected from a card: project ${identity.project}, config ${identity.config}`);
    return client.send({
      t: 'credentials-ready',
      id,
      provider: 'doppler',
      doppler: identity,
      resume: step.resume,
    });
  }

  #acceptPassphrase(client, id, step, value, fail) {
    const { exchange } = step;
    this.#passphraseSteps.delete(exchange);
    const problem = fieldProblem('passphrase', value);
    if (problem) {
      const again = this.#vault.issue({ ...step, kind: 'doppler-passphrase' });
      this.#passphraseSteps.set(exchange, again);
      return fail(
        'VALUE_REFUSED',
        `${exchangeLabel(exchange)} API passphrase: ${problem}. Nothing was kept.`,
        {
          retry: passphraseSecretStep(again),
        },
      );
    }
    const { replaced } = this.#passphrases.set(exchange, value);
    this.#log(`${exchangeLabel(exchange)} passphrase ${replaced ? 'replaced' : 'kept'} from a card`);
    return client.send({ t: 'credentials-ready', id, provider: 'doppler', resume: step.resume });
  }

  #acceptField(client, id, step, value, fail) {
    const { exchange, field } = step;
    const scope = this.#vault.scopeOf(step);
    const label = fieldLabel(exchange, field);
    if (!scope) {
      return fail('CREDENTIALS_EXPIRED', 'this manual entry expired; nothing was kept', {
        retryChoice: true,
        exchanges: step.exchanges,
        resume: step.resume,
      });
    }
    const problem =
      fieldProblem(field, value) ?? this.#vault.storeField(scope, exchange, field, value).problem;
    if (problem) {
      const again = this.#vault.issue({ ...step, scope });
      this.#log(`manual entry ${scope.tag}: ${label} refused`);
      return fail(
        'VALUE_REFUSED',
        `${label}: ${problem}. The file was deleted and nothing was kept for it.`,
        {
          retry: manualSecretStep(again, { remaining: this.#vault.missing(scope, step.exchanges) }),
          credentials: scope.id,
        },
      );
    }
    this.#log(`manual entry ${scope.tag}: ${label} kept in memory`);
    const next = this.#vault.nextField(scope, step.exchanges);
    if (next) {
      const following = this.#vault.issue({
        kind: 'manual',
        ...next,
        scope,
        exchanges: step.exchanges,
        resume: step.resume,
      });
      return client.send({
        t: 'secret-step',
        id,
        provider: 'manual',
        stored: label,
        credentials: scope.id,
        step: manualSecretStep(following, { remaining: this.#vault.missing(scope, step.exchanges) }),
      });
    }
    return client.send({
      t: 'credentials-ready',
      id,
      provider: 'manual',
      stored: label,
      credentials: scope.id,
      connected: step.exchanges,
      resume: withCredentials(step.resume, scope.id),
    });
  }

  #secretCancel(client, { id, stepId }) {
    if (!client.attached) {
      return client.send({
        t: 'error',
        id,
        code: 'BAD_REQUEST',
        message: 'only a host broker cancels cards',
      });
    }
    const cancelled = this.#vault.cancel(stepId);
    if (!cancelled) {
      const retired = this.#vault.retired(stepId);
      client.send({
        t: 'secret-cancelled',
        id,
        already: Boolean(retired),
        exchanges: retired?.step.exchanges ?? [],
        resume: retired?.step.resume ?? null,
      });
      return this.#endIfIdle();
    }
    const { step, discarded, scope } = cancelled;
    if (step.kind === 'doppler-passphrase') this.#passphraseSteps.delete(step.exchange);
    this.#log(
      `card cancelled (${step.kind}${step.exchange ? `, ${step.exchange}` : ''}); ` +
        `${discarded} unfinished field(s) dropped`,
    );
    client.send({
      t: 'secret-cancelled',
      id,
      kind: step.kind,
      exchange: step.exchange,
      discarded,
      kept: scope ? [...scope.complete] : [],
      exchanges: step.exchanges,
      credentials: scope?.id ?? null,
      resume: step.resume,
    });
    return this.#endIfIdle();
  }

  /** `fundkit unlock --token-file` while a session without Doppler runs: add the token. */
  async #storeToken(client, { id, value }) {
    const fail = (code, text) => client.send({ t: 'error', id, code, message: text });
    if (client.attached) return fail('BAD_REQUEST', 'a token is accepted only from fundkit unlock');
    if (typeof value !== 'string' || !SERVICE_TOKEN_PATTERN.test(value)) {
      return fail('TOKEN_FORMAT', 'not a Doppler Service Token');
    }
    const already = () =>
      client.send({ t: 'token-stored', id, already: true, doppler: this.#options.identity ?? null });
    if (this.#doppler) return already();
    const doppler = new DopplerClient(value);
    let identity;
    try {
      identity = await doppler.identify();
    } catch (error) {
      doppler.drop();
      return fail(error.code ?? 'DOPPLER_ERROR', `${error.message}. Nothing was kept.`);
    }
    if (this.#doppler || this.#ending) {
      doppler.drop();
      return already();
    }
    this.#doppler = doppler;
    this.#options.identity = identity;
    this.#log('Doppler connected from fundkit unlock');
    return client.send({ t: 'token-stored', id, doppler: this.#options.identity });
  }

  #onExpired(what) {
    if (what.kind === 'scope') {
      this.#log(`manual credential set ${what.tag} ${what.why}; its values were dropped`);
    }
    if (what.kind === 'step') {
      if (what.step.kind === 'doppler-passphrase') this.#passphraseSteps.delete(what.step.exchange);
      this.#log(`card expired (${what.step.kind}); nothing from it was kept`);
    }
    if (what.kind === 'scope') {
      this.#stopProfilesOf((source) => source.kind === 'manual' && !this.#vault.scope(source.scopeId));
    }
    this.#endIfIdle();
  }

  /** Stop the running profiles whose credential source matches. */
  #stopProfilesOf(matches, reason = 'its credentials were dropped') {
    for (const entry of [...this.#profiles.values()]) {
      if (matches(entry.source, entry)) this.#stopProfile(entry.profile.alias, reason);
    }
  }

  /** The exchange rejected a manually entered key: forget it, so the next request asks again. */
  #rejectManual(entry) {
    const { exchange } = entry.profile;
    const { scopeId, tag } = entry.source;
    this.#vault.discardVenue(this.#vault.scope(scopeId), exchange);
    this.#log(`manual entry ${tag}: ${exchangeLabel(exchange)} rejected the key; its values were dropped`);
    setImmediate(() =>
      this.#stopProfilesOf(
        (source, other) => source.scopeId === scopeId && other.profile.exchange === exchange,
        'the exchange rejected its key',
      ),
    );
  }

  /** Doppler rejected the token: drop it and its profiles; manual sets stay. */
  #dropDoppler(reason) {
    this.#doppler?.drop();
    this.#doppler = null;
    this.#options.identity = null;
    this.#passphrases.clear();
    this.#log(`Doppler disconnected: ${reason}`);
    this.#stopProfilesOf((source) => source.kind === 'doppler', reason);
  }

  /** A background session that holds nothing ends after IDLE_GRACE_MS, unless it gets something. */
  #endIfIdle() {
    if (!this.#options.headless || this.#ending || this.#idleTimer) return;
    this.#idleTimer = setTimeout(() => {
      this.#idleTimer = null;
      if (this.#isIdle()) this.end('no credentials left in the session');
    }, IDLE_GRACE_MS);
    this.#idleTimer.unref();
  }

  #isIdle() {
    if (this.#doppler || !this.#vault.isEmpty()) return false;
    return this.#profiles.size === 0 && this.#connecting.size === 0;
  }

  // ------------------------------------------------------------------ connect

  async #connect(client, message) {
    const { id } = message;
    const fail = (code, text, extra = {}) => client.send({ t: 'error', id, code, message: text, ...extra });

    const exchange = normalizeExchange(message.exchange);
    if (!exchange) {
      return fail('UNKNOWN_EXCHANGE', `unsupported exchange: ${String(message.exchange).slice(0, 40)}`);
    }
    if (message.planId !== undefined) return this.#connectPlan(client, message, exchange, fail);
    const { role } = message;
    if (!isRole(role)) return fail('UNKNOWN_ROLE', `role must be one of ${ROLE_NAMES.join(', ')}`);

    // The recheck of a plan's destination uses the credentials the plan was prepared with.
    const viaPlan = message.viaPlan !== undefined ? this.#plans.get(message.viaPlan) : null;
    const credentials = viaPlan?.to === exchange ? viaPlan.credentials : message.credentials;
    const source = this.#sourceFor(exchange, credentials);
    if (!source) return fail(...this.#needed(exchange));
    const alias =
      source.kind === 'manual' ? `${aliasFor(exchange, role)}-${source.tag}` : aliasFor(exchange, role);
    if (this.#connecting.has(alias)) {
      return fail('CONNECT_IN_PROGRESS', `${alias} is being connected; call again in a moment`);
    }
    const existing = this.#profiles.get(alias);
    if (existing) {
      if (existing.owner !== client || sourceKey(existing.source) !== sourceKey(source)) {
        return fail('ALIAS_IN_USE', `${alias} is connected to another host session`);
      }
      const { dryRun } = existing.profile;
      return client.send({
        t: 'connected',
        id,
        alias,
        exchange,
        role,
        dryRun,
        source: source.kind,
        already: true,
      });
    }

    this.#connecting.add(alias);
    let prepared;
    try {
      prepared = await this.#credentialsFor(exchange, alias, fail, source, message.resume);
    } finally {
      this.#connecting.delete(alias);
    }
    if (!prepared) return undefined;
    const { credentials: values, serverPath, names, passphraseEnv } = prepared;

    const { profile } = this.#startProfile({
      client,
      alias,
      exchange,
      role,
      credentials: values,
      serverPath,
      source,
    });
    const from =
      source.kind === 'manual'
        ? `entered manually (set ${source.tag})`
        : `fetched ${names.join(', ')}${passphraseEnv ? '; passphrase from a private step' : ''}`;
    this.#log(
      `${alias} connected for ${client.name} (${exchange}, ${role}, dryRun ${profile.dryRun}); ${from}`,
    );
    client.send({
      t: 'connected',
      id,
      alias,
      exchange,
      role,
      dryRun: profile.dryRun,
      source: source.kind,
      configPath: profile.configPath,
      fetched: source.kind === 'doppler' ? names : [],
      ...this.#connectFacts(exchange, role, alias, source, Boolean(passphraseEnv)),
    });
  }

  /** The CREDENTIALS_NEEDED failure for one exchange, as [code, message, extra]. */
  #needed(exchange) {
    return [
      'CREDENTIALS_NEEDED',
      `${exchangeLabel(exchange)} has no credentials in this session; nothing was started`,
      { missing: [exchange], doppler: Boolean(this.#doppler) },
    ];
  }

  /**
   * The credentials of one profile: a manual set's values, or the exchange's two Doppler names
   * plus its passphrase. Returns {credentials, serverPath, names, passphraseEnv}, or null after
   * answering the failure with `fail`.
   */
  async #credentialsFor(exchange, alias, fail, source, resume) {
    const serverPath = ccxtServerPath();
    if (!serverPath || !fs.existsSync(serverPath)) {
      fail('SERVER_NOT_INSTALLED', 'pinned ccxt-mcp not found; run fundkit install');
      return null;
    }
    if (source.kind === 'manual') {
      const credentials = this.#vault.credentials(this.#vault.scope(source.scopeId), exchange);
      if (!credentials) {
        fail(...this.#needed(exchange));
        return null;
      }
      return { credentials, serverPath, names: [...credentials.keys()], passphraseEnv: null };
    }
    if (!this.#doppler) {
      fail(...this.#needed(exchange));
      return null;
    }
    const names = dopplerNames(exchange);
    let fetched;
    try {
      fetched = await this.#doppler.fetchSecrets(names);
    } catch (error) {
      await this.#fetchFailed(fail, alias, error, exchange);
      return null;
    }
    if (this.#ending || !this.#doppler) {
      fetched.clear();
      fail('SESSION_ENDED', 'the session is ending');
      return null;
    }
    const passphraseProblem = this.#passphraseProblem(exchange, alias, resume);
    if (passphraseProblem) {
      fetched.clear();
      const { code, message: text, ...extra } = passphraseProblem;
      fail(code, text, extra);
      return null;
    }
    const credentials = new Map(fetched);
    fetched.clear();
    const passphraseEnv = passphraseEnvName(exchange);
    if (passphraseEnv) credentials.set(passphraseEnv, this.#passphrases.get(exchange));
    return { credentials, serverPath, names, passphraseEnv };
  }

  // ------------------------------------------------------------------ plans

  #registerPlan(client, { id, plan }) {
    const fail = (code, text) => client.send({ t: 'error', id, code, message: text });
    if (!client.attached) return fail('BAD_REQUEST', 'plans are registered only by a host broker');
    const { planId, exchange, to, credentials = null, argsHash, cap, expiresAt } = plan ?? {};
    const valid =
      isPlanId(planId) &&
      normalizeExchange(exchange) === exchange &&
      (to === undefined || normalizeExchange(to) === to) &&
      /^[0-9a-f]{64}$/.test(String(argsHash)) &&
      Number.isFinite(cap) &&
      cap > 0 &&
      Number.isFinite(expiresAt) &&
      expiresAt > Date.now() &&
      expiresAt - Date.now() <= PLAN_MAX_LIFETIME_MS;
    if (!valid) return fail('BAD_PLAN', 'plan fields are missing or out of range');
    if (this.#plans.has(planId)) return fail('PLAN_EXISTS', `${planId} is already registered`);
    // The plan is bound to the credentials it was prepared with: a manual set, or Doppler.
    const source = this.#sourceFor(exchange, credentials);
    if (!source) return fail(...this.#needed(exchange));
    this.#plans.set(planId, {
      planId,
      exchange,
      to: to ?? null,
      // The caller's manual set, if any: the destination recheck reads B with the same credentials.
      credentials: this.#vault.scope(credentials) ? credentials : null,
      sourceKey: sourceKey(source),
      argsHash,
      cap,
      expiresAt,
      state: 'registered',
    });
    this.#log(`plan ${planId} registered (${exchange}, cap ${cap}, ${source.kind} credentials)`);
    return client.send({ t: 'plan-registered', id, planId });
  }

  /** Start the plan's single-use source profile. A plan connects once, ever. */
  async #connectPlan(client, message, exchange, fail) {
    const plan = this.#plans.get(message.planId);
    if (!plan) {
      return fail(
        'PLAN_NOT_REGISTERED',
        'this session has no such plan (a restarted session forgets plans); prepare again',
      );
    }
    if (plan.exchange !== exchange) return fail('PLAN_MISMATCH', 'the plan is for another exchange');
    if (Date.now() >= plan.expiresAt) return fail('PLAN_EXPIRED', 'the plan expired; prepare again');
    if (plan.state !== 'registered') return fail('PLAN_SPENT', 'this plan was already used; prepare again');
    const source = this.#sourceFor(exchange, plan.credentials);
    if (!source || sourceKey(source) !== plan.sourceKey) {
      plan.state = 'spent';
      return fail(
        'CREDENTIALS_CHANGED',
        'the credentials this plan was prepared with are no longer in the session; nothing was sent, prepare again',
      );
    }
    plan.state = 'connecting';
    const alias = planAlias(exchange, plan.planId);
    const prepared = await this.#credentialsFor(exchange, alias, fail, source);
    if (!prepared) {
      plan.state = 'spent';
      return undefined;
    }
    const { credentials, serverPath } = prepared;
    const entry = this.#startProfile({
      client,
      alias,
      exchange,
      role: 'source',
      credentials,
      serverPath,
      source,
      account: { funds: 'live', maxTransferValue: plan.cap, confirm: 'always', dryRun: false },
    });
    entry.plan = plan;
    plan.state = 'connected';
    this.#log(`${alias}: single-use profile for plan ${plan.planId} (cap ${plan.cap}, dryRun false)`);
    return client.send({
      t: 'connected',
      id: message.id,
      alias,
      exchange,
      role: 'source',
      dryRun: false,
      source: source.kind,
      planId: plan.planId,
      configPath: entry.profile.configPath,
      fetched: source.kind === 'doppler' ? prepared.names : [],
    });
  }

  /** What a plan profile forwards: its key check, get_safety_status and the plan's one withdraw. */
  #authorizePlanCall(entry, tool, args, channel) {
    const deny = (code, message) => ({ allowed: false, code, message });
    const { plan, profile } = entry;
    if (channel !== 'plan') {
      if (tool === 'get_safety_status' || isKeyCheckCall(profile.exchange, tool, args)) {
        return { allowed: true };
      }
      return deny('PLAN_PROFILE_ONLY', 'a plan profile forwards only its key check and the plan withdrawal');
    }
    if (tool !== 'withdraw') {
      return deny('PLAN_PROFILE_ONLY', 'a plan profile sends only the planned withdrawal');
    }
    if (plan.state === 'dispatched') {
      return deny('PLAN_ALREADY_DISPATCHED', 'this plan was already dispatched');
    }
    if (Date.now() >= plan.expiresAt) return deny('PLAN_EXPIRED', 'the plan expired; nothing was sent');
    if (hashOf(args) !== plan.argsHash) {
      return deny(
        'PLAN_ARGS_CHANGED',
        'the withdrawal arguments differ from the prepared plan; nothing was sent',
      );
    }
    if (!entry.keyChecked && hasKeyCheck(profile.exchange)) {
      return deny('KEY_CHECK_REQUIRED', 'run the key check on the plan profile first');
    }
    if (
      !claimDispatch(plan.planId, {
        alias: profile.alias,
        argsHash: plan.argsHash,
        at: new Date().toISOString(),
      })
    ) {
      plan.state = 'dispatched';
      return deny(
        'PLAN_ALREADY_DISPATCHED',
        'this plan was already dispatched (journal); nothing was sent again',
      );
    }
    plan.state = 'dispatched';
    return { allowed: true };
  }

  /** What the agent must tell the user about a new profile: account, key and role scope. */
  #connectFacts(exchange, role, alias, source, withPassphrase) {
    const sameAccountAs = [...this.#profiles.values()]
      .filter((other) => other.profile.exchange === exchange && other.profile.alias !== alias)
      .filter((other) => sourceKey(other.source) === sourceKey(source))
      .map((other) => other.profile.alias);
    const label = exchangeLabel(exchange);
    const account =
      source.kind === 'manual'
        ? {
            credentials: manualFields(exchange).map(
              (field) => `${fieldLabel(exchange, field)} (private card, memory only)`,
            ),
            sameAccountAs,
            note:
              `Entered manually in this chat's private cards: one ${label} account, and every ${exchange} role ` +
              'of this credential set uses this same key. fundkit trusts that mapping; it does not read, store ' +
              'or compare an account UID.',
          }
        : {
            credentials: withPassphrase
              ? [...dopplerNames(exchange), 'API passphrase (private step, memory only)']
              : dopplerNames(exchange),
            sameAccountAs,
            note:
              `One Doppler config holds one ${label} account: every ${exchange} role in this ` +
              "session uses this same key. fundkit trusts the operator's mapping of this exchange to these " +
              'names; it does not read, store or compare an account UID.',
          };
    return {
      account,
      keyCapability:
        'Not verified by fundkit. The key may hold withdrawal or transfer rights on the exchange; report ' +
        'what the venue key check shows, and call the key read-only only if the check shows that.',
      roleScope: describeRole(role),
      venueScope: venueScopeNotes(exchange),
    };
  }

  #fetchFailed(fail, alias, error, exchange) {
    switch (error.code) {
      case 'TOKEN_REJECTED':
        this.#log(`Doppler rejected the token while fetching for ${alias}`);
        if (this.#options.headless) {
          // Manual credential sets stay; only Doppler and its profiles go.
          fail(error.code, `${error.message}. Doppler was disconnected; nothing else changed.`, {
            retryChoice: true,
            exchanges: [exchange],
          });
          this.#dropDoppler('Doppler rejected the token');
          return this.#endIfIdle();
        }
        fail(error.code, `${error.message}. The session has ended; start a new one with: fundkit session`);
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

  #startProfile({ client, alias, exchange, role, credentials, serverPath, account, source }) {
    let entry = null;
    const profile = new ProfileProcess({
      alias,
      exchange,
      role,
      account: { exchange, ...(account ?? this.#accountFor(role)) },
      serverPath,
      credentials,
      alsoRedact: [
        ...(this.#doppler?.valuesToRedact() ?? []),
        ...this.#passphrases.values(),
        ...this.#vault.values(),
      ],
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
    entry = new ProfileEntry(profile, client, {
      kind: source.kind,
      scopeId: source.scopeId,
      tag: source.tag,
    });
    this.#profiles.set(alias, entry);
    client.aliases.add(alias);
    return entry;
  }

  // ------------------------------------------------------------------ calls

  #forward(client, { alias, msg, call }) {
    const entry = this.#profiles.get(alias);
    if (entry?.owner !== client || !msg || typeof msg !== 'object') return;
    if (msg.method === 'tools/call') {
      const tool = String(msg.params?.name ?? '');
      const args = msg.params?.arguments ?? {};
      const decision = entry.plan
        ? this.#authorizePlanCall(entry, tool, args, call?.channel)
        : authorizeCall({
            profile: entry.profile,
            channel: call?.channel === 'write' ? 'write' : 'read',
            tool,
            args,
            keyChecked: entry.keyChecked,
            provisioning: this.#options.provisioning,
          });
      if (!decision.allowed) {
        this.#log(`${alias}: refused ${msg.params?.name} (${decision.code})`);
        client.send({ t: 'rpc', alias, msg: toolError(msg.id, decision) });
        return;
      }
      if (msg.id !== undefined && isKeyCheckCall(entry.profile.exchange, tool, args)) {
        entry.keyChecksInFlight.add(msg.id);
      }
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
    if (isResponse && entry.keyChecksInFlight.delete(msg.id)) {
      // Only success matters here; whatever metadata the result holds (it may name a UID) is not kept.
      if (msg.result && !msg.result.isError) entry.keyChecked = true;
      else if (entry.source.kind === 'manual' && isAuthFailure(msg)) this.#rejectManual(entry);
    }
    entry.owner.send({ t: 'rpc', alias: entry.profile.alias, msg });
  }

  #stopProfile(alias, reason) {
    const entry = this.#profiles.get(alias);
    if (!entry) return;
    this.#log(`${alias}: ${reason}`);
    entry.profile.stop();
  }

  /** End the session: drop every credential, stop every profile, remove socket and files. */
  async end(reason) {
    if (this.#ending) return;
    this.#ending = true;
    this.#doppler?.drop();
    this.#passphrases.clear();
    this.#vault.clear();
    this.#passphraseSteps.clear();
    this.#log(`session ended: ${reason}`);
    clearTimeout(this.#ttlTimer);
    clearTimeout(this.#idleTimer);
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
