// curves.js
// Generates a full 8-stage {rate, level, sustain} envelope shape from a
// handful of musical parameters (speed, peak level, base/sustain level,
// how many of the 8 stages to use). These are starting points, not
// finished patches - every generated stage is fully editable afterward on
// the graph or in the numeric strip.
//
// hasSustainFlag controls whether a generated "hold" stage gets marked as
// a true CZ sustain point (only meaningful for DCW envelopes, per the
// source SysEx spec - see sysex.js). For DCA/DCO, "hold" stages are just
// flat repeated stages, an approximation of a sustain since those envelope
// types have no documented sustain-point bit.
//
// Curve shapes: envelope/automation editors generally offer some mix of
// linear (constant rate of change), exponential (fast then slow - the
// natural shape of a decaying physical resonance, and how many analog
// envelope generators actually behave), logarithmic (the mirror of
// exponential - fast then leveling off), and S-curve/sigmoid (eased at
// both ends, smoothstep-shaped - common for automation that shouldn't
// sound mechanical). linearRamp, expDecay, logRise, and sCurve below are
// direct implementations of those four; adsr/pluck/cycle are named,
// musically-shaped presets built from the same underlying math.

function clamp(v, lo = 0, hi = 99) {
  return Math.max(lo, Math.min(hi, v));
}
function stage(rate, level, sustain = false) {
  return { rate: Math.round(clamp(rate)), level: Math.round(clamp(level)), sustain };
}
function finish(stages, endStep) {
  const out = stages.slice(0, 8);
  const last = out[out.length - 1] ?? { rate: 0, level: 0, sustain: false };
  while (out.length < 8) out.push({ rate: last.rate, level: last.level, sustain: false });
  return { stages: out, endStep: clamp(endStep, 0, 7) };
}

export const CURVE_PRESETS = {
  // The four "textbook" curve shapes used across synth envelope/automation
  // editors (linear, exponential, logarithmic, S-curve/sigmoid) - see the
  // module comment below for where these come from - plus a few
  // instrument-shaped presets built out of them (ADSR, pluck, cycle).
  linearRamp: {
    label: "Linear ramp",
    description: "A straight, even move from a starting level to an ending level at a constant rate - plain fades or filter sweeps. Set base above peak to ramp down instead of up.",
    generate({ speed = 50, peak = 99, base = 0, numStages = 8 }) {
      const n = clamp(numStages, 2, 8);
      const stages = [];
      for (let i = 0; i < n; i++) {
        const frac = i / (n - 1);
        stages.push(stage(speed, base + (peak - base) * frac));
      }
      return finish(stages, n - 1);
    },
  },
  expDecay: {
    label: "Exponential decay",
    description: "Fast rise, then a progressively slowing fall - a natural pluck/string/drum decay.",
    generate({ speed = 70, peak = 99, base = 0, numStages = 5 }) {
      const n = clamp(numStages, 2, 8);
      const stages = [stage(clamp(speed + 20), peak)];
      for (let i = 1; i < n; i++) {
        const frac = i / (n - 1);
        stages.push(stage(speed * (1 - frac * 0.6), base + (peak - base) * Math.pow(1 - frac, 2)));
      }
      return finish(stages, n - 1);
    },
  },
  logRise: {
    label: "Logarithmic rise",
    description: "Quick to start, then leveling off well before the last stage - the mirror of exponential decay. Good for a fast-opening filter or a fade that feels \"done\" early.",
    generate({ speed = 70, peak = 99, base = 0, numStages = 5 }) {
      const n = clamp(numStages, 2, 8);
      const stages = [];
      for (let i = 0; i < n; i++) {
        const frac = i / (n - 1);
        stages.push(stage(speed * (1 - frac * 0.5), base + (peak - base) * (1 - Math.pow(1 - frac, 3))));
      }
      return finish(stages, n - 1);
    },
  },
  sCurve: {
    label: "S-curve swell",
    description: "A smooth ease-in/ease-out move - slow to start, quickest through the middle, slow to settle. Good for pads, strings, or any change that shouldn't feel mechanical.",
    generate({ speed = 50, peak = 99, base = 0, numStages = 8 }) {
      const n = clamp(numStages, 2, 8);
      const stages = [];
      for (let i = 0; i < n; i++) {
        const frac = i / (n - 1);
        const eased = frac * frac * (3 - 2 * frac); // smoothstep
        stages.push(stage(speed, base + (peak - base) * eased));
      }
      return finish(stages, n - 1);
    },
  },
  adsr: {
    label: "Classic ADSR",
    description: "Attack / Decay / Sustain hold / Release, spread across however many stages you allow.",
    generate({ speed = 70, peak = 99, base = 60, numStages = 6, hasSustainFlag = false }) {
      const n = clamp(numStages, 2, 8);
      const stages = [stage(clamp(speed + 20), peak)]; // attack
      if (n >= 4) {
        stages.push(stage(speed, base)); // decay to sustain level
        const holdCount = n - 3;
        for (let i = 0; i < holdCount; i++) stages.push(stage(10, base, hasSustainFlag && i === holdCount - 1));
      } else if (n === 3) {
        stages.push(stage(speed, base, hasSustainFlag)); // decay-to-sustain doubles as the hold
      }
      stages.push(stage(clamp(speed * 0.6), 0)); // release
      return finish(stages, n - 1);
    },
  },
  pluck: {
    label: "Percussive pluck",
    description: "Near-instant peak, then an immediate decay to zero - mallet hits or a snappy DCW transient.",
    generate({ speed = 90, peak = 99, base = 0, numStages = 3 }) {
      const n = clamp(numStages, 2, 8);
      const stages = [stage(99, peak)];
      for (let i = 1; i < n; i++) {
        const frac = i / (n - 1);
        stages.push(stage(speed * (1 - frac * 0.3), base + (peak - base) * Math.pow(1 - frac, 3)));
      }
      return finish(stages, n - 1);
    },
  },
  cycle: {
    label: "Cycle / wobble",
    description: "Rises and falls repeatedly across the available stages - rhythmic timbral movement, mostly for DCW.",
    generate({ speed = 60, peak = 90, base = 20, numStages = 8 }) {
      const n = clamp(numStages, 2, 8);
      const stages = [];
      for (let i = 0; i < n; i++) stages.push(stage(speed, i % 2 === 0 ? peak : base));
      return finish(stages, n - 1);
    },
  },
};
