// Plate Cutter — three steps: mark rows, fix each frame's corners, preview & export.
'use strict';
(() => {
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const tick = () => new Promise(r => setTimeout(r, 0));
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const MAX_PIXELS = 24e6;

const st = {
  plate: null, img: null, name: '', key: '', tones: null,
  rows: [],            // {id, box, frames:[{quad, guess, ok, tol, exact, nudge}], tol, exact, align, range, placed}
  joinNudge: {},       // 'rowIdA>rowIdB' -> [dx, dy]: your adjustment where row B follows row A
  seqDefs: [],         // sequences: lists of row ids, in play order (a row may appear more than once)
  step: 1, view: { s: 1, ox: 0, oy: 0 },
  sel: { r: 0, f: 0 }, phase: 'adjust',
  fps: 6, loop: 'pingpong', rev: false, indep: false, t: 0, dir: 1, playing: true, selSeq: 0, seqs: [],
};
const cutCache = new Map();   // "r:f" -> {sig, cut, bmp}
const alignCache = new Map(); // row -> {sig, pos:[...]}

// ---------- persistence ----------
function save() {
  if (!st.key) return;
  clearTimeout(save.t);
  save.t = setTimeout(() => { try { localStorage.setItem(st.key, JSON.stringify(projectJSON())); } catch (e) { /* storage blocked or full */ } }, 250);
}
function projectJSON() {
  // each frame keeps the tool's first guess beside your corners, so the guessing can be tuned later
  return { v: 2, name: st.name, size: [st.plate.W, st.plate.H], tones: st.tones, fps: st.fps, loop: st.loop, rev: st.rev, indep: st.indep,
    joinNudge: st.joinNudge, sequences: st.seqDefs.map(d => d.map(id => rowName(st.rows.findIndex(R => R.id === id)))), seqDefs: st.seqDefs,
    rows: st.rows.map((R, r) => ({ id: R.id, placed: R.placed, name: rowName(r), box: R.box, tol: R.tol, exact: R.exact, align: R.align, range: R.range, from: R.from, to: R.to,
      frames: R.frames.map(f => ({ quad: f.quad, guess: f.guess, ok: f.ok, touched: f.touched, tol: f.tol, exact: f.exact, nudge: f.nudge })) })) };
}
function loadSaved() { try { const s = localStorage.getItem(st.key); return s ? JSON.parse(s) : null; } catch (e) { return null; } }

function status(msg, busy) { const el = $('status'); el.textContent = msg || ''; el.classList.toggle('busy', !!busy); }
const rowName = r => LETTERS[r] || `R${r + 1}`;
const uid = () => Math.random().toString(36).slice(2, 9);

// ---------- loading ----------
$('fileInput').addEventListener('change', e => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ''; });
const drop = $('drop');
['dragenter', 'dragover'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach(t => document.addEventListener(t, e => { e.preventDefault(); if (t === 'drop' || !e.relatedTarget) drop.classList.remove('over'); }));
document.addEventListener('drop', e => { const f = e.dataTransfer.files[0]; if (f) openFile(f); });

let pdfDoc = null, pdfName = '';
function openFile(file) {
  if (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name)) return openPDF(file);
  status('Loading image…', true);
  const url = URL.createObjectURL(file), img = new Image();
  img.onload = () => { URL.revokeObjectURL(url); $('pdfPage').hidden = true; startPlate(img, file.name.replace(/\.[^.]+$/, '')); };
  img.onerror = () => status("This browser can't read that image. Try a JPEG or PNG.");
  img.src = url;
}
async function openPDF(file) {
  status('Loading PDF reader…', true);
  if (!window.pdfjsLib) {
    await new Promise((res, rej) => { const s = document.createElement('script'); s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js'; s.onload = res; s.onerror = rej; document.head.appendChild(s); })
      .catch(() => status("Couldn't load the PDF reader (no connection?)."));
    if (!window.pdfjsLib) return;
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  pdfDoc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  pdfName = file.name.replace(/\.[^.]+$/, '');
  const sel = $('pdfPage'); sel.innerHTML = '';
  for (let i = 1; i <= pdfDoc.numPages; i++) sel.add(new Option(`Page ${i}`, i));
  sel.hidden = pdfDoc.numPages < 2;
  renderPDFPage(1);
}
$('pdfPage').addEventListener('change', e => renderPDFPage(+e.target.value));
async function renderPDFPage(n) {
  status(`Rendering page ${n}…`, true);
  const page = await pdfDoc.getPage(n), vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: Math.min(3, 3000 / vp1.width) });
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  startPlate(c, `${pdfName}_p${n}`);
}

async function startPlate(src, name) {
  status('Reading pixels…', true); await tick();
  let W = src.naturalWidth || src.width, H = src.naturalHeight || src.height;
  const k = Math.min(1, Math.sqrt(MAX_PIXELS / (W * H)));
  W = Math.round(W * k); H = Math.round(H * k);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(src, 0, 0, W, H);
  st.img = c; st.plate = Core.preparePlate(ctx.getImageData(0, 0, W, H));
  st.tones = Core.estimateTones(st.plate);
  st.name = name.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '') || 'plate';
  st.key = `platecutter2:${st.name}:${W}x${H}`;
  $('plateName').textContent = `${name} — ${W}×${H}${k < 1 ? ' (scaled down)' : ''}`;
  cutCache.clear(); alignCache.clear();
  const saved = loadSaved();
  st.rows = []; st.seqDefs = []; st.joinNudge = {}; st.fps = 6; st.loop = 'pingpong';
  if (saved && saved.rows) {
    st.fps = saved.fps || 6; st.loop = saved.loop === 'loop' ? 'loop' : 'pingpong'; st.indep = !!saved.indep; st.rev = !!saved.rev;
    st.rows = saved.rows.map(R => ({ id: R.id || uid(), placed: !!R.placed, joinPrev: !!R.joinPrev, box: R.box, tol: R.tol, exact: !!R.exact, align: R.align || 'content', range: R.range || 12, from: R.from || 0, to: R.to ?? null,
      frames: R.frames.map(f => ({ quad: f.quad, guess: f.guess, ok: !!f.ok, touched: !!f.touched, tol: f.tol ?? null, exact: f.exact ?? null, nudge: f.nudge || [0, 0] })) }));
  }
  if (saved && saved.joinNudge) st.joinNudge = saved.joinNudge;
  if (saved && saved.seqDefs) st.seqDefs = saved.seqDefs;
  else if (saved && saved.rows) {   // older saves: rebuild from "join to row above"
    st.rows.forEach((R, r) => { if (r > 0 && R.joinPrev && st.seqDefs.length) st.seqDefs[st.seqDefs.length - 1].push(R.id); else st.seqDefs.push([R.id]); R.placed = true; });
  }
  st.rows.forEach(R => delete R.joinPrev);
  $('empty').hidden = true; $('steps').hidden = false;
  status(saved ? 'Picked up where you left off on this plate.' : '');
  goStep(1);
}

// ---------- steps ----------
document.querySelectorAll('#steps button').forEach(b => b.addEventListener('click', () => goStep(+b.dataset.step)));
function goStep(n) {
  if (n > 1 && !st.rows.length) { status('Mark at least one row first.'); n = 1; }
  st.step = n;
  document.querySelectorAll('#steps button').forEach(b => b.classList.toggle('on', +b.dataset.step === n));
  for (const k of [1, 2, 3]) $('step' + k).hidden = k !== n;
  if (n !== 3) stopPlay();
  if (n === 1) { requestAnimationFrame(() => { fit(); renderRowList(); }); }
  if (n === 2) { if (!st.rows[st.sel.r] || !st.rows[st.sel.r].frames[st.sel.f]) st.sel = { r: 0, f: 0 }; selectFrame(st.sel.r, st.sel.f); }
  if (n === 3) enterPreview();
}

// ======================= STEP 1: mark rows =======================
const pc = $('plateCanvas'), viewer = $('viewer');
function fit() {
  const r = viewer.getBoundingClientRect(); if (!st.plate || !r.width) return;
  const s = Math.min(r.width / st.plate.W, r.height / st.plate.H) * 0.97;
  st.view = { s, ox: (r.width - st.plate.W * s) / 2, oy: (r.height - st.plate.H * s) / 2 };
  drawPlate();
}
$('fitBtn').addEventListener('click', fit);
const zoomBy = f => { const r = viewer.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, f); };
$('zoomIn').addEventListener('click', () => zoomBy(1.4));
$('zoomOut').addEventListener('click', () => zoomBy(1 / 1.4));
function zoomAt(mx, my, f) {
  const s2 = clamp(st.view.s * f, 0.03, 10);
  st.view.ox = mx - (mx - st.view.ox) * s2 / st.view.s; st.view.oy = my - (my - st.view.oy) * s2 / st.view.s; st.view.s = s2;
  drawPlate();
}
new ResizeObserver(() => { if (st.plate && st.step === 1) fit(); }).observe(viewer);

