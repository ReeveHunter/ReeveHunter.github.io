// Genus — prototype, v2 (grid).
// A first-person/follow-camera world on a flat surface with glued edges. Rendering is a
// per-pixel ray tracer in a fragment shader: rays travel through the floor plan, and when one
// passes through a doorway that is glued somewhere else, it is carried across by that
// doorway's similarity transform (translation, rotation, reflection and/or uniform scale).
//
// Movement is on a grid whose cell is one body-width: 1 unit at normal size, 1/2 at half
// size, and so on. All walls and doorways sit on grid lines at every size the level allows,
// and glued doorways map grid lines to grid lines, so a cell centre always lands on a cell
// centre on the far side.

(() => {
'use strict';

// ======================================================================
// Level
// ======================================================================
const CEIL = 1e4;          // no roof: the sky is open
const WALL = 4.0;          // wall height: above her eyes and the camera even at double size, so nothing is seen over a wall
const OPEN = 1e4;          // "height" of an open gap
const FRAME = 0.1;         // doorway thickness on each side of a wall
const segs = [];
function seg(x0, y0, x1, y1, o = {}) {
  segs.push({ x0, y0, x1, y1, door: !!o.door, h: o.h ?? OPEN, portal: 0, glyph: o.glyph || 0, gu: o.gu || 0, frame: !!o.frame });
  return segs.length - 1;
}
// A gap in a wall, with short jamb walls so it has some thickness (only on the yard side, for
// a glued gap). Glued gaps must be listed with the yard's interior on their left (p0 to p1).
// A gap's width is the largest size that fits through it.
function door(x0, y0, x1, y1, glued) {
  const i = seg(x0, y0, x1, y1, { door: true });
  const ex = x1 - x0, ey = y1 - y0, l = Math.hypot(ex, ey), nx = -ey / l * FRAME, ny = ex / l * FRAME;
  for (const sd of glued ? [1] : [1, -1]) {
    seg(x0, y0, x0 + sd * nx, y0 + sd * ny, { frame: true });
    seg(x1, y1, x1 + sd * nx, y1 + sd * ny, { frame: true });
  }
  return i;
}

const portals = [{ L: [1, 0, 0, 1], ox: 0, oy: 0, s: 1, det: 1 }]; // 0 = identity
const pairs = [];

// The similarity of the plane taking a0->c0 and a1->c1, orientation-preserving or reversing.
function similarity(a0, a1, c0, c1, reverse) {
  const ex = a1.x - a0.x, ey = a1.y - a0.y, fx = c1.x - c0.x, fy = c1.y - c0.y;
  const den = ex * ex + ey * ey;
  let L;
  if (!reverse) { const ar = (fx * ex + fy * ey) / den, ai = (fy * ex - fx * ey) / den; L = [ar, -ai, ai, ar]; }
  else { const ar = (fx * ex - fy * ey) / den, ai = (fy * ex + fx * ey) / den; L = [ar, ai, ai, -ar]; }
  const ox = c0.x - (L[0] * a0.x + L[1] * a0.y), oy = c0.y - (L[2] * a0.x + L[3] * a0.y);
  const det = L[0] * L[3] - L[1] * L[2];
  return { L, ox, oy, s: Math.sqrt(Math.abs(det)), det };
}
// Glue doorway i to doorway j. Without a flip, p0 of one meets p1 of the other.
function link(i, j, flip) {
  const A = segs[i], B = segs[j];
  const a0 = { x: A.x0, y: A.y0 }, a1 = { x: A.x1, y: A.y1 }, b0 = { x: B.x0, y: B.y0 }, b1 = { x: B.x1, y: B.y1 };
  const tab = flip ? similarity(a0, a1, b0, b1, true) : similarity(a0, a1, b1, b0, false);
  const tba = flip ? similarity(b0, b1, a0, a1, true) : similarity(b0, b1, a1, a0, false);
  A.portal = portals.push(tab) - 1; B.portal = portals.push(tba) - 1;
  pairs.push({ i, j, flip });
}

// Everything is sized for double size (a 2-unit square), so every wall and gap sits on even
// coordinates, apart from the one gap meant only for normal size and smaller.
//
// West yard G (x -6..0, y 0..6). Its north gap (2 wide) is glued to its own west gap (1 wide).
seg(-6, 6, -4, 6);
const gBig = door(-2, 6, -4, 6, true);
seg(-2, 6, 0, 6);
seg(-6, 0, -6, 2);
const gSmall = door(-6, 3, -6, 2, true);
seg(-6, 3, -6, 6);
seg(-6, 0, 0, 0);
seg(0, 0, 0, 2);
door(0, 2, 0, 4);                         // G <-> A
seg(0, 4, 0, 6);
// Start yard A (x 0..6, y 0..6), with the passages' inner walls.
seg(0, 6, 2, 6);
door(2, 6, 4, 6);                         // A <-> north passage
seg(4, 6, 12, 6);
seg(6, 6, 6, 2, { glyph: 1, gu: 1 });
door(6, 0, 6, 2);                         // A <-> pillar yard
seg(0, 0, 2, 0);
door(2, 0, 4, 0);                         // A <-> south passage
seg(4, 0, 12, 0);
// Pillar yard: an L of three 2x2 squares. The missing square's two edges are glued by a quarter
// turn about the inner corner, so there is only 270 degrees of ground around that corner.
seg(6, 4, 8, 4);
seg(10, 0, 10, 2);
const pA = seg(8, 2, 8, 4, { door: true });
const pB = seg(10, 2, 8, 2, { door: true });
// North passage C (y 6..8): ends glued straight (a cylinder).
seg(0, 8, 12, 8, { glyph: 1, gu: 6 });
const cE = seg(12, 6, 12, 8, { door: true });
const cW = seg(0, 8, 0, 6, { door: true });
// South passage F (y -2..0): ends glued with a flip (a Möbius band).
seg(12, -2, 0, -2, { glyph: 1, gu: 6 });
const fE = seg(12, -2, 12, 0, { door: true });
const fW = seg(0, 0, 0, -2, { door: true });

link(gBig, gSmall, false);
link(cE, cW, false);
link(fE, fW, true);
link(pA, pB, false);

const rooms = [
  { x0: 0, y0: 0, x1: 6, y1: 6, fill: '#ead8b9' },
  { x0: -6, y0: 0, x1: 0, y1: 6, fill: '#f1ece0' },
  { x0: 0, y0: 6, x1: 12, y1: 8, fill: '#e3d7b4' },
  { x0: 0, y0: -2, x1: 12, y1: 0, fill: '#e8cdb8' },
  { x0: 6, y0: 0, x1: 10, y1: 2, fill: '#e6d3b0' },
  { x0: 6, y0: 2, x1: 8, y1: 4, fill: '#e6d3b0' },
];
const staticBoxes = [
  { minx: 4.0, miny: 4.0, maxx: 5.995, maxy: 5.995, z0: 0, z1: 1.0, kind: 0 },   // ledge in A
  // a low sill just inside the small west gap. Arriving there at quarter size you can step
  // onto it; arriving at an eighth you can't, so quarter size is the smallest you can get.
  { minx: -5.995, miny: 2.0, maxx: -5.75, maxy: 3.0, z0: 0, z1: 0.1, kind: 0 },
];
// round obstacles: the pillar sits on the cone point
const pillars = [{ x: 8, y: 2, r: 0.42, h: 3.2 }];

// ======================================================================
// Rules
// ======================================================================
const PLAYER_H = 1.7, CRAWL = 0.55;
const SIZES = [2, 1, 0.5, 0.25];          // 1/8 is reserved for the finale
const QCELL = 0.25;                       // the quail moves like you do at quarter size
const QUAIL_H = 0.36;
const STEP_T = 0.2, CRAWL_T = 0.36, PUSH_T = 0.34, QUAIL_T = 0.1, RIDE_T = 0.085;
const EPS = 1e-6;

function playerBody() {
  if (P.riding) return { cell: QCELL, h: QUAIL_H + 0.5 * PLAYER_H * P.s, climb: 0.5 * QCELL, scales: false, pusher: false, who: 'ride' };
  return { cell: P.s, h: PLAYER_H * P.s * CRAWL, climb: 0.5 * P.s, scales: true, pusher: true, who: 'player' };
}
const quailBody = () => ({ cell: QCELL, h: QUAIL_H, climb: 0.5 * QCELL, scales: false, pusher: false, who: 'quail' });

let P, Q, crates, plant, logged;

function reset() {
  P = { x: 2.5, y: 1.5, z: 0, fx: 0, fy: 1, rx: 1, ry: 0, bx: 0, by: 1, pitch: -0.3, s: 1, crawl: false,
        riding: false, plan: null, eye: 1.58, vx: 0, vy: 0 };
  Q = { x: 1.625, y: 2.375, z: 0, fx: 1, fy: 0, m: 1, phase: 0, moving: false, peck: 0, peckT: 2, plan: null };
  crates = [
    { x: 2.75, y: 4.25, size: 0.5, z0: 0 },
    { x: -2.5, y: 1.5, size: 1, z0: 0 },
  ];
  plant = { x: 5.5, y: 5.5, z: 1.0 };
  logged = { quail: false, plant: false };
  feet = null; bfs.at = -1;
  renderJournalText();
}

// ======================================================================
// Geometry helpers
// ======================================================================
function applyP(T, x, y) { return [T.L[0] * x + T.L[1] * y + T.ox, T.L[2] * x + T.L[3] * y + T.oy]; }
function applyL(T, x, y) { return [T.L[0] * x + T.L[1] * y, T.L[2] * x + T.L[3] * y]; }
function norm(x, y) { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; }
// Where along a->b does the path cross segment s (0..1), or null.
function crossParam(ax, ay, bx, by, s) {
  const rx = bx - ax, ry = by - ay, sx = s.x1 - s.x0, sy = s.y1 - s.y0;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = s.x0 - ax, qy = s.y0 - ay;
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  return (t > 1e-7 && t <= 1 && u >= -1e-9 && u <= 1 + 1e-9) ? t : null;
}
function blocks(s, z, h) { return !s.door || z + h > s.h - 1e-6; }

function crateBox(c) { const hs = c.size / 2; return { minx: c.x - hs, miny: c.y - hs, maxx: c.x + hs, maxy: c.y + hs, z0: c.z0, z1: c.z0 + c.size, kind: 1, crate: c }; }
function worldBoxes() { return staticBoxes.concat(crates.map(crateBox)); }
// boxes overlapping a small square around (x,y)
function boxesAt(x, y, half) {
  return worldBoxes().filter(b => x + half > b.minx && x - half < b.maxx && y + half > b.miny && y - half < b.maxy);
}
function snapSize(s) { return Math.pow(2, Math.round(Math.log2(s))); }

// ======================================================================
// Probing one grid step
// ======================================================================
// Try to move a body one cell from (x,y,z) by (dx,dy). Returns null if blocked, otherwise
// the end point (in whatever frame the step finishes in), the floor height there, the
// glued doorways crossed (with where along the step each happens), and any crate pushed.
function probe(b, x, y, z, dx, dy, opts = {}) {
  let sx = x, sy = y, ex = x + dx, ey = y + dy, zz = z, h = b.h, climb = b.climb, cell = b.cell;
  let p0 = 0;
  const crossings = [];
  for (let iter = 0; iter < 8; iter++) {
    let best = -1, bu = Infinity;
    for (let k = 0; k < segs.length; k++) {
      const u = crossParam(sx, sy, ex, ey, segs[k]);
      if (u !== null && u < bu) { bu = u; best = k; }
    }
    // low obstacles along the way (sills, ledges), but not crates: those are whole cells
    const uEnd = best < 0 ? 1 : bu;
    for (let i = 1; i <= 6; i++) {
      const t = uEnd * i / 6, px = sx + (ex - sx) * t, py = sy + (ey - sy) * t;
      for (const bx of staticBoxes) {
        if (px > bx.minx + EPS && px < bx.maxx - EPS && py > bx.miny + EPS && py < bx.maxy - EPS &&
            bx.z1 > zz + climb + EPS && bx.z0 < zz + h) return null;
      }
    }
    // her body has width: the path can't pass close to the end of a wall (a gap narrower
    // than her square stops her), and can't pass through a pillar
    const qx = sx + (ex - sx) * uEnd, qy = sy + (ey - sy) * uEnd;
    for (const w of segs) {
      if (w.door || w.frame) continue;
      if (distToPath(w.x0, w.y0, sx, sy, qx, qy) < 0.4 * cell || distToPath(w.x1, w.y1, sx, sy, qx, qy) < 0.4 * cell) return null;
    }
    for (const c of pillars) if (distToPath(c.x, c.y, sx, sy, qx, qy) < c.r) return null;
    if (best < 0) break;
    const s = segs[best];
    if (blocks(s, zz, h)) return null;
    const cx = sx + (ex - sx) * bu, cy = sy + (ey - sy) * bu;
    const g = p0 + bu * (1 - p0);
    if (s.portal) {
      if (opts.noPortals) return null;
      const T = portals[s.portal];
      crossings.push({ u: g, T });
      [sx, sy] = applyP(T, cx, cy); [ex, ey] = applyP(T, ex, ey);
      zz *= T.s;
      if (b.scales) { h *= T.s; climb *= T.s; cell *= T.s; }
    } else { sx = cx; sy = cy; }
    p0 = g;
  }
  // the destination cell
  let floor = 0, push = null;
  for (const bx of boxesAt(ex, ey, 0.2 * cell)) {
    if (bx.z1 <= zz + climb + EPS) { floor = Math.max(floor, bx.z1); continue; }
    if (bx.z0 >= zz + h) continue;
    if (bx.crate && b.pusher && Math.abs(bx.crate.size - cell) < 1e-6 && !push && !opts.noPush) {
      const [ux, uy] = norm(ex - sx, ey - sy);
      push = { crate: bx.crate, vx: ux * cell, vy: uy * cell };
      continue;
    }
    return null;
  }
  if (push) {
    if (!crateCanMove(push.crate, push.vx, push.vy)) return null;
    floor = 0;
    for (const bx of boxesAt(ex, ey, 0.2 * cell)) if (bx.crate !== push.crate && bx.z1 <= zz + climb + EPS) floor = Math.max(floor, bx.z1);
  }
  if (CEIL - floor < h - EPS) return null;
  return { ex, ey, z: floor, crossings, push, cell };
}

function distToPath(px, py, ax, ay, bx, by) {
  const ex = bx - ax, ey = by - ay, l2 = ex * ex + ey * ey;
  let t = l2 > 0 ? ((px - ax) * ex + (py - ay) * ey) / l2 : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * ex), py - (ay + t * ey));
}

