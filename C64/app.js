// app.js - UI for the Cynthcart controller
import {
  MODES, FX, WAVES, WAVE_NAMES, MODS, FILTER_TYPES, TUNINGS, VIB_LEVELS, TARGETS, GLOBAL_PARAMS, VOICE_PARAMS,
  supports, why, patchFromPreset, normalizePatch, patchToFile, randomPatch, RANDOM_KEYS,
  VIB_HZ, PASSES_PER_SEC, trmHz, trmLevel,
  PADDLE_MODES, FIRE_MODES, VID_STATES, CHANNELS, SETUP_PARAMS, normalizeSetup, setupSupported, setupMessages, allSetupMessages,
  editMessages, patchMessages, voiceSelectCC, headerRows, isV20,
} from "./engine.js";
import { PRESETS } from "./presets.js";
import { Midi, hex } from "./midi.js";
import { FilterGraph } from "./filtergraph.js";

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k != null) e.append(k);
  return e;
};

// ------------------------------------------------------------ storage
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem("cynthcart." + key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, v) { try { localStorage.setItem("cynthcart." + key, JSON.stringify(v)); } catch {} },
};

const settings = Object.assign(
  { outId: "", inId: "", ch: 1, target: "sx", live: true, link: true, kbdBase: 48, locks: {} },
  store.get("settings", {}),
);
if (!TARGETS[settings.target]) settings.target = "sx";
if (!settings.locks || typeof settings.locks !== "object") settings.locks = {};
settings.setup = normalizeSetup(settings.setup); // paddles, fire buttons, video, Cynthcart's channel
settings.kbdBase = Math.max(12, Math.min(96, settings.kbdBase));
const saveSettings = () => store.set("settings", settings);

let library = store.get("library", []).filter((e) => e && e.patch);
const saveLibrary = () => store.set("library", library);

let patch = normalizePatch(store.get("current", null) ?? patchFromPreset(17));
let currentId = store.get("currentId", null);
const saveCurrent = () => { store.set("current", patch); store.set("currentId", currentId); };

const midi = new Midi();
const chan = () => settings.ch - 1;

// ------------------------------------------------------------ controls
// Each control: { el, update() } - update() reads the patch and the target.
const controls = [];

function slider({ get, set, min, max, step = 1, show = String, label, cls = "" }) {
  const fill = el("div", { className: "fill" });
  const out = el("output");
  const track = el("div", { className: "slider", tabIndex: 0, role: "slider" }, el("div", { className: "ticks" }), fill);
  track.setAttribute("aria-label", label);
  track.setAttribute("aria-valuemin", min);
  track.setAttribute("aria-valuemax", max);
  const n = (max - min) / step;
  track.querySelector(".ticks").style.backgroundSize = n <= 32 ? `${100 / n}% 100%` : `${100 / 16}% 100%`;
  const fromX = (x) => {
    const r = track.getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (x - r.left) / r.width));
    return min + Math.round(f * n) * step;
  };
  let dragging = false;
  track.addEventListener("pointerdown", (e) => {
    if (track.closest(".na")) return;
    dragging = true;
    track.setPointerCapture(e.pointerId);
    track.classList.add("active");
    set(fromX(e.clientX));
    e.preventDefault();
  });
  track.addEventListener("pointermove", (e) => { if (dragging) set(fromX(e.clientX)); });
  const end = () => { dragging = false; track.classList.remove("active"); };
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);
  track.addEventListener("keydown", (e) => {
    const v = get();
    const big = Math.max(step, Math.round(n / 8) * step);
    const k = { ArrowRight: step, ArrowUp: step, ArrowLeft: -step, ArrowDown: -step, PageUp: big, PageDown: -big }[e.key];
    if (k) { set(Math.min(max, Math.max(min, v + k))); e.preventDefault(); }
    else if (e.key === "Home") { set(min); e.preventDefault(); }
    else if (e.key === "End") { set(max); e.preventDefault(); }
  });
  const wrap = el("div", { className: "slider-wrap " + cls }, track);
  return {
    el: wrap, out,
    update() {
      const v = get();
      fill.style.width = `${((v - min) / (max - min)) * 100}%`;
      out.value = show(v);
      track.setAttribute("aria-valuenow", v);
      track.setAttribute("aria-valuetext", show(v));
    },
  };
}

function seg({ get, set, options, label, multi = false, short = null }) {
  const box = el("div", { className: "seg", role: multi ? "group" : "radiogroup" });
  box.setAttribute("aria-label", label);
  const btns = options.map((o, i) => {
    const b = el("button", { type: "button", title: o });
    if (short) b.append(el("span", { className: "long", textContent: o }), el("span", { className: "short", textContent: short[i] }));
    else b.textContent = o;
    b.addEventListener("click", () => { if (!box.closest(".na")) set(i); });
    box.append(b);
    return b;
  });
  return {
    el: box,
    update() {
      const v = get();
      btns.forEach((b, i) => b.setAttribute("aria-pressed", multi ? String(!!(v & (1 << i))) : String(v === i)));
    },
    buttons: btns,
  };
}

function select({ get, set, options, label }) {
  const s = el("select");
  s.setAttribute("aria-label", label);
  options.forEach((o, i) => s.append(el("option", { value: i, textContent: o })));
  s.addEventListener("change", () => set(Number(s.value)));
  return { el: s, update() { s.value = get(); } };
}

// ---- locks: a locked parameter is left alone by the dice
const LOCKABLE = new Set([...RANDOM_KEYS, "vol"]);
const lockButtons = [];
function lockBtn(key, label) {
  if (!LOCKABLE.has(key)) return null;
  const b = el("button", { type: "button", className: "lock" });
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    settings.locks[key] = !settings.locks[key];
    if (!settings.locks[key]) delete settings.locks[key];
    saveSettings();
    updateLocks();
  });
  b.dataset.key = key;
  b.dataset.label = label;
  lockButtons.push(b);
  return b;
}
function updateLocks() {
  for (const b of lockButtons) {
    const on = !!settings.locks[b.dataset.key];
    b.textContent = on ? "🔒" : "🔓";
    b.classList.toggle("on", on);
    b.setAttribute("aria-pressed", String(on));
    b.title = on ? `${b.dataset.label} is locked: the dice leave it alone` : `Lock ${b.dataset.label.toLowerCase()} so the dice leave it alone`;
    b.setAttribute("aria-label", `Lock ${b.dataset.label}`);
  }
}

