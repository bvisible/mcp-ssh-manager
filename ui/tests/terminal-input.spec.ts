import fs from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from './fixtures';

// Keystrokes reach the shell in the order they were typed.
//
// Each keystroke used to go out as its own fetch, without waiting for the one
// before. The browser sends several at once and the control plane writes them
// to the shell as they arrive, so on a loaded machine `mo --help` reached the
// shell as `mo- elh-p` (seen in the desktop application). Here the first
// keystroke's request is held back, as a busy machine would, and the shell must
// still receive exactly what was typed.
test.describe('the terminal', () => {
  test.use({ localShell: true });

  test('keeps keystrokes in order when one request is slow', async ({ page, app }) => {
    let first = true;
    await page.route('**/api/terminal/input**', async route => {
      if (first) {
        first = false;
        await new Promise(resolve => setTimeout(resolve, 600));
      }
      await route.continue();
    });

    await page.goto(app.url);
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.getByRole('button', { name: /This machine/ }).click();
    const screen = page.locator('.xterm');
    await expect(screen).toContainText('fixture %');
    await screen.click();

    const typed = 'echo "keystrokes in order" && ls -la /srv';
    await page.keyboard.type(typed);
    await page.keyboard.press('Enter');

    const received = path.join(app.home, 'typed.txt');
    await expect.poll(async () => (await fs.readFile(received, 'utf8').catch(() => '')).length, { timeout: 10_000 })
      .toBeGreaterThanOrEqual(typed.length + 1);
    expect(await fs.readFile(received, 'utf8')).toBe(`${typed}\r`);
  });

  // A program asking the terminal for one of its modes (DECRQM) gets an answer,
  // and the terminal keeps drawing afterwards.
  //
  // vim asks `ESC [ ? 12 $ p` (is the cursor blinking?) as soon as it has drawn
  // its first screen. When xterm threw on that query, the reply never left and
  // nothing after it was drawn: keystrokes still reached vim, but the screen
  // stayed frozen on its first frame. See `build.target` in vite.config.ts for
  // why it threw. The stand-in shell echoes what it is sent, so typing the
  // query makes it come back as output, exactly as vim's would.
  test('answers a mode query and keeps drawing', async ({ page, app }) => {
    await page.goto(app.url);
    await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await page.getByRole('button', { name: /This machine/ }).click();
    const screen = page.locator('.xterm');
    await expect(screen).toContainText('fixture %');
    await screen.click();

    await page.keyboard.press('Escape');
    await page.keyboard.type('[?12$p');

    // What the shell received: the query it echoed, then xterm's answer to it
    // (DECRPM, `ESC [ ? 12 ; <state> $ y`). The state is 1 (set) only because
    // ShellPage creates the terminal with `cursorBlink: true`; with it off,
    // xterm answers 2.
    const received = path.join(app.home, 'typed.txt');
    await expect.poll(async () => fs.readFile(received, 'utf8').catch(() => ''), { timeout: 10_000 })
      .toBe('\x1b[?12$p\x1b[?12;1$y');

    await page.keyboard.type('still drawing');
    await expect(screen).toContainText('still drawing');
  });
});
