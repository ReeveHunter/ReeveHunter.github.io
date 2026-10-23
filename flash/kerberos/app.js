import * as K from "./protocol.js";
import { mountLibrary } from "../library/library.js";

// Bump on every change so the page shows which build the browser is running.
const BUILD = "v1.6 · 2026-10-22";
document.getElementById("buildTag").textContent = `Build ${BUILD}`;
console.info("Kerberos Flash build", BUILD);

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("kerberos." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("kerberos." + k, JSON.stringify(v)); } catch {} },
};
const hex4 = (n) => n.toString(16).toUpperCase().padStart(4, "0");
const fmtBytes = (n) => n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB (${n.toLocaleString()} bytes)`;
const fmtDuration = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

// ------------------------------------------------------------------ state

const state = {
  midi: null,
  out: null,
  input: null,
  file: null,          // { name, bytes, kind: "prg" | "crt", crt? }
  slot: store.get("slot", 1),
  // slots[n] = { kind: "prg" | "empty" | "ef" | "data", name?, length? }
  slots: store.get("slots", {}),
  ef: store.get("ef", null), // { present, name, overlapping } once read
  busy: false,
  abort: null,
  lastMessages: null,
  pendingReply: null,
};

// -------------------------------------------------------------------- log

function log(text, cls = "") {
  const el = $("log");
  const line = document.createElement("div");
  const t = document.createElement("span");
  t.className = "t";
  t.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + "  ";
  const m = document.createElement("span");
  if (cls) m.className = cls;
  m.textContent = text;
  line.append(t, m);
  el.append(line);
  while (el.childNodes.length > 400) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}

// ------------------------------------------------------------------- MIDI

const receiver = new K.Receiver(
  (tag, data) => {
    if (state.pendingReply) { const r = state.pendingReply; state.pendingReply = null; r.resolve({ tag, data }); }
    else if (tag === K.CMD.PONG) log("Received PONG from cartridge.", "ok");
  },
  (err) => {
    if (state.pendingReply) { const r = state.pendingReply; state.pendingReply = null; r.reject(err); }
    else log(err.message, "err");
  },
);

function onMidiMessage(e) { receiver.feed(e.data); }

async function connectMidi() {
  if (!navigator.requestMIDIAccess) return;
  try {
    state.midi = await navigator.requestMIDIAccess({ sysex: false });
  } catch (err) {
    log("MIDI access was refused: " + (err.message || err.name), "err");
    return;
  }
  state.midi.onstatechange = () => refreshPorts();
  $("connectBtn").hidden = true;
  refreshPorts();
  log("MIDI access granted.");
}

function fillSelect(sel, ports, savedName, allowNone) {
  const prev = sel.value;
  sel.innerHTML = "";
  if (allowNone) sel.append(new Option("None", ""));
  for (const p of ports) sel.append(new Option(p.name, p.id));
  if (!ports.length && !allowNone) sel.append(new Option("No MIDI outputs found", ""));
  const byName = ports.find((p) => p.name === savedName);
  const keep = ports.find((p) => p.id === prev);
  sel.value = keep ? prev : byName ? byName.id : allowNone ? "" : ports[0]?.id || "";
  sel.disabled = !ports.length;
}

function refreshPorts() {
  if (!state.midi) return;
  const outs = [...state.midi.outputs.values()];
  const ins = [...state.midi.inputs.values()];
  fillSelect($("outSelect"), outs, store.get("outName", null), false);
  // First visit: pair the input with the output's interface (same name).
  const savedIn = store.get("inName", null);
  fillSelect($("inSelect"), ins, savedIn === null ? state.midi.outputs.get($("outSelect").value)?.name : savedIn, true);
  selectOut(); selectIn();
}

function selectOut() {
  const id = $("outSelect").value;
  state.out = id ? state.midi.outputs.get(id) || null : null;
  if (state.out) { store.set("outName", state.out.name); state.out.open?.().catch(() => {}); }
  updateUi();
}

function selectIn() {
  if (state.input) state.input.onmidimessage = null;
  const id = $("inSelect").value;
  state.input = id ? state.midi.inputs.get(id) || null : null;
  if (state.input) { store.set("inName", state.input.name); state.input.onmidimessage = onMidiMessage; }
  else store.set("inName", "");
  receiver.reset();
  updateUi();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Streams a MessageBuilder's messages at a fixed pace. The cartridge has no
// flow control, so pacing at (or below) MIDI wire speed is what keeps the
// C64 in step — the same job the 31250-baud cable did for the original app.
async function stream(builder, { title, signal, quiet = false }) {
  const out = state.out;
  if (!out) throw new Error("No MIDI output selected.");
  const bytes = builder.bytes(), marks = builder.marks, n = builder.length;
  const interval = Number($("pacingSelect").value) || 1;
  if (!quiet) {
    state.lastMessages = bytes;
    $("downloadLogBtn").disabled = false;
    showDock(title, n * interval);
  }

  let i = 0, markIdx = -1, t0 = performance.now(), lastPaint = 0;
  const maxBurst = 64;
  while (i < n) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const now = performance.now();
    const due = Math.min(n, Math.floor((now - t0) / interval) + 1);
    const end = Math.min(due, i + maxBurst);
    if (end > i) { out.send(bytes.subarray(i * 3, end * 3)); i = end; }
    // If the tab was throttled we fall behind: rebase instead of bursting.
    if (end < due) t0 = performance.now() - i * interval;
    while (markIdx + 1 < marks.length && marks[markIdx + 1].at <= i) markIdx++;
    if (!quiet && (now - lastPaint > 100 || i === n)) {
      lastPaint = now;
      paintProgress(i, n, markIdx >= 0 ? marks[markIdx].text : title, (n - i) * interval);
    }
    await sleep(8);
  }
  // Let the OS/interface buffer drain before reporting success.
  if (!quiet) await sleep(150);
}

function waitReply(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingReply = null;
      reject(new Error("No reply from the cartridge. Check the MIDI in cable, and that the C64 is on the Kerberos menu's T (Transfer from PC/Mac) screen."));
    }, timeoutMs);
    state.pendingReply = {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    };
  });
}

// ------------------------------------------------------------ job runner

let wakeLock = null;
async function runJob(title, fn) {
  if (state.busy) return;
  state.busy = true;
  state.abort = new AbortController();
  updateUi();
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  log(title + "…");
  const started = performance.now();
  try {
    const msg = await fn(state.abort.signal);
    finishDock(true, msg || "Done");
    log(`${msg || title + " done"} (${fmtDuration(performance.now() - started)})`, "ok");
  } catch (err) {
    if (err.name === "AbortError") {
      finishDock(false, "Cancelled");
      log("Cancelled. If this was a flash, the slot is only partly written — flash it again.", "err");
    } else {
      finishDock(false, err.message);
      log(err.message, "err");
    }
  } finally {
    state.busy = false;
    state.abort = null;
    try { await wakeLock?.release(); } catch {}
    wakeLock = null;
    updateUi();
  }
}

function showDock(title, etaMs) {
  const dock = $("progressDock");
  dock.hidden = false;
  dock.classList.remove("done", "failed");
  $("cancelBtn").hidden = false;
  paintProgress(0, 1, title, etaMs);
}
function paintProgress(i, n, stage, remainingMs) {
  const pct = n ? (i / n) * 100 : 0;
  $("progBar").style.width = pct.toFixed(1) + "%";
  $("progStage").textContent = stage.replace(/\s+\d+%$/, "");
  $("progDetail").textContent = `${Math.floor(pct)}% · ${fmtDuration(remainingMs)} left`;
}
let dockTimer = null;
function finishDock(ok, text) {
  const dock = $("progressDock");
  dock.hidden = false;
  dock.classList.add(ok ? "done" : "failed");
  if (ok) $("progBar").style.width = "100%";
  $("progStage").textContent = text;
  $("progDetail").textContent = "";
  $("cancelBtn").hidden = true;
  clearTimeout(dockTimer);
  dockTimer = setTimeout(() => { if (!state.busy) dock.hidden = true; }, ok ? 4000 : 12000);
}

// ------------------------------------------------------------- confirm

// buttons: [{ value, label, kind: "primary" | "danger" | "ghost" }]
function choiceBox(title, body, buttons) {
  const d = $("confirmDialog");
  $("confirmTitle").textContent = title;
  $("confirmBody").textContent = body;
  const row = $("dialogActions");
  row.innerHTML = "";
  const cancel = document.createElement("button");
  cancel.value = "cancel";
  cancel.className = "btn ghost";
  cancel.textContent = "Cancel";
  row.append(cancel);
  for (const b of buttons) {
    const el = document.createElement("button");
    el.value = b.value;
    el.className = "btn " + (b.kind === "danger" ? "danger-ghost" : b.kind === "ghost" ? "ghost" : "primary");
    el.textContent = b.label;
    row.append(el);
  }
  d.returnValue = "";
  d.showModal();
  row.lastElementChild.focus();
  return new Promise((resolve) => d.addEventListener("close", () => resolve(d.returnValue === "cancel" ? "" : d.returnValue), { once: true }));
}

async function confirmBox(title, body, okLabel = "OK", danger = false) {
  return (await choiceBox(title, body, [{ value: "ok", label: okLabel, kind: danger ? "danger" : "primary" }])) === "ok";
}

// ------------------------------------------------------------- settings

function readOpts() {
  const la = parseInt($("loadAddr").value, 16);
  const sa = parseInt($("startAddr").value, 16);
  return {
    c128: document.querySelector('input[name="machine"]:checked').value === "c128",
    midiEmulation: Number($("emuSelect").value) || 0,
    cartridgeDisks: $("cartDisks").checked,
    loadAddress: Number.isFinite(la) ? la & 0xffff : 0x0801,
    startAddress: Number.isFinite(sa) ? sa & 0xffff : 0,
  };
}
function validateHex(el) {
  const ok = /^[0-9a-f]{1,4}$/i.test(el.value.trim());
  el.classList.toggle("invalid", !ok);
  return ok;
}
function setMachine(c128) {
  document.querySelector(`input[name="machine"][value="${c128 ? "c128" : "c64"}"]`).checked = true;
}
function saveSettings() {
  store.set("emu", $("emuSelect").value);
  store.set("cartDisks", $("cartDisks").checked);
}

// ----------------------------------------------------------------- files

async function loadFile(file) {
  if (state.busy) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const name = file.name;
  const facts = $("fileFacts");
  const notice = $("fileNotice");
  facts.innerHTML = "";
  notice.hidden = true;
  notice.className = "notice";
  $("fileInfo").hidden = false;
  $("fileName").textContent = name;
  $("prgActions").hidden = true;
  $("crtActions").hidden = true;
  state.file = null;

  const fact = (k, v) => { const dt = document.createElement("dt"); dt.textContent = k; const dd = document.createElement("dd"); dd.textContent = v; facts.append(dt, dd); };
  const fail = (msg) => { notice.hidden = false; notice.classList.add("error"); notice.textContent = msg; log(`${name}: ${msg}`, "err"); };
  const interval = Number($("pacingSelect").value) || 1;

  if (/\.crt$/i.test(name)) {
    $("fileType").textContent = "CRT";
    fact("Size", fmtBytes(bytes.length));
    let crt;
    try { crt = K.parseCrt(bytes); } catch (e) { fail(e.message); return; }
    if (crt.cartName) fact("Cartridge name", crt.cartName);
    if (crt.efName) fact("EasyFlash name", crt.efName);
    fact("Banks / chips", `${crt.banks} banks, ${crt.chips} CHIP packets`);
    const builder = K.buildFlashCrt(name, crt.image);
    fact("Transfer time", "≈ " + fmtDuration(builder.length * interval));
    state.file = { name, bytes, kind: "crt", crt, builder };
    $("crtActions").hidden = false;
    log(`Loaded ${name} (EasyFlash CRT, ${crt.banks} banks).`);
  } else if (/\.prg$/i.test(name)) {
    $("fileType").textContent = "PRG";
    fact("Size", fmtBytes(bytes.length));
    if (bytes.length < 3) { fail("File is too small to be a PRG."); return; }
    let { loadAddress, suspiciousC128 } = K.inspectPrg(bytes);
    const d = K.prgDefaults(loadAddress);
    fact("Load address", "$" + hex4(loadAddress));
    fact("Looks like", (d.c128 ? "C128 " : "C64 ") + (d.startAddress === 0 ? "BASIC program (starts with RUN)" : "machine code"));
    if (bytes.length > K.PRG_MAX_SIZE) { fail(`File is too big for a slot (max ${K.PRG_MAX_SIZE.toLocaleString()} bytes).`); return; }
    $("loadAddr").value = hex4(d.loadAddress);
    $("startAddr").value = hex4(d.startAddress);
    validateHex($("loadAddr")); validateHex($("startAddr"));
    setMachine(d.c128);
    if (suspiciousC128) {
      notice.hidden = false;
      notice.textContent = "Load address $4001 is usually a wrong C128 load address.";
      const fix = document.createElement("button");
      fix.className = "btn small";
      fix.textContent = "Use $1C01 (C128)";
      fix.onclick = () => { $("loadAddr").value = "1C01"; $("startAddr").value = "0000"; setMachine(true); notice.hidden = true; };
      notice.append(fix);
    }
    state.file = { name, bytes, kind: "prg" };
    $("prgActions").hidden = false;
    log(`Loaded ${name} (load $${hex4(loadAddress)}, ${bytes.length} bytes).`);
  } else {
    $("fileType").textContent = "?";
    fail("Only .prg and .crt files are supported.");
  }
  updateUi();
}

// ------------------------------------------------------- MIDI emulation

const emuShort = (i) => (i >= 0 ? K.MIDI_EMULATIONS[i].short : "custom MIDI");

// ----------------------------------------------------------------- slots

const DRAG_TYPE = "application/x-kerberos-slot";
const isEfSlot = (s) => s >= 10;
const efLabel = () => "EasyFlash CRT";

function slotLabel(info) {
  if (!info) return { text: "—", cls: "empty" };
  if (info.kind === "prg") return { text: info.name || "(unnamed)", cls: "" };
  if (info.kind === "ef") return { text: efLabel(), cls: "efdata" };
  if (info.kind === "data") return { text: "(unknown data)", cls: "empty" };
  return { text: "empty", cls: "empty" };
}

function setSlot(slot, info) {
  state.slots = { ...state.slots, [slot]: info };
  store.set("slots", state.slots);
}

function canReorganize() {
  return !!state.out && !!state.input && !state.busy;
}

let dragFrom = 0;
function renderSlots() {
  const list = $("slotList");
  list.innerHTML = "";
  const dragOk = canReorganize();
  for (let s = K.SLOT_MIN; s <= K.SLOT_MAX; s++) {
    const info = state.slots[s];
    const li = document.createElement("li");
    if (isEfSlot(s)) li.className = "ef";
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.slot = s;
    b.setAttribute("aria-pressed", String(s === state.slot));
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = s;
    const nm = document.createElement("span");
    const label = slotLabel(info);
    nm.className = "nm" + (label.cls ? " " + label.cls : "");
    nm.textContent = label.text;
    b.title = info?.kind === "prg"
      ? `${info.name} · ${info.length.toLocaleString()} bytes${info.emu !== undefined ? ` · MIDI: ${info.emu >= 0 ? K.MIDI_EMULATIONS[info.emu].label : "custom"}` : ""}${info.c128 ? " · C128" : ""}${dragOk ? " · drag to another slot to move, copy or swap" : ""}`
      : info?.kind === "ef" && state.ef?.name ? `Part of the installed EasyFlash CRT (${state.ef.name})` : label.text;
    b.append(num, nm);
    if (info?.kind === "prg" && info.emu !== undefined) {
      const tag = document.createElement("span");
      tag.className = "emu" + (info.emu === K.EMU_NONE ? " off" : "");
      tag.textContent = emuShort(info.emu);
      b.append(tag);
    }
    b.onclick = () => { state.slot = s; store.set("slot", s); renderSlots(); updateUi(); };

    if (info?.kind === "prg" && dragOk) {
      b.draggable = true;
      b.addEventListener("dragstart", (e) => {
        dragFrom = s;
        e.dataTransfer.setData(DRAG_TYPE, String(s));
        e.dataTransfer.effectAllowed = "copyMove";
        li.classList.add("dragging-src");
      });
      b.addEventListener("dragend", () => { dragFrom = 0; li.classList.remove("dragging-src"); clearDropTargets(); });
    }
    b.addEventListener("dragover", (e) => {
      if (!dragFrom || dragFrom === s || !e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      clearDropTargets();
      li.classList.add("drop-target");
    });
    b.addEventListener("dragleave", () => li.classList.remove("drop-target"));
    b.addEventListener("drop", (e) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.stopPropagation();
      clearDropTargets();
      const from = Number(e.dataTransfer.getData(DRAG_TYPE));
      dragFrom = 0;
      if (from && from !== s) onSlotDrop(from, s);
    });
    li.append(b);
    list.append(li);
  }
  document.querySelectorAll(".slotNum").forEach((el) => (el.textContent = state.slot));
  $("flashSlotLabel").textContent = state.slot;
  renderEfStatus();
}

function clearDropTargets() {
  document.querySelectorAll(".slots .drop-target").forEach((el) => el.classList.remove("drop-target"));
}

function renderEfStatus() {
  const el = $("efStatus");
  el.className = "ef-status";
  if (!state.ef) {
    el.textContent = "EasyFlash CRT: not read yet";
    el.classList.add("unknown");
  } else if (!state.ef.present) {
    el.textContent = "No EasyFlash CRT installed";
  } else {
    el.textContent = state.ef.name ? `EasyFlash CRT installed: ${state.ef.name}` : "EasyFlash CRT installed (this CRT doesn't store its name)";
    el.classList.add("present");
    if (state.ef.nameFromBrowser) {
      const note = document.createElement("span");
      note.className = "note";
      note.textContent = " · name remembered from when this browser flashed it";
      el.append(note);
    }
    const over = state.ef.overlapping || [];
    if (over.length) {
      const warn = document.createElement("span");
      warn.className = "warn";
      warn.textContent = ` — slot${over.length > 1 ? "s" : ""} ${over.join(", ")} also hold${over.length > 1 ? "" : "s"} a PRG inside the CRT's area, so the CRT may be damaged.`;
      el.append(warn);
    }
  }
}

