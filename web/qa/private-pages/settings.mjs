import { chromium } from '/home/phe/.local/state/ctw-go-live-20261013/cross-account-review/wechat-contact-gate/canton-root-contact-integration/node_modules/playwright/index.mjs';
const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const page = await browser.newPage({ viewport: { width: 390, height: 850 }, isMobile: true, hasTouch: true });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.goto('http://127.0.0.1:8189/qa/private-pages/', { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: 'Abrir ou fechar navegação' }).click();
await page.locator('.suco-nav-item').filter({ hasText: 'Configurações' }).click();
await page.getByRole('button', { name: 'Tentar sincronizar' }).click();
await page.waitForFunction(() => window.__qaCalls?.includes('POST /api/connection/reconnect'));
const state = { heading: await page.locator('main h1').first().innerText(),
  connected: await page.getByText('Mensagem nova salva após a conexão.').isVisible(),
  calls: await page.evaluate(() => window.__qaCalls), errors,
  overflow: await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth) };
await browser.close();
console.log(JSON.stringify(state, null, 2));
if (!state.connected || state.errors.length || state.overflow) process.exitCode = 1;
