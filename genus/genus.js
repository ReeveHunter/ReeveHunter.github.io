// Genus — prototype.
// A first-person world on a flat surface with glued edges. Rendering is a per-pixel ray tracer
// in a fragment shader: rays travel through the floor plan, and when one passes through a doorway
// that is glued somewhere else, it is carried across by that doorway's similarity transform
// (translation, rotation, reflection and/or uniform scale). Everything else (walking, carrying,
// the quail) uses the same transforms on the CPU.

(() => {
'use strict';

// ======================================================================
// Level
// ======================================================================
const CEIL = 3.0;
const segs = [];
// A segment is a wall or a doorway. Doorways glued elsewhere must be listed with the room's
// interior on their left (walking from p0 to p1).
function seg(x0, y0, x1, y1, o = {}) {
  segs.push({ x0, y0, x1, y1, door: !!o.door, h: o.h ?? CEIL, portal: 0, glyph: o.glyph || 0, gu: o.gu || 0 });
  return segs.length - 1;
}

const portals = [{ L: [1, 0, 0, 1], ox: 0, oy: 0, s: 1, det: 1 }]; // 0 = identity
const pairs = [];

// The similarity of the plane taking a0->c0 and a1->c1, orientation-preserving or reversing.
function similarity(a0, a1, c0, c1, reverse) {
  const ex = a1.x - a0.x, ey = a1.y - a0.y, fx = c1.x - c0.x, fy = c1.y - c0.y;
  const den = ex * ex + ey * ey;
  let L;
  if (!reverse) { // z -> alpha z + beta, alpha = f / e
    const ar = (fx * ex + fy * ey) / den, ai = (fy * ex - fx * ey) / den;
    L = [ar, -ai, ai, ar];
  } else {        // z -> alpha conj(z) + beta, alpha = f / conj(e)
    const ar = (fx * ex - fy * ey) / den, ai = (fy * ex + fx * ey) / den;
    L = [ar, ai, ai, -ar];
  }
  const ox = c0.x - (L[0] * a0.x + L[1] * a0.y);
  const oy = c0.y - (L[2] * a0.x + L[3] * a0.y);
  const det = L[0] * L[3] - L[1] * L[2];
  return { L, ox, oy, s: Math.sqrt(Math.abs(det)), det };
}

// Glue doorway i to doorway j. Without a flip, p0 of one meets p1 of the other.
function link(i, j, flip) {
  const A = segs[i], B = segs[j];
  const a0 = { x: A.x0, y: A.y0 }, a1 = { x: A.x1, y: A.y1 };
  const b0 = { x: B.x0, y: B.y0 }, b1 = { x: B.x1, y: B.y1 };
  const tab = flip ? similarity(a0, a1, b0, b1, true) : similarity(a0, a1, b1, b0, false);
  const tba = flip ? similarity(b0, b1, a0, a1, true) : similarity(b0, b1, a1, a0, false);
  A.portal = portals.push(tab) - 1;
  B.portal = portals.push(tba) - 1;
  pairs.push({ i, j, flip });
}

// West room G (x -8..0). Its north doorway is glued to its own, half-size west doorway.
seg(-8, 8, -5, 8);
const gBig = seg(-3, 8, -5, 8, { door: true, h: 2.4 });
seg(-3, 8, 0, 8);
seg(-8, 0, -8, 3.5);
const gSmall = seg(-8, 4.5, -8, 3.5, { door: true, h: 1.2 });
seg(-8, 4.5, -8, 8);
seg(-8, 0, 0, 0);
seg(0, 0, 0, 3);
seg(0, 3, 0, 5, { door: true, h: 2.4 });   // G <-> A, an ordinary doorway
seg(0, 5, 0, 8);
// Start room A (x 0..10, y 0..8), with the passages' inner walls.
seg(0, 8, 4, 8);
seg(4, 8, 6, 8, { door: true, h: 2.4 });   // A <-> north passage
seg(6, 8, 20, 8);
seg(10, 8, 10, 0, { glyph: 1, gu: 4 });
seg(0, 0, 4, 0);
seg(4, 0, 6, 0, { door: true, h: 2.4 });   // A <-> south passage
seg(6, 0, 20, 0);
// North passage C (y 8..11): ends glued straight (a cylinder).
seg(0, 11, 20, 11, { glyph: 1, gu: 10 });
const cE = seg(20, 8, 20, 11, { door: true });
const cW = seg(0, 11, 0, 8, { door: true });
// South passage F (y -3..0): ends glued with a flip (a Möbius band).
seg(20, -3, 0, -3, { glyph: 1, gu: 10 });
const fE = seg(20, -3, 20, 0, { door: true });
const fW = seg(0, 0, 0, -3, { door: true });

link(gBig, gSmall, false);
link(cE, cW, false);
link(fE, fW, true);

const rooms = [
  { name: 'A', x0: 0, y0: 0, x1: 10, y1: 8, fill: '#ead8b9' },
  { name: 'G', x0: -8, y0: 0, x1: 0, y1: 8, fill: '#f1ece0' },
  { name: 'C', x0: 0, y0: 8, x1: 20, y1: 11, fill: '#e3d7b4' },
  { name: 'F', x0: 0, y0: -3, x1: 20, y1: 0, fill: '#e8cdb8' },
];

const staticBoxes = [
  { minx: 8.8, miny: 6.0, maxx: 9.995, maxy: 7.995, z0: 0, z1: 1.0, kind: 0 },   // ledge in A
  { minx: -5.0, miny: 7.75, maxx: -3.0, maxy: 7.995, z0: 0, z1: 0.2, kind: 0 }, // sill at G's north doorway
];

// ======================================================================
// State
// ======================================================================
const PLAYER_H = 1.7, CRAWL = 0.55, CLIMB = 0.62, RADIUS = 0.22, WALK = 2.4, REACH = 0.75;
const QUAIL_H = 0.36, QUAIL_R = 0.12, QUAIL_CLIMB = 0.22;

let P, Q, crates, plant, logged;

function reset() {
  P = { x: 5, y: 1.2, z: 0, fx: 0, fy: 1, rx: 1, ry: 0, pitch: -0.2, s: 1, eye: 1.58, crawl: false, held: null, riding: false };
  Q = { x: 4.3, y: 3.3, z: 0, fx: 1, fy: 0, m: 1, phase: 0, moving: false, peck: 0, peckT: 2, trail: [], stuckT: 0, held: false };
  crates = [
    { x: 6.2, y: 3.6, size: 0.4, z0: 0 },
    { x: -4.0, y: 2.2, size: 0.8, z0: 0 },
  ];
  plant = { x: 9.6, y: 7.5, z: 1.0 };
  logged = { quail: false, plant: false };
  renderJournalText();
}

// ======================================================================
// Geometry helpers
// ======================================================================
function applyP(T, x, y) { return [T.L[0] * x + T.L[1] * y + T.ox, T.L[2] * x + T.L[3] * y + T.oy]; }
function applyL(T, x, y) { return [T.L[0] * x + T.L[1] * y, T.L[2] * x + T.L[3] * y]; }
function norm(x, y) { const l = Math.hypot(x, y) || 1; return [x / l, y / l]; }

function closestOnSeg(px, py, s) {
  const ex = s.x1 - s.x0, ey = s.y1 - s.y0;
  let t = ((px - s.x0) * ex + (py - s.y0) * ey) / (ex * ex + ey * ey);
  t = Math.max(0, Math.min(1, t));
  return [s.x0 + t * ex, s.y0 + t * ey];
}
function crosses(ax, ay, bx, by, s) {
  const rx = bx - ax, ry = by - ay, sx = s.x1 - s.x0, sy = s.y1 - s.y0;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return false;
  const qx = s.x0 - ax, qy = s.y0 - ay;
  const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}
// Does this segment stop a body of height h standing at z?
function blocks(s, z, h) { return !s.door || z + h > s.h - 1e-6; }

function crateBox(c) { const hs = c.size / 2; return { minx: c.x - hs, miny: c.y - hs, maxx: c.x + hs, maxy: c.y + hs, z0: c.z0, z1: c.z0 + c.size, kind: 1, crate: c }; }
function worldBoxes(exclude) {
  const out = staticBoxes.slice();
  for (const c of crates) if (c !== exclude && !(P.held && P.held.crate === c)) out.push(crateBox(c));
  return out;
}
function circleRect(px, py, r, b) {
  const cx = Math.max(b.minx, Math.min(px, b.maxx)), cy = Math.max(b.miny, Math.min(py, b.maxy));
  const dx = px - cx, dy = py - cy, d2 = dx * dx + dy * dy;
  return { hit: d2 < r * r, cx, cy, dx, dy, d: Math.sqrt(d2) };
}

// Highest surface under a body that it can step onto.
function support(b) {
  let z = 0;
  for (const bx of worldBoxes(b.self)) {
    if (bx.z1 > b.z + b.climb + 1e-4) continue;
    if (circleRect(b.x, b.y, b.r * 0.5, bx).hit) z = Math.max(z, bx.z1);
  }
  return z;
}

function crateFits(c, nx, ny) {
  const hs = c.size / 2, rad = hs * 1.02;
  for (const s of segs) {
    if (s.door && s.portal === 0 && !blocks(s, c.z0, c.size)) continue;
    const [qx, qy] = closestOnSeg(nx, ny, s);
    if (Math.max(Math.abs(qx - nx), Math.abs(qy - ny)) < rad) return false;
  }
  for (const b of worldBoxes(c)) {
    if (b.z1 <= c.z0 + 1e-4 || b.z0 >= c.z0 + c.size) continue;
    if (nx - hs < b.maxx && nx + hs > b.minx && ny - hs < b.maxy && ny + hs > b.miny) return false;
  }
  return true;
}

// Push a body out of walls and boxes. A body that pushes can shove medium crates.
function resolve(b) {
  for (let it = 0; it < 4; it++) {
    for (const s of segs) {
      if (!blocks(s, b.z, b.h)) continue;
      const [qx, qy] = closestOnSeg(b.x, b.y, s);
      const dx = b.x - qx, dy = b.y - qy, d = Math.hypot(dx, dy);
      if (d < b.r && d > 1e-9) { b.x += dx / d * (b.r - d); b.y += dy / d * (b.r - d); }
    }
    for (const bx of worldBoxes(b.self)) {
      if (bx.z1 <= b.z + b.climb + 1e-4 || bx.z0 >= b.z + b.h) continue;
      const c = circleRect(b.x, b.y, b.r, bx);
      if (!c.hit) continue;
      let nx, ny, depth;
      if (c.d > 1e-9) { nx = c.dx / c.d; ny = c.dy / c.d; depth = b.r - c.d; }
      else {
        const l = b.x - bx.minx, r = bx.maxx - b.x, d = b.y - bx.miny, u = bx.maxy - b.y, m = Math.min(l, r, d, u);
        if (m === l) { nx = -1; ny = 0; } else if (m === r) { nx = 1; ny = 0; } else if (m === d) { nx = 0; ny = -1; } else { nx = 0; ny = 1; }
        depth = m + b.r;
      }
      if (b.pusher && bx.crate) {
        const rel = bx.crate.size / P.s;
        if (rel > 0.45 && rel <= 1.25) {
          const cx = bx.crate.x - nx * depth, cy = bx.crate.y - ny * depth;
          if (crateFits(bx.crate, cx, cy)) { bx.crate.x = cx; bx.crate.y = cy; continue; }
        }
      }
      b.x += nx * depth; b.y += ny * depth;
    }
  }
}

// Move a body, carrying it across glued doorways. onCross(T, segIndex, beyondX, beyondY) runs
// after each crossing so the caller can rescale or reorient whatever rides along.
function moveBody(b, dx, dy, onCross) {
  const len = Math.hypot(dx, dy);
  const n = Math.max(1, Math.ceil(len / (b.r * 0.5)));
  let sx = dx / n, sy = dy / n;
  for (let i = 0; i < n; i++) {
    let nx = b.x + sx, ny = b.y + sy;
    for (let k = 0; k < segs.length; k++) {
      const s = segs[k];
      if (!s.door || s.portal === 0 || blocks(s, b.z, b.h)) continue;
      if (!crosses(b.x, b.y, nx, ny, s)) continue;
      const T = portals[s.portal], bxp = nx, byp = ny;
      [nx, ny] = applyP(T, nx, ny);
      [sx, sy] = applyL(T, sx, sy);
      b.z *= T.s;
      if (onCross) onCross(T, k, bxp, byp);
      break;
    }
    b.x = nx; b.y = ny;
    resolve(b);
  }
  if (n === 0) resolve(b);
}

// ======================================================================
// Player
// ======================================================================
function playerBody() {
  const H = PLAYER_H * P.s;
  return { x: P.x, y: P.y, z: P.z, r: RADIUS * P.s, h: H * CRAWL, climb: CLIMB * P.s, pusher: true };
}
function transformPlayer(T) {
  P.s *= T.s;
  [P.fx, P.fy] = norm(...applyL(T, P.fx, P.fy));
  [P.rx, P.ry] = norm(...applyL(T, P.rx, P.ry));
  P.eye *= T.s;
}
function transformQuail(T) {
  const sx = Q.m * Q.fy, sy = -Q.m * Q.fx;        // the quail's side vector
  [Q.fx, Q.fy] = norm(...applyL(T, Q.fx, Q.fy));
  const [tx, ty] = applyL(T, sx, sy);
  Q.m = Math.sign(tx * Q.fy - ty * Q.fx) || 1;    // compare with right(F)
}
function clearance(x, y, z, r) {
  let c = CEIL - z;
  for (const s of segs) {
    if (!s.door) continue;
    const [qx, qy] = closestOnSeg(x, y, s);
    if (Math.hypot(x - qx, y - qy) < r) c = Math.min(c, s.h - z);
  }
  return c;
}
function parity() { return Math.sign(P.rx * P.fy - P.ry * P.fx); } // +1 normal, -1 mirrored

const keys = new Set();
let lookX = 0, lookY = 0;

function updatePlayer(dt) {
  // look
  const a = lookX * 0.0022; lookX = 0;
  if (a) {
    const c = Math.cos(a), s = Math.sin(a);
    const fx = P.fx * c + P.rx * s, fy = P.fy * c + P.ry * s;
    const rx = P.rx * c - P.fx * s, ry = P.ry * c - P.fy * s;
    P.fx = fx; P.fy = fy;
    // keep R perpendicular to F, on the same side it was
    const side = Math.sign(rx * fy - ry * fx) || 1;
    [P.fx, P.fy] = norm(P.fx, P.fy);
    P.rx = side * P.fy; P.ry = -side * P.fx;
  }
  P.pitch = Math.max(-1.25, Math.min(1.25, P.pitch - lookY * 0.0022)); lookY = 0;
  if (thirdPerson) P.pitch = Math.max(-1.1, Math.min(0.45, P.pitch));

  let f = 0, st = 0;
  if (keys.has('KeyW') || keys.has('ArrowUp')) f += 1;
  if (keys.has('KeyS') || keys.has('ArrowDown')) f -= 1;
  if (keys.has('KeyD') || keys.has('ArrowRight')) st += 1;
  if (keys.has('KeyA') || keys.has('ArrowLeft')) st -= 1;
  let mx = P.fx * f + P.rx * st, my = P.fy * f + P.ry * st;
  const ml = Math.hypot(mx, my);
  if (ml > 0) { mx /= ml; my /= ml; }

  if (P.riding) {
    const spd = 2.6;
    const b = { x: Q.x, y: Q.y, z: Q.z, r: QUAIL_R, h: QUAIL_H + 0.5 * PLAYER_H * P.s, climb: QUAIL_CLIMB, self: null };
    moveBody(b, mx * spd * dt, my * spd * dt, (T) => { transformQuail(T); transformPlayer(T); });
    Q.moving = ml > 0;
    if (ml > 0) faceQuail(b.x - Q.x, b.y - Q.y, dt);
    Q.x = b.x; Q.y = b.y; Q.z = support({ ...b, z: Q.z });
    P.x = Q.x; P.y = Q.y; P.z = Q.z + 0.3;
    const target = Q.z + 0.36 + 0.45 * PLAYER_H * P.s;
    P.eye += (target - P.eye) * Math.min(1, dt * 12);
    return;
  }

  walking += ((ml > 0 ? 1 : 0) - walking) * Math.min(1, dt * 10);
  walkPhase += dt * (P.crawl ? 6 : 9) * walking;
  const spd = WALK * P.s * (P.crawl ? 0.5 : 1);
  const b = playerBody();
  const ox = P.x, oy = P.y;
  moveBody(b, mx * spd * dt, my * spd * dt, (T, k, bx, by) => {
    transformPlayer(T);
    b.r = RADIUS * P.s; b.h = PLAYER_H * P.s * CRAWL; b.climb = CLIMB * P.s;
    Q.trail.push({ cross: true, x: bx, y: by, seg: k });
  });
  P.x = b.x; P.y = b.y;
  // climb or fall
  const sup = support({ x: P.x, y: P.y, z: P.z, r: RADIUS * P.s, climb: CLIMB * P.s });
  P.z = sup > P.z ? sup : Math.max(sup, P.z - 9 * P.s * dt);
  // stand when there's room, crawl when there isn't
  const Hn = PLAYER_H * P.s;
  P.crawl = clearance(P.x, P.y, P.z, RADIUS * P.s * 1.3) < Hn;
  const target = P.z + (P.crawl ? 0.85 * Hn * CRAWL : 0.93 * Hn);
  P.eye += (target - P.eye) * Math.min(1, dt * 12);

  // breadcrumbs for the quail
  const last = Q.trail[Q.trail.length - 1];
  const spacing = Math.max(0.05, Math.min(0.5, 0.25 * P.s));
  if (!last || last.cross || Math.hypot(P.x - last.x, P.y - last.y) > spacing) {
    if (Math.hypot(P.x - ox, P.y - oy) > 1e-6 || !last) Q.trail.push({ x: P.x, y: P.y });
  }
  if (Q.trail.length > 6000) Q.trail.splice(0, Q.trail.length - 6000);
}

// ======================================================================
// Quail
// ======================================================================
function faceQuail(dx, dy, dt) {
  const l = Math.hypot(dx, dy); if (l < 1e-6) return;
  const k = Math.min(1, dt * 10);
  [Q.fx, Q.fy] = norm(Q.fx + (dx / l - Q.fx) * k, Q.fy + (dy / l - Q.fy) * k);
}

function updateQuail(dt) {
  Q.phase += dt * (Q.moving ? 22 : 0);
  if (P.riding) return;
  if (Q.held) {
    Q.x = P.x + P.fx * (0.3 * P.s + 0.25); Q.y = P.y + P.fy * (0.3 * P.s + 0.25);
    Q.z = Math.max(P.z, P.eye - 0.6 * P.s);
    Q.moving = false; Q.trail.length = 0;
    return;
  }
  let dPlayer = Math.hypot(P.x - Q.x, P.y - Q.y);
  const pending = Q.trail.some(t => t.cross);
  const stopDist = 0.45 + 0.5 * P.s;
  if (!pending) while (Q.trail.length && Math.hypot(Q.trail[Q.trail.length - 1].x - P.x, Q.trail[Q.trail.length - 1].y - P.y) < stopDist) Q.trail.pop();
  // step aside if the player walks into us
  const touch = QUAIL_R + RADIUS * P.s;
  if (dPlayer < touch && dPlayer > 1e-6 && Math.abs(P.z - Q.z) < QUAIL_H) {
    const b = { x: Q.x, y: Q.y, z: Q.z, r: QUAIL_R, h: QUAIL_H, climb: QUAIL_CLIMB };
    moveBody(b, (Q.x - P.x) / dPlayer * (touch - dPlayer), (Q.y - P.y) / dPlayer * (touch - dPlayer), (T) => transformQuail(T));
    Q.x = b.x; Q.y = b.y; dPlayer = Math.hypot(P.x - Q.x, P.y - Q.y);
  }
  if (!pending && dPlayer < stopDist) {
    Q.trail.length = 0; Q.moving = false;
    // idle: peck now and then
    Q.peckT -= dt;
    if (Q.peckT < 0) { Q.peck = 1; Q.peckT = 1.5 + Math.random() * 3; }
    Q.peck = Math.max(0, Q.peck - dt * 3);
    if (dPlayer > 0.05) faceQuail(P.x - Q.x, P.y - Q.y, dt * 0.3);
    return;
  }
  Q.peck = 0;
  // drop trail points already behind us
  while (Q.trail.length && !Q.trail[0].cross && Math.hypot(Q.trail[0].x - Q.x, Q.trail[0].y - Q.y) < 0.12) Q.trail.shift();
  const tgt = Q.trail[0];
  let tx, ty;
  if (tgt) { tx = tgt.x; ty = tgt.y; } else { tx = P.x; ty = P.y; }
  const dx = tx - Q.x, dy = ty - Q.y, d = Math.hypot(dx, dy);
  if (d < 1e-6) { if (tgt && !tgt.cross) Q.trail.shift(); return; }
  const spd = Math.min(7, 2.6 + Math.max(0, dPlayer - stopDist) * 1.5);
  const step = Math.min(d + (tgt && tgt.cross ? 0.3 : 0), spd * dt);
  const b = { x: Q.x, y: Q.y, z: Q.z, r: QUAIL_R, h: QUAIL_H, climb: QUAIL_CLIMB, self: null };
  let crossed = false;
  moveBody(b, dx / d * step, dy / d * step, (T) => { transformQuail(T); crossed = true; });
  const moved = Math.hypot(b.x - Q.x, b.y - Q.y);
  if (!crossed) faceQuail(dx, dy, dt);
  Q.x = b.x; Q.y = b.y;
  Q.z = support({ x: Q.x, y: Q.y, z: Q.z, r: QUAIL_R, climb: QUAIL_CLIMB });
  Q.moving = true;
  if (crossed) {
    // we went through a glued doorway: drop everything up to and including the crossing marker
    const ci = Q.trail.findIndex(t => t.cross);
    if (ci >= 0) Q.trail.splice(0, ci + 1);
    Q.stuckT = 0;
  } else if (moved < step * 0.25) {
    Q.stuckT += dt;
    if (Q.stuckT > 0.8) { // can't get there (too high, too narrow): skip ahead to the next crossing
      const ci = Q.trail.findIndex(t => t.cross);
      if (tgt && !tgt.cross) Q.trail.splice(0, ci >= 0 ? ci : Q.trail.length);
      else if (tgt && tgt.cross) Q.trail.shift();
      Q.stuckT = 0;
    }
  } else Q.stuckT = 0;
  if (!logged.quail && Math.hypot(P.x - Q.x, P.y - Q.y) < 1.2) logSpecimen('quail');
}

// ======================================================================
// Interaction
// ======================================================================
function freeSpot(x, y, r, z, h) {
  for (const s of segs) {
    if (!blocks(s, z, h) && !(s.door && s.portal > 0)) continue;
    const [qx, qy] = closestOnSeg(x, y, s);
    if (Math.hypot(x - qx, y - qy) < r) return false;
  }
  for (const b of worldBoxes()) {
    if (b.z1 <= z + 1e-4 || b.z0 >= z + h) continue;
    if (circleRect(x, y, r, b).hit) return false;
  }
  return true;
}

function interact() {
  if (P.riding) return;
  if (P.held && P.held.crate) { dropCrate(); return; }
  if (P.held) return;
  const H = PLAYER_H * P.s;
  // specimen
  if (!logged.plant) {
    const hd = Math.hypot(plant.x - P.x, plant.y - P.y);
    if (hd < REACH * P.s + 0.1 && plant.z >= P.z - 0.1 && plant.z <= P.z + H) { logSpecimen('plant'); return; }
  }
  // crate
  let best = null, bd = 1e9;
  for (const c of crates) {
    const dx = c.x - P.x, dy = c.y - P.y, d = Math.hypot(dx, dy);
    const reach = RADIUS * P.s + c.size * 0.75 + 0.45 * P.s;
    if (d > reach || d < 1e-6) continue;
    if ((dx * P.fx + dy * P.fy) / d < 0.3) continue;
    if (c.z0 + c.size < P.z - 0.3 * P.s || c.z0 > P.z + H) continue;
    if (crates.some(o => o !== c && o.z0 >= c.z0 + c.size - 1e-3 && Math.abs(o.x - c.x) < (o.size + c.size) / 2 && Math.abs(o.y - c.y) < (o.size + c.size) / 2)) continue;
    if (d < bd) { bd = d; best = c; }
  }
  if (best) {
    const rel = best.size / P.s;
    if (rel <= 0.45) { P.held = { crate: best, rel }; toast(''); }
    else if (rel <= 1.25) toast('Too heavy to lift — but you could push it.');
    else toast('It won’t budge.');
  }
}

function dropCrate() {
  const c = P.held.crate, size = P.held.rel * P.s;
  const dist = RADIUS * P.s + size * 0.5 + 0.15 * P.s;
  const x = P.x + P.fx * dist, y = P.y + P.fy * dist;
  // what would it rest on?
  let base = 0;
  const hs = size / 2;
  for (const b of worldBoxes()) {
    if (x - hs < b.maxx && x + hs > b.minx && y - hs < b.maxy && y + hs > b.miny) {
      if (b.z1 <= P.z + CLIMB * P.s + 1e-4) base = Math.max(base, b.z1);
    }
  }
  const test = { x, y, size, z0: base };
  if (!crateFits(test, x, y)) { toast('No room to put it down there.'); return; }
  c.x = x; c.y = y; c.size = size; c.z0 = base;
  P.held = null;
}

function quailAction() {
  if (P.riding) { // dismount beside the quail
    const r = RADIUS * P.s, H = PLAYER_H * P.s;
    const off = QUAIL_R + r + 0.03;
    const tries = [[P.rx, P.ry], [-P.rx, -P.ry], [-P.fx, -P.fy], [P.fx, P.fy]];
    for (const [dx, dy] of tries) {
      const x = Q.x + dx * off, y = Q.y + dy * off;
      if (freeSpot(x, y, r, Q.z, H * CRAWL)) {
        P.riding = false; P.x = x; P.y = y; P.z = Q.z; Q.trail.length = 0; return;
      }
    }
    toast('No room to climb down here.');
    return;
  }
  if (Q.held) { // put the quail down in front
    const x = P.x + P.fx * (RADIUS * P.s + 0.25), y = P.y + P.fy * (RADIUS * P.s + 0.25);
    const z = support({ x, y, z: P.z, r: QUAIL_R, climb: CLIMB * P.s });
    if (!freeSpot(x, y, QUAIL_R, z, QUAIL_H)) { toast('No room to set the quail down.'); return; }
    Q.held = false; Q.x = x; Q.y = y; Q.z = z; Q.trail.length = 0; return;
  }
  const d = Math.hypot(Q.x - P.x, Q.y - P.y);
  if (Math.abs(Q.z - P.z) > 0.5 * P.s + 0.2) return;
  if (P.s <= 0.3 && d < QUAIL_R + RADIUS * P.s + 0.25) {
    if (P.held) { toast('Your hands are full.'); return; }
    P.riding = true; Q.trail.length = 0; return;
  }
  if (P.s >= 1.6 && d < RADIUS * P.s + 0.7) {
    if (P.held) { toast('Your hands are full.'); return; }
    Q.held = true; return;
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
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toastEl.classList.remove('on'), 2600);
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
  const bx0 = -9.5, bx1 = 21, by0 = -4.2, by1 = 12.2;
  const k = Math.min(W / (bx1 - bx0), H / (by1 - by0));
  const ox = (W - k * (bx1 - bx0)) / 2, oy = (H - k * (by1 - by0)) / 2;
  const X = x => ox + (x - bx0) * k, Y = y => H - (oy + (y - by0) * k);
  mctx.clearRect(0, 0, W, H);
  mctx.fillStyle = '#f7f0e2'; mctx.fillRect(0, 0, W, H);
  for (const r of rooms) { mctx.fillStyle = r.fill; mctx.fillRect(X(r.x0), Y(r.y1), (r.x1 - r.x0) * k, (r.y1 - r.y0) * k); }
  for (const b of staticBoxes) { mctx.fillStyle = 'rgba(150,110,70,.35)'; mctx.fillRect(X(b.minx), Y(b.maxy), (b.maxx - b.minx) * k, (b.maxy - b.miny) * k); }
  // walls
  mctx.lineCap = 'round';
  for (const s of segs) {
    if (s.door) continue;
    mctx.strokeStyle = '#4a3b2c'; mctx.lineWidth = 4;
    mctx.beginPath(); mctx.moveTo(X(s.x0), Y(s.y0)); mctx.lineTo(X(s.x1), Y(s.y1)); mctx.stroke();
  }
  // glued doorways: arrows from p0 to p1 on one side, and along the image on the other
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
      mctx.beginPath();
      mctx.moveTo(cx - ux * 9 + nx * 8, cy - uy * 9 + ny * 8);
      mctx.lineTo(cx, cy);
      mctx.lineTo(cx - ux * 9 - nx * 8, cy - uy * 9 - ny * 8);
      mctx.stroke();
    }
    if (label) {
      mctx.fillStyle = col; mctx.font = 'bold 20px Georgia, serif';
      // put the label on the room side
      mctx.fillText(label, mx - nx * 26 - 10, my - ny * 26 + 7);
    }
  }
  // plain doorways
  for (const s of segs) {
    if (!s.door || s.portal) continue;
    mctx.strokeStyle = '#9b8a72'; mctx.lineWidth = 1.5; mctx.setLineDash([4, 4]);
    mctx.beginPath(); mctx.moveTo(X(s.x0), Y(s.y0)); mctx.lineTo(X(s.x1), Y(s.y1)); mctx.stroke();
    mctx.setLineDash([]);
  }
  // crates, plant, quail
  for (const c of crates) {
    if (P.held && P.held.crate === c) continue;
    mctx.fillStyle = '#9a6a3c'; mctx.fillRect(X(c.x - c.size / 2), Y(c.y + c.size / 2), c.size * k, c.size * k);
  }
  if (!logged.plant) { mctx.fillStyle = '#5c8a46'; mctx.beginPath(); mctx.arc(X(plant.x), Y(plant.y), 6, 0, 7); mctx.fill(); }
  mctx.fillStyle = '#7d8a99'; mctx.beginPath(); mctx.arc(X(Q.x), Y(Q.y), 7, 0, 7); mctx.fill();
  // the player's L: long bar along F, foot along R
  const px = X(P.x), py = Y(P.y);
  const fx = P.fx, fy = -P.fy, rx = P.rx, ry = -P.ry, L = 24;
  mctx.strokeStyle = '#1f1a15'; mctx.lineWidth = 5; mctx.lineJoin = 'round';
  mctx.beginPath();
  mctx.moveTo(px + fx * L, py + fy * L);
  mctx.lineTo(px, py);
  mctx.lineTo(px + rx * L * 0.55, py + ry * L * 0.55);
  mctx.stroke();
  // labels
  mctx.fillStyle = '#6f6353'; mctx.font = 'italic 18px Georgia, serif';
  mctx.fillText('start room', X(3.2), Y(4.3));
  mctx.fillText('west room', X(-5.6), Y(4.3));
  mctx.fillText('north passage', X(12.5), Y(9.3));
  mctx.fillText('south passage', X(12.5), Y(-1.7));
}

