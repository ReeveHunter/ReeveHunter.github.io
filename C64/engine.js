// engine.js
// The patch model and how each Cynthcart build is driven over MIDI.
// No DOM and no Web MIDI here, so it can be tested on its own.
//
// Message maps: docs/midi-implementation.md in the cynthcart-kerberos repo.

import { PRESETS } from "./presets.js";

export const MODES = ["POLY", "5THS", "5PORT", "PORT1", "PORT2", "PORT3", "MONO1", "MONO2",
  "MONP1", "MONP2", "ARP1", "ARP2", "ARP3", "ARP4", "ARP5", "6CHAN"];
export const FX = ["NONE", "FILT1", "FILT2", "FILT3", "FILT4", "FILT5", "PULS1", "PULS2", "PULS3"];
export const WAVES = ["T", "S", "P", "N"];
export const WAVE_NAMES = ["Triangle", "Sawtooth", "Pulse", "Noise"];
export const MODS = ["-", "RING", "SYNC", "R+S"];
export const FILTER_TYPES = ["---", "LP", "BP", "L+B", "HP", "NCH", "B+H", "ALL"];
export const TUNINGS = ["-40", "-30", "-20", "-10", "0", "+10", "+20", "+30", "+40", "+50"];
export const VIB_LEVELS = [0, 2, 5, 15]; // 2.0's vibrato depths (and the custom build's preset depths)

export const TARGETS = {
  sx: { label: "Custom build + SysEx", short: "Custom + SysEx", sysex: true, custom: true },
  cc: { label: "Custom build (CC only)", short: "Custom (CC)", sysex: false, custom: true },
  v20f: { label: "Cynthcart 2.0.1F (bug fixes)", short: "2.0.1F", sysex: false, custom: false },
  v20: { label: "Cynthcart 2.0", short: "2.0", sysex: false, custom: false },
};

/** 2.0 and 2.0.1F share a MIDI map (2.0.1F fixes the PW CC and the resonance range). */
export const isV20 = (t) => t === "v20" || t === "v20f";

// SysEx parameter indexes (header order, cynthparam.asm paramTable)
const P = { CH: 0, PRESET: 1, MODE: 2, FX: 3, P1: 4, P2: 5, OSC: 6, PW: 7, OCT: 8, TUN: 9, VIB: 10, FLT: 11,
  CUT: 12, RES: 13, VID: 14, VOL: 15, A: 16, D: 17, S: 18, R: 19, TRM: 20 };

// ---------------------------------------------------------------- parameters
// range, display and grouping for every control. group = C64 header color.
export const GLOBAL_PARAMS = {
  mode: { label: "Mode", min: 0, max: 15, group: "sys", show: (v) => MODES[v] },
  fx: { label: "FX", min: 0, max: 8, group: "sys", show: (v) => FX[v] },
  oct: { label: "Octave", min: 0, max: 3, group: "osc" },
  tune: { label: "Tuning", min: 0, max: 9, group: "osc", show: (v) => TUNINGS[v] + "¢" },
  vibD: { label: "Vibrato depth", min: 0, max: 31, group: "mod" },
  vibS: { label: "Vibrato speed", min: 0, max: 3, group: "mod" },
  trmD: { label: "Tremolo depth", min: 0, max: 15, group: "mod" },
  trmS: { label: "Tremolo speed", min: 0, max: 31, group: "mod" },
  fType: { label: "Filter type", min: 0, max: 7, group: "flt", show: (v) => FILTER_TYPES[v] },
  cut: { label: "Cutoff", min: 0, max: 254, step: 2, group: "flt", show: (v) => String(v >> 1) },
  res: { label: "Resonance", min: 0, max: 15, group: "flt" },
  vol: { label: "Volume", min: 0, max: 15, group: "amp" },
};
export const VOICE_PARAMS = {
  wave: { label: "Waveform", min: 0, max: 3, group: "osc", show: (v) => WAVES[v] },
  mod: { label: "Ring / sync", min: 0, max: 3, group: "osc", show: (v) => MODS[v] },
  pw: { label: "Pulse width", min: 0, max: 254, step: 2, group: "osc", show: (v) => String(v >> 1) },
  flt: { label: "Filter", min: 0, max: 1, group: "flt", show: (v) => (v ? "ON" : "OFF") },
  a: { label: "Attack", min: 0, max: 15, group: "amp" },
  d: { label: "Decay", min: 0, max: 15, group: "amp" },
  s: { label: "Sustain", min: 0, max: 15, group: "amp" },
  r: { label: "Release", min: 0, max: 15, group: "amp" },
};