/** A labelled control for a global parameter. */
function globalCtl(container, key, kind = "slider", extra = {}) {
  const d = GLOBAL_PARAMS[key];
  const show = d.show ?? String;
  const opts = { get: () => patch[key], set: (v) => setParam(key, v), min: d.min, max: d.max, step: d.step, show, label: d.label, ...extra };
  const c = kind === "slider" ? slider(opts) : kind === "seg" ? seg(opts) : select(opts);
  const out = c.out ?? el("output", { hidden: kind === "select" });
  const lab = el("div", { className: "lab" }, el("span", { className: "lab-l" }, el("b", { textContent: extra.label ?? d.label }), lockBtn(key, d.label)), out);
  const box = el("div", { className: "ctl" }, lab, c.el);
  container.append(box);
  const ctl = {
    key, box,
    update() {
      c.update();
      if (!c.out) out.value = show(patch[key]);
      const s = supports(settings.target, key);
      box.classList.toggle("na", s === false);
      box.title = why(settings.target, key);
      extra.after?.(c);
    },
  };
  controls.push(ctl);
  return ctl;
}

// ---- global controls
globalCtl($("sysCtls"), "mode", "select", { options: MODES });
const fxCtl = globalCtl($("sysCtls"), "fx", "select", {
  options: FX,
  after: (c) => { c.el.querySelector('option[value="8"]').disabled = isV20(settings.target); },
});
globalCtl($("sysCtls"), "oct", "seg", { options: ["0", "1", "2", "3"] });
globalCtl($("sysCtls"), "tune", "slider");

// vibrato depth: 0-31 on the custom build, four levels on 2.0
const vibSlider = globalCtl($("modCtls"), "vibD", "slider");
const vibLevels = globalCtl($("modCtls"), "vibD", "seg", {
  options: VIB_LEVELS.map(String),
  get: () => VIB_LEVELS.reduce((b, d, i) => (Math.abs(d - patch.vibD) < Math.abs(VIB_LEVELS[b] - patch.vibD) ? i : b), 0),
  set: (i) => setParam("vibD", VIB_LEVELS[i]),
  label: "Vibrato depth (2.0 levels)",
});
globalCtl($("modCtls"), "vibS", "seg", { options: ["0", "1", "2", "3"] });
globalCtl($("modCtls"), "trmD", "slider");
globalCtl($("modCtls"), "trmS", "slider");

globalCtl($("fltCtls"), "cut", "slider");
globalCtl($("fltCtls"), "res", "slider");
globalCtl($("fltCtls"), "fType", "seg", { options: ["LP", "BP", "HP"], multi: true, set: (i) => setParam("fType", patch.fType ^ (1 << i)) });

globalCtl($("ampCtls"), "vol", "slider");

const fgraph = new FilterGraph($("fgraph"));
controls.push({
  update() {
    fgraph.set({
      cut: patch.cut, res: patch.res, fType: patch.fType, fx: patch.fx,
      routed: patch.voices.map((v) => !!v.flt),
      resCap: settings.target === "v20" ? 7 : 15, // stock 2.0's CC 0 stops at 7
    });
  },
});
// notes the C64 is playing, as far as this page knows (FILT2 / FILT3 follow them)
const inputHeld = new Set();
function notesChanged(isOn) {
  const n = Math.min(6, held.size + inputHeld.size);
  const mono = patch.mode === 6 || patch.mode === 7; // MONO1/MONO2 restart FILT3 on a new note only
  fgraph.notes(n, mono ? isOn : true);
}

// ---- voice grid
const vg = $("voiceGrid");
vg.append(el("div", { className: "corner" }), ...[1, 2, 3].map((n) => el("div", { className: "vh", textContent: `Voice ${n}` })));
const VOICE_ROWS = [
  ["wave", "seg", { options: WAVES }, "osc"],
  ["mod", "seg", { options: ["–", "RING", "SYNC", "R+S"], short: ["–", "R", "S", "RS"] }, "osc"],
  ["pw", "slider", {}, "osc"],
  ["flt", "seg", { options: ["OFF", "ON"] }, "flt"],
  ["a", "slider", {}, "amp"],
  ["d", "slider", {}, "amp"],
  ["s", "slider", {}, "amp"],
  ["r", "slider", {}, "amp"],
];
const voiceRows = [];
for (const [key, kind, extra, g] of VOICE_ROWS) {
  const d = VOICE_PARAMS[key];
  const show = d.show ?? String;
  const rl = el("div", { className: "rl", style: `--g2: var(--c-${g})` }, el("span", { textContent: d.label }), lockBtn(key, d.label));
  vg.append(rl);
  const cells = [0, 1, 2].map((i) => {
    const opts = { get: () => patch.voices[i][key], set: (v) => setParam(key, v, i), min: d.min, max: d.max, step: d.step, show, label: `${d.label}, voice ${i + 1}`, ...extra };
    const c = kind === "slider" ? slider(opts) : seg(opts);
    const cell = el("div", { className: `cell v${i}`, style: `--g2: var(--c-${g})` }, c.el, c.out ?? null);
    vg.append(cell);
    return { c, cell };
  });
  voiceRows.push({ key, rl, cells });
  controls.push({
    update() {
      const s = supports(settings.target, key);
      rl.classList.toggle("na", s === false || s === "fixed");
      rl.classList.toggle("part", s === "voice1");
      rl.title = why(settings.target, key);
      cells.forEach(({ c, cell }, i) => {
        c.update();
        cell.classList.toggle("na", s === false || s === "fixed" || (s === "voice1" && i > 0));
        cell.title = rl.title;
      });
    },
  });
}
// envelope sketches
vg.append(el("div", { className: "rl", style: "--g2: var(--c-amp)" }, "Envelope"));
const envs = [0, 1, 2].map(() => {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 40");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("env");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  svg.append(path);
  vg.append(el("div", { className: "cell" }, svg));
  return path;
});
controls.push({
  update() {
    patch.voices.forEach((v, i) => {
      // rough SID timing: each step is about 1.6x longer than the last
      const t = (x) => 2 + 26 * (Math.pow(1.6, x) - 1) / (Math.pow(1.6, 15) - 1);
      const a = t(v.a), d = t(v.d), r = t(v.r), hold = 18;
      const sy = 40 - (v.s / 15) * 36;
      const k = 100 / (a + d + hold + r);
      const x1 = a * k, x2 = x1 + d * k, x3 = x2 + hold * k;
      envs[i].setAttribute("d", `M0 40 L${x1} 4 L${x2} ${sy} L${x3} ${sy} L100 40 Z`);
    });
  },
});

