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

const loopJs = `import { createClient } from "@vellumdb/sdk-js";

const db = createClient({
  endpoint: "https://api.example.com",
  projectId: "<PROJECT_ID>",
  apiKey: "<API_KEY>",
});

const q = db
  .collection("orders")
  .where("status", "==", "paid")
  .orderBy("total", "desc")
  .limit(20);

// الأسلوب اليدوي عبر startAfter
let cursor: string | null = null;
do {
  const page = await (cursor ? q.startAfter(cursor) : q).get();
  for (const doc of page.docs) console.log(doc.id, doc.data());
  cursor = page.nextCursor; // null تعني نهاية النتائج
} while (cursor);

// أو الأسلوب الانسيابي الحديث بذاكرة محدودة (Async Generator)
const controller = new AbortController();
for await (const doc of q.stream({ pageSize: 50, maxDocs: 500, signal: controller.signal })) {
  console.log(doc.id, doc.data());
}`;

const loopFlutter = `final q = client
    .collection('orders')
    .where('status', '==', 'paid')
    .orderBy('total', dir: 'desc')
    .limit(20);

// الأسلوب اليدوي عبر startAfter
String? cursor;
do {
  final page = await (cursor == null ? q : q.startAfter(cursor)).get();
  for (final doc in page.docs) {
    print(doc.id);
  }
  cursor = page.nextCursor;
} while (cursor != null);

// أو عبر التدفقات المدمجة (Streams) بذاكرة محدودة
await for (final doc in q.streamDocuments(pageSize: 50, maxDocuments: 500)) {
  print('\${doc.id} \${doc.data()}');
}`;

const loopRest = `# الصفحة الأولى — بدون أي مؤشر
curl -s -X POST \\
  "https://api.example.com/v1/projects/<PROJECT_ID>/query" \\
  -H "x-vellum-api-key: <API_KEY>" -H "content-type: application/json" \\
  -d '{
    "collectionPath": "orders",
    "where": [{ "field": "status", "op": "==", "value": "paid" }],
    "orderBy": [{ "field": "total", "dir": "desc" }],
    "limit": 20
  }'

# الصفحة التالية — أضف "startAfter": "<NEXT_CURSOR>" إلى نفس جسم الاستعلام تماماً.
# عندما تعود nextCursor بقيمة null تكون النتائج قد اكتملت.`;

const modesJs = `const first = await db.collection("orders").orderBy("total", "desc").limit(20).get();
const cursor = first.nextCursor!;

// شامل (Inclusive): يعيد مستند الحد نفسه في بداية الصفحة التالية.
const at = await db.collection("orders").orderBy("total", "desc").startAt(cursor).limit(20).get();

// حصري (Exclusive): الخيار المعتاد لجلب الصفحة التالية دون تكرار.
const after = await db.collection("orders").orderBy("total", "desc").startAfter(cursor).limit(20).get();`;

const modesFlutter = `final first = await client
    .collection('orders')
    .orderBy('total', dir: 'desc')
    .limit(20)
    .get();
final cursor = first.nextCursor!;

// توفر حزمة Flutter الحد الحصري startAfter للتنقل بين الصفحات.
final after = await client
    .collection('orders')
    .orderBy('total', dir: 'desc')
    .startAfter(cursor)
    .limit(20)
    .get();`;

const modesRest = `// startAt: تضمين مستند الحد (مع بقاء where و orderBy كما هما)
{
  "collectionPath": "orders",
  "orderBy": [{ "field": "total", "dir": "desc" }],
  "limit": 20,
  "startAt": "<CURSOR>"
}

// startAfter: استبعاد مستند الحد (الانتقال للصفحة التالية)
{
  "collectionPath": "orders",
  "orderBy": [{ "field": "total", "dir": "desc" }],
  "limit": 20,
  "startAfter": "<CURSOR>"
}`;

const decodedCursor = `// بنية توضيحية فقط — المؤشر الفعلي سلسلة base64url معتمة لا يجب تعديلها.
{
  "qHash": "9f2c1a...",                      // بصمة SHA-256 لشكل الاستعلام
  "vals": [{ "$t": "int", "$v": "4200" }],   // قيم حقول orderBy لمستند الحد
  "docId": "ord_123",                         // فاصل الحسم document_id
  "sortKey": "05204...",                      // مفتاح الفرز السداسي للخطط المفهرسة
  "sig": "7b1e83..."                          // توقيع HMAC-SHA256
}`;

