// Curriculum: tracks, unlock order, adaptive confidence, and exercise generators.
import { parseNote, keyAcc, keyById, letterOf, tonicLetter, midiOf, noteName, STAFF_BOTTOM, STAFF_TOP, INTERVAL_NAMES, keyLabel } from './music.js';

// ---------------------------------------------------------------------------
// Items & confidence
// ---------------------------------------------------------------------------
export const SPEEDS = { relaxed: 2200, standard: 1400, fluent: 900 };
const CFG = {
  n: { alpha: 0.25, minN: 5, tMul: 1 },
  im: { alpha: 0.18, minN: 8, tMul: 1 },
  ih: { alpha: 0.2, minN: 6, tMul: 1.3 },
  k: { alpha: 0.06, minN: 40, tMul: 1 },
  c: { alpha: 0.2, minN: 6, tMul: 1.6 },
};
const cfgOf = id => CFG[id.split(':')[0]] || CFG.n;
export const GREEN = 0.8;

export function record(profile, id, ms, correct) {
  const c = cfgOf(id);
  let s = profile.items[id];
  if (!s) s = profile.items[id] = { n: 0, t: null, a: 0.75, last: 0 };
  s.a += Math.max(c.alpha, 1 / (s.n + 2)) * ((correct ? 1 : 0) - s.a);
  if (ms != null && correct) s.t = s.t == null ? ms : s.t + Math.max(c.alpha, 0.2) * (ms - s.t);
  s.n++;
  s.last = Date.now();
}

export function conf(profile, id) {
  const s = profile.items[id];
  if (!s || !s.n) return 0;
  const target = SPEEDS[profile.settings.speed] * cfgOf(id).tMul;
  const speed = s.t == null ? 0.5 : Math.min(1, target / s.t);
  return speed * s.a;
}
export function calibrated(profile, id) {
  const s = profile.items[id];
  return !!s && s.n >= Math.min(3, cfgOf(id).minN);
}
export function isGreen(profile, id) {
  const s = profile.items[id];
  return !!s && s.n >= cfgOf(id).minN && conf(profile, id) >= GREEN;
}

function readyToUnlock(profile, ids) {
  if (!ids.length) return true;
  const newest = ids[ids.length - 1];
  if (!isGreen(profile, newest)) return false;
  const greens = ids.filter(id => isGreen(profile, id)).length;
  const minConf = Math.min(...ids.map(id => conf(profile, id)));
  return greens / ids.length >= 0.85 && minConf >= 0.55;
}

/** Focus = the newest item until it is solid, otherwise the weakest. */
export function focusOf(profile, ids) {
  if (!ids.length) return null;
  const newest = ids[ids.length - 1];
  if (!isGreen(profile, newest)) return newest;
  let best = ids[0], bc = Infinity;
  for (const id of ids) { const c = conf(profile, id); if (c < bc) { bc = c; best = id; } }
  return best;
}

// ---------------------------------------------------------------------------
// Unlock orders
// ---------------------------------------------------------------------------
const NOTE_SPEC = [
  ['T', 'C4'], ['T', 'G4'], ['B', 'F3'],                       // the three classic landmarks
  ['T', 'C5'], ['B', 'C3'], ['B', 'C4'],                       // more landmarks
  ['T', 'A4'], ['T', 'F4'], ['B', 'A3'], ['B', 'G3'],
  ['T', 'E4'], ['B', 'E3'], ['T', 'B4'], ['B', 'D3'],
  ['T', 'D4'], ['B', 'B3'], ['T', 'D5'], ['B', 'B2'],
  ['T', 'E5'], ['B', 'A2'], ['T', 'F5'], ['B', 'G2'],          // ← both staves complete (22)
  ['T', 'G5'], ['B', 'F2'], ['T', 'A5'], ['B', 'E2'],          // first ledger lines
  ['T', 'B3'], ['B', 'D4'], ['T', 'A3'], ['B', 'E4'],          // around middle C
  ['T', 'B5'], ['B', 'D2'], ['T', 'C6'], ['B', 'C2'],          // second ledger lines
  ['T', 'D6'], ['B', 'B1'], ['T', 'E6'], ['B', 'A1'],          // third ledger lines
  ['T', 'G3'], ['B', 'F4'],
];
export const NOTES = NOTE_SPEC.map(([clef, name]) => {
  const { d } = parseNote(name);
  return { id: `n:${clef}:${d}`, clef, d, name };
});
const NOTE_BY_ID = Object.fromEntries(NOTES.map(n => [n.id, n]));
export const noteId = (clef, d) => `n:${clef}:${d}`;
export const STAVES_COMPLETE = 22;