const debugEl = document.getElementById('debug');
let debugOn = false, fps = 60;
function drawDebug() {
  if (!debugOn) return;
  debugEl.textContent =
    `fps ${fps.toFixed(0)}  res ${resScale.toFixed(2)}\n` +
    `size x${P.s.toFixed(3)} (log2 ${Math.log2(P.s).toFixed(2)})\n` +
    `mirrored ${parity() < 0 ? 'yes' : 'no'}   quail mirrored ${Q.m < 0 ? 'yes' : 'no'}\n` +
    `pos ${P.x.toFixed(2)}, ${P.y.toFixed(2)}, z ${P.z.toFixed(2)}  ${P.riding ? 'riding' : P.crawl ? 'crawling' : 'standing'}\n` +
    `holding ${P.held ? 'crate' : Q.held ? 'quail' : 'nothing'}  trail ${Q.trail.length}`;
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

const MAXS = 32, MAXP = 8, MAXB = 12, MAXE = 24;

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
uniform int uNS, uNB, uNE;
uniform vec4 uSA[${MAXS}];   // x0 y0 x1 y1
uniform vec4 uSB[${MAXS}];   // isDoor, doorHeight, portal, glyph position (or -1)
uniform vec4 uPL[${MAXP}];   // linear part, row-major
uniform vec4 uPO[${MAXP}];   // offset x, offset y, scale, det
uniform vec4 uBA[${MAXB}];   // minx miny maxx maxy
uniform vec4 uBB[${MAXB}];   // z0 z1 kind
uniform vec4 uEC[${MAXE}];   // centre, kind
uniform vec4 uER[${MAXE}];   // radii
uniform vec4 uEB[${MAXE}];   // forward.xy, side.xy

const float CEIL = 3.0;
const float PI = 3.14159265;
const vec3 HAZE = vec3(0.86, 0.79, 0.69);
const vec3 SUN = normalize(vec3(0.35, 0.55, 0.76));

float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), f.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
}
float cross2(vec2 a, vec2 b){ return a.x*b.y - a.y*b.x; }
// periodic in x with period 20, so the glued passages show no seam
float pwave(float x, float k, float ph){ return sin(x * 2.0*PI*k/20.0 + ph); }

