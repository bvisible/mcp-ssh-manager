# From npm to the desktop app in one step, and a CLI worth looking at

Date: 2026-10-08 · Status: design approved in conversation, spec awaiting review · Target: 4.0.0-beta.3

## Why

Someone who installed mcp-ssh-manager from npm has the engine their agents use, the `ssh-manager` CLI and,
since V4, a browser interface (`ssh-manager control`). The desktop application — menu bar, native
notifications, updates itself — exists, but nothing in the npm product leads to it: today it is a GitHub page
to find, a file to pick for the right architecture, an installer to run by hand. The maintainer's ask:
"from npm, switch to the interface easily — one click, and it installs". The browser interface should say the
application exists and offer to move to it. And the CLI, which has looked the same since 3.1, should look like
the product it belongs to.

What stays true:

- **The application does not replace the npm engine.** Claude Code, Codex and Claude Desktop keep launching the
  npm engine; the application is the window on top of it, as it is today.
- **Nothing happens unless asked.** No `postinstall` script, no download without a click or a command, no new
  prompt in a command people already script. Direct commands, pipes and CI stay silent (the existing
  `suggestDesktop` rules).
- **Every existing CLI command and menu number keeps its meaning.**

Success: on a Mac with the npm package only, `ssh-manager app` — or one click in the browser interface — leaves
the signed application installed and open, its integrity proven, with the agents still on the npm engine; the
CLI opens on a screen that says where things stand.

## 1. Getting the application: `src/desktop-install.js`

One module, used by the CLI command and by the control plane. No new dependency.

### Which file, from where

- The engine installs the application of **its own version**: `package.json` `version`, release tag
  `v<version>`. A 4.0.0 engine never installs 4.1.0, and a beta engine installs its beta.
- The release publishes, per platform, `release-manifest-<platform>.json` (`darwin`, `win32`, `linux`): every
  artifact with its `size` and `sha256`. The release workflow already checks every uploaded file against these
  manifests, so they are the reference. JSON, so no YAML parser is needed.
- Artifact per platform, chosen from the manifest by name pattern:

| Platform | Artifact | Install |
|---|---|---|
| macOS arm64 / x64 | `SSH-Manager-<v>-<arch>.zip` | unpack with `ditto -x -k`, verify, move to `/Applications` (or `~/Applications` when `/Applications` is not writable) |
| Windows x64 / arm64 | `SSH-Manager-<v>-setup.exe` | run it with `/S` (silent, per user, no administrator rights) |
| Linux x64 | `SSH-Manager-<v>-amd64.deb` | `sudo apt-get install -y <file>`, in the terminal only (the password is asked there) |
| Linux x64 without apt | `SSH-Manager-<v>-x86_64.AppImage` | `~/Applications/SSH-Manager.AppImage`, mode 0755 |
| anything else (Linux arm64, …) | — | not offered: the message names the releases page |

- URLs: `https://github.com/bvisible/mcp-ssh-manager/releases/download/v<v>/<file>`, HTTPS only, following
  GitHub's redirect to its asset host. The base URL is a parameter of the module's functions for tests; the CLI
  and the control plane always use the real one, and there is no environment override.

### Verification — nothing is installed unless all of it holds

1. The downloaded file's size and SHA-256 equal the manifest's. Computed while downloading, into a private
   temporary directory (`mkdtemp`, 0700).