let boxDrag = null;
function plateXY(e) { const r = pc.getBoundingClientRect(); return [(e.clientX - r.left - st.view.ox) / st.view.s, (e.clientY - r.top - st.view.oy) / st.view.s]; }
pc.addEventListener('pointerdown', e => {
  if (!st.plate) return;
  if (e.button === 1 || e.button === 2 || e.altKey) { boxDrag = { pan: true, sx: e.clientX, sy: e.clientY, ox: st.view.ox, oy: st.view.oy }; }
  else { const p = plateXY(e); boxDrag = { p0: p, p1: p }; }
  pc.setPointerCapture(e.pointerId);
});
pc.addEventListener('pointermove', e => {
  if (!boxDrag) return;
  if (boxDrag.pan) { st.view.ox = boxDrag.ox + e.clientX - boxDrag.sx; st.view.oy = boxDrag.oy + e.clientY - boxDrag.sy; }
  else boxDrag.p1 = plateXY(e);
  drawPlate();
});
pc.addEventListener('pointerup', async () => {
  const d = boxDrag; boxDrag = null; if (!d || d.pan) return;
  const box = [Math.min(d.p0[0], d.p1[0]), Math.min(d.p0[1], d.p1[1]), Math.max(d.p0[0], d.p1[0]), Math.max(d.p0[1], d.p1[1])].map(Math.round);
  if (box[2] - box[0] < 20 || box[3] - box[1] < 20) { drawPlate(); return; }
  await markRow(box);
});
pc.addEventListener('contextmenu', e => e.preventDefault());
pc.addEventListener('wheel', e => {
  if (!st.plate) return; e.preventDefault();
  const r = pc.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey) zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.002)));
  else { st.view.ox -= e.deltaX; st.view.oy -= e.deltaY; drawPlate(); }
}, { passive: false });

const snap = q => Core.snapQuad(st.plate, q, { gutter: st.tones.gutter });
const bboxOf = q => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const [x, y] of q) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); } return [x0, y0, x1, y1]; };
function overlap(a, b) { const ix = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), iy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])); return ix * iy / Math.min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1])); }

async function markRow(box, count) {
  status('Finding the frames in this row…', true); await tick();
  const guess = Core.guessRow(st.plate, st.tones, box, count);
  // redo a row when the box lands on one of its frames; otherwise it's a new row
  let ri = st.rows.findIndex(R => R.frames.some(f => overlap(bboxOf(f.quad), box) > 0.5) || overlap(R.box, box) > 0.5);
  const fw = bboxOf(guess[0].quad); const tol = Math.max(3, Math.round((fw[2] - fw[0]) * 0.012));
  const R = { id: uid(), placed: false, box, tol, exact: false, align: 'content', range: 12,
    frames: guess.map(g => { const q = snap(g.quad); return { quad: q, guess: q.map(p => p.slice()), ok: false, touched: false, tol: null, exact: null, nudge: [0, 0] }; }) };
  if (ri >= 0) { const old = st.rows[ri]; R.id = old.id; R.placed = old.placed; R.align = old.align; R.range = old.range; R.from = old.from; R.to = old.to; st.rows[ri] = R; }
  else st.rows.push(R);
  st.rows.sort((a, b) => a.box[1] - b.box[1]);
  cutCache.clear(); alignCache.clear();
  status(`Row ${rowName(st.rows.indexOf(R))}: ${R.frames.length} frames.`);
  save(); renderRowList(); drawPlate();
}

async function setCount(r, n) {
  const R = st.rows[r]; n = clamp(n, 1, 60);
  if (n < R.frames.length) R.frames.length = n;
  else if (n > R.frames.length) {
    status('Guessing more frames…', true); await tick();
    const g = Core.guessRow(st.plate, st.tones, R.box, n);
    for (let i = R.frames.length; i < n; i++) { const q = snap(g[i].quad); R.frames.push({ quad: q, guess: q.map(p => p.slice()), ok: false, touched: false, tol: null, exact: null, nudge: [0, 0] }); }
    carryForward(r);
    status('');
  }
  cutCache.clear(); alignCache.delete(r); save(); renderRowList(); drawPlate();
}

function renderRowList() {
  const ul = $('rowList'); ul.innerHTML = '';
  if (!st.rows.length) ul.innerHTML = '<li class="empty-note">No rows yet.</li>';
  st.rows.forEach((R, r) => {
    const li = document.createElement('li');
    const done = R.frames.filter(f => f.ok).length;
    li.innerHTML = `<b>${rowName(r)}</b><span class="hint" style="margin:0">${done ? `${done} checked` : ''}</span>
      <span class="cnt"><button class="btn small ghost" data-a="-" aria-label="One frame fewer">−</button><span>${R.frames.length}</span><button class="btn small ghost" data-a="+" aria-label="One frame more">+</button>
      <button class="btn small ghost" data-a="x" aria-label="Remove row">×</button></span>`;
    li.querySelector('[data-a="-"]').onclick = () => setCount(r, R.frames.length - 1);
    li.querySelector('[data-a="+"]').onclick = () => setCount(r, R.frames.length + 1);
    li.querySelector('[data-a=x]').onclick = () => { st.rows.splice(r, 1); cutCache.clear(); alignCache.clear(); save(); renderRowList(); drawPlate(); };
    ul.appendChild(li);
  });
  $('toFrames').disabled = !st.rows.length;
}
$('toFrames').addEventListener('click', () => { st.sel = { r: 0, f: 0 }; goStep(2); });

