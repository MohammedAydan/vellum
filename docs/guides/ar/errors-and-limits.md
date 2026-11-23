---
title: الأخطاء والحدود
order: 12
group: المرجع
description: رموز الأخطاء القياسية مع حالات HTTP، والحصص الثابتة للإصدار 1 التي يفرضها @vellum/core.
---

# الأخطاء والحدود

تستخدم كل الإخفاقات غلافًا قياسيًا واحدًا ومجموعة واحدة من رموز الأخطاء، المعرّفة في `@vellum/core` (`SYSTEM_LIMITS` و`VellumError`). كل استجابة HTTP تحمل أيضًا الترويسة `X-Request-Id`.

## السيناريو

أنت تربط معالجة الأخطاء في العميل وتريد إعادة المحاولة فقط للإخفاقات العابرة: تعارض الإصدار يجب أن يُعيد القراءة والمحاولة، وحد المعدل يجب أن يتراجع باستخدام `Retry-After`، أما خطأ الصلاحيات فيجب أن يظهر للمستخدم. تُفرّع على الحقل `code` القياسي من غلاف الخطأ.

```ts
import { VellumError } from "@vellum/core";

try {
  await db.collection("users").doc("u_123").update({ name: "Ada" }, { ifVersion: 4 });
} catch (err) {
  const e = err as { code?: string; status?: number; details?: Record<string, unknown> };
  switch (e.code) {
    case "FAILED_PRECONDITION": // أعد القراءة وأعد المحاولة بالإصدار الحالي
      break;
    case "ABORTED_CONFLICT": // أعد تشغيل المعاملة كاملة
      break;
    case "PERMISSION_DENIED": // تحقق من النطاقات أو القواعد
      break;
    default:
      throw err;
  }
}
```

## غلاف الخطأ

```json
{
  "error": {
    "code": "FAILED_PRECONDITION",
    "message": "Version precondition failed on 'users/u_123' (expected 4, actual 5)",
    "requestId": "req_01JCK9X2P8...",
    "details": {
      "path": "users/u_123",
      "expectedVersion": 4,
      "actualVersion": 5
    }
  }
}
```

في SDK، تُثير الطلبات الفاشلة خطأ `Error` يحمل `code` و`status` و`details` و`requestId` المنسوخة من الغلاف. الكائن `details` مكتوب كسجل (record) وتختلف مفاتيحه حسب الرمز؛ لا تعتمد على شكل ثابت.

## رموز الأخطاء القياسية

| الرمز | HTTP | السبب المعتاد |
| :--- | :--- | :--- |
| `INVALID_ARGUMENT` | 400 | طلب مشوّه، أو رمز غير مسموح، أو قيمة تهيئة خاطئة. |
| `INVALID_DOCUMENT_PATH` | 400 | عمق مسار خاطئ، أو مقطع طويل جدًا أو محجوز. |
| `INVALID_FIELD_NAME` | 400 | اسم حقل فارغ أو طويل جدًا أو يحتوي أحرف تحكم أو يحاكي تلوث النموذج الأولي. |
| `MAX_NESTING_EXCEEDED` | 400 | تداخل مستند أعمق من 20 مستوى. |
| `BATCH_SIZE_EXCEEDED` | 400 | أكثر من 100 عملية دفعة. |
| `INVALID_CURSOR` | 400 | مؤشر ترقيم صفحي مُتلاعب به أو مشوّه أو من شكل خاطئ. |
| `QUERY_TOO_COMPLEX` | 400 | عدد كبير جدًا من المرشحات/حقول الترتيب، أو تجاوز شجرة القواعد لحدود العمق/العقد. |
| `LIMIT_EXCEEDED` | 400 | `limit` في الاستعلام أكبر من 500. |
| `SUBSCRIPTION_LIMIT_EXCEEDED` | 400 | أكثر من 50 اشتراكًا WebSocket على اتصال واحد. |
| `UNAUTHENTICATED` | 401 | مفتاح API أو رمز مفقود أو مشوّه أو غير صالح أو منتهي أو مُلغى. |
| `PERMISSION_DENIED` | 403 | نطاق مفتاح خادم مفقود، أو قواعد الأمان رفضت العملية. |
| `NOT_FOUND` | 404 | قراءة أو حذف مستند غير موجود. |
| `TRANSACTION_TIMEOUT` | 408 | تجاوزت المعاملة 5 ثوانٍ. |
| `ALREADY_EXISTS` | 409 | `create` على مسار مشغول، أو فهرس مركّب مكرر. |
| `ABORTED_CONFLICT` | 409 | تغيّر إصدار من مجموعة القراءات قبل الإتمام. |
| `FAILED_PRECONDITION` | 412 | عدم تطابق `ifVersion` / `exists`، أو هدف زيادة غير صالح، أو فهرس مطلوب مفقود. |
| `DOCUMENT_TOO_LARGE` | 413 | المستند المتسلسل يتجاوز 1 MiB. |
| `PAYLOAD_TOO_LARGE` | 413 | حمولة الدفعة تتجاوز 5 MiB. |
| `RESPONSE_TOO_LARGE` | 413 | استجابة الاستعلام تتجاوز 4 MiB. |
| `RATE_LIMITED` | 429 | تجاوز حد RPS لكل مفتاح؛ تُضبط الترويسة `Retry-After`. |
| `QUOTA_EXCEEDED` | 429 | تجاوز حصة الخطة. |
| `SLOW_CONSUMER_DISCONNECT` | 429 | تجاوز المخزن الصادر لـ WebSocket 1 MiB. |
| `INTERNAL_ERROR` | 500 | عطل غير متوقع في الخادم. |
| `SERVICE_UNAVAILABLE` | 503 | اعتماد أو مستوى غير متاح. |
| `QUERY_DEADLINE_EXCEEDED` | 504 | تجاوز الاستعلام ميزانية تنفيذه البالغة 5 ثوانٍ. |

