# Final V4 test before publication

This is a candidate review. A successful test does not publish a package, create
a release tag, or update existing users. Use the exact reviewed commit and its
**Release desktop apps** run with `publish: false`; keep that run URL with the
test results. The npm tarball and desktop installers must come from that commit.

## Start with an isolated preview

From the candidate checkout, install its dependencies and start a browser preview:

```sh
npm ci
node scripts/preview-candidate.mjs --engine .
```

Open the local URL printed in the terminal. The launcher creates two servers,
`demo_app` and `demo_backup`, in a disposable profile, with a local SSH fixture
at `127.0.0.1` and an available port. Remote commands are simulated; SFTP uses
real temporary files. The sample upload path is printed in the terminal.
The profile isolates application state, not operating-system permissions: the
desktop's local terminal remains a real shell. Use only `pwd` and harmless
`echo` commands there during this review.

Keep the launcher running. Type **`r` + Enter** there to restart the candidate
with the same profile. **`q` + Enter**, Ctrl-C or quitting the candidate ends the
session and removes that profile. Record results before quitting. Do not select
personal SSH configuration, import real credentials, or connect to a production
server during this review. Stop the previous preview before starting another.

`SSH_MANAGER_HOME` alone is not a complete desktop sandbox: Electron's profile,
SSH files and the OS keychain have separate locations. Use the preview launcher
for the functional review. Use a disposable OS account or VM for a normal
installer launch and the platform checks below. A VM snapshot also gives an
unambiguous installer rollback.

## Review together: about 20 minutes

Record pass/fail and a short reproduction for each item. Redact authentication
URLs, tokens, credentials and private paths from screenshots and logs.

1. **SSH workspace:** open `demo_app`, then its terminal. Run `whoami`,
   `hostname` and `pwd`; expect `demo`, `local-preview-fixture` and `/srv`.
   On desktop, also open a local terminal and run `echo v4-local-ok`.
2. **Files:** open `/srv`, download `README.txt`, upload the printed
   `upload-me.txt` sample into `/srv/uploads`, then download that copy. Check its
   filename and contents. Use only the sample file and scratch directories.
3. **Persistence:** create a group, save `uptime` as a command, change theme and
   list/grid view, then type `r` + Enter in the launcher. The servers, groups,
   saved command and preferences remain available after the restart.
4. **Recovery:** create an encrypted recovery backup with a test passphrase.
   Delete only `demo_backup`, preview the backup and cancel; the server stays
   deleted. Preview again, restore, and confirm that server connects again.
   Do this within the same launcher session: a new session has new fixture
   credentials. Groups and preferences are not part of a recovery backup.
5. **Feedback and layout:** resize the window, navigate with Tab and Escape,
   inspect the server form, terminal and vault panel. In the browser preview,
   leave its page open and type `q` + Enter in the launcher. Connection loss must
   be visible; the page must not present stale data as a live connection.

This populated preview skips onboarding and legacy import. The browser suite
checks those with fresh and legacy fixture profiles, including keyboard focus,
source-file preservation and advanced fields; see [TESTING-V4.md](TESTING-V4.md).
A manual first-launch/import check belongs in a clean test account with fixture
configuration, not the user's real configuration.

If the maintainer drives an MCP request against this isolated fixture, enable
approval and observe one prompt, then reject and approve separate requests.
A direct UI command does not exercise MCP approval. Record that distinction;
the automated security tests cover rejection and a disconnected control plane.

## Test the npm package without replacing a global installation

From a disposable checkout of the candidate, using Node 24:

```sh
npm ci
npm run test:published-upgrade
```

This installs the real registry 3.8.5 into temporary directories, upgrades to
the candidate tarball, then reinstalls 3.8.5. It verifies `.env`, TOML and process
environment configurations, 37 MCP tool schemas, source-file preservation and
headless behavior. It does not change the global npm package or MCP client
configuration. Record the command's exit status and candidate commit.

For a manual package installation in the disposable account, create an empty
`../v4-final-test` directory next to the checkout, then run:

```sh
npm pack --pack-destination ../v4-final-test
npm install --prefix ../v4-final-test/npm --no-audit --no-fund ../v4-final-test/mcp-ssh-manager-4.0.0.tgz
```

Use the filename printed by `npm pack` if the candidate version differs. Test
this installed package without changing a real client's MCP entry:

```sh
node scripts/preview-candidate.mjs --engine ../v4-final-test/npm/node_modules/mcp-ssh-manager
```

A source-checkout preview alone does not prove the packed interface and
dependencies are present.

## Get the actual desktop installers

The maintainer supplies `RUN_ID` for the successful candidate run. Replace that
placeholder below. Download all three artifact sets from that same run into an
empty directory; do not mix retries or an older build with the same version.

