---
title: مصادقة المستخدمين النهائيين والمجالات الثلاثة
order: 4
group: المصادقة
description: ثلاثة مجالات مصادقة معزولة، رموز EdDSA للمستخدمين النهائيين، تدوير الرموز مع نافذة سماح 15 ثانية، إسقاط الملف الشخصي، واجهات REST، مصادقة WebSocket وتحديد المعدل.
---

# مصادقة المستخدمين النهائيين والمجالات الثلاثة

يُقسّم VELLUM المصادقة إلى **ثلاثة مجالات معزولة**. تشترك هذه المجالات في عناصر التشفير عديمة الحالة من `@vellum/auth` فقط (scrypt، AES-256-GCM، SHA-256، TOTP، مولّدات الرموز، حساب التدوير). أما التخزين ومفاتيح التوقيع و`typ`/`iss`/`aud` والclaims وخدمات الجلسة والوسيط فهي منفصلة تمامًا — يُرفض أي رمز من مجال في المجالين الآخرين.

| المجال | الجلسات | السر | الخوارزمية | `typ` | `iss` | `aud` |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `super_admin` | `control_db.control_plane_refresh_sessions` | `SUPER_ADMIN_JWT_SECRET` | HS256 | `vellum+superadmin+jwt` | `vellum:control-plane:super-admin` | `vellum-super-admin` |
| `customer_console` | `control_db.control_plane_refresh_sessions` | `CONSOLE_JWT_SECRET` | HS256 | `vellum+console+jwt` | `vellum:control-plane:console` | `vellum-customer-console` |
| `project_end_user` | `data_db.project_auth_*` (FORCE RLS) | مفتاح Ed25519 لكل بيئة | **EdDSA** | `vellum+enduser+jwt` | `https://api.vellum.dev/v1/projects/<projectId>/auth` | `<projectId>` |

:::important لا يوجد بديل HS256
تُتحقق رموز المستخدمين النهائيين عبر **EdDSA فقط** في كل من HTTP وWebSocket، مقابل مفتاح البيئة العام Ed25519. يُرفض أي رمز HS256 خاص بـ Console/Admin — أو أي رمز HS256 خام — على مستوى المستندات حتى مع مفتاح مشروع صالح.
:::

## رموز المستخدمين النهائيين وJWKS

تحمل رموز الوصول `iss` و`sub` و`aud=projectId` و`email` و`email_verified` و`is_anonymous` و`claims` و`iat` و`exp` و`auth_time` و`jti`، وتُوقَّع لكل مشروع. يتطلب التحقق `alg=EdDSA` و`typ=vellum+enduser+jwt` وتطابق `aud`/`iss` بدقة، ويُبلَّغ عن الرموز المنتهية بـ `TOKEN_EXPIRED` مع `retryableWithRefresh: true`. تُقدَّم مفاتيح التحقق العامة عبر `GET /v1/projects/:projectId/auth/.well-known/jwks.json` (OKP/Ed25519، دون مفتاح API).

رموز التحديث (refresh) قيم معتمة بطول 32 بايتًا؛ تُخزَّن فقط تجزئات SHA-256. يحتفظ التدوير بالتجزئة السابقة و`rotated_at`:

- التجزئة الحالية → تدوير عادي؛
- التجزئة السابقة خلال **15 ثانية** → تبويب متزامن غير ضار، تُصدر جلسة جديدة ولا يُلغى أي شيء؛
- التجزئة السابقة بعد 15 ثانية → إعادة استخدام (replay) → **تُلغى كل الجلسات** بالسبب `refresh_token_replay_detected`.

تُجري مجموعتا SDK تحديثًا مسبقًا قبل `exp` بـ 45 ثانية، وتوحّد الطلبات المتزامنة في طلب واحد (single-flight)، وتستجيب لـ `401` بتحديث قسري واحد وإعادة إرسال شفافة مرة واحدة.

## الإسقاط التلقائي لملف المستخدم

عند تفعيل `enable_user_projection` (الافتراضي)، تكتب واجهة المصادقة `users/{uid}` عبر `DocumentEngine.setDocument` باستخدام `system_bypass` (`bypassRules: true`) و`merge: true`. يُحدَّث المستند بعد التسجيل وتعديل الملف وتأكيد التحقق من البريد وتعديلات مسؤول العميل ومنح الـ claims — وكل ذلك مُتحقَّق منه عمليًا.

## واجهات REST

- **المستخدم النهائي** (`/v1/projects/:p/auth`): `sign-up/email`، `sign-in/email`، `sign-in/anonymous`، `sign-in/provider`، `token/refresh`، `sign-out`، `GET|PATCH /user`، `password/reset`، `password/confirm`، `email/verify/request`، `email/verify/confirm`، `mfa/enroll`، `mfa/verify`، `mfa/challenge`، `/.well-known/jwks.json`.
- **مسؤول العميل** (`.../auth/admin`): دليل المستخدمين وCRUD، `PUT /users/:uid/claims`، الإلغاء، الاستيراد، `GET|PATCH /config`.
- **المدير العام** (`/v1/admin/auth`): `overview`، `projects`، تعديل التحكم، `rotate-signing-key`، `GET|PATCH /settings`، ونقطة التحديث `POST /session/refresh`.
- تحديث Console `POST /v1/console/auth/refresh` وتحديث المدير `POST /v1/admin/auth/session/refresh` يقبلان الرمز من الجسم أو من ملف تعريف الارتباط HttpOnly `vellum_refresh_token` ويرفضان رموز المجالات الأخرى.

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
