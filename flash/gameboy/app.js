import * as E from "./ems.js";

// Bump on every change so the page shows which build the browser is running.
const BUILD = "v1.9 · 2026-10-22";
document.getElementById("buildTag").textContent = `Build ${BUILD}`;
console.info("Game Boy Flash build", BUILD);

const $ = (id) => document.getElementById(id);
const pageEls = [...document.querySelectorAll(".page")];
const kb = (n) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(n % (1 << 20) ? 1 : 0)} MB` : `${n >> 10} KB`);
const fmtDuration = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

const state = {
  cart: null,
  demo: false,
  pages: [null, null], // listing per page
  busy: false,
  abort: null,
  menu: null,
  rate: 40 * 1024, // bytes/s estimate, refined from real transfers
};

// -------------------------------------------------------------- log

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
$("clearLogBtn").onclick = () => { $("log").innerHTML = ""; };

// ------------------------------------------------------- progress

function showDock(title) {
  const dock = $("progressDock");
  dock.hidden = false;
  dock.classList.remove("done", "failed");
  $("cancelBtn").hidden = false;
  $("progStage").textContent = title;
  $("progDetail").textContent = "";
  $("progBar").style.width = "0%";
}
function paint(done, total, stage, t0) {
  const pct = total ? Math.min(100, (done / total) * 100) : 0;
  $("progBar").style.width = pct.toFixed(1) + "%";
  if (stage) $("progStage").textContent = stage;
  const elapsed = performance.now() - t0;
  const rate = done > 64 * 1024 && elapsed > 1500 ? done / (elapsed / 1000) : state.rate;
  $("progDetail").textContent = total ? `${Math.floor(pct)}% · ${kb(done)} of ${kb(total)} · ${fmtDuration(((total - done) / rate) * 1000)} left` : "";
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
  dockTimer = setTimeout(() => { if (!state.busy) dock.hidden = true; }, ok ? 4000 : 15000);
}
$("cancelBtn").onclick = () => state.abort?.abort();

// A progress tracker for one job: call track(bytes) as data moves.
function tracker(total, stage) {
  const t0 = performance.now();
  let done = 0, label = stage, last = 0;
  paint(0, total, label, t0);
  return {
    add(n) {
      done += n;
      const now = performance.now();
      if (now - last > 120) { last = now; paint(done, total, label, t0); }
    },
    stage(s) { label = s; paint(done, total, label, t0); },
    finish() {
      const secs = (performance.now() - t0) / 1000;
      if (done > 256 * 1024 && secs > 2 && !state.demo) state.rate = done / secs;
    },
  };
}

// ------------------------------------------------------------ jobs

let wakeLock = null;
async function runJob(title, fn) {
  if (state.busy) return;
  if (!state.cart) { log("Connect the cart first.", "err"); return; }
  state.busy = true;
  state.abort = new AbortController();
  updateUi();
  showDock(title);
  try { wakeLock = await navigator.wakeLock?.request("screen"); } catch {}
  log(title + "…");
  const t0 = performance.now();
  try { await state.cart.resetError?.(); } catch {}
  try {
    const msg = await fn(state.abort.signal);
    if (msg === null) { $("progressDock").hidden = true; log("Cancelled before anything was written."); }
    else {
      finishDock(true, msg || "Done");
      log(`${msg || title + " done"} (${fmtDuration(performance.now() - t0)})`, "ok");
    }
  } catch (err) {
    const cancelled = err.name === "AbortError";
    finishDock(false, cancelled ? "Cancelled" : err.message);
    log(cancelled ? "Cancelled." : err.message, "err");
    console.error(err);
  } finally {
    state.busy = false;
    state.abort = null;
    try { await wakeLock?.release(); } catch {}
    wakeLock = null;
    updateUi();
  }
}

// ---------------------------------------------------------- dialog

// buttons: [{ value, label, kind }]; body: string or array of strings/nodes
function choiceBox(title, body, buttons, { cancelLabel = "Cancel" } = {}) {
  const d = $("confirmDialog");
  $("confirmTitle").textContent = title;
  const b = $("confirmBody");
  b.innerHTML = "";
  for (const part of [].concat(body)) {
    if (part instanceof Node) b.append(part);
    else { const p = document.createElement("p"); p.textContent = part; b.append(p); }
  }
  const row = $("dialogActions");
  row.innerHTML = "";
  if (cancelLabel) {
    const c = document.createElement("button");
    c.value = "cancel"; c.className = "btn ghost"; c.textContent = cancelLabel;
    row.append(c);
  }
  for (const x of buttons) {
    const el = document.createElement("button");
    el.value = x.value;
    el.className = "btn " + (x.kind === "danger" ? "danger-ghost" : x.kind === "ghost" ? "ghost" : "primary");
    el.textContent = x.label;
    row.append(el);
  }
  d.returnValue = "";
  d.showModal();
  row.lastElementChild?.focus();
  return new Promise((resolve) => d.addEventListener("close", () => resolve(d.returnValue === "cancel" ? "" : d.returnValue), { once: true }));
}
const confirmBox = async (title, body, ok, danger = false) =>
  (await choiceBox(title, body, [{ value: "ok", label: ok, kind: danger ? "danger" : "primary" }])) === "ok";
const bullets = (items) => {
  const ul = document.createElement("ul");
  for (const i of items) { const li = document.createElement("li"); li.textContent = i; ul.append(li); }
  return ul;
};

// ------------------------------------------------------- downloads

function saveBlob(data, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: "application/octet-stream" }));
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
const romFilename = (h) => `${(h.title || "rom").replace(/[\/\\:*?"<>|]/g, "_").trim() || "rom"}.${h.enhancements & E.ENH_GBC ? "gbc" : "gb"}`;

// -------------------------------------------------------- connect

async function loadMenu() {
  if (state.menu) return state.menu;
  const r = await fetch("menu.gb");
  if (!r.ok) throw new Error("Couldn't load the menu ROM (menu.gb).");
  state.menu = new Uint8Array(await r.arrayBuffer());
  return state.menu;
}

async function attach(cart, demo = false) {
  state.cart = cart;
  state.demo = demo;
  state.pages = [null, null];
  $("cartStatus").textContent = demo ? "Simulated cart — changes only live in this tab." : `Connected: ${cart.name}`;
  log(demo ? "Using a simulated cart." : `Connected to ${cart.name}.`, "ok");
  if (!demo && cart.describe) log(cart.describe());
  updateUi();
  await refreshAll();
}

$("connectBtn").onclick = async () => {
  try {
    const cart = await E.WebUsbCart.request();
    await attach(cart);
  } catch (err) {
    if (err.name === "NotFoundError") { log("No cart was picked. If Chrome said “No compatible devices found”, click “Show every USB device” below to see what it can find."); return; }
    log(err.message, "err");
    $("cartStatus").textContent = err.message;
  }
};

$("anyDeviceBtn").onclick = async () => {
  if (state.busy) return;
  let device;
  try {
    device = await E.WebUsbCart.requestAnyDevice();
  } catch (err) {
    if (err.name === "NotFoundError") {
      log("Chrome doesn't see any USB devices it can offer to web pages. If the cart isn't listed either, macOS isn't seeing it: try another USB cable (many are charge-only) and plug it straight into the Mac.", "err");
    } else log(err.message, "err");
    return;
  }
  const label = E.WebUsbCart.label(device);
  log(`You picked: ${label}.`);
  if (!E.WebUsbCart.isEms(device)) {
    const ok = await confirmBox("Not the usual EMS cart ID", [
      `${label} isn't the ID ems-flasher looks for (4670:9394).`,
      "If this is your cart, the page can try talking to it anyway. Connecting only reads the ROM headers; nothing is written until you add, delete or restore something.",
    ], "Try it as the cart");
    if (!ok) return;
  }
  try {
    const cart = await E.WebUsbCart.fromDevice(device);
    await attach(cart);
  } catch (err) {
    log(err.message, "err");
    $("cartStatus").textContent = err.message;
  }
};

$("disconnectBtn").onclick = async () => {
  if (state.busy) return;
  await state.cart?.close?.();
  state.cart = null;
  state.pages = [null, null];
  $("cartStatus").textContent = "Disconnected.";
  updateUi();
  renderPages();
};

$("demoBtn").onclick = async () => {
  if (state.busy) return;
  const cart = new E.MemoryCart({ strict: true });
  await attach(cart, true);
};

navigator.usb?.addEventListener("disconnect", (e) => {
  if (state.cart?.device === e.device) {
    state.abort?.abort();
    state.cart = null;
    state.pages = [null, null];
    $("cartStatus").textContent = "The cart was unplugged.";
    log("The cart was unplugged.", "err");
    updateUi();
    renderPages();
  }
});

// ---------------------------------------------------------- pages

// After a failed transfer: clear the USB error state, then show what is
// really on the cart now.
async function rereadAfterError(page) {
  try { await state.cart?.resetError?.(); } catch {}
  try { await readPage(page); } catch (err) {
    // Don't keep showing a list that may no longer be true.
    state.pages[page] = null;
    renderPage(page);
    pageEls[page].querySelector("[data-meta]").textContent = "Couldn't re-read this page after the error. Unplug and replug the cart, then click Connect.";
    log(`Couldn't re-read page ${page + 1}: ${err.message}`, "err");
  }
}

// Update what the page shows from what we just did, without re-reading.
function setPage(page, listing) {
  state.pages[page] = listing;
  renderPage(page);
}
const withoutRom = (listing, offset) => E.describePage(listing.roms.filter((r) => r.offset !== offset));

async function readPage(page, signal) {
  const el = pageEls[page];
  el.classList.add("rereading");
  if (state.busy) $("progStage").textContent = `Re-reading page ${page + 1}`;
  let listing;
  try { listing = await E.listPage(state.cart, page); }
  finally { el.classList.remove("rereading"); }
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  state.pages[page] = listing;
  renderPage(page);
  return listing;
}

async function refreshAll() {
  await runJob("Reading the cart", async (signal) => {
    $("progStage").textContent = "Reading page 1";
    await readPage(0, signal);
    $("progBar").style.width = "50%";
    $("progStage").textContent = "Reading page 2";
    await readPage(1, signal);
    const n = state.pages.reduce((a, p) => a + p.roms.filter((r) => r !== p.menu).length, 0);
    return `Read both pages: ${n} game${n === 1 ? "" : "s"}`;
  });
}

const hueOf = (title) => {
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
};

function renderPages() { renderPage(0); renderPage(1); }

function renderPage(page) {
  const el = pageEls[page];
  const listing = state.pages[page];
  const meta = el.querySelector("[data-meta]");
  const map = el.querySelector("[data-map]");
  const list = el.querySelector("[data-list]");
  map.innerHTML = "";
  list.innerHTML = "";
  if (!listing) {
    meta.textContent = state.cart ? "Reading…" : "Not read yet";
    for (let i = 0; i < 128; i++) map.append(cell(null));
    return;
  }

  const games = listing.roms.filter((r) => r !== listing.menu);
  const parts = [];
  if (listing.menu) parts.push(`Mode: ${E.enhName(listing.enhancements)}`);
  else if (listing.single) parts.push("Single game, no menu — boots straight into it");
  else if (games.length) parts.push("No menu ROM");
  else parts.push("Empty");
  parts.push(`${games.length} game${games.length === 1 ? "" : "s"}`);
  parts.push(`${kb(listing.free)} free`);
  meta.textContent = parts.join(" · ");
  if (listing.incompatible) {
    const w = document.createElement("span");
    w.className = "warn";
    w.textContent = ` · mixed modes: some games don't match this page's ${E.enhName(listing.enhancements)} mode`;
    meta.append(w);
  }
  if (listing.roms.length && !listing.menu && !listing.single) {
    const w = document.createElement("span");
    w.className = "warn";
    w.textContent = " · no menu at bank 0, so only the game at bank 0 (if any) can start";
    meta.append(w);
  }

  // Bank map: 128 cells of 32 KB.
  const owner = new Array(128).fill(null);
  listing.roms.forEach((r, i) => {
    for (let c = r.offset / 32768; c < (r.offset + r.header.romsize) / 32768; c++) owner[c] = i;
  });
  owner.forEach((i, c) => map.append(cell(i === null ? null : listing.roms[i], i, c, listing)));
  map.setAttribute("aria-label", `Bank map of page ${page + 1}: ${kb(listing.used)} used, ${kb(listing.free)} free`);

  listing.roms.forEach((r, i) => list.append(romRow(page, r, i, listing)));
}

function cell(rom, idx, c, listing) {
  const d = document.createElement("div");
  d.className = "cell";
  if (!rom) { d.title = c === undefined ? "" : `Free · bank ${c * 2}`; return d; }
  d.dataset.rom = idx;
  const isMenu = rom === listing.menu;
  d.classList.add(isMenu ? "menu" : "used");
  if (!isMenu) d.style.setProperty("--h", hueOf(rom.header.title));
  const first = rom.offset / 32768 === c;
  if (first) d.classList.add("first");
  d.title = `${isMenu ? "Menu" : rom.header.title} · ${kb(rom.header.romsize)} · bank ${rom.offset / E.BANKSIZE}`;
  d.addEventListener("mouseenter", () => highlight(d.closest(".page"), idx, true));
  d.addEventListener("mouseleave", () => highlight(d.closest(".page"), idx, false));
  return d;
}

function highlight(pageEl, idx, on) {
  pageEl.querySelectorAll(`[data-rom="${idx}"]`).forEach((e) => e.classList.toggle("hl", on));
}

function badge(text, cls = "") {
  const s = document.createElement("span");
  s.className = "badge " + cls;
  s.textContent = text;
  return s;
}

function romRow(page, rom, idx, listing) {
  const li = document.createElement("li");
  li.dataset.rom = idx;
  const isMenu = rom === listing.menu;
  const h = rom.header;
  const sw = document.createElement("span");
  sw.className = "swatch" + (isMenu ? " menu" : "");
  if (!isMenu) sw.style.setProperty("--h", hueOf(h.title));
  const main = document.createElement("div");
  main.className = "rom-main";
  const t = document.createElement("span");
  t.className = "rom-title";
  t.textContent = isMenu ? "Menu" : h.title || "(untitled)";
  const sub = document.createElement("span");
  sub.className = "rom-sub";
  sub.textContent = isMenu ? `${E.MENU_TITLES[h.title]} (${h.title}) · lists this page's games at power-on` : `${kb(h.romsize)} · bank ${rom.offset / E.BANKSIZE} · ${h.cartTypeName}${h.ramKB ? ` · ${h.ramKB} KB save` : ""}`;
  main.append(t, sub);
  const tags = document.createElement("span");
  tags.className = "rom-tags";
  if (!isMenu) {
    if (h.gbcOnly) tags.append(badge("GBC only", "gbc"));
    else if (h.enhancements & E.ENH_GBC) tags.append(badge("GBC", "gbc"));
    if (h.enhancements & E.ENH_SGB) tags.append(badge("SGB", "sgb"));
    if (h.battery) tags.append(badge("saves", "save"));
  }
  li.append(sw, main, tags);
  if (!isMenu) {
    const acts = document.createElement("span");
    acts.className = "rom-acts";
    const mk = (label, title, fn, cls = "") => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "btn ghost tiny " + cls;
      b.textContent = label;
      b.title = title;
      b.setAttribute("aria-label", `${title}: ${h.title}`);
      b.onclick = fn;
      b.disabled = state.busy;
      acts.append(b);
      return b;
    };
    mk("✎", "Rename (change the title the menu shows)", () => renameRom(page, rom));
    mk("↓", "Download this ROM", () => downloadRom(page, rom));
    mk(`→ P${2 - page}`, `Move or copy to page ${2 - page}`, () => transferRom(page, rom, 1 - page));
    mk("✕", "Delete from the cart", () => deleteRom(page, rom), "danger-text");
    li.append(acts);
    li.draggable = !state.busy;
    li.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("application/x-ems-rom", JSON.stringify({ page, offset: rom.offset }));
      e.dataTransfer.effectAllowed = "copyMove";
      li.classList.add("dragging-src");
    });
    li.addEventListener("dragend", () => li.classList.remove("dragging-src"));
  } else {
    li.classList.add("menu-row");
  }
  li.addEventListener("mouseenter", () => highlight(li.closest(".page"), idx, true));
  li.addEventListener("mouseleave", () => highlight(li.closest(".page"), idx, false));
  return li;
}

