/**
 * @vellum/security - Shared security domain types.
 *
 * Internal to this package: the threat taxonomy is consumed by the
 * payload/query guards and by the threat-detector module owned by the
 * security workstream. Keeping it here avoids a circular dependency between
 * the individual guard modules.
 */

export type ThreatCategory =
  | "brute_force"
  | "token_replay"
  | "prototype_pollution"
  | "query_exhaustion"
  | "ssrf_attempt"
  | "cross_tenant_probe"
  | "ws_flood"
  | "quota_abuse";
