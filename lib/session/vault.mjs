// Manual credential sets and pending secret steps of one session daemon, in memory only.
//
// A credential set ("scope") belongs to the chat that entered it: its id is returned to that
// chat's agent only, and every later call that should use those keys names it. Another chat,
// a restarted session or an expired set never sees the values. One set holds at most one
// account per exchange; every local role on that exchange uses it, as with Doppler.
//
// A secret step is one private card the agent opens: a Doppler Service Token, a Doppler-path
// API passphrase, or one field of a manual entry (API key, then API secret, then API
// passphrase for OKX, Bitget and KuCoin). Each step is single use and expires; a manual entry
// that is cancelled, expires or fails part-way keeps none of its fields.

import crypto from 'node:crypto';
import { fieldEnvName, manualFields } from '../credentials.mjs';

const SCOPE_ID = /^cs-[0-9a-f]{32}$/;
const STEP_ID = /^st-[0-9a-f]{32}$/;
const RESUME_LIMIT = 2048;
/** Used and expired steps are remembered this long, so a late file is still recognized. */
const RETIRED_LIMIT = 256;

export const isScopeId = (id) => typeof id === 'string' && SCOPE_ID.test(id);
export const isStepId = (id) => typeof id === 'string' && STEP_ID.test(id);

const randomHex = (bytes) => crypto.randomBytes(bytes).toString('hex');

/** A non-secret resume call, kept with a step so the last answer can name it; null if unusable. */
export function boundedResume(resume) {
  if (!resume || typeof resume !== 'object' || typeof resume.tool !== 'string') return null;
  const text = JSON.stringify({ tool: resume.tool, arguments: resume.arguments ?? {} });
  return text.length <= RESUME_LIMIT ? JSON.parse(text) : null;
}

class Scope {
  constructor(id, tag, expiresAt) {
    this.id = id;
    /** short alias suffix, so profiles of different sets never share a process or an alias */
    this.tag = tag;
    this.expiresAt = expiresAt;
    /** @type {Map<string, Map<string, string>>} exchange -> field -> value */
    this.venues = new Map();
    this.complete = new Set();
    this.pending = null;
    this.timer = null;
  }

  wipe(exchange) {
    const fields = this.venues.get(exchange);
    if (fields) {
      for (const field of fields.keys()) fields.set(field, null);
      fields.clear();
    }
    this.venues.delete(exchange);
    this.complete.delete(exchange);
    return fields;
  }
}

export class CredentialVault {
  /** @type {Map<string, Scope>} */
  #scopes = new Map();
  /** @type {Map<string, object>} */
  #steps = new Map();
  /** @type {Map<string, {step: object, why: 'used'|'expired'|'cancelled'}>} */
  #retired = new Map();
  #stepTtlMs;
  #scopeTtlMs;
  #onExpire;

  /**
   * @param {object} options
   * @param {number} options.stepTtlMs   how long one card may take
   * @param {number} options.scopeTtlMs  how long a manual credential set lives
   * @param {(what: object) => void} options.onExpire  told about expired steps and sets
   */
  constructor({ stepTtlMs, scopeTtlMs, onExpire }) {
    this.#stepTtlMs = stepTtlMs;
    this.#scopeTtlMs = scopeTtlMs;
    this.#onExpire = onExpire;
  }

  // ------------------------------------------------------------------ credential sets

  /** The live set with this id, or null (unknown, malformed or expired). */
  scope(id) {
    if (!isScopeId(id)) return null;
    const scope = this.#scopes.get(id);
    if (!scope) return null;
    if (Date.now() >= scope.expiresAt) {
      this.#dropScope(scope, 'expired');
      return null;
    }
    return scope;
  }

