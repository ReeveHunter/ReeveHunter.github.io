// knob.js
// A small rotary knob widget (drag vertically to change value) plus a
// ChoiceGroup widget for discrete switch-like parameters (the CZ-101's
// panel uses real switches, not knobs, for things like octave/line/
// waveform - so those are rendered as button rows instead of knobs).

export class Knob {
  /**
   * @param {object} opts
   * @param {string} opts.label
   * @param {number} [opts.min=0]
   * @param {number} [opts.max=99]
   * @param {number} opts.value
   * @param {(v:number)=>void} opts.onChange
   * @param {(v:number)=>string} [opts.format]
   */
  constructor({ label, min = 0, max = 99, value = 0, onChange, format }) {
    this.label = label;
    this.min = min;
    this.max = max;
    this.value = value;
    this.onChange = onChange;
    this.format = format ?? ((v) => String(v));
    this.el = this._build();
    this._renderAngle();
  }

  _build() {
    const wrap = document.createElement("div");
    wrap.className = "knob";

    const dial = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    dial.setAttribute("viewBox", "0 0 60 60");
    dial.classList.add("knob-dial");
    dial.innerHTML = `
      <circle cx="30" cy="30" r="26" class="knob-face"></circle>
      <line x1="30" y1="30" x2="30" y2="9" class="knob-pointer"></line>
    `;
    this.pointer = dial.querySelector(".knob-pointer");

    const labelEl = document.createElement("div");
    labelEl.className = "knob-label";
    labelEl.textContent = this.label;

    const valueEl = document.createElement("div");
    valueEl.className = "knob-value";
    this.valueEl = valueEl;

    wrap.append(labelEl, dial, valueEl);

    let dragStartY = null;
    let dragStartValue = null;
    const onMove = (e) => {
      if (dragStartY === null) return;
      const dy = dragStartY - e.clientY;
      const range = this.max - this.min;
      const delta = (dy / 140) * range;
      this.setValue(clamp(Math.round(dragStartValue + delta), this.min, this.max));
    };
    const onUp = () => {
      dragStartY = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    dial.addEventListener("pointerdown", (e) => {
      dragStartY = e.clientY;
      dragStartValue = this.value;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      e.preventDefault();
    });
    dial.addEventListener("wheel", (e) => {
      e.preventDefault();
      const dir = e.deltaY < 0 ? 1 : -1;
      this.setValue(clamp(this.value + dir, this.min, this.max));
    }, { passive: false });
    dial.tabIndex = 0;
    dial.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp" || e.key === "ArrowRight") this.setValue(clamp(this.value + 1, this.min, this.max));
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") this.setValue(clamp(this.value - 1, this.min, this.max));
      else return;
      e.preventDefault();
    });

    return wrap;
  }

  setValue(v, { silent = false } = {}) {
    this.value = clamp(v, this.min, this.max);
    this._renderAngle();
    if (!silent) this.onChange?.(this.value);
  }

  _renderAngle() {
    const frac = (this.value - this.min) / (this.max - this.min || 1);
    const angleDeg = -135 + frac * 270; // sweep from -135deg to +135deg
    this.pointer.setAttribute("transform", `rotate(${angleDeg} 30 30)`);
    this.valueEl.textContent = this.format(this.value);
  }
}

