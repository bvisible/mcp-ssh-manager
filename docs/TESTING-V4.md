# V4 validation and release gates

The npm engine and the desktop application share one engine. Both paths must
remain usable: upgrading an npm installation must not launch a UI, create a
vault automatically, or require a human approval unless the user enabled it.

## Contributor commands

Use a disposable checkout/test home for the full legacy suite. Browser and
published-package tests create temporary homes themselves; they use loopback
fixtures, not your SSH hosts, credentials or keychain.

```sh
npm ci
npm test                        # 44 engine, migration, security, release and preview suites
npm run lint
npm run typecheck
npx knip
./scripts/validate.sh

npm ci --prefix ui
npm run build --prefix ui
cd ui
npx playwright install --with-deps chromium
npm run test:e2e
cd ..
npm run test:published-upgrade   # needs network: actual npm 3.8.5 → V4 → 3.8.5
```

`dist/ui` is committed and shipped in the npm tarball. Rebuild after a UI edit;
CI rejects a build that differs from the committed interface. Browser tests
exercise that compiled interface against the real local ControlPlane HTTP/SSE
server. Playwright reports, traces and failure screenshots are retained in CI.

For focused work, run `npm run test:migration`, `test:security`, `test:hostkeys`,
`test:proxy`, `test:working-directory`, `test:groups-persistence`, `test:release`,
`test:preview`, `test:desktop-smoke` or `test:cli-experience`. Existing `test:upgrade`, `test:vault`, `test:recovery`,
`test:controlplane`, `test:terminal` and `test:files` cover adjacent behavior.

`npm run test:preview` checks the disposable candidate profile, real local
SSH/SFTP fixture, simulated remote commands, restart persistence and cleanup
without opening a GUI. For an interactive review of the npm tarball or packaged
application, follow [the final V4 test](FINAL-TEST-V4.md).

The old `scripts/test-first-run.mjs`, `scripts/test-import-ui.mjs` and
`scripts/test-preferences-persist.mjs` entry points now delegate to isolated
Playwright tests. `--help` explains their arguments; they no longer connect to a
manually supplied URL or a user's running application.

## Regression coverage

| Area | Executable proof |
| --- | --- |
| Headless upgrade and rollback | Actual registry 3.8.5, current packed V4, then 3.8.5 again; `.env`, TOML and process env; 37 unchanged tool schemas and server listings, all configured fields, unchanged source files, no UI listener/vault/prompt |
| Vault and live configuration | Vault creation/edit/deletion reloads; env precedence preserves approval; partial edits preserve secrets, accounts, proxies and restrictions; lost-key and external recovery cases; unreadable vault blocks remote operations while local inspection, cleanup and graphical recovery remain available; strict decryption; stale preview/concurrent restore refusal; confirmed recovery repairs a corrupt key file |
| Approval boundary | Previously bypassed remote tools, aliases/partial names, exactly one prompt, opt-in fail-closed behavior, in-flight identity snapshot and pooled-connection invalidation |
| SSH transport | Real local ssh2 host-key handshake and changed-key refusal before authentication; revoked and hashed known hosts; multi-hop ProxyJump and ProxyCommand; working-directory injection canaries |
| CLI adoption | One optional terminal invitation; no hint on commands, help, version, pipes, CI or MCP stdout |
| Interface | First-server creation, direct import, legacy import/edit preservation, keyboard focus/Escape, axe accessibility, narrow viewport, reduced motion, connection loss, preferences across a new port, encrypted backup/preview/restore including files above 1 MB |
| Groups and distribution | Legacy groups migrated into shared user state, write failures preserved; signed application unchanged by edits; version/channel/commit/hash checks, tampered artifacts rejected, RC isolation |
| Candidate preview | Disposable home and file-backed key; encrypted fixture credentials; real SFTP confined to scratch files; simulated remote commands; same-profile control-plane restart; older desktop artifacts refused; orderly cleanup |

Accessibility automation covers the welcome dialog and the vault panel. It is
not a claim of a complete screen-reader or WCAG audit of every application view.
Recovery through the interface is limited to 16 MB encrypted files; larger
vaults use the CLI. Backup refuses an oversized download so it never offers a
file that its own restore screen cannot accept.

## CI and release conditions

- Engine tests: Linux on Node 18, 20, 22 and 24. Existing required check names
  remain intact. Packaging/tooling uses Node 24 independently of the engine's
  supported Node range.
- Interface and actual published-package upgrade: macOS, Windows and Linux.
- Desktop: packaged smoke tests, real Electron/terminal startup, user-state
  persistence and platform signature checks before publishing final metadata.
- Linux: install the generated `.deb`, then run its packaged UI and terminal as
  an unprivileged user under Xvfb. The installer configures its AppArmor profile
  and Chromium sandbox; AppImage startup remains a separate platform test.
- macOS: Developer ID + notarization/stapling on the final application and
  distribution image; hashes/blockmaps regenerated afterward.
- Windows stable: valid Authenticode required. Unsigned dry runs/RCs do not count
  as evidence of a signed production release.
- RC: npm `next` and GitHub prerelease; no stable Homebrew/MCP Registry update.
- Stable: final tested commit/tag, all artifact manifests validated, platform
  checks green and explicit release decision. See [DISTRIBUTION.md](DISTRIBUTION.md).

## Verified locally on 2026-09-07

The engine suites, lint, JSDoc typecheck and knip passed on macOS with Node 25.8.2.
The new preview suite also passed; `npm test` now contains 44 suites, including a desktop terminal smoke regression that accepts VT output but rejects input echo alone. Latest
focused results include seven security checks and nine recovery checks. The
actual registry upgrade/rollback passed all eight checks. Eleven Chromium flows
cover the UI paths above. An isolated macOS arm64 packaged application passed
Electron startup, UI rendering, native terminal, group persistence and strict
ad hoc signature verification before and after use during implementation. The
final release artifacts must repeat these checks after the branch is integrated.

Targeted upgrade (10 checks), migration (13) and the earlier six-check security
suite also passed on Node 18.20.8 and Node 24.20.0, using isolated homes. The added
seventh security check covers local cleanup with an unreadable vault.

No Windows/Linux runner or production signing/notarization run was executed
locally. Those are release gates, not inferred successes. The V4 production
release has not been published.