// ---- setup card: paddles, fire buttons, video, Cynthcart's MIDI channel (not part of patches)
const SETUP_OPTIONS = {
  ch: CHANNELS.map((c, i) => (i ? `Channel ${c}` : "ALL (omni)")),
  pad1: PADDLE_MODES.map(([c, n]) => n), pad2: PADDLE_MODES.map(([c, n]) => n),
  fire1: FIRE_MODES.map(([c, n]) => `${c.trim() || "--"}  ${n}`), fire2: FIRE_MODES.map(([c, n]) => `${c.trim() || "--"}  ${n}`),
  vid: VID_STATES.map(([c, n]) => n), pat: ["1", "2", "3"],
};
const setupOk = (key) => setupSupported(settings.target, key, settings.setup);
for (const key of ["pad1", "fire1", "pad2", "fire2", "vid", "pat", "ch"]) {
  const box = $("setupCtls");
  const c = key === "pat"
    ? seg({ get: () => settings.setup.pat, set: (v) => setSetup("pat", v), options: SETUP_OPTIONS.pat, label: SETUP_PARAMS.pat.label })
    : select({ get: () => settings.setup[key], set: (v) => setSetup(key, v), options: SETUP_OPTIONS[key], label: SETUP_PARAMS[key].label });
  const ctl = el("div", { className: "ctl" }, el("div", { className: "lab" }, el("b", { textContent: SETUP_PARAMS[key].label })), c.el);
  box.append(ctl);
  controls.push({
    update() {
      c.update();
      const ok = setupOk(key) || (key === "vid" && settings.target === "cc");
      ctl.classList.toggle("na", !ok);
      ctl.title = ok ? "" : settings.target === "cc" ? "Only the SysEx firmware can set this (the CC-only build reaches video on CC 10, without full screen)." : "Cynthcart 2.0 can't set this over MIDI; use the C64's keys.";
      if (key === "vid" && c.el.tagName === "SELECT") for (const o of c.el.options) o.disabled = settings.target === "cc" && (o.value === "1" || o.value === "3");
    },
  });
}
function setSetup(key, v) {
  v = Math.max(0, Math.min(SETUP_PARAMS[key].max, v));
  if (settings.setup[key] === v) return;
  settings.setup[key] = v;
  saveSettings();
  if (settings.live) sendSetup([key]);
  if (key === "ch" && v) { // the page must send on the channel Cynthcart now listens to
    settings.ch = v; saveSettings();
    $("chSelect").value = v;
    status(`Cynthcart now listens on channel ${v}, so this page sends on ${v} too.`);
  }
  renderAll();
}
function sendSetup(keys) {
  if (!midi.output) { status("Connect a MIDI output first.", "warn"); return; }
  const t = settings.target;
  const msgs = keys ? keys.flatMap((k) => setupMessages(t, chan(), settings.setup, k) ?? []) : allSetupMessages(t, chan(), settings.setup);
  if (!msgs.length) { status(t === "cc" ? "The CC-only build can only set video (without full screen) over MIDI." : "Cynthcart 2.0 can't set these over MIDI.", "warn"); return; }
  if (msgs.some((m) => m[0] === 0xf0) && !midi.sysexAllowed) { status("SysEx isn't allowed in this browser session, so the setup can't be sent.", "warn"); return; }
  midi.flush();
  midi.sendSequence(msgs.map((msg) => ({ msg, delay: 0 })));
  if (!keys) status("Sent the setup (paddles, buttons, video, channel).", "ok");
}

// ------------------------------------------------------------ editing
function setParam(key, value, voice) {
  const perVoice = key in VOICE_PARAMS;
  const d = perVoice ? VOICE_PARAMS[key] : GLOBAL_PARAMS[key];
  value = Math.max(d.min, Math.min(d.max, value));
  let voices;
  if (perVoice) {
    voices = settings.link ? [0, 1, 2] : [voice];
    if (voices.every((i) => patch.voices[i][key] === value)) return;
    for (const i of voices) patch.voices[i][key] = value;
  } else {
    if (patch[key] === value) return;
    patch[key] = value;
  }
  renderAll();
  saveCurrentSoon();
  if (settings.live) sendEdit(key, voices);
}

function sendEdit(key, voices) {
  if (!midi.output) return;
  const e = editMessages(settings.target, chan(), patch, key, voices);
  if (!e) return;
  if (e.msgs.some((m) => m[0] === 0xf0) && !midi.sysexAllowed) { status("SysEx isn't allowed in this browser session, so this change can't be sent.", "warn"); return; }
  midi.queue(`${key}:${e.mask ?? ""}`, e.msgs, e.mask, (m) => voiceSelectCC(chan(), m));
}

let saveTimer = null;
function saveCurrentSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveCurrent, 400);
}

// ------------------------------------------------------------ rendering
const isPristine = () => {
  const b = patchFromPreset(patch.base);
  const { name: _a, ...x } = patch; const { name: _b, ...y } = b;
  return JSON.stringify(x) === JSON.stringify(y);
};

