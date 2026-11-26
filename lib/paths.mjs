// Where fundkit keeps its non-secret state. Every location can be moved for tests.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function homeDir() {
  return process.env.HOME || os.homedir();
}

/** Private runtime directory: the control socket and the per-profile config files. */
export function runDir() {
  return process.env.FUNDKIT_RUN_DIR || path.join(homeDir(), '.local', 'state', 'fundkit', 'run');
}

export function socketPath() {
  return path.join(runDir(), 'session.sock');
}

export function profilesDir() {
  return path.join(runDir(), 'profiles');
}

export function configDir() {
  return process.env.FUNDKIT_CONFIG_DIR || path.join(homeDir(), '.config', 'fundkit');
}

export function installRecordPath() {
  return path.join(configDir(), 'install.json');
}

export function defaultAppDir() {
  return path.join(homeDir(), '.local', 'share', 'fundkit', 'app');
}

export function launcherPath() {
  return path.join(homeDir(), '.local', 'bin', 'fundkit');
}

export function skillLinkPaths() {
  return {
    claude: path.join(homeDir(), '.claude', 'skills', 'usdt-funding'),
    codex: path.join(homeDir(), '.agents', 'skills', 'usdt-funding'),
  };
}

export function codexConfigPath() {
  return path.join(process.env.CODEX_HOME || path.join(homeDir(), '.codex'), 'config.toml');
}

export function readInstallRecord() {
  try {
    return JSON.parse(fs.readFileSync(installRecordPath(), 'utf8'));
  } catch {
    return {};
  }
}

/** The pinned ccxt-mcp entry point, or null before `fundkit install`. */
export function ccxtServerPath() {
  if (process.env.FUNDKIT_CCXT_MCP) return process.env.FUNDKIT_CCXT_MCP;
  const { appDir } = readInstallRecord();
  return appDir ? path.join(appDir, 'node_modules', 'ccxt-mcp', 'js', 'server.js') : null;
}

/** Create `dir` if needed and make it private to the current user. */
export function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

export function writePrivateFile(file, text) {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
