/**
 * @vellum/api-contract - WebSocket Realtime Protocol Frames
 * Strictly matches Specification Section 9.2 and Section 9.4.
 */

import { z } from "zod";
import { DocumentPathSchema } from "./limits.js";
import { IncludeSpecSchema, QuerySpecSchema } from "./queries.js";
import { DocumentPayloadSchema } from "./documents.js";
import { ErrorCodeEnum } from "./errors.js";
import { CONTROL_CHAR_REGEX } from "./safety.js";

const SafeWsIdSchema = (label: string, maxLen: number) =>
  z
    .string()
    .min(1, `${label} is required`)
    .max(maxLen, `${label} exceeds ${maxLen} chars`)
    .refine((val) => !CONTROL_CHAR_REGEX.test(val), `${label} contains invalid control characters`);

// Client -> Server Frames
export const ClientAuthFrameSchema = z.object({
  type: z.literal("auth"),
  projectId: SafeWsIdSchema("projectId", 256),
  apiKey: SafeWsIdSchema("apiKey", 512),
  authToken: z.string().max(16_384).nullable().optional(),
});

export const ClientSubscribeFrameSchema = z.object({
  type: z.literal("subscribe"),
  subId: SafeWsIdSchema("subId", 128),
  path: DocumentPathSchema.optional(),
  query: QuerySpecSchema.optional(),
  resolveIncludes: z.boolean().optional(),
  include: z.array(IncludeSpecSchema).max(10).optional(),
  resumeSeqId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
});

export const ClientUnsubscribeFrameSchema = z.object({
  type: z.literal("unsubscribe"),
  subId: SafeWsIdSchema("subId", 128),
});

export const ClientPingFrameSchema = z.object({
  type: z.literal("ping"),
  ts: z.number().finite(),
});

export const ClientFrameSchema = z
  .discriminatedUnion("type", [
    ClientAuthFrameSchema,
    ClientSubscribeFrameSchema,
    ClientUnsubscribeFrameSchema,
    ClientPingFrameSchema,
  ])
  .superRefine((frame, ctx) => {
    if (frame.type === "subscribe" && !frame.path && !frame.query) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "subscribe frame requires either 'path' or 'query'",
      });
    }
  });

export type ClientFrame = z.infer<typeof ClientFrameSchema>;

// Server -> Client Frames
export const ServerAuthAckFrameSchema = z.object({
  type: z.literal("auth_ack"),
  status: z.literal("authenticated"),
  connectionId: z.string(),
});

export const ServerInitialSyncFrameSchema = z.object({
  type: z.literal("initial_sync"),
  subId: z.string(),
  seqId: z.number().int().nonnegative(),
  documents: z.array(DocumentPayloadSchema),
});

export const ServerMutationFrameSchema = z.object({
  type: z.literal("mutation"),
  subId: z.string(),
  seqId: z.number().int().nonnegative(),
  operation: z.enum(["create", "update", "delete"]),
  document: DocumentPayloadSchema,
});

export const ServerErrorFrameSchema = z.object({
  type: z.literal("error"),
  subId: z.string().optional(),
  code: ErrorCodeEnum,
  message: z.string(),
  /** Set with SUBSCRIPTION_LIMIT_EXCEEDED: the per-connection subscription limit. */
  limit: z.number().int().positive().optional(),
});

export const ServerPongFrameSchema = z.object({
  type: z.literal("pong"),
  ts: z.number().finite(),
  serverTs: z.number().finite(),
});

/** Confirmation sent after a `resumeSeqId` replay finishes (additive v1 frame). */
export const ServerResumeCompleteFrameSchema = z.object({
  type: z.literal("resume_complete"),
  subId: z.string(),
  seqId: z.string(),
  count: z.number().int().nonnegative(),
  truncated: z.boolean(),
});

export type ResumeCompleteFrame = z.infer<typeof ServerResumeCompleteFrameSchema>;

export const ServerFrameSchema = z.discriminatedUnion("type", [
  ServerAuthAckFrameSchema,
  ServerInitialSyncFrameSchema,
  ServerMutationFrameSchema,
  ServerErrorFrameSchema,
  ServerPongFrameSchema,
  ServerResumeCompleteFrameSchema,
]);

export type ServerFrame = z.infer<typeof ServerFrameSchema>;