// -------------------------------------------------------- actions

function describeStep(u) {
  const t = u.rom?.header?.title || "";
  switch (u.cmd) {
    case "writef": return t === E.MENUTITLE ? "Writing the menu" : `Writing ${t}`;
    case "move": return `Moving ${t} to make room`;
    case "read": return `Saving ${t} (shares an erase block)`;
    case "write": return `Restoring ${t}`;
    case "erase": return "Erasing a 128 KB block";
  }
  return "";
}

async function applyPlan(page, plan, signal, title) {
  const totals = E.summarizeUpdates(plan.updates);
  const tr = tracker(totals.bytes, title);
  const res = await E.applyUpdates(state.cart, page, plan.updates, {
    signal,
    onProgress: (n) => tr.add(n),
    onStep: (u) => tr.stage(describeStep(u)),
  });
  tr.finish();
  if (!res.ok) {
    if (res.recovered.length) log(`Recovered ${res.recovered.join(", ")} after the error.`, "ok");
    if (res.rescued.length) {
      for (const r of res.rescued) saveBlob(r.bytes, `rescued-${r.title || "rom"}.gb`);
      log(`Saved ${res.rescued.length} ROM${res.rescued.length > 1 ? "s" : ""} the page was holding (${res.rescued.map((r) => r.title).join(", ")}) as downloads.`, "err");
    }
    if (res.lost.length) log(`These ROMs may be damaged on the cart: ${res.lost.join(", ")}.`, "err");
    await rereadAfterError(page);
    throw res.error;
  }
  return totals;
}

