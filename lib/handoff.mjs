// Single-use consumption of a secret the host delivered as a file (T3 Code's `request_secret`
// with `delivery: "file"` writes a 0600 regular file in a 0700 directory and returns its path).
//
// The value is read once and the file is unlinked before the value is used. A file that is not
// a private regular file of the current user, or that cannot be removed, is refused, so the
// value never stays behind on disk because of fundkit. The path is the only thing that ever
// appears in argv; the value never does.

import fs from 'node:fs';
import path from 'node:path';
import { codedError } from './util.mjs';

/** Largest file accepted; a token or passphrase is far shorter. */
export const MAX_SECRET_FILE_BYTES = 4096;

const GROUP_OTHER_BITS = 0o077;
const GROUP_OTHER_WRITE = 0o022;
/** A host-delivered secret file has a random-looking name (T3 Code: 32 hex characters). */
const DELIVERED_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{15,127}$/;
const SYSTEM_TREES = ['/proc/', '/sys/', '/dev/'];
/** Clock tolerance between the step's issue time and the host writing the file. */
const CLOCK_SKEW_MS = 2000;

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function unsafe(message) {
  return codedError('FILE_UNSAFE', message);
}

/**
 * Refuse anything but a private regular file of this user in a directory only they can change.
 * With `delivery` ({notBefore}) the file must also look like a host delivery made for this step:
 * a random-looking name outside the kernel's trees, written no earlier than the step was issued.
 * Such refusals happen before the file is opened, so an unrelated file is never read or removed.
 */
function checkPath(file, delivery) {
  if (typeof file !== 'string' || file.length === 0 || !path.isAbsolute(file)) {
    throw codedError('FILE_PATH', 'give the absolute path the host returned for the secret');
  }
  if (delivery) {
    const normalized = path.normalize(file);
    if (normalized !== file || SYSTEM_TREES.some((tree) => file.startsWith(tree))) {
      throw unsafe('the path is not a host-delivered secret file');
    }
    if (!DELIVERED_NAME.test(path.basename(file))) {
      throw unsafe('the file name is not a host-delivered secret file name');
    }
  }
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    throw codedError('FILE_MISSING', 'no such file: it was already used or it expired; ask the user again');
  }
  if (stat.isSymbolicLink()) throw unsafe('the path is a symbolic link');
  if (!stat.isFile()) throw unsafe('the path is not a regular file');
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) throw unsafe('the file belongs to another user');
  if (stat.mode & GROUP_OTHER_BITS) throw unsafe('the file is readable or writable by other users');
  if (stat.size > MAX_SECRET_FILE_BYTES) throw unsafe('the file is too large for a secret');
  if (stat.nlink !== 1) throw unsafe('the file has more than one name');
  if (delivery && stat.mtimeMs < delivery.notBefore - CLOCK_SKEW_MS) {
    throw codedError(
      'FILE_STALE',
      'the file is older than this secret step, so it was not delivered for it; it was not read or removed',
    );
  }

  const dir = fs.statSync(path.dirname(file));
  if (uid !== null && dir.uid !== uid) throw unsafe('the directory belongs to another user');
  if (dir.mode & GROUP_OTHER_WRITE) throw unsafe('the directory is writable by other users');
  return stat;
}

/**
 * Read the secret in `file` once and delete the file. Returns a Buffer the caller must wipe
 * (`buffer.fill(0)`) after use. Surrounding whitespace (a trailing newline) is not part of
 * the value; with `keepSpaces` (API passphrases may contain spaces) only line breaks at the
 * ends are removed. `delivery` ({notBefore: ms}) adds the host-delivery checks of checkPath.
 * Rejects with FILE_PATH, FILE_MISSING, FILE_UNSAFE, FILE_STALE, FILE_EMPTY or
 * FILE_NOT_CONSUMED; on every rejection after the read the value is wiped and not returned.
 */
export function consumeSecretFile(file, { keepSpaces = false, delivery = null } = {}) {
  const expected = checkPath(file, delivery);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    throw unsafe('the file could not be opened safely');
  }
  let raw;
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== expected.ino || opened.dev !== expected.dev) {
      throw unsafe('the file changed while it was opened');
    }
    raw = Buffer.alloc(Math.min(opened.size, MAX_SECRET_FILE_BYTES));
    let offset = 0;
    while (offset < raw.length) {
      const read = fs.readSync(fd, raw, offset, raw.length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    raw = trimmed(raw, offset, keepSpaces);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.unlinkSync(file);
  } catch {
    raw.fill(0);
    throw codedError(
      'FILE_NOT_CONSUMED',
      'the secret file could not be deleted after reading, so it was not used; nothing was sent',
    );
  }
  if (raw.length === 0) throw codedError('FILE_EMPTY', 'the secret file was empty; nothing was sent');
  return raw;
}

/** A copy of `buffer[0, length)` without surrounding ASCII whitespace; the original is wiped. */
function trimmed(buffer, length, keepSpaces) {
  let start = 0;
  let end = length;
  const space = keepSpaces
    ? (byte) => byte === 0x0a || byte === 0x0d
    : (byte) => byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
  while (start < end && space(buffer[start])) start += 1;
  while (end > start && space(buffer[end - 1])) end -= 1;
  const copy = Buffer.from(buffer.subarray(start, end));
  buffer.fill(0);
  return copy;
}
