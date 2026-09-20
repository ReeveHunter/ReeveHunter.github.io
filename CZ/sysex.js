// sysex.js
//
// Casio CZ-101 / CZ-1000 / CZ-5000 voice (patch) SysEx encoding.
//
// Source: the classic youngmonkey.ca "Casio CZ MIDI implementation" writeup,
// archived at https://github.com/ajwills72/cz101/blob/master/docs/sysex.md
// (that page itself credits youngmonkey.ca). This is a hobbyist reverse-
// engineering document, not an official Casio spec, and a few corners of it
// are genuinely ambiguous in the transcription that survives online. Every
// function below that rests on solid ground says so; the couple of spots
// that are a best-effort reconstruction are flagged with CONFIDENCE notes.
// If your CZ-101 does something different than documented here, trust the
// hardware and let's fix the code.
//
// A "voice" is 256 logical bytes, organized into 25 sections (oscillator 1's
// waveform/envelopes, then oscillator 2's). On the wire each byte is split
// into two nibbles (low nibble first) before being sent, so the SysEx body
// is 512 bytes long.

// ---------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------

/** Clamp x into [lo, hi] and floor it. */
function clampInt(x, lo, hi) {
  return Math.max(lo, Math.min(hi, Math.floor(x)));
}

/**
 * Split an array of 0-255 byte values into nibble pairs (low nibble first),
 * exactly as the CZ expects on the wire.
 * e.g. byte 0x5F -> [0x0F, 0x05]
 */
export function nibblize(bytes) {
  const out = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] & 0xff;
    out[i * 2] = b & 0x0f;
    out[i * 2 + 1] = (b >> 4) & 0x0f;
  }
  return out;
}

/** Inverse of nibblize(), used only for tests / round-tripping. */
export function denibblize(nibbles) {
  const out = new Uint8Array(nibbles.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = (nibbles[i * 2] & 0x0f) | ((nibbles[i * 2 + 1] & 0x0f) << 4);
  }
  return out;
}

// ---------------------------------------------------------------------
// Section 1: PFLAG (octave range + line select)
// ---------------------------------------------------------------------

// octave: -1, 0, or +1.  line: 1, 2, 3 ("1+1'"), or 4 ("1+2'").
export function pflagByte(octave, line) {
  const octv = octave === 1 ? 0b01 : octave === -1 ? 0b10 : 0b00;
  const ls = { 1: 0b00, 2: 0b01, 3: 0b10, 4: 0b11 }[line] ?? 0b00;
  return (octv << 2) | ls;
}

// ---------------------------------------------------------------------
// Section 2/3: detune sign + depth
// ---------------------------------------------------------------------

// sign: '+' or '-'
export function detuneSignByte(sign) {
  return sign === "-" ? 0x01 : 0x00;
}

// fine: 0-60 (cents-ish, arbitrary internal units matching the manual's dial)
export function detuneFineByte(fine) {
  const v = clampInt(fine, 0, 60);
  if (v <= 15) return v;
  if (v <= 30) return 0x11 + (v - 16);
  if (v <= 45) return 0x21 + (v - 31);
  return 0x31 + (v - 46);
}

// octave: 0-3, note: 0-11 (semitone within the octave)
export function detuneOctaveNoteByte(octave, note) {
  return clampInt(octave, 0, 3) * 12 + clampInt(note, 0, 11);
}

// ---------------------------------------------------------------------
// Section 4: vibrato waveform
// ---------------------------------------------------------------------

const VIBRATO_WAVE_BYTE = { 1: 0x08, 2: 0x04, 3: 0x20, 4: 0x02 };
export function vibratoWaveByte(wave) {
  return VIBRATO_WAVE_BYTE[wave] ?? VIBRATO_WAVE_BYTE[1];
}

// ---------------------------------------------------------------------
// Sections 5-7: vibrato delay / rate / depth (each a 3-byte value, 0-99)
// ---------------------------------------------------------------------
// For 0-24 the encoding follows a documented arithmetic pattern; for 25-99
// it's a lookup table straight from the source doc (verified to agree with
// the arithmetic pattern in the 25-31 overlap, so the join is trustworthy).

