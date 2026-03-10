#!/usr/bin/env bash
# Install pi-airead extensions by symlinking them to ~/.pi/agent/extensions/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXTENSIONS_SRC="$SCRIPT_DIR/extensions"
EXTENSIONS_DST="$HOME/.pi/agent/extensions"

if [ ! -d "$EXTENSIONS_SRC" ]; then
  echo "Error: extensions directory not found at $EXTENSIONS_SRC" >&2
  exit 1
fi

mkdir -p "$EXTENSIONS_DST"

installed=0
for ext in "$EXTENSIONS_SRC"/*.ts; do
  [ -f "$ext" ] || continue
  name="$(basename "$ext")"
  target="$EXTENSIONS_DST/$name"

  if [ -L "$target" ]; then
    existing="$(readlink "$target")"
    if [ "$existing" = "$ext" ]; then
      echo "  skip: $name (already linked)"
      continue
    fi
    echo "  update: $name (relink)"
    rm "$target"
  elif [ -e "$target" ]; then
    echo "  skip: $name (file exists, not a symlink — remove it manually to install)"
    continue
  else
    echo "  install: $name"
  fi

  ln -s "$ext" "$target"
  installed=$((installed + 1))
done

if [ "$installed" -eq 0 ]; then
  echo "Nothing to install. All extensions are up to date."
else
  echo "Installed $installed extension(s) to $EXTENSIONS_DST"
fi
