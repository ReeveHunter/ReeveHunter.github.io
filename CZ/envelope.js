// envelope.js
// A small canvas-based 8-stage envelope editor: drag a point up/down to set
// its level (0-99), drag it left/right to set its rate (0-99, i.e. how long
// it takes to get there from the previous point). Double-click (or
// double-tap, on touch) a point to mark it as the envelope's end step -
// handled as our own pointerup-based tap detector rather than the native
// "dblclick" event, since a touch-friendly canvas needs `touch-action: none`
// (see style.css) to keep single-finger drags from scrolling the page, and
// that same property stops browsers from synthesizing click/dblclick events
// out of touch input, so a real double-tap would otherwise go unnoticed.
// For DCW envelopes, press and hold a point (see LONG_PRESS_MS) to toggle a
// sustain flag on that stage.
//
// The x-axis is auto-scaled to the current envelope's own total rate, purely
// for legibility - it has no absolute time units (the CZ's own rate dial
// isn't calibrated in milliseconds either).

const PAD_L = 28;
const PAD_R = 16;
const PAD_T = 14;
const PAD_B = 26;
const POINT_R = 6;
const MIN_SEGMENT = 14; // px, purely visual so rate=0 stages stay clickable
const LONG_PRESS_MS = 500; // hold a point this long (without dragging) to toggle sustain
const LONG_PRESS_CANCEL_PX = 6; // moving more than this cancels the long-press and starts a normal drag
const TAP_MOVE_PX = 6; // a pointer up/down pair counts as a "tap" (not a drag) if it moved no more than this
const DOUBLE_TAP_MS = 400; // two taps on the same point within this long count as a double-tap
const HOLD_GAP_PX = 62; // reserved width for a sustain stage's dashed "held here" segment - inserted into the layout (not stolen from the following stage's own spacing)
// A stage's rate contributes at least this much to the width-split math,
// even at rate 0. Without a floor, each stage's segment width is its share
// of the sum of every stage's rate - so if seven stages are at 0 and one is
// nudged from 0 to 1, that one stage's "share" jumps from 0% to ~100% of
// the available width (it's the only nonzero term in the sum), which reads
// as a sudden snap instead of a small nudge. Below this floor, changing a
// rate has no visible effect on width; by the time it matters (rate 3+),
// it's a smooth, ordinary continuation of the same line.
const RATE_WEIGHT_FLOOR = 2;

