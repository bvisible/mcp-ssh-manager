# Download numbers

The **downloads** and **desktop app downloads** badges in the README are
recomputed once a day by the [Download stats](../.github/workflows/download-stats.yml)
workflow, with [`scripts/download-stats.mjs`](../scripts/download-stats.mjs).
The raw numbers and the time they were taken are in
[`stats.json`](https://github.com/bvisible/mcp-ssh-manager/blob/stats/stats.json).

**Counted**

- **npm**: every download the npm registry reports for `mcp-ssh-manager` since
  its first version. Like every npm download count, it includes updates, CI
  machines and mirrors, not only people.
- **Desktop app**: the installers attached to the GitHub releases (`.dmg`,
  `-setup.exe`, `.AppImage`, `.deb`) and the archives a macOS app downloads to
  update itself (`.zip`).
- **Package tarballs** attached to some releases (`.tgz`), in the total only.

**Not counted**

- The update feeds (`latest-mac.yml`, `latest.yml`, `latest-linux.yml`): the
  application reads one every time it checks for an update, so they measure
  checks, not downloads. GitHub's own download counter includes them, which is
  why the README does not use it.
- Blockmaps, release manifests and the SBOM, which tools read alongside a
  download.
- Homebrew installs: they fetch the npm tarball, so npm already counts them.
