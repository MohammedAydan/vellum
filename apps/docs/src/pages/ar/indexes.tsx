import {
  Api,
  Callout,
  Code,
  CodeTabs,
  Doc,
  H3,
  P,
  PageLink,
  Section,
  Table,
  UL,
} from "../../ui";

const needsIndexJs = `// الترتيب على حقلين مخصصين أو الجمع بين نطاق وترتيب يتطلب فهرساً مركّباً.
try {
  const page = await db
    .collection("users")
    .where("status", "==", "open")
    .orderBy("status")
    .orderBy("priority", "desc")
    .limit(50)
    .get();
  console.log(page.docs.length);
} catch (err) {
  const e = err as Error & {
    code?: string;
    details?: {
      suggestedIndex?: {
        collectionPath: string;
        fields: Array<{ path: string; dir: string }>;
      };
    };
  };
  if (e.code === "FAILED_PRECONDITION") {
    console.log("Create this index:", e.details?.suggestedIndex);
  }
}`;

const needsIndexFlutter = `try {
  final page = await client
      .collection('users')
      .where('status', '==', 'open')
      .orderBy('status')
      .orderBy('priority', dir: 'desc')
      .limit(50)
      .get();
  print(page.docs.length);
} on VellumException catch (e) {
  if (e.code == 'FAILED_PRECONDITION') {
    print('Create this index: \${e.details['suggestedIndex']}');
  }
}`;

const needsIndexRest = `# يعيد الاستعلام 412 FAILED_PRECONDITION مع suggestedIndex داخل error.details.
curl -s -X POST \\
  "https://api.example.com/v1/projects/<PROJECT_ID>/query" \\
  -H "x-vellum-api-key: <API_KEY>" \\
  -H "content-type: application/json" \\
  -d '{
    "collectionPath": "users",
    "orderBy": [
      { "field": "status", "dir": "asc" },
      { "field": "priority", "dir": "desc" }
    ],
    "limit": 50
  }'`;

const indexDefinition = `{
  "collectionPath": "users",
  "fields": [
    { "path": "status", "dir": "asc" },
    { "path": "priority", "dir": "desc" }
  ]
}`;

const createIndexCurl = `# يتطلب مفتاح خادم sk_ بصلاحية indexes:manage.
curl -s -X POST \\
  "https://api.example.com/v1/projects/<PROJECT_ID>/indexes" \\
  -H "x-vellum-api-key: <SERVER_KEY>" \\
  -H "content-type: application/json" \\
  -d '{
    "collectionPath": "users",
    "fields": [
      { "path": "status", "dir": "asc" },
      { "path": "priority", "dir": "desc" }
    ]
  }'`;

const pollIndexCurl = `# يعود التسجيل فوراً بحالة "building"؛ استعلم حتى تصبح الحالة "ready".
curl -s "https://api.example.com/v1/projects/<PROJECT_ID>/indexes" \\
  -H "x-vellum-api-key: <SERVER_KEY>" \\
  | jq '.indexes[] | {id, status, errorMessage}'`;

const singleScan = `-- كل إدخال فهرس يُخزَّن بمفتاح فرز ثنائي يحافظ على الترتيب.
PRIMARY KEY (index_id, sort_key, document_id)

-- يتحوّل الاستعلام متعدد الحقول إلى مسح B-Tree تصاعدي واحد.
SELECT ...
FROM document_index_entries ie
JOIN documents d ON d.project_id = ie.project_id AND d.path = ie.path
WHERE ie.index_id = $index_id
  AND (ie.sort_key, ie.document_id) > ($start_key::bytea, $doc_id)
ORDER BY ie.sort_key ASC, ie.document_id ASC;`;

