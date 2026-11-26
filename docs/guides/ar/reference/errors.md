---
title: الرموز المعيارية للأخطاء وإرشادات إعادة المحاولة
order: 5
group: المرجع
description: كل رمز خطأ معياري في VELLUM، وحالته HTTP، ومتى يحدث، وما إذا كانت إعادة المحاولة آمنة.
---

# الرموز المعيارية للأخطاء وإرشادات إعادة المحاولة

جميع الأخطاء تستخدم مغلّفًا واحدًا. يُنتج `VellumError.toEnvelope(requestId)` وبرمجية أخطاء HTTP (`apps/api/src/middleware/error-handler.ts`) ما يلي:

```json
{
  "error": {
    "code": "FAILED_PRECONDITION",
    "message": "Version conflict on users/u_123",
    "requestId": "req_...",
    "details": { "path": "users/u_123" }
  }
}
```

`details` اختياري (يُحذف عند كونه فارغًا). ويعكس `requestId` قيمة `X-Request-Id` (أو `req_unknown`). المصدر المعتمد: `packages/core/src/errors.ts` (`ERROR_HTTP_STATUS`، `VellumError`) و`packages/api-contract/src/schemas/errors.ts` (`ErrorCodeEnum`) والقسم 4 من AGENTS.md.

## خريطة الحالات (معتمدة)

| الرمز | HTTP | المُحفِّز المعتاد | إعادة المحاولة؟ |
| :--- | :--- | :--- | :--- |
| `INVALID_ARGUMENT` | 400 | فشل تحقق المخطط/الجسم، `$op` غير صالح، بيئة غير صالحة، `fields` فارغ للفهرس | **لا** — أصلح الطلب |
| `INVALID_DOCUMENT_PATH` | 400 | قواعد مسار خاطئة (تماثلية، مقاطع فارغة/نسبية/محجوزة، مقطع >1,500 بايت) | **لا** |
| `INVALID_FIELD_NAME` | 400 | مفتاح حقل فارغ / >256 حرفًا / يحوي أحرف تحكم | **لا** |
| `MAX_NESTING_EXCEEDED` | 400 | بيانات مستند متداخلة أعمق من 20 مستوى | **لا** |
| `BATCH_SIZE_EXCEEDED` | 400 | دفعة/معاملة تضم >100 عملية | **لا** — قسّم الدفعة |
| `INVALID_CURSOR` | 400 | مؤشر HMAC مشوّه أو مُتلاعب به أو منتهي | **لا** — أعد ترقيم الصفحات من البداية |
| `QUERY_TOO_COMPLEX` | 400 | >10 `where`، >3 `orderBy`، أو >30 قيمة منفصلة | **لا** — بسّط الاستعلام أو أضف فهرسًا |
| `LIMIT_EXCEEDED` | 400 | `limit` >500 (أو <1) | **لا** |
| `SUBSCRIPTION_LIMIT_EXCEEDED` | 400 | >25 اشتراكًا على اتصال WebSocket واحد | **لا** — ألغِ اشتراكًا أو افتح اتصالًا آخر |
| `UNAUTHENTICATED` | 401 | مفتاح API مفقود/غير صالح، JWT مفقود/غير صالح/منتهي، رمز MFA خاطئ، انتهاء مصادقة WS | **لا** — جدّد بيانات الاعتماد ثم أعد المحاولة مرة |
| `PERMISSION_DENIED` | 403 | عدم تطابق المفتاح/المشروع/البيئة، رفض القواعد، وصول عبر مستأجر آخر، مشروع/حساب موقوف | **لا** — التصريح لن يتغير بإعادة المحاولة |
| `NOT_FOUND` | 404 | مستند أو مفتاح API أو مستأجر أو علم ميزة أو مسار مفقود | **لا** |
| `TRANSACTION_TIMEOUT` | 408 | انقضت نافذة OCC (5,000 مللي ثانية) قبل الإيداع | **نعم** — أعد تشغيل المعاملة برمز جديد |
| `ALREADY_EXISTS` | 409 | تسجيل مكرر/إعداد مالك/تسجيل MFA، أو إنشاء مستند وهو موجود | **لا** — استخدم `set`/`put` بدلًا |
| `ABORTED_CONFLICT` | 409 | عدم تطابق إصدار مجموعة القراءة عند الإيداع | **نعم** — أعد محاولة المعاملة كاملة بتراجع full-jitter (حيث تفعل مجموعات SDK ذلك تلقائيًا، بـ5 محاولات افتراضيًا) |
| `FAILED_PRECONDITION` | 412 | عدم تطابق `ifVersion`، هدف `inc` غير رقمي، خطأ حالة إعداد/تحقق MFA | **لا** (إلا بعد إعادة قراءة الحالة أولًا) |
| `DOCUMENT_TOO_LARGE` | 413 | مستند مُسلسَل >1 MiB | **لا** |
| `PAYLOAD_TOO_LARGE` | 413 | حمولة دفعة >5 MiB أو إطار WS كبير جدًا | **لا** — قسّم الحمولة |
| `RESPONSE_TOO_LARGE` | 413 | استجابة استعلام >4 MiB | **لا** — قلّل `limit`/`select` |
| `RATE_LIMITED` | 429 | حد RPS لكل مفتاح، مشروع مُخنَّق، أو تخنيق محاولات MFA | **نعم** — بعد `Retry-After`/التراجع؛ ولا تُدخل حلقة ضيقة أبدًا |
| `QUOTA_EXCEEDED` | 429 | نفدت حصة الخطة/المستأجر | **لا** حتى تُرفع الحصة أو يُعاد ضبط الاستخدام |
| `SLOW_CONSUMER_DISCONNECT` | 429 | مخزن إخراج WebSocket >1 MiB | **لا** — يجب على المستهلك التفريغ أسرع؛ الاتصال مغلق |
| `INTERNAL_ERROR` | 500 | فشل ثابت/سلامة من جهة الخادم (مثل سلامة سر MFA) | **أعد المحاولة مرة** بتراجع؛ وإن استمر فابلّغ مع `requestId` |
| `SERVICE_UNAVAILABLE` | 503 | فشل تبعية/فحص (مثل فشل فحص الجاهزية) | **نعم** — بعد تراجع، مع موعد نهائي |
| `QUERY_DEADLINE_EXCEEDED` | 504 | تجاوز الاستعلام `MAX_QUERY_EXECUTION_MS` (5,000 مللي ثانية) | **نعم** — ضيّق الاستعلام / أضف فهرسًا |

