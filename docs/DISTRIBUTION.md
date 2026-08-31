# Shipping the desktop app

What has to happen between `npm run build:mac` and somebody double-clicking the
downloaded file without macOS refusing to open it.

## There is no Xcode project, and there does not need to be

The desktop app is Electron, assembled by `electron-builder`. Nothing here is an
Xcode target: there is no `.xcodeproj`, no `.xcworkspace`, no `Package.swift`.
Opening `desktop/electron` in Xcode shows a folder of JavaScript.

Signing is already done, and Xcode would not do it differently — `electron-builder`
calls `codesign`, the same binary Xcode drives. The current build is signed:

```
Identifier=com.bvisible.ssh-manager
Authority=Developer ID Application: bVisible Sarl (BT249938WK)
Authority=Developer ID Certification Authority
Authority=Apple Root CA
```

Xcode is still needed, for exactly one thing: `notarytool`, which ships inside it.

## The missing step is notarization

```
$ spctl -a -vvv -t exec "dist/mac-arm64/SSH Manager.app"
rejected
source=Unnotarized Developer ID
```

Signed but not notarized means anyone who **downloads** the DMG is told macOS
"cannot check it for malicious software". It opens fine on the machine that built
it only because a locally produced file carries no quarantine attribute.

`electron-builder` already tries on every build and gives up quietly:

```
• skipped macOS notarization  reason=`notarize` options were unable to be generated
```

Nothing is missing from the configuration. What is missing is a credential, and
only the account holder can create one.

### Option A — an App Store Connect API key (preferred)

A key is revocable on its own, is not tied to a person's Apple ID, and works
unattended in CI.

1. App Store Connect → Users and Access → Integrations → App Store Connect API
2. Generate a key with the **Developer** role; download the `.p8` **once**
3. Keep the Key ID and Issuer ID

```bash
export APPLE_API_KEY=~/private_keys/AuthKey_XXXXXXXXXX.p8
export APPLE_API_KEY_ID=XXXXXXXXXX
export APPLE_API_ISSUER=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
npm run build:mac
```

### Option B — an app-specific password

1. appleid.apple.com → Sign-In and Security → App-Specific Passwords
2. Generate one for "notarytool"

```bash
export APPLE_ID=apple@bvisible.ch
export APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx
export APPLE_TEAM_ID=BT249938WK
npm run build:mac
```

Either way the build stops skipping, uploads, waits for Apple, and staples the
ticket. Expect a few minutes. Then confirm what a downloader will see:

```bash
spctl -a -vvv -t exec "dist/mac-arm64/SSH Manager.app"   # want: accepted
xcrun stapler validate "dist/SSH Manager-4.0.0-arm64.dmg"
```

Never commit the key or the password. They belong in the shell, or in GitHub
Actions secrets.

## The Mac App Store is a different product

Not a further step along this path — a different one, and this application does
not fit down it. Three reasons, in order of how hard they are to move.

**The certificates do not exist.** The keychain holds `Developer ID Application`
(direct distribution) and `Apple Development` (local builds). The store needs
`Apple Distribution` and `3rd Party Mac Developer Installer`. Those are a
request away, so this is the easy one.

**Two entitlements the app relies on are refused outright.** `resources/entitlements.mac.plist`
declares `com.apple.security.cs.disable-library-validation` and
`com.apple.security.cs.allow-unsigned-executable-memory`. Both are rejected by
App Store review. The first is what lets `ssh2` load its optional native
bindings; without it the crypto acceleration and `cpu-features` go.

**The sandbox removes the features people install this for.** A store build must
declare `com.apple.security.app-sandbox`, which this one does not. Under it:

| What the app does | Under the sandbox |
|---|---|
| Browses **your** filesystem — `fs.readdirSync` from `os.homedir()`, the left pane of the file browser | Only files the user picks one at a time through a system panel. The pane cannot exist. |
| Spawns external binaries — `ssh-keyscan` for host keys, `rsync` for `ssh_sync` | Not permitted. Both features go. |
| Opens SSH to any host and port you name | Allowed (`network.client`), the one part that survives intact. |
| Serves the interface on a local port | Allowed (`network.server`), but the token-in-URL handoff needs rethinking. |

So a store build would be an SSH client that cannot see your files, cannot sync,
and cannot check a host key. That is not a constrained version of this app; it is
a different, worse one wearing its name.

**Recommendation: notarized Developer ID, distributed as a DMG from GitHub
Releases and Homebrew.** It is the normal channel for developer tools, it costs
one credential, and it keeps every feature. If the store ever becomes a
requirement, it should be scoped as its own build target with its own honest
feature list — not as a flag on this one.
