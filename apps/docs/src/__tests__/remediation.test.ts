import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { betaJavaScriptInstall, betaDartInstall } from '../beta-install';
import { quickstartTypeScript, quickstartDart } from '../quickstart-examples';
const root=resolve(import.meta.dirname,'../../../..');
const read=(path:string)=>readFileSync(resolve(root,path),'utf8');
describe('docs remediation contracts',()=>{
 it('pins beta installs to the same source revision and requires supported runtimes',()=>{
   const ref=betaJavaScriptInstall.match(/git checkout ([a-f0-9]{40})/)?.[1];
   expect(ref).toBeTruthy(); expect(betaDartInstall).toContain(`ref: ${ref}`);
   expect(betaJavaScriptInstall).toContain('Node.js 22+');expect(betaDartInstall).toContain('Dart 3.4+');
   expect(betaDartInstall).toContain('path: sdks/flutter');
 });
 it('uses one executable Quickstart source with guaranteed lifecycle cleanup',()=>{
   for(const lang of ['en','ar']){
     const text=read(`apps/docs/src/pages/${lang}/quickstart.tsx`);
     expect(text).toContain('code: quickstartTypeScript');expect(text).toContain('code: quickstartDart');
     for(const section of ['verify-health','install','first-operations','operators-at-a-glance','dispose-best-practices'])expect(text).toContain(`id="${section}"`);
   }
   for(const code of [quickstartTypeScript,quickstartDart]){expect(code).toContain('finally');expect(code).toContain('db.dispose()');}
 });
 it('documents optimistic-concurrency conflict handling in both languages',()=>{
   for(const lang of ['en','ar']){
     expect(read(`apps/docs/src/pages/${lang}/reference/errors.tsx`)).toContain('If-Match');
   }
 });
 it('has all 13 Dart manifest programs in the live CI gate',()=>{
   const manifest=JSON.parse(read('examples/ts/manifest.json')) as {dart:string}[];
   expect(manifest).toHaveLength(13);for(const entry of manifest)expect(read(`examples/${entry.dart}`)).toContain('Platform.environment');
   expect(read('.github/workflows/docs-regression.yml')).toContain('run-docs-live.ts');
 });
});
