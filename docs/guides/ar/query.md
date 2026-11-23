---
title: الاستعلام
order: 6
group: المفاهيم الأساسية
description: المرشحات والترتيب والإسقاط والحدود ومتطلبات الفهارس المركّبة وتجميع SQL وشكل الاستجابة.
---

# الاستعلام

تُجرى الاستعلامات مقابل `collectionPath` واحد داخل نطاق `(projectId)`. يبني SDK مواصفات الاستعلام ويرسلها إلى `/v1/projects/:projectId/query`.

```ts
const page = await db
  .collection("users")
  .where("age", ">=", 18)
  .where("status", "==", "active")
  .orderBy("age", "desc")
  .select("name", "age")
  .limit(25)
  .get();
```

## السيناريو

أنت تبني شاشة إدارة تعرض العملاء المشتركين، مرتبين من الأحدث، وتُظهر اسمهم وخطتهم فقط. تجمع بين مرشح مساواة ومرشح نطاق وترتيب على حقل مخصص، وهو ما يتطلب فهرسًا مركّبًا — ويخبرك الخادم تمامًا بالفهرس المطلوب إن كان غائبًا.

```ts
const customers = await db
  .collection("users")
  .where("plan", "==", "pro")
  .where("createdAt", ">=", "2026-01-01T00:00:00.000Z")
  .orderBy("createdAt", "desc")
  .select("name", "plan")
  .limit(50)
  .get();
```

## عوامل التصفية

| العامل | نوع القيمة | الدلالة |
| :--- | :--- | :--- |
| `==` | قيمة مفردة، طابع زمني، مرجع، null | مساواة تامة مكتوبة. |
| `!=` | قيمة مفردة، طابع زمني، مرجع، null | الحقل موجود وغير مساوٍ. |
| `<`, `<=`, `>`, `>=` | رقم، int64، نص، طابع زمني | مقارنة نطاق مكتوبة داخل العائلة نفسها. |
| `in` | مصفوفة من 1–30 قيمة | الحقل يساوي أي عنصر. |
| `not-in` | مصفوفة من 1–30 قيمة | الحقل موجود ولا يساوي أي عنصر. |
| `array-contains` | عددى، طابع زمني، مرجع | حقل المصفوفة يحتوي القيمة. |
| `array-contains-any` | مصفوفة من 1–30 قيمة | حقل المصفوفة يحتوي قيمة واحدة على الأقل. |

تعمل أسماء حقول خاصة في المرشحات والترتيب: `documentId` (أو `__name__`) لمعرّف المستند، و`createdAt` / `updatedAt` للطوابع الزمنية التي يديرها الخادم.

## الترتيب والإسقاط والحدود

- حتى **10** جمل `where` و**3** جمل `orderBy`. تجاوزها يُثير `QUERY_TOO_COMPLEX`.
- يُلحق `document_id ASC` تلقائيًا كفاصل حسم نهائي، لذا تعود المستندات المتساوية في قيم الترتيب دائمًا بترتيب ثابت.
- يُسقط `select(...fields)` الحقول المحددة فقط من المستوى الأعلى. بدونه تُعاد خريطة `data` كاملة.
- يقبل `limit(n)` القيم 1–500 وافتراضه 50. القيمة الأكبر من 500 تُثير `LIMIT_EXCEEDED`.
- يمكن للمصفوفات الانفصالية (`in`, `not-in`, `array-contains-any`) أن تحمل 30 عنصرًا كحد أقصى.
- استجابة الاستعلام الأكبر من 4 MiB تُثير `RESPONSE_TOO_LARGE`.
- تنفيذ الاستعلام محدد بـ 5 ثوانٍ؛ تجاوزها يُنتج `QUERY_DEADLINE_EXCEEDED`.

أداة بناء الاستعلام غير قابلة للتعديل: تُرجع `where` و`orderBy` و`limit` و`select` و`startAt` و`startAfter` أداة جديدة، لذا يمكنك إعادة استخدام استعلام أساسي بأمان.

```ts
// استعلام أساسي قابل لإعادة الاستخدام؛ كل استدعاء يشتق أداة جديدة.
const base = db.collection("users").where("active", "==", true);
const young = await base.where("age", "<", 30).get();
const seniors = await base.where("age", ">=", 65).get();
```

تُعرّف `toQuerySpec()` الكائن العادي الذي يُرسل على مستوى الأسلاك.

## المؤشرات (cursors)

استخدم `startAt(cursor)` لتضمين صف الحد أو `startAfter(cursor)` لاستبعاده، مع تمرير `nextCursor` من صفحة سابقة:

```ts
const first = await db.collection("users").orderBy("age").limit(50).get();
if (first.nextCursor) {
  const second = await db
    .collection("users")
    .orderBy("age")
    .limit(50)
    .startAfter(first.nextCursor)
    .get();
}
```

