import { chromium } from 'playwright';

// Rendered documentation is data, never executable shell or JavaScript.
export function displayedRulesExamples(blocks) {
  blocks = blocks.map(text => text.replaceAll('\u00a0', ' '));
  const source = blocks.find(text => text.includes('match /users/{userId}/notes/{noteId}') && text.includes('function ownsNamespace()'));
  const simulation = blocks.map(text => {
    try { return JSON.parse(text); } catch { return null; }
  }).find(value => value?.operation === 'get' && value?.rulesAst && value?.auth?.uid === 'alice');
  if (!source || !simulation) throw new Error('Missing displayed Rules DSL or simulation JSON');
  return { source, simulation };
}

export async function verifyDisplayedRulesRequests(base, projectId, apiKey, docsBase = 'http://127.0.0.1:5175') {
  const browser = await chromium.launch();
  let verified = 0;
  async function post(endpoint, body, lang) {
    const response = await fetch(`${base}/v1/projects/${projectId}/rules/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-project-key': apiKey },
      body: JSON.stringify(body),
    });
    if (response.status !== 200) throw new Error(`${lang} displayed ${endpoint}: HTTP ${response.status}`);
    verified++;
    return response.json();
  }
  try {
    for (const lang of ['en', 'ar']) {
      const page = await browser.newPage();
      await page.goto(`${docsBase}/docs/${lang === 'ar' ? 'ar/' : ''}security-rules-dsl/`);
      await page.waitForSelector('h1');
      const { source, simulation } = displayedRulesExamples(await page.locator('pre').allTextContents());
      const compiled = await post('compile', { source }, lang);
      if (!compiled.ast || compiled.diagnostics?.length) throw new Error(`${lang} displayed DSL did not compile cleanly`);
      const decompiled = await post('decompile', { rulesAst: compiled.ast }, lang);
      if (typeof decompiled.dsl !== 'string' || !decompiled.dsl.trim()) throw new Error(`${lang} decompile returned no DSL`);
      const allowed = await post('simulate', simulation, lang);
      if (allowed.allowed !== true) throw new Error(`${lang} displayed owner simulation was denied`);
      for (const uid of ['bob', null]) {
        const denied = await post('simulate', { ...simulation, auth: { ...simulation.auth, uid } }, lang);
        if (denied.allowed !== false) throw new Error(`${lang} non-owner simulation was allowed`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`Displayed Rules examples: ${verified}/10 requests returned HTTP 200 with expected results`);
}
