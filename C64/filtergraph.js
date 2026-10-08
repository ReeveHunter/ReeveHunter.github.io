// filtergraph.js
// Frequency response of the SID filter as Cynthcart sets it on a 6581,
// with the filter FX (FILT1-5) animated the way the firmware runs them.
//
// Sources:
// - Cutoff: reSID 0.16's measured 6581 curve (Dag Lem, filter.cc,
//   f0_points_6581: FC 0-2047 -> 220 Hz-18 kHz, tanh-shaped, with the
//   jump at FC = 0x80 << 3). Real 6581s vary from chip to chip.
// - Resonance: reSID 0.16, 1/Q = 1 / (0.707 + res/15).
// - Filter shapes: the SID's 2-pole state-variable filter (12 dB/octave);
//   the selected outputs (LP, BP, HP) are summed.
// - Cynthcart writes only the high cutoff register ($D416): FC = value << 3.
//   The value sent each pass is filterSetValue + (filterModValue - 127),
//   clamped to 0-255 (updateFilterAndPW in cynthcart.asm).
// - FX timing follows cynthmodulation.asm, one step per main-loop pass
//   (about 150 passes per second).

const PASSES_PER_SEC = 150;

// ---- 6581 cutoff (FC -> Hz), monotone cubic through reSID's points, split at the jump
const LO = [[0, 220], [128, 230], [256, 250], [384, 300], [512, 420], [640, 780], [768, 1600], [832, 2300],
  [896, 3200], [960, 4300], [992, 5000], [1008, 5400], [1016, 5700], [1023, 6000]];
const HI = [[1024, 4600], [1032, 4800], [1056, 5300], [1088, 6000], [1120, 6600], [1152, 7200], [1280, 9500],
  [1408, 12000], [1536, 14500], [1664, 16000], [1792, 17100], [1920, 17700], [2047, 18000]];