function renderScreen() {
  const pristine = isPristine();
  // the custom build with SysEx shows "--" and our name after a patch send; otherwise the preset
  const showOwn = settings.target === "sx" && !pristine;
  const view = showOwn ? patch : { ...patch, name: PRESETS[patch.base].name };
  const rows = headerRows(view, { presetLabel: showOwn ? "--" : String(patch.base).padStart(2), setup: settings.setup, setupOk });
  const scr = $("screen");
  scr.replaceChildren();
  rows.forEach((row, r) => {
    let len = 0;
    for (const [text, cls, key] of row) {
      len += text.length;
      if (key && screenEditable(key)) {
        const sp = el("span", { className: cls + " edit" + (pop.key === key ? " open" : ""), textContent: text });
        sp.dataset.key = key;
        scr.append(sp);
      } else scr.append(cls ? el("span", { className: cls, textContent: text }) : text);
    }
    scr.append(" ".repeat(Math.max(0, 40 - len)) + (r < rows.length - 1 ? "\n" : ""));
  });
}

// ------------------------------------------------------------ editing on the C64 screen
// Each value is a "spec": sections of { key, voice, options | range }. Drag a value up/down to
// step its first section; click for a small menu with every section.
const opt = (key, options, extra = {}) => ({ key, options, ...extra });
const rng = (key, extra = {}) => ({ key, range: true, ...extra });
const sopt = (key, extra = {}) => ({ key, setup: true, options: SETUP_OPTIONS[key], label: SETUP_PARAMS[key].label, ...extra });
const voiceLabel = (k, i = 0) => `${VOICE_PARAMS[k].label}${settings.link ? "" : `, voice ${i + 1}`}`;
const SCREEN_SPECS = {
  base: () => [opt("base", PRESETS.map((p, i) => `${String(i).padStart(2, "0")} ${p.name}`), { label: "Base preset", list: true })],
  mode: () => [opt("mode", MODES)],
  fx: () => [opt("fx", FX)],
  osc0: () => [opt("wave", WAVE_NAMES, { voice: 0, label: "Waveform, voice 1" }), opt("mod", MODS, { voice: 0, label: "Ring / sync, voice 1" })],
  osc1: () => [opt("wave", WAVE_NAMES, { voice: 1, label: "Waveform, voice 2" }), opt("mod", MODS, { voice: 1, label: "Ring / sync, voice 2" })],
  osc2: () => [opt("wave", WAVE_NAMES, { voice: 2, label: "Waveform, voice 3" }), opt("mod", MODS, { voice: 2, label: "Ring / sync, voice 3" })],
  pw: () => [rng("pw", { voice: 0, label: voiceLabel("pw") })],
  oct: () => [opt("oct", ["0", "1", "2", "3"])],
  tune: () => [opt("tune", TUNINGS.map((t) => t + "¢"))],
  vibD: () => [rng("vibD")],
  vibS: () => [opt("vibS", ["0", "1", "2", "3"])],
  flt: () => [opt("fType", FILTER_TYPES.slice(1), { offset: 1 }), opt("flt", ["OFF", "ON"], { voice: 0, label: voiceLabel("flt") })],
  cut: () => [rng("cut")],
  res: () => [rng("res")],
  vol: () => [rng("vol")],
  a: () => [rng("a", { voice: 0, label: voiceLabel("a") })],
  d: () => [rng("d", { voice: 0, label: voiceLabel("d") })],
  s: () => [rng("s", { voice: 0, label: voiceLabel("s") })],
  r: () => [rng("r", { voice: 0, label: voiceLabel("r") })],
  trmD: () => [rng("trmD")],
  trmS: () => [rng("trmS")],
  ch: () => [sopt("ch", { list: true })],
  pad1: () => [sopt("pad1", { list: true })],
  fire1: () => [sopt("fire1", { list: true })],
  pad2: () => [sopt("pad2", { list: true })],
  fire2: () => [sopt("fire2", { list: true })],
  vid: () => [sopt("vid"), sopt("pat")],
  pat: () => [sopt("pat"), sopt("vid")],
};
const paramDef = (k) => (k in VOICE_PARAMS ? VOICE_PARAMS[k] : k in GLOBAL_PARAMS ? GLOBAL_PARAMS[k] : { min: 0, max: SETUP_PARAMS[k].max, label: SETUP_PARAMS[k].label });
const sectionOk = (sec) => {
  if (sec.key === "base") return true;
  if (sec.setup) return setupOk(sec.key) || (sec.key === "vid" && settings.target === "cc");
  const ok = supports(settings.target, sec.key);
  return ok !== false && ok !== "fixed" && !(ok === "voice1" && sec.voice > 0);
};
const sections = (key) => (SCREEN_SPECS[key] ? SCREEN_SPECS[key]().filter(sectionOk) : []);
function screenEditable(key) { return key === "name" || sections(key).length > 0; }
const secGet = (sec) => sec.setup ? settings.setup[sec.key] : sec.key === "base" ? patch.base : sec.voice != null ? patch.voices[sec.voice][sec.key] : patch[sec.key];
function secSet(sec, v) {
  if (sec.key === "base") { setBase(v); return; }
  if (sec.setup) { setSetup(sec.key, v); return; }
  setParam(sec.key, v, sec.voice ?? 0);
}
// the menu ("pop") under a clicked value
const pop = { key: null, update: null };
function closePop() {
  pop.key = null; pop.update = null;
  $("pop").hidden = true;
  $("pop").replaceChildren();
  for (const e of $("screen").querySelectorAll(".edit.open")) e.classList.remove("open");
}
function openPop(span) {
  const key = span.dataset.key;
  if (key === "name") { $("nameInput").focus(); $("nameInput").select(); return; }
  const secs = sections(key);
  const box = $("pop");
  box.replaceChildren();
  const updaters = [];
  for (const sec of secs) {
    const d = sec.key === "base" || sec.setup ? null : paramDef(sec.key);
    const title = sec.label ?? d.label;
    box.append(el("div", { className: "pop-t", textContent: title }));
    if (sec.range) {
      const sl = slider({ get: () => secGet(sec), set: (v) => secSet(sec, v), min: d.min, max: d.max, step: d.step, show: d.show ?? String, label: title });
      box.append(el("div", { className: "pop-range" }, sl.el, sl.out));
      updaters.push(sl.update);
    } else {
      const grid = el("div", { className: "pop-opts" + (sec.list ? " list" : "") });
      const off = sec.offset ?? 0;
      const btns = sec.options.map((o, i) => {
        const b = el("button", { type: "button", textContent: o });
        if (sec.key === "fx" && i === 8 && isV20(settings.target)) b.disabled = true;
        if (sec.key === "vid" && (i === 1 || i === 3) && settings.target === "cc") b.disabled = true;
        b.addEventListener("click", () => { secSet(sec, i + off); if (sec.list) closePop(); });
        grid.append(b);
        return b;
      });
      box.append(grid);
      updaters.push(() => btns.forEach((b, i) => b.setAttribute("aria-pressed", String(secGet(sec) === i + off))));
    }
  }
  pop.key = key;
  pop.update = () => updaters.forEach((u) => u());
  pop.update();
  box.hidden = false;
  // place it under the value, kept inside the screen area
  const wrap = box.parentElement.getBoundingClientRect(), r = span.getBoundingClientRect();
  const w = Math.min(box.offsetWidth, wrap.width - 16);
  box.style.left = `${Math.max(8, Math.min(r.left - wrap.left, wrap.width - w - 8))}px`;
  box.style.top = `${r.bottom - wrap.top + 6}px`;
  span.classList.add("open");
  box.querySelector('button[aria-pressed="true"]') ?? box.querySelector("button, .slider")?.focus({ preventScroll: true });
}
// drag up/down to step the value's first section
let drag = null;
$("screen").addEventListener("pointerdown", (e) => {
  const span = e.target.closest(".edit");
  if (!span) return;
  e.preventDefault();
  const sec = sections(span.dataset.key)[0];
  const d = sec && sec.key !== "base" && sec.key !== "ch" ? paramDef(sec.key) : null; // (the channel: menu only)
  drag = { span, key: span.dataset.key, sec, d, y: e.clientY, moved: false, start: sec ? secGet(sec) : 0, id: e.pointerId };
  $("screen").setPointerCapture(e.pointerId);
});
$("screen").addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.id || !drag.d) return;
  const dy = drag.y - e.clientY;
  if (!drag.moved && Math.abs(dy) < 5) return;
  if (!drag.moved) { drag.moved = true; closePop(); $("screen").classList.add("dragging"); }
  const { d, sec } = drag;
  const step = d.step ?? 1;
  const n = (d.max - d.min) / step;
  const px = n > 40 ? 3 : n > 15 ? 6 : 12; // pixels per step
  const lo = sec.offset ?? d.min;
  const v = Math.max(lo, Math.min(d.max, drag.start + Math.round(dy / px) * step));
  if (v !== secGet(sec)) secSet(sec, v);
});
const dragEnd = (e) => {
  if (!drag || e.pointerId !== drag.id) return;
  const { moved, key } = drag;
  drag = null;
  $("screen").classList.remove("dragging");
  if (moved) return;
  if (pop.key === key) { closePop(); return; }
  const span = [...$("screen").querySelectorAll(".edit")].find((s) => s.dataset.key === key);
  if (span) openPop(span);
};
$("screen").addEventListener("pointerup", dragEnd);
$("screen").addEventListener("pointercancel", (e) => { if (drag && e.pointerId === drag.id) { drag = null; $("screen").classList.remove("dragging"); } });
document.addEventListener("pointerdown", (e) => {
  if (pop.key && !e.target.closest("#pop") && !e.target.closest("#screen .edit")) closePop();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && pop.key) closePop(); });

