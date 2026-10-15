// Take UI screenshots against the fake backend: `node scripts/shots.mjs <output-dir> [url]`
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const out = process.argv[2] ?? 'shots';
const base = process.argv[3] ?? 'http://localhost:1420/?mock';
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
await page.goto(base);
await page.waitForSelector('nav', { timeout: 10000 });
await page.waitForTimeout(800);
const shot = async (name) => { await page.waitForTimeout(500); await page.screenshot({ path: `${out}/${name}.png` }); };
const nav = (label) => page.locator('nav button.navi', { hasText: label }).first().click();

await shot('01-dashboard');
await nav('Projects'); await shot('02-projects');
await nav('Containers'); await page.waitForTimeout(900); await shot('03-containers-logs');
await page.getByRole('tab', { name: 'Terminal' }).click(); await shot('04-containers-terminal');
await page.getByRole('tab', { name: 'Stats' }).click(); await page.waitForTimeout(2500); await shot('05-containers-stats');
await page.getByRole('tab', { name: 'Inspect' }).click(); await shot('06-containers-inspect');
await nav('Images'); await shot('07-images');
await page.getByRole('button', { name: 'myshop-api' }).first().click(); await shot('08-image-drawer'); await page.keyboard.press('Escape');
await nav('Networks'); await shot('09-networks');
await nav('Volumes'); await shot('10-volumes');
await nav('Cleanup'); await page.locator('button.linkbtn', { hasText: 'Preview' }).first().click(); await shot('11-cleanup');
await nav('Connections'); await shot('12-connections');
await nav('Kubernetes'); await shot('13-kubernetes');
await nav('Overview');
await page.keyboard.press('Control+k'); await page.keyboard.type('myshop'); await shot('14-palette'); await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Add folder' }).first().click(); await page.locator('.pick').first().click(); await shot('15-add-project'); await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Run container' }).first().click(); await shot('16-run'); await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Pull image' }).first().click(); await page.locator('.optc', { hasText: 'nginx:alpine' }).click(); await page.getByRole('button', { name: 'Pull', exact: true }).click(); await page.waitForTimeout(500); await shot('17-pull'); await page.keyboard.press('Escape');
await nav('Projects'); await page.getByRole('button', { name: 'Open folder' }).first().click(); await page.waitForTimeout(400); await shot('18-project-files');
console.log(errors.length ? errors.join('\n') : 'no console errors');
await browser.close();
