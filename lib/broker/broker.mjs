// `fundkit mcp`: the MCP server the host launches. It holds no token and no credential; it
// relays tool calls to session profiles through the session daemon and forwards ccxt-mcp's
// native confirmation form to the host unchanged.

import { DEFAULT_PROTOCOL_VERSION, VERSION } from '../constants.mjs';
import { onJsonLines } from '../ndjson.mjs';
import { DaemonLink } from './daemon-link.mjs';
import { ProfileLink } from './profile-link.mjs';
import { tokenSecretStep } from '../secret-step.mjs';
import { NativeFlows } from './native.mjs';
import { NAMING_HINT, routeNeeds, serverInstructions, START_STEP, TOOL_DEFINITIONS } from './tools.mjs';

const INIT_TIMEOUT_MS = 60_000;
const TOOLS_LIST_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 180_000;
const EXIT_DELAY_MS = 50;
const RESTART_STEP_CODES = new Set(['TOKEN_REJECTED', 'SESSION_ENDED', 'NO_SESSION']);

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

  async #toolProfiles({ from, to }) {
    const daemon = await this.#attach();
    const needs = from || to ? routeNeeds(from, to) : undefined;
    if (!daemon) {
      return textResult({
        session: 'none',
        note: this.#lastEnd ?? 'no fundkit session is running',
        needs,
        secretStep: tokenSecretStep(),
        ...START_STEP,
        naming: NAMING_HINT,
      });
    }
    const { session = {} } = await daemon.request({ t: 'status' });
    for (const item of needs ?? []) item.connected = Boolean(item.alias && this.#profiles.has(item.alias));
    const profiles = [...this.#profiles.values()].map((profile) => ({
      alias: profile.alias,
      exchange: profile.exchange,
      role: profile.role,
      dryRun: profile.dryRun,
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
    });
  }

  /** The error body for a missing session: one secret step, then the same call again. */
  noSession(resume) {
    return {
      error: 'NO_SESSION',
      message: this.#lastEnd ?? 'no fundkit session is running',
      secretStep: tokenSecretStep(),
      ...(resume ? { resume } : {}),
      ...START_STEP,
    };
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
    const daemon = await this.#attach();
    if (!daemon) return { error: this.noSession(resume) };
    const reply = await daemon.request({ t: 'connect', ...request });
    if (reply.t === 'error') {
      return {
        error: {
          ...(RESTART_STEP_CODES.has(reply.code) ? this.noSession(resume) : {}),
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

  async #toolConnect({ exchange, role }) {
    const opened = await this.openProfile({ exchange, role });
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
        ...(daemon ? {} : this.noSession()),
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
