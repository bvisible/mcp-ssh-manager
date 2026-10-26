import { test, expect, apiUrl } from './fixtures';

// Seven groups, as on a real fleet: the chips fill the row. The layout switch
// used to come after them and wrapped onto a line of its own, leaving a band of
// empty space between the filters and the list.
const groups = ['ai-lab', 'autre', 'client', 'client-neoffice', 'neoffice', 'neoffice-fleet', 'unpress'];

test('the layout switch sits beside the search, and the groups wrap on their own row below', async ({ page, app }) => {
  // Created in the vault through the same endpoint the form uses.
  for (const [index, group] of groups.entries()) {
    const response = await page.request.post(apiUrl(app, '/api/servers'), {
      data: { name: `server_${index + 1}`, host: `10.0.0.${index + 1}`, user: 'deploy', password: 'fixture-only-secret', group },
    });
    expect(response.ok(), await response.text()).toBe(true);
  }

  for (const width of [1100, 760]) {
    await page.setViewportSize({ width, height: 800 });
    await page.goto(app.url);
    const welcome = page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true });
    if (await welcome.isVisible().catch(() => false)) await welcome.click();
    await expect(page.getByRole('group', { name: 'Filter by group' }).getByRole('button')).toHaveCount(groups.length + 1);

    const search = await page.getByRole('searchbox', { name: 'Search servers' }).boundingBox();
    const layout = await page.getByRole('group', { name: 'Layout' }).boundingBox();
    const chips = await page.getByRole('group', { name: 'Filter by group' }).boundingBox();
    const list = await page.getByRole('heading', { level: 3 }).first().boundingBox().catch(() => null);
    expect(search && layout && chips).toBeTruthy();

    // Same row: the switch is level with the search field, to its right.
    expect(Math.abs((layout!.y + layout!.height / 2) - (search!.y + search!.height / 2)), `${width}px: switch level with the search`).toBeLessThan(8);
    expect(layout!.x, `${width}px: switch right of the search`).toBeGreaterThan(search!.x + search!.width);
    // The groups come after, as their own row, close to it: no band of space.
    expect(chips!.y, `${width}px: groups below the search`).toBeGreaterThan(search!.y + search!.height);
    expect(chips!.y - (search!.y + search!.height), `${width}px: gap between search and groups`).toBeLessThan(24);
    // The switch reaches the right edge of the toolbar, not the middle of the page.
    const toolbarRight = chips!.x + chips!.width;
    expect(Math.abs((layout!.x + layout!.width) - toolbarRight), `${width}px: switch at the right edge`).toBeLessThan(2);
    void list;
  }
});
