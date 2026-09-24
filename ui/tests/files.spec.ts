import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCandidatePreview } from '../../scripts/preview-candidate.mjs';
import { test, expect, apiUrl } from './fixtures';

const root = fileURLToPath(new URL('../..', import.meta.url));

for (const direction of ['upload', 'download'] as const) {
  test(`${direction} refresh keeps both file panes in their selected directories`, async ({ page, app }) => {
    const fixture = await createCandidatePreview(root);
    const localDirectory = path.join(app.home, 'Documents');
    const remoteDirectory = '/srv/uploads';
    const filename = `${direction}-me.txt`;
    const fileText = `Real SFTP ${direction} from the browser fixture.\n`;
    try {
      await fs.mkdir(localDirectory);
      const localFile = path.join(localDirectory, filename);
      const remoteFile = path.join(fixture.remote, 'srv/uploads', filename);
      await fs.writeFile(direction === 'upload' ? localFile : remoteFile, fileText);
      const response = await page.request.post(apiUrl(app, '/api/servers'), {
        data: { name: 'demo_app', host: '127.0.0.1', port: fixture.port,
          user: 'demo', password: fixture.password, defaultDir: '/srv' },
      });
      expect(response.ok()).toBe(true);
      await page.goto(app.url);
      await page.getByRole('button', { name: 'Browse files', exact: true }).click();
      const row = (name: string) => page.getByRole('row').filter({ has: page.getByText(name, { exact: true }) });
      await row('Documents').dblclick();
      await row('uploads').dblclick();
      await expect(page.getByRole('button', { name: /Documents$/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'uploads', exact: true })).toBeVisible();

      // Observe the refresh caused by the real transfer-complete SSE event.
      // Before the fix it requests '.' (upload) or no path (download), and the
      // successful transfer sends the operator back to the pane's home.
      const endpoint = direction === 'upload' ? '/api/files' : '/api/local/files';
      const refreshed = page.waitForResponse(result => new URL(result.url()).pathname === endpoint
        && result.request().method() === 'GET');
      await row(filename).click({ button: 'right' });
      await page.getByRole('menuitem', { name: direction === 'upload' ? 'Upload' : 'Download', exact: true }).click();
      const listing = await (await refreshed).json();
      expect(await fs.readFile(direction === 'upload' ? remoteFile : localFile, 'utf8')).toBe(fileText);
      expect(listing.path).toBe(direction === 'upload' ? remoteDirectory : localDirectory);
      await expect(row(filename)).toHaveCount(2);
      await expect(page.getByRole('button', { name: /Documents$/ })).toBeVisible();
      await expect(page.getByRole('button', { name: 'uploads', exact: true })).toBeVisible();
    } finally {
      await fixture.close();
    }
  });
}
