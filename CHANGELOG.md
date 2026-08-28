# Changelog

All notable changes to MCP SSH Manager will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [3.8.5] - 2026-08-28

### Security

Three reported advisories, all the same class of bug, all confirmed present in 3.8.4 and fixed here. The v3.6.7 fix (CVE-2026-77383) introduced `shellQuote()` but applied it to `src/database-manager.js` only; the parallel builders for backups and monitoring were never covered.

- **RCE through every `ssh_backup_*` builder** (GHSA-qwwm-vrm9-4mw8, high). `src/backup-manager.js` concatenated `database`, `dbUser`, `dbPassword`, `dbHost`, `backupDir`, `paths` and `exclude` into shell strings with no escaping — 0 uses of `shellQuote` across 9 builders. Arbitrary command execution as the SSH user on every managed server.
- **RCE through `ssh_db_dump` and the MongoDB backup path** (GHSA-796j-h5q5-jx6p, critical). The follow-up `stat` command interpolated `outputFile` raw, after the dump itself had been fixed — the earlier patch stopped one line short.
- **RCE bypassing readonly/restricted mode** (GHSA-m793-whw6-f537, critical). `ssh_service_status` and `ssh_tail` are read-only, so they stay enabled on servers the operator locked down — and neither quoted its arguments nor consulted the policy layer. `buildServiceStatusCommand` interpolated the service name unquoted six times; `ssh_tail` built `tail -n ${lines} "${file}" | grep "${grep}"` with double quotes only, so a `"` breakout ran. **This defeated the exact control those modes exist to provide**, and the README had just started advertising them.

Fixes: `shellQuote()` extracted to `src/shell-quote.js` and applied across `backup-manager.js` (54 call sites), `health-monitor.js` and the remaining inline commands in `index.js`; a `safeInteger()` helper for numeric arguments that still land in command strings; `buildProcessInfoCommand` now validates its PID like `buildKillProcessCommand` always did; and `ssh_tail` and `ssh_service_status` now call the policy layer.

Guarded by `npm run test:backupinjection`: **340 builder × argument × payload combinations** driven through a real `/bin/sh` with a canary file, asserting no payload ever executes. Verified by mutation — removing any single quote-call is caught.

**Upgrade if you use `ssh_backup_*`, `ssh_db_dump`, `ssh_service_status` or `ssh_tail`, and especially if you rely on `readonly` or `restricted` mode.**

## [3.8.4] - 2026-08-28

### Security

- **The logger no longer writes secrets in clear text** (CodeQL `js/clear-text-logging`, `src/logger.js`). Structured log data is now redacted inside the logger rather than at each call site: any key matching password / passphrase / secret / token / credential / private key / api key / auth becomes `[redacted]`, at any depth, in arrays, whatever the casing. This matters because the logger writes to **two** places outside our control — `~/.ssh-manager.log` and stderr, which the MCP host captures — so one forgotten call site handing over a whole server config would have persisted a production password. Cyclic objects are marked rather than followed, so a self-referencing config cannot hang a log call. Guarded by `npm run test:redaction`.

### Fixed

- **`examples/backup-workflow.js` did not parse at all**, and is now `examples/backup-workflow.md`. A cron expression (`*/6`) inside a `/* */` block closed the comment early. Repairing it exposed the deeper problem CodeQL then found (`js/call-to-non-callable`): the file called `createBackup(...)`, a function that does not exist anywhere — it was never a JavaScript API, but documentation of conversations with the agent, where the real operations are MCP tools (`ssh_backup_create`, …). Shipping it as executable `.js` in the npm tarball invited people to run something that could only throw. It is now Markdown, which is what it always was, with the illustrative nature stated at the top.
- **`scripts/validate.sh` now syntax-checks every tracked `.js` file** (49 instead of 2), which is how the above escaped for so long. The guard is itself verified by deliberately breaking a file.
- Two time-of-check/time-of-use races (CodeQL `js/file-system-race`): `ssh-key-manager.js` guarded `mkdirSync({recursive:true})` with an `existsSync` that was both redundant and racy, and `config-loader.js` checked for the Codex config before reading it instead of reading it and handling `ENOENT`.

### Changed

- **Every GitHub action is pinned to a commit SHA**, including `trufflesecurity/trufflehog`, which tracked the moving `main` branch inside a workflow that reads the whole repository. This closes 17 of the 22 findings OpenSSF Scorecard reported.
- **CodeQL analysis added** (`security-and-quality`), answering Scorecard's SAST finding. It paid for itself immediately: every fix in this entry came out of its first run.
- **Dependabot alerts and automated security fixes enabled** on the repository — they were switched off.
- The `Release` workflow is re-runnable: it skips publishing when the version is already on the registry instead of failing on a duplicate, and creates the GitHub release if the SBOM step finds none.

## [3.8.3] - 2026-08-28

### Changed