// ------------------------------------------------------------ vibrato and tremolo pictures
// What the C64 does over a few seconds: vibrato as pitch around the note (a stepped triangle),
// tremolo as the SID volume the firmware writes each pass. Slow tremolo gets a longer window
// (up to 8 s) so a whole cycle shows. A cursor runs across in real time.
const svgNS = "http://www.w3.org/2000/svg";
function vizPanel(title, cls) {
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 200 60");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.classList.add("viz", cls);
  const mk = (tag, c) => { const n = document.createElementNS(svgNS, tag); if (c) n.setAttribute("class", c); svg.append(n); return n; };
  const mid = mk("line", "mid"), path = mk("path", "wave"), cursor = mk("line", "cursor");
  const read = el("output", { className: "viz-read" });
  const span = el("small", { className: "viz-span" });
  const box = el("figure", { className: "viz-box" }, el("figcaption", {}, el("b", {}, title, " ", span), read), svg);
  return { box, svg, mid, path, cursor, read, span, secs: 2 };
}
const vibViz = vizPanel("Vibrato", "vib");
const trmViz = vizPanel("Tremolo", "trm");
$("modviz").append(vibViz.box, trmViz.box);
function drawViz() {
  let passes = vibViz.secs * PASSES_PER_SEC;
  let X = (i) => (i / passes) * 200;
  vibViz.span.textContent = `· ${vibViz.secs} s`;
  // vibrato: stepped triangle, height from the depth (0-31)
  const hz = VIB_HZ[patch.vibS], amp = (patch.vibD / 31) * 26;
  vibViz.mid.setAttribute("x1", 0); vibViz.mid.setAttribute("x2", 200); vibViz.mid.setAttribute("y1", 30); vibViz.mid.setAttribute("y2", 30);
  let d = "";
  for (let i = 0; i <= passes; i++) {
    const t = (i * hz / PASSES_PER_SEC) % 1;
    const tri = t < 0.5 ? t * 4 - 1 : 3 - t * 4; // -1..1
    const y = 30 - Math.round(tri * 3) / 3 * amp; // a few steps, like the LFO
    d += (i ? "L" : "M") + X(i).toFixed(1) + " " + y.toFixed(1);
  }
  vibViz.path.setAttribute("d", d);
  vibViz.read.value = patch.vibD ? `≈${hz.toFixed(1)} Hz · depth ${patch.vibD}` : "off";
  vibViz.box.classList.toggle("off", !patch.vibD);
  // tremolo: the volume the firmware writes, pass by pass
  const tna = supports(settings.target, "trmD") === false;
  const thz = trmHz(patch.trmS);
  trmViz.secs = Math.max(2, Math.min(8, Math.ceil(1.25 / thz)));
  trmViz.span.textContent = `· ${trmViz.secs} s`;
  passes = trmViz.secs * PASSES_PER_SEC;
  X = (i) => (i / passes) * 200;
  let td = "", lo = 15;
  for (let i = 0; i <= passes; i++) {
    const lvl = trmLevel(patch.vol, tna ? 0 : patch.trmD, (i * thz / PASSES_PER_SEC) % 1);
    lo = Math.min(lo, lvl);
    td += (i ? "L" : "M") + X(i).toFixed(1) + " " + (56 - (lvl / 15) * 52).toFixed(1);
  }
  trmViz.mid.setAttribute("x1", 0); trmViz.mid.setAttribute("x2", 200); trmViz.mid.setAttribute("y1", 56); trmViz.mid.setAttribute("y2", 56);
  trmViz.path.setAttribute("d", td);
  trmViz.read.value = tna ? "not on 2.0" : patch.trmD ? `≈${thz < 1 ? thz.toFixed(2) : thz.toFixed(1)} Hz · VOL ${patch.vol}→${lo}` : "off";
  trmViz.box.classList.toggle("off", tna || !patch.trmD);
}
controls.push({ update: drawViz });
const still = matchMedia("(prefers-reduced-motion: reduce)");
function tickViz(now) {
  for (const v of [vibViz, trmViz]) {
    const x = ((now / 1000) % v.secs) / v.secs * 200;
    const on = !still.matches && !v.box.classList.contains("off");
    v.cursor.style.display = on ? "" : "none";
    if (on) { v.cursor.setAttribute("x1", x); v.cursor.setAttribute("x2", x); v.cursor.setAttribute("y1", 0); v.cursor.setAttribute("y2", 60); }
  }
  requestAnimationFrame(tickViz);
}
requestAnimationFrame(tickViz);

