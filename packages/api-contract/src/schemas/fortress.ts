/**
 * @vellum/api-contract - Security Fortress & Billing request schemas.
 *
 * Runtime validation for the locked HTTP endpoints in
 * `docs/SECURITY-BILLING-CONTRACT.md` §6. These are pure wire contracts:
 * authorization, persistence and hash-chain construction stay in the owning
 * packages (`@vellum/api`, `@vellum/database-control`, `@vellum/security`).
 *
 * All monetary values are integer cents. Unknown keys are rejected on mutation
 * bodies so a client cannot smuggle control-plane fields through a PATCH.
 */

import { z } from "zod";
import { CONTROL_CHAR_REGEX, createSafeRecordSchema } from "./safety.js";

/* -------------------------------------------------------------------------- */
/* Shared enums                                                               */
/* -------------------------------------------------------------------------- */

export const FortressPlanIdEnum = z.enum(["free", "pro", "enterprise"]);
export type FortressPlanId = z.infer<typeof FortressPlanIdEnum>;

export const SubscriptionStatusEnum = z.enum([
  "active",
  "past_due",
  "suspended",
  "canceled",
]);
export type SubscriptionStatus = z.infer<typeof SubscriptionStatusEnum>;

/** ISO-8601 timestamp, with an explicit `Z` or numeric offset required. */
const IsoTimestampSchema = z.string().datetime({ offset: true });

const SafeQuotaOverrideSchema = createSafeRecordSchema({
  maxDepth: 6,
  maxKeys: 50,
  maxArrayLength: 50,
  maxBytes: 16_384,
});

/* -------------------------------------------------------------------------- */
/* Customer console (§6.1)                                                    */
/* -------------------------------------------------------------------------- */

/** Owner-only plan switch / hard spend cap / billing contact update. */
export const SubscriptionPatchSchema = z
  .object({
    planId: FortressPlanIdEnum.optional(),
    monthlySpendCapCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    billingEmail: z.string().email().max(320).nullable().optional(),
  })
  .strict();
export type SubscriptionPatchRequest = z.infer<typeof SubscriptionPatchSchema>;

/** API-key Origin / IP / expiry restrictions. */
export const KeyRestrictionsSchema = z
  .object({
    allowedOrigins: z
      .array(
        z
          .string()
          .url()
          .max(2_048)
          .refine((val) => !CONTROL_CHAR_REGEX.test(val), "Origin contains invalid control characters")
      )
      .max(100)
      .optional(),
    allowedIps: z
      .array(
        z
          .string()
          .min(1)
          .max(64)
          .refine((val) => !CONTROL_CHAR_REGEX.test(val), "IP contains invalid control characters")
      )
      .max(100)
      .optional(),
    expiresAt: IsoTimestampSchema.nullable().optional(),
  })
  .strict();
export type KeyRestrictionsRequest = z.infer<typeof KeyRestrictionsSchema>;

/* -------------------------------------------------------------------------- */
/* Super admin (§6.2)                                                         */
/* -------------------------------------------------------------------------- */

export const BlocklistTargetTypeEnum = z.enum([
  "ip",
  "api_key_id",
  "org_id",
  "project_id",
]);
export type BlocklistTargetType = z.infer<typeof BlocklistTargetTypeEnum>;

export const BlocklistCreateSchema = z
  .object({
    targetType: BlocklistTargetTypeEnum,
    targetValue: z
      .string()
      .min(1)
      .max(512)
      .refine((val) => !CONTROL_CHAR_REGEX.test(val), "targetValue contains invalid control characters"),
    reason: z.string().min(1).max(1_000),
    expiresAt: IsoTimestampSchema.nullable().optional(),
  })
  .strict();
export type BlocklistCreateRequest = z.infer<typeof BlocklistCreateSchema>;

export const ThreatStatusPatchSchema = z
  .object({
    status: z.enum(["acknowledged", "resolved"]),
  })
  .strict();
export type ThreatStatusPatchRequest = z.infer<typeof ThreatStatusPatchSchema>;

/**
 * Super-admin organization override. An optional positive/negative integer
 * adjustment appends a hash-chained `admin_adjustment` ledger entry.
 */
export const OrgOverrideSchema = z
  .object({
    planId: FortressPlanIdEnum.optional(),
    status: SubscriptionStatusEnum.optional(),
    monthlySpendCapCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
    quotaOverride: SafeQuotaOverrideSchema.optional(),
    adjustmentAmountCents: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).optional(),
    adjustmentDescription: z.string().max(1_000).optional(),
  })
  .strict();
export type OrgOverrideRequest = z.infer<typeof OrgOverrideSchema>;

export const InvoiceGenerateSchema = z
  .object({
    billingMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "billingMonth must be YYYY-MM"),
  })
  .strict();
export type InvoiceGenerateRequest = z.infer<typeof InvoiceGenerateSchema>;

/** Verified Stripe event envelope; `data` is provider-owned and passed through. */
export const BillingWebhookSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.string().min(1).max(256),
    data: z.object({}).passthrough(),
  })
  .passthrough();
export type BillingWebhookEvent = z.infer<typeof BillingWebhookSchema>;