المؤشرات موقّعة بـ HMAC ومرتبطة بالشكل الدقيق للاستعلام. إعادة استخدام أحدها بمرشحات أو ترتيب مختلف يُثير `INVALID_CURSOR`. راجع [الترقيم الصفحي](./pagination.md).

## متى يُطلب فهرس مركّب

تستخدم مرشحات المساواة البسيطة الفهارس المدمجة ولا تتطلب إعدادًا. أما الاستعلام الذي يجمع مرشحات نطاق أو حقول ترتيب مخصصة متعددة فيتطلب فهرسًا مركّبًا مطابقًا. إن لم يوجد، يُرجع الخادم `FAILED_PRECONDITION` (412) مع `suggestedIndex` في تفاصيل الخطأ:

```json
{
  "error": {
    "code": "FAILED_PRECONDITION",
    "message": "Query on 'users' requires a composite index for the requested filters and sort order.",
    "details": {
      "collectionPath": "users",
      "suggestedIndex": { "collectionPath": "users", "fields": [{ "path": "status", "dir": "asc" }] }
    }
  }
}
```

:::tip
أنشئ الفهرس المقترح عبر واجهة الفهارس، ثم أعد المحاولة بعد أن تكون حالته `ready`. راجع [الفهارس المركّبة](./indexes.md).
:::

## ملاحظات تجميع SQL

يُجمّع محرك الاستعلام استعلامًا مُتحققًا منه ومُطبَّعًا إلى **SQL مُعلَّم (parameterized)** — دون سلسلة قيم مستخدم مُلصقة. يحدث التجميع والتنفيذ داخل الحزم، وليس في معالجات المسارات مطلقًا:

1. **الفهارس المدمجة صفرية الإعداد** تغطي `(project_id, collection_path, document_id)` و`updated_at` و`created_at`، إضافةً إلى فهرس GIN على `data jsonb_path_ops` لمعاملات الاحتواء (`==`, `in`, `array-contains`).
2. **الفهارس المركّبة** تُحل من صفوف `document_indexes`؛ وتوجد الإدخالات المطابقة في `document_index_entries` بمفتاح `sort_key BYTEA` يحافظ على الترتيب، مما يتيح مسح نطاق B-tree واحدًا.
3. **سياق المستأجر مُربوط** عبر `SET LOCAL` في المعاملة، لذا تُصفّي سياسات RLS في PostgreSQL كل صف.
4. **مسح الاحتياط غير المفهرس** محدد بسقف أمان؛ ولا يُقتطع من النتائج بصمت. غياب فهرس مركّب مطلوب هو خطأ صريح، لا مسح بطيء.

## شكل الاستجابة

```json
{
  "documents": [
    {
      "path": "users/u_123",
      "collectionPath": "users",
      "collectionGroup": "users",
      "documentId": "u_123",
      "data": { "name": "Ada", "age": 36 },
      "sizeBytes": 128,
      "version": 3,
      "createdAt": "2026-11-15T14:30:00.123Z",
      "updatedAt": "2026-11-17T09:00:00.000Z"
    }
  ],
  "nextCursor": null,
  "meta": {
    "count": 1,
    "indexUsed": "primary_btree",
    "executionTimeMs": 1.234,
    "compiledSql": "SELECT ..."
  }
}
```

يُسقط SDK الحقل `documents` إلى `QuerySnapshot.docs` (مع مُوصّل `data()`)، وينسخ `nextCursor` و`meta` إلى اللقطة.

:::note
الحقل `compiledSql` في `meta` هو أداة تصحيح أخطاء. يحتوي على الجملة المجمّعة مع المعلمات مرتبطة بشكل منفصل؛ لا تعامله كعقد يمكن تحليله.
:::

## الأخطاء الشائعة

- **تجاوز حدود الجمل.** أكثر من 10 جمل `where` أو 3 حقول `orderBy` أو حد يتجاوز 500 يُثير `QUERY_TOO_COMPLEX` / `LIMIT_EXCEEDED`.
- **خلط أنواع القيم في النطاق.** تقارن `<` و`<=` و`>` و`>=` داخل العائلة نفسها؛ مقارنة نص برقم لن تُطابق كما تتوقع.
- **إعادة استخدام مؤشر مع استعلام مختلف.** المؤشر مرتبط بالمرشحات والترتيب والمشروع والبيئة؛ تغيير أي منها يُنتج `INVALID_CURSOR`.
- **الاعتماد على `compiledSql`.** إنه حقل تصحيح أخطاء، وليس عقد API مستقرًا.

## مثال موثّق

:::example-tabs query

## ماذا تقرأ بعد ذلك

- [الترقيم الصفحي](./pagination.md) — كيفية توقيع المؤشرات المعتمة وإعادة استخدامها.
- [الفهارس المركّبة](./indexes.md) — إنشاء الفهارس التي قد يحتاجها الاستعلام.
- [الأخطاء والحدود](./errors-and-limits.md) — رموز الأخطاء المتعلقة بالاستعلامات.
