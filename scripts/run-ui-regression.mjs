import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

/** Compatibility entry points use the maintained Playwright assertions and
 * isolated fixtures. They never connect to a user's live control plane. */
export function runUiRegression(grep) {
  const script = path.basename(process.argv[1]);
  const args = process.argv.slice(2);
  const usage = `Usage: node scripts/${script} [Playwright flags]\n`
    + 'The UI must already be built (npm run build:ui). Install browser dependencies with\n'
    + 'npm ci --prefix ui && npm --prefix ui exec -- playwright install chromium.\n'
    + 'Examples: --headed, --list, --workers=1, --output=/tmp/ui-results\n'
    + 'Legacy URL/token and screenshot-directory positional arguments are no longer accepted.\n'
    + 'Tests create their own temporary control plane; failures exit nonzero.\n'
    + 'Reports: ui/playwright-report; traces and failure screenshots: ui/test-results.\n';
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    return;
  }
  if (args.length && !args[0].startsWith('-')) {
    console.error(`This entry point now runs isolated Playwright tests.\n${usage}`);
    process.exitCode = 2;
    return;
  }
  const ui = fileURLToPath(new URL('../ui', import.meta.url));
  if (!fs.existsSync(new URL('../dist/ui/index.html', import.meta.url))) {
    console.error(`The bundled UI is missing. Run npm run build:ui first.\n${usage}`);
    process.exitCode = 1;
    return;
  }
  let cli;
  try {
    const require = createRequire(new URL('../ui/package.json', import.meta.url));
    cli = require.resolve('@playwright/test/cli');
  } catch {
    console.error(`Playwright is not installed in ui/.\n${usage}`);
    process.exitCode = 1;
    return;
  }
  const result = spawnSync(process.execPath, [cli, 'test', 'tests/workspace.spec.ts', '--grep', grep, ...args], {
    cwd: ui, stdio: 'inherit', env: { ...process.env, PLAYWRIGHT_HTML_OPEN: 'never' },
  });
  if (result.error) console.error(`Could not start Playwright: ${result.error.message}`);
  process.exitCode = result.status ?? 1;
}
