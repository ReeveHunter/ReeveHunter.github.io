// waveicons.js
// Small SVG glyphs of the CZ-101's 8 waveforms, traced directly against the
// manual's own waveform diagram (Fig. 8) using pixel measurements of the
// source image (peak positions, dip depths, arc tangents), not just an
// eyeballed approximation:
//  1 Saw-tooth  - rise is essentially vertical (only ~3% of the width),
//                 then one long straight fall across the rest.
//  2 Square     - flat top for about half the width.
//  3 Pulse      - a narrow, roughly symmetric pointed spike (~25% of the
//                 width), then a long flat tail.
//  4 Double Sine- two peaks of equal height; the dip between them comes
//                 down almost to the baseline (not a shallow dip), and the
//                 first hump is noticeably narrower than the second.
//  5 Saw-Pulse  - a quarter-ellipse arc (vertical tangent at the bottom,
//                 horizontal tangent at the peak - literally the top-left
//                 quarter of a circle/ellipse), then a sharp vertical drop.
//  6-8 Resonance- six evenly-spaced, smooth, roughly symmetric ripple
//                 bumps; the "Saw-tooth / Triangle / Trapezoid" in each
//                 name describes the shape traced by the *peak heights*
//                 across the six bumps (a decaying ramp, a symmetric
//                 tent, and a sustained-then-dropping shape respectively),
//                 not the shape of an individual bump.

import { createIconDropdown } from "./iconpicker.js";

const VIEWBOX = "0 0 64 48";
const SVG_NS = "http://www.w3.org/2000/svg";
const BASELINE = 42;
const TOP = 6;

// Explicit paths for the five "simple" waveforms - straight lines except
// where the manual's own icon is genuinely curved (4 and 5).
const PATHS = {
  1: "M4,42 L5.5,6 L60,42", // Saw-tooth: essentially vertical rise (measured ~3% of width), then one long fall
  2: "M4,42 L4,10 L32,10 L32,42 L60,42", // Square: flat top ~ half the width
  3: "M4,42 L12,6 L18,42 L60,42", // Pulse: narrow, roughly symmetric spike
  4: "M4,42 C6.3,42 8.7,6 11,6 C13.7,6 16.3,40 19,40 C25.3,40 31.7,6 38,6 C45,6 52,42 59,42 L60,42", // Double Sine: dip nearly to baseline, wider 2nd hump
  5: "M4,42 A28,36 0 0 1 32,6 L32,42 L60,42", // Saw-Pulse: quarter-ellipse arc, then sharp vertical drop
};

// The three "Resonance" waveforms: six smooth, evenly-spaced, roughly
// symmetric ripple bumps. Each icon's distinct look comes entirely from
// the amplitude of its six peaks (measured from the figure), matching the
// "Saw-tooth / Triangle / Trapezoid" envelope each name describes.
function rippleFromAmps(amps) {
  const x0 = 4, totalW = 56;
  const maxAmp = BASELINE - TOP;
  const humps = amps.length;
  const N = 140;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const humpIdx = Math.min(humps - 1, Math.floor(t * humps));
    const localPhase = t * humps - humpIdx;
    const bump = Math.sin(Math.PI * localPhase);
    const amp = amps[humpIdx] * Math.max(0, bump);
    const x = x0 + t * totalW;
    const y = BASELINE - amp * maxAmp;
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(" ");
}

const RIPPLES = {
  // Resonance I: decays quickly, tallest bump first (a "saw-tooth" ramp of peak heights).
  6: rippleFromAmps([1.0, 0.82, 0.63, 0.43, 0.25, 0.11]),
  // Resonance II: symmetric rise-then-fall, tallest in the middle two bumps (a "triangle" of peak heights).
  7: rippleFromAmps([0.15, 0.54, 1.0, 1.0, 0.53, 0.13]),
  // Resonance III: stays near full height for the first three bumps, then drops off (a "trapezoid" of peak heights).
  8: rippleFromAmps([1.0, 0.99, 0.99, 0.84, 0.54, 0.14]),
};

export const WAVE_NAMES = {
  1: "Saw-tooth", 2: "Square", 3: "Pulse", 4: "Double Sine", 5: "Saw-Pulse",
  6: "Resonance I", 7: "Resonance II", 8: "Resonance III",
};

function buildIconSvg() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", VIEWBOX);
  svg.classList.add("icon-glyph");
  const shape = document.createElementNS(SVG_NS, "path");
  shape.classList.add("icon-glyph-line");
  svg.appendChild(shape);
  return { svg, shape };
}

export class WaveformIcon {
  constructor({ value = 1 } = {}) {
    const { svg, shape } = buildIconSvg();
    this.svg = svg;
    this.shape = shape;
    this.el = svg;
    this.setValue(value);
  }

  setValue(n) {
    const isRipple = n >= 6 && RIPPLES[n];
    const tag = isRipple ? "polyline" : "path";
    if (this.shape.tagName.toLowerCase() !== tag) {
      const next = document.createElementNS(SVG_NS, tag);
      next.classList.add("icon-glyph-line");
      this.svg.replaceChild(next, this.shape);
      this.shape = next;
    }
    if (isRipple) {
      this.shape.setAttribute("points", RIPPLES[n]);
      this.shape.removeAttribute("d");
    } else {
      this.shape.setAttribute("d", PATHS[n] ?? PATHS[1]);
      this.shape.removeAttribute("points");
    }
  }
}

/**
 * A small icon button that doubles as a dropdown: clicking it opens a
 * popup grid of all 8 waveform icons to pick from.
 * @param {object} opts
 * @param {string} [opts.label]
 * @param {number} opts.value
 * @param {(v:number)=>void} opts.onChange
 * @returns {{el: HTMLElement, setValue: (v:number)=>void}}
 */
export function createWaveformPicker({ label, value, onChange }) {
  const choices = Object.entries(WAVE_NAMES).map(([v, name]) => ({ value: Number(v), label: name }));
  return createIconDropdown({
    label,
    choices,
    value,
    onChange,
    renderIcon: (v) => new WaveformIcon({ value: v }).el,
  });
}
