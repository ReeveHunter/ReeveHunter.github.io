# CLAUDE.md — reevehunter.com

Reeve Hunter's site (GitHub Pages, custom domain in `CNAME`). Each top-level folder is its own small static project: plain HTML/CSS/JS, no build step, no shared framework. Reeve pushes to GitHub himself; commit locally and leave pushing to him. Before working on a project, read its folder's `CLAUDE.md` if it has one.

| Folder | What |
|---|---|
| `C64/` | **Cynthcart Controller** — Web MIDI editor for Cynthcart on Reeve's C64 (patches, setup, screen editing). Notes: `C64/CLAUDE.md`; the firmware is in Reeve's private local repo `cynthcart-kerberos`. |
| `flash/` | **Kerberos Flash** — flashes PRGs and EasyFlash CRTs to the Kerberos C64/C128 MIDI cartridge over Web MIDI (a port of Frank Buß's Kerberos App). Each slot stores a MIDI emulation; Cynthcart needs **DATEL / Siel / JMS** (with "None" the cartridge's MIDI is off). |
| `CZ/` | CZ-101 Patch Editor — SysEx editor for the Casio CZ-101/1000/5000. |
| `sightreading/` | Sight Reading — piano sight-reading practice with a MIDI keyboard. |
| `stumped/` | Stumped — Game Boy-style Sokoban (WebAssembly build). |
| `tunes/` | Tunes — browse and play Reeve's songs. |
| `projects/` | Projects in progress and ideas (`ideas/` redirects here). |
| `math/` | Math resources and practice problems. |
| `clock/`, `stopwatch/` | Classroom clock and exam stopwatch. |
| `dinner/`, `mixup/`, `feelings/` | Family dinner planner, group shuffler, feelings wheel. |
| `CheckItBU/` | CheckIt course material (`Cal-I`). |
| `assets/` | Shared images, favicon and the home page's styles. |

Web MIDI pages (`C64/`, `flash/`, `CZ/`, `sightreading/`) need Chrome, Edge or Opera on a computer (or a Web MIDI browser app on iPad), and `https://` or `localhost`. To try a page locally: `python3 -m http.server` in the repo root, then open `http://localhost:8000/<folder>/`.
