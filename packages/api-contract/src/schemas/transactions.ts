/**
 * @vellum/api-contract - Batch & Transaction Schemas
 * Strictly matches Specification Section 8 and System Limits Section 2.3.
 */

import { z } from "zod";
import { SYSTEM_LIMITS } from "@vellum/core";
import { DocumentPathSchema } from "./limits.js";
import { DocumentDataSchema, DocumentPreconditionSchema } from "./documents.js";

const MAX_READ_SET_ENTRIES = SYSTEM_LIMITS.MAX_BATCH_OPERATIONS * 5;
const MAX_TRANSACTION_TOKEN_LENGTH = 4_096;

export const MutationTypeEnum = z.enum(["create", "set", "update", "delete"]);
export type MutationType = z.infer<typeof MutationTypeEnum>;

export const BatchOperationSchema = z
  .object({
    type: MutationTypeEnum,
    path: DocumentPathSchema,
    data: DocumentDataSchema.optional(),
    options: z.object({ merge: z.boolean().optional() }).optional(),
    precondition: DocumentPreconditionSchema.optional(),
  })
  .superRefine((op, ctx) => {
    if ((op.type === "create" || op.type === "set" || op.type === "update") && !op.data) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Mutation type '${op.type}' requires 'data'`,
      });
    }
  });

export type BatchOperation = z.infer<typeof BatchOperationSchema>;

export const BatchWriteSchema = z.object({
  operations: z
    .array(BatchOperationSchema)
    .min(1, "Batch must contain at least 1 operation")
    .max(SYSTEM_LIMITS.MAX_BATCH_OPERATIONS, `Batch exceeds maximum of ${SYSTEM_LIMITS.MAX_BATCH_OPERATIONS} operations`),
});

export type BatchWrite = z.infer<typeof BatchWriteSchema>;

export const BatchWriteResponseSchema = z.object({
  results: z.array(
    z.object({
      path: z.string(),
      version: z.number().int().min(1),
      updatedAt: z.string(),
    })
  ),
  commitTimestamp: z.string(),
});

export const BeginTransactionSchema = z.object({
  readOnly: z.boolean().optional().default(false),
});

export type BeginTransaction = z.infer<typeof BeginTransactionSchema>;

export const BeginTransactionResponseSchema = z.object({
  transactionToken: z.string(),
  expiresAt: z.string(),
});

export const ReadSetEntrySchema = z.object({
  path: DocumentPathSchema,
  readVersion: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});

export const CommitTransactionSchema = z.object({
  transactionToken: z
    .string()
    .min(1, "transactionToken is required")
    .max(MAX_TRANSACTION_TOKEN_LENGTH, "transactionToken exceeds maximum length"),
  mutations: z
    .array(BatchOperationSchema)
    .max(SYSTEM_LIMITS.MAX_BATCH_OPERATIONS, `Mutations exceed maximum of ${SYSTEM_LIMITS.MAX_BATCH_OPERATIONS}`),
  reads: z
    .array(ReadSetEntrySchema)
    .max(MAX_READ_SET_ENTRIES, `Read set exceeds maximum of ${MAX_READ_SET_ENTRIES} entries`)
    .optional()
    .default([]),
});

export type CommitTransaction = z.infer<typeof CommitTransactionSchema>;

export const CommitTransactionResponseSchema = z.object({
  results: z.array(
    z.object({
      path: z.string(),
      version: z.number().int().min(1),
      updatedAt: z.string(),
    })
  ),
  commitTimestamp: z.string(),
});
