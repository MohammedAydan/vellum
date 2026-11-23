---
title: النشر والاستضافة
order: 15
group: التشغيل
description: الواجهة الموحدة بمصدر واحد — التطوير المحلي، عزل التخزين، Vercel، Cloudflare Pages، Docker Compose مع Caddy، واستكشاف الأخطاء.
---

# النشر والاستضافة

تُقدّم VELLUM **مصدرًا واحدًا للمتصفح**: لوحة العميل على `/`، وحدة تحكم المنصة على `/admin/`، والوثائق على `/docs/`. كل ما تحت `/v1` (REST **و** WebSocket) يُعاد توجيهه إلى الـ API المستقل على المنفذ `8080`.

## التطوير المحلي — عنوانان فقط

```bash
corepack pnpm build
corepack pnpm build:frontend
corepack pnpm dev:stack
```

| العنوان | ما يقدّمه |
| :------ | :-------- |
| `http://localhost:3000` | بوابة الواجهة الموحدة: `/` و`/admin/` و`/docs/` إضافةً إلى وكيل `/v1` لـ HTTP و WS |
| `http://localhost:8080` | الـ API المستقل (SDK، curl، اختبارات E2E المباشرة) |

تبقى لوحة العميل ووحدة التحكم **تطبيقين منفصلين** — يدمج `scripts/build-unified-frontend.mjs` مجلدات `dist` الخاصة بهما، ويستخدم موجه وحدة التحكم `basepath: "/admin"`، لذا يصبح `to="/tenants"` هو `/admin/tenants`. يبقى الـ API مستقلًا: التهيئة الأولية، ومصادقة المشغّلين، والتحقق من المفاتيح، والتعافي لا تعتمد على أي واجهة. للتحقق المشابه للإنتاج شغّل `node scripts/frontend-gateway.mjs --mode=prod` مقابل `dist-frontend/`.

## عزل التخزين وملفات تعريف الارتباط

تشترك الوحدتان في `localStorage` على نفس المصدر، لذا تملك كل مجال ثلاثة مفاتيح منفصلة ولا تقرأ مفاتيح المجال الآخر:

| المجال | رمز الوصول | رمز التحديث | كائن المستخدم |
| :----- | :--------- | :---------- | :------------ |
| لوحة العميل | `vellum_console_access_token` | `vellum_console_refresh_token` | `vellum_console_user` |
| مدير المنصة | `vellum_super_admin_access_token` | `vellum_super_admin_refresh_token` | `vellum_super_admin_user` |

ملفات تعريف الارتباط للتحديث HttpOnly ومحددة المسار:

| المجال | ملف تعريف الارتباط | المسار |
| :----- | :----------------- | :----- |
| لوحة العميل | `vellum_console_rt` | `/v1/console/auth` |
| مدير المنصة | `vellum_admin_rt` | `/v1/admin/auth` |

المفتاح `vellum.locale` تفضيل واجهة مشترك وغير مرتبط بالبيانات الحساسة. يثبت `node scripts/qa-unified-gateway.mjs` في سياق متصفح واحد أن تسجيل الدخول إلى وحدة التحكم لا يغيّر مفاتيح لوحة العميل الثلاثة.

## الخيار A — واجهة Vercel مع API على Railway/Render

- ملف `vercel.json`: أمر البناء `corepack pnpm build:frontend`، ومجلد الإخراج `dist-frontend`، وإعداد إطار العمل Other.
- استبدل وجهة إعادة التوجيه التوثيقية `https://api.yourdomain.com/v1/$1` بمضيف الـ API الحقيقي. لا يستطيع Vercel إدخال متغيرات البيئة في قواعد إعادة التوجيه. اترك `VITE_API_BASE_URL` فارغًا وقت البناء ليبقى `/v1` ضمن نفس المصدر (بما في ذلك ترقية WebSocket).
- تُوجّه القواعد `/admin` و`/admin/*` إلى `/admin/index.html`، و`/docs` إلى `/docs/index.html`، والمسارات بدون امتداد إلى لوحة العميل. تُستبعد مجلدات الأصول من الإعادة التوجيهية، فيُعيد الأصل المفقود 404 حقيقيًا وليس HTML حالة 200.
- الـ API: ملف `deploy/railway/railway.api.json` (البناء `pnpm --filter @vellum/api build`، والتشغيل `node apps/api/dist/node-server.js`) أو `deploy/render/render.yaml`. كلاهما يستمع على `8080` ويفحص `/v1/health/live`.
- اضبط `CORS_ALLOWED_ORIGINS` على مصدر الواجهة بالضبط، واجعل `CONSOLE_JWT_SECRET` و`SUPER_ADMIN_JWT_SECRET` قيمتين إنتاجيتين مختلفتين.