// Plan, confirm and write `files` to `page`. Returns false if the user backed out.
// Plan a menu-page write, asking before mixing console modes.
async function makePlan(listing, files) {
  const menu = await loadMenu();
  let force = false;
  for (;;) {
    try {
      return E.planWrite(listing, files, menu, { force });
    } catch (err) {
      if (err.code === "ENH" && !force) {
        const ok = await confirmBox("Different console modes", [
          err.message,
          "Each menu page runs every game in one mode. A Game Boy Color game on a classic-mode page (or the reverse) usually still runs on an original Game Boy, but may look wrong or not start on a Color or Super Game Boy.",
        ], "Add anyway");
        if (!ok) return null;
        force = true;
        continue;
      }
      throw err;
    }
  }
}

// Games that should stay alone on a page with no menu: LSDJ (by title) and
// anything declaring the full 128 KB of save RAM. Menus have a poor track
// record with LSDJ, and launching from a menu limits the save RAM by header.
const needsOwnPage = (h) => /^LSDJ/i.test(h.title) || h.ramKB >= 128;
const ownPageNote = (names) =>
  `${names} works best alone on a page with no menu. Menus have a poor track record with LSDJ, and launching from a menu limits save RAM based on the game's header, which risks the save. Keep it on its own page (like your page 1).`;

