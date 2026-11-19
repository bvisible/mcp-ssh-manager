import { test, expect, apiUrl } from './fixtures';
import { languages, selectorLabel, selectorNames, unsupportedLocale } from './languages';

const welcomes = Object.fromEntries(languages.map(language => [language.code, language.welcome]));

// Until somebody chooses a language, the browser's decides; unsupported locales use English.
// Nothing is saved by that, so the interface keeps following the system.
const followed: [string, string][] = [
  ...languages.map(language => [language.code, language.code] as [string, string]),
  ['zh-TW', 'zh-CN'], ['ja-JP', 'ja'], ['en-US', 'en'], [unsupportedLocale, 'en'],
];
for (const [locale, language] of followed) {
  test.describe(`a ${locale} browser, no language chosen yet`, () => {
    test.use({ language: null, locale });
    test(`shows ${language} and saves nothing`, async ({ page, app }) => {
      await page.goto(app.url);
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      await expect(page.getByRole('dialog')).toContainText(welcomes[language]);
      const preferences = (await (await page.request.get(apiUrl(app, '/api/preferences'))).json()).preferences;
      expect(preferences['ssh-manager.language']).toBeUndefined();
    });
  });
}

// The same Han characters are drawn differently in Chinese and in Japanese, so each language
// sets the page in its own fonts: Chinese fonts for Chinese, Japanese fonts for Japanese, and
// never both in one list (a character both languages write would take the first font's form,
// and the characters only one of them has would fall to another font in the same line).
for (const [language, locale, own, foreign] of [
  ['zh-CN', 'zh-CN', 'PingFang SC', ['Hiragino', 'Yu Gothic']],
  ['ja', 'ja-JP', 'Hiragino Kaku Gothic ProN', ['PingFang', 'YaHei', 'CJK SC']],
] as const) {
  test.describe(`the ${language} interface fonts`, () => {
    test.use({ language, locale });
    test('use that language\'s CJK fonts and none of the other\'s', async ({ page, app }) => {
      await page.goto(app.url);
      await expect(page.locator('html')).toHaveAttribute('lang', language);
      for (const variable of ['--font-body', '--font-mono']) {
        const stack = await page.evaluate(name => getComputedStyle(document.documentElement).getPropertyValue(name), variable);
        expect(stack, `${variable} in ${language}`).toContain(own);
        for (const other of foreign) expect(stack, `${variable} in ${language} must not name ${other}`).not.toContain(other);
      }
      // What the page is actually set in, not only what the variable says.
      const body = await page.evaluate(() => getComputedStyle(document.body).fontFamily);
      expect(body).toContain(own);
    });
  });
}

// A saved choice always wins over the browser's language.
test.describe('a saved choice', () => {
  const choices = new Map<string, [string, string]>();
  for (const { code } of languages) {
    if (code !== 'en') choices.set(`${code} in en-US`, [code, 'en-US']);
    choices.set(`en in ${code === 'en' ? 'ja-JP' : code}`, ['en', code === 'en' ? 'ja-JP' : code]);
  }
  for (const [saved, locale] of choices.values()) {
    test.describe(`${saved} in a ${locale} browser`, () => {
      test.use({ language: saved, locale });
      test('wins', async ({ page, app }) => {
        await page.goto(app.url);
        await expect(page.locator('html')).toHaveAttribute('lang', saved);
        await expect(page.getByRole('dialog')).toContainText(welcomes[saved]);
      });
    });
  }
});

test.describe('choosing a language', () => {
  test.use({ language: null, locale: 'zh-CN', localShell: true });

  test('the selector is multilingual, the choice is saved, and it survives a new backend port', async ({ page, app }) => {
    await page.goto(app.url);
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
    await page.getByRole('dialog').getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const language = page.getByLabel(selectorLabel, { exact: true });
    await expect(language).toHaveValue('zh-CN');
    // Each language is named in itself, so it can be found from the wrong one.
    await expect(language.locator('option')).toHaveText(selectorNames);
    await language.selectOption('en');
    await expect(page.getByRole('heading', { name: 'Options', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(language.locator('option')).toHaveText(selectorNames);
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
    await page.getByLabel(selectorLabel, { exact: true }).selectOption('en');
    expect(await (await screen)!.evaluate(element => element.isConnected)).toBe(true);
    // The tab keeps the title it was opened with: a title is a name, like a server's, and is not retranslated.
    await page.getByRole('button', { name: '本机', exact: true }).first().click();
    await expect(page.locator('.xterm')).toBeVisible();
  });
});
