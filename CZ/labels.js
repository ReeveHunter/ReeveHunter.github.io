// labels.js
// Human-readable names for the CZ-101's enumerated parameters, used to
// populate dropdowns instead of showing raw numbers.
//
// CONFIDENCE NOTE: the source SysEx doc (see sysex.js) only gives numeric
// codes for these, not names. The waveform names below come from the
// Casio manual's own waveform diagram (Fig. 8), so those are the official
// names/ordering. The vibrato waveform names are still reconstructed from
// general CZ-101 documentation/community sources, not the official Casio
// manual, so treat that ordering as a best guess - if your ear says a
// label is swapped with another, trust your ear and we'll fix the mapping.

export const WAVEFORM_NAMES = {
  1: "Saw-tooth",
  2: "Square",
  3: "Pulse",
  4: "Double Sine",
  5: "Saw-Pulse",
  6: "Resonance I",
  7: "Resonance II",
  8: "Resonance III",
};

export const VIBRATO_WAVE_NAMES = {
  1: "Triangle",
  2: "Sawtooth up",
  3: "Square",
  4: "Sawtooth down",
};

export const MODULATION_NAMES = {
  none: "None",
  ring: "Ring",
  noise: "Noise",
};

export const LINE_SELECT_NAMES = {
  1: "1",
  2: "2",
  3: "1 + 1′",
  4: "1 + 2′",
};

// An array of [value, label] pairs, not a plain object: JS always
// enumerates a plain object's integer-index-looking keys (0, 1, ...) in
// ascending numeric order *before* any other string key, regardless of
// insertion order - so { [-1]: ..., 0: ..., 1: ... } actually iterates as
// 0, 1, -1, not -1, 0, 1. An array keeps our intended order.
export const OCTAVE_NAMES = [
  [-1, "−1"],
  [0, "0"],
  [1, "+1"],
];

export const DETUNE_SIGN_NAMES = {
  "+": "Up",
  "-": "Down",
};
