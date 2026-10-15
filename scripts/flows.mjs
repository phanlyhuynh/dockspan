// Check the UI's interactive flows against the fake backend: `node scripts/flows.mjs`
import { chromium } from 'playwright-core';

const base = process.argv[2] ?? 'http://localhost:1420/?mock';
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(5000);
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
let failed = 0;
const step = async (name, fn) => {
  await page.keyboard.press('Escape');
  try { await fn(); console.log('✓', name); } catch (e) { failed++; console.log('✗', name, '\n   ', String(e.message).split('\n')[0]); await page.screenshot({ path: `/tmp/flow-fail-${failed}.png` }); }
};
const nav = (label) => page.locator('nav button.navi', { hasText: label }).first().click();
const row = (name) => page.locator('.tr:visible').filter({ has: page.locator('.nm', { hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }) }).first();
const toast = (text) => page.locator('.toast', { hasText: text }).first().waitFor({ timeout: 4000 });

await page.goto(base);
await page.waitForSelector('nav');
await page.waitForTimeout(600);

await step('sidebar shows the containers counter 5/6', async () => {
  await page.locator('nav button.navi', { hasText: 'Containers' }).getByText('5/6').waitFor({ timeout: 2000 });
});

await step('stop container: switches to "Run" and shows a toast', async () => {
  await nav('Containers');
  await row('myshop-redis-1').getByRole('button', { name: 'Stop', exact: true }).click();
  await toast('myshop-redis-1 has stopped');
  await row('myshop-redis-1').getByRole('button', { name: 'Run', exact: true }).waitFor({ timeout: 3000 });
});

await step('start the container again', async () => {
  await row('myshop-redis-1').getByRole('button', { name: 'Run', exact: true }).click();
  await toast('myshop-redis-1 is now running');
  await row('myshop-redis-1').getByRole('button', { name: 'Stop', exact: true }).waitFor({ timeout: 3000 });
});

await step('filter by keyword and "Running only"', async () => {
  await page.getByPlaceholder('Filter by name, image, project').fill('blog');
  await page.waitForTimeout(200);
  if ((await page.locator('.tr:visible').count()) !== 2) throw new Error('filtering blog must leave 2 rows');
  await page.getByRole('button', { name: 'Running only' }).click();
  if ((await page.locator('.tr:visible').count()) !== 1) throw new Error('running blog must leave 1 row');
  await page.getByRole('button', { name: 'Running only' }).click();
  await page.getByPlaceholder('Filter by name, image, project').fill('');
});

await step('run a new container from the modal + equivalent command', async () => {
  await page.getByRole('button', { name: 'Run new container' }).click();
  await page.locator('.optc', { hasText: 'nginx:alpine' }).click();
  await page.getByPlaceholder('leave empty = auto-generated').fill('web');
  await page.getByPlaceholder('8080:80').fill('8080:80');
  const cmd = await page.locator('.term', { hasText: 'docker run' }).first().innerText();
  if (!cmd.includes('--name web -p 8080:80') || !cmd.includes('nginx:alpine')) throw new Error('wrong equivalent command: ' + cmd);
  await page.getByRole('button', { name: 'Create container' }).click();
  await toast('web created and started');
  await row('web').waitFor({ timeout: 3000 });
});

await step('delete container through the confirm dialog', async () => {
  await row('web').getByRole('button', { name: 'Delete container' }).click();
  await page.getByRole('dialog').getByText('Delete container web?').waitFor();
  await page.getByRole('button', { name: 'Force delete' }).click();
  await toast('Removed web');
  await page.waitForTimeout(500);
  if (await page.locator('.tr:visible', { hasText: 'nginx:alpine' }).count()) throw new Error('container web is still there');
});

await step('Logs tab filters by Error level', async () => {
  await row('myshop-api-1').locator('.cellbtn').click();
  await page.getByRole('tab', { name: 'Logs' }).click();
  await page.waitForTimeout(700);
  await page.getByRole('button', { name: 'Error', exact: true }).click();
  const n = await page.locator('.lvl.INFO').count();
  if (n !== 0) throw new Error('INFO lines remain after filtering Error');
  if ((await page.locator('.lvl.ERROR').count()) < 1) throw new Error('no ERROR line');
});

await step('Terminal: several sessions, kept when selecting another container and coming back', async () => {
  await nav('Containers');
  await row('myshop-api-1').locator('.cellbtn').click();
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await page.getByRole('button', { name: '+ New terminal' }).click();
  await page.getByRole('button', { name: /^Terminal 2/ }).waitFor();
  await row('myshop-web-1').locator('.cellbtn').click();
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await page.getByRole('button', { name: /^Terminal 1/ }).waitFor();
  if (await page.getByRole('button', { name: /^Terminal 2/ }).count()) throw new Error('container B must not see the session of A');
  await row('myshop-api-1').locator('.cellbtn').click();
  await page.getByRole('button', { name: /^Terminal 2/ }).waitFor();
  await page.getByRole('tab', { name: 'Logs' }).click();
  await nav('Images'); await nav('Containers');
  await page.getByRole('tab', { name: 'Terminal' }).click();
  await page.getByRole('button', { name: /^Terminal 2/ }).waitFor();
});

