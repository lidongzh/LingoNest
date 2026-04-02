#!/usr/bin/env bash

set -euo pipefail

PLUGIN_ID="lingonest"
PLUGIN_DATA_FILENAME="data.json"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_MODE="symlink"
FORCE="false"
OBSIDIAN_APP_CONFIG="${HOME}/Library/Application Support/obsidian/obsidian.json"
PRESERVED_DATA_PATH=""
PRESERVED_DATA_DIR=""

usage() {
  cat <<'EOF'
Usage:
  ./install.sh [ /path/to/ObsidianVault ] [--copy] [--force]

Behavior:
  If no vault path is provided, the script tries to detect the active vault from:
    ~/Library/Application Support/obsidian/obsidian.json

  Default mode creates a symlink from the current repo into:
    <vault>/.obsidian/plugins/lingonest

Options:
  --copy   Copy the built plugin files instead of creating a symlink.
  --force  Replace an existing plugin at the target path.

Notes:
  - The vault path must already exist if you provide one explicitly.
  - Automatic detection uses the active Obsidian vault when exactly one is open.
  - If multiple vaults are open or known, pass the vault path explicitly.
  - Existing plugin data.json is preserved across reinstall/--force.
  - Copy mode requires these files to exist in the repo root:
      manifest.json
      main.js
      styles.css
EOF
}

fail() {
  echo "Error: $*" >&2
  exit 1
}

require_file() {
  local path="$1"
  [[ -e "$path" ]] || fail "Required file not found: $path"
}

preserve_plugin_data() {
  local data_path="$1/$PLUGIN_DATA_FILENAME"
  if [[ ! -f "$data_path" ]]; then
    return
  fi

  PRESERVED_DATA_DIR="$(mktemp -d)"
  PRESERVED_DATA_PATH="$PRESERVED_DATA_DIR/$PLUGIN_DATA_FILENAME"
  cp "$data_path" "$PRESERVED_DATA_PATH"
}

restore_plugin_data() {
  local target_path="$1"
  if [[ -z "$PRESERVED_DATA_PATH" || ! -f "$PRESERVED_DATA_PATH" ]]; then
    return
  fi

  cp "$PRESERVED_DATA_PATH" "$target_path/$PLUGIN_DATA_FILENAME"
}

cleanup_preserved_data() {
  if [[ -n "$PRESERVED_DATA_DIR" && -d "$PRESERVED_DATA_DIR" ]]; then
    rm -rf "$PRESERVED_DATA_DIR"
  fi
}

trap cleanup_preserved_data EXIT

detect_default_vault() {
  [[ -f "$OBSIDIAN_APP_CONFIG" ]] || fail "No vault path provided and Obsidian config was not found at: $OBSIDIAN_APP_CONFIG"

  local detected
  if ! detected="$(node - "$OBSIDIAN_APP_CONFIG" <<'EOF'
const fs = require("fs");

const configPath = process.argv[2];
const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
const vaults = Object.values(raw.vaults ?? {}).filter(
  (vault) => vault && typeof vault.path === "string" && vault.path.trim()
);
const openVaults = vaults.filter((vault) => vault.open === true);

if (openVaults.length === 1) {
  process.stdout.write(openVaults[0].path);
  process.exit(0);
}

if (openVaults.length > 1) {
  process.stderr.write("Multiple open Obsidian vaults were found.");
  process.exit(2);
}

if (vaults.length === 1) {
  process.stdout.write(vaults[0].path);
  process.exit(0);
}

if (vaults.length > 1) {
  process.stderr.write("Multiple Obsidian vaults were found.");
  process.exit(3);
}

process.stderr.write("No Obsidian vaults were found.");
process.exit(4);
EOF
  )"; then
    fail "Could not determine a default vault. ${detected:-Pass the vault path explicitly.}"
  fi

  printf '%s\n' "$detected"
}

VAULT_PATH=""

for arg in "$@"; do
  case "$arg" in
    --copy)
      TARGET_MODE="copy"
      ;;
    --force)
      FORCE="true"
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      fail "Unknown option: $arg"
      ;;
    *)
      if [[ -n "$VAULT_PATH" ]]; then
        fail "Only one vault path may be provided."
      fi
      VAULT_PATH="$arg"
      ;;
  esac
done

if [[ -z "$VAULT_PATH" ]]; then
  VAULT_PATH="$(detect_default_vault)"
  echo "Detected Obsidian vault:"
  echo "  $VAULT_PATH"
fi

[[ -d "$VAULT_PATH" ]] || fail "Vault path does not exist: $VAULT_PATH"

OBSIDIAN_DIR="$VAULT_PATH/.obsidian"
PLUGINS_DIR="$OBSIDIAN_DIR/plugins"
TARGET_PATH="$PLUGINS_DIR/$PLUGIN_ID"

[[ -d "$OBSIDIAN_DIR" ]] || fail "Not an Obsidian vault: missing $OBSIDIAN_DIR"

mkdir -p "$PLUGINS_DIR"

if [[ -e "$TARGET_PATH" || -L "$TARGET_PATH" ]]; then
  if [[ "$FORCE" != "true" ]]; then
    fail "Target already exists: $TARGET_PATH (use --force to replace it)"
  fi
  preserve_plugin_data "$TARGET_PATH"
  rm -rf "$TARGET_PATH"
fi

if [[ "$TARGET_MODE" == "symlink" ]]; then
  ln -s "$SCRIPT_DIR" "$TARGET_PATH"
  restore_plugin_data "$TARGET_PATH"
  cat <<EOF
Installed LingoNest as a symlink:
  $TARGET_PATH -> $SCRIPT_DIR

Next steps:
  1. Run "npm run build" here after any code changes.
  2. In Obsidian, enable the LingoNest community plugin.
EOF
  exit 0
fi

require_file "$SCRIPT_DIR/manifest.json"
require_file "$SCRIPT_DIR/main.js"
require_file "$SCRIPT_DIR/styles.css"

mkdir -p "$TARGET_PATH"
cp "$SCRIPT_DIR/manifest.json" "$TARGET_PATH/manifest.json"
cp "$SCRIPT_DIR/main.js" "$TARGET_PATH/main.js"
cp "$SCRIPT_DIR/styles.css" "$TARGET_PATH/styles.css"
if [[ -f "$SCRIPT_DIR/versions.json" ]]; then
  cp "$SCRIPT_DIR/versions.json" "$TARGET_PATH/versions.json"
fi
restore_plugin_data "$TARGET_PATH"

cat <<EOF
Installed LingoNest by copying built files to:
  $TARGET_PATH

Copied files:
  manifest.json
  main.js
  styles.css
EOF