// ---------------------------------------------------------------- setup (not part of patches)
// Paddles, fire buttons, video and Cynthcart's MIDI channel. Presets never change these on the
// C64, so they're sent on their own. Only the SysEx firmware can set all of them; the
// custom build's CC 10 reaches video (no full screen).
export const PADDLE_MODES = [
  ["---", "Off"], ["FLT", "Cutoff"], ["PW ", "Pulse width"], ["VOL", "Volume"], ["ATK", "Attack"], ["DEC", "Decay"],
  ["SUS", "Sustain"], ["REL", "Release"], ["VIB", "Vibrato depth"], ["VSP", "Vibrato speed"], ["TRM", "Tremolo depth"],
  ["TSP", "Tremolo speed"], ["PB ", "Pitch bend (both ways)"], ["PB+", "Bend up"], ["PB-", "Bend down"],
];
export const FIRE_MODES = [
  ["--", "Off"], ["P-", "Short bend down"], ["P+", "Short bend up"], ["HD", "Hold notes (latch)"], ["F ", "Filter wah"],
  ["V ", "Deep vibrato (latch)"], ["T ", "Deep tremolo (latch)"],
  ["A1", "ARP1 (latch)"], ["A2", "ARP2 (latch)"], ["A3", "ARP3 (latch)"], ["A4", "ARP4 (latch)"], ["A5", "ARP5 (latch)"],
  ["M1", "MONO1 (latch)"], ["M2", "MONO2 (latch)"], ["M3", "MONP1 (latch)"], ["M4", "MONP2 (latch)"],
  ["P1", "PORT1 (latch)"], ["P2", "PORT2 (latch)"], ["P3", "PORT3 (latch)"], ["N ", "Noise (latch)"], ["5 ", "5THS (latch)"],
  ["O+", "Octave up (latch)"], ["O-", "Octave down (latch)"], ["A+", "Attack max (latch)"], ["R+", "Release max (latch)"],
  ["MU", "Mute"], [">>", "Next preset"], ["<<", "Previous preset"], ["+1", "Selected parameter +1"],
  ["-1", "Selected parameter −1"], ["? ", "Randomize all"],
];
export const VID_STATES = [["ON ", "On"], ["ON ", "Full screen"], ["SND", "On with sound"], ["SND", "Full screen with sound"], ["OFF", "Off"]];
export const CHANNELS = ["ALL", ...Array.from({ length: 16 }, (_, i) => String(i + 1))];
/** The C64's power-on setup. */
export const DEFAULT_SETUP = { ch: 0, pad1: 0, fire1: 1, pad2: 0, fire2: 2, vid: 0, pat: 1 };
export const SETUP_PARAMS = {
  ch: { label: "Cynthcart MIDI channel", max: 16 },
  pad1: { label: "Paddle 1", max: 14 }, fire1: { label: "Paddle 1 button", max: 30 },
  pad2: { label: "Paddle 2", max: 14 }, fire2: { label: "Paddle 2 button", max: 30 },
  vid: { label: "Video", max: 4 }, pat: { label: "Video pattern", max: 2 },
};
export function normalizeSetup(raw) {
  const s = { ...DEFAULT_SETUP };
  for (const [k, d] of Object.entries(SETUP_PARAMS)) if (Number.isFinite(raw?.[k])) s[k] = clamp(raw[k], 0, d.max);
  return s;
}
/** true if the target can set this setup value (key = "ch", "pad1", ...). */
export function setupSupported(target, key, setup = DEFAULT_SETUP) {
  if (target === "sx") return true;
  if (target === "cc" && (key === "vid" || key === "pat")) return setup.vid !== 1 && setup.vid !== 3; // no full screen by CC
  return false;
}
const SETUP_SX = { ch: [P.CH, 0], pad1: [P.P1, 0], fire1: [P.P1, 1], pad2: [P.P2, 0], fire2: [P.P2, 1], vid: [P.VID, 0], pat: [P.VID, 1] };
/** Messages to set one setup value (or null if the target can't). */
export function setupMessages(target, ch, setup, key) {
  if (target === "sx") { const [pp, ww] = SETUP_SX[key]; return [sxMsg(1, pp, ww, setup[key])]; }
  if (target === "cc" && (key === "vid" || key === "pat") && setupSupported(target, key, setup)) {
    const band = setup.vid === 4 ? 6 : (setup.vid === 2 ? 3 : 0) + setup.pat; // CC 10: on 1-3, with sound 1-3, off
    return [ccMsg(ch, 10, band * 16 + 8)];
  }
  return null;
}
/** Everything in the setup the target can set. */
export function allSetupMessages(target, ch, setup) {
  const keys = target === "sx" ? ["pad1", "fire1", "pad2", "fire2", "vid", "pat", "ch"] : ["vid"];
  return keys.flatMap((k) => setupMessages(target, ch, setup, k) ?? []);
}

