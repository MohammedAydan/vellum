import { RelationshipCreation } from "../../relationship-creation";
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

const includeJs = `const posts = await db
  .collection("posts")
  .where("published", "==", true)
  .include([
    "author",                          // اختصار → { field: "author" }
    {
      field: "editorId",
      collection: "users",
      as: "editor",
      select: ["name", "email"],
      include: [{ field: "avatarRef", as: "avatar" }],
    },
  ])
  .select("title", "authorRef", "createdAt")
  .limit(25)
  .get();

for (const post of posts.docs) {
  console.log(post.included?.["author"]); // المستند المُحلَّل (أو null)
  console.log(post.redactedRefs);         // المفاتيح التي أخفتها القواعد
}`;

const includeDart = `final page = await client.collection('posts')
  .where('published', '==', true)
  .include([
    'author',
    VellumInclude(
      field: 'editorId',
      collection: 'users',
      as: 'editor',
      select: ['name', 'email'],
      include: [VellumInclude(field: 'avatarRef', as: 'avatar')],
    ),
  ])
  .select(['title', 'createdAt'])
  .limit(25)
  .get();`;

const includeRest = `curl -s -X POST \\
  "https://api.example.com/v1/projects/$PROJECT_ID/query" \\
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \\
  -d '{
    "collectionPath": "posts",
    "select": ["title", "authorRef"],
    "include": [
      { "field": "author" },
      { "field": "editorId", "collection": "users", "as": "editor",
        "select": ["name", "email"] }
    ],
    "limit": 25
  }'`;

const readRulesRest = `curl -s \\
  "https://api.example.com/v1/projects/$PROJECT_ID/relation-rules" \\
  -H "authorization: Bearer $CONSOLE_SESSION"
# => { "projectId": "...", "version": 3, "rules": [ ... ] }`;

const putRulesRest = `curl -s -X PUT \\
  "https://api.example.com/v1/projects/$PROJECT_ID/relation-rules" \\
  -H "authorization: Bearer $CONSOLE_SESSION" \\
  -H "content-type: application/json" \\
  -H "if-match: 3" \\
  -d '{
    "rules": [
      { "collection": "orders", "field": "customerId",
        "targetCollection": "users", "onDelete": "restrict" },
      { "collection": "comments", "field": "postId",
        "targetCollection": "posts", "onDelete": "cascade" }
    ]
  }'
# => 409 ABORTED_CONFLICT when the version is stale`;

const referencedByJs = `let cursor;
do {
  const page = await db.doc("users/u1").referencedBy({
    collection: "orders",
    field: "customerId",
    limit: 25,
    cursor,
  });
  for (const doc of page.documents) console.log(doc.path, doc.data());
  cursor = page.nextCursor ?? undefined;
} while (cursor !== undefined);`;

const referencedByDart = `var page = await client.collection('users').doc('u1').referencedBy(
  collection: 'orders',
  field: 'customerId',
  limit: 25,
);
while (page.nextCursor != null) {
  page = await client.collection('users').doc('u1').referencedBy(
    collection: 'orders',
    field: 'customerId',
    limit: 25,
    cursor: page.nextCursor,
  );
}`;

const aggregateJs = `const orders = db.collection("orders").where("status", "==", "paid");

const total  = await orders.count();
const revenue = await orders.sum("total");
const average = await orders.avg("total");
const largest = await orders.max("total");

const byStatus = await orders.aggregate({
  groupBy: ["status", "currency"],
  metrics: {
    orders:  { op: "count" },
    revenue: { op: "sum", field: "total" },
    average: { op: "avg", field: "total" },
  },
});`;

const aggregateDart = `final orders = client.collection('orders').where('status', '==', 'paid');

final int total = await orders.count();
final num? revenue = await orders.sum('total');
final num? average = await orders.avg('total');

final grouped = await orders.aggregate(
  groupBy: ['status', 'currency'],
  metrics: {
    'orders': const AggregateMetric.count(),
    'revenue': AggregateMetric.sum('total'),
    'smallest': AggregateMetric.min('total'),
  },
);
final rows = grouped['rows'] as List;`;

const aggregateRest = `curl -s -X POST \\
  "https://api.example.com/v1/projects/$PROJECT_ID/documents:aggregate" \\
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \\
  -d '{
    "collectionPath": "orders",
    "where": [{ "field": "status", "op": "==", "value": "paid" }],
    "groupBy": ["status", "currency"],
    "metrics": {
      "orders":  { "op": "count" },
      "revenue": { "op": "sum", "field": "total" }
    }
  }'`;