export default function Page() {
  return (
    <Doc
      title="الفهارس المركّبة"
      description="فهارس المستأجرين كصفوف بلا DDL، ومفاتيح الفرز الثنائية BYTEA المحافظة على الترتيب، ودورة حياة البناء والحالات."
      eyebrow="المفاهيم الأساسية"
    >
      <Section id="overview" title="نظرة عامة">
        <P>
          تُسرّع الفهارس المركّبة الاستعلامات التي تصفّي أو ترتّب بناءً على حقول مخصصة داخل المستندات. لأن
          تنفيذ <code>CREATE INDEX</code> لكل عميل على جدول <code>documents</code> المشترك يسبّب تضخماً في
          فهارس النظام وأقفال DDL خطرة، يُخزّن VELLUM فهارس كل مستأجر <strong>كصفوف بيانات عادية، لا كأوامر DDL</strong>.
        </P>
        <Callout tone="danger" title="ثابت معماري: صفر أوامر DDL للمستأجرين">
          لا يُنفَّذ <code>CREATE INDEX</code> على جدول <code>documents</code> المشترك لفهرس خاص بمستأجر
          أبداً. تعيش التعريفات في <code>document_indexes</code> وتعيش الإدخالات في{" "}
          <code>document_index_entries</code> بمفتاح فرز <code>sort_key BYTEA</code>، وكلا الجدولين محميان
          بـ <code>FORCE ROW LEVEL SECURITY</code>.
        </Callout>
        <Table
          head={["الجدول", "الدور"]}
          rows={[
            [<code>document_indexes</code>, "تعريف الفهرس: مسار المجموعة، قائمة الحقول المرتبة، بصمة التعريف، وحالة البناء"],
            [<code>document_index_entries</code>, "صف واحد لكل مستند مفهرس، بمفتاح أساسي (index_id, sort_key, document_id)"],
          ]}
        />
        <P>
          يقبل التعريف حتى <strong>ثلاثة حقول</strong> (بمسار نقطي واتجاه <code>asc</code> أو{" "}
          <code>desc</code>). توضع حقول المساواة أولاً كبادئة، تليها حقول الترتيب المخصصة باتجاهاتها.
        </P>
        <Code lang="json" title="تعريف فهرس مركّب" code={indexDefinition} />
      </Section>

      <Section id="sort-keys" title="مفاتيح الفرز المحافظة على الترتيب (Order-Preserving Sort Keys)">
        <P>
          يُرمّز المحرك قيم الحقول المفهرسة لكل مستند في سلسلة بايتات واحدة (<code>BYTEA</code>) قابلة
          للمقارنة المعجمية المباشرة. يُضاف بايت بادئة لكل نوع منطقي لضمان ترتيب الأنواع بشكل حتمي، وتُقلَب
          بتّات مقاطع الحقول ذات الاتجاه <code>desc</code> بحيث يكفي مسح B-Tree تصاعدي واحد لإنتاج الترتيب
          التنازلي المطلوب:
        </P>
        <Table
          head={["البادئة", "النوع المنطقي", "البادئة", "النوع المنطقي"]}
          rows={[
            [<code>0x05</code>, "مفقود / undefined", <code>0x30</code>, "نص UTF-8 (مُهرَّب ومُنهى)"],
            [<code>0x0A</code>, "null", <code>0x40</code>, "طابع زمني (64-bit ms موقّع)"],
            [<code>0x10</code>, "منطقي (Boolean)", <code>0x50</code>, "مرجع مستند (UTF-8 path)"],
            [<code>0x20</code>, "رقم / int64", <code>0x60</code>, "بايتات ثنائية (مُهرَّبة ومُنهى)"],
          ]}
        />
        <P>
          تقارن PostgreSQL قيم <code>BYTEA</code> بايتاً تلو الآخر من اليسار إلى اليمين. ومع المفتاح الأساسي{" "}
          <code>(index_id, sort_key, document_id)</code> يُنفَّذ الاستعلام متعدد الحقول والترقيم الصفحي عبر
          مسح فهرس واحد سريع.
        </P>
        <Code lang="sql" title="شكل الاستعلام المفهرس" code={singleScan} />
      </Section>

      <Section id="when-required" title="متى يُطلب الفهرس المركّب؟">
        <UL
          items={[
            <>
              <strong>لا يلزم إعداد يدوي:</strong> فلاتر المساواة (<code>{"=="}</code>، <code>in</code>)
              والترتيب على الحقول النظامية (<code>documentId</code>، <code>createdAt</code>،{" "}
              <code>updatedAt</code>) تستخدم فهارس B-Tree وGIN المدمجة تلقائياً.
            </>,
            <>
              <strong>يلزم فهرس مركّب جاهز (<code>ready</code>):</strong> الترتيب على حقلين مخصصين أو
              أكثر، أو الجمع بين شرطَي نطاق أو أكثر، أو الترتيب على حقل مخصص يختلف عن حقل النطاق.
            </>,
          ]}
        />
        <CodeTabs
          tabs={[
            { label: "JavaScript / TypeScript", lang: "typescript", code: needsIndexJs },
            { label: "Flutter / Dart", lang: "dart", code: needsIndexFlutter },
            { label: "REST", lang: "bash", code: needsIndexRest },
          ]}
        />
        <Callout tone="info" title="دع المخطّط يرشّح لك التعريف الدقيق">
          يُشتق كائن <code>suggestedIndex</code> داخل خطأ <code>FAILED_PRECONDITION</code> مباشرة من
          الاستعلام الذي أرسلته. راجع أيضاً{" "}
          <PageLink slug="smart-indexing" lang="ar">الفهرسة الذكية والأداء</PageLink> للتوصيات الاستباقية
          والإنشاء بنقرة واحدة.
        </Callout>
      </Section>

      <Section id="lifecycle" title="الإنشاء والحالات ومنع التكرار">
        <P>
          إدارة الفهارس عملية إدارية مميّزة تتطلب مفتاح خادم <code>sk_</code> يحمل النطاق{" "}
          <code>indexes:manage</code> عبر الترويسة <code>x-vellum-api-key</code>؛ لا يمكن لمفاتيح{" "}
          <code>pk_</code> العامة إنشاء الفهارس أو حذفها.
        </P>
        <Table
          head={["الطريقة", "نقطة النهاية", "الغرض"]}
          rows={[
            [<code>GET</code>, <code>/v1/projects/:projectId/indexes</code>, "عرض قائمة الفهارس وحالاتها"],
            [<code>POST</code>, <code>/v1/projects/:projectId/indexes</code>, "تسجيل فهرس جديد وبدء تعبئته الخلفية"],
            [<code>DELETE</code>, <code>/v1/projects/:projectId/indexes/:indexId</code>, "حذف فهرس وإزالة جميع إدخالاته"],
          ]}
        />
        <Api method="POST" path="/v1/projects/:projectId/indexes">
          <P>يستقبل جسم الطلب مسار المجموعة ومصفوفة الحقول المرتبة كما في التعريف أعلاه.</P>
        </Api>
        <Code lang="bash" title="تسجيل فهرس جديد" code={createIndexCurl} />
        <P>
          يعود التسجيل فوراً بحالة <code>building</code>. يلتقط عامل التعبئة الخلفي (Backfill Worker) الصفوف
          قيد البناء ويمسح المستندات النشطة على دفعات حتمية من <strong>500 مستند</strong> مرتبة بـ{" "}
          <code>document_id ASC</code> لحساب <code>sort_key</code> وإدراج الإدخالات حتى تتحوّل الحالة إلى{" "}
          <code>ready</code>. بعد ذلك تُحدَّث الإدخالات معاملاتياً مع كل كتابة جديدة.
        </P>
        <Code lang="bash" title="التحقق من الجاهزية" code={pollIndexCurl} />
        <Table
          head={["الحالة", "المعنى"]}
          rows={[
            [<code>building</code>, "تم التسجيل ويعمل عامل التعبئة الخلفية على بناء الإدخالات"],
            [<code>ready</code>, "مكتمل ومتاح لمخطّط الاستعلامات"],
            [<code>failed</code>, "فشل البناء؛ يوضّح الحقل errorMessage السبب"],
            [<code>deleting</code>, "قيد الحذف والتنظيف"],
          ]}
        />
        <H3 id="duplicates">منع التكرار (Deduplication)</H3>
        <P>
          يُحسب لكل تعريف <code>definitionHash</code> فريد بناءً على المشروع ومسار المجموعة والحقول ويُفرض
          بقيد <code>UNIQUE</code> في قاعدة البيانات. محاولة إنشاء فهرس مطابق تعيد{" "}
          <code>ALREADY_EXISTS</code> (409) — أعد استخدام الفهرس القائم بدلاً من تكرار الطلب.
        </P>
      </Section>

      <Section id="operations" title="تشغيل الفهارس المركّبة والحدود">
        <P>
          تُحتسب إدخالات الفهارس ضمن استهلاك التخزين وتُحدَّث مع كل عملية كتابة، لذا حافظ على فهارس مركّزة
          تخدم استعلامات فعلية واحذف غير المستخدم منها. تتيح حدود v1 الثابتة <strong>50</strong> فهرساً
          مركّباً في الخطة المجانية و<strong>200</strong> فهرس في خطة Pro (<code>QUOTA_EXCEEDED</code> عند
          التجاوز).
        </P>
        <Table
          head={["المزلق", "الأثر"]}
          rows={[
            ["استخدام مفتاح pk_ لإدارة الفهارس", "مرفوض — يتطلب مفتاح sk_ بصلاحية indexes:manage"],
            ["تشغيل الاستعلام قبل وصول الحالة إلى ready", "يتجاهله المخطّط وقد يعود خطأ FAILED_PRECONDITION"],
            ["إعادة تسجيل تعريف مطابق", "يعود ALREADY_EXISTS (409)"],
            ["فهرسة كل حقل دون حاجة فعلية", "تكلفة تخزين إضافية وبطء في عمليات الكتابة"],
          ]}
        />
        <P>
          راجع <PageLink slug="smart-indexing" lang="ar">الفهرسة الذكية والأداء</PageLink> للتعرّف على مستشار
          E/S/R، و<PageLink slug="pagination" lang="ar">الترقيم الصفحي</PageLink> لتكامل <code>sortKey</code>{" "}
          مع المؤشرات الموقّعة.
        </P>
      </Section>
    </Doc>
  );
}
