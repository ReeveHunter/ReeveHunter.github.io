// Kerberos MIDI protocol — a JavaScript port of the transfer logic in
// Frank Buß's Kerberos App (github.com/FrankBuss/kerberos, qt/mainwindow.cpp).
// Pure functions only: everything here builds arrays of 3-byte MIDI messages
// or parses incoming bytes, so it can be tested without hardware.

export const CMD = {
  SET_ADDRESS: 0x01,
  SET_RAM_BANK: 0x02,
  SET_FLASH_BANK: 0x03,
  ERASE_FLASH_SECTOR: 0x04,
  WRITE_FLASH: 0x05,
  COMPARE_FLASH: 0x06,
  WRITE_RAM: 0x07,
  REDRAW_SCREEN: 0x08,
  PRINT: 0x09,
  GOTOX: 0x0a,
  NOP: 0x0b,
  START_SLOT_PROGRAM: 0x0c,
  START_SRAM_PROGRAM: 0x0d,
  CHANGE_CONFIG: 0x0e,
  LIST_SLOTS: 0x0f,
  WRITE_FLASH_FROM_SRAM: 0x10,
  READ_MEMORY_BLOCK: 0x15,
  MEMORY_BLOCK: 0x16,
  PING: 0x17,
  PONG: 0x18,
};

export const CONFIG = { MIDI_IN_THRU: 1, MIDI_OUT_THRU: 2 };

// "KERBEROS PRGSLOT"
export const PRG_SLOT_ID = [75, 69, 82, 66, 69, 82, 79, 83, 32, 80, 82, 71, 83, 76, 79, 84];

export const SLOT_MIN = 1;
export const SLOT_MAX = 25;
export const PRG_MAX_SIZE = 63486;
export const NEWLINE = "\r\n";

export const slotAddress = (slot) => slot * 0x10000 + 0x60000;

// MIDI emulation presets: [MIDI_ADDRESS ($DE39), MIDI_CONFIG ($DE3A)]
const IRQ_ON = 0x01, NMI_ON = 0x02, CLOCK_2MHZ = 0x04, THRU_IN_ON = 0x08, ENABLE_ON = 0x20;
export const MIDI_EMULATIONS = [
  { label: "None", address: 0x00, config: 0x00 },
  { label: "Sequential Circuits Inc.", address: 0x02, config: IRQ_ON | ENABLE_ON },
  { label: "Passport & Syntech", address: 0x88, config: IRQ_ON | ENABLE_ON },
  { label: "DATEL / Siel / JMS", address: 0x46, config: IRQ_ON | CLOCK_2MHZ | ENABLE_ON },
  { label: "Namesoft", address: 0x02, config: NMI_ON | ENABLE_ON },
];

// ---------------------------------------------------------------- CRC-8

const CRC_TABLE = new Uint8Array(256);
(() => {
  // Dallas/Maxim CRC-8 (reflected poly 0x8C) — same table as the original.
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >> 1) ^ 0x8c : c >> 1;
    CRC_TABLE[i] = c;
  }
})();

export function crc8(bytes, init = 0xff) {
  let crc = init;
  for (const b of bytes) crc = CRC_TABLE[(b ^ crc) & 0xff];
  return crc;
}

export function ascii2petscii(c) {
  if (c >= 65 && c <= 90) return c + 32;
  if (c >= 97 && c <= 122) return c - 32;
  return c;
}

const latin1 = (s) => Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
const hex4 = (n) => n.toString(16).padStart(4, "0");

// ------------------------------------------------------- message builder

// Accumulates outgoing MIDI messages. Each entry in `messages` is a
// Uint8Array(3). `marks` records progress labels at message indices so the
// UI can show what stage the transfer is in while it streams.
export class MessageBuilder {
  constructor() {
    this.buf = new Uint8Array(3 * 4096);
    this.length = 0; // number of 3-byte messages
    this.marks = [];
    this.noteOff = true;
    this.lastByte = -1;
  }

  mark(text, percent = null) {
    this.marks.push({ at: this.length, text, percent });
  }

  _raw(status, d1, d2) {
    let o = this.length * 3;
    if (o + 3 > this.buf.length) {
      const bigger = new Uint8Array(this.buf.length * 2);
      bigger.set(this.buf);
      this.buf = bigger;
    }
    this.buf[o] = status; this.buf[o + 1] = d1; this.buf[o + 2] = d2;
    this.length++;
  }

