// API passphrases (OKX, Bitget, KuCoin) for one session. They are never in Doppler, the chat,
// argv, a file or the host: the operator types each one in a private terminal, once per
// exchange and session, and it lives only in this process's memory until the session ends.

import { exchangeLabel } from '../exchanges.mjs';
import { readHiddenLine } from '../terminal.mjs';

export const PASSPHRASE_PROMPT_TIMEOUT_MS = 300_000;

/** Prompt text for one exchange; shared by the session terminal and `fundkit passphrase`. */
export function passphrasePrompt(exchange) {
  return `${exchangeLabel(exchange)} API passphrase (for the key in ${exchange.toUpperCase()}_APIKEY): `;
}

/**
 * State per exchange: absent → prompting → present, or → cancelled / timed-out (reported once
 * to the next connect, then absent again). Prompts on the session terminal run one at a time.
 */
export class PassphraseStore {
  #values = new Map();
  #outcomes = new Map();
  #prompts = new Map(); // exchange -> AbortController of the running terminal prompt
  #queue = Promise.resolve();
  #canPrompt;
  #log;

  /**
   * @param {object} options
   * @param {boolean} options.canPrompt  true when this process may prompt on its own terminal
   *                                     (not when it runs the host in that terminal)
   * @param {(line: string) => void} options.log
   * @param {Map<string,string>} [options.initial]  passphrases typed before the session started
   */
  constructor({ canPrompt, log, initial = new Map() }) {
    this.#canPrompt = canPrompt;
    this.#log = log;
    for (const [exchange, value] of initial) this.#values.set(exchange, value);
    initial.clear();
  }

  get canPrompt() {
    return this.#canPrompt;
  }

  get(exchange) {
    return this.#values.get(exchange);
  }

  /** Every passphrase held, for redaction. */
  values() {
    return [...this.#values.values()];
  }

  /**
   * Where `exchange` stands: 'present', 'prompting', 'cancelled', 'timed-out' or 'absent'.
   * A cancelled or timed-out outcome is reported once.
   */
  takeStatus(exchange) {
    if (this.#values.has(exchange)) return 'present';
    if (this.#prompts.has(exchange)) return 'prompting';
    const outcome = this.#outcomes.get(exchange);
    this.#outcomes.delete(exchange);
    return outcome ?? 'absent';
  }

  /** Keep a passphrase typed in another terminal; ends a terminal prompt for it. */
  set(exchange, value) {
    const replaced = this.#values.has(exchange);
    this.#values.set(exchange, value);
    this.#outcomes.delete(exchange);
    this.#prompts.get(exchange)?.abort();
    return { replaced };
  }

  /** Ask on the session terminal (queued behind any other prompt). Returns false if it cannot. */
  prompt(exchange, alias) {
    if (!this.#canPrompt) return false;
    if (this.#prompts.has(exchange)) return true;
    const controller = new AbortController();
    this.#prompts.set(exchange, controller);
    this.#queue = this.#queue.then(() => this.#runPrompt(exchange, alias, controller));
    return true;
  }

  async #runPrompt(exchange, alias, controller) {
    if (controller.signal.aborted || this.#values.has(exchange)) {
      this.#prompts.delete(exchange);
      return;
    }
    const label = exchangeLabel(exchange);
    process.stderr.write(
      `\x07\nfundkit: ${alias} needs the ${label} API passphrase. It is not in Doppler and never goes ` +
        'to the chat.\nType it here: input is hidden, Enter submits, Ctrl-C skips. It stays in this ' +
        "session's memory only.\n",
    );
    try {
      const value = await readHiddenLine(passphrasePrompt(exchange), {
        allowSpace: true,
        timeoutMs: PASSPHRASE_PROMPT_TIMEOUT_MS,
        signal: controller.signal,
      });
      if (value.length === 0) {
        this.#outcomes.set(exchange, 'cancelled');
        this.#log(`${label} passphrase: empty input, nothing kept`);
      } else {
        this.#values.set(exchange, value);
        this.#log(`${label} passphrase kept in memory for this session; go back to the chat`);
      }
    } catch (error) {
      if (error.code === 'TIMEOUT') this.#outcomes.set(exchange, 'timed-out');
      else if (error.code !== 'ABORTED') this.#outcomes.set(exchange, 'cancelled');
      this.#log(
        `${label} passphrase: ${error.code === 'ABORTED' ? 'received from another terminal' : error.message}`,
      );
    } finally {
      this.#prompts.delete(exchange);
    }
  }

  /** Forget everything and stop any prompt. */
  clear() {
    for (const controller of this.#prompts.values()) controller.abort();
    this.#prompts.clear();
    this.#values.clear();
    this.#outcomes.clear();
  }
}
