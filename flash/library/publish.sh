#!/bin/bash
# Copies the latest Fat Chip builds into the flash library and records their
# versions in builds.json (shown in the Library panels).
# Run from anywhere:  ReeveHunter.github.io/flash/library/publish.sh
# Expects the fat-chip-gb and fat-chip-64 repos next to ReeveHunter.github.io.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repos="$(cd "$here/../../.." && pwd)"

# version from the newest commit subject that names one (e.g. "v0.07: ..."),
# date of that commit
info() {
  local repo="$1"
  local line
  line="$(git -C "$repo" log -50 --format='%h|%cs|%s' | grep -m1 -E 'v[0-9]+(\.[0-9]+)+' || true)"
  local commit="${line%%|*}"; local rest="${line#*|}"
  local date="${rest%%|*}"; local subject="${rest#*|}"
  local ver
  ver="$(printf '%s' "$subject" | grep -oE 'v[0-9]+(\.[0-9]+)+' | head -1)"
  printf '{"version": "%s", "date": "%s", "commit": "%s"}' "$ver" "$date" "$commit"
}

copy() { # repo-relative source, library destination
  cp "$1" "$here/$2"
  echo "  $2  ← $1"
}

echo "Copying builds into $here"
copy "$repos/fat-chip-gb/fat-chip-gb.gb" gb/fat-chip-gb.gb
copy "$repos/fat-chip-64/bin/fatchip64.prg" c64/fatchip64.prg

cat > "$here/builds.json" <<EOF
{
  "fat-chip-gb": $(info "$repos/fat-chip-gb"),
  "fat-chip-64": $(info "$repos/fat-chip-64")
}
EOF
echo "Wrote builds.json:"
cat "$here/builds.json"
