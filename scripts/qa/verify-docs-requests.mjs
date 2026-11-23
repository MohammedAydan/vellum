import {chromium} from 'playwright';
import {requestBodies} from './docs-request-bodies.mjs';
// Read rendered curl bodies as data. Never execute arbitrary shell from docs.
export async function verifyDisplayedRulesRequests(base,projectId,apiKey,docsBase='http://127.0.0.1:5175'){
 const browser=await chromium.launch();let verified=0;
 try{
  for(const lang of ['en','ar']){
   const page=await browser.newPage();await page.goto(`${docsBase}/docs/${lang==='ar'?'ar/':''}security-rules-dsl/`);await page.waitForSelector('h1');
   const block=(await page.locator('pre').allTextContents()).find(x=>x.includes('$BASE/compile'));
   if(!block)throw new Error('Missing displayed Rules requests');
   const bodies=requestBodies(block.replaceAll('\u00a0',' '));if(bodies.length!==3)throw new Error('Expected three displayed Rules bodies');
   for(let i=0;i<bodies.length;i++){
    const endpoint=['compile','decompile','simulate'][i];
    const body=bodies[i];
    const response=await fetch(`${base}/v1/projects/${projectId}/rules/${endpoint}`,{method:'POST',headers:{'content-type':'application/json','x-project-key':apiKey},body:JSON.stringify(body)});
    if(response.status!==200)throw new Error(`${lang} displayed ${endpoint}: HTTP ${response.status}`);
    verified++;
   }
   await page.close();
  }
 }finally{await browser.close();}
 console.log(`Displayed Rules requests: ${verified}/6 returned HTTP 200`);
}