export class EnvelopeEditor {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} opts
   * @param {Array<{rate:number, level:number, sustain?:boolean}>} opts.stages
   * @param {number} opts.endStep
   * @param {boolean} [opts.hasSustain]
   * @param {(state:{stages:any[], endStep:number}) => void} opts.onChange
   */
  constructor(canvas, { stages, endStep, hasSustain = false, onChange }) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.stages = stages.map((s) => ({ rate: s.rate, level: s.level, sustain: !!s.sustain }));
    this.endStep = endStep;
    this.hasSustain = hasSustain;
    this.onChange = onChange;
    this.selected = 0;
    this.hover = -1;
    this._press = null;
    this._pressRaf = null;
    this._lastTap = null;
    this._dpr = window.devicePixelRatio || 1;
    this._resize();
    this._bind();
    this.draw();
  }

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = Math.max(1, Math.round(rect.width * this._dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * this._dpr));
    this.w = rect.width;
    this.h = rect.height;
  }

  setStages(stages, endStep) {
    this.stages = stages.map((s) => ({ rate: s.rate, level: s.level, sustain: !!s.sustain }));
    // defensive: only one sustain point is meaningful on real hardware: if
    // incoming data (e.g. an older saved patch) has more than one flagged,
    // keep just the first and drop the rest rather than showing several.
    let seen = false;
    for (const s of this.stages) {
      if (s.sustain) { if (seen) s.sustain = false; else seen = true; }
    }
    this.endStep = endStep;
    this.draw();
  }

  /** Call after the canvas becomes visible/sized again (e.g. un-hiding a
   * collapsed section) - getBoundingClientRect() reads 0 while hidden. */
  resize() {
    this._resize();
    this.draw();
  }

  _emit() {
    this.onChange?.({ stages: this.stages.map((s) => ({ ...s })), endStep: this.endStep });
    this.draw();
  }

  _layout() {
    const total = this.stages.reduce((sum, s) => sum + Math.max(s.rate, RATE_WEIGHT_FLOOR), 0);
    const innerW = this.w - PAD_L - PAD_R;
    // Reserve minimum segment width for every stage so zero-rate stages
    // remain visible/clickable, plus a fixed gap after any sustain stage
    // for its dashed "held here" segment - reserved space, not space
    // borrowed from the following stage, so that stage's own segment keeps
    // the same proportional width it would have without the hold.
    const sustainCount = this.hasSustain ? this.stages.filter((s) => s.sustain).length : 0;
    const reserved = MIN_SEGMENT * this.stages.length + HOLD_GAP_PX * sustainCount;
    const scale = Math.max(0, innerW - reserved) / total;
    const pts = [];
    let x = PAD_L;
    for (let i = 0; i < this.stages.length; i++) {
      x += MIN_SEGMENT + Math.max(this.stages[i].rate, RATE_WEIGHT_FLOOR) * scale;
      const y = PAD_T + (99 - this.stages[i].level) * ((this.h - PAD_T - PAD_B) / 99);
      pts.push({ x, y });
      if (this.hasSustain && this.stages[i].sustain) x += HOLD_GAP_PX;
    }
    return pts;
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this._onDown(e));
    c.addEventListener("pointermove", (e) => this._onMove(e));
    window.addEventListener("pointerup", (e) => this._onUp(e));
    c.tabIndex = 0;
    c.addEventListener("keydown", (e) => this._onKey(e));
    window.addEventListener("resize", () => { this._resize(); this.draw(); });
  }

  _mousePos(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  _hitTest(mx, my) {
    const pts = this._layout();
    let best = -1, bestD = 14;
    pts.forEach((p, i) => {
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d < bestD) { bestD = d; best = i; }
    });
    return best;
  }

  _onDown(e) {
    const { x, y } = this._mousePos(e);
    const hit = this._hitTest(x, y);
    if (hit >= 0) {
      this.selected = hit;
      this.canvas.focus();
      this.drag = { index: hit, startX: x, startY: y, rate: this.stages[hit].rate, level: this.stages[hit].level };
      this.canvas.setPointerCapture(e.pointerId);
      if (this.hasSustain) this._startLongPress(hit);
    }
  }

  _startLongPress(index) {
    this._press = { index, start: performance.now() };
    const tick = () => {
      if (!this._press || this._press.index !== index) return; // cancelled
      const elapsed = performance.now() - this._press.start;
      if (elapsed >= LONG_PRESS_MS) {
        this._toggleSustain(index);
        this._press = null;
        this.drag = null; // this press was a sustain toggle, not a rate/level edit
        this._emit();
        return;
      }
      this.draw();
      this._drawPressProgress(index, elapsed / LONG_PRESS_MS);
      this._pressRaf = requestAnimationFrame(tick);
    };
    this._pressRaf = requestAnimationFrame(tick);
  }

  _cancelLongPress() {
    this._press = null;
    if (this._pressRaf) cancelAnimationFrame(this._pressRaf);
    this._pressRaf = null;
  }

  /** The CZ only has one sustain point per envelope - turning sustain on
   * for a stage clears it from every other stage first. */
  _toggleSustain(index) {
    const turningOn = !this.stages[index].sustain;
    if (turningOn) this.stages.forEach((s) => (s.sustain = false));
    this.stages[index].sustain = turningOn;
  }

  _onMove(e) {
    const { x, y } = this._mousePos(e);
    this.hover = this._hitTest(x, y);
    if (this.drag) {
      const dx = x - this.drag.startX;
      const dy = y - this.drag.startY;
      if (this._press && Math.hypot(dx, dy) > LONG_PRESS_CANCEL_PX) this._cancelLongPress();
      const innerW = this.w - PAD_L - PAD_R;
      const rateRange = 99;
      const newRate = clamp(Math.round(this.drag.rate + (dx / innerW) * rateRange * 2.2), 0, 99);
      const innerH = this.h - PAD_T - PAD_B;
      const newLevel = clamp(Math.round(this.drag.level - (dy / innerH) * 99), 0, 99);
      this.stages[this.drag.index].rate = newRate;
      this.stages[this.drag.index].level = newLevel;
      this._emit();
    } else {
      this.draw();
    }
  }

  _onUp(e) {
    this._cancelLongPress();
    const drag = this.drag;
    this.drag = null;
    // A tap/click that barely moved is a candidate for the double-tap/
    // double-click end-step gesture below - a long press that already fired
    // (see _startLongPress) has nulled `drag` itself by this point, so it
    // never reaches here as a tap.
    if (drag && e) {
      const { x, y } = this._mousePos(e);
      if (Math.hypot(x - drag.startX, y - drag.startY) <= TAP_MOVE_PX) this._onTap(drag.index, e);
    }
    this.draw();
  }

  /** Our own double-tap/double-click detector, built on the same
   * pointerdown/pointerup this editor already tracks for dragging, rather
   * than the browser's native "dblclick" event - see the file-header
   * comment for why dblclick can't be relied on here. */
  _onTap(index, e) {
    const now = performance.now();
    const last = this._lastTap;
    this._lastTap = { index, time: now };
    if (!last || last.index !== index || now - last.time > DOUBLE_TAP_MS) return;
    this._lastTap = null; // consume it, so a third quick tap doesn't chain into another double
    // Shift+double-click is an undocumented alternate way to toggle sustain
    // (mouse/keyboard only - shiftKey is never true from a touch tap),
    // kept around for anyone who finds it faster than the press-and-hold
    // gesture (which is the one shown in the UI hint).
    if (this.hasSustain && e.shiftKey) {
      this._toggleSustain(index);
    } else {
      this.endStep = index;
    }
    this._emit();
  }

  _onKey(e) {
    const i = this.selected;
    if (i == null) return;
    const s = this.stages[i];
    let handled = true;
    if (e.key === "ArrowUp") s.level = clamp(s.level + 1, 0, 99);
    else if (e.key === "ArrowDown") s.level = clamp(s.level - 1, 0, 99);
    else if (e.key === "ArrowRight") s.rate = clamp(s.rate + 1, 0, 99);
    else if (e.key === "ArrowLeft") s.rate = clamp(s.rate - 1, 0, 99);
    else if (e.key === "e" || e.key === "E") this.endStep = i;
    else if ((e.key === "s" || e.key === "S") && this.hasSustain) this._toggleSustain(i);
    else handled = false;
    if (handled) { e.preventDefault(); this._emit(); }
  }

  draw() {
    const ctx = this.ctx;
    const dpr = this._dpr;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, this.w, this.h);

    // background grid
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const y = PAD_T + (g * (this.h - PAD_T - PAD_B)) / 4;
      ctx.beginPath();
      ctx.moveTo(PAD_L, y);
      ctx.lineTo(this.w - PAD_R, y);
      ctx.stroke();
    }

    const pts = this._layout();
    const zeroY = PAD_T + (this.h - PAD_T - PAD_B);

    // active envelope line: origin -> stages up through endStep, drawn in
    // pieces so a sustain stage's hold can be spliced in as a dashed
    // segment instead of a normal solid connector - see below.
    ctx.strokeStyle = "#e0a94e";
    ctx.lineWidth = 2;
    let segStart = { x: PAD_L, y: zeroY };
    const holdSegments = [];
    for (let i = 0; i <= this.endStep && i < pts.length; i++) {
      const p = pts[i];
      ctx.beginPath();
      ctx.moveTo(segStart.x, segStart.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      segStart = p;

      if (this.hasSustain && this.stages[i].sustain && i < this.endStep) {
        // Hold at this stage's level for a little while (dashed, since the
        // real hold length depends on how long the key stays down - not
        // real time on this axis), then the solid line resumes from the
        // end of the dash toward the next programmed point, mirroring the
        // CZ manual's own envelope diagram (sustain point -> Key OFF ->
        // on to the next stage in Fig. 1). _layout() already reserved this
        // gap as real width, so the segment into the next point keeps the
        // same proportional length it would have without the hold.
        const holdEndX = p.x + HOLD_GAP_PX;
        holdSegments.push({ from: p, to: { x: holdEndX, y: p.y } });
        segStart = { x: holdEndX, y: p.y };
      }
    }

    // dimmed tail past endStep (not reached during playback, but still
    // real data that gets sent - handy to see while editing)
    if (this.endStep < pts.length - 1) {
      ctx.beginPath();
      ctx.moveTo(pts[this.endStep].x, pts[this.endStep].y);
      for (let i = this.endStep + 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.strokeStyle = "rgba(224,169,78,0.35)";
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // sustain hold segment(s): a dashed horizontal hold in the same yellow
    // as the rest of the envelope line, plus vertical guide lines down to
    // the axis at both the sustain point and the key-off point, and a
    // "key off" label toward the bottom - mirroring the CZ manual's own
    // envelope diagram (sustain point -> dashed hold -> Key OFF, labeled
    // on the time axis, -> on to the next stage).
    holdSegments.forEach(({ from, to }) => {
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = "#e0a94e";
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(from.x, zeroY);
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(to.x, zeroY);
      ctx.strokeStyle = "rgba(224,169,78,0.5)";
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = "rgba(224,169,78,0.9)";
      ctx.font = "9px Montserrat, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("key off", to.x, this.h - 6);
    });

    // points
    pts.forEach((p, i) => {
      const active = i <= this.endStep;
      ctx.beginPath();
      ctx.arc(p.x, p.y, POINT_R, 0, Math.PI * 2);
      ctx.fillStyle = i === this.selected ? "#ffffff" : active ? "#e0a94e" : "rgba(224,169,78,0.35)";
      ctx.fill();
      if (i === this.hover || i === this.selected) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (this.hasSustain && this.stages[i].sustain) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, POINT_R + 4, 0, Math.PI * 2);
        ctx.strokeStyle = "#6fc2ff";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
      if (i === this.endStep) {
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.font = "9px Montserrat, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("end", p.x, this.h - 6);
      }
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      ctx.font = "9px Montserrat, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(i + 1), p.x, PAD_T - 4);
    });

    // readout for selected point
    const sel = this.stages[this.selected];
    if (sel) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.font = "11px Montserrat, sans-serif";
      ctx.textAlign = "left";
      const sustainTxt = this.hasSustain ? `  sustain:${sel.sustain ? "on" : "off"}` : "";
      ctx.fillText(`step ${this.selected + 1}  rate:${sel.rate}  level:${sel.level}${sustainTxt}`, PAD_L, this.h - 4);
    }

    ctx.restore();
  }

  /** Draws a small progress ring around a point while it's being long-pressed. */
  _drawPressProgress(index, frac) {
    const pts = this._layout();
    const p = pts[index];
    if (!p) return;
    const ctx = this.ctx;
    const dpr = this._dpr;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.beginPath();
    ctx.arc(p.x, p.y, POINT_R + 5, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2);
    ctx.strokeStyle = "#6fc2ff";
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.restore();
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Draw a small, static (non-interactive) preview of an envelope's shape -
 * used in the collapsed/compact view so there's still something visual to
 * glance at before clicking "Edit" for full control.
 */
export function drawEnvelopeThumbnail(canvas, stages, endStep) {
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return; // hidden (display:none) - drawing now would collapse the backing store to 1x1
  const dpr = window.devicePixelRatio || 1;
  const w = rect.width;
  const h = rect.height;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const ctx = canvas.getContext("2d");
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const pad = 3;
  const HOLD_GAP = 20; // reserved gap for a sustain stage's dashed hold, scaled down for the thumbnail - same idea as the full editor's HOLD_GAP_PX
  const active = stages.slice(0, endStep + 1);
  const sustainCount = active.filter((s) => s.sustain).length;
  const total = Math.max(1, active.reduce((s, st) => s + Math.max(st.rate, RATE_WEIGHT_FLOOR), 0));
  const innerW = w - pad * 2;
  const innerH = h - pad * 2;
  const scale = Math.max(0, innerW - HOLD_GAP * sustainCount) / total;

  ctx.strokeStyle = "#e0a94e";
  ctx.lineWidth = 1.5;

  let segStart = { x: pad, y: pad + innerH };
  const holdSegments = [];
  for (let i = 0; i <= endStep && i < stages.length; i++) {
    const x = segStart.x + Math.max(stages[i].rate, RATE_WEIGHT_FLOOR) * scale;
    const y = pad + (99 - stages[i].level) * (innerH / 99);
    ctx.beginPath();
    ctx.moveTo(segStart.x, segStart.y);
    ctx.lineTo(x, y);
    ctx.stroke();
    segStart = { x, y };

    if (stages[i].sustain && i < endStep) {
      const holdEnd = { x: x + HOLD_GAP, y };
      holdSegments.push({ from: { x, y }, to: holdEnd });
      segStart = holdEnd;
    }
  }

  // small dashed nub at any sustain stage - a compact hint that this level
  // holds until key-off (see the full editor for the labeled version).
  holdSegments.forEach(({ from, to }) => {
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.setLineDash([2, 2]);
    ctx.stroke();
    ctx.setLineDash([]);
  });

  ctx.restore();
}
