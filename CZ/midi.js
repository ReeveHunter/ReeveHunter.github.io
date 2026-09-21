// midi.js
// Thin Web MIDI wrapper: port discovery, connecting, and sending a voice
// dump. Web MIDI with SysEx access only works in Chromium-based browsers
// (Chrome, Edge, Brave, Opera) - Safari and Firefox don't implement the
// sysex permission. If navigator.requestMIDIAccess is missing entirely,
// callers should tell the user to switch browsers rather than retry.

import { buildVoiceDumpMessage, decodeVoiceDumpMessage } from "./sysex.js";

export function hex(bytes) {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
}

export class CzMidi {
  constructor() {
    this.access = null;
    this.output = null;
    this.input = null;
    /** @type {(msg: string) => void} */
    this.onLog = () => {};
    /** Fired whenever an incoming SysEx message decodes as a full CZ voice
     * dump - e.g. the CZ-101 sending its current sound after you press SEND
     * on the front panel with this computer wired in as its MIDI input.
     * Not fired for other SysEx traffic (the handshake's "ready" reply,
     * anything from a different device). Set by app.js.
     * @type {(result: {channel:number, program:number, patch:object}) => void} */
    this.onVoiceDump = () => {};
  }

  get isSupported() {
    return typeof navigator !== "undefined" && !!navigator.requestMIDIAccess;
  }

  async requestAccess() {
    if (!this.isSupported) {
      throw new Error(
        "This browser doesn't support Web MIDI. Use Chrome, Edge, Brave, or Opera."
      );
    }
    this.access = await navigator.requestMIDIAccess({ sysex: true });
    this.access.onstatechange = () => this.onLog("MIDI devices changed");
    return this.access;
  }

  listOutputs() {
    if (!this.access) return [];
    return Array.from(this.access.outputs.values());
  }

  listInputs() {
    if (!this.access) return [];
    return Array.from(this.access.inputs.values());
  }

  setOutputById(id) {
    this.output = this.listOutputs().find((o) => o.id === id) ?? null;
  }

  setInputById(id) {
    if (this._inputListener && this.input) {
      this.input.removeEventListener("midimessage", this._inputListener);
    }
    this.input = this.listInputs().find((i) => i.id === id) ?? null;
    if (this.input) {
      this._inputListener = (e) => this._handleIncoming(e);
      this.input.addEventListener("midimessage", this._inputListener);
    }
  }

  _handleIncoming(e) {
    const data = e.data;
    if (data[0] === 0xf0) {
      this.onLog(`received: ${hex(data)}`);
      if (this._waitingResolve) {
        const resolve = this._waitingResolve;
        this._waitingResolve = null;
        resolve(data);
      }
      // Separately from the handshake wait above, see if this is a full
      // voice dump on its own (e.g. an unsolicited SEND from the CZ's front
      // panel, not requested by us) and hand it off if so. Anything that
      // isn't shaped like a voice dump (the handshake's own "ready" reply,
      // some other device's SysEx) just gets the log line above and is
      // otherwise ignored here.
      const result = decodeVoiceDumpMessage(data);
      if (!result.error) this.onVoiceDump(result);
    }
  }

  /** Resolves with the next incoming SysEx message, or null on timeout. */
  _waitForSysex(timeoutMs) {
    return new Promise((resolve) => {
      this._waitingResolve = resolve;
      setTimeout(() => {
        if (this._waitingResolve === resolve) {
          this._waitingResolve = null;
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  /**
   * Send a full voice dump for `patch` to `program` on `channel` (0-15).
   *
   * mode: "blind" (default) sends the one-shot unsolicited dump message,
   * matching how a .syx patch file gets played into the synth. mode:
   * "handshake" additionally performs the documented request/ready
   * exchange first - only useful if you've also connected a MIDI INPUT
   * from the CZ back to this computer, and worth trying if "blind" doesn't
   * get a sound loaded.
   */
  async sendVoiceDump(channel, program, patch, { mode = "blind", timeoutMs = 1500 } = {}) {
    if (!this.output) throw new Error("No MIDI output selected.");

    if (mode === "handshake") {
      if (!this.input) {
        this.onLog("No MIDI input selected - falling back to a blind send.");
      } else {
        const initMsg = new Uint8Array([0xf0, 0x44, 0x00, 0x00, 0x70 + (channel & 0x0f), 0x10, program & 0x7f, 0xf7]);
        this.onLog(`sending init: ${hex(initMsg)}`);
        this.output.send(initMsg);
        const reply = await this._waitForSysex(timeoutMs);
        if (!reply) {
          this.onLog("No ready reply from the CZ - sending anyway.");
        } else {
          this.onLog(`got ready reply: ${hex(reply)}`);
        }
      }
    }

    const dump = buildVoiceDumpMessage(channel, program, patch);
    this.onLog(`sending voice dump (${dump.length} bytes) to program 0x${program.toString(16)}`);
    this.output.send(dump);
    return dump;
  }
}
