// app.js
// Wires together the patch data model, the knob/envelope widgets, and the
// Web MIDI transport. Building the UI in JS (rather than hand-written HTML)
// so that adding a new parameter later is a few lines here, not a rewrite
// of the markup.
//
// Layout goal: keep as much on screen as possible. Envelopes default to a
// compact strip (a static thumbnail + a couple of readouts); clicking
// "Edit" reveals the full draggable graph for fine control, and collapses
// again when you're done.

import { CzMidi, hex } from "./midi.js";
import { splitSysexMessages, decodeVoiceDumpMessage, buildVoiceDumpMessage } from "./sysex.js";
import { initPatch, clonePatch, hardwareInitVoiceBasics, hardwareInitOscillator, initEnvelope } from "./patch.js";
import { Knob, ChoiceGroup, Dropdown, Stepper, RateSlider } from "./knob.js";
import { EnvelopeEditor, drawEnvelopeThumbnail } from "./envelope.js";
import { CURVE_PRESETS } from "./curves.js";
import {
  VIBRATO_WAVE_NAMES,
  MODULATION_NAMES,
  LINE_SELECT_NAMES,
  OCTAVE_NAMES,
  DETUNE_SIGN_NAMES,
} from "./labels.js";
import { createWaveformPicker, WAVE_NAMES } from "./waveicons.js";
import { createModulationPicker, createVibratoPicker } from "./paramicons.js";
import { FACTORY_PATCHES } from "./library.js";

const state = {
  patch: initPatch(),
  midi: new CzMidi(),
};

const root = document.getElementById("app");

function log(msg) {
  const statusLog = document.getElementById("status-log");
  if (!statusLog) return; // not mounted yet (e.g. an early MIDI event)
  const line = document.createElement("div");
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  statusLog.prepend(line);
  while (statusLog.children.length > 40) statusLog.removeChild(statusLog.lastChild);
}
state.midi.onLog = log;
// handleImportedPatch and librarySection are both declared later in this
// file (Patch library / Assemble sections) but, same as elsewhere, this
// callback is only ever invoked from a live MIDI event, long after the
// whole module - and those consts - have finished loading.
state.midi.onVoiceDump = (result) => handleImportedPatch(result.patch, { name: `MIDI import (ch ${result.channel + 1})` });

// ---------------------------------------------------------------------
// small DOM helpers
// ---------------------------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  node.append(...children);
  return node;
}

function section(title, subtitle) {
  const s = document.createElement("section");
  s.className = "panel";
  const h = document.createElement("h2");
  h.textContent = title;
  s.appendChild(h);
  if (subtitle) {
    const p = document.createElement("p");
    p.className = "panel-note";
    p.textContent = subtitle;
    s.appendChild(p);
  }
  return s;
}

function row(...children) {
  const r = document.createElement("div");
  r.className = "row";
  r.append(...children);
  return r;
}

function dropdownChoices(namesMap) {
  // Accepts either a plain { key: label } object, or an array of
  // [key, label] pairs (used when insertion order must be preserved -
  // see the comment on OCTAVE_NAMES in labels.js).
  const entries = Array.isArray(namesMap) ? namesMap : Object.entries(namesMap);
  return entries.map(([value, label]) => {
    // numeric-looking keys (from object literals) come back as strings;
    // coerce back to number when the original key was numeric.
    const v = typeof value === "number" ? value : /^-?\d+$/.test(value) ? Number(value) : value;
    return { value: v, label };
  });
}

function clamp99(v) {
  return Math.max(0, Math.min(99, Math.round(v)));
}

/** Bounds-only clamp (no rounding) - used while a continuous scale is in
 * progress, so tiny per-frame changes accumulate in full precision instead
 * of being lost to rounding every frame (rounding every tick would create
 * a "dead zone" where slow, small-deflection scaling never visibly moves). */
function clampFloat99(v) {
  return Math.max(0, Math.min(99, v));
}

/** Multiplicative scaling can never lift a true zero (0 * anything is
 * still 0) - nudge it to 1 the moment the direction is "grow" so a fully
 * silent/flat stage actually responds instead of staying stuck. */
