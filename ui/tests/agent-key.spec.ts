import { test, expect, apiUrl } from './fixtures';
import type { Page } from '@playwright/test';

// The form can say "use this identity from the SSH agent" (agentPublicKeyPath), which until now was
// reachable only through .env, TOML or the environment. The engine refuses an agent key combined with
// a password, a private key or agent forwarding, so the form makes that choice before saving.

const publicKey = '~/.ssh/id_ed25519.pub';
const servers = async (page: Page, app: { url: string }) =>
  (await (await page.request.get(apiUrl(app, '/api/servers'))).json()).servers as Record<string, any>[];

async function openForm(page: Page, app: { url: string }) {
  await page.goto(app.url);
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Add a server' }).first().click();
  const form = page.getByRole('dialog', { name: 'Add a server' });
  await form.getByLabel('Name', { exact: true }).fill('prod');
  await form.getByLabel('Host', { exact: true }).fill('127.0.0.1');
  await form.getByLabel('User', { exact: true }).fill('deploy');
  return form;
}

test('an agent key is saved as the engine reads it, and the other credentials step aside', async ({ page, app }) => {
  const form = await openForm(page, app);
  const key = form.getByLabel('Agent public key', { exact: true });
  await expect(key).toBeEnabled();
  await key.fill(publicKey);
  await expect(form.getByLabel('Password', { exact: true })).toBeDisabled();
  await expect(form.getByLabel('Private key', { exact: true })).toBeDisabled();
  await form.getByText('Advanced connection settings').click();
  await expect(form.getByLabel('Forward the SSH agent')).toBeDisabled();
  // Key passphrase is not part of the engine's rule: it stays available.
  await expect(form.getByLabel('Key passphrase', { exact: true })).toBeEnabled();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toBeHidden();

  const saved = (await servers(page, app)).find(server => server.name === 'prod')!;
  expect(saved.agentPublicKeyPath).toBe(publicKey);
  expect(saved.hasPassword).toBeUndefined();
  expect(saved.keyPath ?? '').toBe('');
  expect(saved.forwardAgent).toBeFalsy();

  // Back in the form, the value is there and can be cleared again.
  await page.getByRole('button', { name: 'Toggle edit mode' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog', { name: 'Edit prod' });
  await expect(edit.getByLabel('Agent public key', { exact: true })).toHaveValue(publicKey);
  await edit.getByLabel('Agent public key', { exact: true }).fill('');
  await expect(edit.getByLabel('Password', { exact: true })).toBeEnabled();
  await edit.getByLabel('Password', { exact: true }).fill('a-new-password');
  await expect(edit.getByLabel('Agent public key', { exact: true })).toBeDisabled();
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(edit).toBeHidden();
  const again = (await servers(page, app)).find(server => server.name === 'prod')!;
  expect(again.hasPassword).toBe(true);
  expect(again.agentPublicKeyPath ?? '').toBe('');
});

test('a typed private key, a password or forwarding keeps the agent key field closed, and says why', async ({ page, app }) => {
  const form = await openForm(page, app);
  const key = form.getByLabel('Agent public key', { exact: true });
  await form.getByLabel('Private key', { exact: true }).fill('~/.ssh/id_ed25519');
  await expect(key).toBeDisabled();
  await expect(form.getByText('Clear the password, the private key and agent forwarding to use an agent key.')).toBeVisible();
  await form.getByLabel('Private key', { exact: true }).fill('');
  await expect(key).toBeEnabled();
  await form.getByLabel('Password', { exact: true }).fill('x');
  await expect(key).toBeDisabled();
  await form.getByLabel('Password', { exact: true }).fill('');
  await form.getByText('Advanced connection settings').click();
  await form.getByLabel('Forward the SSH agent').check();
  await expect(key).toBeDisabled();
});

test('switching a server that has a saved password to an agent key says it removes it, and does', async ({ page, app }) => {
  await page.request.post(apiUrl(app, '/api/servers'), { data: { name: 'old', host: '127.0.0.1', user: 'deploy', password: 'saved-secret', keyPath: '', forwardAgent: true } });
  await page.goto(app.url);
  // A server already exists, so there is no welcome to close.
  await page.getByRole('button', { name: 'Toggle edit mode' }).click();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const form = page.getByRole('dialog', { name: 'Edit old' });
  const key = form.getByLabel('Agent public key', { exact: true });
  // Forwarding is on for this server: it has to be switched off first.
  await expect(key).toBeDisabled();
  await form.getByText('Advanced connection settings').click();
  await form.getByLabel('Forward the SSH agent').uncheck();
  await key.fill(publicKey);
  await expect(form.getByText('Saving removes the password and the private key saved for this server: an agent key cannot be combined with them.')).toBeVisible();
  await form.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(form).toBeHidden();
  const saved = (await servers(page, app)).find(server => server.name === 'old')!;
  expect(saved.agentPublicKeyPath).toBe(publicKey);
  expect(saved.hasPassword).toBeUndefined();
  expect(saved.forwardAgent).toBeFalsy();
});

test.describe('without an SSH agent in the environment', () => {
  test('the form warns that the connection will fail', async ({ page, app }) => {
    const form = await openForm(page, app);
    await form.getByLabel('Agent public key', { exact: true }).fill(publicKey);
    await expect(form.getByRole('status').filter({ hasText: 'No SSH agent is visible to this application' })).toBeVisible();
    expect((await (await page.request.get(apiUrl(app, '/api/options'))).json()).agentSocket).toBe(false);
  });
});

test.describe('with an SSH agent in the environment', () => {
  test.use({ agentSocket: true });
  test('there is no warning', async ({ page, app }) => {
    const form = await openForm(page, app);
    await form.getByLabel('Agent public key', { exact: true }).fill(publicKey);
    expect((await (await page.request.get(apiUrl(app, '/api/options'))).json()).agentSocket).toBe(true);
    await expect(form.getByText('Saving removes the password')).toHaveCount(0);
    await expect(form.getByRole('status').filter({ hasText: 'No SSH agent is visible' })).toHaveCount(0);
  });
});