// slow rise, quick fall: a lopsided (chiral) wave with no hard steps
float asym(float x){ x = fract(x); return min(x / 0.8, (1.0 - x) / 0.2); }

int roomOf(vec2 p){
  if (p.y > 8.0) return 2;
  if (p.y < 0.0) return 3;
  if (p.x < 0.0) return 1;
  return 0;
}

vec3 plasterOf(int r){
  if (r == 1) return vec3(0.91, 0.89, 0.84);
  if (r == 2) return vec3(0.83, 0.73, 0.57);
  if (r == 3) return vec3(0.84, 0.67, 0.53);
  return vec3(0.87, 0.77, 0.61);
}

// The painted landscape above the wainscot. Shapes are deliberately lopsided (slow rise,
// sharp drop) so that a mirrored room looks mirrored.
vec3 mural(int r, float u, float z){
  vec3 skyLo, skyHi, far, near, ground;
  float hFar, hNear;
  if (r == 1) {        // white sands
    skyLo = vec3(0.93,0.91,0.86); skyHi = vec3(0.62,0.76,0.90);
    far = vec3(0.66,0.71,0.78); near = vec3(0.97,0.95,0.90); ground = vec3(0.95,0.93,0.86);
    hFar = 1.75 + 0.18*sin(u*0.9) + 0.10*sin(u*2.3+1.0);
    hNear = 1.32 + 0.16*asym(u*0.35);
  } else if (r == 2) { // grassland under a monsoon sky
    skyLo = vec3(0.78,0.76,0.72); skyHi = vec3(0.42,0.47,0.56);
    far = vec3(0.56,0.55,0.62); near = vec3(0.70,0.63,0.45); ground = vec3(0.80,0.71,0.46);
    hFar = 1.68 + 0.22*pwave(u,3.0,0.4) + 0.12*pwave(u,7.0,1.3) + 0.25*asym(u*4.0/20.0);
    hNear = 1.28 + 0.05*pwave(u,11.0,0.0);
  } else if (r == 3) { // red mesas
    skyLo = vec3(0.95,0.82,0.66); skyHi = vec3(0.56,0.70,0.86);
    far = vec3(0.70,0.47,0.38); near = vec3(0.64,0.36,0.27); ground = vec3(0.82,0.62,0.46);
    float m = fract(u*3.0/20.0);
    hFar = 1.55 + 0.45*smoothstep(0.08,0.12,m)*(1.0-smoothstep(0.55,0.75,m));
    hNear = 1.30 + 0.18*smoothstep(0.0,0.6,fract(u*5.0/20.0+0.3))*step(fract(u*5.0/20.0+0.3),0.62);
  } else {             // desert mountains
    skyLo = vec3(0.95,0.86,0.72); skyHi = vec3(0.52,0.70,0.88);
    far = vec3(0.56,0.61,0.70); near = vec3(0.66,0.62,0.55); ground = vec3(0.82,0.70,0.52);
    hFar = 1.62 + 0.24*sin(u*0.55) + 0.12*sin(u*1.7+2.0) + 0.34*asym(u*0.23);
    hNear = 1.30 + 0.10*asym(u*0.6+0.2);
  }
  vec3 c = mix(skyLo, skyHi, smoothstep(1.3, 2.9, z));
  if (r == 2) { // storm clouds
    float cl = 0.5 + 0.25*pwave(u,5.0,z*3.0) + 0.25*pwave(u,9.0,1.7-z*2.0);
    c = mix(c, vec3(0.36,0.39,0.46), smoothstep(0.55,0.75,cl) * smoothstep(2.0,2.7,z));
  }
  if (r == 0) { // a painted sun
    vec2 sp = vec2(fract(u/7.0)*7.0 - 4.2, z - 2.45);
    c = mix(c, vec3(1.0,0.93,0.74), 1.0 - smoothstep(0.17, 0.2, length(sp)));
  }
  if (z < hFar) c = mix(far, skyLo, 0.15*smoothstep(hFar-0.3, hFar, z));
  if (z < hNear) c = near;
  if (z < 1.18) c = ground;
  return c;
}

