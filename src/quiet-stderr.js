// Opt-in silence on stderr: SSH_LOG_STDERR=false (also 0, off, no).
//
// The engine writes a startup banner, its logger and a few hook and profile
// messages to stderr. An MCP host captures that, and most hosts keep it out of
// sight. A client that draws a terminal interface on the same stderr (OpenCode
// and Kilo were the reports) gets its screen overwritten by those lines.
// The log file (SSH_LOG_FILE) keeps receiving the logger's lines either way.
//
// Idea from fyq163's fork, which silenced stderr for everybody; here nothing
// changes unless the variable is set to a false value. Imported first by
// index.js so it is in place before any other module can print.
const value = process.env.SSH_LOG_STDERR;
if (value !== undefined && /^(0|false|off|no)$/i.test(value.trim())) {
  console.error = () => {};
}
