// Genus — Game Boy-style prototype.
//
// Kept honest to a DMG: a 160x144 screen, four shades, 16x16 cells built from 8x8 tiles,
// sprites for moving things. The world is a square-tiled surface: rectangles of grid cells
// whose edges can be glued to other edges by a translation, a quarter turn or a flip.
//
// The screen is never a fixed map. Every frame the game works out, starting from her, which
// world cell each screen cell shows by walking outward through the grid, crossing glued edges
// as it goes. In a level with a cone point (the pole) different routes disagree about what's
// behind you, so only what her lamp reaches is drawn; the rest is dark and gets redrawn,
// correctly for wherever she now stands, the next time the beam sweeps over it.

(() => {
'use strict';

// ======================================================================
// Screen and palette
// ======================================================================
const SW = 160, SH = 144, CELL = 16;
const PAL = [[0xf2, 0xe8, 0xcf], [0xc9, 0xae, 0x82], [0x7c, 0x62, 0x4a], [0x26, 0x1d, 0x18]];
const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const img = ctx.createImageData(SW, SH);
const fb = new Uint8Array(SW * SH);                 // shade indices 0..3

// ======================================================================
// The world
// ======================================================================
// '#' wall, '.' ground, ' ' outside. y grows downward, like the screen.
const MAP = [
  ' ##########      ',   // 0   north alley: its ends are glued straight across
  ' ..........      ',   // 1
  ' ..........      ',   // 2
  '####..######     ',   // 3
  '#........####    ',   // 4   start yard (x 1..8, y 4..10)
  '#........#...    ',   // 5   pole yard: an L of three 3x3 squares
  '#........#...    ',   // 6
  '#........#...    ',   // 7
  '#..............# ',   // 8
  '#..............# ',   // 9
  '#........#.....# ',   // 10
  '####..###########',   // 11
  ' ..........      ',   // 12  south alley: its ends are glued with a flip
  ' ..........      ',   // 13
  ' ..........      ',   // 14
  ' ##########      ',   // 15
];
const MH = MAP.length, MW = MAP[0].length;
const OUT = 0, GROUND = 1, WALL = 2, HOUSE = 3, POLE = 4;
const cellT = [];
for (let y = 0; y < MH; y++) { cellT.push([]); for (let x = 0; x < MW; x++) { const ch = MAP[y][x]; cellT[y].push(ch === '#' ? WALL : ch === '.' ? GROUND : OUT); } }

function region(x, y) {           // which area a cell belongs to (sets its ground)
  if (y <= 3) return 'alleyN';
  if (y >= 11) return 'alleyS';
  if (x >= 10) return 'pole';
  return 'start';
}

// a house: 3 cells wide, 2 deep, door on its south side
const houses = [{ x: 2, y: 5, w: 3, h: 2, front: [0, 1] }];
for (const h of houses) for (let y = h.y; y < h.y + h.h; y++) for (let x = h.x; x < h.x + h.w; x++) cellT[y][x] = HOUSE;

// the pole stands on the corner (13,8) where the three squares of the L meet
const POLE_AT = [13, 8];
const poleCells = [[12, 7], [12, 8], [13, 8]];
for (const [x, y] of poleCells) cellT[y][x] = POLE;

// painted L glyphs on the ground, to show turns and flips
const glyphs = new Set(['7,5', '8,1', '8,13', '11,5', '14,10']);

// ---------- glued edges ----------
// Each glued edge is listed with the area's interior on its left (walking p0 to p1, "left"
// meaning the (-dy, dx) side). Without a flip, p0 of one meets p1 of the other.
const portals = [];          // linear part L (2x2, row-major), offset
function similarity(a0, a1, c0, c1, reverse) {
  const ex = a1[0] - a0[0], ey = a1[1] - a0[1], fx = c1[0] - c0[0], fy = c1[1] - c0[1];
  const den = ex * ex + ey * ey;
  let L;
  if (!reverse) { const ar = (fx * ex + fy * ey) / den, ai = (fy * ex - fx * ey) / den; L = [ar, -ai, ai, ar]; }
  else { const ar = (fx * ex - fy * ey) / den, ai = (fy * ex + fx * ey) / den; L = [ar, ai, ai, -ar]; }
  L = L.map(Math.round);
  return { L, ox: c0[0] - (L[0] * a0[0] + L[1] * a0[1]), oy: c0[1] - (L[2] * a0[0] + L[3] * a0[1]) };
}
const gluedSegs = [];
function glue(a0, a1, b0, b1, flip) {
  const tab = flip ? similarity(a0, a1, b0, b1, true) : similarity(a0, a1, b1, b0, false);
  const tba = flip ? similarity(b0, b1, a0, a1, true) : similarity(b0, b1, a1, a0, false);
  gluedSegs.push({ p0: a0, p1: a1, T: tab }, { p0: b0, p1: b1, T: tba });
}
glue([1, 3], [1, 1], [11, 1], [11, 3], false);       // north alley: a cylinder
glue([1, 15], [1, 12], [11, 12], [11, 15], true);    // south alley: a Möbius band
glue([13, 5], [13, 8], [13, 8], [16, 8], false);     // the L's missing square: a quarter turn about (13,8)

// edge lookup: "x,y,dx,dy" (leaving cell x,y in direction dx,dy) -> transform
const edgeSeam = new Map();
for (const g of gluedSegs) {
  const ex = Math.sign(g.p1[0] - g.p0[0]), ey = Math.sign(g.p1[1] - g.p0[1]);
  const len = Math.abs(g.p1[0] - g.p0[0]) + Math.abs(g.p1[1] - g.p0[1]);
  const nx = -ey, ny = ex;                           // the interior side
  for (let k = 0; k < len; k++) {
    const mx = g.p0[0] + ex * (k + 0.5), my = g.p0[1] + ey * (k + 0.5);
    const cx = Math.floor(mx + nx * 0.5), cy = Math.floor(my + ny * 0.5);
    edgeSeam.set(cx + ',' + cy + ',' + (-nx) + ',' + (-ny), g.T);
  }
}
const applyP = (T, x, y) => [T.L[0] * x + T.L[1] * y + T.ox, T.L[2] * x + T.L[3] * y + T.oy];
const applyL = (T, x, y) => [T.L[0] * x + T.L[1] * y, T.L[2] * x + T.L[3] * y];

// One grid step from a cell, through a glued edge if there is one. Returns the new cell, the
// direction of travel on arrival, and the transform crossed (or null).
function step(x, y, dx, dy) {
  const T = edgeSeam.get(x + ',' + y + ',' + dx + ',' + dy);
  if (!T) return { x: x + dx, y: y + dy, dx, dy, T: null };
  const [cx, cy] = applyP(T, x + 0.5 + dx, y + 0.5 + dy);
  const [ndx, ndy] = applyL(T, dx, dy);
  return { x: Math.floor(cx), y: Math.floor(cy), dx: ndx, dy: ndy, T };
}
const typeAt = (x, y) => (y < 0 || y >= MH || x < 0 || x >= MW) ? OUT : cellT[y][x];
const walkable = (x, y) => typeAt(x, y) === GROUND && !crateAt(x, y);
const blocksSight = t => t === WALL || t === HOUSE || t === OUT;

// Frames: a 2x2 integer matrix M taking world directions to screen directions.
// Orthogonal, so its inverse is its transpose.
const mul = (A, B) => [A[0] * B[0] + A[1] * B[2], A[0] * B[1] + A[1] * B[3], A[2] * B[0] + A[3] * B[2], A[2] * B[1] + A[3] * B[3]];
const tr = A => [A[0], A[2], A[1], A[3]];
const mv = (A, x, y) => [A[0] * x + A[1] * y, A[2] * x + A[3] * y];
const det = A => A[0] * A[3] - A[1] * A[2];

// ======================================================================
// State
// ======================================================================
let P, Q, crates, lightsOn = false, debug = false;
function reset() {
  P = { x: 5.5, y: 8.5, M: [1, 0, 0, 1], face: [0, 1], faceA: Math.PI / 2, walk: 0, moving: false, push: 0 };
  Q = { x: 2, y: 9, fx: 2, fy: 9, t: 1, dir: [1, 0], sface: -1, wait: 0 };
  crates = [{ x: 6, y: 6, fx: 6, fy: 6, t: 1, dir: [0, 1] }, { x: 7, y: 9, fx: 7, fy: 9, t: 1, dir: [0, 1] }];
  bfs.key = '';
}
function crateAt(x, y) { return crates && crates.find(c => c.x === x && c.y === y); }

// ======================================================================
// Moving her: free movement, but every collision is against grid cells
// ======================================================================
const HALF = 0.28;    // half-size of her footprint, in cells

// Where does a point a short distance from p end up, following the straight line out of p
// (through a glued edge if the line crosses one)?
// Does the step a->b leave the area through glued edge s? Each glued edge has its area's
// interior on its left; leaving means starting inside (or exactly on the edge) and ending
// strictly outside, between the edge's two ends.
function crossesSeg(ax, ay, bx, by, s) {
  const ex = s.p1[0] - s.p0[0], ey = s.p1[1] - s.p0[1];
  const sa = ex * (ay - s.p0[1]) - ey * (ax - s.p0[0]);
  const sb = ex * (by - s.p0[1]) - ey * (bx - s.p0[0]);
  if (!(sa >= -1e-9 && sb < -1e-9)) return -1;
  const t = sa / (sa - sb);
  const ix = ax + (bx - ax) * t, iy = ay + (by - ay) * t;
  const u = ((ix - s.p0[0]) * ex + (iy - s.p0[1]) * ey) / (ex * ex + ey * ey);
  return (u >= 0 && u <= 1) ? t : -1;
}
function follow(ax, ay, bx, by) {
  for (const s of gluedSegs) {
    if (crossesSeg(ax, ay, bx, by, s) >= 0) { const [x, y] = applyP(s.T, bx, by); return { x, y, T: s.T }; }
  }
  return { x: bx, y: by, T: null };
}
function footprintFree(x, y) {
  for (const [ox, oy] of [[-HALF, -HALF], [HALF, -HALF], [-HALF, HALF], [HALF, HALF]]) {
    const q = follow(x, y, x + ox, y + oy);
    if (!walkable(Math.floor(q.x), Math.floor(q.y))) return false;
  }
  return true;
}
function movePlayer(sx, sy) {        // (sx, sy): the move on screen, in cells
  const n = Math.max(1, Math.ceil(Math.hypot(sx, sy) / 0.05));
  let blockedX = false, blockedY = false;
  for (let i = 0; i < n; i++) {
    for (const axis of [0, 1]) {
      const ssx = axis === 0 ? sx / n : 0, ssy = axis === 1 ? sy / n : 0;
      if (!ssx && !ssy) continue;
      const Mi = tr(P.M);
      const [dx, dy] = mv(Mi, ssx, ssy);
      const q = follow(P.x, P.y, P.x + dx, P.y + dy);
      if (!footprintFree(q.x, q.y)) { if (axis === 0) blockedX = true; else blockedY = true; continue; }
      P.x = q.x; P.y = q.y;
      if (q.T) P.M = mul(P.M, tr(q.T.L));          // keep the screen continuous across the seam
    }
  }
  return { blockedX, blockedY };
}

// ======================================================================
// What she can see
// ======================================================================
const VI = 6, VJ = 5;                   // screen cells drawn either side of hers
const CONE = 1.15, RANGE = 6.6;         // lamp half-angle (radians) and reach (cells)
let view = new Map();                   // "i,j" -> { x, y, M }

function castRay(ox, oy, ang, range, set) {
  const dx = Math.cos(ang), dy = Math.sin(ang);
  let i = 0, j = 0;
  let cx = Math.floor(P.x), cy = Math.floor(P.y), M = P.M;
  const stepI = dx > 0 ? 1 : -1, stepJ = dy > 0 ? 1 : -1;
  const tdI = Math.abs(1 / (dx || 1e-9)), tdJ = Math.abs(1 / (dy || 1e-9));
  let tI = (dx > 0 ? 0.5 - ox : ox + 0.5) * tdI, tJ = (dy > 0 ? 0.5 - oy : oy + 0.5) * tdJ;
  for (let n = 0; n < 40; n++) {
    let si = 0, sj = 0, t;
    if (tI < tJ) { t = tI; tI += tdI; si = stepI; } else { t = tJ; tJ += tdJ; sj = stepJ; }
    if (t > range) return;
    i += si; j += sj;
    if (Math.abs(i) > VI + 1 || Math.abs(j) > VJ + 1) return;
    const [mdx, mdy] = mv(tr(M), si, sj);
    const r = step(cx, cy, mdx, mdy);
    if (r.T) M = mul(M, tr(r.T.L));
    cx = r.x; cy = r.y;
    const t0 = typeAt(cx, cy);
    if (t0 === OUT) return;
    set(i, j, cx, cy, M);
    if (blocksSight(t0)) {
      // a building is seen whole: light every cell of it, then stop
      if (t0 === HOUSE) lightHouse(i, j, cx, cy, M, set);
      return;
    }
  }
}
function lightHouse(i, j, x, y, M, set) {
  const h = houses.find(h => x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h);
  for (let yy = h.y; yy < h.y + h.h; yy++) for (let xx = h.x; xx < h.x + h.w; xx++) {
    const [si, sj] = mv(M, xx - x, yy - y);
    set(i + si, j + sj, xx, yy, M);
  }
}

function buildView() {
  view = new Map();
  const set = (i, j, x, y, M) => { const k = i + ',' + j; if (!view.has(k)) view.set(k, { x, y, M }); };
  const cx = Math.floor(P.x), cy = Math.floor(P.y);
  set(0, 0, cx, cy, P.M);
  // her offset within her own cell, in screen cells
  const [ox, oy] = mv(P.M, P.x - cx - 0.5, P.y - cy - 0.5);
  if (lightsOn) {
    // flood outward over the whole screen: fine on a flat level, wrong near the pole
    const q = [[0, 0]];
    for (let k = 0; k < q.length; k++) {
      const [i, j] = q[k], v = view.get(i + ',' + j);
      for (const [si, sj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ni = i + si, nj = j + sj;
        if (Math.abs(ni) > VI + 1 || Math.abs(nj) > VJ + 1 || view.has(ni + ',' + nj)) continue;
        const [mdx, mdy] = mv(tr(v.M), si, sj);
        const r = step(v.x, v.y, mdx, mdy);
        if (typeAt(r.x, r.y) === OUT) continue;
        set(ni, nj, r.x, r.y, r.T ? mul(v.M, tr(r.T.L)) : v.M);
        q.push([ni, nj]);
      }
    }
    return;
  }
  // the lamp: a wide cone ahead, plus a small pool of light all round her
  for (let a = -CONE; a <= CONE + 1e-6; a += 0.025) castRay(ox, oy, P.faceA + a, RANGE, set);
  for (let a = 0; a < Math.PI * 2; a += 0.1) castRay(ox, oy, a, 1.6, set);
}

// ======================================================================
// Art (all procedural, in the four shades; -1 = transparent)
// ======================================================================
function hash(x, y) { let h = (x * 374761393 + y * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177 | 0; return ((h ^ (h >>> 16)) >>> 0) / 4294967296; }
const blank = (w = 16, h = 16, v = -1) => ({ w, h, p: new Int8Array(w * h).fill(v) });
const px = (a, x, y, v) => { if (x >= 0 && y >= 0 && x < a.w && y < a.h) a.p[y * a.w + x] = v; };
const get = (a, x, y) => (x >= 0 && y >= 0 && x < a.w && y < a.h) ? a.p[y * a.w + x] : -1;
function rect(a, x0, y0, x1, y1, v) { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(a, x, y, v); }
function outline(a, v = 3) {      // darken pixels on the edge of the shape
  const out = { w: a.w, h: a.h, p: a.p.slice() };
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
    if (get(a, x, y) < 0) continue;
    if (get(a, x - 1, y) < 0 || get(a, x + 1, y) < 0 || get(a, x, y - 1) < 0 || get(a, x, y + 1) < 0) out.p[y * a.w + x] = v;
  }
  return out;
}
function flipH(a) { const o = blank(a.w, a.h); for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) o.p[y * a.w + x] = a.p[y * a.w + a.w - 1 - x]; return o; }
// redraw a square, map-aligned picture as seen through frame M (rotations and flips)
function viewArt(a, M) {
  const o = blank(a.w, a.h), c = (a.w - 1) / 2;
  const Mi = tr(M);
  for (let y = 0; y < a.h; y++) for (let x = 0; x < a.w; x++) {
    const [u, v] = mv(Mi, x - c, y - c);
    o.p[y * a.w + x] = get(a, Math.round(u + c), Math.round(v + c));
  }
  return o;
}

const groundCache = new Map();
function groundArt(x, y) {
  const reg = region(x, y);
  const variant = Math.floor(hash(x, y) * 4);
  const key = reg + variant;
  if (groundCache.has(key)) return groundCache.get(key);
  const a = blank(16, 16, reg === 'alleyS' ? 1 : 0);
  const rnd = (k) => hash(variant * 97 + k, reg.length * 31 + k * 7);
  if (reg === 'start') {          // sand: scattered grains and the odd pebble
    for (let k = 0; k < 9; k++) px(a, Math.floor(rnd(k) * 16), Math.floor(rnd(k + 50) * 16), 1);
    if (variant === 1) { rect(a, 9, 9, 11, 10, 1); px(a, 10, 11, 2); px(a, 11, 11, 2); }
  } else if (reg === 'alleyN') {  // dry grass: tufts
    for (let k = 0; k < 3; k++) {
      const tx = 2 + Math.floor(rnd(k) * 11), ty = 4 + Math.floor(rnd(k + 9) * 10);
      px(a, tx, ty, 2); px(a, tx - 1, ty - 1, 1); px(a, tx + 1, ty - 1, 1); px(a, tx, ty - 2, 2); px(a, tx + 2, ty - 2, 1);
    }
    for (let k = 0; k < 6; k++) px(a, Math.floor(rnd(k + 20) * 16), Math.floor(rnd(k + 40) * 16), 1);
  } else if (reg === 'alleyS') {  // red gravel
    for (let k = 0; k < 14; k++) px(a, Math.floor(rnd(k) * 16), Math.floor(rnd(k + 60) * 16), rnd(k + 3) > 0.5 ? 0 : 2);
  } else {                        // flagstones
    const off = variant & 1 ? 5 : 9;
    rect(a, 0, 7, 15, 7, 1); rect(a, off, 0, off, 6, 1); rect(a, (off + 6) % 16, 8, (off + 6) % 16, 15, 1);
    px(a, 3, 3, 1); px(a, 12, 12, 1);
  }
  groundCache.set(key, a);
  return a;
}
const glyphArt = (() => { const a = blank(16, 16); rect(a, 5, 3, 7, 12, 3); rect(a, 8, 10, 11, 12, 3); return a; })();

const wallArt = (() => {
  const top = blank(16, 16, 1), face = blank(16, 16, 1);
  for (let k = 0; k < 10; k++) px(top, Math.floor(hash(k, 3) * 16), Math.floor(hash(k, 9) * 16), 0);
  for (let k = 0; k < 6; k++) px(top, Math.floor(hash(k, 13) * 16), Math.floor(hash(k, 19) * 16), 2);
  // face: the top 5 rows are the wall's top, the rest its sunlit side
  for (let y = 0; y < 5; y++) for (let x = 0; x < 16; x++) face.p[y * 16 + x] = top.p[y * 16 + x];
  rect(face, 0, 5, 15, 5, 0);
  rect(face, 0, 6, 15, 15, 2);
  for (const by of [9, 13]) rect(face, 0, by, 15, by, 3);
  for (const [bx, by0, by1] of [[4, 6, 8], [12, 6, 8], [0, 10, 12], [8, 10, 12], [4, 14, 15], [12, 14, 15]]) rect(face, bx, by0, bx, by1, 3);
  return { top, face };
})();

const crateArt = (() => {
  const a = blank(16, 16);
  rect(a, 1, 2, 14, 6, 0);
  rect(a, 1, 7, 14, 15, 1);
  for (const y of [10, 13]) rect(a, 2, y, 13, y, 2);
  rect(a, 3, 3, 12, 3, 1); rect(a, 3, 5, 12, 5, 1);
  return outline(a);
})();

// a house seen from each side: pictures in whole cells
function housePicture(view, wCells, hCells) {
  const W = wCells * 16, H = hCells * 16;
  const a = blank(W, H);
  const side = view === 'east' || view === 'west';
  const roofH = side ? H - 13 : H - 14;
  // roof
  for (let y = 0; y < roofH; y++) for (let x = 0; x < W; x++) {
    let v = 2;
    if (side) { if ((x + (y >> 2)) % 6 === 0) v = 3; }       // ridge runs away from you: tiles in columns
    else if (y % 4 === 3) v = 3;
    if (y === 0 || y === roofH - 1) v = 3;
    a.p[y * W + x] = v;
  }
  if (!side) rect(a, 0, Math.floor(roofH / 2), W - 1, Math.floor(roofH / 2), 1);   // the ridge
  else { const rx = Math.floor(W / 2); rect(a, rx, 0, rx, roofH - 1, 1); }
  // wall face
  rect(a, 0, roofH, W - 1, H - 1, 1);
  rect(a, 0, H - 1, W - 1, H - 1, 3);
  const mid = Math.floor(W / 2);
  if (view === 'front') {      // the door
    rect(a, mid - 4, roofH + 2, mid + 3, H - 1, 3); rect(a, mid - 3, roofH + 3, mid + 2, H - 2, 2); px(a, mid + 1, roofH + 8, 0);
    rect(a, 6, roofH + 3, 11, roofH + 7, 3); rect(a, 7, roofH + 4, 10, roofH + 6, 0);
    rect(a, W - 12, roofH + 3, W - 7, roofH + 7, 3); rect(a, W - 11, roofH + 4, W - 8, roofH + 6, 0);
  } else if (view === 'back') { // one small window, no door
    rect(a, mid - 3, roofH + 3, mid + 2, roofH + 8, 3); rect(a, mid - 2, roofH + 4, mid + 1, roofH + 7, 0);
  } else if (view === 'east') { // a side window
    rect(a, mid - 3, roofH + 3, mid + 2, roofH + 8, 3); rect(a, mid - 2, roofH + 4, mid + 1, roofH + 7, 0);
  }                             // west: a plain wall
  return outline(a);
}
const housePics = {
  front: housePicture('front', 3, 2), back: housePicture('back', 3, 2),
  east: housePicture('east', 2, 3), west: housePicture('west', 2, 3),
};

// the pole, seen from above: a round post. Each of the three cells around its corner shows
// the quarter of it that falls in that cell.
function poleArt(cornerSX, cornerSY) {
  const a = blank(16, 16, -1);
  const cx = cornerSX > 0 ? 16 : 0, cy = cornerSY > 0 ? 16 : 0;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    if (d < 12.5) a.p[y * 16 + x] = d > 11.2 ? 3 : (d > 9 ? 2 : (Math.abs(d - 5) < 0.7 ? 2 : 1));
  }
  return a;
}

// her: a striped poncho on long legs. dir 0 down, 1 up, 2 left (right = flipped).
function girlArt(dir, frame) {
  const a = blank(16, 24);
  // legs (frame 1/2 lift one foot)
  const lift = [0, 1, -1][frame];
  if (dir === 2) {
    const s = [0, 2, -2][frame];
    rect(a, 7 - s, 16, 7 - s, 21, 3); rect(a, 9 + s, 16, 9 + s, 21, 3);
    rect(a, 5 - s, 22, 7 - s, 22, 3); rect(a, 7 + s, 22, 9 + s, 22, 3);
  } else {
    rect(a, 6, 16, 6, 21 - (lift > 0 ? 1 : 0), 3); rect(a, 9, 16, 9, 21 - (lift < 0 ? 1 : 0), 3);
    rect(a, 5, 22 - (lift > 0 ? 1 : 0), 6, 22 - (lift > 0 ? 1 : 0), 3); rect(a, 9, 22 - (lift < 0 ? 1 : 0), 10, 22 - (lift < 0 ? 1 : 0), 3);
  }
  // poncho: a widening trapezoid in stripes
  for (let y = 9; y <= 16; y++) {
    const half = 3 + Math.floor((y - 9) * 0.75);
    for (let x = 8 - half; x < 8 + half; x++) px(a, x, y, (y === 11 || y === 14) ? 0 : (y === 12 ? 1 : 2));
  }
  // head
  for (let y = 0; y < 10; y++) for (let x = 0; x < 16; x++) {
    const d = Math.hypot(x + 0.5 - 8, y + 0.5 - 5);
    if (d < 4.6) a.p[y * 16 + x] = 3;   // hair
  }
  if (dir === 0) { rect(a, 5, 4, 10, 8, 0); px(a, 6, 6, 3); px(a, 9, 6, 3); rect(a, 5, 4, 10, 4, 3); }
  else if (dir === 2) { rect(a, 4, 4, 7, 8, 0); px(a, 5, 6, 3); px(a, 3, 7, 0); }
  return outline(a);
}
// the scaled quail, side on, facing left
function quailArt(frame) {
  const a = blank(16, 16);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const body = ((x + 0.5 - 9) / 5.6) ** 2 + ((y + 0.5 - 10) / 3.9) ** 2 < 1;
    const head = Math.hypot(x + 0.5 - 4.5, y + 0.5 - 6) < 2.8;
    const tail = x >= 13 && x <= 15 && y >= 7 && y <= 9;
    if (body || head || tail) a.p[y * 16 + x] = 1;
    if (body && (x + y * 3) % 5 === 0 && y < 12) a.p[y * 16 + x] = 2;     // scaly feathers
    if (body && y >= 12) a.p[y * 16 + x] = 0;                              // pale belly
  }
  rect(a, 4, 2, 5, 3, 0);                     // white cotton-top crest
  px(a, 3, 6, 3); px(a, 1, 7, 3); px(a, 2, 7, 3);   // eye, beak
  const s = frame ? 1 : 0;
  rect(a, 8 - s, 14, 8 - s, 15, 3); rect(a, 10 + s, 14, 10 + s, 15, 3);
  return outline(a);
}
const girl = [0, 1, 2].map(d => [0, 1, 2].map(f => girlArt(d, f)));
const quail = [quailArt(0), quailArt(1)];

