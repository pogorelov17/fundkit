// Small helpers without fundkit-specific knowledge.

const DURATION_UNITS_MS = { s: 1000, m: 60_000, h: 3_600_000 };

/** Parse `90`, `90s`, `15m` or `8h` into milliseconds. */
export function parseDuration(text) {
  const match = /^(\d+)([smh])?$/.exec(String(text));
  if (!match) throw new Error(`bad duration: ${text}`);
  const [, amount, unit = 's'] = match;
  return Number(amount) * DURATION_UNITS_MS[unit];
}

/** UTC timestamp without milliseconds, as shown in logs and records. */
export function nowIso() {
  return new Date().toISOString().replace(/\.\d+Z$/, 'Z');
}

/** An Error that carries a machine-readable `code` and optional extra fields. */
export function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code }, extra);
}

/** Resolve after `ms`, without keeping the process alive. */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms).unref());
}
