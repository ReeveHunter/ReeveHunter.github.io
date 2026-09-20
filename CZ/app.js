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
import { initPatch, clonePatch, hardwareInitVoiceBasics, hardwareInitOscillator } from "./patch.js";
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

function envelopeBlock(title, { hasSustain = false, note, onExpand, onCollapse } = {}) {
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
  const editBtn = el("button", { className: "envelope-toggle", textContent: "Edit" });
  statsRow.append(summary, editBtn);

  const thumb = el("canvas", { className: "envelope-thumb" });

  const detail = el("div", { className: "envelope-detail" });
  detail.hidden = true;
  const canvas = el("canvas", { className: "envelope-canvas" });
  const strip = el("div", { className: "envelope-strip" });
  const tools = el("div", { className: "envelope-tools" });
  const hint = el("p", {
    className: "envelope-hint",
    textContent: "Drag a point: up/down = level, left/right = rate. Double-click a point to end the envelope there."
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
    editBtn.textContent = expanding ? "Done" : "Edit";
    thumb.style.display = expanding ? "none" : "";
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
    el("div", { className: "tool-row" }, [
      curveDropdown.el, speedStepper.el, peakStepper.el, baseStepper.el, stagesStepper.el, generateBtn,
    ]),
    liveLabel,
    curveHint,
  ]);

  // --- Stretch every rate, or scale every level, by holding the slider
  // away from center - see RateSlider in knob.js for how the continuous
  // hold-to-scale behavior works. Each slider keeps its own float buffer
  // (liveRateFloats/liveLevelFloats) seeded fresh from the current integer
  // values whenever a new drag starts, so slow/small scaling still
  // accumulates smoothly instead of being wiped out by per-frame rounding.
  function makeContinuousScaler(field, label) {
    let liveFloats = null;
    return new RateSlider({
      label,
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
  const scaleGroup = el("div", { className: "tool-group" }, [
    el("span", { className: "tool-group-label", textContent: "Stretch / scale (hold + drag, all 8 stages)" }),
    el("div", { className: "tool-row" }, [rateSlider.el, levelSlider.el]),
  ]);

  // --- Randomize, and copy/paste between any two envelopes ---
  const randomizeBtn = el("button", { className: "tool-btn", textContent: "Randomize" });
  randomizeBtn.addEventListener("click", () => {
    const stages = Array.from({ length: 8 }, () => ({ rate: randInt(0, 99), level: randInt(0, 99), sustain: false }));
    const endStep = randInt(1, 7);
    if (hasSustain) stages[randInt(0, endStep)].sustain = true;
    applyEnvelopeStages(key, { stages, endStep });
  });
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
  const copyGroup = el("div", { className: "tool-group" }, [
    el("span", { className: "tool-group-label", textContent: "Randomize / copy" }),
    el("div", { className: "tool-row" }, [randomizeBtn, copyBtn, pasteBtn]),
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
  const initBtn = el("button", { className: "panel-toggle", textContent: "Initialize" });
  titleEl.replaceWith(headerRow);
  headerRow.append(titleEl, initBtn);

  const octave = new Dropdown({
    label: "Octave", choices: dropdownChoices(OCTAVE_NAMES), value: state.patch.octave,
    onChange: (v) => (state.patch.octave = v),
  });
  const line = new Dropdown({
    label: "Line select", choices: dropdownChoices(LINE_SELECT_NAMES), value: state.patch.line,
    onChange: (v) => (state.patch.line = v),
  });
  const detuneSign = new Dropdown({
    label: "Detune", choices: dropdownChoices(DETUNE_SIGN_NAMES), value: state.patch.detune.sign,
    onChange: (v) => (state.patch.detune.sign = v),
  });
  const detuneFine = new Knob({ label: "fine", min: 0, max: 60, value: state.patch.detune.fine, onChange: (v) => (state.patch.detune.fine = v) });
  const detuneOctave = new Knob({ label: "oct", min: 0, max: 3, value: state.patch.detune.octave, onChange: (v) => (state.patch.detune.octave = v) });
  const detuneNote = new Knob({ label: "note", min: 0, max: 11, value: state.patch.detune.note, onChange: (v) => (state.patch.detune.note = v) });

  const vibratoWave = createVibratoPicker({
    label: "Vibrato wave", names: VIBRATO_WAVE_NAMES, value: state.patch.vibrato.wave,
    onChange: (v) => (state.patch.vibrato.wave = v),
  });
  // Steppers (value + up/down arrows), not knobs, for these three: a knob's
  // whole sweep only covers 0-99 in a couple of drag-inches, which is too
  // coarse for landing on an exact value across that full range.
  const vDelay = new Stepper({ label: "delay", min: 0, max: 99, value: state.patch.vibrato.delay, onChange: (v) => (state.patch.vibrato.delay = v) });
  const vRate = new Stepper({ label: "rate", min: 0, max: 99, value: state.patch.vibrato.rate, onChange: (v) => (state.patch.vibrato.rate = v) });
  const vDepth = new Stepper({ label: "depth", min: 0, max: 99, value: state.patch.vibrato.depth, onChange: (v) => (state.patch.vibrato.depth = v) });

  const randomizeVibratoBtn = el("button", { className: "panel-toggle", textContent: "Randomize" });
  randomizeVibratoBtn.addEventListener("click", () => {
    const wave = randomChoice(VIBRATO_WAVE_NAMES);
    const delay = randInt(0, 99), rate = randInt(0, 99), depth = randInt(0, 99);
    state.patch.vibrato = { wave, delay, rate, depth };
    vibratoWave.setValue(wave);
    vDelay.setValue(delay, { silent: true });
    vRate.setValue(rate, { silent: true });
    vDepth.setValue(depth, { silent: true });
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
  const copyOtherBtn = el("button", { className: "panel-toggle", textContent: `Copy from Osc ${otherOscNum}` });
  const initBtn = el("button", { className: "panel-toggle", textContent: "Initialize" });
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
    onChange: (v) => (state.patch[oscKey].first = v),
  });

  const secondPicker = createWaveformPicker({
    label: "Line 2 waveform",
    value: state.patch[oscKey].second,
    onChange: (v) => (state.patch[oscKey].second = v),
  });

  let modulation = null;
  const headerRow = row(firstPicker.el, secondPicker.el);
  if (oscNum === 1) {
    modulation = createModulationPicker({
      label: "Osc1×Osc2 mod",
      names: MODULATION_NAMES,
      value: state.patch.osc1.modulation,
      onChange: (v) => (state.patch.osc1.modulation = v),
    });
    headerRow.appendChild(modulation.el);
  }
  const randomizeWaveBtn = el("button", { className: "panel-toggle", textContent: "Randomize" });
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
  });
  headerRow.appendChild(randomizeWaveBtn);
  const keyFollowDca = new Knob({ label: "DCA follow", min: 0, max: 9, value: state.patch[dcaKey].keyFollow, onChange: (v) => (state.patch[dcaKey].keyFollow = v) });
  const keyFollowDcw = new Knob({ label: "DCW follow", min: 0, max: 9, value: state.patch[dcwKey].keyFollow, onChange: (v) => (state.patch[dcwKey].keyFollow = v) });
  headerRow.append(keyFollowDca.el, keyFollowDcw.el);
  s.appendChild(headerRow);

  const envRow = el("div", { className: "envelope-row" });
  const blocks = {};
  function makeBlock(key, title, opts = {}) {
    let originalNextSibling = null; // where block.wrap goes back to on collapse
    const block = envelopeBlock(title, {
      ...opts,
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
    note: "The spec doesn't say which level counts as “no pitch shift” - start near the middle and trust your ears.",
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
  const saveBtn = el("button", { textContent: "Save patch (.json)" });
  const loadBtn = el("button", { textContent: "Load patch (.json)" });
  const loadInput = el("input", { type: "file", accept: "application/json", style: "display:none" });

  body.appendChild(row(connectBtn, outputLabel, inputLabel));
  body.appendChild(row(channelLabel, targetLabel, modeLabel));
  body.appendChild(row(sendBtn, saveBtn, loadBtn, loadInput));

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

  saveBtn.addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state.patch, null, 2)], { type: "application/json" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `${state.patch.name || "cz101-patch"}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  });

  loadBtn.addEventListener("click", () => loadInput.click());
  loadInput.addEventListener("change", async () => {
    const file = loadInput.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      applyPatchToUI(JSON.parse(text));
      log(`Loaded patch from ${file.name}`);
    } catch (err) {
      log(`Load failed: ${err.message}`);
    }
    loadInput.value = "";
  });

  return s;
}

// ---------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------

const globalSection = buildGlobalSection();
const osc1Section = buildOscillatorSection(1);
const osc2Section = buildOscillatorSection(2);
const midiSection = buildMidiSection();

const oscGrid = el("div", { className: "two-col" }, [osc1Section, osc2Section]);
root.append(midiSection, globalSection, expandedHost, oscGrid);

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
}

log("Ready. Connect to MIDI, pick your CZ-101's output port, then send.");