// ======================================================================
// Drawing
// ======================================================================
function blit(a, sx, sy, dark = false) {
  for (let y = 0; y < a.h; y++) {
    const yy = sy + y; if (yy < 0 || yy >= SH) continue;
    for (let x = 0; x < a.w; x++) {
      const xx = sx + x; if (xx < 0 || xx >= SW) continue;
      const v = a.p[y * a.w + x]; if (v < 0) continue;
      fb[yy * SW + xx] = dark && ((xx ^ yy) & 1) ? 3 : v;
    }
  }
}
// draw part of a bigger picture into one cell
function blitPart(a, ox, oy, sx, sy, dark) {
  for (let y = 0; y < 16; y++) {
    const yy = sy + y; if (yy < 0 || yy >= SH) continue;
    for (let x = 0; x < 16; x++) {
      const xx = sx + x; if (xx < 0 || xx >= SW) continue;
      const v = get(a, ox + x, oy + y); if (v < 0) continue;
      fb[yy * SW + xx] = dark && ((xx ^ yy) & 1) ? 3 : v;
    }
  }
}

const viewCache = new Map();
function cachedView(key, a, M) { const k = key + M.join(','); let v = viewCache.get(k); if (!v) { v = viewArt(a, M); viewCache.set(k, v); } return v; }
const flipCache = new Map();
function cachedFlip(key, a) { let v = flipCache.get(key); if (!v) { v = flipH(a); flipCache.set(key, v); } return v; }