function crateCanMove(c, vx, vy, ignoreAt) {
  const nx = c.x + vx, ny = c.y + vy, hs = c.size / 2;
  for (const s of segs) {
    if (s.door && !s.portal && !blocks(s, c.z0, c.size)) continue;
    // any wall or glued doorway between the old and new position, or touching the new square
    if (crossParam(c.x, c.y, nx, ny, s) !== null) return false;
    for (const [ox, oy] of [[-hs, -hs], [hs, -hs], [-hs, hs], [hs, hs]]) {
      if (crossParam(c.x + ox * 0.98, c.y + oy * 0.98, nx + ox * 0.98, ny + oy * 0.98, s) !== null) return false;
    }
  }
  for (const b of worldBoxes()) {
    if (b.crate === c || b.z1 <= c.z0 + EPS || b.z0 >= c.z0 + c.size - EPS) continue;
    if (nx - hs < b.maxx - EPS && nx + hs > b.minx + EPS && ny - hs < b.maxy - EPS && ny + hs > b.miny + EPS) return false;
  }
  for (const p of pillars) if (Math.abs(p.x - nx) < hs + p.r && Math.abs(p.y - ny) < hs + p.r) return false;
  // don't run over the quail or the player
  if (Math.abs(Q.x - nx) < hs && Math.abs(Q.y - ny) < hs && Q.z < c.z0 + c.size) return false;
  if (!P.riding && Math.abs(P.x - nx) < hs && Math.abs(P.y - ny) < hs && ignoreAt !== 'player') return false;
  return true;
}

// ======================================================================
// Player
// ======================================================================
function parity() { return Math.sign(P.rx * P.fy - P.ry * P.fx) || 1; } // +1 normal, -1 mirrored
function transformPlayer(T) {
  [P.fx, P.fy] = norm(...applyL(T, P.fx, P.fy));
  [P.rx, P.ry] = norm(...applyL(T, P.rx, P.ry));
  [P.bx, P.by] = norm(...applyL(T, P.bx, P.by));
  [P.vx, P.vy] = applyL(T, P.vx, P.vy);
  if (feet) for (const f of feet) for (const k of ['', 'a', 'b']) {
    if (f['x' + k] === undefined) continue;
    [f['x' + k], f['y' + k]] = applyP(T, f['x' + k], f['y' + k]);
    f['z' + k] *= T.s;
  }
  P.eye *= T.s;
  if (T.s !== 1) {
    P.s = snapSize(P.s * T.s);
    if (P.riding) P.dismountAfter = true;
  }
}
function transformQuail(T) {
  const sx = Q.m * Q.fy, sy = -Q.m * Q.fx;
  [Q.fx, Q.fy] = norm(...applyL(T, Q.fx, Q.fy));
  const [tx, ty] = applyL(T, sx, sy);
  Q.m = Math.sign(tx * Q.fy - ty * Q.fx) || 1;
}

const keys = new Set();
let lookX = 0, lookY = 0;

// Camera-relative input, snapped to the nearer grid axis.
function inputDir() {
  let f = 0, st = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) st += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) st -= 1;
  if (!f && !st) return null;
  const mx = P.fx * f + P.rx * st, my = P.fy * f + P.ry * st;
  return Math.abs(mx) >= Math.abs(my) ? [Math.sign(mx), 0] : [0, Math.sign(my)];
}

function occupiedByQuail(x, y) { return Math.abs(Q.x - x) < 0.13 && Math.abs(Q.y - y) < 0.13; }

function tryStartPlayerStep(dir) {
  const b = playerBody();
  if (P.riding) {
    const pr = probe(b, Q.x, Q.y, Q.z, dir[0] * QCELL, dir[1] * QCELL);
    if (!pr) return false;
    startPlan(Q, pr, RIDE_T, Q.z, (T) => { transformQuail(T); transformPlayer(T); });
    Q.moving = true;
    faceQuailTo(dir[0], dir[1], 1);
    [P.bx, P.by] = dir;
    return true;
  }
  const grab = keys.has('KeyE');
  const cell = P.s;
  let pr, pull = null;
  if (grab) {
    // holding E: grab the crate in front, push it forward or pull it back
    const fx = Math.round(P.bx), fy = Math.round(P.by);
    const c = crates.find(c => Math.abs(c.size - cell) < 1e-6 && Math.abs(c.x - (P.x + fx * cell)) < 0.01 * cell && Math.abs(c.y - (P.y + fy * cell)) < 0.01 * cell && Math.abs(c.z0 - P.z) < 0.01);
    if (c) {
      if (dir[0] === fx && dir[1] === fy) pr = probe(b, P.x, P.y, P.z, dir[0] * cell, dir[1] * cell);
      else if (dir[0] === -fx && dir[1] === -fy) {
        pr = probe(b, P.x, P.y, P.z, dir[0] * cell, dir[1] * cell, { noPortals: true, noPush: true });
        if (pr && crateCanMove(c, dir[0] * cell, dir[1] * cell, 'player')) pull = { crate: c, vx: dir[0] * cell, vy: dir[1] * cell };
        else pr = null;
      } else pr = null;
      if (!pr) return false;
      if (pull) pr.push = pull;
      startPlan(P, pr, PUSH_T, P.z, transformPlayer);
      return true;
    }
  }
  pr = probe(b, P.x, P.y, P.z, dir[0] * cell, dir[1] * cell);
  [P.bx, P.by] = dir;
  if (!pr) return false;
  if (P.s <= 0.25 + EPS && occupiedByQuail(pr.ex, pr.ey)) return false;
  const H = PLAYER_H * pr.cell;
  P.crawl = CEIL - pr.z < H || segs.some(s => s.door && s.h - pr.z < H && nearSeg(pr.ex, pr.ey, s, 0.55 * pr.cell));
  startPlan(P, pr, pr.push ? PUSH_T : (P.crawl ? CRAWL_T : STEP_T), P.z, transformPlayer);
  return true;
}
function nearSeg(x, y, s, r) {
  const ex = s.x1 - s.x0, ey = s.y1 - s.y0;
  let t = ((x - s.x0) * ex + (y - s.y0) * ey) / (ex * ex + ey * ey); t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (s.x0 + t * ex), y - (s.y0 + t * ey)) < r;
}

