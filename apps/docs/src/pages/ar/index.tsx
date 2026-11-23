import { Callout, Code, Doc, P, PageLink, Section, Steps, Table, UL } from "../../ui";

export default function Page() {
  return (
    <Doc
      title="مقدمة"
      description="ما هو VELLUM، وكيف تتكامل قاعدتا البيانات في PostgreSQL، والمبادئ المعمارية الصلبة التي يقوم عليها النظام."
      eyebrow="البداية"
    >
      <Section id="what-is-vellum" title="ما هو VELLUM؟">
        <P>
          <strong>VELLUM</strong> هو قاعدة بيانات مستندات سحابية متعددة المستأجرين مبنية بالكامل على{" "}
          <code>PostgreSQL</code> و<code>JSONB</code>. تمنحك مجموعات هرمية (Collections &amp;
          Subcollections)، ومستندات JSON مُنمّطة، واستعلامات مهيكلة بترقيم صفحي يعتمد على المؤشرات
          الموقّعة (Signed Cursors)، وتحويلات حقول ذرية، ومعاملات تزامن متفائل (OCC)، وبثّاً حيّاً عبر{" "}
          <code>WebSocket</code> — من خلال حزم برمجية رسمية لـ TypeScript (<code>@vellumdb/sdk-js</code>) و
          Flutter/Dart (<code>vellum_flutter</code>) أو مباشرة عبر REST HTTP.
        </P>
        <P>
          تعتمد المنصة على <strong>خدمة حالة واحدة فقط في وقت التشغيل: PostgreSQL</strong>. لا وجود لـ
          Redis، ولا لوسيط رسائل خارجي، ولا لخادم تخزين مؤقت منفصل. يُبنى البث الفوري على{" "}
          <code>LISTEN/NOTIFY</code> وصندوق بريد معاملاتي دائم (<code>realtime_outbox</code>)، بينما تعمل
          المعاملات كمعاملات PostgreSQL أصلية تحت حماية العزل على مستوى الصفوف (Row-Level Security).
        </P>
        <Code
          lang="ts"
          title="أول عميل مرتبط بمشروعك"
          code={`import { createClient } from "@vellumdb/sdk-js";

// عميل واحد بنطاق مستأجر واحد: كل طلب يحمل projectId تلقائياً.
const db = createClient({
  endpoint: "http://localhost:8080",
  projectId: "<YOUR_PROJECT_ID>",
  apiKey: "<YOUR_API_KEY>", // pk_ في المتصفح/الجوال، و sk_ على الخادم فقط
});

await db.collection("tasks").doc("task_123").set({
  title: "Ship v1",
  done: false,
  priority: 1,
});

const snapshot = await db.collection("tasks").doc("task_123").get();
console.log(snapshot.id, snapshot.version, snapshot.data());`}
        />
        <P>
          يُوجّه العميل كل طلبات مستوى البيانات إلى <code>/v1/projects/:projectId/…</code>. يمثّل{" "}
          <code>projectId</code> حدود العزل الصارمة التي يفرضها محرك قاعدة البيانات على كل استعلام وكتابة.
        </P>
      </Section>

      <Section id="two-databases" title="قاعدتا بيانات لمنصة واحدة">
        <P>
          ينفصل التخزين إلى قاعدتي بيانات مستقلتين فيزيائياً ومنطقياً، لكل منهما مخططها واتصالها ومسؤوليتها
          المحددة:
        </P>
        <Table
          head={["المستوى", "قاعدة البيانات", "المسؤولية والبيانات المخزّنة"]}
          rows={[
            [
              "مستوى التحكم (Control Plane)",
              <code>control_db</code>,
              "المشاريع، بادئات وتجزئات مفاتيح API، قواعد الأمان المنسّخة، وإعدادات المنصة.",
            ],
            [
              "مستوى البيانات (Data Plane)",
              <code>data_db</code>,
              "مستندات العملاء، تعريفات وإدخالات الفهارس المركّبة، صندوق البريد المعاملاتي realtime_outbox، وجدول معاملات التزامن المتفائل transactions، وجداول مصادقة المستخدمين النهائيين.",
            ],
          ]}
        />
        <P>ينتج عن هذا الفصل ثلاث ثوابت معمارية لا تُكسر:</P>
        <UL
          items={[
            <>
              <strong>إقلاع وتعافٍ مستقلان تماماً عن بيانات العملاء.</strong> تشغيل الخدمة، ومصادقة
              المشغّلين، والتحقق من مفاتيح API لا تعتمد أبداً على قراءة <code>data_db</code>؛ فلا توجد أي
              تبعية دائرية على واجهة المستندات العامة.
            </>,
            <>
              <strong>عزل مستأجرين إلزامي يفشل بأمان (Fail-Closed RLS).</strong> يمر كل طلب بيانات عبر{" "}
              <code>withTenantContext()</code> الذي يربط في رحلة شبكة واحدة مُعامَلة (Parameterized){" "}
              <code>set_config('app.current_project_id', $1, true)</code> مع{" "}
              <code>statement_timeout = '5000ms'</code> و<code>lock_timeout = '2000ms'</code> و
              <code>idle_in_transaction_session_timeout = '15000ms'</code>. وتُفرض سياسات{" "}
              <code>FORCE ROW LEVEL SECURITY</code> على جميع جداول المستأجرين الـ 12 في مستوى البيانات.
            </>,
            <>
              <strong>صفر أوامر DDL للمستأجرين.</strong> تُخزَّن الفهارس المركّبة كصفوف في{" "}
              <code>document_indexes</code> مع مفاتيح فرز ثنائية تحافظ على الترتيب (<code>BYTEA</code>) في{" "}
              <code>document_index_entries</code> — ولا يُنفَّذ <code>CREATE INDEX</code> على جدول{" "}
              <code>documents</code> المشترك إطلاقاً.
            </>,
          ]}
        />
        <Callout tone="info" title="بيانات اعتماد معزولة تماماً">
          يعتمد مستوى البيانات على مفتاح API (<code>pk_</code> أو <code>sk_</code>) مع رمز مستخدم نهائي
          اختياري بتوقيع <code>EdDSA</code> فقط، وأي بيانات اعتماد أخرى مرفوضة عليه — راجع{" "}
          <PageLink slug="authentication" lang="ar">المصادقة</PageLink>.
        </Callout>
      </Section>

      <Section id="zero-redis" title="الوقت الفعلي بلا وسيط خارجي (Zero-Redis)">
        <P>
          تُغني البنية الحالية تماماً عن Redis أو أي وسيط رسائل إضافي. يُكتب التعديل على المستند وحدث
          البث المرتبط به داخل نفس معاملة PostgreSQL، مما يمنع أي انفصال في الحالة بين التخزين والبث:
        </P>
        <Steps
          items={[
            {
              title: "كتابة صف في صندوق البريد المعاملاتي",
              body: (
                <P>
                  كل عملية إنشاء أو تحديث أو حذف تُدرج صفّاً في <code>realtime_outbox</code> يحمل{" "}
                  <code>seq_id</code> متزايداً داخل نفس المعاملة.
                </P>
              ),
            },
            {
              title: "إصدار إشعار NOTIFY خفيف",
              body: (
                <P>
                  يُطلق مُحفّز <code>AFTER INSERT</code> إشعاراً يحتوي فقط على رقم التسلسل ومعرّف المشروع —
                  دون تمرير بيانات المستند عبر قناة الإشعارات.
                </P>
              ),
            },
            {
              title: "إيقاظ عميل LISTEN مخصّص",
              body: (
                <P>
                  اتصال PostgreSQL واحد غير مجمّع (Session-Mode) يوقظ مستقصي صندوق البريد كاشف الفجوات لجلب
                  الصفوف الكاملة عبر طبقة التخزين المحصورة بالمستأجر.
                </P>
              ),
            },
            {
              title: "التوزيع عبر WebSocket مع علامات الاستئناف",
              body: (
                <P>
                  يتلقى المشتركون لقطات حيّة تحمل <code>watermarkSeqId</code>؛ وعند انقطاع الاتصال يُعاد
                  تشغيل الأحداث المفقودة بدقة دون إسقاط أو تكرار.
                </P>
              ),
            },
          ]}
        />
        <P>
          تُدار ذاكرة التخزين المؤقت للمفاتيح ونوافذ تحديد المعدل في هياكل LRU/TTL محدودة داخل العملية مع
          إبطال متزامن بين النسخ عبر <code>NOTIFY vellum_cache_invalidate</code>. للتفاصيل الكاملة راجع{" "}
          <PageLink slug="realtime" lang="ar">الوقت الفعلي</PageLink>.
        </P>
      </Section>

      <Section id="request-lifecycle" title="دورة حياة الطلب داخل الخادم">
        <P>
          المفتاح العام <code>pk_</code> يحدّد هوية المشروع فقط ولا يمنح أي صلاحية ضمنية؛ القرار الأمني
          النهائي يصدر من محرك قواعد الأمان الحتمي:
        </P>
        <Steps
          items={[
            {
              title: "تقديم بيانات الاعتماد",
              body: (
                <P>
                  يُرسل الترويسة القياسية <code>x-vellum-api-key</code> (ويُقبل الاسم القديم{" "}
                  <code>x-project-key</code> للتوافق)، ومعه اختيارياً{" "}
                  <code>authorization: Bearer &lt;jwt&gt;</code> للمستخدم النهائي.
                </P>
              ),
            },
            {
              title: "حواجز الأمان وفك نطاق المستأجر",
              body: (
                <P>
                  تفحص الطبقة الوسطى قائمة الحظر، وحدود الحجم والبنية الآمنة لـ JSON، وقيود الأصل/IP،
                  وحصص الخطة، ثم تتحقق من رمز <code>EdDSA</code> وترفض أي مفتاح لا يخص المشروع المطلوب.
                </P>
              ),
            },
            {
              title: "تقييم قواعد الأمان الحتمية",
              body: (
                <P>
                  تُقيَّم شجرة قواعد v1 (JSON AST) في الذاكرة بقاعدة الرفض الافتراضي (Deny-by-Default) ضمن
                  حدود صارمة (<code>maxDepth ≤ 10</code> و<code>maxNodes ≤ 100</code>) ودون استخدام{" "}
                  <code>eval()</code> إطلاقاً.
                </P>
              ),
            },
            {
              title: "التنفيذ والالتزام تحت RLS",
              body: (
                <P>
                  يفتح محرك المستندات معاملة محمية بـ <code>withTenantContext</code>، ويحفظ المستند وحدث
                  صندوق البريد معاً، مع ضمان تدمير الاتصال الملوّث إذا فشل <code>ROLLBACK</code>.
                </P>
              ),
            },
          ]}
        />
      </Section>

      <Section id="verified" title="التحقق المباشر ضد خادم حقيقي">
        <P>
          تختبر أداة <code>tests/dart-verify</code> الخادم الفعلي عبر HTTP وWebSocket دون أي محاكاة أو
          استجابات وهمية. تُظهر النتائج الموثّقة نجاح <strong>55 من أصل 55 فحصاً</strong> تشمل CRUD
          والاستعلام والوقت الفعلي والكتابات الدفعية ومعاملات OCC والمصادقة وعزل المجالات الثلاثة:
        </P>
        <Table
          head={["المجال", "النتيجة"]}
          rows={[
            ["الاتصال والفحوص (live / ready)", "2/2"],
            ["تجهيز بيانات الاستعلام", "1/1"],
            ["عمليات CRUD", "7/7"],
            ["الاستعلام والترقيم الصفحي", "11/11"],
            ["الوقت الفعلي (WebSocket)", "2/2"],
            ["الكتابات الدفعية (Batch)", "2/2"],
            ["معاملات التزامن المتفائل (OCC)", "1/1"],
            ["المجموعات الفرعية (Subcollections)", "1/1"],
            ["رموز الأخطاء والحدود", "4/4"],
            ["مصادقة المستخدم النهائي", "8/8"],
            ["التخويل وعزل المجالات", "16/16"],
          ]}
        />
        <Code
          lang="bash"
          title="تشغيل حزمة التحقق بنفسك"
          code={`export PATH="$PWD/.tools/dart-sdk/bin:$PATH"
cd tests/dart-verify && dart pub get && cd ../..

dart run tests/dart-verify \\
  --VELLUM_ENDPOINT=http://127.0.0.1:8080 \\
  --VELLUM_PROJECT_ID=<project-uuid> \\
  --VELLUM_API_KEY=pk_... \\
  --VELLUM_REPORT=tests/dart-verify/VERIFICATION-REPORT.md`}
        />
      </Section>

      <Section id="where-to-start" title="من أين تبدأ؟">
        <UL
          items={[
            <>
              <PageLink slug="quickstart" lang="ar">البدء السريع</PageLink> — شغّل البيئة المحلية، ثبّت
              الحزمة البرمجية، ونفّذ أول عملية كتابة واستعلام خلال دقائق.
            </>,
            <>
              <PageLink slug="query" lang="ar">الاستعلام</PageLink> و{" "}
              <PageLink slug="pagination" lang="ar">الترقيم الصفحي</PageLink> — عوامل التصفية الـ 13،
              والترتيب، والمؤشرات الموقّعة.
            </>,
            <>
              <PageLink slug="sdks/javascript" lang="ar">حزمة JavaScript / TypeScript</PageLink> و{" "}
              <PageLink slug="sdks/flutter" lang="ar">حزمة Flutter / Dart</PageLink> — المرجع العملي الكامل
              للواجهات البرمجية المحصّنة.
            </>,
            <>
              <PageLink slug="security-and-defense" lang="ar">الأمان والدفاع المتعدد الطبقات</PageLink> —
              حماية الحمولة وتكلفة الاستعلام وعزل المجالات وسجل التدقيق المشفّر.
            </>,
            <>
              <PageLink slug="production-checklist" lang="ar">قائمة التحقق للإنتاج</PageLink> و{" "}
              <PageLink slug="deployment" lang="ar">النشر والاستضافة</PageLink> — جاهزية التشغيل الفعلي.
            </>,
          ]}
        />
      </Section>
    </Doc>
  );
}