let tilesInUse = new Set();

function drawCell(c, i, j, sx, sy, edge) {
  const t = typeAt(c.x, c.y);
  const gk = 'g' + region(c.x, c.y) + Math.floor(hash(c.x, c.y) * 4);
  // the ground under everything
  if (t !== WALL && t !== OUT) {
    blit(groundArt(c.x, c.y), sx, sy, edge); tilesInUse.add(gk);
    if (glyphs.has(c.x + ',' + c.y)) { blit(cachedView('L', glyphArt, c.M), sx, sy, edge); tilesInUse.add('L' + c.M.join()); }
  }
  if (t === WALL) {
    const below = view.get(i + ',' + (j + 1));
    const showFace = below && typeAt(below.x, below.y) !== WALL;
    blit(showFace ? wallArt.face : wallArt.top, sx, sy, edge); tilesInUse.add(showFace ? 'wf' : 'wt');
  } else if (t === HOUSE) {
    const h = houses.find(h => c.x >= h.x && c.x < h.x + h.w && c.y >= h.y && c.y < h.y + h.h);
    // which side of the house faces the viewer: the world direction that is "down" on screen here
    const [dx, dy] = mv(tr(c.M), 0, 1);
    const f = h.front;
    let pic, name;
    if (dx === f[0] && dy === f[1]) name = 'front';
    else if (dx === -f[0] && dy === -f[1]) name = 'back';
    else name = (dx === -f[1] && dy === f[0]) ? 'west' : 'east';
    pic = housePics[name];
    if (det(c.M) < 0) pic = cachedFlip(name, pic);
    // where this cell sits within the house as seen on screen
    let minX = 1e9, minY = 1e9;
    for (let yy = h.y; yy < h.y + h.h; yy++) for (let xx = h.x; xx < h.x + h.w; xx++) {
      const [s1, s2] = mv(c.M, xx + 0.5, yy + 0.5); minX = Math.min(minX, s1); minY = Math.min(minY, s2);
    }
    const [s1, s2] = mv(c.M, c.x + 0.5, c.y + 0.5);
    const ox = Math.round(s1 - minX) * 16, oy = Math.round(s2 - minY) * 16;
    blitPart(pic, ox, oy, sx, sy, edge); tilesInUse.add('h' + name + det(c.M) + ox + ',' + oy);
  } else if (t === POLE) {
    const [csx, csy] = mv(c.M, POLE_AT[0] - (c.x + 0.5), POLE_AT[1] - (c.y + 0.5));
    blit(poleArt(Math.sign(csx), Math.sign(csy)), sx, sy, edge); tilesInUse.add('p' + Math.sign(csx) + Math.sign(csy));
  }
}

