import {
  Api,
  Callout,
  Code,
  CodeTabs,
  Doc,
  P,
  PageLink,
  Section,
  Table,
  UL,
} from "../../ui";

const sdkJs = `import { createClient } from "@vellumdb/sdk-js";

const db = createClient({
  projectId: "<YOUR_PROJECT_ID>",
  apiKey: "pk_...",
  warnOnMissingIndexes: true, // الافتراضي؛ false تُوقف طباعة التحذير في console
  onIndexSuggestion: ({ url, suggestion }) => {
    // يُستدعى لكل توصية حتى لو كان warnOnMissingIndexes = false.
    telemetry.track("slow_query", { url, suggestion });
  },
});`;

const sdkDart = `import 'package:vellum_flutter/vellum_flutter.dart';

final client = VellumClient(
  endpoint: 'https://api.example.com',
  projectId: '<YOUR_PROJECT_ID>',
  apiKey: '<YOUR_API_KEY>',
  warnOnMissingIndexes: true,
  onIndexSuggestion: (VellumIndexSuggestion suggestion) {
    // يحمل الكائن fingerprint و url و reason و collectionPath و fields
    print('Index suggestion: \${suggestion.url}');
  },
);`;

const warning = `[VELLUM Index Advisor] Slow/unindexed query detected on "posts".
Reason: Composite index needed for equality filter on [status] + sort on [priority DESC]
Create this index in 1 click: http://localhost:3000/app/orgs/.../indexes?suggest=eyJvcm...`;

const deepLink = `\${VELLUM_DASHBOARD_BASE_URL}/app/orgs/\${orgId}/projects/\${projectId}/indexes?suggest=\${base64url}`;

const curl = `# تُعاد ترويسات المستشار الاستباقية على /query وقراءات المجموعات.
curl -s -D - -o /dev/null -X POST \\
  "https://api.example.com/v1/projects/$PROJECT_ID/query" \\
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \\
  -d '{
    "collectionPath": "posts",
    "where": [{ "field": "status", "op": "==", "value": "open" }],
    "orderBy": [{ "field": "priority", "dir": "desc" }],
    "limit": 50
  }'
# x-vellum-index-suggestion: {"collectionPath":"posts","fields":[...],"fingerprint":"..."}
# x-vellum-index-url: http://localhost:3000/app/orgs/.../indexes?suggest=...

# تطبيق التوصية بنقرة واحدة من طابور لوحة التحكم:
curl -s -X POST \\
  "https://api.example.com/v1/projects/$PROJECT_ID/indexes/recommendations/$ID/apply" \\
  -H "Authorization: Bearer $CONSOLE_SESSION_TOKEN"`;

