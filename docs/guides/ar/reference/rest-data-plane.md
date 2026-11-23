---
title: واجهة REST العامة لمستوى البيانات
order: 2
group: المرجع
description: عمليات مستندات بمفتاح API فقط: CRUD، الاستعلام، batchWrite، معاملات OCC، الفهارس وعرض المجموعات تحت /v1/projects/:projectId.
---

# واجهة REST العامة لمستوى البيانات

مستوى المستندات العام مُنفَّذ مباشرة في `apps/api/src/app.ts`. إنه **السطح الوحيد** الذي يقرأ مستندات العملاء ويكتبها. كل عملية محدودة النطاق بـ `(projectId)` من URL وتُصادَق بمفتاح API. أما منطق العمل (التحقق، تقييم القواعد، SQL) فيقع في `@vellum/query-engine` و`@vellum/document-engine` و`@vellum/storage` — ولا في معالجات المسارات أبدًا.

## تحديد نطاق المستأجر والمصادقة

كل مسار في هذا القسم له الشكل:

```text
/v1/projects/:projectId/...
```

| الشرط | التفاصيل |
| :--- | :--- |
| `:projectId` | معرّف UUID للمشروع. يُحلَّ عبر `controlStore.getProject`. |
| مفتاح API | **إلزامي.** الترويسة `X-Project-Key`. غيابه → `401 UNAUTHENTICATED`. يجب أن يخص المفتاح المشروع **والبيئة** المُعنوَنين، وإلا `403 PERMISSION_DENIED`. |
| JWT للمستخدم النهائي | اختياري: `Authorization: Bearer <JWT>`. عند وجوده يجب أن يكون JWT موقعًا صالحًا (`verifyEndUserJwtSync`)؛ وإلا `401`. وتصبح مطالباته (claims) هي `authContext` الذي تستخدمه قواعد الأمان. |
| حالة المشروع | `suspended` → `403 PERMISSION_DENIED`؛ و`throttled` → `429 RATE_LIMITED`. |
| حد المعدل | يُفرَض لكل بادئة مفتاح عبر المُحدِّد ذي النافذة المنزلقة عند `rateLimitRps` الخاص بالمفتاح. |

:::warning
مفتاح API الخام (`pk_…` / `sk_…`) سرّ. لا تضعه أبدًا في سلسلة استعلام URL أو سجل أو حزمة عميل مرئية لمستخدمين غير موثوقين. أرسله فقط في الترويسة `X-Project-Key` عبر TLS.
:::

## ملخص نقاط النهاية

| الطريقة | المسار | النطاق / القواعد المطلوبة | الوصف |
| :--- | :--- | :--- | :--- |
| `GET` | `/v1/projects/:projectId/documents/*` | `documents:read` + القواعد `get`/`list` | قراءة مستند (عدد مقاطع زوجي) أو عرض مجموعة (عدد مقاطع فردي) |
| `POST` | `/v1/projects/:projectId/documents/*` | `documents:write` + القواعد `create` | إنشاء مستند (يفشل بـ `409 ALREADY_EXISTS` إن كان موجودًا) |
| `PUT` | `/v1/projects/:projectId/documents/*` | `documents:write` + القواعد `create`/`update` | استبدال (`merge:false`) أو دمج عميق (`merge:true`) |
| `PATCH` | `/v1/projects/:projectId/documents/*` | `documents:write` + القواعد `update` | تعديل حقول وتطبيق تحويلات `$op` الذرية |
| `DELETE` | `/v1/projects/:projectId/documents/*` | `documents:write` + القواعد `delete` | حذف ناعم (شاهد قبر + حدث في outbox) |
| `POST` | `/v1/projects/:projectId/query` | `documents:read` + القواعد `list` | استعلام منظّم بـ `where` و`orderBy` و`limit` و`select` ومؤشر |
| `POST` | `/v1/projects/:projectId/batchWrite` | `documents:write` + القواعد | حتى 100 تعديل ذري |
| `POST` | `/v1/projects/:projectId/documents:batchWrite` | `documents:write` + القواعد | اسم مستعار لـ `batchWrite` |
| `POST` | `/v1/projects/:projectId/transactions:begin` | `documents:read` | إصدار رمز OCC موقع باسم `transactionToken` |
| `POST` | `/v1/projects/:projectId/transactions:commit` | `documents:write` + القواعد | التحقق من إصدارات مجموعة القراءة والإيداع ذريًا |
| `GET` | `/v1/projects/:projectId/indexes` | `sk_` مع `indexes:manage` | عرض الفهارس المركّبة وحالات بنائها |
| `POST` | `/v1/projects/:projectId/indexes` | `sk_` مع `indexes:manage` | تسجيل/بناء فهرس مركّب |
| `DELETE` | `/v1/projects/:projectId/indexes/:indexId` | `sk_` مع `indexes:manage` | حذف الفهرس ومداخله |
| `GET` | `/v1/projects/:projectId/collections` | `documents:read` | عرض مسارات المجموعات المميزة (مساعد لـ Studio) |