// A plan animates a body from cell centre to cell centre, applying doorway transforms as the
// body passes each one. A pushed or pulled crate slides along with it.
function startPlan(m, pr, dur, z0, onCross) {
  m.plan = { ax: m.x, ay: m.y, bx: m.x, by: m.y, u: 0, dur, z0, z1: pr.z, crossings: pr.crossings.slice(), onCross, push: pr.push,
             cx0: pr.push ? pr.push.crate.x : 0, cy0: pr.push ? pr.push.crate.y : 0 };
  // the straight line in the starting frame
  let ex = pr.ex, ey = pr.ey;
  for (let i = pr.crossings.length - 1; i >= 0; i--) { const T = pr.crossings[i].T; [ex, ey] = invP(T, ex, ey); }
  m.plan.bx = ex; m.plan.by = ey;
}
function invP(T, x, y) {
  const [a, b, c, d] = T.L, det = a * d - b * c;
  const px = x - T.ox, py = y - T.oy;
  return [(d * px - b * py) / det, (-c * px + a * py) / det];
}
// Advance a plan; returns leftover time once it finishes.
function stepPlan(m, dt) {
  const pl = m.plan;
  pl.u = Math.min(1, pl.u + dt / pl.dur);
  while (pl.crossings.length && pl.crossings[0].u <= pl.u) {
    const T = pl.crossings.shift().T;
    [pl.ax, pl.ay] = applyP(T, pl.ax, pl.ay); [pl.bx, pl.by] = applyP(T, pl.bx, pl.by);
    pl.z0 *= T.s;
    pl.onCross && pl.onCross(T);
  }
  const e = pl.u;
  m.x = pl.ax + (pl.bx - pl.ax) * e; m.y = pl.ay + (pl.by - pl.ay) * e;
  m.z = pl.z0 + (pl.z1 - pl.z0) * Math.min(1, e * 1.6);
  if (pl.push) { pl.push.crate.x = pl.cx0 + pl.push.vx * e; pl.push.crate.y = pl.cy0 + pl.push.vy * e; }
  if (pl.u >= 1) {
    if (pl.push) { pl.push.crate.x = pl.cx0 + pl.push.vx; pl.push.crate.y = pl.cy0 + pl.push.vy; bfs.at = -1; }
    m.plan = null;
    return 0;
  }
  return -1;
}

function updatePlayer(dt) {
  // look
  const a = lookX * 0.0022; lookX = 0;
  if (a) {
    const par = parity(), c = Math.cos(a), s = Math.sin(a);
    const fx = P.fx * c + P.rx * s, fy = P.fy * c + P.ry * s;
    [P.fx, P.fy] = norm(fx, fy);
    P.rx = par * P.fy; P.ry = -par * P.fx;
  }
  P.pitch = Math.max(view === 'follow' ? -0.8 : -1.25, Math.min(view === 'follow' ? 0.5 : 1.25, P.pitch - lookY * 0.0022));
  lookY = 0;

  const ox = P.riding ? Q.x : P.x, oy = P.riding ? Q.y : P.y;
  const mover = P.riding ? Q : P;
  if (mover.plan) stepPlan(mover, dt);
  if (!mover.plan) {
    if (P.riding && P.dismountAfter) autoDismount();
    const dir = inputDir();
    if (dir && !tryStartPlayerStep(dir)) { /* blocked: just face that way */ }
    if (P.riding && !Q.plan) Q.moving = false;
  }
  if (P.riding) { P.x = Q.x; P.y = Q.y; P.z = Q.z + 0.24; }
  // velocity (for the legs)
  const nx = P.riding ? Q.x : P.x, ny = P.riding ? Q.y : P.y;
  if (dt > 0) { P.vx = (nx - ox) / dt; P.vy = (ny - oy) / dt; if (Math.hypot(P.vx, P.vy) > 50 * P.s) { P.vx = 0; P.vy = 0; } }
  if (!P.plan && !P.riding) {
    const H = PLAYER_H * P.s;
    P.crawl = CEIL - P.z < H || segs.some(s => s.door && s.h - P.z < H && nearSeg(P.x, P.y, s, 0.55 * P.s));
  }
  const Hn = PLAYER_H * P.s;
  const target = P.riding ? Q.z + 0.36 + 0.45 * Hn : P.z + (P.crawl ? 0.85 * Hn * CRAWL : 0.93 * Hn);
  P.eye += (target - P.eye) * Math.min(1, dt * 12);

  // collect things by walking onto them
  if (!logged.plant && Math.hypot(plant.x - P.x, plant.y - P.y) < 0.45 * P.s + 0.2 && Math.abs(P.z - plant.z) < 0.1) logSpecimen('plant');
  if (!logged.quail && Math.hypot(P.x - Q.x, P.y - Q.y) < 1.2) logSpecimen('quail');
}

function autoDismount() {
  P.riding = false; P.dismountAfter = false;
  P.x = Q.x; P.y = Q.y; P.z = Q.z; feet = null;
  toast('Too big to ride now.');
  // the quail hops off to a free neighbouring cell
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const pr = probe(quailBody(), Q.x, Q.y, Q.z, dx * QCELL, dy * QCELL);
    if (pr) { startPlan(Q, pr, QUAIL_T, Q.z, transformQuail); faceQuailTo(dx, dy, 1); return; }
  }
}

function quailAction() {
  if (P.riding) {
    if (Q.plan) return;
    const b = { cell: QCELL, h: PLAYER_H * 0.25 * CRAWL, climb: 0.5 * QCELL, scales: true, pusher: false };
    for (const [dx, dy] of [[P.rx, P.ry], [-P.rx, -P.ry], [-P.bx, -P.by], [P.bx, P.by]].map(([a, b]) => Math.abs(a) > Math.abs(b) ? [Math.sign(a), 0] : [0, Math.sign(b)])) {
      const pr = probe(b, Q.x, Q.y, Q.z, dx * QCELL, dy * QCELL, { noPortals: true, noPush: true });
      if (pr) { P.riding = false; P.x = pr.ex; P.y = pr.ey; P.z = pr.z; feet = null; return; }
    }
    toast('No room to climb down here.');
    return;
  }
  if (P.plan) return;
  if (Math.abs(P.s - 0.25) > EPS) { toast(P.s > 0.25 ? 'Too big to ride the quail.' : 'Too small to climb on.'); return; }
  if (Q.plan) stepPlan(Q, 1);
  const d = Math.hypot(Q.x - P.x, Q.y - P.y);
  if (d < QCELL * 1.05 && Math.abs(Q.z - P.z) < 0.05) { P.riding = true; feet = null; return; }
  toast('Get next to the quail first.');
}

// ======================================================================
// Quail: follows by the shortest route, glued doorways included
// ======================================================================
// Breadth-first search over quail-sized cells, outward from the player, taking glued
// doorways like any other step. Cheap enough to redo a few times a second.
const bfs = { dist: new Map(), at: -1, key: '' };
const qkey = (x, y) => Math.floor(x / QCELL + 1e-6) + ',' + Math.floor(y / QCELL + 1e-6);
function computeBFS(now) {
  const dist = new Map();
  const sx = (Math.floor(P.x / QCELL + 1e-6) + 0.5) * QCELL, sy = (Math.floor(P.y / QCELL + 1e-6) + 0.5) * QCELL;
  let floor0 = 0;
  for (const b of boxesAt(sx, sy, 0.05)) if (b.z1 <= P.z + 0.01) floor0 = Math.max(floor0, b.z1);
  const queue = [[sx, sy, floor0]];
  dist.set(qkey(sx, sy), 0);
  const qb = quailBody();
  for (let qi = 0; qi < queue.length && queue.length < 9000; qi++) {
    const [x, y, z] = queue[qi], d = dist.get(qkey(x, y));
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const pr = probe(qb, x, y, z, dx * QCELL, dy * QCELL, { noPush: true });
      if (!pr) continue;
      const k = qkey(pr.ex, pr.ey);
      if (dist.has(k)) continue;
      dist.set(k, d + 1);
      queue.push([(Math.floor(pr.ex / QCELL + 1e-6) + 0.5) * QCELL, (Math.floor(pr.ey / QCELL + 1e-6) + 0.5) * QCELL, pr.z]);
    }
  }
  bfs.dist = dist; bfs.at = now; bfs.key = qkey(P.x, P.y);
}

function faceQuailTo(dx, dy, k) { [Q.fx, Q.fy] = norm(Q.fx + (dx - Q.fx) * k, Q.fy + (dy - Q.fy) * k); }

function updateQuail(dt, now) {
  Q.phase += dt * (Q.moving ? 24 : 0);
  if (P.riding) return;
  if (Q.plan) { stepPlan(Q, dt); if (Q.plan) return; }
  Q.moving = false;
  if (bfs.at < 0 || (now - bfs.at > 0.3 && bfs.key !== qkey(P.x, P.y))) computeBFS(now);
  const here = bfs.dist.get(qkey(Q.x, Q.y));
  const stop = Math.max(1, Math.floor((0.3 + 0.45 * P.s) / QCELL));
  if (here === undefined || here <= stop) {
    // idle: peck now and then, look at you
    Q.peckT -= dt;
    if (Q.peckT < 0) { Q.peck = 1; Q.peckT = 1.5 + Math.random() * 3; }
    Q.peck = Math.max(0, Q.peck - dt * 3);
    const [tx, ty] = norm(P.x - Q.x, P.y - Q.y);
    if (Math.hypot(P.x - Q.x, P.y - Q.y) < 3) faceQuailTo(tx, ty, Math.min(1, dt * 3));
    return;
  }
  Q.peck = 0;
  let best = null, bd = here;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const pr = probe(quailBody(), Q.x, Q.y, Q.z, dx * QCELL, dy * QCELL, { noPush: true });
    if (!pr) continue;
    if (P.s <= 0.25 + EPS && Math.abs(pr.ex - P.x) < 0.13 && Math.abs(pr.ey - P.y) < 0.13) continue;
    const d = bfs.dist.get(qkey(pr.ex, pr.ey));
    if (d !== undefined && (d < bd || (d === bd && best && dx === Q.fx && dy === Q.fy))) { bd = d; best = { pr, dx, dy }; }
  }
  if (!best) return;
  const far = here > stop + 12;
  startPlan(Q, best.pr, far ? QUAIL_T * 0.7 : QUAIL_T, Q.z, transformQuail);
  faceQuailTo(best.dx, best.dy, 1);
  Q.moving = true;
  stepPlan(Q, 0);
}

