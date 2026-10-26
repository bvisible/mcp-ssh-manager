import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect, apiUrl } from './fixtures';

test('outside the desktop application there is no Updates tab and no endpoint', async ({ page, app }) => {
  await page.goto(app.url);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Appearance' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Updates/ })).toHaveCount(0);
  expect((await page.request.get(apiUrl(app, '/api/app-update'))).status()).toBe(404);
});

test.describe('the desktop application', () => {
  test.use({ appUpdates: true });

  test('says there is an update, offers it, downloads it and restarts into it on a click each', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();

    // Nothing to say yet: no mark on the rail.
    await expect(page.getByRole('button', { name: 'Options', exact: true })).toBeVisible();
    await expect(page.getByText('Update available')).toHaveCount(0);

    await page.getByRole('button', { name: 'Options', exact: true }).click();
    await page.getByRole('tab', { name: 'Updates' }).click();
    await expect(page.getByRole('heading', { name: 'SSH Manager 4.0.0-beta.3' })).toBeVisible();
    await expect(page.getByText('preview build')).toBeVisible();
    await expect(page.getByText('Not checked yet.')).toBeVisible();

    // A check that finds something, anywhere: the panel, the rail and the tab all say so.
    await page.getByRole('button', { name: 'Check now' }).click();
    await expect(page.getByText('Checking for updates…')).toBeVisible();
    await expect(page.getByText('Version 4.1.0 is available')).toBeVisible();
    // The rail's mark: its name follows the state, so it is found by where it is and what it says.
    const chip = page.locator('.sidebar-nav').getByRole('button').filter({ hasText: 'Version 4.1.0' });
    await expect(chip).toContainText('Update available');
    await expect(page.getByRole('button', { name: 'Options (update available)' })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Updates/ }).getByRole('img', { name: 'update available' })).toBeVisible();

    await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));
    const accessibility = await new AxeBuilder({ page }).include('[role="tabpanel"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
    expect(accessibility.violations).toEqual([]);

    await page.getByRole('button', { name: 'Download 4.1.0' }).click();
    await expect(page.getByRole('progressbar', { name: 'Download' })).toBeVisible();
    await expect(page.getByText('Version 4.1.0 is ready to install')).toBeVisible({ timeout: 10_000 });
    await expect(chip).toContainText('Restart to update');

    // Restarting is a deliberate second click, and it is the application that quits.
    await page.getByRole('tabpanel').getByRole('button', { name: 'Restart to update' }).click();
    await expect.poll(async () => fs.readFile(path.join(app.home, 'update-installed.flag'), 'utf8').catch(() => ''), { timeout: 5_000 }).toBe('1');
  });

  test('the mark on the rail opens Options at the Updates tab, from any screen', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    // Found by the control plane rather than by a click in the page.
    await page.request.post(apiUrl(app, '/api/app-update/check'));
    const chip = page.getByRole('button', { name: /Update available/ });
    await expect(chip).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Servers' })).toBeVisible();
    await chip.click();
    await expect(page.getByRole('tab', { name: /Updates/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByText('Version 4.1.0 is available')).toBeVisible();
  });
});
