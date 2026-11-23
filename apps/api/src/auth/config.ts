/**
 * @vellum/api - Better Auth Configuration
 * Configures platform authentication, sessions, and organizations.
 */

import { betterAuth } from "better-auth";
import { organization } from "better-auth/plugins";

export const authSecret = process.env["BETTER_AUTH_SECRET"] ?? "vellum_auth_secret_32bytes_dev_placeholder";

export function createBetterAuth() {
  return betterAuth({
    secret: authSecret,
    baseURL: process.env["BETTER_AUTH_URL"] ?? "http://localhost:8080",
    basePath: "/v1/auth",
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: true,
      }),
    ],
  });
}

export type BetterAuthInstance = ReturnType<typeof createBetterAuth>;
