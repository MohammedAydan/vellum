import { Callout, Code, Doc, H3, P, PageLink, Section, Table, UL } from "../../ui";

export default function Page() {
  return (
    <Doc
      title="قائمة التحقق للإنتاج"
      description="بوابة الجاهزية قبل استقبال حركة المرور: البنية التشغيلية، الأسرار، فحوص الصحة، الترحيلات، RLS المحصّن، العمال الخلفيون، النسخ الاحتياطي، والتحذيرات المعروفة."
      eyebrow="التشغيل"
    >
      <Section id="preflight" title="بوابة الجاهزية قبل الإطلاق (Go / No-Go)">
        <P>
          شغّل هذا الفحص قبل توجيه أي حركة مرور إنتاجية. يفشل الفحص إذا لم يكن مسبار الجاهزية أخضر، وهو
          ما يعني وجود خلل في اتصال قاعدتي البيانات أو حالة الترحيلات أو نقطة <code>LISTEN</code>:
        </P>
        <Code
          lang="bash"
          title="بوابة الجاهزية"
          code={`curl -fsS http://localhost:8080/v1/health/ready | jq -e '.ready == true' >/dev/null \\
  && echo "ready to serve traffic" \\
  || { echo "not ready"; exit 1; }`}
        />
        <UL
          items={[
            "ضبط DATABASE_MODE=postgres وتوجيه CONTROL_DATABASE_URL وDATA_DATABASE_URL إلى PostgreSQL/Neon خارجية.",
            "استبدال جميع أسرار التطوير وتشغيل العملية بـ NODE_ENV=production.",
            "تطبيق الترحيلات على المستويين عبر الروابط المباشرة غير المجمّعة (*_DATABASE_URL_DIRECT).",
            "عودة GET /v1/health/ready بحالة 200 وready = true.",
            "التأكد من عمل العمال الخلفيين الثلاثة (الفهارس، تنظيف الصندوق، وتنظيف شواهد الحذف).",
            "اختبار استعادة نسخة احتياطية كاملة لكلتا القاعدتين مسبقاً.",
          ]}
        />
        <Callout tone="danger" title="يرفض الإنتاج الإقلاع بأسرار التطوير">
          عند ضبط <code>NODE_ENV=production</code> يرفض محمّل الإعدادات بدء التشغيل إذا بقي أي سر تطوير
          افتراضي. حافظ على ثبات <code>CURSOR_HMAC_SECRET</code> لأن تدويره يُبطل جميع مؤشرات الترقيم النشطة.
        </Callout>
      </Section>

      <Section id="runtime-and-topology" title="بيئة التشغيل والطوبولوجيا">
        <Table
          head={["البند", "المتطلب الإنتاجي"]}
          rows={[
            ["Node.js", "Node 22 أو أحدث (صور الإنتاج مبنية على node:22-alpine بمستخدم غير جذري uid 1001)."],
            ["قواعد البيانات", "قاعدتا PostgreSQL: control_db وdata_db فقط. لا Redis ولا وسيط رسائل."],
            ["وضع التخزين", "DATABASE_MODE=postgres حصراً؛ وضع الذاكرة للاختبارات المعزولة فقط."],
            ["الترحيلات (DDL)", "عبر الروابط المباشرة *_DATABASE_URL_DIRECT في CI/CD، لا عبر رابط التجميع."],
            ["المنفذ", "يستمع الخادم على المنفذ 8080 (PORT / API_PORT / API_HOST=0.0.0.0)."],
          ]}
        />
        <P>
          راجع وصفات الاستضافة الكاملة لـ Vercel وCloudflare Pages وDocker Compose + Caddy في{" "}
          <PageLink slug="deployment" lang="ar">النشر والاستضافة</PageLink>.
        </P>
      </Section>

      <Section id="secrets-and-configuration" title="الأسرار ومتغيرات البيئة الإلزامية">
        <P>
          اضبط هذه القيم في مدير الأسرار أو لوحة الاستضافة فقط ولا تضعها في مستودع الشيفرة. ملفات{" "}
          <code>.env</code> مخصصة للتطوير المحلي فقط:
        </P>
        <Code
          lang="bash"
          title="متغيرات بيئة الإنتاج المطلوبة"
          code={`NODE_ENV=production
DATABASE_MODE=postgres
CONTROL_DATABASE_URL="postgres://.../control_db"
DATA_DATABASE_URL="postgres://.../data_db"
DATA_DATABASE_URL_LISTEN="postgres://.../data_db"   # وضع الجلسة (ليس -pooler)
PORT=8080
API_PORT=8080
API_HOST=0.0.0.0
BETTER_AUTH_SECRET="<strong-unique-value>"
JWT_SECRET="<strong-unique-value>"
API_KEY_PEPPER="<strong-unique-value>"
CURSOR_HMAC_SECRET="<strong-unique-value>"
SESSION_COOKIE_SECRET="<strong-unique-value>"
MASTER_ENCRYPTION_KEY="<strong-unique-value>"
CONSOLE_JWT_SECRET="<distinct-console-realm-secret>"
SUPER_ADMIN_JWT_SECRET="<distinct-admin-realm-secret>"
CORS_ALLOWED_ORIGINS="https://vellum.example.com"`}
        />
        <Callout tone="warning" title="نظافة الأسرار وإخفاؤها">
          لا تطبع مفاتيح API أو رموز Bearer أو روابط قواعد البيانات في السجلات أو مخرجات CI. استخدم{" "}
          <code>getRedactedConfigSummary</code> ومُسجّل <code>@vellum/observability</code> الذي يُخفي{" "}
          <code>pk_</code> و<code>sk_</code> و<code>Bearer</code> و<code>secret_hash</code> تلقائياً.
        </Callout>
      </Section>

      <Section id="health-and-migrations" title="فحوص الصحة والترحيلات وRLS المحصّن">
        <Table
          head={["نقطة النهاية", "تلمس PostgreSQL؟", "الاستخدام"]}
          rows={[
            [<code>GET /v1/health/live</code>, "لا", "مسبار حيوية الحاوية واستجابة حلقة الأحداث."],
            [<code>GET /v1/health/ready</code>, "نعم", "مسبار جاهزية موازن الأحمال: يفحص القاعدتين وجداول schema_migrations ونقطة LISTEN ويعيد 503 عند أي خلل."],
          ]}
        />
        <Code
          lang="bash"
          title="تطبيق وفحص الترحيلات في CI/CD"
          code={`corepack pnpm db:migrate
# لمستوى واحد فقط: tsx scripts/migrate.ts --only=control | --only=data
# التحقق من الحالة: corepack pnpm db:migrate -- --status`}
        />
        <P>
          تعمل حركة مستوى البيانات بدور PostgreSQL غير مشرف (<code>vellum_app</code> /{" "}
          <code>vellum_runtime</code>) مع تفعيل <code>ENABLE</code> و<code>FORCE ROW LEVEL SECURITY</code>{" "}
          على جميع جداول المستأجرين الـ 12. وتربط <code>withTenantContext()</code> سياق كل معاملة في استعلام
          مُعامَل واحد:
        </P>
        <Code
          lang="sql"
          title="سياق المعاملة المحصّن في مستوى البيانات"
          code={`SELECT
  set_config('app.current_project_id', $1, true),
  set_config('statement_timeout', '5000ms', true),
  set_config('lock_timeout', '2000ms', true),
  set_config('idle_in_transaction_session_timeout', '15000ms', true);`}
        />
        <Callout tone="danger" title="قاعدة ذهبية: لا تتصل كـ superuser في الإنتاج">
          حسابات <code>superuser</code> تتجاوز سياسات RLS. ترفض <code>sanitizeRoleName()</code> في{" "}
          <code>@vellum/database-data</code> تلقائياً الأدوار المميزة مثل <code>postgres</code> و
          <code>neon_superuser</code> و<code>rdsadmin</code>. وإذا غاب <code>app.current_project_id</code>{" "}
          يفشل RLS بأمان ولا يعيد أي صفوف.
        </Callout>
      </Section>

      <Section id="workers-and-observability" title="العمال الخلفيون والمراقبة">
        <H3 id="workers">العمال الخلفيون المتكررو الأمان</H3>
        <Table
          head={["العامل", "السلوك"]}
          rows={[
            ["تعبئة الفهارس المركّبة (Index Backfill)", "يبني إدخالات الفهارس على دفعات من 500 مستند؛ بدونه تبقى الفهارس الجديدة في حالة building."],
            ["ضغط صندوق البريد (Outbox Compaction)", "يحذف أحداث realtime_outbox الأقدم من 24 ساعة على دفعات من 10,000 صف."],
            ["تنظيف شواهد الحذف (Tombstone Purge)", "يحذف الصفوف المحذوفة ناعماً بعد نافذة الاحتفاظ الافتراضية (7 أيام) على دفعات من 5,000 صف."],
          ]}
        />
        <H3 id="observability">التسجيل وتحديد المعدل وسجل التدقيق</H3>
        <UL
          items={[
            "اعتمد مسجّل JSON المهيكل من @vellum/observability؛ يُصدر requestId وprojectId وdurationMs مع تنقية تلقائية للأسرار.",
            "يُفرض تحديد المعدل لكل مفتاح (الافتراضي 100 طلب/ثانية) ويعيد 429 RATE_LIMITED مع Retry-After.",
            "تُسجَّل كل تعديلات مستوى التحكم في security_audit_logs المتسلسل المشفّر وغير القابل للتعديل.",
            "لا تعرض لوحة الإدارة محتوى حقل documents.data الخاص بالعملاء أبداً — بل تقتصر على البيانات الوصفية والحصص وصحة الفهارس.",
          ]}
        />
      </Section>

      <Section id="backups-and-caveats" title="النسخ الاحتياطي والتنبيهات التشغيلية">
        <P>
          احتفظ بنسخ احتياطية مستقلة لكل من <code>control_db</code> و<code>data_db</code>. ولأن الإقلاع
          يعتمد على <code>control_db</code> فقط، يمكنك استعادة المصادقة والإعدادات قبل استعادة مستندات
          العملاء. راجع اتساق <code>schema_migrations</code> بعد كل استعادة.
        </P>
        <Table
          head={["التنبيه", "التوجيه العملي"]}
          rows={[
            ["مبدأ Zero-Redis", "التخزين المؤقت وتحديد المعدل داخل العملية مع NOTIFY vellum_cache_invalidate؛ لا تضف Redis."],
            ["زمن الوصول إلى Neon البعيد", "ضع خادم API في نفس المنطقة الجغرافية لقاعدة البيانات وحافظ على قِصر دوال المعاملات."],
            ["LISTEN ووضع الجلسة", "استخدم DATA_DATABASE_URL_LISTEN غير المجمّع، أو اقبل وضع الاستقصاء الاحتياطي."],
            ["تدوير CURSOR_HMAC_SECRET", "يُبطل كل مؤشرات الترقيم الجارية؛ خطّط لإعادة الترقيم من الصفحة الأولى."],
            ["المستهلكون البطيئون في WebSocket", "تجاوز المخزن الصادر 1 MiB يفصل المشترك برمز SLOW_CONSUMER_DISCONNECT."],
          ]}
        />
      </Section>
    </Doc>
  );
}