// One 256-byte flash block, with retries. Retries add the original app's
// NOP padding in case the menu needs more breathing room.
async function readBlock(phys, signal) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    try {
      const reply = waitReply(attempt ? 4000 : 2500);
      await stream(K.buildReadBlock(phys, { safe: attempt > 0 }), { quiet: true, signal });
      const { tag, data } = await reply;
      if (tag !== K.CMD.MEMORY_BLOCK || data.length !== 256) throw new Error(`Unexpected reply (command $${tag.toString(16)}).`);
      return data;
    } catch (err) {
      if (err.name === "AbortError") throw err;
      lastErr = err;
      state.pendingReply = null;
      receiver.reset();
      log(`Read at $${phys.toString(16).toUpperCase()} failed (${err.message}) — retrying…`, "err");
      await sleep(600); // let any late reply drain before asking again
    }
  }
  throw lastErr;
}

// Job-level progress for multi-step reads.
function readProgress(title) {
  const t0 = performance.now();
  showDock(title, 0);
  return (done, total, stage) => {
    const per = done ? (performance.now() - t0) / done : 160;
    paintProgress(done, total, stage, (total - done) * per);
  };
}

function prgInfo(h) {
  return { kind: "prg", name: h.name, length: h.length, emu: h.midiEmulation, c128: h.c128, regs: h.regs };
}