export const LANDMARK_TEXT = {
  'n:T:28': 'Middle C sits on its own ledger line just below the treble staff. It is the C nearest the middle of the keyboard.',
  'n:T:32': 'Treble G. The treble clef is a fancy G: its curl wraps around the second line. That line is G above middle C.',
  'n:B:24': 'Bass F. The bass clef is an F: its two dots sit on either side of the fourth line. That line is F below middle C.',
  'n:T:35': 'Treble C: the third space, an octave above middle C. Count down a step to B on the middle line, or up to D.',
  'n:B:21': 'Bass C: the second space, an octave below middle C.',
  'n:B:28': 'Middle C again, now seen from the bass staff: one ledger line above it. Same key on the piano as treble middle C.',
};

export const INTERVALS = ['im:2', 'im:3', 'im:4', 'im:5', 'ih:3', 'ih:5', 'ih:4', 'im:6', 'ih:6', 'ih:2', 'im:8', 'ih:8', 'im:7', 'ih:7'];
export const INTERVAL_TEXT = {
  2: 'A 2nd is a step: line to the next space, or space to the next line. Next-door keys.',
  3: 'A 3rd is a skip: line to the next line, or space to the next space. Skip one white key.',
  4: 'A 4th goes line to space (or space to line), with two notes in between.',
  5: 'A 5th goes line to line skipping one line, or space to space skipping one space. Your thumb and pinky in a five-finger position.',
  6: 'A 6th goes line to space, a bit wider than a 5th. Picture a 5th and add a step.',
  7: 'A 7th goes line to line with two lines in between. One step short of an octave.',
  8: 'An octave goes line to space (or space to line) and lands on the same letter. Same key, next one over.',
};

export const KEY_ITEMS = ['k:C', 'k:G', 'k:F', 'k:D', 'k:Bb', 'k:A', 'k:acc', 'k:Eb', 'k:E', 'k:Ab', 'k:B', 'k:Db', 'k:F#', 'k:Gb'];

export const CHORDS = ['c:root:T', 'c:root:B', 'c:inv1:T', 'c:inv1:B', 'c:inv2:T', 'c:inv2:B', 'c:7:T', 'c:7:B'];
export const CHORD_TEXT = {
  root: 'Root position: three notes stacked in 3rds, all on lines or all in spaces. It looks like a snowman.',
  inv1: 'First inversion: a 3rd on the bottom and a 4th on top. The gap sits at the top of the chord.',
  inv2: 'Second inversion: a 4th on the bottom and a 3rd on top. The gap sits at the bottom.',
  7: 'Seventh chord: four notes stacked in 3rds, all lines or all spaces. A taller snowman.',
};

export const MELODY_LEVELS = [
  { id: 'm1', name: 'Quarter notes, right hand', hands: 'R', rhythm: 'q', text: 'Steady quarter notes, one per beat. The playhead won\'t wait: keep going even if you miss.' },
  { id: 'm2', name: 'Half and whole notes', hands: 'R', rhythm: 'qh', text: 'Hollow notes last longer: half notes get two beats, whole notes four. Use the extra time to read ahead.' },
  { id: 'm3', name: 'Left hand', hands: 'L', rhythm: 'qh', text: 'Same rhythms, now in the bass clef for your left hand.' },
  { id: 'm4', name: 'Eighth notes', hands: 'RL', rhythm: 'qhe', text: 'Beamed pairs are eighth notes: two per beat.' },
  { id: 'm5', name: 'Hands together', hands: 'T', rhythm: 'qh', text: 'The left hand holds chord roots while the right hand plays the melody. Read the two staves as one picture.' },
  { id: 'm6', name: 'Hands together, more rhythm', hands: 'T', rhythm: 'qhed', text: 'Dotted rhythms and eighths with both hands. A dot adds half the note\'s value.' },
];

