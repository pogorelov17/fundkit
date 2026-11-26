// A verified QR image for one deposit address: encoded locally from the exact address bytes,
// written atomically under a name derived from its own content, then read back from disk and
// decoded by an independent decoder (the pinned jsQR) and compared byte for byte. A QR that
// fails the comparison is deleted and never returned.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT } from '../constants.mjs';
import { ensurePrivateDir, qrDir, readInstallRecord } from '../paths.mjs';
import { codedError } from '../util.mjs';
import { encodeQr } from './encode.mjs';
import { decodePng, matrixToPng } from './png.mjs';

const MAX_AGE_MS = 24 * 3_600_000;

/** The pinned jsQR from the install's app directory, or the repository's dev install. */
function loadDecoder() {
  const roots = [process.env.FUNDKIT_JSQR_ROOT, readInstallRecord().appDir, REPO_ROOT].filter(Boolean);
  for (const root of roots) {
    try {
      const require = createRequire(path.join(root, 'package.json'));
      const jsQR = require('jsqr');
      return typeof jsQR === 'function' ? jsQR : jsQR.default;
    } catch {
      // try the next root
    }
  }
  return null;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Remove QR files older than a day; they are never reused. */
function prune(dir) {
  const now = Date.now();
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > MAX_AGE_MS) fs.rmSync(file, { force: true });
    } catch {
      // raced with another prune
    }
  }
}

/**
 * Decode the QR in a PNG file. Returns the decoded bytes as a Buffer, or null when nothing
 * decodes. Exported for tests and for re-checking a delivered file.
 */
export function decodeQrFile(file, decoder = loadDecoder()) {
  if (!decoder) throw codedError('QR_DECODER_MISSING', 'the pinned QR decoder (jsqr) is not installed');
  const { width, height, rgba } = decodePng(fs.readFileSync(file));
  const result = decoder(rgba, width, height, { inversionAttempts: 'dontInvert' });
  return result ? Buffer.from(result.binaryData) : null;
}

/**
 * Write and verify the QR image for `text`. Returns {path, sha256, bytes, version, mask,
 * payload, verified: true}. Throws QR_DECODER_MISSING or QR_MISMATCH (and leaves no file).
 */
export function writeVerifiedQr(text, { dir = qrDir() } = {}) {
  const decoder = loadDecoder();
  if (!decoder) {
    throw codedError(
      'QR_DECODER_MISSING',
      'the pinned QR decoder (jsqr) is not installed, so no QR can be verified; run fundkit install',
    );
  }
  const expected = Buffer.from(text, 'utf8');
  const qr = encodeQr(text);
  const png = matrixToPng(qr.modules);
  const digest = sha256(png);
  ensurePrivateDir(dir);
  prune(dir);
  const file = path.join(dir, `${digest}.png`);
  const partial = path.join(
    dir,
    `.${digest}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.partial`,
  );
  fs.writeFileSync(partial, png, { mode: 0o600, flag: 'wx' });
  fs.renameSync(partial, file);

  const delivered = fs.readFileSync(file);
  const decoded = decodeQrFile(file, decoder);
  if (sha256(delivered) !== digest || !decoded || !decoded.equals(expected)) {
    fs.rmSync(file, { force: true });
    throw codedError('QR_MISMATCH', 'the QR image did not decode to the exact address; no QR is shown');
  }
  return {
    path: file,
    sha256: digest,
    bytes: png.length,
    version: qr.version,
    mask: qr.mask,
    payload: decoded.toString('utf8'),
    verified: true,
    decoder: 'jsqr 1.4.0 on the PNG file read back from disk',
  };
}
