export type Lang = "en" | "ar";

export interface Localized {
  en: string;
  ar: string;
}

export interface PageMeta {
  slug: string;
  title: Localized;
  desc: Localized;
  keywords?: string[];
}

export interface NavGroup {
  title: Localized;
  items: PageMeta[];
}

const t = (en: string, ar: string): Localized => ({ en, ar });

export const NAV_GROUPS: NavGroup[] = [
  {
    title: t("Get started", "البداية"),
    items: [
      { slug: "index", title: t("Introduction", "مقدمة"), desc: t("What VELLUM is, how its two PostgreSQL data planes fit together, and where to begin.", "ما هو VELLUM، وكيف تتكامل قاعدتا البيانات الخاصتان بـ PostgreSQL، ومن أين تبدأ."), keywords: ["overview", "architecture", "postgres", "jsonb"] },
      { slug: "quickstart", title: t("Quickstart", "البدء السريع"), desc: t("Install the SDK, create a client and perform your first write, read and delete.", "ثبّت الحزمة البرمجية، أنشئ عميلًا، ونفّذ أول كتابة وقراءة وحذف."), keywords: ["install", "setup", "first write"] },
      { slug: "ai-agents", title: t("Use with AI agents", "الاستخدام مع وكلاء الذكاء الاصطناعي"), desc: t("A ready prompt, llms.txt and Markdown versions of every page for AI coding assistants.", "تعليمات جاهزة وملف llms.txt ونسخ Markdown لكل صفحة لمساعدي البرمجة بالذكاء الاصطناعي."), keywords: ["ai", "llm", "llms.txt", "markdown", "prompt", "agents", "chatgpt", "claude"] },
      { slug: "advanced", title: t("Advanced configuration", "الإعدادات المتقدمة"), desc: t("Optional settings: auto-ids, auth tokens, secure storage, cache policy, references and realtime transport.", "إعدادات اختيارية: المعرفات التلقائية، ورموز المصادقة، والتخزين الآمن، وسياسة الكاش، والمراجع ونقل الوقت الفعلي."), keywords: ["doc", "auto id", "cachePolicy", "setCustomToken", "secure storage", "addWithRelated", "sse"] },
      { slug: "authentication", title: t("Authentication", "المصادقة"), desc: t("API keys, end-user tokens, key rotation and least-privilege access.", "مفاتيح API، ورموز المستخدمين النهائيين، وتدوير المفاتيح، وأقل قدر من الامتيازات."), keywords: ["api key", "token", "session"] },
    ],
  },
  {
    title: t("Core concepts", "المفاهيم الأساسية"),
    items: [
      { slug: "crud", title: t("CRUD & document paths", "CRUD ومسارات المستندات"), desc: t("Canonical paths, references, create/set/update/delete, ifVersion and merge semantics.", "المسارات القياسية، والمراجع، وcreate/set/update/delete، وifVersion ودلالات الدمج."), keywords: ["set", "update", "delete", "path"] },
      { slug: "field-transforms", title: t("Field transforms", "تحويلات الحقول"), desc: t("Every atomic fieldOp sentinel, how it is applied, its ordering and its limits.", "كل رموز fieldOp الذرية، وكيفية تطبيقها وترتيبها وقيودها."), keywords: ["increment", "arrayUnion", "fieldOp"] },
      { slug: "query", title: t("Query", "الاستعلام"), desc: t("Filters, ordering, projection, limits, index requirements, SQL compilation and response shape.", "المرشحات والترتيب والإسقاط والحدود ومتطلبات الفهارس وتجميع SQL وشكل الاستجابة."), keywords: ["where", "orderBy", "filter"] },
      { slug: "pagination", title: t("Pagination", "الترقيم الصفحي"), desc: t("HMAC-signed opaque cursors, startAt vs startAfter, and the document_id tie-breaker.", "مؤشرات معتمة موقّعة بـ HMAC، وstartAt مقابل startAfter، وفاصل حسم بمعرّف المستند."), keywords: ["cursor", "startAfter", "OFFSET"] },
      { slug: "indexes", title: t("Composite indexes", "الفهارس المركّبة"), desc: t("Tenant indexes as rows, order-preserving sort keys, creation, status and when one is required.", "فهارس المستأجرين كصفوف، ومفاتيح فرز تحافظ على الترتيب، والإنشاء والحالة ومتى يُطلب فهرس."), keywords: ["index", "sort key", "BYTEA"] },
      { slug: "smart-indexing", title: t("Smart indexing & performance", "الفهرسة الذكية والأداء"), desc: t("The E/S/R index advisor, fingerprints and deep links, SDK warnings, bounded caches and the Zero-Redis doctrine.", "مستشار الفهارس E/S/R، والبصمات والروابط المباشرة، وتحذيرات الحزم البرمجية، والذاكرة المؤقتة المحدودة ونهج بلا Redis."), keywords: ["advisor", "ESR", "fingerprint", "cache", "performance"] },
      { slug: "relationships", title: t("Relationships & advanced queries", "العلاقات والاستعلامات المتقدمة"), desc: t("Eager-loaded $ref relations, onDelete actions, aggregations, or groups, text operators, upsert, deleteWhere and TTL.", "علاقات $ref المحمّلة مسبقًا، وإجراءات onDelete، والتجميع، ومجموعات or، وعوامل النص، وupsert وdeleteWhere وTTL."), keywords: ["include", "$ref", "referencedBy", "aggregate", "groupBy", "upsert", "TTL"] },
      { slug: "realtime", title: t("Realtime", "الوقت الفعلي"), desc: t("LISTEN/NOTIFY with a durable outbox, resume watermarks, gap detection and live snapshots.", "LISTEN/NOTIFY مع صندوق بريد دائم، وعلامات الاستئناف وكشف الفجوات واللقطات الحية."), keywords: ["websocket", "listen", "notify", "outbox"] },
      { slug: "batch-and-transactions", title: t("Batch writes & transactions", "الكتابات الدفعية والمعاملات"), desc: t("batchWrite limits and failure semantics, and OCC transactions with FOR UPDATE locking.", "حدود batchWrite ودلالات الفشل، ومعاملات OCC مع قفل FOR UPDATE."), keywords: ["batch", "transaction", "OCC"] },
    ],
  },
  {
    title: t("Authentication", "المصادقة"),
    items: [
      { slug: "end-user-auth", title: t("End-user authentication", "مصادقة المستخدمين النهائيين"), desc: t("EdDSA-only end-user tokens, refresh rotation, MFA and the exact auth REST paths.", "رموز EdDSA حصراً للمستخدمين النهائيين، وتدوير الرموز، وMFA، ومسارات المصادقة الدقيقة."), keywords: ["EdDSA", "JWT", "refresh", "mfa"] },
      { slug: "social-login", title: t("Social sign-in", "تسجيل الدخول الاجتماعي"), desc: t("Sign in with Google, GitHub or Apple on the web and in Flutter: popup, redirect, native Google and Apple, and security notes.", "تسجيل الدخول بحساب Google أو GitHub أو Apple على الويب وفي Flutter: نافذة منبثقة وإعادة توجيه وGoogle وApple الأصليان وملاحظات أمنية."), keywords: ["google", "github", "apple", "oauth", "social", "popup", "redirect", "google_sign_in"] },
    ],
  },
  {
    title: t("Security", "الأمان"),
    items: [
      { slug: "security-rules", title: t("Security rules", "قواعد الأمان"), desc: t("The v1 JSON rules AST, deterministic deny-by-default evaluation, validation and publishing.", "شجرة قواعد v1 بصيغة JSON، والتقييم الحتمي بالرفض الافتراضي، والتحقق والنشر."), keywords: ["rules", "AST", "deny by default"] },
      { slug: "security-rules-dsl", title: t("Security Rules DSL", "لغة قواعد الأمان"), desc: t("The readable rules language: macros, functions, compile/decompile/simulate and exact diagnostics.", "لغة القواعد المقروءة: الماكروهات والدوال، والتجميع والتفكيك والمحاكاة والتشخيص الدقيق."), keywords: ["DSL", "macros", "rules_version", "simulate", "diagnostics"] },
      { slug: "security-and-defense", title: t("Security & defense in depth", "الأمان والدفاع المتعدد الطبقات"), desc: t("Threat model, payload and query-cost guards, WS hardening, SSRF and API-key restrictions.", "نموذج التهديدات، وحاجز الحمولة وتكلفة الاستعلام، وتأمين WebSocket، والحماية من SSRF، وقيود المفاتيح."), keywords: ["threat model", "payload guard", "SSRF", "blocklist"] },
    ],
  },
  {
    title: t("SDKs", "المجموعات البرمجية"),
    items: [
      { slug: "sdks/javascript", title: t("JavaScript / TypeScript", "JavaScript / TypeScript"), desc: t("Exported symbols of @vellumdb/sdk-js — client, references, queries, auth and realtime.", "الرموز المُصدَّرة في @vellumdb/sdk-js — العميل، والمراجع، والاستعلام والمصادقة والوقت الفعلي."), keywords: ["npm", "typescript", "sdk"] },
      { slug: "sdks/flutter", title: t("Flutter / Dart", "Flutter / Dart"), desc: t("Using vellum_flutter — client setup, CRUD, queries, pagination, realtime and auth.", "استخدام vellum_flutter — إعداد العميل، CRUD، الاستعلام، الترقيم والوقت الفعلي والمصادقة."), keywords: ["dart", "flutter", "sdk"] },
    ],
  },
  {
    title: t("Reference", "المرجع"),
    items: [
      { slug: "rest-api", title: t("REST API orientation", "نظرة عامة على REST API"), desc: t("A short map of the /v1 HTTP endpoint families, with links to the full reference.", "خريطة مختصرة لعائلات نقاط نهاية HTTP أسفل /v1، مع روابط إلى المرجع الكامل."), keywords: ["http", "endpoints"] },
      { slug: "reference/rest-data-plane", title: t("Data plane REST API", "واجهة REST لمستوى البيانات"), desc: t("API-key-only document CRUD, query, batchWrite, OCC transactions and indexes.", "عمليات مستندات بمفتاح API فقط: CRUD والاستعلام وbatchWrite والمعاملات والفهارس."), keywords: ["data plane", "http", "documents"] },
      { slug: "reference/realtime-protocol", title: t("Realtime WebSocket protocol", "بروتوكول WebSocket للوقت الفعلي"), desc: t("Canonical frames, auth handshake, subscribe/resume, watermarks and gap detection.", "الإطارات المعيارية، ومصافحة المصادقة، والاشتراك والاستئناف، والعلامات المائية وكشف الفجوات."), keywords: ["frames", "ws", "protocol"] },
      { slug: "reference/wire-format", title: t("Wire format & paths", "تنسيق الإرسال والمسارات"), desc: t("Canonical $t/$v tagged types, $op transforms, path grammar and the locked v1 limits.", "الأنواع الموسومة $t/$v، وتحويلات $op، وقواعد المسارات والحدود الثابتة للإصدار 1."), keywords: ["wire", "tag", "path"] },
      { slug: "reference/errors", title: t("Error codes & retry guidance", "رموز الأخطاء وإرشادات إعادة المحاولة"), desc: t("Every canonical code, its HTTP status, when it occurs and whether retry is safe.", "كل رمز معياري، وحالته HTTP، ومتى يحدث، وما إذا كانت إعادة المحاولة آمنة."), keywords: ["errors", "retry", "status"] },
      { slug: "errors-and-limits", title: t("Quotas & limits", "الحصص والحدود"), desc: t("Locked v1 quotas enforced by @vellum/core, with the exact error for each breach.", "الحصص الثابتة للإصدار 1 التي يفرضها @vellum/core، والخطأ المطابق لتجاوز كل منها."), keywords: ["limits", "quota", "1MiB"] },
      { slug: "reference/packages", title: t("Package APIs", "واجهات الحزم البرمجية"), desc: t("Package-by-package API surface for the framework-agnostic @vellum/* libraries.", "الواجهة البرمجية لكل حزمة على حدة لمكتبات @vellum/* المستقلة عن الأطر."), keywords: ["packages", "monorepo"] },
    ],
  },
  {
    title: t("Legal", "قانوني"),
    items: [
      { slug: "privacy", title: t("Privacy Policy", "سياسة الخصوصية"), desc: t("What data VELLUM collects, how it is stored and protected, and that it is never sold or shared.", "ما البيانات التي يجمعها VELLUM، وكيف تُخزَّن وتُحمى، وأنها لا تُباع ولا تُشارك."), keywords: ["privacy", "data", "gdpr"] },
      { slug: "terms", title: t("Terms of Service", "شروط الاستخدام"), desc: t("Acceptable use, technical limits, intellectual property, and the Alpha notice and disclaimer.", "الاستخدام المقبول، والحدود التقنية، والملكية الفكرية، وإشعار ألفا وإخلاء المسؤولية."), keywords: ["terms", "alpha", "disclaimer", "AS IS"] },
    ],
  },
  {
    title: t("Operations", "التشغيل"),
    items: [
      { slug: "production-checklist", title: t("Production checklist", "قائمة التحقق للإنتاج"), desc: t("Deployment, health probes, migrations, RLS, redaction, backups and known caveats.", "النشر، وفحوص الصحة، والترحيلات، وRLS، والإخفاء، والنسخ الاحتياطي والتحذيرات المعروفة."), keywords: ["production", "rls", "backup"] },
      { slug: "deployment", title: t("Deployment & hosting", "النشر والاستضافة"), desc: t("Unified single-origin frontend, local dev, Vercel, Cloudflare, Docker and Caddy.", "الواجهة الموحدة بمصدر واحد، والتطوير المحلي، وVercel وCloudflare وDocker وCaddy."), keywords: ["deploy", "hosting", "gateway"] },
    ],
  },
];

export const ALL_PAGES: PageMeta[] = NAV_GROUPS.flatMap((group) => group.items);
export const PAGE_BY_SLUG = new Map(ALL_PAGES.map((page) => [page.slug, page]));

export function pageHref(slug: string, lang: Lang): string {
  // Vitest/CI leaves Vite's BASE_URL at "/" while the deployed docs app is
  // mounted at "/docs/". Normalise both so canonical links are identical in
  // tests and in production (the previous code emitted "/query/" in CI).
  const configured = import.meta.env.BASE_URL || "/docs/";
  const base = configured === "/" ? "/docs/" : configured.replace(/\/*$/, "/");
  const prefix = lang === "ar" ? "ar/" : "";
  return `${base}${prefix}${slug}/`;
}

export function neighbors(slug: string): { prev?: PageMeta; next?: PageMeta } {
  const i = ALL_PAGES.findIndex((p) => p.slug === slug);
  return {
    prev: i > 0 ? ALL_PAGES[i - 1] : undefined,
    next: i >= 0 && i < ALL_PAGES.length - 1 ? ALL_PAGES[i + 1] : undefined,
  };
}
