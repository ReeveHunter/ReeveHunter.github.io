// Shared program library for the flash tools.
//
// Built-in entries come from manifest.json (files committed next to it, with
// versions for the Fat Chip builds in builds.json, written by publish.sh).
// "My files" are programs that can't be hosted publicly (LSDj, Cynthcart):
// the person adds their own copy once and this browser keeps it in IndexedDB.
// Both tools live on the same site, so they share one store.

const BASE = new URL("./", import.meta.url);
const DB_NAME = "flash-library";
const STORE = "files";

// Known programs people add themselves. Adding a file from the same family
// replaces the copy already stored, so a new build just gets added again.
const FAMILIES = [
  { key: "lsdj", kind: "gb", test: /^lsdj/i, label: "LSDj", note: "Little Sound Dj. Best alone on a page with no menu." },
  { key: "cynthcart-fixes", kind: "prg", test: /^cynthcart2\.0\.1f_kerberos/i, label: "Cynthcart 2.0.1F (bug fixes)", version: "2.0.1F", emu: 3 },
  { key: "cynthcart-stock", kind: "prg", test: /^cynthcart2\.0\.1_kerberos/i, label: "Cynthcart 2.0.1 (stock)", version: "2.0.1", emu: 3 },
  { key: "cynthcart-custom", kind: "prg", test: /^cynthcart_kerberos/i, label: "Cynthcart (custom build)", emu: 3, dated: true },
  { key: null, kind: "prg", test: /^cynthcart/i, label: null, emu: 3 },
];

export const kindOf = (name) => (/\.(gb|gbc|sgb)$/i.test(name) ? "gb" : /\.(prg|crt)$/i.test(name) ? "prg" : null);

export function identify(name) {
  const kind = kindOf(name);
  const fam = FAMILIES.find((f) => f.kind === kind && f.test.test(name)) || {};
  const stem = name.replace(/\.[^.]+$/, "");
  let version = fam.version || null;
  if (!version && !fam.dated) {
    const m = stem.match(/v?(\d+(?:[._-]\d+)+[a-z]?)(?!.*\d)/i);
    if (m) version = m[1].replace(/[_-]/g, ".");
  }
  return {
    key: fam.key || `file:${kind}:${name.toLowerCase()}`,
    kind,
    label: fam.label || stem,
    version,
    note: fam.note || null,
    emu: fam.emu ?? null,
    dated: !!fam.dated,
  };
}

// ------------------------------------------------------------- IndexedDB

let dbPromise = null;
function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "key" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("The file store is busy in another tab."));
    }).catch((e) => { dbPromise = null; throw e; });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("Storage was refused."));
  });
}

export async function listMine(kind) {
  const all = await tx("readonly", (s) => s.getAll());
  return all.filter((r) => !kind || r.kind === kind).sort((a, b) => a.label.localeCompare(b.label));
}

