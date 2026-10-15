// SSH page flows against the fake backend: `node scripts/ssh-flows.mjs <output-dir> [url]` (needs Vite running).
// Uses the macOS Chrome when present, otherwise Playwright's own Chromium (`npx playwright-core install chromium-headless-shell`).
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const out = process.argv[2] ?? 'shots-ssh';
const base = process.argv[3] ?? 'http://localhost:1420/?mock';
fs.mkdirSync(out, { recursive: true });
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath: fs.existsSync(mac) ? mac : undefined, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${name}.png` }); };
const ok = (cond, msg) => { if (!cond) { errors.push('assert: ' + msg); console.log('FAIL', msg); } else console.log('ok  ', msg); };
const nav = (label) => page.locator('nav button.navi', { hasText: label }).first().click();
const sshNav = () => page.locator('nav button.navi', { hasText: 'SSH' });
const visibleTerm = () => page.locator('.xterm-host:visible .xterm-rows');

await page.goto(base);
await page.waitForSelector('nav', { timeout: 10000 });
await nav('SSH');
await page.getByRole('heading', { name: 'SSH', exact: true }).waitFor();
const rows = page.locator('.tr:visible');
ok(await rows.count() === 4, 'hosts from ~/.ssh/config, the SSH Docker context and the app');
ok(await page.locator('.tr:visible', { hasText: 'prod-db' }).getByText('ops@10.20.0.5:2222 · via bastion').isVisible(), 'config host shows the ssh -G address');

// two terminals on one host
await page.locator('.tr:visible', { hasText: 'prod-db' }).getByRole('button', { name: 'Open terminal' }).click();
await visibleTerm().getByText('Welcome to Ubuntu').waitFor({ timeout: 4000 });
ok(true, 'terminal opened');
await page.getByRole('button', { name: '+ New terminal' }).click();
await page.getByRole('tab', { name: 'prod-db · 2' }).waitFor();
await visibleTerm().getByText('Welcome to Ubuntu').waitFor({ timeout: 4000 });
ok((await sshNav().innerText()).includes('2'), 'sidebar counts open terminals');
await shot('s1-ssh');

// terminals survive leaving the page
await nav('Images');
await nav('SSH');
await page.getByRole('tab', { name: 'prod-db', exact: true }).click();
ok(await visibleTerm().getByText('Welcome to Ubuntu').isVisible(), 'terminal kept after changing page');

// close a tab
await page.getByRole('button', { name: 'Close terminal prod-db · 2' }).click();
ok(await page.getByRole('tab').filter({ hasText: 'prod-db' }).count() === 1, 'tab closed');

// add a host and connect
await page.getByRole('button', { name: 'Add host' }).click();
await page.locator('.modal').getByLabel('Host / IP').fill('198.51.100.7');
await page.locator('.modal').getByLabel('User').fill('admin');
ok((await page.locator('.modal code').innerText()) === 'ssh admin@198.51.100.7', 'equivalent ssh command');
await page.locator('.modal').getByLabel('Display name').fill('edge-1');
await page.getByRole('button', { name: 'Save and connect' }).click();
await page.getByRole('tab', { name: 'edge-1' }).waitFor({ timeout: 3000 });
await visibleTerm().getByText('admin@198.51.100.7').waitFor({ timeout: 4000 });
ok(true, 'new host saved and connected');
await shot('s2-ssh-added');

// remove the saved host (terminal stays)
await page.locator('.tr:visible', { hasText: 'edge-1' }).getByRole('button', { name: 'Remove host' }).click();
await page.locator('.modal').getByRole('button', { name: 'Remove', exact: true }).click();
await page.waitForTimeout(300);
ok(await page.locator('.tr:visible', { hasText: 'edge-1' }).count() === 0 && await page.getByRole('tab', { name: 'edge-1' }).count() === 1, 'host removed, its terminal stays');

// command palette
await page.keyboard.press('Control+k');
await page.locator('#pq').fill('ssh lab');
await page.locator('.palitem', { hasText: 'SSH to lab-pi' }).click();
await page.getByRole('tab', { name: 'lab-pi' }).waitFor({ timeout: 3000 });
ok(true, 'palette opens an SSH terminal');

// the SSH page is not blocked when Docker is stopped
ok(await page.locator('.box.warn:visible').count() === 0, 'no Docker banner on the SSH page');

console.log(errors.length ? `\n${errors.length} problem(s):\n` + errors.join('\n') : '\nall flows passed');
await browser.close();
process.exit(errors.length ? 1 : 0);
