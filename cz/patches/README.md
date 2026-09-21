# patches/

Two kinds of patch files live here, kept in separate folders on purpose:

```
patches/
  sysex/    raw, unmodified .syx files exactly as they were sourced
  native/   this editor's own JSON patch format (what "Save patch (.json)"
            writes and "Load patch (.json)" reads)
```

**Why split them up:** a `.syx` file is a binary MIDI dump - useful for
sending straight to real hardware (or another CZ editor) with a SysEx
librarian, but opaque otherwise. This editor's native `.json` format is
the human-readable, directly-editable shape used everywhere else in the
app (the same shape `state.patch` has in memory). Keeping them apart means
`patches/sysex/` stays a faithful, untouched archive of exactly what was
downloaded - handy for provenance, and for re-decoding from scratch if the
decoder ever improves - while `patches/native/` is generated output you can
freely open, tweak by hand, or diff. Each gets its own subfolder per
source, so it's always clear where a given file came from.

Within each, one subfolder per source bank, e.g. `sysex/cz-230s-factory/`
and `native/cz-230s-factory/`, named for where the patches came from
rather than what they sound like (nobody's listened to most of these yet -
see below).

## What's here now: cz-230s-factory

100 factory-programmed voices from a real **Casio CZ-230S** (a
pre-programmed CZ-101/CZ-1000 variant that added a built-in drum machine),
exported to SysEx and shared publicly at
[alphacharlie/CZ-Presets](https://github.com/alphacharlie/CZ-Presets) on
GitHub. Casio's CZ-101, CZ-1000, and CZ-230S all speak the same voice
SysEx format, so these load and decode cleanly as ordinary CZ-101 voices.

- `sysex/cz-230s-factory/` - the 100 individual voice dumps (`00.syx` -
  `99.syx`, one voice each) plus the source repo's own 7 "ready to import"
  bulk files (`CZ230S-00-15.syx`, etc., 16 voices per file, matching how
  many the CZ-101/CZ-1000 can hold in internal memory at once) - copied
  in unmodified.
- `native/cz-230s-factory/` - the same 100 voices, decoded with this app's
  `decodeVoiceDumpMessage()`/`decodePatchFromBytes()` (see `sysex.js`) and
  written out as this editor's native JSON, one file per voice
  (`cz230s-00.json` - `cz230s-99.json`). Each one can be loaded directly
  via the "Load patch (.json)" button in the MIDI panel.
- All 100 are also baked directly into the in-app **Patch Library**
  (`cz230s-presets.js`, pulled into `library.js`), tagged `factory` and
  `cz-230s` so they're easy to filter to as a group. They're deliberately
  *not* tagged with guessed mood/category words like the hand-built
  patches are - that would mean making something up, since nobody's
  actually listened through all 100 yet. Give some a listen and add
  tags that fit!

**Provenance / license note:** these are Casio's own factory ROM sounds
from 1980s CZ hardware, not the GitHub uploader's original creative work -
dumping and re-sharing factory patches like this is long-standing, widely
tolerated practice in the vintage-synth community, and the source repo's
own README explicitly frames them as ready to use. That said, the source
repo doesn't carry an explicit open-source license file, so if you plan to
redistribute this project more broadly (rather than just using it
yourself), it's worth keeping that in mind.

## Adding more

Found another free `.syx` file worth including?

1. Drop the raw file(s) into a new `sysex/<source-name>/` folder, unmodified.
2. Decode it - either through the app itself (MIDI panel → **Import .syx**,
   which also drops it straight into the Patch Library tagged `imported`),
   or with a small script calling `decodeVoiceDumpMessage()` /
   `splitSysexMessages()` from `sysex.js` for a whole batch at once (see
   the generator that made `cz230s-presets.js`, if you want a starting
   point).
3. If you want it permanently in the shipped app rather than something
   you import each time, write the decoded voices out as native `.json`
   into a matching `native/<source-name>/` folder, and fold them into
   `library.js` (either hand-written, like the original 13, or as a
   generated module like `cz230s-presets.js`).

Two SysEx dump shapes decode cleanly: this app's own one-shot format
(format byte `0x20`, with a program number) and the CZ's own "here's the
current voice" reply shape (format byte `0x30`, no program number) - which
is how the cz-230s-factory files above turned out to be encoded. Anything
else (a different format byte, a non-Casio manufacturer ID) gets reported
back as a per-message error rather than crashing the import, so a mixed or
partly-unsupported file still imports whatever it can.
