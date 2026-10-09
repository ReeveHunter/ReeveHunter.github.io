// Input: Web MIDI, computer keyboard, on-screen piano. Plus a small Web Audio synth and metronome.

export class Input {
  constructor() {
    this.listeners = new Set();
    this.held = new Map();       // midi -> source
    this.access = null;
    this.devices = [];
    this.kbOctave = 4;
    this.onStatus = () => {};
    this.status = { midi: 'idle', devices: [] };
    this._kbDown = new Map();
    this._bindKeyboard();
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  emit(ev) {
    if (ev.type === 'on') this.held.set(ev.midi, ev.source);
    else this.held.delete(ev.midi);
    for (const fn of this.listeners) fn(ev);
  }

  isHeld(midi) { return this.held.has(midi); }

  async initMidi() {
    if (!navigator.requestMIDIAccess) {
      this.status = { midi: 'unsupported', devices: [] };
      this.onStatus(this.status);
      return;
    }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (e) {
      this.status = { midi: 'denied', devices: [] };
      this.onStatus(this.status);
      return;
    }
    const refresh = () => {
      const names = [];
      for (const inp of this.access.inputs.values()) {
        inp.onmidimessage = m => this._onMidi(m);
        if (inp.state !== 'disconnected') names.push(inp.name);
      }
      this.status = { midi: names.length ? 'connected' : 'none', devices: names };
      this.onStatus(this.status);
    };
    this.access.onstatechange = refresh;
    refresh();
  }

  _onMidi(m) {
    const [st, d1, d2] = m.data;
    const cmd = st & 0xf0;
    const ts = m.timeStamp || performance.now();
    if (cmd === 0x90 && d2 > 0) this.emit({ type: 'on', midi: d1, vel: d2, ts, source: 'midi' });
    else if (cmd === 0x80 || (cmd === 0x90 && d2 === 0)) this.emit({ type: 'off', midi: d1, ts, source: 'midi' });
  }

  _bindKeyboard() {
    // Two rows like a piano: white keys on A S D F G H J K L ; '  black keys on W E T Y U O P
    const map = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12, o: 13, l: 14, p: 15, ';': 16, "'": 17 };
    window.addEventListener('keydown', ev => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const tag = (ev.target && ev.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      const k = ev.key.toLowerCase();
      if (k === 'z' || k === 'x') {
        this.kbOctave = Math.max(1, Math.min(7, this.kbOctave + (k === 'z' ? -1 : 1)));
        this.onStatus({ ...this.status, kbOctave: this.kbOctave });
        ev.preventDefault();
        return;
      }
      if (!(k in map) || ev.repeat || this._kbDown.has(k)) return;
      const midi = 12 * (this.kbOctave + 1) + map[k];
      this._kbDown.set(k, midi);
      this.emit({ type: 'on', midi, vel: 90, ts: performance.now(), source: 'key' });
      ev.preventDefault();
    });
    window.addEventListener('keyup', ev => {
      const k = ev.key.toLowerCase();
      if (!this._kbDown.has(k)) return;
      const midi = this._kbDown.get(k);
      this._kbDown.delete(k);
      this.emit({ type: 'off', midi, ts: performance.now(), source: 'key' });
    });
    window.addEventListener('blur', () => {
      for (const [k, midi] of this._kbDown) this.emit({ type: 'off', midi, ts: performance.now(), source: 'key' });
      this._kbDown.clear();
    });
  }
}