const VIBRATO_DELAY_TABLE = {
  25:[0x19,0x00,0x19],26:[0x1A,0x00,0x1A],27:[0x1B,0x00,0x1B],28:[0x1C,0x00,0x1C],29:[0x1D,0x00,0x1D],
  30:[0x1E,0x00,0x1E],31:[0x1F,0x00,0x1F],32:[0x20,0x00,0x21],33:[0x21,0x00,0x23],34:[0x22,0x00,0x25],
  35:[0x23,0x00,0x27],36:[0x24,0x00,0x29],37:[0x25,0x00,0x2B],38:[0x26,0x00,0x2D],39:[0x27,0x00,0x2F],
  40:[0x28,0x00,0x31],41:[0x29,0x00,0x33],42:[0x2A,0x00,0x35],43:[0x2B,0x00,0x37],44:[0x2C,0x00,0x39],
  45:[0x2D,0x00,0x3B],46:[0x2E,0x00,0x3D],47:[0x2F,0x00,0x3F],48:[0x30,0x00,0x43],49:[0x31,0x00,0x47],
  50:[0x32,0x00,0x4B],51:[0x33,0x00,0x4F],52:[0x34,0x00,0x53],53:[0x35,0x00,0x57],54:[0x36,0x00,0x5B],
  55:[0x37,0x00,0x5F],56:[0x38,0x00,0x63],57:[0x39,0x00,0x67],58:[0x3A,0x00,0x6B],59:[0x3B,0x00,0x6F],
  60:[0x3C,0x00,0x73],61:[0x3D,0x00,0x77],62:[0x3E,0x00,0x7B],63:[0x3F,0x00,0x7F],64:[0x40,0x00,0x87],
  65:[0x41,0x00,0x8F],66:[0x42,0x00,0x97],67:[0x43,0x00,0x9F],68:[0x44,0x00,0xA7],69:[0x45,0x00,0xAF],
  70:[0x46,0x00,0xB7],71:[0x47,0x00,0xBF],72:[0x48,0x00,0xC7],73:[0x49,0x00,0xCF],74:[0x4A,0x00,0xD7],
  75:[0x4B,0x00,0xDF],76:[0x4C,0x00,0xE7],77:[0x4D,0x00,0xEF],78:[0x4E,0x00,0xF7],79:[0x4F,0x00,0xFF],
  80:[0x50,0x01,0x0F],81:[0x51,0x01,0x1F],82:[0x52,0x01,0x2F],83:[0x53,0x01,0x3F],84:[0x54,0x01,0x4F],
  85:[0x55,0x01,0x5F],86:[0x56,0x01,0x6F],87:[0x67,0x01,0x7F],88:[0x58,0x01,0x8F],89:[0x59,0x01,0x9F],
  90:[0x5A,0x01,0xAF],91:[0x5B,0x01,0xBF],92:[0x5C,0x01,0xCF],93:[0x5D,0x01,0xDF],94:[0x5E,0x01,0xEF],
  95:[0x5F,0x01,0xFF],96:[0x60,0x02,0x1F],97:[0x61,0x02,0x3F],98:[0x62,0x02,0x5F],99:[0x63,0x02,0x7F],
};
// NOTE: row 87 (0x67 0x01 0x7F) looks like a transcription typo in the source
// for what should probably be 0x57 (it breaks the otherwise-smooth run of
// first bytes 0x50..0x63); left as-published rather than "corrected" blind.