// ======================================================================
// Legs: the body leads, the feet catch up under where it's heading
// ======================================================================
let feet = null;
function bodySide() { const par = parity(); return [par * P.by, -par * P.bx]; }
function updateFeet(dt) {
  const s = P.riding ? 0.25 : P.s, legSide = (P.riding ? 0.11 : 0.075 * s);
  const [sx, sy] = bodySide();
  const bx = P.riding ? Q.x : P.x, by = P.riding ? Q.y : P.y, bz = P.riding ? Q.z + 0.1 : P.z;
  if (!feet) feet = [1, -1].map(side => ({ side, x: bx + side * legSide * sx, y: by + side * legSide * sy, z: bz, t: 1 }));
  if (P.riding) { // dangle
    for (const f of feet) { f.x = bx + f.side * 0.13 * sx + P.bx * 0.03; f.y = by + f.side * 0.13 * sy + P.by * 0.03; f.z = Q.z + 0.07; f.t = 1; }
    return;
  }
  const speed = Math.hypot(P.vx, P.vy);
  const lead = 0.1;
  const px = bx + P.vx * lead, py = by + P.vy * lead;
  const stepT = P.crawl ? 0.16 : 0.09;
  for (const f of feet) {
    const hx = px + f.side * legSide * sx, hy = py + f.side * legSide * sy;
    if (f.t >= 1) {
      const other = feet.find(o => o !== f);
      const need = speed > 0.05 * s ? 0.16 * s : 0.02 * s;
      if (Math.hypot(f.x - hx, f.y - hy) > need && other.t >= 0.6) {
        f.xa = f.x; f.ya = f.y; f.za = f.z;
        f.xb = hx + P.vx * 0.06; f.yb = hy + P.vy * 0.06; f.zb = bz;
        f.t = 0;
      }
    } else {
      f.t = Math.min(1, f.t + dt / stepT);
      const e = f.t * f.t * (3 - 2 * f.t);
      f.x = f.xa + (f.xb - f.xa) * e; f.y = f.ya + (f.yb - f.ya) * e;
      f.z = f.za + (f.zb - f.za) * e + 0.09 * s * Math.sin(Math.PI * f.t);
    }
  }
}

// ======================================================================
// Journal, toasts, debug
// ======================================================================
const toastEl = document.getElementById('toast');
let toastTimer = 0;
function toast(msg) {
  if (!msg) { toastEl.classList.remove('on'); return; }
  toastEl.textContent = msg; toastEl.classList.add('on');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('on'), 2400);
}
function logSpecimen(which) {
  if (logged[which]) return;
  logged[which] = true;
  renderJournalText();
  toast('New journal entry (J)');
}
function renderJournalText() {
  const el = document.getElementById('specimens');
  const q = logged && logged.quail, p = logged && logged.plant;
  el.innerHTML =
    (q ? '<div class="entry"><i>Callipepla squamata</i><br>Scaled quail. Runs rather than flies. Wears a band with a tiny clasp. Never seems to change size.</div>'
       : '<div class="entry locked">An unrecorded bird.</div>') +
    (p ? '<div class="entry"><i>Selaginella lepidophylla</i><br>Resurrection plant. Curls into a dry ball in drought and unrolls when it rains.</div>'
       : '<div class="entry locked">Something green, up high.</div>');
}

const journalEl = document.getElementById('journal');
const mapEl = document.getElementById('map');
const mctx = mapEl.getContext('2d');
let journalOpen = false;

function drawMap() {
  const W = mapEl.width, H = mapEl.height;
  const bx0 = -7, bx1 = 13, by0 = -3, by1 = 9;
  const k = Math.min(W / (bx1 - bx0), H / (by1 - by0));
  const ox = (W - k * (bx1 - bx0)) / 2, oy = (H - k * (by1 - by0)) / 2;
  const X = x => ox + (x - bx0) * k, Y = y => H - (oy + (y - by0) * k);
  mctx.clearRect(0, 0, W, H);
  mctx.fillStyle = '#f7f0e2'; mctx.fillRect(0, 0, W, H);
  for (const r of rooms) { mctx.fillStyle = r.fill; mctx.fillRect(X(r.x0), Y(r.y1), (r.x1 - r.x0) * k, (r.y1 - r.y0) * k); }
  // faint unit grid
  mctx.strokeStyle = 'rgba(120,90,60,.12)'; mctx.lineWidth = 1;
  for (const r of rooms) {
    for (let x = r.x0; x <= r.x1; x++) { mctx.beginPath(); mctx.moveTo(X(x), Y(r.y0)); mctx.lineTo(X(x), Y(r.y1)); mctx.stroke(); }
    for (let y = r.y0; y <= r.y1; y++) { mctx.beginPath(); mctx.moveTo(X(r.x0), Y(y)); mctx.lineTo(X(r.x1), Y(y)); mctx.stroke(); }
  }
  for (const b of staticBoxes) { mctx.fillStyle = 'rgba(150,110,70,.35)'; mctx.fillRect(X(b.minx), Y(b.maxy), (b.maxx - b.minx) * k, (b.maxy - b.miny) * k); }
  mctx.lineCap = 'round';
  for (const s of segs) {
    if (s.door) continue;
    mctx.strokeStyle = '#4a3b2c'; mctx.lineWidth = 4;
    mctx.beginPath(); mctx.moveTo(X(s.x0), Y(s.y0)); mctx.lineTo(X(s.x1), Y(s.y1)); mctx.stroke();
  }
  const colors = ['#c0562f', '#2f7f86', '#7a4fa0'];
  pairs.forEach((pr, n) => {
    const A = segs[pr.i], B = segs[pr.j], T = portals[A.portal];
    const [c0x, c0y] = applyP(T, A.x0, A.y0), [c1x, c1y] = applyP(T, A.x1, A.y1);
    const col = colors[n % colors.length];
    drawGlued(A.x0, A.y0, A.x1, A.y1, col, n + 1, T.s !== 1 ? (T.s < 1 ? '×½' : '×2') : '');
    const Tb = portals[B.portal];
    drawGlued(c0x, c0y, c1x, c1y, col, n + 1, Tb.s !== 1 ? (Tb.s < 1 ? '×½' : '×2') : '');
  });
  function drawGlued(x0, y0, x1, y1, col, count, label) {
    mctx.strokeStyle = col; mctx.lineWidth = 5;
    mctx.beginPath(); mctx.moveTo(X(x0), Y(y0)); mctx.lineTo(X(x1), Y(y1)); mctx.stroke();
    const mx = (X(x0) + X(x1)) / 2, my = (Y(y0) + Y(y1)) / 2;
    const [ux, uy] = norm(X(x1) - X(x0), Y(y1) - Y(y0));
    const nx = -uy, ny = ux;
    mctx.lineWidth = 3;
    for (let c = 0; c < count; c++) {
      const cx = mx + ux * (c - (count - 1) / 2) * 11, cy = my + uy * (c - (count - 1) / 2) * 11;
      mctx.beginPath(); mctx.moveTo(cx - ux * 9 + nx * 8, cy - uy * 9 + ny * 8); mctx.lineTo(cx, cy); mctx.lineTo(cx - ux * 9 - nx * 8, cy - uy * 9 - ny * 8); mctx.stroke();
    }
    if (label) { mctx.fillStyle = col; mctx.font = 'bold 20px Georgia, serif'; mctx.fillText(label, mx - nx * 26 - 10, my - ny * 26 + 7); }
  }
  for (const s of segs) {
    if (!s.door || s.portal || s.frame) continue;
    mctx.strokeStyle = '#9b8a72'; mctx.lineWidth = 1.5; mctx.setLineDash([4, 4]);
    mctx.beginPath(); mctx.moveTo(X(s.x0), Y(s.y0)); mctx.lineTo(X(s.x1), Y(s.y1)); mctx.stroke();
    mctx.setLineDash([]);
  }
  for (const c of crates) { mctx.fillStyle = '#9a6a3c'; mctx.fillRect(X(c.x - c.size / 2), Y(c.y + c.size / 2), c.size * k, c.size * k); }
  if (!logged.plant) { mctx.fillStyle = '#5c8a46'; mctx.beginPath(); mctx.arc(X(plant.x), Y(plant.y), 6, 0, 7); mctx.fill(); }
  mctx.fillStyle = '#7d8a99'; mctx.beginPath(); mctx.arc(X(Q.x), Y(Q.y), 7, 0, 7); mctx.fill();
  const px = X(P.x), py = Y(P.y), L = 24;
  const fx = P.fx, fy = -P.fy, rx = P.rx, ry = -P.ry;
  mctx.strokeStyle = '#1f1a15'; mctx.lineWidth = 5; mctx.lineJoin = 'round';
  mctx.beginPath(); mctx.moveTo(px + fx * L, py + fy * L); mctx.lineTo(px, py); mctx.lineTo(px + rx * L * 0.55, py + ry * L * 0.55); mctx.stroke();
  mctx.fillStyle = '#6f6353'; mctx.font = 'italic 18px Georgia, serif';
  mctx.fillText('start yard', X(0.6), Y(3.1));
  mctx.fillText('west yard', X(-5.4), Y(5.1));
  mctx.fillText('north passage', X(7), Y(7.2));
  mctx.fillText('south passage', X(7), Y(-1.2));
  mctx.fillText('pillar', X(8.3), Y(3.2));
  for (const c of pillars) { mctx.fillStyle = '#8a6a4a'; mctx.beginPath(); mctx.arc(X(c.x), Y(c.y), c.r * k, 0, 7); mctx.fill(); }
}

const debugEl = document.getElementById('debug');
let debugOn = false, fps = 60;
function drawDebug() {
  if (!debugOn) return;
  debugEl.textContent =
    `fps ${fps.toFixed(0)}  res ${resScale.toFixed(2)}\n` +
    `size x${P.s} (log2 ${Math.log2(P.s).toFixed(0)})\n` +
    `mirrored ${parity() < 0 ? 'yes' : 'no'}   quail mirrored ${Q.m < 0 ? 'yes' : 'no'}\n` +
    `pos ${P.x.toFixed(3)}, ${P.y.toFixed(3)}, z ${P.z.toFixed(2)}  ${P.riding ? 'riding' : P.crawl ? 'crawling' : 'standing'}\n` +
    `quail steps to you ${bfs.dist.get(qkey(Q.x, Q.y)) ?? '?'}`;
}

// ======================================================================
// Renderer
// ======================================================================
const canvas = document.getElementById('view');
const gl = canvas.getContext('webgl2', { antialias: false, preserveDrawingBuffer: true });
if (!gl) {
  document.getElementById('title').style.display = 'none';
  document.getElementById('nogl').style.display = 'flex';
  return;
}

const MAXS = 160, MAXP = 12, MAXB = 12, MAXE = 32, MAXC = 16;

