/**
 * Runs LAST (file name order). These cases intentionally look like attacks, so the platform's threat detector
 * may auto-block the local IP afterwards; restart the local API before re-running other suites.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { provision, uid, expectApiError, type Env } from "./harness.js";

let env: Env;
beforeAll(async () => { env = await provision("abuse"); });
afterAll(() => env.cleanup());

describe("abusive input (runs last)", () => {
  it("rejects dangerous / invalid paths and ids client-side or server-side without crashing", async () => {
    const db = env.secret(); const c = uid("c");
    for (const p of [`${c}/../x`, `${c}/%2e%2e`, `${c}/a/b`, `${c}//x`, ``, `${c}`, `${c}/__reserved__`]) {
      let threw = false;
      try { await db.doc(p).get(); } catch (e: any) { threw = true; expect(e).toBeInstanceOf(Error); }
      expect(threw, `path ${JSON.stringify(p)} should reject`).toBe(true);
    }
  });

  it("prototype pollution keys are neutralised", async () => {
    const db = env.secret(); const c = uid("c");
    const payload = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted2":true}},"ok":1}');
    try { await db.doc(`${c}/p`).create(payload); } catch { /* rejection is fine */ }
    expect(({} as any).polluted).toBeUndefined();
    expect(({} as any).polluted2).toBeUndefined();
    try {
      const d: any = (await db.doc(`${c}/p`).get()).data();
      expect(d.polluted).toBeUndefined();
      expect(Object.getPrototypeOf(d)?.polluted).toBeUndefined();
    } catch { /* not stored: fine */ }
  });
});
