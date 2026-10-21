// EMS "GB USB Smart Card 64M" — protocol, ROM headers and bank management.
// A JavaScript port of ems-flasher by Mike Ryan, David Wendt Jr. and
// Christophe Staiesse (MIT licence, github.com/mikeryan/ems-flasher):
// ems.c (USB commands), header.c, insert.c (best-fit placement and buddy
// defragmentation), update.c (update planning) and flash.c / updates.c
// (executing the plan with erase-block awareness).
//
// Everything here talks to a "device" object with two async methods:
//   read(from, offset, count) -> Uint8Array
//   write(to, offset, data)
// so the same code drives real hardware (WebUsbCart) or the emulator
// (MemoryCart) used for testing.

export const FROM_ROM = 1;
export const FROM_SRAM = 2;
export const TO_ROM = FROM_ROM;
export const TO_SRAM = FROM_SRAM;

export const PAGESIZE = 4 << 20;       // 4 MB per page, 2 pages
export const PAGES = 2;
export const SRAMSIZE = 128 << 10;
export const BANKSIZE = 16 << 10;      // "bank" numbers as printed by ems-flasher
export const ERASEBLOCKSIZE = 128 << 10;
export const MINROMSIZE = 32 << 10;
export const WRITEBLOCKSIZE = 32;
export const READBLOCKSIZE = 4096;
export const HEADER_SIZE = 336;
export const MENUTITLE = "MENU#";

export const ENH_GBC = 1;
export const ENH_SGB = 2;
export const ENH_ALL = ENH_GBC | ENH_SGB;
const ENH_NOT = (x) => ~x & ENH_ALL;

const CMD_READ = 0xff;
const CMD_WRITE = 0x57;
const CMD_READ_SRAM = 0x6d;
const CMD_WRITE_SRAM = 0x4d;

export const EMS_VID = 0x4670;
export const EMS_PID = 0x9394;

// ------------------------------------------------------------- headers

const H_LOGO = 0x104, H_TITLE = 0x134, H_CGB = 0x143, H_SGB = 0x146,
  H_TYPE = 0x147, H_ROMSIZE = 0x148, H_RAMSIZE = 0x149, H_OLDLIC = 0x14b, H_CHK = 0x14d;

export const NINTENDO_LOGO = Uint8Array.of(
  0xce, 0xed, 0x66, 0x66, 0xcc, 0x0d, 0x00, 0x0b, 0x03, 0x73, 0x00, 0x83, 0x00, 0x0c, 0x00, 0x0d,
  0x00, 0x08, 0x11, 0x1f, 0x88, 0x89, 0x00, 0x0e, 0xdc, 0xcc, 0x6e, 0xe6, 0xdd, 0xdd, 0xd9, 0x99,
  0xbb, 0xbb, 0x67, 0x63, 0x6e, 0x0e, 0xec, 0xcc, 0xdd, 0xdc, 0x99, 0x9f, 0xbb, 0xb9, 0x33, 0x3e,
);

export function headerChecksum(raw) {
  let c = 0;
  for (let i = H_TITLE; i < H_CHK; i++) c = (c - raw[i] - 1) & 0xff;
  return c;
}

// true if the logo and header checksum are valid
export function headerValid(raw) {
  for (let i = 0; i < NINTENDO_LOGO.length; i++) if (raw[H_LOGO + i] !== NINTENDO_LOGO[i]) return false;
  return headerChecksum(raw) === raw[H_CHK];
}

const RAM_SIZES = { 0: 0, 1: 2, 2: 8, 3: 32, 4: 128, 5: 64 };
const CART_TYPES = {
  0x00: "ROM only", 0x01: "MBC1", 0x02: "MBC1+RAM", 0x03: "MBC1+RAM+battery",
  0x05: "MBC2", 0x06: "MBC2+battery", 0x0f: "MBC3+timer+battery", 0x10: "MBC3+timer+RAM+battery",
  0x11: "MBC3", 0x12: "MBC3+RAM", 0x13: "MBC3+RAM+battery", 0x19: "MBC5", 0x1a: "MBC5+RAM",
  0x1b: "MBC5+RAM+battery", 0x1c: "MBC5+rumble", 0x1d: "MBC5+rumble+RAM", 0x1e: "MBC5+rumble+RAM+battery",
  0xfc: "Pocket Camera",
};