function classify(block) {
  const h = K.parseSlotHeader(block);
  if (h) return prgInfo(h);
  return block.every((x) => x === 0xff) ? { kind: "empty" } : { kind: "data" };
}

async function scanCartridge(signal) {
  const total = K.SLOT_MAX + 3;
  const paint = readProgress("Reading slots");
  const msg = new K.MessageBuilder();
  msg.redraw(); msg.print("reading slots..." + K.NEWLINE);
  await stream(msg, { quiet: true, signal });
  const found = {};
  let n = 0;
  for (let s = K.SLOT_MIN; s <= K.SLOT_MAX; s++) {
    paint(n, total, `Reading slot ${s} of ${K.SLOT_MAX}`);
    found[s] = classify(await readBlock(K.slotAddress(s), signal));
    setSlot(s, found[s]);
    renderSlots();
    n++;
  }
  paint(n, total, "Checking for an EasyFlash CRT");
  const probe = {};
  for (const [key, phys] of Object.entries(K.EF_PROBE_BLOCKS)) {
    probe[key] = await readBlock(phys, signal);
    paint(++n, total, "Checking for an EasyFlash CRT");
  }
  const kinds = Object.fromEntries(Object.entries(found).map(([s, v]) => [s, v.kind]));
  const ef = K.detectEasyFlash(probe, kinds);
  // Many CRTs (e.g. the SID Collection) store no name on the cartridge. If this
  // browser flashed the CRT, reuse the file's name.
  const remembered = store.get("lastCrt", null);
  if (ef.present && !ef.name && remembered?.vectors === hexOf(probe.vectors.subarray(0xe0))) {
    ef.name = remembered.name;
    ef.nameFromBrowser = true;
  }
  state.ef = ef;
  store.set("ef", ef);
  if (ef.present) {
    for (let s = 10; s <= K.SLOT_MAX; s++) if (found[s].kind === "data") setSlot(s, { kind: "ef" });
  }
  const done = new K.MessageBuilder();
  done.print("done");
  await stream(done, { quiet: true, signal });
  renderSlots();
  const used = Object.values(found).filter((v) => v.kind === "prg").length;
  const crt = ef.present ? `EasyFlash CRT ${ef.name ? `“${ef.name}”` : "(unnamed)"} installed` : "no EasyFlash CRT";
  return `Read ${K.SLOT_MAX} slots: ${used} program${used === 1 ? "" : "s"}, ${crt}`;
}