المسار بعد `/documents/` يُفَكَّ ترميزه عبر `decodeURIComponent` من URL. وتتكفل تماثلية عدد المقاطع بتحديد المستند مقابل المجموعة تلقائيًا.

## قواعد المسارات المعيارية

تتبع مسارات المستندات والمجموعات القواعد النحوية في [تنسيق الإرسال وقواعد المسارات](./wire-format.md). وتُفرَض عبر `parseDocumentPath` / `parseCollectionPath` في `@vellum/core`:

| القاعدة | مسار المستند | مسار المجموعة |
| :--- | :--- | :--- |
| عدد المقاطع | زوجي، 2–10 | فردي، 1–9 |
| أمثلة | `users/u_123`، `users/u_123/orders/ord_456` | `users`، `users/u_123/orders` |
| `/` في البداية/النهاية | مرفوض | مرفوض |
| مقطع فارغ | مرفوض | مرفوض |
| `.`، `..`، `%2e%2e`، `%2f` | مرفوض | مرفوض |
| المقاطع المحجوزة `__…__` | مرفوض | مرفوض |
| أحرف التحكم ASCII `0x00`–`0x1F` | مرفوض | مرفوض |
| الحد الأقصى لطول المقطع | 1,500 بايت UTF-8 | 1,500 بايت UTF-8 |

أي مخالفة → `400 INVALID_DOCUMENT_PATH`. التفكيك المعياري لـ `users/u_123/orders/ord_456`: `path` = المسار نفسه، `collectionPath` = `users/u_123/orders`، `collectionGroup` = `orders`، `documentId` = `ord_456`، `pathDepth` = 4.

## CRUD للمستندات

أشكال الطلب/الاستجابة من `packages/api-contract/src/schemas/documents.ts`:

- `CreateDocumentRequestSchema`: `{ data: object }`
- `SetDocumentRequestSchema`: `{ data: object, merge?: boolean }`
- `UpdateDocumentRequestSchema`: `{ data: object, preconditions?: { exists?, version?, lastUpdateTime? } }`
- `DocumentPayloadSchema` (المستند المُعاد): `{ path, collectionPath, collectionGroup, documentId, data, sizeBytes?, version, createdAt, updatedAt }`

معالجات المسار تقبل `{ data }` **أو كائن بيانات مجرّد** (`body.data ?? body`).

| الطريقة | الطلب | الاستجابة | أخطاء ملحوظة |
| :--- | :--- | :--- | :--- |
| `GET` | `?limit=<n>&startAfter=<cursor>` (للمجموعة فقط)، أو `?transactionToken=`/`?txToken=`/`x-transaction-token` (للمستند فقط) | كائن المستند، أو نتيجة استعلام `{ documents, nextCursor, hasMore, executionStats? }` | `INVALID_DOCUMENT_PATH`، `NOT_FOUND`، رفض القواعد |
| `POST` | `{ data }` | `201` المستند المُنشأ | `ALREADY_EXISTS`، `INVALID_DOCUMENT_PATH`، `DOCUMENT_TOO_LARGE` |
| `PUT` | `{ data, merge?, ifVersion? }` | `200` المستند المحفوظ | `FAILED_PRECONDITION` (412) عند عدم تطابق `ifVersion`، `MAX_NESTING_EXCEEDED`، `INVALID_FIELD_NAME` |
| `PATCH` | `{ data, ifVersion? }` | `200` المستند المُحدَّث | `FAILED_PRECONDITION`، `INVALID_ARGUMENT` (`$op` غير صالح) |
| `DELETE` | `?ifVersion=<n>` | `200` نتيجة الحذف | `FAILED_PRECONDITION`، `NOT_FOUND` |

