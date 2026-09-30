// A QR code for a short text (the page's address), without a library: byte mode, error correction level M,
// versions 1–10 (up to 213 bytes). Returns the module grid; qrSvg draws it.

// Versions 1–10 at level M: error correction codewords per block, and [blocks, data codewords] groups.
const M = [
  null,
  [10, [[1, 16]]],
  [16, [[1, 28]]],
  [26, [[1, 44]]],
  [18, [[2, 32]]],
  [24, [[2, 43]]],
  [16, [[4, 27]]],
  [18, [[4, 31]]],
  [22, [[2, 38], [2, 39]]],
  [22, [[3, 36], [2, 37]]],
  [26, [[4, 43], [1, 44]]],
]
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]]

// GF(256) with the QR polynomial 0x11d.
const EXP = new Array(512)
const LOG = new Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0)

function generator(n) {
  let g = [1]
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0)
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j]
      next[j + 1] ^= mul(g[j], EXP[i])
    }
    g = next
  }
  return g
}
function ecCodewords(data, n) {
  const g = generator(n)
  const r = [...data, ...new Array(n).fill(0)]
  for (let i = 0; i < data.length; i++) {
    const c = r[i]
    if (c) for (let j = 0; j < g.length; j++) r[i + j] ^= mul(g[j], c)
  }
  return r.slice(data.length)
}

function dataCapacity(v) {
  return M[v][1].reduce((s, [b, d]) => s + b * d, 0)
}

/** The codewords for `bytes` in version `v`: data with its error correction, interleaved by block. */
function codewords(bytes, v) {
  const cap = dataCapacity(v)
  const bits = []
  const put = (val, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1)
  }
  put(0b0100, 4)
  put(bytes.length, v < 10 ? 8 : 16)
  for (const b of bytes) put(b, 8)
  put(0, Math.min(4, cap * 8 - bits.length))
  while (bits.length % 8) bits.push(0)
  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0))
  for (let pad = 0; data.length < cap; pad++) data.push(pad % 2 ? 0x11 : 0xec)
  const [ecn, groups] = M[v]
  const blocks = []
  let at = 0
  for (const [count, size] of groups)
    for (let k = 0; k < count; k++) {
      const d = data.slice(at, at + size)
      at += size
      blocks.push({ d, e: ecCodewords(d, ecn) })
    }
  const out = []
  const maxD = Math.max(...blocks.map((b) => b.d.length))
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i])
  for (let i = 0; i < ecn; i++) for (const b of blocks) out.push(b.e[i])
  return out
}

function bch(value, poly, shift) {
  let v = value << shift
  const top = Math.floor(Math.log2(poly))
  while (v && Math.floor(Math.log2(v)) >= top) v ^= poly << (Math.floor(Math.log2(v)) - top)
  return (value << shift) | v
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
]