// tetromino L, cells of 0.26 along the wall
float glyphL(float u, float z){
  vec2 g = vec2(u / 0.26 + 1.0, (z - 1.35) / 0.26);
  bool a = g.x >= 0.0 && g.x < 1.0 && g.y >= 0.0 && g.y < 3.0;
  bool b = g.x >= 1.0 && g.x < 2.0 && g.y >= 0.0 && g.y < 1.0;
  return (a || b) ? 1.0 : 0.0;
}

vec3 wallColor(int r, float uw, float z, float gu, float useg){
  vec3 base = plasterOf(r);
  float mott;
  if (r >= 2) mott = 0.5 + 0.25*pwave(uw, 13.0, z*7.0) + 0.25*pwave(uw, 29.0, z*13.0);
  else mott = vnoise(vec2(uw, z) * 5.0);
  vec3 c;
  if (z < 0.95) c = base * (0.9 + 0.12*mott);
  else if (z < 1.05) c = (r == 1) ? vec3(0.55,0.63,0.70) : vec3(0.64,0.35,0.23);
  else if (z < 2.78) c = mural(r, uw, z) * (0.95 + 0.07*mott);
  else c = base * (z < 2.84 ? 0.78 : 0.95 + 0.06*mott);   // cornice
  if (gu >= 0.0 && glyphL(useg - gu, z) > 0.5) c = vec3(0.42,0.20,0.14);
  return c;
}