export default function Page() {
  return (
    <Doc
      title="الفهرسة الذكية والأداء"
      description="مستشار الفهارس E/S/R، والبصمات والروابط المباشرة، وتحذيرات الحزم البرمجية، والذاكرة المؤقتة المحدودة، ونهج Zero-Redis."
      eyebrow="المفاهيم الأساسية"
    >
      <Section id="overview" title="نظرة عامة">
        <P>
          يحلّل <strong>مستشار الفهارس الذكي (E/S/R Index Advisor)</strong> كل استعلام وقراءة مجموعة تلقائياً.
          إذا لم يجد فهرساً مركّباً بحالة <code>ready</code> يغطي شكل الاستعلام، يُرفق الخادم ترويسات إرشادية
          في الاستجابة، ويُسجّل التوصية في طابور لوحة التحكم، وتطبع الحزمة البرمجية رابطاً مباشراً لإنشاء
          الفهرس بنقرة واحدة — وكل ذلك بصورة استشارية غير معطّلة لا تؤثر إطلاقاً على نتيجة الاستعلام أو
          زمن استجابته.
        </P>
        <Callout tone="info" title="لا أوامر DDL للعملاء">
          تبقى الفهارس المركّبة صفوفاً في <code>document_indexes</code> و<code>document_index_entries</code>{" "}
          دون أي <code>CREATE INDEX</code> على جدول <code>documents</code>. راجع{" "}
          <PageLink slug="indexes" lang="ar">الفهارس المركّبة</PageLink>.
        </Callout>
      </Section>

      <Section id="esr" title="الترتيب المعياري E → S → R">
        <P>
          تصنّف الدالة النقية <code>analyzeQueryIndexCoverage()</code> شروط الاستعلام إلى تسلسل حقول معياري
          حتمي يضمن أعلى كفاءة لمسح B-Tree:
        </P>
        <Table
          head={["المجموعة", "قاعدة الترتيب", "العوامل"]}
          rows={[
            [<strong>E — المساواة (Equality)</strong>, "مرتّبة أبجدياً", <code>== in array-contains array-contains-any</code>],
            [<strong>S — الفرز (Sort)</strong>, "نفس ترتيب orderBy واتجاهاته بدقة", <code>asc / desc</code>],
            [<strong>R — النطاق (Range)</strong>, "دون تكرار ومرتّبة أبجدياً", <code>&lt; &lt;= &gt; &gt;= != not-in starts_with_ci</code>],
          ]}
        />
        <Code
          lang="json"
          title="الفهرس الموصى به"
          code={`{
  "collectionPath": "posts",
  "fields": [
    { "path": "status", "dir": "asc" },
    { "path": "priority", "dir": "desc" },
    { "path": "createdAt", "dir": "asc" }
  ]
}`}
        />
        <P>
          المستشار دالة نقية وحتمية بلا إدخال/إخراج أو حالة عامة وتستخدم <code>SHA-256</code> فقط. أما
          عوامل البحث النصي غير القابلة لترتيب B-Tree (مثل <code>contains_ci</code> و<code>text_search</code>)
          فتُترك غير مصنّفة مع احتسابها ضمن تقدير تعقيد الاستعلام.
        </P>
      </Section>

      <Section id="coverage" title="مطابقة البادئة والمسح العكسي والمسار السريع">
        <P>
          يغطي فهرس <code>ready</code> الاستعلام إذا بدأت حقوله بالتسلسل المعياري الكامل (لا يضر وجود حقول
          إضافية في النهاية)، وذلك عبر حالتين: <strong>مطابقة بادئة مباشرة</strong> أو{" "}
          <strong>مسح عكسي كامل (Reverse Scan)</strong> حين يؤدي عكس جميع اتجاهات الفهرس إلى تطابق التسلسل
          المطلوب. لا تُحتسب الفهارس التي ما زالت في حالة <code>building</code> أو <code>failed</code>.
        </P>
        <P>
          لا يحتاج الاستعلام الذي يمس <strong>حقلاً واحداً على الأكثر</strong> إلى فهرس مركّب (إذ تغطي
          الفهارس المدمجة الحقول النظامية والحقل المفرد). خلاف ذلك يعيد المستشار كائناً يحتوي على:
        </P>
        <Table
          head={["الحقل", "الدلالة"]}
          rows={[
            [<code>covered</code>, "هل يوجد فهرس جاهز يغطي الاستعلام؟"],
            [<code>equalityFields / sortFields / rangeFields</code>, "التصنيف التفصيلي وفق E/S/R"],
            [<code>recommendedFields</code>, "تسلسل الحقول المعياري المقترح تسجيله"],
            [<code>fingerprint</code>, <code>sha256(project:collection:JSON(fields))</code>],
            [<code>suggestPayload</code>, "حمولة رابط الإنشاء المباشر بترميز base64url"],
            [<code>reason</code>, "شرح واضح لسبب التوصية"],
          ]}
        />
      </Section>

      <Section id="deep-links" title="البصمات والروابط المباشرة (Deep Links)">
        <P>
          تمنع البصمة <code>fingerprint</code> تكرار نفس التحذير عند تكرار الاستعلام. وتُفحص حمولة{" "}
          <code>suggestPayload</code> بدقة عند فك الترميز (أي حمولة معطوبة أو أكبر من 8 KiB تعود{" "}
          <code>null</code>). يحمل الترويسة <code>x-vellum-index-url</code> رابط الإنشاء بنقرة واحدة:
        </P>
        <Code lang="text" title="بنية الرابط المباشر" code={deepLink} />
        <P>
          القيمة الافتراضية لـ <code>VELLUM_DASHBOARD_BASE_URL</code> هي <code>http://localhost:3000</code>،
          وتُكشف ترويستا المستشار عبر CORS. عند فتح الرابط تُملأ بيانات الفهرس تلقائياً في لوحة التحكم، وعند
          إنشائه تُحدَّث حالة التوصية المطابقة إلى <code>applied</code>.
        </P>
      </Section>

      <Section id="sdk-warnings" title="تحذيرات الحزم البرمجية القابلة للنقر">
        <P>
          تفحص كلتا الحزمتين ترويسات المستشار في كل استجابة HTTP وتطبعان تحذيراً يقتصر على الحقول المولّدة
          من الخادم فقط (مع إخفاء أي مفاتيح أو رموز سرية). تُمنع التحذيرات المكررة عبر مجموعة بصمات محدودة
          على مستوى العملية (تتسع حتى 1,000 بصمة في <code>@vellumdb/sdk-js</code>).
        </P>
        <CodeTabs
          tabs={[
            { label: "JavaScript / TypeScript", lang: "typescript", code: sdkJs },
            { label: "Flutter / Dart", lang: "dart", code: sdkDart },
          ]}
        />
        <Code lang="text" title="مخرجات وحدة التحكم" code={warning} />
        <Callout tone="warning" title="فارق مهم بين الحزمتين">
          في <strong>TypeScript</strong> يُستدعى <code>onIndexSuggestion</code> لكل توصية حتى عندما يكون{" "}
          <code>warnOnMissingIndexes: false</code>. أما في <strong>Flutter / Dart</strong> فإن تعيين{" "}
          <code>warnOnMissingIndexes: false</code> يُعطّل كلاً من الطباعة واستدعاء{" "}
          <code>onIndexSuggestion</code> معاً، ويتلقى الاستدعاء كائن <code>VellumIndexSuggestion</code> واحد.
        </Callout>
      </Section>

      <Section id="dashboard" title="طابور توصيات الفهرسة في لوحة التحكم">
        <P>
          يُغذّى قسم مستشار الفهارس في لوحة التحكم من نقاط نهاية حيّة تسجّل عدد التكرارات والزمن الأقصى
          وعينة الاستعلام والحقول المقترحة (تُسجَّل التوصيات بشكل غير متزامن Fire-and-Forget دون إضافة أي
          تأخير على مسار الاستعلام):
        </P>
        <Table
          head={["الطريقة", "المسار", "الغرض"]}
          rows={[
            [<code>GET</code>, <code>…/indexes/recommendations</code>, "عرض التوصيات مرتّبة بعدد التكرارات"],
            [<code>POST</code>, <code>…/indexes/recommendations/:id/apply</code>, "إنشاء الفهرس وتحديث التوصية إلى applied"],
            [<code>POST</code>, <code>…/indexes/recommendations/:id/dismiss</code>, "تجاهل التوصية"],
          ]}
        />
        <Api method="POST" path="/v1/projects/:projectId/indexes/recommendations/:id/apply">
          <P>يتطلب صلاحية <code>indexes:manage</code> عبر جلسة لوحة التحكم أو مفتاح خادم <code>sk_</code>.</P>
        </Api>
        <Code lang="bash" title="cURL" code={curl} />
      </Section>

      <Section id="zero-redis" title="مبدأ Zero-Redis والذاكرة المؤقتة المحدودة">
        <P>
          تبقى PostgreSQL هي خدمة الحالة الوحيدة في النظام دون الحاجة إلى Redis أو أي طبقة تخزين مؤقت
          خارجية:
        </P>
        <UL
          items={[
            <>
              <strong>ذاكرة LRU/TTL محدودة</strong> (<code>BoundedLruCache</code>) على الخادم لمفاتيح API
              والبيانات الوصفية ونوافذ تحديد المعدل، مع إبطال فوري بين النسخ عبر{" "}
              <code>NOTIFY vellum_cache_invalidate</code> — وذاكرة قراءة اختيارية محدودة في حزمة JS عبر{" "}
              <code>cache: {"{ enabled: true, ttlMs, maxEntries }"}</code> وتجميع الطلبات المتزامنة{" "}
              <code>dedupeReads: true</code>.
            </>,
            <>
              <strong>استعلام SQL في رحلة شبكة واحدة</strong> مع ربط سياق المستأجر عبر{" "}
              <code>withTenantContext</code> بـ <code>SELECT set_config(..., true)</code> في جولة واحدة.
            </>,
            <>
              <strong>علاقات بلا مشكلة N+1</strong> عبر تجميع المراجع في <code>batchGetDocuments</code> —
              راجع <PageLink slug="relationships" lang="ar">العلاقات والاستعلامات المتقدمة</PageLink>.
            </>,
          ]}
        />
      </Section>

      <Section id="migration" title="فهارس الأداء وانتهاء الصلاحية (TTL)">
        <P>
          تضيف ترحيلة مستوى البيانات <code>0007_performance_and_ttl.sql</code> الأساس الفيزيائي للأداء وTTL
          بصورة متكررة الأمان (Idempotent):
        </P>
        <Table
          head={["الكائن", "الدور"]}
          rows={[
            [<code>documents.expires_at</code>, "تاريخ انتهاء صلاحية اختياري للمستند (NULL = دائم)"],
            [<code>idx_docs_expires_at</code>, "فهرس جزئي يسرّع عامل التنظيف المحدود للمستندات المنتهية"],
            [<code>idx_docs_collection_cover_active</code>, "فهرس تغطية لقوائم المجموعات والترقيم بالمؤشرات"],
            [<code>idx_docs_data_gin</code>, "فهرس GIN (jsonb_path_ops) لعوامل الاحتواء والمساواة"],
          ]}
        />
      </Section>

      <Section id="measurement" title="منهجية قياس الأداء الموثوقة">
        <UL
          items={[
            <>تعبئة بيانات واقعية عبر <code>corepack pnpm bench</code> وتسخين الذاكرة المؤقتة قبل القياس.</>,
            <>تسجيل <code>meta.executionTimeMs</code> و<code>meta.indexUsed</code> قبل إنشاء الفهرس وبعد وصوله إلى <code>ready</code>.</>,
            <>تشغيل <code>corepack pnpm bench:explain</code> (<code>EXPLAIN (ANALYZE, BUFFERS)</code>) للتحقق من استخدام Index Scan بدلاً من Sequential Scan.</>,
            <>اختبار التزامن عبر <code>corepack pnpm test:load</code> (k6) وقياس الشرائح <code>p50 / p95 / p99</code> لا المتوسطات فقط.</>,
          ]}
        />
      </Section>
    </Doc>
  );
}
