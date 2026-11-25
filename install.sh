#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_DIR="${PI_AGENT_DIR:-$HOME/.pi/agent}"
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -h|--help)
      echo "Usage: ./install.sh [--dry-run]"
      echo "Symlinks extensions and themes into $PI_DIR and merges config templates (never touches auth.json / mcp-auth.json)."
      exit 0
      ;;
  esac
done

run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] $*"
  else
    "$@"
  fi
}

echo "Installing pi-extensions from $REPO_DIR -> $PI_DIR"
run mkdir -p "$PI_DIR/extensions" "$PI_DIR/themes"

# 1. Symlink extensions (live-editable from this repo)
for ext in "$REPO_DIR"/extensions/*.ts; do
  name="$(basename "$ext")"
  run ln -sfn "$ext" "$PI_DIR/extensions/$name"
  echo "  ext:   $name -> $ext"
done

# 2. Symlink themes
for theme in "$REPO_DIR"/themes/*.json; do
  name="$(basename "$theme")"
  run ln -sfn "$theme" "$PI_DIR/themes/$name"
  echo "  theme: $name -> $theme"
done

# 2b. Symlink APPEND_SYSTEM.md (global system prompt addendum, applies to both plain Pi and OptChat)
if [[ -f "$REPO_DIR/config/APPEND_SYSTEM.md" ]]; then
  run ln -sfn "$REPO_DIR/config/APPEND_SYSTEM.md" "$PI_DIR/APPEND_SYSTEM.md"
  echo "  sys:   APPEND_SYSTEM.md -> $REPO_DIR/config/APPEND_SYSTEM.md"
fi

# 3. Merge settings.json (preserves machine-specific keys like deviceId, lastChangelogVersion, extensionChangelogVersions)
if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] merge $REPO_DIR/config/settings.json -> $PI_DIR/settings.json"
else
  node -e '
    const fs = require("fs");
    const tplPath = process.argv[1];
    const dstPath = process.argv[2];
    const tpl = JSON.parse(fs.readFileSync(tplPath, "utf8"));
    let cur = {};
    if (fs.existsSync(dstPath)) {
      cur = JSON.parse(fs.readFileSync(dstPath, "utf8"));
    }
    const merged = { ...cur, ...tpl };
    // Remove legacy npm:pi-questions if present since ask-questions.ts is provided directly
    if (Array.isArray(merged.packages)) {
      merged.packages = merged.packages.filter((p) => p !== "npm:pi-questions");
    }
    // Remove legacy explicit extensions array so ~/.pi/agent/extensions auto-discovery is authoritative
    delete merged.extensions;
    fs.writeFileSync(dstPath, JSON.stringify(merged, null, 2) + "\n");
  ' "$REPO_DIR/config/settings.json" "$PI_DIR/settings.json"
  echo "  cfg:   merged settings.json"
fi

# 4. Copy mcp.json and models.json if missing (or update via --force-config in future)
for cfg in mcp.json models.json; do
  if [[ ! -f "$PI_DIR/$cfg" ]]; then
    run cp "$REPO_DIR/config/$cfg" "$PI_DIR/$cfg"
    echo "  cfg:   installed $cfg"
  else
    echo "  cfg:   kept existing $cfg (diff against config/$cfg if needed)"
  fi
done

# 5. Apply pi-better-devin-auth footer patch if installed and not yet applied
DEVIN_REPO="$PI_DIR/git/github.com/zhuasy/pi-better-devin-auth"
PATCH_FILE="$REPO_DIR/patches/pi-better-devin-auth-footer.patch"
if [[ -d "$DEVIN_REPO/.git" && -f "$PATCH_FILE" ]]; then
  if git -C "$DEVIN_REPO" apply --reverse --check "$PATCH_FILE" >/dev/null 2>&1; then
    echo "  patch: pi-better-devin-auth footer patch already applied"
  elif git -C "$DEVIN_REPO" apply --check "$PATCH_FILE" >/dev/null 2>&1; then
    run git -C "$DEVIN_REPO" apply "$PATCH_FILE"
    echo "  patch: applied pi-better-devin-auth footer patch"
  else
    echo "  patch: skipped pi-better-devin-auth (local diff or upstream changed)"
  fi
fi

echo ""
echo "Done. Run 'pi update --extensions' on a new machine to install packages, then '/reload' inside Pi."
