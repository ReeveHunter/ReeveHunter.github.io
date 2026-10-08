// app.js - UI for the Cynthcart controller
import {
  MODES, FX, WAVES, MODS, FILTER_TYPES, TUNINGS, VIB_LEVELS, TARGETS, GLOBAL_PARAMS, VOICE_PARAMS,
  supports, why, patchFromPreset, normalizePatch, patchToFile, randomPatch,
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
  { outId: "", inId: "", ch: 1, target: "sx", live: true, link: true, kbdBase: 48 },
  store.get("settings", {}),
);
if (!TARGETS[settings.target]) settings.target = "sx";
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

/** A labelled control for a global parameter. */
function globalCtl(container, key, kind = "slider", extra = {}) {
  const d = GLOBAL_PARAMS[key];
  const show = d.show ?? String;
  const opts = { get: () => patch[key], set: (v) => setParam(key, v), min: d.min, max: d.max, step: d.step, show, label: d.label, ...extra };
  const c = kind === "slider" ? slider(opts) : kind === "seg" ? seg(opts) : select(opts);
  const out = c.out ?? el("output", { hidden: kind === "select" });
  const lab = el("div", { className: "lab" }, el("b", { textContent: extra.label ?? d.label }), out);
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
  const rl = el("div", { className: "rl", style: `--g2: var(--c-${g})` }, d.label);
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
  const rows = headerRows(view, { presetLabel: showOwn ? "--" : String(patch.base).padStart(2) });
  const scr = $("screen");
  scr.replaceChildren();
  rows.forEach((row, r) => {
    let len = 0;
    for (const [text, cls] of row) {
      len += text.length;
      scr.append(cls ? el("span", { className: cls, textContent: text }) : text);
    }
    scr.append(" ".repeat(Math.max(0, 40 - len)) + (r < rows.length - 1 ? "\n" : ""));
  });
}

function renderAll() {
  for (const c of controls) c.update();
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
$("baseSelect").addEventListener("change", (e) => {
  const n = Number(e.target.value);
  patch = patchFromPreset(n);
  currentId = null;
  renderAll();
  saveCurrent();
  if (settings.live && midi.output) { midi.flush(); midi.send([0xc0 | chan(), n]); status(`Loaded preset ${n}.`); }
});
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

$("randomBtn").addEventListener("click", () => {
  patch = randomPatch(patch);
  currentId = null;
  renderAll();
  saveCurrent();
  if (settings.live) sendPatch();
});

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
  const nW = 15;
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
$("octDown").addEventListener("click", () => { settings.kbdBase = Math.max(24, settings.kbdBase - 12); saveSettings(); buildPiano(); });
$("octUp").addEventListener("click", () => { settings.kbdBase = Math.min(96, settings.kbdBase + 12); saveSettings(); buildPiano(); });

const KEYMAP = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12 };
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
