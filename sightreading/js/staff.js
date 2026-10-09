// SVG grand-staff renderer.
// One "line" of music = { key, timeSig, beatsPerBar, slices:[{beat, dur, notes:[{d,clef,acc,print,dur}], annot}] }
// print: accidental to print in front of the note (null = none).
import { STAFF_BOTTOM, STAFF_TOP, keyById, keySigPositions, noteName } from './music.js';

const NS = 'http://www.w3.org/2000/svg';
export const DEFAULT_W = 1000;
const SP = 10;               // one staff space
const T_TOP = 70;            // y of treble top line (F5)
const B_TOP = 170;           // y of bass top line (A3)
export const H = 270;
const GLYPH = { sharp: '♯', flat: '♭', natural: '♮', treble: '\u{1D11E}', bass: '\u{1D122}' };
const ACC_GLYPH = { '-1': GLYPH.flat, '0': GLYPH.natural, '1': GLYPH.sharp };

export function yOf(d, clef) {
  return clef === 'T' ? T_TOP - (d - 38) * (SP / 2) : B_TOP - (d - 26) * (SP / 2);
}

function el(name, attrs = {}, parent) {
  const e = document.createElementNS(NS, name);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function accText(parent, acc, x, y) {
  // Glyph baselines calibrated against Noto Music at 40px (one staff space = 250 units).
  const dy = acc === -1 ? 4 : 5;
  const t = el('text', { x, y: y + dy, class: 'glyph acc', 'font-size': 40, 'text-anchor': 'middle' }, parent);
  t.textContent = ACC_GLYPH[acc];
  return t;
}

function ledgerYs(d, clef) {
  const out = [];
  const bot = STAFF_BOTTOM[clef], top = STAFF_TOP[clef];
  for (let p = bot - 2; p >= d; p -= 2) out.push(yOf(p, clef));
  for (let p = top + 2; p <= d; p += 2) out.push(yOf(p, clef));
  return out;
}

/**
 * Render a line into `container`. Returns a handle used by the practice runners.
 */
export function renderLine(container, line, opts = {}) {
  const W = opts.width || DEFAULT_W;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'staff' + (opts.preview ? ' preview' : ''), role: 'img' });
  svg.setAttribute('aria-label', 'Music staff');
  const key = keyById(line.key || 'C');
  const clefs = line.clefs || ['T', 'B'];

  // ---- staff lines
  const gStaff = el('g', { class: 'stafflines' }, svg);
  const top = clefs.includes('T') ? T_TOP : B_TOP;
  const bottom = clefs.includes('B') ? B_TOP + 4 * SP : T_TOP + 4 * SP;
  for (const c of clefs) {
    const t0 = c === 'T' ? T_TOP : B_TOP;
    for (let i = 0; i < 5; i++) el('line', { x1: 14, x2: W - 6, y1: t0 + i * SP, y2: t0 + i * SP }, gStaff);
  }
  el('line', { x1: 14, x2: 14, y1: top, y2: bottom, class: 'bar' }, gStaff);
  el('line', { x1: W - 6, x2: W - 6, y1: top, y2: bottom, class: 'bar' }, gStaff);
  if (clefs.length === 2) {
    // brace
    el('path', { class: 'brace', d: `M10 ${top} C 1 ${top + 20}, 9 ${(top + bottom) / 2 - 18}, 2 ${(top + bottom) / 2} C 9 ${(top + bottom) / 2 + 18}, 1 ${bottom - 20}, 10 ${bottom}` }, gStaff);
  }

  // ---- clefs, key signature, time signature
  let x = 22;
  for (const c of clefs) {
    const t = el('text', { class: 'glyph clef', 'font-size': 40, x }, svg);
    if (c === 'T') { t.setAttribute('y', T_TOP + 4 * SP); t.textContent = GLYPH.treble; }
    else { t.setAttribute('y', B_TOP + 4 * SP - 3); t.textContent = GLYPH.bass; }
  }
  x = 58;
  const sig = key ? key.sig : 0;
  const nAcc = Math.abs(sig);
  for (const c of clefs) {
    keySigPositions(sig, c).forEach((p, i) => accText(svg, p.acc, x + 6 + i * 11, yOf(p.d, c)));
  }
  x += nAcc * 11 + (nAcc ? 8 : 0);
  if (line.timeSig) {
    for (const c of clefs) {
      const t0 = c === 'T' ? T_TOP : B_TOP;
      const a = el('text', { class: 'timesig', x: x + 9, y: t0 + 19, 'text-anchor': 'middle' }, svg);
      a.textContent = line.timeSig[0];
      const b = el('text', { class: 'timesig', x: x + 9, y: t0 + 39, 'text-anchor': 'middle' }, svg);
      b.textContent = line.timeSig[1];
    }
    x += 24;
  }
  const startX = x + 22;

  // ---- horizontal layout
  const slices = line.slices;
  const bpb = line.beatsPerBar || 4;
  const total = line.totalBeats ?? (slices.length ? slices[slices.length - 1].beat + slices[slices.length - 1].dur : 0);
  const weights = slices.map((s, i) => {
    const next = i + 1 < slices.length ? slices[i + 1].beat : total;
    const gap = Math.max(0.25, next - s.beat);
    return 0.6 + Math.sqrt(gap);
  });
  const BAR_GAP = 16;
  const barBefore = slices.map((s, i) => i > 0 && Math.abs(s.beat / bpb - Math.round(s.beat / bpb)) < 1e-6);
  const nBars = barBefore.filter(Boolean).length;
  const accRoom = slices.map(s => s.notes.some(n => n.print != null) ? 10 : 0);
  const fixed = nBars * BAR_GAP + accRoom.reduce((a, b) => a + b, 0) + 30;
  const scale = (W - startX - fixed) / weights.reduce((a, b) => a + b, 0.0001);
  const sliceX = [];
  const barXs = [];
  let cx = startX;
  slices.forEach((s, i) => {
    if (barBefore[i]) { barXs.push(cx + BAR_GAP / 2 - weights[i - 1] * scale * 0.25); cx += BAR_GAP; }
    cx += accRoom[i];
    sliceX.push(cx);
    cx += weights[i] * scale;
  });
  for (const bx of barXs) el('line', { x1: bx, x2: bx, y1: top, y2: bottom, class: 'bar' }, gStaff);

  // ---- cursor (wait mode) and playhead (flow mode)
  const cursor = el('rect', { class: 'cursor', x: -18, y: 26, width: 36, height: H - 40, rx: 8 }, svg);
  cursor.style.display = 'none';

  // ---- notes
  const sliceEls = [];
  slices.forEach((s, i) => {
    const g = el('g', { class: 'slice pending' }, svg);
    const xs = sliceX[i];
    // group notes by clef → one stem per clef per duration
    for (const clef of ['T', 'B']) {
      const ns = s.notes.filter(n => n.clef === clef).sort((a, b) => a.d - b.d);
      if (!ns.length) continue;
      drawChord(g, ns, clef, xs, s, opts);
    }
    if (s.annot != null) {
      const a = el('text', { class: 'annot', x: (i > 0 ? (sliceX[i - 1] + xs) / 2 : xs - 20), y: 145, 'text-anchor': 'middle' }, g);
      a.textContent = s.annot;
    }
    sliceEls.push(g);
  });

  // beams for consecutive eighth notes
  drawBeams(svg, slices, sliceX, sliceEls);

  const playhead = el('line', { class: 'playhead', x1: 0, x2: 0, y1: 22, y2: H - 12 }, svg);
  playhead.style.display = 'none';

  if (clefs.length === 1) {
    const y0 = clefs[0] === 'T' ? 16 : 118;
    svg.setAttribute('viewBox', `0 ${y0} ${W} ${clefs[0] === 'T' ? 136 : 152}`);
  }
  container.appendChild(svg);

  return {
    svg, sliceX, sliceEls, startX,
    setState(i, state) {
      const g = sliceEls[i];
      if (!g) return;
      g.setAttribute('class', 'slice ' + state);
    },
    addClass(i, c) { sliceEls[i]?.classList.add(c); },
    removeClass(i, c) { sliceEls[i]?.classList.remove(c); },
    moveCursor(i) {
      if (i == null || i >= sliceX.length) { cursor.style.display = 'none'; return; }
      cursor.style.display = '';
      cursor.style.transform = `translateX(${sliceX[i]}px)`;
    },
    /** x position for a fractional beat (flow mode) */
    xAtBeat(b) {
      if (!slices.length) return startX;
      if (b <= slices[0].beat) {
        const lead = Math.min(60, startX - 10);
        return sliceX[0] - lead * Math.min(1, (slices[0].beat - b));
      }
      for (let i = 0; i < slices.length; i++) {
        const b0 = slices[i].beat;
        const b1 = i + 1 < slices.length ? slices[i + 1].beat : total;
        const x0 = sliceX[i];
        const x1 = i + 1 < slices.length ? sliceX[i + 1] : W - 14;
        if (b < b1 || i === slices.length - 1) return x0 + (x1 - x0) * Math.min(1, (b - b0) / Math.max(1e-6, b1 - b0));
      }
      return W - 14;
    },
    showPlayhead(xp) {
      playhead.style.display = '';
      playhead.setAttribute('x1', xp); playhead.setAttribute('x2', xp);
    },
    hidePlayhead() { playhead.style.display = 'none'; },
    remove() { svg.remove(); },
  };
}