let frameNo = 0;
function render() {
  fb.fill(3);
  tilesInUse = new Set();
  const cx = Math.floor(P.x), cy = Math.floor(P.y);
  const [ox, oy] = mv(P.M, P.x - cx - 0.5, P.y - cy - 0.5);
  const ax = 80, ay = 80;                         // where her feet go on screen
  const cellPos = (i, j) => [Math.round(ax + (i - ox) * CELL - 8), Math.round(ay + (j - oy) * CELL - 8)];
  const reach = (i, j) => Math.hypot(i - ox, j - oy);
  for (let j = -VJ - 1; j <= VJ + 1; j++) for (let i = -VI - 1; i <= VI + 1; i++) {
    const c = view.get(i + ',' + j); if (!c) continue;
    const [sx, sy] = cellPos(i, j);
    drawCell(c, i, j, sx, sy, !lightsOn && reach(i, j) > RANGE - 1.2);
  }
  // things that move: crates, the quail, her. Each is drawn wherever its cell appears.
  const sprites = [];
  const where = new Map();
  for (const [k, c] of view) { const key = c.x + ',' + c.y; if (!where.has(key)) where.set(key, []); where.get(key).push([...k.split(',').map(Number), c]); }
  const place = (x, y, dir, t, fn) => {
    for (const [i, j, c] of where.get(x + ',' + y) || []) {
      const [sdx, sdy] = mv(c.M, dir[0], dir[1]);
      const [sx, sy] = cellPos(i, j);
      fn(sx - Math.round(sdx * 16 * (1 - t)), sy - Math.round(sdy * 16 * (1 - t)), c, sdx, sdy, reach(i, j));
    }
  };
  for (const cr of crates) place(cr.x, cr.y, cr.dir, cr.t, (sx, sy, c, a, b, r) => sprites.push({ y: sy + 15, draw: () => blit(crateArt, sx, sy, !lightsOn && r > RANGE - 1.2) }));
  place(Q.x, Q.y, Q.dir, Q.t, (sx, sy, c, sdx, sdy, r) => {
    let left = Q.sface < 0;
    if (Q.t < 1 && sdx) left = sdx < 0;
    const art = quail[Q.t < 1 ? (frameNo >> 2) & 1 : 0];
    sprites.push({ y: sy + 14, draw: () => blit(left ? art : cachedFlip('q' + (art === quail[0] ? 0 : 1), art), sx, sy, !lightsOn && r > RANGE - 1.2) });
  });
  // her
  const f = P.face;
  const dir = Math.abs(f[0]) > Math.abs(f[1]) ? 2 : (f[1] < 0 ? 1 : 0);
  const fr = P.moving ? 1 + ((P.walk >> 3) & 1) : 0;
  let art = girl[dir][fr];
  if (dir === 2 && f[0] > 0) art = cachedFlip('g' + fr, art);
  sprites.push({ y: ay + 4, draw: () => blit(art, ax - 8, ay - 21) });
  sprites.sort((a, b) => a.y - b.y).forEach(s => s.draw());

  // to the screen
  const d = img.data;
  for (let k = 0; k < SW * SH; k++) { const c = PAL[fb[k]]; d[k * 4] = c[0]; d[k * 4 + 1] = c[1]; d[k * 4 + 2] = c[2]; d[k * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  if (debug) {
    document.getElementById('debug').textContent =
      `cell ${cx},${cy}  frame [${P.M.join(',')}]${det(P.M) < 0 ? ' mirrored' : ''}\n` +
      `screen cells lit ${view.size}   different 16x16 cells on screen ${tilesInUse.size} (~${tilesInUse.size * 4} of 256 tiles)\n` +
      `lights ${lightsOn ? 'on (L)' : 'lamp (L)'}`;
  }
}

// ======================================================================
// The quail: follows by the shortest route, glued edges included
// ======================================================================
const bfs = { key: '', dist: new Map() };
function computeBFS() {
  const sx = Math.floor(P.x), sy = Math.floor(P.y);
  const dist = new Map([[sx + ',' + sy, 0]]);
  const q = [[sx, sy]];
  for (let k = 0; k < q.length; k++) {
    const [x, y] = q[k], d = dist.get(x + ',' + y);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const r = step(x, y, dx, dy);
      const key = r.x + ',' + r.y;
      if (dist.has(key) || !walkable(r.x, r.y)) continue;
      dist.set(key, d + 1); q.push([r.x, r.y]);
    }
  }
  bfs.dist = dist; bfs.key = sx + ',' + sy;
}
function updateQuail() {
  if (Q.t < 1) { Q.t = Math.min(1, Q.t + 1 / 7); return; }
  const key = Math.floor(P.x) + ',' + Math.floor(P.y);
  if (bfs.key !== key) computeBFS();
  const here = bfs.dist.get(Q.x + ',' + Q.y);
  const onHer = Q.x === Math.floor(P.x) && Q.y === Math.floor(P.y);
  if (!onHer && (here === undefined || here <= 2)) return;      // close enough: wait
  let best = null, bd = onHer ? -1 : here;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const r = step(Q.x, Q.y, dx, dy);
    if (!walkable(r.x, r.y)) continue;
    const d = bfs.dist.get(r.x + ',' + r.y);
    if (d === undefined) continue;
    if (onHer ? d >= bd : d < bd) { bd = d; best = r; }        // on her square: hop away; otherwise: closer
  }
  if (!best) return;
  Q.fx = Q.x; Q.fy = Q.y; Q.x = best.x; Q.y = best.y; Q.dir = [best.dx, best.dy]; Q.t = 0;
}