vec3 floorColor(int r, vec2 p){
  if (r == 1) { // gypsum sand
    float rip = 0.5 + 0.5*sin(p.x*7.0 + 1.5*sin(p.y*1.3));
    return vec3(0.93,0.91,0.85) * (0.94 + 0.06*rip);
  }
  float ts = (r == 2) ? 1.0 : 0.5;
  vec2 cell = floor(p / ts), f = fract(p / ts);
  float grout = step(min(min(f.x, 1.0-f.x), min(f.y, 1.0-f.y)), 0.035);
  float v = hash(cell);
  vec3 tile;
  if (r == 2) tile = vec3(0.70,0.58,0.42) * (0.9 + 0.15*v);          // adobe bricks
  else if (r == 3) tile = vec3(0.66,0.42,0.31) * (0.88 + 0.18*v);     // red flagstone
  else tile = vec3(0.76,0.48,0.32) * (0.88 + 0.18*v);                 // saltillo tile
  return mix(tile, tile*0.62, grout);
}

vec3 ceilingColor(int r, vec2 p){
  vec3 sky = (r == 2) ? vec3(0.50,0.55,0.64) : vec3(0.58,0.74,0.89);
  if (r <= 1) {
    float cl = vnoise(p * 0.35) * 0.65 + vnoise(p * 1.1) * 0.35;
    sky = mix(sky, vec3(0.97,0.96,0.93), smoothstep(0.55, 0.75, cl));
  } else {
    float cen = abs(p.y - (r == 2 ? 9.5 : -1.5)); // symmetric across the passage, so the flip matches up
    sky = mix(sky, vec3(0.90,0.88,0.84), 0.35*smoothstep(1.5, 0.0, cen));
  }
  // vigas (ceiling beams)
  float bx = fract(p.x / 1.0);
  if (bx < 0.13) sky = vec3(0.40,0.28,0.18) * (0.85 + 0.15*sin(p.y*9.0));
  return sky;
}