const VS = `#version 300 es
in vec2 aPos; void main(){ gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
precision highp int;
out vec4 fragColor;
uniform vec2 uRes;
uniform vec3 uCam;
uniform vec2 uF, uR;
uniform float uPitch, uScale;
uniform float uPS;          // her size in the camera's frame; sets how fine the world's pixels are
uniform int uNS, uNB, uNE, uNC;
uniform highp sampler2D uSeg; // row 0: x0 y0 x1 y1; row 1: isGap, gapHeight, portal, glyph position (or -1)
uniform vec4 uPL[${MAXP}];   // linear part, row-major
uniform vec4 uPO[${MAXP}];   // offset x, offset y, scale, det
uniform vec4 uBA[${MAXB}];   // minx miny maxx maxy
uniform vec4 uBB[${MAXB}];   // z0 z1 kind
uniform vec4 uEC[${MAXE}];   // centre, kind
uniform vec4 uER[${MAXE}];   // radii
uniform vec4 uEB[${MAXE}];   // forward.xy, side.xy
uniform vec4 uCA[${MAXC}];   // capsule end a, radius
uniform vec4 uCB[${MAXC}];   // capsule end b, kind

const float WALL = ${WALL.toFixed(2)};
const float PI = 3.14159265;
const float PERIOD = 12.0;   // length of the glued passages: their patterns repeat with this period
const vec3 HAZE = vec3(0.88, 0.82, 0.72);
const vec3 SUN = normalize(vec3(0.35, 0.55, 0.76));
const float TEX = 16.0;      // world pixels per body-width, at every size

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
// value noise on a lattice that can wrap with period n (n = 0: no wrap)
float vnoise(vec2 p, float n){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  vec2 i1 = i + 1.0;
  if (n > 0.0) { i = mod(i, n); i1 = mod(i1, n); }
  return mix(mix(hash(i), hash(vec2(i1.x, i.y)), f.x), mix(hash(vec2(i.x, i1.y)), hash(i1), f.x), f.y);
}
// layered noise that stops at the pixel size: smaller you, more layers
float fbm(vec2 p, float px, float f0, float per){
  float v = 0.0, amp = 0.5, f = f0;
  for (int i = 0; i < 9; i++) {
    if (1.0 / f < 2.0 * px) break;
    v += amp * (vnoise(p * f, per > 0.0 ? per * f : 0.0) - 0.5);
    amp *= 0.55; f *= 2.0;
  }
  return v;
}
float cross2(vec2 a, vec2 b){ return a.x*b.y - a.y*b.x; }
float pwave(float x, float k, float ph){ return sin(x * 2.0*PI*k/PERIOD + ph); }
float asym(float x){ x = fract(x); return min(x / 0.8, (1.0 - x) / 0.2); }
// four shades between a dark and a light colour
vec3 ramp4(vec3 dark, vec3 light, float t){ return mix(dark, light, clamp(floor(t * 4.0), 0.0, 3.0) / 3.0); }

int roomOf(vec2 p){
  if (p.y > 6.0) return 2;   // north passage
  if (p.y < 0.0) return 3;   // south passage
  if (p.x < 0.0) return 1;   // west yard
  if (p.x > 6.0) return 4;   // pillar yard
  return 0;                  // start yard
}
// patterns in the passages must line up across their glued ends: periodic along x, and in the
// flipped passage symmetric across its centre line
vec2 patCoord(int r, vec2 p){
  if (r == 3) return vec2(p.x, abs(p.y + 1.0));
  return p;
}
float perOf(int r){ return (r == 2 || r == 3) ? PERIOD : 0.0; }

vec3 skyColor(vec3 d){
  float e = normalize(d).z;
  vec3 c = mix(vec3(0.93,0.86,0.74), vec3(0.46,0.66,0.88), smoothstep(0.0, 0.55, e));
  return mix(c, vec3(0.34,0.52,0.80), smoothstep(0.55, 1.0, e));
}

// ---------- ground ----------
vec3 groundColor(int r, vec2 p, float px, float lit){
  vec2 pc = patCoord(r, p);
  vec2 q = (floor(pc / px) + 0.5) * px;            // snap to the world's pixel grid
  float per = perOf(r);
  float t = 0.6 + 0.75 * fbm(q, px, 0.5, per);
  // pebbles: visible at normal size and smaller
  if (px < 0.07) {
    float cs = 0.375; vec2 c = floor(q / cs), f = fract(q / cs) - 0.5;
    vec2 ch = per > 0.0 ? mod(c, per / cs) : c;
    float hh = hash(ch), rr = 0.12 + 0.16 * hash(ch + 1.3);
    vec2 off = vec2(hash(ch + 3.1), hash(ch + 7.7)) - 0.5;
    if (hh > 0.55 && length(f - off * 0.45) < rr) t += hh > 0.8 ? 0.25 : -0.25;
  }
  // grit: half size and smaller
  if (px < 0.035) {
    float cs = 0.09375; vec2 c = floor(q / cs), f = fract(q / cs) - 0.5;
    vec2 ch = per > 0.0 ? mod(c, per / cs) : c;
    float hh = hash(ch + 11.0);
    if (hh > 0.72 && length(f) < 0.28) t -= 0.2; else if (hh < 0.08 && length(f) < 0.22) t += 0.22;
  }
  // single grains, and the odd ant: quarter size
  if (px < 0.02) {
    float cs = 0.0234375; vec2 c = floor(q / cs);
    vec2 ch = per > 0.0 ? mod(c, per / cs) : c;
    float hh = hash(ch + 5.0);
    if (hh > 0.86) t += 0.14;
    if (hh < 0.0015) return vec3(0.10,0.06,0.05);
  }
  // grass tufts in the north passage
  if (r == 2) {
    float g = fbm(q + 7.0, max(px, 0.03), 0.75, per);
    if (g > 0.12) return ramp4(vec3(0.33,0.33,0.18), vec3(0.78,0.74,0.46), (0.55 + g) * lit);
  }
  t *= lit;
  if (r == 1) return ramp4(vec3(0.66,0.65,0.62), vec3(0.98,0.96,0.91), t);   // white gypsum sand
  if (r == 2) return ramp4(vec3(0.44,0.36,0.22), vec3(0.86,0.75,0.52), t);   // dry grassland
  if (r == 3) return ramp4(vec3(0.42,0.22,0.16), vec3(0.88,0.60,0.46), t);   // red earth
  if (r == 4) {                                                             // flagstones
    vec2 cc = floor(q / 0.5); vec2 ff = fract(q / 0.5);
    float joint = step(min(min(ff.x, 1.0-ff.x), min(ff.y, 1.0-ff.y)), max(0.05, px / 0.5));
    return ramp4(vec3(0.40,0.30,0.24), vec3(0.86,0.76,0.62), (t + 0.15*(hash(cc)-0.5)) * (1.0 - 0.45*joint));
  }
  return ramp4(vec3(0.46,0.30,0.20), vec3(0.90,0.74,0.56), t);              // caliche earth
}

// ---------- walls ----------
// Adobe up to 1 unit, a painted landscape above, a coping along the top. The landscape's
// shapes are lopsided (slow rise, quick fall) so a mirrored wall looks mirrored.
vec3 muralColor(int r, float u, float z, float px, float lit, float n){
  float hFar, hNear;
  vec3 skyD, skyL, farD, farL, nearD, nearL, gD, gL;
  if (r == 1) {
    skyD = vec3(0.55,0.66,0.80); skyL = vec3(0.96,0.95,0.90); farD = vec3(0.46,0.52,0.62); farL = vec3(0.76,0.80,0.86);
    nearD = vec3(0.72,0.71,0.68); nearL = vec3(1.0,0.98,0.93); gD = vec3(0.70,0.68,0.62); gL = vec3(0.98,0.95,0.88);
    hFar = 2.2 + 0.25*sin(u*0.9) + 0.12*sin(u*2.3+1.0);
    hNear = 1.5 + 0.25*asym(u*0.35);
  } else if (r == 2) {
    skyD = vec3(0.30,0.34,0.44); skyL = vec3(0.80,0.78,0.74); farD = vec3(0.36,0.36,0.44); farL = vec3(0.64,0.62,0.68);
    nearD = vec3(0.44,0.40,0.28); nearL = vec3(0.78,0.72,0.50); gD = vec3(0.52,0.46,0.30); gL = vec3(0.86,0.78,0.52);
    hFar = 2.1 + 0.3*pwave(u,2.0,0.4) + 0.15*pwave(u,5.0,1.3) + 0.3*asym(u*3.0/PERIOD);
    hNear = 1.45 + 0.08*pwave(u,7.0,0.0);
  } else if (r == 3) {
    skyD = vec3(0.50,0.62,0.80); skyL = vec3(0.98,0.86,0.70); farD = vec3(0.48,0.28,0.22); farL = vec3(0.80,0.54,0.42);
    nearD = vec3(0.40,0.20,0.15); nearL = vec3(0.72,0.42,0.30); gD = vec3(0.56,0.38,0.28); gL = vec3(0.90,0.66,0.50);
    float m = fract(u*2.0/PERIOD);
    hFar = 1.9 + 0.6*smoothstep(0.08,0.12,m)*(1.0-smoothstep(0.55,0.75,m));
    hNear = 1.45 + 0.22*smoothstep(0.0,0.6,fract(u*3.0/PERIOD+0.3))*step(fract(u*3.0/PERIOD+0.3),0.62);
  } else {
    skyD = vec3(0.48,0.64,0.84); skyL = vec3(0.98,0.88,0.74); farD = vec3(0.40,0.45,0.56); farL = vec3(0.70,0.74,0.82);
    nearD = vec3(0.46,0.42,0.36); nearL = vec3(0.78,0.72,0.62); gD = vec3(0.56,0.44,0.30); gL = vec3(0.90,0.76,0.56);
    hFar = 2.0 + 0.3*sin(u*0.55) + 0.15*sin(u*1.7+2.0) + 0.4*asym(u*0.23);
    hNear = 1.45 + 0.14*asym(u*0.6+0.2);
  }
  if (z < 1.3) return ramp4(gD, gL, (0.6 + n) * lit);
  if (z < hNear) return ramp4(nearD, nearL, (0.62 + n) * lit);
  if (z < hFar) return ramp4(farD, farL, (0.62 + n) * lit);
  float sky = 0.95 - 0.55 * smoothstep(1.6, 3.6, z);          // paler towards the painted horizon
  vec3 c = ramp4(skyD, skyL, (sky + 0.5*n) * (0.6 + 0.4*lit));
  if (r == 0) {   // a painted sun
    vec2 sp = vec2(fract(u/7.0)*7.0 - 4.2, z - 3.0);
    if (length(sp) < 0.22) c = vec3(1.0,0.94,0.76);
  }
  return c;
}

float glyphL(float u, float z){
  vec2 g = vec2(u / 0.3 + 1.0, (z - 1.7) / 0.3);
  bool a = g.x >= 0.0 && g.x < 1.0 && g.y >= 0.0 && g.y < 3.0;
  bool b = g.x >= 1.0 && g.x < 2.0 && g.y >= 0.0 && g.y < 1.0;
  return (a || b) ? 1.0 : 0.0;
}

vec3 adobe(vec2 q, float px, float lit, float per, vec3 dark, vec3 light){
  float t = 0.62 + 0.6 * fbm(q, px, 0.8, per);
  if (px < 0.035) {   // straw in the plaster
    vec2 c = floor(q / vec2(0.09375, 0.03)); float hh = hash(per > 0.0 ? vec2(mod(c.x, per / 0.09375), c.y) : c);
    if (hh > 0.9) t -= 0.18;
  }
  if (px < 0.02) {    // hairline cracks
    float cr = abs(fbm(q * 1.7 + 3.0, 0.02, 2.0, per > 0.0 ? per : 0.0));
    if (cr < 0.012) t -= 0.22;
  }
  return ramp4(dark, light, t * lit);
}

vec3 wallColor(int r, vec2 p, float uw, float z, float gu, float useg, float px, float lit){
  float per = perOf(r);
  vec2 q = (floor(vec2(uw, z) / px) + 0.5) * px;
  vec3 dark = (r == 1) ? vec3(0.62,0.60,0.56) : (r == 3 ? vec3(0.48,0.32,0.24) : vec3(0.50,0.38,0.26));
  vec3 light = (r == 1) ? vec3(0.98,0.96,0.92) : (r == 3 ? vec3(0.92,0.74,0.60) : vec3(0.94,0.84,0.66));
  vec3 c;
  if (q.y < 0.95 || q.y > 3.78) c = adobe(q, px, lit, per, dark, light);
  else if (q.y < 1.05) c = (r == 1) ? ramp4(vec3(0.34,0.40,0.48), vec3(0.62,0.70,0.78), 0.7*lit) : ramp4(vec3(0.38,0.18,0.12), vec3(0.74,0.40,0.26), 0.7*lit);
  else c = muralColor(r, q.x, q.y, px, lit, 0.25 * fbm(q, px, 1.0, per));
  if (gu >= 0.0 && glyphL(useg - gu, q.y) > 0.5) c = ramp4(vec3(0.26,0.12,0.08), vec3(0.56,0.28,0.18), 0.7*lit);
  return c;
}

struct Hit { float t; int type; int idx; vec3 n; vec3 lp; };

// ray vs capsule (after Inigo Quilez); rd need not be unit length
float capsule(vec3 ro, vec3 rd, vec3 pa, vec3 pb, float r){
  float L = length(rd); rd /= L;
  vec3 ba = pb - pa, oa = ro - pa;
  float baba = dot(ba,ba), bard = dot(ba,rd), baoa = dot(ba,oa), rdoa = dot(rd,oa), oaoa = dot(oa,oa);
  float a = baba - bard*bard, b = baba*rdoa - baoa*bard, c = baba*oaoa - baoa*baoa - r*r*baba;
  float h = b*b - a*c;
  if (h >= 0.0) {
    float t = (-b - sqrt(h)) / a;
    float y = baoa + t*bard;
    if (y > 0.0 && y < baba) return t / L;
    vec3 oc = (y <= 0.0) ? oa : ro - pb;
    b = dot(rd, oc); c = dot(oc, oc) - r*r; h = b*b - c;
    if (h > 0.0) return (-b - sqrt(h)) / L;
  }
  return -1.0;
}

void main(){
  vec2 uv = (gl_FragCoord.xy - 0.5*uRes) / (0.5*uRes.y);
  float cp = cos(uPitch), sp = sin(uPitch);
  vec3 fw = vec3(uF * cp, sp);
  vec3 up = vec3(-uF * sp, cp);
  vec3 rt = vec3(uR, 0.0);
  const float TH = 0.72;
  vec3 d = normalize(fw + uv.x*TH*rt + uv.y*TH*up);
  vec3 o = uCam;
  float tmin = 0.0;
  float ps = uPS;               // her size in the current frame; changes as the ray crosses scaling gaps
  vec3 col = HAZE;
  float tHit = 1e9;
  bool found = false;

  for (int bounce = 0; bounce < 32; bounce++) {
    Hit h; h.t = 1e9; h.type = 0; h.idx = -1; h.n = vec3(0); h.lp = vec3(0);
    if (d.z < 0.0) { float t = -o.z / d.z; if (t > tmin && t < h.t) { h.t = t; h.type = 1; } }
    for (int i = 0; i < ${MAXS}; i++) {
      if (i >= uNS) break;
      vec4 A = texelFetch(uSeg, ivec2(i, 0), 0);
      vec2 e = A.zw - A.xy;
      float den = cross2(d.xy, e);
      if (abs(den) < 1e-9) continue;
      vec2 q = A.xy - o.xy;
      float t = cross2(q, e) / den;
      float u = cross2(q, d.xy) / den;
      if (u < 0.0 || u > 1.0 || t <= tmin + 1e-5 || t >= h.t) continue;
      if (o.z + t*d.z > WALL) {   // over the top of a wall: only glued gaps (open to the sky) still count
        vec4 Bq = texelFetch(uSeg, ivec2(i, 1), 0);
        if (!(Bq.x > 0.5 && Bq.z > 0.5)) continue;
      }
      h.t = t; h.type = 3; h.idx = i;
    }
    vec3 sd = sign(d) * max(abs(d), vec3(1e-7));
    vec3 inv = 1.0 / sd;
    for (int i = 0; i < ${MAXB}; i++) {
      if (i >= uNB) break;
      vec3 bmin = vec3(uBA[i].xy, uBB[i].x), bmax = vec3(uBA[i].zw, uBB[i].y);
      vec3 t0 = (bmin - o) * inv, t1 = (bmax - o) * inv;
      vec3 ts = min(t0, t1), tb = max(t0, t1);
      float tn = max(max(ts.x, ts.y), ts.z), tf = min(min(tb.x, tb.y), tb.z);
      if (tn < tf && tn > tmin + 1e-5 && tn < h.t) {
        h.t = tn; h.type = 4; h.idx = i;
        if (tn == ts.x) h.n = vec3(-sign(d.x), 0, 0);
        else if (tn == ts.y) h.n = vec3(0, -sign(d.y), 0);
        else h.n = vec3(0, 0, -sign(d.z));
      }
    }
    for (int i = 0; i < ${MAXE}; i++) {
      if (i >= uNE) break;
      vec3 R = uER[i].xyz; vec2 Fv = uEB[i].xy, Sv = uEB[i].zw;
      vec3 q = o - uEC[i].xyz;
      vec3 lo = vec3(dot(q.xy, Fv), dot(q.xy, Sv), q.z) / R;
      vec3 ld = vec3(dot(d.xy, Fv), dot(d.xy, Sv), d.z) / R;
      float a = dot(ld, ld), b = dot(lo, ld), c = dot(lo, lo) - 1.0;
      float disc = b*b - a*c;
      if (disc < 0.0) continue;
      float t = (-b - sqrt(disc)) / a;
      if (t > tmin + 1e-5 && t < h.t) {
        h.t = t; h.type = 5; h.idx = i;
        vec3 lh = lo + t*ld;
        vec3 nl = lh / R;
        h.n = normalize(vec3(nl.x*Fv + nl.y*Sv, nl.z));
        h.lp = lh;
      }
    }
    for (int i = 0; i < ${MAXC}; i++) {
      if (i >= uNC) break;
      float t = capsule(o, d, uCA[i].xyz, uCB[i].xyz, uCA[i].w);
      if (t > tmin + 1e-5 && t < h.t) { h.t = t; h.type = 6; h.idx = i; }
    }

    if (h.type == 0) { col = skyColor(d); tHit = 1e9; found = false; break; }
    vec3 p = o + h.t * d;

    if (h.type == 3) {
      vec4 B = texelFetch(uSeg, ivec2(h.idx, 1), 0);
      if (B.x > 0.5 && p.z < B.y) {          // through a gap
        int pi = int(B.z + 0.5);
        if (pi > 0) {
          vec4 L = uPL[pi], O = uPO[pi];
          o = vec3(L.x*o.x + L.y*o.y + O.x, L.z*o.x + L.w*o.y + O.y, o.z * O.z);
          d = vec3(L.x*d.x + L.y*d.y, L.z*d.x + L.w*d.y, d.z * O.z);
          ps *= O.z;
        }
        tmin = h.t;
        continue;
      }
    }

    found = true; tHit = h.t;
    float px = ps / TEX;            // the size of one world pixel here
    if (h.type == 1) {
      int r = roomOf(p.xy);
      float sh = 1.0;               // soft contact shadows
      for (int i = 0; i < ${MAXB}; i++) {
        if (i >= uNB) break;
        if (uBB[i].x > 0.05) continue;
        vec2 c = clamp(p.xy, uBA[i].xy, uBA[i].zw);
        float w = min(0.22, 0.4*min(uBA[i].z-uBA[i].x, uBA[i].w-uBA[i].y));
        sh *= 1.0 - 0.38*(1.0 - smoothstep(0.0, w, length(p.xy - c)));
      }
      for (int i = 0; i < ${MAXE}; i++) {
        if (i >= uNE) break;
        if (uEC[i].w != 0.0 || uEC[i].z > 0.35) continue;
        sh *= 1.0 - 0.45*(1.0 - smoothstep(0.04, 0.2, length(p.xy - uEC[i].xy)));
      }
      for (int i = 0; i < ${MAXC}; i++) {
        if (i >= uNC) break;
        if (uCB[i].w < 19.5) continue;
        sh *= 1.0 - 0.4*(1.0 - smoothstep(uCA[i].w, uCA[i].w + 0.3, length(p.xy - uCA[i].xy)));
      }
      col = groundColor(r, p.xy, px, 0.98 * sh);
    } else if (h.type == 3) {
      vec4 A = texelFetch(uSeg, ivec2(h.idx, 0), 0), B = texelFetch(uSeg, ivec2(h.idx, 1), 0);
      vec2 e = normalize(A.zw - A.xy);
      vec2 n2 = vec2(-e.y, e.x);
      if (dot(n2, d.xy) > 0.0) n2 = -n2;
      int r = roomOf(p.xy + n2 * 0.02);
      float uw = abs(e.x) > abs(e.y) ? p.x : p.y;
      float useg = dot(p.xy - A.xy, e);
      float lit = 0.8 + 0.2*dot(n2, normalize(vec2(0.6, 0.8)));
      lit *= 0.8 + 0.2*smoothstep(0.0, 0.3, p.z);
      col = wallColor(r, p.xy, uw, p.z, B.w, useg, px, lit);
    } else if (h.type == 4) {
      vec4 BA = uBA[h.idx], BB = uBB[h.idx];
      vec3 bmin = vec3(BA.xy, BB.x), bmax = vec3(BA.zw, BB.y);
      vec3 lp = (p - bmin) / (bmax - bmin);
      float lit = 0.7 + 0.3*max(0.0, dot(h.n, SUN));
      vec2 fuv = abs(h.n.z) > 0.5 ? p.xy : (abs(h.n.x) > 0.5 ? p.yz : p.xz);
      vec2 q = (floor(fuv / px) + 0.5) * px;
      if (BB.z > 0.5) { // crate: planks, then grain and nails as you shrink
        vec3 sz = bmax - bmin;
        vec2 l2 = abs(h.n.z) > 0.5 ? lp.xy : (abs(h.n.x) > 0.5 ? lp.yz : lp.xz);
        vec2 lq = (floor(l2 * sz.x / px) + 0.5) * px / sz.x;
        float edge = step(min(min(lq.x, 1.0-lq.x), min(lq.y, 1.0-lq.y)), max(0.09, px / sz.x));
        float t = 0.62 + 0.25*(hash(vec2(floor(lq.y * 4.0), BA.x)) - 0.5);
        if (abs(fract(lq.y * 4.0) - 0.5) > 0.46) t -= 0.25;
        if (px < 0.04 * sz.x) t += 0.18 * sin(lq.x * 60.0 + 5.0*sin(lq.y * 23.0));            // grain
        if (px < 0.02 * sz.x) { vec2 nd = abs(fract(lq * vec2(1.0, 4.0)) - vec2(0.5)); if (edge > 0.5 && length(nd * vec2(1.0, 0.25)) < 0.06) t = 0.05; }
        vec3 c = ramp4(vec3(0.34,0.22,0.12), vec3(0.84,0.64,0.40), t * lit);
        col = edge > 0.5 ? ramp4(vec3(0.24,0.15,0.08), vec3(0.58,0.40,0.24), (t * 0.9) * lit) : c;
      } else {
        int r = roomOf(p.xy - h.n.xy*0.01);
        vec3 dark = (r == 1) ? vec3(0.62,0.60,0.56) : vec3(0.50,0.38,0.26);
        vec3 light = (r == 1) ? vec3(0.98,0.96,0.92) : vec3(0.94,0.84,0.66);
        col = adobe(q, px, (h.n.z > 0.5 ? 1.0 : 0.85) * lit, 0.0, dark, light);
      }
    } else if (h.type == 5) {
      int kind = int(uEC[h.idx].w + 0.5);
      vec3 l = h.lp;
      if (kind == 0) {         // quail body: scaly blue-grey, paler belly
        vec2 sc = vec2(atan(l.y, l.x) * 2.6, l.z * 5.5);
        sc.x += 0.5 * mod(floor(sc.y), 2.0);
        float scale = length(fract(sc) - vec2(0.5, 0.15));
        col = mix(vec3(0.55,0.60,0.67), vec3(0.30,0.33,0.38), smoothstep(0.42, 0.5, scale));
        col = mix(col, vec3(0.84,0.80,0.70), smoothstep(-0.2, -0.75, l.z));
        col = mix(col, vec3(0.58,0.53,0.47), smoothstep(0.3, 0.9, l.z) * smoothstep(0.0, -0.8, l.x));
      }
      else if (kind == 1) col = vec3(0.60,0.60,0.58);
      else if (kind == 2) col = vec3(0.96,0.95,0.91);
      else if (kind == 3) col = vec3(0.18,0.17,0.17);
      else if (kind == 4) col = vec3(0.56,0.50,0.44);
      else if (kind == 5) col = vec3(0.95,0.42,0.13);
      else if (kind == 6) col = vec3(0.44,0.48,0.55);
      else if (kind == 7) col = vec3(0.05);
      else if (kind == 9) {     // poncho: serape stripes, fringe at the hem
        float z = l.z;
        vec3 c1 = vec3(0.78,0.36,0.22), c2 = vec3(0.93,0.86,0.70), c3 = vec3(0.26,0.52,0.55), c4 = vec3(0.86,0.64,0.24);
        float b = fract(z * 2.2 + 0.1);
        col = b < 0.45 ? c1 : (b < 0.6 ? c2 : (b < 0.8 ? c3 : c4));
        if (z < -0.62) col = mix(c2, c1, step(0.5, fract(atan(l.y, l.x) * 9.0)));
      }
      else if (kind == 10) col = vec3(0.80,0.60,0.46);
      else if (kind == 13) col = vec3(0.40,0.27,0.17);
      else if (kind == 14) col = vec3(0.17,0.12,0.09);
      else if (kind == 8) {     // resurrection plant: a green spiral rosette (world: four shades)
        float ang = atan(l.y, l.x), rr = length(l.xy);
        float spiral = fract(ang / (2.0*PI) * 5.0 + log(max(rr, 0.02)) * 1.6);
        float lt = 0.55 + 0.45*max(0.0, dot(h.n, SUN));
        col = ramp4(vec3(0.18,0.32,0.16), vec3(0.62,0.78,0.42), (0.55 + 0.35*smoothstep(0.3, 0.7, spiral)) * lt + 0.1);
      }
      float lit = 0.55 + 0.45*max(0.0, dot(h.n, SUN)) + 0.1*h.n.z;
      if (kind != 8) col *= lit;
    } else if (h.type == 6) {
      vec3 a = uCA[h.idx].xyz, b = uCB[h.idx].xyz;
      vec3 ba = b - a, pa = p - a;
      float k = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
      vec3 n = normalize(pa - k*ba);
      float lit = 0.6 + 0.4*max(0.0, dot(n, SUN)) + 0.1*n.z;
      if (uCB[h.idx].w > 19.5) {   // the pillar: adobe, in world pixels
        float ang = atan(n.y, n.x) * uCA[h.idx].w;
        vec2 q = (floor(vec2(ang, p.z) / px) + 0.5) * px;
        col = adobe(q, px, lit, 0.0, vec3(0.50,0.36,0.26), vec3(0.94,0.80,0.62));
      } else col = vec3(0.22,0.19,0.18) * lit;   // her legs
    }
    break;
  }

  if (found) {
    float dist = tHit / uScale;
    col = mix(col, HAZE, clamp(1.0 - exp(-dist * 0.025), 0.0, 1.0));
  }
  float vig = 1.0 - 0.16*dot(uv*0.6, uv*0.6);
  fragColor = vec4(col * vig, 1.0);
}`;