export function decodeHeader(raw) {
  let title = "";
  for (let i = 0; i < 16; i++) {
    const c = raw[H_TITLE + i];
    title += c >= 32 && c <= 126 ? String.fromCharCode(c) : " ";
  }
  title = title.replace(/ +$/, "");
  const code = raw[H_ROMSIZE];
  let romsize = 0;
  if (code <= 8) romsize = 32768 * 2 ** code;
  else if (code === 0x52) romsize = 1152 << 10;
  else if (code === 0x53) romsize = 1280 << 10;
  else if (code === 0x54) romsize = 1536 << 10;
  let enhancements = 0;
  if (raw[H_CGB] & 0x80) enhancements |= ENH_GBC;
  if (raw[H_SGB] === 0x03 && raw[H_OLDLIC] === 0x33) enhancements |= ENH_SGB;
  const type = raw[H_TYPE];
  return {
    title,
    romsize,
    enhancements,
    gbcOnly: (raw[H_CGB] & 0xc0) === 0xc0,
    cartType: type,
    cartTypeName: CART_TYPES[type] || `type $${type.toString(16).padStart(2, "0")}`,
    ramKB: RAM_SIZES[raw[H_RAMSIZE]] ?? 0,
    battery: [0x03, 0x06, 0x09, 0x0d, 0x0f, 0x10, 0x13, 0x1b, 0x1e, 0x22, 0xff].includes(type),
  };
}

export function enhName(enh) {
  switch (enh & ENH_ALL) {
    case ENH_GBC | ENH_SGB: return "Color+Super";
    case ENH_GBC: return "Color";
    case ENH_SGB: return "SGB";
    default: return "Classic";
  }
}

// Make the menu variant whose header enables the given enhancements
// (same edits as ems-flasher's updateheader.sh).
export function menuVariant(menu, enh) {
  const m = Uint8Array.from(menu);
  m.set(NINTENDO_LOGO, H_LOGO);
  if (enh & ENH_GBC && m[H_CGB] < 128) m[H_CGB] += 128;
  if (enh & ENH_SGB) { m[H_SGB] = 3; m[H_OLDLIC] = 0x33; }
  m[H_CHK] = headerChecksum(m);
  return m;
}

// Validate a ROM file the way validate_romfile() does.
export function inspectRomFile(name, bytes) {
  if (bytes.length < HEADER_SIZE) throw new Error(`${name}: file is too small to be a Game Boy ROM.`);
  if (!headerValid(bytes)) throw new Error(`${name}: invalid ROM header (bad Nintendo logo or header checksum).`);
  const header = decodeHeader(bytes);
  if (header.romsize === 0) throw new Error(`${name}: invalid ROM size code in header.`);
  if (bytes.length !== header.romsize) {
    throw new Error(`${name}: the header says ${header.romsize >> 10} KB but the file is ${(bytes.length / 1024).toFixed(0)} KB.`);
  }
  if (header.romsize & (header.romsize - 1)) throw new Error(`${name}: size is not a power of two.`);
  if (header.romsize > PAGESIZE) throw new Error(`${name}: larger than a 4 MB page.`);
  return header;
}

// --------------------------------------------------------- linked list
// A tiny TAILQ so the placement code can follow insert.c/update.c exactly.

class Image {
  constructor() { this.head = null; this.tail = null; }
  *[Symbol.iterator]() { for (let r = this.head; r; r = r._next) yield r; }
  toArray() { return [...this]; }
  next(r) { return r._next; }
  prev(r) { return r._prev; }
  insertHead(r) {
    r._prev = null; r._next = this.head;
    if (this.head) this.head._prev = r; else this.tail = r;
    this.head = r;
  }
  insertTail(r) {
    r._next = null; r._prev = this.tail;
    if (this.tail) this.tail._next = r; else this.head = r;
    this.tail = r;
  }
  insertAfter(after, r) {
    r._prev = after; r._next = after._next;
    if (after._next) after._next._prev = r; else this.tail = r;
    after._next = r;
  }
  remove(r) {
    if (r._prev) r._prev._next = r._next; else this.head = r._next;
    if (r._next) r._next._prev = r._prev; else this.tail = r._prev;
    r._prev = r._next = null;
  }
}

// ---------------------------------------------------- insert.c (port)

function imageInsert(image, newrom) {
  let best = { size: Infinity, offset: 0, prev: null };
  const lastrom = { offset: PAGESIZE, romsize: 0 };
  image.insertTail(lastrom);
  let offset = 0, prev = null;
  for (const rom of image) {
    const cur = rom.offset;
    const next = cur + rom.romsize;
    while (cur - offset > 0) {
      let bigest;
      for (bigest = PAGESIZE; bigest >= MINROMSIZE; bigest /= 2) {
        if (offset % bigest === 0 && cur - offset >= bigest) {
          if (bigest >= newrom.romsize && best.size > bigest) best = { size: bigest, offset, prev };
          break;
        }
      }
      offset += bigest;
    }
    prev = rom;
    offset = next;
  }
  image.remove(lastrom);
  if (best.size !== Infinity) {
    newrom.offset = best.offset;
    if (best.prev) image.insertAfter(best.prev, newrom); else image.insertHead(newrom);
    return true;
  }
  return false;
}