- **First release published from CI with build provenance and an attested SBOM.** 3.8.2 shipped the workflow but was still published by hand, so it carried no attestation — `npm audit signatures` found none for it, while the comparable competitor had both an npm publish attestation and SLSA provenance. This release closes that gap for real: anyone can now verify which commit and which workflow built the tarball.
- **`zod` 3 → 4** ([#65](https://github.com/bvisible/mcp-ssh-manager/pull/65)). Verified before merging rather than after: with zod 4 installed, all 37 tools still register over a real MCP stdio handshake, and the full suite, typecheck and lint stay green. `@modelcontextprotocol/sdk` accepts `^3.25 || ^4.0`, and knip already wanted `^4.1.11`.
- `actions/checkout` and `actions/setup-node` bumped to v7 ([#61](https://github.com/bvisible/mcp-ssh-manager/pull/61), [#62](https://github.com/bvisible/mcp-ssh-manager/pull/62)).

### Note

TypeScript 7 ([#64](https://github.com/bvisible/mcp-ssh-manager/issues/64)) and ESLint 10 ([#63](https://github.com/bvisible/mcp-ssh-manager/issues/63)) were declined, not deferred by accident: knip 5 pins `peer typescript ">=5.0.4 <7"`, and ESLint 9+ requires migrating off `.eslintrc` to flat config — tracked in [#66](https://github.com/bvisible/mcp-ssh-manager/issues/66).

## [3.8.2] - 2026-08-28

### Security

- **The sudo password no longer reaches the remote command line** ([#34](https://github.com/bvisible/mcp-ssh-manager/issues/34)). `ssh_execute_sudo` and the three privileged steps of `ssh_deploy` built `echo "<password>" | sudo -S <cmd>`, which published the password to the remote process list, `/proc/<pid>/cmdline` and any `auditd` trail for the lifetime of the `echo` — readable by every account on the host. The existing output masking never helped: it only redacted the copy sent back to the agent. The password now travels on the SSH exec channel's stdin (`sudo -S -k -p ''`), where no other process can observe it. `-k` is required: without it an already-authorised sudo skips the prompt, leaving the password in the pipe for the command itself to read as input. Guarded by `npm run test:sudostdin`, which also fails if the old pipeline reappears anywhere in `src/`.

### Added

- **`server.json`** — the manifest for the official [MCP Registry](https://registry.modelcontextprotocol.io), published as `io.github.bvisible/mcp-ssh-manager`, plus the `mcpName` field in `package.json` that proves package ownership. The registry is what feeds MCP clients today; the project was absent from it.
- **OpenSSF Scorecard workflow and badge** — a public grade of the repository's supply-chain posture. For a server that hands an agent a shell on production machines, that grade is part of the product.
- **`Release` workflow** publishing to npm with build provenance and attaching a CycloneDX SBOM to each GitHub release. Removes the hand-publish step that failed twice on 2026-08-28 (expired token, then a 2FA prompt), and lets anyone verify the tarball's origin with `npm audit signatures`.
- **README section "Giving an agent SSH access, safely"** documenting the per-server `unrestricted` / `readonly` / `restricted` modes, which existed since v3.5.0 but were never surfaced where readers land.

### Fixed

- `SSHManager.execCommand` accepts an `stdin` option, written to the exec channel and then closed. Commands that pass no stdin are untouched, so interactive remote processes keep working.

## [3.8.1] - 2026-08-28

### Added

- **`package-lock.json` is now committed** (contributed by @cudatuda in #60) — installs are reproducible, `npm ci` works, and the transitive tree is auditable. npm excludes lockfiles from published tarballs, so consumers of the package are unaffected.
- **`npm run test:lockfile`** (`tests/test-lockfile.js`, wired into `npm test`) — guards the lockfile against the ways it rots: version drift between `package.json` and the lockfile's two version fields, dependency ranges out of sync, a locked version outside its declared range, packages resolved from anywhere but registry.npmjs.org, missing integrity hashes, `file:`/`git+`/`link:` entries, unreviewed install scripts, and runtime dependencies requiring a newer Node than `engines.node` advertises.
- **Node 22.x added to the CI test matrix** — `engines` claims `>=18` and 22 is the active LTS.
- **`.github/dependabot.yml`** — a pinned tree stops receiving upstream fixes on its own, so monthly grouped dependency updates (capped at 3 open PRs) act as the counterweight. GitHub Actions versions are tracked too.
- **Advisory `npm audit --omit=dev --audit-level=high` step** in the `Code Quality` workflow. Not a required check: a CVE published against a transitive dependency should be visible without blocking unrelated merges.

### Changed

- **CI installs with `npm ci` instead of `npm install`** in both workflows. `npm ci` reproduces the locked tree exactly and aborts if `package.json` and the lockfile have drifted.
- **ESLint and the JSDoc typecheck are now blocking**, and moved into the `lint` job — one of the three required status checks on `main`. They previously lived in the advisory `Code Quality` workflow, where ESLint additionally ran with `continue-on-error: true`, so neither gate could ever fail a pull request.
- **Node module caching now works.** `Code Quality` keyed its cache on `hashFiles('**/package-lock.json')` while the lockfile was gitignored, so every run shared one degenerate key. Replaced by `actions/setup-node@v4`'s built-in `cache: 'npm'`.
- GitHub Actions bumped from `actions/checkout@v3` / `actions/setup-node@v3` / `actions/cache@v3` to v4.

### Removed

- **`npm install --save-dev eslint prettier` from the `Code Quality` workflow** — it re-resolved both packages to their latest majors on every run (ESLint 9 over the pinned `^8.56.0`) and rewrote `package.json` in the CI workspace, defeating the pinning it ran next to.
- Redundant CI steps re-running `test-profiles.js`, `test-command-aliases.js` and `test-hooks.js` individually after `npm test` had already run them.

### Fixed

- `mcp-ssh-manager-setup.md`: the two `.gitignore` templates no longer tell readers to ignore `package-lock.json`.

## [3.8.0] - 2026-08-14

### Security

- **`@modelcontextprotocol/sdk` floor raised to `^1.30.0`** — the declared range (`^1.17.2`) still allowed versions carrying three published advisories, one of them high: cross-client data leak through shared server/transport instance reuse, DNS rebinding protection off by default, and a ReDoS. It also dragged in vulnerable transitive express packages (`body-parser`, `path-to-regexp`, `qs`, `ajv`). `npm audit --omit=dev` now reports **0 vulnerabilities**. Behaviour verified against the real MCP stdio protocol: identical to 1.17.5 (37 tools registered, same negotiation, clean shutdown).

### Added

- **Optional `group` field on server config** ([#56](https://github.com/bvisible/mcp-ssh-manager/pull/56) — contributed by [@ice616](https://github.com/ice616), requested in [#55](https://github.com/bvisible/mcp-ssh-manager/issues/55))
  - A free-form label (`SSH_SERVER_<NAME>_GROUP` in `.env`, `group = "..."` in TOML) carried on the server entry itself, so a server's group membership can be read straight off its config when exporting to — or importing from — another tool, with no second file to ship. It round-trips through `exportToToml`/`exportToEnv` and is returned by `ssh_list_servers`.
  - **The label is not just descriptive: it makes the group usable.** `ssh_execute_group` and `ssh_group_manage list` now resolve members from the `group` field as well, so tagging servers is enough to run a command across them — `.server-groups.json` is no longer required to have a working group.
  - Membership is the **union** of both sources: the explicit list stored by `ssh_group_manage` (which keeps carrying strategy, delay and stop-on-error) plus every server tagged with that name. Group names are case-insensitive. Config-derived members are resolved at read time and never written to `.server-groups.json`, so they cannot go stale.
  - A group that exists only through the config is read-only for `ssh_group_manage`; attempting to edit it now returns an error pointing at the server config instead of a bare "not found".
  - The `ssh-manager` add-server wizard asks for an optional group.
- Tests: new `tests/test-server-groups.js` (14 checks) covers config-derived groups, the union with stored groups, case-insensitivity, read-only enforcement, persistence isolation, the dynamic-group reload regression and group execution; `tests/test-config-field-names.js` gains `group` coverage across the `.env` loader, the TOML loader, the forbidden-field guard and the export round-trip.
- **Static type-checking over the existing JavaScript** (`npm run typecheck`) — a `tsconfig.json` in `checkJs`/`noEmit` mode runs TypeScript as a linter over JSDoc annotations. **Nothing is compiled and nothing changes for users**: the package still ships plain JS straight from `src/`, with no build step and no `dist/`. Added as a hard gate in the Code Quality workflow.
  - A `ServerConfig` typedef in `src/config-loader.js` documents the resolved server shape and makes its camelCase contract enforceable: reading `serverConfig.default_dir` — the exact issue #49 regression — is now a type error (*"Property 'default_dir' does not exist on type 'ServerConfig'. Did you mean 'defaultDir'?"*) instead of a silent `undefined`. `tests/test-config-field-names.js` keeps guarding the same contract at runtime.

### Fixed

- **A tunnel on an already-used local port crashed the entire MCP server** — `net.Server#listen` never passes an error to its callback (a failed bind is emitted as an `'error'` event), yet `ssh_tunnel_create` used `listen(port, host, (err) => ...)` and registered no `'error'` listener. On `EADDRINUSE` — the everyday tunnel failure — Node rethrew the unhandled event and killed the process, taking every pooled SSH connection and session with it, while the awaited promise never settled. Binding now rejects properly and the tool returns an error. Guarded by `tests/test-tunnel-listen.js`.
- **`ssh_sync` always passed an explicit `-p 22` to rsync** — the guard read `serverConfig.port !== '22'`, comparing a number against a string, so it never matched. Harmless in effect, but the intent (omit the flag on the default port) never applied. Found by the new typecheck, along with a matching `parseInt(serverConfig.port || '22')` in `ssh_known_hosts` that only worked because `parseInt` stringifies its argument first.
- **`ssh_sync` treated native Windows local paths as remote rsync specifications** — a path such as `C:\project` was passed unchanged to MSYS2 rsync, which parsed `C:` as a remote host and attempted an SSH connection to `c`. Windows drive-letter, rooted, UNC, and extended-length paths are now resolved and converted only for the spawned rsync argument while Node keeps the native path for local filesystem checks and logging; relative paths keep their existing semantics with normalized separators. Trailing separators retain rsync's directory-content semantics. A path already written in MSYS2 form (`/c/project`, `//server/share`) — the shape Windows users adopted to work around this very bug — is passed through untouched instead of being mounted twice into `/c/c/project`. Guarded by `tests/test-rsync-path.js` (24 checks: conversion table, pass-through, invariants over every input, platform isolation, failure modes, and a static guard on the `ssh_sync` wiring) plus a real MSYS2 rsync dry run.
- **The MCP server announced itself as version `1.2.0`** — the `serverInfo` version sent to Claude Code / Codex was a hardcoded literal the release process never bumped, so it had drifted far behind the real package version (3.7.0). It is now derived from `package.json`, the same treatment the CLI banner got in 3.7.0. This matters more under the MCP `2026-07-28` spec, where servers identify themselves in the `_meta` of every result.
- **`exportToEnv` no longer truncates a `group` containing `#`** — the value is now quoted like `DESCRIPTION`, so a label such as `prod #eu west` survives an export/re-import instead of coming back as `prod`.
- **The dynamic `all` group now sees TOML-defined servers** — it enumerated `process.env` only, so `ssh_execute_group all` silently skipped every server declared in a TOML config. The group layer now reads the configuration actually loaded by `ConfigLoader`.
- **The `all` group no longer disappears after the first group edit** — dynamic groups are deliberately never persisted, so every `.server-groups.json` written by `ssh_group_manage` lacked `all`, and the next start loaded that file as the complete set: `ssh_execute_group all` then failed with `Group 'all' not found`. Dynamic groups are now re-injected when the file is read.

### Changed

- **Dropped the `uuid` dependency** in favour of Node's built-in `crypto.randomUUID()` — available since Node 14.17, and this package already requires Node >= 18. Removes one runtime dependency and the last remaining advisory. Session and tunnel ID formats are unchanged.

## [3.7.0] - 2026-07-13

### Added

- **Per-server SSH agent forwarding (`ForwardAgent`)** ([#53](https://github.com/bvisible/mcp-ssh-manager/pull/53) — requested by [@raphaelbahat](https://github.com/raphaelbahat) in [#52](https://github.com/bvisible/mcp-ssh-manager/issues/52))
  - New opt-in option, `SSH_SERVER_<NAME>_FORWARD_AGENT=true` (`.env`) or `forward_agent = true` (TOML), enabling the equivalent of OpenSSH's `ForwardAgent yes` on a per-server basis. Processes on the remote host can then authenticate to other SSH hosts using the keys held in the operator's local `ssh-agent` (e.g. `git` over SSH), without copying any private key to the server.
  - Requires a running local agent (`SSH_AUTH_SOCK`); the flag is ignored when no agent is present. `ForwardAgent` is set only alongside a valid agent, since `ssh2` throws otherwise. Because `ssh2`'s connection-level `agentForward` forwards on every exec/shell channel, no per-command change is needed.
  - A `parseBool()` helper coerces the `.env` string value so `FORWARD_AGENT=false` is not treated as truthy; only `true`/`1`/`yes`/`on` enable it.
  - **Defaults to `false`.** Documented in the README (*SSH Agent Forwarding*) and CLAUDE.md with the standard security warning (a root user on the remote host can use the forwarded agent for the life of the connection).
- Tests: `tests/test-agent-forward.js` verifies the `connect()` wiring across the on/off/absent/no-agent states; `tests/test-config-field-names.js` gains `forwardAgent` coverage including `.env` boolean coercion and a TOML export round-trip.

## [3.6.7] - 2026-07-11

### Security

- **Command injection in the database command builders** ([#51](https://github.com/bvisible/mcp-ssh-manager/pull/51) — responsibly disclosed by **Ugur Ozer, Aeon AI Risk Management** (http://airiskmanagement.ca), see [#48](https://github.com/bvisible/mcp-ssh-manager/issues/48))
  - Every `ssh_db_*` tool argument — `database`, `table`, `collection`, output/input file paths, and the `user` / `host` / `port` / `password` connection fields — arrives from tool-call parameters and was interpolated straight into a **shell-evaluated** command string in `src/database-manager.js`. A crafted value (`$(…)`, backticks, `; cmd`, `| cmd`, `&& cmd`, bare `> file`) executed arbitrary commands on the configured SSH target, under the account the MCP server uses.
  - The strongest path is **`ssh_db_list`**: it is classified read-only, so it stayed **allowed in the `readonly` and `restricted`** per-server security modes while still reaching an injectable builder — bypassing the boundary those modes promise.
  - The v3.6.5 heredoc fix (#44) only hardened `ssh_db_query`'s query **text**; the `list` / `dump` / `import` / `restore` builders and the query builders' **connection flags** were untouched.
  - **Fix:** a centralized `shellQuote()` (single-quote wrap + `'\''` escaping) now wraps **every** interpolated caller value across all 15 builders. The MySQL list-tables `database` became a shell-quoted positional argument instead of an interpolated `USE <db>` SQL clause, closing the SQL path too. Shell-quoting is transparent for legitimate values.

### Added

- Security regression test `tests/test-database-injection.js` (`npm run test:dbinjection`, part of `npm test`): drives every builder × every caller-controlled parameter × an injection-payload battery (648 combinations) through a real `/bin/sh` with fake DB client binaries and asserts no payload ever executes; unit-tests `shellQuote()`; verifies benign values stay correctly quoted.
- `SECURITY.md` documenting the private vulnerability disclosure process (GitHub private vulnerability reporting + security email; resolves [#48](https://github.com/bvisible/mcp-ssh-manager/issues/48)).

## [3.6.6] - 2026-07-11

### Fixed

- **Handlers read stale snake_case config fields that `ConfigLoader` no longer produces** ([#49](https://github.com/bvisible/mcp-ssh-manager/issues/49) — thanks [@egoan82](https://github.com/egoan82) for the excellent root-cause report; fixed in [#50](https://github.com/bvisible/mcp-ssh-manager/pull/50))
  - Since the v3.0.0 ConfigLoader refactor, resolved server configs expose **camelCase** fields (`sudoPassword`, `defaultDir`, `keyPath`), but several handlers still read the pre-3.0 snake_case/lowercase names — always `undefined`, so their fallback branches silently never ran:
    - `ssh_execute_sudo` ignored the configured `SUDO_PASSWORD` → `sudo: a terminal is required to authenticate` on hosts without a TTY on the exec channel
    - `ssh_execute` / `ssh_group_execute` / `ssh_execute_sudo` ignored `DEFAULT_DIR` — commands silently ran in `$HOME`
    - `ssh_list_servers` always reported an empty `defaultDir`
    - `ssh_sync` never passed the configured SSH key to rsync (`-i` / `BatchMode=yes`), falling back to whatever default key the agent offered
  - No configuration change required: `.env`/TOML source keys (`SUDO_PASSWORD`, `default_dir`, `key_path`, …) are unchanged — existing configs simply start working again.

### Added

- Regression test `tests/test-config-field-names.js` (`npm run test:fieldnames`, part of `npm test`): locks the ConfigLoader's output field names from both `.env` and TOML sources, and statically forbids stale `.sudo_password` / `.default_dir` / `.keypath` access in `src/`.

## [3.6.5] - 2026-06-30

### Security

- **`ssh_db_query` could execute arbitrary shell commands on the remote host** ([#44](https://github.com/bvisible/mcp-ssh-manager/pull/44) — thanks [@technophile77](https://github.com/technophile77))
  - The query builders interpolated the raw query into a **double-quoted** shell string (`mysql -e "${query}"`, `psql -c "${query}"`, `mongo --eval "${query}"`), so the remote shell evaluated backticks `` `…` `` and `$(…)`/`$VAR` **before** the database engine ever saw the query. The "SELECT-only" tool could therefore run shell commands on the target server (e.g. `` SELECT `id` `` / `SELECT '$(id)'`).
  - The query is now delivered to `mysql`/`psql`/`mongo` on **stdin via a single-quoted heredoc** (`<<'__MCP_SQL_EOF__'`), so the remote shell never parses it — only the database engine interprets the SQL/JS. A shared `buildHeredoc()` helper keeps the existing `awk` JSON-wrapper pipe on the heredoc opening line (MySQL JSON output is byte-for-byte unchanged) and defensively rejects a delimiter collision. `isSafeQuery()` is intentionally left as-is, since the heredoc — not keyword filtering — closes the injection path.

### Fixed

- **`ssh_db_query` (MySQL) silently corrupted backtick-quoted identifiers** ([#44](https://github.com/bvisible/mcp-ssh-manager/pull/44) — thanks [@technophile77](https://github.com/technophile77))
  - The same shell-evaluation bug meant any query using backtick identifiers — hyphenated database names, cross-database joins, reserved-word columns — was rewritten by the shell and returned empty/incorrect results **with no error**. The stdin heredoc fix above restores these queries verbatim.
- **`ssh_db_query` reported `row_count` off by one** ([#45](https://github.com/bvisible/mcp-ssh-manager/pull/45) — thanks [@technophile77](https://github.com/technophile77))
  - The handler reported `output.split('\n').length`, which counted cosmetic lines (the leading `[` of the MySQL JSON wrapper, psql header/separator lines) rather than result rows: 1 row → `2`, 13 rows → `14`, 0 rows → `2`. A new `countQueryRows()` derives the count from each engine's actual output structure — MySQL JSON `{"row":N,…}` entries, MySQL `--batch` lines, psql's authoritative `(N rows)` footer (with a header/separator fallback), and MongoDB `printjson` documents — so empty output is `0` and the count tracks real rows.

### Tests

- **New `tests/test-database-query-quoting.js`** (`test:dbquoting`) — verifies the SQL/JS query text is carried verbatim on stdin for all three builders (never via `-e "`/`-c "`/`--eval "`), that the `awk` pipe stays on the heredoc opening line with the terminator alone, that `buildHeredoc` rejects a delimiter collision, and a stochastic round-trip of 500 random shell-metacharacter queries.
- **New `tests/test-database-row-count.js`** (`test:dbrowcount`) — covers the exact issue cases (MySQL 0/1/13 rows), a look-alike `{"row":` value inside a cell, MySQL text format, psql `(N rows)`/`(1 row)`/`(0 rows)` footers and the no-footer fallback, MongoDB single/multi-document counting, and empty/whitespace → `0`.

## [3.6.4] - 2026-06-18

### Changed

- **Internal dead-code cleanup — no behavioral change.** Removed 27 unused exports and 2 duplicate exports across the codebase (−343 lines): fully-unused helper functions deleted, internally-used symbols un-exported, and redundant `export default`s removed. The public surface (the MCP server + CLI) is unchanged — command builders and parsers are byte-identical before/after (verified by a differential test of `main` vs the change), and all 37 tools were exercised end-to-end against a live SSH server (Ubuntu + MariaDB) with no regression.

### Tooling

- **Dead-code quality gate.** Added a calibrated `knip.json` and a **blocking** `knip` step to the `quality` CI workflow, so unused exports/files/dependencies now fail the build and can't creep back in. `eslint src/` is clean (0 errors, 0 warnings).

## [3.6.3] - 2026-06-18

### Fixed

- **`ssh_sync` falsely reported "No files needed to be transferred" even when files were synced** ([#42](https://github.com/bvisible/mcp-ssh-manager/pull/42) — thanks [@MakksSh](https://github.com/MakksSh))
  - Two bugs in the rsync `--stats` scraper kept `filesTransferred` at `0`: `--stats` was only passed when `verbose` was enabled (so rsync produced no statistics lines at all), and the count regex only matched rsync 2.x wording (`Number of files transferred`) while rsync 3.x — standard on modern distros — emits `Number of regular files transferred`. Agents would mistrust the result, run redundant checks, or retry the sync.
  - `--stats` is now always passed, and the count regex matches both rsync 2.x and 3.x.
- **`totalSize` stayed `0` on macOS, and locale-formatted numbers were mis-parsed** (follow-up hardening)
  - openrsync (the default `/usr/bin/rsync` on recent macOS) suffixes byte counts with `B`, not `bytes`, so the size regex never matched. Both suffixes are now accepted — openrsync keeps raw byte counts even for large files (verified at 5 MB), so no `K/M/G` handling is needed.
  - Numbers grouped with locale-specific separators (`,` or `.` for thousands, the opposite char for the decimal) are now parsed correctly for the file count, transferred size, and speed, instead of only stripping commas.
  - The `--stats` parsing was extracted into `src/rsync-stats.js` so it is unit-testable without booting the MCP server.

### Tests

- **New `tests/test-sync-stats.js`** (wired into `npm test` as `test:sync`) — 46 assertions covering openrsync output captured from a live macOS run, GNU rsync 3.x/2.x, US/EU locale number formats, the zero-files case, and a missing `--stats` block.

## [3.6.2] - 2026-06-09

### Changed

- **All 37 tool descriptions rewritten for clarity and agent reliability.** Every MCP tool now documents its real behavior — side effects, destructive vs read-only nature, idempotency, sudo/auth requirements, security-mode gating, and parameter semantics (mutually-exclusive params, defaults, edge cases) — instead of a 4-to-10-word summary. Average description length went from ~6 words to ~70, with no weak outliers (shortest is now 55 words).
  - Improves real tool-calling: agents now know the consequences before invoking a tool — e.g. that `ssh_db_import` and `ssh_backup_restore` are destructive (DROP/overwrite), that `ssh_db_query` is strictly SELECT-only, that `ssh_upload`/`ssh_sync`/`ssh_deploy` are blocked on `readonly` servers, and which parameters are mutually exclusive.
  - Also raises the Glama "Tool Definition Quality" score (previously C — average 3.1/5, lowest 2.1/5).
  - **No behavioral change**: only `description` strings were edited; all logic, parameters, and tool names are unchanged. All test suites pass unmodified.

## [3.6.1] - 2026-06-09

### Fixed

- **Module-level monitor/cleanup intervals pinned the Node event loop** (follow-up to [#41](https://github.com/bvisible/mcp-ssh-manager/pull/41))
  - `tunnel-manager.js` (`monitorTunnels`, every 30 s) and `session-manager.js` (inactive-session cleanup, every 5 min) registered module-level `setInterval` timers that were never `unref()`'d, so importing either module kept the event loop alive on its own.
  - Both are now `unref()`'d, matching the keepalive and cleanup timers fixed in #41. The forced-exit added in #41 already made these harmless for the orphan-process bug; this restores proper teardown hygiene so process lifetime tracks the stdio transport, not a background timer.
  - Verified: before, importing either module never exits on its own; after, both exit naturally. Full `npm test` (including `test:lifecycle`) stays green.

## [3.6.0] - 2026-06-09

### Added

- **Live configuration hot reload** ([#40](https://github.com/bvisible/mcp-ssh-manager/pull/40) — thanks [@EnjoySR](https://github.com/EnjoySR))
  - The MCP server now reloads its server configuration when the `.env` or TOML file changes on disk, so tools like `ssh_list_servers` see newly added or edited servers **without restarting the MCP process**.
  - A new `ServerConfigManager` tracks a lightweight signature (path + `mtime` + size) of both config files and reloads **lazily** — only when that signature changes, on the next config access. No file watcher, no polling thread, no background timer.
  - **Fail-safe:** if a reload throws (e.g. a malformed file caught mid-edit), the last known-good configuration is kept in memory and the error is logged — the server never ends up with an empty or broken config.
  - `.env` parsing no longer permanently mutates `process.env` (`dotenv` is now read with `processEnv: {}`), and real process environment variables keep the **highest priority** over file values, matching the documented loading order.

### Fixed

- **stdio server orphaned on session teardown — one leaked node process per session** ([#41](https://github.com/bvisible/mcp-ssh-manager/pull/41) — thanks [@LegendaryGatz](https://github.com/LegendaryGatz))
  - A stdio MCP server is torn down by its host closing **stdin (EOF)** and/or sending **SIGTERM** — not `SIGINT`, which only arrives on an interactive Ctrl-C. The only shutdown handler was `SIGINT`, so on normal teardown the process was never signalled, got reparented to init, and leaked (~83 MB plus live keepalive timers each, accumulating one process per session).
  - Shutdown is now an **idempotent** `shutdown(reason)` registered on `SIGINT`, `SIGTERM`, `SIGHUP` and stdin `'end'`/`'close'`. The per-connection keepalive interval and the 10-minute cleanup interval are `unref()`'d so process lifetime tracks the transport, not a timer. `ssh.dispose()` is wrapped in try/catch so one bad connection can't block the rest, and a short `unref`'d timer forces exit so teardown can never hang if the host has already stopped reading.
  - Measured: exits cleanly **~10 ms** after stdin EOF, versus staying alive indefinitely before.

### Tests

- **New `tests/test-lifecycle.js`** (wired into `npm test` as `test:lifecycle`) — black-box teardown coverage asserting a clean exit on stdin EOF, SIGTERM, SIGINT and overlapping signals. Regression guard for the orphan-process bug.
- **`tests/test-server-config-manager.js` extended to 9 checks** — laziness (no reload while files are unchanged, exactly one reload after a change), reload-failure-keeps-last-valid-config plus recovery, and deleted-file robustness, in addition to the original TOML/`.env` hot-reload paths.

### Backward compatibility

- **Zero impact on existing setups.** Hot reload is transparent — if your config files don't change, behavior is identical to v3.5.x. No new config field, no new prompt, no new file is ever created.
- The lifecycle fix is pure teardown hygiene: no change to any tool's behavior or output.
- All pre-existing test suites pass unmodified.

## [3.5.1] - 2026-05-26

### Fixed

- **Healthy Windows/OpenSSH sessions wrongly reported as `Dead`** ([#39](https://github.com/bvisible/mcp-ssh-manager/pull/39) — thanks @username77)
  - `ssh_connection_status` ran `echo "ping"` and compared the output with a strict `=== 'ping'`. On `cmd.exe` the surrounding quotes are echoed literally (output `"ping"`), so the check failed and a live pooled connection was torn down and rebuilt for nothing.
  - The probe now runs `echo ping` (no quotes), which emits a bare `ping` consistently across bash, `cmd.exe` and PowerShell — fixing the root cause rather than only the symptom.
  - Output parsing moved to a new exported helper `isPingAlive(stdout)` that normalizes CRLF, stray quotes/backslashes and case before matching, and is null/undefined-safe. `includes('ping')` (rather than strict equality) is intentional: a liveness probe should err toward "alive" — a false positive just lets the next real command reconnect, whereas a false negative needlessly drops a healthy connection.
  - **New test suite** `tests/test-ssh-ping.js` (wired into `npm test` as `test:ping`) covering the quoted/escaped/CRLF/case variants and the null/undefined paths. Validated against a real Windows/OpenSSH host.

## [3.5.0] - 2026-05-18

### Added

- **Per-server security modes** — opt-in second authorization layer that filters tool invocations and commands *inside* the MCP server, complementing the existing client-side `autoApprove` mechanism. Useful when sharing the MCP with a third-party agent, a CI bot, or any context where you can't fully trust the client. See [docs/SECURITY_MODES.md](docs/SECURITY_MODES.md).
  - New per-server fields (env: `SSH_SERVER_<N>_MODE`, `SSH_SERVER_<N>_ALLOW_PATTERNS`, `SSH_SERVER_<N>_DENY_PATTERNS`, `SSH_SERVER_<N>_AUDIT_LOG` — TOML: `mode`, `allow_patterns`, `deny_patterns`, `audit_log`).
  - Three modes: `unrestricted` (default — identical to v3.4.x), `readonly` (blocks mutating tools + built-in destructive command denylist), `restricted` (require regex allowlist + optional denylist, DENY wins over ALLOW).
  - Gated tools: `ssh_execute`, `ssh_execute_sudo`, `ssh_execute_group`, `ssh_session_send` (command-aware), `ssh_upload`, `ssh_sync`, `ssh_deploy`, `ssh_backup_create`, `ssh_backup_restore`, `ssh_backup_schedule`, `ssh_db_import`, `ssh_db_dump` (tool-level), plus action-gated `ssh_key_manage` (accept/remove), `ssh_alert_setup` (set), `ssh_process_manager` (kill).
  - Command aliases (`ssh_command_alias`) are expanded **before** policy evaluation, so the denylist can't be bypassed via an alias.
- **Audit log** — opt-in JSONL trail per server (set `SSH_SERVER_<N>_AUDIT_LOG` to a file path). Records `ts`, `server`, `tool`, sanitized `args`, `allowed`, `reason` (on denial), `exitCode`/`success`/`error` (on execution). Credentials (`password`, `passphrase`, `sudoPassword`, `token`, `secret`, `apikey`) are redacted to `***` even if a tool passes them through args. No log rotation built-in — use `logrotate`.
- **Interactive wizard prompts** (`ssh-manager server add`) for the three new fields, each with default = skip. Pressing Enter on all three produces an `.env` block identical to v3.4.x output.
- **New test suite** `tests/test-policy.js` — 26 tests covering the three modes, DENY > ALLOW precedence, invalid regex handling, secret redaction, fail-closed for unknown modes, backward-compat fast path.

### Backward compatibility

- **Zero impact on existing configs.** A v3.4.x `.env` or TOML file loads identically — no `MODE` field means `unrestricted`, and `evaluatePolicy()` early-returns `{ allowed: true }` without compiling a single regex.
- No new field is mandatory.
- The audit log file is never created unless `AUDIT_LOG` is explicitly set.
- `autoApprove` on the Claude Code side keeps working unchanged — the policy intercepts after the client approves, before the SSH command runs, so the client never sees a new prompt.
- All pre-existing tests (`test-profiles`, `test-command-aliases`, `test-hooks`, `test-tool-registry` — 13 tests) pass without modification.

## [3.4.1] - 2026-05-16

### Fixed

- **SSH handshake failing against OpenSSH 9.x servers (Debian 12 / Ubuntu 24.04)** ([#32](https://github.com/bvisible/mcp-ssh-manager/pull/32) — thanks @YoungHong1992)
  - The hardcoded algorithm list in `src/ssh-manager.js` was missing modern algorithms required by OpenSSH 9.x. The `ssh2` lib would fail the key-exchange phase against stock Debian 12 / Ubuntu 24.04 servers because no common KEX algorithm could be negotiated.
  - **KEX** — added `curve25519-sha256`, `curve25519-sha256@libssh.org`, `diffie-hellman-group15-sha512`, `diffie-hellman-group16-sha512`. `curve25519-sha256` is now OpenSSH's preferred default since 6.5.
  - **Server host key** — added `rsa-sha2-512` and `rsa-sha2-256` (RFC 8332). OpenSSH 8.2+ deprecates the SHA-1-based `ssh-rsa` signature algorithm in the default offer; without SHA-2 variants, RSA host keys could no longer be verified.
  - **Cipher** — added `aes128-gcm@openssh.com` and `aes256-gcm@openssh.com` at the head of the list (preferred GCM variants on modern OpenSSH; the plain `aes*-gcm` names were already present but are not what OpenSSH advertises).
  - **HMAC** — added `hmac-sha2-256-etm@openssh.com`, `hmac-sha2-512-etm@openssh.com`, `hmac-sha1-etm@openssh.com`. Encrypt-then-MAC is both faster and cryptographically stronger than encrypt-and-MAC; OpenSSH prefers ETM variants when both peers support them.
  - **Fully backward-compatible** — every legacy algorithm previously in the list (`diffie-hellman-group14-sha1`, `ssh-rsa`, CBC ciphers, plain `hmac-sha*`) is preserved at lower preference. Connections to older servers (CentOS 7, Debian 10, AIX, network gear with legacy SSH stacks) continue to work unchanged.

## [3.4.0] - 2026-05-07

### Added

- **Full Windows OpenSSH command execution** ([#31](https://github.com/bvisible/mcp-ssh-manager/pull/31) — thanks @WenKingSu)
  - When a server is configured with `platform = "windows"`, commands are now wrapped as `powershell -NoProfile -OutputFormat Text -EncodedCommand <utf16le-base64>`. This is the same approach used by Ansible, Chef, and Puppet for Windows remote execution. It sidesteps every `cmd.exe` quoting and OEM code page issue (CP950, CP932, CP1252…) that was causing mojibake on non-ASCII output.
  - Prepends `$ProgressPreference='SilentlyContinue'` (suppresses CLIXML progress sentinels in stderr) and `[Console]::OutputEncoding=UTF8` (forces clean UTF-8 stdout).
  - Working-directory prefix uses `Set-Location '${escapedDir}'; ${cmd}` (PowerShell-native, with `'` → `''` escaping) instead of `cd ${dir} && ${cmd}` which is invalid in `cmd.exe`. Applied consistently across `ssh_execute`, `ssh_execute_group`, and `ssh_execute_sudo`.
  - Strictly gated behind `platform === 'windows'` — Linux/macOS targets are completely unaffected.

### Fixed

- **`ssh_session_start` timing out on real-world shells** ([#20](https://github.com/bvisible/mcp-ssh-manager/issues/20), [#30](https://github.com/bvisible/mcp-ssh-manager/pull/30) — thanks @MakksSh)
  - The previous shell-prompt detection used a fragile regex (`/[$#>]\s*$/`) that broke on custom prompts, ANSI color codes, multiline prompts, slow shells, `.bashrc`/profile script noise, and any non-standard prompt symbol. Sessions would frequently fail to initialize with `Timeout waiting for shell prompt`.
  - Replaced with a marker-based protocol: the PTY is requested with `ECHO: 0`, a unique UUID v4 readiness marker is sent on session start, and every executed command is wrapped with `set +e; <cmd>; __mcp_status=$?; printf '\n<marker>:%s\n' "$__mcp_status"`. The completion marker carries the **real exit code** captured from `$?` instead of the previous `!output.includes('command not found')` heuristic.
  - A shell prompt is presentation, not a protocol boundary. Marker-based sync is shell-agnostic, deterministic, and requires zero per-server configuration.
  - Bonus: sessions now report accurate `success`/`exitCode` for downstream consumers.

## [3.3.0] - 2026-05-02

### Added

- **ProxyCommand support** for SOCKS5 and custom proxy connections ([#24](https://github.com/bvisible/mcp-ssh-manager/pull/24))
  - New `SSH_SERVER_<NAME>_PROXYCOMMAND` env var (and `proxy_command` in TOML) to specify a custom command (e.g. `ncat --proxy 127.0.0.1:1080 --proxy-type socks5 %h %p`, `ssh -W %h:%p bastion`).
  - Useful for reaching servers behind SOCKS5 proxies, custom jump hosts, or any scenario the existing `ProxyJump` doesn't cover.

### Fixed

- **`ssh_execute` timeout silently capped at 30 s** when the requested timeout was below 300 000 ms ([#28](https://github.com/bvisible/mcp-ssh-manager/issues/28), [#29](https://github.com/bvisible/mcp-ssh-manager/pull/29) — thanks @LukasOrcik for the precise root-cause analysis and @MakksSh for the patch)
  - In `execCommandWithTimeout`, the wrapped `timeout NNN sh -c …` path forwarded `otherOptions` to `ssh.execCommand` without a `timeout` key, so the underlying `SSHManager.execCommand` fell back to its hardcoded 30 000 ms default. The local stream was aborted at 30 s while the remote `timeout` wrapper was still running.
  - Now passes `timeout: timeoutMs + 5000` so the inner timer always exceeds the requested timeout. The +5000 grace lets the remote `timeout` binary return exit code 124/143 first, surfacing the nicer `Command timeout after Nms` message instead of a stream abort.

- **Windows global install fails with `/bin/bash` shim error** ([#22](https://github.com/bvisible/mcp-ssh-manager/issues/22), [#23](https://github.com/bvisible/mcp-ssh-manager/pull/23) — confirmed by @Eleef on Win11 / PS7)
  - npm's PowerShell shim refused to launch the legacy bash entry point because Windows has no `/bin/bash.exe`.
  - New cross-platform `cli/ssh-manager.js` Node wrapper is now the `bin.ssh-manager` entry point. On Windows it probes Git Bash → WSL → `bash` on PATH (with proper `C:\…` → `/c/…` and `/mnt/c/…` path conversion); on Unix it just `spawnSync`s `bash`.

- **`server add` blocked at startup by missing `rsync`** ([#22](https://github.com/bvisible/mcp-ssh-manager/issues/22) follow-up, [#26](https://github.com/bvisible/mcp-ssh-manager/pull/26))
  - `rsync` was in the **required** dependency list, but it's only used by `ssh-manager sync`. Git for Windows doesn't ship `rsync`, so the CLI was unusable on a stock Windows install for users who never call `sync`.
  - `rsync` is now optional. `cmd_sync` checks lazily and emits an actionable error with install hints for macOS / Debian / Windows (MSYS2 + WSL).

- **`server add` accepted hyphens in server names, producing entries invisible to MCP clients** ([#25](https://github.com/bvisible/mcp-ssh-manager/issues/25), [#27](https://github.com/bvisible/mcp-ssh-manager/pull/27) — thanks @alexeibugrov)
  - The Bash CLI used a loose regex when reading `.env` and accepted `web-server`, but POSIX env-var names disallow hyphens. The MCP Node loader uses a strict `/^SSH_SERVER_([A-Z0-9_]+)_HOST$/` and silently dropped the entry, so Claude Code reported zero servers while the CLI listed them.
  - `validate_server_name` now rejects `-` (and any other non-`[A-Za-z0-9_]`) at the prompt, with a copy-paste suggestion (`web-server` → `Try 'web_server' instead`).
  - `server list` detects pre-existing invalid entries, marks each affected row with `⚠ invalid`, and prints a warning block telling the user how to migrate.
  - Prompt examples updated from `web-server` to `web_server` in both `server add` and the interactive wizard.

## [3.1.2] - 2026-02-09

### Fixed

- **Windows compatibility**: Replace `process.env.HOME` with `os.homedir()` for cross-platform support ([#8](https://github.com/bvisible/mcp-ssh-manager/issues/8))
  - `process.env.HOME` is undefined on Windows, causing crash at startup
  - Fixed in `src/ssh-key-manager.js`, `src/index.js`, `src/ssh-manager.js`

## [3.1.1] - 2025-11-15

### 🔧 Stability & Performance Release

This release fixes critical issues causing Claude Code to crash or freeze during MCP tool execution, particularly with large command outputs.

### Fixed

- **Claude Code crashes**: Automatic output truncation prevents context overflow
  - All stdout/stderr outputs now limited to 10,000 characters (configurable)
  - Clear truncation indicator showing how many characters were cut
  - Prevents "Interrupted: What should Claude do instead?" errors

- **Timeout issues**: Default timeout increased from 30s to 2 minutes
  - Maximum timeout raised to 5 minutes for long-running operations
  - Prevents premature command termination

- **Standardized error responses**: Consistent JSON error format
  - Better error handling and logging
  - Improved debugging information

### Added

- **Performance configuration** via environment variables:
  - `MCP_SSH_MAX_OUTPUT_LENGTH`: Control output truncation (default: 10000)
  - `MCP_SSH_DEFAULT_TIMEOUT`: Set default command timeout (default: 120000ms)
  - `MCP_SSH_MAX_TIMEOUT`: Set maximum timeout limit (default: 300000ms)
  - `MCP_SSH_COMPACT_JSON`: Enable compact JSON responses (default: false)
  - `MCP_SSH_DEBUG`: Enable debug information (default: false)
  - `MCP_SSH_CONNECTION_TIMEOUT`: Connection idle timeout (default: 1800000ms)
  - `MCP_SSH_KEEPALIVE_INTERVAL`: Keepalive packet interval (default: 60000ms)

- **New configuration module** (`src/config.js`):
  - Centralized configuration management
  - Helper functions: `truncateOutput()`, `formatJSONResponse()`
  - Environment variable parsing with defaults

- **Troubleshooting documentation**:
  - Complete guide in `docs/TROUBLESHOOTING.md`
  - Best practices for handling large outputs
  - Performance optimization tips
  - Debugging steps for common issues

### Changed

- Updated `.env.example` with new performance configuration options
- Enhanced README with troubleshooting section for Claude Code crashes
- Improved error logging with detailed context

### Documentation

- Added comprehensive troubleshooting guide
- Updated README with performance tuning section
- Added examples for handling large command outputs

## [3.0.0] - 2025-10-01

### 🎉 Major Release - Enterprise DevOps Features

This major release transforms MCP SSH Manager into a comprehensive DevOps automation platform with **12 new MCP tools** across three major feature areas.

### Added

#### Phase 1: Backup & Restore System (v2.1)
- **ssh_backup_create**: Create database or file backups with compression
  - Supports MySQL, PostgreSQL, MongoDB, and file system backups
  - Automatic gzip compression and metadata tracking
  - Configurable retention policies
  - Auto-creates backup directory if missing
- **ssh_backup_list**: List all available backups with detailed metadata
- **ssh_backup_restore**: Restore from previous backups with cross-database support
- **ssh_backup_schedule**: Schedule automatic backups using cron

#### Phase 2: Health Checks & Monitoring (v2.2)
- **ssh_health_check**: Comprehensive server health monitoring
  - CPU, Memory (RAM/Swap), Disk usage for all filesystems
  - Network statistics, system uptime, load average
  - Overall health status: healthy/warning/critical
- **ssh_service_status**: Monitor services (nginx, mysql, docker, etc.)
  - Supports systemd and sysv init systems
  - Returns running/stopped status with PID
- **ssh_process_manager**: Process management
  - List top processes sorted by CPU or memory
  - Kill processes with configurable signals
- **ssh_alert_setup**: Configure health monitoring alerts with custom thresholds

#### Phase 3: Database Management (v2.3)
- **ssh_db_dump**: Create database dumps (MySQL, PostgreSQL, MongoDB)
  - Gzip compression and selective table backups
- **ssh_db_import**: Import and restore databases
  - Auto-detection of compressed files
- **ssh_db_list**: List databases or tables/collections
  - Filters system databases automatically
- **ssh_db_query**: Execute read-only SQL queries
  - **Security**: Only SELECT queries allowed
  - Blocks DROP, DELETE, UPDATE, ALTER operations

### Fixed

- **ssh_service_status**: Fixed parsing bug where active services were incorrectly detected as "stopped"
  - Redirected systemctl output to /dev/null for clean status detection

### Improved

- **ssh_backup_create**: Auto-creates backup directory with error handling
  - Previously required manual creation of `/var/backups/ssh-manager`

### Documentation

- Added `docs/BACKUP_GUIDE.md` with comprehensive backup strategies
- Added `examples/backup-workflow.js` with 13 real-world examples
- Updated README.md and CLAUDE.md with all new tools

### Technical Details

- **New Modules**: backup-manager.js (469 lines), health-monitor.js (428 lines), database-manager.js (555 lines)
- **Total Lines Added**: ~4,100 lines of production code
- **Total Tools**: 37 MCP tools (25 existing + 12 new)
- **Supported Databases**: MySQL, PostgreSQL, MongoDB
- **Security**: SQL injection prevention, read-only query enforcement

### Breaking Changes

None. All existing tools remain fully compatible.

---

## [1.3.0] - 2025-09-04

### Added
- OpenAI Codex compatibility with TOML configuration support
- Enhanced documentation visibility for both Claude Code and Codex
- Dual configuration format support (.env and TOML)
- Badge system in README for platform compatibility

---

## [1.2.0] - 2025-08-12

### Added
- **ssh_deploy** tool for automated file deployment with permission handling
- **ssh_execute_sudo** tool for secure sudo command execution
- **ssh_alias** tool for managing server aliases
- Server alias support - use short names like "prod" instead of full server names
- Automatic permission detection for system directories
- Backup creation before file deployment
- Service restart capability after deployment
- Deployment helper functions for complex workflows
- Comprehensive deployment guide documentation
- Example deployment workflows

### Enhanced
- Connection resolution now supports aliases and partial matches
- Better error messages with available servers and aliases
- Secure sudo password handling (masked in logs)
- Support for batch file deployments

### Security
- Sudo passwords are never logged in plain text
- Automatic masking of sensitive information in command output
- Secure temporary file handling during deployments

## [1.1.0] - 2025-08-11

### Added
- Default directory configuration per server
- DEFAULT_DIR field in .env configuration
- Automatic working directory for commands

### Fixed
- Syntax error in index.js (extra parenthesis)

## [1.0.0] - 2025-08-10

### Initial Release
- Core SSH connection management
- ssh_execute tool for remote command execution
- ssh_upload tool for file uploads
- ssh_download tool for file downloads
- ssh_list_servers tool to list configured servers
- Password and SSH key authentication support
- Interactive server configuration tool
- Connection testing utility
- Pre-commit hooks for code quality
- GitHub Actions workflow for CI/CD
