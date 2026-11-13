import { test, expect, apiUrl } from './fixtures';

const chineseWelcome = '你的服务器，你的工作空间。';
const englishWelcome = 'Your servers. Your workspace.';

// Until somebody chooses a language, the browser's decides: Chinese for any zh locale, English for the rest.
// Nothing is saved by that, so the interface keeps following the system.
for (const [locale, language] of [['zh-CN', 'zh-CN'], ['zh-TW', 'zh-CN'], ['en-US', 'en'], ['fr-FR', 'en'], ['de-DE', 'en']] as const) {
  test.describe(`a ${locale} browser, no language chosen yet`, () => {
    test.use({ language: null, locale });
    test(`shows ${language} and saves nothing`, async ({ page, app }) => {
      await page.goto(app.url);
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      await expect(page.getByRole('dialog')).toContainText(language === 'en' ? englishWelcome : chineseWelcome);
      const preferences = (await (await page.request.get(apiUrl(app, '/api/preferences'))).json()).preferences;
      expect(preferences['ssh-manager.language']).toBeUndefined();
    });
  });
}

// A saved choice always wins over the browser's language.
test.describe('a saved choice', () => {
  for (const [saved, locale, shown] of [['en', 'zh-CN', 'en'], ['zh-CN', 'en-US', 'zh-CN']] as const) {
    test.describe(`${saved} in a ${locale} browser`, () => {
      test.use({ language: saved, locale });
      test('wins', async ({ page, app }) => {
        await page.goto(app.url);
        await expect(page.locator('html')).toHaveAttribute('lang', shown);
        await expect(page.getByRole('dialog')).toContainText(shown === 'en' ? englishWelcome : chineseWelcome);
      });
    });
  }
});

test.describe('choosing a language', () => {
  test.use({ language: null, locale: 'zh-CN', localShell: true });

  test('the selector is bilingual, the choice is saved, and it survives a new backend port', async ({ page, app }) => {
    await page.goto(app.url);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const language = page.getByLabel('Language / 语言');
    await expect(language).toHaveValue('zh-CN');
    // Each language is named in itself, so it can be found from the wrong one.
    await expect(language.locator('option')).toHaveText(['English', '简体中文']);
    await language.selectOption('en');
    await expect(page.getByRole('heading', { name: 'Options', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(language.locator('option')).toHaveText(['English', '简体中文']);
    await expect.poll(async () => (await (await page.request.get(apiUrl(app, '/api/preferences'))).json()).preferences['ssh-manager.language']).toBe('en');
    const old = new URL(app.url).port;
    await app.restart();
    expect(new URL(app.url).port).not.toBe(old);
    await page.goto(app.url);
    // English was chosen, so a Chinese browser no longer decides.
    await page.getByRole('button', { name: 'Options', exact: true }).click();
    await expect(language).toHaveValue('en');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await page.getByRole('button', { name: 'Options', exact: true }).click();
    await language.selectOption('zh-CN');
    await expect(page.getByRole('heading', { name: '设置', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '服务器', exact: true }).click();
    await page.getByRole('button', { name: '添加服务器', exact: true }).first().click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('名称', { exact: true }).fill('language_fixture');
    await dialog.getByLabel('主机地址', { exact: true }).fill('127.0.0.1');
    await dialog.getByLabel('用户名', { exact: true }).fill('fixture_user');
    await dialog.getByLabel('密码', { exact: true }).fill('test-only-password');
    await dialog.getByLabel('权限模式').selectOption('readonly');
    await dialog.getByLabel('审批策略').selectOption('always');
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    // Server names are data, not interface text: they are never translated.
    await expect(page.getByRole('heading', { name: 'language_fixture' })).toBeVisible();
    const saved = await (await page.request.get(apiUrl(app, '/api/servers'))).json();
    const server = saved.servers.find((entry: { name: string }) => entry.name === 'language_fixture');
    expect(server.host).toBe('127.0.0.1');
    expect(server.mode).toBe('readonly');
    expect(server.approval).toBe('always');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await language.selectOption('en');
    await page.getByRole('button', { name: 'Servers', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'language_fixture' })).toBeVisible();
    await expect(page.getByText('Read only', { exact: true })).toBeVisible();
    await expect(page.getByText('Approval: every request', { exact: true })).toBeVisible();
  });

  test('switching language preserves an open local terminal', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '终端', exact: true }).click();
    await page.getByRole('button', { name: /本机/ }).first().click();
    await expect(page.locator('.xterm')).toBeVisible();
    const screen = page.locator('.xterm').elementHandle();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByLabel('Language / 语言').selectOption('en');
    expect(await (await screen)!.evaluate(element => element.isConnected)).toBe(true);
    // The tab keeps the title it was opened with: a title is a name, like a server's, and is not retranslated.
    await page.getByRole('button', { name: '本机', exact: true }).first().click();
    await expect(page.locator('.xterm')).toBeVisible();
  });
});