```sh
gh run view RUN_ID --json headSha,conclusion,url
gh run download RUN_ID --name validated-darwin --dir ../v4-final-test/artifacts
gh run download RUN_ID --name validated-win32 --dir ../v4-final-test/artifacts
gh run download RUN_ID --name validated-linux --dir ../v4-final-test/artifacts
```

Check every manifest, size and SHA256 against the checkout before opening an
installer. This command imports only the verifier; it does not publish:

```sh
node --input-type=module -e "import fs from 'node:fs'; import {execFileSync} from 'node:child_process'; import {verifyArtifacts} from './scripts/publish-desktop.mjs'; const version=JSON.parse(fs.readFileSync('package.json')).version; const commit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(); console.log('Verified files:',verifyArtifacts('../v4-final-test/artifacts',version,commit).length)"
```

| Platform | Candidate to open in a disposable account/VM | Check |
| --- | --- | --- |
| macOS Apple silicon / Intel | Matching `*-arm64.dmg` / `*-x64.dmg`; copy the app into the test account's Applications directory | Download/open through the normal browser/Finder path; no Gatekeeper bypass. Check the app signature before and after the persistence test. |
| Windows x64 / arm64 | `*-setup.exe`; choose a separate per-user test installation | Check installer and installed app Authenticode status. An unsigned test build is not a signed-release success. |
| Linux x64 | Install the `.deb` in a disposable VM; test the executable `*.AppImage` separately. | Start the installed app and local terminal as an ordinary user. Record distribution/version and any AppImage sandbox or FUSE failure; do not disable the sandbox to obtain a pass. |

For the isolated functional review of an extracted/installed macOS app:

```sh
node scripts/preview-candidate.mjs --app "/absolute/path/SSH Manager.app"
```

On Windows or Linux, pass the actual unpacked/installed application executable
with its adjacent `resources` directory. Do not pass the NSIS installer, DMG,
AppImage container or ZIP to this launcher. It rejects older builds without
explicit preview isolation. Installer/Gatekeeper acceptance is tested separately
in the disposable OS account; preview launch alone does not establish it.

On macOS, set `SSH_V4_APP` to the installed candidate path, then run before and
after ordinary use:

```sh
codesign --verify --deep --strict "$SSH_V4_APP"
spctl --assess --type execute --verbose "$SSH_V4_APP"
xcrun stapler validate "$SSH_V4_APP"
```

Do not strip quarantine, disable Gatekeeper, or modify the bundle to turn a
failure into a pass. For Windows, use PowerShell's `Get-AuthenticodeSignature`
on the downloaded installer and installed `SSH Manager.exe`; record `Status`
and the certificate subject. Test native arm64/x64 machines where available;
a runner launch on one architecture does not exercise the other.

## Rollback and the update boundary

For the preview, record results, then type `q` + Enter in its launcher. It
removes the temporary profile; return to the untouched installed application or
client. For installer tests, quit the app and revert the disposable VM snapshot
or reinstall the retained previous build. Keep the test profile and its backup
outside the installation directory.

For the isolated npm installation above, a manual rollback is:

```sh
npm install --prefix ../v4-final-test/npm --no-audit --no-fund mcp-ssh-manager@3.8.5
```

3.8.5 uses the retained original `.env`/TOML, not credentials added only to a V4
vault. Its package-local groups may also differ from V4's user-state groups.
Before any later trial on a real installation, retain the original config,
package-local groups, user-state files, SSH key files and an encrypted recovery
backup; verify that backup can be restored. A vault file alone is not a portable
backup of its key. See [MIGRATION.md](MIGRATION.md).

Reinstalling a candidate proves replacement and persistence. It does not prove
automatic download, quit, installation and restart. A true updater test needs
two distinct candidate versions and an isolated test feed, followed by a check
that stable clients are not offered prereleases. Do not point normal clients
at a test feed. The preview disables automatic updates deliberately.

## Decision record

Attach the candidate commit, workflow URL, manifest verification result, tested
OS/architecture, npm upgrade result, checklist results and unresolved defects.
Installation, normal use after restart, signature checks and any updater test
must each have their own result. “Not tested” stays visible.

As checked on 2026-09-07, the repository has the five required macOS signing and
notarization secret names; their validity is proved only by the new build.
`WIN_CSC_LINK` and `WIN_CSC_KEY_PASSWORD` are absent. An unsigned Windows dry run
can support the functional review, but stable desktop publication remains
blocked until real signing is configured and verification passes. Linux also
needs its first complete candidate run. No certificate values belong in the
test record.

The latest public release, [v3.8.5](https://github.com/bvisible/mcp-ssh-manager/releases/tag/v3.8.5),
contains no desktop installer or updater feed. Old CI build artifacts do not
establish a released desktop upgrade path. Resolve the updater test plan before
claiming that path is validated. Publication remains a separate explicit
decision after this review; follow [DISTRIBUTION.md](DISTRIBUTION.md) then.
