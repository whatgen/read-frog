#!/usr/bin/env bash
# Bundle yt-dlp into the Safari extension so it can fetch YouTube audio for
# local AI subtitles, then re-sign the extension and app.
#
#   scripts/embed-safari-ytdlp.sh <path/to/App.app> <codesign identity or ->
set -euo pipefail
cd "$(dirname "$0")/.."

YTDLP_VERSION="2026.08.19"
YTDLP_SHA256="07e54b0865303c864006925913bce2604f8ee8cc6f18699bac9c309f9328a6d8"

app="$1"
identity="$2"
appex=$(find "$app/Contents/PlugIns" -maxdepth 1 -name "*.appex" | head -1)
[[ -d "$appex" ]] || { echo "No Safari extension found in $app" >&2; exit 1; }

# Official PyInstaller "onedir" build: unlike the one-file build it never
# extracts libraries at run time, which the hardened, sandboxed extension forbids.
cache=".safari/cache/yt-dlp-$YTDLP_VERSION"
if [[ ! -x "$cache/yt-dlp_macos" ]]; then
  mkdir -p "$cache"
  zip="$cache.zip"
  curl -fsSL -o "$zip" \
    "https://github.com/yt-dlp/yt-dlp/releases/download/$YTDLP_VERSION/yt-dlp_macos.zip"
  echo "$YTDLP_SHA256  $zip" | shasum -a 256 -c - >/dev/null
  ditto -x -k "$zip" "$cache"
  rm -f "$zip"
  # Apple silicon only: drop the x86_64 slices (halves the size).
  while IFS= read -r file; do
    if lipo -info "$file" 2>/dev/null | grep -q "x86_64.*arm64\|arm64.*x86_64"; then
      lipo -thin arm64 "$file" -output "$file.arm64" && mv "$file.arm64" "$file"
    fi
  done < <(find "$cache" -type f)
fi

# Resources (not Helpers): the bundle also carries non-code files, which may only
# be sealed as resources. Each Mach-O is signed on its own.
target="$appex/Contents/Resources/yt-dlp"
rm -rf "$target"
ditto "$cache" "$target"

entitlements=$(mktemp -d)
trap 'rm -rf "$entitlements"' EXIT
# Sign a detached copy: codesign refuses files inside PyInstaller's partial
# "Python.framework" ("bundle format is ambiguous"), yet the signature lives in
# the Mach-O itself.
while IFS= read -r file; do
  if file -b "$file" | grep -q "Mach-O"; then
    cp "$file" "$entitlements/binary"
    codesign --force --sign "$identity" --timestamp=none --identifier "$(basename "$file")" "$entitlements/binary"
    cat "$entitlements/binary" >"$file"
  fi
done < <(find "$target/_internal" -type f)
cat >"$entitlements/inherit.plist" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.app-sandbox</key><true/>
  <key>com.apple.security.inherit</key><true/>
</dict></plist>
EOF
# The helper runs inside the extension's sandbox rather than its own.
codesign --force --sign "$identity" --timestamp=none \
  --entitlements "$entitlements/inherit.plist" "$target/yt-dlp_macos"

# Re-seal the extension, then the app, keeping their original entitlements.
for bundle in "$appex" "$app"; do
  codesign -d --entitlements :- "$bundle" >"$entitlements/bundle.plist" 2>/dev/null
  codesign --force --sign "$identity" --timestamp=none -o runtime \
    --entitlements "$entitlements/bundle.plist" --preserve-metadata=identifier "$bundle"
done
codesign --verify --deep --strict "$app"
echo "Bundled yt-dlp $YTDLP_VERSION ($(du -sh "$target" | cut -f1))"
