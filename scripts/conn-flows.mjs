// Connection flows (SSH / TCP+TLS / WSL2) against the fake backend: `node scripts/conn-flows.mjs <output-dir> [url]` (needs Vite running).
// Uses the macOS Chrome when present, otherwise Playwright's own Chromium (`npx playwright-core install chromium-headless-shell`).
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const out = process.argv[2] ?? 'shots-conn';
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
const modal = () => page.locator('.modal');

await page.goto(base);
await page.waitForSelector('nav', { timeout: 10000 });
await nav('Connections');
await page.getByRole('heading', { name: 'Docker engines' }).waitFor();
ok(await page.locator('.card .tag', { hasText: 'TLS' }).count() === 1, 'TLS context gets a TLS tag');

// SSH: failing check shows the original error, a good one shows the engine
await page.getByRole('button', { name: 'Add connection' }).first().click();
ok(await modal().locator('button.seg.on', { hasText: 'SSH' }).count() === 1, 'SSH is the default type');
await modal().getByLabel('Host / IP').fill('fail.example.com');
await modal().getByLabel('User').fill('deploy');
ok(await modal().getByLabel('Display name').getAttribute('placeholder') === 'fail', 'name suggested from the host');
await modal().getByRole('button', { name: 'Test connection' }).click();
await modal().getByText('Connection timed out').waitFor({ timeout: 3000 });
ok(true, 'failed check shows the ssh error');
await modal().getByLabel('Host / IP').fill('203.0.113.20');
await modal().getByLabel('Display name').fill('build-box');
ok((await modal().locator('code').innerText()) === 'docker context create build-box --docker host=ssh://deploy@203.0.113.20', 'equivalent command');
await modal().getByRole('button', { name: 'Test connection' }).click();
await modal().getByText('Connection OK · deploy@203.0.113.20 · Docker 26.1.4').waitFor({ timeout: 3000 });
await shot('c1-add-ssh');
await modal().getByRole('button', { name: 'Save connection' }).click();
await page.getByText('Saved connection build-box').waitFor({ timeout: 3000 });
ok(await page.locator('.card', { hasText: 'build-box' }).count() === 1, 'new SSH card');

// hosts from ~/.ssh/config: picking one keeps the alias as the host and shows what ssh resolves
await page.getByRole('button', { name: 'Add connection' }).first().click();
await modal().locator('button.seg', { hasText: 'prod-db' }).click();
ok(await modal().getByLabel('Host / IP').inputValue() === 'prod-db', 'alias fills the host');
ok(await modal().getByText('→ ops@10.20.0.5:2222 · ~/.ssh/id_prod · via bastion').isVisible(), 'resolved ssh -G details');
ok((await modal().locator('code').innerText()) === 'docker context create prod-db --docker host=ssh://prod-db', 'endpoint uses the alias');
await shot('c0-ssh-config');
await modal().getByRole('button', { name: 'Cancel' }).click();

// duplicate name → red toast, modal stays open
await page.getByRole('button', { name: 'Add connection' }).first().click();
await modal().getByLabel('Host / IP').fill('x');
await modal().getByLabel('Display name').fill('build-box');
await modal().getByRole('button', { name: 'Save connection' }).click();
await page.getByText('A connection named build-box already exists').waitFor({ timeout: 3000 });
ok(await modal().count() === 1, 'duplicate name keeps the modal open');

// TCP without TLS warns
await modal().locator('button.seg', { hasText: 'TCP + TLS' }).click();
await modal().getByText('TLS authentication (recommended)').click();
ok(await modal().getByText('Not encrypted. Do not expose the Docker port to the Internet.').isVisible(), 'TCP without TLS warning');
await shot('c2-add-tcp');
// Kubernetes chip opens the cluster modal
await modal().locator('button.seg', { hasText: 'Kubernetes' }).click();
await page.getByRole('heading', { name: 'Add Kubernetes cluster' }).waitFor({ timeout: 3000 });
ok(true, 'Kubernetes chip opens the cluster modal');
await page.locator('.modal').getByRole('button', { name: 'Cancel' }).click();

// remove the SSH context (confirm), default/active are locked
ok(await page.locator('.card', { hasText: 'desktop-linux' }).getByRole('button', { name: 'The context in use cannot be removed' }).isDisabled(), 'active context cannot be removed');
await page.locator('.card', { hasText: 'build-box' }).getByRole('button', { name: 'Remove connection' }).click();
await page.locator('.modal').getByRole('button', { name: 'Remove', exact: true }).click();
await page.getByText('Removed connection build-box').waitFor({ timeout: 3000 });
ok(await page.locator('.card', { hasText: 'build-box' }).count() === 0, 'SSH card removed');

// WSL2: install Docker in Debian, add Ubuntu as a context
await page.getByRole('heading', { name: 'WSL2 distros on this machine' }).waitFor();
await page.locator('.tr', { hasText: 'Debian' }).getByRole('button', { name: 'Install Docker Engine' }).click();
await page.locator('.modal').getByRole('button', { name: 'Install Docker Engine' }).click();
await page.getByText('Installed Docker 27.3.1 in Debian').waitFor({ timeout: 5000 });
ok(true, 'install Docker in a distro');
await page.locator('.tr', { hasText: 'Ubuntu-24.04' }).getByRole('button', { name: 'Add as context' }).click();
await modal().locator('button.seg.on', { hasText: 'Ubuntu-24.04' }).waitFor({ timeout: 3000 });
ok(true, 'distro preselected');
ok(await modal().getByLabel('Display name').getAttribute('placeholder') === 'wsl-ubuntu-24-04', 'WSL name suggestion');
await shot('c3-add-wsl');
await modal().getByRole('button', { name: 'Save connection' }).click();
await page.getByText('Saved connection wsl-ubuntu-24-04').waitFor({ timeout: 3000 });
await page.locator('.tr', { hasText: 'Ubuntu-24.04' }).getByRole('button', { name: 'Added' }).waitFor({ timeout: 3000 });
ok(await page.locator('.card .tag', { hasText: 'WSL2' }).count() === 1, 'WSL2 card + row marked Added');
await shot('c4-connections');

// context menu → Add connection…
await page.getByRole('button', { name: 'Change Docker context' }).click();
ok(await page.locator('.menu .mi', { hasText: 'wsl-ubuntu-24-04' }).count() === 1, 'new context in the menu');
await page.locator('.menu .mi', { hasText: 'Add connection…' }).click();
ok(await modal().getByRole('heading', { name: 'Add connection' }).count() === 1, 'menu opens the add modal');

console.log(errors.length ? `\n${errors.length} problem(s):\n` + errors.join('\n') : '\nall flows passed');
await browser.close();
process.exit(errors.length ? 1 : 0);