// Titles must be unique on a page (the menu lists games by title). When new
// files clash with each other or with games already on the page, ask for a
// different title for each clashing file and patch only the copy we write.
async function resolveTitles(listing, files) {
  const taken = new Set(listing.roms.map((r) => r.header.title));
  const clashes = [];
  for (const f of files) {
    if (taken.has(f.header.title)) clashes.push(f);
    else taken.add(f.header.title);
  }
  if (!clashes.length) return files;

  const suggest = (f, used) => {
    const max = f.header.enhancements & E.ENH_GBC ? 15 : 16;
    let base = f.name.replace(/\.[^.]+$/, "").replace(/[^\x20-\x7e]/g, "").trim() || f.header.title;
    base = base.slice(0, max);
    let t = base;
    for (let i = 2; used.has(t); i++) { const suffix = ` ${i}`; t = base.slice(0, max - suffix.length) + suffix; }
    return t;
  };
  const used = new Set(taken);
  const inputs = clashes.map((f) => {
    const max = f.header.enhancements & E.ENH_GBC ? 15 : 16;
    const label = document.createElement("label");
    label.className = "field rename-field";
    const span = document.createElement("span");
    span.textContent = `${f.name} — currently “${f.header.title || "(untitled)"}” (up to ${max} characters)`;
    const input = document.createElement("input");
    input.maxLength = max;
    input.spellcheck = false;
    input.autocomplete = "off";
    input.value = suggest(f, used);
    used.add(input.value);
    label.append(span, input);
    return { f, input, label };
  });
  for (;;) {
    const box = document.createElement("div");
    box.append(...inputs.map((x) => x.label));
    const ok = await confirmBox("Same title as another game", [
      `The menu lists games by title, so each one on a page needs its own. Pick a title for ${clashes.length > 1 ? "these copies" : "this copy"}. Only what's written to the cart changes; your file${clashes.length > 1 ? "s stay" : " stays"} as ${clashes.length > 1 ? "they are" : "it is"}.`,
      box,
    ], "Use these titles");
    if (!ok) return null;
    const final = new Set(taken);
    for (const x of inputs) final.delete(x.f.header.title);
    for (const f of files) if (!clashes.includes(f)) final.add(f.header.title);
    for (const r of listing.roms) final.add(r.header.title);
    let problem = null;
    const chosen = new Set();
    for (const x of inputs) {
      const t = x.input.value.replace(/\s+$/, "");
      if (!t) problem = "Titles can't be empty.";
      else if (!/^[\x20-\x7e]+$/.test(t)) problem = "Use plain letters, numbers and punctuation.";
      else if (final.has(t) || chosen.has(t)) problem = `“${t}” is already used on this page.`;
      chosen.add(t);
    }
    if (problem) { log(problem, "err"); continue; }
    return files.map((f) => {
      const x = inputs.find((y) => y.f === f);
      if (!x) return f;
      const bytes = Uint8Array.from(f.bytes);
      E.setHeaderTitle(bytes, x.input.value.replace(/\s+$/, ""));
      return { ...f, bytes, header: E.decodeHeader(bytes), renamedFrom: f.header.title };
    });
  }
}

const fileLine = (f) => `${f.header.title || f.name} — ${kb(f.header.romsize)}${f.name && f.name !== f.header.title ? ` (${f.name}${f.renamedFrom !== undefined ? `, was “${f.renamedFrom || "untitled"}”` : ""})` : ""}`;