// What each target can reach over MIDI. "voice1" = one value for all voices
// (2.0 only has global envelope / pulse width CCs).
const V20_SUPPORT = { oct: false, tune: false, fType: false, flt: false, trmD: false, trmS: false, mod: false,
  d: "fixed", s: "fixed", a: "voice1", r: "voice1", pw: "voice1" };
const SUPPORT = {
  v20f: V20_SUPPORT,
  sx: { all: true },
  cc: { oct: false, tune: false, fType: false, flt: false },
  v20: V20_SUPPORT,
};
/** true, false, "voice1" (only voice 1's control is used, for all voices) or "fixed" */
export function supports(target, key) {
  const t = SUPPORT[target];
  if (t.all) return true;
  return key in t ? t[key] : true;
}
export function why(target, key) {
  const s = supports(target, key);
  if (s === true) return "";
  if (isV20(target)) {
    if (s === "voice1") return "Cynthcart 2.0 sets this for all voices at once (voice 1's value is sent).";
    if (key === "d") return "On 2.0, sending attack sets decay to 0; otherwise decay comes from the base preset.";
    if (key === "s") return "On 2.0, sending release sets sustain to 15; otherwise sustain comes from the base preset.";
    return "Cynthcart 2.0 can't set this over MIDI: it comes from the base preset.";
  }
  return "Only the SysEx firmware can set this over MIDI: with CCs it comes from the base preset.";
}

// ---------------------------------------------------------------- patches
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v | 0));

export function patchFromPreset(n) {
  const p = PRESETS[n];
  return {
    name: titleCase(p.name),
    base: n,
    mode: p.mode, fx: p.fx, oct: p.oct, tune: 4,
    vibD: p.vibD, vibS: p.vibS, trmD: 0, trmS: 0,
    fType: p.fType, cut: p.cut, res: p.res, vol: p.vol,
    voices: p.voices.map((v) => ({ ...v })),
  };
}
function titleCase(s) {
  return s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).replace(/\b(Arp|Pwm)\b/g, (w) => w.toUpperCase());
}

/** Clean up a patch from storage or a file: fill gaps, clamp ranges. */
export function normalizePatch(raw) {
  const base = clamp(raw?.base ?? 0, 0, 29);
  const p = patchFromPreset(base);
  if (typeof raw?.name === "string") p.name = raw.name.slice(0, 16);
  for (const [k, d] of Object.entries(GLOBAL_PARAMS)) {
    if (Number.isFinite(raw?.[k])) p[k] = clampStep(raw[k], d);
  }
  for (let i = 0; i < 3; i++) {
    const rv = raw?.voices?.[i];
    if (!rv) continue;
    for (const [k, d] of Object.entries(VOICE_PARAMS)) {
      if (Number.isFinite(rv[k])) p.voices[i][k] = clampStep(rv[k], d);
    }
  }
  return p;
}
function clampStep(v, d) {
  v = clamp(v, d.min, d.max);
  if (d.step) v -= v % d.step;
  return v;
}

export function patchToFile(p) {
  return { format: "cynthcart-patch", version: 1, ...structuredClone(p) };
}

