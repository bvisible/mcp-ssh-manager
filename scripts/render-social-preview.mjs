#!/usr/bin/env node
// Renders brand/social-preview.html into the GitHub social preview image
// (docs/images/social-preview.png at 1280x640, and @2x). Needs the built interface
// for its fonts (npm run build:ui) and Playwright from ui/ (npm ci --prefix ui).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(root, 'dist', 'ui', 'assets', 'Karla-Variable.woff2'))) {
  console.error('The fonts come from the built interface: run `npm run build:ui` first.');
  process.exit(1);
}
let chromium;
try {
  ({ chromium } = createRequire(path.join(root, 'ui', 'package.json'))('@playwright/test'));
} catch {
  console.error('Playwright is not installed in ui/: run `npm ci --prefix ui` first.');
  process.exit(1);
}
const html = pathToFileURL(path.join(root, 'brand', 'social-preview.html')).href;
const browser = await chromium.launch();
try {
  for (const [scale, name] of [[1, 'social-preview.png'], [2, 'social-preview@2x.png']]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: scale });
    await page.goto(html);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(root, 'docs', 'images', name) });
    await page.close();
    console.log(`docs/images/${name}`);
  }
} finally {
  await browser.close();
}