const orJs = `const page = await db
  .collection("users")
  .where("active", "==", true)        // يُدمج مع مجموعات OR
  .or([
    [{ field: "role", op: "==", value: "admin" }],
    [
      { field: "role", op: "==", value: "editor" },
      { field: "verified", op: "==", value: true },
    ],
  ])
  .get();`;

const orDart = `final page = await client.collection('users')
  .where('active', '==', true)
  .or([
    [
      {'field': 'role', 'op': '==', 'value': 'admin'},
    ],
    [
      {'field': 'role', 'op': '==', 'value': 'editor'},
      {'field': 'verified', 'op': '==', 'value': true},
    ],
  ])
  .get();`;

const writeJs = `// كتابة idempotent (INSERT … ON CONFLICT DO UPDATE).
await db.doc("counters/visits").upsert({ count: 1 });

// تنتهي صلاحية المستند بعد ساعة من إنشائه.
await db.collection("sessions").doc("s_1")
  .create({ userId: "u_1" }, { ttlSeconds: 3600 });

// حذف جماعي للمستندات المطابقة.
const removed = await db.collection("sessions")
  .where("lastSeenAt", "<", "2026-01-01T00:00:00.000Z")
  .deleteWhere({ limit: 2000 });
console.log(removed.deletedCount);`;

const writeDart = `await client.collection('counters').doc('visits').upsert({'count': 1});

await client.collection('sessions').doc('s_1')
  .create({'userId': 'u_1'}, ttlSeconds: 3600);

final removed = await client.collection('sessions')
  .where('lastSeenAt', '<', '2026-01-01T00:00:00.000Z')
  .deleteWhere(limit: 2000);`;

const writeRest = `# Upsert مع TTL عبر PUT.
curl -s -X PUT \\
  "https://api.example.com/v1/projects/$PROJECT_ID/documents/sessions/s_1" \\
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \\
  -d '{ "data": { "userId": "u_1" }, "ttlSeconds": 3600, "upsert": true }'

# حذف جماعي.
curl -s -X POST \\
  "https://api.example.com/v1/projects/$PROJECT_ID/documents:bulk-delete" \\
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \\
  -d '{ "collectionPath": "sessions",
        "where": [{ "field": "lastSeenAt", "op": "<",
                    "value": "2026-01-01T00:00:00.000Z" }], "limit": 2000 }'`;