function renderAll() {
  for (const c of controls) c.update();
  updateLocks();
  pop.update?.();
  const v20 = isV20(settings.target);
  vibSlider.box.hidden = v20;
  vibLevels.box.hidden = !v20;
  document.body.classList.toggle("linked", settings.link);
  if (document.activeElement !== $("nameInput")) $("nameInput").value = patch.name;
  $("baseSelect").value = patch.base;
  renderScreen();
}

// ------------------------------------------------------------ status, log
let statusTimer = null;
function status(text, kind = "") {
  const s = $("patchStatus");
  s.textContent = text;
  s.className = "status " + kind;
  clearTimeout(statusTimer);
  if (kind !== "warn") statusTimer = setTimeout(() => { s.textContent = ""; }, 6000);
}
const logLines = [];
midi.onLog = (msg, err) => {
  const t = new Date().toLocaleTimeString([], { hour12: false });
  logLines.push(err ? `${t}  error: ${err}` : `${t}  ${hex(msg)}`);
  if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
  if ($("log").closest("details").open) $("log").textContent = logLines.join("\n");
};
$("log").closest("details").addEventListener("toggle", () => { $("log").textContent = logLines.join("\n"); });

// ------------------------------------------------------------ connection
function fillPorts() {
  const outs = midi.outputs();
  const os = $("outSelect");
  os.replaceChildren(...(outs.length ? outs.map((o) => el("option", { value: o.id, textContent: o.name })) : [el("option", { value: "", textContent: "No MIDI outputs" })]));
  os.disabled = !outs.length;
  if (outs.some((o) => o.id === settings.outId)) os.value = settings.outId;
  midi.setOutput(os.value);
  const ins = midi.inputs();
  const is = $("inSelect");
  is.replaceChildren(el("option", { value: "", textContent: "None" }), ...ins.map((i) => el("option", { value: i.id, textContent: i.name })));
  is.disabled = !ins.length;
  is.value = ins.some((i) => i.id === settings.inId) ? settings.inId : "";
  midi.setInput(is.value);
  $("statusDot").className = "dot" + (midi.output ? " on" : "");
  $("sysexNote").hidden = midi.sysexAllowed || settings.target !== "sx";
  $("connectBtn").hidden = true;
}
midi.onChange = fillPorts;

async function connect() {
  try {
    await midi.connect();
    store.set("connected", true);
  } catch (e) {
    $("statusDot").className = "dot err";
    status("MIDI access wasn't granted: " + e.message, "warn");
  }
}
$("connectBtn").addEventListener("click", connect);
$("outSelect").addEventListener("change", (e) => { settings.outId = e.target.value; saveSettings(); midi.setOutput(settings.outId); fillPorts(); });
$("inSelect").addEventListener("change", (e) => { settings.inId = e.target.value; saveSettings(); midi.setInput(settings.inId); });

for (let c = 1; c <= 16; c++) $("chSelect").append(el("option", { value: c, textContent: c }));
$("chSelect").value = settings.ch;
$("chSelect").addEventListener("change", (e) => { settings.ch = Number(e.target.value); saveSettings(); });

for (const [k, t] of Object.entries(TARGETS)) $("targetSelect").append(el("option", { value: k, textContent: t.label }));
$("targetSelect").value = settings.target;
$("targetSelect").addEventListener("change", (e) => {
  settings.target = e.target.value;
  saveSettings();
  $("sysexNote").hidden = !midi.access || midi.sysexAllowed || settings.target !== "sx";
  renderAll();
});

// MIDI keyboard pass-through, on our channel
midi.onInput = (data) => {
  const st = data[0];
  if (st < 0x80 || st >= 0xf0) return; // channel messages only
  const type = st & 0xf0;
  midi.send([type | chan(), ...data.slice(1)]);
  if (type === 0x90 && data[2] > 0) { inputHeld.add(data[1]); notesChanged(true); }
  else if (type === 0x80 || type === 0x90) { if (inputHeld.delete(data[1])) notesChanged(false); }
};

