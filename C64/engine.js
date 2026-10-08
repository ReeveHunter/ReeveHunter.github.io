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
const P = { CH: 0, PRESET: 1, MODE: 2, FX: 3, OSC: 6, PW: 7, OCT: 8, TUN: 9, VIB: 10, FLT: 11,
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

/** Random patch with the firmware's guards (no 6CHAN, no silent PW, VOL 8-15, a real filter type). */
export function randomPatch(from, rnd = Math.random) {
  const r = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const p = structuredClone(from);
  p.name = "Random";
  p.mode = r(0, 14); p.fx = r(0, 8);
  p.vibD = r(0, 31); p.vibS = r(0, 3); p.trmD = r(0, 15); p.trmS = r(0, 31);
  p.fType = r(1, 7); p.cut = r(0, 127) * 2; p.res = r(0, 15); p.vol = r(8, 15);
  for (const v of p.voices) {
    v.wave = r(0, 3); v.mod = r(0, 3); v.pw = r(12, 115) * 2; v.flt = r(0, 1);
    v.a = r(0, 15); v.d = r(0, 15); v.s = r(0, 15); v.r = r(0, 15);
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
export function headerRows(p, { channel = null, presetLabel = null } = {}) {
  const L = (t, c) => [t, c];
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  const num = (v, n) => String(v).padStart(n);
  const ch = channel == null ? "ALL" : num(channel, 2) + " ";
  const vSame = (k) => p.voices.every((v) => v[k] === p.voices[0][k]);
  const eq = (k) => (vSame(k) ? ["=", "eq"] : ["*", "diff"]);
  // one letter per voice; R = triangle + ring, reverse video = sync
  const osc = p.voices.map((v) => L(v.wave === 0 && v.mod & 1 ? "R" : WAVES[v.wave], v.mod & 2 ? "val rev" : "val"));
  const fltOn = p.voices[0].flt ? FILTER_TYPES[p.fType] : "OFF";
  const fltSame = p.voices.every((v) => v.flt === p.voices[0].flt);
  const v = p.voices[0];
  return [
    [L("CYNTHCART ", "title"), L("CH", "sys"), L("=", "eq"), L(pad(ch, 3), "val"), L("  ", ""),
      L(presetLabel ?? "--", "val"), L(" ", ""), L(pad(p.name.toUpperCase(), 16), "val"), L("   ", "")],
    [L("MODE", "sys"), L("=", "eq"), L(pad(MODES[p.mode], 5), "val"), L(" ", ""), L("FX", "sys"), L("=", "eq"),
      L(pad(FX[p.fx], 5), "val"), L(" ", ""), L("P1", "mod"), L("=", "eq"), L("---/P-", "dim"), L(" ", ""),
      L("P2", "mod"), L("=", "eq"), L("---/P+", "dim")],
    [L("OSC", "osc"), L("=", "eq"), ...osc, L(" ", ""), L("PW", "osc"), eq("pw"), L(pad(num(v.pw >> 1, 3), 4), "val"),
      L(" ", ""), L("OCT", "osc"), L("=", "eq"), L(String(p.oct), "val"), L(" ", ""), L("TUN", "osc"), L("=", "eq"),
      L(num(TUNINGS[p.tune], 3), "val"), L(" ", ""), L("VIB", "mod"), L("=", "eq"),
      L(num(p.vibD, 2) + "/" + p.vibS, "val")],
    [L("FLT", "flt"), fltSame ? L("=", "eq") : L("*", "diff"), L(pad(fltOn, 3), "val"), L(" ", ""), L("CUT", "flt"), L("=", "eq"),
      L(pad(num(p.cut >> 1, 3), 4), "val"), L(" ", ""), L("RES", "flt"), L("=", "eq"), L(num(p.res, 2), "val"),
      L("       ", ""), L("VID", "sys"), L("=", "eq"), L("-----", "dim")],
    [L("VOL", "amp"), L("=", "eq"), L(num(p.vol, 2), "val"), L(" ", ""), L("A", "amp"), eq("a"), L(num(v.a, 2), "val"), L(" ", ""),
      L("D", "amp"), eq("d"), L(num(v.d, 2), "val"), L(" ", ""), L("S", "amp"), eq("s"), L(num(v.s, 2), "val"), L(" ", ""),
      L("R", "amp"), eq("r"), L(num(v.r, 2), "val"), L(" ", ""), L("TRM", "mod"), L("=", "eq"),
      L(num(p.trmD, 2) + "/" + num(p.trmS, 2), "val")],
  ];
}
