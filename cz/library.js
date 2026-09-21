// library.js
// A starter set of ready-to-use CZ-101 patches for the Patch Library panel
// (see buildLibrarySection() in app.js), plus the shape helpers used to
// build them.
//
// Two sources feed FACTORY_PATCHES below: a hand-built set (this file),
// designed directly in this editor's own data model to cover a spread of
// classic CZ-101 territory - that distinctive phase-distortion brightness -
// tagged by mood/category so the library panel's tag filter has something
// descriptive to filter on; and a real hardware-sourced set, decoded from
// actual Casio CZ-230S factory SysEx dumps now that sysex.js can decode as
// well as encode (see cz230s-presets.js and patches/README.md for
// provenance). The real set is tagged only "factory"/"cz-230s" rather than
// guessed moods, since nobody's actually listened to them yet.

import { CZ230S_PRESETS } from "./cz230s-presets.js";

function st(rate, level, sustain = false) {
  return { rate, level, sustain };
}

/** Attack -> decay -> a slow-rate "hold" stage (the CZ wire format this
 * editor speaks only carries a true sustain point for DCW - see
 * encodeDcwEnvelope in sysex.js - so DCA/DCO approximate a held note with a
 * slow rate instead, same convention as hardwareInitAmpOrWaveEnvelope in
 * patch.js and the "adsr" preset in curves.js) -> release to silence. */
function sustainedEnv({ attackRate, peak, decayRate, sustainLevel, releaseRate, dcwSustain = false }) {
  const stages = [
    st(attackRate, peak),
    st(decayRate, sustainLevel),
    st(10, sustainLevel, dcwSustain),
    st(releaseRate, 0),
  ];
  const endStep = stages.length - 1;
  while (stages.length < 8) stages.push({ ...stages[stages.length - 1] });
  return { endStep, stages };
}

/** Attack, then a handful of [rate, level] pairs that run all the way down
 * to 0 on their own - a one-shot shape (bell, pluck) that finishes its
 * decay whether or not the key is still held, rather than parking at a
 * sustain level. */
function oneShotEnv({ attackRate, peak, steps }) {
  const stages = [st(attackRate, peak), ...steps.map(([rate, level]) => st(rate, level))];
  const endStep = stages.length - 1;
  while (stages.length < 8) stages.push({ ...stages[stages.length - 1] });
  return { endStep, stages };
}

function ampOrWave(env, keyFollow = 0) {
  return { keyFollow, ...env };
}

/** Pads a hand-written run of stages out to the required 8, repeating the
 * last one - for the handful of envelopes below shaped directly as a stage
 * list instead of through sustainedEnv()/oneShotEnv(). */
function raw(endStep, stages) {
  const out = stages.map((s) => ({ ...s }));
  while (out.length < 8) out.push({ ...out[out.length - 1] });
  return { endStep, stages: out };
}

// A function, not a shared constant object - each call returns its own
// fresh stages array, so two patches that both want "flat, no pitch
// movement" never end up pointing at the very same array in memory.
function flatPitch() {
  return { endStep: 7, stages: Array.from({ length: 8 }, () => st(0, 50)) };
}

function vib(wave = 1, delay = 0, rate = 0, depth = 0) {
  return { wave, delay, rate, depth };
}
function detune(sign = "+", fine = 0, octave = 0, note = 0) {
  return { sign, fine, octave, note };
}

function patch(name, {
  octave = 0, line = 1, detune: dt = detune(), vibrato = vib(),
  osc1, osc2, dca1, dcw1, dco1 = flatPitch(), dca2, dcw2, dco2 = flatPitch(),
}) {
  return { name, octave, line, detune: dt, vibrato, osc1, osc2, dca1, dcw1, dco1, dca2, dcw2, dco2 };
}

function entry(id, name, tags, p) {
  return { id, name, tags, patch: p };
}