function imageInsertDefrag(image, newrom) {
  if (!imageInsert(image, newrom)) {
    imageDefrag(image, newrom.romsize);
    return imageInsert(image, newrom);
  }
  return true;
}

function moveRom(image, destrom, destofs, buddysize, srcrom) {
  image.remove(srcrom);
  srcrom.offset = destofs + (srcrom.offset % buddysize);
  if (destrom) image.insertAfter(destrom, srcrom); else image.insertHead(srcrom);
}

// Incrementally defragment to make room for a ROM of `size`, aligned to its
// size. ROMs only ever move from higher to lower addresses.
function imageDefrag(image, size) {
  if (size === MINROMSIZE) return false;
  let first = { romsize: size / 2, dummy: true };
  let second = { romsize: size / 2, dummy: true };
  if (!imageInsertDefrag(image, first)) return false;
  if (!imageInsertDefrag(image, second)) { image.remove(first); return false; }
  if (second.offset < first.offset) [first, second] = [second, first];

  let insertrom = image.prev(first);
  const firstoffset = first.offset;
  image.remove(first);

  const prev = image.prev(second);
  const nxt = image.next(second);
  const secondoffset = second.offset;
  image.remove(second);

  if ((secondoffset & (size / 2)) === 0) {
    let move = nxt;
    const buddyoffset = secondoffset + size / 2;
    while (move && move.offset < buddyoffset + size / 2) {
      const nextmove = image.next(move);
      moveRom(image, insertrom, firstoffset, size / 2, move);
      insertrom = move;
      move = nextmove;
    }
  } else {
    let move = prev;
    const buddyoffset = secondoffset - size / 2;
    while (move && move.offset >= buddyoffset) {
      const prevmove = image.prev(move);
      moveRom(image, insertrom, firstoffset, size / 2, move);
      move = prevmove;
    }
  }
  return true;
}

// ---------------------------------------------------- update.c (port)

const EB = (ofs) => Math.floor(ofs / ERASEBLOCKSIZE);
const fromFlash = (r) => r.source.type === "flash";

function updateSmallRoms(updates, image, from) {
  const blockRoms = [];
  for (let cur = from; cur && EB(cur.offset) === EB(from.offset); cur = image.next(cur)) blockRoms.push(cur);
  // Save the ROMs of this erase-block that must survive its erasure.
  let slot = 0;
  for (const cur of blockRoms) {
    if (fromFlash(cur) && EB(cur.source.origoffset) === EB(from.offset)) {
      updates.push({ cmd: "read", rom: cur, slot: slot++ });
    }
  }
  if (from.offset % ERASEBLOCKSIZE !== 0) {
    updates.push({ cmd: "erase", offset: from.offset - (from.offset % ERASEBLOCKSIZE) });
  }
  slot = 0;
  for (const cur of blockRoms) {
    if (fromFlash(cur) && EB(cur.source.origoffset) === EB(from.offset)) {
      updates.push({ cmd: "write", rom: cur, slot: slot++ });
    } else if (cur.source.type === "file") {
      updates.push({ cmd: "writef", rom: cur });
    } else {
      updates.push({ cmd: "move", rom: cur });
    }
  }
}

// Turn the planned image into an ordered list of flash commands.
export function imageUpdate(image) {
  const updates = [];
  for (let rom = image.head; rom; rom = rom ? image.next(rom) : null) {
    if (fromFlash(rom) && rom.offset === rom.source.origoffset) continue;
    if (rom.romsize >= ERASEBLOCKSIZE) {
      updates.push({ cmd: fromFlash(rom) ? "move" : "writef", rom });
    } else {
      let from = rom, p;
      while ((p = image.prev(from)) && EB(p.offset) === EB(from.offset)) from = p;
      updateSmallRoms(updates, image, from);
      let n;
      while ((n = image.next(rom)) && EB(n.offset) === EB(from.offset)) rom = n;
    }
  }
  return updates;
}

// -------------------------------------------------- listing (cmd.c)

// List the valid ROMs of a page, as list() does.
export async function listPage(dev, page, onProgress) {
  const base = page * PAGESIZE;
  const roms = [];
  let offset = 0;
  do {
    onProgress?.(offset, PAGESIZE);
    const raw = await dev.read(FROM_ROM, base + offset, HEADER_SIZE);
    if (!headerValid(raw)) { offset += 32768; continue; }
    const header = decodeHeader(raw);
    const r = header.romsize;
    if (r === 0 || (r & (r - 1)) !== 0 || offset % r !== 0 || offset + r > PAGESIZE) { offset += 32768; continue; }
    roms.push({ offset, header });
    offset += r;
  } while (offset < PAGESIZE);
  onProgress?.(PAGESIZE, PAGESIZE);
  return describePage(roms);
}

