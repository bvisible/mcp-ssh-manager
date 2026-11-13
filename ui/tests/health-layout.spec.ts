import { test, expect } from './fixtures';

test.use({ language: 'zh-CN' });
const longMount = '/srv/customer-data/' + 'a'.repeat(128) + '/backup';
const results = [
  { server: 'hk', host: '192.0.2.1', reachable: true, tookMs: 420, uptime: 'up 2 days',
    cpu: { percent: 14 }, memory: { total_mb: 4096, used_mb: 2252, percent: 55 },
    disks: [
      { mount: '/', filesystem: 'ext4', size: '29G', used: '25G', avail: '4.4G', percent: 85 },
      { mount: longMount, filesystem: 'xfs', size: '100G', used: '90G', avail: '10G', percent: 90 },
    ], alerts: [{ type: 'disk', mount: longMount, value: 90, threshold: 85, message: 'Raw engine alert' }],
  },
  { server: 'second_server', host: '192.0.2.2', reachable: true, tookMs: 300, uptime: 'up 3 days',
    cpu: { percent: 10 }, memory: { total_mb: 4096, used_mb: 1024, percent: 25 },
    disks: [{ mount: '/', size: '40G', used: '10G', avail: '30G', percent: 25 }], alerts: [],
  },
  { server: 'offline', host: '192.0.2.3', reachable: false, tookMs: 1000, error: 'Connection_failed_' + 'x'.repeat(180) },
];

test('health cards contain long paths, bars, warnings and backgrounds at every desktop width', async ({ page, app }) => {
  await page.route('**/api/health**', route => route.fulfill({ json: { results } }));
  await page.goto(app.url);
  await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '健康状态', exact: true }).click();
  await page.getByRole('button', { name: '检查所有服务器', exact: true }).click();
  await expect(page.locator('.health-card')).toHaveCount(3);
  await expect(page.getByText('已用 2 / 4 GB', { exact: true })).toBeVisible();
  await expect(page.getByText('已用 25G / 总计 29G，可用 4.4G', { exact: false })).toBeVisible();
  // Chinese words an alert from its facts; the engine's English sentence is not shown.
  await expect(page.getByText('Raw engine alert', { exact: true })).toHaveCount(0);
  await expect(page.getByText(`磁盘 ${longMount}：已用 90%（阈值 85%）`, { exact: false })).toBeVisible();
  await expect(page.getByText(longMount, { exact: true })).toBeVisible();

  for (const width of [900, 1100, 1440]) {
    await page.setViewportSize({ width, height: 800 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.classList.toggle('dark', theme === 'dark'), theme);
      const layout = await page.locator('.health-card').evaluateAll(cards => cards.map(card => {
        const box = card.getBoundingClientRect();
        const escaped = [...card.querySelectorAll('*')].filter(node => {
          const bounds = node.getBoundingClientRect();
          return bounds.width > 0 && (bounds.left < box.left - 1 || bounds.right > box.right + 1);
        }).map(node => node.tagName + ':' + node.className);
        return { left: box.left, right: box.right, scrollWidth: card.scrollWidth, clientWidth: card.clientWidth, escaped, background: getComputedStyle(card).backgroundColor };
      }));
      for (const card of layout) {
        expect(card.left).toBeGreaterThanOrEqual(0);
        expect(card.right).toBeLessThanOrEqual(width);
        expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
        expect(card.escaped).toEqual([]);
        expect(card.background).not.toBe('rgba(0, 0, 0, 0)');
      }
      const scroll = await page.locator('.health-scroll').evaluate(node => ({ actual: node.scrollWidth, visible: node.clientWidth }));
      expect(scroll.actual).toBeLessThanOrEqual(scroll.visible + 1);
    }
  }

  await page.getByRole('button', { name: '收起侧边栏', exact: true }).click();
  for (const width of [390, 640]) {
    await page.setViewportSize({ width, height: 740 });
    const scroll = await page.locator('.health-scroll').evaluate(node => ({ actual: node.scrollWidth, visible: node.clientWidth }));
    expect(scroll.actual).toBeLessThanOrEqual(scroll.visible + 1);
    const card = await page.locator('.health-card').first().boundingBox();
    expect(card!.x + card!.width).toBeLessThanOrEqual(width);
  }

  await page.setViewportSize({ width: 1100, height: 800 });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByLabel('Language / 语言').selectOption('en');
  await page.getByRole('button', { name: 'Health', exact: true }).click();
  await page.getByRole('button', { name: 'Check every server', exact: true }).click();
  // English is shown exactly as it always was: the engine's own alert, memory rounded to whole gigabytes.
  await expect(page.getByText('2 of 4 GB', { exact: true })).toBeVisible();
  await expect(page.getByText('25G of 29G, 4.4G free', { exact: false })).toBeVisible();
  await expect(page.getByText('Raw engine alert', { exact: true })).toBeVisible();
});