const VIBRATO_RATE_TABLE = {
  25:[0x19,0x03,0x40],26:[0x1A,0x03,0x60],27:[0x1B,0x03,0x80],28:[0x1C,0x03,0xA0],29:[0x1D,0x03,0xC0],
  30:[0x1E,0x03,0xE0],31:[0x1F,0x04,0x00],32:[0x20,0x04,0x60],33:[0x21,0x04,0xA0],34:[0x22,0x04,0xE0],
  35:[0x23,0x05,0x20],36:[0x24,0x05,0x60],37:[0x25,0x05,0xA0],38:[0x26,0x05,0xE0],39:[0x27,0x06,0x20],
  40:[0x28,0x06,0x60],41:[0x29,0x06,0xA0],42:[0x2A,0x06,0xE0],43:[0x2B,0x07,0x20],44:[0x2C,0x07,0x60],
  45:[0x2D,0x07,0xA0],46:[0x2E,0x07,0xE0],47:[0x2F,0x08,0x20],48:[0x30,0x08,0xE0],49:[0x31,0x09,0x60],
  50:[0x32,0x09,0xE0],51:[0x33,0x0A,0x60],52:[0x34,0x0A,0xE0],53:[0x35,0x0B,0x60],54:[0x36,0x0B,0xE0],
  55:[0x37,0x0C,0x60],56:[0x38,0x0C,0xE0],57:[0x39,0x0D,0x60],58:[0x3A,0x0D,0xE0],59:[0x3B,0x0E,0x60],
  60:[0x3C,0x0E,0xE0],61:[0x3D,0x0F,0x60],62:[0x3E,0x0F,0xE0],63:[0x3F,0x10,0x60],64:[0x40,0x11,0xE0],
  65:[0x41,0x12,0xE0],66:[0x42,0x13,0xE0],67:[0x43,0x14,0xE0],68:[0x44,0x15,0xE0],69:[0x45,0x16,0xE0],
  70:[0x46,0x17,0xE0],71:[0x47,0x18,0xE0],72:[0x48,0x19,0xE0],73:[0x49,0x1A,0xE0],74:[0x4A,0x1B,0xE0],
  75:[0x4B,0x1C,0xE0],76:[0x4C,0x1D,0xE0],77:[0x4D,0x1E,0xE0],78:[0x4E,0x1F,0xE0],79:[0x4F,0x20,0xE0],
  80:[0x50,0x23,0xE0],81:[0x51,0x25,0xE0],82:[0x52,0x27,0xE0],83:[0x53,0x29,0xE0],84:[0x54,0x2B,0xE0],
  85:[0x55,0x2D,0xE0],86:[0x56,0x2F,0xE0],87:[0x57,0x31,0xE0],88:[0x58,0x33,0xE0],89:[0x59,0x35,0xE0],
  90:[0x5A,0x37,0xE0],91:[0x5B,0x39,0xE0],92:[0x5C,0x3B,0xE0],93:[0x5D,0x3D,0xE0],94:[0x5E,0x3F,0xE0],
  95:[0x5F,0x41,0xE0],96:[0x60,0x47,0xE0],97:[0x61,0x4B,0xE0],98:[0x62,0x4F,0xE0],99:[0x63,0x53,0xE0],
};

