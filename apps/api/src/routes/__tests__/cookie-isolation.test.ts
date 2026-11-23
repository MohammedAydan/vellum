import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createVellumPlatform } from "../../index.js";

function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function cookieRequest(url: string, cookie: string): Request {
  return new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: "{}",
  });
}

async function realmFixture() {
  const platform = createVellumPlatform();
  const consoleEmail = "cookie-console@example.com";
  const consolePassword = "Password123!";
  const signUp = await platform.fetch(
    jsonRequest("/v1/auth/sign-up/email", {
      email: consoleEmail,
      name: "Cookie Console",
      password: consolePassword,
    })
  );
  expect(signUp.status).toBe(201);
  const consoleSession = (await signUp.json()) as { refreshToken: string };

  const adminEmail = "cookie-admin@vellum.dev";
  const adminPassword = "Password123!";
  const setup = await platform.fetch(
    jsonRequest("/v1/admin/setup-owner", {
      name: "Cookie Owner",
      email: adminEmail,
      password: adminPassword,
    })
  );
  expect(setup.status).toBe(201);
  const adminSession = (await setup.json()) as { refreshToken: string };

  return { platform, consoleEmail, consolePassword, consoleSession, adminEmail, adminPassword, adminSession };
}

describe("@vellum/api - per-realm refresh cookie isolation", () => {
  it("console sign-in sets only vellum_console_rt with Path=/v1/console/auth", async () => {
    const { platform, consoleEmail, consolePassword } = await realmFixture();
    const signIn = await platform.fetch(
      jsonRequest("/v1/auth/sign-in/email", { email: consoleEmail, password: consolePassword })
    );
    expect(signIn.status).toBe(200);
    const setCookie = signIn.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("vellum_console_rt=");
    expect(setCookie).toContain("Path=/v1/console/auth");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("vellum_admin_rt=");
  });

  it("admin login sets only vellum_admin_rt with Path=/v1/admin/auth", async () => {
    const { platform, adminEmail, adminPassword } = await realmFixture();
    const login = await platform.fetch(
      jsonRequest("/v1/admin/login", { email: adminEmail, password: adminPassword })
    );
    expect(login.status).toBe(200);
    const setCookie = login.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("vellum_admin_rt=");
    expect(setCookie).toContain("Path=/v1/admin/auth");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).not.toContain("vellum_console_rt=");
  });

  it("each refresh endpoint accepts its own cookie and rejects the other realm's cookie", async () => {
    const { platform, consoleSession, adminSession } = await realmFixture();

    const consoleOwn = await platform.fetch(
      cookieRequest("/v1/console/auth/refresh", `vellum_console_rt=${consoleSession.refreshToken}`)
    );
    expect(consoleOwn.status).toBe(200);
    expect(consoleOwn.headers.get("set-cookie") ?? "").toContain("vellum_console_rt=");
    expect(consoleOwn.headers.get("set-cookie") ?? "").toContain("Path=/v1/console/auth");

    const adminOwn = await platform.fetch(
      cookieRequest("/v1/admin/auth/session/refresh", `vellum_admin_rt=${adminSession.refreshToken}`)
    );
    expect(adminOwn.status).toBe(200);
    expect(adminOwn.headers.get("set-cookie") ?? "").toContain("vellum_admin_rt=");
    expect(adminOwn.headers.get("set-cookie") ?? "").toContain("Path=/v1/admin/auth");

    const consoleWithAdminCookie = await platform.fetch(
      cookieRequest("/v1/console/auth/refresh", `vellum_admin_rt=${adminSession.refreshToken}`)
    );
    expect(consoleWithAdminCookie.status).toBe(401);

    const adminWithConsoleCookie = await platform.fetch(
      cookieRequest("/v1/admin/auth/session/refresh", `vellum_console_rt=${consoleSession.refreshToken}`)
    );
    expect(adminWithConsoleCookie.status).toBe(401);
  });
});

describe("storage key prefix isolation (source-level)", () => {
  const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

  function collectSourceFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      // Tests that assert isolation are allowed to mention the other prefix.
      if (entry.isDirectory() && entry.name === "__tests__") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectSourceFiles(full));
      } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".test.ts")) {
        files.push(full);
      }
    }
    return files;
  }

  it("dashboard source never references the super-admin storage prefix", () => {
    const files = collectSourceFiles(path.join(repoRoot, "apps/dashboard/src"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, "utf8"), `${file} must not reference vellum_super_admin_`).not.toContain(
        "vellum_super_admin_"
      );
    }
  });

  it("admin source never references the console storage prefix", () => {
    const files = collectSourceFiles(path.join(repoRoot, "apps/admin/src"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, "utf8"), `${file} must not reference vellum_console_`).not.toContain(
        "vellum_console_"
      );
    }
  });
});