  // All messages as one flat byte array (3 bytes per message).
  bytes() { return this.buf.subarray(0, this.length * 3); }

  // Array of 3-byte views; convenient for tests, avoid for huge transfers.
  get messages() {
    const out = [];
    for (let i = 0; i < this.length; i++) out.push(this.buf.subarray(i * 3, i * 3 + 3));
    return out;
  }

  // Data is carried in note-off/note-on messages. Channel nibble:
  //   bit 3: start of transfer, bit 2: two data bytes,
  //   bit 1: bit 7 of first byte, bit 0: bit 7 of second byte.
  _sendBytesWithFlags(b1, b2, flags) {
    let channel = 0;
    if (b1 & 0x80) { b1 &= 0x7f; channel |= 2; }
    if (b2 >= 0) {
      if (b2 & 0x80) { b2 &= 0x7f; channel |= 1; }
      channel |= 4;
    } else {
      b2 = 0;
    }
    // Alternate note-off / note-on so interfaces can't apply running status.
    this._raw((this.noteOff ? 0x80 : 0x90) | channel | flags, b1, b2);
    this.noteOff = !this.noteOff;
  }

  _sendByte(byte) {
    if (this.lastByte < 0) {
      this.lastByte = byte;
    } else {
      this._sendBytesWithFlags(this.lastByte, byte, 0);
      this.lastByte = -1;
    }
  }

  command(tag, data = []) {
    this.noteOff = true;
    data = Array.from(data);
    let length = data.length;
    if (length <= 1) {
      tag |= 0x80;
      if (length === 1) { length = data[0]; data = []; }
    } else {
      length--;
    }
    this.lastByte = -1;
    this._sendBytesWithFlags(tag, length, 1 << 3);
    let crc = crc8([tag, length]);
    for (const b of data) {
      this._sendByte(b);
      crc = CRC_TABLE[(b ^ crc) & 0xff];
    }
    this._sendByte(crc);
    if (this.lastByte >= 0) this._sendBytesWithFlags(this.lastByte, -1, 0);
    return this;
  }

  byteCommand(tag, b) { return this.command(tag, [b & 0xff]); }
  wordCommand(tag, w) { return this.command(tag, [w & 0xff, (w >> 8) & 0xff]); }
  nop() { return this.command(CMD.NOP, new Array(256).fill(0)); }
  redraw() { return this.command(CMD.REDRAW_SCREEN); }
  gotoX(x) { return this.byteCommand(CMD.GOTOX, x); }
  print(text) {
    const bytes = latin1(text).map(ascii2petscii);
    bytes.push(0);
    return this.command(CMD.PRINT, bytes);
  }
}

// ---------------------------------------------------------- slot header

// Builds the 256-byte header the menu uses for slots and SRAM programs.
//   $00 ID, $10 name (32), $30 control byte, $31-$3F register mirror of
//   $DE31-$DE3F, $40 load address, $42 start address, $44 length.
export function createHeader(name, ramOperation, length, opts = {}) {
  const {
    c128 = false,
    cartridgeDisks = false,
    midiEmulation = 0,
    loadAddress = 0x0801,
    startAddress = 0,
  } = opts;
  const h = new Uint8Array(256);
  h.set(PRG_SLOT_ID, 0);
  const n = latin1(name).slice(0, 32);
  h.set(n, 0x10);

  let control = 0;
  if (c128) control |= 1;
  control |= 1 << 3; // use global MIDI thru settings
  if (cartridgeDisks) control |= 1 << 4;
  h[0x30] = control;

  const emu = MIDI_EMULATIONS[midiEmulation] || MIDI_EMULATIONS[0];
  h[0x39] = emu.address;
  h[0x3a] = emu.config | THRU_IN_ON;
  h[0x3b] = 0x01 | 0x02; // CART_CONTROL: GAME high, EXROM high
  h[0x3c] = 0x00; // CART_CONFIG: no custom BASIC/KERNAL

  h[0x40] = loadAddress & 0xff; h[0x41] = (loadAddress >> 8) & 0xff;
  h[0x42] = startAddress & 0xff; h[0x43] = (startAddress >> 8) & 0xff;
  h[0x44] = length & 0xff; h[0x45] = (length >> 8) & 0xff;
  return h;
}

// --------------------------------------------------------- PRG handling