const VIBRATO_DEPTH_TABLE = {
  25:[0x19,0x00,0x1A],26:[0x1A,0x00,0x1B],27:[0x1B,0x00,0x1C],28:[0x1C,0x00,0x1D],29:[0x1D,0x00,0x1E],
  30:[0x1E,0x00,0x1F],31:[0x1F,0x00,0x20],32:[0x20,0x00,0x23],33:[0x21,0x00,0x25],34:[0x22,0x00,0x27],
  35:[0x23,0x00,0x29],36:[0x24,0x00,0x2B],37:[0x25,0x00,0x2D],38:[0x26,0x00,0x2F],39:[0x27,0x00,0x31],
  40:[0x28,0x00,0x33],41:[0x29,0x00,0x35],42:[0x2A,0x00,0x37],43:[0x2B,0x00,0x39],44:[0x2C,0x00,0x3B],
  45:[0x2D,0x00,0x3D],46:[0x2E,0x00,0x3F],47:[0x2F,0x00,0x41],48:[0x30,0x00,0x47],49:[0x31,0x00,0x4B],
  50:[0x32,0x00,0x4F],51:[0x33,0x00,0x53],52:[0x34,0x00,0x57],53:[0x35,0x00,0x5B],54:[0x36,0x00,0x5F],
  55:[0x37,0x00,0x63],56:[0x38,0x00,0x67],57:[0x39,0x00,0x6B],58:[0x3A,0x00,0x6F],59:[0x3B,0x00,0x73],
  60:[0x3C,0x00,0x77],61:[0x3D,0x00,0x7B],62:[0x3E,0x00,0x7F],63:[0x3F,0x00,0x83],64:[0x40,0x00,0x8F],
  65:[0x41,0x00,0x97],66:[0x42,0x00,0x9F],67:[0x43,0x00,0xA7],68:[0x44,0x00,0xAF],69:[0x45,0x00,0xB7],
  70:[0x46,0x00,0xBF],71:[0x47,0x00,0xC7],72:[0x48,0x00,0xCF],73:[0x49,0x00,0xD7],74:[0x4A,0x00,0xDF],
  75:[0x4B,0x00,0xE7],76:[0x4C,0x00,0xEF],77:[0x4D,0x00,0xF7],78:[0x4E,0x00,0xFF],79:[0x4F,0x01,0x07],
  80:[0x50,0x01,0x1F],81:[0x51,0x01,0x2F],82:[0x52,0x01,0x3F],83:[0x53,0x01,0x4F],84:[0x54,0x01,0x5F],
  85:[0x55,0x01,0x6F],86:[0x56,0x01,0x7F],87:[0x57,0x01,0x8F],88:[0x58,0x01,0x9F],89:[0x59,0x01,0xAF],
  90:[0x5A,0x01,0xBF],91:[0x5B,0x01,0xCF],92:[0x5C,0x01,0xDF],93:[0x5D,0x01,0xEF],94:[0x5E,0x01,0xFF],
  95:[0x5F,0x02,0x0F],96:[0x60,0x02,0x3F],97:[0x61,0x02,0x5F],98:[0x62,0x02,0x7F],99:[0x63,0x03,0x00],
};

function vibratoDelayBytes(v) {
  v = clampInt(v, 0, 99);
  if (v <= 24) return [v, 0x00, v];
  return VIBRATO_DELAY_TABLE[v];
}
function vibratoRateBytes(v) {
  v = clampInt(v, 0, 99);
  if (v <= 24) {
    const combined = 0x20 * (v + 1);
    return [v, (combined >> 8) & 0xff, combined & 0xff];
  }
  return VIBRATO_RATE_TABLE[v];
}
function vibratoDepthBytes(v) {
  v = clampInt(v, 0, 99);
  if (v <= 24) return [v, 0x00, v + 1];
  return VIBRATO_DEPTH_TABLE[v];
}

// ---------------------------------------------------------------------
// Sections 8 & 17: DCO waveform ("line") select + modulation
// ---------------------------------------------------------------------
// The 8 selectable "lines" per oscillator are, per the manual: SAW, SQUARE,
// PULSE, DOUBLE SINE, SAW-PULSE, and three resonant lines (RESO 1/2/3).
// Values 1-5 map to clean, unambiguous 3-bit codes. Values 6-8 (the
// resonant lines) share a base code and are disambiguated with 2 extra
// bits, per the source table.
//
// CONFIDENCE NOTE: the source ASCII table places the "first oscillator"
// 3-bit code, a constant marker bit, a constant zero bit, a 2-bit
// extension (used only for values 6-8), a 3-bit modulation field, and a
// trailing 3-bit field in one 16-bit word - but the table's layout makes it
// ambiguous whether the "second" (line-select-only-used-when-combining-two-
// lines) waveform's own 6/7/8 extension lives in that same 2-bit slot or in
// the trailing 3-bit field. Values 1-5 for both "first" and "second" are
// unambiguous and solid. If you only use lines 1-5 (SAW/SQUARE/PULSE/
// DBLSINE/SAWPULSE) - which covers the vast majority of classic CZ patches -
// this is exact. If you dial in a resonant line (6/7/8) for the *second*
// line of a combined line-select and it comes out wrong on the hardware,
// that's the spot to fix; the encoder isolates the guess in one place
// (SECOND_EXT_IN_TRAILING_FIELD below) so it's a one-line change to try
// the alternative placement.
const SECOND_EXT_IN_TRAILING_FIELD = true;

