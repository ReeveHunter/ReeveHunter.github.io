// Practice runners: WaitSession (waits for each note, measures reaction time)
// and FlowSession (playhead moves at tempo and never stops).
import { renderLine } from './staff.js';
import { midiOf } from './music.js';
import { record } from './curriculum.js';

/** Renders the current line plus a dimmed preview of the next one. */
export class Stage {
  constructor(container) {
    this.el = container;
    this.cur = null;
    this.next = null;
  }
  show(curLine, nextLine, opts = {}) {
    this.el.innerHTML = '';
    const a = document.createElement('div'); a.className = 'line-cur';
    const b = document.createElement('div'); b.className = 'line-next';
    this.el.append(a, b);
    this.cur = renderLine(a, curLine, opts);
    this.next = nextLine ? renderLine(b, nextLine, { ...opts, preview: true }) : null;
    if (!nextLine) b.classList.add('empty');
  }
  clear() { this.el.innerHTML = ''; this.cur = this.next = null; }
}

const targetsOf = slice => slice.notes.map(n => midiOf(n.d, n.acc));
const pc = m => ((m % 12) + 12) % 12;

// ---------------------------------------------------------------------------
export class WaitSession {
  /**
   * opts: { stage, input, piano, profile, genLine, onLineDone(stats)→{regen?,stop?}, onProgress(state),
   *         hintAfter (mistakes before hint, 0 = never), showNames }
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.running = false;
    this.paused = false;
    this.unsub = null;
  }
  start() {
    this.running = true;
    this.curLine = this.genLine();
    this.nextLine = this.genLine();
    this.unsub = this.input.on(ev => this.handle(ev));
    this.beginLine();
  }
  stop() {
    this.running = false;
    if (this.unsub) this.unsub();
    this.unsub = null;
    this.piano?.mark([], 'hint');
  }
  render() {
    this.stage.show(this.curLine, this.nextLine, { showNames: this.showNames });
  }
  beginLine() {
    if (!this.curLine) { this.stop(); return; }
    this.render();
    this.i = 0;
    this.lineStats = { n: 0, ok: 0, ms: 0, timed: 0, misses: [] };
    this.focusSlice();
  }
  focusSlice() {
    this.mistakes = 0;
    this.hits = new Map();
    this.tPrev = performance.now();
    this.stage.cur.setState(this.i, 'current');
    this.stage.cur.moveCursor(this.i);
    this.piano?.mark([], 'hint');
    this.onProgress?.(this.progress());
  }
  progress() {
    return { i: this.i, total: this.curLine.slices.length, line: this.lineStats };
  }
  handle(ev) {
    if (!this.running || this.paused || ev.type !== 'on') return;
    const slice = this.curLine.slices[this.i];
    if (!slice) return;
    const targets = targetsOf(slice);
    const matchT = targets.find(t => this.ignoreOctave ? pc(t) === pc(ev.midi) : t === ev.midi);
    if (matchT != null) {
      this.hits.set(matchT, ev.ts);
      const done = targets.every(t => {
        const h = this.hits.get(t);
        if (h == null) return false;
        const held = this.ignoreOctave ? [...this.input.held.keys()].some(m => pc(m) === pc(t)) : this.input.isHeld(t);
        return held || ev.ts - h < 450;
      });
      if (done) this.complete(ev.ts);
      return;
    }
    // wrong note
    this.mistakes++;
    this.piano?.flash(ev.midi, 'wrong');
    this.stage.cur.addClass(this.i, 'err');
    setTimeout(() => this.stage.cur?.removeClass(this.i, 'err'), 350);
    this.onWrong?.(ev.midi, slice);
    if (this.hintAfter && this.mistakes >= this.hintAfter) {
      this.stage.cur.addClass(this.i, 'hinted');
      this.piano?.mark(targets, 'hint');
    }
  }
  complete(ts) {
    const slice = this.curLine.slices[this.i];
    const ms = ts - this.tPrev;
    const timed = this.i > 0 && ms < 8000;
    const correct = this.mistakes === 0;
    for (const id of slice.items || []) record(this.profile, id, timed ? Math.min(ms, 5000) : null, correct);
    const st = this.lineStats;
    st.n++; if (correct) st.ok++; else st.misses.push(slice.items?.[0]);
    if (timed) { st.ms += Math.min(ms, 5000); st.timed++; }
    this.stage.cur.setState(this.i, correct ? 'ok' : 'bad');
    this.stage.cur.addClass(this.i, 'played');
    this.onNoteDone?.(slice, correct, timed ? ms : null);
    this.i++;
    if (this.i >= this.curLine.slices.length) {
      this.stage.cur.moveCursor(null);
      this.piano?.mark([], 'hint');
      const res = this.onLineDone?.(st) || {};
      if (res.stop || !this.running) return;
      this.curLine = res.regen ? this.genLine() : this.nextLine;
      this.nextLine = this.genLine();
      if (res.delay) {
        this.paused = true;
        setTimeout(() => { this.paused = false; if (this.running) this.beginLine(); }, res.delay);
      } else if (!res.hold) this.beginLine();
      return;
    }
    this.focusSlice();
  }
  resume() { if (this.running) { this.paused = false; this.beginLine(); } }
}

// ---------------------------------------------------------------------------
export class FlowSession {
  /**
   * opts: { stage, input, piano, synth, profile, genLine, bpm, lineCount, metronome, lookAhead,
   *         ignoreOctave, showNames, onDone(stats), onProgress(state) }
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.running = false;
  }
  start() {
    this.lines = [];
    for (let i = 0; i < this.lineCount; i++) this.lines.push(this.genLine());
    this.beatMs = 60000 / this.bpm;
    this.win = Math.min(210, this.beatMs * 0.42);
    const countIn = this.lines[0].beatsPerBar || 4;
    this.t0 = performance.now() + 400 + countIn * this.beatMs;
    // absolute beat offsets per line
    let off = 0;
    this.offsets = this.lines.map(l => { const o = off; off += l.totalBeats; return o; });
    this.totalBeats = off;
    this.events = [];
    this.lines.forEach((l, li) => l.slices.forEach((s, si) => {
      this.events.push({ li, si, t: this.t0 + (this.offsets[li] + s.beat) * this.beatMs, targets: targetsOf(s), hit: new Set(), state: 'pending', err: false, items: s.items || [] });
    }));
    this.stats = { n: this.events.length, ok: 0, wrong: 0, missed: 0 };
    this.lineIdx = -1;
    this.showLine(0);
    // count-in clicks
    for (let b = 0; b < countIn; b++) this.synth.click(this.t0 - (countIn - b) * this.beatMs, b === 0);
    this.nextClickBeat = 0;
    this.running = true;
    this.unsub = this.input.on(ev => this.handle(ev));
    this.raf = requestAnimationFrame(() => this.loop());
  }
  stop() {
    this.running = false;
    cancelAnimationFrame(this.raf);
    if (this.unsub) this.unsub();
  }
  showLine(li) {
    this.lineIdx = li;
    this.stage.show(this.lines[li], this.lines[li + 1] || null, { showNames: this.showNames });
    for (const e of this.events) if (e.li === li && e.state !== 'pending') this.stage.cur.setState(e.si, e.state);
  }
  beatNow(now) { return (now - this.t0) / this.beatMs; }
  loop() {
    if (!this.running) return;
    const now = performance.now();
    const beat = this.beatNow(now);
    // metronome
    while (this.metronome && this.nextClickBeat < this.totalBeats && this.t0 + this.nextClickBeat * this.beatMs < now + 120) {
      const bpb = this.lines[0].beatsPerBar || 4;
      if (this.t0 + this.nextClickBeat * this.beatMs >= now - 10) this.synth.click(this.t0 + this.nextClickBeat * this.beatMs, this.nextClickBeat % bpb === 0);
      this.nextClickBeat++;
    }
    // line swaps
    let li = this.lineIdx;
    while (li + 1 < this.lines.length && beat >= this.offsets[li + 1]) li++;
    if (li !== this.lineIdx) this.showLine(li);
    const lineBeat = beat - this.offsets[li];
    const h = this.stage.cur;
    h.showPlayhead(h.xAtBeat(lineBeat));
    // look-ahead fade
    if (this.lookAhead > 0) {
      this.lines[li].slices.forEach((s, si) => {
        const dt = s.beat - lineBeat;
        const ev = this.events.find(e => e.li === li && e.si === si);
        const hide = ev.state === 'pending' && dt > 0.05 && dt <= this.lookAhead;
        if (hide) h.addClass(si, 'gone'); else h.removeClass(si, 'gone');
      });
    }
    // misses
    for (const e of this.events) {
      if (e.state === 'pending' && now > e.t + this.win) {
        e.state = 'missed';
        this.stats.missed++;
        for (const id of e.items) record(this.profile, id, null, false);
        if (e.li === this.lineIdx) this.stage.cur.setState(e.si, 'missed');
      }
    }
    this.onProgress?.({ beat, stats: this.stats, countIn: beat < 0 ? Math.ceil(-beat) : 0 });
    if (beat >= this.totalBeats + 0.25) { this.finish(); return; }
    this.raf = requestAnimationFrame(() => this.loop());
  }
  handle(ev) {
    if (!this.running || ev.type !== 'on') return;
    const m = ev.midi;
    const match = t => this.ignoreOctave ? pc(t) === pc(m) : t === m;
    let best = null, bd = Infinity;
    for (const e of this.events) {
      if (e.state !== 'pending') continue;
      const dt = Math.abs(ev.ts - e.t);
      if (dt > this.win) continue;
      const t = e.targets.find(x => match(x) && !e.hit.has(x));
      if (t == null) continue;
      if (dt < bd) { bd = dt; best = { e, t }; }
    }
    if (best) {
      const { e, t } = best;
      e.hit.add(t);
      if (e.hit.size === e.targets.length) {
        e.state = e.err ? 'bad' : 'ok';
        if (!e.err) this.stats.ok++;
        for (const id of e.items) record(this.profile, id, null, !e.err);
        if (e.li === this.lineIdx) this.stage.cur.setState(e.si, e.state);
      }
      return;
    }
    // wrong / stray note: penalize the nearest pending event
    this.stats.wrong++;
    this.piano?.flash(m, 'wrong');
    let near = null, nd = Infinity;
    for (const e of this.events) {
      if (e.state !== 'pending') continue;
      const dt = Math.abs(ev.ts - e.t);
      if (dt < this.win * 1.6 && dt < nd) { nd = dt; near = e; }
    }
    if (near) {
      near.err = true;
      if (near.li === this.lineIdx) this.stage.cur.addClass(near.si, 'err');
    }
  }
  finish() {
    this.stop();
    this.stage.cur?.hidePlayhead();
    this.onDone?.({ ...this.stats, bpm: this.bpm, acc: this.stats.n ? this.stats.ok / this.stats.n : 0 });
  }
}