export function describePage(roms) {
  const menu = roms.length > 0 && roms[0].offset === 0 && roms[0].header.title === MENUTITLE ? roms[0] : null;
  const menuEnh = menu ? menu.header.enhancements : -1;
  let incompat = 0, used = 0;
  for (const r of roms) {
    if (menuEnh !== -1 && r.header.enhancements !== menuEnh) incompat |= r.header.enhancements ^ menuEnh;
    used += r.header.romsize;
  }
  return {
    roms,
    menu,
    enhancements: menuEnh,
    incompatible: incompat,
    used,
    free: PAGESIZE - used,
    corrupt: used > PAGESIZE,
  };
}

// --------------------------------------------- planning (cmd_write)

// files: [{ name, bytes, header }]; menu: Uint8Array of the base menu ROM.
// Returns { updates, image, menuAdded, warnings } or throws with a message.
export function planWrite(listing, files, menu, { force = false } = {}) {
  if (!files.length) throw new Error("No ROMs to write.");
  let roms = listing.roms.slice();

  // Drop a lone menu if the page is otherwise empty and the new ROMs want a
  // different mode, or a 4 MB ROM takes the whole page.
  if (roms.length === 1 && roms[0].offset === 0 && roms[0].header.title === MENUTITLE && roms[0].header.romsize === 32768) {
    if (files[0].header.romsize === PAGESIZE || files[0].header.enhancements !== roms[0].header.enhancements) roms = [];
  }
  if (roms.length > 0 && (roms[0].offset !== 0 || roms[0].header.title !== MENUTITLE)) {
    throw new Error("This page has ROMs but no menu at bank 0. Format the page (or restore a dump) before adding ROMs.");
  }

  const warnings = [];
  if (!force) {
    const enhPage = roms.length > 0 ? roms[0].header.enhancements : files[0].header.enhancements;
    let ignore = 0;
    for (const r of roms) if (r.header.enhancements !== enhPage) ignore |= enhPage ^ r.header.enhancements;
    let incompat = 0;
    const bad = [];
    for (const f of files) {
      const a = f.header.enhancements & ENH_NOT(ignore), b = enhPage & ENH_NOT(ignore);
      if (a !== b) { incompat |= a ^ b; bad.push(f); }
    }
    if (incompat) {
      const err = new Error(
        `${bad.map((f) => f.name).join(", ")} ${bad.length > 1 ? "need" : "needs"} a page set to “${enhName(bad[0].header.enhancements)}”, but this page is “${enhName(enhPage)}”. ` +
        `Put ${bad.length > 1 ? "them" : "it"} on the other page, or add anyway if you don't use ${enhName(incompat)} hardware.`,
      );
      err.code = "ENH";
      err.pageEnh = enhPage;
      err.incompat = incompat;
      throw err;
    }
  }

  const image = new Image();
  let free = PAGESIZE;
  for (const r of roms) {
    image.insertTail({ offset: r.offset, romsize: r.header.romsize, header: r.header, source: { type: "flash", origoffset: r.offset } });
    free -= r.header.romsize;
  }
  if (free < 0) throw new Error("The ROMs on this page add up to more than 4 MB — the page looks corrupt. Format it first.");

  let menuAdded = null;
  if (roms.length === 0 && files[0].header.romsize < PAGESIZE) {
    const m = menuVariant(menu, files[0].header.enhancements);
    const mh = decodeHeader(m);
    if (mh.title !== MENUTITLE || mh.romsize !== 32768) throw new Error("The bundled menu ROM is invalid.");
    menuAdded = { name: "menu.gb", bytes: m, header: mh };
    image.insertTail({ offset: 0, romsize: 32768, header: mh, source: { type: "file", file: menuAdded } });
    free -= 32768;
  }

  const sorted = files.slice().sort((a, b) => b.header.romsize - a.header.romsize);
  for (const f of sorted) {
    for (const r of image) {
      if (r.header.title === f.header.title) {
        throw new Error(
          r.source.type === "flash"
            ? `${f.name}: a ROM titled “${f.header.title}” is already on this page.`
            : `${f.name} and ${r.source.file.name} have the same title (“${f.header.title}”).`,
        );
      }
    }
    const rom = { romsize: f.header.romsize, header: f.header, source: { type: "file", file: f } };
    imageInsertDefrag(image, rom);
    if (free < f.header.romsize) throw new Error(`Not enough space on this page for ${f.name} (${f.header.romsize >> 10} KB needed, ${free >> 10} KB free).`);
    free -= f.header.romsize;
  }

  const updates = imageUpdate(image);
  const plan = image.toArray().map((r) => ({
    offset: r.offset, romsize: r.romsize, title: r.header.title,
    source: r.source.type, from: r.source.type === "flash" ? r.source.origoffset : null,
  }));
  return { updates, plan, menuAdded, free };
}