function build(v, cws, mask) {
  const n = 17 + 4 * v
  const m = Array.from({ length: n }, () => new Array(n).fill(null)) // null: free for data
  const set = (r, c, dark) => (m[r][c] = dark ? 1 : 0)
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r
        const cc = c0 + c
        if (rr < 0 || cc < 0 || rr >= n || cc >= n) continue
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3))
        set(rr, cc, ring !== 2 && ring !== 4)
      }
  }
  finder(0, 0)
  finder(0, n - 7)
  finder(n - 7, 0)
  for (let i = 8; i < n - 8; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }
  for (const r of ALIGN[v])
    for (const c of ALIGN[v]) {
      // Not where a finder is (a pattern on the timing row, from version 7, is drawn).
      if ((r < 9 && c < 9) || (r < 9 && c > n - 10) || (r > n - 10 && c < 9)) continue
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1)
    }
  set(n - 8, 8, true) // the dark module
  // Reserve format (and version) areas; filled below.
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === null) m[8][i] = 0
    if (m[i][8] === null) m[i][8] = 0
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][n - 1 - i] === null) m[8][n - 1 - i] = 0
    if (m[n - 1 - i][8] === null) m[n - 1 - i][8] = 0
  }
  if (v >= 7)
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 3; j++) {
        m[i][n - 11 + j] = 0
        m[n - 11 + j][i] = 0
      }
  const reserved = m.map((row) => row.map((x) => x !== null))
  // Data, in the zigzag from the bottom right, skipping the timing column.
  const bits = []
  for (const cw of cws) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1)
  let k = 0
  let up = true
  for (let c = n - 1; c > 0; c -= 2) {
    if (c === 6) c--
    for (let i = 0; i < n; i++) {
      const r = up ? n - 1 - i : i
      for (const cc of [c, c - 1]) {
        if (reserved[r][cc]) continue
        const bit = k < bits.length ? bits[k++] : 0
        m[r][cc] = bit ^ (MASKS[mask](r, cc) ? 1 : 0)
      }
    }
    up = !up
  }
  // Format: level M (00) and the mask, BCH(15,5), then the fixed XOR.
  const format = bch(mask, 0x537, 10) ^ 0x5412
  const fb = (i) => (format >> i) & 1
  // Around the top-left finder, then split between the other two.
  for (let i = 0; i <= 5; i++) m[i][8] = fb(i)
  m[7][8] = fb(6)
  m[8][8] = fb(7)
  m[8][7] = fb(8)
  for (let i = 9; i < 15; i++) m[8][14 - i] = fb(i)
  for (let i = 0; i < 8; i++) m[8][n - 1 - i] = fb(i)
  for (let i = 8; i < 15; i++) m[n - 15 + i][8] = fb(i)
  m[n - 8][8] = 1
  if (v >= 7) {
    const ver = bch(v, 0x1f25, 12)
    for (let i = 0; i < 18; i++) {
      const bit = (ver >> i) & 1
      m[Math.floor(i / 3)][n - 11 + (i % 3)] = bit
      m[n - 11 + (i % 3)][Math.floor(i / 3)] = bit
    }
  }
  return m
}

/** The usual penalty score; the mask with the lowest one reads best. */
function penalty(m) {
  const n = m.length
  let p = 0
  for (let pass = 0; pass < 2; pass++)
    for (let a = 0; a < n; a++) {
      let run = 1
      for (let b = 1; b < n; b++) {
        const cur = pass ? m[b][a] : m[a][b]
        const prev = pass ? m[b - 1][a] : m[a][b - 1]
        if (cur === prev) {
          run++
          if (run === 5) p += 3
          else if (run > 5) p++
        } else run = 1
      }
    }
  for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) p += 3
  const pat = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0]
  const rev = [...pat].reverse()
  for (let a = 0; a < n; a++)
    for (let b = 0; b <= n - 11; b++)
      for (const q of [pat, rev]) {
        if (q.every((x, i) => m[a][b + i] === x)) p += 40
        if (q.every((x, i) => m[b + i][a] === x)) p += 40
      }
  const dark = m.flat().filter((x) => x).length
  p += Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5) * 10
  return p
}

export function qrMatrix(text) {
  const bytes = [...new TextEncoder().encode(text)]
  let v = 1
  while (v <= 10 && dataCapacity(v) < bytes.length + (v < 10 ? 2 : 3)) v++
  if (v > 10) throw new Error('QR 에 넣기엔 너무 긴 주소예요')
  const cws = codewords(bytes, v)
  let best = null
  for (let mask = 0; mask < 8; mask++) {
    const m = build(v, cws, mask)
    const score = penalty(m)
    if (!best || score < best.score) best = { m, score }
  }
  return best.m
}

/** The grid as SVG with a 4-module quiet zone (dark on white, whatever the theme: scanners need contrast). */
export function qrSvg(text, size = 176) {
  const m = qrMatrix(text)
  const n = m.length + 8
  let d = ''
  m.forEach((row, r) => row.forEach((x, c) => x && (d += `M${c + 4} ${r + 4}h1v1h-1z`)))
  return `<svg xmlns="http://www.w3.org/2000/svg" class="qr" viewBox="0 0 ${n} ${n}" width="${size}" height="${size}" shape-rendering="crispEdges" role="img" aria-label="이 페이지를 폰으로 여는 QR"><rect width="${n}" height="${n}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`
}
