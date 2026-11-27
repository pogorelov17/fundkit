// `fundkit mcp`: the MCP server the host launches. It holds no token and no credential; it
// relays tool calls to session profiles through the session daemon and forwards ccxt-mcp's
// native confirmation form to the host unchanged. When a request lacks credentials it returns
// one provider choice (Doppler Service Token or manual entry) and, once the operator chose, the
// private cards one at a time; it relays only the file path each card returned, and the session
// daemon reads and deletes the file itself.

import { DEFAULT_PROTOCOL_VERSION, VERSION } from '../constants.mjs';
import { onJsonLines } from '../ndjson.mjs';
import { credentialsArg } from '../credentials.mjs';
import { normalizeExchange } from '../exchanges.mjs';
import { choiceStep } from '../secret-step.mjs';
import { startDaemon } from '../session/spawn.mjs';
import { isStepId } from '../session/vault.mjs';
import { delay } from '../util.mjs';
import { DaemonLink } from './daemon-link.mjs';
import { ProfileLink } from './profile-link.mjs';
import { NativeFlows } from './native.mjs';
import { NAMING_HINT, routeNeeds, serverInstructions, START_STEP, TOOL_DEFINITIONS } from './tools.mjs';

const INIT_TIMEOUT_MS = 60_000;
const TOOLS_LIST_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 180_000;
const EXIT_DELAY_MS = 50;
const CHOICE_CODES = new Set(['CREDENTIALS_NEEDED', 'TOKEN_REJECTED', 'SESSION_ENDED', 'NO_SESSION']);
/** Calls a finished credential step may resume; anything else is dropped from `resume`. */
const RESUME_TOOLS = new Set([
  'fundkit_deposit_address',
  'fundkit_transfer_prepare',
  'fundkit_connect',
  'fundkit_profiles',
]);
const MAX_PATH_LENGTH = 4096;
const SESSION_RESTART_DELAY_MS = 300;

/** A resume call the agent passed back, or null when it is not one fundkit offers. */
function resumeOf(value) {
  if (!value || typeof value !== 'object' || !RESUME_TOOLS.has(value.tool)) return null;
  const args = value.arguments;
  return {
    tool: value.tool,
    arguments: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
  };
}

/** Supported exchanges named in a request, deduplicated, or null if any is not supported. */
function exchangeNames(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 8) return null;
  const list = values.map(normalizeExchange);
  return list.every(Boolean) ? [...new Set(list)] : null;
}

const JSONRPC = Object.freeze({ METHOD_NOT_FOUND: -32601, INTERNAL_ERROR: -32603 });

function textResult(body, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError };
}

const errorResult = (body) => textResult(body, true);

export class Broker {
  #hostCapabilities = {};
  #hostInfo = {};
  #protocolVersion = DEFAULT_PROTOCOL_VERSION;
  #nextHostRequestId = 1;
  #hostPending = new Map();
  /** @type {DaemonLink|null} */
  #daemon = null;
  /** @type {Map<string, ProfileLink>} */
  #profiles = new Map();
  /** host request id -> {alias, profileRequestId}, for notifications/cancelled */
  #openCalls = new Map();
  #lastEnd = null;
  #native = new NativeFlows(this);
  /** connect request JSON -> promise of the open in flight */
  #opening = new Map();
  /** the background session being started for a credential choice, shared by concurrent calls */
  #starting = null;

