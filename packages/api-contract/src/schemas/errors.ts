/**
 * @vellum/api-contract - Error Schemas
 * Strictly matches Specification Section 11.2 and Canonical Error Codes.
 * Single source of truth derived directly from `@vellum/core`'s `ERROR_HTTP_STATUS`.
 */

import { z } from "zod";
import { ERROR_HTTP_STATUS, type ErrorCode } from "@vellum/core";

const CANONICAL_ERROR_CODES = Object.keys(ERROR_HTTP_STATUS) as [ErrorCode, ...ErrorCode[]];

export const ErrorCodeEnum = z.enum(CANONICAL_ERROR_CODES);

export type ErrorCodeType = z.infer<typeof ErrorCodeEnum>;

export const ApiErrorDetailSchema = z.record(z.unknown());

export const ApiErrorBodySchema = z.object({
  code: ErrorCodeEnum,
  message: z.string(),
  requestId: z.string().default("req_unknown"),
  details: ApiErrorDetailSchema.optional(),
});

export const ApiErrorSchema = z.object({
  error: ApiErrorBodySchema,
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
export type ApiErrorBody = z.infer<typeof ApiErrorBodySchema>;
