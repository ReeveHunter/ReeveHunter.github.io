# patches/

Every patch here lives as a raw `.syx` file - one shared format for saving
your own work, sharing a sound with someone else, and pulling in whatever
`.syx` files you come across, rather than a separate app-specific shape.
That's what "Save patch (.syx)" and "Load patch (.syx)" in the MIDI panel
read and write, and it's the same format any CZ-101 SysEx librarian or the
hardware itself understands. It's also the *only* place the in-app Patch
Library's built-in starter set comes from: `library.js` is generated
straight from the files here (see "How library.js is built" below) rather
than containing any hand-authored patch data of its own.

```
patches/
  <source-name>/
    <voice>.syx     one voice's raw SysEx dump
    meta.json       optional: {"<filename>": {"tags": [...]}, "_default": {"tags": [...]}}
```

One subfolder per source, named for where the patches came from rather
than what they sound like:

- **`automagic/`** - this editor's own hand-built starter set (13 voices),
  designed directly in this editor's data model to cover a spread of
  classic CZ-101 territory - that distinctive phase-distortion brightness.
  Saved out as ordinary `.syx` files (via `buildVoiceDumpMessage()`) the
  same way "Save patch (.syx)" would, rather than living as JS literals.
- **`cz-230s-factory/`** - 100 factory-programmed voices from a real
  **Casio CZ-230S** (a pre-programmed CZ-101/CZ-1000 variant that added a
  built-in drum machine), exported to SysEx and shared publicly at
  [alphacharlie/CZ-Presets](https://github.com/alphacharlie/CZ-Presets) on
  GitHub. Casio's CZ-101, CZ-1000, and CZ-230S all speak the same voice
  SysEx format, so these load and decode cleanly as ordinary CZ-101
  voices. Named with each preset's number plus Casio's own real factory
  voice name (e.g. `00 - Brass Ens. 1.syx`, ... `99 - Sweep.syx`), sourced
  from the source repo's `CZ230Sindex.txt`. Also includes that source
  repo's own 7 "ready to import" bulk files (`CZ230S-00-15.syx`, etc., 16
  voices per file, matching how many the CZ-101/CZ-1000 can hold in
  internal memory at once) - copied in unmodified and left un-renamed,
  since each spans a range of voices already covered individually above.

  **Provenance / license note:** these are Casio's own factory ROM sounds
  from 1980s CZ hardware, not the GitHub uploader's original creative
  work - dumping and re-sharing factory patches like this is
  long-standing, widely tolerated practice in the vintage-synth
  community, and the source repo's own README explicitly frames them as
  ready to use. That said, the source repo doesn't carry an explicit
  open-source license file, so if you plan to redistribute this project
  more broadly (rather than just using it yourself), it's worth keeping
  that in mind.

Keeping each source in its own folder, unmodified, keeps this a faithful
archive of exactly what was downloaded (or, for `automagic/`, exactly
what this editor produced) - handy for provenance, and lets `sysex.js`'s
decoder be re-applied from scratch if it ever improves, without losing
anything.

(This used to also have a `patches/native/` folder of this editor's own
JSON patch format, one file per voice, with the source folders nested a
level deeper under `patches/sysex/` to distinguish the two formats - and
before that, the `automagic/` set lived only as hand-typed JS literals in
`library.js`, with the CZ-230S set baked into a separate generated
`cz230s-presets.js`. All of that's gone now: `sysex.js` can encode as
well as decode, so .syx is the only file format the app reads or writes
*and* the only place its built-in patches are defined, which made the
JSON copy, the `sysex/` nesting, the hand-typed literals, and the second
generated file all redundant.)

## How library.js is built

A `.syx` file's wire format has no room for a name or tags - just the
raw voice parameters - so that metadata has to live next to the file
instead. Each source folder can have its own `meta.json` mapping a
filename to `{"tags": [...]}`, plus an optional `"_default"` entry
applied to any file the map doesn't otherwise mention (that's all
`cz-230s-factory/meta.json` has, since all 100 of those share the same
two tags; `automagic/meta.json` gives each voice its own curated set). A
voice's *name* comes from its filename instead - stripping a leading
`"NN - "` index if there is one, so `"00 - Brass Ens. 1.syx"` becomes
"Brass Ens. 1" but `"Warm Bass.syx"` is already just "Warm Bass".

To regenerate `library.js`: for each subfolder here, decode every `.syx`
file with `decodeVoiceDumpMessage()` (skipping any file `splitSysexMessages()`
finds more than one voice in - a multi-voice bundle file like
`CZ230S-00-15.syx`, whose voices are already covered by their own
single-voice files), look up its name and tags as above, and emit a
`{id, name, tags, patch}` entry. `library.js` itself just exports the
resulting `FACTORY_PATCHES` array - see its own header comment, and
don't hand-edit it directly.

## Adding more

Found another free `.syx` file worth including, or want to add a new
hand-built voice permanently to the shipped app?

1. Drop the raw file(s) into a new `patches/<source-name>/` folder,
   unmodified (for something you designed yourself, "Save patch (.syx)"
   in the MIDI panel writes one straight out of the current patch).
2. Try it out immediately through the app itself, without touching
   `library.js` at all: MIDI panel → **Load patch (.syx)**, which decodes
   it, loads the first voice into the editor, and adds every voice in the
   file to the Patch Library tagged `imported`.
3. If you want it permanently in the shipped app's built-in set rather
   than something you load each time, add a `meta.json` entry for its
   tags (see "How library.js is built" above) and regenerate
   `library.js` from every `patches/*/` folder the same way.

Two SysEx dump shapes decode cleanly: this app's own one-shot format
(format byte `0x20`, with a program number) - how `automagic/`'s voices
are encoded, via the same `buildVoiceDumpMessage()` "Save patch (.syx)"
uses - and the CZ's own "here's the current voice" reply shape (format
byte `0x30`, no program number), which is how `cz-230s-factory/`'s dumps
turned out to be encoded. Anything else (a different format byte, a
non-Casio manufacturer ID) gets reported back as a per-message error
rather than crashing the import, so a mixed or partly-unsupported file
still imports whatever it can.
