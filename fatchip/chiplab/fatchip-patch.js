// Fat Chip patches -> Fat Chip 64's live patch bytes and SysEx: the JavaScript twin of tools/gen_patches.py.
// Chip Lab uses it to send a patch to the C64. test/test_patch_js.py checks that both give the same bytes for
// every built-in patch, so change the two together.
// Use: const fc = FatChipPatch.make(effectsJson, layoutJson); fc.bytes(patch); fc.sysex(patch)
(function (root) {
  "use strict";

  // Python's round(): halves go to the even number (gen_patches.py rounds this way)
  function pyRound(x) {
    const f = Math.floor(x), d = x - f;
    if (Math.abs(d - 0.5) < 1e-9) return f % 2 === 0 ? f : f + 1;
    return Math.round(x);
  }
  const ccv = (param, mx) => Math.min(127, Math.ceil(param * 128 / (mx + 1)));
  const inc4 = hz => pyRound(hz * 65536 / 250);
  function nearest(values, x, log = true) {
    const f = log ? v => Math.log(Math.max(v, 1e-6)) : v => v;
    let best = 0;
    for (let i = 1; i < values.length; i++) if (Math.abs(f(values[i]) - f(x)) < Math.abs(f(values[best]) - f(x))) best = i;
    return best;
  }
  const GB_TICK_HZ = 59.73;
  const GB_LFO_HZ = Array.from({ length: 32 }, (_, i) =>
    Math.max(1, Math.min(65535, pyRound(0.08 * Math.pow(24 / 0.08, i / 31) * 65536 / GB_TICK_HZ))) * GB_TICK_HZ / 65536);
  const GB_LFO_DEPTH = Array.from({ length: 32 }, (_, d) => d ? pyRound(192 * Math.pow(d / 31, 2.2)) : 0);
  const GB_GLIDE = [0].concat(Array.from({ length: 15 }, (_, i) => Math.max(3, pyRound(256 * Math.pow(0.6, (i + 1) * 0.55)))));
  const GB_SHAPES = { "TRI": 0, "SINE": 0, "SAW DOWN": 1, "SAW UP": 2, "SQUARE": 3, "RANDOM": 4 };
  const SID_WAVES = [0x10, 0x20, 0x40, 0x80, 0x30, 0x50, 0x60, 0x70];
  const REPEAT_NATIVE = [0, 1, 2, 3, 4, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
  const gbEnvN = (ms, level) => level <= 0 ? 0 : Math.max(0, Math.min(7, pyRound(ms / 1000 * 64 / level)));
  function gbGlide(ms) {
    if (!ms) return 0;
    const tau = g => 1000 / GB_TICK_HZ / -Math.log(1 - GB_GLIDE[g] / 256);
    let best = 1;
    for (let g = 2; g < 16; g++) if (Math.abs(Math.log(tau(g)) - Math.log(ms)) < Math.abs(Math.log(tau(best)) - Math.log(ms))) best = g;
    return best;
  }
  function gbDepth(cents) {
    let best = 0;
    for (let d = 1; d < 32; d++) if (Math.abs(GB_LFO_DEPTH[d] * 100 / 16 - cents) < Math.abs(GB_LFO_DEPTH[best] * 100 / 16 - cents)) best = d;
    return best;
  }
  const BLIP_STEPS = [3, 4, 5, 8, 10];
  const GB_PENV = [131, 156, 178, 195, 209, 221, 229, 236, 241, 245, 248, 250, 251, 253, 253, 254];
  const bendK = ms => Math.max(1, Math.min(9, pyRound(Math.log2(ms / 12))));
  function gbPenvT(ms) {
    const e = i => Math.abs(Math.log(3000 / GB_TICK_HZ / Math.log(256 / GB_PENV[i])) - Math.log(ms));
    let best = 0;
    for (let i = 1; i < 16; i++) if (e(i) < e(best)) best = i;
    return best;
  }
  function nesEnv(a, d, s, r, peak) {
    const sus = s > 0 ? Math.max(1, pyRound(peak * s)) : 0;
    const atk = a < 0.015 ? 0 : Math.max(1, Math.min(255, pyRound(peak * 256 / (a * 100))));
    const dec = d === 0 || sus >= peak ? 0 : Math.max(1, Math.min(255, pyRound((peak - sus) * 256 / (d * 100))));
    const rel = r < 0.01 ? 0 : Math.max(1, Math.min(68, pyRound(10240 / (r * 1000))));
    return [atk, dec, sus, rel];
  }

  function make(DEF, LAYOUT) {
    const EFFECTS = Object.fromEntries(DEF.effects.map(e => [e.id, e]));
    const SID_ATK = DEF.lists.sidAttackMs, SID_DR = DEF.lists.sidDecayReleaseMs;
    const GLIDE_MS = EFFECTS.glide.params.find(q => q.id === "time").values.map(v => parseInt(v, 10));
    const ALL = ["sid", "gb", "nes"];

    // patch settings and the parameters of every effect that's on (defaults filled in), and each effect's chips
    function settings(p) {
      const ps = Object.fromEntries(DEF.patch.map(q => [q.id, q.default]));
      for (const k of Object.keys(p)) if (k in ps) ps[k] = p[k];
      const on = {}, chips = {}, fx = p.fx || {};
      for (const e of DEF.effects) {
        if (!(e.id in fx) && !e.alwaysOn) continue;
        const given = { ...(fx[e.id] || {}) };
        chips[e.id] = new Set(given.on || e.chips || ALL);
        delete given.on;
        const vals = Object.fromEntries(e.params.map(q => [q.id, q.default]));
        Object.assign(vals, given);
        on[e.id] = vals;
      }
      return { ps, on, chips };
    }

    function fields(p) {
      const { ps, on, chips } = settings(p), f = {};
      const has = (eid, chip) => eid in on && chips[eid].has(chip);
      const tone = on.tone, env = on.env;
      f.sndMono = ps.mono;
      const rp = on.repeat;
      f.sndRp = rp ? 1 : 0;
      f.sndRpTime = rp ? REPEAT_NATIVE[rp.time] : 1;
      f.sndRpCount = (rp ? rp.repeats : 3) - 1;
      f.sndRpLevel = Math.max(0, Math.min(5, pyRound((100 - (rp ? rp.level : 70)) / 10)));
      f.sndFat = ps.fatBass;
      // SID
      const sus = env.sustain;
      f.sndAD = nearest(SID_ATK, env.attack) << 4 | nearest(SID_DR, env.decay);
      f.sndSR = sus << 4 | nearest(SID_DR, env.release);
      f.sndWave = SID_WAVES[tone.sidWave];
      f.sndPwLo = tone.sidPw & 255;
      f.sndPwHi = tone.sidPw >> 8;
      f.sndPwVoice = tone.sidPwSpread;
      const det = on.detune ? on.detune.cents : 0;
      f.sndDet = has("detune", "sid") || has("detune", "nes") ? pyRound(det * 8 / 7) : 0;
      f.sndOct = ps.octSid * 12 & 255;
      const gl = on.glide;
      f.sndGlide = gl && (has("glide", "sid") || has("glide", "nes")) ? gl.time + 3 : 0;
      const fl = on.filter;
      f.sndCut = fl ? fl.cutoff : 0;
      f.sndRes = fl ? (fl.resonance << 4 | 7) : 0;
      f.sndFDep = fl ? fl.lfoDepth : 0;
      let r = fl && fl.lfoDepth ? inc4(fl.filtLfoRate) : 0;
      f.sndFRateL = r & 255; f.sndFRateH = r >> 8;
      f.sndFEnv = fl ? Math.max(0, fl.envAmount) : 0;
      const pw = has("pwm", "sid") ? on.pwm : null;
      f.sndPwm = pw ? pyRound(pw.depth * 1.27) : 0;
      r = pw ? inc4(pw.pwmRate) : 0;
      f.sndPwmRL = r & 255; f.sndPwmRH = r >> 8;
      const v = has("vibrato", "sid") || has("vibrato", "nes") ? on.vibrato : null;
      f.sndVib = v ? Math.min(127, pyRound(v.depth / 100 * 0.0595 * 4096)) : 0;
      r = v ? inc4(v.vibRate) : 0;
      f.sndVibRL = r & 255; f.sndVibRH = r >> 8;
      f.sndVibDel = v ? Math.min(255, pyRound(v.delay / 4)) : 0;
      f.sndVibSpr = v && v.drift > 0 ? 1 : 0;
      const ds = on.dutyseq;
      f.sndSeq = ds ? ds.pattern + 1 : 0;
      f.sndSeqMs = ds ? Math.min(255, Math.floor(ds.stepMs / 4)) : 0;
      f.sndSeqSid = ds && chips.dutyseq.has("sid") ? 1 : 0;
      // Game Boy (CC values)
      const lvl = ps.lvlGbPulse;
      const [ga, gd, gs, gr] = env.gbEnv ? [env.gbAttack, env.gbDecay, env.gbSustain, env.gbRelease] : [env.attack, env.decay, sus, env.release];
      f.gbAtk = ccv(gbEnvN(ga, lvl), 7);
      f.gbDec = ccv(gs >= 8 ? 0 : gbEnvN(gd, lvl), 7);
      f.gbRel = ccv(gbEnvN(gr, lvl), 7);
      f.gbDuty1 = ccv(tone.gbDuty1, 3);
      f.gbDuty2 = ccv(tone.gbDuty2, 3);
      const g = gl && has("glide", "gb") ? gbGlide(GLIDE_MS[gl.time]) : 0;
      f.gbGl1 = f.gbGl2 = f.gbGlW = ccv(g, 15);
      const mode = tone.gbWaveMode;
      f.gbWMode = ccv(mode, 6);
      f.gbWShape = mode === 1 ? 64 : mode === 2 ? 0 : ccv(tone.gbWaveShape, 15);
      const w = has("warble", "gb") ? on.warble : null;
      f.gbWarb = w ? Math.ceil(w.amount * 2.56 - 1e-9) : 0;
      f.gbWSpd = w ? w.speed : 40;
      const vb = has("vibrato", "gb") ? on.vibrato : null, pm = has("pwm", "gb") ? on.pwm : null;
      let lf = null;
      if (vb) lf = [0, GB_SHAPES[DEF.lists.shapes[vb.shape]], nearest(GB_LFO_HZ, vb.vibRate), gbDepth(vb.depth), Math.min(15, pyRound(vb.delay / (8000 / GB_TICK_HZ)))];
      else if (pm) lf = [1, GB_SHAPES[DEF.lists.shapes[pm.shape]], nearest(GB_LFO_HZ, pm.pwmRate), pyRound(pm.depth * 31 / 100), 0];
      f.gbLDest = lf ? ccv(lf[0], 2) : 0;
      f.gbLShape = lf ? ccv(lf[1], 4) : 0;
      f.gbLRate = lf ? ccv(lf[2], 31) : 0;
      f.gbLDepth = lf ? ccv(lf[3], 31) : 0;
      f.gbLDelay = lf ? ccv(lf[4], 15) : 0;
      const steps = pyRound((has("detune", "gb") ? det : 0) / 1.5625);
      f.gbDetA = Math.max(0, (32 - steps) * 2);
      f.gbDetB = Math.min(127, (32 + steps) * 2);
      f.gbLvl = ccv(lvl, 15);
      f.gbLvlW = ccv(ps.lvlGbWave, 15);
      f.gbOct = ps.octGb * 12 & 255;
      // MidiNES (the C64's software envelope)
      const peak = ps.lvlNes;
      const [na, nd, ns, nr] = env.nesEnv ? [env.nesAttack, env.nesDecay, env.nesSustain, env.nesRelease] : [env.attack, env.decay, sus, env.release];
      const flat = na <= 2 && ns === 15 && nr <= 6;
      f.nesEnv = flat ? 0 : 1;
      const [a, d, s, rr] = nesEnv(na / 1000, nd / 1000 * (1 - ns / 15), ns / 15, nr / 1000, peak);
      f.nesAtk = flat ? 0 : a; f.nesDec = flat ? 0 : d;
      f.nesSus = flat ? 15 : s;
      f.nesPeak = peak;
      f.nesRel = flat ? 0 : rr;
      f.nesDuty1 = tone.nesDuty1 * 32;
      f.nesDuty2 = tone.nesDuty2 * 32;
      const t = has("tremolo", "nes") || has("tremolo", "sid") ? on.tremolo : null;
      f.nesTrem = t ? pyRound(t.depth * 15 / 100) : 0;
      r = t ? pyRound(t.tremRate * 65536 / 100) : 0;
      f.nesTremRL = r & 255; f.nesTremRH = r >> 8;
      f.nesTremSq = t && DEF.lists.shapes[t.shape] === "SQUARE" ? 1 : 0;
      // v0.30
      f.nesTremSync = t ? t.tremSync : 0;
      f.nesTremMode = t ? t.mode : 0;
      f.sndRpShift = rp ? rp.shift & 255 : 0;
      f.sndRpMode = rp ? (rp.shiftIn | rp.hop << 1) : 0;
      const at = has("attack", "sid") ? on.attack : null;
      f.sndBlip = at ? at.blip : 0;
      f.sndBlipT = at ? BLIP_STEPS[at.blipMs] : 5;
      f.sndClick = at ? at.click : 0;
      const pe = has("penv", "sid") || has("penv", "nes") ? on.penv : null;
      f.sndPenv = pe ? pe.amount & 255 : 0;
      f.sndPenvK = pe ? bendK(pe.time) : 0;
      const pg = has("penv", "gb") ? on.penv : null;
      f.gbPenvA = ccv(pg ? pg.amount + 24 : 24, 48);
      f.gbPenvT = ccv(pg ? gbPenvT(pg.time) : 0, 15);
      const rd = has("rdrop", "sid") ? on.rdrop : null;
      f.sndRdrop = rd ? rd.amount : 0;
      const ra = on.rdrop;
      f.sndRdropK = ra ? bendK(ra.time) : 0;
      // v0.31: BEND OUT on the NES (a bend while it fades, or a fall-off) and the Game Boy (CC 87 / 88)
      const rn = has("rdrop", "nes") ? ra : null;
      f.nesRdrop = rn ? rn.amount : 0;
      f.sndRdropT = rn ? Math.min(255, pyRound(rn.time / 10)) : 0;
      const rg = has("rdrop", "gb") ? ra : null;
      f.gbRdA = rg ? rg.amount : 0;
      f.gbRdT = rg ? gbPenvT(rg.time) * 8 : 0;
      // v0.33: the patch's tremolo on the SID too (its master volume): bit 0 the NES, bit 1 the SID
      f.tremChips = (has("tremolo", "nes") ? 1 : 0) | (has("tremolo", "sid") ? 2 : 0);
      return f;
    }

    // the PATCH_SIZE bytes, in the C64's order (LAYOUT.fields), then the name
    function bytes(p) {
      const f = fields(p);
      const name = String(p.name || "").toUpperCase().replace(/[^ -Z]/g, " ").slice(0, LAYOUT.nameLen).padEnd(LAYOUT.nameLen, " ");
      return LAYOUT.fields.map(k => f[k] & 255).concat([...name].map(ch => ch.charCodeAt(0)), [0]);
    }
    function sysex(p) {
      const b = bytes(p);
      return [0xF0, ...LAYOUT.sysexHead, b.length, ...b.flatMap(x => [x >> 4, x & 15]), 0xF7];
    }
    return { settings, fields, bytes, sysex };
  }

  const api = { make, pyRound };
  root.FatChipPatch = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