// Plan, confirm and write `files` to `page`. Returns false if the user backed out.
async function writeFiles(page, files, signal, { title = null, extraNote = null } = {}) {
  // Plan from what the page already shows (kept up to date by every action);
  // read the cart only if this page hasn't been read yet.
  let listing = state.pages[page];
  if (!listing) {
    $("progStage").textContent = `Reading page ${page + 1}`;
    listing = await readPage(page, signal);
  }
  const games = listing.roms.filter((r) => r !== listing.menu);

  // A page with games but no menu (e.g. LSDJ on its own): replace it, or
  // turn the page into a menu page that keeps what's there.
  if (!listing.menu && games.length) {
    const cur = games.map((r) => r.header.title || "(untitled)").join(", ");
    const one = files.length === 1 ? files[0] : null;
    const special = [...games.map((r) => r.header), ...files.map((f) => f.header)].filter(needsOwnPage).map((h) => h.title);
    const warnMenu = special.length > 0;
    const choice = await choiceBox(`Page ${page + 1} has no menu`, [
      listing.single ? `The cart boots straight into ${cur}.` : `Page ${page + 1} has ${cur} but no menu, so only the game at bank 0 can start.`,
      ...(one ? [one.header.title === cur
        ? `Replace: the new ${cur} (${one.name}) replaces the one on the cart and still boots straight in (no menu).`
        : `Replace: ${one.header.title} takes over the page and boots straight in (no menu). ${cur} ${games.length > 1 ? "are" : "is"} removed.`] : []),
      `Menu page: ${cur} ${games.length > 1 ? "are" : "is"} read into this page, the page is cleared, and everything is written back with a menu so you pick a game at power-on.`,
      ...(warnMenu ? [`⚠ ${ownPageNote([...new Set(special)].join(", "))}`] : []),
    ], warnMenu
      ? [{ value: "menu", label: "Make a menu page anyway", kind: "danger" }, ...(one ? [{ value: "replace", label: "Replace (no menu)" }] : [])]
      : [...(one ? [{ value: "replace", label: "Replace (no menu)", kind: "ghost" }] : []), { value: "menu", label: "Make a menu page" }]);
    if (!choice) return false;
    if (choice === "replace") return writeSingle(page, one, signal);
    return rebuildWithMenu(page, games, files, signal);
  }

  // An empty page and one game: boot straight into it, or start a menu page.
  if (!listing.roms.length && files.length === 1 && files[0].header.romsize < E.PAGESIZE) {
    const f = files[0];
    const special = needsOwnPage(f.header);
    const choice = await choiceBox(`How should page ${page + 1} start?`, [
      `Boot straight into ${f.header.title}: no menu, the game starts at power-on.${special ? " Recommended for this one." : " Good for something like LSDJ that lives on its own page."}`,
      `With a menu: a menu lists the page's games at power-on, and you can add more games later.`,
      ...(special ? [`⚠ ${ownPageNote(f.header.title)}`] : []),
    ], [{ value: "menu", label: special ? "With a menu anyway" : "With a menu", kind: special ? "danger" : "ghost" }, { value: "single", label: "Boot straight in" }]);
    if (!choice) return false;
    if (choice === "single") return writeSingle(page, f, signal);
  }

  const special = files.filter((f) => needsOwnPage(f.header));
  if (special.length) {
    const names = special.map((f) => f.header.title).join(", ");
    const ok = await confirmBox(`Put ${names} behind a menu?`, [
      ownPageNote(names),
      `To give it its own page, add it to an empty page and choose “Boot straight in”, or replace the game on a page that has no menu.`,
    ], "Add behind the menu anyway", true);
    if (!ok) return false;
  }

  files = await resolveTitles(listing, files);
  if (!files) return false;
  const plan = await makePlan(listing, files);
  if (!plan) return false;
  const t = E.summarizeUpdates(plan.updates);
  const notes = [];
  if (plan.menuAdded) notes.push(`The page is empty, so the boot menu is added first (page mode: ${E.enhName(plan.menuAdded.header.enhancements)}).`);
  if (t.moves) notes.push(`${t.moves} game${t.moves > 1 ? "s" : ""} already on the page will be moved to make room.`);
  const preserved = plan.updates.filter((u) => u.cmd === "read").length;
  if (preserved) notes.push(`${preserved} small game${preserved > 1 ? "s" : ""} sharing a 128 KB erase block will be held in memory and rewritten.`);
  notes.push(`About ${kb(t.bytes)} to transfer${state.demo ? "" : ` (≈ ${fmtDuration((t.bytes / state.rate) * 1000)})`}. ${kb(plan.free)} will be left free.`);
  if (extraNote) notes.push(extraNote);
  const go = await confirmBox(title || `Add ${files.length} ROM${files.length > 1 ? "s" : ""} to page ${page + 1}?`, [bullets(files.map(fileLine)), ...notes], `Write to page ${page + 1}`);
  if (!go) return false;
  await applyPlan(page, plan, signal, `Writing page ${page + 1}`);
  setPage(page, E.describePage(plan.result));
  return files; // the files as written (titles may have been changed)
}

// One game, no menu, at bank 0.
async function writeSingle(page, file, signal) {
  const tr = tracker(file.header.romsize, `Writing ${file.header.title}`);
  await E.writeSingleGame(state.cart, page, file, { signal, onProgress: (n) => tr.add(n) });
  tr.finish();
  setPage(page, E.describePage([{ offset: 0, header: file.header }]));
  return [file];
}

