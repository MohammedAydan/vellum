---
title: واجهة REST لمستوى التحكم والكونسول
order: 1
group: المرجع
description: مرجع تفصيلي لكل نقطة نهاية على حدة: المصادقة، المؤسسات، المشاريع، البيئات، المفاتيح، مجموعات القواعد، الفهارس، المستندات، الاستعلام، المعاملات، الاستخدام، التدقيق ومسارات الإدارة.
---

# واجهة REST لمستوى التحكم والكونسول

هذه الصفحة هي المرجع المعتمد لكل مسار مُركّب تحت `/v1` **باستثناء** مستوى المستندات العام (راجع [مستوى البيانات عبر REST](./rest-data-plane.md)) وبروتوكول WebSocket (راجع [بروتوكول الوقت الفعلي](./realtime-protocol.md)).

المصدر المعتمد: `apps/api/src/routes/{auth-endpoints,mfa,control-plane,console,admin,usage,health}.ts` و`apps/api/src/app.ts` ومخططات Zod في `packages/api-contract/src/schemas/*`. جميع نقاط النهاية مُركّبة عبر `app.route("/v1", …)` في `apps/api/src/app.ts`.

:::note
كل استجابة تحمل الترويسة `X-Request-Id`. وتستخدم أجسام الأخطاء دائمًا المغلّف المعياري `{ "error": { "code", "message", "requestId", "details"? } }` — راجع [الأخطاء](./errors.md).
:::

## مخططات المصادقة

| المخطط | الترويسة | جهة الاستخدام | المعنى |
| :--- | :--- | :--- | :--- |
| لا شيء (عام) | — | التسجيل، تسجيل الدخول، الإعداد، الدخول، الفحص الصحي، OpenAPI | لا يلزم رمز مميز |
| جلسة اختيارية | `Authorization: Bearer <access JWT>` | مسارات مستوى التحكم القديمة `/v1/organizations` و`/v1/projects/...` | يمكن استدعاؤها دون جلسة، لكن **أي رمز مُقدَّم يجب أن يكون صالحًا** (الفشل آمن). مُنفَّذة عبر `optionalSession`. |
| جلسة | `Authorization: Bearer <access JWT>` | `/v1/console/**`، `/v1/auth/mfa/**`، `/v1/**/usage` | الرمز المفقود أو المشوّه أو منتهي الصلاحية أو المُلغى → `401 UNAUTHENTICATED` |
| جلسة مشغّل | `Authorization: Bearer <access JWT>` | `/v1/admin/**` | جلسة يكون دورها `owner` أو `admin` أو `support_readonly` (للقراءة فقط) |

أدوار الكونسول المقبولة: `customer` و`owner` و`admin` و`support_readonly` (`CONSOLE_ROLES`). أدوار قراءة المشغّل: `owner` و`admin` و`support_readonly` و`customer` للاستخدام؛ أما واجهة الإدارة فتستخدم `owner` و`admin` و`support_readonly`. أدوار كتابة المشغّل: `owner` و`admin`.

الرموز المميزة هي رموز وصول جلسة HS256 صادرة عن `SessionService` المشتركة (`signAccess`)، بمدة حياة تضبطها تلك الخدمة (تُبلّغ استجابتا تسجيل الدخول والإعداد للإدارة عن `expiresAt` بعد 15 دقيقة؛ وتُبلّغ استجابتا تسجيل مستخدم جديد وتسجيل الدخول بعد 7 أيام).

---

## 1. المصادقة (`auth-endpoints.ts`)

| الطريقة | المسار | المصادقة | جسم الطلب | استجابة النجاح | الأخطاء |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `POST` | `/v1/auth/sign-up/email` | لا شيء | `{ email, name, password }` (`password` ≥ 6 أحرف، `name` ≥ 2) | `201{ success, user:{id,name,email,platformRole}, token, organization, project, apiKey:{id,keyPrefix}\|null, expiresAt }` | `INVALID_ARGUMENT`، `ALREADY_EXISTS` |
| `POST` | `/v1/auth/sign-in/email` | لا شيء | `{ email, password }` | `200{ success, user:{id,name,email,platformRole}, token, expiresAt }` | `INVALID_ARGUMENT`، `UNAUTHENTICATED`، `PERMISSION_DENIED` (موقوف) |
| `GET` | `/v1/auth/session` | Bearer (يتحقق من الرمز) | — | `{ session: null }` عند غياب ترويسة `Authorization`؛ وإلا `{ session:{ valid:true, uid, claims, expiresAt } }` | `UNAUTHENTICATED` |
| `POST` | `/v1/auth/sign-out` | Bearer اختياري | — | `{ success:true, message:"Signed out successfully" }` | — (رمز التحديث غير الصالح لا يؤدي إلى أي فعل) |