export class Stepper {
  /**
   * A compact numeric value control: drag the number up/down to change it,
   * or use the small arrows above/below to nudge by 1. Used for per-stage
   * rate/level fine control in the envelope editor.
   * @param {object} opts
   * @param {number} opts.value
   * @param {number} [opts.min=0]
   * @param {number} [opts.max=99]
   * @param {string} [opts.label]
   * @param {(v:number)=>void} opts.onChange
   */
  constructor({ value, min = 0, max = 99, label, onChange }) {
    this.min = min;
    this.max = max;
    this.value = value;
    this.onChange = onChange;

    this.el = document.createElement("div");
    this.el.className = "stepper";

    this.upBtn = document.createElement("button");
    this.upBtn.type = "button";
    this.upBtn.className = "stepper-arrow";
    this.upBtn.textContent = "▲";

    this.valueEl = document.createElement("div");
    this.valueEl.className = "stepper-value";
    this.valueEl.tabIndex = 0;

    this.downBtn = document.createElement("button");
    this.downBtn.type = "button";
    this.downBtn.className = "stepper-arrow";
    this.downBtn.textContent = "▼";

    this.el.append(this.upBtn, this.valueEl, this.downBtn);
    if (label) {
      const labelEl = document.createElement("div");
      labelEl.className = "stepper-label";
      labelEl.textContent = label;
      this.el.prepend(labelEl);
    }

    this.upBtn.addEventListener("click", () => this.setValue(this.value + 1));
    this.downBtn.addEventListener("click", () => this.setValue(this.value - 1));

    let dragStartY = null;
    let dragStartValue = null;
    const onMove = (e) => {
      if (dragStartY === null) return;
      const dy = dragStartY - e.clientY;
      this.setValue(Math.round(dragStartValue + dy / 3));
    };
    const onUp = () => {
      dragStartY = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    this.valueEl.addEventListener("pointerdown", (e) => {
      dragStartY = e.clientY;
      dragStartValue = this.value;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      e.preventDefault();
    });
    this.valueEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      this.setValue(this.value + (e.deltaY < 0 ? 1 : -1));
    }, { passive: false });
    this.valueEl.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp") this.setValue(this.value + 1);
      else if (e.key === "ArrowDown") this.setValue(this.value - 1);
      else return;
      e.preventDefault();
    });

    this._render();
  }

  setValue(v, { silent = false } = {}) {
    this.value = clamp(v, this.min, this.max);
    this._render();
    if (!silent) this.onChange?.(this.value);
  }

  _render() {
    this.valueEl.textContent = String(this.value);
  }
}

export class Dropdown {
  /**
   * @param {object} opts
   * @param {string} opts.label
   * @param {Array<{value:any, label:string}>} opts.choices
   * @param {any} opts.value
   * @param {(v:any)=>void} opts.onChange
   */
  constructor({ label, choices, value, onChange }) {
    this.choices = choices;
    this.onChange = onChange;
    this.el = document.createElement("label");
    this.el.className = "dropdown";
    const span = document.createElement("span");
    span.className = "dropdown-label";
    span.textContent = label;
    this.select = document.createElement("select");
    this.choices.forEach((choice, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = choice.label;
      this.select.appendChild(opt);
    });
    this.select.addEventListener("change", () => {
      this.value = this.choices[Number(this.select.value)].value;
      this.onChange?.(this.value);
    });
    this.el.append(span, this.select);
    this.setValue(value, { silent: true });
  }

  setValue(v, { silent = false } = {}) {
    this.value = v;
    const idx = this.choices.findIndex((c) => c.value === v);
    if (idx >= 0) this.select.value = String(idx);
    if (!silent) this.onChange?.(this.value);
  }
}