export async function addMine(file) {
  const id = identify(file.name);
  if (!id.kind) throw new Error(`${file.name}: not a program file this library knows.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const rec = { ...id, name: file.name, bytes, fileDate: file.lastModified || Date.now(), added: Date.now() };
  const prev = await tx("readonly", (s) => s.get(rec.key));
  await tx("readwrite", (s) => s.put(rec));
  return { rec, replaced: prev || null };
}

export const removeMine = (key) => tx("readwrite", (s) => s.delete(key));

// --------------------------------------------------------------- manifest

export async function loadBuiltIns(kind) {
  const get = async (p) => {
    const r = await fetch(new URL(p, BASE), { cache: "no-cache" });
    if (!r.ok) throw new Error(`${p}: ${r.status}`);
    return r.json();
  };
  const manifest = await get("manifest.json");
  const builds = await get("builds.json").catch(() => ({}));
  const entries = manifest.entries
    .filter((e) => !kind || e.kind === kind)
    .map((e) => ({ ...e, ...(builds[e.id] || {}), url: new URL(e.file, BASE).href, from: "site" }));
  // Entries with a GitHub repo use the newest build pushed there; the copy on
  // this site is only the fallback (repo private or unreachable, rate limit).
  await Promise.all(entries.filter((e) => e.github).map(async (e) => {
    try { Object.assign(e, await latestFromGitHub(e.github)); }
    catch (err) { e.fallbackWhy = err.message; }
  }));
  return entries;
}

// Newest commit that changed the build file: its version (from the commit
// message, e.g. "v0.07: ..."), date, and a raw URL pinned to that commit so
// no cache can serve an older build.
async function latestFromGitHub({ repo, path }) {
  const api = `https://api.github.com/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=10`;
  const r = await fetch(api, { headers: { Accept: "application/vnd.github+json" } });
  if (!r.ok) throw new Error(r.status === 404 ? `${repo} isn't public on GitHub` : `GitHub said ${r.status}`);
  const commits = await r.json();
  if (!commits.length) throw new Error(`${path} isn't in ${repo} yet`);
  const newest = commits[0];
  const withVer = commits.find((c) => /v\d+(\.\d+)+/.test(c.commit.message));
  const ver = withVer ? withVer.commit.message.match(/v\d+(\.\d+)+/)[0] : null;
  return {
    version: ver,
    date: (newest.commit.committer?.date || newest.commit.author?.date || "").slice(0, 10),
    commit: newest.sha.slice(0, 7),
    url: `https://raw.githubusercontent.com/${repo}/${newest.sha}/${path}`,
    from: "github",
    link: `https://github.com/${repo}`,
  };
}

export async function fetchBuiltIn(entry) {
  const r = await fetch(entry.url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`Couldn't download ${entry.name} (${r.status}).`);
  return new Uint8Array(await r.arrayBuffer());
}

// --------------------------------------------------------------------- UI

const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const vtext = (v) => (v ? (/^v/i.test(v) ? v : `v${v}`) : "");

// Render a library panel into `root`.
//   kind:    "gb" or "prg"
//   actions: [{ label, primary?, run(item) }] — buttons on every entry; `item`
//            is { name, bytes, entry } with entry.emu etc. when known.
//   accept:  file input accept string for "Add my files…"
//   mineHint: text shown under My files while it's empty
//   log(text, cls): where to report problems
export function mountLibrary(root, { kind, actions, accept, mineHint, log = console.log, busy = () => false }) {
  root.classList.add("lib");
  root.innerHTML = "";
  const builtList = el("ul", "lib-list");
  const mineHead = el("div", "lib-subhead");
  const mineTitle = el("h3", null, "My files");
  const addLabel = el("label", "btn small ghost file-btn", "Add my files…");
  const input = el("input");
  input.type = "file"; input.multiple = true; input.accept = accept; input.hidden = true;
  addLabel.append(input);
  mineHead.append(mineTitle, addLabel);
  const mineList = el("ul", "lib-list");
  const mineNote = el("p", "hint lib-hint", mineHint);
  root.append(builtList, mineHead, mineList, mineNote);

  const row = (item, { src, onRemove }) => {
    const li = el("li", "lib-item");
    const main = el("div", "lib-main");
    const top = el("div", "lib-top");
    top.append(el("strong", null, item.label));
    if (item.version) top.append(el("span", "lib-ver", vtext(item.version)));
    if (item.date) top.append(el("span", "lib-date", item.date));
    if (item.dated && item.fileDate) top.append(el("span", "lib-date", `built ${fmtDate(item.fileDate)}`));
    top.append(el("span", `lib-src ${src}`, src === "mine" ? "my file" : item.from === "github" ? "from GitHub" : "built in"));
    main.append(top);
    const sub = el("p", "lib-note");
    if (item.note) sub.append(item.note + " ");
    if (item.fallbackWhy) sub.append(el("span", "lib-file", `Using the copy on this site (${item.fallbackWhy}).`));
    if (item.link) { const a = el("a", null, "Source"); a.href = item.link; a.target = "_blank"; a.rel = "noopener"; sub.append(a); }
    if (src === "mine") sub.append(el("span", "lib-file", `${item.name} · ${(item.bytes.length / 1024).toFixed(item.bytes.length < 10240 ? 1 : 0)} KB · added ${fmtDate(item.added)}`));
    if (sub.childNodes.length) main.append(sub);
    const acts = el("div", "lib-acts");
    for (const a of actions) {
      const b = el("button", `btn small${a.primary ? " primary" : ""}`, a.label);
      b.type = "button";
      b.onclick = async () => {
        if (busy()) return;
        try { await a.run(await item.load()); }
        catch (e) { log(e.message || String(e), "err"); }
      };
      acts.append(b);
    }
    if (onRemove) {
      const x = el("button", "btn small ghost lib-remove", "✕");
      x.type = "button"; x.title = `Remove ${item.label} from this browser`; x.setAttribute("aria-label", x.title);
      x.onclick = onRemove;
      acts.append(x);
    }
    li.append(main, acts);
    return li;
  };

  async function renderBuilt() {
    builtList.innerHTML = "";
    let entries;
    try { entries = await loadBuiltIns(kind); }
    catch (e) { builtList.append(el("li", "lib-empty", "The built-in library couldn't be loaded.")); log(`Library: ${e.message}`, "err"); return; }
    for (const e of entries) {
      const item = { ...e, label: e.name };
      item.load = async () => ({ name: e.file.split("/").pop(), bytes: await fetchBuiltIn(e), entry: item });
      builtList.append(row(item, { src: "built" }));
    }
  }

  async function renderMine() {
    mineList.innerHTML = "";
    let recs;
    try { recs = await listMine(kind); }
    catch (e) {
      mineList.append(el("li", "lib-empty", "This browser can't keep files here (private window or storage turned off)."));
      addLabel.hidden = true;
      return;
    }
    mineNote.hidden = recs.length > 0;
    for (const r of recs) {
      const item = { ...r, load: async () => ({ name: r.name, bytes: r.bytes, entry: r }) };
      mineList.append(row(item, {
        src: "mine",
        onRemove: async () => {
          if (busy()) return;
          await removeMine(r.key);
          log(`Removed ${r.label} from this browser's library.`);
          renderMine();
        },
      }));
    }
  }

  input.onchange = async () => {
    const files = [...input.files];
    input.value = "";
    for (const f of files) {
      try {
        if (kindOf(f.name) !== kind) { log(`${f.name}: not a ${kind === "gb" ? "Game Boy ROM" : "C64 program"}.`, "err"); continue; }
        const { rec, replaced } = await addMine(f);
        log(replaced ? `Updated ${rec.label} in your library (${replaced.name} → ${rec.name}).` : `Added ${rec.label} to your library.`, "ok");
      } catch (e) { log(e.message || String(e), "err"); }
    }
    renderMine();
  };

  renderBuilt();
  renderMine();
  return { refresh: () => { renderBuilt(); renderMine(); } };
}