// ---------------------------------------------------------------------------
// Tracks
// ---------------------------------------------------------------------------
export function unlockedIds(profile, track) {
  const t = profile.tracks[track];
  switch (track) {
    case 'notes': return NOTES.slice(0, t.unlocked).map(n => n.id);
    case 'intervals': return INTERVALS.slice(0, t.unlocked);
    case 'keys': return KEY_ITEMS.slice(0, t.unlocked);
    case 'chords': return CHORDS.slice(0, t.unlocked);
    default: return [];
  }
}
const ORDER = { notes: NOTES.map(n => n.id), intervals: INTERVALS, keys: KEY_ITEMS, chords: CHORDS };

export const TRACKS = [
  {
    id: 'notes', name: 'Notes', blurb: 'Learn each note on the grand staff by sight, starting from landmark notes.',
    available: () => true, lockText: '',
  },
  {
    id: 'intervals', name: 'Intervals', blurb: 'Read steps, skips and leaps from their shape, without naming every note.',
    available: p => p.tracks.notes.unlocked >= 10, lockText: 'Unlocks after 10 notes',
  },
  {
    id: 'melodies', name: 'Melodies', blurb: 'Real sight-reading: rhythm, a moving playhead, no stopping.',
    available: p => p.tracks.notes.unlocked >= 14, lockText: 'Unlocks after 14 notes', flowOnly: true,
  },
  {
    id: 'keys', name: 'Key signatures', blurb: 'Carry the key signature in your head: sharps and flats around the circle of fifths.',
    available: p => p.tracks.notes.unlocked >= STAVES_COMPLETE, lockText: 'Unlocks once you know every note on both staves',
  },
  {
    id: 'chords', name: 'Chords', blurb: 'Recognize triads and inversions as one shape.',
    available: p => p.tracks.intervals.unlocked >= 6, lockText: 'Unlocks with harmonic 5ths in Intervals',
  },
];
export const trackById = id => TRACKS.find(t => t.id === id);

export function trackProgress(profile, track) {
  if (track === 'melodies') return { done: profile.tracks.melodies.level, total: MELODY_LEVELS.length };
  return { done: profile.tracks[track].unlocked, total: ORDER[track].length };
}

/** Check for an unlock after practice. Returns the newly unlocked item id, or null. */
export function maybeUnlock(profile, track) {
  if (track === 'melodies') return null;
  const t = profile.tracks[track];
  if (t.unlocked >= ORDER[track].length) return null;
  if (!readyToUnlock(profile, unlockedIds(profile, track))) return null;
  t.unlocked++;
  return ORDER[track][t.unlocked - 1];
}