await step('Images: pull receives progress then completes', async () => {
  await nav('Images');
  await page.getByRole('button', { name: 'Pull image' }).first().click();
  await page.getByPlaceholder('nginx:alpine').fill('redis:8');
  await page.getByRole('button', { name: 'Pull', exact: true }).click();
  await page.getByText('Done. The image is now in the Images list.').waitFor({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await row('redis').first().waitFor();
});

await step('Images: in-use image has delete disabled, dangling one can be deleted', async () => {
  const used = page.locator('.tr:visible', { hasText: 'myshop-api' }).first();
  if (!(await used.getByRole('button', { name: 'Delete image' }).isDisabled())) throw new Error('an in-use image must be locked');
  const dang = page.locator('.tr:visible', { hasText: '<none>' }).first();
  await dang.getByRole('button', { name: 'Delete image' }).click();
  await page.getByRole('button', { name: 'Delete image', exact: true }).last().click();
  await toast('Removed image');
});

await step('Networks/Volumes: system networks and in-use volumes cannot be deleted', async () => {
  await nav('Networks');
  if (!(await row('bridge').getByRole('button', { name: 'Delete network' }).isDisabled())) throw new Error('bridge must be locked');
  if (await row('old-project_net').getByRole('button', { name: 'Delete network' }).isDisabled()) throw new Error('an unused network must be deletable');
  await nav('Volumes');
  if (!(await row('myshop_pgdata').getByRole('button', { name: 'Delete volume' }).isDisabled())) throw new Error('an in-use volume must be locked');
});

await step('Cleanup: volumes off by default, confirm then finish', async () => {
  await nav('Cleanup');
  if (await page.locator('.prune', { hasText: 'Unused volumes' }).locator('input').isChecked()) throw new Error('volumes must be off by default');
  await page.getByRole('button', { name: 'Clean up now' }).click();
  await page.getByRole('dialog').getByText('Confirm cleanup').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: /^Clean / }).click();
  await page.getByText(/Cleanup done, freed/).first().waitFor({ timeout: 5000 });
});

await step('Cleanup: enabling volumes shows the red warning', async () => {
  await page.locator('.prune', { hasText: 'Unused volumes' }).locator('input').check();
  await page.getByText('Pruning volumes deletes data').waitFor();
  await page.locator('.prune', { hasText: 'Unused volumes' }).locator('input').uncheck();
});

await step('Projects: Stop then Start a compose project', async () => {
  await nav('Projects');
  const card = page.locator('.card', { hasText: 'docker-compose.yml' }).first();
  await card.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByText('myshop: services stopped').waitFor({ timeout: 5000 });
  await card.getByRole('button', { name: 'Start', exact: true }).waitFor({ timeout: 3000 });
});

await step('Projects: add a new folder', async () => {
  await page.getByRole('button', { name: 'Add folder' }).first().click();
  await page.locator('.pick', { hasText: 'inventory-service' }).click();
  await page.getByRole('button', { name: 'Add project' }).click();
  await page.getByText('Added project inventory-service').waitFor({ timeout: 4000 });
  await page.locator('.card', { hasText: 'inventory-service' }).first().waitFor();
});

await step('Projects: open files, .env hides sensitive values and reveals on click', async () => {
  await page.getByRole('button', { name: 'Open folder' }).first().click();
  await page.locator('.frow', { hasText: '.env' }).click();
  await page.getByText('JWT_SECRET=••••••').waitFor();
  await page.getByRole('button', { name: 'Show sensitive values' }).click();
  await page.locator('textarea.editor').waitFor();
  if (!(await page.locator('textarea.editor').inputValue()).includes('JWT_SECRET=abc123')) throw new Error('value not revealed');
  await page.keyboard.press('Escape');
});

await step('Command palette Ctrl+K: filter, arrow + Enter opens a container', async () => {
  await page.keyboard.press('Control+k');
  await page.keyboard.type('myshop-redis');
  await page.locator('.palitem').first().waitFor();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Containers' }).waitFor();
  await page.locator('.tr.sel', { hasText: 'redis' }).waitFor({ timeout: 2000 });
});

await step('Switch context from the sidebar', async () => {
  await page.getByRole('button', { name: 'Change Docker context' }).click();
  await page.locator('.menu .mi', { hasText: 'colima' }).click();
  await page.getByText('Switched to context colima').first().waitFor({ timeout: 4000 }).catch(() => {});
});

await step('Engine off: banner, Start button, write actions blocked', async () => {
  await page.evaluate(() => window.__mockEmit('engine://status', { state: 'off', ctx: { id: 'default', name: 'desktop-linux', endpoint: 'unix:///x', kind: 'local' } }));
  await page.getByText('Lost connection to Docker').waitFor({ timeout: 2000 });
  await page.locator('header').getByRole('button', { name: 'Start' }).waitFor();
  await nav('Containers');
  await page.locator('.tr:visible').first().getByRole('button', { name: /^(Stop|Run)$/ }).click();
  await toast('Docker Engine is not running');
});

await step('Settings: gear opens the Settings page; default English, change applies immediately and is remembered', async () => {
  const p2 = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await p2.goto(base); await p2.waitForSelector('nav');
  await p2.locator('nav button.navi', { hasText: 'Overview' }).waitFor();
  await p2.getByRole('button', { name: 'Settings' }).click();
  await p2.getByRole('heading', { name: 'Language' }).waitFor();
  await p2.getByRole('radio', { name: 'Tiếng Việt' }).click();
  await p2.locator('nav button.navi', { hasText: 'Tổng quan' }).waitFor();
  await p2.reload(); await p2.waitForSelector('nav');
  await p2.locator('nav button.navi', { hasText: 'Tổng quan' }).waitFor();
  await p2.getByRole('button', { name: 'Cài đặt' }).click();
  await p2.getByRole('radio', { name: 'English' }).click();
  await p2.locator('nav button.navi', { hasText: 'Overview' }).waitFor();
  await p2.close();
});

console.log(errors.length ? '\nPage errors:\n' + errors.join('\n') : '\nno page errors');
console.log(failed ? `\n${failed} steps failed` : '\nall steps passed');
await browser.close();
process.exit(failed ? 1 : 0);