// Read a whole PRG slot (header + body) back from flash.
async function readSlotImage(slot, signal, paint, label = `Reading slot ${slot}`) {
  const header = await readBlock(K.slotAddress(slot), signal);
  const h = K.parseSlotHeader(header);
  if (!h) {
    setSlot(slot, classify(header));
    renderSlots();
    throw new Error(`Slot ${slot} doesn't hold a program.`);
  }
  const blocks = K.slotBlockCount(h);
  const raw = new Uint8Array(blocks * 256);
  raw.set(header, 0);
  for (let i = 1; i < blocks; i++) {
    paint?.(i, blocks, label);
    raw.set(await readBlock(K.slotAddress(slot) + i * 256, signal), i * 256);
  }
  paint?.(blocks, blocks, label);
  setSlot(slot, prgInfo(h));
  return { header: h, raw: raw.subarray(0, 256 + h.length) };
}

async function verifySlot(slot, raw, signal, paint) {
  const blocks = Math.ceil(raw.length / 256);
  for (let i = 0; i < blocks; i++) {
    paint?.(i, blocks, `Verifying slot ${slot}`);
    const got = await readBlock(K.slotAddress(slot) + i * 256, signal);
    const want = raw.subarray(i * 256, i * 256 + 256);
    for (let j = 0; j < want.length; j++) {
      if (got[j] !== want[j]) throw new Error(`Verify failed: slot ${slot} differs at byte ${i * 256 + j}.`);
    }
  }
}

const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const safeName = (s) => s.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_").trim() || "program";
const prgName = (name) => (/\.prg$/i.test(name) ? name : name + ".prg");