// Read the games already on a menu-less page, clear it and write them back
// together with the new files under a menu.
async function rebuildWithMenu(page, games, files, signal) {
  const held = [];
  const total = games.reduce((n, r) => n + r.header.romsize, 0);
  const tr = tracker(total, "Reading the games on the page");
  for (const r of games) {
    tr.stage(`Reading ${r.header.title}`);
    const bytes = await E.readRom(state.cart, page, r.offset, r.header.romsize, { signal, onProgress: (n) => tr.add(n) });
    const header = E.inspectRomFile(r.header.title, bytes);
    held.push({ name: romFilename(header), bytes, header });
  }
  const all = await resolveTitles(E.describePage([]), [...held, ...files]);
  if (!all) return false;
  const plan = await makePlan(E.describePage([]), all);
  if (!plan) return false;
  const t = E.summarizeUpdates(plan.updates);
  const go = await confirmBox(`Make page ${page + 1} a menu page?`, [
    bullets(all.map(fileLine)),
    `Page ${page + 1} is cleared and these are written back with a menu (page mode: ${E.enhName(plan.menuAdded.header.enhancements)}). About ${kb(t.bytes)} to transfer.`,
    "If anything fails, the games that were on the page are saved as downloads.",
  ], `Rebuild page ${page + 1}`);
  if (!go) return false;
  try {
    await E.formatPage(state.cart, page, { signal });
    await applyPlan(page, plan, signal, `Writing page ${page + 1}`);
  } catch (err) {
    for (const h of held) saveBlob(h.bytes, h.name);
    log(`Saved ${held.map((h) => h.name).join(", ")} as downloads because the rebuild didn't finish.`, "err");
    await rereadAfterError(page);
    throw err;
  }
  setPage(page, E.describePage(plan.result));
  return all.slice(held.length);
}

async function filesFromList(fileList) {
  const ok = [], bad = [];
  for (const f of fileList) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    try { ok.push({ name: f.name, bytes, header: E.inspectRomFile(f.name, bytes) }); }
    catch (err) { bad.push(err.message); }
  }
  for (const m of bad) log(m, "err");
  return ok;
}

async function addRoms(page, fileList) {
  if (!state.cart) { log("Connect the cart first.", "err"); return; }
  const files = await filesFromList(fileList);
  if (!files.length) return;
  runJob(`Adding ${files.length} ROM${files.length > 1 ? "s" : ""} to page ${page + 1}`, async (signal) => {
    const done = await writeFiles(page, files, signal);
    if (!done) return null;
    const written = Array.isArray(done) ? done : files;
    return `Added ${written.map((f) => f.header.title).join(", ")} to page ${page + 1}`;
  });
}

function downloadRom(page, rom) {
  runJob(`Downloading ${rom.header.title}`, async (signal) => {
    const tr = tracker(rom.header.romsize, `Reading ${rom.header.title}`);
    const bytes = await E.readRom(state.cart, page, rom.offset, rom.header.romsize, { signal, onProgress: (n) => tr.add(n) });
    tr.finish();
    const name = romFilename(rom.header);
    saveBlob(bytes, name);
    return `Downloaded ${name}`;
  });
}

async function renameRom(page, rom) {
  const listing = state.pages[page];
  const max = rom.header.enhancements & E.ENH_GBC ? 15 : 16;
  const wrap = document.createElement("div");
  const label = document.createElement("label");
  label.className = "field";
  const span = document.createElement("span");
  span.textContent = `New title (up to ${max} characters)`;
  const input = document.createElement("input");
  input.value = rom.header.title;
  input.maxLength = max;
  input.spellcheck = false;
  input.autocomplete = "off";
  label.append(span, input);
  const note = document.createElement("p");
  note.textContent = "This changes the name the menu shows. Only the title and its checksum change; the game itself is untouched.";
  wrap.append(label, note);
  setTimeout(() => { input.focus(); input.select(); }, 30);
  const ok = await confirmBox(`Rename ${rom.header.title || "(untitled)"}`, [wrap], "Rename");
  if (!ok) return;
  const title = input.value.replace(/\s+$/, "");
  if (!title) { log("The title can't be empty.", "err"); return; }
  if (!/^[\x20-\x7e]+$/.test(title)) { log("Use plain letters, numbers and punctuation for the title.", "err"); return; }
  if (title === rom.header.title) return;
  if (listing?.roms.some((r) => r !== rom && r.header.title === title)) { log(`Page ${page + 1} already has a game called “${title}”.`, "err"); return; }
  runJob(`Renaming ${rom.header.title || "(untitled)"} to ${title}`, async (signal) => {
    const tr = tracker(E.ERASEBLOCKSIZE * 2, "Reading the block with its header");
    try {
      const res = await E.renameRom(state.cart, page, rom.offset, title, { signal, onProgress: (n) => tr.add(n) });
      const cur = state.pages[page];
      if (cur) setPage(page, E.describePage(cur.roms.map((r) => (r.offset === rom.offset ? { offset: r.offset, header: res.header } : r))));
    } catch (err) {
      if (err.block) {
        state.pendingBlock = { page, blockStart: err.blockStart, block: err.block, title };
        updateUi();
        const bank = (err.blockStart / E.BANKSIZE) | 0;
        saveBlob(err.block, `ems-page${page + 1}-bank${bank}-block.bin`);
        for (let s = 0; s < err.block.length; s += 32768) {
          const h = E.headerValid(err.block.subarray(s)) ? E.decodeHeader(err.block.subarray(s)) : null;
          if (h && s + h.romsize <= err.block.length) saveBlob(err.block.slice(s, s + h.romsize), romFilename(h));
        }
        log("The rename didn't finish. The 128 KB block (and any whole games in it) were saved as downloads, and the page is holding it: once the cart responds again, click “Finish the interrupted write”.", "err");
      }
      await rereadAfterError(page);
      throw err;
    }
    tr.finish();
    return `Renamed to ${title}`;
  });
}

$("finishBlockBtn").onclick = () => {
  const p = state.pendingBlock;
  if (!p) return;
  runJob(`Finishing the interrupted write on page ${p.page + 1}`, async (signal) => {
    const tr = tracker(E.ERASEBLOCKSIZE, "Rewriting the 128 KB block");
    await E.writeBlockAt(state.cart, p.page, p.blockStart, p.block, { signal, onProgress: (n) => tr.add(n) });
    tr.finish();
    state.pendingBlock = null;
    await readPage(p.page, signal);
    return `Finished the interrupted write on page ${p.page + 1}`;
  });
};

