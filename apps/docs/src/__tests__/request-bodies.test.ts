import { describe, expect, it } from 'vitest';
// @ts-expect-error The dependency-free parser is shared with Node browser checks.
import { requestBodies, shellWords } from '../../../../scripts/qa/docs-request-bodies.mjs';
describe('displayed request body parser',()=>{
 it('parses shell-quoted JSON with escaped newlines and apostrophes without running shell',()=>{
  const body={source:"rules_version = '2';\nmatch /users/{uid} { allow get: if isOwner(uid); }"};
  const displayed=`curl -d '${JSON.stringify(body).replaceAll("'","'\\''")}'`;
  expect(requestBodies(displayed)).toEqual([body]);
 });
 it('rejects literal control characters in JSON',()=>{
  expect(()=>requestBodies(`curl -d '{"source":"one\ntwo"}'`)).toThrow();
 });
 it('never evaluates shell substitutions',()=>{
  expect(shellWords("curl -d '$(command)'" )).toEqual(['curl','-d','$(command)']);
 });
});