## رموز موجودة في `ErrorCodeEnum` دون خريطة حالة في النواة

يُعلن مخطط Zod `ErrorCodeEnum` (في api-contract) أيضًا عن `ABORTED` و`RESOURCE_EXHAUSTED` و`DEADLINE_EXCEEDED` و`UNAVAILABLE` و`INTERNAL`. هذه **ليست** مفاتيح في `ERROR_HTTP_STATUS` في `@vellum/core` ولا يمكن إنشاء `VellumError` بها. إذا وصل أحدها إلى برمجية أخطاء HTTP فإنه يسقط في الفرع `?? 500` (الحالة 500)؛ أما الخطأ العام غير المُعالَج فيُسلسَل كـ `code:"INTERNAL"` بالحالة 500. فضّل المكافئات المُخرَطة أعلاه (`ABORTED_CONFLICT`، `RATE_LIMITED`/`QUOTA_EXCEEDED`، `QUERY_DEADLINE_EXCEEDED`، `SERVICE_UNAVAILABLE`، `INTERNAL_ERROR`) في الكود الجديد.

:::note `INTERNAL` مقابل `INTERNAL_ERROR`
كلاهما قد يظهر على الإرسال بالحالة 500. و`INTERNAL_ERROR` هو الرمز المعياري لـ `VellumError` (له خرطة 500 صريحة)؛ أمّا `INTERNAL` فهو رمز المغلّف الاحتياطي للاستثناءات غير المتوقعة. عامل الاثنين كـ"عطل في الخادم، أعد المحاولة بقتار وأدرج `requestId` في أي بلاغ."
:::

