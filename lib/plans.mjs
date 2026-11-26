// Transfer plans: immutable fields, their hash, and the on-disk journal (no secrets).
//
//   <plansDir>/<PLAN-ID>.json           the plan as prepared (written once, exclusive create)
//   <plansDir>/<PLAN-ID>.dispatch       created by the session daemon, exclusively, right
//                                       before it forwards the plan's one money call; never removed
//   <plansDir>/<PLAN-ID>.result.json    the outcome the broker saw
//
// A plan whose .dispatch exists is never dispatched again, whatever restarts in between.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensurePrivateDir, plansDir, writePrivateFile } from './paths.mjs';

const PLAN_ID = /^FK-[A-Z2-7]{8}$/;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** JSON with object keys sorted at every level, so equal values hash equally. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256Hex(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function hashOf(value) {
  return sha256Hex(canonicalJson(value));
}

export function newPlanId() {
  const bytes = crypto.randomBytes(8);
  return `FK-${[...bytes].map((byte) => BASE32[byte & 31]).join('')}`;
}

export function isPlanId(id) {
  return typeof id === 'string' && PLAN_ID.test(id);
}

/** The alias of a plan's single-use source profile; unique, so ccxt-mcp journals never mix. */
export function planAlias(exchange, planId) {
  return `${exchange}-${planId.toLowerCase()}`;
}

function file(planId, suffix) {
  return path.join(plansDir(), `${planId}${suffix}`);
}

/** The plan body without its hash; what the hash covers. */
export function planBody(plan) {
  const body = { ...plan };
  delete body.hash;
  return body;
}

export function savePlan(plan) {
  ensurePrivateDir(plansDir());
  fs.writeFileSync(file(plan.planId, '.json'), `${JSON.stringify(plan, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
}

/** The stored plan, or null when it does not exist or its hash does not match its fields. */
export function loadPlan(planId) {
  if (!isPlanId(planId)) return null;
  try {
    const plan = JSON.parse(fs.readFileSync(file(planId, '.json'), 'utf8'));
    return plan.hash === hashOf(planBody(plan)) ? plan : { tampered: true, planId };
  } catch {
    return null;
  }
}

/** Create the dispatch marker; false if it already exists (the plan was dispatched before). */
export function claimDispatch(planId, note) {
  ensurePrivateDir(plansDir());
  try {
    fs.writeFileSync(file(planId, '.dispatch'), `${JSON.stringify(note)}\n`, { mode: 0o600, flag: 'wx' });
    return true;
  } catch (error) {
    if (error.code === 'EEXIST') return false;
    throw error;
  }
}

export function dispatchClaimed(planId) {
  return fs.existsSync(file(planId, '.dispatch'));
}

export function saveResult(planId, result) {
  ensurePrivateDir(plansDir());
  writePrivateFile(file(planId, '.result.json'), `${JSON.stringify(result, null, 2)}\n`);
}

export function loadResult(planId) {
  try {
    return JSON.parse(fs.readFileSync(file(planId, '.result.json'), 'utf8'));
  } catch {
    return null;
  }
}
