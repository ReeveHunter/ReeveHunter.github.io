import { store } from './store.js';
import * as C from './curriculum.js';
import { Input, Synth, Piano } from './input.js';
import { Stage, WaitSession, FlowSession } from './practice.js';
import { renderLine } from './staff.js';
import { noteName, keyLabel, keyById, midiOf, positionWords, INTERVAL_NAMES, LETTERS } from './music.js';

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const P = () => store.profile;

const input = new Input();
const synth = new Synth();
let piano, stage;
let session = null;
let current = { track: null, mode: 'wait' };
let live = null;
let overlayUnsub = null;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function init() {
  store.init();
  piano = new Piano($('#piano'), input);
  stage = new Stage($('#stage'));

  input.onStatus = updateMidiPill;
  if (!navigator.requestMIDIAccess) $('#unsupported').hidden = false;
  input.initMidi();

  input.on(ev => {
    const s = P().settings;
    const want = ev.source === 'midi' ? s.soundMidi : s.soundKeys;
    if (ev.type === 'on') { piano.setDown(ev.midi, true); if (want) synth.noteOn(ev.midi, ev.vel); }
    else { piano.setDown(ev.midi, false); synth.noteOff(ev.midi); }
  });
  const unlockAudio = () => { synth.ensure(); window.removeEventListener('pointerdown', unlockAudio); window.removeEventListener('keydown', unlockAudio); };
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);

  document.querySelectorAll('.navbtn[data-view]').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#brandLink').addEventListener('click', e => { e.preventDefault(); showView('home'); });
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#midiPill').addEventListener('click', () => input.initMidi());
  $('#backBtn').addEventListener('click', () => showView('home'));
  $('#modeSeg').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]');
    if (!b || b.disabled || b.dataset.mode === current.mode) return;
    current.mode = b.dataset.mode;
    P().mode = P().mode || {};
    P().mode[current.track] = current.mode;
    store.save();
    setupPracticeHeader();
    beginSession();
  });
  $('#tDown').addEventListener('click', () => nudgeTempo(-4));
  $('#tUp').addEventListener('click', () => nudgeTempo(4));
  setupProfileMenu();
  updateKbHelp();
  applySettings();
  showView('home');

  // test hook for automated checks
  window.__sr = { input, store, C, get session() { return session; } };
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------
function showView(name) {
  if (name !== 'practice') stopSession();
  for (const v of ['home', 'practice', 'stats']) $('#view-' + v).hidden = v !== name;
  document.querySelectorAll('.navbtn[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name || (name === 'practice' && b.dataset.view === 'home')));
  if (name === 'home') renderHome();
  if (name === 'stats') renderStats();
  window.scrollTo(0, 0);
}

function stopSession() {
  if (session) session.stop();
  session = null;
  hideOverlay();
  piano?.mark([], 'hint');
  piano?.mark([], 'target');
}

function applySettings() {
  const s = P().settings;
  $('#pianoWrap').hidden = !s.showKeyboard;
}

// ---------------------------------------------------------------------------
// Confidence colors
// ---------------------------------------------------------------------------
function confColor(id) {
  const p = P();
  if (!C.calibrated(p, id)) return null;
  const c = C.conf(p, id);
  const x = Math.max(0, Math.min(1, (c - 0.3) / (C.GREEN - 0.3)));
  const hue = 6 + x * 128;
  return `hsl(${hue.toFixed(0)} 50% ${C.isGreen(p, id) ? 38 : 45}%)`;
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------
const UNITS = { notes: 'notes learned', intervals: 'intervals', melodies: 'levels passed', keys: 'keys', chords: 'chord shapes' };
const ORDER_IDS = { notes: C.NOTES.map(n => n.id), intervals: C.INTERVALS, keys: C.KEY_ITEMS, chords: C.CHORDS };

function recommend() {
  const p = P();
  if (p.tracks.notes.unlocked < 10) return 'notes';
  const avail = C.TRACKS.filter(t => t.available(p));
  return avail.sort((a, b) => (p.lastPlayed[a.id] || 0) - (p.lastPlayed[b.id] || 0))[0].id;
}

function focusText(track) {
  const p = P();
  if (track === 'melodies') {
    const lv = C.MELODY_LEVELS[Math.min(p.tracks.melodies.level, C.MELODY_LEVELS.length - 1)];
    return `Level ${Math.min(p.tracks.melodies.level + 1, C.MELODY_LEVELS.length)}: ${lv.name.toLowerCase()}.`;
  }
  const ids = C.unlockedIds(p, track);
  const f = C.focusOf(p, ids);
  if (!f) return '';
  const lab = C.itemLabel(f);
  if (track === 'notes') {
    const n = C.NOTES.find(x => x.id === f);
    return `Focus: ${lab.text}, ${positionWords(n.d, n.clef)} of the ${lab.sub} staff.`;
  }
  return `Focus: ${lab.text} ${lab.sub}.`;
}

function relTime(ts) {
  if (!ts) return 'not started';
  const d = (Date.now() - ts) / 86400000;
  if (d < 1 / 24) return 'just now';
  if (d < 1) return 'today';
  if (d < 2) return 'yesterday';
  return `${Math.floor(d)} days ago`;
}

function renderHome() {
  const p = P();
  const fresh = !p.history.length && !p.placement;
  const rec = recommend();
  const recT = C.trackById(rec);
  let hero;
  if (fresh) {
    hero = `
      <div class="continue">
        <div class="eyebrow">Welcome, ${esc(p.name)}</div>
        <h1>Where would you like to start?</h1>
        <p>If you can already read some notes, the placement test (about two minutes) skips what you know. Otherwise, start with three landmark notes and build out from there.</p>
        <div class="actions">
          <button class="btn primary" id="goPlacement">Take the placement test</button>
          <button class="btn" data-start="notes">Start from the first note</button>
        </div>
      </div>`;
  } else {
    const prog = C.trackProgress(p, rec);
    hero = `
      <div class="continue">
        <div class="eyebrow">Up next</div>
        <h1>${recT.name}</h1>
        <p>${esc(focusText(rec))} ${prog.done} of ${prog.total} ${UNITS[rec]}.</p>
        <div class="actions">
          <button class="btn primary" data-start="${rec}">Continue ▶</button>
          <button class="btn ghost" id="goPlacement">Placement test</button>
        </div>
      </div>`;
  }
  const howto = `
    <div class="howto">
      <h3>How it works</h3>
      <ol>
        <li>Plug in your MIDI keyboard and use Chrome or Edge. No piano nearby? Computer keys work too: <b>A S D F G H J K</b> are the white keys, <b>W E T Y U</b> the black keys, <b>Z / X</b> change octave.</li>
        <li><b>Wait mode</b> holds on each note until you play it, and times you. Each chip turns green once you play it quickly <i>and</i> accurately. When the chips are green, a new item unlocks.</li>
        <li><b>Flow mode</b> moves a playhead at a steady tempo and never waits. Keep going and don't stop to fix mistakes. That's what real sight-reading is.</li>
        <li>Ten focused minutes a day beats an hour once a week.</li>
      </ol>
    </div>`;

  const cards = C.TRACKS.map(t => {
    const avail = t.available(p);
    const prog = C.trackProgress(p, t.id);
    let chips = '';
    if (t.id === 'melodies') {
      chips = C.MELODY_LEVELS.map((l, i) => `<i style="${i < p.tracks.melodies.level ? 'background:var(--ok)' : ''}"></i>`).join('');
    } else {
      chips = ORDER_IDS[t.id].map((id, i) => {
        const col = i < prog.done ? confColor(id) : null;
        return `<i style="${col ? 'background:' + col : ''}${i >= prog.done ? ';opacity:.45' : ''}"></i>`;
      }).join('');
    }
    return `
      <div class="track ${avail ? '' : 'locked'}">
        <h3>${t.name}</h3>
        <p>${avail ? t.blurb : esc(t.lockText)}</p>
        ${avail ? `<div class="mini-chips">${chips}</div>` : ''}
        <div class="meta"><span>${prog.done} / ${prog.total} ${UNITS[t.id]}</span><span>${avail ? relTime(p.lastPlayed[t.id]) : 'locked'}</span></div>
        <div class="prog"><i style="width:${(100 * prog.done / prog.total).toFixed(1)}%"></i></div>
        ${avail ? `<div class="row">
          ${t.flowOnly ? '' : `<button class="btn primary" data-start="${t.id}" data-mode="wait">Practice</button>`}
          <button class="btn ${t.flowOnly ? 'primary' : ''}" data-start="${t.id}" data-mode="flow">${t.flowOnly ? 'Play' : 'Flow'}</button>
        </div>` : ''}
      </div>`;
  }).join('');

  $('#view-home').innerHTML = `
    <div class="hero">${hero}${howto}</div>
    <div class="section-h"><h2>Tracks</h2><span class="kbd">Progress is saved separately for each person in this browser</span></div>
    <div class="tracks">${cards}</div>`;
  $('#view-home').querySelectorAll('[data-start]').forEach(b => b.addEventListener('click', () => startPractice(b.dataset.start, b.dataset.mode)));
  $('#goPlacement')?.addEventListener('click', startPlacement);
}

// ---------------------------------------------------------------------------
// Practice
// ---------------------------------------------------------------------------
function defaultTempo(track) { return track === 'melodies' ? 60 : 50; }

function startPractice(track, mode) {
  const p = P();
  stopSession();
  p.mode = p.mode || {};
  current = { track, mode: track === 'melodies' ? 'flow' : (mode || p.mode[track] || 'wait') };
  p.mode[track] = current.mode;
  p.lastPlayed[track] = Date.now();
  store.save();
  showView('practice');
  live = { n: 0, ok: 0, ms: 0, timed: 0, streak: 0 };
  updateLive();
  setupPracticeHeader();
  renderChips();
  $('#msg').innerHTML = '&nbsp;';
  stage.clear();

  // intros for anything unlocked but not yet introduced
  let unseen;
  if (track === 'melodies') {
    const lv = C.MELODY_LEVELS[Math.min(p.tracks.melodies.level, C.MELODY_LEVELS.length - 1)];
    unseen = p.seen['m:' + lv.id] ? [] : ['m:' + lv.id];
  } else {
    unseen = C.unlockedIds(p, track).filter(id => !p.seen[id]);
    if (unseen.length > 3) { unseen.slice(0, -1).forEach(id => { p.seen[id] = true; }); unseen = unseen.slice(-1); }
  }
  showIntros(unseen, beginSession);
}

function setupPracticeHeader() {
  const t = current.track === 'placement' ? null : C.trackById(current.track);
  $('#pTitle').textContent = t ? t.name : 'Placement test';
  $('#pSub').textContent = t ? focusText(current.track) : 'Play each note as soon as you recognize it.';
  $('#modeSeg').hidden = !t;
  document.querySelectorAll('#modeSeg button').forEach(b => {
    b.classList.toggle('on', b.dataset.mode === current.mode);
    b.disabled = !!(t && t.flowOnly && b.dataset.mode === 'wait');
  });
  const flow = current.mode === 'flow' && !!t;
  $('#tempoBox').hidden = !flow;
  $('#lSpeedBox').hidden = flow;
  $('#lStreakBox').hidden = flow;
  $('#tVal').textContent = P().tempo[current.track] || defaultTempo(current.track);
  $('#chips').hidden = !t;
}

function nudgeTempo(d) {
  const p = P();
  const v = Math.max(30, Math.min(200, (p.tempo[current.track] || defaultTempo(current.track)) + d));
  p.tempo[current.track] = v;
  $('#tVal').textContent = v;
  store.save();
}

function renderChips() {
  const p = P();
  const track = current.track;
  const box = $('#chips');
  if (!C.trackById(track)) { box.innerHTML = ''; return; }
  if (track === 'melodies') {
    const lvl = p.tracks.melodies.level;
    box.innerHTML = C.MELODY_LEVELS.map((l, i) => {
      const cls = i < lvl ? 'cal' : i === lvl ? 'focus' : 'locked';
      return `<span class="chip ${cls}" style="${i < lvl ? 'background:var(--ok)' : ''}" title="${esc(l.name)}">L${i + 1}<small>${esc(l.name.split(',')[0].split(' ').slice(0, 2).join(' '))}</small></span>`;
    }).join('');
    return;
  }
  const ids = C.unlockedIds(p, track);
  const order = ORDER_IDS[track];
  const focus = C.focusOf(p, ids);
  const show = order.slice(0, Math.min(order.length, ids.length + 1));
  box.innerHTML = show.map((id, i) => {
    const lab = C.itemLabel(id);
    const locked = i >= ids.length;
    const col = locked ? null : confColor(id);
    const sub = lab.sub;
    const tip = locked ? 'Next to unlock' : `${Math.round(C.conf(p, id) * 100)}% confidence · ${(p.items[id]?.n || 0)} played`;
    return `<span class="chip ${col ? 'cal' : ''} ${id === focus ? 'focus' : ''} ${locked ? 'locked' : ''}" style="${col ? 'background:' + col : ''}" title="${esc(tip)}">${esc(lab.text)}<small>${esc(sub)}</small></span>`;
  }).join('');
}

function updateLive() {
  $('#lAcc').textContent = live.n ? Math.round(100 * live.ok / live.n) + '%' : '—';
  $('#lSpeed').textContent = live.timed ? Math.round(60000 / (live.ms / live.timed)) : '—';
  $('#lStreak').textContent = live.streak;
}

function sessionCommon() {
  const s = P().settings;
  return {
    stage, input, piano, synth, profile: P(),
    ignoreOctave: s.ignoreOctave, showNames: s.showNames,
  };
}

function beginSession() {
  stopSession();
  const track = current.track;
  const p = P();
  if (current.mode === 'wait') {
    session = new WaitSession({
      ...sessionCommon(),
      genLine: () => C.generate(p, track),
      hintAfter: p.settings.hints ? 2 : 0,
      onNoteDone: (slice, correct, ms) => {
        live.n++; if (correct) { live.ok++; live.streak++; } else live.streak = 0;
        if (ms != null && ms < 8000) { live.ms += Math.min(ms, 5000); live.timed++; }
        updateLive();
      },
      onLineDone: st => {
        p.history.push({ ts: Date.now(), track, mode: 'wait', n: st.n, ok: st.ok, ms: st.ms, timed: st.timed });
        const unlocked = C.maybeUnlock(p, track);
        store.save();
        renderChips();
        $('#pSub').textContent = focusText(track);
        const avg = st.timed ? (st.ms / st.timed / 1000).toFixed(2) : '—';
        $('#msg').innerHTML = `Last line: <b>${st.ok}/${st.n}</b> right first time · <b>${avg} s</b> per note`;
        if (unlocked) {
          showIntros([unlocked], () => session?.resume());
          return { regen: true, hold: true };
        }
        return { delay: 450 };
      },
    });
    session.start();
  } else {
    flowReady();
  }
}

function flowReady() {
  const p = P();
  const bpm = p.tempo[current.track] || defaultTempo(current.track);
  stage.show(C.generate(p, current.track), null);
  const card = showOverlay(`
    <div class="ocard">
      <div class="eyebrow">Flow mode</div>
      <h2>Ready?</h2>
      <p>${p.settings.linesPerPiece} lines at <b>${bpm} bpm</b>, after a one-bar count-in. The playhead won't wait, so keep going even if you miss a note.</p>
      <div class="actions"><button class="btn primary" id="flowGo">Start ▶</button></div>
      <div class="kbd">…or press any key on your piano</div>
    </div>`);
  const go = () => { hideOverlay(); runFlow(); };
  card.querySelector('#flowGo').addEventListener('click', go);
  card.querySelector('#flowGo').focus();
  overlayUnsub = input.on(ev => { if (ev.type === 'on') { setTimeout(go, 0); } });
}

function runFlow() {
  const p = P();
  const track = current.track;
  const bpm = p.tempo[track] || defaultTempo(track);
  stopSession();
  session = new FlowSession({
    ...sessionCommon(),
    genLine: () => C.generate(p, track),
    bpm,
    lineCount: p.settings.linesPerPiece,
    metronome: p.settings.metronome,
    lookAhead: p.settings.lookAhead,
    onProgress: st => {
      if (st.countIn) $('#msg').innerHTML = `Count-in… <b>${st.countIn}</b>`;
      else $('#msg').innerHTML = `<b>${st.stats.ok}</b> right · ${st.stats.missed} missed · ${st.stats.wrong} wrong notes`;
    },
    onDone: res => flowDone(res),
  });
  session.start();
}

function flowDone(res) {
  const p = P();
  const track = current.track;
  p.history.push({ ts: Date.now(), track, mode: 'flow', n: res.n, ok: res.ok, bpm: res.bpm });
  live.n += res.n; live.ok += res.ok; updateLive();
  const acc = res.acc;
  const step = acc >= 0.95 ? 4 : acc >= 0.85 ? 2 : acc < 0.7 ? -4 : 0;
  const newBpm = Math.max(30, Math.min(200, res.bpm + step));
  p.tempo[track] = newBpm;
  let unlocked = null;
  let levelUp = null;
  if (track === 'melodies') {
    const m = p.tracks.melodies;
    m.recent = [...(m.recent || []), acc].slice(-3);
    const lastTwo = m.recent.slice(-2);
    if (m.level < C.MELODY_LEVELS.length && lastTwo.length === 2 && lastTwo.every(a => a >= 0.9)) {
      m.level++; m.recent = [];
      if (m.level < C.MELODY_LEVELS.length) levelUp = 'm:' + C.MELODY_LEVELS[m.level].id;
    }
  } else {
    unlocked = C.maybeUnlock(p, track);
  }
  store.save();
  renderChips();
  $('#tVal').textContent = newBpm;
  $('#pSub').textContent = focusText(track);
  const tempoLine = step > 0 ? `Nice. Tempo goes up to <b>${newBpm} bpm</b>.`
    : step < 0 ? `Tempo eases back to <b>${newBpm} bpm</b>. Slower is fine: steady matters more than fast.`
      : `Tempo stays at <b>${newBpm} bpm</b>.`;
  const card = showOverlay(`
    <div class="ocard">
      <div class="eyebrow">Piece complete</div>
      <div class="big">${Math.round(acc * 100)}%</div>
      <div class="stats">
        <div><b>${res.ok}</b><span>right</span></div>
        <div><b>${res.missed}</b><span>missed</span></div>
        <div><b>${res.wrong}</b><span>wrong notes</span></div>
      </div>
      <p>${tempoLine}${levelUp ? ' <b>New level unlocked!</b>' : ''}</p>
      <div class="actions">
        <button class="btn primary" id="again">Play another ▶</button>
        <button class="btn" id="done">Done</button>
      </div>
      <div class="kbd">…or press any piano key to keep going</div>
    </div>`);
  const next = () => {
    hideOverlay();
    const intro = levelUp || unlocked;
    if (intro) showIntros([intro], () => flowReady());
    else runFlow();
  };
  card.querySelector('#again').addEventListener('click', next);
  card.querySelector('#done').addEventListener('click', () => showView('home'));
  setTimeout(() => {
    if ($('#overlay').hidden) return;
    overlayUnsub = input.on(ev => { if (ev.type === 'on') setTimeout(next, 0); });
  }, 1200);
}

// ---------------------------------------------------------------------------
// Overlay & intros
// ---------------------------------------------------------------------------
function showOverlay(html) {
  if (overlayUnsub) { overlayUnsub(); overlayUnsub = null; }
  const o = $('#overlay');
  o.innerHTML = html;
  o.hidden = false;
  return o;
}
function hideOverlay() {
  if (overlayUnsub) { overlayUnsub(); overlayUnsub = null; }
  const o = $('#overlay');
  o.hidden = true;
  o.innerHTML = '';
  piano?.mark([], 'target');
}

const LANDMARK_NAMES = { 'n:T:28': 'Middle C', 'n:T:32': 'Treble G', 'n:B:24': 'Bass F', 'n:T:35': 'Treble C', 'n:B:21': 'Bass C', 'n:B:28': 'Middle C' };
const LANDMARK_POS = { T: [[28, 'middle C'], [32, 'treble G'], [35, 'treble C']], B: [[24, 'bass F'], [21, 'bass C'], [28, 'middle C']] };

function noteIntroText(n) {
  if (C.LANDMARK_TEXT[n.id]) return C.LANDMARK_TEXT[n.id];
  const lms = LANDMARK_POS[n.clef];
  let best = lms[0];
  for (const l of lms) if (Math.abs(l[0] - n.d) < Math.abs(best[0] - n.d)) best = l;
  const diff = n.d - best[0];
  const size = Math.abs(diff) + 1;
  const rel = `${size === 2 ? 'A step' : 'A ' + INTERVAL_NAMES[size]} ${diff > 0 ? 'above' : 'below'} ${best[1]}`;
  const onLine = (n.d - (n.clef === 'T' ? 30 : 18)) % 2 === 0;
  return `${rel}. Read it from the landmark, then let the shape stick: ${noteName(n.d, 0, false)} sits on the ${positionWords(n.d, n.clef)}${onLine ? '' : ''}.`;
}

function showIntros(ids, done) {
  const p = P();
  const queue = [...ids];
  const nextIntro = () => {
    const id = queue.shift();
    if (!id) { hideOverlay(); done(); return; }
    p.seen[id] = true;
    store.save();
    showIntro(id, nextIntro);
  };
  nextIntro();
}

function showIntro(id, next) {
  const p = P();
  if (id.startsWith('m:')) {
    const idx = C.MELODY_LEVELS.findIndex(l => 'm:' + l.id === id);
    const lv = C.MELODY_LEVELS[idx];
    const card = showOverlay(`
      <div class="ocard">
        <div class="eyebrow">Melodies · Level ${idx + 1}</div>
        <h2>${esc(lv.name)}</h2>
        <p>${esc(lv.text)}</p>
        <p class="kbd">Pass two pieces in a row at 90% or better to move up a level. The tempo adjusts itself as you go.</p>
        <div class="actions"><button class="btn primary" id="ok">Got it</button></div>
      </div>`);
    card.querySelector('#ok').addEventListener('click', next);
    card.querySelector('#ok').focus();
    return;
  }
  const intro = C.introFor(id);
  let eyebrow = '', title = '', text = '', needPlay = false, targets = [];
  if (intro.kind === 'note') {
    const n = intro.note;
    eyebrow = LANDMARK_NAMES[id] ? 'New landmark note' : 'New note';
    title = `${noteName(n.d, 0)}${LANDMARK_NAMES[id] ? ' · ' + LANDMARK_NAMES[id] : ''}`;
    text = noteIntroText(n);
    needPlay = true;
    targets = [midiOf(n.d, 0)];
  } else if (intro.kind === 'interval') {
    eyebrow = 'New interval';
    title = `${intro.harmonic ? 'Harmonic' : 'Melodic'} ${INTERVAL_NAMES[intro.size]}`;
    text = intro.text + (intro.harmonic ? ' Harmonic means both notes are stacked: play them together.' : ' Melodic means one note after the other.');
  } else if (intro.kind === 'key') {
    if (intro.key === 'acc') {
      eyebrow = 'New skill';
      title = 'Accidentals';
      text = 'A sharp (♯), flat (♭) or natural (♮) written in front of a note changes it until the next barline. A natural cancels the key signature. After a barline the key signature applies again.';
    } else {
      const sig = keyById(intro.key).sig;
      const order = sig > 0 ? ['F', 'C', 'G', 'D', 'A', 'E', 'B'] : ['B', 'E', 'A', 'D', 'G', 'C', 'F'];
      const list = order.slice(0, Math.abs(sig)).map(l => l + (sig > 0 ? '♯' : '♭'));
      eyebrow = 'New key';
      title = keyLabel(intro.key);
      text = sig === 0 ? 'No sharps or flats: every note is a white key.'
        : `${Math.abs(sig)} ${sig > 0 ? 'sharp' : 'flat'}${Math.abs(sig) > 1 ? 's' : ''}: ${list.join(', ')}. The key signature applies to every octave, so each ${list.map(x => x[0]).join(', ')} you see is ${sig > 0 ? 'sharp' : 'flat'} unless the music says otherwise.`;
    }
  } else if (intro.kind === 'chord') {
    eyebrow = 'New chord shape';
    title = `${C.itemLabel(id).text === 'Root' ? 'Root position' : C.itemLabel(id).text === '7th' ? 'Seventh chord' : C.itemLabel(id).text.replace('inv', 'inversion')} · ${intro.clef === 'T' ? 'right hand' : 'left hand'}`;
    text = intro.text + ' Press all the notes together.';
  }
  const card = showOverlay(`
    <div class="ocard">
      <div class="eyebrow">${eyebrow}</div>
      <h2>${esc(title)}</h2>
      <div class="ex" id="introEx"></div>
      <p>${esc(text)}</p>
      ${needPlay ? `<div class="count" id="introCount"><i></i><i></i><i></i></div><div class="kbd">Find it on your piano and play it three times</div>` : ''}
      <div class="actions">
        ${needPlay ? '<button class="btn ghost" id="skip">Skip</button>' : '<button class="btn primary" id="ok">Got it</button>'}
      </div>
    </div>`);
  const line = C.exampleLine(intro);
  if (line) renderLine(card.querySelector('#introEx'), line, { width: Math.max(360, 140 + line.slices.length * 90) });
  if (needPlay) {
    piano.mark(targets, 'target');
    let count = 0;
    card.querySelector('#skip').addEventListener('click', next);
    overlayUnsub = input.on(ev => {
      if (ev.type !== 'on') return;
      const ok = P().settings.ignoreOctave ? targets.some(t => t % 12 === ev.midi % 12) : targets.includes(ev.midi);
      if (!ok) { piano.flash(ev.midi, 'wrong'); return; }
      count++;
      card.querySelectorAll('#introCount i').forEach((d, i) => d.classList.toggle('on', i < count));
      if (count >= 3) { if (overlayUnsub) { overlayUnsub(); overlayUnsub = null; } setTimeout(next, 350); }
    });
  } else {
    card.querySelector('#ok').addEventListener('click', next);
    card.querySelector('#ok').focus();
  }
}

// ---------------------------------------------------------------------------
// Placement test
// ---------------------------------------------------------------------------
function startPlacement() {
  stopSession();
  current = { track: 'placement', mode: 'wait' };
  showView('practice');
  live = { n: 0, ok: 0, ms: 0, timed: 0, streak: 0 };
  updateLive();
  setupPracticeHeader();
  $('#msg').innerHTML = '&nbsp;';
  stage.clear();
  const card = showOverlay(`
    <div class="ocard">
      <div class="eyebrow">Placement test</div>
      <h2>What do you already know?</h2>
      <p>Notes come in groups of six, starting from the landmarks and working outward to the ledger lines. Play each one as soon as you recognize it. If you get one wrong, the right key lights up, so just play that and keep going.</p>
      <p>The test stops at the first group you don't mostly know. That's expected, and that's where you'll start.</p>
      <div class="actions"><button class="btn primary" id="pgo">Begin</button><button class="btn ghost" id="pcancel">Cancel</button></div>
    </div>`);
  card.querySelector('#pcancel').addEventListener('click', () => showView('home'));
  card.querySelector('#pgo').addEventListener('click', () => {
    hideOverlay();
    let block = 0;
    let results = [];
    const p = P();
    session = new WaitSession({
      ...sessionCommon(),
      genLine: () => C.placementBlock(block),
      hintAfter: 1,
      onNoteDone: (slice, correct, ms) => {
        results.push({ correct, ms });
        live.n++; if (correct) { live.ok++; live.streak++; } else live.streak = 0;
        if (ms != null) { live.ms += Math.min(ms, 5000); live.timed++; }
        updateLive();
      },
      onLineDone: st => {
        p.history.push({ ts: Date.now(), track: 'placement', mode: 'wait', n: st.n, ok: st.ok, ms: st.ms, timed: st.timed });
        const known = results.filter(r => r.correct && (r.ms == null || r.ms < 3000)).length;
        const need = Math.min(5, results.length - 1);
        results = [];
        $('#msg').innerHTML = `Group ${block + 1}: <b>${known}</b> recognized`;
        if (known >= need) {
          block++;
          if (block < C.PLACEMENT_BLOCKS) return { regen: true, delay: 600 };
        }
        finishPlacement(block);
        return { stop: true };
      },
    });
    session.start();
  });
}

function finishPlacement(passed) {
  const p = P();
  if (session) session.stop();
  session = null;
  const n = Math.max(3, Math.min(C.NOTES.length, passed * 6));
  p.tracks.notes.unlocked = Math.max(p.tracks.notes.unlocked, n);
  for (let i = 0; i < p.tracks.notes.unlocked; i++) p.seen[C.NOTES[i].id] = true;
  p.placement = { ts: Date.now(), unlocked: n };
  store.save();
  const last = C.NOTES[p.tracks.notes.unlocked - 1];
  const card = showOverlay(`
    <div class="ocard">
      <div class="eyebrow">Placement result</div>
      <div class="big">${p.tracks.notes.unlocked}</div>
      <p>notes unlocked, up to <b>${noteName(last.d, 0)}</b> in the ${last.clef === 'T' ? 'treble' : 'bass'} clef.</p>
      <p>${passed === 0 ? 'You\'ll start with the three landmark notes, the anchors everything else is read from.' : 'The chips start grey and turn green as you confirm each note at speed. New notes unlock once they\'re solid.'}</p>
      <div class="actions"><button class="btn primary" id="pstart">Start practicing ▶</button><button class="btn" id="phome">Home</button></div>
    </div>`);
  card.querySelector('#pstart').addEventListener('click', () => startPractice('notes', 'wait'));
  card.querySelector('#phome').addEventListener('click', () => showView('home'));
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
function dayKey(ts) { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }

function renderStats() {
  const p = P();
  const h = p.history;
  const total = h.reduce((a, x) => a + x.n, 0);
  const ok = h.reduce((a, x) => a + x.ok, 0);
  const wait = h.filter(x => x.mode === 'wait' && x.timed).slice(-20);
  const wms = wait.reduce((a, x) => a + x.ms, 0), wt = wait.reduce((a, x) => a + x.timed, 0);
  const days = new Set(h.map(x => dayKey(x.ts)));

  const el = $('#view-stats');
  el.innerHTML = `
    <div class="stats-head">
      <h1>Progress · ${esc(p.name)}</h1>
      <span class="kbd">Speed goal: ${p.settings.speed} (${(C.SPEEDS[p.settings.speed] / 1000).toFixed(1)} s per note). Change it in Settings.</span>
    </div>
    <div class="tiles">
      <div class="tile"><b>${total.toLocaleString()}</b><span>notes played</span></div>
      <div class="tile"><b>${total ? Math.round(100 * ok / total) + '%' : '—'}</b><span>first-try accuracy</span></div>
      <div class="tile"><b>${wt ? Math.round(60000 / (wms / wt)) : '—'}</b><span>notes / min (recent)</span></div>
      <div class="tile"><b>${days.size}</b><span>days practiced</span></div>
    </div>
    <div class="panel">
      <h2>Note map</h2>
      <p class="sub">Every note in the course, colored by how reliably and quickly you play it.</p>
      <div class="legend">
        <span><i style="background:hsl(6 50% 45%)"></i>shaky</span>
        <span><i style="background:hsl(70 50% 45%)"></i>getting there</span>
        <span><i style="background:hsl(134 50% 38%)"></i>solid</span>
        <span><i style="background:var(--ink-3)"></i>unlocked, not enough data</span>
        <span><i style="background:var(--line)"></i>locked</span>
      </div>
      <div id="heatT"></div><div id="heatB"></div>
    </div>
    <div class="panel">
      <h2>Daily trend</h2>
      <p class="sub"><span style="color:var(--accent)">●</span> notes per minute in wait mode &nbsp; <span style="color:var(--current)">●</span> first-try accuracy</p>
      <div id="trend"></div>
    </div>
    <div class="panel"><h2>Intervals</h2><div class="items" id="itIntervals"></div></div>
    <div class="panel"><h2>Key signatures</h2><div class="items" id="itKeys"></div></div>
    <div class="panel"><h2>Chords</h2><div class="items" id="itChords"></div></div>
    <div class="panel"><h2>Melodies</h2><div class="items" id="itMel"></div></div>
    <div class="panel">
      <h2>Data</h2>
      <p class="sub">Progress is stored in this browser only. Export it as a backup or to move it to another computer.</p>
      <div class="row" style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn" id="exportBtn">Export ${esc(p.name)}'s progress</button>
        <button class="btn" id="importBtn">Import as a new person…</button>
        <input type="file" id="importFile" accept="application/json,.json" hidden>
        <button class="btn danger" id="resetBtn">Reset ${esc(p.name)}'s progress…</button>
      </div>
    </div>`;

  // heatmaps
  for (const clef of ['T', 'B']) {
    const notes = C.NOTES.map((n, i) => ({ ...n, i })).filter(n => n.clef === clef).sort((a, b) => a.d - b.d);
    const line = { key: 'C', clefs: [clef], beatsPerBar: 1000, slices: notes.map((n, i) => ({ beat: i, dur: 1, notes: [{ d: n.d, clef, acc: 0, print: null, dur: 4 }] })), totalBeats: notes.length };
    const hnd = renderLine(el.querySelector(clef === 'T' ? '#heatT' : '#heatB'), line, { showNames: true });
    hnd.svg.classList.add('heat');
    notes.forEach((n, i) => {
      const unlocked = n.i < p.tracks.notes.unlocked;
      const col = unlocked ? (confColor(n.id) || 'var(--ink-3)') : 'var(--line)';
      hnd.sliceEls[i].style.color = col;
      const t = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      t.textContent = `${n.name} · ${unlocked ? Math.round(C.conf(p, n.id) * 100) + '% · ' + (p.items[n.id]?.n || 0) + ' played' : 'locked'}`;
      hnd.sliceEls[i].appendChild(t);
    });
  }

  // trend
  const byDay = new Map();
  for (const x of h) {
    const k = dayKey(x.ts);
    if (!byDay.has(k)) byDay.set(k, { n: 0, ok: 0, ms: 0, timed: 0 });
    const d = byDay.get(k);
    d.n += x.n; d.ok += x.ok;
    if (x.mode === 'wait') { d.ms += x.ms || 0; d.timed += x.timed || 0; }
  }
  const daysArr = [...byDay.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1).slice(-30);
  el.querySelector('#trend').innerHTML = daysArr.length < 2
    ? '<div class="empty-note">Practice on a couple of different days and your trend shows up here.</div>'
    : trendChart(daysArr);

  // item lists
  const itemRows = (ids, unlockedN) => ids.map((id, i) => {
    const lab = C.itemLabel(id);
    const locked = i >= unlockedN;
    const c = C.conf(p, id);
    const col = locked ? 'var(--line)' : (confColor(id) || 'var(--ink-3)');
    return `<div class="item ${locked ? 'locked' : ''}"><span>${esc(lab.text)} <small style="color:var(--ink-3)">${esc(lab.sub)}</small></span>
      <div class="prog"><i style="width:${locked ? 0 : Math.round(c * 100)}%;background:${col}"></i></div>
      <span class="pct">${locked ? '🔒' : Math.round(c * 100) + '%'}</span></div>`;
  }).join('');
  el.querySelector('#itIntervals').innerHTML = itemRows(C.INTERVALS, p.tracks.intervals.unlocked);
  el.querySelector('#itKeys').innerHTML = itemRows(C.KEY_ITEMS, C.trackById('keys').available(p) ? p.tracks.keys.unlocked : 0);
  el.querySelector('#itChords').innerHTML = itemRows(C.CHORDS, C.trackById('chords').available(p) ? p.tracks.chords.unlocked : 0);
  const lvl = p.tracks.melodies.level;
  el.querySelector('#itMel').innerHTML = C.MELODY_LEVELS.map((l, i) => `
    <div class="item ${i > lvl ? 'locked' : ''}"><span>Level ${i + 1}</span>
      <div class="prog"><i style="width:${i < lvl ? 100 : 0}%;background:var(--ok)"></i></div>
      <span class="pct">${i < lvl ? '✓' : i === lvl ? 'now' : ''}</span></div>`).join('') +
    `<p class="sub" style="grid-column:1/-1;margin-top:6px">Tempo now: ${p.tempo.melodies || 60} bpm</p>`;

  el.querySelector('#exportBtn').addEventListener('click', () => {
    const blob = new Blob([store.exportCurrent()], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `sightreading-${p.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  el.querySelector('#importBtn').addEventListener('click', () => el.querySelector('#importFile').click());
  el.querySelector('#importFile').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { store.importAsNew(await f.text()); updateProfileUI(); applySettings(); renderStats(); }
    catch (err) { await askConfirm('Import failed', String(err.message || err), 'OK', true); }
  });
  el.querySelector('#resetBtn').addEventListener('click', async () => {
    if (await askConfirm(`Reset ${p.name}'s progress?`, 'This clears every note, score and history entry for this person. Settings are kept. It can\'t be undone.', 'Reset progress')) {
      store.resetCurrent(); renderStats();
    }
  });
}

function trendChart(days) {
  const W = 1000, H = 220, L = 44, R = 44, T = 14, B = 30;
  const speed = days.map(([, d]) => d.timed ? 60000 / (d.ms / d.timed) : null);
  const acc = days.map(([, d]) => d.n ? d.ok / d.n : null);
  const maxS = Math.max(30, ...speed.filter(x => x != null)) * 1.1;
  const x = i => L + (W - L - R) * (days.length === 1 ? 0.5 : i / (days.length - 1));
  const yS = v => T + (H - T - B) * (1 - v / maxS);
  const yA = v => T + (H - T - B) * (1 - v);
  const path = (vals, y) => vals.map((v, i) => v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`).filter(Boolean).join(' ');
  let g = '';
  for (let k = 0; k <= 4; k++) {
    const yy = T + (H - T - B) * k / 4;
    g += `<line class="ax" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/>`;
    g += `<text x="${L - 8}" y="${yy + 4}" text-anchor="end">${Math.round(maxS * (1 - k / 4))}</text>`;
    g += `<text x="${W - R + 8}" y="${yy + 4}">${Math.round(100 * (1 - k / 4))}%</text>`;
  }
  const step = Math.max(1, Math.ceil(days.length / 8));
  days.forEach(([k], i) => { if (i % step === 0 || i === days.length - 1) g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${k.slice(5).replace('-', '/')}</text>`; });
  const dots = (vals, y, cls) => vals.map((v, i) => v == null ? '' : `<circle class="${cls}" cx="${x(i)}" cy="${y(v)}" r="3.5"/>`).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}">${g}
    <polyline class="l1" points="${path(speed, yS)}"/><polyline class="l2" points="${path(acc, yA)}"/>
    ${dots(speed, yS, 'd1')}${dots(acc, yA, 'd2')}</svg>`;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function openSettings() {
  const s = P().settings;
  const dlg = $('#dlg');
  const chk = (k, label, help) => `<label class="f"><span>${label}${help ? `<small>${help}</small>` : ''}</span><input type="checkbox" data-k="${k}" ${s[k] ? 'checked' : ''}></label>`;
  dlg.innerHTML = `
    <h2>Settings for ${esc(P().name)}</h2>
    <div class="form">
      <h3>Practice</h3>
      <label class="f"><span>Speed goal<small>How fast a note must be played to count as solid</small></span>
        <select data-k="speed">
          <option value="relaxed" ${s.speed === 'relaxed' ? 'selected' : ''}>Relaxed · 2.2 s</option>
          <option value="standard" ${s.speed === 'standard' ? 'selected' : ''}>Standard · 1.4 s</option>
          <option value="fluent" ${s.speed === 'fluent' ? 'selected' : ''}>Fluent · 0.9 s</option>
        </select></label>
      ${chk('hints', 'Show the answer after two mistakes', 'Lights up the right key and names the note')}
      ${chk('showNames', 'Training wheels: note names', 'Prints the name under every note. Turn it off as soon as you can.')}
      ${chk('ignoreOctave', 'Accept any octave', 'Counts the right letter in any octave as correct')}
      <h3>Flow mode</h3>
      ${chk('metronome', 'Metronome click')}
      <label class="f"><span>Look-ahead trainer<small>Hides each note just before the playhead reaches it, so your eyes have to stay ahead</small></span>
        <select data-k="lookAhead">
          <option value="0" ${+s.lookAhead === 0 ? 'selected' : ''}>Off</option>
          <option value="1" ${+s.lookAhead === 1 ? 'selected' : ''}>1 beat ahead</option>
          <option value="2" ${+s.lookAhead === 2 ? 'selected' : ''}>2 beats ahead</option>
          <option value="4" ${+s.lookAhead === 4 ? 'selected' : ''}>A full bar ahead</option>
        </select></label>
      <label class="f"><span>Lines per piece</span>
        <select data-k="linesPerPiece">${[2, 3, 4, 6, 8].map(n => `<option value="${n}" ${+s.linesPerPiece === n ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
      <h3>Sound &amp; display</h3>
      ${chk('soundKeys', 'Sound for computer / on-screen keys')}
      ${chk('soundMidi', 'Sound for MIDI input', 'Leave off if your piano makes its own sound')}
      ${chk('showKeyboard', 'Show on-screen keyboard')}
    </div>
    <div class="actions"><button class="btn primary" id="sDone">Done</button></div>`;
  dlg.querySelectorAll('[data-k]').forEach(inp => inp.addEventListener('change', () => {
    const k = inp.dataset.k;
    s[k] = inp.type === 'checkbox' ? inp.checked : (['lookAhead', 'linesPerPiece'].includes(k) ? Number(inp.value) : inp.value);
    store.save();
    applySettings();
    if (session) { session.showNames = s.showNames; session.ignoreOctave = s.ignoreOctave; session.hintAfter = s.hints ? 2 : 0; }
    if (current.track && !$('#view-practice').hidden) renderChips();
  }));
  dlg.querySelector('#sDone').addEventListener('click', () => dlg.close());
  dlg.showModal();
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------
function updateProfileUI() {
  const name = P().name;
  $('#profileName').textContent = name;
  $('#profileAvatar').textContent = (name.trim()[0] || '?').toUpperCase();
}

function setupProfileMenu() {
  const btn = $('#profileBtn'), menu = $('#profileMenu');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  const build = () => {
    const cur = store.currentId;
    menu.innerHTML = store.profiles.map(pr => `
      <button data-id="${pr.id}"><span class="avatar">${esc((pr.name.trim()[0] || '?').toUpperCase())}</span>${esc(pr.name)}${pr.id === cur ? '<span class="check">✓</span>' : ''}</button>`).join('') +
      `<div class="sep"></div>
       <button data-act="add" class="muted">＋ Add a person…</button>
       <button data-act="rename" class="muted">Rename ${esc(P().name)}…</button>
       <button data-act="delete" class="danger">Remove ${esc(P().name)}…</button>`;
  };
  btn.addEventListener('click', e => {
    e.stopPropagation();
    if (!menu.hidden) { close(); return; }
    build(); menu.hidden = false; btn.setAttribute('aria-expanded', 'true');
  });
  document.addEventListener('click', e => { if (!menu.contains(e.target)) close(); });
  menu.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    close();
    if (b.dataset.id) {
      if (b.dataset.id !== store.currentId) { stopSession(); store.switchTo(b.dataset.id); afterProfileChange(); }
      return;
    }
    if (b.dataset.act === 'add') {
      const name = await askText('Add a person', 'Each person gets their own progress, history and settings.', '');
      if (name) { stopSession(); store.addProfile(name); afterProfileChange(); }
    } else if (b.dataset.act === 'rename') {
      const name = await askText('Rename', '', P().name);
      if (name) { store.renameCurrent(name); updateProfileUI(); if (!$('#view-home').hidden) renderHome(); if (!$('#view-stats').hidden) renderStats(); }
    } else if (b.dataset.act === 'delete') {
      if (await askConfirm(`Remove ${P().name}?`, 'Their progress and history are deleted from this browser. Export it first from the Progress page if you want a copy.', 'Remove')) {
        stopSession(); store.deleteCurrent(); afterProfileChange();
      }
    }
  });
  updateProfileUI();
}

function afterProfileChange() {
  updateProfileUI();
  applySettings();
  const v = !$('#view-stats').hidden ? 'stats' : 'home';
  showView(v);
}

function askText(title, help, def) {
  return new Promise(resolve => {
    const dlg = $('#dlg');
    dlg.innerHTML = `<h2>${esc(title)}</h2>${help ? `<p>${esc(help)}</p>` : ''}
      <form method="dialog" id="askForm"><input type="text" id="askIn" maxlength="40" placeholder="Name" value="${esc(def)}">
      <div class="actions"><button type="button" class="btn ghost" id="askCancel">Cancel</button><button class="btn primary" type="submit">Save</button></div></form>`;
    let result = null;
    dlg.querySelector('#askForm').addEventListener('submit', () => { result = dlg.querySelector('#askIn').value.trim() || null; });
    dlg.querySelector('#askCancel').addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => resolve(result), { once: true });
    dlg.showModal();
    dlg.querySelector('#askIn').select();
  });
}

