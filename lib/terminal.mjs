// Hidden input from the controlling terminal. Values typed here never touch stdin, argv,
// the environment or a file, and the terminal never echoes them.

import fs from 'node:fs';
import tty from 'node:tty';
import { codedError } from './util.mjs';

const KEY = Object.freeze({
  CTRL_C: 0x03,
  CTRL_D: 0x04,
  BACKSPACE: 0x08,
  LINE_FEED: 0x0a,
  CARRIAGE_RETURN: 0x0d,
  CTRL_U: 0x15,
  ESCAPE: 0x1b,
  CSI_INTRODUCER: 0x5b,
  DELETE: 0x7f,
});

const DEFAULT_TIMEOUT_MS = 300_000;

/** Bytes accepted as part of a value; `allowSpace` also keeps the space character. */
function isValueByte(byte, allowSpace) {
  if (byte === 0x20) return allowSpace;
  return (byte > 0x20 && byte < KEY.DELETE) || byte >= 0x80;
}

/**
 * Collects keystrokes into a value. Escape sequences (arrow keys and the like) are skipped,
 * Backspace and Ctrl-U edit, Enter submits, Ctrl-C (or Ctrl-D on an empty line) cancels.
 */
class HiddenLine {
  #bytes = [];
  #escapeState = 'none'; // 'none' | 'escape' | 'csi'
  #allowSpace;

  constructor({ allowSpace }) {
    this.#allowSpace = allowSpace;
  }

  /** Feed one byte; returns 'submit', 'cancel' or null to keep reading. */
  feed(byte) {
    if (this.#escapeState === 'escape') {
      this.#escapeState = byte === KEY.CSI_INTRODUCER ? 'csi' : 'none';
      return null;
    }
    if (this.#escapeState === 'csi') {
      if (byte >= 0x40 && byte <= 0x7e) this.#escapeState = 'none';
      return null;
    }
    switch (byte) {
      case KEY.ESCAPE:
        this.#escapeState = 'escape';
        return null;
      case KEY.CTRL_C:
        return 'cancel';
      case KEY.CTRL_D:
        return this.#bytes.length === 0 ? 'cancel' : null;
      case KEY.CARRIAGE_RETURN:
      case KEY.LINE_FEED:
        return 'submit';
      case KEY.BACKSPACE:
      case KEY.DELETE:
        this.#bytes.pop();
        return null;
      case KEY.CTRL_U:
        this.wipe();
        return null;
      default:
        if (isValueByte(byte, this.#allowSpace)) this.#bytes.push(byte);
        return null;
    }
  }

  value() {
    return Buffer.from(this.#bytes).toString('utf8');
  }

  wipe() {
    this.#bytes.fill(0);
    this.#bytes = [];
  }
}

/**
 * Show `prompt` on /dev/tty and read one hidden line. Echo is turned off before the prompt
 * appears, so typed-ahead input is never shown. Rejects with code NO_TTY, CANCELLED or TIMEOUT.
 * `signal` (an AbortSignal) cancels the read from outside, for example when the value arrives
 * another way.
 */
export function readHiddenLine(prompt, { timeoutMs = DEFAULT_TIMEOUT_MS, allowSpace = false, signal } = {}) {
  let fd;
  try {
    fd = fs.openSync('/dev/tty', 'r+');
  } catch {
    return Promise.reject(codedError('NO_TTY', 'no controlling terminal'));
  }
  // One stream owns the descriptor and closes it; output goes straight to the same fd.
  const input = new tty.ReadStream(fd);
  input.setRawMode(true);
  fs.writeSync(fd, prompt);
  input.resume();

  const line = new HiddenLine({ allowSpace });
  return new Promise((resolve, reject) => {
    let timer = null;
    const finish = (error, value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      input.removeAllListeners('data');
      try {
        input.setRawMode(false);
      } catch {
        // The terminal may already be gone (hangup); nothing to restore then.
      }
      try {
        fs.writeSync(fd, '\n');
      } catch {
        // Same as above.
      }
      input.destroy();
      line.wipe();
      if (error) reject(error);
      else resolve(value);
    };
    function onAbort() {
      finish(codedError('ABORTED', 'no longer needed'));
    }
    timer = setTimeout(() => finish(codedError('TIMEOUT', 'timed out')), timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });

    input.on('data', (chunk) => {
      for (const byte of chunk) {
        const outcome = line.feed(byte);
        if (outcome === 'cancel') return finish(codedError('CANCELLED', 'cancelled'));
        if (outcome === 'submit') return finish(null, line.value());
      }
      chunk.fill(0);
    });
  });
}
