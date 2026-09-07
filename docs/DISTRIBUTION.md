# Releasing SSH Manager

The npm engine remains compatible with Node 18+. Build the interface and desktop
applications with **Node 24**: Electron 44's build tools require Node 22.12 or newer.
The desktop release workflow builds macOS arm64/x64, Windows x64/arm64 (one NSIS
installer), and Linux x64 (AppImage and deb). Linux desktop support must pass its
first complete CI rehearsal before it is announced as available.

## Release gates

1. Merge the release changes through a pull request. Keep the existing required
   `lint`, `test (18.x)` and `test (20.x)` checks; also require the interface jobs
   before release. They build/typecheck the UI, compare it with committed
   `dist/ui`, run browser flows, and exercise an upgrade from the real npm 3.8.5.
2. Update root/desktop package manifests and lockfiles, plus both version fields
   in `server.json`. `scripts/release-version.mjs` checks their agreement.
3. For a candidate, use a version such as `4.0.0-rc.1` and its exact `v4.0.0-rc.1`
   tag. `release.yml` publishes with npm provenance to **next**, creates a draft
   prerelease on GitHub, and leaves stable Homebrew and npm `latest` alone.
4. Run **Release desktop apps** with `publish: false` against the candidate.
   Install the artifacts on clean machines and verify imports, old configuration,
   approvals, terminal, transfers, groups and persistence after restart. The CI
   smoke launches the packaged application with an isolated home, renders its
   real interface, writes a group outside the application, and runs a native PTY.
5. Verify an actual desktop update from an earlier installed candidate. A build
   or a download test alone does not prove quit/install/restart works. Confirm
   servers, vault, saved commands and groups survive. Stable clients must not be
   offered a candidate release.
6. Publish the desktop workflow against the **exact version tag** only when all
   candidates pass. It builds without upload credentials, signs, notarizes and
   staples, smoke tests, verifies signatures, regenerates final metadata and DMG
   blockmaps, and uploads validated CI artifacts. A separate job waits for every
   platform, verifies SHA256 manifests, uploads to the draft, then makes the
   release public. An already public release cannot have its installers replaced;
   use a new version.
7. For stable, repeat with `4.0.0`/`v4.0.0`. Apply the `homebrew-update` artifact
   from the npm release as a pull request and run the formula workflow before
   merging. The release workflow never pushes an unchecked commit onto `main`.
   Publish `server.json` to the MCP Registry from the same tag only after npm is
   available. Finally check npm dist-tags, GitHub assets/updater feeds, Homebrew
   version and Registry version from a fresh machine. The Registry workflow skips
   prereleases so a candidate cannot replace its stable listing.

The npm publish and desktop build are separate operations. If a desktop gate
fails after npm publication, npm may already be available but GitHub remains a
draft. Fix and re-run against the same unchanged tag, or issue a new version when
code changes; do not move a published version tag.

## macOS signing and notarization

The application is Electron; no Xcode project is involved. A Developer ID
Application certificate signs the app. Xcode command line tools provide
`codesign`, `notarytool` and `stapler`.

GitHub Actions uses the maintainer's existing secrets:

- `MAC_CERT_P12`: base64 encoded Developer ID certificate and private key.
- `MAC_CERT_PASSWORD`: its password.
- `APPLE_API_KEY`: base64 encoded App Store Connect `.p8` key.
- `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`: the matching key and issuer IDs.

Never commit these files or values. The workflow imports the certificate into an
isolated runner keychain and removes temporary key files on completion.

Electron Builder notarizes/staples the app before packaging. The workflow also
submits and staples **each DMG**. Stapling changes its bytes, so updater hashes
and `.dmg.blockmap` files are regenerated afterwards by
`desktop/electron/finalize-artifacts.mjs`. The ZIP updater files and final DMGs
are retained together with SHA256 manifests.

`./scripts/verify-mac-build.sh "path/to/SSH Manager.app"` checks the Developer ID,
deep signature, Gatekeeper, stapled app and matching DMG, dependencies, interface,
tray icon and local terminal helper. It runs **after** the application smoke test:
normal use must not invalidate the signature.

For a local diagnostic build that must not use signing credentials:

```sh
npm ci
npm run build:ui
npm ci --prefix desktop/electron
cd desktop/electron
npm run prepare-engine
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --arm64 --dir --publish never -c.mac.identity=-
```

This produces an ad hoc signed developer build, not a distributable application.

## Windows signing

A successful Electron Builder log does **not** prove Authenticode was applied.
The workflow runs `scripts/verify-windows-build.ps1` against the NSIS installer
and both packaged application executables. Stable publication requires every
signature to have `Valid` status. Unsigned dry runs and prereleases are retained
with an explicit warning, for testing only.

The optional `WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` repository secrets are
passed to Electron Builder's Windows certificate support. They must contain real
signing credentials supplied by the maintainer; no Windows credential is bundled
or assumed to exist. Until a certificate or equivalent signing infrastructure is
configured and the verification passes, **stable desktop publication is blocked**.
Do not disable that check to make a release green.

## Data belongs outside the application

The shared groups file is `${SSH_MANAGER_HOME:-~/.ssh-manager}/groups.json`;
`SSH_GROUPS_FILE` overrides it. Reads fall back to a legacy `.server-groups.json`
next to an installed engine only when the shared file does not exist. The first
successful edit writes the shared file atomically and keeps the legacy file
unchanged. Starting the application or listing groups creates nothing.

MCP and desktop processes refresh this shared file before group operations.
They report persistence errors instead of claiming an unsaved edit succeeded.
For an old npm installation, back up package-local state **before replacing the
package**; an installer cannot recover a legacy file npm has already deleted.
See [MIGRATION.md](MIGRATION.md).

## Mac App Store

The release channel is Developer ID distribution through GitHub Releases.
A Mac App Store build would require a separate sandbox design for arbitrary local
file browsing, external tools such as rsync, host-key discovery and the local
control-plane service. It is outside the current release scope.
