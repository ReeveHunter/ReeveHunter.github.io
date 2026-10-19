// tryout.js - TEMPORARY: audition candidate starter patches on the C64 and mark which to keep.
// To remove: delete this file, the <section id="tryout"> in index.html, the import + initTryout()
// call in app.js and the "tryout" rules in style.css.

import { patchFromPreset, normalizePatch, MODES, FX, WAVE_NAMES } from "./engine.js";

/** Candidates in the app's units (CUT and PW internal = screen value × 2). */
function make(name, idea, o, voices) {
  const p = patchFromPreset(0);
  Object.assign(p, { name, tune: 4, vol: 15, vibD: 0, vibS: 0, trmD: 0, trmS: 0, fx: 0 }, o);
  p.voices = [0, 1, 2].map((i) => ({ ...p.voices[i], ...voices(i) }));
  return { id: name.toLowerCase().replace(/\W+/g, "-"), idea, patch: normalizePatch(p) };
}
const all = (v) => () => v;
export const CANDIDATES = [
  make("Hubbard Bass", "Tight plucky bass: fast filter drop per note (Hubbard's beat-locked basslines).",
    { mode: 7, fx: 3, oct: 0, fType: 1, cut: 80, res: 10 },
    all({ wave: 2, mod: 0, pw: 64, flt: 1, a: 0, d: 8, s: 4, r: 3 })),
  make("Square Lead", "Soft, round square-wave melody (Chimera).",
    { mode: 7, oct: 2, vibD: 5, vibS: 2 },
    all({ wave: 2, mod: 0, pw: 128, flt: 0, a: 1, d: 9, s: 10, r: 5 })),
  make("Glide Lead", "Glissando square solo (Zoids).",
    { mode: 9, oct: 2, vibD: 7, vibS: 2 },
    all({ wave: 2, mod: 0, pw: 96, flt: 0, a: 0, d: 9, s: 11, r: 6 })),
  make("PWM Strings", "Galway-style slowly shifting pulse width pad.",
    { mode: 0, fx: 6, oct: 1, fType: 1, cut: 180, res: 4 },
    all({ wave: 2, mod: 0, pw: 128, flt: 1, a: 6, d: 9, s: 12, r: 9 })),
  make("Shimmer Arp", "Fast one-voice arpeggio chords (Ocean Loader): hold a chord.",
    { mode: 10, oct: 2 },
    all({ wave: 2, mod: 0, pw: 128, flt: 0, a: 0, d: 7, s: 10, r: 4 })),
  make("Saw Arp", "Sawtooth arpeggios with a slow filter drift (Mutants).",
    { mode: 11, fx: 1, oct: 2, fType: 1, cut: 140, res: 8 },
    all({ wave: 1, mod: 0, pw: 128, flt: 1, a: 0, d: 8, s: 9, r: 4 })),
  make("Ring Bell", "Metallic ringing tone from ring modulation (Hubbard). Check by ear: depends on MONO1's voice tuning.",
    { mode: 6, oct: 2 },
    (i) => ({ wave: 0, mod: i ? 1 : 0, pw: 128, flt: 0, a: 0, d: 10, s: 0, r: 10 })),
  make("Sync Buzz", "Fixed hard-sync timbre on the fifth (no sync sweep possible). Check by ear.",
    { mode: 1, oct: 1, fType: 1, cut: 200, res: 6 },
    (i) => ({ wave: 1, mod: i === 1 ? 2 : 0, pw: 128, flt: 1, a: 0, d: 9, s: 12, r: 5 })),
  make("Stutter Lead", "Fluttering notes from a fast volume LFO (Chimera). Custom build only (tremolo).",
    { mode: 7, oct: 2, trmD: 15, trmS: 22 },
    all({ wave: 2, mod: 0, pw: 128, flt: 0, a: 0, d: 9, s: 12, r: 5 })),
  make("Noise Riser", "Filtered noise and saw that opens while held (Chimera's riser).",
    { mode: 0, fx: 2, oct: 1, fType: 1, cut: 40, res: 12 },
    (i) => ({ wave: i ? 1 : 3, mod: 0, pw: 128, flt: 1, a: 8, d: 10, s: 13, r: 10 })),
  make("Noise Snare", "Playable percussion hit from band-passed noise.",
    { mode: 0, oct: 2, fType: 2, cut: 160, res: 2 },
    all({ wave: 3, mod: 0, pw: 128, flt: 1, a: 0, d: 6, s: 0, r: 6 })),
  make("Octave Organ", "Drawbar organ from three stacked octaves.",
    { mode: 6, oct: 1, vibD: 2, vibS: 3 },
    (i) => ({ wave: i === 1 ? 2 : 0, mod: 0, pw: 128, flt: 0, a: 0, d: 0, s: 15, r: 2 })),
];

const KEY = "cynthcart.tryout";
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? {}; } catch { return {}; } };
const save = (s) => { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {} };