التحويلات الذرية (`$op`: `serverTimestamp`، `inc`/`increment`، `arrayUnion`، `arrayRemove`، `deleteField`) مقبولة في `PUT` (مع دمج) و`PATCH` و`batchWrite` و`transactions:commit`، لكنها مرفوضة في سياقات الإنشاء العادية بـ `POST`. راجع [تنسيق الإرسال](./wire-format.md) و[الدليل السردي لواجهة REST](../rest-api.md).

## الاستعلام (`POST …/query`)

`QuerySpecSchema` (`packages/api-contract/src/schemas/queries.ts`):

| الحقل | النوع | القواعد |
| :--- | :--- | :--- |
| `collectionPath` | string (مسار مجموعة معياري) | حصري مع `collectionGroup`؛ أحدهما مطلوب |
| `collectionGroup` | string (min 1) | حصري مع `collectionPath` |
| `where` | `{field, op, value}[]` | حتى 10؛ و`op` ∈ `==`، `!=`، `<`، `<=`، `>`، `>=`، `in`، `not-in`، `array-contains`، `array-contains-any` |
| `orderBy` | `{field, direction:"asc"\|"desc"}[]` | حتى 3 |
| `limit` | int | من 1 إلى 500، الافتراضي 50 |
| `cursor`، `startAt`، `startAfter`، `endAt`، `endBefore` | string / array | مؤشرات HMAC-SHA256 غير شفافة أو مصفوفات حدود؛ و`document_id ASC` هو الفاصل الحاسم الأخير |
| `select` | string[] | إسقاط الحقول المختارة |

استجابة `QueryResponseSchema`: `{ documents: object[], nextCursor: string|null, hasMore: boolean, executionStats?: { scannedCount?, matchedCount?, executionDurationMs?, indexUsed? } }`.

الأخطاء: `QUERY_TOO_COMPLEX` (>10 `where`، >3 `orderBy`، أو >30 قيمة منفصلة)، `LIMIT_EXCEEDED` (limit >500)، `INVALID_CURSOR` (مؤشر مشوّه أو مُتلاعب به)، `RESPONSE_TOO_LARGE` (>4 MiB)، `QUERY_DEADLINE_EXCEEDED` (>5 ثوانٍ، 504). ترقيم الصفحات بالمؤشر هو النمط الوحيد — لا يُعرَض SQL `OFFSET` أبدًا.

## الكتابة الدُفعية

`POST …/batchWrite` (أو `…/documents:batchWrite`). الجسم: `{ writes }` أو `{ operations }` — مصفوفة من `BatchOperationSchema`:

```json
{
  "operations": [
    { "type": "create", "path": "users/u_1", "data": { "name": "Ada" } },
    { "type": "update", "path": "counters/c_1", "data": { "n": { "$op": "inc", "by": 1 } } }
  ]
}
```

`type` ∈ `create` / `set` / `update` / `delete`؛ وتتطلب أنواع الكتابة حقل `data`. يُدعم كلٌ من `options?: { merge?: boolean }` و`precondition?: { exists?, version?, lastUpdateTime? }`. الحد الأقصى 100 عملية و5 MiB إجمالي الحمولة. الاستجابة `{ results:[{path,version,updatedAt}], commitTimestamp }`. الأخطاء: `BATCH_SIZE_EXCEEDED`، `PAYLOAD_TOO_LARGE`، `ABORTED_CONFLICT`.

## معاملات OCC

1. `POST …/transactions:begin` → `{ transactionToken, expiresAt }`. نافذة صلاحية الرمز: 5,000 مللي ثانية (`MAX_TRANSACTION_DURATION_MS`).
2. القراءة داخل اللقطة: `GET …/documents/*?transactionToken=<token>`.
3. `POST …/transactions:commit` مع `{ transactionToken, writes }` (يقبل المسار أيضًا `mutations`، و`ifVersion`/`preconditions`/`precondition` لكل عملية كتابة). يمكن تقديم القراءات كـ `reads:[{path,readVersion}]` في مخطط العقد.

يتحقق الإيداع من إصدارات مجموعة القراءة باستخدام `SELECT … FOR UPDATE` بترتيب `path ASC` حتمي. الأخطاء: `TRANSACTION_TIMEOUT` (408) عند انتهاء النافذة، و`ABORTED_CONFLICT` (409) عند عدم تطابق الإصدار — أعد محاولة المعاملة كاملة بتراجع عشوائي (jittered backoff). راجع [قرار OCC](../../../decisions/ADR-002-occ-transaction-tokens.md).

## الفهارس المركّبة