// ------------------------------------------------------------ patch bar
PRESETS.forEach((p, i) => $("baseSelect").append(el("option", { value: i, textContent: `${String(i).padStart(2, "0")}  ${p.name}` })));
$("baseSelect").addEventListener("change", (e) => setBase(Number(e.target.value)));
function setBase(n) {
  patch = patchFromPreset(n);
  currentId = null;
  renderAll();
  saveCurrent();
  if (settings.live && midi.output) { midi.flush(); midi.send([0xc0 | chan(), n]); status(`Loaded preset ${n}.`); }
}
$("nameInput").addEventListener("input", (e) => { patch.name = e.target.value.slice(0, 16); renderScreen(); saveCurrentSoon(); });

function sendPatch() {
  if (!midi.output) { status("Connect a MIDI output first.", "warn"); return; }
  const t = settings.target;
  if (t === "sx" && !midi.sysexAllowed) { status("SysEx isn't allowed in this browser session; pick “Custom build (CC only)” or allow SysEx and reconnect.", "warn"); return; }
  const { steps, unreachable } = patchMessages(t, chan(), patch);
  const ms = midi.sendSequence(steps, t === "cc");
  const what = `Sent “${patch.name}” (${steps.length} message${steps.length > 1 ? "s" : ""}, ${Math.round(ms)} ms).`;
  if (unreachable.length) status(`${what} Not reachable on ${TARGETS[t].short}, so left as in the preset: ${unreachable.join(", ")}.`, "warn");
  else status(what, "ok");
}
$("sendBtn").addEventListener("click", sendPatch);
$("sendSetupBtn").addEventListener("click", () => sendSetup());

// ---- dice: the big one randomizes every unlocked parameter (not volume, octave or tuning),
// each card's randomizes that card. Linked voices get one value for all three.
$("randomBtn").addEventListener("click", () => {
  patch = randomPatch(patch, Math.random, { locks: settings.locks, link: settings.link });
  currentId = null;
  renderAll();
  saveCurrent();
  if (settings.live) sendPatch();
  status("Randomized every unlocked parameter (volume, octave and tuning stay).");
});
const CARD_KEYS = {
  sys: ["mode", "fx"],
  mod: ["vibD", "vibS", "trmD", "trmS"],
  flt: ["cut", "res", "fType"],
  amp: ["vol"],
  voices: ["wave", "mod", "pw", "flt", "a", "d", "s", "r"],
};
for (const btn of document.querySelectorAll("[data-dice]")) {
  btn.addEventListener("click", () => {
    const keys = CARD_KEYS[btn.dataset.dice].filter((k) => !settings.locks[k]);
    if (!keys.length) { status("Everything in this card is locked.", "warn"); return; }
    patch = randomPatch(patch, Math.random, { keys, link: settings.link });
    currentId = null;
    renderAll();
    saveCurrentSoon();
    if (settings.live) {
      for (const k of keys) {
        if (k in VOICE_PARAMS) {
          if (settings.link) sendEdit(k, [0, 1, 2]);
          else for (const i of [0, 1, 2]) sendEdit(k, [i]);
        } else sendEdit(k);
      }
    }
  });
}

$("liveToggle").checked = settings.live;
$("liveToggle").addEventListener("change", (e) => { settings.live = e.target.checked; saveSettings(); });
$("linkToggle").checked = settings.link;
$("linkToggle").addEventListener("change", (e) => {
  settings.link = e.target.checked;
  saveSettings();
  if (settings.link) { // linking copies voice 1 to the others
    patch.voices = patch.voices.map(() => ({ ...patch.voices[0] }));
    renderAll();
    if (settings.live) for (const k of Object.keys(VOICE_PARAMS)) sendEdit(k, [0, 1, 2]);
  }
  renderAll();
});