function compile(type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
  return sh;
}
const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VS));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FS));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
gl.useProgram(prog);

const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
const aPos = gl.getAttribLocation(prog, 'aPos');
gl.enableVertexAttribArray(aPos);
gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

const U = {};
for (const n of ['uRes', 'uCam', 'uF', 'uR', 'uPitch', 'uScale', 'uPS', 'uNS', 'uNB', 'uNE', 'uNC', 'uCA', 'uCB', 'uSeg', 'uPL', 'uPO', 'uBA', 'uBB', 'uEC', 'uER', 'uEB'])
  U[n] = gl.getUniformLocation(prog, n);

// static: segments (in a float texture) and portals
{
  if (segs.length > MAXS) throw new Error('too many segments');
  const data = new Float32Array(segs.length * 4 * 2);
  segs.forEach((s, i) => {
    data.set([s.x0, s.y0, s.x1, s.y1], i * 4);
    data.set([s.door ? 1 : 0, s.h, s.portal, s.glyph ? s.gu : -1], (segs.length + i) * 4);
  });
  const tex = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, segs.length, 2, 0, gl.RGBA, gl.FLOAT, data);
  gl.uniform1i(U.uSeg, 0);
  const PL = new Float32Array(MAXP * 4), PO = new Float32Array(MAXP * 4);
  portals.forEach((T, i) => { PL.set(T.L, i * 4); PO.set([T.ox, T.oy, T.s, T.det], i * 4); });
  gl.uniform4fv(U.uPL, PL); gl.uniform4fv(U.uPO, PO);
  gl.uniform1i(U.uNS, segs.length);
}