function saveBlob(blob, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function rescue(images, why) {
  const files = images.map(({ slot, raw }) => {
    const h = K.parseSlotHeader(raw);
    return { name: `slot${String(slot).padStart(2, "0")}-${safeName(prgName(h.name))}`, data: K.prgFromSlot(raw) };
  });
  saveBlob(K.makeZip(files), "kerberos-rescued-programs.zip");
  log(`${why} Saved ${files.length} program${files.length > 1 ? "s" : ""} the page was holding to kerberos-rescued-programs.zip.`, "err");
}

async function onSlotDrop(from, to) {
  if (!canReorganize()) return;
  const src = state.slots[from];
  const dst = state.slots[to];
  if (src?.kind !== "prg") return;
  const efWarn = isEfSlot(to) && state.ef?.present
    ? " Slots 10–25 hold the installed EasyFlash CRT, so this will damage it."
    : isEfSlot(to) && !state.ef ? " Slots 10–25 share flash with the EasyFlash CRT area." : "";
  let action;
  if (dst?.kind === "prg") {
    action = await choiceBox(
      `Swap slots ${from} and ${to}?`,
      `“${src.name}” goes to slot ${to} and “${dst.name}” goes to slot ${from}. Both are read into the page first and each write is checked before moving on.${efWarn}`,
      [{ value: "swap", label: "Swap", kind: efWarn ? "danger" : "primary" }],
    );
  } else {
    const what = dst?.kind === "ef" ? `EasyFlash data in slot ${to}` : dst?.kind === "data" ? `the unknown data in slot ${to}` : "";
    action = await choiceBox(
      `Move or copy “${src.name}” to slot ${to}?`,
      `Move erases slot ${from} only after the new copy reads back correctly.${what ? ` This overwrites ${what}.` : ""}${efWarn}`,
      [{ value: "copy", label: "Copy", kind: "ghost" }, { value: "move", label: "Move", kind: efWarn ? "danger" : "primary" }],
    );
  }
  if (!action) return;
  if (action === "swap") swapSlots(from, to);
  else copySlot(from, to, action === "move");
}

function copySlot(from, to, move) {
  const verb = move ? "Moving" : "Copying";
  runJob(`${verb} slot ${from} to slot ${to}`, async (signal) => {
    const paint = readProgress(`Reading slot ${from}`);
    const { header, raw } = await readSlotImage(from, signal, paint, `Reading slot ${from}`);
    const target = classify(await readBlock(K.slotAddress(to), signal));
    if (target.kind === "prg") throw new Error(`Slot ${to} now holds “${target.name}”. Nothing was changed; read the slots and try again.`);
    try {
      await stream(K.buildFlashSlotImage(raw, to), { title: `Writing to slot ${to}`, signal });
      await verifySlot(to, raw, signal, readProgress(`Verifying slot ${to}`));
    } catch (err) {
      if (err.name !== "AbortError") setSlot(to, { kind: "data" });
      throw err;
    }
    setSlot(to, prgInfo(header));
    if (isEfSlot(to) && state.ef?.present) markEfOverlap(to);
    if (move) {
      await stream(K.buildDeleteSlot(from), { title: `Erasing slot ${from}`, signal });
      setSlot(from, { kind: "empty" });
      if (state.slot === from) { state.slot = to; store.set("slot", to); }
    }
    renderSlots();
    return `${move ? "Moved" : "Copied"} “${header.name}” from slot ${from} to slot ${to}`;
  });
}

function swapSlots(a, b) {
  runJob(`Swapping slots ${a} and ${b}`, async (signal) => {
    const A = await readSlotImage(a, signal, readProgress(`Reading slot ${a}`), `Reading slot ${a}`);
    const B = await readSlotImage(b, signal, readProgress(`Reading slot ${b}`), `Reading slot ${b}`);
    const held = [{ slot: a, raw: A.raw }, { slot: b, raw: B.raw }];
    try {
      await stream(K.buildFlashSlotImage(A.raw, b), { title: `Writing “${A.header.name}” to slot ${b}`, signal });
      await verifySlot(b, A.raw, signal, readProgress(`Verifying slot ${b}`));
      setSlot(b, prgInfo(A.header));
      await stream(K.buildFlashSlotImage(B.raw, a), { title: `Writing “${B.header.name}” to slot ${a}`, signal });
      await verifySlot(a, B.raw, signal, readProgress(`Verifying slot ${a}`));
      setSlot(a, prgInfo(B.header));
    } catch (err) {
      rescue(held, err.name === "AbortError" ? "Swap cancelled partway." : "Swap failed partway.");
      setSlot(a, { kind: "data" }); setSlot(b, { kind: "data" });
      renderSlots();
      throw err;
    }
    for (const s of [a, b]) if (isEfSlot(s) && state.ef?.present) markEfOverlap(s);
    renderSlots();
    return `Swapped slots ${a} and ${b}`;
  });
}

// Rewrite only the slot's first 4 KB flash sector with a corrected header.
// The sector is held in memory, so a failed write is simply retried.
async function changeSlotEmulation(slot, emu) {
  runJob(`Changing slot ${slot} to ${emuShort(emu)}`, async (signal) => {
    const sectorBlocks = 16;
    const base = K.slotAddress(slot);
    const paint = readProgress(`Reading slot ${slot}`);
    const sector = new Uint8Array(sectorBlocks * 256);
    for (let i = 0; i < sectorBlocks; i++) {
      paint(i, sectorBlocks, `Reading slot ${slot}`);
      sector.set(await readBlock(base + i * 256, signal), i * 256);
      if (i === 0 && !K.parseSlotHeader(sector)) {
        setSlot(slot, classify(sector.subarray(0, 256)));
        renderSlots();
        throw new Error(`Slot ${slot} doesn't hold a program.`);
      }
    }
    const before = K.parseSlotHeader(sector);
    if (before.midiEmulation === emu) return `Slot ${slot} already uses ${emuShort(emu)}`;
    K.setHeaderEmulation(sector, emu);
    let lastErr;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await stream(K.buildFlashSector(sector, base, before.name), { title: `Writing slot ${slot} header`, signal });
        await verifySlot(slot, sector, signal, readProgress(`Verifying slot ${slot}`));
        lastErr = null;
        break;
      } catch (err) {
        if (err.name === "AbortError" && attempt === 1) {
          // Never leave the sector half-written: finish the rewrite even if cancelled.
          log("Finishing the header rewrite so the slot isn't left half-written…", "err");
        } else if (err.name === "AbortError") {
          throw err;
        }
        lastErr = err;
        log(`Header rewrite attempt ${attempt} failed (${err.message}).`, "err");
        signal = undefined;
      }
    }
    if (lastErr) throw new Error(`Couldn't rewrite slot ${slot}'s header. Download the slot or re-flash it from the .prg. (${lastErr.message})`);
    setSlot(slot, prgInfo(K.parseSlotHeader(sector)));
    renderSlots();
    return `Slot ${slot} (“${before.name}”) now uses ${emuShort(emu)} (was ${emuShort(before.midiEmulation)})`;
  });
}