/** Keys practiced in other tracks once the keys track has started. */
export function realKeys(profile) {
  return unlockedIds(profile, 'keys').filter(k => k !== 'k:acc').map(k => k.slice(2));
}
export function chromaticUnlocked(profile) {
  return unlockedIds(profile, 'keys').includes('k:acc');
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------
export function itemLabel(id) {
  const [p, a, b] = id.split(':');
  if (p === 'n') { const n = NOTE_BY_ID[id]; return { text: n.name, sub: a === 'T' ? 'treble' : 'bass' }; }
  if (p === 'im') return { text: INTERVAL_NAMES[a], sub: 'melodic' };
  if (p === 'ih') return { text: INTERVAL_NAMES[a], sub: 'harmonic' };
  if (p === 'k') return a === 'acc' ? { text: 'Accidentals', sub: 'chromatic' } : { text: a.replace('b', '♭').replace('#', '♯'), sub: 'major' };
  if (p === 'c') return { text: { root: 'Root', inv1: '1st inv', inv2: '2nd inv', 7: '7th' }[a], sub: b === 'T' ? 'treble' : 'bass' };
  return { text: id, sub: '' };
}

// ---------------------------------------------------------------------------
// Random helpers
// ---------------------------------------------------------------------------
function pick(arr, weights) {
  let tot = 0;
  for (const w of weights) tot += w;
  let r = Math.random() * tot;
  for (let i = 0; i < arr.length; i++) { r -= weights[i]; if (r <= 0) return arr[i]; }
  return arr[arr.length - 1];
}
const rand = arr => arr[Math.floor(Math.random() * arr.length)];
function weakW(profile, id) { return 1 + 2.5 * (1 - conf(profile, id)); }

function mkNote(d, clef, sig, dur = 1) {
  const acc = keyAcc(letterOf(d), sig);
  return { d, clef, acc, print: null, dur };
}

function simpleLine(events, opts = {}) {
  // events: [{ notes, items, annot }] → line with one slice per beat (or per `step` beats)
  const step = opts.step || 1;
  return {
    key: opts.key || 'C',
    timeSig: null,
    beatsPerBar: opts.beatsPerBar || 4,
    slices: events.map((e, i) => ({ beat: i * step, dur: step, notes: e.notes.map(n => ({ ...n, dur: step })), items: e.items, annot: e.annot ?? null })),
    totalBeats: events.length * step,
  };
}

function proximityW(a, b) {
  if (a.clef !== b.clef) return 0.45;
  const dist = Math.abs(a.d - b.d);
  return [0.05, 3, 3, 2, 1.6, 1.2, 1, 0.8, 0.8][dist] ?? 0.5;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------
export function genNotes(profile, len = 12) {
  const ids = unlockedIds(profile, 'notes');
  const pool = ids.map(id => NOTE_BY_ID[id]);
  const focus = focusOf(profile, ids);
  const w = n => weakW(profile, n.id) * (n.id === focus ? 3 : 1);
  const seq = [];
  let prev = null;
  for (let i = 0; i < len; i++) {
    const cands = pool.filter(n => !prev || n.id !== prev.id);
    const n = pick(cands, cands.map(c => w(c) * (prev ? proximityW(c, prev) : 1)));
    seq.push(n); prev = n;
  }
  // make sure the focus note shows up a few times
  const fNote = NOTE_BY_ID[focus];
  let count = seq.filter(n => n.id === focus).length;
  for (let tries = 0; count < Math.min(3, len / 3) && tries < 40; tries++) {
    const i = Math.floor(Math.random() * len);
    if (seq[i].id === focus) continue;
    if ((i > 0 && seq[i - 1].id === focus) || (i + 1 < len && seq[i + 1].id === focus)) continue;
    seq[i] = fNote; count++;
  }
  return simpleLine(seq.map(n => ({ notes: [mkNote(n.d, n.clef, 0)], items: [n.id] })));
}

function clefRange(profile, clef, pad = 0) {
  const ds = unlockedIds(profile, 'notes').map(id => NOTE_BY_ID[id]).filter(n => n.clef === clef).map(n => n.d);
  if (!ds.length) return null;
  return [Math.min(...ds) - pad, Math.max(...ds) + pad];
}
function creditNote(profile, clef, d) {
  const id = noteId(clef, d);
  return unlockedIds(profile, 'notes').includes(id) ? [id] : [];
}

export function genIntervals(profile) {
  const ids = unlockedIds(profile, 'intervals');
  const focus = focusOf(profile, ids);
  const mel = ids.filter(i => i.startsWith('im'));
  const har = ids.filter(i => i.startsWith('ih'));
  let harmonic = focus.startsWith('ih');
  if (har.length && mel.length && Math.random() < 0.3) harmonic = !harmonic;
  const set = harmonic ? har : mel;
  const w = id => weakW(profile, id) * (id === focus ? 3 : 1);
  const tR = clefRange(profile, 'T'), bR = clefRange(profile, 'B');
  const clefFor = () => (bR && bR[1] - bR[0] >= 5 && Math.random() < 0.4) ? 'B' : 'T';

  if (!harmonic) {
    let clef = clefFor();
    let range = clef === 'T' ? tR : bR;
    if (range[1] - range[0] < 8) range = [range[0], range[0] + 8];
    let d = range[0] + Math.floor(Math.random() * (range[1] - range[0] + 1));
    const ev = [{ notes: [mkNote(d, clef, 0)], items: creditNote(profile, clef, d) }];
    for (let i = 1; i < 12; i++) {
      let item = null, nd = null;
      for (let tries = 0; tries < 20 && nd == null; tries++) {
        item = pick(set, set.map(w));
        const size = Number(item.split(':')[1]) - 1;
        const dirs = Math.random() < 0.5 ? [1, -1] : [-1, 1];
        for (const dir of dirs) { const c = d + dir * size; if (c >= range[0] && c <= range[1]) { nd = c; break; } }
      }
      if (nd == null) { item = set[0]; nd = d + (d + 1 <= range[1] ? 1 : -1); }
      d = nd;
      ev.push({ notes: [mkNote(d, clef, 0)], items: [item, ...creditNote(profile, clef, d)], annot: item.split(':')[1] });
    }
    return simpleLine(ev);
  }
  const ev = [];
  for (let i = 0; i < 8; i++) {
    const item = pick(set, set.map(w));
    const size = Number(item.split(':')[1]) - 1;
    const clef = clefFor();
    let range = clef === 'T' ? tR : bR;
    if (range[1] - range[0] < size + 2) range = [range[0], range[0] + size + 2];
    const lo = range[0] + Math.floor(Math.random() * (range[1] - size - range[0] + 1));
    ev.push({ notes: [mkNote(lo, clef, 0), mkNote(lo + size, clef, 0)], items: [item], annot: item.split(':')[1] });
  }
  return simpleLine(ev, { step: 2 });
}

/** Apply printed accidentals per measure, given actual accidentals on notes. */
function applyAccidentals(line, sig) {
  const bpb = line.beatsPerBar || 4;
  let bar = -1, state = {}, prevAltered = {};
  for (const s of line.slices) {
    const b = Math.floor(s.beat / bpb + 1e-6);
    if (b !== bar) { prevAltered = { ...state }; state = {}; bar = b; }
    for (const n of s.notes) {
      const k = n.clef + n.d;
      const sigAcc = keyAcc(letterOf(n.d), sig);
      const current = k in state ? state[k] : sigAcc;
      if (n.acc !== current) { n.print = n.acc; state[k] = n.acc; }
      else if (!(k in state) && k in prevAltered && prevAltered[k] !== sigAcc && n.acc === sigAcc) {
        n.print = n.acc; state[k] = n.acc; // courtesy accidental
      }
    }
  }
}

export function genKeys(profile) {
  const ids = unlockedIds(profile, 'keys');
  const focus = focusOf(profile, ids);
  const item = Math.random() < 0.55 ? focus : pick(ids, ids.map(id => weakW(profile, id)));
  const keys = realKeys(profile);
  const keyId = item === 'k:acc' ? rand(keys) : item.slice(2);
  const sig = keyById(keyId).sig;
  const chromatic = item === 'k:acc' || (chromaticUnlocked(profile) && Math.random() < 0.25);

  const pool = unlockedIds(profile, 'notes').map(id => NOTE_BY_ID[id])
    .filter(n => n.d >= STAFF_BOTTOM[n.clef] - 2 && n.d <= STAFF_TOP[n.clef] + 2);
  const tl = tonicLetter(keyId);
  const w = n => (keyAcc(letterOf(n.d), sig) !== 0 ? 2.5 : 1) * weakW(profile, n.id);
  // start on a tonic
  const tonics = pool.filter(n => letterOf(n.d) === tl && n.clef === 'T');
  let prev = tonics.length ? rand(tonics) : rand(pool);
  const seq = [prev];
  for (let i = 1; i < 12; i++) {
    const cands = pool.filter(n => n.id !== prev.id);
    prev = pick(cands, cands.map(c => w(c) * proximityW(c, prev)));
    seq.push(prev);
  }
  const ev = seq.map((n, i) => {
    const note = mkNote(n.d, n.clef, sig);
    if (chromatic && i > 0 && i < 11 && Math.random() < 0.2) {
      const opts = [note.acc - 1, note.acc + 1].filter(a => a >= -1 && a <= 1);
      note.acc = rand(opts);
    }
    return { notes: [note], items: [item, n.id] };
  });
  const line = simpleLine(ev, { key: keyId });
  applyAccidentals(line, sig);
  return line;
}

export function genChords(profile) {
  const ids = unlockedIds(profile, 'chords');
  const focus = focusOf(profile, ids);
  const keys = profile.tracks.notes.unlocked >= STAVES_COMPLETE ? realKeys(profile) : ['C'];
  const keyId = Math.random() < 0.5 ? keys[keys.length - 1] : rand(keys);
  const sig = keyById(keyId).sig;
  const tl = tonicLetter(keyId);
  const ev = [];
  let prevDeg = 0;
  for (let i = 0; i < 8; i++) {
    const item = pick(ids, ids.map(id => weakW(profile, id) * (id === focus ? 3 : 1)));
    const [, type, clef] = item.split(':');
    const degs = type === '7' ? [2, 5, 1, 4, 6] : [1, 2, 3, 4, 5, 6];
    let deg = rand(degs);
    if (deg === prevDeg) deg = rand(degs);
    prevDeg = deg;
    const shapes = { root: [0, 2, 4], inv1: [2, 4, 7], inv2: [4, 7, 9], 7: [0, 2, 4, 6] };
    const rel = shapes[type];
    const [lo, hi] = clef === 'T' ? [28, 33] : [16, 20];
    let r = tl + deg - 1;            // a root position index in octave 0
    let bottom = r + rel[0];
    while (bottom < lo) { r += 7; bottom += 7; }
    while (bottom > hi) { r -= 7; bottom -= 7; }
    ev.push({ notes: rel.map(x => mkNote(r + x, clef, sig)), items: [item] });
  }
  return simpleLine(ev, { key: keyId, step: 2 });
}

// ---- Melodies (flow) -------------------------------------------------------
const RHYTHMS = {
  q: [[1, 1, 1, 1]],
  h: [[2, 1, 1], [1, 1, 2], [2, 2], [1, 2, 1], [4]],
  e: [[0.5, 0.5, 1, 1, 1], [1, 0.5, 0.5, 1, 1], [1, 1, 0.5, 0.5, 1], [0.5, 0.5, 0.5, 0.5, 1, 1], [1, 1, 1, 0.5, 0.5]],
  d: [[1.5, 0.5, 1, 1], [3, 1], [1, 1.5, 0.5, 1], [1.5, 0.5, 2]],
};
const ENDINGS = { q: [[1, 1, 2], [2, 2]], h: [[4], [2, 2], [1, 1, 2]] };

function rhythmBar(set, last) {
  if (last) return rand(set.includes('h') ? ENDINGS.h : [[1, 1, 1, 1]]);
  const pools = [];
  for (const c of set) pools.push(...RHYTHMS[c].map(r => ({ r, c })));
  const ws = pools.map(p => (p.c === 'q' ? 2 : 1));
  return pick(pools, ws).r;
}

const PROGRESSIONS = [[1, 4, 5, 1], [1, 6, 4, 5], [1, 5, 4, 1], [1, 2, 5, 1], [1, 4, 1, 5], [6, 4, 5, 1]];

function melodyVoice(range, keyId, sig, rhythmSet, prog, bars = 4) {
  const tl = tonicLetter(keyId);
  const isTonic = d => letterOf(d) === tl;
  const chordTones = deg => { const r = (tl + deg - 1) % 7; return [r, (r + 2) % 7, (r + 4) % 7]; };
  const mid = Math.round((range[0] + range[1]) / 2);
  const starts = [];
  for (let d = range[0]; d <= range[1]; d++) if ([tl, (tl + 2) % 7, (tl + 4) % 7].includes(letterOf(d))) starts.push(d);
  let d = starts.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid))[Math.floor(Math.random() * Math.min(3, starts.length))] ?? mid;
  const notes = [];
  let beat = 0;
  for (let bar = 0; bar < bars; bar++) {
    const last = bar === bars - 1;
    const rh = rhythmBar(rhythmSet, last);
    rh.forEach((dur, j) => {
      const finalNote = last && j === rh.length - 1;
      if (notes.length) {
        if (finalNote) {
          const cands = [];
          for (let x = range[0]; x <= range[1]; x++) if (isTonic(x)) cands.push(x);
          d = cands.sort((a, b) => Math.abs(a - d) - Math.abs(b - d))[0] ?? d;
        } else {
          const moves = [-1, 1, -2, 2, -3, 3, -4, 4, 0];
          const strong = Math.abs(beat % 2) < 1e-6;
          const ct = prog ? chordTones(prog[bar]) : null;
          const ws = moves.map(m => {
            const nd = d + m;
            if (nd < range[0] || nd > range[1]) return 0;
            let w = { 0: 0.25, 1: 5, 2: 2.6, 3: 1.2, 4: 0.6 }[Math.abs(m)];
            if (ct && strong && ct.includes(letterOf(nd))) w *= 2.5;
            return w;
          });
          d += pick(moves, ws);
        }
      }
      notes.push({ beat, dur, d });
      beat += dur;
    });
  }
  return notes;
}

