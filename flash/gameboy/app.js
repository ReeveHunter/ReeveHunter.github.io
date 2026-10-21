import * as E from "./ems.js";

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

async function readPage(page, signal) {
  const listing = await E.listPage(state.cart, page);
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
    await readPage(page).catch(() => {});
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

const fileLine = (f) => `${f.header.title || f.name} — ${kb(f.header.romsize)}${f.name && f.name !== f.header.title ? ` (${f.name})` : ""}`;

// Plan, confirm and write `files` to `page`. Returns false if the user backed out.
async function writeFiles(page, files, signal, { title = null, extraNote = null } = {}) {
  $("progStage").textContent = `Reading page ${page + 1}`;
  const listing = await readPage(page, signal);
  const games = listing.roms.filter((r) => r !== listing.menu);

  // A page with games but no menu (e.g. LSDJ on its own): replace it, or
  // turn the page into a menu page that keeps what's there.
  if (!listing.menu && games.length) {
    const cur = games.map((r) => r.header.title || "(untitled)").join(", ");
    const one = files.length === 1 ? files[0] : null;
    const choice = await choiceBox(`Page ${page + 1} has no menu`, [
      listing.single ? `The cart boots straight into ${cur}.` : `Page ${page + 1} has ${cur} but no menu, so only the game at bank 0 can start.`,
      ...(one ? [one.header.title === cur
        ? `Replace: the new ${cur} (${one.name}) replaces the one on the cart and still boots straight in (no menu).`
        : `Replace: ${one.header.title} takes over the page and boots straight in (no menu). ${cur} ${games.length > 1 ? "are" : "is"} removed.`] : []),
      `Menu page: ${cur} ${games.length > 1 ? "are" : "is"} read into this page, the page is cleared, and everything is written back with a menu so you pick a game at power-on.`,
    ], [
      ...(one ? [{ value: "replace", label: "Replace (no menu)", kind: "ghost" }] : []),
      { value: "menu", label: "Make a menu page" },
    ]);
    if (!choice) return false;
    if (choice === "replace") return writeSingle(page, one, signal);
    return rebuildWithMenu(page, games, files, signal);
  }

  // An empty page and one game: boot straight into it, or start a menu page.
  if (!listing.roms.length && files.length === 1 && files[0].header.romsize < E.PAGESIZE) {
    const f = files[0];
    const choice = await choiceBox(`How should page ${page + 1} start?`, [
      `Boot straight into ${f.header.title}: no menu, the game starts at power-on. Good for something like LSDJ that lives on its own page.`,
      `With a menu: a menu lists the page's games at power-on, and you can add more games later.`,
    ], [{ value: "menu", label: "With a menu", kind: "ghost" }, { value: "single", label: "Boot straight in" }]);
    if (!choice) return false;
    if (choice === "single") return writeSingle(page, f, signal);
  }

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
  await readPage(page, signal);
  return true;
}

// One game, no menu, at bank 0.
async function writeSingle(page, file, signal) {
  const tr = tracker(file.header.romsize, `Writing ${file.header.title}`);
  await E.writeSingleGame(state.cart, page, file, { signal, onProgress: (n) => tr.add(n) });
  tr.finish();
  await readPage(page, signal);
  return true;
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
  const all = [...held, ...files];
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
    await readPage(page).catch(() => {});
    throw err;
  }
  await readPage(page, signal);
  return true;
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
    return `Added ${files.map((f) => f.header.title).join(", ")} to page ${page + 1}`;
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

async function deleteRom(page, rom) {
  const ok = await confirmBox(`Delete ${rom.header.title}?`, [
    `It's removed from page ${page + 1}'s menu right away. Its space is reused the next time you add ROMs.`,
  ], "Delete", true);
  if (!ok) return;
  runJob(`Deleting ${rom.header.title}`, async (signal) => {
    await E.deleteRoms(state.cart, page, [rom.offset]);
    await readPage(page, signal);
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
      await readPage(fromPage, signal);
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
    await readPage(page, signal);
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
    await readPage(page, signal);
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
