// iconpicker.js
// A small, reusable "graphical dropdown": a labeled button that shows the
// current choice as an icon, and opens a popup grid of every choice (icon
// + name) to pick from. Used anywhere a value is more recognizable as a
// shape than as a word: oscillator waveforms, the DCO1×DCO2 modulation
// type, and the vibrato waveform.
//
// This module knows nothing about what the icons look like - callers pass
// a renderIcon(value) function that builds one <svg> glyph. The icon
// drawing itself lives with the domain it belongs to (waveicons.js,
// paramicons.js).

/**
 * @param {object} opts
 * @param {string} [opts.label] - text shown above the control (e.g. "Line 1 waveform")
 * @param {Array<{value:any, label:string}>} opts.choices - in display order
 * @param {(value:any) => SVGElement} opts.renderIcon - builds one icon glyph for a given value
 * @param {any} opts.value - initial value
 * @param {(value:any) => void} [opts.onChange]
 * @returns {{el: HTMLElement, setValue: (v:any) => void}}
 */
export function createIconDropdown({ label, choices, renderIcon, value, onChange }) {
  const wrap = document.createElement("div");
  wrap.className = "icon-dropdown";

  if (label) {
    const labelEl = document.createElement("span");
    labelEl.className = "dropdown-label";
    labelEl.textContent = label;
    wrap.appendChild(labelEl);
  }

  const picker = document.createElement("div");
  picker.className = "icon-picker";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "icon-picker-btn";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.title = label ? `Choose ${label.toLowerCase()}` : "Choose a value";
  let btnIcon = renderIcon(value);
  btn.appendChild(btnIcon);

  const menu = document.createElement("div");
  menu.className = "icon-picker-menu";
  menu.setAttribute("role", "listbox");

  const optionEls = [];
  choices.forEach(({ value: v, label: optLabel }) => {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = "icon-picker-option";
    opt.setAttribute("role", "option");
    opt.appendChild(renderIcon(v));
    const lab = document.createElement("span");
    lab.className = "icon-picker-option-label";
    lab.textContent = optLabel;
    opt.appendChild(lab);
    opt.addEventListener("click", () => {
      setValue(v);
      closeMenu();
      onChange?.(v);
    });
    menu.appendChild(opt);
    optionEls.push({ v, opt });
  });

  function setActive(v) {
    optionEls.forEach(({ v: ov, opt }) => opt.classList.toggle("active", ov === v));
  }
  setActive(value);

  function onDocClick(e) {
    if (!picker.contains(e.target)) closeMenu();
  }
  function onKeydown(e) {
    if (e.key === "Escape") closeMenu();
  }
  function openMenu() {
    menu.classList.add("open");
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onKeydown, true);
  }
  function closeMenu() {
    menu.classList.remove("open");
    document.removeEventListener("click", onDocClick, true);
    document.removeEventListener("keydown", onKeydown, true);
  }
  btn.addEventListener("click", () => (menu.classList.contains("open") ? closeMenu() : openMenu()));

  picker.append(btn, menu);
  wrap.appendChild(picker);

  function setValue(v) {
    const next = renderIcon(v);
    btn.replaceChild(next, btnIcon);
    btnIcon = next;
    setActive(v);
  }

  return { el: wrap, setValue };
}