export function inspectPrg(bytes) {
  if (bytes.length < 3) throw new Error("File is too small to be a PRG (minimum 3 bytes).");
  let loadAddress = bytes[0] | (bytes[1] << 8);
  const suspiciousC128 = loadAddress === 0x4001;
  return { loadAddress, suspiciousC128 };
}

// Defaults the original app picks after loading a PRG.
export function prgDefaults(loadAddress) {
  const basic = loadAddress === 0x0801 || loadAddress === 0x0800 || loadAddress === 0x1c01;
  return {
    loadAddress,
    startAddress: basic ? 0 : loadAddress,
    c128: loadAddress === 0x1c01,
  };
}

const isBlockFF = (block) => block.every((b) => b === 0xff);

// Port of flashFile(): erase every 4 KB sector covering the data, then write
// each 256-byte block that isn't all $FF.
export function buildFlashFile(b, name, data, startAddress) {
  b.redraw();
  b.nop();
  b.print("erasing..." + NEWLINE);
  b.nop();

  const full = data.length;
  let transferred = 0, oldPercent = -1, address = startAddress;
  while (transferred < full) {
    const c64 = (address & 0x1fff) | 0x8000;
    const sectorStart = (c64 & 0x0fff) === 0;
    if (sectorStart) {
      b.wordCommand(CMD.SET_ADDRESS, c64);
      b.byteCommand(CMD.SET_FLASH_BANK, address >> 13);
      b.command(CMD.ERASE_FLASH_SECTOR);
      b.nop();
    }
    address += 0x100;
    transferred += Math.min(full, 256);
    const percent = Math.min(100, Math.floor((transferred * 100) / full));
    if (percent !== oldPercent && sectorStart) {
      b.mark(`Erasing ${percent}%`, percent);
      b.gotoX(0);
      b.print(`${percent}%`);
      oldPercent = percent;
      b.nop();
    }
  }
  b.gotoX(0);
  b.print("100%");

  b.nop();
  b.print(NEWLINE + NEWLINE + "flashing " + name.slice(0, 20) + "..." + NEWLINE);
  b.nop();

  transferred = 0; oldPercent = -1; address = startAddress;
  for (let pos = 0; pos < full; pos += 256) {
    const c64 = (address & 0x1fff) | 0x8000;
    const size = Math.min(256, full - pos);
    const block = new Uint8Array(256).fill(0xff);
    block.set(data.subarray(pos, pos + size));
    if (!isBlockFF(block)) {
      b.wordCommand(CMD.SET_ADDRESS, c64);
      b.byteCommand(CMD.SET_FLASH_BANK, address >> 13);
      b.command(CMD.WRITE_FLASH, block);
      b.nop();
      const percent = Math.min(100, Math.floor((transferred * 100) / full));
      if (percent !== oldPercent) {
        b.mark(`Flashing ${percent}%`, percent);
        b.gotoX(0);
        b.print(`${percent}%`);
        oldPercent = percent;
        b.nop();
      }
    }
    address += 0x100;
    transferred += size;
  }
  b.gotoX(0);
  b.print("100%");
  b.nop();
  b.print(NEWLINE);
  b.print(name + " flash ok" + NEWLINE);
  b.print("waiting for next file");
  b.mark("Flash done", 100);
}

// Port of sramUpload(): copy data into the cartridge's 128 KB RAM.
export function buildSramUpload(b, name, data, startBank) {
  b.redraw();
  b.nop();
  b.print("receiving " + name.slice(0, 20) + "..." + NEWLINE);
  b.nop();
  b.wordCommand(CMD.SET_ADDRESS, 0xdf00);
  let bank = startBank, transferred = 0, oldPercent = -1;
  const full = data.length;
  for (let pos = 0; pos < full; pos += 256) {
    b.wordCommand(CMD.SET_RAM_BANK, bank);
    const block = data.subarray(pos, Math.min(full, pos + 256));
    b.command(CMD.WRITE_RAM, block);
    bank++;
    transferred += block.length;
    const percent = Math.floor((transferred * 100) / full);
    if (percent !== oldPercent) {
      b.mark(`Uploading ${percent}%`, percent);
      b.gotoX(0);
      b.print(`${percent}%`);
      oldPercent = percent;
    }
  }
  b.print(NEWLINE);
}

function checkPrg(name, bytes) {
  if (!/\.prg$/i.test(name)) throw new Error("A .prg file is required.");
  if (bytes.length < 3) throw new Error("File is too small (minimum 3 bytes).");
  if (bytes.length > PRG_MAX_SIZE) throw new Error(`File is too big (maximum ${PRG_MAX_SIZE} bytes).`);
}