export function summarizeUpdates(updates) {
  const t = { erase: 0, writef: 0, write: 0, read: 0, moves: 0, newRoms: 0 };
  for (const u of updates) {
    switch (u.cmd) {
      case "writef":
        if (u.rom.offset % ERASEBLOCKSIZE === 0) t.erase += Math.ceil(u.rom.romsize / ERASEBLOCKSIZE);
        t.writef += u.rom.romsize; t.newRoms++;
        break;
      case "move":
        if (u.rom.offset % ERASEBLOCKSIZE === 0) t.erase += Math.ceil(u.rom.romsize / ERASEBLOCKSIZE);
        t.write += u.rom.romsize; t.read += u.rom.romsize; t.moves++;
        break;
      case "write":
        if (u.rom.offset % ERASEBLOCKSIZE === 0) t.erase += Math.ceil(u.rom.romsize / ERASEBLOCKSIZE);
        t.write += u.rom.romsize;
        break;
      case "read": t.read += u.rom.romsize; break;
      case "erase": t.erase++; break;
    }
  }
  t.bytes = t.writef + t.write + t.read;
  return t;
}

// ------------------------------------------------- flash.c (port)

export class Cancelled extends Error {
  constructor() { super("Cancelled"); this.name = "AbortError"; }
}

class Flasher {
  constructor(dev, { onProgress, signal } = {}) {
    this.dev = dev;
    this.onProgress = onProgress || (() => {});
    this.signal = signal;
    this.lastofs = -1;
    this.slots = [];
  }
  check() { if (this.signal?.aborted) throw new Cancelled(); }
  async w(to, ofs, data) {
    this.lastofs = ofs;
    await this.dev.write(to, ofs, data);
  }

  // Write a file image; the 64 bytes at 0x100 (logo) go last so the ROM only
  // becomes visible once every other byte is in place.
  async writef(to, offset, bytes, size = bytes.length) {
    const B = WRITEBLOCKSIZE * 2;
    let hold = null;
    for (let ofs = 0; ofs < size; ofs += B) {
      const chunk = bytes.subarray(ofs, ofs + B);
      if (to === TO_ROM && ofs === 0x100) { hold = chunk; continue; }
      this.check();
      await this.w(to, offset + ofs, chunk.subarray(0, 32));
      await this.w(to, offset + ofs + 32, chunk.subarray(32, 64));
      this.onProgress(B);
    }
    if (to === TO_ROM && hold) {
      await this.w(to, offset + 0x100, hold.subarray(0, 32));
      await this.w(to, offset + 0x120, hold.subarray(32, 64));
    }
  }

  async readInto(from, offset, size) {
    const out = new Uint8Array(size);
    for (let ofs = 0; ofs + READBLOCKSIZE <= size; ofs += READBLOCKSIZE) {
      this.check();
      out.set(await this.dev.read(from, offset + ofs, READBLOCKSIZE), ofs);
      this.onProgress(READBLOCKSIZE);
    }
    return out;
  }

  async move(offset, size, origoffset) {
    let hold = null;
    let src = origoffset, dest = offset;
    for (let remain = size; remain > 0; remain -= READBLOCKSIZE) {
      this.check();
      const block = await this.dev.read(FROM_ROM, src, READBLOCKSIZE);
      this.onProgress(READBLOCKSIZE);
      for (let b = 0; b < READBLOCKSIZE; b += WRITEBLOCKSIZE) {
        if (src === origoffset && b === 0x100) { hold = block.slice(0x100, 0x140); b += WRITEBLOCKSIZE; continue; }
        await this.w(TO_ROM, dest + b, block.subarray(b, b + WRITEBLOCKSIZE));
      }
      this.onProgress(READBLOCKSIZE);
      src += READBLOCKSIZE;
      dest += READBLOCKSIZE;
    }
    await this.w(TO_ROM, offset + 0x100, hold.subarray(0, 32));
    await this.w(TO_ROM, offset + 0x120, hold.subarray(32, 64));
    await this.deleteRom(origoffset, 2);
  }

  async read(slot, size, offset) {
    this.slots[slot] = await this.readInto(FROM_ROM, offset, size);
  }

  async write(offset, size, slot) {
    const buf = this.slots[slot];
    for (let b = 0; b < size; b += WRITEBLOCKSIZE) {
      if (b === 0x100) continue;
      await this.w(TO_ROM, offset + b, buf.subarray(b, b + WRITEBLOCKSIZE));
      if ((b + WRITEBLOCKSIZE) % READBLOCKSIZE === 0) this.onProgress(READBLOCKSIZE);
    }
    await this.w(TO_ROM, offset + 0x100, buf.subarray(0x100, 0x120));
  }

