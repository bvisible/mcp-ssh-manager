#!/bin/bash
# Build SSH Manager.app — the desktop shell around the control plane.
#
# No Xcode project, no package manager: one Swift file, swiftc, and a bundle
# assembled by hand. Keeping it this small is the point — the window is a
# wrapper around a page the engine already serves.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${1:-$HERE/build/SSH Manager.app}"
VERSION="$(node -p "require('$HERE/../package.json').version")"

# Homebrew's Xcode may be older than the toolchain needed; prefer a beta when
# one is installed, as the released Xcode on this machine lags behind.
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode-beta.app ]; then
  export DEVELOPER_DIR=/Applications/Xcode-beta.app/Contents/Developer
fi

echo "Building SSH Manager.app ($VERSION)"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>SSH Manager</string>
  <key>CFBundleDisplayName</key><string>SSH Manager</string>
  <key>CFBundleIdentifier</key><string>com.bvisible.ssh-manager</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>SSHManager</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <!-- The page is served from 127.0.0.1 over plain HTTP: it never leaves the
       machine, and TLS on a loopback socket would only add a certificate to
       manage. Scoped to localhost so nothing else is exempted. -->
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

xcrun swiftc \
  -O \
  -target arm64-apple-macosx13.0 \
  -framework AppKit -framework WebKit \
  -o "$APP/Contents/MacOS/SSHManager" \
  "$HERE/ControlPlaneApp.swift"

# Ad-hoc signature: enough for the app to run on the machine that built it.
# A distributed build needs a Developer ID and notarisation.
codesign --force --sign - "$APP" 2>/dev/null || echo "  (unsigned — fine for local use)"

echo "Built: $APP"
du -sh "$APP" | awk '{print "  size: " $1}'
