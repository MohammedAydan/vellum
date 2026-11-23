import type { ReactNode } from "react";
import {
  Api,
  Callout,
  Code,
  Doc,
  H3,
  PageLink,
  P,
  Section,
  Table,
  UL,
} from "../../ui";

/** Inline LTR span for technical identifiers inside Arabic prose. */
const IC = ({ children }: { children: ReactNode }) => <code dir="ltr">{children}</code>;

export default function Page() {
  return (
    <Doc
      title="نظرة عامة على REST API"
      description="خريطة مختصرة لعائلات نقاط نهاية HTTP أسفل /v1، ونموذجا المصادقة، والاتفاقيات المشتركة، مع روابط إلى المرجع التفصيلي."
      eyebrow="المرجع"
    >
      <Section id="overview" title="نظرة عامة">
        <P>
          تُقدِّم VELLUM واجهة HTTP واحدة تحت البادئة <IC>/v1</IC>، مبنية على إطار Hono. كل نقطة نهاية تُعيد JSON،
          وكل استجابة — نجاحاً كانت أم خطأً — تحمل الرأس <IC>X-Request-Id</IC> الذي يسمح بتتبّع الطلب في السجلات
          المُهيكلة. لا توجد واجهة منفصلة لكل مستأجر؛ العنوان نفسه يخدم الجميع، والعزل يحدث داخل قاعدة البيانات.
        </P>
        <P>
          ينقسم النظام مادياً إلى مستويين: مستوى التحكم <IC>control_db</IC>، ويملك المستخدمين والمؤسسات والمشاريع
          ومفاتيح API ومجموعات القواعد والقياس اليومي وسجلات التدقيق غير القابلة للتعديل؛ ومستوى البيانات{" "}
          <IC>data_db</IC>، ويملك المستندات والفهارس المركّبة وصندوق بريد الوقت الفعلي ومعاملات OCC. لا يوجد وسيط
          خارجي ولا <IC>Redis</IC>؛ PostgreSQL هي التبعية الحالية الوحيدة.
        </P>
        <Callout tone="info" title="العزل يفشل بصورة مغلقة">
          <P>
            كل عملية على مستوى البيانات مُقيَّدة بـ <IC>projectId</IC>. تربط طبقة التخزين سياق
            المستأجر داخل كل معاملة عبر <IC>SET LOCAL app.current_project_id</IC> و
            <IC> statement_timeout = '5000ms'</IC>، بحيث ترفض سياسات
            الأمان على مستوى الصفوف (RLS) أي استعلام يُحذف منه سياق المستأجر.
          </P>
        </Callout>
      </Section>

      <Section id="families" title="عائلات نقاط النهاية">
        <P>
          الإرشادات التالية تكفي لتحديد المسار الصحيح: إذا كنت تكتب مستندات أو تستعلام عنها فأنت في مستوى
          البيانات، وإذا كنت تُدير مؤسسة أو مفتاحاً أو مستخدماً فأنت في مستوى التحكم. يلخّص الجدول العائلات
          الأساسية أسفل <IC>/v1</IC>:
        </P>
        <Table
          head={["العائلة", "المسار الأساسي", "المصادقة", "الوصف"]}
          rows={[
            [
              "الصحة والمواصفة",
              <IC>/v1/health/**</IC>,
              "عامة",
              "فحص الحيّ وفحص الجاهزية ومواصفة OpenAPI 3.1 القابلة للقراءة آلياً.",
            ],
            [
              "مستوى البيانات",
              <IC>/v1/projects/:projectId/…</IC>,
              <IC>x-vellum-api-key</IC>,
              "CRUD والمستندات، الاستعلام، الكتابة الدفعية، المعاملات والفهارس المركّبة.",
            ],
            [
              "مصادقة العملاء",
              <IC>/v1/auth/**</IC>,
              "جلسة Console",
              "التسجيل والدخول والجلسة الحالية والخروج للمستخدمين أصحاب الحسابات.",
            ],
            [
              "واجهة Console",
              <IC>/v1/console/**</IC>,
              "جلسة Console",
              "إدارة المؤسسات والمشاريع والمفاتيح والقواعد نيابة عن العميل، مع سجل تدقيق لكل تغيير.",
            ],
            [
              "واجهة المشغّل",
              <IC>/v1/admin/**</IC>,
              "جلسة Super Admin",
              "دليل المستأجرين، قياس الكتلة، سجلات التدقيق وإدارة ميزات المنصة.",
            ],
            [
              "مصادقة المستخدمين النهائيين",
              <IC>/v1/projects/:projectId/auth/**</IC>,
              "مفتاح المشروع + رمز EdDSA",
              "تسجيل ودخول وإعادة تعيين وMFA لمستخدمي تطبيقك، مع JWKS عام لكل مشروع.",
            ],
            [
              "إدارة مستخدمي المشروع",
              <IC>…/auth/admin/**</IC>,
              <>مفتاح <IC>sk_</IC> أو جلسة</>,
              "دليل المستخدمين النهائيين وإعدادات المصادقة الخاصة بالمشروع.",
            ],
            [
              <PageLink slug="relationships" lang="ar">العلاقات</PageLink>,
              <IC>…/documents:referencedBy</IC>,
              <>مفتاح API + قواعد</>,
              "بحث عكسي إلى المستندات المُشيرة، مع تجميع وحذف دفعي يراعي المراجع.",
            ],
            [
              <PageLink slug="relationships" lang="ar">قواعد العلاقات</PageLink>,
              <IC>/v1/projects/:projectId/relation-rules</IC>,
              "جلسة Console",
              "قراءة وتحديث قواعد التكامل المرجعي cascade وset_null وrestrict لكل مشروع.",
            ],
            [
              <PageLink slug="realtime" lang="ar">الوقت الحقيقي</PageLink>,
              <IC>/v1/realtime</IC>,
              "مفتاح API عبر WebSocket",
              "اشتراك دائم مع استئناف وعلامات مائية وكشف فجوات، وتضمين علاقات اختياري.",
            ],
            [
              "القياس",
              <IC>/v1/projects/:projectId/usage</IC>,
              "جلسة",
              <>قراءات يومية دائمة من <IC>project_usage_daily</IC>، دون أي قيم مُختلقة.</>,
            ],
          ]}
        />
        <P>للحصول على الشكل الكامل لكل طلب واستجابة، ابدأ بالمرجعين التفصيليين:</P>
        <UL
          items={[
            <PageLink slug="reference/rest-data-plane" lang="ar">واجهة REST لمستوى البيانات</PageLink>,
            <PageLink slug="reference/rest-control-plane" lang="ar">واجهة REST لمستوى التحكم</PageLink>,
            <PageLink slug="reference/realtime-protocol" lang="ar">بروتوكول WebSocket للوقت الفعلي</PageLink>,
            <PageLink slug="reference/errors" lang="ar">رموز الأخطاء وإرشادات إعادة المحاولة</PageLink>,
          ]}
        />
      </Section>

      <Section id="auth-models" title="نموذجا المصادقة">
        <P>
          لا تخلط بين النموذجين؛ الخلط بينهما هو أكثر أخطاء التكامل شيوعاً. مستوى البيانات يُصادَق عليه بمفتاح API
          ثابت في الرأس، بينما مستوى التحكم يُصادَق عليه بجلسة مرتبطة بمجال معيّن (Realm) ومحفوظة في ملف
          تعريف ارتباط HttpOnly. الرموز الصادرة عن مجال لا تُقبل إطلاقاً في مجال آخر.
        </P>
        <H3 id="data-plane-auth">مستوى البيانات: مفتاح API إلزامي</H3>
        <P>
          كل طلب إلى <IC>/v1/projects/:projectId/…</IC> يتطلّب الرأس <IC>x-vellum-api-key</IC> (ويُقبل
          الاسم القديم <IC>x-project-key</IC> كمرادف). غياب الرأس يعني <IC>UNAUTHENTICATED</IC>؛ ولا يُنشأ أي مفتاح
          احتياطي تلقائياً. المفاتيح العامة تبدأ بـ <IC>pk_</IC> والمفاتيح السرية للخادم بـ <IC>sk_</IC>.
        </P>
        <Table
          head={["الرأس", "الحالة", "القيمة والغرض"]}
          rows={[
            [<IC>x-vellum-api-key</IC>, "مطلوب", <>مفتاح <IC>pk_</IC> للمتصفح/الجوال أو <IC>sk_</IC> للخادم، مرتبط بالمشروع.</>],
            [<IC>authorization</IC>, "اختياري", <>رمز حامل EdDSA للمستخدم النهائي بصيغة <IC>Bearer …</IC>.</>],
            [<IC>x-vellum-user-token</IC>, "اختياري", <>اسم مستعار للرمز نفسه، يُستخدم عندما لا يتناسب رأس <IC>Authorization</IC>.</>],
            [<IC>x-transaction-token</IC>, "اختياري", "رمز معاملة OCC عند قراءة مستند ضمن معاملة مفتوحة."],
          ]}
        />
        <H3 id="control-plane-auth">مستوى التحكم: جلسات مرتبطة بالمجال</H3>
        <P>
          توجد ثلاثة مجالات مصادقة معزولة: <IC>SUPER_ADMIN</IC> أسفل <IC>/v1/admin/**</IC> بملف التعريف{" "}
          <IC>vellum_admin_rt</IC>، و<IC>CUSTOMER_CONSOLE</IC> أسفل <IC>/v1/console/**</IC> بملف التعريف{" "}
          <IC>vellum_console_rt</IC>، و<IC>PROJECT_END_USER</IC> المُقيَّد بالمشروع والمُستخدم في مستوى البيانات.
          يُوقَّع كل رمز بخدمة جلسات خاصة بمجاله، ويُتحقَّق منه في نفس المجال فقط.
        </P>
        <Callout tone="danger" title="لا بديل HS256 لرموز المستخدمين النهائيين">
          <P>
            إذا حمل الطلب رمز مستخدم نهائي، فيجب أن يكون رمز <IC>vellum+enduser+jwt</IC> بتوقيع EdDSA يتحقق من
            مفتاح Ed25519 الخاص بالمشروع. الرمز غير الصالح يُنتج <IC>401 UNAUTHENTICATED</IC> ولا يؤدي إلى تراجع
            صامت إلى سياق مجهول.
          </P>
        </Callout>
      </Section>

      <Section id="collections-lifecycle" title="دورة حياة المجموعات (Collections)">
        <P>
          المجموعات صفوف دائمة في قاعدة البيانات، وليست قائمة <IC>DISTINCT</IC> مستنبطة من المستندات.
          ثماني نقاط نهاية تديرها على كلا السطحين: السطح العام{" "}
          <IC>/v1/projects/:projectId/collections…</IC> بمفتاح API، وسطح Console الموثَّق
          بالجلسة <IC>/v1/console/projects/:projectId/collections…</IC> الذي تستخدمه اللوحة.
          القراءات (السرد، واحدة، التصدير) تقبل مفتاحاً عاماً <IC>pk_</IC>، والتعديلات (الإنشاء،
          التعديل، المسح، الحذف، الاستيراد) تتطلب مفتاح خادم <IC>sk_</IC>. السرد يعيد{" "}
          <IC>limit=50</IC> افتراضياً — استخدم <IC>?limit=500</IC> لرؤية كل المجموعات عند وجود أكثر
          من 50. <strong>المسح</strong> يحذف المستندات ويُبقي التسجيل والإعدادات، أما{" "}
          <strong>الحذف</strong> فيُزيل الاثنين. الاستيراد يقبل مصفوفة JSON تضم 500 كائن{" "}
          <IC>{'{ id?, data }'}</IC> كحد أقصى، والتصدير يعيد <IC>documents</IC> مع مؤشر{" "}
          <IC>nextCursor</IC> بترتيب <IC>path ASC</IC>. يقبل الاستيراد أيضاً غلاف الحزم{" "}
          <IC>{'{ documents, mode }'}</IC>.
        </P>
        <P>
          الأشكال الكاملة للطلب والاستجابة وحقول الإعدادات وأغلفة الحزم البرمجية في{" "}
          <PageLink slug="reference/rest-data-plane" lang="ar">
            مرجع مستوى البيانات — دورة حياة المجموعات
          </PageLink>
          .
        </P>
      </Section>

      <Section id="conventions" title="الاتفاقيات المشتركة">
        <Table
          head={["الاتفاقية", "التفصيل"]}
          rows={[
            [
              "معاملات المسار",
              <>المعاملات <IC>projectId</IC> و<IC>indexId</IC> إلزامية حيث تظهر.</>,
            ],
            [
              "الأجسام",
              <>كل الأجسام JSON. يقبل <IC>batchWrite</IC> المفتاحين <IC>writes</IC> أو <IC>operations</IC> بالتبادل، ويتعامل <IC>data</IC> مع الجسم بأكمله إذا لم يُرسل غلاف.</>,
            ],
            [
              "شكل الخطأ",
              <>الأخطاء حتمية: <IC>error.code</IC> و<IC>error.message</IC> و<IC>error.requestId</IC>، مع <IC>error.details</IC> الاختياري عند وجود سياق إضافي.</>,
            ],
            [
              "الترقيم الصفحي",
              <>يُعاد المؤشر المعتم <IC>nextCursor</IC> الموقّع بـ HMAC-SHA256، مع <IC>document_id ASC</IC> كفاصل حسم. لا يُعرَض <IC>OFFSET</IC> في أي واجهة عامة.</>,
            ],
            [
              "المسار غير الموجود",
              <>أي مسار غير مسجّل يُنتج <IC>404 NOT_FOUND</IC> عبر معالج شامل في نهاية التطبيق.</>,
            ],
          ]}
        />
        <P>مثال على استجابة خطأ قياسية:</P>
        <Code
          lang="json"
          title="خطأ 403 — مفتاح من مشروع آخر"
          code={`{
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "Provided API key does not belong to the requested project",
    "requestId": "req_01J9Z8K3M4",
    "details": {
      "projectId": "proj_7c1f"
    }
  }
}`}
        />
      </Section>

      <Section id="health-and-spec" title="الفحص والمواصفة الآلية">
        <P>
          نقاط النهاية العامة الثلاث التالية لا تتطلّب أي مصادقة، وهي مصمَّمة لتكون صغيرة وسريعة ومجانية من الأسرار.
          يُنصح بفصل فحص الحيّ عن فحص الجاهزية في إعدادات الحاوية وموازن التحميل.
        </P>
        <Api method="GET" path="/v1/health/live">
          <P>
            فحص حيّ لا يلمس قاعدة البيانات؛ يجيب عن سؤال واحد: هل عملية Node قادرة على خدمة الطلبات؟ هذا هو الفحص
            الذي يستخدمه <IC>HEALTHCHECK</IC> في الحاوية.
          </P>
          <P>الرؤوس المطلوبة: لا شيء.</P>
          <Code
            lang="json"
            title="200 OK"
            code={`{
  "status": "alive",
  "version": "0.0.1",
  "mode": "postgres",
  "uptimeMs": 482311,
  "timestamp": "2026-11-18T09:12:44.000Z",
  "checks": {
    "process": {
      "state": "ok",
      "probe": "event loop responsive",
      "result": { "alive": true }
    }
  }
}`}
          />
        </Api>
        <Api method="GET" path="/v1/health/ready">
          <P>
            فحص جاهزية يُجري استعلامات SQL حقيقية ضد مستوى التحكم ومستوى البيانات وجداول الترحيل واتصال LISTEN
            المخصّص. يُعيد <IC>503</IC> إذا فشل أي فحص، ليتمكن موازن التحميل من حجب التدفق مؤقتاً. القيم المعروضة
            هي ما أعادته PostgreSQL فعلياً، ولا تُختلق سلاسل «متصل».
          </P>
          <P>الرؤوس المطلوبة: لا شيء.</P>
          <Code
            lang="json"
            title="200 OK (أو 503 عند عدم الجاهزية)"
            code={`{
  "status": "ready",
  "ready": true,
  "version": "0.0.1",
  "mode": "postgres",
  "uptimeMs": 482311,
  "timestamp": "2026-11-18T09:12:44.000Z",
  "checks": {
    "controlDb": {
      "state": "ok",
      "target": "control_db",
      "query": "SELECT 1 AS probe_ok",
      "result": { "probe_ok": 1 },
      "latencyMs": 3,
      "errorCode": null,
      "reason": null
    },
    "dataDb": { "state": "ok", "target": "data_db", "latencyMs": 4 },
    "controlMigrations": { "state": "ok", "table": "present", "missing": [], "drift": [] },
    "dataMigrations": { "state": "ok", "table": "present", "missing": [], "drift": [] },
    "realtimeListen": { "state": "ok", "target": "realtime_listen" }
  }
}`}
          />
        </Api>
        <Api method="GET" path="/v1/openapi.json">
          <P>مواصفة OpenAPI 3.1 مولَّدة ديناميكياً من العقود المشتركة، وتُستخدم لتوليد عملاء HTTP آلياً.</P>
          <P>الرؤوس المطلوبة: لا شيء.</P>
          <Code
            lang="json"
            title="200 OK — مقتطف"
            code={`{
  "openapi": "3.1.0",
  "info": {
    "title": "Vellum Public API",
    "version": "0.0.1"
  },
  "servers": [{ "url": "https://api.example.com" }],
  "paths": {
    "/v1/projects/{projectId}/query": { "post": { "operationId": "queryDocuments" } }
  }
}`}
          />
        </Api>
        <Callout tone="warning" title="الاسم القديم لا يزال موجوداً">
          <P>
            المسار <IC>/v1/health</IC> محفوظ للتوافق مع العملاء القدامى وموسوم <IC>deprecated: true</IC> في استجابته.
            للتكاملات الجديدة استخدم <IC>/v1/health/live</IC> و<IC>/v1/health/ready</IC>.
          </P>
        </Callout>
      </Section>

      <Section id="next" title="ما التالي">
        <UL
          items={[
            <PageLink slug="reference/rest-data-plane" lang="ar">مرجع مستوى البيانات: كل نقطة نهاية بالتفصيل</PageLink>,
            <PageLink slug="reference/rest-control-plane" lang="ar">مرجع مستوى التحكم: المجالات الثلاثة والجلسات</PageLink>,
            <PageLink slug="errors-and-limits" lang="ar">الحصص والحدود الثابتة للإصدار 1</PageLink>,
          ]}
        />
      </Section>
    </Doc>
  );
}
