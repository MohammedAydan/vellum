import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mockApi, seedSession, ORG_ID } from './helpers.js';

test.beforeEach(async({page})=>{await mockApi(page);await seedSession(page,true);await page.addInitScript(()=>localStorage.setItem('vellum_theme','light'));});
test('failed flag create preserves form and never reports success',async({page})=>{
  await page.route('**/v1/admin/features',route=>route.request().method()==='POST'?route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{message:'Controlled failure'}})}):route.fallback());
  await page.goto('http://127.0.0.1:3001/admin/features');
  await page.getByRole('button',{name:'Register Flag',exact:true}).click();
  await expect(page.locator('#flagName')).toHaveCount(0);await expect(page.locator('#category')).toHaveCount(0);
  await page.locator('#flagId').fill('failed_creation');await page.locator('#desc').fill('Keep this input');
  await page.getByRole('button',{name:'Create Flag',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible();await expect(page.locator('#flagId')).toHaveValue('failed_creation');await expect(page.locator('#desc')).toHaveValue('Keep this input');
  await expect(page.getByText(/registered successfully/i)).toHaveCount(0);
});
test('bulk save skips unchanged flags and blocks reentry; failed toggle stays unchanged',async({page})=>{
  let writes=0;await page.route('**/v1/admin/features',async route=>{
    if(route.request().method()!=='POST')return route.fallback();writes++;await new Promise(resolve=>setTimeout(resolve,400));
    await route.fulfill({contentType:'application/json',body:JSON.stringify({...route.request().postDataJSON(),updatedAt:new Date().toISOString(),updatedBy:null})});
  });
  await page.goto('http://127.0.0.1:3001/admin/features');const save=page.getByRole('button',{name:'Save Changes',exact:true});await expect(save).toBeDisabled();
  const slider=page.getByRole('slider');await slider.focus();await slider.press('ArrowLeft');await expect(save).toBeEnabled();
  await save.evaluate(el=>{(el as HTMLButtonElement).click();(el as HTMLButtonElement).click();});await expect(save).toBeDisabled();await expect.poll(()=>writes).toBe(1);
  await page.route('**/v1/admin/features',route=>route.request().method()==='POST'?route.fulfill({status:500,contentType:'application/json',body:JSON.stringify({error:{message:'Toggle failed'}})}):route.fallback());
  const toggle=page.getByRole('switch');await expect(toggle).toBeChecked();await toggle.click();await expect(toggle).toBeChecked();
});
test('real download contains explicit filters and no invented verification',async({page})=>{
  await page.route('**/v1/admin/audit-export?*',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({scope:{source:'audit_logs',query:new URL(route.request().url()).searchParams.get('q')},integrity:{status:'not_available'},items:[{action:'tenant.suspended'}]})}));
  await page.goto('http://127.0.0.1:3001/admin/audit');await page.getByPlaceholder(/Filter by action/i).fill('tenant');
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export Audit Trail'}).click();const file=await download;expect(file.suggestedFilename()).toBe('audit_trail.json');
  const stream=await file.createReadStream();let content='';for await(const chunk of stream!)content+=chunk;expect(JSON.parse(content).scope.query).toBe('tenant');expect(JSON.parse(content).integrity.status).toBe('not_available');
});
for(const locale of ['en','ar'])for(const theme of ['light','dark'])test(`flag accessibility and single mobile nav ${locale} ${theme}`,async({page})=>{
  await page.addInitScript(({locale,theme})=>{localStorage.setItem('vellum.locale',locale);localStorage.setItem('vellum_theme',theme);},{locale,theme});
  await page.goto('http://127.0.0.1:3001/admin/features');await expect(page.getByRole('switch')).toHaveAccessibleName(/E2e Flag/i);await expect(page.getByRole('slider')).toHaveAccessibleName(/E2e Flag/i);
  const result=await new AxeBuilder({page}).withRules(['button-name','aria-input-field-name','color-contrast','heading-order']).analyze();expect(result.violations).toEqual([]);
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Toggle navigation menu'}).click();const drawer=page.getByRole('dialog',{name:'Navigation'});await expect(drawer).toBeVisible();
  await expect(drawer.locator('button[aria-current="page"]')).toHaveCount(1);await expect(drawer.getByText(locale==='ar'?'ميزات التجربة':'Feature Flags',{exact:true})).toHaveCount(1);
  const controls=drawer.locator('button:visible, a[href]:visible, [tabindex="0"]:visible');await controls.last().focus();await page.keyboard.press('Tab');await expect(controls.first()).toBeFocused();await page.keyboard.press('Shift+Tab');await expect(controls.last()).toBeFocused();
  await page.keyboard.press('Escape');await expect(drawer).toHaveCount(0);await expect(page.getByRole('button',{name:'Toggle navigation menu'})).toBeFocused();
});
test('tenant usage read-only and missing security reads unknown',async({page})=>{
  await page.route('**/security-metadata',route=>route.fulfill({status:500,contentType:'application/json',body:'{"error":{"message":"Unavailable"}}'}));
  await page.goto(`http://127.0.0.1:3001/admin/tenants/${ORG_ID}`);await expect(page.locator('#qReads')).toHaveAttribute('readonly','');await expect(page.getByRole('link',{name:'Revenue & Quota Control'})).toBeVisible();
  await page.getByRole('tab',{name:'Security & Rules'}).click();await expect(page.getByRole('status').filter({hasText:'Unknown'})).toBeVisible();await expect(page.getByText('v4',{exact:true})).toHaveCount(0);
});
for(const setup of [false,true])for(const locale of ['en','ar'])for(const theme of ['light','dark'])test(`auth landmarks and contrast setup=${setup} ${locale} ${theme}`,async({page})=>{
  await page.addInitScript(({locale,theme})=>{localStorage.clear();localStorage.setItem('vellum.locale',locale);localStorage.setItem('vellum_theme',theme);},{locale,theme});
  await page.route('**/v1/admin/setup-status',route=>route.fulfill({contentType:'application/json',body:JSON.stringify({initialized:!setup,requiresSetup:setup,tokenRequired:setup})}));
  await page.goto('http://127.0.0.1:3001/admin/login');await expect(page.getByRole('heading',{level:1})).toHaveCount(1);await expect(page.getByRole('main')).toHaveCount(1);
  const result=await new AxeBuilder({page}).withRules(['color-contrast','heading-order','label','landmark-one-main']).analyze();expect(result.violations).toEqual([]);
});
