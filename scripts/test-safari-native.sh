#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
xcrun swiftc native/safari/SafariWebExtensionHandler.swift \
  native/safari/tests/AccountTransportCheck.swift -o "$test_dir/check"
"$test_dir/check"