ملاحظات:

- التسجيل ذو أثر جانبي: ينشئ المستخدم، ومؤسسة افتراضية، و`Default Project` ومفتاح API **خادم** افتراضي `sk_`. لا يُعاد المفتاح الخام هنا؛ أنشئه/استرجعه عبر نقاط نهاية مفاتيح API.
- تُجزّأ كلمات المرور باستخدام scrypt غير المتزامن (`N=2^14, r=8, p=1`، بالصيغة `scrypt$<saltHex>$<hashHex>`)؛ ويُدعم مسار PBKDF2 القديم لأغراض الترحيل فقط. لا يمكن للمستخدم الذي لا يملك تجزئة كلمة مرور مخزّنة أن يسجّل الدخول.
- جميع مسارات Better-Auth الأخرى المطابقة لـ `/v1/auth/**` (`POST`/`GET`) تُفوَّض إلى `createBetterAuth().handler` في `app.ts`. أشكال هذه المسارات يعرّفها Better Auth نفسه، لا هذا المستودع.

## 2. المصادقة متعددة العوامل TOTP (`mfa.ts`)

جميع نقاط النهاية الأربع تتطلب جلسة صالحة (`requireSession`). أشكال الإرسال مثبّتة بموجب عقد المسار في `mfa.ts`.

| الطريقة | المسار | جسم الطلب | استجابة النجاح | الأخطاء |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/v1/auth/mfa/status` | — | `{ enabled: boolean }` | `UNAUTHENTICATED` |
| `POST` | `/v1/auth/mfa/setup` | — | `{ secret, otpauthUri, recoveryCodes: string[] }` | `UNAUTHENTICATED`، `ALREADY_EXISTS`، `INTERNAL_ERROR` |
| `POST` | `/v1/auth/mfa/verify` | `{ code }` (TOTP من 6 أرقام) | `{ enabled: true }` | `UNAUTHENTICATED`، `INVALID_ARGUMENT`، `FAILED_PRECONDITION`، `RATE_LIMITED` |
| `POST` | `/v1/auth/mfa/disable` | `{ code }` (TOTP أو رمز استعادة) | `{ enabled: false }` | `UNAUTHENTICATED`، `INVALID_ARGUMENT`، `FAILED_PRECONDITION`، `RATE_LIMITED` |

ملاحظات:

- `setup` متطابق (idempotent) ما دام لم يتم التحقق منه: استدعاؤه مجددًا يُعيد نفس `secret` ورموز `recoveryCodes` المشتقة بنص عادي. لا تُخزَّن سوى الرموز المُجزّأة والسر المُشفَّر.
- يقبل التحقق انحراف TOTP بمقدار ±30 ثانية (خطوة واحدة مدتها 30 ثانية، SHA-1، 6 أرقام). كما يقبل `disable` أحد رموز الاستعادة الثمانية.
- تُخنق محاولات `verify`/`disable` الفاشلة داخل العملية: 5 محاولات افتراضيًا كل 60,000 مللي ثانية لكل مستخدم، ثم `RATE_LIMITED` (429).
- حالة MFA دائمة في جدول مستوى التحكم `mfa_secrets` (أو مخزن داخل الذاكرة في الوضع المعزول).

---

## 3. المؤسسات والمشاريع والبيئات (`control-plane.ts`)

تستخدم مسارات مستوى التحكم القديمة `optionalSession`. جلسات العملاء لا ترى سوى المؤسسات التي هم أعضاء فيها؛ أما جلسات `owner`/`admin` فترى الجميع.

| الطريقة | المسار | جسم الطلب | استجابة النجاح | الأخطاء |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/v1/organizations` | `CreateOrganizationRequestSchema`: `{ name (1–100), slug (1–100, /^[a-z0-9-]+$/), planTier?: "free"\|"developer"\|"pro"\|"enterprise" }` | `201Organization{id,name,slug,planTier,createdAt,updatedAt}` | `INVALID_ARGUMENT` |
| `GET` | `/v1/organizations` | — | `200Organization[]` | — |
| `GET` | `/v1/organizations/:orgId/projects` | — | `200Project[]` | `PERMISSION_DENIED` (الجلسة ليست عضوًا) |

