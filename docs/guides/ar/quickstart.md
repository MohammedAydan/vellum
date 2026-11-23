---
title: البدء السريع
order: 2
group: البداية
description: ثبّت @vellumdb/sdk-js، وأنشئ عميلًا، ونفّذ أول عملية كتابة وقراءة وحذف.
---

# البدء السريع

يُدخلك هذا الدليل في عالم VELLUM خلال دقائق قليلة: كتابة مستند وقراءته مجددًا. نستخدم SDK الرسمي بلغة TypeScript/JavaScript وهو `@vellumdb/sdk-js`.

## السيناريو

لقد أنشأت مشروعًا جديدًا وتريد التأكد من أن الإعداد يعمل من طرف إلى طرف: ثبّت SDK، وأنشئ عميلًا بمفتاح إنتاج، واكتب مستند مستخدم واحدًا، واقرأه مجددًا، ثم احذفه. في نهاية هذا الدليل سيكون لديك عميل عامل يمكنك توسيعه ل بقية ميزات SDK. المشروع هو المستأجر الوحيد.

## 1. ثبّت SDK

```bash
npm install @vellumdb/sdk-js
```

الحزمة هي ESM (`type: module`) وتستهدف Node 22+ أو متصفحًا حديثًا. وتتضمن تعريفات TypeScript الخاصة بها، لذا لا حاجة إلى حزمة `@types` منفصلة.

## 2. احصل على مفتاح مشروع

يجب على طلب مستوى المستندات تقديم مفتاح API في الترويسة `x-project-key`. أنشئ مفتاحًا ضمن بيئة مشروعك. عامل مفاتيح الخادم (`sk_`) كأسرار؛ يمكن شحن المفاتيح العامة (`pk_`) إلى المتصفحات وتطبيقات الجوال لكنها لا تمنح أي وصول ضمني — تُفحص كل عملية مقابل قواعد أمان البيئة.

لا تلتزم بمفتاح حقيقي في التحكم بالمصادر. استخدم عنصرًا نائبًا مثل `<YOUR_API_KEY>` في الأمثلة، وحمّل القيمة الحقيقية من متغير بيئة وقت التشغيل.

## 3. أنشئ عميلًا

```ts
import { createClient } from "@vellumdb/sdk-js";

const db = createClient({
  endpoint: process.env.VELLUM_ENDPOINT ?? "http://localhost:8080",
  projectId: process.env.VELLUM_PROJECT_ID ?? "proj_01JCK9X2P8", // اختياري؛ الافتراضي production (الأسماء القديمة مقبولة)
  apiKey: process.env.VELLUM_API_KEY ?? "<YOUR_API_KEY>",
  // اختياري: قدّم JWT للمستخدم النهائي حتى تتمكن القواعد من تقييم auth.uid / auth.claims.
  getAuthToken: async () => currentUserJwt(),
});
```

يتطلب `createClient` كلًا من `projectId` و`apiKey`. تكون `endpoint` افتراضيًا `http://localhost:8080`. يمكن لتحديد `realtimeUrl` اختياريًا تجاوز عنوان WebSocket المشتق `<endpoint>/v1/realtime`، أما `customFetch` / `webSocketFactory` فهما نقاط اختبار (test seams). تُرسل جميع الطلبات إلى `/v1/projects/:projectId/...`.

## 4. اكتب واقرأ واحذف

```ts
const users = db.collection("users");
const user = users.doc("user_123");

await user.create({ name: "Ada", role: "admin", active: true });
const snapshot = await user.get();
console.log(snapshot.id, snapshot.version, snapshot.data());

await user.update({ active: false });
await user.delete();
```

- يفشل `create` إذا كان المستند موجودًا بالفعل (`ALREADY_EXISTS`).
- يدمج `set(data, { merge: true })` بعمق؛ وبدون `merge` يستبدل المستند.
- يعدّل `update` الحقول المحددة ويمكن أن يحمل تحويلات حقول ذرية.
- يكتب `delete` علامة حذف (tombstone) وحدثًا في صندوق البريد؛ إنه حذف ناعم.

بمجرد وجود مستند، يمكنك الاستعلام عن المجموعة مباشرة:

```ts
// اقرأ جميع المستخدمين النشطين، عشرة في كل مرة.
const active = await users.where("active", "==", true).limit(10).get();
for (const doc of active.docs) console.log(doc.id, doc.data());
```

راجع [CRUD](./crud.md) لقواعد المسارات و[تحويلات الحقول](./field-transforms.md) لـ `fieldOp.*`.

## إعداد البيئة

يقرأ خادم API التهيئة من متغيرات البيئة (ومن ملف `.env` اختياري). المفيدة للتطوير المحلي:

| المتغير | المعنى | الافتراضي |
| :--- | :--- | :--- |
| `DATABASE_MODE` | `memory` للاختبارات المعزولة، `postgres` للتخزين الدائم | `memory` |
| `CONTROL_DATABASE_URL` | اتصال PostgreSQL بمستوى التحكم | `postgres://vellum:vellum_dev_password@localhost:5432/control_db` |
| `DATA_DATABASE_URL` | اتصال PostgreSQL بمستوى البيانات | `postgres://vellum:vellum_dev_password@localhost:5433/data_db` |
| `DATA_DATABASE_URL_LISTEN` | عنوان وضع الجلسة المحجوز لعميل `LISTEN` الخاص بالوقت الفعلي | غير محدد (وقت فعلي بالاستطلاع فقط) |
| `API_PORT` / `API_HOST` | عنوان الاستماع | `8080` / `0.0.0.0` |
| `CURSOR_HMAC_SECRET` | يوقّع مؤشرات الترقيم الصفحي | الافتراضي للتطوير (يجب استبداله في الإنتاج) |

:::warning
في `NODE_ENV=production` يرفض الخادم التشغيل إذا كان أي سر تطوير مخبوء لا يزال مستخدمًا. اضبط قيمًا قوية وفريدة لـ `BETTER_AUTH_SECRET` و`API_KEY_PEPPER` و`CURSOR_HMAC_SECRET` و`JWT_SECRET` قبل النشر. لا تسجّل أبدًا عناوين الاتصال أو قيم الأسرار.
:::

## أمثلة موثّقة

الأمثلة القابلة للتشغيل التالية تظهر كمصدر ثابت مرفق بمخرجات مسجّلة من المولّد.

:::example-tabs quickstart

## الأخطاء الشائعة

- **شحن مفتاح `sk_` إلى المتصفح.** مفاتيح الخادم تتجاوز القواعد حسب النطاق؛ احتفظ بها على بنية تحتية موثوقة.
- **حذف `projectId` / `apiKey`.** يتطلب `createClient` كلًا منهما؛ الإغفال يفشل عند الإنشاء.
- **استخدم مشاريع منفصلة للعزل.** البيانات مقيدة بالمشروع فقط؛ لا توجد بيئات.
- **توقّع أن `create` يستبدل المستند.** استخدم `set(...)` لاستبدال مستند موجود.

## ماذا تقرأ بعد ذلك

- [المصادقة](./authentication.md) — مفاتيح API، ومصادقة الجلسة، وMFA، والتدوير.
- [CRUD](./crud.md) — المسارات، والمراجع، والتزامن، وتنسيق الأسلاك الموسوم.
- [الاستعلام](./query.md) — المرشحات والترتيب والإسقاط.
- [الوقت الفعلي](./realtime.md) — لقطات حية للمستندات والاستعلامات.