  async erase(offset) {
    this.check();
    const blank = new Uint8Array(32).fill(0xff);
    await this.w(TO_ROM, offset, blank);
    await this.w(TO_ROM, offset + 32, blank);
  }

  // Zero part of the header (title area) so the menu no longer sees the ROM.
  async deleteRom(offset, blocks) {
    const zero = new Uint8Array(32);
    while (blocks--) {
      await this.dev.write(TO_ROM, offset + 0x130 - blocks * 32, zero);
    }
  }
}

// Execute a plan from planWrite() on page `page` (updates.c).
export async function applyUpdates(dev, page, updates, { onProgress, onStep, signal } = {}) {
  const base = page * PAGESIZE;
  const f = new Flasher(dev, { onProgress, signal });
  let i = 0, error = null;
  for (; i < updates.length; i++) {
    const u = updates[i];
    onStep?.(u, i, updates.length);
    try {
      switch (u.cmd) {
        case "writef": await f.writef(TO_ROM, base + u.rom.offset, u.rom.source.file.bytes, u.rom.romsize); break;
        case "move": await f.move(base + u.rom.offset, u.rom.romsize, base + u.rom.source.origoffset); break;
        case "read": await f.read(u.slot, u.rom.romsize, base + u.rom.source.origoffset); break;
        case "write": await f.write(base + u.rom.offset, u.rom.romsize, u.slot); break;
        case "erase": await f.erase(base + u.offset); break;
      }
    } catch (err) {
      error = err;
      break;
    }
  }
  if (!error) {
    try { await dev.flush?.(); } catch (err) { error = err; i = updates.length - 1; }
  }
  if (!error) return { ok: true };
  await dev.resetError?.();

  // Error recovery: re-write the small ROMs saved in memory for the erase-block
  // that was being rebuilt, so they aren't lost. A cancel is treated like a
  // non-USB error (the page is still talking to us); a USB error is not retried.
  const usbError = !(error instanceof Cancelled);
  const lost = [], recovered = [];
  const recover = new Flasher(dev, {});
  recover.slots = f.slots;
  for (let j = i; j < updates.length; j++) {
    const u = updates[j];
    if (u.cmd !== "write") continue;
    if (Math.floor(f.lastofs / ERASEBLOCKSIZE) !== Math.floor((base + u.rom.offset) / ERASEBLOCKSIZE)) break;
    if (!usbError && j !== i) {
      try {
        await recover.write(base + u.rom.offset, u.rom.romsize, u.slot);
        recovered.push(u.rom.header.title);
        continue;
      } catch { /* fall through */ }
    }
    lost.push(u.rom.header.title);
  }
  // Return the in-memory copies so the UI can offer them as downloads.
  const rescued = [];
  for (const u of updates) {
    if (u.cmd === "write" && f.slots[u.slot] && lost.includes(u.rom.header.title)) {
      rescued.push({ title: u.rom.header.title, bytes: f.slots[u.slot].subarray(0, u.rom.romsize) });
    }
  }
  return { ok: false, error, lost, recovered, rescued };
}

// ----------------------------------------------- other commands

export async function deleteRoms(dev, page, offsets) {
  const f = new Flasher(dev);
  for (const ofs of offsets) {
    const raw = await dev.read(FROM_ROM, page * PAGESIZE + ofs, HEADER_SIZE);
    if (!headerValid(raw)) throw new Error(`No ROM at bank ${ofs / BANKSIZE}.`);
    await f.deleteRom(page * PAGESIZE + ofs, 2);
  }
  await dev.flush?.();
}

export async function formatPage(dev, page, { signal } = {}) {
  const f = new Flasher(dev, { signal });
  for (let ofs = 0; ofs <= PAGESIZE - 32768; ofs += 32768) await f.deleteRom(page * PAGESIZE + ofs, 1);
  await dev.flush?.();
}

export async function readRom(dev, page, offset, size, opts) {
  return new Flasher(dev, opts).readInto(FROM_ROM, page * PAGESIZE + offset, size);
}

export async function dumpPage(dev, page, opts) {
  return new Flasher(dev, opts).readInto(FROM_ROM, page * PAGESIZE, PAGESIZE);
}

export async function restorePage(dev, page, bytes, opts) {
  if (bytes.length !== PAGESIZE) throw new Error("A page dump must be exactly 4 MB.");
  await new Flasher(dev, opts).writef(TO_ROM, page * PAGESIZE, bytes);
  await dev.flush?.();
}

export async function dumpSram(dev, opts) {
  return new Flasher(dev, opts).readInto(FROM_SRAM, 0, SRAMSIZE);
}