const keysetSql = `-- خطة الفهرس المركّب: مقارنة صف مركّب (Row-Value Tuple) لتمكين B-Tree Seek مباشر.
SELECT ...
FROM document_index_entries ie
JOIN documents d ON d.project_id = ie.project_id AND d.path = ie.path
WHERE ie.index_id = $index_id
  AND (ie.sort_key, ie.document_id) > ($key::bytea, $doc_id)
ORDER BY ie.sort_key ASC, ie.document_id ASC
LIMIT $limit_plus_one;`;

const envConfig = `# سر توقيع المؤشرات على الخادم — يجب توحيده عبر كل النسخ في الإنتاج.
CURSOR_HMAC_SECRET="<a-long-random-value>"`;

export default function Page() {
  return (
    <Doc
      title="الترقيم الصفحي"
      description="مؤشرات Keyset معتمة موقّعة بـ HMAC-SHA256، والفرق بين startAt وstartAfter، ومقارنات Row-Value Tuple السريعة دون SQL OFFSET."
      eyebrow="المفاهيم الأساسية"
    >
      <Section id="overview" title="نظرة عامة">
        <P>
          يعتمد VELLUM حصراً على <strong>الترقيم الصفحي بالمؤشرات الموقّعة (Signed Keyset Cursors)</strong>{" "}
          ولا يوفّر معامل SQL <code>OFFSET</code> في الواجهة العامة. يعاني <code>OFFSET</code> من تباطؤ
          خطّي كلما تعمّقت الصفحات ومن انزياح النتائج عند إدراج مستندات أو حذفها أثناء التصفح؛ أما مؤشر
          Keyset فيستأنف المسح مباشرة من صف الحد الدقيق للصفحة السابقة بزمن ثابت تقريباً.
        </P>
        <Api method="POST" path="/v1/projects/:projectId/query">
          <P>
            أعد إرسال <code>nextCursor</code> من الاستجابة السابقة في الحقل <code>startAfter</code> ضمن نفس
            الاستعلام. عندما تعود <code>nextCursor</code> بقيمة <code>null</code> فهذا يعني اكتمال النتائج.
          </P>
        </Api>
        <CodeTabs
          tabs={[
            { label: "JavaScript / TypeScript", lang: "typescript", code: loopJs },
            { label: "Flutter / Dart", lang: "dart", code: loopFlutter },
            { label: "REST", lang: "bash", code: loopRest },
          ]}
        />
      </Section>

      <Section id="inclusive-vs-exclusive" title="الفرق بين startAt و startAfter">
        <Table
          head={["الحد", "مستند الحد نفسه", "الاستخدام المعتاد"]}
          rows={[
            [<code>startAt(cursor)</code>, "مشمول — يظهر مجدداً في بداية الصفحة", "الاستئناف من صف محدد بدقة (يستخدم >=)"],
            [<code>startAfter(cursor)</code>, "مستبعد — تبدأ الصفحة من الصف التالي مباشرة", "جلب الصفحة التالية دون تكرار (يستخدم >)"],
          ]}
        />
        <P>
          لا يجوز تمرير <code>startAt</code> و<code>startAfter</code> معاً في نفس الاستعلام (يرفضه المحرك
          بخطأ <code>INVALID_ARGUMENT</code>). كلا الدالتين غير قابلتين للتعديل في منشئ الاستعلام، وتوفّر
          حزمة TypeScript وREST كليهما بينما توفّر حزمة Dart الحد الحصري <code>startAfter</code>.
        </P>
        <CodeTabs
          tabs={[
            { label: "JavaScript / TypeScript", lang: "typescript", code: modesJs },
            { label: "Flutter / Dart", lang: "dart", code: modesFlutter },
            { label: "REST", lang: "json", code: modesRest },
          ]}
        />
      </Section>

      <Section id="cursor-anatomy" title="بنية المؤشر والتوقيع الأمني">
        <P>
          المؤشر هو كائن JSON مرمّز بـ <code>base64url</code> وموقّع بـ <strong>HMAC-SHA256</strong>. يتحقق
          الخادم من التوقيع بمقارنة ثابتة الزمن (Constant-Time) ويعيد التحقق من بصمة الاستعلام في كل طلب:
        </P>
        <Table
          head={["الحقل", "الدور"]}
          rows={[
            [<code>qHash</code>, "تجزئة SHA-256 تشمل projectId وcollectionPath وwhere وorderBy"],
            [<code>vals</code>, "قيم حقول الترتيب في مستند الحد"],
            [<code>docId</code>, "معرّف مستند الحد المستخدم كفاصل حسم نهائي"],
            [<code>sortKey</code>, "مفتاح الفرز الثنائي بالترميز السداسي للخطط المعتمدة على فهرس مركّب"],
            [<code>sig</code>, "توقيع HMAC-SHA256 محسوب عبر CURSOR_HMAC_SECRET"],
          ]}
        />
        <Code lang="json" title="بنية توضيحية لمحتوى المؤشر" code={decodedCursor} />
        <UL
          items={[
            "أي تعديل في حرف واحد من المؤشر يُبطل التوقيع ويعيد INVALID_CURSOR (400).",
            "إعادة استخدام المؤشر بعد تغيير where أو orderBy أو المشروع يُخلّ ببصمة qHash ويعيد INVALID_CURSOR.",
            "استئناف خطة فهرس مركّب بمؤشر لا يحمل sortKey صالحاً يُرفض بخطأ INVALID_CURSOR.",
          ]}
        />
        <Callout tone="warning" title="المؤشر معتم بالتصميم">
          لا تحاول فك ترميز المؤشر أو تعديله أو إنشاؤه يدوياً في العميل. تعامل معه كرمز مؤقت صالح فقط لنفس
          الاستعلام الذي ولّده.
        </Callout>
        <H3 id="cursor-secret">إعداد سر التوقيع وتدويره</H3>
        <P>
          يستخدم الخادم المتغير <code>CURSOR_HMAC_SECRET</code> لتوقيع المؤشرات. احرص على أن يكون قوياً
          وعشوائياً ومطابقاً في جميع نسخ الخادم خلف موازن الأحمال. تدوير هذا السر يُبطل جميع المؤشرات
          النشطة حالياً فيلزم العملاء البدء من الصفحة الأولى.
        </P>
        <Code lang="bash" title="إعداد بيئة التشغيل" code={envConfig} />
      </Section>

      <Section id="deterministic-order" title="الترتيب الحتمي ومقارنة Row-Value Tuple">
        <P>
          لضمان ثبات الترقيم حتى عند تساوي قيم حقل الفرز، يُلحق المحرك <code>documentId ASC</code> بكل
          قائمة <code>orderBy</code> (أو يحترم اتجاه <code>documentId DESC</code> إذا حدده المستخدم صراحةً).
        </P>
        <P>
          في المُجمّع المحصّن، تُبنى شروط المؤشر باستخدام مقارنة الصفوف المركّبة{" "}
          (<code>Row-Value Tuple Comparison</code>) مثل{" "}
          <code>(ie.sort_key, ie.document_id) &gt; ($key::bytea, $doc_id)</code> للفهارس المركّبة و{" "}
          <code>(d.created_at, d.document_id) &gt; ($1::timestamptz, $2)</code> للحقول النظامية، مما يتيح
          لـ PostgreSQL تنفيذ بحث B-Tree مباشر ودقيق دون أخطاء في حسم التساوي مع <code>startAt</code>.
        </P>
        <Code lang="sql" title="شرط Keyset المجمّع (توضيحي)" code={keysetSql} />
      </Section>

      <Section id="no-offset" title="لماذا لا يوجد OFFSET؟">
        <P>
          يجلب المحرك داخلياً <code>limit + 1</code> صفّاً: إذا عاد الصف الإضافي فذلك يؤكد وجود صفحة تالية
          فيُوقَّع <code>nextCursor</code> من آخر صف مُعاد (الصف رقم <code>limit</code>)، وإلا تُرجَع{" "}
          <code>nextCursor: null</code>. بهذه الآلية تبقى الكلفة متوقعة ومحدودة حتى في المجموعات الضخمة.
        </P>
      </Section>

      <Section id="pitfalls" title="أخطاء شائعة يجب تجنبها">
        <Table
          head={["الخطأ الشائع", "النتيجة والحل"]}
          rows={[
            ["استخدام startAt للانتقال للصفحة التالية", "يتكرر مستند الحد؛ استخدم startAfter بدلاً منه"],
            ["تعديل المؤشر أو بناؤه يدوياً", "فشل التحقق من التوقيع → INVALID_CURSOR (400)"],
            ["تغيير الفلاتر أو الترتيب مع نفس المؤشر", "عدم تطابق qHash → INVALID_CURSOR (400)"],
            ["تمرير startAt و startAfter معاً", "يرفضه المحرك بخطأ INVALID_ARGUMENT (400)"],
            ["توقع وجود nextCursor عندما يكون العدد مساوياً تماماً لـ limit", "تعود nextCursor بقيمة null لعدم وجود صف إضافي"],
          ]}
        />
        <P>
          للمزيد حول قيود الاستعلام ورموز الأخطاء راجع{" "}
          <PageLink slug="errors-and-limits" lang="ar">الحصص والحدود</PageLink>.
        </P>
      </Section>
    </Doc>
  );
}