function accent() { return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#c2412d'; }
function drawPlate() {
  if (!st.plate || st.step !== 1) return;
  const dpr = devicePixelRatio || 1, r = viewer.getBoundingClientRect();
  pc.width = Math.round(r.width * dpr); pc.height = Math.round(r.height * dpr);
  const ctx = pc.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, r.width, r.height);
  const { s, ox, oy } = st.view, X = x => ox + x * s, Y = y => oy + y * s;
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(st.img, ox, oy, st.plate.W * s, st.plate.H * s);
  ctx.font = '600 12px Inter, sans-serif'; ctx.textBaseline = 'top';
  st.rows.forEach((R, ri) => {
    R.frames.forEach((f, fi) => {
      ctx.strokeStyle = f.ok ? 'rgba(127,224,168,.95)' : 'rgba(80,200,255,.9)'; ctx.lineWidth = 1.5; ctx.setLineDash(f.ok ? [] : [5, 4]);
      ctx.beginPath(); f.quad.forEach(([x, y], i) => i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))); ctx.closePath(); ctx.stroke();
      const lbl = `${rowName(ri)}${fi + 1}`, [tx, ty] = [X(f.quad[0][0]) + 4, Y(f.quad[0][1]) + 4];
      ctx.setLineDash([]); ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(tx - 2, ty - 1, ctx.measureText(lbl).width + 5, 16); ctx.fillStyle = '#fff'; ctx.fillText(lbl, tx, ty);
    });
    ctx.setLineDash([]); ctx.strokeStyle = accent(); ctx.lineWidth = 2;
    ctx.strokeRect(X(R.box[0]), Y(R.box[1]), (R.box[2] - R.box[0]) * s, (R.box[3] - R.box[1]) * s);
  });
  if (boxDrag && !boxDrag.pan) {
    const [a, b] = [boxDrag.p0, boxDrag.p1]; ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
    ctx.strokeRect(X(Math.min(a[0], b[0])), Y(Math.min(a[1], b[1])), Math.abs(b[0] - a[0]) * s, Math.abs(b[1] - a[1]) * s); ctx.setLineDash([]);
  }
}

// ======================= cutting (shared) =======================
const effTol = (R, f) => f.tol ?? R.tol;
const effExact = (R, f) => f.exact ?? R.exact;
function getCut(r, fi) {
  const R = st.rows[r], f = R.frames[fi], key = `${r}:${fi}`;
  const sig = JSON.stringify([f.quad, effTol(R, f), effExact(R, f)]);
  let c = cutCache.get(key);
  if (!c || c.sig !== sig) {
    const cut = Core.cutQuad(st.plate, st.tones, f.quad, { tol: effTol(R, f), exact: effExact(R, f) });
    const bmp = document.createElement('canvas'); bmp.width = cut.w; bmp.height = cut.h;
    bmp.getContext('2d').putImageData(Core.renderCut(st.plate, cut, false), 0, 0);
    c = { sig, cut, bmp }; cutCache.set(key, c);
  }
  return c;
}
function paintChecker(ctx, x, y, w, h, sq = 10) {
  ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.fillStyle = '#bbb'; ctx.fillRect(x, y, w, h); ctx.fillStyle = '#ddd';
  for (let j = 0; j * sq < h; j++) for (let i = j % 2; i * sq < w; i += 2) ctx.fillRect(x + i * sq, y + j * sq, sq, sq);
  ctx.restore();
}

// ======================= STEP 2: frames =======================
const ec = $('edCanvas'), edView = $('edView');
let ev = null, cornerDrag = null;
function curFrame() { const R = st.rows[st.sel.r]; return R && R.frames[st.sel.f]; }
function selectFrame(r, f, phase) {
  st.sel = { r, f }; const F = curFrame(); if (!F) return; activeCorner = -1;
  st.phase = phase || (F.ok ? 'crop' : 'adjust');
  syncEditor(); buildStrip(); drawEditor();
}
function syncEditor() {
  const R = st.rows[st.sel.r], F = curFrame();
  $('edTitle').textContent = `Row ${rowName(st.sel.r)} · frame ${st.sel.f + 1} of ${R.frames.length}`;
  const adj = st.phase === 'adjust';
  $('adjustCtl').hidden = !adj; $('cropCtl').hidden = adj;
  $('edHint').textContent = adj ? 'Put each corner on the print\'s corner: drag it on the frame, or click/drag in its close-up. Arrow keys nudge the last corner you touched by ¼px (Shift: 1px). Drag inside the box to move it all. Then OK to see the cut.'
    : 'This is the cut. Change the tolerance, or go back and adjust the corners.';
  const ex = effExact(R, F), tol = effTol(R, F);
  $('exact').checked = ex; $('tol').value = tol; $('tolVal').textContent = tol + ' px'; $('tolWrap').hidden = ex; $('tolHint').hidden = ex;
  $('frameOnly').checked = F.tol != null || F.exact != null;
  const last = st.sel.r === st.rows.length - 1 && st.sel.f === R.frames.length - 1;
  $('nextBtn').innerHTML = last ? 'Done — preview → <kbd>↵</kbd>' : 'Next frame → <kbd>↵</kbd>';
}
function buildStrip() {
  const strip = $('strip'); strip.innerHTML = '';
  st.rows.forEach((R, r) => R.frames.forEach((F, f) => {
    const [x0, y0, x1, y1] = bboxOf(F.quad), th = 64, tw = Math.max(16, Math.round((x1 - x0) * th / (y1 - y0)));
    const d = document.createElement('div'); d.className = 'thumb' + (F.ok ? ' ok' : '') + (r === st.sel.r && f === st.sel.f ? ' cur' : '') + (f === 0 && r > 0 ? ' sep' : '');
    const cv = document.createElement('canvas'); cv.width = tw; cv.height = th;
    cv.getContext('2d').drawImage(st.img, x0, y0, x1 - x0, y1 - y0, 0, 0, tw, th);
    d.appendChild(cv); d.insertAdjacentHTML('beforeend', `<span>${rowName(r)}${f + 1}</span>`);
    d.onclick = () => selectFrame(r, f);
    strip.appendChild(d);
  }));
  const cur = strip.querySelector('.cur'); if (cur) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function drawEditor() {
  if (st.step !== 2) return;
  const F = curFrame(); if (!F) return;
  const rect = edView.getBoundingClientRect(), dpr = devicePixelRatio || 1;
  ec.width = Math.round(rect.width * dpr); ec.height = Math.round(rect.height * dpr);
  const ctx = ec.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, rect.width, rect.height);
  // view: the frame's box with generous bleed
  const [x0, y0, x1, y1] = bboxOf(F.quad), b = Math.max(30, Math.max(x1 - x0, y1 - y0) * 0.15);
  if (!cornerDrag || !ev) {
    const vx0 = x0 - b, vy0 = y0 - b, vw = x1 - x0 + 2 * b, vh = y1 - y0 + 2 * b, s = Math.min(rect.width / vw, rect.height / vh);
    ev = { s, ox: (rect.width - vw * s) / 2 - vx0 * s, oy: (rect.height - vh * s) / 2 - vy0 * s, vx0, vy0, vw, vh };
  }
  const { s, ox, oy } = ev, X = x => ox + x * s, Y = y => oy + y * s;
  ctx.imageSmoothingEnabled = s < 2;
  if (st.phase === 'adjust') {
    ctx.drawImage(st.img, ev.vx0, ev.vy0, ev.vw, ev.vh, X(ev.vx0), Y(ev.vy0), ev.vw * s, ev.vh * s);
    ctx.strokeStyle = '#ffd34d'; ctx.lineWidth = 1.5;
    ctx.beginPath(); F.quad.forEach(([x, y], i) => i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))); ctx.closePath(); ctx.stroke();
    F.quad.forEach(([x, y]) => {
      ctx.beginPath(); ctx.arc(X(x), Y(y), 8, 0, 7); ctx.fillStyle = 'rgba(255,211,77,.25)'; ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X(x) - 4, Y(y)); ctx.lineTo(X(x) + 4, Y(y)); ctx.moveTo(X(x), Y(y) - 4); ctx.lineTo(X(x), Y(y) + 4); ctx.stroke();
    });
    if (activeCorner >= 0) { const [x, y] = F.quad[activeCorner]; ctx.beginPath(); ctx.arc(X(x), Y(y), 8, 0, 7); ctx.fillStyle = 'rgba(255,211,77,.85)'; ctx.fill(); }
  } else {
    const { cut, bmp } = getCut(st.sel.r, st.sel.f);
    paintChecker(ctx, X(ev.vx0), Y(ev.vy0), ev.vw * s, ev.vh * s, 12);
    ctx.drawImage(bmp, X(cut.x), Y(cut.y), cut.w * s, cut.h * s);
    ctx.strokeStyle = 'rgba(255,211,77,.55)'; ctx.lineWidth = 1; ctx.setLineDash([4, 5]);
    ctx.beginPath(); F.quad.forEach(([x, y], i) => i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y))); ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
  }
  drawLoupes();
}
// ---------- corner close-ups (one per corner, beside the frame) ----------
const q4 = v => Math.round(v * 4) / 4;  // corners live on a quarter-pixel grid
const Z = 6;                         // close-up zoom: screen px per plate px
let activeCorner = -1, loupeDrag = null;
const loupeEls = [...document.querySelectorAll('#loupes canvas')];
function drawLoupes() {
  const F = curFrame(); if (!F) return;
  $('loupes').hidden = st.phase !== 'adjust';
  if (st.phase !== 'adjust') return;
  const dpr = devicePixelRatio || 1;
  loupeEls.forEach(cv => {
    const k = +cv.dataset.k, r = cv.getBoundingClientRect(), size = r.width; if (!size) return;
    cv.width = Math.round(size * dpr); cv.height = Math.round(size * dpr);
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // while dragging inside this close-up, its view holds still; otherwise it follows the corner
    const [cx, cy] = loupeDrag && loupeDrag.k === k ? loupeDrag.center : F.quad[k], half = size / 2 / Z;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, size, size);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(st.img, cx - half, cy - half, half * 2, half * 2, 0, 0, size, size);
    const LX = x => (x - (cx - half)) * Z, LY = y => (y - (cy - half)) * Z, [mx, my] = F.quad[k];
    ctx.strokeStyle = 'rgba(255,211,77,.9)'; ctx.lineWidth = 1.5;
    for (const j of [(k + 3) % 4, (k + 1) % 4]) { ctx.beginPath(); ctx.moveTo(LX(mx), LY(my)); ctx.lineTo(LX(F.quad[j][0]), LY(F.quad[j][1])); ctx.stroke(); }
    // the mark: crosshair with a gap and a dot at the exact point
    const px = LX(mx), py = LY(my), arm = (w, col) => { ctx.lineWidth = w; ctx.strokeStyle = col; ctx.beginPath();
      ctx.moveTo(px - 22, py); ctx.lineTo(px - 6, py); ctx.moveTo(px + 6, py); ctx.lineTo(px + 22, py); ctx.moveTo(px, py - 22); ctx.lineTo(px, py - 6); ctx.moveTo(px, py + 6); ctx.lineTo(px, py + 22); ctx.stroke(); };
    arm(3, 'rgba(0,0,0,.6)'); arm(1.5, '#4fd1ff');
    ctx.beginPath(); ctx.arc(px, py, 2.2, 0, 7); ctx.fillStyle = '#4fd1ff'; ctx.fill();
    ctx.font = '11px "JetBrains Mono", monospace'; ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(0, size - 18, size, 18);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(`${['TL', 'TR', 'BR', 'BL'][k]}  ${mx}, ${my}`, 6, size - 9);
    cv.classList.toggle('on', k === activeCorner);
  });
}
loupeEls.forEach(cv => {
  const k = +cv.dataset.k;
  const place = e => {
    const r = cv.getBoundingClientRect(), [cx, cy] = loupeDrag.center, half = r.width / 2 / Z;
    const x = cx - half + (e.clientX - r.left) / Z, y = cy - half + (e.clientY - r.top) / Z;
    curFrame().quad[k] = [q4(x), q4(y)];
    drawEditor();
  };
  cv.addEventListener('pointerdown', e => {
    if (st.phase !== 'adjust') return;
    activeCorner = k; loupeDrag = { k, center: curFrame().quad[k].slice() };
    cv.classList.add('drag'); cv.setPointerCapture(e.pointerId); place(e);
  });
  cv.addEventListener('pointermove', e => { if (loupeDrag && loupeDrag.k === k) place(e); });
  cv.addEventListener('pointerup', () => { if (!loupeDrag) return; loupeDrag = null; cv.classList.remove('drag'); cornerChanged(); });
});
function cornerChanged() { curFrame().touched = true; alignCache.delete(st.sel.r); save(); drawEditor(); buildStrip(); }
new ResizeObserver(() => { if (st.step === 2) { ev = null; drawEditor(); } }).observe(edView);

