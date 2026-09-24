#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
test_dir=$(mktemp -d)
trap 'rm -rf "$test_dir"' EXIT
for check in AccountTransportCheck TranscriberCheck; do
  xcrun swiftc native/safari/SafariWebExtensionHandler.swift \
    "native/safari/tests/$check.swift" -o "$test_dir/$check"
  "$test_dir/$check"
done