  start() {
    onJsonLines(process.stdin, (message) => {
      this.#onHostMessage(message).catch((error) => {
        if (message.id !== undefined && message.method) {
          this.#reply(message.id, {
            error: { code: JSONRPC.INTERNAL_ERROR, message: String(error?.message ?? error) },
          });
        }
      });
    });
    process.stdin.on('end', () => this.#shutdown());
    process.on('SIGTERM', () => this.#shutdown());
  }

  #shutdown() {
    this.#daemon?.close();
    setTimeout(() => process.exit(0), EXIT_DELAY_MS);
  }

  #writeToHost(message) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  }

  #reply(id, body) {
    this.#writeToHost({ id, ...body });
  }

  // ------------------------------------------------------------------ host side (MCP)

  async #onHostMessage(message) {
    const isResponse = message.method === undefined && message.id !== undefined;
    if (isResponse) {
      const settle = this.#hostPending.get(message.id);
      this.#hostPending.delete(message.id);
      settle?.(message);
      return;
    }
    const { id, method, params } = message;
    switch (method) {
      case 'initialize':
        return this.#reply(id, { result: this.#initialize(params ?? {}) });
      case 'notifications/initialized':
        return undefined;
      case 'ping':
        return this.#reply(id, { result: {} });
      case 'tools/list':
        return this.#reply(id, { result: { tools: TOOL_DEFINITIONS } });
      case 'notifications/cancelled':
        return this.#cancel(params ?? {});
      case 'tools/call':
        return this.#reply(id, { result: await this.#callTool(id, params?.name, params?.arguments ?? {}) });
      default:
        if (id !== undefined) {
          this.#reply(id, { error: { code: JSONRPC.METHOD_NOT_FOUND, message: 'method not found' } });
        }
        return undefined;
    }
  }

  #initialize(params) {
    this.#hostCapabilities = params.capabilities ?? {};
    this.#hostInfo = params.clientInfo ?? {};
    if (typeof params.protocolVersion === 'string') this.#protocolVersion = params.protocolVersion;
    return {
      protocolVersion: this.#protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fundkit', version: VERSION },
      instructions: serverInstructions(),
    };
  }

  #cancel({ requestId, reason }) {
    const call = this.#openCalls.get(requestId);
    if (!call) return;
    this.#daemon?.sendRpc(call.alias, {
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: call.profileRequestId, reason },
    });
  }

  /** Ask the host for the native form and resolve with its JSON-RPC response. */
  #elicit(params) {
    return this.elicit(params).response;
  }

  /**
   * Ask the host for a form. Returns {response, cancel}: `response` resolves with the host's
   * JSON-RPC response, or with {cancelled: true} after `cancel(reason)`, which also tells the
   * host to close the form. A late answer after cancel is ignored.
   */
  elicit(params) {
    const id = `fk-${this.#nextHostRequestId++}`;
    let settle;
    const response = new Promise((resolve) => {
      settle = resolve;
      this.#hostPending.set(id, resolve);
      this.#writeToHost({ id, method: 'elicitation/create', params });
    });
    const cancel = (reason) => {
      if (!this.#hostPending.delete(id)) return;
      this.#writeToHost({ method: 'notifications/cancelled', params: { requestId: id, reason } });
      settle({ cancelled: true });
    };
    return { response, cancel };
  }

  // ------------------------------------------------------------------ session side

  /** Connect to the running session once; null when none is running. */
  async #attach() {
    if (this.#daemon && !this.#daemon.closed) return this.#daemon;
    const link = await DaemonLink.open({
      onPush: (message) => this.#onDaemonPush(message),
      onLost: () => this.#onDaemonLost(link),
    });
    if (!link) return null;
    this.#daemon = link;
    const host = `${this.#hostInfo.name ?? 'host'} ${this.#hostInfo.version ?? ''}`.trim();
    const hello = await link.request({ t: 'hello', host });
    if (hello.t !== 'hello') return null;
    this.#lastEnd = null;
    return link;
  }

  #onDaemonLost(link) {
    if (this.#daemon !== link) return;
    this.#daemon = null;
    for (const alias of [...this.#profiles.keys()]) {
      this.#dropProfile(alias, this.#lastEnd ?? 'the fundkit session ended');
    }
  }

  #onDaemonPush(message) {
    switch (message.t) {
      case 'rpc':
        return this.#onProfileMessage(message.alias, message.msg);
      case 'exit':
        return this.#dropProfile(message.alias, 'the profile server stopped');
      case 'end':
        this.#lastEnd = `the fundkit session ended: ${message.reason}`;
        return undefined;
      default:
        return undefined;
    }
  }

  #dropProfile(alias, reason) {
    const profile = this.#profiles.get(alias);
    if (!profile) return;
    this.#profiles.delete(alias);
    profile.fail(reason);
  }

  async #onProfileMessage(alias, message) {
    const profile = this.#profiles.get(alias);
    if (!profile) return;
    if (message.method === undefined) {
      if (message.id !== undefined) profile.resolve(message);
      return;
    }
    if (message.id === undefined) return; // notifications from ccxt-mcp are not forwarded
    if (message.method === 'ping') {
      profile.respond(message.id, { result: {} });
      return;
    }
    if (message.method === 'elicitation/create' && profile.planId) {
      // A plan profile's form is re-shown with the plan's fields; never forwarded raw, never
      // answered without the human (lib/broker/native.mjs).
      const answer = await this.#native.answerPlanForm(profile, message.params);
      profile.respond(message.id, { result: answer });
      return;
    }
    if (message.method === 'elicitation/create' && this.#hostCapabilities.elicitation) {
      // The native confirmation form goes to the host unchanged; the human's answer goes back.
      const answer = await this.#elicit(message.params);
      profile.respond(message.id, answer.error ? { error: answer.error } : { result: answer.result });
      return;
    }
    profile.respond(message.id, {
      error: { code: JSONRPC.METHOD_NOT_FOUND, message: 'not supported by the fundkit broker' },
    });
  }

  // ------------------------------------------------------------------ tools

  #callTool(hostRequestId, name, args) {
    switch (name) {
      case 'fundkit_profiles':
        return this.#toolProfiles(args);
      case 'fundkit_connect':
        return this.#toolConnect(args);
      case 'fundkit_disconnect':
        return this.#toolDisconnect(args);
      case 'fundkit_credentials':
        return this.#toolCredentials(args);
      case 'fundkit_secret_submit':
        return this.#toolSecretSubmit(args);
      case 'fundkit_secret_cancel':
        return this.#toolSecretCancel(args);
      case 'fundkit_deposit_address':
        return this.#native.depositAddress(args);
      case 'fundkit_transfer_prepare':
        return this.#native.transferPrepare(args);
      case 'fundkit_transfer_confirm':
        return this.#native.transferConfirm(args);
      case 'fundkit_transfer_status':
        return this.#native.transferStatus(args);
      case 'fundkit_read':
        return this.#toolForward(hostRequestId, args, { write: false });
      case 'fundkit_write':
        return this.#toolForward(hostRequestId, args, { write: true });
      default:
        return errorResult({ error: 'UNKNOWN_TOOL' });
    }
  }

  async #toolProfiles({ from, to, credentials: given }) {
    const credentials = credentialsArg(given);
    const needs = from || to ? routeNeeds(from, to) : undefined;
    const route = exchangeNames([from, to].filter(Boolean));
    const resume = {
      tool: 'fundkit_profiles',
      arguments: {
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
        ...(credentials ? { credentials } : {}),
      },
    };
    const check = route ? await this.checkCredentials(route, credentials, resume) : null;
    const choice = check ? { missingCredentials: check.missing, choiceStep: check.choiceStep, resume } : {};
    const daemon = await this.#attach();
    if (!daemon) {
      return textResult({
        session: 'none',
        note: this.#lastEnd ?? 'no fundkit session is running',
        needs,
        ...choice,
        ...START_STEP,
        naming: NAMING_HINT,
      });
    }
    const { session = {} } = await daemon.request({ t: 'status' });
    for (const item of needs ?? []) {
      item.connected = [...this.#profiles.values()].some(
        (profile) => profile.exchange === item.exchange && profile.role === item.role,
      );
    }
    const profiles = [...this.#profiles.values()].map((profile) => ({
      alias: profile.alias,
      exchange: profile.exchange,
      role: profile.role,
      dryRun: profile.dryRun,
      credentials: profile.source,
      registration: `fundkit/${profile.alias}`,
      configPath: profile.configPath,
    }));
    return textResult({
      session: 'active',
      expires: session.expires,
      doppler: session.doppler,
      writes: session.writes,
      maxTransferValue: session.maxTransferValue,
      maxDailyValue: session.maxDailyValue,
      profiles,
      needs,
      ...choice,
    });
  }

  /**
   * The answer when `exchanges` have no credentials: exactly one choice, before any secret card,
   * between a Doppler Service Token and a manual entry. Nothing starts until the operator picks.
   */
  credentialsNeeded(exchanges, { credentials, resume, why, code = 'CREDENTIALS_NEEDED', message } = {}) {
    return {
      error: code,
      message: message ?? why ?? this.#lastEnd ?? 'these exchanges have no credentials in this session',
      missing: exchanges,
      choiceStep: choiceStep({ exchanges, credentials, resume, why }),
      ...(resume ? { resume } : {}),
      next:
        'Show choiceStep now (one question, two options, Doppler Service Token first). Nothing was read or ' +
        'started; only the option the operator selects runs.',
      ...START_STEP,
    };
  }

  /**
   * null when every exchange has credentials for this caller (its manual set, else Doppler);
   * otherwise the CREDENTIALS_NEEDED body for the missing ones. Reads nothing secret.
   */
  async checkCredentials(exchanges, credentials, resume) {
    const daemon = await this.#attach();
    if (!daemon) return this.credentialsNeeded(exchanges, { resume });
    const reply = await daemon.request({ t: 'credentials-status', exchanges, credentials });
    if (reply.t !== 'credentials-status') return this.credentialsNeeded(exchanges, { resume });
    if (reply.missing.length === 0) return null;
    const why =
      reply.credentials === 'unknown'
        ? 'The credentials named for this chat are gone (they expired or the session restarted).'
        : undefined;
    return this.credentialsNeeded(reply.missing, {
      credentials: reply.credentials === 'active' ? credentials : null,
      resume,
      why,
    });
  }

  /** The running session, or a new background one without credentials (after a choice only). */
  async #ensureDaemon() {
    const running = await this.#attach();
    if (running) return { daemon: running };
    this.#starting ??= startDaemon({ idle: true }).finally(() => {
      this.#starting = null;
    });
    const started = await this.#starting;
    if (!started.ok) return { error: { error: started.error, message: started.message } };
    const daemon = await this.#attach();
    if (!daemon) return { error: { error: 'DAEMON_FAILED', message: 'the session did not answer' } };
    return { daemon };
  }

  /** What the agent does after a credential step's reply from the session. */
  #credentialReply(reply) {
    if (reply.t === 'secret-step') {
      return textResult({
        status: 'secret-needed',
        provider: reply.provider,
        ...(reply.stored ? { stored: `${reply.stored}: kept in fundkit's memory` } : {}),
        ...(reply.credentials ? { credentials: reply.credentials } : {}),
        secretStep: reply.step,
        next:
          'Open secretStep.request in the private card now, then call secretStep.submit with the file path ' +
          'it returned. Say nothing about the value.',
      });
    }
    if (reply.t === 'credentials-ready') {
      return textResult({
        status: 'ready',
        provider: reply.provider,
        ...(reply.already ? { already: true } : {}),
        ...(reply.stored ? { stored: `${reply.stored}: kept in fundkit's memory` } : {}),
        ...(reply.doppler ? { doppler: reply.doppler } : {}),
        ...(reply.credentials ? { credentials: reply.credentials } : {}),
        ...(reply.connected ? { connected: reply.connected } : {}),
        resume: reply.resume ?? null,
        next: reply.resume
          ? 'Call resume.tool with resume.arguments now, in the same turn. Do not ask the user anything, and ' +
            'pass `credentials` on every later fundkit call in this chat.'
          : 'Continue the request.',
      });
    }
    const body = {
      error: reply.code ?? 'SESSION_ENDED',
      message: reply.message ?? 'the fundkit session ended',
      ...(reply.credentials ? { credentials: reply.credentials } : {}),
    };
    if (reply.retry) {
      return errorResult({
        ...body,
        retry: reply.retry,
        next:
          'Tell the user in one sentence why it was refused. Then open retry.request once more and submit ' +
          'it; if they cancel that card, call retry.ifCancelled.',
      });
    }
    if (reply.retryChoice && reply.exchanges?.length) {
      const choice = this.credentialsNeeded(reply.exchanges, {
        credentials: reply.credentials,
        resume: reply.resume,
        code: body.error,
        message: body.message,
        why: body.message,
      });
      return errorResult({
        ...choice,
        next:
          'Tell the user in one sentence what happened. Then show choiceStep once more: the Doppler Service ' +
          'Token again or manual entry. Nothing is chosen for them; with no selection, stop.',
      });
    }
    return errorResult(body);
  }

  async #toolCredentials({ provider, exchanges, credentials, resume }) {
    if (provider !== 'doppler' && provider !== 'manual') {
      return errorResult({ error: 'BAD_PROVIDER', message: 'provider is "doppler" or "manual"' });
    }
    const list = exchangeNames(exchanges);
    if (!list) return errorResult({ error: 'UNKNOWN_EXCHANGE', message: 'name 1 to 8 supported exchanges' });
    const request = {
      t: 'credentials-start',
      provider,
      exchanges: list,
      credentials: credentialsArg(credentials),
      resume: resumeOf(resume),
    };
    let reply = null;
    // A background session that just ended for being idle is started again once.
    for (let attempt = 0; attempt < 2 && (!reply || reply.code === 'SESSION_ENDED'); attempt += 1) {
      if (attempt > 0) await delay(SESSION_RESTART_DELAY_MS);
      const started = await this.#ensureDaemon();
      if (started.error) return errorResult(started.error);
      reply = await started.daemon.request(request);
    }
    return this.#credentialReply(reply);
  }

  async #toolSecretSubmit({ stepId, file }) {
    if (!isStepId(stepId)) return errorResult({ error: 'STEP_UNKNOWN', message: 'unknown stepId' });
    if (typeof file !== 'string' || file.length === 0 || file.length > MAX_PATH_LENGTH) {
      return errorResult({ error: 'FILE_PATH', message: 'give the absolute path the card returned' });
    }
    const daemon = await this.#attach();
    if (!daemon) {
      return errorResult({
        error: 'STEP_UNKNOWN',
        message:
          'no fundkit session is running (it ended or restarted), so nothing was read and the file was left ' +
          'for the host to remove. Repeat the original request to get the credentials choice again.',
      });
    }
    return this.#credentialReply(await daemon.request({ t: 'secret-file', stepId, file }));
  }

  async #toolSecretCancel({ stepId }) {
    if (!isStepId(stepId)) return errorResult({ error: 'STEP_UNKNOWN', message: 'unknown stepId' });
    const daemon = await this.#attach();
    const reply = daemon ? await daemon.request({ t: 'secret-cancel', stepId }) : null;
    if (reply && reply.t !== 'secret-cancelled') return this.#credentialReply(reply);
    const exchanges = reply?.exchanges ?? [];
    const kept = reply?.kept ?? [];
    const dropped = reply?.discarded ? ', and the unfinished entry for that exchange was dropped' : '';
    const body = {
      status: 'cancelled',
      kept,
      discardedFields: reply?.discarded ?? 0,
      note:
        `Nothing from the cancelled card was kept${dropped}.` +
        (kept.length ? ` Still connected for this chat: ${kept.join(', ')}.` : ''),
    };
    if (exchanges.length === 0) return textResult({ ...body, next: 'Say so and stop.' });
    const choice = this.credentialsNeeded(exchanges, {
      credentials: reply.credentials,
      resume: reply.resume,
      why: 'The private card was cancelled.',
    });
    return textResult({
      ...body,
      choiceStep: choice.choiceStep,
      resume: choice.resume,
      next:
        'Say the card was cancelled and nothing from it was kept. Then show choiceStep once more; if the ' +
        'operator selects nothing, stop: nothing more is connected and no card opens.',
    });
  }

  /**
   * Ask the session for a profile and start talking MCP to it. `request` is {exchange, role} or
   * {exchange, planId}. Resolves {profile, reply, init} or {error: <tool error body>}.
   */
  openProfile(request, options = {}) {
    // Concurrent calls for the same profile share one connect, so one alias never gets two
    // server processes.
    const key = JSON.stringify(request);
    const pending = this.#opening.get(key);
    if (pending) return pending.then((opened) => (opened.error ? opened : { ...opened, already: true }));
    const opening = this.#openProfile(request, options).finally(() => this.#opening.delete(key));
    this.#opening.set(key, opening);
    return opening;
  }

  async #openProfile(request, { resume } = {}) {
    const credentials = credentialsArg(request.credentials);
    const daemon = await this.#attach();
    if (!daemon) return { error: this.credentialsNeeded([normalizeExchange(request.exchange)], { resume }) };
    const reply = await daemon.request({ t: 'connect', ...request, ...(resume ? { resume } : {}) });
    if (reply.t === 'error') {
      if (CHOICE_CODES.has(reply.code) && !request.planId) {
        const exchanges = reply.missing ?? reply.exchanges ?? [];
        return {
          error: this.credentialsNeeded(
            exchanges.length ? exchanges : [normalizeExchange(request.exchange)],
            {
              credentials,
              resume,
              code: reply.code,
              message: reply.message,
            },
          ),
        };
      }
      return {
        error: {
          error: reply.code,
          message: reply.message,
          missing: reply.missing,
          ...(reply.userStep ? { userStep: reply.userStep } : {}),
          ...(reply.secretStep ? { secretStep: reply.secretStep } : {}),
          ...(resume && reply.secretStep ? { resume } : {}),
        },
      };
    }
    const existing = this.#profiles.get(reply.alias);
    if (reply.already && existing) return { profile: existing, reply, already: true };

    const profile = new ProfileLink({
      ...reply,
      send: (msg, call) => daemon.sendRpc(reply.alias, msg, call),
    });
    profile.planId = reply.planId ?? null;
    profile.source = reply.source ?? 'doppler';
    this.#profiles.set(reply.alias, profile);
    const capabilities = this.#hostCapabilities.elicitation
      ? { elicitation: this.#hostCapabilities.elicitation }
      : {};
    const init = await profile.request(
      'initialize',
      {
        protocolVersion: this.#protocolVersion,
        capabilities,
        clientInfo: { name: `fundkit-broker (${this.#hostInfo.name ?? 'host'})`, version: VERSION },
      },
      { timeoutMs: INIT_TIMEOUT_MS },
    );
    if (init.error) {
      await daemon.request({ t: 'disconnect', alias: reply.alias });
      this.#profiles.delete(reply.alias);
      return { error: { error: 'SERVER_START_FAILED', message: init.error.message } };
    }
    profile.notify('notifications/initialized');
    const listed = await profile.request('tools/list', {}, { timeoutMs: TOOLS_LIST_TIMEOUT_MS });
    profile.tools = (listed.result?.tools ?? []).map((tool) => tool.name);
    return { profile, reply, init };
  }

  /** Stop a profile this broker opened. */
  async closeProfile(alias, reason = 'disconnected') {
    await this.#daemon?.request({ t: 'disconnect', alias });
    this.#dropProfile(alias, reason);
  }

  /** Send a control request to the session; null when no session is running. */
  async sessionRequest(message) {
    const daemon = await this.#attach();
    return daemon ? daemon.request(message) : null;
  }

  get hostElicitation() {
    return Boolean(this.#hostCapabilities.elicitation);
  }

  async #toolConnect({ exchange, role, credentials: given }) {
    const credentials = credentialsArg(given);
    const resume = {
      tool: 'fundkit_connect',
      arguments: { exchange, role, ...(credentials ? { credentials } : {}) },
    };
    const opened = await this.openProfile({ exchange, role, credentials }, { resume });
    if (opened.error) return errorResult(opened.error);
    const { profile, reply, init } = opened;
    if (opened.already) return textResult({ alias: reply.alias, already: true });
    return textResult({
      alias: reply.alias,
      exchange: reply.exchange,
      role: reply.role,
      registration: `fundkit/${reply.alias}`,
      configPath: reply.configPath,
      dryRun: reply.dryRun,
      credentials: reply.source,
      server: init.result?.serverInfo,
      tools: profile.tools,
      fetchedNames: reply.fetched,
      account: reply.account,
      keyCapability: reply.keyCapability,
      roleScope: reply.roleScope,
      venueScope: reply.venueScope,
      next:
        'Run Step 0 on this alias with fundkit_read (get_safety_status, list_accounts) and the venue key ' +
        'check before any plan; recipient reads and money moves need that key check first where the venue ' +
        "has one. Report the key's rights; no account UID is read or compared.",
    });
  }

  async #toolDisconnect({ alias }) {
    if (!this.#profiles.has(alias)) return errorResult({ error: 'UNKNOWN_ALIAS' });
    await this.#daemon?.request({ t: 'disconnect', alias });
    this.#dropProfile(alias, 'disconnected');
    return textResult({ disconnected: alias });
  }

  /**
   * Relay a ccxt-mcp tool call. The session daemon decides it by the profile's role, venue and
   * key check (lib/policy.mjs) and answers a refusal as a tool error.
   */
  async #toolForward(hostRequestId, args, { write }) {
    const tool = String(args.tool ?? '');
    const profile = this.#profiles.get(args.alias);
    if (!profile) {
      const daemon = await this.#attach();
      return errorResult({
        ...(daemon ? {} : { session: 'none', note: this.#lastEnd ?? 'no fundkit session is running' }),
        error: 'UNKNOWN_ALIAS',
        message: `${args.alias} is not a connected session profile (fundkit_profiles lists them)`,
      });
    }
    const response = await profile.request(
      'tools/call',
      { name: tool, arguments: args.arguments ?? {} },
      {
        timeoutMs: write ? 0 : READ_TIMEOUT_MS,
        // An older caller's `uid` is ignored: fundkit binds no account UID.
        call: { channel: write ? 'write' : 'read' },
        onSent: (profileRequestId) =>
          this.#openCalls.set(hostRequestId, { alias: profile.alias, profileRequestId }),
      },
    );
    this.#openCalls.delete(hostRequestId);
    if (response.error) {
      return errorResult({
        error: 'PROFILE_ERROR',
        code: response.error.code,
        message: response.error.message,
      });
    }
    return response.result;
  }
}
