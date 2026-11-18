import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { reportCommand, requestApproval } from './engine';

const longCommand = (marker: string) =>
  `echo ${Array.from({ length: 12 }, (_, i) => `"segment-${i}-abcdefghijklmnopqrstuvwxyz"`).join(' ')} "${marker}"`;

async function openActivity(page: Page, url: string) {
  await page.goto(url);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Activity', exact: true }).click();
}

/**
 * The entry is a one-line overview with the command as its title; opening it
 * shows the command in full, wrapped, selectable and copyable.
 */
async function expectFullCommandOnOpen(page: Page, row: Locator, command: string, marker: string) {
  const overview = row.locator('code');
  await expect(overview).toHaveAttribute('title', command);
  expect(await overview.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  await expect(row).toHaveAttribute('aria-expanded', 'false');

  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');

  // Wrapped rather than clipped, and outside the toggle: a click to select it
  // must not close the entry.
  const full = page.locator('pre', { hasText: marker });
  await expect(full).toHaveText(command);
  expect(await full.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  expect(await full.evaluate(element => element.closest('button') === null)).toBe(true);
  await full.click();
  await expect(full).toBeVisible();

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy the command' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(command);

  await row.click();
  await expect(full).toHaveCount(0);
}

test('Activity → Commands opens an entry to its full command, output kept or not', async ({ page, app }) => {
  // The default: output is not kept, and the entry used to be a disabled
  // button that could not be opened at all.
  const command = longCommand('END-OF-COMMAND');
  await reportCommand(app.approvalSocket, command, 'not kept\r\n');
  await openActivity(page, app.url);

  const row = page.getByRole('button', { name: /segment-0-/ });
  await expect(row).toBeEnabled();
  await expectFullCommandOnOpen(page, row, command, 'END-OF-COMMAND');
});

test('Activity → Commands keeps several entries open, as new ones arrive', async ({ page, app }) => {
  const first = longCommand('END-OF-FIRST');
  const second = longCommand('END-OF-SECOND');
  await reportCommand(app.approvalSocket, first, '');
  await reportCommand(app.approvalSocket, second, '');
  await openActivity(page, app.url);

  await page.getByRole('button', { name: /END-OF-FIRST/ }).click();
  await page.getByRole('button', { name: /END-OF-SECOND/ }).click();
  await expect(page.locator('pre', { hasText: 'END-OF-FIRST' })).toHaveText(first);
  await expect(page.locator('pre', { hasText: 'END-OF-SECOND' })).toHaveText(second);

  // A new command lands at the top and shifts every row down. What was open
  // stays open, and is the same element: a row rebuilt under the reader loses
  // the text they were selecting.
  const opened = page.locator('pre', { hasText: 'END-OF-FIRST' });
  await opened.evaluate(element => { (element as HTMLElement & { marked?: boolean }).marked = true; });
  await reportCommand(app.approvalSocket, 'uptime', '');
  await expect(page.getByRole('button', { name: /uptime/ })).toBeVisible();
  await expect(page.locator('pre', { hasText: 'END-OF-SECOND' })).toBeVisible();
  expect(await opened.evaluate(element => (element as HTMLElement & { marked?: boolean }).marked)).toBe(true);
});

test.describe('with output kept', () => {
  test.use({ logOutput: true });

  test('Activity → Commands shows the full command above the output', async ({ page, app }) => {
    const command = longCommand('END-OF-COMMAND');
    await reportCommand(app.approvalSocket, command, 'output-was-kept\r\n');
    await openActivity(page, app.url);

    await page.getByRole('button', { name: /segment-0-/ }).click();
    const full = page.locator('pre', { hasText: 'END-OF-COMMAND' });
    await expect(full).toHaveText(command);
    await expect(page.getByText('output-was-kept')).toBeVisible();
    // The command first, then what it printed.
    const [commandTop, outputTop] = await Promise.all([
      full.evaluate(element => element.getBoundingClientRect().top),
      page.getByText('output-was-kept').evaluate(element => element.getBoundingClientRect().top),
    ]);
    expect(commandTop).toBeLessThan(outputTop);
  });
});

test('Activity → Decisions opens an entry to its full command', async ({ page, app }) => {
  const command = longCommand('END-OF-DECISION');
  const request = requestApproval(app.approvalSocket, command);

  await page.goto(app.url);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Waiting', exact: true }).click();
  await page.getByRole('button', { name: 'Refuse' }).click();
  expect((await request.decision).decision).toBe('deny');

  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  await page.getByRole('button', { name: /^Decisions/ }).click();
  const row = page.getByRole('button', { name: /segment-0-/ });
  await expect(row).toContainText('refused');
  await expectFullCommandOnOpen(page, row, command, 'END-OF-DECISION');
});