function edXY(e) { const r = ec.getBoundingClientRect(); return [(e.clientX - r.left - ev.ox) / ev.s, (e.clientY - r.top - ev.oy) / ev.s]; }
function insideQuad(q, x, y) { let inside = false; for (let i = 0, j = 3; i < 4; j = i++) { const [xi, yi] = q[i], [xj, yj] = q[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; } return inside; }
ec.addEventListener('pointerdown', e => {
  if (st.phase !== 'adjust' || !ev) return;
  const F = curFrame(), [px, py] = edXY(e);
  let k = -1, bd = 14 / ev.s; F.quad.forEach(([x, y], i) => { const d = Math.hypot(x - px, y - py); if (d < bd) { bd = d; k = i; } });
  if (k >= 0) { cornerDrag = { k, last: [px, py] }; activeCorner = k; ec.style.cursor = 'none'; }
  else if (insideQuad(F.quad, px, py)) cornerDrag = { k: -1, last: [px, py] };
  else return;
  ec.setPointerCapture(e.pointerId);
});
ec.addEventListener('pointermove', e => {
  if (!ev || st.phase !== 'adjust') return;
  const F = curFrame(), [px, py] = edXY(e);
  if (!cornerDrag) {
    let hk = -1; F.quad.forEach(([x, y], i) => { if (Math.hypot(x - px, y - py) < 14 / ev.s) hk = i; });
    ec.style.cursor = hk >= 0 ? 'crosshair' : insideQuad(F.quad, px, py) ? 'move' : 'default';
    return;
  }
  const dx = px - cornerDrag.last[0], dy = py - cornerDrag.last[1]; cornerDrag.last = [px, py];
  if (cornerDrag.k >= 0) F.quad[cornerDrag.k] = [q4(px), q4(py)];
  else F.quad = F.quad.map(([x, y]) => [x + dx, y + dy]);
  drawEditor();
});
ec.addEventListener('pointerup', () => {
  if (!cornerDrag) return; cornerDrag = null;
  const F = curFrame(); F.quad = F.quad.map(([x, y]) => [q4(x), q4(y)]);
  ec.style.cursor = 'crosshair'; ev = null; cornerChanged();
});

$('okBtn').addEventListener('click', ok);
function ok() {
  const F = curFrame(); F.ok = true;
  const n = carryForward(st.sel.r);
  if (n) status(`Updated ${n} unchecked frame${n > 1 ? 's' : ''} in row ${rowName(st.sel.r)} from your corners.`);
  alignCache.delete(st.sel.r); save(); st.phase = 'crop'; syncEditor(); buildStrip(); drawEditor();
}
// Frames you haven't checked or touched take the correction from the nearest checked frame in the row,
// corner by corner: the same move relative to the tool's guess. Where your corner sits on the print's corner
// (snapping agrees with you), the moved corner also snaps onto its own print's corner; where you placed it
// off the corner on purpose (bleed), it gets exactly your shift and no snapping.
function carryForward(r) {
  const R = st.rows[r], conf = R.frames.map((F, i) => F.ok ? i : -1).filter(i => i >= 0);
  if (!conf.length) return 0;
  const info = {};
  conf.forEach(i => { const F = R.frames[i], sn = snap(F.quad);
    info[i] = { delta: F.quad.map((p, k) => [p[0] - F.guess[k][0], p[1] - F.guess[k][1]]), onEdge: F.quad.map((p, k) => sn.traced[k] && Math.hypot(p[0] - sn[k][0], p[1] - sn[k][1]) <= 0.75) }; });
  let n = 0;
  R.frames.forEach((G, j) => {
    if (G.ok || G.touched) return;
    let src = conf[0]; for (const i of conf) if (Math.abs(i - j) < Math.abs(src - j)) src = i;
    const { delta, onEdge } = info[src], moved = G.guess.map((p, k) => [p[0] + delta[k][0], p[1] + delta[k][1]]), sn = snap(moved);
    G.quad = moved.map((p, k) => onEdge[k] ? [q4(sn[k][0]), q4(sn[k][1])] : [q4(p[0]), q4(p[1])]); n++;
  });
  if (n) alignCache.delete(r);
  return n;
}
$('adjustBtn').addEventListener('click', () => { st.phase = 'adjust'; syncEditor(); drawEditor(); });
$('nextBtn').addEventListener('click', () => next(1));
$('nextFrame').addEventListener('click', () => next(1));
$('prevFrame').addEventListener('click', () => next(-1));
function next(d) {
  let { r, f } = st.sel; f += d;
  if (f >= st.rows[r].frames.length) { r++; f = 0; }
  if (f < 0) { r--; if (r < 0) { r = 0; f = 0; } else f = st.rows[r].frames.length - 1; }
  if (r >= st.rows.length) { goStep(3); return; }
  ev = null; selectFrame(r, f);
}
$('toPreview').addEventListener('click', () => goStep(3));
function cropSetting(apply) {
  const R = st.rows[st.sel.r], F = curFrame();
  if ($('frameOnly').checked) { apply(F); if (F.tol == null) F.tol = R.tol; if (F.exact == null) F.exact = R.exact; }
  else { apply(R); R.frames.forEach(fr => { fr.tol = null; fr.exact = null; }); }
  alignCache.delete(st.sel.r); save(); syncEditor(); drawEditor();
}
$('tol').addEventListener('input', e => cropSetting(o => { o.tol = +e.target.value; }));
$('exact').addEventListener('change', e => cropSetting(o => { o.exact = e.target.checked; }));
$('frameOnly').addEventListener('change', e => {
  const R = st.rows[st.sel.r], F = curFrame();
  if (e.target.checked) { F.tol = R.tol; F.exact = R.exact; } else { F.tol = null; F.exact = null; }
  alignCache.delete(st.sel.r); save(); syncEditor(); drawEditor();
});

// ======================= STEP 3: preview & export =======================
async function enterPreview() {
  // cut everything (cached), align each row, chain joined rows
  for (let r = 0; r < st.rows.length; r++) for (let f = 0; f < st.rows[r].frames.length; f++) {
    if (!cutCache.has(`${r}:${f}`) || cutCache.get(`${r}:${f}`).sig !== JSON.stringify([st.rows[r].frames[f].quad, effTol(st.rows[r], st.rows[r].frames[f]), effExact(st.rows[r], st.rows[r].frames[f])])) {
      status(`Cutting row ${rowName(r)}, frame ${f + 1}…`, true); await tick();
    }
    getCut(r, f);
  }
  for (let r = 0; r < st.rows.length; r++) await alignRow(r);
  buildSeqs(); renderRowCtl(); renderSeqs();
  $('fps').value = st.fps; syncLoop(); status('');
  st.t = Math.min(st.t, Math.max(0, maxLen() - 1)); updateScrub(); drawSeqs();
  startPlay();   // the preview always opens playing
}

async function alignRow(r) {
  const R = st.rows[r], sig = JSON.stringify([R.align, R.range, R.frames.map((f, i) => cutCache.get(`${r}:${i}`).sig)]);
  const c = alignCache.get(r); if (c && c.sig === sig) return;
  const cuts = R.frames.map((_, i) => cutCache.get(`${r}:${i}`).cut);
  const pos = cuts.map(k => [-k.center[0], -k.center[1]]);
  if (R.align === 'content' && cuts.length > 1) {
    for (let i = 1; i < cuts.length; i++) {
      status(`Aligning row ${rowName(r)}, frame ${i + 1}…`, true); await tick();
      const A = cuts[i - 1], B = cuts[i], ca = [pos[i - 1][0] + A.center[0], pos[i - 1][1] + A.center[1]];
      // frame edges put B on A; picture content may move it at most ±range from there
      const d0 = [A.center[0] - B.center[0] - ca[0], A.center[1] - B.center[1] - ca[1]];
      const res = Core.matchShift(st.plate, A, B, d0, R.range);
      const cb = [res.d[0] - d0[0], res.d[1] - d0[1]].map(v => clamp(v, -R.range, R.range));
      pos[i] = [-B.center[0] + cb[0], -B.center[1] + cb[1]];
    }
  }
  alignCache.set(r, { sig, pos });
}
const joinCache = new Map();
function buildSeqs() {
  syncSeqDefs();
  const seqs = [];
  st.seqDefs.forEach(def => { seqs.push({ rows: [], items: [], base: [], joins: [] }); def.forEach((id, di) => {
    const r = st.rows.findIndex(q => q.id === id), R = st.rows[r];
    const S = seqs[seqs.length - 1]; S.rows.push(r);
    const pos = alignCache.get(r).pos, span = rowSpan(R); let off = [0, 0];
    if (S.items.length) {
      const last = S.items[S.items.length - 1], pa = S.base[S.base.length - 1];
      const A = cutCache.get(`${last.r}:${last.f}`).cut, B = cutCache.get(`${r}:${span[0]}`).cut, pb = pos[span[0]];
      off = [pa[0] + A.center[0] - (pb[0] + B.center[0]), pa[1] + A.center[1] - (pb[1] + B.center[1])];
      const RA = st.rows[last.r];
      if (RA.align === 'content' && R.align === 'content') {
        const key = cutCache.get(`${last.r}:${last.f}`).sig + '|' + cutCache.get(`${r}:${span[0]}`).sig + '|' + Math.min(RA.range, R.range);
        let jc = joinCache.get(key);
        if (!jc) { const rng = Math.min(RA.range, R.range), d0 = [A.center[0] - B.center[0], A.center[1] - B.center[1]], res = Core.matchShift(st.plate, A, B, d0, rng);
          jc = [clamp(res.d[0] - d0[0], -rng, rng), clamp(res.d[1] - d0[1], -rng, rng)]; joinCache.set(key, jc); }
        off = [off[0] + jc[0], off[1] + jc[1]];
      }
      const jkey = `${def[di - 1]}>${id}`, jn = st.joinNudge[jkey] || [0, 0];
      off = [off[0] + jn[0], off[1] + jn[1]];
      S.joins.push({ key: jkey, a: S.items.length - 1, b: S.items.length });
    }
    for (let f = span[0]; f <= span[1]; f++) { S.items.push({ r, f }); S.base.push([pos[f][0] + off[0], pos[f][1] + off[1]]); }
  }); });
  const used = {};
  seqs.forEach(S => {
    const nm = S.rows.map(rowName).join('-'); used[nm] = (used[nm] || 0) + 1;
    S.name = used[nm] > 1 ? `${nm}_${used[nm]}` : nm;
    S.pos = S.items.map(({ r, f }, i) => { const n = st.rows[r].frames[f].nudge; return [S.base[i][0] + n[0], S.base[i][1] + n[1]]; });
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    S.items.forEach(({ r, f }, i) => {
      const k = cutCache.get(`${r}:${f}`).cut, bb = k.bbox || (k.bbox = alphaBBox(k)), p = S.pos[i];
      x0 = Math.min(x0, p[0] + bb[0]); y0 = Math.min(y0, p[1] + bb[1]); x1 = Math.max(x1, p[0] + bb[2]); y1 = Math.max(y1, p[1] + bb[3]);
    });
    S.bounds = { x: Math.floor(x0) - 2, y: Math.floor(y0) - 2, w: Math.ceil(x1 - x0) + 4, h: Math.ceil(y1 - y0) + 4 };
  });
  seqs.forEach((S, i) => { const o = st.seqs[i]; if (o && o.t != null) { S.t = Math.min(o.t, S.items.length - 1); S.dir = o.dir; } });   // keep playheads
  st.seqs = seqs; if (st.selSeq >= seqs.length) st.selSeq = 0;
}
function alphaBBox(k) {
  let x0 = k.w, y0 = k.h, x1 = 0, y1 = 0;
  for (let y = 0; y < k.h; y++) for (let x = 0; x < k.w; x++) if (k.alpha[y * k.w + x]) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x + 1 > x1) x1 = x + 1; if (y + 1 > y1) y1 = y + 1; }
  return x1 > x0 ? [x0, y0, x1, y1] : [0, 0, k.w, k.h];
}
function renderRowCtl() {
  const host = $('rowCtl'); host.innerHTML = '';
  st.rows.forEach((R, r) => {
    const d = document.createElement('div'); d.className = 'rowctl';
    d.innerHTML = `<div class="line"><b>${rowName(r)}</b> Align on
      <select data-k="align"><option value="content">picture content</option><option value="edges">frame edges</option></select>
      <span data-k="rw">± <input type="number" class="num" data-k="range" min="1" max="60" value="${R.range}"> px</span></div>
      <div class="line" style="padding-left:28px">frames <input type="number" class="num" data-k="from" min="1" max="${R.frames.length}" value="${rowSpan(R)[0] + 1}">
        to <input type="number" class="num" data-k="to" min="1" max="${R.frames.length}" value="${rowSpan(R)[1] + 1}"> <span class="hint small" style="margin:0">of ${R.frames.length}</span></div>`;
    const sel = d.querySelector('[data-k=align]'); sel.value = R.align; d.querySelector('[data-k=rw]').hidden = R.align !== 'content';
    sel.onchange = () => { R.align = sel.value; d.querySelector('[data-k=rw]').hidden = R.align !== 'content'; refreshPreview(); };
    d.querySelector('[data-k=range]').onchange = e => { R.range = clamp(+e.target.value || 12, 1, 60); e.target.value = R.range; refreshPreview(); };
    d.querySelector('[data-k=from]').onchange = e => setRowSpan(r, (+e.target.value || 1) - 1, rowSpan(R)[1]);
    d.querySelector('[data-k=to]').onchange = e => setRowSpan(r, rowSpan(R)[0], (+e.target.value || R.frames.length) - 1);
    host.appendChild(d);
  });
  renderSeqEditor();
}
// ---------- sequences editor: chains of rows, drag chips to reorder or move between sequences ----------
function syncSeqDefs() {
  // edit in place: the editor's buttons hold references to these arrays
  const ids = new Set(st.rows.map(R => R.id));
  st.seqDefs.forEach(d => { for (let i = d.length - 1; i >= 0; i--) if (!ids.has(d[i])) d.splice(i, 1); });
  for (let i = st.seqDefs.length - 1; i >= 0; i--) if (!st.seqDefs[i].length) st.seqDefs.splice(i, 1);
  st.rows.forEach(R => { if (!R.placed) { st.seqDefs.push([R.id]); R.placed = true; } });   // a new row starts as its own sequence
}
let chipDrag = null;
function renderSeqEditor() {
  syncSeqDefs();
  const host = $('seqEd'); host.innerHTML = '';
  const nameOf = id => rowName(st.rows.findIndex(R => R.id === id));
  const changed = () => { renderSeqEditor(); refreshPreview(); };
  st.seqDefs.forEach((def, s) => {
    const line = document.createElement('div'); line.className = 'seqline'; line.dataset.s = s;
    def.forEach((id, i) => {
      if (i > 0) {
        const jb = document.createElement('button'), key = `${def[i - 1]}>${id}`, n = st.joinNudge[key];
        jb.className = 'jbtn' + (st.join && st.join.s === s && st.join.j === i - 1 ? ' on' : '') + (n && (n[0] || n[1]) ? ' moved' : '');
        jb.textContent = '⇄'; jb.title = `Line up ${nameOf(def[i - 1])} → ${nameOf(id)}`;
        jb.onclick = () => openJoin(s, i - 1);
        line.appendChild(jb);
      }
      const c = document.createElement('span'); c.className = 'chip'; c.draggable = true; c.dataset.i = i;
      c.innerHTML = `${nameOf(id)}<button aria-label="Remove ${nameOf(id)} from this sequence">×</button>`;
      c.querySelector('button').onclick = () => { def.splice(i, 1); changed(); };
      c.addEventListener('dragstart', e => { chipDrag = { s, i }; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); c.classList.add('dragging'); });
      c.addEventListener('dragend', () => { chipDrag = null; c.classList.remove('dragging'); });
      c.addEventListener('dragover', e => { if (chipDrag) { e.preventDefault(); e.stopPropagation(); c.classList.add('over'); } });
      c.addEventListener('dragleave', () => c.classList.remove('over'));
      c.addEventListener('drop', e => { e.preventDefault(); e.stopPropagation(); dropChip(s, i); });
      line.appendChild(c);
    });
    const add = document.createElement('select'); add.className = 'addrow'; add.setAttribute('aria-label', 'Add a row to this sequence');
    add.innerHTML = '<option value="">+ row</option>' + st.rows.map((R, r) => `<option value="${R.id}">${rowName(r)}</option>`).join('');
    add.onchange = () => { if (add.value) { def.push(add.value); changed(); } };
    line.appendChild(add);
    line.addEventListener('dragover', e => { if (chipDrag) { e.preventDefault(); line.classList.add('over'); } });
    line.addEventListener('dragleave', () => line.classList.remove('over'));
    line.addEventListener('drop', e => { e.preventDefault(); dropChip(s, def.length); });
    host.appendChild(line);
  });
  const nw = document.createElement('div'); nw.className = 'seqline new'; nw.textContent = '+ New sequence (drop a row here, or pick one)';
  const pick = document.createElement('select'); pick.className = 'addrow';
  pick.innerHTML = '<option value="">+ row</option>' + st.rows.map((R, r) => `<option value="${R.id}">${rowName(r)}</option>`).join('');
  pick.onchange = () => { if (pick.value) { st.seqDefs.push([pick.value]); changed(); } };
  nw.appendChild(pick);
  nw.addEventListener('dragover', e => { if (chipDrag) { e.preventDefault(); nw.classList.add('over'); } });
  nw.addEventListener('dragleave', () => nw.classList.remove('over'));
  nw.addEventListener('drop', e => { e.preventDefault(); dropChip(st.seqDefs.length, 0); });
  host.appendChild(nw);
  function dropChip(s2, i2) {
    if (!chipDrag) return; const { s, i } = chipDrag; chipDrag = null;
    const id = st.seqDefs[s][i];
    if (s2 >= st.seqDefs.length) st.seqDefs.push([]);
    st.seqDefs[s].splice(i, 1);
    if (s === s2 && i < i2) i2--;
    st.seqDefs[s2].splice(i2, 0, id);
    changed();
  }
}
async function refreshPreview() { save(); for (let r = 0; r < st.rows.length; r++) await alignRow(r); buildSeqs(); renderSeqs(); updateScrub(); drawSeqs(); drawJoin(); status(''); }
function renderSeqs() {
  const host = $('seqs'); host.innerHTML = '';
  st.seqs.forEach((S, i) => {
    const d = document.createElement('div'); d.className = 'seq' + (i === st.selSeq ? ' sel' : '');
    const B = S.bounds, H = Math.min(380, Math.max(200, window.innerHeight - 330)), sc = Math.min(H / B.h, 560 / B.w), dpr = devicePixelRatio || 1;
    const cv = document.createElement('canvas'); cv.width = Math.round(B.w * sc * dpr); cv.height = Math.round(B.h * sc * dpr); cv.style.width = Math.round(B.w * sc) + 'px'; cv.style.height = Math.round(B.h * sc) + 'px';
    S.cv = cv; S.sc = sc;
    d.appendChild(cv); d.insertAdjacentHTML('beforeend', `<p><b>${S.name}</b><span>${S.items.length} frames · ${B.w}×${B.h}px</span><span class="nud"></span></p>`);
    d.onclick = () => { st.selSeq = i; host.querySelectorAll('.seq').forEach((x, k) => x.classList.toggle('sel', k === i)); drawSeqs(); };
    host.appendChild(d);
  });
}
function drawSeqs() {
  st.seqs.forEach((S, i) => {
    if (!S.cv) return;
    const ctx = S.cv.getContext('2d'), dpr = devicePixelRatio || 1, B = S.bounds, sc = S.sc;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); paintChecker(ctx, 0, 0, B.w * sc, B.h * sc, 10);
    const k = shownIndex(S), { r, f } = S.items[k], c = cutCache.get(`${r}:${f}`), p = S.pos[k];
    ctx.imageSmoothingQuality = 'high'; ctx.drawImage(c.bmp, (p[0] - B.x) * sc, (p[1] - B.y) * sc, c.cut.w * sc, c.cut.h * sc);
    const n = st.rows[r].frames[f].nudge, el = S.cv.parentNode.querySelector('.nud');
    if (el) el.textContent = i === st.selSeq && !st.playing ? `${rowName(r)}${f + 1}${n[0] || n[1] ? ` nudged ${n[0]}, ${n[1]}` : ''}` : '';
  });
}
// which frame a sequence shows: the shared playhead, or its own when sequences run independently
function shownIndex(S) { return Math.min(st.indep && S.t != null ? S.t : st.t, S.items.length - 1); }
// one playback step inside [lo, hi] for a playhead object {t, dir}
function stepHead(h, lo, hi) {
  const rev = st.loop === 'loop' && st.rev;
  if (h.t == null || h.t < lo || h.t > hi) { h.t = rev ? hi : lo; h.dir = 1; return; }
  if (st.loop === 'loop') h.t = rev ? (h.t <= lo ? hi : h.t - 1) : (h.t >= hi ? lo : h.t + 1);
  else if (hi > lo) { if (h.t + h.dir > hi || h.t + h.dir < lo) h.dir = -h.dir; h.t = clamp(h.t + h.dir, lo, hi); }
}
function maxLen() { return st.seqs.reduce((a, S) => Math.max(a, S.items.length), 0); }
function range() { return [0, Math.max(1, maxLen()) - 1]; }
function updateScrub() {
  const n = Math.max(1, maxLen()); $('scrub').max = n - 1; st.t = Math.min(st.t, n - 1); $('scrub').value = st.t;
  $('frameNo').textContent = `${st.t + 1} / ${n}`;
}
// each row plays only frames from..to (0-based, inclusive; to null = last)
const rowSpan = R => { const n = R.frames.length, b = R.to == null ? n - 1 : clamp(R.to, 0, n - 1), a = clamp(R.from || 0, 0, b); return [a, b]; };
function setRowSpan(r, a, b) {
  const R = st.rows[r], n = R.frames.length; a = clamp(a, 0, n - 1); b = clamp(b, 0, n - 1); if (a > b) [a, b] = [b, a];
  R.from = a; R.to = b === n - 1 ? null : b;
  renderRowCtl(); refreshPreview();
}
$('scrub').addEventListener('input', e => { stopPlay(); st.t = +e.target.value; syncHeads(); updateScrub(); drawSeqs(); });
function syncHeads() { st.seqs.forEach(S => { S.t = Math.min(st.t, S.items.length - 1); S.dir = st.dir; }); }
$('playBtn').addEventListener('click', () => st.playing ? stopPlay() : startPlay());
$('fps').addEventListener('change', e => { st.fps = clamp(+e.target.value || 6, 1, 60); e.target.value = st.fps; save(); if (st.playing) startPlay(); });
function syncLoop() { document.querySelectorAll('#loopSeg button').forEach(b => b.classList.toggle('on', b.dataset.v === st.loop)); $('indep').checked = st.indep; $('rev').checked = st.rev; $('revWrap').hidden = st.loop !== 'loop'; }
$('rev').addEventListener('change', e => { st.rev = e.target.checked; save(); });
$('indep').addEventListener('change', e => { st.indep = e.target.checked; syncHeads(); save(); drawSeqs(); });
document.querySelectorAll('#loopSeg button').forEach(b => b.addEventListener('click', () => { st.loop = b.dataset.v; st.dir = 1; syncLoop(); save(); }));
let timer = null;
function startPlay() {
  clearInterval(timer); st.playing = true; $('playBtn').textContent = '❚❚';
  timer = setInterval(() => {
    const [lo, hi] = range(), head = { t: st.t, dir: st.dir };
    stepHead(head, lo, hi); st.t = head.t; st.dir = head.dir;
    // independent: each sequence turns around (or wraps) at the end of its own frames, within the same start/end
    if (st.indep) st.seqs.forEach(S => { const h = { t: S.t, dir: S.dir || 1 }; stepHead(h, Math.min(lo, S.items.length - 1), Math.min(hi, S.items.length - 1)); S.t = h.t; S.dir = h.dir; });
    updateScrub(); drawSeqs();
  }, 1000 / st.fps);
}
function stopPlay() { st.playing = false; clearInterval(timer); $('playBtn').textContent = '▶'; if (st.step === 3) drawSeqs(); }