function monotone(pts) {
  const n = pts.length, x = pts.map((p) => p[0]), y = pts.map((p) => p[1]);
  const d = [], m = [];
  for (let i = 0; i < n - 1; i++) d.push((y[i + 1] - y[i]) / (x[i + 1] - x[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) { // Fritsch-Carlson: no overshoot
    if (d[i] === 0) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return (v) => {
    let i = 0;
    while (i < n - 2 && v > x[i + 1]) i++;
    const h = x[i + 1] - x[i], t = (v - x[i]) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * y[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}
const loCurve = monotone(LO), hiCurve = monotone(HI);
/** Cutoff in Hz for an 11-bit FC on a 6581 (reSID's measurements). */
export const f0_6581 = (fc) => (fc < 1024 ? loCurve(fc) : hiCurve(fc));
/** Cutoff in Hz for Cynthcart's 8-bit cutoff value (written to $D416). */
export const cutoffHz = (v) => f0_6581(Math.max(0, Math.min(255, v)) << 3);
export const qFor = (res) => 0.707 + res / 15;

/** Magnitude in dB of the summed outputs at f, for type bits (1 LP, 2 BP, 4 HP). */
export function responseDb(f, f0, q, type) {
  if (!type) return -Infinity;
  // H(s) = (a s^2 + b w0 s + c w0^2) / (s^2 + s w0/Q + w0^2), s = jw; LP = -w0^2, BP = w0 s, HP = -s^2
  const w = f / f0; // normalized
  const c = type & 1 ? -1 : 0, b = type & 2 ? 1 : 0, a = type & 4 ? -1 : 0;
  const nr = -a * w * w + c, ni = b * w;
  const dr = 1 - w * w, di = w / q;
  const mag = Math.hypot(nr, ni) / Math.hypot(dr, di);
  return 20 * Math.log10(Math.max(mag, 1e-6));
}

// ---- firmware FX simulation (filterModValue per pass)
export class FxSim {
  constructor() { this.reset(); }
  reset() { this.mod = 127; this.v1 = 150; this.dir = 1; this.frame = 0; this.notes = 0; this.lastCount = -1; this.retrig = false; }
  noteChange(count, retrigger) { this.notes = count; if (retrigger) this.retrig = true; }
  /** one main-loop pass; fx = Cynthcart FX number */
  step(fx) {
    this.frame = (this.frame + 1) & 0xff;
    switch (fx) {
      case 1: // FILT1: slow triangle 150..245, one step every 8 passes
        if ((this.frame & 7) === 0) {
          this.v1 += this.dir ? 1 : -1;
          if (this.v1 >= 245) this.dir = 0;
          if (this.v1 <= 150) this.dir = 1;
        }
        this.mod = this.v1; break;
      case 2: // FILT2: rises 1 every other pass to 255 while notes are held, 0 with none
        if (this.frame & 1) break;
        if (this.v1 < 255) this.v1++;
        this.mod = this.v1;
        if (this.notes === 0) this.v1 = 0;
        break;
      case 3: // FILT3: drops 5 per pass from 180 (while >= 8), restarts when the held notes change
        if (this.v1 & 0xf8) this.v1 -= 5;
        this.mod = this.v1;
        if (this.retrig) { this.v1 = 180; this.retrig = false; }
        break;
      case 4: this.mod = this.frame & 8 ? 230 : 0; break; // FILT4: chopper, 8 passes each
      case 5: this.mod = this.frame & 2 ? 150 : 50; break; // FILT5: fast chopper, 2 passes each
      default: this.mod = 127;
    }
  }
  /** The value Cynthcart writes to $D416 (updateFilterAndPW, byte for byte).
   *  With no FX, mod = 127 and the result is cutoff + 1. A mod of 255 (FILT2 at
   *  its top) lands in the "negative" branch and wraps: the cutoff drops. */
  static written(set, mod) {
    const a = (mod - 127) & 0xff, carry = mod >= 127 ? 1 : 0;
    const sum = a + set + carry;
    if (a & 0x80) return sum > 255 ? sum - 256 : 0;
    return sum > 255 ? 255 : sum;
  }
}
const FX_MODS = {
  1: Array.from({ length: 96 }, (_, i) => 150 + i), // 150-245
  2: Array.from({ length: 256 }, (_, i) => i),
  3: Array.from({ length: 36 }, (_, i) => 180 - 5 * i).filter((m) => m >= 0),
  4: [0, 230],
  5: [50, 150],
};
/** lowest and highest cutoff (Hz) an FX reaches from this cutoff setting */
export function fxRangeHz(fx, set) {
  const mods = FX_MODS[fx];
  if (!mods) return null;
  const hz = mods.map((m) => cutoffHz(FxSim.written(set, m)));
  return [Math.min(...hz), Math.max(...hz)];
}

// ---- drawing
const NS = "http://www.w3.org/2000/svg";
const W = 600, H = 200, PAD_L = 34, PAD_R = 8, PAD_T = 10, PAD_B = 34;
const FMIN = 30, FMAX = 20000, DBMAX = 12, DBMIN = -36;
const xOf = (f) => PAD_L + (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * (W - PAD_L - PAD_R);
const yOf = (db) => PAD_T + ((DBMAX - Math.max(DBMIN, Math.min(DBMAX, db))) / (DBMAX - DBMIN)) * (H - PAD_T - PAD_B);
const mk = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  parent?.append(e);
  return e;
};
const fmtHz = (f) => (f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + " kHz" : Math.round(f) + " Hz");

export class FilterGraph {
  constructor(host) {
    this.svg = mk("svg", { viewBox: `0 0 ${W} ${H}`, class: "fgraph", role: "img" });
    host.append(this.svg);
    const g = mk("g", { class: "grid" }, this.svg);
    for (const f of [100, 1000, 10000]) {
      mk("line", { x1: xOf(f), x2: xOf(f), y1: PAD_T, y2: H - PAD_B }, g);
      mk("text", { x: xOf(f), y: H - PAD_B + 26, "text-anchor": "middle", class: "lbl" }, g).textContent = fmtHz(f).replace(" ", "");
    }
    for (const f of [50, 200, 300, 500, 2000, 3000, 5000]) mk("line", { x1: xOf(f), x2: xOf(f), y1: PAD_T, y2: H - PAD_B, class: "minor" }, g);
    for (const db of [12, 0, -12, -24, -36]) {
      mk("line", { x1: PAD_L, x2: W - PAD_R, y1: yOf(db), y2: yOf(db), class: db === 0 ? "zero" : "" }, g);
      mk("text", { x: PAD_L - 5, y: yOf(db) + 4, "text-anchor": "end", class: "lbl" }, g).textContent = (db > 0 ? "+" : "") + db;
    }
    // every cutoff position Cynthcart can set (CUT 0-127 = value 0-254 in steps of 2)
    const ticks = mk("g", { class: "steps" }, this.svg);
    for (let v = 0; v <= 254; v += 2) {
      const x = xOf(cutoffHz(FxSim.written(v, 127))); // (written as cutoff + 1)
      mk("line", { x1: x, x2: x, y1: H - PAD_B + 3, y2: H - PAD_B + 9, class: v === 128 ? "jump" : "" }, ticks);
    }
    this.band = mk("rect", { class: "band", y: PAD_T, height: H - PAD_T - PAD_B }, this.svg);
    this.dry = mk("line", { class: "dry", x1: PAD_L, x2: W - PAD_R, y1: yOf(0), y2: yOf(0) }, this.svg);
    this.fill = mk("path", { class: "fill" }, this.svg);
    this.curve = mk("path", { class: "curve" }, this.svg);
    this.marker = mk("line", { class: "marker", y1: PAD_T, y2: H - PAD_B + 9 }, this.svg);
    this.readout = mk("text", { class: "readout", x: W - PAD_R - 4, y: PAD_T + 14, "text-anchor": "end" }, this.svg);
    this.note = mk("text", { class: "note", x: PAD_L + 6, y: PAD_T + 14 }, this.svg);
    this.sim = new FxSim();
    this.state = null;
    this.raf = 0;
    this.reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /** s: { cut, res, fType, routed: [bool x3], fx, resCap } */
  set(s) {
    const fxChanged = !this.state || this.state.fx !== s.fx;
    this.state = s;
    if (fxChanged) this.sim.reset();
    this.draw(FxSim.written(s.cut, 127));
    const animate = s.fx >= 1 && s.fx <= 5 && !this.reduced && s.routed.some(Boolean) && s.fType;
    if (animate && !this.raf) this.start();
    if (!animate) this.stop();
  }

  notes(count, retrigger) { this.sim.noteChange(count, retrigger); }

  start() {
    let last = performance.now(), acc = 0;
    const tick = (t) => {
      acc += Math.min(250, t - last) * PASSES_PER_SEC / 1000; last = t;
      while (acc >= 1) { this.sim.step(this.state.fx); acc--; }
      this.draw(FxSim.written(this.state.cut, this.sim.mod));
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }
  stop() { cancelAnimationFrame(this.raf); this.raf = 0; }

  draw(written) {
    const s = this.state;
    const res = Math.min(s.res, s.resCap ?? 15);
    const f0 = cutoffHz(written), q = qFor(res);
    const any = s.routed.some(Boolean);
    const all = s.routed.every(Boolean);
    let d = "", pts = [];
    for (let i = 0; i <= 160; i++) {
      const f = FMIN * Math.pow(FMAX / FMIN, i / 160);
      pts.push([xOf(f), yOf(responseDb(f, f0, q, s.fType))]);
    }
    d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
    this.curve.setAttribute("d", d);
    this.fill.setAttribute("d", d + `L${W - PAD_R} ${H - PAD_B}L${PAD_L} ${H - PAD_B}Z`);
    this.svg.classList.toggle("unused", !any || !s.fType);
    this.dry.style.display = all ? "none" : "";
    const x = xOf(f0);
    this.marker.setAttribute("x1", x); this.marker.setAttribute("x2", x);
    const r = fxRangeHz(s.fx, s.cut);
    if (r && any) {
      const a = xOf(r[0]), b = xOf(r[1]);
      this.band.setAttribute("x", a); this.band.setAttribute("width", Math.max(2, b - a));
      this.band.style.display = "";
    } else this.band.style.display = "none";
    this.readout.textContent = `≈ ${fmtHz(f0)} · Q ${q.toFixed(2)}`;
    const voices = s.routed.map((r, i) => (r ? null : i + 1)).filter(Boolean);
    this.note.textContent = !s.fType ? "No filter type: filtered voices are silent"
      : !any ? "No voices go through the filter"
      : voices.length ? `Voice${voices.length > 1 ? "s" : ""} ${voices.join(" & ")} unfiltered (flat line)` : "";
    this.svg.setAttribute("aria-label", `Filter response: ${this.readout.textContent}`);
  }
}
