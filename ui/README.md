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

**The output in `../dist/ui` is generated, not committed.** It is built when the
npm package is packed (`prepack`) and when the desktop app is assembled, so
`npm install mcp-ssh-manager` never compiles anything: the package and the app
carry the built interface. `dist/` is git-ignored. Nothing in this directory is a
dependency of the published package: `ui/` has its own `package.json` precisely
so React never appears in the engine's tree.

This replaced a single hand-written HTML page and a vendored copy of xterm.js.
Both are gone: the app bundles xterm from npm, and a second implementation of
every screen was a second implementation to keep in step — which nobody does,
and the one that drifts is always the one nobody looks at. What remains at `/`
when the build is missing is a page that says which command to run.

There is nothing to commit after a change here: `npm run build:ui` (or `npm pack`)
rebuilds `dist/ui` from the sources, so the shipped interface cannot drift from
them.

## Translations

A language is three files, and nothing else names it. The interface finds its
catalogues when it is built, the desktop application finds its own when it starts,
and the language selector in Options is generated from what they find.

| File | What it holds |
|---|---|
| `src/locales/<code>.json` | the labels of the components carried over from TransHub (`t('files.contextOpen')`), and `language.name` (the language written in itself, "Français") and `language.label` (the word for "Language") |
| `src/locales/messages.<code>.json` | every sentence written for this project. The **keys are the English sentences**, read through `tr()` and `trn()` |
| `../desktop/electron/native.<code>.json` | the desktop application's own menus, tray and notifications (also keyed by the English text) |

`en` is the source and the fallback, and has no file of its own for the last two.

### Adding a language

From the repository root:

```bash
npm run lang -- add fr --name "Français" --label "Langue"
```

That creates the three files with every value still the English text, and adds the
language's page to the Windows installer when it has one. Then:

1. Translate the **values**. Never change a key of `messages.<code>.json` or
   `native.<code>.json` (the key is how the code finds the sentence), and keep every
   `{{placeholder}}` as it is.
2. `npm run lang -- status` shows how many entries are still the English text (a few are
   right to be: product names, "OK").
3. `npm run test:locale` checks that every key exists, every placeholder survived, every
   `tr('…')` sentence of the source has a translation, every menu label is translated and
   the installer has the page. `npm run test:ui` runs the language scenarios of the
   interface in each language found.
4. Look at it: `npm run build:ui`, then `ssh-manager control` from a checkout (with an
   isolated `SSH_MANAGER_HOME`), and pick the language in Options → Appearance.

Until somebody chooses, the system or browser language decides: the exact tag
(`pt-BR`), else the first language of the same family (`fr-CH` → `fr`), else English.
Nothing in the code lists the languages; no test lists them either.

Things worth knowing when translating:

- **Plurals.** `trn(count, one, other)` carries two forms, the English ones. A language
  with no plural (Chinese, Japanese) puts the same text in both entries; French, German
  or Spanish translate each. A language that needs more than two forms is not covered.
- **Fonts.** A language written in Han characters needs its own font stack, because the
  same characters are drawn differently in Chinese and in Japanese: see `:root:lang(ja)`
  in `src/globals.css`. Other scripts need nothing unless the system's fonts do not cover them.
- **What is not translated.** Server names, commands, paths, and anything a remote
  machine or the engine prints stay as they are.

## What is deliberately absent

Everything that served TransHub's AI chat: the chat itself, the browser
automation panes, git integration, plugins, cloud sync, voice. They are what
made that bundle 5 MB; without them this one is under 900 KB including fonts.