## 4. مفاتيح API (`control-plane.ts`)

| الطريقة | المسار | جسم الطلب | استجابة النجاح | الأخطاء |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/v1/projects/:projectId/api-keys` | `CreateApiKeyRequestSchema`: `{ name, keyType:"publishable"\|"secret", expiresAt? }` | `201{ apiKey: ApiKey, rawKey }` | `INVALID_ARGUMENT` |
| `GET` | `/v1/projects/:projectId/api-keys` | — | `200ApiKey[]` | — |
| `DELETE` | `/v1/projects/:projectId/api-keys/:keyId` | — | `200{ success:true, revoked }` | `NOT_FOUND`، `PERMISSION_DENIED` |

ملاحظات:

- `keyType:"secret"` يقابل مفتاح **خادم** بالنطاقات `documents:read` و`documents:write` و`indexes:manage`؛ و`publishable` يقابل مفتاحًا **عامًا** بالنطاقين `documents:read` و`documents:write`. مفاتيح الخادم تستخدم العائلة `sk_`، والمفاتيح العامة العائلة `pk_`.
- يُعاد `rawKey` **مرة واحدة فقط**، عند الإنشاء. خزّنه بأمان؛ فمستوى التحكم لا يُبقي سوى `keyPrefix` وتجزئة HMAC باسم `secretHash`.
- يتحقق الإلغاء من أن المفتاح يخص `(projectId)` المُعنوَن قبل حذفه (إلغاء عبر مستأجر آخر → `PERMISSION_DENIED`)، ثم ينشر إبطالًا للذاكرة المؤقتة عبر `NOTIFY vellum_cache_invalidate`.
- `ApiKeySchema`: `{ id, projectId, projectId, name, keyType:"publishable"\|"secret", keyPrefix, createdAt, expiresAt?, lastUsedAt? }`.

## 5. مجموعات قواعد الأمان (`control-plane.ts`)

| الطريقة | المسار | جسم الطلب | استجابة النجاح | الأخطاء |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/v1/projects/:projectId/rulesets` | `UpdateRulesetRequestSchema`: `{ rulesAst: object }` | `201` مجموعة قواعد منشورة `{ id, projectId, projectId, version, rulesAst, publishedAt, … }` | `INVALID_ARGUMENT` (فشل تحقق المخطط أو AST) |
| `GET` | `/v1/projects/:projectId/rulesets` | — | `200` مجموعة القواعد النشطة، أو مجموعة افتراضية v1 مُركّبة `{ id:"default_<projectId>", version:1, rulesAst:{schemaVersion:"1.0", rules:[…]} }` | — |

يتحقق AST عبر `validateSecurityRulesetAst` (`maxDepth ≤ 10`، `maxNodes ≤ 100`، دون كود ديناميكي). راجع [شجرة قواعد الأمان](../../../04-security-rules-ast.md). النشر يُبطل ذاكرة مجموعات القواعد داخل العملية عبر `NOTIFY vellum_cache_invalidate`.

---

## 6. واجهة الكونسول (`console.ts`)

كل مسار من `/v1/console/**` يتطلب جلسة بأحد أدوار `CONSOLE_ROLES`. وتكتب كل عملية تعديل سجل تدقيق غير قابل للتغيير. تُصرَّح طلبات الكونسول عبر الجلسة (لا مفتاح طويل الأمد)؛ وتسمح سجلة مفتاح خادم صناعية محدودة النطاق لمحرك المستندات بتطبيق مسار القواعد والنطاقات المعتاد.

### 6.1 اكتشاف المؤسسة / المشروع

