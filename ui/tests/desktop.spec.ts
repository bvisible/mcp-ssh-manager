import AxeBuilder from '@axe-core/playwright';
import { test, expect, apiUrl } from './fixtures';
import { selectorLabel } from './languages';

const OFFER = 'SSH Manager is also a desktop app';
const KEEP_RUNNING = 'Keep running in the background when the window is closed';

test('without the offer there is no banner and no endpoint', async ({ page, app }) => {
  await page.goto(app.url);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Servers' })).toBeVisible();
  await expect(page.getByText(OFFER)).toHaveCount(0);
  expect((await page.request.get(apiUrl(app, '/api/desktop'))).status()).toBe(404);

  // A browser tab has no tray to stay in: the desktop window option is absent.
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Appearance' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: KEEP_RUNNING })).toHaveCount(0);
});

test('inside the Windows and Linux wrapper, keeping the app in the tray is off until chosen and persists across ports', async ({ page, app }) => {
  await page.goto(`${app.url}&shell=overlay`);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Options', exact: true }).click();

  const toggle = page.getByRole('checkbox', { name: KEEP_RUNNING });
  await expect(toggle).toBeVisible();
  await expect(toggle).not.toBeChecked();
  const initialPrefs = (await (await page.request.get(apiUrl(app, '/api/preferences'))).json()).preferences;
  expect(initialPrefs['ssh-manager.close-to-tray']).toBeUndefined();

  await page.evaluate(() => Promise.all(document.getAnimations().map(animation => animation.finished)));
  const accessibility = await new AxeBuilder({ page }).include('[role="tabpanel"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(accessibility.violations).toEqual([]);

  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect.poll(async () => (await (await page.request.get(apiUrl(app, '/api/preferences'))).json()).preferences['ssh-manager.close-to-tray']).toBe('true');

  const oldPort = new URL(app.url).port;
  await app.restart();
  expect(new URL(app.url).port).not.toBe(oldPort);
  await page.goto(`${app.url}&shell=overlay`);
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(toggle).toBeChecked();

  await page.getByLabel(selectorLabel, { exact: true }).selectOption('zh-CN');
  const zhToggle = page.getByRole('checkbox', { name: '关闭窗口后保持在后台运行' });
  await expect(zhToggle).toBeChecked();
  await zhToggle.uncheck();
  await expect(zhToggle).not.toBeChecked();
  await expect.poll(async () => (await (await page.request.get(apiUrl(app, '/api/preferences'))).json()).preferences['ssh-manager.close-to-tray']).toBe('false');
});

test('inside the macOS wrapper, keeping the app in the menu bar is on by default and can be turned off', async ({ page, app }) => {
  await page.goto(`${app.url}&shell=macos`);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Options', exact: true }).click();

  const toggle = page.getByRole('checkbox', { name: KEEP_RUNNING });
  await expect(toggle).toBeVisible();
  await expect(toggle).toBeChecked();
  const initialPrefs = (await (await page.request.get(apiUrl(app, '/api/preferences'))).json()).preferences;
  expect(initialPrefs['ssh-manager.close-to-tray']).toBeUndefined();

  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();
  await expect.poll(async () => (await (await page.request.get(apiUrl(app, '/api/preferences'))).json()).preferences['ssh-manager.close-to-tray']).toBe('false');

  await page.reload();
  await page.getByRole('button', { name: 'Options', exact: true }).click();
  await expect(toggle).not.toBeChecked();
});

test.describe('a control plane started by ssh-manager control', () => {
  test.use({ offerDesktop: true });

  test('offers the app in a browser tab, never inside the app, and remembers "Not now"', async ({ page, app }) => {
    const options = await (await page.request.get(apiUrl(app, '/api/options'))).json();
    expect(options.offerDesktop).toBe(true);

    await page.goto(app.url);
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await expect(page.getByText(OFFER)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Install the app', exact: true })).toBeVisible();

    // The desktop application loads the same page with ?shell=…; offering it
    // the application it is running in would be absurd.
    await page.goto(`${app.url}&shell=macos`);
    await expect(page.getByRole('heading', { name: 'Servers' })).toBeVisible();
    await expect(page.getByText(OFFER)).toHaveCount(0);

    await page.goto(app.url);
    await page.getByRole('button', { name: 'Not now', exact: true }).click();
    await expect(page.getByText(OFFER)).toHaveCount(0);
    // Remembered by the control plane, not the origin: it outlives a reload.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Servers' })).toBeVisible();
    await expect(page.getByText(OFFER)).toHaveCount(0);
  });

  test('install draws its progress, then hands over without crying "connection lost"', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Install the app', exact: true }).click();

    await expect(page.getByRole('progressbar', { name: 'Download' })).toBeVisible();
    await expect(page.getByText('Continued in the desktop app.')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: 'Install the app', exact: true })).toHaveCount(0);

    const status = await (await page.request.get(apiUrl(app, '/api/desktop'))).json();
    expect(status).toMatchObject({ installed: true, handingOver: true, phase: 'handover' });
  });
});
