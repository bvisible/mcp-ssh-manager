import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures';

test('Options → AI tools shows what each tool runs and switches it to the app and back', async ({ page, app }) => {
  // Claude Code on npm's engine, keeping a setting of its own; Codex installed
  // with no entry; Claude Desktop absent.
  const claudeJson = path.join(app.home, '.claude.json');
  await fs.writeFile(claudeJson, JSON.stringify({
    numStartups: 3,
    mcpServers: { 'ssh-manager': { type: 'stdio', command: 'node', args: ['/usr/lib/node_modules/mcp-ssh-manager/src/index.js'], env: { SSH_ENV_PATH: '/srv/.env' } } },
  }));
  await fs.mkdir(path.join(app.home, '.codex'));
  await fs.writeFile(path.join(app.home, '.codex', 'config.toml'), 'model = "o4"\n');

  await page.goto(app.url);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('tab', { name: 'AI tools' }).click();

  const tools = page.getByRole('list', { name: 'AI tools' });
  const claudeCode = tools.getByRole('listitem').filter({ hasText: 'Claude Code' });
  const codex = tools.getByRole('listitem').filter({ hasText: 'Codex' });
  const claudeDesktop = tools.getByRole('listitem').filter({ hasText: 'Claude Desktop' });
  await expect(claudeCode).toContainText('Runs the npm engine');
  await expect(codex).toContainText('No ssh-manager entry yet');
  await expect(claudeDesktop).toContainText('Not found on this machine');
  await expect(claudeDesktop.getByRole('button')).toHaveCount(0);
  await expect(page.getByText('4.0.0-test').first()).toBeVisible();

  await page.getByRole('button', { name: 'Claude Code: use the desktop app' }).click();
  await expect(claudeCode).toContainText("Runs the desktop app's engine 4.0.0-test");
  await expect(claudeCode.getByRole('status')).toContainText('Start a new Claude Code session');
  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));
  const accessibility = await new AxeBuilder({ page }).include('[role="tabpanel"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(accessibility.violations).toEqual([]);
  let written = JSON.parse(await fs.readFile(claudeJson, 'utf8'));
  expect(written.numStartups).toBe(3);
  expect(written.mcpServers['ssh-manager'].env).toEqual({ SSH_ENV_PATH: '/srv/.env', ELECTRON_RUN_AS_NODE: '1' });

  await page.getByRole('button', { name: 'Claude Code: use npm' }).click();
  await expect(claudeCode).toContainText('Runs the npm engine');
  written = JSON.parse(await fs.readFile(claudeJson, 'utf8'));
  expect(written.mcpServers['ssh-manager'].env).toEqual({ SSH_ENV_PATH: '/srv/.env' });

  await page.getByRole('button', { name: 'Codex: use the desktop app' }).click();
  await expect(codex).toContainText("Runs the desktop app's engine");
  const toml = await fs.readFile(path.join(app.home, '.codex', 'config.toml'), 'utf8');
  expect(toml).toMatch(/^model = "o4"\n\n\[mcp_servers\.ssh-manager\]\n/);
});