export function buildFlashPrg(name, bytes, slot, opts) {
  checkPrg(name, bytes);
  if (slot < SLOT_MIN || slot > SLOT_MAX) throw new Error(`Slot must be ${SLOT_MIN}–${SLOT_MAX}.`);
  const body = bytes.subarray(2);
  const header = createHeader(name, false, body.length, opts);
  const data = new Uint8Array(256 + body.length);
  data.set(header, 0);
  data.set(body, 256);
  const b = new MessageBuilder();
  buildFlashFile(b, name, data, slotAddress(slot));
  return b;
}

export function buildUploadAndRun(name, bytes, opts) {
  checkPrg(name, bytes);
  const body = bytes.subarray(2);
  const header = createHeader(name, true, body.length, opts);
  const data = new Uint8Array(256 + body.length);
  data.set(header, 0);
  data.set(body, 256);
  const b = new MessageBuilder();
  buildSramUpload(b, name, data, 256);
  b.command(CMD.START_SRAM_PROGRAM);
  b.mark("Started", 100);
  return b;
}

export function buildStartSlot(slot, opts) {
  const header = createHeader("", true, 0, opts);
  const b = new MessageBuilder();
  b.command(CMD.START_SLOT_PROGRAM, [slot, ...header.subarray(0x30, 0x40)]);
  b.mark(`Started slot ${slot}`, 100);
  return b;
}

export function buildDeleteSlot(slot) {
  const b = new MessageBuilder();
  b.redraw();
  b.print("erasing slot " + slot + NEWLINE);
  b.nop();
  const full = 0x10000;
  let transferred = 0, address = slotAddress(slot);
  while (transferred < full) {
    const c64 = (address & 0x1fff) | 0x8000;
    if ((c64 & 0x0fff) === 0) {
      b.wordCommand(CMD.SET_ADDRESS, c64);
      b.byteCommand(CMD.SET_FLASH_BANK, address >> 13);
      b.command(CMD.ERASE_FLASH_SECTOR);
      b.nop();
    }
    address += 0x2000;
    transferred += 0x2000;
    const percent = Math.min(100, Math.floor((transferred * 100) / full));
    b.mark(`Erasing ${percent}%`, percent);
    b.gotoX(0);
    b.print(`${percent}%`);
    b.nop();
  }
  b.gotoX(0);
  b.print("100%");
  b.print(NEWLINE + "done");
  return b;
}

export function buildListSlots() {
  return new MessageBuilder().command(CMD.LIST_SLOTS);
}

export function buildBackToBasic(opts) {
  const header = createHeader("BASIC", true, 0, opts);
  header[0x40] = 0; header[0x41] = 0; // load address 0 = plain BASIC boot
  const b = new MessageBuilder();
  buildSramUpload(b, "BASIC", header, 256);
  b.command(CMD.START_SRAM_PROGRAM);
  return b;
}

// Ping: temporarily route MIDI-in to thru, then expect a PONG back.
export function buildPing() {
  const b = new MessageBuilder();
  b.command(CMD.CHANGE_CONFIG, [CONFIG.MIDI_IN_THRU, 1, CONFIG.MIDI_OUT_THRU, 0]);
  b.redraw();
  b.nop();
  b.print("ping/pong test..." + NEWLINE);
  b.nop();
  b.command(CMD.PING);
  return b;
}

// Read the 256-byte header at the start of a slot.
export function buildReadSlotHeader(slot) {
  const address = slotAddress(slot);
  const b = new MessageBuilder();
  b.wordCommand(CMD.SET_ADDRESS, (address & 0x1fff) | 0x8000);
  b.nop();
  b.byteCommand(CMD.SET_FLASH_BANK, address >> 13);
  b.nop();
  b.command(CMD.READ_MEMORY_BLOCK);
  return b;
}

export function parseSlotHeader(block) {
  for (let i = 0; i < 16; i++) if (block[i] !== PRG_SLOT_ID[i]) return null;
  let name = "";
  for (let i = 0x10; i < 0x30 && block[i]; i++) name += String.fromCharCode(block[i]);
  return {
    name,
    c128: !!(block[0x30] & 1),
    loadAddress: block[0x40] | (block[0x41] << 8),
    startAddress: block[0x42] | (block[0x43] << 8),
    length: block[0x44] | (block[0x45] << 8),
  };
}