export function genMelody(profile) {
  const t = profile.tracks.melodies;
  const level = MELODY_LEVELS[Math.min(t.level, MELODY_LEVELS.length - 1)];
  const keys = profile.tracks.notes.unlocked >= STAVES_COMPLETE ? realKeys(profile) : ['C'];
  const keyId = Math.random() < 0.4 ? keys[keys.length - 1] : rand(keys);
  const sig = keyById(keyId).sig;
  let hands = level.hands;
  if (hands === 'RL') { t.hand = (t.hand + 1) % 2; hands = t.hand ? 'L' : 'R'; }

  const tR = clefRange(profile, 'T') || [28, 35];
  const bR = clefRange(profile, 'B') || [21, 28];
  const rhRange = [Math.max(28, tR[0]), Math.min(39, tR[1])];
  const lhRange = [Math.max(16, bR[0]), Math.min(27, bR[1])];
  const prog = hands === 'T' ? rand(PROGRESSIONS) : null;

  const voices = [];
  if (hands === 'R' || hands === 'T') voices.push({ clef: 'T', notes: melodyVoice(rhRange, keyId, sig, level.rhythm, prog) });
  if (hands === 'L') voices.push({ clef: 'B', notes: melodyVoice(lhRange, keyId, sig, level.rhythm, null) });
  if (hands === 'T') {
    const tl = tonicLetter(keyId);
    const notes = [];
    prog.forEach((deg, bar) => {
      let r = tl + deg - 1;
      while (r < lhRange[0]) r += 7;
      while (r > lhRange[0] + 6) r -= 7;
      if (level.rhythm.includes('e')) {
        const fifth = r + 4 <= lhRange[1] + 2 ? r + 4 : r - 3;
        notes.push({ beat: bar * 4, dur: 2, d: r }, { beat: bar * 4 + 2, dur: 2, d: fifth });
      } else notes.push({ beat: bar * 4, dur: 4, d: r });
    });
    voices.push({ clef: 'B', notes });
  }
  const byBeat = new Map();
  for (const v of voices) for (const n of v.notes) {
    const k = n.beat;
    if (!byBeat.has(k)) byBeat.set(k, []);
    byBeat.get(k).push({ ...mkNote(n.d, v.clef, sig, n.dur) });
  }
  const unlocked = new Set(unlockedIds(profile, 'notes'));
  const slices = [...byBeat.keys()].sort((a, b) => a - b).map(beat => {
    const notes = byBeat.get(beat);
    return {
      beat, dur: Math.min(...notes.map(n => n.dur)), notes,
      items: notes.map(n => noteId(n.clef, n.d)).filter(id => unlocked.has(id)),
    };
  });
  return { key: keyId, timeSig: [4, 4], beatsPerBar: 4, slices, totalBeats: 16, level: level.id };
}

