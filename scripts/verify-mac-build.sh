#!/usr/bin/env bash
#
# Is this build actually shippable?
#
# Every failure this checks for has already happened here, and none of them were
# visible from the build log — which exited 0 each time:
#
#   - the engine shipped with an empty node_modules, so every downloaded copy
#     died on launch with "Cannot find package 'dotenv'"
#   - the menu-bar glyph was left out of the asar, which would have thrown
#     inside `new Tray` and taken the app down
#   - the app is signed but not notarized, so anyone who *downloads* it is told
#     macOS cannot check it — invisible on the machine that built it, because a
#     locally produced file carries no quarantine attribute
#
# Run it on the artifact you are about to publish, not on the tree that made it.
#
# Usage: scripts/verify-mac-build.sh [path/to/SSH Manager.app]
set -uo pipefail

APP="${1:-desktop/electron/dist/mac-arm64/SSH Manager.app}"
FAIL=0
pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }

[ -d "$APP" ] || { echo "No app at: $APP"; exit 1; }
echo "Checking $APP"
echo

# --- it is what it says it is ------------------------------------------------
# Read once into a variable, then match against that. Piping into `grep -q`
# under `set -o pipefail` is a trap: grep exits at the first match, codesign
# dies of SIGPIPE writing the rest, and the pipeline reports 141 — but only
# sometimes, depending on whether codesign had already finished. It reported a
# correctly signed app as unsigned on roughly every other run.
SIG=$(codesign -dv --verbose=2 "$APP" 2>&1)

ID=$(sed -n 's/^Identifier=//p' <<<"$SIG")
[ "$ID" = "com.bvisible.ssh-manager" ] \
  && pass "bundle identifier is $ID" \
  || fail "bundle identifier is '$ID', expected com.bvisible.ssh-manager"

if codesign --verify --deep --strict "$APP" 2>/dev/null; then
  pass "signature is valid, all the way down"
else
  fail "signature does not verify — codesign --verify --deep --strict failed"
fi

case "$SIG" in
  *"Authority=Developer ID Application"*)
    pass "signed with a Developer ID Application certificate" ;;
  *)
    fail "not signed with a Developer ID — it will not open on another machine" ;;
esac

# --- it will open on somebody else's machine ---------------------------------
GK=$(spctl -a -vvv -t exec "$APP" 2>&1)
if grep -q 'accepted' <<<"$GK"; then
  pass "Gatekeeper accepts it"
elif grep -q 'Unnotarized' <<<"$GK"; then
  fail "NOT NOTARIZED — a downloader gets \"cannot check it for malicious software\". See docs/DISTRIBUTION.md"
else
  fail "Gatekeeper rejects it: $(head -2 <<<"$GK" | tr '\n' ' ')"
fi

if xcrun stapler validate "$APP" >/dev/null 2>&1; then
  pass "the notarization ticket is stapled to the app"
else
  warn "no stapled ticket on the app (expected while unnotarized)"
fi

# And on the DMG, which is the file people actually download. electron-builder
# notarizes the .app *before* packaging it, so Apple has no ticket for the disk
# image and `stapler staple` on it fails with "could not find base64 encoded
# ticket". The DMG has to be submitted on its own — see docs/DISTRIBUTION.md.
DMG=$(ls -t "$(dirname "$APP")/../"*.dmg 2>/dev/null | head -1)
if [ -n "$DMG" ]; then
  if xcrun stapler validate "$DMG" >/dev/null 2>&1; then
    pass "and to the DMG, so it opens offline too"
  else
    warn "the DMG has no stapled ticket — it works, but Gatekeeper phones home"
  fi
fi

# --- it carries all of itself ------------------------------------------------
ENGINE="$APP/Contents/Resources/engine"
COUNT=$(ls "$ENGINE/node_modules" 2>/dev/null | wc -l | tr -d ' ')
[ "${COUNT:-0}" -ge 50 ] \
  && pass "the engine has its dependencies ($COUNT packages)" \
  || fail "the engine has $COUNT packages — it will die on 'Cannot find package'"

for module in dotenv ssh2 @modelcontextprotocol; do
  [ -e "$ENGINE/node_modules/$module" ] \
    && pass "  $module is present" \
    || fail "  $module is MISSING"
done

[ -f "$ENGINE/dist/ui/index.html" ] \
  && pass "the interface is bundled" \
  || fail "no dist/ui — the window would load nothing"

# --- the pieces the app reads at runtime -------------------------------------
ASAR="$APP/Contents/Resources/app.asar"
ASAR_LIST=$(npx --no-install asar list "$ASAR" 2>/dev/null || true)
case "$ASAR_LIST" in
  *trayTemplate.png*) pass "the menu-bar icon is in the asar" ;;
  '')                 warn "could not read the asar (is @electron/asar installed?)" ;;
  *)                  fail "trayTemplate.png is not packaged — there would be no menu bar item" ;;
esac

echo
if [ "$FAIL" -eq 0 ]; then
  printf '\033[32mReady to publish.\033[0m\n'
else
  printf '\033[31mNot shippable yet — see the failures above.\033[0m\n'
  exit 1
fi