## الخيار B — Cloudflare Pages مع API خارجي

- أمر البناء `corepack pnpm build:frontend`، مجلد الإخراج `dist-frontend`، والمتغير `NODE_VERSION=22`.
- ينشئ البناء ملفَي `_redirects` (إعادة توجيه SPA مع استثناء الأصول) و`_headers` (رؤوس أمان وتخزين دائم للأصول). لا تحررهما يدويًا؛ عدّل `scripts/build-unified-frontend.mjs`.
- لا تعمل Pages كوكيل لـ `/v1` تلقائيًا: أضف دالة Pages تُعيد توجيه `/v1/*` مع ترقية WebSocket، **أو** اضبط `VITE_API_BASE_URL=https://api.<domain>` وقت البناء واسمح بمصدر Pages في `CORS_ALLOWED_ORIGINS`.

## الخيار C — استضافة ذاتية كاملة بـ Docker Compose و Caddy

```bash
VELLUM_DOMAIN=example.com \
  docker compose -f deploy/docker/docker-compose.prod.yml up -d --build
```

ثلاث حاويات: `api` على `:8080`، و`frontend` (البوابة `:3000` مع `API_UPSTREAM=http://api:8080`)، و`caddy` على `:80`/`:443` مع HTTPS تلقائي. يوجّه `deploy/caddy/Caddyfile` النطاق `api.{$VELLUM_DOMAIN}` إلى الـ API، و`{$VELLUM_DOMAIN}/v1/*` إلى الـ API، وكل شيء آخر إلى الواجهة. قاعدة PostgreSQL **خارجية** (Neon/Postgres) عبر `.env`؛ لا توجد حاوية Redis أو وسيط أو تخزين مؤقت — تطبيقًا لمبدأ «صفر Redis».

## استكشاف الأخطاء

- **الأصول المفقودة:** يجب أن يُعيد `/assets/__missing__.js` و`/admin/assets/__missing__.js` الرقم 404 بنوع محتوى غير HTML. إذا حصلت على `200 text/html` فصحّح قواعد إعادة توجيه SPA.
- **`/docs` مقابل `/docs/`:** تستخدم وثائق الموقع مراجع أصول نسبية؛ افتح المسار الرسمي `/docs/` (ب الشرطة المائلة) ليتم حلّها تحت `/docs/assets/`.
- **CORS:** أضف `http://localhost:3000` في التطوير، وفي الإنتاج اذكر مصدر المتصفح بالضبط. يُفضّل وكيل `/v1` حتى لا يُطبّق CORS أصلًا.
- **ملفات تحديث الجلسة:** `Path=/v1/console/auth` و`Path=/v1/admin/auth` على التوالي. الملفات HttpOnly — رموز الوصول موجودة في مفاتيح `localStorage` الخاصة بكل مجال.
- **الروابط العميقة:** يجب أن تُعيد `/admin/<route>` و`/docs/<route>` عند التحديث الأخير صفحة 200 مُصيَّرة وليس 404.
- **Node ≥ 22:** صور الإنتاج تستخدم `node:22-alpine` وترفض الإصدارات الأخرى؛ اضبط `NODE_VERSION=22` على Vercel/Cloudflare.

الدليل الكامل: [`docs/11-deployment-and-hosting.md`](../../../docs/11-deployment-and-hosting.md).