export async function restoreSram(dev, bytes, opts) {
  if (bytes.length > SRAMSIZE) throw new Error("A save file can be at most 128 KB.");
  const full = new Uint8Array(SRAMSIZE).fill(0xff);
  full.set(bytes);
  // Pad to a multiple of 64 bytes so writes stay paired.
  const size = Math.ceil(bytes.length / 64) * 64 || 64;
  await new Flasher(dev, opts).writef(TO_SRAM, 0, full, size);
  await dev.flush?.();
}

// ------------------------------------------------------ devices

function command(cmd, addr, len) {
  const b = new Uint8Array(9);
  const v = new DataView(b.buffer);
  b[0] = cmd;
  v.setUint32(1, addr, false);
  v.setUint32(5, len, false);
  return b;
}

// Real cartridge over WebUSB (Chrome / Edge).
export class WebUsbCart {
  static async request() {
    if (!navigator.usb) throw new Error("This browser doesn't support WebUSB. Use Chrome or Edge.");
    const device = await navigator.usb.requestDevice({ filters: [{ vendorId: EMS_VID, productId: EMS_PID }] });
    const cart = new WebUsbCart(device);
    await cart.open();
    return cart;
  }
  // Diagnostic: let the user pick any USB device Chrome can see.
  static async requestAnyDevice() {
    if (!navigator.usb) throw new Error("This browser doesn't support WebUSB. Use Chrome or Edge.");
    return navigator.usb.requestDevice({ filters: [] });
  }
  static async fromDevice(device) {
    const cart = new WebUsbCart(device);
    await cart.open();
    return cart;
  }
  static isEms(device) { return device.vendorId === EMS_VID && device.productId === EMS_PID; }
  static label(device) {
    const name = [device.manufacturerName, device.productName].filter(Boolean).join(" ") || "Unnamed device";
    return `${name} (ID ${hex4(device.vendorId)}:${hex4(device.productId)})`;
  }
  static async reconnect() {
    if (!navigator.usb) return null;
    const devices = await navigator.usb.getDevices();
    const device = devices.find((d) => d.vendorId === EMS_VID && d.productId === EMS_PID);
    if (!device) return null;
    const cart = new WebUsbCart(device);
    await cart.open();
    return cart;
  }
  constructor(device) {
    this.device = device;
    this.writeCount = 0;
    this.epOut = 2;
    this.epIn = 1;
    this.queue = Promise.resolve();
  }
  get name() { return this.device.productName || "EMS 64M cart"; }
  async open() {
    const d = this.device;
    try {
      await d.open();
      if (d.configuration === null) await d.selectConfiguration(1);
      const claimed = [];
      for (const intf of d.configuration.interfaces) {
        try { await d.claimInterface(intf.interfaceNumber); claimed.push(intf); } catch (e) { this.claimError = e; }
      }
      if (!claimed.length) throw this.claimError || new Error("No USB interface could be claimed.");
      // Find the bulk endpoints (ems-flasher uses OUT 2 and IN 1).
      for (const intf of claimed) {
        for (const ep of intf.alternate.endpoints) {
          if (ep.type !== "bulk") continue;
          if (ep.direction === "out") this.epOut = ep.endpointNumber;
          if (ep.direction === "in") this.epIn = ep.endpointNumber;
        }
      }
    } catch (err) {
      throw describeUsbError(err, d);
    }
  }
  async close() { try { await this.device.close(); } catch {} }
  describe() {
    const d = this.device;
    const lines = [`${d.manufacturerName || "?"} ${d.productName || "?"} (${hex4(d.vendorId)}:${hex4(d.productId)})`];
    for (const intf of d.configuration?.interfaces || []) {
      const a = intf.alternate;
      lines.push(`interface ${intf.interfaceNumber}: class ${a.interfaceClass}/${a.interfaceSubclass}/${a.interfaceProtocol}, endpoints ${a.endpoints.map((e) => `${e.direction}${e.endpointNumber}(${e.type})`).join(" ")}`);
    }
    return lines.join("\n");
  }
  // Serialise transfers: the cart handles one command at a time. Writes are
  // pipelined (up to 32 in flight) because each one is a tiny USB transfer;
  // once any transfer fails, everything after it is refused.
  run(fn) {
    const p = this.queue.then(() => {
      if (this.broken) throw this.broken;
      return fn();
    });
    this.queue = p.catch((e) => { this.broken = this.broken || e; });
    return p;
  }
  // Drain everything queued, clear any stalled endpoint and accept new
  // transfers again. Called after an error and before each new job.
  async resetError() {
    const all = this.inflight || [];
    this.inflight = [];
    await Promise.allSettled(all);
    await this.queue;
    if (this.broken) {
      for (const [dir, ep] of [["out", this.epOut], ["in", this.epIn]]) {
        try { await this.device.clearHalt(dir, ep); } catch {}
      }
    }
    this.broken = null;
    // The cart blocks reads after an odd number of writes. If an error left us
    // odd, send one pad write of 0xFF (programming 1-bits never changes flash;
    // offset 0x20 is not the start of an erase block, so nothing is erased).
    if (this.writeCount % 2) {
      try { await this.write(TO_ROM, 0x20, new Uint8Array(32).fill(0xff)); await this.flush(); } catch {}
      this.broken = null;
    }
  }
  async read(from, offset, count) {
    await this.flush();
    return this.run(async () => {
      const cmd = from === FROM_ROM ? CMD_READ : CMD_READ_SRAM;
      const out = await withTimeout(this.device.transferOut(this.epOut, command(cmd, offset, count)));
      if (out.status !== "ok") throw new Error(`USB write failed (${out.status}).`);
      const buf = new Uint8Array(count);
      let got = 0;
      while (got < count) {
        const r = await withTimeout(this.device.transferIn(this.epIn, count - got));
        if (r.status === "stall") { await this.device.clearHalt("in", this.epIn); throw new Error("USB read stalled."); }
        const chunk = new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
        if (!chunk.length) throw new Error("USB read returned no data.");
        buf.set(chunk, got);
        got += chunk.length;
      }
      return buf;
    });
  }
  async write(to, offset, data) {
    const cmd = to === TO_ROM ? CMD_WRITE : CMD_WRITE_SRAM;
    const pkt = new Uint8Array(9 + data.length);
    pkt.set(command(cmd, offset, data.length));
    pkt.set(data, 9);
    const p = this.run(async () => {
      const r = await withTimeout(this.device.transferOut(this.epOut, pkt));
      if (r.status !== "ok" || r.bytesWritten !== pkt.length) throw new Error(`USB write failed (${r.status}).`);
      this.writeCount++;
    });
    this.inflight = this.inflight || [];
    this.inflight.push(p);
    if (this.inflight.length >= 32) await this.inflight.shift();
  }
  // Wait for every queued write (reads do this implicitly via the queue).
  async flush() {
    const all = this.inflight || [];
    this.inflight = [];
    await Promise.all(all);
  }
}