export class RateSlider {
  /**
   * A "press and hold" slider for continuous scaling (used by the envelope
   * Stretch/Scale tools). Dragging away from center doesn't set a value
   * directly - it sets a *rate and direction* of ongoing change, applied
   * via onTick() on every animation frame for as long as the slider is
   * held away from center. Releasing snaps the handle back to center
   * (only the control resets - whatever changes were already applied
   * stay). Farther from center = faster change, center = no change, so a
   * small nudge and a big sweep both come from the same control without
   * having to type a target percentage first.
   * @param {object} opts
   * @param {string} [opts.label]
   * @param {"horizontal"|"vertical"} [opts.orientation="horizontal"]
   * @param {() => void} [opts.onStart] - fires once when a drag begins
   * @param {(direction:number, dtSeconds:number) => void} opts.onTick - direction is -1 (full left/down) .. 1 (full right/up)
   */
  constructor({ label, orientation = "horizontal", onStart, onTick }) {
    this.onStart = onStart;
    this.onTick = onTick;
    const vertical = orientation === "vertical";

    this.el = document.createElement("div");
    this.el.className = "rate-slider" + (vertical ? " rate-slider-vertical" : "");

    if (label) {
      const labelEl = document.createElement("div");
      labelEl.className = "rate-slider-label";
      labelEl.textContent = label;
      this.el.appendChild(labelEl);
    }

    this.input = document.createElement("input");
    this.input.type = "range";
    this.input.min = "-100";
    this.input.max = "100";
    this.input.value = "0";
    this.input.className = "rate-slider-input" + (vertical ? " rate-slider-input-vertical" : "");

    if (vertical) {
      // With -webkit-appearance:slider-vertical (see style.css), the track's
      // max sits at the top and min at the bottom - so "grow" (max, +100)
      // belongs above the track and "shrink" (min, -100) below it, instead
      // of the horizontal layout's side-by-side hint row.
      const grow = document.createElement("span");
      grow.className = "rate-slider-hint-vert";
      grow.textContent = "grow";
      const shrink = document.createElement("span");
      shrink.className = "rate-slider-hint-vert";
      shrink.textContent = "shrink";
      this.el.append(grow, this.input, shrink);
    } else {
      this.el.appendChild(this.input);
      const hint = document.createElement("div");
      hint.className = "rate-slider-hint";
      const shrink = document.createElement("span");
      shrink.textContent = "shrink";
      const grow = document.createElement("span");
      grow.textContent = "grow";
      hint.append(shrink, grow);
      this.el.appendChild(hint);
    }

    let raf = null;
    let lastT = null;
    const tick = (t) => {
      if (lastT == null) lastT = t;
      const dt = (t - lastT) / 1000;
      lastT = t;
      const direction = Number(this.input.value) / 100;
      if (direction !== 0) this.onTick?.(direction, dt);
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (raf != null) return;
      lastT = null;
      this.onStart?.();
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (raf != null) cancelAnimationFrame(raf);
      raf = null;
      lastT = null;
      this.input.value = "0";
    };
    this.input.addEventListener("pointerdown", start);
    window.addEventListener("pointerup", stop);
    this.input.addEventListener("pointercancel", stop);
    // Arrow keys don't produce pointerdown/up, so keyboard users get a
    // single discrete nudge per key press (as if held briefly) instead of
    // true continuous hold.
    this.input.addEventListener("keydown", (e) => {
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      e.preventDefault();
      const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : -1;
      this.onStart?.();
      this.onTick?.(dir, 0.15);
      this.input.value = "0";
    });
  }
}

export class ChoiceGroup {
  /**
   * @param {object} opts
   * @param {string} opts.label
   * @param {Array<{value:any, label:string}>} opts.choices
   * @param {any} opts.value
   * @param {(v:any)=>void} opts.onChange
   */
  constructor({ label, choices, value, onChange }) {
    this.choices = choices;
    this.value = value;
    this.onChange = onChange;
    this.el = document.createElement("div");
    this.el.className = "choice-group";
    const labelEl = document.createElement("div");
    labelEl.className = "choice-label";
    labelEl.textContent = label;
    this.row = document.createElement("div");
    this.row.className = "choice-row";
    this.el.append(labelEl, this.row);
    this._renderButtons();
  }

  _renderButtons() {
    this.row.innerHTML = "";
    this.buttons = this.choices.map((choice) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = choice.label;
      btn.className = "choice-btn" + (choice.value === this.value ? " active" : "");
      btn.addEventListener("click", () => this.setValue(choice.value));
      this.row.appendChild(btn);
      return btn;
    });
  }

  setValue(v, { silent = false } = {}) {
    this.value = v;
    this.buttons.forEach((btn, i) => btn.classList.toggle("active", this.choices[i].value === v));
    if (!silent) this.onChange?.(v);
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
