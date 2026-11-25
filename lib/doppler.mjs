// Minimal Doppler client: one endpoint, an explicit name filter, nothing cached.
// https://docs.doppler.com/reference/secrets-download

import { DOPPLER_API } from './constants.mjs';
import { codedError } from './util.mjs';

const DOWNLOAD_PATH = '/v3/configs/config/secrets/download';
const METADATA_NAMES = ['DOPPLER_PROJECT', 'DOPPLER_CONFIG', 'DOPPLER_ENVIRONMENT'];
const REQUEST_TIMEOUT_MS = 15_000;
const LOOPBACK_TEST_API = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/;

/** The API base; a test may point it at a loopback mock, never anywhere else. */
function apiBase() {
  const override = process.env.FUNDKIT_DOPPLER_API;
  if (!override) return DOPPLER_API;
  if (LOOPBACK_TEST_API.test(override)) return override;
  throw new Error('FUNDKIT_DOPPLER_API may only point to a loopback test server');
}

function isDopplerMetadata(name) {
  return name.startsWith('DOPPLER_');
}

/** Overwrite every value of a parsed response so it is not kept around by accident. */
function scrub(body) {
  for (const name of Object.keys(body)) body[name] = null;
}

export class DopplerClient {
  #token;

  constructor(token) {
    this.#token = token;
  }

  /** Values that must never appear in anything a profile prints. */
  valuesToRedact() {
    return this.#token ? [this.#token] : [];
  }

  /** Forget the token; every later request fails with TOKEN_DROPPED. */
  drop() {
    this.#token = null;
  }

  /** Check the token with Doppler's own metadata names and return {project, config}. */
  async identify() {
    const body = await this.#download(METADATA_NAMES);
    const identity = {
      project: String(body.DOPPLER_PROJECT ?? '?'),
      config: String(body.DOPPLER_CONFIG ?? '?'),
    };
    const ignoredFilter = Object.keys(body).some((name) => !isDopplerMetadata(name));
    scrub(body);
    if (ignoredFilter) {
      throw codedError('DOPPLER_UNEXPECTED_SECRETS', 'Doppler ignored the name filter; refusing this token');
    }
    return identity;
  }

  /**
   * Fetch exactly `names` and return a Map name -> value. A response with any name that was not
   * requested (other than Doppler's own metadata) is refused whole; a missing or empty name
   * fails with MISSING_SECRETS and the list in `missing`.
   */
  async fetchSecrets(names) {
    const body = await this.#download(names);
    const wanted = new Set(names);
    const values = new Map();
    let unexpected = 0;
    for (const [name, value] of Object.entries(body)) {
      if (wanted.has(name)) {
        if (typeof value === 'string' && value.length > 0) values.set(name, value);
      } else if (!isDopplerMetadata(name)) {
        unexpected += 1;
      }
    }
    scrub(body);
    if (unexpected > 0) {
      values.clear();
      throw codedError(
        'DOPPLER_UNEXPECTED_SECRETS',
        `Doppler returned ${unexpected} secret(s) that were not requested; refusing them all`,
      );
    }
    const missing = names.filter((name) => !values.has(name));
    if (missing.length > 0) {
      values.clear();
      throw codedError('MISSING_SECRETS', `missing or empty in the Doppler config: ${missing.join(', ')}`, {
        missing,
      });
    }
    return values;
  }

  async #download(names) {
    if (!this.#token) throw codedError('TOKEN_DROPPED', 'the session no longer holds a token');
    const url = new URL(DOWNLOAD_PATH, apiBase());
    url.searchParams.set('format', 'json');
    url.searchParams.set('include_dynamic_secrets', 'false');
    url.searchParams.set('secrets', names.join(','));

    let response;
    try {
      response = await fetch(url, {
        headers: { authorization: `Bearer ${this.#token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (error) {
      if (error?.name === 'TimeoutError') {
        throw codedError('DOPPLER_TIMEOUT', `Doppler did not answer within ${REQUEST_TIMEOUT_MS / 1000} s`);
      }
      throw codedError('DOPPLER_UNAVAILABLE', 'Doppler is unreachable');
    }

    if (!response.ok) {
      await response.body?.cancel();
      throw httpError(response.status);
    }
    let body;
    try {
      body = await response.json();
    } catch {
      throw codedError('DOPPLER_BAD_RESPONSE', 'Doppler returned no JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw codedError('DOPPLER_BAD_RESPONSE', 'unexpected Doppler response');
    }
    return body;
  }
}

function httpError(status) {
  if (status === 401 || status === 403) {
    return codedError(
      'TOKEN_REJECTED',
      `Doppler rejected the service token (HTTP ${status}: expired, revoked or wrong)`,
    );
  }
  if (status === 429) return codedError('DOPPLER_RATE_LIMITED', 'Doppler rate limit (HTTP 429)');
  return codedError('DOPPLER_UNAVAILABLE', `Doppler answered HTTP ${status}`);
}
