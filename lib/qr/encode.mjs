// QR Code Model 2 encoder: byte mode, error correction level M, versions 1–10, with the mask
// chosen by the standard penalty rules (ISO/IEC 18004). Pure and deterministic: the same text
// always gives the same matrix. Written for fundkit's deposit addresses (at most 213 bytes);
// nothing is fetched or cached.

const MAX_VERSION = 10;
/** Level M per version (index 1–10): error-correction codewords per block, and block count. */
const ECC_PER_BLOCK_M = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];
const FORMAT_BITS_M = 0; // L=1, M=0, Q=3, H=2
const PENALTY = Object.freeze({ N1: 3, N2: 3, N3: 40, N4: 10 });

function rawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version) {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK_M[version] * BLOCKS_M[version];
}

function alignmentPositions(version) {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const size = version * 4 + 17;
  const step = Math.ceil((version * 4 + 4) / (count * 2 - 2)) * 2;
  const positions = [6];
  for (let pos = size - 7; positions.length < count; pos -= step) positions.splice(1, 0, pos);
  return positions;
}

// ---------------------------------------------------------------- Reed–Solomon over GF(2^8)

function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    divisor.forEach((coefficient, index) => {
      result[index] ^= gfMultiply(coefficient, factor);
    });
  }
  return result;
}

// ---------------------------------------------------------------- data codewords

function chooseVersion(length) {
  for (let version = 1; version <= MAX_VERSION; version += 1) {
    const countBits = version < 10 ? 8 : 16;
    if (4 + countBits + length * 8 <= dataCodewords(version) * 8) return version;
  }
  throw new RangeError(`text too long for a version ${MAX_VERSION} QR code (${length} bytes)`);
}

function encodeData(bytes, version) {
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    codewords.push(bits.slice(i, i + 8).reduce((value, bit) => (value << 1) | bit, 0));
  }
  for (let pad = 0xec; codewords.length < dataCodewords(version); pad ^= 0xec ^ 0x11) codewords.push(pad);
  return codewords;
}

function interleave(data, version) {
  const blockCount = BLOCKS_M[version];
  const eccLength = ECC_PER_BLOCK_M[version];
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (rawCodewords % blockCount);
  const shortLength = Math.floor(rawCodewords / blockCount);
  const divisor = rsDivisor(eccLength);
  const blocks = [];
  for (let i = 0, offset = 0; i < blockCount; i += 1) {
    const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
    const chunk = data.slice(offset, offset + length);
    offset += length;
    const ecc = rsRemainder(chunk, divisor);
    if (i < shortBlocks) chunk.push(0); // placeholder, skipped below
    blocks.push([...chunk, ...ecc]);
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i += 1) {
    blocks.forEach((block, index) => {
      if (i !== shortLength - eccLength || index >= shortBlocks) result.push(block[i]);
    });
  }
  return result;
}

// ---------------------------------------------------------------- matrix

class Matrix {
  constructor(version) {
    this.version = version;
    this.size = version * 4 + 17;
    this.dark = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
    this.reserved = Array.from({ length: this.size }, () => new Array(this.size).fill(false));
  }

  set(x, y, dark) {
    this.dark[y][x] = dark;
    this.reserved[y][x] = true;
  }
}

function drawFinder(matrix, cx, cy) {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= matrix.size || y >= matrix.size) continue;
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      matrix.set(x, y, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignment(matrix, cx, cy) {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      matrix.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function drawFormatBits(matrix, mask) {
  const data = (FORMAT_BITS_M << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) !== 0;
  const { size } = matrix;
  for (let i = 0; i <= 5; i += 1) matrix.set(8, i, bit(i));
  matrix.set(8, 7, bit(6));
  matrix.set(8, 8, bit(7));
  matrix.set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) matrix.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i += 1) matrix.set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) matrix.set(8, size - 15 + i, bit(i));
  matrix.set(8, size - 8, true); // the dark module
}