const HAND_BUILT_PATCHES = [
  entry("warm-bass", "Warm Bass", ["bass", "warm", "low"], patch("Warm Bass", {
    octave: -1,
    detune: detune("+", 6, 0, 0),
    osc1: { first: 1, second: 2, modulation: "none" },
    osc2: { first: 1, second: 2 },
    dca1: ampOrWave(sustainedEnv({ attackRate: 90, peak: 99, decayRate: 55, sustainLevel: 78, releaseRate: 35 })),
    dcw1: ampOrWave(sustainedEnv({ attackRate: 70, peak: 50, decayRate: 45, sustainLevel: 28, releaseRate: 30, dcwSustain: true })),
  })),

  entry("pluck-bass", "Pluck Bass", ["bass", "pluck", "percussive"], patch("Pluck Bass", {
    octave: -1,
    osc1: { first: 6, second: 2, modulation: "none" },
    osc2: { first: 6, second: 2 },
    dca1: ampOrWave(oneShotEnv({ attackRate: 99, peak: 99, steps: [[70, 35], [55, 10], [45, 0]] })),
    dcw1: ampOrWave(oneShotEnv({ attackRate: 99, peak: 85, steps: [[65, 25], [45, 0]] })),
  })),

  entry("bell-tines", "Bell Tines", ["bell", "bright", "mallet", "percussive"], patch("Bell Tines", {
    osc1: { first: 4, second: 7, modulation: "none" },
    osc2: { first: 4, second: 7 },
    dca1: ampOrWave(oneShotEnv({ attackRate: 75, peak: 99, steps: [[35, 55], [20, 25], [12, 0]] })),
    dcw1: ampOrWave(oneShotEnv({ attackRate: 95, peak: 90, steps: [[55, 45], [30, 15], [15, 0]] })),
  })),

  entry("glass-bell", "Glass Bell", ["bell", "glass", "shimmer", "ambient"], patch("Glass Bell", {
    detune: detune("+", 4, 0, 0),
    vibrato: vib(1, 40, 30, 8),
    osc1: { first: 8, second: 4, modulation: "none" },
    osc2: { first: 8, second: 4 },
    dca1: ampOrWave(oneShotEnv({ attackRate: 60, peak: 99, steps: [[22, 60], [12, 30], [8, 0]] })),
    dcw1: ampOrWave(oneShotEnv({ attackRate: 80, peak: 95, steps: [[35, 55], [18, 25], [10, 0]] })),
  })),

  entry("brass-stab", "Brass Stab", ["brass", "stab", "punchy", "bright"], patch("Brass Stab", {
    vibrato: vib(1, 25, 55, 10),
    osc1: { first: 1, second: 3, modulation: "none" },
    osc2: { first: 1, second: 3 },
    dca1: ampOrWave(sustainedEnv({ attackRate: 95, peak: 99, decayRate: 60, sustainLevel: 82, releaseRate: 40 })),
    dcw1: ampOrWave(sustainedEnv({ attackRate: 90, peak: 90, decayRate: 50, sustainLevel: 65, releaseRate: 35, dcwSustain: true })),
  })),

  entry("analog-pad", "Analog Pad", ["pad", "warm", "slow", "strings"], patch("Analog Pad", {
    detune: detune("+", 10, 0, 0),
    vibrato: vib(1, 60, 25, 14),
    osc1: { first: 1, second: 1, modulation: "none" },
    osc2: { first: 1, second: 1 },
    dca1: ampOrWave(sustainedEnv({ attackRate: 20, peak: 95, decayRate: 25, sustainLevel: 90, releaseRate: 20 })),
    dcw1: ampOrWave(sustainedEnv({ attackRate: 15, peak: 70, decayRate: 20, sustainLevel: 55, releaseRate: 18, dcwSustain: true })),
  })),

  entry("airy-pad", "Airy Pad", ["pad", "airy", "ambient", "evolving"], patch("Airy Pad", {
    vibrato: vib(1, 70, 20, 10),
    osc1: { first: 7, second: 1, modulation: "noise" },
    osc2: { first: 7, second: 1 },
    dca1: ampOrWave(sustainedEnv({ attackRate: 18, peak: 90, decayRate: 22, sustainLevel: 80, releaseRate: 16 })),
    // A slow brightening swell rather than a plain decay - the DCW keeps
    // opening for a while after the note starts instead of settling right away.
    dcw1: ampOrWave(raw(3, [st(20, 20), st(14, 45), st(10, 65, true), st(16, 0)])),
  })),

  entry("pluck-lead", "Pluck Lead", ["lead", "pluck", "bright", "mono"], patch("Pluck Lead", {
    osc1: { first: 1, second: 2, modulation: "none" },
    osc2: { first: 1, second: 2 },
    dca1: ampOrWave(sustainedEnv({ attackRate: 99, peak: 99, decayRate: 60, sustainLevel: 65, releaseRate: 30 })),
    dcw1: ampOrWave(sustainedEnv({ attackRate: 99, peak: 95, decayRate: 55, sustainLevel: 55, releaseRate: 28, dcwSustain: true })),
  })),

  entry("resonant-lead", "Resonant Lead", ["lead", "resonant", "aggressive", "bright"], patch("Resonant Lead", {
    osc1: { first: 6, second: 7, modulation: "ring" },
    osc2: { first: 6, second: 7 },
    dca1: ampOrWave(sustainedEnv({ attackRate: 95, peak: 99, decayRate: 58, sustainLevel: 75, releaseRate: 35 })),
    dcw1: ampOrWave(sustainedEnv({ attackRate: 92, peak: 99, decayRate: 50, sustainLevel: 70, releaseRate: 30, dcwSustain: true })),
  })),

  entry("wobble-bass", "Wobble Bass", ["bass", "wobble", "movement"], patch("Wobble Bass", {
    octave: -1,
    osc1: { first: 2, second: 3, modulation: "none" },
    osc2: { first: 2, second: 3 },
    dca1: ampOrWave(sustainedEnv({ attackRate: 90, peak: 99, decayRate: 50, sustainLevel: 85, releaseRate: 40 })),
    // The DCW rises and falls across all 8 stages instead of settling -
    // the same rhythmic idea as the Generate tool's own "Cycle / wobble"
    // curve preset, baked directly into a patch.
    dcw1: ampOrWave(raw(7, [st(55, 85), st(55, 25), st(55, 85), st(55, 25), st(55, 85), st(55, 25), st(55, 85), st(55, 25)])),
  })),

  entry("electric-piano", "Electric Piano", ["keys", "ep", "mellow"], patch("Electric Piano", {
    osc1: { first: 4, second: 5, modulation: "none" },
    osc2: { first: 4, second: 5 },
    dca1: ampOrWave(sustainedEnv({ attackRate: 85, peak: 99, decayRate: 45, sustainLevel: 55, releaseRate: 30 })),
    dcw1: ampOrWave(oneShotEnv({ attackRate: 90, peak: 80, steps: [[40, 35], [20, 10], [12, 0]] })),
  })),

  entry("organ-drone", "Organ Drone", ["organ", "sustained", "drone"], patch("Organ Drone", {
    vibrato: vib(1, 0, 35, 12),
    osc1: { first: 2, second: 3, modulation: "none" },
    osc2: { first: 2, second: 3 },
    dca1: ampOrWave(raw(3, [st(99, 99), st(99, 99), st(10, 99), st(45, 0)])),
    dcw1: ampOrWave(raw(3, [st(99, 70), st(99, 70), st(10, 70, true), st(40, 0)])),
  })),

  entry("scifi-sweep", "Sci-fi Sweep", ["sfx", "sweep", "movement", "riser"], patch("Sci-fi Sweep", {
    osc1: { first: 8, second: 7, modulation: "noise" },
    osc2: { first: 8, second: 7 },
    dca1: ampOrWave(sustainedEnv({ attackRate: 25, peak: 99, decayRate: 30, sustainLevel: 90, releaseRate: 25 })),
    // A slow multi-stage brightening rather than a quick attack/decay - the
    // filter keeps opening well after the note starts.
    dcw1: ampOrWave(raw(4, [st(12, 10), st(10, 35), st(8, 60), st(8, 85, true), st(20, 0)])),
    // The one patch here where the pitch envelope actually moves: a slow
    // glide from below pitch up to center (level 50 = no shift, per
    // patch.js's DCO note), instead of the flat line every other patch uses.
    dco1: raw(2, [st(8, 20), st(10, 35), st(12, 50)]),
  })),
];

// Osc2 defaults to mirroring osc1's envelopes for every hand-built patch
// above that doesn't set its own dca2/dcw2/dco2 - most CZ patches use very
// similar or identical envelopes on both oscillators, and the
// per-oscillator "Copy from Osc" button already exists for anyone who
// wants to diverge them further from the editor. The decoded CZ230S_PRESETS
// already carry real dca2/dcw2/dco2 values straight off the hardware, so
// this loop only ever needs to run over the hand-built set.
for (const { patch: p } of HAND_BUILT_PATCHES) {
  if (p.dca2 === undefined) p.dca2 = JSON.parse(JSON.stringify(p.dca1));
  if (p.dcw2 === undefined) p.dcw2 = JSON.parse(JSON.stringify(p.dcw1));
  if (p.dco2 === undefined) p.dco2 = JSON.parse(JSON.stringify(p.dco1));
}

export const FACTORY_PATCHES = [...HAND_BUILT_PATCHES, ...CZ230S_PRESETS];
