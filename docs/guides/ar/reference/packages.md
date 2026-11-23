---
title: واجهات الحزم البرمجية
order: 9
group: المرجع
description: المرجع الداخلي لواجهة كل حزمة على حدة لمكتبات @vellum/* المستقلة عن الأطر في Monorepo.
---

# واجهات الحزم البرمجية (داخلية)

هذا مرجع داخلي لمكتبات `packages/*` في Monorepo. نُقلت التوقيعات من ملف `src/index.ts` لكل حزمة ومن ملفاتها المصدرية. أما المكتبات الموجَّهة للعملاء فاستخدم [JavaScript SDK](../sdks/javascript.md) و[Flutter SDK](../sdks/flutter.md) بدلًا منهما.

:::warning حزم داخلية — ليست الـ SDK العامة
المكتبات أدناه هي **لبنات بناء داخلية** تستخدمها `apps/api` ومجموعات SDK. ليست سطح منتج عام مدعوم: فقد تتغير صادراتها بين الإصدارات، وبعض المسارات (أبرزها منشئات القيم الموسومة في `@vellum/core` ومؤشرات `@vellum/query-engine`) حرجة بالنسبة لتنسيق الإرسال. يجب أن تعتمد كود التطبيقات على `@vellum/sdk-js` أو على HTTP المباشر، لا على هذه الحزم مباشرة.
:::

## قواعد الحدود المعمارية

| القاعدة | الأثر على هذه الحزم |
| :--- | :--- |
| حدود Monolith المعياري | كل منطق العمل يقع في `packages/*` المستقلة عن الأطر. و`apps/api` و`apps/dashboard` و`apps/admin` مجرد محولات توصيل رقيقة — بلا تقييم AST أو تسلسل إرسال أو تحويل SQL في معالجات المسارات/الواجهة. |
| مستويان للبيانات | `database-control` (المستخدمون، المؤسسات، المشاريع، البيئات، تجزئات المفاتيح، مجموعات القواعد، القياس، التدقيق) و`database-data` (المستندات، تعريفات/مداخل الفهارس، outbox، المعاملات) منفصلان فيزيائيًا ومنطقيًا. ولا تعتمد التهيئة أو التحقق من المفاتيح على واجهة المستندات العامة أبدًا. |
| عزل المستأجرين | كل عملية في مستوى البيانات تتطلب `(projectId)` (`TenantContext`). تربط معاملات PostgreSQL الإعدادات `SET LOCAL statement_timeout='5000ms'` و`app.current_project_id` كي يفشل RLS بانغلاق (fail closed). |
| صفر DDL للعملاء | فهارس المستأجرين المركّبة هي صفوف في `document_indexes` + `document_index_entries` بمفاتيح فرز ثنائية — ولا يُنفَّذ `CREATE INDEX` على `documents` أبدًا. |
| AST حتمي | لا `eval()`/`new Function()`؛ يتحقق `@vellum/authorization` من شجرة قواعد v1 ويقيّمها بشكل متزامن. |
| ترقيم بالمؤشر فقط | مؤشرات غير شفافة موقّعة HMAC-SHA256 من `@vellum/query-engine`؛ بلا `OFFSET`. |
| صفر خدمات حالة خارجية | PostgreSQL فقط. الوقت الفعلي = `LISTEN/NOTIFY` + outbox دائم؛ والمخاب/حدود المعدل هي TTL داخل العملية+z حالة مدعومة بـ PostgreSQL. |

الحزم الثماني أدناه كلها مستقلة عن الأطر (لا تستورد Hono أو Next.js أو React). وتستخدم عدة منها أدوات Node المدمجة (`node:crypto`، `pg`) ولذلك تستهدف الخادم/وقت التشغيل، لا المتصفح.

---

## `@vellum/core`

**المسؤولية:** الحدود الثابتة، تسلسل الأخطاء المعياري، مُحلِّل المسارات، تنسيق الإرسال الموسوم، ومُشفِّر مفاتيح الفرز الحافظ للترتيب. حزمة نقية خفيفة التبعية، وهي الأدنى في الرسم البياني (`@vellum/api-contract` و`@vellum/authorization` و`@vellum/query-engine` و`@vellum/storage` و`@vellum/realtime` تعتمد عليها جميعًا). تُصدِّر الحزمة التجميعية `limits` و`errors` و`paths` و`wire-format` و`sort-key`.

| التصدير | التوقيع / الشكل | الدلالة |
| :--- | :--- | :--- |
| `SYSTEM_LIMITS` | كائن `const` | كل حصص v1 (مستندات 1 MiB، عمق مسار 10، دفعة 100، إلخ). |
| `VellumError` | `class extends Error` — `constructor(code: ErrorCode, message: string, details?: ErrorDetails)`؛ الحقول `code`، `status`، `details`؛ `toEnvelope(requestId?: string): ErrorEnvelope` | الاستثناء المعياري القابل للرمي؛ تُحلَّل `status` من `ERROR_HTTP_STATUS`. |
| `ERROR_HTTP_STATUS` | خريطة `constRecord<ErrorCode, number>` | الرمز المعياري → حالة HTTP (راجع [الأخطاء](./errors.md)). |
| `parseDocumentPath` | `(rawPath: string): DocumentPathResult` | يتحقق من 2–10 مقاطع زوجية؛ يُعيد `path` و`collectionPath` و`collectionGroup` و`documentId` و`pathDepth` و`segments`. |
| `parseCollectionPath` | `(rawCollectionPath: string): CollectionPathResult` | يتحقق من 1–9 مقاطع فردية. |
| `validatePathSegment` | `(segment: string, fullPath: string): void` | يرفض المقطع الفارغ أو النسبي أو `__…__` أو أحرف التحكم أو >1,500 بايت. |
| `validateWireValue` | `(value: unknown, depth?: number, allowFieldOps?: boolean): void` | تحقق متكرر من القيم الموسومة/تحويلات الحقول، بعمق ≤20. |
| `validateFieldName` | `(fieldName: string): void` | غير فارغ، ≤256 حرفًا، بلا أحرف تحكم. |
| `normalizeAndValidateDocumentData` | `(data: unknown, allowFieldOps?: boolean): NormalizedDocument` | يوحّد الطوابع الزمنية، يفرض حد 1 MiB؛ يُعيد `{data, sizeBytes}`. |
| `WireValue` | `const` مع `int64`، `timestamp`، `reference`، `bytes`، `geopoint`، `escapeMap` | منشئات للقيم الموسومة `$t`/`$v`. |
| `encodeSortableFloat64` / `encodeSortableInt64` | `(n: number): Buffer` / `(v: bigint\|number\|string): Buffer` | ترميزات big-endian حافظة للترتيب. |
| `TYPE_TAG` | خريطة `const` | بايتات نوع مفتاح الفرز (`NULL 0x0a`، `NUMBER 0x20`، `STRING 0x30`، …). |

## `@vellum/api-contract`

**المسؤولية:** مخططات Zod التشغيلية لأشكال مستوى التحكم والمستندات والاستعلام والمعاملات والأخطاء والحدود وWebSocket؛ ومولّد OpenAPI 3.1؛ ومُتحقِّقات الحدود التي تستخدمها مسارات API.

| التصدير | التوقيع / الشكل | الدلالة |
| :--- | :--- | :--- |
| `generateOpenApiSpec` | `(serverUrl = "https://api.vellum.dev") => object` | يبني مستند OpenAPI 3.1 المُقدَّم على `/v1/openapi.json`. |
| `validateProjectParam` | `(name: string): ProjectName` | يقبل اسم المشروع؛ وأي قيمة أخرى تُنتج `INVALID_ARGUMENT`. |
| `validateClientWsFrame` | `(frame: unknown): ClientFrame` | تحقق Zod من إطارات WS الداخلة؛ يرمي `INVALID_ARGUMENT`. |
| `VALID_PROJECT_NAMES`، `VALID_QUERY_OPERATORS` | `Set<string>` | مجموعات متوافقة مع الإصدارات السابقة. |
| `QuerySpecSchema`، `QueryResponseSchema`، `BatchWriteSchema`، `CommitTransactionSchema` | مخططات Zod | تحقق تشغيلي من أجسام الطلب/الاستجابة العامة. |
| `CreateOrganizationRequestSchema`، `CreateProjectRequestSchema`، `CreateApiKeyRequestSchema`، `UpdateRulesetRequestSchema` | مخططات Zod | تحقق طلبات مستوى التحكم. |
| `ClientFrameSchema`، `ServerFrameSchema`، `ResumeCompleteFrame` | مخطط Zod / type | الاتحاد المعياري لإطارات WebSocket. |
| `TaggedObjectSchema`، `TaggedValueSchema`، `DocumentPayloadSchema` | مخططات Zod | تمثيل تنسيق الإرسال (يُوحّد الأسماء المستعارة القديمة). |
| `ApiErrorSchema`، `ErrorCodeEnum` | مخطط Zod / enum | مغلّف الخطأ المعياري ومجموعة الرموز. |
| types | `QuerySpec`، `QueryFilter`، `QueryOrderBy`، `ClientFrame`، `ServerFrame`، `ApiError`، `PlanTier`، `ProjectName`، … | الأنواع المستنتجة في TypeScript. |

## `@vellum/authorization`

**المسؤولية:** توليد/التحقق من مفاتيح API، والتحقق من مطالبات JWT، ورموز الجلسة مع الإلغاء، ومساعدات TOTP MFA، ومُقيّم/مُصرِّح شجرة قواعد الأمان الحتمي. نواة أمان مستقلة عن الأطر.

| التصدير | التوقيع | الدلالة |
| :--- | :--- | :--- |
| `generateProjectApiKey` | `({ keyType: "public"\|"server", pepper?: string }): GeneratedApiKey` | ينشئ `pk_…` / `sk_…` افتراضيًا، ويُعيد `{fullKey, keyPrefix, secretHash, keyType}`. |
| `hashApiKey` | `(fullKey: string, pepper?: string): string` | تجزئة SHA-256(`fullKey:pepper`) بصيغة سداسية عشرية. |
| `verifyApiKey` | `(fullKey: unknown, controlStore: ApiKeyStore, pepper?: string): ApiKeyRecord` | مقارنة ثابتة الزمن للتجزئة مع ذاكرة مؤقتة داخل العملية مدتها 30 ثانية؛ يرمي `UNAUTHENTICATED`. |
| `invalidateApiKeyCache` | `(keyPrefix?: string): void` | يُفرغ مدخلًا واحدًا أو كل المداخل المُتحقَّق منها. |
| `getDefaultPepper` | `(): string` | حل كسول: `API_KEY_PEPPER` ← `PEPPER_HEX` ← قيمة احتياطية. |
| `signEndUserJwt` / `verifyEndUserJwt` / `verifyEndUserJwtSync` | `(payload, secret?): string` / `(token, options?): Promise<AuthContext>` / `(token, secret?): AuthContext` | مساعدات JWT محلية HS256؛ والنسخة غير المتزامنة تدعم JWKS عن بُعد عبر `jose`. |
| `validateSecurityRulesetAst` | `(rulesetAst: unknown): boolean` | يفرض مخطط AST للإصدار v1 (العمق ≤10، العقد ≤100). |
| `matchRulePathPattern` | `(pattern: string, targetPath: string): Record<string,string> \| null` | مُطابق لأنماط المسارات يُعيد المعاملات الملتقطة. |
| `evaluateAstNode` | `(expr: AstExpression, context: RuleEvaluationContext): boolean` | مُقيّم تعابير متزامن بدون `eval`. |
| `authorizeOperation` | `({apiKeyRecord, rulesetRecord, operation, path, authContext?, resourceData?, requestData?, requestTimeMs?}: AuthorizeOperationParams): AuthorizationResult` | فحص نطاق مفتاح الخادم أو تقييم AST للقواعد؛ يرمي `PERMISSION_DENIED`. |
| `createSessionService` | `({ secret: string, revocationStore: RevocationStore }): SessionService` | خدمة رموز وصول/تحديث HS256 مع إلغاء. |
| `createInMemoryRevocationStore` | `(): RevocationStore` | مخزن إلغاء للاختبار/الوضع المعزول. |
| مساعدات MFA | `generateMfaSecret(byteLength?)`, `generateTotpCode(secret, options?)`, `verifyTotp(secret, token, options?)`, `deriveRecoveryCodes(secret, count?)`, `hashRecoveryCode(code, pepper)`, `hashRecoveryCodes(codes, pepper)`, `consumeRecoveryCode(code, pepper, storedCodes)` | دورة حياة TOTP ورموز الاستعادة وفق RFC 6238. |
| types | `Role`، `SessionClaims`، `SessionService`، `AuthContext`، `SecurityRulesetAst`، `RuleEvaluationContext`، `AuthorizationResult`، … | أنواع تصريح مشتركة. |

## `@vellum/storage`

**المسؤولية:** عقد `StorageAdapter` مع مُكيّفات الذاكرة وPostgreSQL وNeon؛ وسياق معاملة المستأجر (`TxHandle`) الذي يربط إعدادات RLS؛ وثوابت SQL المُعدّة؛ ومخاب TTL والحافلة `NOTIFY vellum_cache_invalidate` بين النسخ. هنا تُفرَض ثوابت عزل المستأجر وصفر DDL.

| التصدير | التوقيع / الشكل | الدلالة |
| :--- | :--- | :--- |
| `createStorageAdapter` | `(options?: StorageAdapterOptions): StorageAdapter` | يختار مُشغِّل `memory` / `pg` / `neon` (صريح ← متغير بيئة ← استنتاج من URL). |
| `StorageAdapter` | واجهة: `withTransaction<T>(ctx, cb)`، `getDocument`، `putDocument`، `listDocumentsInCollection`، `listDocumentsViaIndex`، `appendOutbox`، `createCompositeIndex`، `listCompositeIndexes`، `deleteCompositeIndex`، `queryOutboxSince`، `runIndexBuilderWorker`، `runOutboxCompactionWorker`، `runTombstonePurgeWorker`، `close` | نقطة الثبات الوحيدة لمستوى البيانات؛ كل الدوال تأخذ `TenantContext`. |
| `TenantContext` | `{ readonly projectId: string; readonly projectId: string }` | نطاق المستأجر الإلزامي لكل عملية. |
| `DataPlaneStore`، `PgStorageAdapter`، `NeonStorageAdapter` | `class … implements StorageAdapter` | الذاكرة (للاختبار)، PostgreSQL المجمّع، Neon serverless. |
| `TxHandle` | واجهة: `getDocument(path, includeSoftDeleted?, forUpdate?)`، `putDocumentRow`، `appendOutboxEvent`، `createIndex`، `queryDocuments(compiled)`، ومساعدات اختيارية لـ outbox/الفهرس | مقبض معاملة مرتبط بالمستأجر؛ تُطبَّق إعدادات RLS عند الإنشاء. |
| `runInTenantTransactionAsync<T>` | `(pool: {connect(): Promise<PgClientLike>}, ctx: TenantContext, asyncCallback: (tx: TxHandle) => Promise<T>, options?: PreparedStatementOptions): Promise<T>` | يفتح عميل PG خامًا، يربط سياق المستأجر، ويُنفّذ رد النداء. |
| `createSqlTransactionHandle` | `(client: PgClientLike, ctx: TenantContext, options?: PreparedStatementOptions): SqlTxHandle` | يغلّف عميلًا كمقبض مرتبط بالمستأجر. |
| `SQL_SET_STATEMENT_TIMEOUT`، `SQL_SET_PROJECT` | نصوص `const` SQL | `SET LOCAL statement_timeout`، `set_config('app.current_project_id'…)`. |
| ثوابت SQL أخرى | `SQL_GET_INDEXES`، `SQL_INSERT_OUTBOX`، `SQL_QUERY_OUTBOX`، `SQL_CREATE_INDEX`، `SQL_LIST_DOCS_VIA_INDEX`، … | عبارات مُعلَّمة بمعاملات لمسارات الفهرس/outbox/الاستعلام. |
| `createTtlCache<V>` | `(options?: TtlCacheOptions): TtlCache<V>` | مخ TTL/LRU داخل العملية؛ `get/set/delete/clear/size/keys/stats/stop`. |
| `getNamedCache`، `invalidateApiKeyCache`، `invalidateRulesetCache`، `invalidateProjectEnvCache`، `invalidateAllCaches` | مساعدات مخاب | مخاب TTL مُسمّاة (30–60 ثانية) + الإبطال. |
| `createCacheInvalidationBus` | `(options: CacheInvalidationBusOptions): CacheInvalidationBus` | حافلة `LISTEN/NOTIFY` على `vellum_cache_invalidate`؛ `publish()`، `close()`، `isListening()`. |
| `getCacheInvalidationBus` / `setCacheInvalidationBus` | `(): CacheInvalidationBus \| null` / `(bus): void` | مُوصِّل الحافلة على مستوى العملية. |
| types | `DocumentRecord`، `OutboxEvent`، `OutboxMutation`، `CompositeIndexRecord`، `CompositeIndexEntry`، `QueriedDocument`، `StorageAdapterOptions`، … | أشكال سجلات مستوى البيانات. |

## `@vellum/query-engine`

**المسؤولية:** التحقق من الاستعلامات وتوحيدها، واختيار فهرس مركّب، وتجميع SQL مُعلَّم بمعاملات (بلا مسندات مبنية بالسلاسل)، وترميز/فك مؤشرات غير شفافة موقّعة HMAC. يفرض الترقيم بالمؤشر فقط وحدود تعقيد الاستعلام.

| التصدير | التوقيع | الدلالة |
| :--- | :--- | :--- |
| `validateAndNormalizeQuery` | `(rawQuery: Record<string, unknown>): NormalizedQuery` | يتحقق من `where`/`orderBy`/`limit`، ويحسم `collectionPath` مقابل `collectionGroup`، والحدود. |
| `compileQueryToParameterizedSql` | `({projectId, projectId, normalizedQuery, matchedCompositeIndex?, cursor?, cursorMode?}): CompiledQuery` | يُصدر SQL مُعلَّمًا بمعاملات ومحددًا بالمستأجر. |
| `selectCompositeIndexForQuery` | `(normalizedQuery: NormalizedQuery, availableIndexes?: CompositeIndexMetadata[]): {matchedIndex, requiresCompositeIndex}` | مُختار الفهرس. |
| `computeIndexDefinitionHash` | `(collectionPath: string, fields: Array<{path,dir}>): string` | تجزئة SHA-256 لتعريف الفهرس. |
| `computeQueryShapeHash` | `({projectId, projectId, collectionPath, where, orderBy}): string` | تجزئة SHA-256 لشكل الاستعلام المعياري؛ مُضمَّنة في المؤشر. |
| `encodeQueryCursor` | `(payload: CursorPayload, cursorSecret?: string): string` | JSON بصيغة base64url + توقيع HMAC-SHA256. |
| `decodeAndVerifyQueryCursor` | `(cursorToken: unknown, expectedQHash: string, cursorSecret?: string): CursorPayload` | يتحقق من التوقيع وتجزئة الشكل؛ يرمي `INVALID_CURSOR`. |
| `documentMatchesQuery`، `documentMatchesWhereClause` | `(docRecord, …): boolean` | مُقيّمات داخل الذاكرة يستخدمها مُكيّف الذاكرة ومُطابق اشتراكات الوقت الفعلي. |
| `extractDocFieldValue`، `buildNestedJsonObject` | `(docRecord, fieldPath): unknown` / `(dotPath, leafValue): object` | مساعدات الحقول ذات المسار النقطي. |
| types | `QuerySpec`، `WhereClause`، `OrderByClause`، `NormalizedQuery`، `CompiledQuery`، `CursorPayload`، `CursorMode`، `QueryOperator`، … | أنواع نطاق الاستعلام. |

## `@vellum/document-engine`

**المسؤولية:** نواة عمل المستندات — CRUD، تحويلات الحقول الذرية، الكتابة الدُفعية، الاستعلام المنظّم، ومعاملات OCC المدعومة بـ PostgreSQL. معالجات المسارات تستدعيها؛ ولا تُنفّذ بنفسها منطق القواعد/SQL/الإرسال.

| التصدير | التوقيع | الدلالة |
| :--- | :--- | :--- |
| `DocumentEngine` | `class` — `constructor(options: DocumentEngineOptions)` | المحرك الرئيسي؛ الخصائص `controlStore`، `dataStore`، `realtimeHub`، `cursorSecret`، `txSecret`، `transactions`. |
| — دوال | `getDocument(ctx: EngineContext & {path}): Promise<PublicDocument>`؛ `createDocument`، `setDocument` (`merge?`، `ifVersion?`)، `updateDocument` (`ifVersion?`)، `deleteDocument` (`ifVersion?`) | CRUD؛ كل واحدة تأخذ `EngineContext` (المشروع/البيئة + apiKey/authContext). |
| — دوال | `batchWrite(ctx: EngineContext & {writes: BatchMutation[]}): Promise<BatchWriteResult>` | حتى 100 تعديل ذري؛ يتحقق من حجم/حمولة الدفعة والقواعد وكتابات outbox. |
| — دوال | `executeQuery(ctx: EngineContext & {querySpec: QuerySpec}): Promise<QueryResult>` | تجميع + تصريح + ترقيم بالمؤشر. |
| — دوال | `beginTransaction(ctx): Promise<TransactionBeginResult>`؛ `commitTransaction(ctx: EngineContext & {transactionToken, writes}): Promise<BatchWriteResult>`؛ `rollbackTransaction`، `cleanupExpiredTransactions` | دورة حياة OCC؛ الإيداع مدعوم بقاعدة البيانات. |
| `applyFieldTransforms` | `(existingObj: Record<string,unknown>\|null\|undefined, patchObj: Record<string,unknown>, txTimestampIso: string): Record<string,unknown>` | يطبّق رموز `$op` (`inc`، `arrayUnion`، `arrayRemove`، `serverTimestamp`، `deleteField`). |
| `createTransactionManager` | `(options: TransactionManagerOptions): TransactionManager` | `begin`، `recordRead`، `verifyAndLock`، `markCommitted`، `rollback`، `cleanupExpired`. |
| `decodeAndVerifyTransactionToken` | `(token: string, secret: string, ctx: TenantContext): TxTokenPayload` | يتحقق من رمز OCC الموقع. |
| `transactionTokenHash` | `(token: string): string` | التجزئة المستخدمة كمفتاح لصف قاعدة البيانات. |
| `runExpiredTransactionCleanup` | `(client: {query(...)}, batchSize = 1000): Promise<number>` | عامل صيانة لصفوف `transactions` القديمة. |
| types | `BatchMutation`، `EngineContext`، `DocumentEngineOptions`، `PublicDocument`، `QueryResult`، `BatchWriteResult`، `TransactionBeginResult`، … | أنواع نطاق المحرك. |

## `@vellum/realtime`

**المسؤولية:** الوقت الفعلي الأصلي في PostgreSQL — موزّع البوابة (معالجة الإطارات، سجل الاشتراكات، النشر للجميع)، ومستقصِص outbox الدائم الكاشف للفجوات، وحافلة/مصنع بنية `LISTEN/NOTIFY`. بلا وسيط؛ عميل LISTEN واحد مخصص غير مجمّع.

| التصدير | التوقيع / الشكل | الدلالة |
| :--- | :--- | :--- |
| `RealtimeGatewayHub` | `class` — `createConnectionSession(sendFrameCallback): ConnectionSessionHandle`؛ `handleClientFrame(connectionId, rawFrame)`؛ `notifyCommittedEvents(projectId, projectId, events)` | مُعدِّد WebSocket، مصادقة، اشتراك/استئناف، نشر للجميع، وحماية من المستهلك البطيء. `MAX_REPLAY_EVENTS = 5000`. |
| `OutboxPoller` | `class` — `start()`، `stop()`، `getWatermark(projectId)`، `handleNotification(payload)`، `discoverTenants()`، `stats` | يستقصي outbox بدُفعات 500 صف (افتراضي 1 ثانية)، يكشف الفجوات، ويُلغي تكرار NOTIFY مقابل الاستقصاء. |
| `createPgNotifyBus` | `(options: PgNotifyBusOptions): PgNotifyBus` | اتصال LISTEN مخصص؛ `publishCommittedBatch`، `subscribeTenantChannel`. |
| `createPgRealtimeInfrastructure` | `(options: PgRealtimeInfrastructureOptions): PgRealtimeInfrastructure` | يربط الحافلة بالمستقصِص والموزّع؛ يتطلب `connectionString`. |
| `parseOutboxNotification` | `(payload: string): OutboxNotification \| null` | يُحلل/يتحقق من حمولات `{seqId, projectId, projectId}`. |
| `PG_OUTBOX_CHANNEL` | `"vellum_outbox"` | قناة NOTIFY المعيارية. |
| `assertValidNotifyChannel`، `assertValidNotifyPayload`، `quoteNotifyChannel` | مُتحقِّقات القناة/الحمولة؛ `(channel: string): string` | يفرض حدود 63 بايت للقناة و7,999 بايت للحмولة. |
| types | `ConnectionSession`، `ConnectionSessionHandle`، `SubscriptionRecord`، `PubSubBus`، `PgNotifyBus`، `OutboxFanoutSink`، `RealtimeHubOptions`، `RealtimeServerFrame` | أنواع نطاق الوقت الفعلي (إطارات الخادم من `@vellum/api-contract`). |

## `@vellum/observability`

**المسؤولية:** تسجيل JSON منظّم مع إخفاء الأسرار، وتحديد معدل بالنافذة المنزلقة، وتوليد معرّف الطلب. كل فشل HTTP يمرّ عبر مرشحات الإخفاء في المُسجِّل — ولا تُسجَّل مفاتيح `pk_`/`sk_` الخام أو رموز Bearer أو عناوين قاعدة البيانات أبدًا.

| التصدير | التوقيع | الدلالة |
| :--- | :--- | :--- |
| `createLogger` | `(config?: LoggerConfig): pino.Logger` | مُسجِّل منظّم مدعوم بـ Pino. |
| `StructuredLogger` | `class` — `constructor({service?, sink?}?: LoggerConfig)` | مُسجِّل داخل العملية بمدخلات `entries` مُلتقَطة؛ تستخدمه خدمة API. |
| `redactSensitiveData` | `(input: unknown): unknown` | يُخفي الحقول/القيم الحساسة بشكل متكرر قبل التسجيل. |
| `SlidingWindowRateLimiter` | `class implements RateLimiter` — `checkAndConsume(keyPrefix: string, limitRps = 100, nowMs = Date.now()): {remaining: number}` | نافذة منزلقة لكل مفتاح؛ تُستخدم على مستوى المستندات العام. |
| `generateRequestId` | `(): string` | معرّف `req_<24 hex>` يُرفق بكل استجابة ومغلّف خطأ. |
| types | `LoggerConfig`، `LogEntry`، `RateLimiter` | عقود المراقبة. |

## مرجع سريع

- [مستوى التحكم والكونسول عبر REST](./rest-control-plane.md) · [مستوى البيانات عبر REST](./rest-data-plane.md) · [بروتوكول الوقت الفعلي](./realtime-protocol.md)
- [تنسيق الإرسال وقواعد المسارات](./wire-format.md) · [الأخطاء](./errors.md)
- الدليل المعماري: [01 — المعمارية](../../../01-architecture.md)
