import { test, expect } from './fixtures';
import { requestApproval } from './engine';

// An approval is a decision taken with the thing to be done in view. A deploy or
// an upload has no command line, so its card used to say "(no command)" while the
// request carried files, target paths and, for a deploy, a command to run after.
const restart = 'sudo systemctl restart app && touch /tmp/after-deploy';
const deployArguments = {
  server: 'fixture',
  files: [{ local: '/work/build/app.js', remote: '/srv/app/current/app.js' }],
  options: { owner: 'deploy:deploy', backup: true, restart, sudoPassword: '***' },
};

test('a deploy card shows the files, the paths and the command it runs afterwards', async ({ page, app }) => {
  const request = requestApproval(app.approvalSocket, undefined, { tool: 'ssh_deploy', args: deployArguments });
  await page.goto(app.url);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: /^Waiting/ }).click();

  const card = page.locator('article').first();
  await expect(card).toContainText('ssh_deploy');
  const shown = card.locator('pre');
  await expect(shown).toContainText('/work/build/app.js');
  await expect(shown).toContainText('/srv/app/current/app.js');
  // The command that ran unseen before: shown whole, as written.
  await expect(shown).toContainText(restart);
  // The card header already names the server; the secret was removed by the engine and stays removed.
  await expect(shown).not.toContainText('"server"');
  await expect(card).not.toContainText('(no command)');
  expect(await shown.textContent()).not.toMatch(/hunter2|password":\s*"(?!\*)/i);

  await card.getByRole('button', { name: 'Refuse' }).click();
  expect((await request.decision).decision).toBe('deny');
});

test('a request with a command still shows the command, not its arguments', async ({ page, app }) => {
  const command = 'systemctl restart nginx';
  const request = requestApproval(app.approvalSocket, command, { args: { server: 'fixture', command, cwd: '/srv' } });
  await page.goto(app.url);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: /^Waiting/ }).click();

  const shown = page.locator('article').first().locator('pre');
  await expect(shown).toHaveText(command);
  await page.locator('article').first().getByRole('button', { name: 'Refuse' }).click();
  await request.decision;
});

test('a request with neither a command nor arguments still says so', async ({ page, app }) => {
  const request = requestApproval(app.approvalSocket, undefined, { tool: 'ssh_deploy', args: { server: 'fixture' } });
  await page.goto(app.url);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: /^Waiting/ }).click();

  await expect(page.locator('article').first().locator('pre')).toHaveText('(no command)');
  await page.locator('article').first().getByRole('button', { name: 'Refuse' }).click();
  await request.decision;
});