const hex4 = (n) => n.toString(16).padStart(4, "0");

// Erasing a block takes about a second; anything much longer means the cart
// has stopped answering.
function withTimeout(promise, ms = 15000) {
  let t;
  const timer = new Promise((_, reject) => {
    t = setTimeout(() => reject(new Error("The cart stopped responding. Unplug it, plug it back in and click Connect.")), ms);
  });
  return Promise.race([promise, timer]).finally(() => clearTimeout(t));
}

function describeUsbError(err, device) {
  const msg = String(err?.message || err);
  if (/protected class/i.test(msg)) {
    return new Error("Chrome won't let web pages use this USB device (it reports a protected USB class). The command-line ems-flasher is the fallback.");
  }
  if (/Access denied|SecurityError|Unable to claim/i.test(msg)) {
    return new Error(`Couldn't open the cart: ${msg}. Close any other program using it (e.g. ems-flasher or the EMS app), unplug and replug it, then try again.`);
  }
  return new Error(`Couldn't open the cart: ${msg}`);
}

// In-memory cartridge with the flash quirks from ems-flasher's Tech notes:
// writing to the start of a 128 KB erase-block erases it; writes can only
// clear bits; a read after an odd number of writes would hang the real cart.
export class MemoryCart {
  constructor({ strict = true } = {}) {
    this.rom = new Uint8Array(PAGES * PAGESIZE).fill(0xff);
    this.sram = new Uint8Array(SRAMSIZE).fill(0xff);
    this.writes = 0;
    this.strict = strict;
    this.stats = { reads: 0, writes: 0, erases: 0 };
    this.name = "Simulated EMS 64M cart";
  }
  async read(from, offset, count) {
    if (this.strict && this.writes % 2) throw new Error(`Read at ${offset} after an odd number of writes — the real cart would hang.`);
    this.stats.reads++;
    const mem = from === FROM_ROM ? this.rom : this.sram;
    const out = new Uint8Array(count).fill(0xff);
    out.set(mem.subarray(offset, Math.min(mem.length, offset + count)));
    return out;
  }
  async write(to, offset, data) {
    this.writes++;
    this.stats.writes++;
    if (to === TO_SRAM) { this.sram.set(data, offset); return; }
    if (offset % ERASEBLOCKSIZE === 0) {
      this.rom.fill(0xff, offset, offset + ERASEBLOCKSIZE);
      this.stats.erases++;
    }
    for (let i = 0; i < data.length; i++) this.rom[offset + i] &= data[i];
  }
}
