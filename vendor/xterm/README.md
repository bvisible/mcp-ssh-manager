# xterm.js, vendored

[xterm.js](https://xtermjs.org) 6.0.0, MIT licensed, copied here rather than
declared as a dependency.

**Why vendored:** the engine has no runtime dependencies, and that is what lets
it install anywhere — a server with no build toolchain, a container, a locked-down
CI runner. xterm.js is only ever needed by the control plane, to *display* a
terminal in a page. Making it a package dependency would push a 477 KB browser
library onto every user of the MCP server, including those who never open a
window.

Served by the control plane at `/vendor/xterm.js` and `/vendor/xterm.css`, and
loaded by nothing else.

**Not needed for the terminal itself.** `ssh2` opens the remote pseudo-terminal
natively (`client.shell()`), so there is no `node-pty` here and no native module
to compile. TransHub uses node-pty because it opens *local* shells; a remote SSH
shell is a different thing and ssh2 already does it.

Upgrading: copy `lib/xterm.js`, `css/xterm.css` and `LICENSE` from a newer
`@xterm/xterm`, and check the version above.
