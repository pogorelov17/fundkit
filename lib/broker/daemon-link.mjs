// The host-side broker's connection to a running session daemon.

import net from 'node:net';
import { onJsonLines, writeJsonLine } from '../ndjson.mjs';
import { socketPath } from '../paths.mjs';

const SESSION_ENDED = Object.freeze({
  t: 'error',
  code: 'SESSION_ENDED',
  message: 'the fundkit session ended',
});

export class DaemonLink {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #handlers;
  #lost = false;

  /**
   * @param {net.Socket} socket  a connected control socket
   * @param {object} handlers    onPush(message) for unsolicited messages, onLost() once
   */
  constructor(socket, handlers) {
    this.#socket = socket;
    this.#handlers = handlers;
    onJsonLines(socket, (message) => this.#receive(message));
    const lost = () => this.#onLost();
    socket.on('close', lost);
    socket.on('error', lost);
  }

  /** Connect to the session socket, or resolve null when no session is running. */
  static open(handlers) {
    return new Promise((resolve) => {
      const socket = net.connect(socketPath());
      socket.once('connect', () => resolve(new DaemonLink(socket, handlers)));
      socket.once('error', () => resolve(null));
    });
  }

  get closed() {
    return this.#lost;
  }

  /** Send a control request and resolve with its reply (SESSION_ENDED if the link drops). */
  request(message) {
    if (this.#lost) return Promise.resolve(SESSION_ENDED);
    const id = this.#nextId++;
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      writeJsonLine(this.#socket, { ...message, id });
    });
  }

  /** Relay one JSON-RPC message to a profile; fire and forget. */
  sendRpc(alias, msg) {
    if (!this.#lost) writeJsonLine(this.#socket, { t: 'rpc', alias, msg });
  }

  close() {
    this.#socket.end();
  }

  #receive(message) {
    const resolve = message.id !== undefined ? this.#pending.get(message.id) : undefined;
    if (resolve) {
      this.#pending.delete(message.id);
      resolve(message);
      return;
    }
    this.#handlers.onPush(message);
  }

  #onLost() {
    if (this.#lost) return;
    this.#lost = true;
    for (const resolve of this.#pending.values()) resolve(SESSION_ENDED);
    this.#pending.clear();
    this.#handlers.onLost();
  }
}
