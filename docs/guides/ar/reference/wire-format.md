---
title: تنسيق الإرسال الموسوم وقواعد المسارات
order: 4
group: المرجع
description: الأنواع الموسومة المعيارية $t/$v، وتحويلات الحقول $op، وقواعد المسارات وحدود v1 الثابتة للحجم والعمق.
---

# تنسيق الإرسال الموسوم وقواعد المسارات

المصدر المعتمد: `packages/core/src/{wire-format,paths,limits,sort-key}.ts` و`packages/api-contract/src/schemas/documents.ts` و`docs/02-wire-format-and-paths.md`. هذه صفحة مرجعية مختصرة ومعتمدة؛ أما الدوافع التصميمية فراجع [المسارات المعيارية وتنسيق الإرسال الموسوم](../../../02-wire-format-and-paths.md).

## لماذا الوسوم

لا يملك JSON أنواعًا أصلية لـ int64 أو الطوابع الزمنية أو البايتات أو المراجع أو النقاط الجغرافية. لذلك تستخدم VELLUM غلافًا محجوزًا `{"$t": "<tag>", "$v": <value>}` حتى لا تتصادم الأنواع الموسعة مع خرائط المستخدم. وتُخزَّن القيم الأولية (`null`، boolean، string، number محدود، array، map عادي) **دون وسم** حتى تستطيع فهارس GIN في PostgreSQL `jsonb` معالجتها مباشرة. منشئات TypeScript موجودة في `WireValue` (`@vellum/core`)، وتكشف مجموعة Dart عن `VellumWire`.

## الأنواع الموسومة المعيارية

| النوع المنطقي | `$t` | `$v` | التحقق |
| :--- | :--- | :--- | :--- |
| int64 | `"int"` | نص عشري، مثل `"-9007199254740993"` | يجب أن يطابق `/^-?\d+$/` ويقع في `[-2^63, 2^63−1]` |
| طابع زمني | `"ts"` | نص ISO-8601 UTC، مثل `"2026-11-15T14:30:00.123Z"` | يجب أن ينجح `Date.parse`. حقل `$ms` اختياري (مللي ثانية epoch محدودة). عند الكتابة يُضاف `$ms` ويُوحَّد دائمًا عبر `new Date(ms).toISOString()`. |
| مرجع | `"ref"` | نص مسار مستند، مثل `"users/u_123"` | يجب أن يجتاز `parseDocumentPath` |
| بايتات | `"bytes"` | نص Base64 قياسي، مثل `"SGVsbG8="` | يجب أن يطابق تعبير Base64 النمطي RFC 4648 |
| نقطة جغرافية | `"geo"` | `{ "lat": 30.0444, "lng": 31.2357 }` | `lat` محدود ∈ [−90,90]، و`lng` ∈ [−180,180] |
| خريطة مستخدم مُهرَّبة | `"map"` | كائن عادي | تلقائيًا عندما يحتوي كائن المستخدم حرفيًا على المفتاح `$t`؛ يُغلَّف كـ `{"$t":"map","$v":{...}}` |

أمثلة:

```json
{ "big": { "$t": "int", "$v": "9007199254740993" } }
{ "when": { "$t": "ts", "$v": "2026-11-15T14:30:00.123Z", "$ms": 1794753000123 } }
{ "owner": { "$t": "ref", "$v": "users/u_123" } }
{ "blob": { "$t": "bytes", "$v": "SGVsbG8=" } }
{ "loc": { "$t": "geo", "$v": { "lat": 30.0444, "lng": 31.2357 } } }
{ "$t": "user_custom" }  →  { "$t": "map", "$v": { "$t": "user_custom" } }
```

:::note أسماء مستعارة قديمة مقبولة في الإدخال
يُوحِّد `@vellum/api-contract` الأسماء المستعارة السابقة للإصدار v1 قبل التحقق: `$t: "time"` → `$t: "ts"`، و`$v.latitude` / `$v.longitude` للنقطة الجغرافية → `$v.lat` / `$v.lng`. وتستخدم المستندات المُتحقَّق منها والمُعادة الصيغة المعيارية دائمًا.
:::

### التحقق والتوحيد

