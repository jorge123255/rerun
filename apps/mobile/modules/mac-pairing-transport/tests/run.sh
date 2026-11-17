#!/bin/sh
# Checks the HTTP/1.1 part of the iPhone's pinned transport on this Mac, without building the app.
# That part of ios/MacPairingTransportModule.swift uses Foundation alone, so it is cut out below its
# MARK line and compiled with the checks in http.swift.  Usage: sh tests/run.sh [path to the module file]
set -e
here="$(cd "$(dirname "$0")" && pwd)"
source="${1:-$here/../ios/MacPairingTransportModule.swift}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
{ echo 'import Foundation'; sed -n '/^\/\/ MARK: HTTP\/1.1/,$p' "$source"; } > "$work/http.swift"
cp "$here/http.swift" "$work/main.swift"
swiftc -O -o "$work/checks" "$work/http.swift" "$work/main.swift"
"$work/checks"
