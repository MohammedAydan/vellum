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
  Steps,
  Table,
  UL,
} from "../../ui";

const basicQueryJs = `import { createClient } from "@vellum/sdk-js";

const db = createClient({
  endpoint: "https://api.example.com",
  projectId: "<PROJECT_ID>",
  apiKey: "<API_KEY>", // pk_ في المتصفح، sk_ على الخادم
});

const page = await db
  .collection("users")
  .where("age", ">=", 18)
  .where("status", "==", "active")
  .orderBy("age", "desc")
  .limit(25)
  .get();

for (const doc of page.docs) {
  console.log(doc.id, doc.version, doc.data());
}`;

const basicQueryFlutter = `import 'package:vellum_flutter/vellum_flutter.dart';

final client = VellumClient(
  endpoint: 'https://api.example.com',
  projectId: '<PROJECT_ID>',
  apiKey: '<API_KEY>', // pk_ في التطبيق، sk_ على الخادم فقط
);

final page = await client
    .collection('users')
    .where('age', '>=', 18)
    .where('status', '==', 'active')
    .orderBy('age', dir: 'desc')
    .limit(25)
    .get();

for (final doc in page.docs) {
  print('\${doc.id} v\${doc.version} \${doc.data()}');
}`;

const basicQueryRest = `curl -s -X POST \\
  "https://api.example.com/v1/projects/<PROJECT_ID>/query" \\
  -H "x-vellum-api-key: <API_KEY>" \\
  -H "content-type: application/json" \\
  -d '{
    "collectionPath": "users",
    "where": [
      { "field": "age", "op": ">=", "value": 18 },
      { "field": "status", "op": "==", "value": "active" }
    ],
    "orderBy": [{ "field": "age", "dir": "desc" }],
    "limit": 25
  }'`;

const reusableJs = `// منشئ الاستعلام غير قابل للتعديل (Immutable): كل دالة تعيد نسخة جديدة.
const base = db.collection("users").where("active", "==", true);

const young = await base
  .where("age", "<", 30)
  .select("name", "age", "profile.city")
  .limit(20)
  .get();

const seniors = await base
  .where("age", ">=", 65)
  .orderBy("name")
  .limit(20)
  .get();

// استعلام بشروط OR (AND داخل كل مجموعة و OR بين المجموعات)
const vipOrCairo = await db
  .collection("users")
  .or([
    [{ field: "plan", op: "==", value: "enterprise" }],
    [{ field: "profile.city", op: "==", value: "Cairo" }],
  ])
  .limit(50)
  .get();

// استعراض الحمولة القياسية المُرسَلة عبر الشبكة
console.log(base.toQuerySpec());`;

const reusableFlutter = `// الكائن Query غير قابل للتعديل؛ يمكن إعادة استخدام الاستعلام الأساسي بأمان.
final base = client.collection('users').where('active', '==', true);

final young = await base
    .where('age', '<', 30)
    .select(['name', 'age', 'profile.city'])
    .limit(20)
    .get();

final seniors = await base
    .where('age', '>=', 65)
    .orderBy('name')
    .limit(20)
    .get();

// استعلام بشروط OR
final vipOrCairo = await client
    .collection('users')
    .or([
      [{'field': 'plan', 'op': '==', 'value': 'enterprise'}],
      [{'field': 'profile.city', 'op': '==', 'value': 'Cairo'}],
    ])
    .limit(50)
    .get();

print(base.toQuerySpec());`;

const reusableRest = `{
  "collectionPath": "users",
  "where": [{ "field": "active", "op": "==", "value": true }],
  "or": [
    [{ "field": "plan", "op": "==", "value": "enterprise" }],
    [{ "field": "profile.city", "op": "==", "value": "Cairo" }]
  ],
  "orderBy": [{ "field": "age", "dir": "desc" }],
  "select": ["name", "plan", "profile.city"],
  "limit": 50
}`;

const responseJson = `{
  "documents": [
    {
      "path": "users/u_123",
      "collectionPath": "users",
      "collectionGroup": "users",
      "documentId": "u_123",
      "data": { "name": "Ada", "age": 36, "plan": "pro" },
      "sizeBytes": 128,
      "version": 3,
      "createdAt": "2026-11-15T14:30:00.123Z",
      "updatedAt": "2026-11-17T09:00:00.000Z"
    }
  ],
  "nextCursor": null,
  "meta": {
    "count": 1,
    "indexUsed": "composite:<INDEX_ID>",
    "executionTimeMs": 1.234,
    "compiledSql": "SELECT ... (لأغراض التشخيص فقط)"
  }
}`;

