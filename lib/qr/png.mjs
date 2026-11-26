// Minimal PNG writer (8-bit grayscale) and reader (8-bit grayscale, gray+alpha, RGB, RGBA; all
// five filter types), Node's zlib only. The reader is what the delivered file is checked with,
// so it accepts any standard 8-bit non-interlaced PNG, not only what the writer produces.

import zlib from 'node:zlib';
import { codedError } from '../util.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CHANNELS = Object.freeze({ 0: 1, 2: 3, 4: 2, 6: 4 });
const MAX_PIXELS = 4096 * 4096;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * Render a module matrix as a grayscale PNG: `scale` pixels per module and a quiet zone of
 * `margin` modules. Deterministic: the same matrix gives the same bytes.
 */
export function matrixToPng(modules, { scale = 8, margin = 4 } = {}) {
  const count = modules.length;
  const side = (count + margin * 2) * scale;
  const rows = [];
  for (let py = 0; py < side; py += 1) {
    const row = Buffer.alloc(side + 1, 0xff);
    row[0] = 0; // filter: none
    const my = Math.floor(py / scale) - margin;
    if (my >= 0 && my < count) {
      for (let px = 0; px < side; px += 1) {
        const mx = Math.floor(px / scale) - margin;
        if (mx >= 0 && mx < count && modules[my][mx]) row[px + 1] = 0x00;
      }
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(side, 0);
  header.writeUInt32BE(side, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  const data = zlib.deflateSync(Buffer.concat(rows), { level: 9 });
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', data),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

function bad(message) {
  return codedError('PNG_INVALID', message);
}

/** Decode a PNG into {width, height, rgba} (Uint8ClampedArray, 4 bytes per pixel). */
export function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(SIGNATURE)) throw bad('not a PNG');
  let offset = 8;
  let header = null;
  const idat = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) throw bad('truncated chunk');
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (
      crc32(buffer.subarray(offset + 4, offset + 8 + length)) !== buffer.readUInt32BE(offset + 8 + length)
    ) {
      throw bad(`bad CRC in ${type}`);
    }
    if (type === 'IHDR') header = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    offset = end;
  }
  if (!header || header.length !== 13) throw bad('no IHDR');
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const [depth, colorType, , , interlace] = header.subarray(8);
  const channels = CHANNELS[colorType];
  if (depth !== 8 || !channels || interlace !== 0) throw bad('only 8-bit non-interlaced PNGs are read');
  if (width === 0 || height === 0 || width * height > MAX_PIXELS) throw bad('unsupported size');

  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) throw bad('image data has the wrong length');
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? pixels[y * stride + x - channels] : 0;
      const b = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? pixels[(y - 1) * stride + x - channels] : 0;
      let value;
      switch (filter) {
        case 0:
          value = line[x];
          break;
        case 1:
          value = line[x] + a;
          break;
        case 2:
          value = line[x] + b;
          break;
        case 3:
          value = line[x] + Math.floor((a + b) / 2);
          break;
        case 4:
          value = line[x] + paeth(a, b, c);
          break;
        default:
          throw bad(`unknown filter ${filter}`);
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const p = pixels.subarray(i * channels, (i + 1) * channels);
    const [r, g, b] = channels >= 3 ? [p[0], p[1], p[2]] : [p[0], p[0], p[0]];
    const alpha = channels === 2 ? p[1] : channels === 4 ? p[3] : 255;
    rgba.set([r, g, b, alpha], i * 4);
  }
  return { width, height, rgba };
}