function askConfirm(title, text, okLabel, infoOnly = false) {
  return new Promise(resolve => {
    const dlg = $('#dlg');
    dlg.innerHTML = `<h2>${esc(title)}</h2><p>${esc(text)}</p>
      <div class="actions">${infoOnly ? '' : '<button class="btn ghost" id="cNo">Cancel</button>'}<button class="btn ${infoOnly ? 'primary' : 'primary danger-fill'}" id="cYes">${esc(okLabel)}</button></div>`;
    let result = false;
    dlg.querySelector('#cYes').addEventListener('click', () => { result = true; dlg.close(); });
    dlg.querySelector('#cNo')?.addEventListener('click', () => dlg.close());
    dlg.addEventListener('close', () => resolve(result), { once: true });
    dlg.showModal();
  });
}

// ---------------------------------------------------------------------------
// MIDI status
// ---------------------------------------------------------------------------
function updateMidiPill(st) {
  const pill = $('#midiPill');
  const txt = pill.querySelector('.txt');
  pill.classList.remove('ok', 'warn');
  if (st.midi === 'connected') {
    pill.classList.add('ok');
    const n = st.devices[0] || 'MIDI';
    txt.textContent = n.length > 24 ? n.slice(0, 22) + '…' : n;
    pill.title = 'Listening to: ' + st.devices.join(', ');
  } else if (st.midi === 'none') {
    pill.classList.add('warn'); txt.textContent = 'No MIDI device'; pill.title = 'Plug in a MIDI keyboard. It is detected automatically.';
  } else if (st.midi === 'unsupported') {
    txt.textContent = 'MIDI not supported'; pill.title = 'Use Chrome or Edge for MIDI.';
  } else if (st.midi === 'denied') {
    pill.classList.add('warn'); txt.textContent = 'MIDI blocked'; pill.title = 'Allow MIDI access for this site in the browser settings, then click to retry.';
  }
  updateKbHelp();
}
function updateKbHelp() {
  const o = input.kbOctave;
  $('#kbHelp').textContent = `Computer keys: A S D F G H J K L ; ' = C${o} to F${o + 1} · W E T Y U O P = black keys · Z / X = octave down / up`;
}

init();