function quailParts(out) {
  const F = [Q.fx, Q.fy], S = [Q.m * Q.fy, -Q.m * Q.fx];
  const walk = Q.moving ? 1 : 0;
  const swing = 0.035 * Math.sin(Q.phase) * walk;
  const bob = 0.008 * Math.abs(Math.sin(Q.phase)) * walk;
  const pk = Math.sin(Math.min(1, Q.peck) * Math.PI);
  const put = (lf, ls, lz, rx, ry, rz, kind) => out.push({
    c: [Q.x + lf * F[0] + ls * S[0], Q.y + lf * F[1] + ls * S[1], Q.z + lz], r: [rx, ry, rz], kind, F, S });
  put(0, 0, 0.17 + bob, 0.17, 0.12, 0.115, 0);
  put(-0.16, 0, 0.2 + bob, 0.075, 0.06, 0.035, 6);
  const hf = 0.13 + 0.05 * pk, hz = 0.27 - 0.13 * pk + bob;
  put(hf, 0, hz, 0.065, 0.058, 0.062, 1);
  put(hf - 0.015, 0, hz + 0.064, 0.036, 0.031, 0.029, 2);
  put(hf + 0.062, 0, hz - 0.006, 0.026, 0.013, 0.013, 3);
  put(hf + 0.03, 0.048, hz + 0.014, 0.012, 0.012, 0.012, 7);
  put(hf + 0.03, -0.048, hz + 0.014, 0.012, 0.012, 0.012, 7);
  put(swing, 0.045, 0.055, 0.013, 0.013, 0.06, 4);
  put(-swing, -0.045, 0.055, 0.013, 0.013, 0.06, 4);
  put(swing, 0.045, 0.03, 0.022, 0.022, 0.012, 5);       // the band, on one leg only
}

