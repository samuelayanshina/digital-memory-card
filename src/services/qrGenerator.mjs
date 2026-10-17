// ============================================================================
// CardNG Zero-Dependency ISO/IEC 18004 QR Code SVG Generator (Versions 1–6, Level L)
// Generates standards-compliant scannable QR codes for Local Hotspot IPs & Share Links
// ============================================================================

// QR Level L capacities (Byte mode) and Reed-Solomon parameters for Versions 1 to 6
const QR_VERSIONS = [
  null,
  { version: 1, size: 21, totalCodewords: 26, ecCodewordsPerBlock: 7, numBlocks: 1, maxBytes: 17, align: [] },
  { version: 2, size: 25, totalCodewords: 44, ecCodewordsPerBlock: 10, numBlocks: 1, maxBytes: 32, align: [6, 18] },
  { version: 3, size: 29, totalCodewords: 70, ecCodewordsPerBlock: 15, numBlocks: 1, maxBytes: 53, align: [6, 22] },
  { version: 4, size: 33, totalCodewords: 100, ecCodewordsPerBlock: 20, numBlocks: 1, maxBytes: 78, align: [6, 26] },
  { version: 5, size: 37, totalCodewords: 134, ecCodewordsPerBlock: 26, numBlocks: 1, maxBytes: 106, align: [6, 30] },
  { version: 6, size: 41, totalCodewords: 172, ecCodewordsPerBlock: 18, numBlocks: 2, maxBytes: 134, align: [6, 34] }
];

// GF(256) Log/Exp tables with primitive polynomial 0x11D
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsComputeRemainder(dataBytes, ecDegree) {
  const gen = rsGeneratorPoly(ecDegree);
  const rem = new Uint8Array(ecDegree);
  for (let i = 0; i < dataBytes.length; i++) {
    const factor = dataBytes[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecDegree - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecDegree; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

function encodeDataCodewords(utf8Bytes, spec) {
  const dataCapacity = spec.totalCodewords - spec.ecCodewordsPerBlock * spec.numBlocks;
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >> i) & 1);
    }
  };

  // Byte mode indicator (0100) + 8-bit character count (for versions 1-9)
  pushBits(0b0100, 4);
  pushBits(utf8Bytes.length, 8);
  for (const b of utf8Bytes) pushBits(b, 8);

  // Terminator (up to 4 zero bits)
  const maxBits = dataCapacity * 8;
  for (let i = 0; i < 4 && bits.length < maxBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = new Uint8Array(dataCapacity);
  const byteLen = bits.length / 8;
  for (let i = 0; i < byteLen; i++) {
    let byteVal = 0;
    for (let bit = 0; bit < 8; bit++) {
      byteVal = (byteVal << 1) | bits[i * 8 + bit];
    }
    codewords[i] = byteVal;
  }

  const padBytes = [0xec, 0x11];
  for (let i = byteLen; i < dataCapacity; i++) {
    codewords[i] = padBytes[(i - byteLen) % 2];
  }

  if (spec.numBlocks === 1) {
    const ec = rsComputeRemainder(codewords, spec.ecCodewordsPerBlock);
    const out = new Uint8Array(spec.totalCodewords);
    out.set(codewords, 0);
    out.set(ec, codewords.length);
    return out;
  }

  // Interleave blocks (for Version 6: 2 blocks)
  const blockSize = dataCapacity / spec.numBlocks;
  const dataBlocks = [];
  const ecBlocks = [];
  for (let b = 0; b < spec.numBlocks; b++) {
    const slice = codewords.subarray(b * blockSize, (b + 1) * blockSize);
    dataBlocks.push(slice);
    ecBlocks.push(rsComputeRemainder(slice, spec.ecCodewordsPerBlock));
  }

  const out = new Uint8Array(spec.totalCodewords);
  let idx = 0;
  for (let i = 0; i < blockSize; i++) {
    for (let b = 0; b < spec.numBlocks; b++) out[idx++] = dataBlocks[b][i];
  }
  for (let i = 0; i < spec.ecCodewordsPerBlock; i++) {
    for (let b = 0; b < spec.numBlocks; b++) out[idx++] = ecBlocks[b][i];
  }
  return out;
}