document.addEventListener('keydown', e => {
  if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName) && document.activeElement.type !== 'checkbox' && document.activeElement.type !== 'range') return;
  if (st.step === 2 && e.key === 'Enter') { e.preventDefault(); if (st.phase === 'adjust') ok(); else next(1); }
  if (st.step === 2 && st.phase === 'adjust' && activeCorner >= 0) {
    const dd = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (dd) { e.preventDefault(); const F = curFrame(), m = e.shiftKey ? 1 : 0.25, [x, y] = F.quad[activeCorner];
      F.quad[activeCorner] = [q4(x + dd[0] * m), q4(y + dd[1] * m)]; ev = null; cornerChanged(); return; }
  }
  if (st.step !== 3) return;
  if (e.key === ' ') { e.preventDefault(); st.playing ? stopPlay() : startPlay(); return; }
  if (e.key === '[' || e.key === ']') {
    const S = st.seqs[st.selSeq]; if (!S) return; stopPlay();
    const { r, f } = S.items[shownIndex(S)], [a, b] = rowSpan(st.rows[r]);
    if (e.key === '[') setRowSpan(r, f, Math.max(f, b)); else setRowSpan(r, Math.min(a, f), f);
    return;
  }
  const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }, d = dirs[e.key];
  if (st.join && e.key === 'Escape') { closeJoin(); return; }
  if (st.join && d) {
    e.preventDefault(); const J = curJoin(); if (!J) return;
    const k = e.shiftKey ? 10 : 1, n = st.joinNudge[J.key] || [0, 0];
    st.joinNudge[J.key] = [n[0] + d[0] * k, n[1] + d[1] * k];
    save(); buildSeqs(); renderSeqs(); drawSeqs(); drawJoin(); renderSeqEditor(); return;
  }
  if (!d) return;
  e.preventDefault(); stopPlay();
  const S = st.seqs[st.selSeq]; if (!S) return;
  const { r, f } = S.items[shownIndex(S)], F = st.rows[r].frames[f], k = e.shiftKey ? 10 : 1;
  F.nudge = [F.nudge[0] + d[0] * k, F.nudge[1] + d[1] * k];
  save(); buildSeqs(); renderSeqs(); drawSeqs();
});