  /** The set with this id when it is live, else a new empty one with a new id. */
  openScope(id, { notAfter = Infinity } = {}) {
    const existing = this.scope(id);
    if (existing) return existing;
    let tag;
    do tag = `m${randomHex(3)}`;
    while ([...this.#scopes.values()].some((scope) => scope.tag === tag));
    const expiresAt = Math.min(Date.now() + this.#scopeTtlMs, notAfter);
    const scope = new Scope(`cs-${randomHex(16)}`, tag, expiresAt);
    scope.timer = setTimeout(() => this.#dropScope(scope, 'expired'), expiresAt - Date.now());
    scope.timer.unref();
    this.#scopes.set(scope.id, scope);
    return scope;
  }

  hasVenue(scope, exchange) {
    return Boolean(scope?.complete.has(exchange));
  }

  /** The exchanges of `exchanges` this set has no complete entry for. */
  missing(scope, exchanges) {
    return exchanges.filter((exchange) => !this.hasVenue(scope, exchange));
  }

  /** A fresh Map envName -> value for one exchange's profile process, or null. */
  credentials(scope, exchange) {
    if (!this.hasVenue(scope, exchange)) return null;
    const fields = scope.venues.get(exchange);
    return new Map(manualFields(exchange).map((field) => [fieldEnvName(exchange, field), fields.get(field)]));
  }

  /** The next field to ask for, in request order: API key, API secret, API passphrase. */
  nextField(scope, exchanges) {
    for (const exchange of exchanges) {
      if (this.hasVenue(scope, exchange)) continue;
      const have = scope.venues.get(exchange);
      const field = manualFields(exchange).find((name) => !have?.has(name));
      if (field) return { exchange, field };
    }
    return null;
  }

  /**
   * Keep one field of a manual entry. Returns {complete} or {problem} when the value repeats
   * another field of the same exchange (a pasted key in the secret card), which keeps nothing.
   */
  storeField(scope, exchange, field, value) {
    const fields = scope.venues.get(exchange) ?? new Map();
    if ([...fields.values()].includes(value)) {
      return { problem: 'the value repeats another field of this exchange' };
    }
    fields.set(field, value);
    scope.venues.set(exchange, fields);
    const complete = manualFields(exchange).every((name) => fields.has(name));
    if (complete) scope.complete.add(exchange);
    return { complete };
  }

  /** Drop an unfinished entry for one exchange; returns how many fields it had. */
  discardPartial(scope, exchange) {
    if (!scope || scope.complete.has(exchange)) return 0;
    const count = scope.venues.get(exchange)?.size ?? 0;
    scope.wipe(exchange);
    return count;
  }

  /** Drop one exchange's values from a set, complete or not (the exchange rejected the key). */
  discardVenue(scope, exchange) {
    if (scope) scope.wipe(exchange);
  }

  /** Every manual value held, for redaction. */
  values() {
    const values = [];
    for (const scope of this.#scopes.values()) {
      for (const fields of scope.venues.values()) values.push(...fields.values());
    }
    return values.filter(Boolean);
  }

  summary() {
    const scopes = [...this.#scopes.values()];
    return {
      sets: scopes.length,
      venues: scopes.reduce((count, scope) => count + scope.complete.size, 0),
      pendingSteps: this.#steps.size,
    };
  }

  isEmpty() {
    return this.#steps.size === 0 && [...this.#scopes.values()].every((scope) => scope.venues.size === 0);
  }

  #dropScope(scope, why) {
    if (this.#scopes.get(scope.id) !== scope) return;
    clearTimeout(scope.timer);
    for (const exchange of [...scope.venues.keys()]) scope.wipe(exchange);
    if (scope.pending) this.#dropStep(scope.pending);
    this.#scopes.delete(scope.id);
    this.#onExpire?.({ kind: 'scope', tag: scope.tag, why });
  }

  // ------------------------------------------------------------------ secret steps

  /**
   * Issue one secret step: {kind: 'doppler-token' | 'doppler-passphrase' | 'manual', exchange?,
   * field?, scope?, exchanges?, resume?}. A manual set has at most one step open at a time.
   */
  issue({ kind, exchange = null, field = null, scope = null, exchanges = [], resume = null }) {
    const now = Date.now();
    const step = {
      id: `st-${randomHex(16)}`,
      kind,
      exchange,
      field,
      scopeId: scope?.id ?? null,
      exchanges: [...exchanges],
      resume: boundedResume(resume),
      issuedAt: now,
      expiresAt: now + this.#stepTtlMs,
      timer: null,
    };
    step.timer = setTimeout(() => this.#expireStep(step), this.#stepTtlMs);
    step.timer.unref();
    this.#steps.set(step.id, step);
    if (scope) scope.pending = step;
    return step;
  }

  /** The open step of a manual set, if it still asks for `next` ({exchange, field}). */
  pendingStep(scope, next) {
    const step = scope?.pending;
    if (!step || !this.#steps.has(step.id)) return null;
    return step.exchange === next.exchange && step.field === next.field ? step : null;
  }

  /** The step to look at before consuming its file; null when unknown. */
  peek(id) {
    return isStepId(id) ? (this.#steps.get(id) ?? null) : null;
  }

  /** Remove a step for its one use. Returns {step, expired} or null when unknown or used. */
  take(id, why = 'used') {
    const step = this.peek(id);
    if (!step) return null;
    this.#dropStep(step);
    const expired = Date.now() >= step.expiresAt;
    this.#retire(step, expired ? 'expired' : why);
    return { step, expired };
  }

  /** A step that was used, cancelled or expired: {step, why}, or null when never issued here. */
  retired(id) {
    return isStepId(id) ? (this.#retired.get(id) ?? null) : null;
  }

  #retire(step, why) {
    this.#retired.set(step.id, { step: { ...step, timer: null }, why });
    while (this.#retired.size > RETIRED_LIMIT) this.#retired.delete(this.#retired.keys().next().value);
  }

  /** Cancel a step: the card was dismissed. A manual entry in progress keeps nothing. */
  cancel(id) {
    const taken = this.take(id, 'cancelled');
    if (!taken) return null;
    const { step } = taken;
    const scope = step.scopeId ? this.#scopes.get(step.scopeId) : null;
    const discarded = step.kind === 'manual' ? this.discardPartial(scope, step.exchange) : 0;
    return { step, discarded, scope };
  }

  /** The live set a step belongs to, or null. */
  scopeOf(step) {
    return step.scopeId ? this.scope(step.scopeId) : null;
  }

  #dropStep(step) {
    clearTimeout(step.timer);
    this.#steps.delete(step.id);
    const scope = step.scopeId ? this.#scopes.get(step.scopeId) : null;
    if (scope?.pending === step) scope.pending = null;
  }

  #expireStep(step) {
    if (!this.#steps.has(step.id)) return;
    this.#dropStep(step);
    this.#retire(step, 'expired');
    const scope = step.scopeId ? this.#scopes.get(step.scopeId) : null;
    if (step.kind === 'manual') this.discardPartial(scope, step.exchange);
    this.#onExpire?.({ kind: 'step', step });
  }

  /** Forget everything. */
  clear() {
    for (const step of [...this.#steps.values()]) this.#dropStep(step);
    this.#retired.clear();
    for (const scope of [...this.#scopes.values()]) {
      clearTimeout(scope.timer);
      for (const exchange of [...scope.venues.keys()]) scope.wipe(exchange);
    }
    this.#scopes.clear();
  }
}