/** A readable summary of a patch: one line, screen units. */
export function describe(p) {
  const vs = p.voices.map((v, i) =>
    `v${i + 1} ${WAVE_NAMES[v.wave]}${v.mod & 1 ? "+ring" : ""}${v.mod & 2 ? "+sync" : ""} PW${v.pw >> 1} ${v.flt ? "FLT" : "dry"} ADSR ${v.a}/${v.d}/${v.s}/${v.r}`).join("; ");
  return `${MODES[p.mode]}, FX ${FX[p.fx]}, OCT ${p.oct}, CUT ${p.cut >> 1}, RES ${p.res}, type ${p.fType}, VOL ${p.vol}, VIB ${p.vibD}/${p.vibS}, TRM ${p.trmD}/${p.trmS} | ${vs}`;
}

/**
 * hooks: el(tag, props, ...kids), getPatch(), loadPatch(patch) (load into the editor and send), status(text, kind)
 */
export function initTryout(host, { el, getPatch, loadPatch, status }) {
  const state = load(); // { id: { keep, note, edited } }
  const list = el("ol", { className: "tryout-list" });
  const count = el("span", { className: "count" });
  const copyBtn = el("button", { type: "button", className: "btn primary small", textContent: "Copy results" });
  const dlBtn = el("button", { type: "button", className: "btn ghost small", textContent: "Download .txt" });
  host.append(
    el("div", { className: "card-head" },
      el("h2", {}, "Patch tryout ", count),
      el("div", { className: "head-actions" }, copyBtn, dlBtn)),
    el("p", { className: "hint" }, "Temporary. Load each candidate, play it on the C64, tweak it if you like and press ", el("b", {}, "Use my edits"),
      ", then tick ", el("b", {}, "Keep"), ". When you're done, copy or download the results and hand them back."),
    list,
  );
  const st = (id) => (state[id] ??= {});
  function render() {
    list.replaceChildren();
    let kept = 0;
    for (const c of CANDIDATES) {
      const s = st(c.id);
      if (s.keep) kept++;
      const keep = el("input", { type: "checkbox", checked: !!s.keep });
      keep.addEventListener("change", () => { s.keep = keep.checked; save(state); render(); });
      const loadBtn = el("button", { type: "button", className: "btn small", textContent: "Load" });
      loadBtn.addEventListener("click", () => { loadPatch(normalizePatch(s.edited ?? c.patch)); status(`Loaded “${c.patch.name}”${s.edited ? " (your edits)" : ""}.`); });
      const useBtn = el("button", { type: "button", className: "btn ghost small", textContent: "Use my edits", title: "Store the sound now in the editor as this candidate's version" });
      useBtn.addEventListener("click", () => {
        const p = structuredClone(getPatch());
        p.name = c.patch.name;
        s.edited = p; save(state); render();
        status(`Stored your edits for “${c.patch.name}”.`, "ok");
      });
      const reset = el("button", { type: "button", className: "btn ghost small", textContent: "Reset", hidden: !s.edited, title: "Forget your edits for this one" });
      reset.addEventListener("click", () => { delete s.edited; save(state); render(); });
      const note = el("input", { type: "text", className: "tryout-note", placeholder: "Notes (optional)", value: s.note ?? "" });
      note.addEventListener("input", () => { s.note = note.value; save(state); });
      list.append(el("li", { className: s.keep ? "kept" : "" },
        el("div", { className: "tryout-top" },
          el("label", { className: "tryout-keep" }, keep, el("span", {}, "Keep")),
          el("div", { className: "tryout-name" }, el("b", {}, c.patch.name), s.edited ? el("span", { className: "badge" }, "edited") : null,
            el("small", {}, c.idea)),
          el("div", { className: "tryout-btns" }, loadBtn, useBtn, reset)),
        note));
    }
    count.textContent = `(${kept} of ${CANDIDATES.length} kept)`;
  }
  function results() {
    const lines = [`Cynthcart patch tryout, ${new Date().toISOString().slice(0, 10)}`, ""];
    for (const c of CANDIDATES) {
      const s = st(c.id);
      const p = s.edited ?? c.patch;
      lines.push(`${s.keep ? "KEEP" : "skip"}  ${c.patch.name}${s.edited ? " (edited)" : ""}${s.note ? `  - ${s.note}` : ""}`);
      if (s.keep) {
        lines.push(`      ${describe(p)}`);
        lines.push(`      ${JSON.stringify(p)}`);
      }
    }
    return lines.join("\n") + "\n";
  }
  copyBtn.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(results()); status("Results copied. Paste them into the chat.", "ok"); }
    catch { status("The browser didn't allow copying; use Download .txt instead.", "warn"); }
  });
  dlBtn.addEventListener("click", () => {
    const url = URL.createObjectURL(new Blob([results()], { type: "text/plain" }));
    const a = el("a", { href: url, download: "cynthcart-tryout.txt" });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  render();
}
