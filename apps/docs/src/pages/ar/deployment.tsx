import { Callout, Cards, Code, Doc, H3, P, PageLink, Section, Table, UL } from "../../ui";

export default function Page() {
  return (
    <Doc
      title="النشر والاستضافة"
      description="أصل متصفح واحد للواجهات الثلاث، وخادم API مستقل على المنفذ 8080، والوصفات العملية للتطوير المحلي وVercel وCloudflare Pages وDocker Compose + Caddy."
      eyebrow="التشغيل"
    >
      <Section id="single-origin-model" title="نموذج الأصل الواحد (Single-Origin)">
        <P>
          يتعامل المتصفح دائماً مع أصل عام واحد فقط. كل ما يقع تحت <code>/v1</code> — سواء طلبات{" "}
          <strong>REST</strong> أو ترقيات <strong>WebSocket</strong> — يُمرَّر إلى خادم Hono API المستقل
          على المنفذ <code>8080</code>. يحافظ هذا التصميم على ملفات تعريف الارتباط كطرف أول (First-Party)
          ويلغي طلبات CORS التمهيدية.
        </P>
        <Table
          head={["المسار على الأصل العام", "التطبيق المخدوم"]}
          rows={[
            [<code>/docs/</code>, "موقع التوثيق (استخدم الشرطة المائلة النهائية)"],
            [<code>/v1/*</code>, "وكيل API — يشمل HTTP وترقيات WebSocket"],
          ]}
        />
        <H3 id="gateway">البوابة الصفرية الاعتماديات (scripts/frontend-gateway.mjs)</H3>
        <P>
          تُبنى البوابة العكسية <code>scripts/frontend-gateway.mjs</code> بالكامل على وحدات{" "}
          <code>node:*</code> الأصلية فقط. في وضع <code>--mode=prod</code> تخدم الشجرة المبنية{" "}
          <code>dist-frontend/</code> مباشرة؛ وفي وضع <code>--mode=dev</code> توجّه الطلبات إلى منافذ Vite
          الداخلية للتطبيقات المبنية (5175 للتوثيق). تضبط البوابة ترويسات{" "}
          <code>X-Content-Type-Options: nosniff</code> و<code>X-Frame-Options: DENY</code> و
          <code>Referrer-Policy</code>، وتمنح الأصول ذات التجزئة تخزيناً مؤقتاً غير قابل للتغيير لمدة عام،
          وتعيد <code>404</code> حقيقياً للأصول المفقودة بدلاً من إرجاع HTML. العنوان الافتراضي للخادم هو{" "}
          <code>http://127.0.0.1:8080</code> ويمكن تغييره عبر <code>API_UPSTREAM</code>.
        </P>
        <H3 id="build">البناء الموحّد المتسلسل</H3>
        <P>
          يبني السكربت <code>scripts/build-unified-frontend.mjs</code> التطبيقات الثلاثة{" "}
          <strong>بالتسلسل لا بالتوازي</strong> حفاظاً على الذاكرة، وينسخ مخرجاتها إلى شجرة واحدة{" "}
          <code>dist-frontend/</code> مع توليد ملفي <code>_redirects</code> و<code>_headers</code> تلقائياً
          (عدّل المولّد ولا تعدّل هذين الملفين يدوياً).
        </P>
        <Callout tone="info" title="استقلال خادم API">
          يمتلك خادم API اتصالاته بقواعد البيانات وعماله الخلفيين بشكل مستقل؛ إيقاف البوابة لا يؤثر على
          استمرارية API، ويمكن لأي وكيل عكسي (Caddy أو Vercel Rewrite أو Cloudflare Function) التوجيه إلى{" "}
          <code>:8080</code> دون تعديل.
        </Callout>
      </Section>

      <Section id="local-development" title="التطوير المحلي: عنوانان فقط">
        <Code
          lang="bash"
          title="تشغيل المنصة محلياً"
          code={`corepack pnpm build
corepack pnpm build:frontend
corepack pnpm dev:stack`}
        />
        <Table
          head={["العنوان", "الخدمة", "ملاحظات"]}
          rows={[
            [<code>http://localhost:3000</code>, "بوابة الواجهات الموحّدة", "/docs/ بالإضافة إلى وكيل /v1 لـ HTTP وWebSocket."],
            [<code>http://localhost:8080</code>, "خادم API المستقل", "الوصول المباشر للحزم البرمجية وcurl وفحوص /v1/health/live و /v1/health/ready."],
          ]}
        />
        <Code
          lang="bash"
          title="اختبار الشجرة المبنية محلياً بوضع الإنتاج"
          code={`corepack pnpm build:frontend
node scripts/frontend-gateway.mjs --mode=prod   # يخدم dist-frontend/ على :3000`}
        />
      </Section>


      <Section id="hosting-options" title="خيارات الاستضافة الإنتاجية">
        <Cards
          items={[
            { title: "الخيار A · Vercel + Railway/Render", body: "واجهات ثابتة مُدارة على Vercel مع خادم API مُدار على Railway أو Render." },
            { title: "الخيار B · Cloudflare Pages", body: "استضافة ثابتة مع Pages Function لتمرير /v1 أو أصل API خارجي." },
            { title: "الخيار C · Docker Compose + Caddy", body: "استضافة ذاتية كاملة بشهادات HTTPS تلقائية عبر ثلاث حاويات فقط." },
          ]}
        />

        <H3 id="option-a">الخيار A — واجهة Vercel + خادم Railway / Render</H3>
        <P>
          يبني ملف <code>vercel.json</code> الجذري عبر <code>corepack pnpm build:frontend</code> إلى{" "}
          <code>dist-frontend</code>. حدّث عنوان الخادم في قاعدة إعادة التوجيه قبل النشر، واترك{" "}
          <code>VITE_API_BASE_URL</code> فارغاً أثناء البناء ليبقى <code>/v1</code> على نفس الأصل:
        </P>
        <Code
          lang="json"
          title="vercel.json — استبدل النطاق بنطاق API الحقيقي"
          code={`{ "source": "/v1/(.*)", "destination": "https://api.yourdomain.com/v1/$1" }`}
        />
        <P>
          انشر API باستخدام <code>deploy/railway/railway.api.json</code> أو{" "}
          <code>deploy/render/render.yaml</code>: كلاهما يبني عبر{" "}
          <code>pnpm --filter @vellum/api build</code>، ويشغّل{" "}
          <code>node apps/api/dist/node-server.js</code> على المنفذ <code>8080</code>، ويفحص{" "}
          <code>/v1/health/live</code>. راجع متغيرات البيئة المطلوبة في{" "}
          <PageLink slug="production-checklist" lang="ar">قائمة التحقق للإنتاج</PageLink>.
        </P>

        <H3 id="option-b">الخيار B — Cloudflare Pages + خادم API خارجي</H3>
        <UL
          items={[
            "أمر البناء: corepack pnpm build:frontend، ومجلد المخرجات: dist-frontend، مع NODE_VERSION=22.",
            "يولّد البناء ملفي _redirects و_headers تلقائياً (لا تعدّلهما يدوياً).",
            "أضف Pages Function لتمرير /v1/* شاملة WebSocket (الخيار المفضل)، أو اضبط VITE_API_BASE_URL مع إدراج أصل Pages في CORS_ALLOWED_ORIGINS.",
          ]}
        />

        <H3 id="option-c">الخيار C — استضافة ذاتية كاملة عبر Docker Compose + Caddy</H3>
        <Code
          lang="bash"
          title="ثلاث حاويات (PostgreSQL خارجية)"
          code={`VELLUM_DOMAIN=example.com \\
  docker compose -f deploy/docker/docker-compose.prod.yml up -d --build`}
        />
        <Table
          head={["الخدمة", "الملف / الصورة", "الدور"]}
          rows={[
            ["api", <code>deploy/docker/Dockerfile.api</code>, "خادم Hono API على :8080 مع فحص صحة /v1/health/live."],
            ["frontend", <code>deploy/docker/Dockerfile.frontend</code>, "يبني dist-frontend/ ويشغّل البوابة على :3000 مع API_UPSTREAM=http://api:8080."],
            ["caddy", <code>caddy:2-alpine</code>, "شهادات HTTPS تلقائية على :80 و:443 وتمرير /v1/* (بما فيه WebSocket) إلى API."],
          ]}
        />
      </Section>

      <Section id="troubleshooting" title="استكشاف الأخطاء وإصلاحها">
        <Table
          head={["العرض", "السبب والحل"]}
          rows={[
            ["خطأ Unexpected token '<' لملف JS", "تم تقديم index.html بدلاً من أصل مفقود؛ تأكد من استبعاد مجلدات الأصول لتعود بـ 404 غير HTML."],
            ["خطأ 404 لملفات docs.css / docs.js", "افتح المسار القياسي /docs/ مع الشرطة المائلة النهائية لتُحل الروابط النسبية تحت /docs/assets/."],
            ["فشل تسجيل الدخول بخطأ CORS", "أدرج أصل المتصفح الدقيق في CORS_ALLOWED_ORIGINS أو فعّل وكيل /v1 على نفس الأصل."],
            ["فشل البناء على Node 20", "يتطلب الإنتاج Node 22+؛ اضبط NODE_VERSION=22 واستخدم صور node:22-alpine."],
            ["مسبار /v1/health/ready غير جاهز", "نفّذ corepack pnpm db:migrate على المستويين وتحقق من رابط DATA_DATABASE_URL_LISTEN."],
          ]}
        />
        <P>
          للمزيد من التفاصيل التشغيلية راجع{" "}
          <PageLink slug="production-checklist" lang="ar">قائمة التحقق للإنتاج</PageLink>.
        </P>
      </Section>
    </Doc>
  );
}