| الطريقة | الطلب | الاستجابة | الأخطاء |
| :--- | :--- | :--- | :--- |
| `GET` | — | `{ indexes: CompositeIndex[] }` | `PERMISSION_DENIED` (النطاق) |
| `POST` | `{ collectionPath, fields:[{fieldPath, order?}], name? }` | `201CompositeIndex` | `INVALID_ARGUMENT`، `INVALID_DOCUMENT_PATH` |
| `DELETE` | — (`/:indexId`) | `{ deleted:true, indexId }` | `NOT_FOUND` |

تتطلب نقاط النهاية نطاق `indexes:manage` الذي تحمله مفاتيح الخادم (`sk_`) فقط. تُخزَّن فهارس المستأجرين كصفوف في `document_indexes` وتُحفظ في `document_index_entries` عبر مفاتيح فرز ثنائية — **ولا يُصدر أي `CREATE INDEX` على جدول `documents` المشترك**.

## دورة حياة المجموعات (Collections)

المجموعات صفوف دائمة في الجدول `data_db.project_collections` مع سياسات RLS مفعّلة وقسرية (`ENABLE` + `FORCE`)، وليست عرضاً عابراً ناتجاً عن `DISTINCT`. المجموعة موجودة حتى وهي خالية من المستندات، وإعداداتها تبقى بعد حذف المستندات وبعد تحديث الصفحة (F5) أو إعادة تشغيل الخادم. بيانات المجموعات القديمة نُقلت من `documents.collection_path` عند تشغيل الترحيل `0009_project_collections.sql`.

مستوى البيانات العام هو السطح الوحيد الموثّق:

| السطح | المسار الأساسي | المصادقة |
| :--- | :--- | :--- |
| مستوى البيانات العام | `/v1/projects/:projectId/collections…` | مفتاح API في الرأس `x-vellum-api-key` (ويُقبل `x-project-key` القديم) |

كل شيء مقيد بزوجي `(projectId)`، وكل تعديل يُسجَّل في سجل التدقيق (`collection.create|update|clear|delete`). عمليات التعديل تتطلّب **مفتاح خادم `sk_`**؛ مفاتيح `pk_` العامة تسمح بالقراءات الثلاث فقط (سرد المجموعات، قراءة واحدة، التصدير). أي مفتاح مفقود أو من نوع خاطئ يُنتج `403 PERMISSION_DENIED`.

### نقاط النهاية الثمانية

يقبل المسار الأساسي اللواحق التالية؛ الحرف «م» يشير إلى التعديلات التي تحتاج `sk_`.

| الطريقة | اللاحقة | المصادقة | الاستجابة |
| :--- | :--- | :--- | :--- |
| `GET` | `/collections` | `pk_` أو `sk_` | `{ collections: CollectionWithStats[], nextCursor: string \| null }` |
| `POST` | `/collections` | `sk_` (م) | `201CollectionRecord` |
| `GET` | `/collections/:name` | `pk_` أو `sk_` | `CollectionWithStats \| null` (المفقودة → `null` في الحزم البرمجية) |
| `PATCH` | `/collections/:name` | `sk_` (م) | `CollectionWithStats` |
| `POST` | `/collections/:name/clear` | `sk_` (م) | `{ deletedCount, freedBytes }` |
| `DELETE` | `/collections/:name` | `sk_` (م) | `{ deletedCollection, deletedDocuments, freedBytes }` |
| `POST` | `/collections/:name/import` | `sk_` (م) | `{ importedCount, skippedCount, errors: [{ index, message }] }` |
| `GET` | `/collections/:name/export` | `pk_` أو `sk_` | `{ documents: ExportedDocument[], nextCursor: string \| null }` |

يمدّ `CollectionWithStats` صف السجل بإحصاءات حيّة: `documentCount` و`storageBytes` و`lastDocumentAt`.

### معاملات استعلام السرد

يقبل `GET …/collections` المعاملات `search` و`limit` و`cursor`:

- `search` — تطابق جزئي اختياري على اسم المجموعة (بحد أقصى 256 حرفاً).
- `limit` — عدد صحيح من 1 إلى 500، **الافتراضي 50**. استخدم `limit=500` لرؤية كل المجموعات عند وجود أكثر من 50 مجموعة؛ وتابع الصفحات التالية عبر `nextCursor`، ثم مرّره في `cursor=`.
- `cursor` — مؤشر مواربة معتم، يُعاد كـ `nextCursor`؛ لا تُنشئه أو تعدّله يدوياً.