$("changeEmuBtn").onclick = async () => {
  if (!needOut() || !state.input) return;
  const slot = state.slot;
  const info = state.slots[slot];
  const current = info?.kind === "prg" ? info.emu : undefined;
  const choices = K.MIDI_EMULATIONS
    .map((e, i) => ({ value: String(i), label: e.short, kind: i === K.EMU_DATEL ? "primary" : "ghost" }))
    .filter((c) => Number(c.value) !== current);
  const choice = await choiceBox(
    `Change MIDI emulation for slot ${slot}`,
    `${info?.name ? `“${info.name}”` : `Slot ${slot}`} currently uses ${current === undefined ? "an unknown setting (read the slots to see it)" : current >= 0 ? K.MIDI_EMULATIONS[current].label : "a custom setting"}. Only the slot's first 4 KB is rewritten; it takes about 10 seconds.`,
    choices,
  );
  if (choice) changeSlotEmulation(slot, Number(choice));
};

function markEfOverlap(slot) {
  const over = new Set(state.ef.overlapping || []);
  over.add(slot);
  state.ef = { ...state.ef, overlapping: [...over].sort((x, y) => x - y) };
  store.set("ef", state.ef);
}

// --------------------------------------------------------------- actions

function needOut() {
  if (!state.out) { log("Connect MIDI and pick the output going to the Kerberos MIDI in.", "err"); return false; }
  return true;
}
function hexOk() {
  const ok = validateHex($("loadAddr")) & validateHex($("startAddr"));
  if (!ok) { $("startSettings").open = true; log("Load and start addresses must be 1–4 hex digits.", "err"); }
  return !!ok;
}

$("runBtn").onclick = () => {
  if (!needOut() || !hexOk() || state.file?.kind !== "prg") return;
  const { name, bytes } = state.file;
  runJob(`Sending ${name}`, async (signal) => {
    await stream(K.buildUploadAndRun(name, bytes, readOpts()), { title: `Sending ${name}`, signal });
    return `Sent ${name} and started it`;
  });
};

// Names match ignoring case and a trailing .prg ("FATCHIP64" = "fatchip64.prg").
const progKey = (n) => (n || "").trim().toLowerCase().replace(/\.prg$/, "");
const sameProgram = (a, b) => progKey(a) !== "" && progKey(a) === progKey(b);

$("flashPrgBtn").onclick = async () => {
  if (!needOut() || !hexOk() || state.file?.kind !== "prg") return;
  const { name, bytes } = state.file;
  let slot = state.slot;
  // Same program already in another slot (e.g. an older build): offer to
  // replace that one instead of filling the selected slot.
  const dup = Object.entries(state.slots)
    .map(([s, info]) => [Number(s), info])
    .find(([s, info]) => s !== slot && info?.kind === "prg" && sameProgram(info.name, name));
  let replacing = false;
  if (dup) {
    const [ds, info] = dup;
    const target = state.slots[slot];
    const choice = await choiceBox(`${info.name} is already in slot ${ds}`,
      `Replace it in slot ${ds} with this ${name}, or flash it to slot ${slot} as well${target?.kind === "prg" ? ` (overwriting “${target.name}”)` : ""}?`,
      [{ value: "here", label: `Flash to slot ${slot} too`, kind: "ghost" }, { value: "replace", label: `Replace slot ${ds}` }]);
    if (!choice) return;
    if (choice === "replace") { slot = ds; replacing = true; }
  }
  const existing = state.slots[slot];
  if (!replacing && existing?.kind === "prg" && !(await confirmBox(`Replace slot ${slot}?`, `Slot ${slot} currently holds “${existing.name}”. It will be overwritten with ${name}.`, "Replace", true))) return;
  if (isEfSlot(slot) && state.ef?.present !== false) {
    const body = state.ef?.present
      ? `Slots 10–25 hold the installed EasyFlash CRT${state.ef.name ? ` (${state.ef.name})` : ""}. Flashing here will damage it.`
      : "Slots 10–25 share flash with the EasyFlash CRT area. If a CRT is installed, flashing here will damage it.";
    if (!(await confirmBox(`Flash to slot ${slot}?`, body, "Flash anyway", true))) return;
  }
  const opts = readOpts();
  runJob(`Flashing ${name} to slot ${slot}`, async (signal) => {
    await stream(K.buildFlashPrg(name, bytes, slot, opts), { title: `Flashing ${name}`, signal });
    setSlot(slot, prgInfo(K.parseSlotHeader(K.createHeader(name, false, bytes.length - 2, opts))));
    if (isEfSlot(slot) && state.ef?.present) markEfOverlap(slot);
    renderSlots();
    return `Flashed ${name} to slot ${slot}`;
  });
};