/** What "randomize" may change: never octave, tuning or the base preset. VOL only when asked for by name (the firmware's "randomize all" keeps it). */
export const RANDOM_KEYS = ["mode", "fx", "vibD", "vibS", "trmD", "trmS", "fType", "cut", "res", "wave", "mod", "pw", "flt", "a", "d", "s", "r"];
const RANDOM_RANGE = { // the firmware's guards: no 6CHAN, no silent PW, a real filter type, VOL 8-15
  mode: [0, 14], fx: [0, 8], vibD: [0, 31], vibS: [0, 3], trmD: [0, 15], trmS: [0, 31], fType: [1, 7],
  cut: [0, 127, 2], res: [0, 15], vol: [8, 15],
  wave: [0, 3], mod: [0, 3], pw: [12, 115, 2], flt: [0, 1], a: [0, 15], d: [0, 15], s: [0, 15], r: [0, 15],
};
/**
 * Random patch. opts.keys: which parameters (default RANDOM_KEYS); opts.locks: { key: true } to leave alone;
 * opts.link: one value for all three voices (like the firmware's "sync" randomize).
 * The name becomes "Random" only when everything is randomized.
 */
export function randomPatch(from, rnd = Math.random, opts = {}) {
  const { keys = RANDOM_KEYS, locks = {}, link = false } = opts;
  const r = (k) => { const [lo, hi, m = 1] = RANDOM_RANGE[k]; return (lo + Math.floor(rnd() * (hi - lo + 1))) * m; };
  const p = structuredClone(from);
  if (!opts.keys) p.name = "Random";
  for (const k of keys) {
    if (locks[k] || !(k in RANDOM_RANGE)) continue;
    if (k in VOICE_PARAMS) {
      const shared = r(k);
      for (const v of p.voices) v[k] = link ? shared : r(k);
    } else p[k] = r(k);
  }
  return p;
}

// ---------------------------------------------------------------- MIDI messages
const band8 = (v) => clamp(v, 0, 15) * 8 + 4; // middle of a 0-15 band of 0-127
const ccMsg = (ch, cc, val) => [0xb0 | ch, cc, clamp(val, 0, 127)];
const sxMsg = (...data) => [0xf0, 0x7d, 0x43, ...data.map((b) => clamp(b, 0, 127)), 0xf7];
const fxCC = (target, fx) => {
  if (isV20(target)) return clamp(fx, 0, 7) * 16 + 8; // 2.0 and 2.0.1F: no PULS3 over MIDI
  if (fx === 7) return 116;
  if (fx === 8) return 124;
  return fx * 16 + 8;
};
const vibLevel = (depth) => {
  // nearest of 2.0's four depths
  let best = 0;
  VIB_LEVELS.forEach((d, i) => { if (Math.abs(d - depth) < Math.abs(VIB_LEVELS[best] - depth)) best = i; });
  return best;
};
// CC 13 on the custom build: bands of 16 -> none(=all), 1, 2, 3, 1+2, 1+3, 2+3, all
const MASK_BAND = { 0: 0, 1: 1, 2: 2, 4: 3, 3: 4, 5: 5, 6: 6, 7: 0 };
export const voiceSelectCC = (ch, mask) => ccMsg(ch, 13, MASK_BAND[mask & 7] * 16 + 8);

/**
 * Messages for one live edit.
 * key: a GLOBAL_PARAMS or VOICE_PARAMS key; voices: array of voice indexes edited (per-voice keys).
 * Returns { mask, msgs } - mask is the custom build's voice selection the messages need
 * (undefined = doesn't matter), or null when the target can't reach this parameter.
 */