// Her: a striped poncho on long noodle legs. The legs run from the hips to wherever the feet
// have planted themselves, sagging into a soft curve.
function playerParts(out, caps) {
  const s = P.riding ? 0.25 : P.s;
  const F = [P.bx, P.by], S = bodySide();
  let bx = P.x, by = P.y, bz = P.z, zs = P.crawl ? 0.58 : 1;
  if (P.riding) { bx = Q.x - Q.fx * 0.03; by = Q.y - Q.fy * 0.03; bz = Q.z + 0.1; zs = 0.8; }
  const moving = Math.hypot(P.vx, P.vy) > 0.05 * s;
  const bob = moving ? 0.025 * s * Math.abs(Math.sin(performance.now() / 1000 * 11)) : 0;
  const put = (lf, ls, lz, rx, ry, rz, kind) => out.push({
    c: [bx + lf * F[0] + ls * S[0], by + lf * F[1] + ls * S[1], bz + lz * zs + bob], r: [rx, ry, rz * zs], kind, F, S });
  put(0, 0, 1.07 * s, 0.25 * s, 0.28 * s, 0.25 * s, 9);
  put(0, 0, 1.25 * s, 0.17 * s, 0.2 * s, 0.13 * s, 9);
  put(0.005 * s, 0, 1.47 * s, 0.13 * s, 0.13 * s, 0.135 * s, 10);
  put(-0.03 * s, 0, 1.51 * s, 0.14 * s, 0.14 * s, 0.13 * s, 14);
  put(0.122 * s, 0.045 * s, 1.48 * s, 0.016 * s, 0.016 * s, 0.02 * s, 7);
  put(0.122 * s, -0.045 * s, 1.48 * s, 0.016 * s, 0.016 * s, 0.02 * s, 7);
  if (!feet) return;
  const legSide = P.riding ? 0.11 : 0.075 * s;
  for (const f of feet) {
    const hx = bx + f.side * legSide * S[0], hy = by + f.side * legSide * S[1], hz = bz + 0.86 * s * zs + bob;
    const fx = f.x, fy = f.y, fz = f.z + 0.05 * s;
    const len = Math.hypot(hx - fx, hy - fy, hz - fz);
    const slack = Math.max(0, 0.86 * s - len) / s;  // shorter than the leg: bend more
    const kx = (hx + fx) / 2 + F[0] * (0.05 + 0.5 * slack) * s, ky = (hy + fy) / 2 + F[1] * (0.05 + 0.5 * slack) * s, kz = (hz + fz) / 2;
    const N = 4;
    let prev = [hx, hy, hz];
    for (let i = 1; i <= N; i++) {
      const t = i / N, a = (1 - t) * (1 - t), b = 2 * (1 - t) * t, c = t * t;
      const pt = [a * hx + b * kx + c * fx, a * hy + b * ky + c * fy, a * hz + b * kz + c * fz];
      caps.push({ a: prev, b: pt, r: 0.028 * s, kind: 11 });
      prev = pt;
    }
    out.push({ c: [fx + F[0] * 0.035 * s, fy + F[1] * 0.035 * s, f.z + 0.035 * s], r: [0.075 * s, 0.045 * s, 0.035 * s], kind: 13, F, S });
  }
}

let resScale = 0.5;
const VIEWS = ['follow', 'first'];
let view = 'follow';

// Follow camera: close behind her and a little above her head, at a height fixed to her size.
// It backs away horizontally from her, and if that line passes a glued gap the camera ends up
// on the far side with its orientation (and scale) carried across, just like the view rays.
// It always stays below the wall tops, so it can't see over a wall.
function cameraPose() {
  const H = PLAYER_H * P.s;
  let x = P.riding ? Q.x : P.x, y = P.riding ? Q.y : P.y;
  let fx = P.fx, fy = P.fy, rx = P.rx, ry = P.ry, k = 1;
  if (view === 'first') {
    if (P.riding) { x = Q.x - Q.fx * 0.12; y = Q.y - Q.fy * 0.12; }
    return { x, y, z: P.eye, fx, fy, rx, ry, k, pitch: P.pitch, hideSelf: true };
  }
  let z = (P.riding ? Q.z + 0.3 : P.z) + 1.45 * H;
  let dx = -fx, dy = -fy;
  const D = 2.1 * P.s + (P.riding ? 0.35 : 0);
  let tmin = 0, tEnd = D;
  for (let bounce = 0; bounce < 12; bounce++) {
    let tb = D, hit = -1;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i], ex = s.x1 - s.x0, ey = s.y1 - s.y0;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-12) continue;
      const qx = s.x0 - x, qy = s.y0 - y;
      const t = (qx * ey - qy * ex) / den, u = (qx * dy - qy * dx) / den;
      if (u < 0 || u > 1 || t <= tmin + 1e-6 || t >= tb) continue;
      tb = t; hit = i;
    }
    if (hit < 0) break;
    const s = segs[hit];
    if (s.door) {
      if (s.portal) {
        const T = portals[s.portal];
        [x, y] = applyP(T, x, y); [dx, dy] = applyL(T, dx, dy);
        z *= T.s;
        [fx, fy] = norm(...applyL(T, fx, fy)); [rx, ry] = norm(...applyL(T, rx, ry));
        k *= T.s;
      }
      tmin = tb;
      continue;
    }
    tEnd = Math.max(tmin, tb - 0.15 * P.s);   // a wall: stop a little short of it
    break;
  }
  const hideSelf = tEnd < 0.45 * P.s;
  return { x: x + dx * tEnd, y: y + dy * tEnd, z: Math.min(WALL - 0.15, z), fx, fy, rx, ry, k, pitch: P.pitch, hideSelf };
}

function resize() {
  const w = Math.max(64, Math.round(innerWidth * resScale)), h = Math.max(48, Math.round(innerHeight * resScale));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
}

function render() {
  resize();
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.uniform2f(U.uRes, canvas.width, canvas.height);
  const cam = cameraPose();
  gl.uniform3f(U.uCam, cam.x, cam.y, cam.z);
  gl.uniform2f(U.uF, cam.fx, cam.fy);
  gl.uniform2f(U.uR, cam.rx, cam.ry);
  gl.uniform1f(U.uPitch, cam.pitch);
  gl.uniform1f(U.uPS, P.s * cam.k);   // her size, measured in the camera's frame
  gl.uniform1f(U.uScale, cam.k);

  const boxes = worldBoxes();
  const BA = new Float32Array(MAXB * 4), BB = new Float32Array(MAXB * 4);
  boxes.slice(0, MAXB).forEach((b, i) => { BA.set([b.minx, b.miny, b.maxx, b.maxy], i * 4); BB.set([b.z0, b.z1, b.kind, 0], i * 4); });
  gl.uniform4fv(U.uBA, BA); gl.uniform4fv(U.uBB, BB); gl.uniform1i(U.uNB, Math.min(MAXB, boxes.length));

  const ells = [], caps = [];
  quailParts(ells);
  if (!cam.hideSelf) playerParts(ells, caps);
  for (const p of pillars) caps.push({ a: [p.x, p.y, -1], b: [p.x, p.y, p.h - p.r], r: p.r, kind: 20 });
  const CA = new Float32Array(MAXC * 4), CB = new Float32Array(MAXC * 4);
  caps.slice(0, MAXC).forEach((c, i) => { CA.set([...c.a, c.r], i * 4); CB.set([...c.b, c.kind], i * 4); });
  gl.uniform4fv(U.uCA, CA); gl.uniform4fv(U.uCB, CB); gl.uniform1i(U.uNC, Math.min(MAXC, caps.length));
  if (!logged.plant) ells.push({ c: [plant.x, plant.y, plant.z + 0.06], r: [0.17, 0.17, 0.07], kind: 8, F: [1, 0], S: [0, -1] });
  const EC = new Float32Array(MAXE * 4), ER = new Float32Array(MAXE * 4), EB = new Float32Array(MAXE * 4);
  ells.slice(0, MAXE).forEach((e, i) => { EC.set([...e.c, e.kind], i * 4); ER.set([...e.r, 0], i * 4); EB.set([...e.F, ...e.S], i * 4); });
  gl.uniform4fv(U.uEC, EC); gl.uniform4fv(U.uER, ER); gl.uniform4fv(U.uEB, EB); gl.uniform1i(U.uNE, Math.min(MAXE, ells.length));

  gl.drawArrays(gl.TRIANGLES, 0, 3);
}

// ======================================================================
// Input and loop
// ======================================================================
const titleEl = document.getElementById('title');
let playing = false;

function setJournal(open) {
  journalOpen = open;
  journalEl.style.display = open ? 'flex' : 'none';
  if (open) { drawMap(); if (document.pointerLockElement) document.exitPointerLock(); }
}

canvas.addEventListener('click', () => { if (!journalOpen) canvas.requestPointerLock(); });
titleEl.addEventListener('click', () => { titleEl.style.display = 'none'; playing = true; canvas.requestPointerLock(); });
journalEl.addEventListener('click', () => { setJournal(false); canvas.requestPointerLock(); });
document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && playing && !journalOpen) {
    titleEl.style.display = 'flex';
    document.getElementById('startLabel').textContent = 'Click to continue';
  }
});
document.addEventListener('mousemove', e => {
  if (document.pointerLockElement === canvas) { lookX += e.movementX; lookY += e.movementY; }
});
addEventListener('keydown', e => {
  keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'KeyJ' || (e.code === 'Escape' && journalOpen)) { setJournal(!journalOpen); if (!journalOpen) canvas.requestPointerLock(); }
  if (journalOpen) return;
  if (e.code === 'KeyQ') quailAction();
  if (e.code === 'KeyR') { reset(); toast('Restarted.'); }
  if (e.code === 'KeyV') {
    view = VIEWS[(VIEWS.indexOf(view) + 1) % VIEWS.length];
    if (view === 'follow') P.pitch = -0.3;
    toast(view === 'follow' ? 'Follow view' : 'First-person view');
  }
  if (e.code === 'Backquote') { debugOn = !debugOn; debugEl.style.display = debugOn ? 'block' : 'none'; }
  if (e.code === 'BracketLeft') resScale = Math.max(0.25, resScale - 0.125);
  if (e.code === 'BracketRight') resScale = Math.min(1.5, resScale + 0.125);
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

let last = performance.now(), clock = 0;
function tick(dt) {
  clock += dt;
  updatePlayer(dt); updateQuail(dt, clock); updateFeet(dt);
}
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  if (!journalOpen && playing) tick(dt);
  render();
  if (journalOpen) drawMap();
  drawDebug();
  requestAnimationFrame(frame);
}

reset();
requestAnimationFrame(frame);

// for testing from the console
window.GENUS = { get P() { return P; }, get Q() { return Q; }, get crates() { return crates; }, segs, portals, bfs,
  step(dt, keyList = []) { keyList.forEach(k => keys.add(k)); tick(dt); keyList.forEach(k => keys.delete(k)); },
  hold(k) { keys.add(k); }, release(k) { keys.delete(k); },
  turn(px) { lookX += px; }, setView(v) { view = v; }, quailAction, render, reset, drawMap, setJournal, probe, playerBody,
  start() { titleEl.style.display = 'none'; playing = true; } };
})();