## خريطة الحدود → الأخطاء

| الحد | القيمة | الخطأ / الحالة |
| :--- | :--- | :--- |
| بايتات المستند | 1 MiB | `DOCUMENT_TOO_LARGE` / 413 |
| عمق المسار | 10 مقاطع | `INVALID_DOCUMENT_PATH` / 400 |
| بايتات مقطع المسار | 1,500 | `INVALID_DOCUMENT_PATH` / 400 |
| تداخل الكائنات | 20 | `MAX_NESTING_EXCEEDED` / 400 |
| طول اسم الحقل | 256 | `INVALID_FIELD_NAME` / 400 |
| عمليات الدفعة | 100 | `BATCH_SIZE_EXCEEDED` / 400 |
| حمولة الدفعة | 5 MiB | `PAYLOAD_TOO_LARGE` / 413 |
| مدة المعاملة | 5,000 مللي ثانية | `TRANSACTION_TIMEOUT` / 408 |
| جمل where | 10 | `QUERY_TOO_COMPLEX` / 400 |
| القيم المنفصلة | 30 | `QUERY_TOO_COMPLEX` / 400 |
| حقول الترتيب | 3 | `QUERY_TOO_COMPLEX` / 400 |
| حد الاستعلام | 500 (الافتراضي 50) | `LIMIT_EXCEEDED` / 400 |
| استجابة الاستعلام | 4 MiB | `RESPONSE_TOO_LARGE` / 413 |
| اشتراكات WS/الاتصال | 25 | `SUBSCRIPTION_LIMIT_EXCEEDED` / 400 |
| مخزن إخراج WS | 1 MiB | `SLOW_CONSUMER_DISCONNECT` / 429 |

## سياسة إعادة المحاولة بنظرة سريعة

| آمن إعادة المحاولة (مع تراجع) | أعد المحاولة فقط بعد تغيير شيء ما | لا تُعد المحاولة أبدًا بشكل أعمى |
| :--- | :--- | :--- |
| `TRANSACTION_TIMEOUT`، `ABORTED_CONFLICT`، `RATE_LIMITED`، `SERVICE_UNAVAILABLE`، `QUERY_DEADLINE_EXCEEDED`، `INTERNAL_ERROR` (مرة) | `UNAUTHENTICATED` (جدّد الرمز)، `FAILED_PRECONDITION` (أعد قراءة الحالة)، `QUOTA_EXCEEDED` (انتظر إعادة الضبط) | أخطاء 4xx للتحقق/التصريح: `INVALID_ARGUMENT`، `INVALID_DOCUMENT_PATH`، `INVALID_FIELD_NAME`، `MAX_NESTING_EXCEEDED`، `BATCH_SIZE_EXCEEDED`، `INVALID_CURSOR`، `QUERY_TOO_COMPLEX`، `LIMIT_EXCEEDED`، `PERMISSION_DENIED`، `NOT_FOUND`، `ALREADY_EXISTS`، `DOCUMENT_TOO_LARGE`، `PAYLOAD_TOO_LARGE`، `RESPONSE_TOO_LARGE`، `SLOW_CONSUMER_DISCONNECT` |

التراجع ذو التشتيت الكامل (full-jitter) الذي تستخدمه مجموعتا SDK لإعادة الاتصال ولإعادة محاولة OCC: `sleep = random(0, min(tMax, t0 · 2^attempt))` مع `t0 = 500 ms` و`tMax = 30,000 ms` (`computeReconnectBackoffMs`). وتستخدم إعادة محاولة إيداع OCC في JS SDK القيم `t0 = 25 ms` و`tMax = 500 ms`.

## مرجع سريع

- جداول أخطاء محددة لكل نقطة نهاية: [مستوى البيانات عبر REST](./rest-data-plane.md)
- إطارات أخطاء WebSocket: [بروتوكول الوقت الفعلي](./realtime-protocol.md)
- ثوابت الحدود والتحقق من القيم الموسومة: [تنسيق الإرسال](./wire-format.md)
