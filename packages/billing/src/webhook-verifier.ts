/**
 * `packages/billing/src/webhook-verifier.ts`
 *
 * Real Stripe-style signature verification: HMAC-SHA256 over `${t}.${rawBody}`,
 * constant-time comparison of `v1` values via `crypto.timingSafeEqual`, strict
 * 300 s timestamp tolerance in both directions, header size/signature count
 * caps, empty-secret rejection, and prototype-pollution guards on parsed JSON.
 * Replay idempotency remains the caller's job; `consumeWebhookEvent` performs
 * the single-use insert into the store.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { BillingRepository } from "@vellum/database-control";

const TOLERANCE_SECONDS = 300;
const MAX_HEADER_LENGTH = 4_096;
const MAX_SIGNATURES_PER_HEADER = 16;
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

export type WebhookVerificationResult =
  | { ok: true; eventId: string; eventType: string }
  | { ok: false; code: string };

export function verifyStripeWebhook(
  rawBody: string | Buffer,
  header: string | null | undefined,
  secret: string,
  nowMs: number = Date.now()
): WebhookVerificationResult {
  if (typeof header !== "string" || header.trim().length === 0) {
    return { ok: false, code: "MISSING_SIGNATURE_HEADER" };
  }
  if (header.length > MAX_HEADER_LENGTH) {
    return { ok: false, code: "INVALID_SIGNATURE" };
  }
  if (typeof secret !== "string" || secret.length === 0) {
    return { ok: false, code: "INVALID_SIGNATURE" };
  }
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    return { ok: false, code: "INVALID_SIGNATURE_TIMESTAMP" };
  }

  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t" && timestamp === null && /^\d{1,16}$/.test(value)) {
      timestamp = Number(value);
    } else if (key === "v1" && value.length > 0) {
      if (signatures.length >= MAX_SIGNATURES_PER_HEADER) {
        return { ok: false, code: "INVALID_SIGNATURE" };
      }
      signatures.push(value);
    }
  }

  if (timestamp === null || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return { ok: false, code: "INVALID_SIGNATURE_TIMESTAMP" };
  }
  if (signatures.length === 0) {
    return { ok: false, code: "MISSING_SIGNATURE" };
  }
  if (Math.abs(Math.floor(nowMs / 1000) - timestamp) > TOLERANCE_SECONDS) {
    return { ok: false, code: "SIGNATURE_TIMESTAMP_OUT_OF_TOLERANCE" };
  }

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`, "utf8")
    .update(rawBody)
    .digest();

  let signatureValid = false;
  for (const signature of signatures) {
    if (!HEX_SHA256.test(signature)) continue;
    const provided = Buffer.from(signature, "hex");
    if (provided.length !== expected.length) continue;
    if (timingSafeEqual(expected, provided)) {
      signatureValid = true;
    }
  }
  if (!signatureValid) return { ok: false, code: "INVALID_SIGNATURE" };

  const body = typeof rawBody === "string" ? rawBody : rawBody.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return { ok: false, code: "INVALID_JSON_BODY" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "INVALID_EVENT_PAYLOAD" };
  }
  for (const key of Object.getOwnPropertyNames(parsed)) {
    if (FORBIDDEN_KEYS.has(key)) {
      return { ok: false, code: "INVALID_EVENT_PAYLOAD" };
    }
  }
  const event = parsed as Record<string, unknown>;
  const eventId = Object.prototype.hasOwnProperty.call(event, "id") ? event["id"] : undefined;
  const eventType = Object.prototype.hasOwnProperty.call(event, "type") ? event["type"] : undefined;
  if (typeof eventId !== "string" || eventId.trim().length === 0 ||
      typeof eventType !== "string" || eventType.trim().length === 0) {
    return { ok: false, code: "INVALID_EVENT_PAYLOAD" };
  }
  return { ok: true, eventId, eventType };
}

/** Atomically consumes a verified event id; false means it was already seen or invalid. */
export async function consumeWebhookEvent(
  billing: BillingRepository,
  eventId: string,
  provider: string,
  eventType: string
): Promise<boolean> {
  if (
    typeof eventId !== "string" || eventId.trim().length === 0 ||
    typeof provider !== "string" || provider.trim().length === 0 ||
    typeof eventType !== "string" || eventType.trim().length === 0
  ) {
    return false;
  }
  return (await billing.recordWebhookEvent(eventId, provider, eventType)) === true;
}