$("flashCrtBtn").onclick = async () => {
  if (!needOut() || state.file?.kind !== "crt") return;
  const { name, builder: b, crt } = state.file;
  const eta = fmtDuration(b.length * (Number($("pacingSelect").value) || 1));
  if (!(await confirmBox("Flash EasyFlash CRT?", `This erases the cartridge's upper 1 MB (slots 10–25 and any previous CRT) and writes ${name}. It takes about ${eta}. Keep this tab in front while it runs.`, "Flash CRT", true))) return;
  runJob(`Flashing ${name}`, async (signal) => {
    await stream(b, { title: `Flashing ${name}`, signal });
    for (let s = 10; s <= K.SLOT_MAX; s++) setSlot(s, { kind: "ef" });
    // Remember which CRT this is (keyed by its reset-vector block) for carts with no stored name.
    const vec = crt.image.subarray(0x80000 + 0x1fe0, 0x80000 + 0x2000);
    store.set("lastCrt", { name: crt.efName || crt.cartName || name.replace(/\.crt$/i, ""), vectors: hexOf(vec) });
    state.ef = { present: true, name: crt.efName || crt.cartName || name.replace(/\.crt$/i, ""), overlapping: [] };
    store.set("ef", state.ef);
    renderSlots();
    return `Flashed ${name}`;
  });
};

$("startSlotBtn").onclick = () => {
  if (!needOut()) return;
  const slot = state.slot;
  runJob(`Starting slot ${slot}`, async (signal) => {
    // Start with the settings stored in the slot (as the C64 menu's "S" does),
    // not the page's dropdowns. Read them fresh when MIDI in is available.
    let info = state.slots[slot];
    if (state.input) {
      info = classify(await readBlock(K.slotAddress(slot), signal));
      setSlot(slot, info);
      renderSlots();
      if (info.kind !== "prg") throw new Error(`Slot ${slot} doesn't hold a program.`);
    }
    const regs = info?.kind === "prg" && info.regs ? info.regs : null;
    if (!regs) log(`Couldn't read slot ${slot}'s stored settings, so it starts with the page's settings (${K.MIDI_EMULATIONS[readOpts().midiEmulation].short}).`, "err");
    await stream(K.buildStartSlot(slot, readOpts(), regs), { title: `Starting slot ${slot}`, signal });
    const emu = regs ? emuShort(info.emu) : K.MIDI_EMULATIONS[readOpts().midiEmulation].short;
    return `Started slot ${slot}${info?.name ? ` (“${info.name}”)` : ""} · ${emu}`;
  });
};

$("deleteSlotBtn").onclick = async () => {
  if (!needOut()) return;
  const slot = state.slot;
  const info = state.slots[slot];
  const what = info?.kind === "prg" ? `“${info.name}” in slot ${slot}` : `slot ${slot}`;
  const efNote = isEfSlot(slot) && state.ef?.present ? " This slot is inside the installed EasyFlash CRT, so erasing it will damage the CRT." : "";
  if (!(await confirmBox(`Delete slot ${slot}?`, `This erases ${what}.${efNote}`, "Delete", true))) return;
  runJob(`Deleting slot ${slot}`, async (signal) => {
    await stream(K.buildDeleteSlot(slot), { title: `Deleting slot ${slot}`, signal });
    setSlot(slot, { kind: "empty" });
    if (isEfSlot(slot) && state.ef?.present) markEfOverlap(slot);
    renderSlots();
    return `Deleted slot ${slot}`;
  });
};

$("listSlotsBtn").onclick = () => {
  if (!needOut()) return;
  runJob("Showing slot list on the C64", async (signal) => {
    await stream(K.buildListSlots(), { title: "Slot list", signal });
    return "Slot list shown on the C64";
  });
};

$("basicBtn").onclick = () => {
  if (!needOut()) return;
  runJob("Returning to BASIC", async (signal) => {
    await stream(K.buildBackToBasic(readOpts()), { title: "Back to BASIC", signal });
    return "C64 reset to BASIC";
  });
};

$("readSlotsBtn").onclick = () => {
  if (!needOut() || !state.input) return;
  runJob("Reading slots", scanCartridge);
};

$("downloadSlotBtn").onclick = () => {
  if (!needOut() || !state.input) return;
  const slot = state.slot;
  runJob(`Downloading slot ${slot}`, async (signal) => {
    const { header, raw } = await readSlotImage(slot, signal, readProgress(`Reading slot ${slot}`));
    renderSlots();
    const filename = safeName(prgName(header.name));
    saveBlob(new Blob([K.prgFromSlot(raw)], { type: "application/octet-stream" }), filename);
    return `Downloaded slot ${slot} as ${filename}`;
  });
};

$("downloadAllBtn").onclick = () => {
  if (!needOut() || !state.input) return;
  runJob("Downloading all programs", async (signal) => {
    showDock("Downloading all programs", 0);
    const files = [];
    for (let s = K.SLOT_MIN; s <= K.SLOT_MAX; s++) {
      paintProgress(s - 1, K.SLOT_MAX, `Checking slot ${s}`, 0);
      const header = await readBlock(K.slotAddress(s), signal);
      const info = classify(header);
      if (info.kind !== "prg") {
        if (!(info.kind === "data" && state.slots[s]?.kind === "ef")) setSlot(s, info);
        renderSlots();
        continue;
      }
      const { header: h, raw } = await readSlotImage(s, signal, readProgress(`Reading slot ${s}`), `Reading slot ${s} (“${info.name}”)`);
      files.push({ name: `${String(s).padStart(2, "0")} ${safeName(prgName(h.name))}`, data: K.prgFromSlot(raw) });
      renderSlots();
    }
    if (!files.length) throw new Error("No programs found in slots 1–25.");
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    saveBlob(K.makeZip(files), `kerberos-slots-${stamp}.zip`);
    return `Downloaded ${files.length} program${files.length === 1 ? "" : "s"} as kerberos-slots-${stamp}.zip`;
  });
};

$("pingBtn").onclick = () => {
  if (!needOut() || !state.input) return;
  runJob("Testing connection", async (signal) => {
    const reply = waitReply(4000);
    await stream(K.buildPing(), { title: "Ping", signal });
    const { tag } = await reply;
    if (tag !== K.CMD.PONG) throw new Error(`Unexpected reply (command $${tag.toString(16)}).`);
    return "Connection OK — the cartridge answered";
  });
};

