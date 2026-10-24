import { chromium } from '/home/phe/.local/state/ctw-go-live-20261013/cross-account-review/wechat-contact-gate/canton-root-contact-integration/node_modules/playwright/index.mjs';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const root = new URL('.', import.meta.url).pathname;
await mkdir(`${root}/screenshots`, { recursive: true });
const results = [];
for (const width of [1440, 390]) {
  const context = await browser.newContext({ viewport: { width, height: 850 },
    ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://127.0.0.1:8189/qa/private-pages/', { waitUntil: 'domcontentloaded' });
  await page.getByText('De que papo vai sair suco?').waitFor();
  const pages = ['Fazer um suco', 'Conversas', 'Meus tipos', 'Meus sucos', 'Resumo do dia', 'Guia do Suco', 'Configurações'];
  for (const name of pages) {
    if (name !== 'Fazer um suco') {
      if (width < 500) await page.getByRole('button', { name: 'Abrir ou fechar navegação' }).click();
      await page.locator('.suco-nav-item').filter({ hasText: name }).click();
    }
    await page.waitForTimeout(250);
    const state = await page.evaluate(() => ({
      heading: document.querySelector('main h1, .suco-page h1')?.textContent?.trim() ?? null,
      active: document.querySelector('.suco-nav-item[aria-current="page"]')?.textContent?.trim() ?? null,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      errors: [...document.querySelectorAll('[role="alert"]')].map(item => item.textContent?.trim()).filter(Boolean),
      apiCalls: (window).__qaCalls?.slice(-6) ?? [],
    }));
    await page.screenshot({ path: `${root}/screenshots/${width}-${name.replace(/\s+/g, '-').toLowerCase()}.png`, fullPage: false });
    results.push({ width, page: name, ...state });
  }
  results.push({ width, browserErrors: errors });
  await context.close();
}
await browser.close();
console.log(JSON.stringify(results, null, 2));