function drawChord(g, ns, clef, x, slice, opts) {
  const dur = ns[0].dur ?? slice.dur ?? 1;
  const mid = clef === 'T' ? 34 : 22;
  const avg = ns.reduce((a, n) => a + n.d, 0) / ns.length;
  const stemUp = opts.stemsUp ?? (avg < mid || (avg === mid && false));
  const up = avg === mid ? false : stemUp;
  const hollow = dur >= 2;
  const whole = dur >= 4;
  const dotted = Math.abs(dur - 1.5) < 1e-6 || Math.abs(dur - 3) < 1e-6 || Math.abs(dur - 0.75) < 1e-6;
  const RX = whole ? 7.4 : 6.4;

  // seconds: offset the second note of an adjacent pair
  const offs = ns.map(() => 0);
  if (up) {
    for (let i = 1; i < ns.length; i++) if (ns[i].d - ns[i - 1].d === 1 && offs[i - 1] === 0) offs[i] = RX * 2 - 1;
  } else {
    for (let i = ns.length - 2; i >= 0; i--) if (ns[i + 1].d - ns[i].d === 1 && offs[i + 1] === 0) offs[i] = -(RX * 2 - 1);
  }

  // ledger lines
  const ledg = new Set();
  ns.forEach((n, i) => ledgerYs(n.d, clef).forEach(y => ledg.add(y + ':' + offs[i])));
  for (const k of ledg) {
    const [y, o] = k.split(':').map(Number);
    el('line', { class: 'ledger', x1: x + o - RX - 4, x2: x + o + RX + 4, y1: y, y2: y }, g);
  }

  // accidentals (stagger columns for chords)
  let col = 0;
  for (let i = ns.length - 1; i >= 0; i--) {
    const n = ns[i];
    if (n.print == null) continue;
    const minOff = Math.min(0, ...offs);
    accText(g, n.print, x + minOff - RX - 7 - col * 10, yOf(n.d, clef));
    col = (col + 1) % 3;
  }

  // noteheads
  ns.forEach((n, i) => {
    const y = yOf(n.d, clef);
    const cxn = x + offs[i];
    const head = el('g', { class: 'head', transform: `translate(${cxn} ${y})` }, g);
    if (whole) {
      el('ellipse', { rx: RX, ry: 4.6, class: 'nh' }, head);
      el('ellipse', { rx: 3.1, ry: 2.2, transform: 'rotate(-55)', class: 'hole' }, head);
    } else {
      el('ellipse', { rx: RX, ry: 4.5, transform: 'rotate(-20)', class: 'nh' }, head);
      if (hollow) el('ellipse', { rx: 4.6, ry: 2.1, transform: 'rotate(-20)', class: 'hole' }, head);
    }
    if (dotted) {
      const dy = (n.d % 2 === (clef === 'T' ? 0 : 0)) ? 0 : 0;
      const onLine = (n.d - STAFF_BOTTOM[clef]) % 2 === 0;
      el('circle', { cx: RX + 5 + Math.max(0, ...offs), cy: onLine ? -4 + dy : dy, r: 1.8, class: 'nh' }, head);
    }
    // hint label (hidden unless shown)
    const lbl = el('text', { class: 'lbl', x: cxn, y: clef === 'T' ? 26 : H - 8, 'text-anchor': 'middle' }, g);
    lbl.textContent = noteName(n.d, n.acc ?? 0, true);
    lbl.dataset.y = y;
    if (opts.showNames) lbl.classList.add('on');
  });

  // stem
  if (!whole) {
    const ys = ns.map(n => yOf(n.d, clef));
    const far = up ? Math.max(...ys) : Math.min(...ys);
    const near = up ? Math.min(...ys) : Math.max(...ys);
    let len = 35;
    // stems reach the middle line at least when notes are far off the staff
    const midY = yOf(mid, clef);
    let end = up ? near - len : near + len;
    if (up && end > midY) end = midY;
    if (!up && end < midY) end = midY;
    const sx = up ? x + RX - 0.6 : x - RX + 0.6;
    const stem = el('line', { class: 'stem', x1: sx, x2: sx, y1: far, y2: end }, g);
    stem.dataset.clef = clef;
    stem.dataset.up = up ? 1 : 0;
    stem.dataset.dur = dur;
    // flags for eighths (removed later if beamed)
    if (dur < 1) {
      const f = up
        ? `M${sx} ${end} c 0.5 7, 11 9, 7.5 21 c 1.5 -8, -3 -12, -7.5 -14 z`
        : `M${sx} ${end} c 0.5 -7, 11 -9, 7.5 -21 c 1.5 8, -3 12, -7.5 14 z`;
      const flag = el('path', { class: 'flag', d: f }, g);
      stem._flag = flag;
    }
  }
}

