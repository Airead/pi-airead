#!/usr/bin/env bash
# Install pi-airead extensions and prompts by symlinking them to ~/.pi/agent/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DST="$HOME/.pi/agent"

installed=0

# --- Install extensions ---
EXTENSIONS_SRC="$SCRIPT_DIR/extensions"
EXTENSIONS_DST="$AGENT_DST/extensions"

if [ -d "$EXTENSIONS_SRC" ]; then
  echo "Extensions:"
  mkdir -p "$EXTENSIONS_DST"

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
else
  echo "Warning: extensions directory not found at $EXTENSIONS_SRC" >&2
fi

# --- Install prompts ---
PROMPTS_SRC="$SCRIPT_DIR/prompts"
PROMPTS_DST="$AGENT_DST/prompts"

if [ -d "$PROMPTS_SRC" ]; then
  echo "Prompts:"
  mkdir -p "$PROMPTS_DST"

  for prompt in "$PROMPTS_SRC"/*.md; do
    [ -f "$prompt" ] || continue
    name="$(basename "$prompt")"
    target="$PROMPTS_DST/$name"

    if [ -L "$target" ]; then
      existing="$(readlink "$target")"
      if [ "$existing" = "$prompt" ]; then
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

    ln -s "$prompt" "$target"
    installed=$((installed + 1))
  done
else
  echo "Warning: prompts directory not found at $PROMPTS_SRC" >&2
fi

# --- Summary ---
if [ "$installed" -eq 0 ]; then
  echo "Nothing to install. Everything is up to date."
else
  echo "Installed $installed file(s) to $AGENT_DST"
fi
