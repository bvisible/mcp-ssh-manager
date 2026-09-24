import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, apiUrl, legacyConfig } from './fixtures';

test('welcome is accessible, finishes into a working form, and stays dismissed', async ({ page, app }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(app.url);
  const welcome = page.getByRole('dialog');
  await expect(welcome).toHaveAccessibleName('Your servers. Your workspace.');
  await expect(welcome.locator('svg')).not.toHaveCount(0);
  const accessibility = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(accessibility.violations).toEqual([]);
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await welcome.evaluate(node => node.contains(document.activeElement))).toBe(true);
  }
  await welcome.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(welcome).toHaveAccessibleName('Bring your servers along.');
  await welcome.getByRole('button', { name: 'Next', exact: true }).click();
  await expect(welcome).toHaveAccessibleName('Stay in control.');
  await welcome.getByRole('button', { name: 'Add a server', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Add a server' });
  await expect(form).toBeVisible();
  await form.getByLabel('Name', { exact: true }).fill('first');
  await form.getByLabel('Host', { exact: true }).fill('127.0.0.1');
  await form.getByLabel('User', { exact: true }).fill('fixture');
  await form.getByLabel('Password', { exact: true }).fill('only-a-fixture');
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toBeHidden();
  await expect(page.getByText('Approval off', { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Servers' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('import action in welcome opens the importer directly', async ({ page, app }) => {
  await page.goto(app.url);
  const welcome = page.getByRole('dialog');
  await welcome.getByRole('button', { name: 'Next', exact: true }).click();
  await welcome.getByRole('button', { name: 'Import servers', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveAccessibleName(/Import/);
  await expect(page.getByRole('heading', { name: 'Bring your servers along.' })).toHaveCount(0);
});

test('preferences survive a new control-plane port and reduced motion disables artwork animation', async ({ page, app }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(app.url);
  await expect(page.locator('.welcome-illustration')).toHaveCSS('animation-name', 'none');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.request.post(apiUrl(app, '/api/servers'), {
    data: { name: 'preference_fixture', host: '127.0.0.1', user: 'fixture', group: 'infra' },
  });
  await expect(page.getByText('preference_fixture', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show as a list' }).click();
  await page.getByRole('button', { name: 'infra 1', exact: true }).click();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await page.getByRole('button', { name: 'Dark always dark', exact: true }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await page.getByRole('button', { name: 'Collapse the sidebar' }).click();
  await expect.poll(async () => (await page.request.get(apiUrl(app, '/api/preferences'))).json().then(x => ({
    sidebar: x.preferences['ssh-manager.sidebar-expanded'], theme: x.preferences['ssh-manager.theme'],
    views: JSON.parse(x.preferences['ssh-manager.view-settings'] || '{}'),
  }))).toEqual({ sidebar: 'false', theme: 'dark', views: { serverViewMode: 'list', collapsedCategories: ['infra'] } });
  await app.restart();
  await page.goto(app.url);
  await expect(page.getByRole('button', { name: 'Expand the sidebar' })).toBeVisible();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.getByRole('button', { name: 'Show as a grid' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'infra 1', exact: true })).toBeVisible();
  await expect(page.getByText('preference_fixture', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('lost control-plane connection is visible instead of silently displaying stale state', async ({ page, app }) => {
  await page.goto(app.url);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Control plane connected');
  await app.stop();
  await expect(page.getByRole('status')).toContainText('Connection lost');
});

test('welcome fits a narrow viewport and keyboard Escape dismisses it', async ({ page, app }) => {
  await page.setViewportSize({ width: 390, height: 740 });
  await page.goto(app.url);
  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();
  const box = await modal.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.width).toBeLessThanOrEqual(390);
  await page.keyboard.press('Escape');
  await expect(modal).toBeHidden();
});

test.describe('existing CLI users adopting the interface', () => {
  test.use({ legacy: true });
  test('import is optional and keeps the original configuration; editing preserves advanced fields', async ({ page, app }) => {
    await page.goto(app.url);
    await expect(page.getByText('Your existing setup keeps working')).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Import it', exact: true }).click();
    await expect(page.getByText('legacy', { exact: true })).toBeVisible();
    expect(await fs.readFile(path.join(app.home, '.env'), 'utf8')).toBe(legacyConfig);
    await page.getByRole('button', { name: 'Toggle edit mode' }).click();
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'Edit legacy' });
    await form.getByLabel('Port', { exact: true }).fill('2222');
    await form.getByLabel('Approval', { exact: true }).selectOption('always');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(form).toBeHidden();
    const response = await page.request.get(apiUrl(app, '/api/servers'));
    const { servers } = await response.json();
    expect(servers[0]).toMatchObject({ name: 'legacy', port: 2222, proxyJump: 'bastion', mode: 'restricted', allowPatterns: ['^uptime$'], approval: 'always', hasPassword: true });
    expect(JSON.stringify(servers)).not.toContain('fixture-only-secret');
    await expect(page.getByText('Approval: every request')).toBeVisible();
    expect(await fs.readFile(path.join(app.home, '.env'), 'utf8')).toBe(legacyConfig);
  });
});
