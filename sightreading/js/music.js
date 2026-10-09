// Music theory helpers.
// A staff position is a diatonic index d = octave*7 + letter (C=0 … B=6),
// so middle C (C4) is d = 28. Pitch = position + accidental.

export const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const STEP_SEMIS = [0, 2, 4, 5, 7, 9, 11];

export const letterOf = d => ((d % 7) + 7) % 7;
export const octaveOf = d => Math.floor(d / 7);

export function midiOf(d, acc = 0) {
  return 12 * (octaveOf(d) + 1) + STEP_SEMIS[letterOf(d)] + acc;
}

/** Parse "G4", "Bb3", "F#5" → { d, acc } */
export function parseNote(s) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(s);
  if (!m) throw new Error('bad note ' + s);
  const L = LETTERS.indexOf(m[1]);
  return { d: Number(m[3]) * 7 + L, acc: m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0 };
}

const ACC_TXT = { '-2': '𝄫', '-1': '♭', '0': '', '1': '♯', '2': '𝄪' };
export function noteName(d, acc = 0, withOctave = true) {
  return LETTERS[letterOf(d)] + ACC_TXT[acc] + (withOctave ? octaveOf(d) : '');
}

// Staff geometry: bottom line of each staff as a diatonic index.
export const STAFF_BOTTOM = { T: 30, B: 18 }; // E4, G2
export const STAFF_TOP = { T: 38, B: 26 };    // F5, A3

/** Where a position sits on its staff, in words, e.g. "2nd line" or "space above". */
export function positionWords(d, clef) {
  const s = d - STAFF_BOTTOM[clef];
  const ord = ['1st', '2nd', '3rd', '4th', '5th'];
  if (s >= 0 && s <= 8) {
    return s % 2 === 0 ? `${ord[s / 2]} line` : `${ord[(s - 1) / 2]} space`;
  }
  if (s === -1) return 'space below the staff';
  if (s === 9) return 'space above the staff';
  if (s < 0) {
    const k = Math.floor((-s) / 2);
    return (-s) % 2 === 0 ? `${ord[k - 1]} ledger line below` : `below ${ord[k - 1]} ledger line`;
  }
  const over = s - 8;
  const k = Math.floor(over / 2);
  return over % 2 === 0 ? `${ord[k - 1]} ledger line above` : `above ${ord[k - 1]} ledger line`;
}

// ---- Keys -----------------------------------------------------------------
const SHARP_ORDER = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
const FLAT_ORDER = [6, 2, 5, 1, 4, 0, 3];  // B E A D G C F

export const KEYS = [
  { id: 'C', sig: 0 }, { id: 'G', sig: 1 }, { id: 'F', sig: -1 },
  { id: 'D', sig: 2 }, { id: 'Bb', sig: -2 }, { id: 'A', sig: 3 },
  { id: 'Eb', sig: -3 }, { id: 'E', sig: 4 }, { id: 'Ab', sig: -4 },
  { id: 'B', sig: 5 }, { id: 'Db', sig: -5 }, { id: 'F#', sig: 6 }, { id: 'Gb', sig: -6 },
];
export const keyById = id => KEYS.find(k => k.id === id);
export const keyLabel = id => id.replace('b', '♭').replace('#', '♯') + ' major';

/** Accidental the key signature applies to a letter. */
export function keyAcc(letter, sig) {
  if (sig > 0 && SHARP_ORDER.indexOf(letter) < sig) return 1;
  if (sig < 0 && FLAT_ORDER.indexOf(letter) < -sig) return -1;
  return 0;
}
export function tonicLetter(keyId) { return LETTERS.indexOf(keyId[0]); }

/** Staff positions for drawing a key signature on a given clef. */
export function keySigPositions(sig, clef) {
  const sharpsT = [38, 35, 39, 36, 33, 37, 34]; // F5 C5 G5 D5 A4 E5 B4
  const flatsT = [34, 37, 33, 36, 32, 35, 31];  // B4 E5 A4 D5 G4 C5 F4
  const shift = clef === 'B' ? -14 : 0;
  if (sig > 0) return sharpsT.slice(0, sig).map(d => ({ d: d + shift, acc: 1 }));
  if (sig < 0) return flatsT.slice(0, -sig).map(d => ({ d: d + shift, acc: -1 }));
  return [];
}

export const INTERVAL_NAMES = { 1: 'unison', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th', 6: '6th', 7: '7th', 8: 'octave' };
