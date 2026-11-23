---
title: نظرة عامة على REST API
order: 13
group: المرجع
description: خريطة مختصرة لعائلات نقاط نهاية HTTP أسفل /v1، مع رابط إلى المرجع الكامل.
---

# نظرة عامة على REST API

واجهة HTTP مُركّبة تحت `/v1` وتُرجع JSON في كل استجابة، مع إرفاق `X-Request-Id`. تتم مصادقة نقاط نهاية مستوى المستندات بالترويسة `x-project-key`؛ أما نقاط نهاية Console فتستخدم رمز جلسة Bearer. تتوفر وثيقة OpenAPI 3.1 قابلة للقراءة آليًا على `GET /v1/openapi.json`.

:::note
فضّل [SDK](./quickstart.md) لكود التطبيقات. استخدم HTTP الخام عند الاستدعاء من لغة لا يوجد لها SDK رسمي أو عند تصحيح الأخطاء. ويوجد المرجع الكامل لنقطة نهاية بنقطة نهاية في [مرجع HTTP API](./reference/rest-data-plane.md).
:::

## السيناريو

أنت تدمج VELLUM من لغة لا يتوفر لها SDK رسمي. تكتشف نقاط النهاية المتاحة من `/v1/openapi.json`، ثم تُجري طلبًا موقّعًا بـ `x-project-key` لقراءة مستند وطلب `POST` إلى `/query` لجلب صفحة مُصفّاة — مع فحص `X-Request-Id` في كل استجابة للدعم الفني.

```bash
# اكتشف العقد الحي قبل كتابة كود التكامل.
curl -fsS "https://api.example.com/v1/openapi.json" | jq '.paths | keys[]'
```

## عائلات نقاط النهاية

| العائلة | المسار الأساسي | المصادقة | ماذا تفعل |
| :--- | :--- | :--- | :--- |
| الصحة | `/v1/health/live`, `/v1/health/ready` | عامة | فحوص الحيوية والجاهزية الحقيقية لـ SQL. |
| البيانات الوصفية | `/v1/openapi.json` | عامة | مواصفة OpenAPI 3.1. |
| المستندات | `/v1/projects/:projectId/documents/*path` | `x-project-key` | `GET` مستند/مجموعة، `POST` إنشاء، `PUT` set، `PATCH` تعديل + تحويلات، `DELETE` حذف ناعم. |
| الاستعلام | `/v1/projects/:projectId/query` | `x-project-key` + قواعد | استعلام منظم بـ `where` / `orderBy` / `select` / مؤشر. |
| الدفعات | `/v1/projects/:projectId/batchWrite` | `x-project-key` + قواعد | حتى 100 تعديل ذري. |
| المعاملات | `/v1/.../transactions:begin`, `.../transactions:commit` | `x-project-key` + قواعد | إصدار رمز OCC وإتمام ذري. |
| الفهارس | `/v1/.../indexes`, `/v1/.../indexes/:indexId` | مفتاح الخادم، `indexes:manage` | عرض وإنشاء وحذف الفهارس المركّبة. |
| المجموعات | `/v1/.../collections` | `x-project-key` | عرض مسارات المجموعات الفعلية (مساعد لـ studio). |
| المصادقة | `/v1/auth/sign-up/email`, `/v1/auth/sign-in/email`, `/v1/auth/session`, `/v1/auth/sign-out` | جلسة / عامة | مصادقة البريد الإلكتروني وإدارة الجلسة. |
| MFA | `/v1/auth/mfa/status`, `/setup`, `/verify`, `/disable` | جلسة | تسجيل TOTP والتحقق منه. |
| Console | `/v1/console/...` | رمز جلسة JWT + فحص مؤسسة | لوحات التحكم؛ تعديلات مستوى التحكم الخاضعة للتدقيق. |
| مجموعات القواعد | `/v1/projects/:projectId/rulesets` | جلسة | نشر وقراءة مجموعات قواعد الأمان. |
| الوقت الفعلي | `/v1/realtime` (WebSocket) | إطار `auth` | تدفقات المستندات والاستعلامات الحية. |

## طلب خام

```bash
curl "https://api.example.com/v1/projects/<PROJECT_ID>/documents/users/u_123" \
  -H "x-project-key: <YOUR_API_KEY>"
```

```json
{
  "path": "users/u_123",
  "collectionPath": "users",
  "collectionGroup": "users",
  "documentId": "u_123",
  "data": { "name": "Ada", "role": "admin" },
  "sizeBytes": 96,
  "version": 3,
  "createdAt": "2026-11-15T14:30:00.123Z",
  "updatedAt": "2026-11-17T09:00:00.000Z"
}
```

بالنسبة إلى الاستعلام، أرسل `POST` بمواصفة استعلام إلى `.../query`؛ تكون الاستجابة `{ documents, nextCursor, meta }`:

```bash
curl -X POST "https://api.example.com/v1/projects/<PROJECT_ID>/query" \
  -H "x-project-key: <YOUR_API_KEY>" \
  -H "content-type: application/json" \
  -d '{"collectionPath":"users","where":[{"field":"status","op":"==","value":"active"}],"limit":25}'
```

راجع [الاستعلام](./query.md) و[الترقيم الصفحي](./pagination.md).

:::warning
لا تضع مفتاح خادم أو رمز جلسة في URL ولا تُلتزم به في التحكم بالمصادر. استخدم عناصر نائبة ومرّر بيانات الاعتماد في الترويسات من مخزن أسرار.
:::

## الأخطاء الشائعة

- **وضع المفتاح في URL.** أرسل `x-project-key` (أو `Authorization: Bearer`) في ترويسة دائمًا.
- **الخلط بين واجهتي المصادقة.** نقاط نهاية المستندات تأخذ مفتاح API؛ ونقاط نهاية Console تأخذ رمز جلسة Bearer.
- **نسيان `X-Request-Id`.** التقطه في كل استجابة ليتمكن الدعم من ربط الحوادث بأمان.
- **تخطي مواصفة OpenAPI.** `GET /v1/openapi.json` هو مخطط الطلب/الاستجابة الموثوق والمُحدَّث.

## مثال موثّق

:::example-tabs rest-api

## ماذا تقرأ بعد ذلك

- [مرجع HTTP API الكامل](./reference/rest-data-plane.md) — مخططات الطلب/الاستجابة لكل نقطة نهاية.
- [المصادقة](./authentication.md) — أشكال الترويسات والنطاقات والجلسات.
- [الوقت الفعلي](./realtime.md) — بروتوكول إطار WebSocket.