// ======================================================================
// Crates: lean into one for a moment and it slides one cell
// ======================================================================
function tryPush(fs) {               // fs: the screen direction she's pushing in (cardinal)
  const cx = Math.floor(P.x), cy = Math.floor(P.y);
  const [mdx, mdy] = mv(tr(P.M), fs[0], fs[1]);
  const front = step(cx, cy, mdx, mdy);
  const c = crateAt(front.x, front.y);
  if (!c || c.t < 1) return false;
  const to = step(front.x, front.y, front.dx, front.dy);
  if (typeAt(to.x, to.y) !== GROUND || crateAt(to.x, to.y)) return false;
  if (to.x === Q.x && to.y === Q.y) { Q.x = -99; bfs.key = ''; }   // (never happens in practice; the quail moves first)
  c.x = to.x; c.y = to.y; c.dir = [to.dx, to.dy]; c.t = 0;
  bfs.key = '';
  return true;
}

// ======================================================================
// Input and loop
// ======================================================================
const keys = new Set();
addEventListener('keydown', e => {
  keys.add(e.code);
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (e.repeat) return;
  document.getElementById('title').style.display = 'none';
  if (e.code === 'KeyL') lightsOn = !lightsOn;
  if (e.code === 'KeyR') reset();
  if (e.code === 'Backquote') { debug = !debug; document.getElementById('debug').style.display = debug ? 'block' : 'none'; }
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

const SPEED = 1 / 16;                 // a pixel a frame, like Link
function tick() {
  frameNo++;
  let sx = 0, sy = 0;
  if (keys.has('ArrowLeft') || keys.has('KeyA')) sx -= 1;
  if (keys.has('ArrowRight') || keys.has('KeyD')) sx += 1;
  if (keys.has('ArrowUp') || keys.has('KeyW')) sy -= 1;
  if (keys.has('ArrowDown') || keys.has('KeyS')) sy += 1;
  P.moving = !!(sx || sy);
  if (P.moving) {
    const l = Math.hypot(sx, sy);
    const res = movePlayer(sx / l * SPEED, sy / l * SPEED);
    P.walk++;
    P.face = [sx, sy];
    const target = Math.atan2(sy, sx);
    let d = target - P.faceA; d = Math.atan2(Math.sin(d), Math.cos(d));
    P.faceA += d * 0.25;
    // pushing: straight into a crate for a moment
    const card = (sx && !sy) ? [Math.sign(sx), 0] : (sy && !sx) ? [0, Math.sign(sy)] : null;
    if (card && ((card[0] && res.blockedX) || (card[1] && res.blockedY))) {
      if (++P.push > 18) { tryPush(card); P.push = 0; }
    } else P.push = 0;
  } else P.push = 0;
  for (const c of crates) if (c.t < 1) c.t = Math.min(1, c.t + 1 / 12);
  updateQuail();
  if (Q.t >= 1 && Q.dir[0]) Q.sface = Q.dir[0];
  buildView();
}

function fit() {
  const s = Math.max(1, Math.floor(Math.min(innerWidth / SW, innerHeight / SH)));
  canvas.style.width = SW * s + 'px'; canvas.style.height = SH * s + 'px';
}
addEventListener('resize', fit); fit();

reset(); buildView();
let last = performance.now(), acc = 0;
function loop(now) {
  acc += Math.min(0.1, (now - last) / 1000); last = now;
  if (!window.__freeze) { while (acc >= 1 / 60) { tick(); acc -= 1 / 60; } render(); } else acc = 0;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

window.GENUS = { get P() { return P; }, get Q() { return Q; }, get crates() { return crates; }, step, tick, render, reset, buildView,
  setLights(v) { lightsOn = v; }, keys, edgeSeam, view: () => view, follow, footprintFree, movePlayer, walkable, gluedSegs, crossesSeg };
})();
