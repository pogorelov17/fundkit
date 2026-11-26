// The host-side view of one connected session profile: JSON-RPC ids and pending requests.

export class ProfileLink {
  #nextId = 1;
  #pending = new Map();
  #send;

  /**
   * @param {object} spec  alias, exchange, role, dryRun, configPath, send(msg, call)
   */
  constructor({ alias, exchange, role, dryRun, configPath, send }) {
    this.alias = alias;
    this.exchange = exchange;
    this.role = role;
    this.dryRun = dryRun;
    this.configPath = configPath;
    this.tools = [];
    this.#send = send;
  }

  /**
   * Send a request and resolve with the JSON-RPC response ({result} or {error}).
   * `timeoutMs` of 0 waits without limit (money moves: the human may take up to 300 s).
   * `onSent(id)` receives the request id, for cancellation. `call` ({channel}) goes to the
   * session daemon, which decides the call by the profile's role.
   */
  request(method, params, { timeoutMs = 0, onSent, call } = {}) {
    const id = this.#nextId++;
    return new Promise((resolve) => {
      let timer = null;
      this.#pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          if (this.#pending.delete(id)) {
            resolve({ error: { code: -32001, message: `no answer within ${timeoutMs / 1000} s` } });
          }
        }, timeoutMs);
      }
      onSent?.(id);
      this.#send({ jsonrpc: '2.0', id, method, params }, call);
    });
  }

  notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) });
  }

  respond(id, body) {
    this.#send({ jsonrpc: '2.0', id, ...body });
  }

  /** Deliver a response from the profile; returns false if nothing was waiting for it. */
  resolve(response) {
    const settle = this.#pending.get(response.id);
    if (!settle) return false;
    this.#pending.delete(response.id);
    settle(response);
    return true;
  }

  /** Fail every open request: the profile is gone, so an open money move has an unknown outcome. */
  fail(reason) {
    const message =
      `${reason}. If this was a withdraw or transfer, its outcome is unknown: ` +
      'reconcile (SKILL.md 2.7), do not retry.';
    for (const settle of this.#pending.values()) settle({ error: { code: -32000, message } });
    this.#pending.clear();
  }
}
