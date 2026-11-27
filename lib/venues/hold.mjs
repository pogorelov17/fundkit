// A hold: an error with `hold: true`, a code and the exact reason. Nothing is sent after one.

import { codedError } from '../util.mjs';

export function hold(code, detail, extra = {}) {
  return codedError(code, detail, { hold: true, ...extra });
}
