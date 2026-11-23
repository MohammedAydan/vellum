/**
 * @vellum/api-contract - System Limits & Validation Rules
 * Strictly enforces quotas from Specification Section 2.3 and AGENTS.md Section 4.
 */

import { z } from "zod";
import { SYSTEM_LIMITS, parseDocumentPath, parseCollectionPath } from "@vellum/core";
import { FORBIDDEN_OBJECT_KEYS } from "./safety.js";

const MAX_PATH_LENGTH = 2_048;

export const DocumentPathSchema = z
  .string()
  .max(MAX_PATH_LENGTH, `Document path exceeds ${MAX_PATH_LENGTH} chars`)
  .superRefine((val, ctx) => {
    if (val.includes("\u0000")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Document path cannot contain NUL bytes",
      });
      return;
    }
    try {
      parseDocumentPath(val);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : "Invalid document path",
      });
    }
  });

export const CollectionPathSchema = z
  .string()
  .max(MAX_PATH_LENGTH, `Collection path exceeds ${MAX_PATH_LENGTH} chars`)
  .superRefine((val, ctx) => {
    if (val.includes("\u0000")) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Collection path cannot contain NUL bytes",
      });
      return;
    }
    try {
      parseCollectionPath(val);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : "Invalid collection path",
      });
    }
  });

export const FieldNameSchema = z
  .string()
  .min(1, "Field name cannot be empty")
  .max(SYSTEM_LIMITS.MAX_FIELD_NAME_LENGTH, `Field name exceeds ${SYSTEM_LIMITS.MAX_FIELD_NAME_LENGTH} chars`)
  .refine((val) => !val.includes("\u0000"), "Field name cannot contain NUL bytes")
  .refine(
    (val) => !val.split(".").some((seg) => FORBIDDEN_OBJECT_KEYS.has(seg)),
    "Field name cannot contain forbidden prototype-pollution segments"
  );

export const BatchSizeSchema = z
  .number()
  .int()
  .min(1)
  .max(SYSTEM_LIMITS.MAX_BATCH_OPERATIONS);

export const QueryLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(SYSTEM_LIMITS.MAX_QUERY_LIMIT)
  .default(SYSTEM_LIMITS.DEFAULT_QUERY_LIMIT);
