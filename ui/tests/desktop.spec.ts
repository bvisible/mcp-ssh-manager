import { test, expect, apiUrl } from './fixtures';

const OFFER = 'SSH Manager is also a desktop app';

test('without the offer there is no banner and no endpoint', async ({ page, app }) => {
  await page.goto(app.url);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Servers' })).toBeVisible();
  await expect(page.getByText(OFFER)).toHaveCount(0);
  expect((await page.request.get(apiUrl(app, '/api/desktop'))).status()).toBe(404);
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
