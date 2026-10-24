import { chromium } from '/home/phe/.local/state/ctw-go-live-20261013/cross-account-review/wechat-contact-gate/canton-root-contact-integration/node_modules/playwright/index.mjs';
const browser=await chromium.launch({headless:true,executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-dev-shm-usage']});
const page=await browser.newPage({viewport:{width:390,height:850},isMobile:true,hasTouch:true});
const errors=[];page.on('pageerror',error=>errors.push(error.message));
await page.goto('http://127.0.0.1:8189/qa/private-pages/',{waitUntil:'domcontentloaded'});
await page.getByRole('button',{name:'Abrir ou fechar navegação'}).click();
await page.locator('.suco-nav-item').filter({hasText:'Conversas'}).click();
await page.getByRole('switch',{name:'Suco automático de Grupo sintético'}).click();
await page.getByRole('switch',{name:'Suco automático de Grupo sintético'}).waitFor({state:'visible'});
await page.waitForTimeout(250);
const tracked=await page.getByRole('switch',{name:'Suco automático de Grupo sintético'}).getAttribute('aria-checked');
await page.getByRole('button',{name:'Escolher conversa Grupo sintético'}).click();
await page.getByRole('button',{name:'Escolher meu suco'}).waitFor({timeout:10000});
const state={tracked,chooseVisible:await page.getByRole('button',{name:'Escolher meu suco'}).isVisible(),
 alerts:await page.locator('[role="alert"]').allTextContents(),browserErrors:errors,
 calls:await page.evaluate(()=>window.__qaCalls)};
await page.screenshot({path:new URL('./screenshots/390-conversation-flow.png',import.meta.url).pathname});
await browser.close();console.log(JSON.stringify(state,null,2));
if(tracked!=='true'||!state.chooseVisible||errors.length||state.alerts.length)process.exitCode=1;