// ------------------------------------------------------------ library
const uid = () => Math.random().toString(36).slice(2, 10);
function renderLibrary() {
  const list = $("libList");
  list.replaceChildren();
  $("libCount").textContent = library.length ? `(${library.length})` : "";
  $("libEmpty").hidden = library.length > 0;
  for (const entry of library) {
    const name = el("button", { className: "lib-name", type: "button" }, entry.patch.name || "Untitled",
      el("small", { textContent: `${String(entry.patch.base).padStart(2, "0")} ${PRESETS[entry.patch.base].name.toLowerCase()} · ${new Date(entry.savedAt).toLocaleDateString()}` }));
    name.addEventListener("click", () => {
      patch = normalizePatch(entry.patch);
      currentId = entry.id;
      renderAll();
      renderLibrary();
      saveCurrent();
      if (settings.live) sendPatch(); else status(`Loaded “${patch.name}”. Send it to hear it.`);
    });
    const exp = el("button", { className: "icon-btn", type: "button", title: "Export as a file", textContent: "⤓" });
    exp.addEventListener("click", () => download(`${fileName(entry.patch.name)}.json`, patchToFile(entry.patch)));
    const del = el("button", { className: "icon-btn del", type: "button", title: "Delete", textContent: "✕" });
    del.addEventListener("click", () => {
      if (del.dataset.armed) {
        library = library.filter((e) => e !== entry);
        if (currentId === entry.id) currentId = null;
        saveLibrary(); renderLibrary();
      } else {
        del.dataset.armed = "1"; del.textContent = "Delete?"; del.style.fontSize = "12px";
        setTimeout(() => { delete del.dataset.armed; del.textContent = "✕"; del.style.fontSize = ""; }, 2500);
      }
    });
    list.append(el("li", { className: entry.id === currentId ? "current" : "" }, name, exp, del));
  }
}
$("saveBtn").addEventListener("click", () => {
  const existing = library.find((e) => e.id === currentId);
  if (existing && existing.patch.name === patch.name) {
    existing.patch = structuredClone(patch);
    existing.savedAt = Date.now();
    status(`Saved “${patch.name}”.`, "ok");
  } else {
    const entry = { id: uid(), savedAt: Date.now(), patch: structuredClone(patch) };
    library.unshift(entry);
    currentId = entry.id;
    status(`Saved “${patch.name}” as a new patch.`, "ok");
  }
  saveLibrary(); saveCurrent(); renderLibrary();
});
$("libraryBtn").addEventListener("click", () => {
  const lib = $("library");
  lib.hidden = !lib.hidden;
  $("libraryBtn").setAttribute("aria-expanded", String(!lib.hidden));
});
$("exportAllBtn").addEventListener("click", () => {
  download("cynthcart-patches.json", { format: "cynthcart-patches", version: 1, patches: library.map((e) => patchToFile(e.patch)) });
});
$("importBtn").addEventListener("click", () => $("importFile").click());
$("importFile").addEventListener("change", async (e) => {
  let n = 0;
  for (const f of e.target.files) {
    try {
      const data = JSON.parse(await f.text());
      const list = data.format === "cynthcart-patches" ? data.patches : [data];
      for (const raw of list) {
        library.unshift({ id: uid(), savedAt: Date.now(), patch: normalizePatch(raw) });
        n++;
      }
    } catch (err) {
      status(`Couldn't read ${f.name}: ${err.message}`, "warn");
    }
  }
  e.target.value = "";
  saveLibrary(); renderLibrary();
  if (n) status(`Imported ${n} patch${n > 1 ? "es" : ""}.`, "ok");
});
const fileName = (s) => (s || "patch").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").toLowerCase() || "patch";
function download(name, obj) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" }));
  const a = el("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------ keyboard
const held = new Set();
const noteOn = (n) => { held.add(n); midi.send([0x90 | chan(), n, 100]); keyEl(n)?.classList.add("on"); notesChanged(true); };
const noteOff = (n) => { held.delete(n); midi.send([0x80 | chan(), n, 0]); keyEl(n)?.classList.remove("on"); notesChanged(false); };
const keyEls = new Map();
const keyEl = (n) => keyEls.get(n - settings.kbdBase);
function buildPiano() {
  const p = $("piano");
  p.replaceChildren(); keyEls.clear();
  const whites = [0, 2, 4, 5, 7, 9, 11];
  const nW = 17; // C to E two octaves up: the reach of the computer-key rows
  for (let w = 0; w < nW; w++) {
    const semi = Math.floor(w / 7) * 12 + whites[w % 7];
    const k = el("div", { className: "w" });
    k.dataset.off = semi;
    if (semi % 12 === 0) k.append(el("span", { textContent: "C" + (Math.floor((settings.kbdBase + semi) / 12) - 1) }));
    p.append(k); keyEls.set(semi, k);
  }
  for (let w = 0; w < nW - 1; w++) {
    const d = whites[w % 7];
    if (d === 4 || d === 11) continue;
    const semi = Math.floor(w / 7) * 12 + d + 1;
    const k = el("div", { className: "b", style: `left: calc(${((w + 1) / nW) * 100}% - ${(0.6 / nW) * 50}%); width: ${(0.6 / nW) * 100}%` });
    k.dataset.off = semi;
    p.append(k); keyEls.set(semi, k);
  }
  $("octLabel").textContent = "C" + (Math.floor(settings.kbdBase / 12) - 1);
}
const pointerNotes = new Map();
const noteAt = (x, y) => {
  const t = document.elementFromPoint(x, y)?.closest("#piano [data-off]");
  return t ? settings.kbdBase + Number(t.dataset.off) : null;
};
$("piano").addEventListener("pointerdown", (e) => {
  const n = noteAt(e.clientX, e.clientY);
  if (n == null) return;
  e.preventDefault();
  $("piano").setPointerCapture(e.pointerId);
  pointerNotes.set(e.pointerId, n); noteOn(n);
});
$("piano").addEventListener("pointermove", (e) => {
  if (!pointerNotes.has(e.pointerId)) return;
  const n = noteAt(e.clientX, e.clientY), old = pointerNotes.get(e.pointerId);
  if (n !== old) { if (old != null) noteOff(old); if (n != null) noteOn(n); pointerNotes.set(e.pointerId, n); }
});
const pointerEnd = (e) => { const n = pointerNotes.get(e.pointerId); if (n != null) noteOff(n); pointerNotes.delete(e.pointerId); };
$("piano").addEventListener("pointerup", pointerEnd);
$("piano").addEventListener("pointercancel", pointerEnd);
$("octDown").addEventListener("click", () => { settings.kbdBase = Math.max(12, settings.kbdBase - 12); saveSettings(); buildPiano(); }); // 12 = C0
$("octUp").addEventListener("click", () => { settings.kbdBase = Math.min(96, settings.kbdBase + 12); saveSettings(); buildPiano(); });

// like Cynthcart and trackers: Z row + A row = lower octave, Q row + number row = upper octave
const KEYMAP = {
  z: 0, s: 1, x: 2, d: 3, c: 4, v: 5, g: 6, b: 7, h: 8, n: 9, j: 10, m: 11, ",": 12, l: 13, ".": 14, ";": 15, "/": 16,
  q: 12, 2: 13, w: 14, 3: 15, e: 16, r: 17, 5: 18, t: 19, 6: 20, y: 21, 7: 22, u: 23, i: 24, 9: 25, o: 26, 0: 27, p: 28,
};
const typing = (e) => e.target.matches("input, select, textarea");
window.addEventListener("keydown", (e) => {
  if (e.repeat || typing(e) || e.metaKey || e.ctrlKey || e.altKey) return;
  const o = KEYMAP[e.key.toLowerCase()];
  if (o == null) return;
  const n = settings.kbdBase + o;
  if (!held.has(n)) noteOn(n);
});
window.addEventListener("keyup", (e) => {
  const o = KEYMAP[e.key.toLowerCase()];
  if (o != null && held.has(settings.kbdBase + o)) noteOff(settings.kbdBase + o);
});
window.addEventListener("blur", () => { for (const n of [...held]) noteOff(n); });

$("panicBtn").addEventListener("click", () => {
  for (const n of [...held]) noteOff(n);
  sendPatch(); // loading the base preset releases every note on the C64
});

// ------------------------------------------------------------ start
buildPiano();
renderAll();
renderLibrary();
if (!midi.supported) {
  $("unsupported").hidden = false;
  $("connectBtn").disabled = true;
} else if (store.get("connected", false)) {
  connect(); // permission was granted before: reconnect without a click
}