2. macOS: after unpacking, `codesign --verify --deep --strict` passes, the signature's `TeamIdentifier` is
   `BT249938WK` (bVisible Sarl, the release's Developer ID), and `spctl --assess --type execute` accepts it
   (notarized). Windows builds are not code-signed yet: the hash is the check, and the release notes say so.
3. Any failure removes the temporary directory and installs nothing.

The trust anchor is the release itself, served over HTTPS: the hash catches a truncated or mismatched download,
and the Apple signature catches anything not built and notarized by us.

### Already installed

Detected at the usual places — macOS `/Applications/SSH Manager.app` then `~/Applications/…` (version from its
`Info.plist`); Windows `%LOCALAPPDATA%\Programs\SSH Manager\SSH Manager.exe`; Linux `ssh-manager-desktop` on the
`PATH`, then the AppImage above. When found, the command **opens** it and downloads nothing: keeping it current is
the application's own auto-update. When the installed version is older than the engine, the message says the
application will offer its update.

### API

```
desktopStatus({ platform, arch, env })            -> { supported, installed, path, version, method }
installDesktop({ version, platform, arch, baseUrl, onProgress, run })
                                                 -> { path, version }      // throws, having installed nothing
openDesktop({ path, platform, run })              -> void                    // detached
```

`method` is `"auto"` (macOS, Windows, Linux AppImage) or `"terminal"` (Linux `.deb`, which needs `sudo`).
`onProgress({ phase, received, total })` with phases `manifest`, `download`, `verify`, `install`, `open`.
`run` (the command runner) is injectable so tests never touch the real system.

## 2. The CLI command: `ssh-manager app`

A native Node command (`cli/app.js`, registered in `nativeCommands`), so it works on Windows without Bash.

```
$ ssh-manager app

  SSH Manager — desktop application

  ↓ SSH-Manager-4.0.0-arm64.zip   128 MB  ████████████ 100%
  ✓ SHA-256 matches release v4.0.0
  ✓ signed and notarized by Apple (bVisible Sarl)
  ✓ installed in /Applications/SSH Manager.app
  → opening…

  Your agents keep using this npm engine; the app shows what they do
  and lets you decide.
```

- `ssh-manager app --status` prints the state in one line (used by the menu, below).
- Exit codes: 0 opened, 1 failed (nothing installed), 2 not available for this platform.
- When an `ssh-manager control` is already running, the command says that the application takes over the
  approval socket and that the browser control plane can be stopped.

## 3. The browser interface

- **A banner**, only when the interface runs in a browser tab (`inDesktopApp` is false) and the control plane
  offers it: "SSH Manager is also a desktop app: menu bar, native notifications, updates itself."
  **[Install the app]** · **[Not now]**. "Not now" is remembered per browser (`localStorage`). When the
  application is already installed, the button reads **[Open the app]**. On Linux with the `.deb` route, the
  banner shows `ssh-manager app` with a copy button instead, since a click cannot type a `sudo` password.
- The click calls the control plane, which runs `installDesktop` then `openDesktop`; progress arrives on the
  existing event stream (`{ type: 'desktop', phase, received, total }`), drawn as a progress bar in the banner.
- **Hand-over.** Once the application is open, the browser control plane says "Continued in the desktop app —
  you can close this tab" and stops itself a few seconds later, freeing the approval socket for the
  application. Without this, the application would take the socket and leave the browser control plane running
  with nobody able to reach it.
- **Endpoints**, token-protected like the rest, offered only when the control plane is started by
  `ssh-manager control` (`offerDesktop: true`), never inside the application:
  - `GET /api/desktop` → `desktopStatus()` plus `{ installing, phase, error }`
  - `POST /api/desktop/install` → 202, runs once at a time (409 while running)
  - `POST /api/desktop/open` → opens the installed application, then the hand-over
- `ssh-manager control` adds one line to its start-up text: "Prefer a window? `ssh-manager app` installs and
  opens the desktop app" (or "opens it" when installed).

## 4. The CLI's look

**Home screen** (the interactive menu), in the application's orange (`#c04500` ≈ 256-colour 166, falling back to
bold where colours are off), no emoji:

```
  ▲ SSH Manager 4.0.0
  63 servers · ~/.ssh-manager/.env · desktop app 4.0.0 installed

  SERVERS                          FILES
  1  List, test, add, edit         3  Sync (rsync)
  2  Connect (SSH session)         4  Tunnels
  6  Run a command
  5  Health                        AGENTS
                                   9  Watch what they run
  SETTINGS                         a  Desktop app (open / install)
  7  Configuration
  t  MCP tools
  v  Encrypted vault
  i  Import servers                ?  Help        q  Quit

  › _
```

- Every existing number keeps its meaning (1 servers … 9 control plane, 0 exit); letters are added (`a` desktop
  app, `t` tools, `v` vault, `i` import, `?` help, `q` quit). `0` still quits and `8` still opens the help, though
  the screen shows `?` and `q` for them.
- The status line: server count and the configuration file in use (`~` for the home), and the application's
  state from `ssh-manager app --status`. Each part degrades to nothing rather than slowing or breaking the menu.
- Two columns when the terminal is at least 72 columns wide, one column below.
- Sub-menus and `--help` use the same palette and headings. `--help` is rewritten in sections — servers, files,
  agents and the interface, settings — with aligned columns and a few common examples; every current command
  stays listed, `app` is added.
- The one-time invitation (`suggestDesktop`) now points to `ssh-manager app` instead of the releases page.
- Non-interactive output (direct commands, pipes, `NO_COLOR`, `TERM=dumb`) is not restyled beyond honouring
  `NO_COLOR`.

## 5. Tests

- `tests/test-desktop-install.js`, against a local HTTP server standing in for the release, with an injected
  command runner: success path (each step called in order, the app "opened"); wrong hash, wrong size, missing
  manifest (404), unsupported platform — each leaves no file behind and installs nothing; already installed →
  opens without downloading; macOS signature checks failing (wrong team, `spctl` refusal) → nothing installed.
- Control plane: `GET /api/desktop`, `POST /api/desktop/install` with an injected installer (progress events on
  the stream, 409 when busy), endpoints absent when `offerDesktop` is false, hand-over stops the plane.
- Interface: a Playwright flow — banner present in a browser tab, absent with `?shell=macos`, "Not now"
  remembered, install drives the progress bar against a mocked endpoint.
- CLI: `--help` lists `app`; the home screen rendered with a fake home (status line, keys, one and two columns);
  the invitation mentions `ssh-manager app`; direct commands and pipes stay silent.
- A real run on this Mac before release: remove `/Applications/SSH Manager.app`, `ssh-manager app` installs and
  opens the published beta; then the browser button after removing it again.

## Out of scope

- Updating an installed application from npm (the application updates itself).
- Code-signing Windows builds (needs an Authenticode certificate).
- Rewriting the CLI's sub-menus or moving it off Bash.