$("cancelBtn").onclick = () => state.abort?.abort();

$("downloadLogBtn").onclick = () => {
  if (!state.lastMessages) return;
  const b = state.lastMessages, hx = (x) => x.toString(16).padStart(2, "0");
  const lines = [];
  for (let o = 0; o < b.length; o += 3) lines.push(`${hx(b[o])} ${hx(b[o + 1])} ${hx(b[o + 2])}`);
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/plain" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "kerberos-midi-log.txt";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$("clearLogBtn").onclick = () => { $("log").innerHTML = ""; };

// -------------------------------------------------------------------- UI

let renderedDragState = null;

function updateUi() {
  const haveOut = !!state.out, haveIn = !!state.input, busy = state.busy;
  const dot = $("statusDot");
  dot.className = "dot" + (haveOut ? " ok" : state.midi ? " warn" : "");
  for (const id of ["runBtn", "flashPrgBtn", "flashCrtBtn", "startSlotBtn", "deleteSlotBtn", "listSlotsBtn", "basicBtn"]) {
    $(id).disabled = busy || !haveOut;
  }
  for (const id of ["pingBtn", "readSlotsBtn", "downloadAllBtn"]) $(id).disabled = busy || !haveOut || !haveIn;
  $("downloadSlotBtn").disabled = busy || !haveOut || !haveIn || state.slots[state.slot]?.kind === "empty";
  $("changeEmuBtn").disabled = busy || !haveOut || !haveIn || (state.slots[state.slot] && state.slots[state.slot].kind !== "prg");
  const needIn = haveOut && !haveIn;
  $("slotsNote").textContent = needIn
    ? "Reading, downloading and drag-to-reorganize need the MIDI in cable (Kerberos MIDI out → computer) selected above."
    : "Drag a program onto another slot to move, copy or swap it. Slots 10–25 share flash with the EasyFlash CRT.";
  if (renderedDragState !== canReorganize()) { renderedDragState = canReorganize(); renderSlots(); }
  $("outSelect").disabled = busy || !state.midi || !state.midi.outputs.size;
  $("inSelect").disabled = busy || !state.midi || !state.midi.inputs.size;
  $("pacingSelect").disabled = busy;
  $("fileInput").disabled = busy;
}

// Library: built-in programs (Fat Chip 64) plus the person's own files.
async function useLibraryItem(item, flash) {
  if (state.busy) return;
  await loadFile(new File([item.bytes], item.name));
  if (state.file?.kind !== "prg" && state.file?.kind !== "crt") return;
  const emu = item.entry?.emu;
  if (emu != null && Number($("emuSelect").value) !== emu) {
    $("emuSelect").value = String(emu);
    saveSettings();
    log(`MIDI emulation set to ${K.MIDI_EMULATIONS[emu].label} for ${item.entry.label || item.name}.`);
  }
  if (!flash) { $("fileCard").scrollIntoView({ behavior: "smooth", block: "nearest" }); return; }
  (state.file.kind === "crt" ? $("flashCrtBtn") : $("flashPrgBtn")).click();
}

function initLibrary() {
  mountLibrary($("library"), {
    kind: "prg",
    accept: ".prg,.crt,.zip,.PRG,.CRT,.ZIP",
    actions: [
      { label: "Load", run: (item) => useLibraryItem(item, false) },
      { label: "Flash", primary: true, run: (item) => useLibraryItem(item, true) },
    ],
    mineHint: "Cynthcart and other programs whose licences don't allow sharing go here. Add your .prg files once (e.g. cynthcart2.0.1_kerberos.prg, cynthcart2.0.1F_kerberos.prg and your custom cynthcart_kerberos.prg from cynthcart-kerberos/bin); this browser keeps them. Adding a newer build of the same file replaces the old one.",
    log,
    busy: () => state.busy,
  });
}

function init() {
  initLibrary();
  for (const [i, e] of K.MIDI_EMULATIONS.entries()) $("emuSelect").append(new Option(e.label, i));
  $("emuSelect").value = store.get("emu", "0");
  $("cartDisks").checked = store.get("cartDisks", false);
  $("pacingSelect").value = store.get("pacing", "1");
  $("emuSelect").onchange = saveSettings;
  $("cartDisks").onchange = saveSettings;
  $("pacingSelect").onchange = () => store.set("pacing", $("pacingSelect").value);
  $("loadAddr").oninput = (e) => validateHex(e.target);
  $("startAddr").oninput = (e) => validateHex(e.target);
  $("outSelect").onchange = selectOut;
  $("inSelect").onchange = selectIn;
  $("connectBtn").onclick = connectMidi;
  $("fileInput").onchange = (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ""; };
  $("dropZone").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("fileInput").click(); } });

  let dragDepth = 0;
  const isFileDrag = (e) => e.dataTransfer?.types?.includes("Files");
  window.addEventListener("dragenter", (e) => { if (!isFileDrag(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); });
  window.addEventListener("dragleave", (e) => { if (!isFileDrag(e)) return; if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("dragover", (e) => { if (isFileDrag(e)) e.preventDefault(); });
  window.addEventListener("drop", (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault(); dragDepth = 0; document.body.classList.remove("dragging");
    const f = e.dataTransfer?.files?.[0];
    if (f) loadFile(f);
  });
  window.addEventListener("beforeunload", (e) => { if (state.busy) { e.preventDefault(); e.returnValue = ""; } });

  renderSlots();
  updateUi();

  if (!navigator.requestMIDIAccess) {
    $("unsupported").hidden = false;
    $("connectBtn").disabled = true;
    log("Web MIDI isn't available in this browser.", "err");
    return;
  }
  if (!window.isSecureContext) log("Web MIDI needs https:// or http://localhost — it won't work from a file:// URL.", "err");
  // Reconnect silently if permission was already granted on an earlier visit.
  navigator.permissions?.query({ name: "midi" }).then((p) => { if (p.state === "granted") connectMidi(); }).catch(() => {});
}

init();
