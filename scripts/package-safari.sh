#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# DEVELOPER_DIR can select Xcode without changing the machine-wide xcode-select.
if [[ -z "${DEVELOPER_DIR:-}" ]]; then
  DEVELOPER_DIR=$(xcode-select -p)
  # Command Line Tools lack the converter; prefer an installed Xcode instead.
  if [[ "$DEVELOPER_DIR" == */CommandLineTools && -d /Applications/Xcode.app ]]; then
    DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
  fi
fi
export DEVELOPER_DIR
if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  echo "safari-web-extension-converter not found in $DEVELOPER_DIR." >&2
  echo "Install full Xcode, open it once, or set DEVELOPER_DIR to its Developer directory." >&2
  exit 1
fi
pnpm build:safari
mkdir -p .safari
project_root=$(mktemp -d "$PWD/.safari/project.XXXXXX")
app_name="Read Frog Safari"
display_name="${SAFARI_DISPLAY_NAME:-陪读翻译蛙}"
bundle_id="${SAFARI_BUNDLE_ID:-app.readfrog.safari.local}"
xcrun safari-web-extension-converter "$PWD/.output/safari-mv3" \
  --project-location "$project_root" --app-name "$app_name" \
  --bundle-identifier "$bundle_id" --macos-only --swift --copy-resources \
  --no-open --no-prompt

# Xcode 27's converter can rewrite the containing app ID independently of its
# extension. Pin both generated target IDs so installation preserves extension data.
python3 scripts/fix-safari-project.py "$project_root/$app_name" "$bundle_id" "$display_name"

# Ad-hoc ("Sign to Run Locally") keeps the sandbox entitlements; a fully
# unsigned extension is never registered with Safari.
signing=(CODE_SIGN_STYLE=Manual CODE_SIGN_IDENTITY=- DEVELOPMENT_TEAM=)
if [[ -n "${SAFARI_TEAM_ID:-}" ]]; then
  signing=(CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY="Apple Development"
    DEVELOPMENT_TEAM="$SAFARI_TEAM_ID" -allowProvisioningUpdates)
fi
xcodebuild -project "$project_root/$app_name/$app_name.xcodeproj" \
  -scheme "$app_name" -configuration Release \
  -derivedDataPath "$PWD/.safari/DerivedData" \
  -destination "generic/platform=macOS" \
  CURRENT_PROJECT_VERSION="${SAFARI_BUILD_NUMBER:-1}" \
  MACOSX_DEPLOYMENT_TARGET="${SAFARI_MACOS_TARGET:-14.0}" "${signing[@]}" build
app_path="$PWD/.safari/DerivedData/Build/Products/Release/$app_name.app"
if [[ -n "${SAFARI_TEAM_ID:-}" ]]; then
  codesign --verify --deep --strict "$app_path"
fi
# Xcode registers the build product with Launch Services, which makes Safari
# list a duplicate extension next to the copy installed in /Applications.
lsregister=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
"$lsregister" -u "$app_path" 2>/dev/null || true
# Deliver the app under its display name; the bundle folder name is not signed.
output_path="$PWD/.safari/$display_name.app"
rm -rf "$output_path"
ditto "$app_path" "$output_path"
"$lsregister" -u "$output_path" 2>/dev/null || true
printf '\nSafari app: %s\n' "$output_path"