// ------------------------------------------------------------ CRT files

// EasyFlash EAPI driver for the SST39VF1681 flash used by Kerberos
// (768 bytes, from qt/eapi-sst39vf1681 with its load address removed).
const EAPI_B64 =
  "ZWFwadPT1DM51jE2ODEg1jEuMAAIeKVLSKVMSKlghUsgSwC6vQABhUzKvQABhUsYkHBMAAFMXQFMuwFMwgFMxgFM0AFM2gFMEAJMWwJMWwKOqt+Mq9+ihY4C3o3//6IHjgLeYKkAjT/eYKkCjT/eYI7K34zL36KFjgLerf//ogeOAt5gqQCNAN4gst+iqqCKqaognt+iVaCFqVVMnt+t//9gom+gf7FLnYDf3YDf0CGIyhDyogDoGL2A32VLnYDf6L2A32VMnYDf6OAe0OgYkAapAY3x3zhohUxohUuwMyDS36KqoIqpkCCe364AgI7w360BgI3x3+C/0AfJyNADGJAGqQKN8d84oICp8CCe3yC4363x37AIrvDfoEAoGGAoOGDJ/9ACGGCN8N+O8d+M8t8IeCDS36KqoIqpoCCe3631340A3iC4363w367x36zy3yCe367x36zy3yC+383w3/ARILLfoICp8CCe3yC43yg4sAIoGKzy367x363w32CN8N+O8d+M8t8IeCDS36KqoIqpgCCe36KqoIqpqiCe36JVoIWpVSCe363w340A3iC436IArPLfwIDwAqDgqTAgnt+gFKIAytD9iND4rfXfjQDerfDfrvHfrPLfGJCWjfXfjQDeYK3132CN9t+O7d+M7t9gjvffjPjfjfnfYK31340A3iDs343w347z34z036kAjfLf8Dut99/QEK3439AIrfnf8AvO+d/O+N/O99+QRTiwQo3w347z34z0367t363u38mgkAIJQKit8N8ggN+wJO7t39AZ7u7frfbfKeDN7t/QDK323woKCo3u3+713xit8t/woaz0367z363w32D/////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////////";

let eapiCache = null;
export function setEapi(bytes) { eapiCache = bytes; }
function eapi() {
  if (!eapiCache) throw new Error("EAPI driver not loaded");
  return eapiCache;
}

const CART_SIG = "C64 CARTRIDGE   ";
const CART_TYPE_EASYFLASH = 32;
const EF_IMAGE_SIZE = 1024 * 1024;
export const EF_FLASH_START = 1024 * 1024;

const ascii = (bytes, start, len) => String.fromCharCode(...bytes.subarray(start, start + len));
const be16 = (bytes, at) => (bytes[at] << 8) | bytes[at + 1];
const be32 = (bytes, at) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

