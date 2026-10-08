import * as K from "./protocol.js";

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
  slotNames: store.get("slotNames", {}),
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
async function stream(builder, { title, signal }) {
  const out = state.out;
  if (!out) throw new Error("No MIDI output selected.");
  const bytes = builder.bytes(), marks = builder.marks, n = builder.length;
  const interval = Number($("pacingSelect").value) || 1;
  state.lastMessages = bytes;
  $("downloadLogBtn").disabled = false;
  showDock(title, n * interval);

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
    if (now - lastPaint > 100 || i === n) {
      lastPaint = now;
      paintProgress(i, n, markIdx >= 0 ? marks[markIdx].text : title, (n - i) * interval);
    }
    await sleep(8);
  }
  // Let the OS/interface buffer drain before reporting success.
  await sleep(150);
}

function waitReply(timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pendingReply = null;
      reject(new Error("No reply from the cartridge. Check the MIDI in cable and that the C64 is in the Kerberos menu."));
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

function confirmBox(title, body, okLabel = "OK", danger = false) {
  const d = $("confirmDialog");
  $("confirmTitle").textContent = title;
  $("confirmBody").textContent = body;
  const ok = $("confirmOk");
  ok.textContent = okLabel;
  ok.className = danger ? "btn danger-ghost" : "btn primary";
  d.returnValue = "";
  d.showModal();
  return new Promise((resolve) => d.addEventListener("close", () => resolve(d.returnValue === "ok"), { once: true }));
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

// ----------------------------------------------------------------- slots

function renderSlots() {
  const list = $("slotList");
  list.innerHTML = "";
  for (let s = K.SLOT_MIN; s <= K.SLOT_MAX; s++) {
    const li = document.createElement("li");
    if (s >= 10) li.className = "ef";
    const b = document.createElement("button");
    b.type = "button";
    b.setAttribute("aria-pressed", String(s === state.slot));
    const num = document.createElement("span");
    num.className = "num";
    num.textContent = s;
    const nm = document.createElement("span");
    const known = state.slotNames[s];
    nm.className = "nm" + (known ? "" : " empty");
    nm.textContent = known === undefined ? "—" : known || "empty";
    if (known) b.title = known;
    b.append(num, nm);
    b.onclick = () => { state.slot = s; store.set("slot", s); renderSlots(); updateUi(); };
    li.append(b);
    list.append(li);
  }
  document.querySelectorAll(".slotNum").forEach((el) => (el.textContent = state.slot));
  $("flashSlotLabel").textContent = state.slot;
}

async function readSlotNames(signal) {
  const names = {};
  const one = new K.MessageBuilder();
  one.redraw(); one.nop(); one.print("reading slots..." + K.NEWLINE);
  await stream(one, { title: "Reading slot names", signal });
  for (let s = K.SLOT_MIN; s <= K.SLOT_MAX; s++) {
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    const reply = waitReply(4000);
    await stream(K.buildReadSlotHeader(s), { title: `Reading slot ${s} of ${K.SLOT_MAX}`, signal });
    const { tag, data } = await reply;
    if (tag !== K.CMD.MEMORY_BLOCK || data.length !== 256) throw new Error(`Unexpected reply while reading slot ${s}.`);
    const h = K.parseSlotHeader(data);
    names[s] = h ? h.name || "(unnamed)" : data.every((x) => x === 0xff) ? "" : "(other data)";
    state.slotNames = { ...state.slotNames, [s]: names[s] };
    renderSlots();
  }
  const done = new K.MessageBuilder();
  done.print("done");
  await stream(done, { title: "Finishing", signal });
  store.set("slotNames", state.slotNames);
  const used = Object.values(names).filter(Boolean).length;
  return `Read ${K.SLOT_MAX} slots (${used} in use)`;
}

function rememberSlot(slot, name) {
  state.slotNames = { ...state.slotNames, [slot]: name };
  store.set("slotNames", state.slotNames);
  renderSlots();
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

$("flashPrgBtn").onclick = async () => {
  if (!needOut() || !hexOk() || state.file?.kind !== "prg") return;
  const { name, bytes } = state.file;
  const slot = state.slot;
  const existing = state.slotNames[slot];
  if (existing && !(await confirmBox(`Replace slot ${slot}?`, `Slot ${slot} currently holds “${existing}”. It will be overwritten with ${name}.`, "Replace", true))) return;
  if (slot >= 10 && !(await confirmBox(`Flash to slot ${slot}?`, "Slots 10–25 share flash with the EasyFlash image. Flashing here will damage an installed CRT.", "Flash anyway", true))) return;
  runJob(`Flashing ${name} to slot ${slot}`, async (signal) => {
    await stream(K.buildFlashPrg(name, bytes, slot, readOpts()), { title: `Flashing ${name}`, signal });
    rememberSlot(slot, name);
    return `Flashed ${name} to slot ${slot}`;
  });
};

$("flashCrtBtn").onclick = async () => {
  if (!needOut() || state.file?.kind !== "crt") return;
  const { name, builder: b } = state.file;
  const eta = fmtDuration(b.length * (Number($("pacingSelect").value) || 1));
  if (!(await confirmBox("Flash EasyFlash CRT?", `This erases the cartridge's upper 1 MB (slots 10–25 and any previous CRT) and writes ${name}. It takes about ${eta}. Keep this tab in front while it runs.`, "Flash CRT", true))) return;
  runJob(`Flashing ${name}`, async (signal) => {
    await stream(b, { title: `Flashing ${name}`, signal });
    const names = { ...state.slotNames };
    for (let s = 10; s <= K.SLOT_MAX; s++) delete names[s];
    state.slotNames = names;
    store.set("slotNames", names);
    renderSlots();
    return `Flashed ${name}`;
  });
};

$("startSlotBtn").onclick = () => {
  if (!needOut()) return;
  const slot = state.slot;
  runJob(`Starting slot ${slot}`, async (signal) => {
    await stream(K.buildStartSlot(slot, readOpts()), { title: `Starting slot ${slot}`, signal });
    return `Started slot ${slot}`;
  });
};

$("deleteSlotBtn").onclick = async () => {
  if (!needOut()) return;
  const slot = state.slot;
  const what = state.slotNames[slot] ? `“${state.slotNames[slot]}” in slot ${slot}` : `slot ${slot}`;
  if (!(await confirmBox(`Delete slot ${slot}?`, `This erases ${what}.`, "Delete", true))) return;
  runJob(`Deleting slot ${slot}`, async (signal) => {
    await stream(K.buildDeleteSlot(slot), { title: `Deleting slot ${slot}`, signal });
    rememberSlot(slot, "");
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
  runJob("Reading slot names", readSlotNames);
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

function updateUi() {
  const haveOut = !!state.out, haveIn = !!state.input, busy = state.busy;
  const dot = $("statusDot");
  dot.className = "dot" + (haveOut ? " ok" : state.midi ? " warn" : "");
  for (const id of ["runBtn", "flashPrgBtn", "flashCrtBtn", "startSlotBtn", "deleteSlotBtn", "listSlotsBtn", "basicBtn"]) {
    $(id).disabled = busy || !haveOut;
  }
  for (const id of ["pingBtn", "readSlotsBtn"]) $(id).disabled = busy || !haveOut || !haveIn;
  $("outSelect").disabled = busy || !state.midi || !state.midi.outputs.size;
  $("inSelect").disabled = busy || !state.midi || !state.midi.inputs.size;
  $("pacingSelect").disabled = busy;
  $("fileInput").disabled = busy;
}

function init() {
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
  window.addEventListener("dragenter", (e) => { e.preventDefault(); dragDepth++; document.body.classList.add("dragging"); });
  window.addEventListener("dragleave", () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove("dragging"); } });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
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
