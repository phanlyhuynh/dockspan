// Scan the English UI (fake backend) for untranslated Vietnamese text: `node scripts/i18n-check.mjs`
import { chromium } from 'playwright-core';
const VN = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
await page.goto('http://localhost:1420/?mock'); await page.waitForSelector('nav'); await page.waitForTimeout(700);
const found = new Set();
const scan = async (tag) => { const t = await page.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0).map((e) => (e.innerText || e.textContent || '') + ' ' + (e.getAttribute('placeholder') || '') + ' ' + (e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '')).join('\n')); for (const l of t.split('\n')) if (VN.test(l) && !/Tiếng Việt/.test(l)) found.add(tag + ': ' + l.trim().slice(0, 90)); };
const nav = (l) => page.locator('nav button.navi', { hasText: l }).first().click();
await scan('dash');
for (const [l, tag] of [['Projects','projects'],['Containers','containers'],['Images','images'],['Networks','networks'],['Volumes','volumes'],['Cleanup','cleanup'],['Connections','conn'],['Kubernetes','k8s']]) { await nav(l); await page.waitForTimeout(500); await scan(tag); }
await nav('Containers');
for (const tab of ['Terminal','Stats','Inspect','Logs']) { await page.getByRole('tab', { name: tab }).click(); await page.waitForTimeout(700); await scan('ctr-' + tab); }
await nav('Images'); await page.locator('.cellbtn:visible').first().click(); await page.waitForTimeout(500); await scan('image-drawer'); await page.keyboard.press('Escape');
await nav('Networks'); await page.locator('.cellbtn:visible').nth(3).click(); await page.waitForTimeout(500); await scan('net-drawer'); await page.keyboard.press('Escape');
await nav('Volumes'); await page.locator('.cellbtn:visible').first().click(); await page.waitForTimeout(700); await scan('vol-drawer'); await page.keyboard.press('Escape');
await nav('Overview');
for (const [btn, tag] of [['Run container','run'],['Pull image','pull'],['Add folder','add']]) { await page.getByRole('button', { name: btn }).first().click(); await page.waitForTimeout(500); await scan(tag); await page.keyboard.press('Escape'); }
await page.keyboard.press('Control+k'); await page.waitForTimeout(300); await scan('palette'); await page.keyboard.press('Escape');
await nav('Projects'); await page.getByRole('button', { name: 'Open folder' }).first().click(); await page.waitForTimeout(500); await scan('files'); await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'More options' }).first().click(); await scan('menu'); await page.keyboard.press('Escape');
await nav('Cleanup'); await page.getByRole('button', { name: 'Schedule…' }).click(); await page.waitForTimeout(300); await scan('schedule'); await page.keyboard.press('Escape');
await page.getByRole('button', { name: 'Clean up now' }).click(); await page.waitForTimeout(300); await scan('prune-confirm');
console.log([...found].join('\n') || 'no Vietnamese text left in the English UI');
await browser.close();