export function generate(profile, track) {
  switch (track) {
    case 'notes': return genNotes(profile);
    case 'intervals': return genIntervals(profile);
    case 'keys': return genKeys(profile);
    case 'chords': return genChords(profile);
    case 'melodies': return genMelody(profile);
    case 'placement': return null;
  }
}

/** Placement test: blocks of six notes in unlock order. */
export function placementBlock(i) {
  const block = NOTES.slice(i * 6, i * 6 + 6);
  if (!block.length) return null;
  const shuffled = [...block].sort(() => Math.random() - 0.5);
  // avoid an immediate repeat isn't an issue: every note is unique within a block
  return simpleLine(shuffled.map(n => ({ notes: [mkNote(n.d, n.clef, 0)], items: [n.id] })));
}
export const PLACEMENT_BLOCKS = Math.ceil(NOTES.length / 6);

/** Intro content for a newly unlocked item. */
export function introFor(id) {
  const [p, a, b] = id.split(':');
  if (p === 'n') {
    const n = NOTE_BY_ID[id];
    return { kind: 'note', id, note: n };
  }
  if (p === 'im' || p === 'ih') return { kind: 'interval', id, size: Number(a), harmonic: p === 'ih', text: INTERVAL_TEXT[a] };
  if (p === 'k') return { kind: 'key', id, key: a };
  if (p === 'c') return { kind: 'chord', id, type: a, clef: b, text: CHORD_TEXT[a] };
  return null;
}