| الطريقة | المسار | استجابة النجاح | الأخطاء |
| :--- | :--- | :--- | :--- |
| `GET` | `/v1/console/organizations` | `Organization[]` (مُصفَّى حسب العضوية؛ المشغّلون يرون الجميع) | `UNAUTHENTICATED` |
| `GET` | `/v1/console/organizations/:orgId/projects` | `Project[]` | `PERMISSION_DENIED` (ليس عضوًا) |

### 6.2 المستندات والاستعلام والدُفعات والمعاملات

| الطريقة | المسار | جسم الطلب | استجابة النجاح | الأخطاء |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/v1/console/projects/:projectId/documents/*` | — | عدد المقاطع الزوجي → مستند؛ والفردي → نتيجة `executeQuery` | `INVALID_DOCUMENT_PATH`، `NOT_FOUND`، أخطاء القواعد |
| `POST` | `/v1/console/projects/:projectId/documents/*` | `{ data }` أو خريطة بيانات مجرّدة | `201` المستند المُنشأ | `INVALID_DOCUMENT_PATH`، `ALREADY_EXISTS`، `DOCUMENT_TOO_LARGE` |
| `PUT` | `/v1/console/projects/:projectId/documents/*` | `{ data, merge?, ifVersion? }` (يمكن أن يكون `merge` أيضًا `?merge=true`) | `200` المستند المحفوظ | `FAILED_PRECONDITION`، `INVALID_DOCUMENT_PATH` |
| `PATCH` | `/v1/console/projects/:projectId/documents/*` | `{ data, ifVersion? }` | `200` المستند المُحدَّث | `FAILED_PRECONDITION`، `INVALID_DOCUMENT_PATH` |
| `DELETE` | `/v1/console/projects/:projectId/documents/*` | — (`?ifVersion=<n>` اختياري) | `200` نتيجة الحذف | `FAILED_PRECONDITION`، `NOT_FOUND` |
| `POST` | `/v1/console/projects/:projectId/query` | `QuerySpec` (راجع [مستوى البيانات](./rest-data-plane.md)) | `200{ documents, nextCursor, hasMore, executionStats? }` | `QUERY_TOO_COMPLEX`، `LIMIT_EXCEEDED`، `INVALID_CURSOR`، `QUERY_DEADLINE_EXCEEDED` |
| `POST` | `/v1/console/projects/:projectId/batchWrite` | `{ writes }` أو `{ operations }` (`BatchOperation[]`) | `200{ results:[{path,version,updatedAt}], commitTimestamp }` | `BATCH_SIZE_EXCEEDED`، `PAYLOAD_TOO_LARGE`، `ABORTED_CONFLICT` |
| `POST` | `/v1/console/projects/:projectId/transactions:begin` | — | `200{ transactionToken, expiresAt }` | `UNAUTHENTICATED` |
| `POST` | `/v1/console/projects/:projectId/transactions:commit` | `{ transactionToken, writes \| mutations \| ... }`؛ و`ifVersion` لكل عملية كتابة من `ifVersion`/`preconditions`/`precondition` | `200` نتيجة الإيداع | `TRANSACTION_TIMEOUT`، `ABORTED_CONFLICT` |

يمكن تمرير رمز المعاملة أيضًا إلى `GET .../documents/*` عبر `?transactionToken=` أو `?txToken=` أو الترويسة `x-transaction-token` للقراءة داخل لقطة OCC.

### 6.3 الفهارس ومجموعات القواعد والمفاتيح

| الطريقة | المسار | جسم الطلب | استجابة النجاح | الأخطاء |
| :--- | :--- | :--- | :--- | :--- |
| `GET` | `/v1/console/projects/:projectId/indexes` | — | `{ indexes: CompositeIndex[] }` | `UNAUTHENTICATED` |
| `POST` | `/v1/console/projects/:projectId/indexes` | `{ collectionPath, fields:[{fieldPath, order?}] }` | `201CompositeIndex` | `INVALID_ARGUMENT` (`fields` فارغ، مسار غير صالح) |
| `DELETE` | `/v1/console/projects/:projectId/indexes/:indexId` | — | `{ deleted:true, indexId }` | `NOT_FOUND` |
| `GET` | `/v1/console/projects/:projectId/rulesets` | — | مجموعة القواعد النشطة أو `{ projectId, version:0, rulesAst:null }` | — |
| `POST` | `/v1/console/projects/:projectId/rulesets` | `{ rulesAst }` | `201` مجموعة قواعد منشورة | `INVALID_ARGUMENT` |
| `GET` | `/v1/console/projects/:projectId/api-keys` | — | `ApiKey[]` | — |
| `POST` | `/v1/console/projects/:projectId/api-keys` | `{ name?, keyType }` — `publishable`/`public` → عام، وأي شيء آخر → خادم | `201{ apiKey, rawKey }` | `UNAUTHENTICATED` |
| `DELETE` | `/v1/console/projects/:projectId/api-keys/:keyId` | — | `{ success:true, revoked }` | `NOT_FOUND`، `PERMISSION_DENIED` |

`CompositeIndexFieldSchema`: `{ fieldPath: string (min 1), order?: "asc"\|"desc" (default asc) }`. `CompositeIndexSchema`: `{ id, projectId, projectId, collectionPath, fields, status:"building"\|"ready"\|"failed", createdAt }`.

---

## 7. القياس والاستخدام (`usage.ts`)

| الطريقة | المسار | المصادقة | معاملات الاستعلام | استجابة النجاح |
| :--- | :--- | :--- | :--- | :--- |

`UsageDailyRecord`: `{ projectId, usageDate, documentReads, documentWrites, documentDeletes, realtimeMessagesSent, egressBytes, storageBytes, updatedAt }`. و`totals` هي نفس مجموعة العدّادات مجمَّعة على الأيام المُعادة. تُقرأ البيانات من `project_usage_daily` (مستوى التحكم)؛ والنسخة المطابقة في الذاكرة هي بديل للوضع دون اتصال/الاختبار. تتجاهل قيم `from`/`to` غير الصالحة (تُعامل كـ `null`).

---

## 8. مسارات الإدارة/المشغّل (`admin.ts`)

تمر استجابات الإدارة عبر `sanitizeAdminPayload` الذي يزيل `data` و`beforeData` و`afterData` من الكائنات ذات شكل المستند. **يمكن لمشغّلي المنصة فحص بيانات المستأجرين والحصص والفهارس وسجلات التدقيق، ولكن ليس حمولات مستندات العملاء مطلقًا.**

| الطريقة | المسار | المصادقة | الطلب / الاستعلام | استجابة النجاح | الأخطاء |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `GET` | `/v1/admin/setup-status` | لا شيء | — | `{ initialized, ownerCount, requiresSetup, totalUsers, tokenRequired }` | — |
| `POST` | `/v1/admin/setup-owner` | رمز الإعداد لمرة واحدة (عند عدم وجود مالك) | `{ name, email, password }` (كلمة المرور ≥ 8) + ترويسة `x-setup-token` (أو الحقل `setupToken`) | `201{ success, user, token, refreshToken, expiresAt }` | `ALREADY_EXISTS`، `INVALID_ARGUMENT`، `UNAUTHENTICATED` (`INVALID_SETUP_TOKEN`) |

في الإنتاج يلزم دائمًا متغيّر `ADMIN_SETUP_TOKEN` لاستدعاء `setup-owner`؛
تتم المقارنة في زمن ثابت ولا يُرجع الرمز مطلقًا من `setup-status` (الذي يعرض
`tokenRequired` فقط). بعد إنشاء المالك يُغلق المسار نهائيًا باستجابة
`409 ALREADY_EXISTS`، لذا احذف متغيّر البيئة بعد التهيئة لمرة واحدة.
| `POST` | `/v1/admin/login` | لا شيء | `{ email, password }` | `{ success, user, token, refreshToken, expiresAt }` | `NOT_FOUND` (يحتاج إعدادًا)، `UNAUTHENTICATED`، `PERMISSION_DENIED` |
| `GET` | `/v1/admin/overview` | مشغّل | — | `{ status, version, tenantsCount, projectsCount, keysCount, usersCount, planes, metrics, nodes, telemetry }` | `UNAUTHENTICATED` |
| `GET` | `/v1/admin/tenants` | مشغّل | — | مصفوفة مستأجرين مع `storageMb`، `dailyReads`، `dailyWrites`، `projectsCount`، `plan`، `status` | `UNAUTHENTICATED` |
| `GET` | `/v1/admin/tenants/:orgId` | مشغّل | — | كائن المستأجر + بيانات `projects` الوصفية | `NOT_FOUND` |
| `POST` | `/v1/admin/tenants/:orgId/suspend` | كتابة مشغّل | — | `{ success:true, status:"suspended" }` | `NOT_FOUND` |
| `POST` | `/v1/admin/tenants/:orgId/reactivate` | كتابة مشغّل | — | `{ success:true, status:"active" }` | `NOT_FOUND` |
| `GET` | `/v1/admin/audit-logs` | مشغّل | `limit`، `cursor`، `action`، `actorUserId`، `organizationId`، `projectId`، `from`، `to`، `envelope=true` | مصفوفة عروض التدقيق (افتراضيًا) أو `{ items, total, nextCursor, hasMore }`. الترويسات: `X-Total-Count`، `X-Has-More`، `X-Next-Cursor` | `UNAUTHENTICATED` |
| `GET` | `/v1/admin/features` | مشغّل | — | `FeatureFlagRecord[]` | `UNAUTHENTICATED` |
| `GET` | `/v1/admin/features/:key` | مشغّل | — | `FeatureFlagRecord` | `NOT_FOUND` |
| `POST` | `/v1/admin/features` | كتابة مشغّل | `{ key, description?, enabled?, rolloutPercent? }` | `200`/`201FeatureFlagRecord` | `INVALID_ARGUMENT` |
| `PUT` | `/v1/admin/features/:key` | كتابة مشغّل | `{ description?, enabled?, rolloutPercent? }` | `200`/`201FeatureFlagRecord` | `INVALID_ARGUMENT` |
| `PATCH` | `/v1/admin/features/:key` | كتابة مشغّل | جسم علم جزئي (الحقول غير المحددة تحتفظ بقيمها الحالية) | `200FeatureFlagRecord` | `INVALID_ARGUMENT` |
| `DELETE` | `/v1/admin/features/:key` | كتابة مشغّل | — | `{ deleted:true, key }` | `NOT_FOUND` |

`FeatureFlagRecord`: `{ key, description, enabled, rolloutPercent, updatedBy?, createdAt?, updatedAt? }` (الحقول الدقيقة من `@vellum/database-control`). مؤشرات سجل تدقيق الإدارة هي أزواج base64url غير شفافة بالصيغة `(created_at, id)` بترتيب تنازلي؛ ترقيم صفحات بمفتاح (keyset)، وليس SQL `OFFSET` أبدًا.

---

## 9. الفحص الصحي و OpenAPI (`health.ts`)

| الطريقة | المسار | المصادقة | الوصف |
| :--- | :--- | :--- | :--- |
| `GET` | `/v1/health/live` | لا شيء | فحص الحياة؛ لا يلمس PostgreSQL أبدًا. تستخدمه الحاوية `HEALTHCHECK`. |
| `GET` | `/v1/health/ready` | لا شيء | فحص الجاهزية؛ يُجري فحوص SQL حقيقية على مستويتي التحكم والبيانات وجداول الترحيل ونقطة LISTEN المخصصة. يُعيد `503 SERVICE_UNAVAILABLE` عند فشل أي فحص. |
| `GET` | `/v1/health` | لا شيء | اسم مستعار التوافق مهمل؛ تُشتق أعلام المستويات من فحوص `SELECT 1` حقيقية. |
| `GET` | `/v1/openapi.json` | لا شيء | مواصفة OpenAPI 3.1 قابلة للقراءة آليًا، يُنشئها `generateOpenApiSpec`. |

أي مسار غير مطابق يُعيد `404 NOT_FOUND` عبر المعالج الشامل في `app.ts`.

## مرجع سريع

- عمليات المستندات العامة التي تستخدم مفتاح API فقط: [مستوى البيانات عبر REST](./rest-data-plane.md)
- إطارات WebSocket والاستئناف والعلامات المائية: [بروتوكول الوقت الفعلي](./realtime-protocol.md)
- الرموز المعيارية والحالات وإرشادات إعادة المحاولة: [الأخطاء](./errors.md)
- القيم الموسومة وقواعد المسارات: [تنسيق الإرسال](./wire-format.md)
