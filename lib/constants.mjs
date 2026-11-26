// Fixed values shared by every fundkit command. Nothing here is secret.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = '0.2.0';

/** Repository root: the skill lives here and `install` links to it. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const CLI_PATH = path.join(REPO_ROOT, 'bin', 'fundkit.mjs');

/** Exact versions installed by `fundkit install` (references/ccxt-mcp.md, pins). */
export const PINS = Object.freeze({
  'ccxt-mcp': '0.1.3',
  ccxt: '4.5.85',
  '@modelcontextprotocol/sdk': '1.32.2',
  zod: '3.25.76',
});

export const DOPPLER_API = 'https://api.doppler.com';

/** Doppler service tokens only; personal and CLI tokens reach every project and are refused. */
export const SERVICE_TOKEN_PATTERN = /^dp\.st\.(?:[a-z0-9\-_]{2,35}\.)?[a-zA-Z0-9]{40,44}$/;

/** The only variables of the session's own environment a profile process inherits. */
export const PASSED_ENV_NAMES = Object.freeze([
  'PATH',
  'HOME',
  'XDG_CACHE_HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'TZ',
  'LANG',
]);

/** MCP protocol version offered when the host does not name one. */
export const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
