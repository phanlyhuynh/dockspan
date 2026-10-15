// Kubernetes UI flows against the fake backend: `node scripts/k8s-flows.mjs <output-dir> [url]` (needs Vite running).
// Uses the macOS Chrome when present, otherwise Playwright's own Chromium (`npx playwright-core install chromium-headless-shell`).
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const out = process.argv[2] ?? 'shots-k8s';
const base = process.argv[3] ?? 'http://localhost:1420/?mock';
fs.mkdirSync(out, { recursive: true });
const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({ executablePath: fs.existsSync(mac) ? mac : undefined, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const shot = async (name) => { await page.waitForTimeout(400); await page.screenshot({ path: `${out}/${name}.png` }); };
const ok = (cond, msg) => { if (!cond) { errors.push('assert: ' + msg); console.log('FAIL', msg); } else console.log('ok  ', msg); };
const nav = (label) => page.locator('nav button.navi', { hasText: label }).first().click();

await page.goto(base);
await page.waitForSelector('nav', { timeout: 10000 });
// The cluster list loads in the background after the window appears.
await page.locator('nav button.navi', { hasText: 'Kubernetes' }).filter({ hasText: '2' }).waitFor({ timeout: 5000 }).catch(() => {});
ok((await page.locator('nav button.navi', { hasText: 'Kubernetes' }).innerText()).includes('2'), 'sidebar shows the cluster count');

await nav('Kubernetes');
await page.getByText('5 / 6 Running').waitFor({ timeout: 5000 });
ok(true, 'cluster connects, stat cards show pods');
await shot('k1-workloads');

// scale up worker → new pod appears
await page.locator('.tr:visible', { hasText: 'worker' }).getByRole('button', { name: 'Increase replicas' }).click();
await page.getByText('Scaled worker to 2 replicas').waitFor({ timeout: 3000 });
ok(true, 'scale + toast');

await page.getByRole('tab', { name: 'Pods' }).click();
await page.waitForTimeout(600);
ok(await page.locator('.tr:visible .pill', { hasText: 'ContainerCreating' }).count() >= 1, 'scaled pod is ContainerCreating');
await shot('k2-pods');

// logs drawer of the crashing pod explains the error
await page.locator('.tr:visible', { hasText: 'CrashLoopBackOff' }).getByRole('button', { name: 'Logs' }).click();
await page.getByText('could not be resolved').waitFor({ timeout: 3000 });
ok(await page.getByText('The Service rabbitmq may be missing in namespace shop.').isVisible(), 'pod error explanation');
await shot('k3-logs');
await page.keyboard.press('Escape');

// exec drawer opens a terminal
await page.locator('.tr:visible', { hasText: /^api-/ }).first().getByRole('button', { name: 'Exec into pod' }).click();
await page.waitForSelector('.xterm-host .xterm', { timeout: 3000 });
ok(true, 'exec terminal opened');
await shot('k4-exec');
// Esc belongs to the shell inside the terminal, so close the drawer with its button.
await page.locator('.drawer').getByRole('button', { name: 'Close', exact: true }).click();

// delete pod asks for confirmation
await page.locator('.tr:visible', { hasText: /^web-/ }).first().getByRole('button', { name: 'Delete pod' }).click();
await page.getByRole('button', { name: 'Delete pod', exact: true }).last().click();
await page.getByText('the ReplicaSet is creating a new pod').waitFor({ timeout: 3000 });
ok(true, 'delete pod + toast');

// namespace filter
await page.locator('select[aria-label="Namespace"], button.seg', { hasText: 'monitoring' }).first().click().catch(() => {});
await page.getByRole('tab', { name: 'Services' }).click();
await page.locator('button.seg', { hasText: 'All' }).first().click().catch(() => {});
await page.waitForTimeout(300);

// port-forward
await page.locator('.tr:visible', { hasText: 'NodePort' }).getByRole('button', { name: 'Port-forward' }).click();
await page.getByText('Forwarding localhost:8080 → svc/web:80').waitFor({ timeout: 3000 });
ok(await page.getByRole('button', { name: 'Stop · localhost:8080' }).isVisible(), 'forward button turns into Stop');
await shot('k5-services');
await page.getByRole('tab', { name: 'Port-forward (1)' }).click();
await shot('k6-forwards');

// auth error on the second cluster
await page.locator('button.seg', { hasText: 'gke-prod' }).click();
await page.getByText('Log in again and retry').waitFor({ timeout: 3000 });
ok(true, 'unauthorized cluster shows the login box');
await shot('k7-auth');

// add cluster modal
await page.getByRole('button', { name: '+ Add cluster' }).first().click();
await page.locator('button.seg', { hasText: 'minikube' }).click();
await page.getByRole('button', { name: 'Test connection' }).click();
await page.getByText('Connection OK · Kubernetes v1.31.0').waitFor({ timeout: 3000 });
ok(true, 'probe in add modal');
await shot('k8-add');
await page.getByRole('button', { name: 'Save cluster' }).click();
await page.getByText('Added cluster minikube').waitFor({ timeout: 3000 });
ok(true, 'cluster added');

// connections page cards
await nav('Connections');
await page.getByRole('heading', { name: 'Kubernetes clusters' }).waitFor();
await shot('k9-connections');

// Kubernetes page is not blocked when Docker is stopped
await nav('Kubernetes');
ok(await page.locator('.box.warn').count() === 0, 'no Docker banner on the Kubernetes page');

console.log(errors.length ? `\n${errors.length} problem(s):\n` + errors.join('\n') : '\nall flows passed');
await browser.close();
process.exit(errors.length ? 1 : 0);
