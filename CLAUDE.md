# CLAUDE.md — reevehunter.com

Reeve Hunter's site (GitHub Pages, custom domain in `CNAME`). Each top-level folder is its own small static project: plain HTML/CSS/JS, no build step, no shared framework. Reeve pushes to GitHub himself; commit locally and leave pushing to him. Before working on a project, read its folder's `CLAUDE.md` if it has one.

| Folder | What |
|---|---|
| `C64/` | **Cynthcart Controller** — Web MIDI editor for Cynthcart on Reeve's C64 (patches, setup, screen editing). Notes: `C64/CLAUDE.md`; the firmware is in Reeve's private local repo `cynthcart-kerberos`. |
| `flash/` | **Kerberos Flash** — flashes PRGs and EasyFlash CRTs to the Kerberos C64/C128 MIDI cartridge over Web MIDI (a port of Frank Buß's Kerberos App). Each slot stores a MIDI emulation; Cynthcart needs **DATEL / Siel / JMS** (with "None" the cartridge's MIDI is off). |
| `fatchip/` | **Fat Chip** tools. `fatchip/linktest/` = **Link Test**: one self-contained page that sends known MIDI bursts (notes, CCs/bends, clock, SysEx) to a Game Boy running Fat Chip GB (Setup > LINK TEST) and shows what its counters should read, to check what the MIDI adapter passes. Bursts must match `test/test_link.py` in the private local repo `~/Documents/GitHub/fat-chip-gb`. `fatchip/nes-lab/` = **NES Lab**: one self-contained page for testing MidiNES MIDI commands from the browser (voice tabs + on-screen keyboard, every CC as sliders snapped to real steps, Reeve's pitch-bend formula, a CC7 software envelope, numbered one-click experiments with a results sheet to paste back to Claude). Device facts: `fat-chip/notes/midines.md`, `midines-plugins.md`, `midines-drums.md`. Plans: `~/Documents/GitHub/fat-chip/fat-chip-brief.md`. |
| `CZ/` | CZ-101 Patch Editor — SysEx editor for the Casio CZ-101/1000/5000. |
| `sightreading/` | Sight Reading — piano sight-reading practice with a MIDI keyboard. |
| `stumped/` | Stumped — Game Boy-style Sokoban (WebAssembly build). |
| `tunes/` | Tunes — browse and play Reeve's songs. Intentionally unlinked from the rest of the site. |
| `projects/` | Projects in progress and ideas. Private-ish: not linked from home or tools. Its `style.css` is also used by `tools/`. |
| `tools/` | Index of the browser tools, grouped (music gear, flashers and tests, utilities, home), each with a one-color inline SVG icon. Add new tools here. |
| `music/` | Redirects to Bandcamp (home page links Bandcamp directly). |
| `games/` | Games page (links Stumped). |
| `genus/` | **Genus** prototype — first-person game on glued surfaces (WebGL 2 ray tracer in `genus.js`, no build). Brief: `projects/genus.html`. Unlinked except from the brief. |
| `math/` | Math resources: Baylor page link (CheckItBU/ is no longer linked). |
| `platecutter/` | **Plate Cutter** — cuts sequential-photography plates (Muybridge) into transparent PNG sequences for a music video. Three steps: (1) drag a box on the first frame of each row, the tool guesses the row; (2) frame by frame, drag 4 corners (uncut view) → OK → see the cut, with an edge tolerance per row (override per frame) or "cut exactly on the corners"; (3) ping-pong preview at 6 fps, align on picture content (±px cap) or frame edges, join rows, arrow-key nudges, zip export with an After Effects scrub expression. Kept deliberately bare-bones (Reeve's call). Analysis in `core.js` (no DOM; `guessRow`, `cutQuad`), UI in `app.js`. `project.json` keeps each frame's first `guess` beside Reeve's `quad`, for tuning the guessing. |
| `clock/`, `stopwatch/` | Classroom clock and exam stopwatch. |
| `dinner/`, `mixup/`, `feelings/` | Family dinner planner, group shuffler, feelings wheel. |
| `CheckItBU/` | CheckIt course material (`Cal-I`). |
| `assets/` | Shared images, favicon and the home page's styles. |

Web MIDI pages (`C64/`, `flash/`, `CZ/`, `sightreading/`, `fatchip/linktest/`) need Chrome, Edge or Opera on a computer (or a Web MIDI browser app on iPad), and `https://` or `localhost`. To try a page locally: `python3 -m http.server` in the repo root, then open `http://localhost:8000/<folder>/`.
