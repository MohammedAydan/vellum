---
title: مصادقة المستخدمين النهائيين
order: 4
group: المصادقة
description: رموز EdDSA للمستخدمين النهائيين، تدوير الرموز مع نافذة سماح 15 ثانية، إسقاط الملف الشخصي، واجهات REST، مصادقة WebSocket وتحديد المعدل.
---

# مصادقة المستخدمين النهائيين

تُعزل رموز المستخدمين النهائيين للمشروع عن أي اعتماد آخر تمامًا. لا تشترك طبقة الرموز مع الأسطح الأخرى إلا في عناصر التشفير عديمة الحالة من `@vellum/auth` (scrypt، AES-256-GCM، SHA-256، TOTP، مولّدات الرموز، حساب التدوير)؛ أما التخزين ومفاتيح التوقيع و`typ`/`iss`/`aud` والclaims وخدمات الجلسة والوسيط فهي منفصلة 100%، ويُرفض أي رمز من سطح آخر هنا دائمًا.

| السطح | الجلسات | السر | الخوارزمية | `typ` | `iss` | `aud` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| مستخدمو المشروع النهائيون | `data_db.project_auth_*` (FORCE RLS) | مفتاح Ed25519 لكل بيئة | **EdDSA** | `vellum+enduser+jwt` | `https://api.vellum.dev/v1/projects/<projectId>/auth` | `<projectId>` |

:::important لا يوجد بديل HS256
تُتحقق رموز المستخدمين النهائيين عبر **EdDSA فقط** في كل من HTTP وWebSocket، مقابل مفتاح البيئة العام Ed25519. يُرفض أي رمز HS256 على مستوى المستندات حتى مع مفتاح مشروع صالح.
:::

## رموز المستخدمين النهائيين وJWKS

تحمل رموز الوصول `iss` و`sub` و`aud=projectId` و`email` و`email_verified` و`is_anonymous` و`claims` و`iat` و`exp` و`auth_time` و`jti`، وتُوقَّع لكل مشروع. يتطلب التحقق `alg=EdDSA` و`typ=vellum+enduser+jwt` وتطابق `aud`/`iss` بدقة، ويُبلَّغ عن الرموز المنتهية بـ `TOKEN_EXPIRED` مع `retryableWithRefresh: true`. تُقدَّم مفاتيح التحقق العامة عبر `GET /v1/projects/:projectId/auth/.well-known/jwks.json` (OKP/Ed25519، دون مفتاح API).

رموز التحديث (refresh) قيم معتمة بطول 32 بايتًا؛ تُخزَّن فقط تجزئات SHA-256. يحتفظ التدوير بالتجزئة السابقة و`rotated_at`:

- التجزئة الحالية → تدوير عادي؛
- التجزئة السابقة خلال **15 ثانية** → تبويب متزامن غير ضار، تُصدر جلسة جديدة ولا يُلغى أي شيء؛
- التجزئة السابقة بعد 15 ثانية → إعادة استخدام (replay) → **تُلغى كل الجلسات** بالسبب `refresh_token_replay_detected`.

تُجري مجموعتا SDK تحديثًا مسبقًا قبل `exp` بـ 45 ثانية، وتوحّد الطلبات المتزامنة في طلب واحد (single-flight)، وتستجيب لـ `401` بتحديث قسري واحد وإعادة إرسال شفافة مرة واحدة.

## الإسقاط التلقائي لملف المستخدم

عند تفعيل `enable_user_projection` (الافتراضي)، تكتب واجهة المصادقة `users/{uid}` عبر `DocumentEngine.setDocument` باستخدام `system_bypass` (`bypassRules: true`) و`merge: true`. يُحدَّث المستند بعد التسجيل وتعديل الملف وتأكيد التحقق من البريد وتغييرات الـ claims — وكل ذلك مُتحقَّق منه عمليًا.

## واجهات REST

- **المستخدم النهائي** (`/v1/projects/:p/auth`): `sign-up/email`، `sign-in/email`، `sign-in/anonymous`، `sign-in/provider`، `token/refresh`، `sign-out`، `GET|PATCH /user`، `password/reset`، `password/confirm`، `email/verify/request`، `email/verify/confirm`، `mfa/enroll`، `mfa/verify`، `mfa/challenge`، `/.well-known/jwks.json`.
- **إدارة المستخدمين** (`.../auth/admin`، بمفتاح الخادم): دليل المستخدمين وCRUD، `PUT /users/:uid/claims`، الإلغاء، الاستيراد، `GET|PATCH /config`.

راجع [مرجع REST الكامل](../../../docs/07-end-user-auth.md).

## مصادقة WebSocket وإطارات الاشتراك

تُرسل إطار `auth` بالشكل `{ type:"auth", projectId, apiKey, authToken }`؛ ويُتحقق من `authToken` كرمز EdDSA مقابل المفتاح العام للبيئة. تُغلَّف مواصفات الاستعلام داخل `query`:

```json
{ "type": "subscribe", "subId": "sub_ab12cd34",
  "query": { "collectionPath": "tasks", "where": [{ "field": "done", "op": "==", "value": false }],
             "orderBy": [{ "field": "priority", "direction": "asc" }], "limit": 20 } }
```

بعد تدوير الرمز تُعيد SDK إرسال إطار `auth` على الاتصال الحي.

## تحديد المعدل

نوافذ منزلقة داخل العملية (بدون Redis): 10 محاولات دخول فاشلة / 15 دقيقة لكل `(ip,email)`؛ 5 طلبات إعادة تعيين/تحقق / 15 دقيقة (بالمفتاح `(ip,email)` أو `ip + SHA-256(الرمز الموقّع)` عند غياب البريد)؛ 5 محاولات MFA فاشلة / 5 دقائق. تكون الاستجابة `429 TOO_MANY_REQUESTS` مع ترويسة `Retry-After`.

## اقرأ بعد ذلك

- [مجموعة JavaScript](./sdks/javascript.md) · [مجموعة Flutter](./sdks/flutter.md)