- `validateWireValue(value, depth, allowFieldOps)` يمرّ عبر كل قيمة بشكل متكرر. الأعداد غير المحدودة (`NaN`، `Infinity`) → `INVALID_ARGUMENT`.
- أي كائن يحتوي على `$t` يُعامل كغلاف موسوم؛ والوسوم غير المعروفة → `INVALID_ARGUMENT`. وأي كائن يحتوي على `$op` يُعامل كتحويل حقل؛ و`allowFieldOps:false` → `INVALID_ARGUMENT`.
- تُتحقَّق مفاتيح الخرائط العادية عبر `validateFieldName`: غير فارغة، ≤256 حرفًا، بلا أحرف تحكم → `INVALID_FIELD_NAME`.
- يضمن `canonicalizeTimestamps` أن كل قيمة `ts` تحمل زوجًا متسقًا من `$v`/`$ms`.
- يفرض `normalizeAndValidateDocumentData` أن تكون بيانات المستوى الأعلى خريطة عادية (بلا `$t`/`$op` في الجذر)، ويتحقق من العمق، ثم يقيس `Buffer.byteLength(JSON.stringify(normalized))` مقابل حد 1 MiB → `DOCUMENT_TOO_LARGE`.

## تحويلات الحقول الذرية (`$op`)

تُقبل فقط حيث يختار المحرك تشغيلها — `PATCH` و`PUT` مع `merge:true` و`batchWrite` و`transactions:commit`. أمّا الإنشاء العادي بـ `POST` فيرفضها.

| `$op` | المعاملات | التأثير | خطأ عند إدخال غير صالح |
| :--- | :--- | :--- | :--- |
| `serverTimestamp` | — | يُستبدل بطابع الوقت الحالي لمعاملة الخادم (`$t:"ts"`) | — |
| `inc` (الاسم المستعار `increment`) | `by` (أو `value`)، number محدود | يضيف إلى number محدود موجود؛ ويُهيّئ القيمة إلى `by` إن كانت مفقودة | `INVALID_ARGUMENT`؛ و`FAILED_PRECONDITION` (412) إن كان الحقل الموجود غير رقمي |
| `arrayUnion` | `elements: any[]` | يُلحق العناصر غير الموجودة أصلًا (مساواة قيمة موسومة عميقة) | `INVALID_ARGUMENT` إن كان `elements` مفقودًا |
| `arrayRemove` | `elements: any[]` | يزيل كل التطابقات لأي عنصر | `INVALID_ARGUMENT` إن كان `elements` مفقودًا |
| `deleteField` | — | يزيل الخاصية المستهدفة من خريطتها الأصلية | — |

مساعدات العميل: `fieldOp` في JS (`@vellum/sdk-js`) و`FieldOp` / `FieldValue` في Dart (`vellum_flutter`). يستخدم مخطط Zod (`TaggedFieldTransformSchema`) الحقل `$v` للحمولة (`increment`/`arrayUnion`/`arrayRemove`) بينما يقبل مُتحقِّق النواة `by`/`value` و`elements`؛ وتتبع أمثلة الإرسال أعلاه مُتحقِّق النواة الذي يستخدمه المحرك.

## قواعد المسارات

| القاعدة | مسار المستند | مسار المجموعة |
| :--- | :--- | :--- |
| عدد المقاطع | زوجي: 2 أو 4 أو 6 أو 8 أو 10 | فردي: 1 أو 3 أو 5 أو 7 أو 9 |
| معنى العمق | حتى 5 مجموعات متداخلة | حتى 5 مستويات مجموعات |
| البداية/النهاية | بلا `/` في البداية أو النهاية | بلا `/` في البداية أو النهاية |
| المقاطع الفارغة | مرفوضة | مرفوضة |
| النسبي/المحجوز | `.` و`..` و`%2e%2e` و`%2f` مرفوضة | كذلك |
| المحجوز من النظام | أي مقطع يطابق `^__.*__$` مرفوض | كذلك |
| أحرف التحكم | `0x00`–`0x1F` مرفوضة | كذلك |
| حجم المقطع | ≤1,500 بايت UTF-8 | ≤1,500 بايت UTF-8 |

الخطأ لكل المخالفات: `400 INVALID_DOCUMENT_PATH`.

