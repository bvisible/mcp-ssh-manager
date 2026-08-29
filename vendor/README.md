# Vendored browser assets

`xterm/` — xterm.js 6.0.0 (MIT), used by the previous single-file interface at
`/legacy`. The React app under `ui/` gets xterm from npm at build time instead,
so once every screen has moved over this directory can go.