export default function Page() {
  return (
    <Doc
      title="العلاقات والاستعلامات المتقدمة"
      description="علاقات $ref المحمّلة مسبقًا، والتجميع، ومجموعات OR، وعوامل النص، وupsert والحذف الجماعي ومدة صلاحية المستندات."
      eyebrow="المفاهيم الأساسية"
    >
      <RelationshipCreation lang="ar" />
      <Section id="overview" title="نظرة عامة">
        <P>
          يضيف الإصدار V2 إمكانيات جديدة لمحرك الاستعلام: يمكنك تحميل المستندات المُشار إليها بـ{" "}
          <code>$ref</code> مسبقًا، والتجميع على الخادم، ودمج المرشحات الانفصالية، وإجراء بحث غير حساس
          لحالة الأحرف وبحث نصي كامل، والكتابة بطريقة idempotent عبر <code>upsert</code>، والحذف الجماعي،
          ومنح المستندات مدة صلاحية. كل ميزة هنا تخضع للوصول نفسه بقواعد الأمان ومعاملة المستأجر التي
          تخضع لها الاستعلامات العادية.
        </P>
        <Callout tone="info" title="مبنية على محرك الإصدار 1">
          هذه قدرات إضافية؛ ما زالت ترقيم الصفحات ومفاتيح الفرز والفهارس المركّبة من صفحتي{" "}
          <PageLink slug="query" lang="ar">الاستعلام</PageLink> و
          <PageLink slug="indexes" lang="ar">الفهارس المركّبة</PageLink> سارية كما هي.
        </Callout>
      </Section>

      <Section id="include" title="العلاقات المحمّلة مسبقًا (.include)">
        <P>
          العلاقة هي حقل يحمل مرجعًا. تُحلّ <code>include()</code> تلك المراجع وتُلحق المستندات المستهدفة
          تحت <code>_included</code>. السلسلة المفردة اختصار لـ <code>{"{ field }"}</code>، بينما يمنحك
          الشكل المفصّل تحكمًا في المجموعة المستهدفة واسم الإلحاق والإسقاط والعلاقات المتداخلة.
        </P>
        <Table
          head={["الخاصية", "الغرض"]}
          rows={[
            [<code>field</code>, "الحقل في المستند الأب الذي يحمل المرجع (تُدعم المسارات النقطية)"],
            [<code>collection</code>, "المجموعة المستهدفة؛ تُستنتج من $ref أو اسم الحقل إن غابت"],
            [<code>as</code>, "مفتاح الإلحاق (يُكتب أيضًا في بيانات المستند)"],
            [<code>select</code>, "إسقاط مسارات نقطية على المستند المُحلَّل"],
            [<code>include</code>, "علاقات متداخلة — عمق 3 كحد أقصى"],
          ]}
        />
        <CodeTabs
          tabs={[
            { label: "JS / TypeScript", lang: "typescript", code: includeJs },
            { label: "Flutter / Dart", lang: "dart", code: includeDart },
            { label: "REST", lang: "bash", code: includeRest },
          ]}
        />
        <H3 id="ref-formats">أشكال المرجع</H3>
        <UL
          items={[
            <><code>{"{ \"$ref\": \"users/u_123\" }"}</code> — كائن مختصر</>,
            <><code>{"{ \"$t\": \"ref\", \"$v\": \"users/u_123\" }"}</code> — مرجع مُوسوم على الأسلاك</>,
            <><code>"users/u_123"</code> — مسار قياسي عادي</>,
            <><code>"u_123"</code> — مُعرّف مجرد، يُحلّ بالمجموعة المعطاة أو المستنتجة</>,
          ]}
        />
        <H3 id="batching">التجميع الدفعي والدورات</H3>
        <P>
          يُصدر الحل <strong>استلامًا دفعيًا واحدًا لكل عمق</strong>: تُجمع كل المسارات المُشار إليها عبر
          جميع المستندات الأب، وتُزال تكراراتها، وتُجلب في استدعاء <code>batchGetDocuments</code> واحد —
          دون استعلامات N+1. تمنع مجموعة <code>visitedPaths</code> إعادة توسيع مسار سبق زيارته في عمق
          أقل، فتنتهي دورات المراجع بأمان.
        </P>
        <Callout tone="warning" title="الإخفاء الأمني (_redactedRefs)">
          يُفحص كل هدف مُحلَّل بتصريح <code>get</code> من قواعد الأمان. الهدف المرفوض يُلحق كـ{" "}
          <code>null</code> ويُسجَّل مفتاحه في <code>_redactedRefs</code> — لا يُسرَّب بياناته ولا يُفشل
          الطلب. تعرض الحزمة البرمجية ذلك عبر <code>snapshot.included</code> و{" "}
          <code>snapshot.redactedRefs</code>.
        </Callout>
      </Section>

      <Section id="on-delete" title="الإجراءات المرجعية (onDelete)">
        <P>
          يحدّد <code>onDelete</code> ما يحدث للمستندات التابعة عند حذف مستند مُشار إليه. يُقيَّم داخل{" "}
          <code>batchWrite</code>، في المعاملة نفسها وبترتيب <code>path ASC</code> — وليس كتتالي غير
          متزامن.
        </P>
        <Table
          head={["الإجراء", "السلوك"]}
          rows={[
            [<code>restrict</code>, "إلغاء الكتابة بخطأ RELATION_RESTRICT_VIOLATION (412) إذا ظل تابع حي يُشير للمسار"],
            [<code>set_null</code>, "كتابة null في حقل التابع، وزيادة إصداره، وإصدار حدث outbox للتحديث"],
            [<code>cascade</code>, "حذف التابع منطقيًا وإدراج تتاليات إضافية بعمق محدود بـ 3"],
          ]}
        />
        <P>
          تُدار القواعد لكل مشروع عبر نقطة relation-rules المصادَق عليها بجلسة الـ Console، وتُحمَّل
          إلى محرك المستندات كـ <code>EngineContext.relationRules</code> مع بث إبطال بين النسخ عند كل
          تغيير. الكتابة محمية بالتزامن التفاؤلي: مرّر <code>version</code> الحالية كـ{" "}
          <code>expectedVersion</code> في الجسم أو في ترويسة <code>If-Match</code>.
        </P>
        <CodeTabs
          tabs={[
            { label: "قراءة القواعد", lang: "bash", code: readRulesRest },
            { label: "استبدال القواعد", lang: "bash", code: putRulesRest },
          ]}
        />
      </Section>

      <Section id="reverse-lookup" title="البحث العكسي (referencedBy)">
        <P>
          تجيب <code>POST /v1/projects/{'{projectId}'}/documents:referencedBy</code> عن سؤال «ما
          المستندات التي تُشير إلى هذا المستند؟» — مع ترشيح بالصلاحيات (التابع الذي لا يحق للمُستدعي
          قراءته لا يُسرَّب أبدًا)، وترقيم صفحي بمؤشرات معتمة موقّعة بـ HMAC. واصل الترقيم ما دام{" "}
          <code>nextCursor</code> غير فارغ، حتى بعد صفحة خالية.
        </P>
        <Table
          head={["الحقل", "الغرض"]}
          rows={[
            [<code>targetPath</code>, "مسار المستند المُشار إليه (إلزامي)"],
            [<code>collection</code>, "اختياري: حصر البحث في مجموعة واحدة"],
            [<code>field</code>, "اختياري: حصر البحث في حقل مرجعي واحد (مسار نقطي)"],
            [<code>limit</code>, "من 1 إلى 100 تابع في الصفحة"],
            [<code>cursor</code>, "مؤشر معتم لمتابعة الصفحة السابقة"],
            [<code>select / include</code>, "إسقاط الحقول وتوسيع العلاقات على التوابع"],
          ]}
        />
        <CodeTabs
          tabs={[
            { label: "JavaScript / TypeScript", lang: "typescript", code: referencedByJs },
            { label: "Flutter / Dart", lang: "dart", code: referencedByDart },
          ]}
        />
        <P>
          يعتمد البحث العكسي على مساواة JSONPath تعاودية مدعومة بفهرس GIN الجزئي{" "}
          <code>idx_docs_reverse_reference_gin_active</code> (هجرة البيانات{" "}
          <code>0012_referenced_by_gin.sql</code>). الاستجابات التي تتجاوز 4 MiB تفشل بخطأ{" "}
          <code>RESPONSE_TOO_LARGE</code>؛ قلّل <code>limit</code> أو استخدم <code>select</code>.
        </P>
      </Section>

      <Section id="aggregates" title="التجميع (count / sum / avg / min / max / groupBy)">
        <P>
          يجري التجميع في SQL داخل معاملة المستأجر — لا تُحمَّل المستندات إلى التطبيق. كل مقياس مُسمَّى؛
          لا يحتاج <code>count</code> إلى حقل، بينما تتطلب sum/avg/min/max مسارًا نقطيًا. مع{" "}
          <code>groupBy</code> (3 حقول كحد أقصى) تحصل على مصفوفة الصفوف كاملة.
        </P>
        <CodeTabs
          tabs={[
            { label: "JS / TypeScript", lang: "typescript", code: aggregateJs },
            { label: "Flutter / Dart", lang: "dart", code: aggregateDart },
            { label: "REST", lang: "bash", code: aggregateRest },
          ]}
        />
        <Callout tone="info" title="القواعد سارية">
          يتطلب التجميع إذن <code>list</code>/<code>read</code> نفسه المطلوب للاستعلام العادي. توفر Dart
          مساعدات <code>count/sum/avg</code> و <code>aggregate()</code> لـ min/max والتجميع؛ وتضيف JS
          المساعدتين <code>min()</code> و <code>max()</code>.
        </Callout>
        <Api method="POST" path="/v1/projects/:projectId/documents:aggregate">
          <P>الجسم: <code>collectionPath</code>، واختياريًا <code>where</code>/<code>or</code>/<code>groupBy</code>، وخريطة <code>metrics</code> المُسمَّاة.</P>
        </Api>
      </Section>

      <Section id="select-or" title="التسقط النقطي ومجموعات OR">
        <H3 id="select">التسقط النقطي</H3>
        <P>
          يُسقط <code>select</code> الحقول ويعيد بناء الكائنات المتداخلة من المسارات النقطية. في JS هو
          متغيّر الوسائط (<code>select("a.b", "c")</code>)، وفي Dart يأخذ قائمة. يعمل أيضًا داخل{" "}
          <code>include</code> حيث يُطبَّق على الهدف المُحلَّل.
        </P>
        <H3 id="or">المجموعات الانفصالية (OR)</H3>
        <P>
          داخل المجموعة تُدمج الجمل بـ AND، وتُدمج المجموعات بـ OR، ثم تُدمج النتيجة مع جمل{" "}
          <code>where</code> الأساسية بـ AND. تُقبل 10 مجموعات كحد أقصى. حقل <code>or</code> نفسه صالح
          للاستعلامات والتجميع والحذف الجماعي.
        </P>
        <CodeTabs
          tabs={[
            { label: "JS / TypeScript", lang: "typescript", code: orJs },
            { label: "Flutter / Dart", lang: "dart", code: orDart },
          ]}
        />
      </Section>

      <Section id="operators" title="عوامل غير حساسة لحالة الأحرف وعوامل النص">
        <P>ثلاثة عوامل V2 تمرّ مباشرة عبر دالة <code>where()</code> في الحزمتين — التحقق في حدود API:</P>
        <Table
          head={["العامل", "تجميع SQL", "الاستخدام"]}
          rows={[
            [<code>contains_ci</code>, <code>ILIKE '%value%'</code>, "جزء نصي غير حساس للحالة"],
            [<code>starts_with_ci</code>, <code>ILIKE 'value%'</code>, "بداية نصية غير حساسة للحالة"],
            [<code>text_search</code>, <code>to_tsvector @@ plainto_tsquery</code>, "بحث نصي كامل في الحمولة"],
          ]}
        />
        <Code lang="ts" title="JavaScript" code={`await db.collection("users").where("email", "contains_ci", "@example.com").get();
await db.collection("posts").where("data", "text_search", "postgres index").get(); // الحقل مُتجاهَل`} />
        <Callout tone="warning" title="ملاحظة الفهرسة">
          هذه العوامل لا تُصنَّف في نموذج E/S/R لدى المستشار، لذا لا تُطلق اقتراح فهرس مركّب. راجع{" "}
          <PageLink slug="smart-indexing" lang="ar">الفهرسة الذكية</PageLink>.
        </Callout>
      </Section>

      <Section id="writes" title="Upsert والحذف الجماعي وTTL">
        <H3 id="upsert">Upsert</H3>
        <P>
          تُصدر <code>upsert(data)</code> (أو <code>set(data, {"{ upsert: true }"})</code>) كتابة{" "}
          <code>INSERT … ON CONFLICT DO UPDATE</code> — آمنة لإعادة المحاولة ولا تفشل لمجرد وجود المستند.
          تتوافق مع <code>merge</code> و<code>ifVersion</code> وTTL.
        </P>
        <H3 id="delete-where">الحذف الجماعي</H3>
        <P>
          تحذف <code>deleteWhere()</code> كل المستندات المطابقة في عملية واحدة على الخادم. تفرض قواعد
          list/read، وتُصدر حدث outbox لكل صف، وتُحصى ضمن <code>documentDeletes</code>. الافتراضي لـ{" "}
          <code>limit</code> هو 1000 والسقف 5000.
        </P>
        <H3 id="ttl">مدة صلاحية المستند (TTL)</H3>
        <P>
          يمكن أن يحمل المستند <code>ttlSeconds</code> (نسبي) أو <code>expiresAt</code> (طابع زمني صريح
          يفوز عند وجود الاثنين). تستبعد القراءات الحيّة المستندات منتهية الصلاحية فورًا، ويُزيلها مكنسة
          محدودة فيزيائيًا باستخدام الفهرس الجزئي <code>idx_docs_expires_at</code>.
        </P>
        <CodeTabs
          tabs={[
            { label: "JS / TypeScript", lang: "typescript", code: writeJs },
            { label: "Flutter / Dart", lang: "dart", code: writeDart },
            { label: "REST", lang: "bash", code: writeRest },
          ]}
        />
        <Api method="POST" path="/v1/projects/:projectId/documents:bulk-delete">
          <P>الجسم: <code>collectionPath</code>، واختياريًا <code>where</code>/<code>or</code>، و<code>limit</code> (من 1 إلى 5000).</P>
        </Api>
      </Section>

      <Section id="next" title="تابع القراءة">
        <UL
          items={[
            <><PageLink slug="security-rules-dsl" lang="ar">لغة قواعد الأمان</PageLink> — اكتب القواعد التي تُجيز هذه العمليات.</>,
            <><PageLink slug="smart-indexing" lang="ar">الفهرسة الذكية والأداء</PageLink> — كيف يحافظ المستشار على سرعة هذه الاستعلامات.</>,
            <><PageLink slug="errors-and-limits" lang="ar">الحصص والحدود</PageLink> — الحدود الدقيقة ورموز الأخطاء.</>,
          ]}
        />
      </Section>
    </Doc>
  );
}
