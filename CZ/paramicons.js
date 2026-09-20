// paramicons.js
// Small SVG glyphs for the two other "pick a shape" parameters: the
// DCO1×DCO2 modulation type, and the vibrato waveform. Unlike the
// oscillator waveform icons (waveicons.js), these aren't traced from a
// manual figure - there's no reference diagram for them - so they use the
// conventional glyph for each idea instead:
//   - Ring modulation multiplies two signals together; multiplying sine
//     waves is what actually produces clean ring-mod sum/difference
//     tones, and a sine is the near-universal icon for "ring" on
//     modulation-capable gear, so that's what's used here.
//   - Noise has no fixed shape at all, so it's drawn as a "sample & hold"
//     staircase - random-looking flat steps, "squared off" rather than a
//     smooth curve - which is the standard way audio gear denotes noise.
//   - None is just a flat line: no modulation happening.
//   - The vibrato waveforms (triangle / sawtooth up / square / sawtooth
//     down) are standard LFO shapes, drawn bipolar (above *and* below
//     center) since vibrato swings pitch both up and down from the note.
//
// These are all bipolar, unlike the CZ's own (unipolar) oscillator
// waveform icons, so they use their own small viewBox/baseline rather
// than sharing waveicons.js's constants.

import { createIconDropdown } from "./iconpicker.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const VIEWBOX = "0 0 64 48";
const MID = 24; // vertical center line - these glyphs swing above and below it
const AMP = 18; // + or - from MID

function buildIconSvg() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", VIEWBOX);
  svg.classList.add("icon-glyph");
  const shape = document.createElementNS(SVG_NS, "path");
  shape.classList.add("icon-glyph-line");
  svg.appendChild(shape);
  return svg;
}

function pathIcon(d) {
  const svg = buildIconSvg();
  svg.querySelector(".icon-glyph-line").setAttribute("d", d);
  return svg;
}

// --- Modulation: None / Ring / Noise -----------------------------------

function sinePath() {
  const x0 = 4, totalW = 56, N = 100;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const x = x0 + t * totalW;
    const y = MID - AMP * Math.sin(2 * Math.PI * t);
    pts.push(`${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(" ");
}

function staircasePath(values) {
  const x0 = 4, totalW = 56;
  const n = values.length;
  const segW = totalW / n;
  const pts = [`M${x0},${(MID - values[0] * AMP).toFixed(1)}`];
  for (let i = 0; i < n; i++) {
    const y = MID - values[i] * AMP;
    const xEnd = x0 + (i + 1) * segW;
    pts.push(`L${xEnd.toFixed(1)},${y.toFixed(1)}`); // hold flat across the step
    if (i < n - 1) {
      const yNext = MID - values[i + 1] * AMP;
      pts.push(`L${xEnd.toFixed(1)},${yNext.toFixed(1)}`); // jump to the next level
    }
  }
  return pts.join(" ");
}

const MOD_PATHS = {
  none: `M4,${MID} L60,${MID}`, // flat: nothing happening
  ring: sinePath(), // multiplying signals -> the classic ring-mod sine
  noise: staircasePath([0.25, -0.75, 0.9, -0.3, 0.55, -0.95, 0.35, -0.55]), // sample & hold, squared off
};

export function renderModulationIcon(v) {
  return pathIcon(MOD_PATHS[v] ?? MOD_PATHS.none);
}

export function createModulationPicker({ label, value, onChange, names }) {
  const choices = Object.entries(names).map(([v, name]) => ({ value: v, label: name }));
  return createIconDropdown({ label, choices, value, onChange, renderIcon: renderModulationIcon });
}

// --- Vibrato waveform: Triangle / Sawtooth up / Square / Sawtooth down --

const VIBRATO_PATHS = {
  1: "M4,24 L18,6 L32,24 L46,42 L60,24", // Triangle: symmetric up/down
  2: "M4,42 L30,6 L32,42 L58,6 L60,42", // Sawtooth up: ramp up, sharp drop, x2
  3: "M4,6 L18,6 L18,42 L32,42 L32,6 L46,6 L46,42 L60,42", // Square: alternating high/low, x2
  4: "M4,6 L30,42 L32,6 L58,42 L60,6", // Sawtooth down: ramp down, sharp rise, x2
};

export function renderVibratoIcon(v) {
  return pathIcon(VIBRATO_PATHS[v] ?? VIBRATO_PATHS[1]);
}

export function createVibratoPicker({ label, value, onChange, names }) {
  const choices = Object.entries(names).map(([v, name]) => ({ value: /^-?\d+$/.test(v) ? Number(v) : v, label: name }));
  return createIconDropdown({ label, choices, value, onChange, renderIcon: renderVibratoIcon });
}