const WAVE_BASE_CODE = { 1: 0b000, 2: 0b001, 3: 0b010, 4: 0b100, 5: 0b101, 6: 0b110, 7: 0b110, 8: 0b110 };
const WAVE_EXT = { 6: 0b01, 7: 0b10, 8: 0b11 }; // only meaningful for 6/7/8

const MODULATION_CODE = { none: 0b000, ring: 0b100, noise: 0b011 };

/**
 * Encode a DCO waveform word (used for both MFW/DCO1 and, with
 * modulation forced to 'none', SFW/DCO2).
 * first/second: 1-8 (line-select waveform choices)
 * modulation: 'none' | 'ring' | 'noise' (ignored - should be 'none' - for DCO2)
 * Returns [byte1, byte2].
 */
export function waveformBytes(first, second, modulation = "none") {
  const firstCode = WAVE_BASE_CODE[first] ?? WAVE_BASE_CODE[1];
  const secondCode = WAVE_BASE_CODE[second] ?? WAVE_BASE_CODE[1];
  const firstExt = WAVE_EXT[first] ?? 0b00;
  const secondExt = WAVE_EXT[second] ?? 0b00;
  const modCode = MODULATION_CODE[modulation] ?? MODULATION_CODE.none;

  // 16-bit word, MSB-first as drawn in the source table:
  // [firstCode:3][secondCode:3][const1:1][const0:1][ext2:2][mod:3][trail:3]
  let ext2 = firstExt;
  let trail = 0b000;
  if (SECOND_EXT_IN_TRAILING_FIELD) {
    trail = secondExt;
  } else {
    ext2 = ext2 | secondExt; // best-effort fallback if you flip the flag
  }

  const word =
    (firstCode << 13) |
    (secondCode << 10) |
    (0b1 << 9) |
    (0b0 << 8) |
    (ext2 << 6) |
    (modCode << 3) |
    trail;

  return [(word >> 8) & 0xff, word & 0xff];
}

// ---------------------------------------------------------------------
// Sections 9/10, 18/19: key follow (DCA and DCW)
// ---------------------------------------------------------------------

const DCA_KEYFOLLOW_2ND = [0x00, 0x08, 0x11, 0x1a, 0x24, 0x2f, 0x3a, 0x45, 0x52, 0x5f];
const DCW_KEYFOLLOW_2ND = [0x00, 0x1f, 0x2c, 0x39, 0x46, 0x53, 0x60, 0x6e, 0x92, 0xff];

export function dcaKeyFollowBytes(amount) {
  const v = clampInt(amount, 0, 9);
  return [v, DCA_KEYFOLLOW_2ND[v]];
}
export function dcwKeyFollowBytes(amount) {
  const v = clampInt(amount, 0, 9);
  return [v, DCW_KEYFOLLOW_2ND[v]];
}

// ---------------------------------------------------------------------
// Envelopes: DCA (amplitude), DCW (waveform/tone), DCO (pitch)
// ---------------------------------------------------------------------
// Each envelope is 8 stages of {rate: 0-99, level: 0-99}. DCA and DCW
// stages also carry a per-stage "sustain" flag (DCW only, per spec) and
// both DCA/DCW auto-derive a "level is falling" bit by comparing each
// stage's level to the previous stage's level (0 for the first stage).

// --- DCA (amplitude envelope): sections 11/12 and 20/21 ---
function dcaRateByte(r) {
  r = clampInt(r, 0, 99);
  if (r <= 0) return 0x00;
  if (r >= 99) return 0x7f;
  return Math.floor((119 * r) / 99);
}
function dcaLevelByte(l) {
  l = clampInt(l, 0, 99);
  if (l <= 0) return 0x00;
  if (l >= 99) return 0x7f;
  return Math.floor((127 * l) / 99);
}
export function encodeDcaEnvelope(stages, endStep) {
  // stages: array of 8 {rate, level}
  const out = [clampInt(endStep, 0, 7)];
  let prevLevel = 0;
  for (let i = 0; i < 8; i++) {
    const { rate, level } = stages[i] ?? { rate: 0, level: 0 };
    let rateByte = dcaRateByte(rate);
    if (level < prevLevel) rateByte |= 0x80; // falling this step
    out.push(rateByte, dcaLevelByte(level));
    prevLevel = level;
  }
  return out; // 17 bytes: [endStep, r0,l0, r1,l1, ... r7,l7]
}

