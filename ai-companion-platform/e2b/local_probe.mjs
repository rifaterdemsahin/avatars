// Local (non-sandbox) dry run: open Venice settings, screenshot, list buttons. Never logs in or pays.
import { chromium } from 'playwright';
const b = await chromium.launch(); const pg = await b.newPage({ viewport: { width: 1280, height: 900 } });
await pg.goto('https://venice.ai/settings/api', { waitUntil: 'domcontentloaded', timeout: 45000 }); await pg.waitForTimeout(6000);
console.log(pg.url(), '|', await pg.title());
console.log((await pg.locator('button, a').allInnerTexts()).map(t => t.trim()).filter(Boolean).slice(0, 25));
await pg.screenshot({ path: 'data/assets/venice-local.png' }); await b.close();
