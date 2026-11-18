import { test, expect } from './fixtures';
import { reportCommand } from './engine';

test('Live shows a long command in full after its row is clicked',async ({ page, app }) => {
  const command = `echo ${Array.from({ length: 12 }, (_, i) => `"segment-${i}-abcdefghijklmnopqrstuvwxyz"`).join(' ')} "END-OF-COMMAND"`;
  await reportCommand(app.approvalSocket, command, 'done\r\n');

  await page.goto(app.url);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Live', exact: true }).click();

  // The row stays a one-line overview; hovering it gives the rest.
  const row = page.getByRole('button', { name: /segment-0-/ });
  const overview = row.locator('code');
  await expect(overview).toHaveAttribute('title', command);
  expect(await overview.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);

  await row.click();

  // The whole command, wrapped rather than clipped, and outside the toggle: a
  // click to select it must not collapse the row.
  const full = page.locator('pre', { hasText: 'END-OF-COMMAND' });
  await expect(full).toHaveText(command);
  expect(await full.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await full.evaluate(element => element.closest('button') === null)).toBe(true);
  await full.click();
  await expect(full).toBeVisible();

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy the command' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);
});
