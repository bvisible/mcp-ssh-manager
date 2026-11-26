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
  // Measured at rest: the copy fades in over 250 ms, and axe reading a colour
  // halfway through that fade reports the fade, not the design.
  await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState !== 'running'));
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

test('every native select and option carries an opaque surface and readable contrast in light and dark themes', async ({ page, app }) => {
  await page.goto(app.url);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();

  const inspectSelects = (scopeSelector: string) => page.locator(`${scopeSelector} select`).evaluateAll(selects => {
    const parseColor = (raw: string) => {
      const nums = raw.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0, 0];
      const [r = 0, g = 0, b = 0] = nums;
      const a = nums.length >= 4 ? nums[3] : 1;
      return { r, g, b, a };
    };
    const luminance = ({ r, g, b }: { r: number; g: number; b: number }) => {
      const channel = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
    };
    const contrast = (fg: { r: number; g: number; b: number }, bg: { r: number; g: number; b: number }) => {
      const l1 = luminance(fg);
      const l2 = luminance(bg);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };

    return selects.map(select => {
      const selStyle = getComputedStyle(select);
      const selBg = parseColor(selStyle.backgroundColor);
      const selFg = parseColor(selStyle.color);
      const options = [...select.querySelectorAll('option')].map(option => {
        const optStyle = getComputedStyle(option);
        const optBg = parseColor(optStyle.backgroundColor);
        const optFg = parseColor(optStyle.color);
        return {
          background: optStyle.backgroundColor,
          alpha: optBg.a,
          bgLum: luminance(optBg),
          contrast: contrast(optFg, optBg),
        };
      });
      return {
        background: selStyle.backgroundColor,
        alpha: selBg.a,
        bgLum: luminance(selBg),
        contrast: contrast(selFg, selBg),
        options,
      };
    });
  });

  const assertReadable = (
    items: Awaited<ReturnType<typeof inspectSelects>>,
    expectedCount: number,
    theme: 'light' | 'dark'
  ) => {
    expect(items).toHaveLength(expectedCount);
    for (const item of items) {
      expect(item.alpha, `<select> background (${item.background}) in ${theme}`).toBe(1);
      expect(item.contrast, `<select> contrast in ${theme}`).toBeGreaterThanOrEqual(4.5);
      if (theme === 'dark') expect(item.bgLum).toBeLessThan(0.05);
      else expect(item.bgLum).toBeGreaterThan(0.8);

      expect(item.options.length).toBeGreaterThan(0);
      for (const opt of item.options) {
        expect(opt.alpha, `<option> background (${opt.background}) in ${theme}`).toBe(1);
        expect(opt.contrast, `<option> contrast in ${theme}`).toBeGreaterThanOrEqual(4.5);
        if (theme === 'dark') expect(opt.bgLum).toBeLessThan(0.05);
        else expect(opt.bgLum).toBeGreaterThan(0.8);
      }
    }
  };

  for (const [theme, buttonName] of [
    ['dark', 'Dark always dark'],
    ['light', 'Light always light, whatever the system does'],
  ] as const) {
    await page.getByRole('button', { name: 'Options', exact: true }).click();
    await page.getByRole('tab', { name: 'Appearance' }).click();
    await page.getByRole('button', { name: buttonName, exact: true }).click();
    if (theme === 'dark') await expect(page.locator('html')).toHaveClass(/dark/);
    else await expect(page.locator('html')).not.toHaveClass(/dark/);

    // 1. Options → Appearance language <select>
    assertReadable(await inspectSelects('[role="tabpanel"]'), 1, theme);

    // 2. Options → Groups → New group dialog <select>
    await page.getByRole('tab', { name: 'Groups' }).click();
    await page.getByRole('button', { name: 'New group', exact: true }).click();
    const groupDialog = page.getByRole('dialog', { name: 'New group' });
    await expect(groupDialog).toBeVisible();
    assertReadable(await inspectSelects('[role="dialog"]'), 1, theme);
    await groupDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(groupDialog).toBeHidden();

    // 3. Servers → Add a server dialog (Mode, Approval, and Remote platform <select>s)
    await page.getByRole('button', { name: 'Servers', exact: true }).click();
    await page.getByRole('button', { name: 'Add a server', exact: true }).first().click();
    const serverDialog = page.getByRole('dialog', { name: 'Add a server' });
    await expect(serverDialog).toBeVisible();
    await serverDialog.locator('summary').click();
    assertReadable(await inspectSelects('[role="dialog"]'), 3, theme);
    await serverDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(serverDialog).toBeHidden();
  }
});
