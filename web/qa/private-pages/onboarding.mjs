// QA harness: point PLAYWRIGHT_MODULE at your playwright install (or npm i playwright).
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const supabaseUrl = process.env.VITE_SUPABASE_URL ?? '';
const projectRef = /^https:\/\/([a-z0-9][a-z0-9-]{19,30})\.supabase\.co$/.exec(supabaseUrl)?.[1];
if (!projectRef) throw Error('QA: export VITE_SUPABASE_URL=https://SEU-PROJETO.supabase.co');

const accountId = '11111111-1111-4111-8111-111111111111';
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const expiresAt = Math.floor(Date.now() / 1000) + 86400;
const token = `${encoded({ alg: 'HS256', typ: 'JWT' })}.${encoded({ sub: accountId, exp: expiresAt,
  aud: 'authenticated', role: 'authenticated' })}.synthetic`;
const session = { access_token: token, refresh_token: 'synthetic-refresh', token_type: 'bearer',
  expires_in: 86400, expires_at: expiresAt,
  user: { id: accountId, email: 'qa@example.test', aud: 'authenticated', role: 'authenticated',
    app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() } };
const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome',
  args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const results = [];
for (const width of [1440, 390]) {
  const context = await browser.newContext({ viewport: { width, height: 850 },
    ...(width < 500 ? { isMobile: true, hasTouch: true } : {}) });
  await context.addInitScript(({ saved }) => {
    localStorage.setItem(`sb-${projectRef}-auth-token`, JSON.stringify(saved));
    window.__qaDisconnected = true;
  }, { saved: session });
  const page = await context.newPage();
  const errors = []; let accepted = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route(`${supabaseUrl}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/rpc/suco_consent_accept')) accepted = true;
    if (path.endsWith('/rpc/suco_consent_status') || path.endsWith('/rpc/suco_consent_accept'))
      return route.fulfill({ status: 200, contentType: 'application/json',
        headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ consent: accepted ?
          { version: 'readonly-2026-10-15', acceptedAt: new Date().toISOString() } : null }) });
    errors.push(`unexpected Supabase request: ${path}`);
    return route.abort();
  });
  await page.goto('http://127.0.0.1:8189/qa/private-pages/', { waitUntil: 'domcontentloaded' });
  await page.getByText('De que papo vai sair suco?').waitFor();
  if (width < 500) await page.getByRole('button', { name: 'Abrir ou fechar navegação' }).click();
  await page.locator('.suco-nav-item').filter({ hasText: 'Conectar WhatsApp' }).click();
  await page.getByRole('heading', { name: 'Seu primeiro suco começa com uma conversa.' }).waitFor();
  await page.getByRole('checkbox', { name: /Sou responsável por esta conta/ }).click();
  await page.getByRole('button', { name: 'Autorizar e conectar' }).click();
  await page.getByRole('heading', { name: 'Vamos retomar seu zap.' }).waitFor();
  const prepare = page.getByRole('button', { name: 'Preparar QR de conexão' });
  if (width < 500) await page.getByText('Tenho outra tela. Mostrar QR aqui.').click();
  await prepare.click().catch(async error => {
    console.log(JSON.stringify({ width, body: (await page.locator('body').innerText()).slice(0, 4000),
      calls: await page.evaluate(() => window.__qaCalls), errors }));
    throw error;
  });
  await page.locator('.qr-quiet-zone svg').waitFor().catch(async error => {
    console.log(JSON.stringify({ width, body: (await page.locator('body').innerText()).slice(0, 4000),
      calls: await page.evaluate(() => window.__qaCalls), errors }));
    throw error;
  });
  const beforeReload = await page.evaluate(() => ({ path: location.pathname,
    draft: [...Array(localStorage.length)].map((_, i) => localStorage.key(i))
      .filter(key => key?.startsWith('suco:onboarding:')), consent: document.body.textContent?.includes('autorização') }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('De que papo vai sair suco?').waitFor();
  if (width < 500) await page.getByRole('button', { name: 'Abrir ou fechar navegação' }).click();
  await page.locator('.suco-nav-item').filter({ hasText: 'Conectar WhatsApp' }).click();
  await page.getByRole('heading', { name: 'Vamos retomar seu zap.' }).waitFor();
  const state = await page.evaluate(() => ({ heading: document.querySelector('main h1')?.textContent,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    alerts: [...document.querySelectorAll('[role="alert"]')].map(el => el.textContent?.trim()),
    calls: window.__qaCalls }));
  results.push({ width, accepted, beforeReload, state, errors });
  await context.close();
}
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 850 } });
  await context.addInitScript(({ saved }) => {
    localStorage.setItem(`sb-${projectRef}-auth-token`, JSON.stringify(saved));
    window.__qaUnverified = true;
  }, { saved: session });
  const page = await context.newPage();
  const errors = []; let accepted = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.route(`${supabaseUrl}/**`, route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/rpc/suco_consent_accept')) accepted = true;
    return route.fulfill({ status: 200, contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ consent: accepted ?
        { version: 'readonly-2026-10-15', acceptedAt: new Date().toISOString() } : null }) });
  });
  await page.goto('http://127.0.0.1:8189/qa/private-pages/', { waitUntil: 'domcontentloaded' });
  await page.getByText('De que papo vai sair suco?').waitFor();
  await page.locator('.suco-nav-item').filter({ hasText: 'Conectar WhatsApp' }).click();
  await page.getByRole('heading', { name: 'Seu primeiro suco começa com uma conversa.' }).waitFor();
  await page.getByRole('checkbox', { name: /Sou responsável por esta conta/ }).click();
  await page.getByRole('button', { name: 'Autorizar e conectar' }).click();
  await page.getByRole('heading', { name: 'Conexão aberta, atualização ainda não confirmada.' }).waitFor();
  results.push({ scenario: 'connected-without-fresh-messages', accepted,
    stayedOnConnection: await page.getByRole('button', { name: 'Tentar sincronizar sem novo QR' }).isVisible(),
    errors });
  await context.close();
}
await browser.close();
console.log(JSON.stringify(results, null, 2));
if (results.some(row => !row.accepted || row.errors.length ||
    (row.state && (row.state.overflow || row.state.alerts.length)) ||
    (row.scenario && !row.stayedOnConnection)))
  process.exitCode = 1;
