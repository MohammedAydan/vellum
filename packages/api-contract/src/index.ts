/**
 * @vellum/api-contract - Public API Contracts, Zod Runtime Schemas, WebSocket Frames,
 * and OpenAPI 3.1 Specification Generator.
 */

import { VellumError } from "@vellum/core";
import { QueryOperatorEnum } from "./schemas/queries.js";
import { ClientFrameSchema, type ClientFrame } from "./schemas/realtime.js";
import { validateSafePayload } from "./schemas/safety.js";

export * from "./schemas/errors.js";
export * from "./schemas/limits.js";
export * from "./schemas/documents.js";
export * from "./schemas/collections.js";
export * from "./schemas/queries.js";
export * from "./schemas/v2.js";
export * from "./schemas/transactions.js";
export * from "./schemas/realtime.js";
export * from "./schemas/control-plane.js";
export * from "./schemas/auth.js";
export * from "./schemas/fortress.js";
export * from "./openapi.js";

const WS_FRAME_SAFETY_BOUNDS = {
  maxDepth: 16,
  maxKeys: 200,
  maxArrayLength: 100,
  maxBytes: 65_536,
} as const;

// Backward-compatible validation helpers
export const VALID_QUERY_OPERATORS: ReadonlySet<string> = new Set<string>(QueryOperatorEnum.options);

export function validateClientWsFrame(frame: unknown): ClientFrame {
  const safety = validateSafePayload(frame, WS_FRAME_SAFETY_BOUNDS);
  if (!safety.ok) {
    throw new VellumError("INVALID_ARGUMENT", safety.message);
  }
  const result = ClientFrameSchema.safeParse(frame);
  if (!result.success) {
    const firstIssue = (result as Extract<typeof result, { success: false }>).error.issues[0];
    const message = firstIssue ? firstIssue.message : "Invalid WebSocket client frame";
    throw new VellumError("INVALID_ARGUMENT", message, { issues: (result as Extract<typeof result, { success: false }>).error.issues });
  }
  return result.data;
}
