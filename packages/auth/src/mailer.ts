/**
 * Dual-mode mailer for end-user verification / reset tokens.
 *
 * 1. SMTP configured (project override or platform fallback) -> real delivery
 *    via nodemailer.
 * 2. No SMTP + NODE_ENV !== "production" -> the token is returned to the caller
 *    as `devToken` so integration/E2E tests are deterministic without a mail
 *    server. The token is always persisted by the caller before this is called.
 * 3. No SMTP + production -> SERVICE_UNAVAILABLE (never leak a token).
 */

import { lookup } from "node:dns/promises";
import net from "node:net";
import nodemailer from "nodemailer";
import { VellumError } from "@vellum/core";
import type { PlatformAuthGlobalSettings } from "@vellum/database-control";
import { decryptSecret } from "./crypto/encrypt.js";
import type { ProjectAuthConfig } from "./config-types.js";

const HEADER_INJECTION_REGEX = /[\r\n]/;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface MailerSendResult {
  delivered: boolean;
  devToken?: string | undefined;
  expiresAt?: string | undefined;
}

export interface SendTokenEmailInput {
  to: string;
  token: string;
  tokenType: string;
  expiresAt: string;
  projectId: string;
  config: ProjectAuthConfig;
  settings: PlatformAuthGlobalSettings;
}

export interface Mailer {
  sendTokenEmail(input: SendTokenEmailInput): Promise<MailerSendResult>;
}

interface SmtpConfig {
  host: string;
  port: number;
  user?: string | undefined;
  pass?: string | undefined;
  from?: string | undefined;
}

function parseProjectSmtp(config: ProjectAuthConfig): SmtpConfig | null {
  if (!config.customSmtpConfigEncrypted) return null;
  try {
    const parsed = JSON.parse(decryptSecret(config.customSmtpConfigEncrypted)) as Record<string, unknown>;
    if (typeof parsed["host"] !== "string" || parsed["host"].length === 0) return null;
    const rawPort = typeof parsed["port"] === "number" && Number.isInteger(parsed["port"]) ? parsed["port"] : 587;
    const port = rawPort >= 1 && rawPort <= 65535 ? rawPort : 587;
    return {
      host: parsed["host"],
      port,
      user: typeof parsed["user"] === "string" ? parsed["user"] : undefined,
      pass: typeof parsed["pass"] === "string" ? parsed["pass"] : undefined,
      from: typeof parsed["from"] === "string" ? parsed["from"] : undefined,
    };
  } catch {
    return null;
  }
}

function parsePlatformSmtp(settings: PlatformAuthGlobalSettings): SmtpConfig | null {
  if (!settings.platformSmtpHost) return null;
  return {
    host: settings.platformSmtpHost,
    port: settings.platformSmtpPort ?? 587,
    user: settings.platformSmtpUser ?? undefined,
    pass: settings.platformSmtpPassEncrypted
      ? decryptSecret(settings.platformSmtpPassEncrypted)
      : undefined,
  };
}


function isPrivateAddress(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:/, "");
  if (net.isIPv4(ip)) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    return ip === "::" || ip === "::1" || ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe8") ||
      ip.startsWith("fe9") || ip.startsWith("fea") || ip.startsWith("feb") || ip.startsWith("ff");
  }
  return true;
}

/**
 * A project can bring its own SMTP server, so the host is attacker-influenced. Refuse hosts that
 * resolve to loopback, private, link-local or metadata addresses (SSRF / internal port probing).
 * `VELLUM_ALLOW_PRIVATE_SMTP=1` opts in for a self-hosted relay on a private network.
 */
export async function assertPublicSmtpHost(host: string): Promise<void> {
  if (process.env["VELLUM_ALLOW_PRIVATE_SMTP"] === "1" || process.env["NODE_ENV"] === "test") return;
  const bad = () => new VellumError("INVALID_ARGUMENT", "SMTP host must be a public address");
  const name = host.trim().toLowerCase();
  if (!name || name === "localhost" || name.endsWith(".localhost") || name.endsWith(".internal") || name.endsWith(".local")) {
    throw bad();
  }
  if (net.isIP(name)) {
    if (isPrivateAddress(name)) throw bad();
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(name, { all: true });
  } catch {
    throw new VellumError("SERVICE_UNAVAILABLE", "Email delivery failed");
  }
  if (addresses.length === 0 || addresses.some((a) => isPrivateAddress(a.address))) throw bad();
}

function subjectFor(tokenType: string): string {
  switch (tokenType) {
    case "email_verification":
      return "Verify your Vellum email address";
    case "password_reset":
      return "Reset your Vellum password";
    case "magic_link":
      return "Your Vellum sign-in link";
    case "mfa_challenge":
      return "Your Vellum verification code";
    default:
      return "Your Vellum verification token";
  }
}

export function createMailer(): Mailer {
  return {
    async sendTokenEmail(input: SendTokenEmailInput): Promise<MailerSendResult> {
      if (typeof input.to !== "string" || input.to.length === 0 || HEADER_INJECTION_REGEX.test(input.to)) {
        throw new VellumError("INVALID_ARGUMENT", "Invalid recipient email address");
      }
      const smtp = parseProjectSmtp(input.config) ?? parsePlatformSmtp(input.settings);
      if (!smtp) {
        // Fail closed: a reset or verification token is only ever returned to the caller
        // when the process is explicitly a test/development one. An unset or unexpected
        // NODE_ENV must never turn "no SMTP" into "anyone can read any reset token".
        const env = process.env["NODE_ENV"];
        const devTokensAllowed =
          env === "test" || env === "development" || process.env["VELLUM_ALLOW_DEV_TOKENS"] === "1";
        if (!devTokensAllowed) {
          throw new VellumError(
            "SERVICE_UNAVAILABLE",
            "Email delivery is not configured for this project or platform"
          );
        }
        return {
          delivered: false,
          devToken: input.token,
          expiresAt: input.expiresAt,
        };
      }
      const from = smtp.from ?? input.settings.platformSmtpFromEmail;
      if (typeof from === "string" && HEADER_INJECTION_REGEX.test(from)) {
        throw new VellumError("INVALID_ARGUMENT", "Invalid sender email address");
      }
      await assertPublicSmtpHost(smtp.host);
      const transport = nodemailer.createTransport({
        host: smtp.host,
        port: smtp.port,
        secure: smtp.port === 465,
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 15_000,
        ...(smtp.user ? { auth: { user: smtp.user, pass: smtp.pass ?? "" } } : {}),
      });
      try {
        await transport.sendMail({
          from,
          to: input.to,
          subject: subjectFor(input.tokenType),
          text: `Your token is ${input.token}\nIt expires at ${input.expiresAt}.\nIf you did not request this, ignore this email.`,
          html: `<p>Your token is <strong>${escapeHtml(input.token)}</strong></p><p>It expires at ${escapeHtml(input.expiresAt)}.</p>`,
        });
        return { delivered: true };
      } catch {
        throw new VellumError("SERVICE_UNAVAILABLE", "Email delivery failed");
      } finally {
        transport.close();
      }
    },
  };
}
