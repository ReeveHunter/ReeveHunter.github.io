// midi.js
// Web MIDI: ports, a coalescing sender for live edits, timed sequences
// for patch recall, and MIDI-in pass-through.

export const hex = (m) => Array.from(m, (b) => b.toString(16).padStart(2, "0")).join(" ");

export class Midi {
  constructor() {
    this.access = null;
    this.sysexAllowed = false;
    this.output = null;
    this.input = null;
    this.onChange = () => {};
    this.onLog = () => {};
    this.onInput = () => {};
    // live edits: latest messages per key, flushed every FLUSH_MS
    this.pending = new Map();
    this.timer = null;
    this.voiceMask = 0; // custom build's voice selection as last sent (0 = all)
    this.restoreTimer = null;
    this.busyUntil = 0; // performance.now() until which a patch recall is still going out
    this.sentCount = 0;
  }

  get supported() {
    return typeof navigator !== "undefined" && !!navigator.requestMIDIAccess;
  }

  async connect() {
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: true });
      this.sysexAllowed = true;
    } catch (e) {
      // SysEx permission refused: plain MIDI still works for CCs and notes
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.sysexAllowed = false;
    }
    this.access.onstatechange = () => this.onChange();
    this.onChange();
  }

  outputs() { return this.access ? [...this.access.outputs.values()] : []; }
  inputs() { return this.access ? [...this.access.inputs.values()] : []; }

  setOutput(id) {
    this.output = this.outputs().find((o) => o.id === id) ?? null;
    this.voiceMask = -1; // unknown: resend the voice selection before the next per-voice edit
  }

  setInput(id) {
    if (this.input) this.input.onmidimessage = null;
    this.input = this.inputs().find((i) => i.id === id) ?? null;
    if (this.input) this.input.onmidimessage = (e) => this.onInput(e.data);
  }

  /** Send now (or at a DOMHighResTimeStamp). SysEx is dropped if not allowed. */
  send(msg, at) {
    if (!this.output) return false;
    if (msg[0] === 0xf0 && !this.sysexAllowed) return false;
    try {
      this.output.send(msg, at);
      this.sentCount++;
      this.onLog(msg);
      return true;
    } catch (e) {
      this.onLog(null, e.message);
      return false;
    }
  }

  /**
   * Queue a live edit. Only the latest messages per key go out, at most
   * every FLUSH_MS, so dragging a slider can't flood Cynthcart.
   * mask: custom build voice selection the messages need (undefined = any).
   */
  queue(key, msgs, mask, voiceSelectMsg) {
    this.pending.delete(key); // re-insert at the end, keeping send order sensible
    this.pending.set(key, { msgs, mask, voiceSelectMsg });
    if (!this.timer) this.timer = setTimeout(() => this.flush(), Midi.FLUSH_MS);
  }

  flush() {
    this.timer = null;
    const now = performance.now();
    if (now < this.busyUntil) { // a patch is still being sent: wait for it
      this.timer = setTimeout(() => this.flush(), this.busyUntil - now + 5);
      return;
    }
    let restore = null;
    for (const { msgs, mask, voiceSelectMsg } of this.pending.values()) {
      if (mask !== undefined && mask !== this.voiceMask) {
        this.send(voiceSelectMsg(mask));
        this.voiceMask = mask;
      }
      for (const m of msgs) this.send(m);
      if (mask !== undefined && mask !== 0) restore = voiceSelectMsg;
    }
    this.pending.clear();
    // after a moment, put the C64's voice selection back to "all"
    if (restore) {
      clearTimeout(this.restoreTimer);
      this.restoreTimer = setTimeout(() => {
        if (this.voiceMask !== 0) { this.send(restore(0)); this.voiceMask = 0; }
      }, Midi.RESTORE_MS);
    }
  }

  /** Send [{msg, delay}] with the delays (ms) between messages. */
  sendSequence(steps, endsOnAllVoices = false) {
    this.flush();
    let t = performance.now();
    for (const { msg, delay } of steps) {
      t += (delay || 0) + Midi.GAP_MS;
      this.send(msg, t);
    }
    this.busyUntil = t + 20;
    if (endsOnAllVoices) this.voiceMask = 0;
    return t - performance.now();
  }
}
Midi.FLUSH_MS = 20;
Midi.RESTORE_MS = 700;
Midi.GAP_MS = 1.5;