// Parse an EasyFlash .crt into the 1 MB image the cartridge stores in its
// upper flash, replacing the cart's EAPI with the Kerberos-specific one.
export function parseCrt(bytes) {
  if (bytes.length < 0x50) throw new Error("File is too small to be a CRT.");
  if (ascii(bytes, 0, 16) !== CART_SIG) throw new Error("Not a CRT file (missing “C64 CARTRIDGE” signature).");
  const type = be16(bytes, 0x16);
  if (type !== CART_TYPE_EASYFLASH) {
    throw new Error(`Only EasyFlash CRTs are supported (this one is hardware type ${type}).`);
  }
  let cartName = "";
  for (let i = 0x20; i < 0x40 && bytes[i]; i++) cartName += String.fromCharCode(bytes[i]);

  const image = new Uint8Array(EF_IMAGE_SIZE).fill(0xff);
  let efName = "";
  let chips = 0;
  const banks = new Set();

  const writeBank = (src, bank, chip, size) => {
    let offset = 0, replaceEapi = false, p = 0;
    while (size > 0) {
      const n = Math.min(256, size);
      let block = src.subarray(p, p + n);
      if (bank === 0 && chip === 1) {
        if (offset === 0x1800 && ascii(block, 0, 4) === "eapi") replaceEapi = true;
        if (offset === 0x1b00 && ascii(block, 0, 8) === "ef-nAME:") {
          for (let i = 0; i < 16 && block[i]; i++) efName += String.fromCharCode(block[i]);
        }
      }
      if (replaceEapi) {
        const e = eapi();
        if (offset === 0x1800) block = e.subarray(0x000, 0x100);
        else if (offset === 0x1900) block = e.subarray(0x100, 0x200);
        else if (offset === 0x1a00) { block = e.subarray(0x200, 0x300); replaceEapi = false; }
      }
      const phys = (bank << 13) | (offset & 0x1fff) | (chip ? 1 << 19 : 0);
      image.set(block, phys);
      p += n; size -= n; offset += n;
    }
  };

  const headerLen = be32(bytes, 0x10) || 0x40;
  let pos = headerLen;
  while (pos < bytes.length) {
    if (pos + 16 > bytes.length) throw new Error("CRT is truncated (incomplete CHIP header).");
    if (ascii(bytes, pos, 4) !== "CHIP") throw new Error(`CRT is malformed (no CHIP packet at offset ${pos}).`);
    const bank = be16(bytes, pos + 10) & 63;
    const loadAddr = be16(bytes, pos + 12);
    const romLen = be16(bytes, pos + 14);
    pos += 16;
    if (pos + romLen > bytes.length) throw new Error("CRT is truncated (CHIP data runs past end of file).");
    const data = bytes.subarray(pos, pos + romLen);
    if (loadAddr === 0x8000 && romLen <= 0x4000) {
      if (romLen > 0x2000) {
        writeBank(data, bank, 0, 0x2000);
        writeBank(data.subarray(0x2000), bank, 1, romLen - 0x2000);
      } else {
        writeBank(data, bank, 0, romLen);
      }
    } else if ((loadAddr === 0xa000 || loadAddr === 0xe000) && romLen <= 0x2000) {
      writeBank(data, bank, 1, romLen);
    } else {
      throw new Error(`Unsupported CHIP packet: $${hex4(loadAddr)}, ${romLen} bytes.`);
    }
    chips++;
    banks.add(bank);
    pos += romLen;
  }

  let usedBlocks = 0;
  for (let i = 0; i < EF_IMAGE_SIZE; i += 256) {
    if (!isBlockFF(image.subarray(i, i + 256))) usedBlocks++;
  }
  return { image, cartName, efName, chips, banks: banks.size, usedBlocks };
}

export function buildFlashCrt(name, image) {
  const b = new MessageBuilder();
  buildFlashFile(b, name, image, EF_FLASH_START);
  return b;
}

// -------------------------------------------------------------- receive

// Incremental parser for commands sent back by the cartridge.
export class Receiver {
  constructor(onCommand, onError) {
    this.onCommand = onCommand;
    this.onError = onError || (() => {});
    this.reset();
  }
  reset() { this.state = 0; this.msg = []; }
  feed(bytes) {
    for (let b of bytes) {
      let nextByte = false;
      switch (this.state) {
        case 0:
          if ((b & 0xfc) === 0x8c) { this.b0 = b; this.state = 1; }
          break;
        case 1:
          this.tag = b; this.state = 2;
          break;
        case 2: {
          let length = b;
          if (this.b0 & 2) this.tag |= 0x80;
          if (this.b0 & 1) length |= 0x80;
          this.crc = crc8([this.tag, length]);
          length = length === 0 ? 0x100 : length + 1;
          if (this.tag & 0x80) { length = 0; this.tag &= 0x7f; }
          this.length = length;
          this.msg = [];
          this.state = 3;
          break;
        }
        case 3:
          if (b & 0x80) { this.b0 = b; this.state = 4; }
          break;
        case 4:
          if (this.b0 & 2) b |= 0x80;
          nextByte = true; this.state = 5;
          break;
        case 5:
          if (this.b0 & 1) b |= 0x80;
          nextByte = true; this.state = 3;
          break;
      }
      if (nextByte) {
        if (this.length > 0) {
          this.crc = CRC_TABLE[(b ^ this.crc) & 0xff];
          this.msg.push(b);
          this.length--;
        } else {
          const ok = b === this.crc;
          const tag = this.tag, data = Uint8Array.from(this.msg);
          this.reset();
          if (ok) this.onCommand(tag, data);
          else this.onError(new Error("Checksum error in data received from the cartridge."));
        }
      }
    }
  }
}

// Decode the base64 EAPI at load time (works in browsers and Node 16+).
setEapi(Uint8Array.from(atob(EAPI_B64), (c) => c.charCodeAt(0)));
