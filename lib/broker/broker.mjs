// `fundkit mcp`: the MCP server the host launches. It holds no token and no credential; it
// relays tool calls to session profiles through the session daemon and forwards ccxt-mcp's
// native confirmation form to the host unchanged.

import { DEFAULT_PROTOCOL_VERSION, VERSION } from '../constants.mjs';
import { onJsonLines } from '../ndjson.mjs';
import { DaemonLink } from './daemon-link.mjs';
import { ProfileLink } from './profile-link.mjs';
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
    const id = `fk-${this.#nextHostRequestId++}`;
    return new Promise((resolve) => {
      this.#hostPending.set(id, resolve);
      this.#writeToHost({ id, method: 'elicitation/create', params });
    });
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

  async #toolConnect({ exchange, role }) {
    const daemon = await this.#attach();
    if (!daemon) {
      return errorResult({
        error: 'NO_SESSION',
        message: this.#lastEnd ?? 'no fundkit session is running',
        ...START_STEP,
      });
    }
    const reply = await daemon.request({ t: 'connect', exchange, role });
    if (reply.t === 'error') {
      return errorResult({
        error: reply.code,
        message: reply.message,
        missing: reply.missing,
        userStep: reply.userStep,
        ...(RESTART_STEP_CODES.has(reply.code) ? START_STEP : {}),
      });
    }
    if (reply.already && this.#profiles.has(reply.alias)) {
      return textResult({ alias: reply.alias, already: true });
    }

    const profile = new ProfileLink({
      ...reply,
      send: (msg, call) => daemon.sendRpc(reply.alias, msg, call),
    });
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
      return errorResult({ error: 'SERVER_START_FAILED', message: init.error.message });
    }
    profile.notify('notifications/initialized');
    const listed = await profile.request('tools/list', {}, { timeoutMs: TOOLS_LIST_TIMEOUT_MS });
    profile.tools = (listed.result?.tools ?? []).map((tool) => tool.name);
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
        error: 'UNKNOWN_ALIAS',
        message: `${args.alias} is not a connected session profile (fundkit_profiles lists them)`,
        ...(daemon ? {} : START_STEP),
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