// ---------- join editor: line up where one row hands over to the next ----------
let jeMode = 'onion';
function curJoin() { if (!st.join) return null; const S = st.seqs[st.join.s]; return S && S.joins[st.join.j] ? Object.assign({ S }, S.joins[st.join.j]) : null; }
function openJoin(s, j) { st.join = { s, j }; $('joinEd').hidden = false; renderSeqEditor(); drawJoin(); $('joinEd').scrollIntoView({ block: 'nearest' }); }
function closeJoin() { st.join = null; $('joinEd').hidden = true; renderSeqEditor(); }
$('jeClose').addEventListener('click', closeJoin);
$('jeReset').addEventListener('click', () => { const J = curJoin(); if (!J) return; delete st.joinNudge[J.key]; save(); buildSeqs(); renderSeqs(); drawSeqs(); drawJoin(); renderSeqEditor(); });
document.querySelectorAll('#jeMode button').forEach(b => b.addEventListener('click', () => { jeMode = b.dataset.v; document.querySelectorAll('#jeMode button').forEach(x => x.classList.toggle('on', x === b)); drawJoin(); }));
function drawJoin() {
  if (!st.join || st.step !== 3) return;
  const J = curJoin(); if (!J) { closeJoin(); return; }
  const S = J.S, ia = S.items[J.a], ib = S.items[J.b], ca = cutCache.get(`${ia.r}:${ia.f}`), cb = cutCache.get(`${ib.r}:${ib.f}`), pa = S.pos[J.a], pb = S.pos[J.b];
  const x0 = Math.min(pa[0], pb[0]) - 6, y0 = Math.min(pa[1], pb[1]) - 6, x1 = Math.max(pa[0] + ca.cut.w, pb[0] + cb.cut.w) + 6, y1 = Math.max(pa[1] + ca.cut.h, pb[1] + cb.cut.h) + 6;
  const cv = $('jeCanvas'), maxW = Math.min(616, $('joinEd').clientWidth - 20), sc = Math.min(maxW / (x1 - x0), 440 / (y1 - y0)), dpr = devicePixelRatio || 1;
  const w = Math.round((x1 - x0) * sc), h = Math.round((y1 - y0) * sc);
  cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px';
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#111'; ctx.fillRect(0, 0, w, h); ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(ca.bmp, (pa[0] - x0) * sc, (pa[1] - y0) * sc, ca.cut.w * sc, ca.cut.h * sc);
  if (jeMode === 'diff') ctx.globalCompositeOperation = 'difference'; else ctx.globalAlpha = 0.5;
  ctx.drawImage(cb.bmp, (pb[0] - x0) * sc, (pb[1] - y0) * sc, cb.cut.w * sc, cb.cut.h * sc);
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  const n = st.joinNudge[J.key] || [0, 0];
  $('jeTitle').textContent = `${rowName(ia.r)}${ia.f + 1} → ${rowName(ib.r)}${ib.f + 1}  (sequence ${S.name})`;
  $('jeVal').textContent = n[0] || n[1] ? `moved ${n[0]}, ${n[1]} px from automatic` : 'automatic';
}

