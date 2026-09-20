// patch.js
// The in-memory patch data model, plus a sane "init" default and a couple
// of starter presets. This is deliberately plain JSON-shaped data (no
// classes) so it can be saved/loaded/cloned trivially and is easy to
// extend later.

export function makeStage(rate = 50, level = 50, sustain = false) {
  return { rate, level, sustain };
}

export function makeEightStages(rate, level, sustain = false) {
  return Array.from({ length: 8 }, () => makeStage(rate, level, sustain));
}

export function makeOscBundle({
  keyFollowDca = 0,
  keyFollowDcw = 0,
  dcaEnv,
  dcwEnv,
  dcoEnv,
} = {}) {
  return {
    keyFollowDca,
    keyFollowDcw,
    dca: { keyFollow: keyFollowDca, endStep: 7, stages: dcaEnv ?? makeEightStages(40, 99) },
    dcw: { keyFollow: keyFollowDcw, endStep: 7, stages: dcwEnv ?? makeEightStages(40, 60) },
    dco: { endStep: 7, stages: dcoEnv ?? makeEightStages(0, 50) },
  };
}

/** A simple, audible "init" patch: sawtooth-ish, quick attack, held sustain. */
export function initPatch() {
  const dcaEnv = [
    makeStage(90, 99), makeStage(60, 80), makeStage(60, 70), makeStage(60, 70),
    makeStage(60, 70), makeStage(60, 70), makeStage(60, 70), makeStage(50, 0),
  ];
  const dcwEnv = [
    makeStage(90, 70), makeStage(50, 40), makeStage(50, 40), makeStage(50, 40),
    makeStage(50, 40), makeStage(50, 40), makeStage(50, 40), makeStage(50, 0),
  ];
  const dcoEnv = makeEightStages(0, 50); // flat, no pitch movement

  return {
    name: "init",
    octave: 0,
    line: 1,
    detune: { sign: "+", fine: 0, octave: 0, note: 0 },
    vibrato: { wave: 1, delay: 30, rate: 40, depth: 0 },
    osc1: { first: 1, second: 1, modulation: "none" },
    osc2: { first: 1, second: 1 },
    dca1: { keyFollow: 0, endStep: 6, stages: dcaEnv },
    dcw1: { keyFollow: 0, endStep: 6, stages: dcwEnv },
    dco1: { endStep: 0, stages: dcoEnv },
    dca2: { keyFollow: 0, endStep: 6, stages: dcaEnv.map((s) => ({ ...s })) },
    dcw2: { keyFollow: 0, endStep: 6, stages: dcwEnv.map((s) => ({ ...s })) },
    dco2: { endStep: 0, stages: dcoEnv.map((s) => ({ ...s })) },
  };
}

export function clonePatch(patch) {
  return JSON.parse(JSON.stringify(patch));
}

// ---------------------------------------------------------------------
// The CZ-101's own front-panel INITIALIZE function
// ---------------------------------------------------------------------
// Researched from the CZ-1000 owner's manual (same synthesis engine and
// parameter set as the CZ-101 - CZ-1000 is a full-size-key version of the
// same instrument). On real hardware, holding the INITIALIZE key and then
// pressing a parameter's own key resets just that parameter group to a
// documented value, described in the manual as "values that enable the
// easiest kind of operations when creating new tones." That's a distinct,
// more minimal target than initPatch() above (which is this editor's own
// ready-to-hear starting point, not a hardware-accurate reset), and is
// what the "Initialize" buttons in the UI reproduce, section by section.
//
// Manual's table (VIBRATO / OCTAVE / WAVE FORM / PITCH ENVELOPE /
// DCW KEY FOLLOW / WAVE ENVELOPE / DCA KEY FOLLOW / AMP ENVELOPE /
// DETUNE), condensed here into one function per this editor's own section
// groupings (Voice basics vs. each oscillator).

export function hardwareInitVoiceBasics() {
  return {
    octave: 0,
    detune: { sign: "+", fine: 0, octave: 0, note: 0 },
    vibrato: { wave: 1, delay: 0, rate: 0, depth: 0 },
  };
  // Line select isn't in the manual's INITIALIZE table at all, so it's
  // left untouched here rather than guessed at.
}

function hardwareInitAmpOrWaveEnvelope({ sustainFirst = false } = {}) {
  // Manual: "STEP 1 RATE 99 LEVEL 99 SUS, STEPS 2-7 RATE 50 LEVEL 00,
  // STEP 8 RATE 50 LEVEL 00 END" - an instant attack to full level, held
  // (sustained) until the key is released, then a straight decay to
  // silence. Same shape for both DCA (amplitude) and DCW (tone).
  return {
    endStep: 7,
    stages: [makeStage(99, 99, sustainFirst), ...Array.from({ length: 7 }, () => makeStage(50, 0))],
  };
}

function hardwareInitPitchEnvelope() {
  // Manual: "RATE 50 LEVEL 00" for all 8 steps - flat, no pitch movement.
  // Handy side note this also settles: since the manual's own idea of "the
  // pitch envelope doing nothing" is level 0 at every step, level 0 is
  // confirmed as DCO's "no pitch shift" center (previously just a guess
  // in this editor's DCO panel note).
  return { endStep: 7, stages: makeEightStages(50, 0) };
}

/** @param {1|2} oscNum */
export function hardwareInitOscillator(oscNum) {
  return {
    osc: {
      first: 1,
      // Manual lists SECOND = 0. Neither this editor nor the CZ-101's own
      // line-2 waveform dropdown has an "off" waveform (1-8 only), so
      // line 1's waveform is mirrored here as the closest equivalent.
      second: 1,
      ...(oscNum === 1 ? { modulation: "none" } : {}),
    },
    dca: { keyFollow: 0, ...hardwareInitAmpOrWaveEnvelope() },
    // DCW is the only one of the three envelopes whose sustain flag this
    // editor - and the CZ's own SysEx voice-dump format (see sysex.js) -
    // can actually store and transmit. The manual marks step 1 as the
    // sustain point on the amp and pitch envelopes too (front-panel
    // sustain applies to all three), but with no wire format to carry it
    // for DCA/DCO, setting it there would be inert data, so only DCW's is
    // actually set.
    dcw: { keyFollow: 0, ...hardwareInitAmpOrWaveEnvelope({ sustainFirst: true }) },
    dco: { ...hardwareInitPitchEnvelope() },
  };
}