async function deleteRom(page, rom) {
  const ok = await confirmBox(`Delete ${rom.header.title}?`, [
    `It's removed from page ${page + 1}'s menu right away. Its space is reused the next time you add ROMs.`,
  ], "Delete", true);
  if (!ok) return;
  runJob(`Deleting ${rom.header.title}`, async (signal) => {
    await E.deleteRoms(state.cart, page, [rom.offset]);
    if (state.pages[page]) setPage(page, withoutRom(state.pages[page], rom.offset));
    return `Deleted ${rom.header.title} from page ${page + 1}`;
  });
}

async function transferRom(fromPage, rom, toPage) {
  const choice = await choiceBox(`Move or copy ${rom.header.title} to page ${toPage + 1}?`, [
    "The game is read into the page, written to the other page (moving other games there if needed), and — for a move — deleted from this page only after the write succeeds.",
  ], [{ value: "copy", label: "Copy", kind: "ghost" }, { value: "move", label: "Move" }]);
  if (!choice) return;
  const move = choice === "move";
  runJob(`${move ? "Moving" : "Copying"} ${rom.header.title} to page ${toPage + 1}`, async (signal) => {
    const tr = tracker(rom.header.romsize, `Reading ${rom.header.title}`);
    const bytes = await E.readRom(state.cart, fromPage, rom.offset, rom.header.romsize, { signal, onProgress: (n) => tr.add(n) });
    const header = E.inspectRomFile(rom.header.title, bytes);
    const file = { name: romFilename(header), bytes, header };
    const done = await writeFiles(toPage, [file], signal, {
      title: `${move ? "Move" : "Copy"} ${rom.header.title} to page ${toPage + 1}?`,
      extraNote: move ? `Then ${rom.header.title} is deleted from page ${fromPage + 1}.` : null,
    });
    if (!done) return null;
    if (move) {
      await E.deleteRoms(state.cart, fromPage, [rom.offset]);
      if (state.pages[fromPage]) setPage(fromPage, withoutRom(state.pages[fromPage], rom.offset));
    }
    return `${move ? "Moved" : "Copied"} ${rom.header.title} to page ${toPage + 1}`;
  });
}

async function formatPage(page) {
  const listing = state.pages[page];
  const n = listing ? listing.roms.filter((r) => r !== listing.menu).length : 0;
  const ok = await confirmBox(`Format page ${page + 1}?`, [
    `This removes ${n ? `all ${n} game${n > 1 ? "s" : ""} and ` : ""}the menu from page ${page + 1}. The next ROM you add sets the page's mode again.`,
  ], "Format page", true);
  if (!ok) return;
  runJob(`Formatting page ${page + 1}`, async (signal) => {
    await E.formatPage(state.cart, page, { signal });
    setPage(page, E.describePage([]));
    return `Formatted page ${page + 1}`;
  });
}

async function downloadGames(page) {
  const listing = state.pages[page];
  const games = listing ? listing.roms.filter((r) => r !== listing.menu) : [];
  if (!games.length) { log(`Page ${page + 1} has no games to download.`); return; }
  const total = games.reduce((n, r) => n + r.header.romsize, 0);
  const how = await choiceBox(`Download ${games.length} game${games.length > 1 ? "s" : ""} from page ${page + 1}?`, [
    bullets(games.map((r) => `${r.header.title} — ${kb(r.header.romsize)}`)),
    `About ${kb(total)} to read. Separate files arrive as individual downloads (Chrome may ask once to allow multiple downloads); a .zip is one file.`,
  ], [{ value: "separate", label: "Separate files", kind: "ghost" }, { value: "zip", label: "One .zip" }]);
  if (!how) return;
  runJob(`Downloading page ${page + 1}'s games`, async (signal) => {
    const tr = tracker(total, "Reading games");
    const files = [];
    const used = new Set();
    for (const r of games) {
      tr.stage(`Reading ${r.header.title}`);
      const bytes = await E.readRom(state.cart, page, r.offset, r.header.romsize, { signal, onProgress: (n) => tr.add(n) });
      let name = romFilename(r.header);
      for (let i = 2; used.has(name.toLowerCase()); i++) name = name.replace(/(\.\w+)$/, ` (${i})$1`);
      used.add(name.toLowerCase());
      files.push({ name, data: bytes });
      if (how === "separate") { saveBlob(bytes, name); await new Promise((r) => setTimeout(r, 300)); }
    }
    tr.finish();
    if (how === "zip") {
      const zipName = `ems-page${page + 1}-games.zip`;
      saveBlob(E.makeZip(files), zipName);
      return `Saved ${files.length} games as ${zipName}`;
    }
    return `Downloaded ${files.length} games from page ${page + 1}`;
  });
}

function dumpPage(page) {
  runJob(`Downloading page ${page + 1}`, async (signal) => {
    const tr = tracker(E.PAGESIZE, `Reading page ${page + 1}`);
    const bytes = await E.dumpPage(state.cart, page, { signal, onProgress: (n) => tr.add(n) });
    tr.finish();
    saveBlob(bytes, `ems-page${page + 1}.gb`);
    return `Saved page ${page + 1} as ems-page${page + 1}.gb`;
  });
}

