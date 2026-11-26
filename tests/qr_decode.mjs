// Test helper: decode a QR from grayscale pixels with the pinned jsQR. The pixels come from the
// test's own Python PNG reader (tests/native_support.py), not from fundkit's lib/qr/png.mjs, so
// the delivered file is checked by code that shares nothing with the encoder.
//
// stdin: {"width": W, "height": H, "gray": "<base64, one byte per pixel>"}
// stdout: {"found": bool, "hex": "<decoded bytes as hex>"}

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const jsQR = require('jsqr');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const { width, height, gray } = JSON.parse(input);
  const pixels = Buffer.from(gray, 'base64');
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) rgba.set([pixels[i], pixels[i], pixels[i], 255], i * 4);
  const result = jsQR(rgba, width, height, { inversionAttempts: 'dontInvert' });
  process.stdout.write(
    `${JSON.stringify({ found: Boolean(result), hex: result ? Buffer.from(result.binaryData).toString('hex') : null })}\n`,
  );
});
