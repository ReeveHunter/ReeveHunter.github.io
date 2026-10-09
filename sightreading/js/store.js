// Persistence with multiple user profiles. Everything lives in this browser's localStorage;
// reads/writes are wrapped so the app still runs (in memory) when storage is unavailable.

const INDEX_KEY = 'sightreading.profiles';
const PROFILE_KEY = id => 'sightreading.profile.' + id;
const mem = {};

function lsGet(k) {
  try { const v = localStorage.getItem(k); return v == null ? (mem[k] ?? null) : v; } catch { return mem[k] ?? null; }
}
function lsSet(k, v) {
  mem[k] = v;
  try { localStorage.setItem(k, v); } catch { /* memory only */ }
}
function lsDel(k) {
  delete mem[k];
  try { localStorage.removeItem(k); } catch { /* ignore */ }
}

export const DEFAULT_SETTINGS = {
  speed: 'standard',      // relaxed | standard | fluent
  ignoreOctave: false,
  soundKeys: true,        // sound for computer keyboard / on-screen keys
  soundMidi: false,       // sound for MIDI input (most pianos make their own)
  showKeyboard: true,
  hints: true,            // reveal the answer after two mistakes
  showNames: false,       // training wheels: note names under every note
  metronome: true,
  lookAhead: 0,           // flow mode: hide notes this many beats before the playhead (0 = off)
  linesPerPiece: 4,
};

export function freshProfile(name) {
  return {
    v: 1,
    name,
    created: Date.now(),
    settings: { ...DEFAULT_SETTINGS },
    items: {},                 // id -> { n, t, a, last }
    tracks: {
      notes: { unlocked: 3 },
      intervals: { unlocked: 2 },
      keys: { unlocked: 1 },
      chords: { unlocked: 1 },
      melodies: { level: 0, recent: [], hand: 0 },
    },
    tempo: {},                 // track -> bpm for flow mode
    lastPlayed: {},            // track -> timestamp
    seen: {},                  // intro screens already shown
    history: [],               // { ts, track, mode, n, ok, ms, timed, bpm }
    placement: null,
  };
}

function uid() { return Math.random().toString(36).slice(2, 10); }

export const store = {
  index: null,     // { list:[{id,name}], current }
  profile: null,
  _saveTimer: null,

  init() {
    let idx = null;
    try { idx = JSON.parse(lsGet(INDEX_KEY) || 'null'); } catch { idx = null; }
    if (!idx || !Array.isArray(idx.list) || !idx.list.length) {
      const id = uid();
      idx = { list: [{ id, name: 'Player 1' }], current: id };
      lsSet(PROFILE_KEY(id), JSON.stringify(freshProfile('Player 1')));
      lsSet(INDEX_KEY, JSON.stringify(idx));
    }
    if (!idx.list.some(p => p.id === idx.current)) idx.current = idx.list[0].id;
    this.index = idx;
    this.load(idx.current);
  },

  load(id) {
    let p = null;
    try { p = JSON.parse(lsGet(PROFILE_KEY(id)) || 'null'); } catch { p = null; }
    const entry = this.index.list.find(e => e.id === id);
    if (!p) p = freshProfile(entry ? entry.name : 'Player');
    // fill in anything added in later versions
    const base = freshProfile(p.name);
    p.settings = { ...base.settings, ...(p.settings || {}) };
    p.tracks = { ...base.tracks, ...(p.tracks || {}) };
    for (const k of Object.keys(base)) if (p[k] === undefined) p[k] = base[k];
    this.profile = p;
    this.index.current = id;
    lsSet(INDEX_KEY, JSON.stringify(this.index));
  },

  save() {
    clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.saveNow(), 300);
  },
  saveNow() {
    clearTimeout(this._saveTimer);
    if (this.profile.history.length > 3000) this.profile.history = this.profile.history.slice(-3000);
    lsSet(PROFILE_KEY(this.index.current), JSON.stringify(this.profile));
  },

  get currentId() { return this.index.current; },
  get profiles() { return this.index.list; },

  addProfile(name) {
    this.saveNow();
    const id = uid();
    this.index.list.push({ id, name });
    lsSet(PROFILE_KEY(id), JSON.stringify(freshProfile(name)));
    this.load(id);
    return id;
  },
  switchTo(id) {
    if (id === this.index.current) return;
    this.saveNow();
    this.load(id);
  },
  renameCurrent(name) {
    const e = this.index.list.find(x => x.id === this.index.current);
    if (e) e.name = name;
    this.profile.name = name;
    lsSet(INDEX_KEY, JSON.stringify(this.index));
    this.saveNow();
  },
  deleteCurrent() {
    const id = this.index.current;
    lsDel(PROFILE_KEY(id));
    this.index.list = this.index.list.filter(x => x.id !== id);
    if (!this.index.list.length) {
      const nid = uid();
      this.index.list.push({ id: nid, name: 'Player 1' });
      lsSet(PROFILE_KEY(nid), JSON.stringify(freshProfile('Player 1')));
    }
    this.load(this.index.list[0].id);
  },
  resetCurrent() {
    const name = this.profile.name;
    const settings = this.profile.settings;
    this.profile = freshProfile(name);
    this.profile.settings = settings;
    this.saveNow();
  },
  exportCurrent() {
    return JSON.stringify(this.profile, null, 1);
  },
  importAsNew(json) {
    const p = JSON.parse(json);
    if (!p || typeof p !== 'object' || !p.tracks || !p.items) throw new Error('Not a sight-reading progress file');
    this.saveNow();
    const id = uid();
    const name = (p.name || 'Imported') + '';
    this.index.list.push({ id, name });
    lsSet(PROFILE_KEY(id), JSON.stringify(p));
    this.load(id);
  },
};