### أسماء المجموعات وإعداداتها

يجب أن يتطابق `name` مع النمط `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` وبطول 1–128 حرفاً — دون `/` في الطرفين، أو `..`، أو مسافات/محابط تحكم، أو البادئة المحجوزة `__internal__`. إنشاء مكرر آمن مع `{"ifNotExists": true}`.

تقبل `POST` / `PATCH` الحقول التالية فقط (أي حقل غير معروف يُنتج `400 INVALID_ARGUMENT`):

| الحقل | النوع | المعنى |
| :--- | :--- | :--- |
| `description` | `string` (≤ 2048 حرفاً)، قابل للـ null في PATCH | ملاحظة للقارئ؛ القيمة `null` تُمسح. |
| `defaultTtlSeconds` | عدد صحيح موجب ≤ 2,147,483,647، قابل للـ null في PATCH | مدة انتهاء تُطبَّق على المستندات التي لا تحمل `expiresAt` / `ttlSeconds`. |
| `schemaValidation` | `{ requiredFields?: string[], strict?: boolean }`، قابل للـ null في PATCH | يُفرض `requiredFields` عند الكتابة ويُنتج `400 INVALID_ARGUMENT` عند غيابه. |
| `metadata` | كائن | حزمة قيم يعرّفها المستدعي. |
| `ifNotExists` | منطقي، في `POST` فقط | إعادة الصف الموجود بدلاً من `409 ALREADY_EXISTS`. |

### مسح المجموعة مقابل حذفها

- **المسح** (`POST …/:name/clear`) يحذف كل مستندات المجموعة حذفاً ناعماً (قبور tombstone وأحداث في صندوق بريد الوقت الفعلي) لكنه **يُبقي صف المجموعة وكل إعداداتها**. يُعيد `{ "deletedCount": 12, "freedBytes": 4096 }`.
- **الحذف** (`DELETE …/:name`) يُزيل تسجيل المجموعة **و** كل مستنداتها. يُعيد `{ "deletedCollection": true, "deletedDocuments": 12, "freedBytes": 4096 }`.

كلتا العمليتين تُقيَّس (`recordDeletes`) وتُضيف سجل تدقيق متسلسل المشفّر، ولا تُعدّ عملية استرجاع.

### صيغ الاستيراد والتصدير

يقبل `POST …/:name/import` **إما مصفوفة JSON تضم 500 كائن كحد أقصى**، كل منها `{ "id"?: string, "data": { … } }، أو غلاف الحزم البرمجية `{ "documents": […], "mode": "upsert" | "insert_only" }`. يصبح `id` معرّف المستند، وإذا غاب يُنشئ الخادم UUID. العناصر غير الصالحة تُتخطى بدلاً من إفشال الدفعة، ويُبلَّغ عن كل فشل بفهرسه ابتداءً من صفر برسالة آمنة (بلا رؤوس أو مفاتيح أو أسرار):

```json
[
  { "id": "u_1", "data": { "name": "Ada", "email": "ada@example.com" } },
  { "data": { "name": "Grace" } }
]
```

```json
{ "importedCount": 2, "skippedCount": 0, "errors": [] }
```

يُصفّي `GET …/:name/export` النتائج حتمياً حسب `path ASC` ويُعيد لكل مستند الحقول `id` و`path` و`data` و`version` و`createdAt` و`updatedAt` مع `nextCursor` (أو null عند النهاية). لا يُستخدم `OFFSET` إطلاقاً.

تغلّف الحزم البرمجية الرسمية هذه الطلبات بالدوال `importDocuments(collection, docs, { mode })` و`exportDocuments(collection, { limit, cursor })` — راجع [حزمة JavaScript](../../../08-sdk-js-guide.md#10-collections-lifecycle) و[حزمة Flutter](../../../09-sdk-flutter-guide.md#9-collections-lifecycle).

## مرجع سريع

- الاشتراك/اللقطات/الاستئناف عبر WebSocket: [بروتوكول الوقت الفعلي](./realtime-protocol.md)
- الرموز والحالات المعيارية: [الأخطاء](./errors.md)
- القيم الموسومة وتحويلات الحقول وقواعد المسارات: [تنسيق الإرسال](./wire-format.md)
- الدليل السردي للاستعلام والفهرسة: [الاستعلام والفهرسة](../../../03-query-and-indexing.md)