function buildQrMatrix(text) {
  const utf8 = Buffer.from(String(text || '').slice(0, 130), 'utf-8');
  const spec = QR_VERSIONS.find((v) => v && utf8.length <= v.maxBytes) || QR_VERSIONS[6];
  const size = spec.size;

  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunction = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunctionModule = (r, c, dark) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = dark ? 1 : 0;
    isFunction[r][c] = 1;
  };

  // Finder patterns + separators
  const drawFinder = (rowOffset, colOffset) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = rowOffset + dr;
        const c = colOffset + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6;
        const inCenter = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunctionModule(r, c, inOuter && (onBorder || inCenter));
      }
    }
  };

  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const alignCoords = spec.align;
  for (const ar of alignCoords) {
    for (const ac of alignCoords) {
      if (
        (ar === 6 && ac === 6) ||
        (ar === 6 && ac === size - 7) ||
        (ar === size - 7 && ac === 6)
      ) {
        continue;
      }
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
          setFunctionModule(ar + dr, ac + dc, dark);
        }
      }
    }
  }

  // Reserve format info & dark module
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setFunctionModule(8, i, false);
      setFunctionModule(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setFunctionModule(8, size - 1 - i, false);
    setFunctionModule(size - 1 - i, 8, false);
  }
  setFunctionModule(size - 8, 8, true);

  // Place data & EC codewords in upward/downward 2-column zig-zag
  const codewords = encodeDataCodewords(utf8, spec);
  let bitIdx = 0;
  const totalBits = codewords.length * 8;

  let upward = true;
  for (let rightCol = size - 1; rightCol >= 1; rightCol -= 2) {
    if (rightCol === 6) rightCol = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let dc = 0; dc < 2; dc++) {
        const c = rightCol - dc;
        if (!isFunction[r][c]) {
          let dark = false;
          if (bitIdx < totalBits) {
            const byteVal = codewords[bitIdx >> 3];
            dark = ((byteVal >> (7 - (bitIdx & 7))) & 1) === 1;
            bitIdx++;
          }
          // Apply Mask 0: (r + c) % 2 === 0
          if ((r + c) % 2 === 0) dark = !dark;
          modules[r][c] = dark ? 1 : 0;
        }
      }
    }
    upward = !upward;
  }

  // Write Format Information for Level L (01) + Mask 0 (000) -> 0x77c4
  const formatBits = 0x77c4;
  const getFormatBit = (i) => ((formatBits >> i) & 1) === 1;

  for (let i = 0; i <= 5; i++) setFunctionModule(8, i, getFormatBit(14 - i));
  setFunctionModule(8, 7, getFormatBit(8));
  setFunctionModule(8, 8, getFormatBit(7));
  setFunctionModule(7, 8, getFormatBit(6));
  for (let i = 0; i <= 5; i++) setFunctionModule(5 - i, 8, getFormatBit(5 - i));

  for (let i = 0; i < 7; i++) setFunctionModule(size - 1 - i, 8, getFormatBit(14 - i));
  for (let i = 0; i < 8; i++) setFunctionModule(8, size - 8 + i, getFormatBit(7 - i));

  return { size, modules };
}

export function generateQrCodeSvg(text, { margin = 3, fg = '#0f172a', bg = '#ffffff' } = {}) {
  const { size, modules } = buildQrMatrix(text);
  const total = size + margin * 2;
  let pathData = '';

  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (modules[r][c]) {
        pathData += `M${c + margin},${r + margin}h1v1h-1z`;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges" width="180" height="180">
  <rect width="${total}" height="${total}" fill="${bg}" rx="2" />
  <path d="${pathData}" fill="${fg}" />
</svg>`;
}