export function editMessages(target, ch, p, key, voices = [0, 1, 2]) {
  const s = supports(target, key);
  if (s === false || s === "fixed") return null;
  const v1 = p.voices[0];
  if (key in GLOBAL_PARAMS) {
    switch (key) {
      case "mode": return { msgs: [ccMsg(ch, 2, p.mode * 8 + 4)] };
      case "fx": return { msgs: [ccMsg(ch, 3, fxCC(target, p.fx))] };
      case "cut": return { msgs: [ccMsg(ch, 1, p.cut >> 1)] };
      case "res": // stock 2.0 only reaches 0-7 (value / 16)
        return { msgs: [ccMsg(ch, 0, target === "v20" ? Math.min(p.res, 7) * 16 + 8 : band8(p.res))] };
      case "vol": return { msgs: [ccMsg(ch, 7, band8(p.vol))] };
      case "vibD": case "vibS":
        if (isV20(target)) {
          return key === "vibD"
            ? { msgs: [ccMsg(ch, 8, vibLevel(p.vibD) * 16 + 8)] }
            : { msgs: [ccMsg(ch, 9, p.vibS * 16 + 8)] };
        }
        return { msgs: [ccMsg(ch, 8, p.vibS * 32 + p.vibD)] };
      case "trmD": return { msgs: [ccMsg(ch, 9, band8(p.trmD))] };
      case "trmS": return { msgs: [ccMsg(ch, 15, p.trmS * 4 + 2)] };
      case "oct": return { msgs: [sxMsg(1, P.OCT, 0, p.oct)] };
      case "tune": return { msgs: [sxMsg(1, P.TUN, 0, p.tune)] };
      case "fType": return { msgs: [sxMsg(1, P.FLT, 1, p.fType)] };
    }
  }
  // per-voice
  if (isV20(target)) {
    switch (key) {
      case "wave": // CC 13 sets all three, CC 14/15 voices 2 and 3
        if (voices.includes(0)) {
          return { msgs: [ccMsg(ch, 13, p.voices[0].wave * 8 + 4), ccMsg(ch, 14, p.voices[1].wave * 8 + 4), ccMsg(ch, 15, p.voices[2].wave * 8 + 4)] };
        }
        return { msgs: voices.map((i) => ccMsg(ch, 13 + i, p.voices[i].wave * 8 + 4)) };
      case "pw": return { msgs: [ccMsg(ch, 6, v1.pw >> 1)] };
      case "a": return { msgs: [ccMsg(ch, 4, band8(v1.a))] };
      case "r": return { msgs: [ccMsg(ch, 5, band8(v1.r))] };
    }
    return null;
  }
  const mask = voices.length === 3 ? 0 : voices.reduce((m, i) => m | (1 << i), 0);
  const v = p.voices[voices[0]];
  switch (key) {
    case "wave": case "mod": return { mask, msgs: [ccMsg(ch, 14, (v.wave * 4 + v.mod) * 8 + 4)] };
    case "pw": return { mask, msgs: [ccMsg(ch, 6, v.pw >> 1)] };
    case "a": return { mask, msgs: [ccMsg(ch, 4, band8(v.a))] };
    case "d": return { mask, msgs: [ccMsg(ch, 12, band8(v.d))] };
    case "s": return { mask, msgs: [ccMsg(ch, 11, band8(v.s))] };
    case "r": return { mask, msgs: [ccMsg(ch, 5, band8(v.r))] };
    case "flt": return { mask, msgs: [sxMsg(1, P.FLT, 0, v.flt)] };
  }
  return null;
}

/**
 * Everything needed to recall a patch on the target.
 * Returns { steps: [{ msg, delay }], unreachable: [labels that differ from the base preset] }.
 * delay = ms to wait before this message.
 */
