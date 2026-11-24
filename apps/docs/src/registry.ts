/** Page registry. Content files live in src/pages/<lang>/<slug>.tsx. */
import { lazy, type ComponentType } from "react";

export type PageComponent = ComponentType;

const en: Record<string, PageComponent> = {
  "index": lazy(() => import("./pages/en/index")),
  "quickstart": lazy(() => import("./pages/en/quickstart")),
  "ai-agents": lazy(() => import("./pages/en/ai-agents")),
  "authentication": lazy(() => import("./pages/en/authentication")),
  "advanced": lazy(() => import("./pages/en/advanced")),
  "social-login": lazy(() => import("./pages/en/social-login")),
  "privacy": lazy(() => import("./pages/en/privacy")),
  "terms": lazy(() => import("./pages/en/terms")),
  "crud": lazy(() => import("./pages/en/crud")),
  "field-transforms": lazy(() => import("./pages/en/field-transforms")),
  "query": lazy(() => import("./pages/en/query")),
  "pagination": lazy(() => import("./pages/en/pagination")),
  "indexes": lazy(() => import("./pages/en/indexes")),
  "smart-indexing": lazy(() => import("./pages/en/smart-indexing")),
  "relationships": lazy(() => import("./pages/en/relationships")),
  "realtime": lazy(() => import("./pages/en/realtime")),
  "batch-and-transactions": lazy(() => import("./pages/en/batch-and-transactions")),
  "end-user-auth": lazy(() => import("./pages/en/end-user-auth")),
  "security-rules": lazy(() => import("./pages/en/security-rules")),
  "security-rules-dsl": lazy(() => import("./pages/en/security-rules-dsl")),
  "security-and-defense": lazy(() => import("./pages/en/security-and-defense")),
  "sdks/javascript": lazy(() => import("./pages/en/sdks/javascript")),
  "sdks/flutter": lazy(() => import("./pages/en/sdks/flutter")),
  "rest-api": lazy(() => import("./pages/en/rest-api")),
  "reference/rest-data-plane": lazy(() => import("./pages/en/reference/rest-data-plane")),
  "reference/realtime-protocol": lazy(() => import("./pages/en/reference/realtime-protocol")),
  "reference/wire-format": lazy(() => import("./pages/en/reference/wire-format")),
  "reference/errors": lazy(() => import("./pages/en/reference/errors")),
  "errors-and-limits": lazy(() => import("./pages/en/errors-and-limits")),
  "reference/packages": lazy(() => import("./pages/en/reference/packages")),
  "production-checklist": lazy(() => import("./pages/en/production-checklist")),
  "deployment": lazy(() => import("./pages/en/deployment")),
};

const ar: Record<string, PageComponent> = {
  "index": lazy(() => import("./pages/ar/index")),
  "quickstart": lazy(() => import("./pages/ar/quickstart")),
  "ai-agents": lazy(() => import("./pages/ar/ai-agents")),
  "authentication": lazy(() => import("./pages/ar/authentication")),
  "advanced": lazy(() => import("./pages/ar/advanced")),
  "social-login": lazy(() => import("./pages/ar/social-login")),
  "privacy": lazy(() => import("./pages/ar/privacy")),
  "terms": lazy(() => import("./pages/ar/terms")),
  "crud": lazy(() => import("./pages/ar/crud")),
  "field-transforms": lazy(() => import("./pages/ar/field-transforms")),
  "query": lazy(() => import("./pages/ar/query")),
  "pagination": lazy(() => import("./pages/ar/pagination")),
  "indexes": lazy(() => import("./pages/ar/indexes")),
  "smart-indexing": lazy(() => import("./pages/ar/smart-indexing")),
  "relationships": lazy(() => import("./pages/ar/relationships")),
  "realtime": lazy(() => import("./pages/ar/realtime")),
  "batch-and-transactions": lazy(() => import("./pages/ar/batch-and-transactions")),
  "end-user-auth": lazy(() => import("./pages/ar/end-user-auth")),
  "security-rules": lazy(() => import("./pages/ar/security-rules")),
  "security-rules-dsl": lazy(() => import("./pages/ar/security-rules-dsl")),
  "security-and-defense": lazy(() => import("./pages/ar/security-and-defense")),
  "sdks/javascript": lazy(() => import("./pages/ar/sdks/javascript")),
  "sdks/flutter": lazy(() => import("./pages/ar/sdks/flutter")),
  "rest-api": lazy(() => import("./pages/ar/rest-api")),
  "reference/rest-data-plane": lazy(() => import("./pages/ar/reference/rest-data-plane")),
  "reference/realtime-protocol": lazy(() => import("./pages/ar/reference/realtime-protocol")),
  "reference/wire-format": lazy(() => import("./pages/ar/reference/wire-format")),
  "reference/errors": lazy(() => import("./pages/ar/reference/errors")),
  "errors-and-limits": lazy(() => import("./pages/ar/errors-and-limits")),
  "reference/packages": lazy(() => import("./pages/ar/reference/packages")),
  "production-checklist": lazy(() => import("./pages/ar/production-checklist")),
  "deployment": lazy(() => import("./pages/ar/deployment")),
};

export const PAGES = { en, ar };

export function getPage(lang: "en" | "ar", slug: string): PageComponent | undefined {
  return (lang === "ar" ? ar : en)[slug];
}