struct Hit { float t; int type; int idx; vec3 n; vec3 lp; };

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
  vec3 col = HAZE;
  float tHit = 1e9;
  bool found = false;

  for (int bounce = 0; bounce < 18; bounce++) {
    Hit h; h.t = 1e9; h.type = 0; h.idx = -1; h.n = vec3(0); h.lp = vec3(0);
    if (d.z < 0.0) { float t = -o.z / d.z; if (t > tmin && t < h.t) { h.t = t; h.type = 1; } }
    if (d.z > 0.0) { float t = (CEIL - o.z) / d.z; if (t > tmin && t < h.t) { h.t = t; h.type = 2; } }
    for (int i = 0; i < ${MAXS}; i++) {
      if (i >= uNS) break;
      vec4 A = uSA[i];
      vec2 e = A.zw - A.xy;
      float den = cross2(d.xy, e);
      if (abs(den) < 1e-9) continue;
      vec2 q = A.xy - o.xy;
      float t = cross2(q, e) / den;
      float u = cross2(q, d.xy) / den;
      if (u < 0.0 || u > 1.0 || t <= tmin + 1e-5 || t >= h.t) continue;
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

    if (h.type == 0) break;
    vec3 p = o + h.t * d;

    if (h.type == 3) {
      vec4 B = uSB[h.idx];
      if (B.x > 0.5 && p.z < B.y) {          // through a doorway
        int pi = int(B.z + 0.5);
        if (pi > 0) {
          vec4 L = uPL[pi], O = uPO[pi];
          o = vec3(L.x*o.x + L.y*o.y + O.x, L.z*o.x + L.w*o.y + O.y, o.z * O.z);
          d = vec3(L.x*d.x + L.y*d.y, L.z*d.x + L.w*d.y, d.z * O.z);
          sd = sign(d) * max(abs(d), vec3(1e-7));
          inv = 1.0 / sd;
        }
        tmin = h.t;
        continue;
      }
    }

    found = true; tHit = h.t;
    float lit = 1.0;
    if (h.type == 1) {
      int r = roomOf(p.xy);
      col = floorColor(r, p.xy);
      // soft contact shadows under boxes and the quail
      float sh = 1.0;
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
        float dd = length(p.xy - uEC[i].xy);
        sh *= 1.0 - 0.45*(1.0 - smoothstep(0.04, 0.2, dd));
      }
      lit = 0.95 * sh;
    } else if (h.type == 2) {
      col = ceilingColor(roomOf(p.xy), p.xy);
      lit = 1.0;
    } else if (h.type == 3) {
      vec4 A = uSA[h.idx], B = uSB[h.idx];
      vec2 e = normalize(A.zw - A.xy);
      vec2 n2 = vec2(-e.y, e.x);
      if (dot(n2, d.xy) > 0.0) n2 = -n2;
      int r = roomOf(p.xy + n2 * 0.02);
      float uw = abs(e.x) > abs(e.y) ? p.x : p.y;
      float useg = dot(p.xy - A.xy, e);
      if (B.x > 0.5 && p.z < B.y + 0.16) { // wooden lintel just above a doorway
        col = vec3(0.44,0.30,0.19) * (0.85 + 0.15*sin(useg*31.0 + p.z*3.0));
      } else if (B.x > 0.5) {
        col = wallColor(r, uw, p.z, -1.0, useg);
      } else {
        col = wallColor(r, uw, p.z, B.w, useg);
      }
      lit = 0.78 + 0.22*dot(n2, normalize(vec2(0.6, 0.8)));
      lit *= 0.82 + 0.18*smoothstep(0.0, 0.25, p.z);  // darker at the floor
    } else if (h.type == 4) {
      vec4 BA = uBA[h.idx], BB = uBB[h.idx];
      vec3 bmin = vec3(BA.xy, BB.x), bmax = vec3(BA.zw, BB.y);
      vec3 lp = (p - bmin) / (bmax - bmin);
      if (BB.z > 0.5) { // crate
        vec2 fuv = abs(h.n.z) > 0.5 ? lp.xy : (abs(h.n.x) > 0.5 ? lp.yz : lp.xz);
        float edge = step(min(min(fuv.x, 1.0-fuv.x), min(fuv.y, 1.0-fuv.y)), 0.09);
        float plank = smoothstep(0.0, 0.04, abs(fract(fuv.y * 4.0) - 0.5) - 0.44);
        vec3 wood = vec3(0.64,0.46,0.28) * (0.9 + 0.1*sin(fuv.x*40.0 + fuv.y*7.0));
        col = mix(wood * (1.0 - 0.25*plank), vec3(0.42,0.28,0.16), edge);
      } else {
        col = plasterOf(roomOf(p.xy - h.n.xy*0.01)) * (h.n.z > 0.5 ? 1.0 : 0.88);
        if (h.n.z > 0.5) col *= 0.92 + 0.08*vnoise(p.xy*6.0);
      }
      lit = 0.72 + 0.28*max(0.0, dot(h.n, SUN));
    } else if (h.type == 5) {
      int kind = int(uEC[h.idx].w + 0.5);
      vec3 l = h.lp;
      if (kind == 0) {         // body: scaly blue-grey, paler belly
        vec2 sc = vec2(atan(l.y, l.x) * 2.6, l.z * 5.5);
        sc.x += 0.5 * mod(floor(sc.y), 2.0);
        float scale = length(fract(sc) - vec2(0.5, 0.15));
        vec3 feather = vec3(0.55,0.60,0.67);
        col = mix(feather, vec3(0.30,0.33,0.38), smoothstep(0.42, 0.5, scale));
        col = mix(col, vec3(0.84,0.80,0.70), smoothstep(-0.2, -0.75, l.z));
        col = mix(col, vec3(0.58,0.53,0.47), smoothstep(0.3, 0.9, l.z) * smoothstep(0.0, -0.8, l.x)); // brownish back
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
      else if (kind == 10) col = vec3(0.80,0.60,0.46);   // skin
      else if (kind == 11) col = vec3(0.22,0.19,0.18);   // long legs
      else if (kind == 13) col = vec3(0.40,0.27,0.17);   // boots
      else if (kind == 14) col = vec3(0.17,0.12,0.09);   // hair
      else if (kind == 8) {     // resurrection plant: a green spiral rosette
        float ang = atan(l.y, l.x), rr = length(l.xy);
        float spiral = fract(ang / (2.0*PI) * 5.0 + log(max(rr, 0.02)) * 1.6);
        col = mix(vec3(0.30,0.50,0.27), vec3(0.52,0.68,0.36), smoothstep(0.3, 0.7, spiral));
      }
      lit = 0.55 + 0.45*max(0.0, dot(h.n, SUN)) + 0.1*h.n.z;
    }
    col *= lit;
    break;
  }

  float dist = found ? tHit / uScale : 1e9;
  float fog = 1.0 - exp(-dist * 0.03);
  col = mix(col, HAZE, clamp(fog, 0.0, 1.0));
  float vig = 1.0 - 0.18*dot(uv*0.6, uv*0.6);
  fragColor = vec4(pow(col * vig, vec3(0.95)), 1.0);
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
for (const n of ['uRes', 'uCam', 'uF', 'uR', 'uPitch', 'uScale', 'uNS', 'uNB', 'uNE', 'uSA', 'uSB', 'uPL', 'uPO', 'uBA', 'uBB', 'uEC', 'uER', 'uEB'])
  U[n] = gl.getUniformLocation(prog, n);

// static: segments and portals
{
  const SA = new Float32Array(MAXS * 4), SB = new Float32Array(MAXS * 4);
  segs.forEach((s, i) => {
    SA.set([s.x0, s.y0, s.x1, s.y1], i * 4);
    SB.set([s.door ? 1 : 0, s.h, s.portal, s.glyph ? s.gu : -1], i * 4);
  });
  const PL = new Float32Array(MAXP * 4), PO = new Float32Array(MAXP * 4);
  portals.forEach((T, i) => { PL.set(T.L, i * 4); PO.set([T.ox, T.oy, T.s, T.det], i * 4); });
  gl.uniform4fv(U.uSA, SA); gl.uniform4fv(U.uSB, SB);
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
  put(0, 0, 0.17 + bob, 0.17, 0.12, 0.115, 0);            // body
  put(-0.16, 0, 0.2 + bob, 0.075, 0.06, 0.035, 6);        // tail
  const hf = 0.13 + 0.05 * pk, hz = 0.27 - 0.13 * pk + bob;
  put(hf, 0, hz, 0.065, 0.058, 0.062, 1);                 // head
  put(hf - 0.015, 0, hz + 0.064, 0.036, 0.031, 0.029, 2); // cotton top
  put(hf + 0.062, 0, hz - 0.006, 0.026, 0.013, 0.013, 3); // beak
  put(hf + 0.03, 0.048, hz + 0.014, 0.012, 0.012, 0.012, 7);
  put(hf + 0.03, -0.048, hz + 0.014, 0.012, 0.012, 0.012, 7);
  put(swing, 0.045, 0.055, 0.013, 0.013, 0.06, 4);        // legs
  put(-swing, -0.045, 0.055, 0.013, 0.013, 0.06, 4);
  put(swing, 0.045, 0.03, 0.022, 0.022, 0.012, 5);        // the band, on one leg only
}

let resScale = 0.5, thirdPerson = true;

// Follow camera: start at her head and back away along the view direction. The camera
// ray can pass through a glued doorway, in which case the camera ends up in another part of
// the level with its orientation (and scale) carried across, exactly as the view rays are.
function cameraPose() {
  const H = PLAYER_H * P.s;
  let x, y, z;
  if (P.riding) { x = Q.x; y = Q.y; z = Q.z + 0.36 + 0.55 * H; }
  else { x = P.x; y = P.y; z = P.z + (P.crawl ? 0.5 : 0.88) * H; }
  let fx = P.fx, fy = P.fy, rx = P.rx, ry = P.ry, k = 1;
  if (!thirdPerson) {
    if (P.riding) { x = Q.x - Q.fx * 0.12; y = Q.y - Q.fy * 0.12; }
    return { x, y, z: P.eye, fx, fy, rx, ry, k, hideSelf: true };
  }
  const cp = Math.cos(P.pitch), sp = Math.sin(P.pitch);
  let dx = -fx * cp, dy = -fy * cp, dz = -sp;
  const D = 2.2 * P.s + (P.riding ? 0.35 : 0);
  let tmin = 0;
  for (let bounce = 0; bounce < 6; bounce++) {
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
    const s = segs[hit], hz = z + tb * dz;
    if (s.door && hz < s.h) {
      if (s.portal) {
        const T = portals[s.portal];
        [x, y] = applyP(T, x, y); [dx, dy] = applyL(T, dx, dy);
        z *= T.s; dz *= T.s;
        [fx, fy] = norm(...applyL(T, fx, fy)); [rx, ry] = norm(...applyL(T, rx, ry));
        k *= T.s;
      }
      tmin = tb;
      continue;
    }
    // a wall: stop a little short of it
    const t = Math.max(tmin, tb - 0.12 * P.s);
    return { x: x + dx * t, y: y + dy * t, z: Math.max(0.06 * k, Math.min(CEIL - 0.06, z + dz * t)), fx, fy, rx, ry, k, hideSelf: tb < 0.5 * P.s };
  }
  return { x: x + dx * D, y: y + dy * D, z: Math.max(0.06 * k, Math.min(CEIL - 0.06, z + dz * D)), fx, fy, rx, ry, k, hideSelf: false };
}

// Her: a striped poncho on long, bendy legs.
let walkPhase = 0, walking = 0;
function playerParts(out) {
  const s = P.s, F = [P.fx, P.fy], S = [P.rx, P.ry];
  let bx = P.x, by = P.y, bz = P.z, zs = P.crawl ? 0.58 : 1, legSide = 0.07 * s;
  if (P.riding) { bx = Q.x - Q.fx * 0.02; by = Q.y - Q.fy * 0.02; bz = Q.z + 0.24; zs = 0.62; legSide = 0.11; }
  const put = (lf, ls, lz, rx, ry, rz, kind) => out.push({
    c: [bx + lf * F[0] + ls * S[0], by + lf * F[1] + ls * S[1], bz + lz * zs], r: [rx, ry, rz * zs], kind, F, S });
  const sw = P.riding ? 0 : 0.16 * s * Math.sin(walkPhase) * walking;
  const lift = (a) => P.riding ? 0 : 0.06 * s * Math.max(0, Math.sin(walkPhase + a)) * walking;
  for (const side of [1, -1]) {
    const w = side * sw, l = lift(side > 0 ? 0 : Math.PI);
    put(0.3 * w, side * legSide, 0.69 * s, 0.03 * s, 0.03 * s, 0.22 * s, 11);          // thigh
    put(0.7 * w, side * legSide, 0.29 * s + l, 0.027 * s, 0.027 * s, 0.23 * s, 11);    // shin
    put(w + 0.035 * s, side * legSide, 0.04 * s + l, 0.075 * s, 0.045 * s, 0.035 * s, 13); // boot
  }
  put(0, 0, 1.07 * s, 0.25 * s, 0.28 * s, 0.25 * s, 9);    // poncho
  put(0, 0, 1.25 * s, 0.17 * s, 0.2 * s, 0.13 * s, 9);     // shoulders
  put(0.005 * s, 0, 1.47 * s, 0.13 * s, 0.13 * s, 0.135 * s, 10); // head
  put(-0.03 * s, 0, 1.51 * s, 0.14 * s, 0.14 * s, 0.13 * s, 14);  // hair
  put(0.122 * s, 0.045 * s, 1.48 * s, 0.016 * s, 0.016 * s, 0.02 * s, 7);
  put(0.122 * s, -0.045 * s, 1.48 * s, 0.016 * s, 0.016 * s, 0.02 * s, 7);
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
  gl.uniform1f(U.uPitch, P.pitch);
  gl.uniform1f(U.uScale, cam.k);

  const boxes = worldBoxes();
  if (P.held && P.held.crate) {
    const size = P.held.rel * P.s, d = RADIUS * P.s + 0.28 * P.s + size / 2;
    const x = P.x + P.fx * d, y = P.y + P.fy * d;
    const z0 = Math.max(P.z, P.eye - 0.42 * P.s - size / 2);
    boxes.push({ minx: x - size / 2, miny: y - size / 2, maxx: x + size / 2, maxy: y + size / 2, z0, z1: z0 + size, kind: 1 });
  }
  const BA = new Float32Array(MAXB * 4), BB = new Float32Array(MAXB * 4);
  boxes.slice(0, MAXB).forEach((b, i) => { BA.set([b.minx, b.miny, b.maxx, b.maxy], i * 4); BB.set([b.z0, b.z1, b.kind, 0], i * 4); });
  gl.uniform4fv(U.uBA, BA); gl.uniform4fv(U.uBB, BB); gl.uniform1i(U.uNB, Math.min(MAXB, boxes.length));

  const ells = [];
  quailParts(ells);
  if (!cam.hideSelf) playerParts(ells);
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
  if (e.repeat) { keys.add(e.code); return; }
  keys.add(e.code);
  if (e.code === 'KeyJ' || (e.code === 'Escape' && journalOpen)) { setJournal(!journalOpen); if (!journalOpen) canvas.requestPointerLock(); }
  if (journalOpen) return;
  if (e.code === 'KeyE') interact();
  if (e.code === 'KeyQ') quailAction();
  if (e.code === 'KeyR') { reset(); toast('Restarted.'); }
  if (e.code === 'KeyV') { thirdPerson = !thirdPerson; toast(thirdPerson ? 'Follow view' : 'First-person view'); }
  if (e.code === 'Backquote') { debugOn = !debugOn; debugEl.style.display = debugOn ? 'block' : 'none'; }
  if (e.code === 'BracketLeft') resScale = Math.max(0.25, resScale - 0.125);
  if (e.code === 'BracketRight') resScale = Math.min(1.5, resScale + 0.125);
});
addEventListener('keyup', e => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000); last = now;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  if (!journalOpen && playing) { updatePlayer(dt); updateQuail(dt); }
  render();
  if (journalOpen) drawMap();
  drawDebug();
  requestAnimationFrame(frame);
}

reset();
requestAnimationFrame(frame);

// for testing from the console
window.GENUS = { get P() { return P; }, get Q() { return Q; }, get crates() { return crates; }, segs, portals,
  step(dt, keyList = []) { keyList.forEach(k => keys.add(k)); updatePlayer(dt); updateQuail(dt); keyList.forEach(k => keys.delete(k)); },
  turn(px) { lookX += px; }, interact, quailAction, render, reset, drawMap, setJournal,
  start() { titleEl.style.display = 'none'; playing = true; } };
})();