function drawBeams(svg, slices, sliceX, sliceEls) {
  // beam pairs of eighths in the same clef that share a beat
  for (let i = 0; i + 1 < slices.length; i++) {
    const a = slices[i], b = slices[i + 1];
    if (Math.abs(a.dur - 0.5) > 1e-6 || Math.abs(b.dur - 0.5) > 1e-6) continue;
    if (Math.abs(a.beat - Math.floor(a.beat)) > 1e-6) continue;
    if (Math.abs(b.beat - a.beat - 0.5) > 1e-6) continue;
    for (const clef of ['T', 'B']) {
      const sa = [...sliceEls[i].querySelectorAll('.stem')].find(s => s.dataset.clef === clef && s.dataset.dur === '0.5');
      const sb = [...sliceEls[i + 1].querySelectorAll('.stem')].find(s => s.dataset.clef === clef && s.dataset.dur === '0.5');
      if (!sa || !sb) continue;
      // common direction: use the first stem's
      const up = sa.dataset.up === '1';
      if ((sb.dataset.up === '1') !== up) {
        // flip second stem to match
        const far2 = Number(sb.getAttribute('y1'));
        const xB = sliceX[i + 1] + (up ? 5.8 : -5.8);
        sb.setAttribute('x1', xB); sb.setAttribute('x2', xB);
        sb.setAttribute('y2', up ? far2 - 35 : far2 + 35);
      }
      let ya = Number(sa.getAttribute('y2')), yb = Number(sb.getAttribute('y2'));
      const ext = up ? Math.min(ya, yb) : Math.max(ya, yb);
      // gentle slope
      const fa = Number(sa.getAttribute('y1')), fb = Number(sb.getAttribute('y1'));
      let slope = Math.max(-5, Math.min(5, (fb - fa) / 2));
      ya = ext - (up ? Math.max(0, slope) : Math.min(0, slope));
      yb = ext + (up ? Math.min(0, slope) : Math.max(0, slope));
      sa.setAttribute('y2', ya); sb.setAttribute('y2', yb);
      sliceEls[i].querySelectorAll('.flag').forEach(f => f.remove());
      sliceEls[i + 1].querySelectorAll('.flag').forEach(f => f.remove());
      const xa = Number(sa.getAttribute('x1')), xb = Number(sb.getAttribute('x1'));
      const t = up ? 4.5 : -4.5;
      el('path', { class: 'beam', d: `M${xa} ${ya} L${xb} ${yb} L${xb} ${yb + t} L${xa} ${ya + t} Z` }, sliceEls[i]);
    }
  }
}
