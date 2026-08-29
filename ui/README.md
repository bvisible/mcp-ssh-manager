# The control plane interface

React, built with Vite, served by `ssh-manager control` from `../dist/ui`.

## Where it comes from

The design system, the sidebar and the file browser are carried over from
**TransHub AI Desktop** — the same authors, relicensed MIT here. That app's
renderer was already decoupled from Electron: nothing in it calls `ipcRenderer`,
everything goes through `window.api`, and it already ran in a browser through a
WebSocket adapter. Porting it was therefore a matter of writing a third adapter
(`src/lib/api.ts`, HTTP and SSE against the control plane), not a rewrite.

Two things were changed rather than copied:

- `FileInspector`'s `chmod`/`chown` interpolated a filename straight into a
  shell command. A filename is remote input, and that is the same class of bug
  as the advisories this project closed in 3.8.5. The port quotes it.
- The dual local/remote file panes became a single remote pane. A page in a
  browser has no access to your local filesystem beyond the file picker, so the
  local half would have been a lie.

## Building

```bash
npm run build:ui        # from the repository root
cd ui && npm run dev    # or iterate with hot reload
```

**The output in `../dist/ui` is committed.** `npm install mcp-ssh-manager` must
never compile anything — the same bargain as the vendored xterm.js. Nothing in
this directory is a dependency of the published package: `ui/` has its own
`package.json` precisely so React never appears in the engine's tree.

Rebuild and commit `dist/ui` whenever you change anything here, or the shipped
interface and the source drift apart.

## What is deliberately absent

Everything that served TransHub's AI chat: the chat itself, the browser
automation panes, git integration, plugins, cloud sync, voice. They are what
made that bundle 5 MB; without them this one is under 900 KB including fonts.