export function patchMessages(target, ch, p) {
  const steps = [];
  const add = (msg, delay = 0) => steps.push({ msg, delay });
  const base = patchFromPreset(p.base);
  const unreachable = [];

  if (target === "sx") {
    const data = [p.base, p.mode, p.fx, p.oct, p.vibD, p.vibS, p.fType, p.cut >> 1, p.res, p.vol, p.trmD, p.trmS];
    for (const v of p.voices) data.push(v.wave, v.mod, v.pw >> 1, v.flt, v.a, v.d, v.s, v.r);
    const name = asciiName(p.name);
    add(sxMsg(3, ...data, ...name));
    add(sxMsg(1, P.TUN, 0, p.tune), 15);
    return { steps, unreachable };
  }

  add([0xc0 | ch, p.base]);
  let first = true;
  const send = (msgs) => { for (const m of msgs) { add(m, first ? 40 : 0); first = false; } };
  const differs = (k) => p[k] !== base[k];

  for (const k of Object.keys(GLOBAL_PARAMS)) {
    const s = supports(target, k);
    if (s === false) { if (differs(k)) unreachable.push(GLOBAL_PARAMS[k].label); continue; }
    if (isV20(target) && !differs(k)) continue; // 2.0: leave the preset's values alone
    if (k === "vibS" && !isV20(target)) continue; // sent with vibD (same CC)
    const e = editMessages(target, ch, p, k);
    if (e) send(e.msgs);
  }

  if (target === "v20" && p.res > 7) unreachable.push("Resonance above 7 (2.0's CC 0 stops at 7)");
  if (isV20(target) && p.fx === 8) unreachable.push("FX PULS3");
  if (isV20(target)) {
    const vd = (k, i = 0) => p.voices[i][k] !== base.voices[i][k];
    if ([0, 1, 2].some((i) => vd("wave", i))) send(editMessages(target, ch, p, "wave", [0]).msgs);
    for (const k of ["pw", "a", "r"]) if (vd(k)) send(editMessages(target, ch, p, k).msgs);
    for (const k of ["mod", "flt"]) if ([0, 1, 2].some((i) => vd(k, i))) unreachable.push(VOICE_PARAMS[k].label);
    for (const k of ["pw", "a", "r"]) if ([1, 2].some((i) => p.voices[i][k] !== p.voices[0][k])) unreachable.push(VOICE_PARAMS[k].label + " (per voice)");
    if (vd("a") && p.voices[0].d !== 0) unreachable.push("Decay (2.0 sets it to 0 with attack)");
    else if ([0, 1, 2].some((i) => vd("d", i))) unreachable.push("Decay");
    if (vd("r") && p.voices[0].s !== 15) unreachable.push("Sustain (2.0 sets it to 15 with release)");
    else if ([0, 1, 2].some((i) => vd("s", i))) unreachable.push("Sustain");
    return { steps, unreachable: [...new Set(unreachable)] };
  }

  // custom build, CC only: voice by voice
  for (let i = 0; i < 3; i++) {
    send([voiceSelectCC(ch, 1 << i)]);
    for (const k of ["wave", "pw", "a", "d", "s", "r"]) send(editMessages(target, ch, p, k, [i]).msgs);
    if (p.voices[i].flt !== base.voices[i].flt) unreachable.push(VOICE_PARAMS.flt.label);
  }
  send([voiceSelectCC(ch, 0)]);
  return { steps, unreachable: [...new Set(unreachable)] };
}

export function asciiName(name) {
  return Array.from(String(name).toUpperCase().slice(0, 16))
    .map((c) => c.charCodeAt(0))
    .map((c) => (c >= 32 && c < 127 ? c : 32));
}