**تفكيك حتمي** — `users/u_123/orders/ord_456`:

| الخاصية | القيمة |
| :--- | :--- |
| `path` | `users/u_123/orders/ord_456` |
| `collectionPath` | `users/u_123/orders` |
| `collectionGroup` | `orders` |
| `documentId` | `ord_456` |
| `pathDepth` | `4` |

## حدود v1 الثابتة

من `SYSTEM_LIMITS` (`@vellum/core`).

| الثابت | القيمة | رمز/حالة التجاوز |
| :--- | :--- | :--- |
| `MAX_DOCUMENT_BYTES` | 1,048,576 (1 MiB) | `DOCUMENT_TOO_LARGE` / 413 |
| `MAX_PATH_DEPTH` | 10 مقاطع | `INVALID_DOCUMENT_PATH` / 400 |
| `MAX_PATH_SEGMENT_BYTES` | 1,500 | `INVALID_DOCUMENT_PATH` / 400 |
| `MAX_OBJECT_NESTING_DEPTH` | 20 | `MAX_NESTING_EXCEEDED` / 400 |
| `MAX_FIELD_NAME_LENGTH` | 256 | `INVALID_FIELD_NAME` / 400 |
| `MAX_BATCH_OPERATIONS` | 100 | `BATCH_SIZE_EXCEEDED` / 400 |
| `MAX_BATCH_PAYLOAD_BYTES` | 5,242,880 (5 MiB) | `PAYLOAD_TOO_LARGE` / 413 |
| `MAX_TRANSACTION_DURATION_MS` | 5,000 | `TRANSACTION_TIMEOUT` / 408 |
| `MAX_WHERE_CLAUSES` | 10 | `QUERY_TOO_COMPLEX` / 400 |
| `MAX_DISJUNCTIVE_VALUES` | 30 | `QUERY_TOO_COMPLEX` / 400 |
| `MAX_ORDER_BY_FIELDS` | 3 | `QUERY_TOO_COMPLEX` / 400 |
| `DEFAULT_QUERY_LIMIT` / `MAX_QUERY_LIMIT` | 50 / 500 | `LIMIT_EXCEEDED` / 400 |
| `MAX_QUERY_RESPONSE_BYTES` | 4,194,304 (4 MiB) | `RESPONSE_TOO_LARGE` / 413 |
| `MAX_QUERY_EXECUTION_MS` | 5,000 | `QUERY_DEADLINE_EXCEEDED` / 504 |
| `MAX_WS_SUBSCRIPTIONS_PER_CONN` | 50 | `SUBSCRIPTION_LIMIT_EXCEEDED` / 400 |
| `MAX_WS_OUTBOUND_BUFFER_BYTES` | 1,048,576 (1 MiB) | `SLOW_CONSUMER_DISCONNECT` / 429 |
| `RULES_AST_MAX_DEPTH` / `RULES_AST_MAX_NODES` | 10 / 100 | `INVALID_ARGUMENT` / 400 |
| `MAX_COMPOSITE_INDEXES_FREE` / `_PRO` | 50 / 200 | فرض حسب الخطة |

## مفاتيح الفرز الثنائية (داخلي)

فهارس المستأجرين المركّبة لا تُصدر `CREATE INDEX` أبدًا. يُشفّر `@vellum/core` كل حقل إلى `sort_key BYTEA` يحفظ الترتيب مع وسوم نوع (`MISSING 0x05`، `NULL 0x0a`، `BOOLEAN 0x10`، `NUMBER 0x20`، `STRING 0x30`، `TIMESTAMP 0x40`، `REFERENCE 0x50`، `BYTES 0x60`، `GEOPOINT 0x70`). وتستخدم الأعداد العائمة وint64 ترميزات big-endian مقلوبة الإشارة ليطابق ترتيب البايتات الترتيب العددي.

## مرجع سريع

- الاستخدام عبر HTTP: [مستوى البيانات عبر REST](./rest-data-plane.md)
- الإطارات التي تحمل `DocumentPayload`: [بروتوكول الوقت الفعلي](./realtime-protocol.md)
- الحالات المعيارية للأخطاء: [الأخطاء](./errors.md)
- مساعدات الإرسال في Dart: [Flutter SDK](../sdks/flutter.md)