// ---------- export ----------
$('exportBtn').addEventListener('click', exportZip);
async function exportZip() {
  const btn = $('exportBtn'); btn.disabled = true; stopPlay();
  try {
    const files = [], enc = new TextEncoder(), base = st.name, out = [];
    for (const S of st.seqs) {
      const B = S.bounds, dir = `${base}_${S.name}`;
      out.push({ folder: dir, frames: S.items.length, w: B.w, h: B.h, rows: S.rows.map(rowName) });
      for (let i = 0; i < S.items.length; i++) {
        status(`Exporting ${S.name}, frame ${i + 1}/${S.items.length}…`, true); await tick();
        const { r, f } = S.items[i], c = cutCache.get(`${r}:${f}`), p = S.pos[i];
        const cv = document.createElement('canvas'); cv.width = B.w; cv.height = B.h;
        cv.getContext('2d').drawImage(c.bmp, Math.round(p[0] - B.x), Math.round(p[1] - B.y));
        files.push({ name: `${dir}/${dir}_${String(i + 1).padStart(4, '0')}.png`, data: await canvasPNG(cv) });
      }
    }
    files.push({ name: 'project.json', data: enc.encode(JSON.stringify(projectJSON(), null, 1)) });
    files.push({ name: 'README.txt', data: enc.encode(readme(out)) });
    status('Zipping…', true); await tick();
    const blob = Core.makeZip(files), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `${base}_sequences.zip`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    status(`Exported ${out.length} sequence${out.length > 1 ? 's' : ''} (${(blob.size / 1e6).toFixed(1)} MB).`);
  } finally { btn.disabled = false; }
}
function canvasPNG(cv) { return new Promise(res => cv.toBlob(b => b.arrayBuffer().then(ab => res(new Uint8Array(ab))), 'image/png')); }
function readme(rows) {
  return `Plate Cutter export — ${st.name}
Made ${new Date().toISOString().slice(0, 10)} at reevehunter.com/platecutter

Sequences (every frame in a folder has the same canvas size; transparent PNG, straight alpha):
${rows.map(r => `  ${r.folder}/  ${r.frames} frames, ${r.w}x${r.h}px${r.rows.length > 1 ? `  (rows ${r.rows.join(' then ')} joined)` : ''}`).join('\n')}

Rows on one plate were exposed at the same instants, so frame N of every unjoined
folder is the same moment seen from a different camera. A joined folder is one
longer sequence that wrapped onto the next row of the plate.

After Effects
1. File > Import, pick the first PNG in a folder, tick "PNG Sequence".
2. Interpret Footage > Main: "Assume this frame rate" = your comp's rate
   (Alpha: Straight).
3. Add a null named SCRUB with Effect > Expression Controls > Slider Control
   (rename the slider "Frame"). Keyframe it to scrub back and forth.
4. On each sequence layer: Layer > Time > Enable Time Remapping, then
   alt/option-click the Time Remap stopwatch and paste:

     n = thisLayer.source.duration / thisComp.frameDuration;
     f = thisComp.layer("SCRUB").effect("Frame")("Slider");
     framesToTime(Math.max(0, Math.min(n - 1, Math.round(f))));

project.json holds every frame's corners (and the tool's first guess), tolerances
and nudges.
`;
}
})();