// ---------------------------------------------------------------- the C64 header
// What Cynthcart's header shows for this patch (5 rows of 40), as spans of
// [text, colorClass]. Good enough to read the app the same way as the screen.
export function headerRows(p, { channel = null, presetLabel = null, setup = null, setupOk = () => false } = {}) {
  const L = (t, c, k) => (k ? [t, c, k] : [t, c]);
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  const num = (v, n) => String(v).padStart(n);
  const st = setup ?? DEFAULT_SETUP;
  const chText = st.ch ? num(st.ch, 2) + " " : channel == null ? "ALL" : num(channel, 2) + " ";
  const sv = (text, key) => L(text, setupOk(key) ? "val" : "dim", key); // setup values: dim when the target can't set them
  const vSame = (k) => p.voices.every((v) => v[k] === p.voices[0][k]);
  const eq = (k) => (vSame(k) ? ["=", "eq"] : ["*", "diff"]);
  // one letter per voice; R = triangle + ring, reverse video = sync
  const osc = p.voices.map((v, i) => L(v.wave === 0 && v.mod & 1 ? "R" : WAVES[v.wave], v.mod & 2 ? "val rev" : "val", "osc" + i));
  const fltOn = p.voices[0].flt ? FILTER_TYPES[p.fType] : "OFF";
  const fltSame = p.voices.every((v) => v.flt === p.voices[0].flt);
  const v = p.voices[0];
  return [
    [L("CYNTHCART ", "title"), L("CH", "sys"), L("=", "eq"), sv(pad(chText, 3), "ch"), L("  ", ""),
      L(presetLabel ?? "--", "val", "base"), L(" ", ""), L(pad(p.name.toUpperCase(), 16), "val", "name"), L("   ", "")],
    [L("MODE", "sys"), L("=", "eq"), L(pad(MODES[p.mode], 5), "val", "mode"), L(" ", ""), L("FX", "sys"), L("=", "eq"),
      L(pad(FX[p.fx], 5), "val", "fx"), L(" ", ""), L("P1", "mod"), L("=", "eq"), sv(PADDLE_MODES[st.pad1][0], "pad1"), L("/", setupOk("pad1") ? "val" : "dim"), sv(FIRE_MODES[st.fire1][0], "fire1"), L(" ", ""),
      L("P2", "mod"), L("=", "eq"), sv(PADDLE_MODES[st.pad2][0], "pad2"), L("/", setupOk("pad2") ? "val" : "dim"), sv(FIRE_MODES[st.fire2][0], "fire2")],
    [L("OSC", "osc"), L("=", "eq"), ...osc, L(" ", ""), L("PW", "osc"), eq("pw"), L(pad(num(v.pw >> 1, 3), 4), "val", "pw"),
      L(" ", ""), L("OCT", "osc"), L("=", "eq"), L(String(p.oct), "val", "oct"), L(" ", ""), L("TUN", "osc"), L("=", "eq"),
      L(num(TUNINGS[p.tune], 3), "val", "tune"), L(" ", ""), L("VIB", "mod"), L("=", "eq"),
      L(num(p.vibD, 2), "val", "vibD"), L("/", "val"), L(String(p.vibS), "val", "vibS")],
    [L("FLT", "flt"), fltSame ? L("=", "eq") : L("*", "diff"), L(pad(fltOn, 3), "val", "flt"), L(" ", ""), L("CUT", "flt"), L("=", "eq"),
      L(pad(num(p.cut >> 1, 3), 4), "val", "cut"), L(" ", ""), L("RES", "flt"), L("=", "eq"), L(num(p.res, 2), "val", "res"),
      L("       ", ""), L("VID", "sys"), L("=", "eq"), sv(VID_STATES[st.vid][0], "vid"), L("/", setupOk("vid") ? "val" : "dim"), sv(String(st.pat + 1), "pat")],
    [L("VOL", "amp"), L("=", "eq"), L(num(p.vol, 2), "val", "vol"), L(" ", ""), L("A", "amp"), eq("a"), L(num(v.a, 2), "val", "a"), L(" ", ""),
      L("D", "amp"), eq("d"), L(num(v.d, 2), "val", "d"), L(" ", ""), L("S", "amp"), eq("s"), L(num(v.s, 2), "val", "s"), L(" ", ""),
      L("R", "amp"), eq("r"), L(num(v.r, 2), "val", "r"), L(" ", ""), L("TRM", "mod"), L("=", "eq"),
      L(num(p.trmD, 2), "val", "trmD"), L("/", "val"), L(num(p.trmS, 2), "val", "trmS")],
  ];
}

// ---------------------------------------------------------------- modulation timing
// The main loop isn't frame-locked: about 138 passes per second with a note playing (emulator, NTSC).
export const PASSES_PER_SEC = 138;
/** Vibrato LFO speeds 0-3 in Hz (measured in the emulator; a stepped triangle). */
export const VIB_HZ = [1.08, 1.52, 4.55, 8.8];
// tremolo phase increments per pass (cynthextra.asm trmRateL/H): a 16-bit triangle LFO
const TRM_INC = [44, 51, 60, 71, 83, 98, 115, 135, 159, 187, 220, 259, 304, 357, 420, 494, 580, 682, 802, 942,
  1107, 1302, 1530, 1798, 2114, 2485, 2921, 3433, 4035, 4743, 5575, 6554];
export const trmHz = (s) => (TRM_INC[clamp(s, 0, 31)] * PASSES_PER_SEC) / 65536;
/** The firmware's tremolo output for a triangle phase t (0-1): volume - (tri * depth) / 16, never below 0. */
export function trmLevel(vol, depth, t) {
  const tri = Math.floor((t < 0.5 ? t * 2 : 2 - t * 2) * 127.99) >> 3; // 0-15
  return depth ? Math.max(0, vol - ((tri * depth) >> 4)) : vol;
}

