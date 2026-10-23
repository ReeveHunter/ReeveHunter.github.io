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
    .map((e) => ({
      ...e, ...(builds[e.id] || {}),
      url: e.file ? new URL(e.file, BASE).href : null,
      fileName: e.file ? e.file.split("/").pop() : null,
      from: e.file ? "site" : null,
    }));
  // Entries with a GitHub repo (or the LSDj site) use the newest build there;
  // the copy on this site, if any, is only the fallback.
  await Promise.all(entries.map(async (e) => {
    try {
      if (e.github) Object.assign(e, await latestFromGitHub(e.github));
      else if (e.lsdj) Object.assign(e, await latestLsdj(e.lsdj));
    } catch (err) { e.fallbackWhy = err.message; }
  }));
  return entries;
}

// GitHub API with conditional requests: an unchanged answer (304) doesn't
// count against GitHub's 60-lookups-an-hour limit for pages without a login.
async function gh(path) {
  const url = `https://api.github.com${path}`;
  const key = `flash-lib:gh:${url}`;
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(key) || "null"); } catch {}
  const headers = { Accept: "application/vnd.github+json" };
  if (cached?.etag) headers["If-None-Match"] = cached.etag;
  let r;
  try { r = await fetch(url, { headers, cache: "no-store" }); }
  catch (e) { if (cached) return cached.body; throw new Error("GitHub couldn't be reached"); }
  if (r.status === 304 && cached) return cached.body;
  if (!r.ok) {
    if (cached && r.status === 403) return cached.body; // rate-limited: last answer
    throw new Error(r.status === 404 ? `${path.split("/").slice(2, 4).join("/")} isn't public on GitHub` : r.status === 403 ? "GitHub's hourly lookup limit was reached" : `GitHub said ${r.status}`);
  }
  const body = await r.json();
  try { localStorage.setItem(key, JSON.stringify({ etag: r.headers.get("ETag"), body })); } catch {}
  return body;
}

const verOf = (text) => text.match(/v?\d+(?:[._]\d+)+[a-z0-9-]*/i)?.[0] || null;
const cmpVer = (a, b) => {
  const pa = a.match(/\d+/g).map(Number), pb = b.match(/\d+/g).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
};

// Either { repo, path }: the newest commit that changed that file (version
// from the commit message, e.g. "v0.07: ..."), or { repo, dir, pattern }: the
// highest-versioned file matching `pattern` in `dir` (version from its name).
// Raw URLs are pinned to the commit so no cache can serve an older build.
async function latestFromGitHub({ repo, path, dir = "", pattern }) {
  if (path) {
    const commits = await gh(`/repos/${repo}/commits?path=${encodeURIComponent(path)}&per_page=10`);
    if (!commits.length) throw new Error(`${path} isn't in ${repo} yet`);
    const newest = commits[0];
    const withVer = commits.find((c) => /v\d+(\.\d+)+/.test(c.commit.message));
    return {
      version: withVer ? withVer.commit.message.match(/v\d+(\.\d+)+/)[0] : null,
      date: (newest.commit.committer?.date || newest.commit.author?.date || "").slice(0, 10),
      url: `https://raw.githubusercontent.com/${repo}/${newest.sha}/${path}`,
      fileName: path.split("/").pop(),
      from: "github",
      link: `https://github.com/${repo}`,
    };
  }
  const head = await gh(`/repos/${repo}/commits?per_page=1`);
  const sha = head[0].sha;
  const list = await gh(`/repos/${repo}/contents${dir ? `/${dir}` : ""}?ref=${sha}`);
  const re = new RegExp(pattern, "i");
  const files = list.filter((f) => f.type === "file" && re.test(f.name) && /\d/.test(f.name));
  if (!files.length) throw new Error(`no build found in ${repo}`);
  files.sort((a, b) => cmpVer(b.name, a.name));
  const f = files[0];
  return {
    version: verOf(f.name.replace(/\.[^.]+$/, ""))?.replace(/_/g, ".") || f.name.match(/v(\d+)/i)?.[1] || null,
    date: (head[0].commit.committer?.date || "").slice(0, 10),
    url: `https://raw.githubusercontent.com/${repo}/${sha}/${f.path}`,
    fileName: f.name,
    from: "github",
    link: `https://github.com/${repo}`,
  };
}

