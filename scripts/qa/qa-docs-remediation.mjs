import { docsPageSlugs } from './docs-pages.mjs';
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { requestBodies } from './docs-request-bodies.mjs';
import {mkdirSync,writeFileSync} from 'node:fs';
const base=process.env.DOCS_BASE_URL||'http://127.0.0.1:5175';
const dir=process.env.DOCS_EVIDENCE||'/downloads/docs-after';mkdirSync(dir,{recursive:true});
const browser=await chromium.launch();const failures=[];const pages={};const bodies=[];let count=0;
function check(ok,msg){if(!ok)failures.push(msg);}
const slugs = docsPageSlugs();
for(const lang of ['en','ar']) {
 const context=await browser.newContext(); const page=await context.newPage();page.on('pageerror',e=>failures.push(`${lang} runtime: ${e.message}`));
 for(const slug of slugs){
  console.log('route',lang,slug);
  const path=`/docs/${lang==='ar'?'ar/':''}${slug==='index'?'':slug+'/'}`;
  await page.goto(base+path);await page.waitForSelector('h1.doc-h1');
  const data=await page.evaluate(()=>({ids:[...document.querySelectorAll('[id]')].map(x=>x.id),hrefs:[...document.querySelectorAll('a[href]')].map(x=>x.getAttribute('href')),sections:[...document.querySelectorAll('h2.doc-h2')].map(x=>x.id)}));pages[path]=data;
  for(const width of [320,390])for(const theme of ['light','dark']){
   await page.setViewportSize({width,height:900});await page.evaluate(t=>{document.documentElement.dataset.theme=t;document.documentElement.classList.toggle('dark',t==='dark');},theme);
   const widths=await page.evaluate(()=>({outer:document.documentElement.scrollWidth,viewport:innerWidth}));check(widths.outer<=widths.viewport,`${path} ${width} ${theme} overflow ${widths.outer}`);count++;
  }
  // Collect actual rendered bodies in every tab, without executing shell snippets.
  const blocks=page.locator('.code-block');
  for(let i=0;i<await blocks.count();i++){
   const block=blocks.nth(i);const tabs=block.locator('[role="tab"]');const n=await tabs.count();
   for(let j=0;j<Math.max(n,1);j++) {if(n)await tabs.nth(j).evaluate(button=>button.click());const code=await block.locator('pre').innerText();
    if(code.includes('curl')&& /(?:-d|--data(?:-raw)?)\s/.test(code)){
     const normalized=code.replaceAll('\u00a0',' ');
     try{bodies.push({path,code:normalized,bodies:requestBodies(normalized)});}catch(error){failures.push(`${path} invalid request JSON: ${error.message}`);}
    }
   }
  }
 }
 // Interaction and pixels, including search Tab/Shift+Tab and opener restoration.
 for(const width of [320,390,768,1440])for(const theme of ['light','dark']){
  await page.setViewportSize({width,height:900});await page.goto(`${base}/docs/${lang==='ar'?'ar/':''}quickstart/`);await page.waitForSelector('h1');await page.evaluate(t=>{document.documentElement.dataset.theme=t;document.documentElement.classList.toggle('dark',t==='dark');},theme);
  const search=page.locator('button.search-trigger');check(await search.isVisible(),`${width} ${lang} search hidden`);
  await page.screenshot({path:`${dir}/${width}-${lang}-${theme}.png`});
  // Radix close-autofocus runs after unmount; wait for the exact trigger, not a fixed sleep.
  if(width<1024){const menu=page.locator('header button').first();await menu.click();const dialog=page.getByRole('dialog');check(await dialog.isVisible(),`${width} ${lang} drawer`);await page.screenshot({path:`${dir}/drawer-${width}-${lang}-${theme}.png`});await page.keyboard.press('Escape');await page.waitForFunction(trigger => !document.querySelector('[role=dialog]') && document.activeElement === trigger, await menu.elementHandle(), {timeout: 3000}).catch(()=>{});check(await menu.evaluate(x=>document.activeElement===x),`${width} ${lang} menu focus restore`);await menu.click();await page.getByRole('dialog').getByRole('link').filter({hasText:lang==='ar'?'البدء السريع':'Quickstart'}).first().click();check(await page.getByRole('dialog').count()===0,`${lang} drawer route close`);await menu.click();await page.mouse.click(lang==='ar'?2:width-2,500);check(await page.getByRole('dialog').count()===0,`${lang} backdrop close`);}
  await search.click();await page.waitForSelector('.search-dialog');
  check(await page.evaluate(()=>document.querySelector('.docs-app > div')?.inert),`${lang} background not inert`);
  for(let i=0;i<16;i++){await page.keyboard.press(i%2?'Shift+Tab':'Tab');check(await page.evaluate(()=>!!document.activeElement?.closest('[role="dialog"]')),`${lang} search focus escaped`);}
  await page.keyboard.press('Escape');await page.waitForTimeout(50);check(await search.evaluate(x=>document.activeElement===x),`${lang} search focus restoration`);
  const axe=await new AxeBuilder({page}).include('.code-block').withRules(['color-contrast']).analyze();for(const v of axe.violations)failures.push(`${lang} ${theme} contrast ${JSON.stringify(v.nodes.map(x=>x.target))}`);
 }
 await context.close();
}
for(const [path,data] of Object.entries(pages))for(const href of data.hrefs){if(!href||!href.includes('#'))continue;const url=new URL(href,base+path);if(url.origin!==base)continue;const target=pages[url.pathname];check(url.hash.length>1,`${path} empty hash ${href}`);if(target&&url.hash)check(target.ids.includes(decodeURIComponent(url.hash.slice(1))),`${path} missing hash ${href}`);}
check(JSON.stringify(pages['/docs/quickstart/'].sections)===JSON.stringify(pages['/docs/ar/quickstart/'].sections),'Quickstart structural parity');
writeFileSync(`${dir}/request-bodies.json`,JSON.stringify(bodies,null,2));writeFileSync(`${dir}/results.json`,JSON.stringify({cases:count,pages:Object.keys(pages).length,bodies:bodies.length,failures},null,2));
console.log(JSON.stringify({cases:count,pages:Object.keys(pages).length,bodies:bodies.length,failures},null,2));await browser.close();process.exitCode=failures.length?1:0;