export default function Page() {
  return (
    <Doc
      title="الاستعلام"
      description="عوامل التصفية الـ 13، الترتيب، الإسقاط، الحدود الأمنية المحصّنة، متطلبات الفهارس المركّبة، وتجميع SQL المُعامَل."
      eyebrow="المفاهيم الأساسية"
    >
      <Section id="overview" title="نظرة عامة">
        <P>
          يقرأ الاستعلام المستندات من مسار مجموعة واحد <code>collectionPath</code> داخل نطاق{" "}
          <code>projectId</code> محدد. تبني الحزمة البرمجية كائن <code>QuerySpecPayload</code> وتُرسله إلى
          مستوى البيانات، حيث يتحقق المحرك (<code>@vellum/query-engine</code>) من كل حقل وعامل وقيمة، ثم
          يجمّع الاستعلام إلى SQL مُعامَل بالكامل (Parameterized SQL) يُنفَّذ داخل معاملة مستأجر محمية بـ
          PostgreSQL RLS ومهلة <code>statement_timeout = 5000ms</code>.
        </P>
        <Api method="POST" path="/v1/projects/:projectId/query">
          <P>
            يُرسَل <code>x-vellum-api-key</code> مع مفتاح <code>pk_</code> أو <code>sk_</code>، ويمكن إرفاق
            رمز <code>EdDSA</code> للمستخدم النهائي لتطبيق قيود قواعد الأمان.
          </P>
        </Api>
        <CodeTabs
          tabs={[
            { label: "JavaScript / TypeScript", lang: "typescript", code: basicQueryJs },
            { label: "Flutter / Dart", lang: "dart", code: basicQueryFlutter },
            { label: "REST", lang: "bash", code: basicQueryRest },
          ]}
        />
      </Section>

      <Section id="filter-operators" title="عوامل التصفية المدعومة (13 عاملاً)">
        <P>
          يُجمَّع كل شرط <code>where(field, op, value)</code> إلى تعبير SQL مُنمّط بدقة. لا يتحوّل أي عامل
          بصمت إلى <code>TRUE</code>، ولا تُقارن القيم عبر عائلات أنواع مختلفة أبداً:
        </P>
        <Table
          head={["العامل", "القيم المقبولة", "الدلالة الفعلية في المحرك"]}
          rows={[
            [<code>{"=="}</code>, "قيمة أولية، كائن/مصفوفة، طابع زمني، مرجع، أو null", "مساواة تامة؛ تستخدم GIN @> للقيم الأولية ومطابقة بنيوية دقيقة للكائنات والمصفوفات"],
            [<code>{"!="}</code>, "أي قيمة سلكية صالحة", "الحقل موجود في المستند وقيمته لا تساوي القيمة المحددة"],
            [
              <span><code>{"<"}</code>، <code>{"<="}</code>، <code>{">"}</code>، <code>{">="}</code></span>,
              "number، int64، string، timestamp",
              "مقارنة نطاق ضمن نفس النوع (وترفض null بخطأ INVALID_ARGUMENT)",
            ],
            [<code>in</code>, "مصفوفة من 1 إلى 30 قيمة", "قيمة الحقل تطابق أحد العناصر (مع إزالة التكرارات تلقائياً)"],
            [<code>not-in</code>, "مصفوفة من 1 إلى 30 قيمة", "الحقل موجود ولا يطابق أياً من العناصر"],
            [<code>array-contains</code>, "قيمة سلكية صالحة", "الحقل مصفوفة تحتوي على القيمة المطلوبة عبر GIN @>"],
            [<code>array-contains-any</code>, "مصفوفة من 1 إلى 30 قيمة", "المصفوفة تحتوي على قيمة واحدة على الأقل (محدودة بإجمالي 120 توسّع OR في الاستعلام)"],
            [<code>contains_ci</code>, "سلسلة نصية (حتى 1024 حرفاً)", "بحث جزئي غير حساس لحالة الأحرف (ILIKE مع تهريب أحرف % و _ و \\ بأمان)"],
            [<code>starts_with_ci</code>, "سلسلة نصية (حتى 1024 حرفاً)", "مطابقة بادئة غير حساسة لحالة الأحرف مع تهريب أنماط LIKE"],
            [<code>text_search</code>, "سلسلة نصية (حتى 1024 حرفاً)", "بحث نصي كامل عبر to_tsvector('simple', ...) @@ plainto_tsquery('simple', $n)"],
          ]}
        />
        <H3 id="special-fields">الحقول النظامية والمسارات المتداخلة</H3>
        <P>
          تُقارن الحقول النظامية مباشرة عبر أعمدة B-Tree الأصلية في PostgreSQL لتحقيق أقصى سرعة:{" "}
          <code>documentId</code> (أو <code>__name__</code>) و<code>createdAt</code> و<code>updatedAt</code>{" "}
          (بصيغة <code>timestamptz</code>). أما الحقول المخصصة فتدعم المسارات النقطية مثل{" "}
          <code>profile.city</code> حتى عمق أقصاه <strong>16 مستوى</strong> (<code>MAX_FIELD_DEPTH</code>)،
          مع رفض مقاطع تلويث النماذج الأولية (<code>__proto__</code>، <code>constructor</code>،{" "}
          <code>prototype</code>) فوراً.
        </P>
        <Callout tone="info" title="شرط وجود الحقل في العوامل السالبة">
          العاملان <code>{"!="}</code> و<code>not-in</code> يطابقان المستندات التي <strong>يوجد فيها الحقل فعلياً</strong>.
          غياب الحقل من المستند لا يكافئ القيمة <code>null</code>.
        </Callout>
      </Section>

      <Section id="ordering-projection-and-limits" title="الترتيب والإسقاط والحدود المحصّنة">
        <UL
          items={[
            <>
              حد أقصى <strong>10</strong> شروط في <code>where</code> و<strong>10</strong> مجموعات في{" "}
              <code>or</code> و<strong>3</strong> حقول في <code>orderBy</code> (مع منع تكرار نفس الحقل)؛
              تجاوز أي منها يعيد <code>QUERY_TOO_COMPLEX</code> (400).
            </>,
            <>
              يُضاف <code>documentId ASC</code> تلقائياً كفاصل حسم نهائي (Tie-Breaker) ما لم يُذكر صراحةً في{" "}
              <code>orderBy</code>، مما يضمن ترتيباً كلياً حتمياً لكل مؤشر ترقيم.
            </>,
            <>
              <code>select(...fields)</code> يُسقط حقولاً محددة (بما فيها المسارات النقطية) حتى{" "}
              <strong>50 حقلاً</strong> كحد أقصى (<code>MAX_SELECT_FIELDS</code>، متوافق مع حد 100 وسيط في{" "}
              <code>jsonb_build_object</code> في PostgreSQL).
            </>,
            <>
              <code>limit(n)</code> يقبل قيماً صحيحة من <code>1</code> إلى <code>500</code> بقيمة افتراضية{" "}
              <code>50</code>؛ أي قيمة خارج النطاق تعيد <code>LIMIT_EXCEEDED</code> (400)، وتجاوز حجم الاستجابة
              4 MiB يعيد <code>RESPONSE_TOO_LARGE</code> (413).
            </>,
            <>
              سقف المسح الاحتياطي غير المفهرس هو <strong>1,000 صف</strong> (<code>UNINDEXED_SCAN_CAP</code>)
              ولا يقوم المحرك أبداً ببتر النتائج بصمت.
            </>,
          ]}
        />
        <CodeTabs
          tabs={[
            { label: "JavaScript / TypeScript", lang: "typescript", code: reusableJs },
            { label: "Flutter / Dart", lang: "dart", code: reusableFlutter },
            { label: "REST", lang: "json", code: reusableRest },
          ]}
        />
      </Section>

      <Section id="composite-index-requirements" title="متى يصبح الفهرس المركّب إلزامياً؟">
        <P>
          تُخدم استعلامات المساواة البسيطة والترتيب على الحقول النظامية عبر الفهارس المدمجة تلقائياً. أما
          الفهرس المركّب فيصبح مطلوباً عند الترتيب على حقلين مخصصين أو أكثر، أو تطبيق شرطَي نطاق أو أكثر،
          أو الترتيب على حقل مخصص يختلف عن حقل النطاق. عند غياب فهرس بحالة <code>ready</code> يفشل الخادم
          بوضوح ويعيد تعريف الفهرس المقترح:
        </P>
        <Code
          lang="json"
          title="FAILED_PRECONDITION · HTTP 412"
          code={`{
  "error": {
    "code": "FAILED_PRECONDITION",
    "requestId": "req_01J...",
    "message": "Query on 'users' requires a composite index for the requested filters and sort order.",
    "details": {
      "collectionPath": "users",
      "suggestedIndex": {
        "collectionPath": "users",
        "fields": [
          { "path": "status", "dir": "asc" },
          { "path": "priority", "dir": "desc" }
        ]
      }
    }
  }
}`}
        />
        <Callout tone="warning" title="أنشئ الفهرس المقترح ثم أعد المحاولة">
          سجّل التعريف الوارد في <code>suggestedIndex</code> عبر مفتاح خادم <code>sk_</code> أو بنقرة واحدة
          من لوحة التحكم، وانتظر حتى تصبح حالته <code>ready</code>. راجع{" "}
          <PageLink slug="indexes" lang="ar">الفهارس المركّبة</PageLink> و{" "}
          <PageLink slug="smart-indexing" lang="ar">الفهرسة الذكية والأداء</PageLink>.
        </Callout>
      </Section>

      <Section id="sql-compilation" title="كيف يُجمَّع الاستعلام إلى SQL؟">
        <P>
          يعمل مُجمّع الاستعلامات داخل حزمة <code>@vellum/query-engine</code> المستقلة عن أطر الويب. لا
          تُدمج أي قيمة نصية من المستخدم داخل جملة SQL مطلقاً، وجميع القيم تُمرَّر كمعاملات مرتبطة{" "}
          (<code>$1, $2, …</code>):
        </P>
        <Steps
          items={[
            {
              title: "التحقق والتطبيع (Validation & Normalization)",
              body: "فحص مسار المجموعة وأسماء الحقول وعمق التداخل (≤16) والقيم السلكية وسقف الشروط والتوسّعات المنطقية وحدود الصفحات.",
            },
            {
              title: "تجميع الشروط المُنَمّطة",
              body: (
                <>
                  تحويل المساواة و<code>array-contains</code> إلى <code>d.data @&gt; $n::jsonb</code> مع
                  تحقق بنيوي تام للكائنات والمصفوفات، وإضافة حراس النوع لمقارنات النطاق (<code>numeric</code>،
                  و<code>COLLATE &quot;C&quot;</code> للنصوص، و<code>bigint</code> للطوابع الزمنية).
                </>
              ),
            },
            {
              title: "ربط سياق المستأجر والمهلة",
              body: (
                <>
                  تنفيذ المعاملة عبر <code>withTenantContext</code> بربط <code>app.current_project_id</code>{" "}
                  و<code>statement_timeout = '5000ms'</code> لضمان العزل الكامل عبر RLS.
                </>
              ),
            },
            {
              title: "اختيار الخطة والترقيم الصفحي",
              body: (
                <>
                  استخدام الفهارس المدمجة أو مسح B-Tree واحد عبر <code>document_index_entries</code> باستخدام
                  مقارنة الصفوف المركّبة <code>(ie.sort_key, ie.document_id) &gt; ($key::bytea, $id)</code>،
                  مع جلب <code>limit + 1</code> صف لتوليد <code>nextCursor</code> بدقة.
                </>
              ),
            },
          ]}
        />
        <Callout tone="info" title="حقل meta.compiledSql للتشخيص فقط">
          يُعرض <code>meta.compiledSql</code> للمساعدة في تتبع الأداء وتدقيق الخطط، ولا يُعد عقداً ثابتاً
          للواجهة البرمجية — لا تبنِ عليه منطق تحليل في تطبيقك.
        </Callout>
      </Section>

      <Section id="response-and-errors" title="شكل الاستجابة ورموز الأخطاء">
        <Code lang="json" title="استجابة /query" code={responseJson} />
        <Table
          head={["الرمز المعياري", "HTTP", "السبب"]}
          rows={[
            [<code>INVALID_ARGUMENT</code>, "400", "عامل غير مدعوم، اسم حقل محظور، قيمة غير صالحة، أو حد نطاق null"],
            [<code>QUERY_TOO_COMPLEX</code>, "400", "تجاوز 10 شروط where أو 3 حقول orderBy أو 30 قيمة in أو عمق 16 أو 50 حقل select أو 120 توسّع OR"],
            [<code>LIMIT_EXCEEDED</code>, "400", "قيمة limit خارج النطاق 1–500"],
            [<code>INVALID_CURSOR</code>, "400", "مؤشر تم التلاعب به أو أُعيد استخدامه مع استعلام مختلف الشكل"],
            [<code>FAILED_PRECONDITION</code>, "412", "غياب فهرس مركّب مطلوب أو تجاوز سقف المسح غير المفهرس"],
            [<code>RESPONSE_TOO_LARGE</code>, "413", "تجاوز حجم الاستجابة المسلسلة 4 MiB"],
            [<code>QUERY_DEADLINE_EXCEEDED</code>, "504", "تجاوز الاستعلام مهلة التنفيذ 5,000 ms"],
          ]}
        />
        <P>
          تابع مع <PageLink slug="pagination" lang="ar">الترقيم الصفحي</PageLink> لفهم آلية توقيع المؤشرات،
          أو راجع <PageLink slug="relationships" lang="ar">العلاقات والاستعلامات المتقدمة</PageLink> لاستخدام{" "}
          <code>include</code> و<code>aggregate</code> و<code>deleteWhere</code>.
        </P>
      </Section>
    </Doc>
  );
}
