// `fundkit install`: one-time, idempotent machine setup. It never touches Doppler or a key.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { CLI_PATH, PINS, REPO_ROOT, VERSION } from './constants.mjs';
import {
  codexConfigPath,
  configDir,
  defaultAppDir,
  ensurePrivateDir,
  installRecordPath,
  launcherPath,
  skillLinkPaths,
  writePrivateFile,
} from './paths.mjs';
import { nowIso } from './util.mjs';

const MIN_NODE_MAJOR = 20;

function say(line = '') {
  process.stdout.write(`${line}\n`);
}

function which(command) {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const candidate = path.join(dir, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // not in this directory
    }
  }
  return null;
}

function parseInstallArgs(argv) {
  const options = { appDir: defaultAppDir(), claude: true, codex: true, skills: true };
  for (let index = 0; index < argv.length; index += 1) {
    switch (argv[index]) {
      case '--app-dir':
        index += 1;
        if (index >= argv.length) throw new Error('--app-dir needs a value');
        options.appDir = path.resolve(argv[index]);
        break;
      case '--no-claude':
        options.claude = false;
        break;
      case '--no-codex':
        options.codex = false;
        break;
      case '--no-skills':
        options.skills = false;
        break;
      default:
        throw new Error(`unknown option ${argv[index]}`);
    }
  }
  return options;
}

const pinSpecs = () => Object.entries(PINS).map(([name, version]) => `${name}@${version}`);

function hasPinnedPackages(appDir) {
  return Object.entries(PINS).every(([name, version]) => {
    try {
      const manifest = path.join(appDir, 'node_modules', name, 'package.json');
      return JSON.parse(fs.readFileSync(manifest, 'utf8')).version === version;
    } catch {
      return false;
    }
  });
}

function installPinnedServer(appDir) {
  if (hasPinnedPackages(appDir)) {
    say(`ccxt-mcp: pinned versions already in ${appDir}`);
    return true;
  }
  const npm = which('npm');
  if (!npm) {
    say('npm not found');
    return false;
  }
  fs.mkdirSync(appDir, { recursive: true });
  say(`ccxt-mcp: installing pinned ${pinSpecs().join(' ')} into ${appDir}`);
  const npmArgs = [
    '--prefix',
    appDir,
    'install',
    '--save-exact',
    '--ignore-scripts',
    '--no-fund',
    '--no-audit',
  ];
  const result = spawnSync(npm, [...npmArgs, ...pinSpecs()], { stdio: 'inherit' });
  if (result.status !== 0 || !hasPinnedPackages(appDir)) {
    say('npm install failed');
    return false;
  }
  return true;
}

function writeLauncher(appDir) {
  const launcher = launcherPath();
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, `#!/bin/sh\nexec "${process.execPath}" "${CLI_PATH}" "$@"\n`, { mode: 0o755 });
  ensurePrivateDir(configDir());
  const record = { repo: REPO_ROOT, appDir, node: process.execPath, installed: nowIso(), version: VERSION };
  writePrivateFile(installRecordPath(), `${JSON.stringify(record, null, 2)}\n`);
  const onPath = (process.env.PATH ?? '').split(':').includes(path.dirname(launcher));
  say(
    `launcher: ${launcher}${onPath ? '' : ` (add ${path.dirname(launcher)} to PATH, or call it by full path)`}`,
  );
}

/** Symlink `link` to `target` unless something else is already there. */
function linkDirectory(link, target) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  let stat = null;
  try {
    stat = fs.lstatSync(link);
  } catch {
    // nothing there yet
  }
  if (!stat) {
    fs.symlinkSync(target, link, 'dir');
    return 'linked';
  }
  const pointsHere =
    stat.isSymbolicLink() && path.resolve(path.dirname(link), fs.readlinkSync(link)) === target;
  return pointsHere ? 'present' : 'exists (left unchanged)';
}

function linkSkill() {
  const links = skillLinkPaths();
  say(`skill (Claude Code): ~/.claude/skills/usdt-funding ${linkDirectory(links.claude, REPO_ROOT)}`);
  say(`skill (Codex): ~/.agents/skills/usdt-funding ${linkDirectory(links.codex, REPO_ROOT)}`);
}

const serverEntry = () => ({ command: process.execPath, args: [CLI_PATH, 'mcp'] });

function registerClaude() {
  const claude = which('claude');
  if (!claude) return say('Claude Code: not found (skipped)');
  if (spawnSync(claude, ['mcp', 'get', 'fundkit'], { encoding: 'utf8' }).status === 0) {
    return say('Claude Code: server "fundkit" already registered (left unchanged)');
  }
  const result = spawnSync(
    claude,
    ['mcp', 'add-json', '-s', 'user', 'fundkit', JSON.stringify(serverEntry())],
    {
      encoding: 'utf8',
    },
  );
  return say(
    result.status === 0
      ? 'Claude Code: registered user-scope server "fundkit"'
      : `Claude Code: registration failed: ${(result.stderr || result.stdout).trim()}`,
  );
}

function codexTable() {
  const { command, args } = serverEntry();
  const quote = (text) => JSON.stringify(text);
  return [
    '[mcp_servers.fundkit]',
    `command = ${quote(command)}`,
    `args = [${args.map(quote).join(', ')}]`,
    'startup_timeout_sec = 30',
    'tool_timeout_sec = 420',
    '',
  ].join('\n');
}

function registerCodex() {
  if (!which('codex')) return say('Codex: not found (skipped)');
  const configPath = codexConfigPath();
  const text = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  if (/^\[mcp_servers\.fundkit\]/m.test(text)) {
    return say('Codex: [mcp_servers.fundkit] already present (left unchanged)');
  }
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  const separator = text && !text.endsWith('\n') ? '\n\n' : '\n';
  fs.appendFileSync(configPath, `${separator}${codexTable()}`);
  return say(
    `Codex: added [mcp_servers.fundkit] to ${configPath} (tool_timeout_sec = 420 for the 300 s confirmation form)`,
  );
}

export function runInstallCommand(argv) {
  let options;
  try {
    options = parseInstallArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  const [major] = process.versions.node.split('.').map(Number);
  if (major < MIN_NODE_MAJOR) {
    say(`Node ${process.versions.node} is too old; fundkit needs Node ${MIN_NODE_MAJOR}+`);
    return 1;
  }
  if (!installPinnedServer(options.appDir)) return 1;
  writeLauncher(options.appDir);
  if (options.skills) linkSkill();
  if (options.claude) registerClaude();
  else say('Claude Code: skipped (--no-claude)');
  if (options.codex) registerCodex();
  else say('Codex: skipped (--no-codex)');
  say();
  say(
    'Done. Start a new T3 Code, Claude Code or Codex thread (a running one does not load new servers) and ask in your own words,',
  );
  say(
    'e.g. "Show my Binance USDT deposit address on BSC". Existing ccxt-mcp profiles keep working; Doppler is only needed for missing ones.',
  );
  return 0;
}