:::note
تظهر أسماء قديمة مثل `ABORTED` وبعض الأسماء الأخرى في تعداد api-contract، لكن تسلسل أخطاء وقت التشغيل أعلاه هو المجموعة المعتمدة. يجب أن يفرّع كود العميل على الرموز في هذا الجدول.
:::

```ts
// حدود المعدل تحمل تلميح Retry-After؛ تراجع قبل إعادة المحاولة.
if (e.code === "RATE_LIMITED") {
  const retryAfterMs = Number((e.details as Record<string, unknown>)?.retryAfterMs ?? 1000);
  await new Promise((r) => setTimeout(r, retryAfterMs));
}
```

## حصص الإصدار 1 الثابتة

تأتي هذه الثوابت من `@vellum/coreSYSTEM_LIMITS` وتُفرض عند حدود المحرك.

| الحد | القيمة | خطأ التجاوز |
| :--- | :--- | :--- |
| `MAX_DOCUMENT_BYTES` | 1,048,576 (1 MiB) | `DOCUMENT_TOO_LARGE` (413) |
| `MAX_PATH_DEPTH` | 10 مقاطع (5 مجموعات متداخلة) | `INVALID_DOCUMENT_PATH` (400) |
| `MAX_PATH_SEGMENT_BYTES` | 1,500 بايت | `INVALID_DOCUMENT_PATH` (400) |
| `MAX_OBJECT_NESTING_DEPTH` | 20 مستوى | `MAX_NESTING_EXCEEDED` (400) |
| `MAX_FIELD_NAME_LENGTH` | 256 حرفًا | `INVALID_FIELD_NAME` (400) |
| `MAX_BATCH_OPERATIONS` | 100 عملية | `BATCH_SIZE_EXCEEDED` (400) |
| `MAX_BATCH_PAYLOAD_BYTES` | 5,242,880 (5 MiB) | `PAYLOAD_TOO_LARGE` (413) |
| `MAX_TRANSACTION_DURATION_MS` | 5,000 ms | `TRANSACTION_TIMEOUT` (408) |
| `MAX_WHERE_CLAUSES` | 10 مرشحات | `QUERY_TOO_COMPLEX` (400) |
| `MAX_DISJUNCTIVE_VALUES` | 30 عنصرًا | `QUERY_TOO_COMPLEX` (400) |
| `MAX_ORDER_BY_FIELDS` | 3 حقول | `QUERY_TOO_COMPLEX` (400) |
| `DEFAULT_QUERY_LIMIT` | 50 | — |
| `MAX_QUERY_LIMIT` | 500 | `LIMIT_EXCEEDED` (400) |
| `MAX_QUERY_RESPONSE_BYTES` | 4,194,304 (4 MiB) | `RESPONSE_TOO_LARGE` (413) |
| `MAX_QUERY_EXECUTION_MS` | 5,000 ms | `QUERY_DEADLINE_EXCEEDED` (504) |
| `MAX_WS_SUBSCRIPTIONS_PER_CONN` | 50 | `SUBSCRIPTION_LIMIT_EXCEEDED` (400) |
| `MAX_WS_OUTBOUND_BUFFER_BYTES` | 1,048,576 (1 MiB) | `SLOW_CONSUMER_DISCONNECT` (429) |
| `RULES_AST_MAX_DEPTH` | 10 | `QUERY_TOO_COMPLEX` (400) |
| `RULES_AST_MAX_NODES` | 100 لكل قاعدة | `QUERY_TOO_COMPLEX` (400) |
| الفهارس المركّبة لكل خطة مجاني/احترافي | 50 / 200 | `QUOTA_EXCEEDED` (429) |
| الاحتفاظ بعلامات الحذف | 7 أيام (افتراضي) | — |
| الاحتفاظ بصندوق البريد | 24 ساعة | — |

## معالجة الأخطاء

يُظهر المثال في بداية هذا الدليل التفريع على `e.code`. أما في عملاء HTTP الخام، فاقرأ حقل `error.code` من غلاف JSON والترويسة `X-Request-Id`.

:::tip
أدرج `X-Request-Id` (أو `error.requestId`) دائمًا في تقارير الأخطاء. السجلات مُخفاة، لذا معرّف الطلب هو الطريقة الآمنة لربط حادثة ما دون مشاركة أسرار.
:::

## الأخطاء الشائعة

- **التفريع على حالة HTTP وحدها.** رموز متعددة تشترك في الحالة نفسها (مثل 400)؛ فَرِّع على `code` القياسي.
- **إعادة محاولة كل خطأ.** فقط الرموز العابرة مثل `ABORTED_CONFLICT` و`RATE_LIMITED` آمنة لإعادة المحاولة؛ خطأ الصلاحيات لن يُصلح نفسه.
- **افتراض شكل ثابت لـ `details`.** مفاتيحه تختلف حسب الرمز — عاملها كسجل.
- **تجاهل معرّف الطلب.** بدونه لا يمكن للدعم ربط حادثة مُخفاة بطلبك.

## مثال موثّق

:::example-tabs errors

## ماذا تقرأ بعد ذلك

- [الاستعلام](./query.md) — أخطاء الاستعلامات واقتراحات الفهارس.
- [الكتابات الدفعية والمعاملات](./batch-and-transactions.md) — سلوك التعارض والمهلة.
- [قائمة التحقق للإنتاج](./production-checklist.md) — تحديد المعدل والإخفاء وفحوص الجاهزية.
