/**
 * @vellum/observability - Request ID Generator
 */

import crypto from "node:crypto";

export function generateRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}