function drawVersionBits(matrix) {
  if (matrix.version < 7) return;
  let remainder = matrix.version;
  for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  const bits = (matrix.version << 12) | remainder;
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = matrix.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    matrix.set(a, b, dark);
    matrix.set(b, a, dark);
  }
}

function drawFunctionPatterns(matrix) {
  const { size } = matrix;
  for (let i = 0; i < size; i += 1) {
    matrix.set(6, i, i % 2 === 0);
    matrix.set(i, 6, i % 2 === 0);
  }
  drawFinder(matrix, 3, 3);
  drawFinder(matrix, size - 4, 3);
  drawFinder(matrix, 3, size - 4);
  const positions = alignmentPositions(matrix.version);
  const last = positions.length - 1;
  positions.forEach((x, i) => {
    positions.forEach((y, j) => {
      const nearFinder = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
      if (!nearFinder) drawAlignment(matrix, x, y);
    });
  });
  drawFormatBits(matrix, 0); // reserve the area; redrawn with the real mask
  drawVersionBits(matrix);
}

function drawCodewords(matrix, codewords) {
  const { size } = matrix;
  let index = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (!matrix.reserved[y][x] && index < codewords.length * 8) {
          matrix.dark[y][x] = ((codewords[index >>> 3] >>> (7 - (index & 7))) & 1) !== 0;
          index += 1;
        }
      }
    }
  }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(matrix, mask) {
  const rule = MASKS[mask];
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (!matrix.reserved[y][x] && rule(x, y)) matrix.dark[y][x] = !matrix.dark[y][x];
    }
  }
}

// ---------------------------------------------------------------- penalty (mask choice)

const FINDER_LIKE = [
  [true, false, true, true, true, false, true, false, false, false, false],
  [false, false, false, false, true, false, true, true, true, false, true],
];

function linePenalty(line) {
  let score = 0;
  let run = 1;
  for (let i = 1; i <= line.length; i += 1) {
    if (i < line.length && line[i] === line[i - 1]) {
      run += 1;
    } else {
      if (run >= 5) score += PENALTY.N1 + (run - 5);
      run = 1;
    }
  }
  for (let i = 0; i + 11 <= line.length; i += 1) {
    for (const pattern of FINDER_LIKE) {
      if (pattern.every((dark, k) => line[i + k] === dark)) score += PENALTY.N3;
    }
  }
  return score;
}

function penalty(matrix) {
  const { size, dark } = matrix;
  let score = 0;
  for (let y = 0; y < size; y += 1) score += linePenalty(dark[y]);
  for (let x = 0; x < size; x += 1) score += linePenalty(dark.map((row) => row[x]));
  for (let y = 0; y + 1 < size; y += 1) {
    for (let x = 0; x + 1 < size; x += 1) {
      const color = dark[y][x];
      if (color === dark[y][x + 1] && color === dark[y + 1][x] && color === dark[y + 1][x + 1]) {
        score += PENALTY.N2;
      }
    }
  }
  const darkCount = dark.flat().filter(Boolean).length;
  const total = size * size;
  const k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1;
  return score + Math.max(0, k) * PENALTY.N4;
}

/**
 * Encode `text` (UTF-8) and return {version, size, mask, modules}, where `modules[y][x]` is
 * true for a dark module. The quiet zone is not included.
 */
export function encodeQr(text) {
  const bytes = [...Buffer.from(String(text), 'utf8')];
  const version = chooseVersion(bytes.length);
  const codewords = interleave(encodeData(bytes, version), version);
  let best = null;
  for (let mask = 0; mask < MASKS.length; mask += 1) {
    const matrix = new Matrix(version);
    drawFunctionPatterns(matrix);
    drawCodewords(matrix, codewords);
    applyMask(matrix, mask);
    drawFormatBits(matrix, mask);
    const score = penalty(matrix);
    if (!best || score < best.score) best = { score, mask, matrix };
  }
  return { version, size: best.matrix.size, mask: best.mask, modules: best.matrix.dark };
}