// LSDj from littlesounddj.com's public download folders: the newest
// lsdjX_Y_Z(-stable).zip, unzipped in the browser. Nothing is hosted here.
const LSDJ_ROOT = "https://www.littlesounddj.com/lsd/latest/rom_images/";
async function latestLsdj({ channel }) {
  const folder = `${LSDJ_ROOT}${channel}/`;
  let html;
  try {
    const r = await fetch(folder, { cache: "no-cache" });
    if (!r.ok) throw new Error(`littlesounddj.com said ${r.status}`);
    html = await r.text();
  } catch (e) {
    throw new Error(/said/.test(e.message) ? e.message : "littlesounddj.com doesn't let other sites download from it");
  }
  const names = [...html.matchAll(/href="(lsdj\d+_\d+_[0-9a-z]+(?:-stable)?\.zip)"/gi)].map((m) => m[1]);
  if (!names.length) throw new Error("no LSDj builds found on littlesounddj.com");
  names.sort((a, b) => cmpVer(b, a));
  const name = names[0];
  const v = name.match(/lsdj(\d+)_(\d+)_([0-9a-z]+)/i);
  return { version: `${v[1]}.${v[2]}.${v[3]}`, url: folder + name, zip: true, fileName: name.replace(/\.zip$/i, ".gb"), from: "lsdj", link: folder };
}

export async function fetchBuiltIn(entry) {
  if (!entry.url) throw new Error(`${entry.name} isn't available right now${entry.fallbackWhy ? ` (${entry.fallbackWhy})` : ""}.`);
  const r = await fetch(entry.url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`Couldn't download ${entry.name} (${r.status}).`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (!entry.zip) return { bytes, name: entry.fileName };
  return unzipRom(bytes, entry.kind);
}

// Pull the program out of a .zip (stored or deflated entries).
export async function unzipRom(zip, kind) {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("That .zip couldn't be read.");
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const want = kind === "prg" ? /\.(prg|crt)$/i : /\.(gb|gbc)$/i;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + elen + clen;
    const base = name.split("/").pop();
    if (!want.test(base) || base.startsWith("._")) continue;
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = zip.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = data.slice();
    else if (method === 8) bytes = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    else throw new Error(`${base}: unsupported zip compression.`);
    if (bytes.length !== usize) throw new Error(`${base}: the zip looks damaged.`);
    return { bytes, name: base };
  }
  throw new Error(`No ${kind === "prg" ? ".prg" : ".gb"} file in that .zip.`);
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
    top.append(el("span", `lib-src ${src}`, src === "mine" ? "my file" : { github: "from GitHub", lsdj: "from littlesounddj.com", site: "built in" }[item.from] || "unavailable"));
    main.append(top);
    const sub = el("p", "lib-note");
    if (item.note) sub.append(item.note + " ");
    if (item.fallbackWhy) sub.append(el("span", "lib-file", item.url ? `Using the copy on this site (${item.fallbackWhy}).` : `Can't fetch it here: ${item.fallbackWhy}. Download it from the link and add the .zip under My files.`));
    if (item.link) { const a = el("a", null, item.from === "lsdj" || item.lsdj ? "Download page" : "Source"); a.href = item.link; a.target = "_blank"; a.rel = "noopener"; sub.append(a); }
    if (src === "mine") sub.append(el("span", "lib-file", `${item.name} · ${(item.bytes.length / 1024).toFixed(item.bytes.length < 10240 ? 1 : 0)} KB · added ${fmtDate(item.added)}`));
    if (sub.childNodes.length) main.append(sub);
    const acts = el("div", "lib-acts");
    for (const a of actions) {
      const b = el("button", `btn small${a.primary ? " primary" : ""}`, a.label);
      b.type = "button";
      if (src !== "mine" && !item.url) b.disabled = true;
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
      item.load = async () => ({ ...(await fetchBuiltIn(e)), entry: item });
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
    for (let f of files) {
      try {
        if (/\.zip$/i.test(f.name)) {
          const { bytes, name } = await unzipRom(new Uint8Array(await f.arrayBuffer()), kind);
          f = new File([bytes], name, { lastModified: f.lastModified });
        }
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