function scaledValue(v, factor) {
  return v === 0 && factor > 1 ? 1 : clampFloat99(v * factor);
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Picks a uniformly random value out of a names map/array, same shape as
 * dropdownChoices() so it always returns a properly-typed key (number vs
 * string) rather than the raw enumerable key. */
function randomChoice(namesMap) {
  const opts = dropdownChoices(namesMap);
  return opts[randInt(0, opts.length - 1)].value;
}

// ---------------------------------------------------------------------
// Collapsible envelope block: thumbnail + readout by default, full
// draggable graph on demand.
// ---------------------------------------------------------------------

function envelopeBlock(title, { hasSustain = false, note, onExpand, onCollapse, onRandomize, onInit } = {}) {
  // Title, stage-count/Edit row, and the graph itself are three separate
  // rows (not one flex header) so that a longer title in a neighboring
  // column - e.g. "DCW1 · tone / phase distortion" wrapping to two lines -
  // doesn't push just *that* graph down relative to the others. The block
  // is a CSS subgrid of the shared .envelope-row's row tracks, so all
  // three graphs stay vertically aligned no matter how the titles wrap.
  const wrap = el("div", { className: "envelope-block" });

  const titleEl = el("h3", { className: "envelope-title", textContent: title });

  const statsRow = el("div", { className: "envelope-stats-row" });
  const summary = el("span", { className: "envelope-summary" });
  // Reshuffle/reset this envelope without opening it - both hidden again
  // once expanded, since the tools panel underneath the graph has its own
  // 🎲 and 🔄 by then.
  const randomizeBtn = el("button", { type: "button", className: "envelope-randomize", textContent: "🎲", title: "Randomize" });
  randomizeBtn.addEventListener("click", () => onRandomize?.());
  const initBtn = el("button", { type: "button", className: "envelope-randomize", textContent: "🔄", title: "Initialize" });
  initBtn.addEventListener("click", () => onInit?.());
  const editBtn = el("button", { className: "envelope-toggle", textContent: "✏️" });
  statsRow.append(summary, randomizeBtn, initBtn, editBtn);

  const thumb = el("canvas", { className: "envelope-thumb" });

  const detail = el("div", { className: "envelope-detail" });
  detail.hidden = true;
  const canvas = el("canvas", { className: "envelope-canvas" });
  const strip = el("div", { className: "envelope-strip" });
  const tools = el("div", { className: "envelope-tools" });
  const hint = el("p", {
    className: "envelope-hint",
    textContent: "Drag a point: up/down = level, left/right = rate. Double-click (or double-tap) a point to end the envelope there."
      + (hasSustain ? " Press and hold a point to toggle sustain on that stage." : ""),
  });
  detail.append(canvas, strip, tools, hint);
  if (note) detail.append(el("p", { className: "envelope-note", textContent: note }));

  wrap.append(titleEl, statsRow, thumb, detail);

  let editor = null;
  let refreshThumb = null;
  function toggle() {
    const expanding = detail.hidden;
    if (expanding) onExpand?.(); else onCollapse?.(); // resize layout first...
    detail.hidden = !expanding;
    editBtn.textContent = expanding ? "Done" : "✏️";
    thumb.style.display = expanding ? "none" : "";
    randomizeBtn.style.display = expanding ? "none" : "";
    initBtn.style.display = expanding ? "none" : "";
    if (expanding && editor) editor.resize(); // ...then measure the canvas at its new size
    if (!expanding) refreshThumb?.(); // thumb was hidden (and not being redrawn) while editing - catch it up now that it's visible again
  }
  editBtn.addEventListener("click", toggle);
  thumb.addEventListener("click", toggle);

  return {
    wrap, thumb, canvas, summary, strip, tools,
    setEditor: (e) => (editor = e),
    setRefreshThumb: (fn) => (refreshThumb = fn),
    collapse: () => { if (!detail.hidden) toggle(); },
  };
}

function refreshEnvelopeSummary(block, stages, endStep) {
  const active = endStep + 1;
  block.summary.textContent = `${active}/8 stages`;
  drawEnvelopeThumbnail(block.thumb, stages, endStep);
}

// ---------------------------------------------------------------------
// Numeric strip: rate/level Steppers for all 8 stages, shown alongside the
// graph so parameters can be fine-tuned by number (click-drag or the small
// up/down arrows) instead of only by dragging the graph.
// ---------------------------------------------------------------------

function buildNumericStrip(container, { stages, endStep, hasSustain, onChange }) {
  container.innerHTML = "";
  const cols = stages.map((stage, i) => {
    const col = el("div", { className: "envelope-strip-col" });
    const num = el("div", { className: "envelope-strip-num", textContent: String(i + 1) });
    const rateStepper = new Stepper({
      value: stage.rate, min: 0, max: 99, label: "R",
      onChange: (v) => onChange({ index: i, field: "rate", value: v }),
    });
    const levelStepper = new Stepper({
      value: stage.level, min: 0, max: 99, label: "L",
      onChange: (v) => onChange({ index: i, field: "level", value: v }),
    });
    const steppers = el("div", { className: "envelope-strip-steppers" }, [levelStepper.el, rateStepper.el]);
    col.append(num, steppers);

    let sustainBtn = null;
    if (hasSustain) {
      sustainBtn = el("button", {
        type: "button",
        className: "envelope-strip-sustain",
        textContent: stage.sustain ? "sustain" : "—",
      });
      sustainBtn.addEventListener("click", () => onChange({ index: i, field: "sustain" }));
      col.append(sustainBtn);
    }

    container.appendChild(col);
    return { col, rateStepper, levelStepper, sustainBtn };
  });

  return {
    setStages(stages, endStep) {
      cols.forEach(({ col, rateStepper, levelStepper, sustainBtn }, i) => {
        rateStepper.setValue(stages[i].rate, { silent: true });
        levelStepper.setValue(stages[i].level, { silent: true });
        if (sustainBtn) {
          const on = !!stages[i].sustain;
          sustainBtn.textContent = on ? "sustain" : "—";
          sustainBtn.classList.toggle("active", on);
        }
        col.classList.toggle("inactive", i > endStep);
      });
    },
  };
}

// ---------------------------------------------------------------------
// Envelope tools: auto-generate a shape from a curve preset, stretch/scale
// every stage at once, randomize, and copy/paste between envelopes.
// applyEnvelopeStages() (defined below, after mountEnvelopeEditors()) is
// the single choke point every one of these goes through so the patch
// data, the graph, the numeric strip, and the thumbnail always stay in
// sync - the same job buildNumericStrip's onChange does for a single
// stage, just for a whole-envelope replacement.
// ---------------------------------------------------------------------

/** One envelope's clipboard slot, shared across every envelope on the page
 * (there's only ever one thing copied at a time). Cross-type copies (e.g.
 * a DCW's sustain flag pasted onto a DCA) are allowed - the pasted flag is
 * simply inert there, same as elsewhere in this app (see
 * hardwareInitOscillator() in patch.js). */
let envelopeClipboard = null;
const pasteButtons = [];
function refreshPasteButtons() {
  pasteButtons.forEach((btn) => {
    btn.disabled = !envelopeClipboard;
    btn.title = envelopeClipboard ? `Paste ${envelopeClipboard.source.toUpperCase()}` : "Copy an envelope first";
  });
}

function buildEnvelopeTools(container, { key, hasSustain }) {
  container.innerHTML = "";

  // --- Generate: fill this envelope from a curve preset ---
  const curveEntries = Object.entries(CURVE_PRESETS);
  const curveDropdown = new Dropdown({
    label: "Curve",
    choices: curveEntries.map(([k, def]) => ({ value: k, label: def.label })),
    value: curveEntries[0][0],
    onChange: () => { updateCurveHint(); maybeLiveGenerate(); },
  });
  const speedStepper = new Stepper({ label: "speed", min: 0, max: 99, value: 70, onChange: () => maybeLiveGenerate() });
  const peakStepper = new Stepper({ label: "peak", min: 0, max: 99, value: 99, onChange: () => maybeLiveGenerate() });
  const baseStepper = new Stepper({ label: "base", min: 0, max: 99, value: 0, onChange: () => maybeLiveGenerate() });
  const stagesStepper = new Stepper({ label: "stages", min: 2, max: 8, value: 6, onChange: () => maybeLiveGenerate() });
  const generateBtn = el("button", { className: "tool-btn", textContent: "Generate" });
  const curveHint = el("p", { className: "tool-hint" });
  const liveCheckbox = el("input", { type: "checkbox", id: `live-${key}`, className: "tool-checkbox" });
  const liveLabel = el("label", { className: "tool-checkbox-row", htmlFor: `live-${key}` }, [liveCheckbox, " Live preview"]);
  function updateCurveHint() {
    curveHint.textContent = CURVE_PRESETS[curveDropdown.value].description;
  }
  function doGenerate() {
    const preset = CURVE_PRESETS[curveDropdown.value];
    const { stages, endStep } = preset.generate({
      speed: speedStepper.value,
      peak: peakStepper.value,
      base: baseStepper.value,
      numStages: stagesStepper.value,
      hasSustainFlag: hasSustain,
    });
    applyEnvelopeStages(key, { stages, endStep });
  }
  function maybeLiveGenerate() {
    // With "Live preview" on, any change to the curve or its parameters
    // re-generates immediately instead of waiting for the Generate click -
    // handy for dialing in a shape while watching the graph react.
    if (liveCheckbox.checked) doGenerate();
  }
  updateCurveHint();
  generateBtn.addEventListener("click", doGenerate);
  const generateGroup = el("div", { className: "tool-group" }, [
    el("span", { className: "tool-group-label", textContent: "Generate" }),
    el("div", { className: "tool-row" }, [curveDropdown.el, generateBtn]),
    el("div", { className: "tool-row" }, [
      liveLabel, speedStepper.el, peakStepper.el, baseStepper.el, stagesStepper.el,
    ]),
    curveHint,
  ]);

  // --- Stretch every rate, or scale every level, by holding the slider
  // away from center - see RateSlider in knob.js for how the continuous
  // hold-to-scale behavior works. Each slider keeps its own float buffer
  // (liveRateFloats/liveLevelFloats) seeded fresh from the current integer
  // values whenever a new drag starts, so slow/small scaling still
  // accumulates smoothly instead of being wiped out by per-frame rounding.
  // Vertical orientation so level+nudge and rate+nudge can sit side by
  // side as four narrow columns instead of two full-width rows.
  function makeContinuousScaler(field, label) {
    let liveFloats = null;
    return new RateSlider({
      label,
      orientation: "vertical",
      onStart: () => { liveFloats = state.patch[key].stages.map((s) => s[field]); },
      onTick: (direction, dt) => {
        const factor = Math.pow(2.5, direction * dt);
        liveFloats = liveFloats.map((v) => scaledValue(v, factor));
        const stages = state.patch[key].stages.map((s, i) => ({ ...s, [field]: Math.round(liveFloats[i]) }));
        applyEnvelopeStages(key, { stages, endStep: state.patch[key].endStep });
      },
    });
  }
  const rateSlider = makeContinuousScaler("rate", "Rate");
  const levelSlider = makeContinuousScaler("level", "Level");

  // A one-at-a-time nudge, for when a precise ±1 to every stage is what's
  // wanted rather than a proportional scale - reuses the Stepper's own
  // arrow styling (no numeric readout, since there's no single value to
  // show for "all 8 stages").
  function makeNudgeControl(field, label) {
    const wrap = document.createElement("div");
    wrap.className = "stepper";
    const labelEl = document.createElement("div");
    labelEl.className = "stepper-label";
    labelEl.textContent = label;
    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "stepper-arrow";
    upBtn.textContent = "▲";
    const valueEl = document.createElement("div");
    valueEl.className = "stepper-value";
    valueEl.textContent = "all";
    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "stepper-arrow";
    downBtn.textContent = "▼";
    function nudge(delta) {
      const stages = state.patch[key].stages.map((s) => ({ ...s, [field]: clamp99(s[field] + delta) }));
      applyEnvelopeStages(key, { stages, endStep: state.patch[key].endStep });
    }
    upBtn.addEventListener("click", () => nudge(1));
    downBtn.addEventListener("click", () => nudge(-1));
    wrap.append(labelEl, upBtn, valueEl, downBtn);
    return wrap;
  }
  const rateNudge = makeNudgeControl("rate", "Rate ±1");
  const levelNudge = makeNudgeControl("level", "Level ±1");

  const scaleGroup = el("div", { className: "tool-group tool-group-wide" }, [
    el("span", { className: "tool-group-label", textContent: "Stretch / scale (all 8 stages)" }),
    el("div", { className: "tool-row tool-row-vertical" }, [
      el("div", { className: "tool-pair tool-pair-vertical" }, [levelSlider.el, levelNudge]),
      el("div", { className: "tool-pair tool-pair-vertical" }, [rateSlider.el, rateNudge]),
    ]),
  ]);

  // --- Randomize, initialize, and copy/paste between any two envelopes ---
  const randomizeBtn = el("button", { className: "tool-btn", textContent: "🎲", title: "Randomize" });
  randomizeBtn.addEventListener("click", () => randomizeEnvelope(key, hasSustain));
  const initBtn = el("button", { className: "tool-btn", textContent: "🔄", title: "Initialize" });
  initBtn.addEventListener("click", () => initEnvelopeByKey(key));
  const copyBtn = el("button", { className: "tool-btn", textContent: "Copy" });
  const pasteBtn = el("button", { className: "tool-btn", textContent: "Paste", disabled: true });
  copyBtn.addEventListener("click", () => {
    envelopeClipboard = {
      stages: state.patch[key].stages.map((s) => ({ ...s })),
      endStep: state.patch[key].endStep,
      source: key,
    };
    refreshPasteButtons();
  });
  pasteBtn.addEventListener("click", () => {
    if (!envelopeClipboard) return;
    applyEnvelopeStages(key, {
      stages: envelopeClipboard.stages.map((s) => ({ ...s })),
      endStep: envelopeClipboard.endStep,
    });
  });
  pasteButtons.push(pasteBtn);
  const copyGroup = el("div", { className: "tool-group tool-group-narrow" }, [
    el("span", { className: "tool-group-label", textContent: "Randomize / init / copy" }),
    el("div", { className: "tool-row" }, [randomizeBtn, initBtn, copyBtn, pasteBtn]),
  ]);

  container.append(generateGroup, scaleGroup, copyGroup);
}

// ---------------------------------------------------------------------
// Global (whole-patch) controls
// ---------------------------------------------------------------------

function buildGlobalSection() {
  const s = section("Voice basics");
  s.classList.add("compact-panel");

  const titleEl = s.querySelector("h2");
  const headerRow = el("div", { className: "panel-header-row" });
  const initBtn = el("button", { className: "panel-toggle", textContent: "🔄", title: "Initialize" });
  titleEl.replaceWith(headerRow);
  headerRow.append(titleEl, initBtn);

  const octave = new Dropdown({
    label: "Octave", choices: dropdownChoices(OCTAVE_NAMES), value: state.patch.octave,
    onChange: (v) => { state.patch.octave = v; notifyPatchChanged(); },
  });
  const line = new Dropdown({
    label: "Line select", choices: dropdownChoices(LINE_SELECT_NAMES), value: state.patch.line,
    onChange: (v) => { state.patch.line = v; notifyPatchChanged(); },
  });
  const detuneSign = new Dropdown({
    label: "Detune", choices: dropdownChoices(DETUNE_SIGN_NAMES), value: state.patch.detune.sign,
    onChange: (v) => { state.patch.detune.sign = v; notifyPatchChanged(); },
  });
  const detuneFine = new Knob({ label: "fine", min: 0, max: 60, value: state.patch.detune.fine, onChange: (v) => { state.patch.detune.fine = v; notifyPatchChanged(); } });
  const detuneOctave = new Knob({ label: "oct", min: 0, max: 3, value: state.patch.detune.octave, onChange: (v) => { state.patch.detune.octave = v; notifyPatchChanged(); } });
  const detuneNote = new Knob({ label: "note", min: 0, max: 11, value: state.patch.detune.note, onChange: (v) => { state.patch.detune.note = v; notifyPatchChanged(); } });

  const vibratoWave = createVibratoPicker({
    label: "Vibrato wave", names: VIBRATO_WAVE_NAMES, value: state.patch.vibrato.wave,
    onChange: (v) => { state.patch.vibrato.wave = v; notifyPatchChanged(); },
  });
  // Steppers (value + up/down arrows), not knobs, for these three: a knob's
  // whole sweep only covers 0-99 in a couple of drag-inches, which is too
  // coarse for landing on an exact value across that full range.
  const vDelay = new Stepper({ label: "delay", min: 0, max: 99, value: state.patch.vibrato.delay, onChange: (v) => { state.patch.vibrato.delay = v; notifyPatchChanged(); } });
  const vRate = new Stepper({ label: "rate", min: 0, max: 99, value: state.patch.vibrato.rate, onChange: (v) => { state.patch.vibrato.rate = v; notifyPatchChanged(); } });
  const vDepth = new Stepper({ label: "depth", min: 0, max: 99, value: state.patch.vibrato.depth, onChange: (v) => { state.patch.vibrato.depth = v; notifyPatchChanged(); } });

  const randomizeVibratoBtn = el("button", { className: "panel-toggle", textContent: "🎲", title: "Randomize vibrato" });
  randomizeVibratoBtn.addEventListener("click", () => {
    const wave = randomChoice(VIBRATO_WAVE_NAMES);
    const delay = randInt(0, 99), rate = randInt(0, 99), depth = randInt(0, 99);
    state.patch.vibrato = { wave, delay, rate, depth };
    vibratoWave.setValue(wave);
    vDelay.setValue(delay, { silent: true });
    vRate.setValue(rate, { silent: true });
    vDepth.setValue(depth, { silent: true });
    notifyPatchChanged();
  });

  initBtn.addEventListener("click", () => {
    const init = hardwareInitVoiceBasics();
    state.patch.octave = init.octave;
    state.patch.detune = init.detune;
    state.patch.vibrato = init.vibrato;
    octave.setValue(init.octave, { silent: true });
    detuneSign.setValue(init.detune.sign, { silent: true });
    detuneFine.setValue(init.detune.fine, { silent: true });
    detuneOctave.setValue(init.detune.octave, { silent: true });
    detuneNote.setValue(init.detune.note, { silent: true });
    vibratoWave.setValue(init.vibrato.wave);
    vDelay.setValue(init.vibrato.delay, { silent: true });
    vRate.setValue(init.vibrato.rate, { silent: true });
    vDepth.setValue(init.vibrato.depth, { silent: true });
    notifyPatchChanged();
  });

  s.appendChild(row(
    octave.el, line.el, detuneSign.el, detuneFine.el, detuneOctave.el, detuneNote.el,
    vibratoWave.el, vDelay.el, vRate.el, vDepth.el, randomizeVibratoBtn,
  ));

  s._widgets = { octave, line, detuneSign, detuneFine, detuneOctave, detuneNote, vibratoWave, vDelay, vRate, vDepth };
  return s;
}

// ---------------------------------------------------------------------
// Shared full-width host for whichever envelope is currently being edited.
// Editing an envelope moves its whole block (title, graph, strip, tools -
// the same DOM node, not a copy, so the live EnvelopeEditor/canvas keep
// working) out of its own oscillator's compact 3-column row and into this
// one shared area, which spans the full width of both oscillator panels
// combined instead of being squeezed into a single ~600px column. That's
// real room for the tool groups (generate/stretch-scale/randomize-copy)
// to sit side by side instead of wrapping into a tall stack. Only one
// envelope can occupy it at a time, across both oscillators - expanding a
// second one auto-collapses whichever was already open.
// ---------------------------------------------------------------------

const expandedHost = el("div", { className: "expanded-envelope-host" });
expandedHost.hidden = true;
let expandedBlock = null;
function setExpandedBlock(block) {
  if (expandedBlock && expandedBlock !== block) expandedBlock.collapse();
  expandedBlock = block;
}

/** Editing an envelope goes "full screen": everything else on the page -
 * MIDI, the patch library, Voice basics, both oscillator cards - is hidden
 * until you back out (the "Done" button), leaving only the one envelope
 * being edited. midi/library/global/oscGrid are declared later in this file
 * (Assemble section) but, as with resetOscillator()/copyOtherOscillator()
 * elsewhere, this function is only ever called from a click handler, long
 * after the whole module - and those consts - have finished loading. */
function setFocusMode(active) {
  midiSection.classList.toggle("is-hidden", active);
  librarySection.classList.toggle("is-hidden", active);
  globalSection.classList.toggle("is-hidden", active);
  oscGrid.classList.toggle("is-hidden", active);
}

// ---------------------------------------------------------------------
// Per-oscillator section (waveform, key follow, 3 envelopes)
// ---------------------------------------------------------------------

function buildOscillatorSection(oscNum) {
  const oscKey = `osc${oscNum}`;
  const dcaKey = `dca${oscNum}`;
  const dcwKey = `dcw${oscNum}`;

  const s = section(`Oscillator ${oscNum} (DCO${oscNum})`);
  s.classList.add("compact-panel");

  const otherOscNum = oscNum === 1 ? 2 : 1;
  const titleEl = s.querySelector("h2");
  const headerRow0 = el("div", { className: "panel-header-row" });
  // 1️⃣⬅️2️⃣ / 1️⃣➡️2️⃣ show which way the copy flows - into Osc 1 from Osc 2,
  // or into Osc 2 from Osc 1 - rather than spelling it out as text.
  const copyArrow = oscNum === 1 ? "1️⃣⬅️2️⃣" : "1️⃣➡️2️⃣";
  const copyOtherBtn = el("button", { className: "panel-toggle", textContent: copyArrow, title: `Copy from Osc ${otherOscNum}` });
  const initBtn = el("button", { className: "panel-toggle", textContent: "🔄", title: "Initialize" });
  // resetOscillator() and copyOtherOscillator() are defined further down
  // (they need the envelope editors/strips, which only exist once
  // mountEnvelopeEditors() has run) but by the time anyone actually clicks
  // these, the whole module has finished loading - a function declaration
  // is hoisted, so the names resolve fine from in here regardless of
  // source order.
  copyOtherBtn.addEventListener("click", () => copyOtherOscillator(oscNum));
  initBtn.addEventListener("click", () => resetOscillator(oscNum));
  titleEl.replaceWith(headerRow0);
  const headerActions = el("div", { className: "panel-header-actions" }, [copyOtherBtn, initBtn]);
  headerRow0.append(titleEl, headerActions);

  const firstPicker = createWaveformPicker({
    label: "Line 1 waveform",
    value: state.patch[oscKey].first,
    onChange: (v) => { state.patch[oscKey].first = v; notifyPatchChanged(); },
  });

  const secondPicker = createWaveformPicker({
    label: "Line 2 waveform",
    value: state.patch[oscKey].second,
    onChange: (v) => { state.patch[oscKey].second = v; notifyPatchChanged(); },
  });

  let modulation = null;
  const headerRow = row(firstPicker.el, secondPicker.el);
  if (oscNum === 1) {
    modulation = createModulationPicker({
      label: "Osc1×Osc2 mod",
      names: MODULATION_NAMES,
      value: state.patch.osc1.modulation,
      onChange: (v) => { state.patch.osc1.modulation = v; notifyPatchChanged(); },
    });
    headerRow.appendChild(modulation.el);
  }
  const randomizeWaveBtn = el("button", { className: "panel-toggle", textContent: "🎲", title: "Randomize waveforms" });
  randomizeWaveBtn.addEventListener("click", () => {
    const first = randomChoice(WAVE_NAMES);
    const second = randomChoice(WAVE_NAMES);
    state.patch[oscKey].first = first;
    state.patch[oscKey].second = second;
    firstPicker.setValue(first);
    secondPicker.setValue(second);
    if (modulation) {
      const mod = randomChoice(MODULATION_NAMES);
      state.patch.osc1.modulation = mod;
      modulation.setValue(mod);
    }
    notifyPatchChanged();
  });
  headerRow.appendChild(randomizeWaveBtn);
  const keyFollowDca = new Knob({ label: "DCA follow", min: 0, max: 9, value: state.patch[dcaKey].keyFollow, onChange: (v) => { state.patch[dcaKey].keyFollow = v; notifyPatchChanged(); } });
  const keyFollowDcw = new Knob({ label: "DCW follow", min: 0, max: 9, value: state.patch[dcwKey].keyFollow, onChange: (v) => { state.patch[dcwKey].keyFollow = v; notifyPatchChanged(); } });
  headerRow.append(keyFollowDca.el, keyFollowDcw.el);
  s.appendChild(headerRow);

  const envRow = el("div", { className: "envelope-row" });
  const blocks = {};
  function makeBlock(key, title, opts = {}) {
    let originalNextSibling = null; // where block.wrap goes back to on collapse
    const patchKey = `${key}${oscNum}`;
    const block = envelopeBlock(title, {
      ...opts,
      onRandomize: () => randomizeEnvelope(patchKey, opts.hasSustain),
      onInit: () => initEnvelopeByKey(patchKey),
      onExpand: () => {
        setExpandedBlock(block); // auto-collapses whatever else was open, in either oscillator
        // A class, not the `hidden` attribute: .envelope-block sets its own
        // `display` (for the subgrid layout), which has the same
        // specificity as the browser's `[hidden] { display: none }` rule
        // and loads after it - so `hidden` alone would be silently
        // overridden and the other two envelopes would stay visible.
        for (const [k, b] of Object.entries(blocks)) if (k !== key) b.wrap.classList.add("is-hidden");
        originalNextSibling = block.wrap.nextSibling;
        expandedHost.appendChild(block.wrap); // move (not clone) into the shared full-width host
        expandedHost.hidden = false;
        envRow.classList.add("is-hidden"); // nothing left in this row to show - it would otherwise be a hairline empty gap
        setFocusMode(true); // hide MIDI/Voice basics/both oscillator cards - just this envelope, full screen
        // The canvas is measured at its new (full) width by toggle()'s own
        // editor.resize() call right after this, once detail.hidden flips -
        // that happens after onExpand() returns, i.e. after the move above.
        expandedHost.scrollIntoView({ behavior: "smooth", block: "nearest" });
      },
      onCollapse: () => {
        envRow.insertBefore(block.wrap, originalNextSibling);
        envRow.classList.remove("is-hidden");
        for (const b of Object.values(blocks)) b.wrap.classList.remove("is-hidden");
        expandedHost.hidden = true;
        setFocusMode(false);
        if (expandedBlock === block) expandedBlock = null;
      },
    });
    blocks[key] = block;
    envRow.appendChild(block.wrap);
    return block;
  }

  const dcaBlock = makeBlock("dca", `DCA${oscNum} · amplitude`);
  const dcwBlock = makeBlock("dcw", `DCW${oscNum} · tone / phase distortion`, { hasSustain: true });
  const dcoBlock = makeBlock("dco", `DCO${oscNum} · pitch`, {
    note: "Level 0 is the no-pitch-shift center (per the CZ-1000 manual's own INITIALIZE table) - higher levels bend away from it.",
  });

  s.appendChild(envRow);

  s._widgets = { firstPicker, secondPicker, modulation, keyFollowDca, keyFollowDcw };
  s._envelopeBlocks = { dca: dcaBlock, dcw: dcwBlock, dco: dcoBlock };
  return s;
}

// ---------------------------------------------------------------------
// MIDI panel
// ---------------------------------------------------------------------

function buildMidiSection() {
  const s = section("MIDI", "Chrome, Edge, Brave, or Opera required - SysEx access isn't available in Safari or Firefox.");

  const toggleBtn = el("button", { className: "panel-toggle", textContent: "Show" });
  const titleEl = s.querySelector("h2");
  const subtitleEl = s.querySelector(".panel-note");
  const headerRow = el("div", { className: "panel-header-row" });
  titleEl.replaceWith(headerRow);
  headerRow.append(titleEl, toggleBtn);

  // Collapsed by default: most of a session is spent on patch editing, not
  // reconnecting MIDI, so this panel starts out of the way and a click on
  // "Show" brings it back.
  const body = el("div", { className: "midi-body" });
  body.hidden = true;
  if (subtitleEl) subtitleEl.hidden = true;
  toggleBtn.addEventListener("click", () => {
    body.hidden = !body.hidden;
    if (subtitleEl) subtitleEl.hidden = body.hidden;
    toggleBtn.textContent = body.hidden ? "Show" : "Hide";
  });

  const connectBtn = el("button", { className: "primary-btn", textContent: "Connect to MIDI" });

  const outputSelect = el("select");
  const outputLabel = el("label", { textContent: "Output (to CZ-101)" }, [outputSelect]);

  const inputSelect = el("select");
  const inputLabel = el("label", { textContent: "Input (from CZ-101, optional)" }, [inputSelect]);

  const channelSelect = el("select");
  for (let i = 1; i <= 16; i++) channelSelect.appendChild(el("option", { value: String(i - 1), textContent: String(i) }));
  const channelLabel = el("label", { textContent: "Channel" }, [channelSelect]);

  const targetSelect = el("select");
  const targetOptions = [{ value: 0x60, label: "Temporary / edit buffer (recommended)" }];
  for (let i = 0; i < 16; i++) targetOptions.push({ value: 0x20 + i, label: `Internal ${i + 1}` });
  for (let i = 0; i < 16; i++) targetOptions.push({ value: 0x40 + i, label: `Cartridge ${i + 1}` });
  targetOptions.forEach(({ value, label }) => targetSelect.appendChild(el("option", { value: String(value), textContent: label })));
  const targetLabel = el("label", { textContent: "Target" }, [targetSelect]);

  const modeSelect = el("select");
  [{ value: "blind", label: "One-shot (recommended)" }, { value: "handshake", label: "Handshake (needs input connected)" }]
    .forEach(({ value, label }) => modeSelect.appendChild(el("option", { value, textContent: label })));
  const modeLabel = el("label", { textContent: "Send mode" }, [modeSelect]);

  const sendBtn = el("button", { className: "primary-btn", textContent: "Send patch to CZ-101", disabled: true });
  // Patches only ever leave/enter this app as SysEx now that sysex.js can
  // both encode and decode (see decodeVoiceDumpMessage/buildVoiceDumpMessage) -
  // one file format for saving your own work, sharing a sound with someone
  // else, and pulling in whatever .syx files you come across, rather than a
  // separate .json shape only this app understood. See patches/README.md.
  const saveBtn = el("button", { textContent: "Save patch (.syx)" });
  const importSyxBtn = el("button", { textContent: "Load patch (.syx)" });
  const importSyxInput = el("input", { type: "file", accept: ".syx,application/octet-stream", style: "display:none" });

  // "Live sync": every edit anywhere in the app - a knob nudge, a dragged
  // envelope point, a randomize click - normally only changes state.patch
  // in memory, and nothing reaches the CZ-101 until Send is pressed. This
  // opts into sending after every change instead, so the synth's edit
  // buffer tracks the UI live. requestSend() is called from all over
  // app.js (see notifyPatchChanged()); it's a no-op unless this box is
  // checked and an output is connected, and debounces rapid-fire changes
  // (like dragging a slider) into one send after things settle.
  const liveSyncCheckbox = el("input", { type: "checkbox", id: "live-sync-checkbox", className: "tool-checkbox" });
  const liveSyncLabel = el("label", { className: "tool-checkbox-row", htmlFor: "live-sync-checkbox" }, [liveSyncCheckbox, " Live sync to CZ-101"]);
  const liveSyncHint = el("p", {
    className: "panel-note",
    textContent: "Sends the patch to your CZ-101 automatically after every change here, instead of waiting for Send. Needs Connect + an output selected; works best with Target set to Temporary / edit buffer.",
  });

  body.appendChild(row(connectBtn, outputLabel, inputLabel));
  body.appendChild(row(channelLabel, targetLabel, modeLabel));
  body.appendChild(row(sendBtn, saveBtn, importSyxBtn, importSyxInput));
  body.appendChild(row(liveSyncLabel));
  body.appendChild(liveSyncHint);

  const logEl = el("div", { id: "status-log" });
  body.appendChild(logEl);
  s.appendChild(body);

  function refreshPortLists() {
    outputSelect.innerHTML = "";
    state.midi.listOutputs().forEach((o) => outputSelect.appendChild(el("option", { value: o.id, textContent: o.name })));
    inputSelect.innerHTML = "";
    inputSelect.appendChild(el("option", { value: "", textContent: "(none)" }));
    state.midi.listInputs().forEach((i) => inputSelect.appendChild(el("option", { value: i.id, textContent: i.name })));
    if (outputSelect.value) state.midi.setOutputById(outputSelect.value);
    sendBtn.disabled = !outputSelect.value;
  }

  connectBtn.addEventListener("click", async () => {
    try {
      await state.midi.requestAccess();
      log("MIDI access granted.");
      refreshPortLists();
    } catch (err) {
      log(`MIDI access failed: ${err.message}`);
    }
  });

  outputSelect.addEventListener("change", () => {
    state.midi.setOutputById(outputSelect.value);
    sendBtn.disabled = !outputSelect.value;
  });
  inputSelect.addEventListener("change", () => state.midi.setInputById(inputSelect.value || null));

  sendBtn.addEventListener("click", async () => {
    try {
      const channel = Number(channelSelect.value);
      const program = Number(targetSelect.value);
      const mode = modeSelect.value;
      const dump = await state.midi.sendVoiceDump(channel, program, state.patch, { mode });
      log(`Sent ${dump.length} bytes: ${hex(dump).slice(0, 60)}...`);
    } catch (err) {
      log(`Send failed: ${err.message}`);
    }
  });

  // Saved as a single-voice dump targeting the temporary/edit buffer (0x60) -
  // the same shape any other CZ-101 .syx patch file uses, so it loads back
  // in here (via "Load patch (.syx)" below) or on the hardware itself
  // through any SysEx librarian.
  saveBtn.addEventListener("click", () => {
    const dump = buildVoiceDumpMessage(0, 0x60, state.patch);
    const blob = new Blob([dump], { type: "application/octet-stream" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `${state.patch.name || "cz101-patch"}.syx` });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  importSyxBtn.addEventListener("click", () => importSyxInput.click());
  importSyxInput.addEventListener("change", async () => {
    const file = importSyxInput.files?.[0];
    if (!file) return;
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      const messages = splitSysexMessages(buf);
      if (!messages.length) {
        log(`No SysEx messages found in ${file.name}.`);
      } else {
        const baseName = file.name.replace(/\.[^.]+$/, "");
        let imported = 0;
        let skipped = 0;
        let firstPatch = null;
        messages.forEach((msg, idx) => {
          const result = decodeVoiceDumpMessage(msg);
          if (result.error) {
            skipped++;
            log(`  message ${idx + 1}: skipped (${result.error})`);
            return;
          }
          const name = messages.length > 1 ? `${baseName} #${idx + 1}` : baseName;
          const named = { ...result.patch, name };
          librarySection._addPatch(named, ["imported"]);
          if (!firstPatch) firstPatch = named;
          imported++;
        });
        if (firstPatch) applyPatchToUI(firstPatch);
        log(`Imported ${imported} patch(es) from ${file.name}${skipped ? `, skipped ${skipped}` : ""}.`);
      }
    } catch (err) {
      log(`Import failed: ${err.message}`);
    }
    importSyxInput.value = "";
  });

  let liveSyncTimer = null;
  async function sendLiveSync() {
    if (!outputSelect.value) return; // nothing connected - quietly skip rather than erroring on every keystroke
    try {
      const channel = Number(channelSelect.value);
      const program = Number(targetSelect.value);
      const mode = modeSelect.value;
      await state.midi.sendVoiceDump(channel, program, state.patch, { mode });
    } catch (err) {
      log(`Live sync failed: ${err.message}`);
    }
  }
  s._liveUpdate = {
    requestSend() {
      if (!liveSyncCheckbox.checked) return;
      clearTimeout(liveSyncTimer);
      // Debounced rather than immediate: a dragged slider or a held stepper
      // arrow can fire this dozens of times a second, and only the value
      // after things settle is worth an actual MIDI send.
      liveSyncTimer = setTimeout(sendLiveSync, 120);
    },
  };

  return s;
}

// ---------------------------------------------------------------------
// Patch library: a tagged, filterable list of ready-made patches (see
// library.js) plus anything saved from the current patch. Lives in
// localStorage from first load onward, seeded from the factory set once.
// ---------------------------------------------------------------------

const LIBRARY_STORAGE_KEY = "cz101-patch-library-v1";

function seedLibrary() {
  return FACTORY_PATCHES.map((e) => ({ id: e.id, name: e.name, tags: [...e.tags], patch: clonePatch(e.patch), builtin: true }));
}
function loadLibrary() {
  try {
    const raw = localStorage.getItem(LIBRARY_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch (err) {
    log(`Patch library failed to load, starting fresh: ${err.message}`);
  }
  return seedLibrary();
}
function saveLibrary(library) {
  try {
    localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(library));
  } catch (err) {
    log(`Patch library failed to save: ${err.message}`);
  }
}
function normalizeTags(text) {
  const seen = new Set();
  for (const raw of text.split(",")) {
    const t = raw.trim().toLowerCase();
    if (t) seen.add(t);
  }
  return [...seen].sort();
}

function buildLibrarySection() {
  const s = section("Patch Library", "A tagged set of ready-made patches - filter by tag, load one into the editor, or save what you've got going as a new entry.");

  let library = loadLibrary();
  const activeTags = new Set();
  let nameFilter = "";

  // Shared by the "Save current..." form below and by _addPatch (called
  // from handleImportedPatch for a .syx/MIDI import) - renderTagRow() too,
  // not just renderList(), since either path can introduce a tag nothing
  // else in the library has used yet. Random suffix on the id, not just
  // Date.now(), because a multi-voice .syx import calls this once per
  // voice, synchronously, fast enough to land in the same millisecond.
  function addPatchToLibrary(patch, tags = []) {
    const cleanTags = [...new Set(tags.map((t) => String(t).trim().toLowerCase()).filter(Boolean))].sort();
    const entry = {
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: patch.name || "Untitled patch",
      tags: cleanTags,
      patch: clonePatch(patch),
      builtin: false,
    };
    library.push(entry);
    saveLibrary(library);
    renderTagRow();
    renderList();
    return entry;
  }

  const toggleBtn = el("button", { className: "panel-toggle", textContent: "Show" });
  const titleEl = s.querySelector("h2");
  const subtitleEl = s.querySelector(".panel-note");
  const headerRow = el("div", { className: "panel-header-row" });
  titleEl.replaceWith(headerRow);
  headerRow.append(titleEl, toggleBtn);

  // Collapsed by default - with 100+ factory patches now in here alongside
  // the hand-built set, this panel is big enough that it shouldn't be the
  // first thing you see on every visit. A click on "Show" reveals the
  // whole thing: save/reset, search and tags, and the patch grid below.
  const body = el("div", { className: "library-body" });
  body.hidden = true;
  if (subtitleEl) subtitleEl.hidden = true;
  toggleBtn.addEventListener("click", () => {
    body.hidden = !body.hidden;
    if (subtitleEl) subtitleEl.hidden = body.hidden;
    toggleBtn.textContent = body.hidden ? "Show" : "Hide";
  });

  const saveToggleBtn = el("button", { className: "panel-toggle", textContent: "Save current…" });
  const resetBtn = el("button", { className: "panel-toggle", textContent: "Reset to factory" });
  const bodyActions = el("div", { className: "panel-header-actions library-body-actions" }, [saveToggleBtn, resetBtn]);

  // --- Save current patch as a new library entry ---
  const saveNameInput = el("input", { type: "text", className: "library-text-input", placeholder: "Name" });
  const saveTagsInput = el("input", { type: "text", className: "library-text-input", placeholder: "Tags, comma-separated" });
  const saveConfirmBtn = el("button", { className: "tool-btn", textContent: "Save" });
  const saveCancelBtn = el("button", { className: "tool-btn", textContent: "Cancel" });
  const saveForm = el("div", { className: "library-save-form" }, [saveNameInput, saveTagsInput, saveConfirmBtn, saveCancelBtn]);
  saveForm.hidden = true;
  saveToggleBtn.addEventListener("click", () => {
    saveForm.hidden = !saveForm.hidden;
    if (!saveForm.hidden) {
      saveNameInput.value = state.patch.name && state.patch.name !== "init" ? state.patch.name : "";
      saveTagsInput.value = "";
      saveNameInput.focus();
    }
  });
  saveCancelBtn.addEventListener("click", () => { saveForm.hidden = true; });
  saveConfirmBtn.addEventListener("click", () => {
    const name = saveNameInput.value.trim() || "Untitled patch";
    const tags = normalizeTags(saveTagsInput.value);
    addPatchToLibrary({ ...state.patch, name }, tags);
    saveForm.hidden = true;
    log(`Saved "${name}" to the patch library.`);
  });

  resetBtn.addEventListener("click", () => {
    if (!confirm("Restore all factory patches to their original tags (custom patches you've saved are kept)?")) return;
    const custom = library.filter((e) => !e.builtin);
    library = [...seedLibrary(), ...custom];
    saveLibrary(library);
    activeTags.clear();
    renderList();
  });

  // --- Filters: name search + tag chips (AND match - a patch must carry
  // every active tag, not just one) ---
  const searchInput = el("input", { type: "text", className: "library-text-input library-search", placeholder: "Filter by name…" });
  searchInput.addEventListener("input", () => {
    nameFilter = searchInput.value.trim().toLowerCase();
    renderList();
  });
  const tagRow = el("div", { className: "library-tag-row" });
  const listEl = el("div", { className: "library-list" });
  const emptyNote = el("p", { className: "tool-hint", textContent: "No patches match the current filters." });

  function allTags() {
    const set = new Set();
    for (const e of library) for (const t of e.tags) set.add(t);
    return [...set].sort();
  }

  function renderTagRow() {
    tagRow.innerHTML = "";
    for (const tag of allTags()) {
      const chip = el("button", { type: "button", className: "library-tag-chip", textContent: tag });
      chip.classList.toggle("active", activeTags.has(tag));
      chip.addEventListener("click", () => {
        if (activeTags.has(tag)) activeTags.delete(tag); else activeTags.add(tag);
        renderTagRow();
        renderList();
      });
      tagRow.appendChild(chip);
    }
  }

  function matchesFilters(entry) {
    if (nameFilter && !entry.name.toLowerCase().includes(nameFilter)) return false;
    for (const tag of activeTags) if (!entry.tags.includes(tag)) return false;
    return true;
  }

  function startTagEdit(entry, tagsEl) {
    const input = el("input", { type: "text", className: "library-text-input", value: entry.tags.join(", ") });
    tagsEl.replaceWith(input);
    input.focus();
    input.select();
    function commit() {
      entry.tags = normalizeTags(input.value);
      saveLibrary(library);
      renderTagRow();
      renderList();
    }
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      else if (e.key === "Escape") renderList();
    });
    input.addEventListener("blur", commit);
  }

  function renderList() {
    listEl.innerHTML = "";
    const filtered = library.filter(matchesFilters);
    if (!filtered.length) {
      listEl.appendChild(emptyNote);
      return;
    }
    for (const entry of filtered) {
      const nameEl = el("span", { className: "library-row-name", textContent: entry.name });
      const tagsEl = el("div", { className: "library-row-tags" },
        entry.tags.map((t) => el("span", { className: "library-tag-chip library-tag-chip-static", textContent: t })));
      const editTagsBtn = el("button", { type: "button", className: "tool-btn", textContent: "🏷️", title: "Edit tags" });
      editTagsBtn.addEventListener("click", () => startTagEdit(entry, tagsEl));
      const loadBtn = el("button", { type: "button", className: "tool-btn", textContent: "⬇️", title: "Load" });
      loadBtn.addEventListener("click", () => {
        applyPatchToUI(entry.patch);
        log(`Loaded "${entry.name}" from the patch library.`);
      });
      // Load sits right before the name, and the tag-edit icon right before
      // the tags themselves, rather than off in a separate actions column -
      // each icon reads as a label for what follows it.
      const nameRow = el("div", { className: "library-row-name-row" }, [loadBtn, nameEl]);
      const tagsRow = el("div", { className: "library-row-tags-row" }, [editTagsBtn, tagsEl]);
      const rowActions = [];
      if (!entry.builtin) {
        const deleteBtn = el("button", { type: "button", className: "tool-btn", textContent: "🗑️", title: "Delete" });
        deleteBtn.addEventListener("click", () => {
          if (!confirm(`Delete "${entry.name}" from the patch library?`)) return;
          library = library.filter((e) => e.id !== entry.id);
          saveLibrary(library);
          renderTagRow();
          renderList();
        });
        rowActions.push(deleteBtn);
      }
      const row = el("div", { className: "library-row" }, [
        el("div", { className: "library-row-main" }, [nameRow, tagsRow]),
        ...(rowActions.length ? [el("div", { className: "library-row-actions" }, rowActions)] : []),
      ]);
      listEl.appendChild(row);
    }
  }

  saveLibrary(library); // persist the initial seed on a first-ever visit
  renderTagRow();
  renderList();

  // headerRow is already in place via replaceWith above - only the rest is new.
  body.append(bodyActions, saveForm, el("div", { className: "library-filters" }, [searchInput, tagRow]), listEl);
  s.append(body);

  // Exposed for handleImportedPatch() - a .syx import or a live MIDI dump
  // adds straight to the library the same way "Save current..." does,
  // without needing the save form's UI round trip.
  s._addPatch = addPatchToLibrary;

  return s;
}

// ---------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------

const globalSection = buildGlobalSection();
const osc1Section = buildOscillatorSection(1);
const osc2Section = buildOscillatorSection(2);
const midiSection = buildMidiSection();
const librarySection = buildLibrarySection();

const oscGrid = el("div", { className: "two-col" }, [osc1Section, osc2Section]);
root.append(midiSection, librarySection, globalSection, expandedHost, oscGrid);

const envelopeEditors = {};
const envelopeStrips = {};
const envelopeBlocksByKey = {};
function mountEnvelopeEditors(oscSection, oscNum) {
  const blocks = oscSection._envelopeBlocks;

  const makeEditor = (key, block, hasSustain) => {
    let strip; // assigned below; referenced here via closure once the editor is live
    const editor = new EnvelopeEditor(block.canvas, {
      stages: state.patch[key].stages,
      endStep: state.patch[key].endStep,
      hasSustain,
      onChange: ({ stages, endStep }) => {
        state.patch[key].stages = stages;
        state.patch[key].endStep = endStep;
        refreshEnvelopeSummary(block, stages, endStep);
        strip?.setStages(stages, endStep);
        notifyPatchChanged();
      },
    });
    block.setEditor(editor);
    block.setRefreshThumb(() => refreshEnvelopeSummary(block, state.patch[key].stages, state.patch[key].endStep));

    strip = buildNumericStrip(block.strip, {
      stages: state.patch[key].stages,
      endStep: state.patch[key].endStep,
      hasSustain,
      onChange: ({ index, field, value }) => {
        const s = state.patch[key].stages[index];
        if (field === "sustain") {
          // only one sustain point is meaningful on real hardware - turning
          // one on clears any other stage's sustain flag first.
          const turningOn = !s.sustain;
          if (turningOn) state.patch[key].stages.forEach((st) => (st.sustain = false));
          s.sustain = turningOn;
        } else {
          s[field] = value;
        }
        editor.setStages(state.patch[key].stages, state.patch[key].endStep);
        refreshEnvelopeSummary(block, state.patch[key].stages, state.patch[key].endStep);
        strip.setStages(state.patch[key].stages, state.patch[key].endStep);
        notifyPatchChanged();
      },
    });
    envelopeStrips[key] = strip;
    envelopeBlocksByKey[key] = block;
    buildEnvelopeTools(block.tools, { key, hasSustain });

    refreshEnvelopeSummary(block, state.patch[key].stages, state.patch[key].endStep);
    return editor;
  };

  envelopeEditors[`dca${oscNum}`] = makeEditor(`dca${oscNum}`, blocks.dca, false);
  envelopeEditors[`dcw${oscNum}`] = makeEditor(`dcw${oscNum}`, blocks.dcw, true);
  envelopeEditors[`dco${oscNum}`] = makeEditor(`dco${oscNum}`, blocks.dco, false);
}
mountEnvelopeEditors(osc1Section, 1);
mountEnvelopeEditors(osc2Section, 2);

/** Called after any edit anywhere in the patch - forwards to the MIDI
 * panel's "Live sync" feature (see buildMidiSection()), which is a no-op
 * unless that checkbox is on. midiSection is declared later in this file
 * (Assemble section) but, same as elsewhere, this is only ever invoked
 * from a click/drag handler long after the whole module has loaded. */
function notifyPatchChanged() {
  midiSection._liveUpdate?.requestSend();
}

/** Reset one oscillator's waveform, modulation, key-follow and all three
 * envelopes to the CZ-101's own hardware INITIALIZE values (see
 * hardwareInitOscillator() in patch.js), updating both state.patch and
 * every widget/editor/strip/thumbnail that reads from it. */
function resetOscillator(oscNum) {
  const oscKey = `osc${oscNum}`, dcaKey = `dca${oscNum}`, dcwKey = `dcw${oscNum}`, dcoKey = `dco${oscNum}`;
  const s = oscNum === 1 ? osc1Section : osc2Section;
  const w = s._widgets;
  const init = hardwareInitOscillator(oscNum);

  state.patch[oscKey] = init.osc;
  state.patch[dcaKey] = init.dca;
  state.patch[dcwKey] = init.dcw;
  state.patch[dcoKey] = init.dco;

  w.firstPicker.setValue(init.osc.first);
  w.secondPicker.setValue(init.osc.second);
  if (w.modulation) w.modulation.setValue(init.osc.modulation);
  w.keyFollowDca.setValue(init.dca.keyFollow, { silent: true });
  w.keyFollowDcw.setValue(init.dcw.keyFollow, { silent: true });

  for (const kind of ["dca", "dcw", "dco"]) {
    const key = `${kind}${oscNum}`;
    envelopeEditors[key].setStages(state.patch[key].stages, state.patch[key].endStep);
    envelopeStrips[key].setStages(state.patch[key].stages, state.patch[key].endStep);
    refreshEnvelopeSummary(s._envelopeBlocks[kind], state.patch[key].stages, state.patch[key].endStep);
  }
  notifyPatchChanged();
}

/** Replace one envelope's stages/endStep wholesale (as opposed to
 * buildNumericStrip's onChange, which edits a single stage) - the shared
 * landing point for the curve generator, stretch/scale, randomize, and
 * copy/paste, all of which produce a brand new 8-stage array rather than
 * tweaking one field. Keeps state.patch, the draggable graph, the numeric
 * strip, and the thumbnail in sync no matter which of those triggered it. */
function applyEnvelopeStages(key, { stages, endStep }) {
  state.patch[key].stages = stages;
  state.patch[key].endStep = endStep;
  envelopeEditors[key].setStages(stages, endStep);
  envelopeStrips[key].setStages(stages, endStep);
  refreshEnvelopeSummary(envelopeBlocksByKey[key], stages, endStep);
  notifyPatchChanged();
}

/** Replace one envelope's 8 stages with random values - the single
 * implementation behind both the 🎲 button in its tools panel (while
 * expanded) and the 🎲 button next to its Edit button (while collapsed),
 * so a whole envelope can be reshuffled without opening it first. */
function randomizeEnvelope(key, hasSustain) {
  const stages = Array.from({ length: 8 }, () => ({ rate: randInt(0, 99), level: randInt(0, 99), sustain: false }));
  const endStep = randInt(1, 7);
  if (hasSustain) stages[randInt(0, endStep)].sustain = true;
  applyEnvelopeStages(key, { stages, endStep });
}

/** Reset one envelope to this editor's own "doing nothing" default for its
 * kind (see initEnvelope() in patch.js) - the single implementation behind
 * both the 🔄 button in its tools panel (while expanded) and the 🔄 button
 * next to its ✏️ button (while collapsed). `key` is e.g. "dca1"/"dcw2" -
 * strip the oscillator number to get the envelope kind initEnvelope() wants. */
function initEnvelopeByKey(key) {
  const kind = key.replace(/[12]$/, "");
  applyEnvelopeStages(key, initEnvelope(kind));
}

/** Copy the other oscillator's waveform, key-follow, and all three
 * envelopes onto this one. Modulation is deliberately left out: it's an
 * Osc1×Osc2 relationship parameter that only lives on the osc1 slot in
 * this data model, not a per-oscillator property with a sensible "other
 * side" to copy either direction. */
function copyOtherOscillator(targetOscNum) {
  const sourceOscNum = targetOscNum === 1 ? 2 : 1;
  const s = targetOscNum === 1 ? osc1Section : osc2Section;
  const w = s._widgets;
  const srcOsc = state.patch[`osc${sourceOscNum}`];
  const srcDca = state.patch[`dca${sourceOscNum}`];
  const srcDcw = state.patch[`dcw${sourceOscNum}`];

  state.patch[`osc${targetOscNum}`].first = srcOsc.first;
  state.patch[`osc${targetOscNum}`].second = srcOsc.second;
  w.firstPicker.setValue(srcOsc.first);
  w.secondPicker.setValue(srcOsc.second);

  state.patch[`dca${targetOscNum}`].keyFollow = srcDca.keyFollow;
  state.patch[`dcw${targetOscNum}`].keyFollow = srcDcw.keyFollow;
  w.keyFollowDca.setValue(srcDca.keyFollow, { silent: true });
  w.keyFollowDcw.setValue(srcDcw.keyFollow, { silent: true });

  for (const kind of ["dca", "dcw", "dco"]) {
    const srcKey = `${kind}${sourceOscNum}`, dstKey = `${kind}${targetOscNum}`;
    applyEnvelopeStages(dstKey, {
      stages: state.patch[srcKey].stages.map((st) => ({ ...st })),
      endStep: state.patch[srcKey].endStep,
    });
  }
  notifyPatchChanged();
}

/** Shared landing point for a freshly-decoded patch, from either a loaded
 * .syx file or a voice dump received live over MIDI (see
 * decodeVoiceDumpMessage in sysex.js and CzMidi.onVoiceDump in midi.js) -
 * loads it into the editor so its settings show up right away, and adds it
 * to the patch library, tagged "imported", so it isn't lost the next time
 * something else gets loaded. librarySection is declared later in this file
 * (Assemble section) but, as elsewhere, this is only ever invoked from a
 * later event (a file picked, a MIDI message received), long after the
 * whole module has finished loading. */
function handleImportedPatch(rawPatch, { name, tags = ["imported"] } = {}) {
  const named = { ...rawPatch, name: name || rawPatch.name || "Imported patch" };
  applyPatchToUI(named);
  librarySection._addPatch(named, tags);
  log(`Imported "${named.name}" - loaded into the editor and added to the patch library.`);
}

function applyPatchToUI(patch) {
  state.patch = clonePatch(patch);
  const g = globalSection._widgets;
  g.octave.setValue(state.patch.octave, { silent: true });
  g.line.setValue(state.patch.line, { silent: true });
  g.detuneSign.setValue(state.patch.detune.sign, { silent: true });
  g.detuneFine.setValue(state.patch.detune.fine, { silent: true });
  g.detuneOctave.setValue(state.patch.detune.octave, { silent: true });
  g.detuneNote.setValue(state.patch.detune.note, { silent: true });
  g.vibratoWave.setValue(state.patch.vibrato.wave);
  g.vDelay.setValue(state.patch.vibrato.delay, { silent: true });
  g.vRate.setValue(state.patch.vibrato.rate, { silent: true });
  g.vDepth.setValue(state.patch.vibrato.depth, { silent: true });

  for (const oscNum of [1, 2]) {
    const s = oscNum === 1 ? osc1Section : osc2Section;
    const w = s._widgets;
    w.firstPicker.setValue(state.patch[`osc${oscNum}`].first);
    w.secondPicker.setValue(state.patch[`osc${oscNum}`].second);
    if (w.modulation) w.modulation.setValue(state.patch.osc1.modulation);
    w.keyFollowDca.setValue(state.patch[`dca${oscNum}`].keyFollow, { silent: true });
    w.keyFollowDcw.setValue(state.patch[`dcw${oscNum}`].keyFollow, { silent: true });

    for (const kind of ["dca", "dcw", "dco"]) {
      const key = `${kind}${oscNum}`;
      envelopeEditors[key].setStages(state.patch[key].stages, state.patch[key].endStep);
      envelopeStrips[key].setStages(state.patch[key].stages, state.patch[key].endStep);
      refreshEnvelopeSummary(s._envelopeBlocks[kind], state.patch[key].stages, state.patch[key].endStep);
    }
  }
  notifyPatchChanged();
}

log("Ready. Connect to MIDI, pick your CZ-101's output port, then send.");