// --- DCW (waveform/tone envelope): sections 13/14 and 22/23 ---
// CONFIDENCE NOTE: the source's rate formula literally reads
// "byte = 119*level/99 + 8", reusing the word "level" where context makes
// clear it means "rate" (the surrounding text says "the rate data is
// encoded differently"). We treat it as a rate formula. The exact byte for
// the top endpoint (rate 99) is stated as a special case in the source but
// the given override value doesn't square with the source's own units
// (it reads as decimal 77 in one place and looks like it should be hex
// 0x7F elsewhere); we use the plain formula through the full range, which
// lands at the same sensible max (0x7F) that DCA/DCO use. Worth an ear
// on a real CZ if you push a DCW stage's rate all the way to 99.
function dcwRateByte(r) {
  r = clampInt(r, 0, 99);
  return clampInt(Math.floor((119 * r) / 99) + 8, 8, 0x7f);
}
function dcwLevelByte(l, sustain) {
  const base = dcaLevelByte(l); // level encoding is identical to DCA's
  return sustain ? base | 0x80 : base;
}
export function encodeDcwEnvelope(stages, endStep) {
  const out = [clampInt(endStep, 0, 7)];
  let prevLevel = 0;
  for (let i = 0; i < 8; i++) {
    const { rate, level, sustain } = stages[i] ?? { rate: 0, level: 0, sustain: false };
    let rateByte = dcwRateByte(rate);
    if (level < prevLevel) rateByte |= 0x80;
    out.push(rateByte, dcwLevelByte(level, !!sustain));
    prevLevel = level;
  }
  return out;
}

// --- DCO (pitch envelope): sections 15/16 and 24/25 ---
function dcoRateByte(r) {
  r = clampInt(r, 0, 99);
  return clampInt(Math.floor((127 * r) / 99), 0, 0x7f);
}
function dcoLevelByte(l) {
  l = clampInt(l, 0, 99);
  if (l <= 63) return l;
  return 0x44 + (l - 64);
}
export function encodeDcoEnvelope(stages, endStep) {
  // No documented direction bit for the pitch envelope - the level byte
  // range itself (00-3F, then a gap, then 44-67) appears to carry that
  // information instead.
  const out = [clampInt(endStep, 0, 7)];
  for (let i = 0; i < 8; i++) {
    const { rate, level } = stages[i] ?? { rate: 0, level: 50 };
    out.push(dcoRateByte(rate), dcoLevelByte(level));
  }
  return out;
}

// ---------------------------------------------------------------------
// Full patch -> 256-byte section list -> nibblized SysEx body
// ---------------------------------------------------------------------

/**
 * patch shape (see patch.js for the canonical default/factory):
 * {
 *   octave, line, detune: {sign, fine, octave, note},
 *   vibrato: {wave, delay, rate, depth},
 *   osc1: {first, second, modulation},
 *   osc2: {first, second},
 *   dca1: {keyFollow, endStep, stages:[{rate,level}x8]},
 *   dcw1: {keyFollow, endStep, stages:[{rate,level,sustain}x8]},
 *   dco1: {endStep, stages:[{rate,level}x8]},
 *   dca2, dcw2, dco2: same shapes as the "1" versions
 * }
 */