export function exampleLine(intro) {
  if (intro.kind === 'note') {
    const n = intro.note;
    return simpleLine([{ notes: [mkNote(n.d, n.clef, 0)], items: [] }]);
  }
  if (intro.kind === 'interval') {
    const s = intro.size - 1;
    const evs = intro.harmonic
      ? [{ notes: [mkNote(31, 'T', 0), mkNote(31 + s, 'T', 0)] }, { notes: [mkNote(32, 'T', 0), mkNote(32 + s, 'T', 0)] }]
      : [{ notes: [mkNote(30, 'T', 0)] }, { notes: [mkNote(30 + s, 'T', 0)] }, { notes: [mkNote(33, 'T', 0)] }, { notes: [mkNote(33 + s, 'T', 0)] }];
    return simpleLine(evs.map(e => ({ ...e, items: [] })));
  }
  if (intro.kind === 'key') {
    if (intro.key === 'acc') {
      const ev = [[32, 0], [31, 1], [32, 0], [34, -1], [33, 0], [31, 0], [30, 0], [28, 0]].map(([d, acc]) => ({ notes: [{ d, clef: 'T', acc, print: null }], items: [] }));
      const l = simpleLine(ev); applyAccidentals(l, 0); return l;
    }
    const sig = keyById(intro.key).sig;
    const tl = tonicLetter(intro.key);
    let start = tl + 28; if (start > 32) start -= 7;
    return simpleLine([0, 1, 2, 3, 4, 5, 6, 7].map(i => ({ notes: [mkNote(start + i, 'T', sig)], items: [] })), { key: intro.key });
  }
  if (intro.kind === 'chord') {
    const shapes = { root: [0, 2, 4], inv1: [2, 4, 7], inv2: [4, 7, 9], 7: [0, 2, 4, 6] };
    const base = intro.clef === 'T' ? 28 : 14;
    return simpleLine([0, 3, 4, 0].map(deg => ({ notes: shapes[intro.type].map(x => mkNote(base + deg + x, intro.clef, 0)), items: [] })), { step: 2 });
  }
  return null;
}

export function describeNote(n) {
  return `${noteName(n.d, 0)} · ${n.clef === 'T' ? 'treble' : 'bass'} clef`;
}
export { keyLabel, midiOf };
