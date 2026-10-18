# CLAUDE.md — Cynthcart Controller (reevehunter.com/C64)

A browser MIDI controller for **Cynthcart** on Reeve's Commodore 64 (Kerberos MIDI cartridge, 6581 SID). It only sends MIDI, so it can be public; the firmware it talks to lives in Reeve's **private** repo `~/Documents/GitHub/cynthcart-kerberos` (not on GitHub). Read that repo's `CLAUDE.md`, `docs/webapp-plan.md` (what this app does, decisions, file format) and `docs/midi-implementation.md` (every CC and SysEx message) before changing anything here.

## Facts to keep straight

- Static page, no build step, plain ES modules, no dependencies (Google Fonts only). Test locally with `python3 -m http.server` in the repo root and open `http://localhost:8000/C64/` in Chrome/Edge (Web MIDI needs `localhost` or HTTPS). Safari and every iOS browser have no Web MIDI; on an iPad Reeve needs a Web MIDI browser app.
- **Targets:** `sx` (custom build + SysEx: everything), `cc` (custom build without SysEx), `v20f` (Cynthcart 2.0.1F: stock 2.0.1 + bug fixes) and `v20` (stock 2.0). `supports()` / `why()` / `setupSupported()` in `engine.js` decide what each can reach; unreachable controls are greyed out, never hidden.
- **Cynthcart can't send anything back.** The page is the source of truth; changes made with the C64's keys aren't seen (Send patch / Send setup resync).
- On the Kerberos, Cynthcart must be flashed with **MIDI emulation = DATEL** (reevehunter.com/flash), or it receives nothing.
- MIDI on the wire is slow (~1 ms per 3-byte message) and SysEx stalls Cynthcart's main loop while it arrives, so live edits are coalesced (`midi.js`, 20 ms per parameter) and only patch loads use the big SysEx `03`.

## Files

| File | What |
|---|---|
| `engine.js` | No DOM. The patch model (`GLOBAL_PARAMS`, `VOICE_PARAMS`), presets → patches, `randomPatch(from, rnd, { keys, locks, link })` with the firmware's guards (`RANDOM_KEYS`; never volume, octave, tuning unless asked by key), the setup model (`PADDLE_MODES`, `FIRE_MODES`, `VID_STATES`, `DEFAULT_SETUP`, `setupMessages`), every MIDI/SysEx message per target (`editMessages`, `patchMessages`), the C64 header text (`headerRows`, value spans carry a third element = the key that makes them editable), and modulation timing (`VIB_HZ`, `trmHz`, `trmLevel`, `PASSES_PER_SEC` = 138). Imported by the firmware repo's tests (`tests/gen_webapp_patches.mjs` calls `randomPatch(from, rnd)` and `patchMessages`) — keep those signatures compatible. |
| `app.js` | The UI: control factories (`slider`, `seg`, `select`), lock buttons, card dice (`CARD_KEYS`), the Setup card, editing on the C64 screen (`SCREEN_SPECS` → sections of options or a range; drag = first section, click = menu `#pop`), the vibrato/tremolo pictures, library, keyboard (`KEYMAP`: Z/A rows lower octave, Q/number rows upper; base down to C0 = MIDI 12, since Cynthcart plays MIDI note − 12), connection, MIDI log. Every control registers `update()` in `controls`; `renderAll()` redraws everything after any change. |
| `midi.js` | Web MIDI access (asks for SysEx, falls back without), coalescing `queue`/`flush`, timed `sendSequence` for patch recall. |
| `presets.js` | Generated from the firmware's `cynthdata.asm` by `tools/make_presets_js.py` in the firmware repo. Don't hand-edit. |
| `filtergraph.js` | 6581 filter response (reSID curve), Cynthcart's cutoff steps, and the FILT1–5 animation using the firmware's own logic. |
| `index.html`, `style.css` | Layout; colors per header group (`--c-sys`, `--c-mod`, `--c-osc`, `--c-flt`, `--c-amp`), light and dark. |

**Storage** (localStorage, prefix `cynthcart.`): `settings` (output/input ids, channel, target, live, link, keyboard base, **locks**, **setup**), `library` (saved patches), `current`, `currentId`, `connected`.

## Rules that came from Reeve

- The dice never change volume, octave, tuning or the base preset; the Amplitude card's dice is the only way to randomize volume. Locked parameters are skipped. Linked voices get one value for all three.
- Paddles, paddle buttons, video and Cynthcart's MIDI channel are a setup, not part of patches. Setting Cynthcart to a channel also switches the page's channel.
- Keep the look of the C64 header (40 columns, same colors); everything on it is editable where the target allows.
- When the firmware's parameters, ranges or SysEx change, update `engine.js` here and the firmware docs together, and regenerate the firmware repo's `tests/webapp_patches.json`.

## Testing

- `node --input-type=module -e "const E = await import('./engine.js'); …"` for engine logic.
- Headless Chromium (Playwright) against `python3 -m http.server`: drag/click on screen values, the pop-up menu, locks + dice, card dice, Setup sends and channel switching, keyboard range, and no page errors. Real MIDI needs the C64; the firmware repo's emulator tests replay this app's patch messages.