// NOTE ON THE "256 BYTES" IN THE SOURCE DOC: the intro text says a voice
// dump is "a sequence of 256 bytes", but summing the source's own 25-section
// length table gives 128. 128 logical bytes, nibblized, is exactly 256
// nibbles on the wire - so the "256" almost certainly refers to the wire
// (nibble) count, and the per-section table (128 real bytes) is the one
// that's internally consistent. This function produces those 128 bytes;
// nibblize() then doubles it to 256 for transmission. A runtime check
// below will throw loudly if a future edit breaks that invariant, rather
// than silently sending a malformed dump to your synth.
export function encodePatchToBytes(patch) {
  const bytes = [];

  // 1: pflag
  bytes.push(pflagByte(patch.octave, patch.line));
  // 2: detune sign
  bytes.push(detuneSignByte(patch.detune.sign));
  // 3: detune depth (2 bytes)
  bytes.push(detuneFineByte(patch.detune.fine));
  bytes.push(detuneOctaveNoteByte(patch.detune.octave, patch.detune.note));
  // 4: vibrato wave
  bytes.push(vibratoWaveByte(patch.vibrato.wave));
  // 5-7: vibrato delay/rate/depth (3 bytes each)
  bytes.push(...vibratoDelayBytes(patch.vibrato.delay));
  bytes.push(...vibratoRateBytes(patch.vibrato.rate));
  bytes.push(...vibratoDepthBytes(patch.vibrato.depth));
  // 8: DCO1 waveform (+ modulation)
  bytes.push(...waveformBytes(patch.osc1.first, patch.osc1.second, patch.osc1.modulation));
  // 9: DCA1 key follow
  bytes.push(...dcaKeyFollowBytes(patch.dca1.keyFollow));
  // 10: DCW1 key follow
  bytes.push(...dcwKeyFollowBytes(patch.dcw1.keyFollow));
  // 11-12: DCA1 envelope
  bytes.push(...encodeDcaEnvelope(patch.dca1.stages, patch.dca1.endStep));
  // 13-14: DCW1 envelope
  bytes.push(...encodeDcwEnvelope(patch.dcw1.stages, patch.dcw1.endStep));
  // 15-16: DCO1 (pitch) envelope
  bytes.push(...encodeDcoEnvelope(patch.dco1.stages, patch.dco1.endStep));
  // 17: DCO2 waveform (modulation bits forced to 'none' per spec)
  bytes.push(...waveformBytes(patch.osc2.first, patch.osc2.second, "none"));
  // 18: DCA2 key follow
  bytes.push(...dcaKeyFollowBytes(patch.dca2.keyFollow));
  // 19: DCW2 key follow
  bytes.push(...dcwKeyFollowBytes(patch.dcw2.keyFollow));
  // 20-21: DCA2 envelope
  bytes.push(...encodeDcaEnvelope(patch.dca2.stages, patch.dca2.endStep));
  // 22-23: DCW2 envelope
  bytes.push(...encodeDcwEnvelope(patch.dcw2.stages, patch.dcw2.endStep));
  // 24-25: DCO2 (pitch) envelope
  bytes.push(...encodeDcoEnvelope(patch.dco2.stages, patch.dco2.endStep));

  if (bytes.length !== 128) {
    throw new Error(
      `CZ-101 voice encoding produced ${bytes.length} bytes, expected 128. ` +
        `This is an internal bug in sysex.js, not a bad patch value - please ` +
        `don't send this to hardware until it's fixed.`
    );
  }
  return bytes;
}

/**
 * Build the complete list of SysEx bytes (F0 ... F7) that carries a full
 * voice dump to the CZ, targeting the given program slot.
 *
 * channel: 0-15 (MIDI channel, zero-based)
 * program: 0x00-0x0F (preset - read only on real hardware, sending here is
 *          harmless but won't stick), 0x20-0x2F (internal 1-16),
 *          0x40-0x4F (cartridge 1-16), or 0x60 (temporary/edit buffer -
 *          recommended while you're auditioning sounds).
 * patch: the patch object described above.
 *
 * This sends the "here is voice data for program N" message in one shot
 * (format byte 0x20) rather than performing the full request/acknowledge
 * handshake documented for computer-initiated dumps. That's deliberate:
 * .syx patch files for the CZ have circulated for decades and are just
 * static one-shot SysEx blasts like this, which is strong evidence the
 * synth accepts an unsolicited dump without a live handshake. See midi.js
 * for a handshake-based variant used if you ask for it explicitly.
 */
export function buildVoiceDumpMessage(channel, program, patch) {
  const bytes = encodePatchToBytes(patch);
  const nibbles = nibblize(bytes);
  return new Uint8Array([
    0xf0, 0x44, 0x00, 0x00, 0x70 + (channel & 0x0f), 0x20, program & 0x7f,
    ...nibbles,
    0xf7,
  ]);
}