// ---------------------------------------------------------------------------
export class Synth {
  constructor() { this.ctx = null; this.voices = new Map(); this.master = null; }
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      const comp = this.ctx.createDynamicsCompressor();
      this.master.connect(comp); comp.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  noteOn(midi, vel = 90) {
    const ctx = this.ensure(); if (!ctx) return;
    this.noteOff(midi);
    const f = 440 * Math.pow(2, (midi - 69) / 12);
    const t = ctx.currentTime;
    const g = ctx.createGain();
    const amp = 0.25 + 0.6 * (vel / 127);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(amp, t + 0.008);
    g.gain.exponentialRampToValueAtTime(amp * 0.3, t + 0.5);
    g.gain.exponentialRampToValueAtTime(0.0008, t + 3.5);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(Math.min(12000, f * 8), t);
    lp.frequency.exponentialRampToValueAtTime(Math.min(8000, f * 3), t + 0.6);
    const o1 = ctx.createOscillator(); o1.type = 'triangle'; o1.frequency.value = f;
    const o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = f * 2;
    const g2 = ctx.createGain(); g2.gain.value = 0.25;
    o1.connect(lp); o2.connect(g2); g2.connect(lp); lp.connect(g); g.connect(this.master);
    o1.start(t); o2.start(t); o1.stop(t + 3.6); o2.stop(t + 3.6);
    this.voices.set(midi, { g, o1, o2 });
  }
  noteOff(midi) {
    const v = this.voices.get(midi);
    if (!v || !this.ctx) return;
    const t = this.ctx.currentTime;
    v.g.gain.cancelScheduledValues(t);
    v.g.gain.setValueAtTime(Math.max(0.0008, v.g.gain.value), t);
    v.g.gain.exponentialRampToValueAtTime(0.0008, t + 0.25);
    try { v.o1.stop(t + 0.3); v.o2.stop(t + 0.3); } catch { /* already stopped */ }
    this.voices.delete(midi);
  }
  /** Schedule a click at a performance.now() timestamp. */
  click(atPerfMs, accent = false) {
    const ctx = this.ensure(); if (!ctx) return;
    const when = ctx.currentTime + Math.max(0, (atPerfMs - performance.now()) / 1000);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(accent ? 0.3 : 0.18, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0005, when + 0.05);
    o.connect(g); g.connect(this.master);
    o.start(when); o.stop(when + 0.06);
  }
}

// ---------------------------------------------------------------------------
const BLACK = new Set([1, 3, 6, 8, 10]);

export class Piano {
  constructor(container, input) {
    this.el = container;
    this.input = input;
    this.keys = new Map();
    this.build();
  }
  build() {
    this.el.innerHTML = '';
    const lo = 21, hi = 108;
    const whites = [];
    for (let m = lo; m <= hi; m++) if (!BLACK.has(m % 12)) whites.push(m);
    const ww = 100 / whites.length;
    let wi = 0;
    for (let m = lo; m <= hi; m++) {
      const k = document.createElement('div');
      const black = BLACK.has(m % 12);
      k.className = 'key ' + (black ? 'black' : 'white');
      if (black) {
        k.style.left = `calc(${wi * ww}% - ${ww * 0.32}%)`;
        k.style.width = `${ww * 0.64}%`;
      } else {
        k.style.left = `${wi * ww}%`;
        k.style.width = `${ww}%`;
        wi++;
        if (m % 12 === 0) {
          const lab = document.createElement('span');
          lab.textContent = 'C' + (m / 12 - 1);
          if (m === 60) lab.className = 'mid';
          k.appendChild(lab);
        }
      }
      k.dataset.midi = m;
      this.el.appendChild(k);
      this.keys.set(m, k);
    }
    let down = null;
    const press = m => { down = m; this.input.emit({ type: 'on', midi: m, vel: 90, ts: performance.now(), source: 'mouse' }); };
    const release = () => { if (down != null) this.input.emit({ type: 'off', midi: down, ts: performance.now(), source: 'mouse' }); down = null; };
    this.el.addEventListener('pointerdown', e => {
      const k = e.target.closest('.key'); if (!k) return;
      e.preventDefault();
      press(Number(k.dataset.midi));
    });
    window.addEventListener('pointerup', release);
    this.el.addEventListener('pointerleave', release);
  }
  setDown(midi, on) { this.keys.get(midi)?.classList.toggle('down', on); }
  flash(midi, cls, ms = 450) {
    const k = this.keys.get(midi); if (!k) return;
    k.classList.add(cls);
    setTimeout(() => k.classList.remove(cls), ms);
  }
  mark(midis, cls) {
    for (const k of this.el.querySelectorAll('.' + cls)) k.classList.remove(cls);
    for (const m of midis) this.keys.get(m)?.classList.add(cls);
  }
}