async function restorePage(page, file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== E.PAGESIZE) { log(`${file.name} is ${kb(bytes.length)}; a page dump is exactly 4 MB.`, "err"); return; }
  const ok = await confirmBox(`Restore page ${page + 1} from ${file.name}?`, [
    `Everything on page ${page + 1} is replaced with the dump. This rewrites all 4 MB.`,
  ], "Restore page", true);
  if (!ok) return;
  runJob(`Restoring page ${page + 1}`, async (signal) => {
    const tr = tracker(E.PAGESIZE, `Writing page ${page + 1}`);
    await E.restorePage(state.cart, page, bytes, { signal, onProgress: (n) => tr.add(n) });
    tr.finish();
    setPage(page, await E.listPageImage(bytes));
    return `Restored page ${page + 1} from ${file.name}`;
  });
}

$("sramDumpBtn").onclick = () => {
  runJob("Downloading save RAM", async (signal) => {
    const tr = tracker(E.SRAMSIZE, "Reading save RAM");
    const bytes = await E.dumpSram(state.cart, { signal, onProgress: (n) => tr.add(n) });
    tr.finish();
    const d = new Date();
    const name = `ems-save-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.sav`;
    saveBlob(bytes, name);
    return `Saved the save RAM as ${name}`;
  });
};

$("sramRestoreInput").onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > E.SRAMSIZE) { log(`${file.name} is larger than 128 KB.`, "err"); return; }
  const ok = await confirmBox(`Restore save RAM from ${file.name}?`, [
    `The first ${kb(bytes.length)} of the cart's save RAM is replaced. Whatever game saved there last loses its save.`,
  ], "Restore save", true);
  if (!ok) return;
  runJob("Restoring save RAM", async (signal) => {
    const tr = tracker(Math.ceil(bytes.length / 64) * 64, "Writing save RAM");
    await E.restoreSram(state.cart, bytes, { signal, onProgress: (n) => tr.add(n) });
    tr.finish();
    return `Restored the save RAM from ${file.name}`;
  });
};

// Wire up each page card.
pageEls.forEach((el, page) => {
  el.querySelector('input[data-act="add"]').onchange = (e) => { const fl = [...e.target.files]; e.target.value = ""; addRoms(page, fl); };
  el.querySelector('input[data-act="restore"]').onchange = (e) => { const f = e.target.files[0]; e.target.value = ""; el.querySelector("details").open = false; if (f) restorePage(page, f); };
  el.querySelector('button[data-act="dump"]').onclick = () => { el.querySelector("details").open = false; dumpPage(page); };
  el.querySelector('button[data-act="reread"]').onclick = () => runJob(`Re-reading page ${page + 1}`, async (signal) => {
    const l = await readPage(page, signal);
    const n = l.roms.filter((r) => r !== l.menu).length;
    return `Page ${page + 1}: ${n} game${n === 1 ? "" : "s"}, ${kb(l.free)} free`;
  });
  el.querySelector('button[data-act="games"]').onclick = () => { el.querySelector("details").open = false; downloadGames(page); };
  el.querySelector('button[data-act="format"]').onclick = () => { el.querySelector("details").open = false; formatPage(page); };

  let depth = 0;
  const kind = (e) => (e.dataTransfer.types.includes("application/x-ems-rom") ? "rom" : e.dataTransfer.types.includes("Files") ? "file" : null);
  el.addEventListener("dragenter", (e) => { if (!kind(e) || state.busy) return; e.preventDefault(); depth++; el.classList.add("drop-target"); });
  el.addEventListener("dragleave", () => { if (--depth <= 0) { depth = 0; el.classList.remove("drop-target"); } });
  el.addEventListener("dragover", (e) => { if (kind(e) && !state.busy) e.preventDefault(); });
  el.addEventListener("drop", (e) => {
    const k = kind(e);
    if (!k) return;
    e.preventDefault();
    depth = 0;
    el.classList.remove("drop-target");
    if (state.busy) return;
    if (k === "file") { addRoms(page, [...e.dataTransfer.files]); return; }
    const src = JSON.parse(e.dataTransfer.getData("application/x-ems-rom"));
    if (src.page === page) return;
    const rom = state.pages[src.page]?.roms.find((r) => r.offset === src.offset);
    if (rom) transferRom(src.page, rom, page);
  });
});
// Don't let a file dropped outside a page replace the tab.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());
window.addEventListener("beforeunload", (e) => { if (state.busy) { e.preventDefault(); e.returnValue = ""; } });

// ------------------------------------------------------------- UI

function updateUi() {
  const have = !!state.cart, busy = state.busy;
  $("statusDot").className = "dot" + (have ? " ok" : "");
  $("connectBtn").hidden = have;
  $("disconnectBtn").hidden = !have;
  $("disconnectBtn").disabled = busy;
  $("demoBtn").disabled = busy;
  $("finishBlockBtn").hidden = !state.pendingBlock;
  $("finishBlockBtn").disabled = busy || !have;
  $("anyDeviceBtn").disabled = busy || have;
  for (const el of pageEls) {
    el.querySelectorAll("input, button, summary").forEach((b) => { b.disabled = busy || !have; });
    el.querySelectorAll(".file-btn, .menu-more").forEach((b) => b.classList.toggle("disabled", busy || !have));
    el.querySelectorAll(".romlist li").forEach((li) => { if (!li.classList.contains("menu-row")) li.draggable = !busy; });
  }
  $("sramDumpBtn").disabled = busy || !have;
  $("sramRestoreInput").disabled = busy || !have;
  $("sramRestoreLabel").classList.toggle("disabled", busy || !have);
}

async function init() {
  renderPages();
  updateUi();
  if (!navigator.usb) {
    $("unsupported").hidden = false;
    $("connectBtn").disabled = true;
    log("WebUSB isn't available in this browser. The simulated cart still works.", "err");
    return;
  }
  if (!window.isSecureContext) log("WebUSB needs https:// or http://localhost.", "err");
  try {
    const cart = await E.WebUsbCart.reconnect();
    if (cart) await attach(cart);
  } catch (err) {
    log(err.message, "err");
  }
}

init();
