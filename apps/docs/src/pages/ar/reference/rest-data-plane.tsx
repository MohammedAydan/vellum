import type { ReactNode } from "react";
import {
  Api,
  Callout,
  Code,
  CodeTabs,
  Doc,
  PageLink,
  P,
  Section,
  Table,
  UL,
} from "../../../ui";

/** Inline LTR span for technical identifiers inside Arabic prose. */
const IC = ({ children }: { children: ReactNode }) => <code dir="ltr">{children}</code>;

export default function Page() {
  return (
    <Doc
      title="واجهة REST لمستوى البيانات"
      description="المرجع الكامل لعمليات المستندات والاستعلام والكتابة الدفعية ومعاملات OCC والفهارس المركّبة. كل نقطة نهاية تتطلّب مفتاح API مرتبطاً بالمشروع."
      eyebrow="المرجع — مستوى البيانات"
    >
      <Section id="auth" title="المصادقة والرؤوس">
        <P>
          كل نقطة نهاية في هذه الصفحة تقع أسفل <IC>/v1/projects/:projectId</IC>، وتتطلّب رأس مفتاح API
          إلزامياً. يتحقق الخادم من أن المفتاح ينتمي فعلياً إلى المشروع المطلوب؛ وإلا أجاب{" "}
          <IC>403 PERMISSION_DENIED</IC>. قبل ذلك يُتحقَّق من حالة المشروع، فالمشروع المُوقَّف يُنتج{" "}
          <IC>PERMISSION_DENIED</IC> والمُخنَّق يُنتج <IC>429 RATE_LIMITED</IC>.
        </P>
        <Table
          head={["الرأس", "الحالة", "الوصف"]}
          rows={[
            [<IC>x-vellum-api-key</IC>, "مطلوب", <>مفتاح <IC>pk_</IC> للمتصفح والجوال أو <IC>sk_</IC> للخادم. غيابه يعني <IC>401 UNAUTHENTICATED</IC>.</>],
            [<IC>Authorization: Bearer &lt;jwt&gt;</IC>, "اختياري", <>رمز EdDSA للمستخدم النهائي؛ يُقيَّم في قواعد الأمان عبر <IC>auth.uid</IC>.</>],
            [<IC>x-vellum-user-token</IC>, "اختياري", <>الاسم المستعار نفسه للرمز، ويُفضَّل عندما يحجب وكيلٌ رأس Authorization.</>],
            [<IC>x-transaction-token</IC>, "حسب الطلب", <>رمز معاملة OCC عند قراءة مستند ضمن معاملة مفتوحة.</>],
          ]}
        />
        <Callout tone="danger" title="قاعدة غير قابلة للتفاوض">
          <P>
            الرمز الاختياري للمستخدم النهائي يجب أن يكون <IC>vellum+enduser+jwt</IC> بتوقيع EdDSA مقابل مفتاح
            Ed25519 الخاص بالمشروع. لا يوجد مسار بديل بتوقيع HS256، ولا تراجع صامت إلى حساب مجهول عند فشل التحقق.
          </P>
        </Callout>
        <P>
          الشكل الوسيط للمستندات هو <IC>$t/$v</IC> الموسوم؛ راجع{" "}
          <PageLink slug="reference/wire-format" lang="ar">تنسيق الإرسال والمسارات</PageLink> قبل بناء الأجسام يدوياً.
        </P>
      </Section>

      <Section id="documents" title="عمليات المستندات والمجموعات">
        <P>
          مسار المستند يُمرَّر كجزء من المسار بعد <IC>/documents/</IC>. عدد المقاطع يحدد الدلالة: عدد زوجي يعني
          مستنداً، وعدد فردي يعني مجموعة. لذلك يشترك GET في نقطة نهاية واحدة لكلتي الحالتين.
        </P>

        <Api method="GET" path="/v1/projects/:projectId/documents/*">
          <P>
            إذا كان عدد المقاطع زوجياً يُعاد مستند واحد؛ وإذا كان فردياً تُسرد المستندات المباشرة في تلك المجموعة.
            في حالة السرد يُقبل <IC>?limit=</IC> (الافتراضي <IC>50</IC>، الأقصى <IC>500</IC>) و
            <IC> ?startAfter=</IC>، مع ترقيم صفحي بمؤشر معتم فقط. عند قراءة مستند داخل معاملة مرر{" "}
            <IC>x-transaction-token</IC> أو <IC>?transactionToken=</IC>.
          </P>
          <P>
            الرؤوس المطلوبة: <IC>x-vellum-api-key</IC>، واختيارياً رمز المستخدم النهائي و
            <IC> x-transaction-token</IC>.
          </P>
          <Code
            lang="json"
            title="200 OK — مستند (عدد المقاطع زوجي)"
            code={`{
  "path": "users/u_123",
  "collectionPath": "users",
  "collectionGroup": "users",
  "documentId": "u_123",
  "data": {
    "name": "Amina",
    "email": "amina@example.com",
    "active": true,
    "joinedAt": { "$t": "ts", "$v": "2026-11-18T09:00:00.000Z", "$ms": 1794973200000 }
  },
  "sizeBytes": 184,
  "version": 3,
  "createdAt": "2026-11-01T08:12:00.000Z",
  "updatedAt": "2026-11-18T09:00:00.000Z"
}`}
          />
          <Code
            lang="json"
            title="200 OK — سرد مجموعة (عدد المقاطع فردي)"
            code={`{
  "documents": [
    {
      "path": "users/u_123",
      "collectionPath": "users",
      "collectionGroup": "users",
      "documentId": "u_123",
      "data": { "name": "Amina", "active": true },
      "sizeBytes": 96,
      "version": 3,
      "createdAt": "2026-11-01T08:12:00.000Z",
      "updatedAt": "2026-11-18T09:00:00.000Z"
    }
  ],
  "nextCursor": "eyJ2IjozLCJpZCI6InVfMTIzIn0",
  "meta": {
    "count": 1,
    "indexUsed": "collection_scan",
    "executionTimeMs": 4,
    "compiledSql": "SELECT ... FROM documents WHERE collection_path = $1 ORDER BY document_id ASC LIMIT $2"
  }
}`}
          />
        </Api>

        <Api method="POST" path="/v1/projects/:projectId/documents/*">
          <P>
            ينشئ مستنداً جديداً ولا يستبدل موجوداً. وجود المستند مسبقاً يُنتج <IC>409 ALREADY_EXISTS</IC>. يُقبل
            الجسم بصيغة غلاف <IC>data</IC> أو كخريطة حقول مباشرة.
          </P>
          <P>الرؤوس المطلوبة: <IC>x-vellum-api-key</IC>، واختيارياً رمز المستخدم النهائي.</P>
          <Code lang="json" title="طلب" code={`{
  "data": {
    "name": "Amina",
    "email": "amina@example.com",
    "ownerId": "u_123",
    "createdAt": { "$op": "serverTimestamp" }
  }
}`} />
          <Code lang="json" title="201 Created" code={`{
  "path": "users/u_123",
  "collectionPath": "users",
  "collectionGroup": "users",
  "documentId": "u_123",
  "data": {
    "name": "Amina",
    "email": "amina@example.com",
    "ownerId": "u_123",
    "createdAt": { "$t": "ts", "$v": "2026-11-18T09:00:00.000Z", "$ms": 1794973200000 }
  },
  "sizeBytes": 212,
  "version": 1,
  "createdAt": "2026-11-18T09:00:00.000Z",
  "updatedAt": "2026-11-18T09:00:00.000Z"
}`} />
        </Api>

        <Api method="PUT" path="/v1/projects/:projectId/documents/*">
          <P>
            يحفظ المستند. بقيمة <IC>merge: false</IC> (أو غيابه) يستبدل البيانات بالكامل، وبقيمة <IC>true</IC> يُجري
            دمجاً عميقاً مع الحقول الموجودة. الحقل <IC>ifVersion</IC> اختياري ويفرض تحققاً متشائماً؛ عدم تطابق الإصدار
            يُنتج <IC>412 FAILED_PRECONDITION</IC>. يمكن تمرير <IC>?merge=true</IC> بدلاً من الحقل.
          </P>
          <P>الرؤوس المطلوبة: <IC>x-vellum-api-key</IC>، واختيارياً رمز المستخدم النهائي.</P>
          <Code lang="json" title="طلب — دمج عميق مع تحقق من الإصدار" code={`{
  "data": {
    "displayName": "Amina K.",
    "loginCount": { "$op": "inc", "by": 1 }
  },
  "merge": true,
  "ifVersion": 3
}`} />
          <Code lang="json" title="200 OK" code={`{
  "path": "users/u_123",
  "collectionPath": "users",
  "collectionGroup": "users",
  "documentId": "u_123",
  "data": {
    "name": "Amina",
    "email": "amina@example.com",
    "active": true,
    "displayName": "Amina K.",
    "loginCount": 8
  },
  "sizeBytes": 226,
  "version": 4,
  "createdAt": "2026-11-01T08:12:00.000Z",
  "updatedAt": "2026-11-18T09:30:00.000Z"
}`} />
        </Api>

        <Api method="PATCH" path="/v1/projects/:projectId/documents/*">
          <P>
            يحدّث الحقول المذكورة فقط، ويطبّق تحويلات الحقول الذرية مثل <IC>$op</IC>. الفرق الجوهري عن PUT هو أنه لا
            يستبدل المستند ولا يتطلّب تمرير <IC>merge</IC>. يقبل <IC>ifVersion</IC> أيضاً.
          </P>
          <P>الرؤوس المطلوبة: <IC>x-vellum-api-key</IC>، واختيارياً رمز المستخدم النهائي.</P>
          <Code lang="json" title="طلب" code={`{
  "data": {
    "lastSeen": { "$op": "serverTimestamp" },
    "tags": { "$op": "arrayUnion", "elements": ["vip", "beta"] },
    "legacyField": { "$op": "deleteField" }
  },
  "ifVersion": 4
}`} />
          <Code lang="json" title="200 OK" code={`{
  "path": "users/u_123",
  "collectionPath": "users",
  "collectionGroup": "users",
  "documentId": "u_123",
  "data": {
    "name": "Amina",
    "active": true,
    "tags": ["beta", "vip"],
    "lastSeen": { "$t": "ts", "$v": "2026-11-18T09:45:00.000Z", "$ms": 1794975900000 }
  },
  "sizeBytes": 198,
  "version": 5,
  "createdAt": "2026-11-01T08:12:00.000Z",
  "updatedAt": "2026-11-18T09:45:00.000Z"
}`} />
        </Api>

        <Api method="DELETE" path="/v1/projects/:projectId/documents/*">
          <P>
            حذف ناعم: يُكتب قبر tombstone ويُسجَّل حدث في <IC>realtime_outbox</IC>، فتصل إشاعة <IC>removed</IC> إلى
            المشتركين. يقبل <IC>?ifVersion=</IC> للتحقق المتشائم.
          </P>
          <P>الرؤوس المطلوبة: <IC>x-vellum-api-key</IC>، واختيارياً رمز المستخدم النهائي. لا جسم للطلب.</P>
          <Code lang="json" title="200 OK" code={`{
  "path": "users/u_123",
  "status": "deleted",
  "version": 6,
  "updatedAt": "2026-11-18T10:00:00.000Z"
}`} />
        </Api>
      </Section>

      <Section id="query" title="الاستعلام المُهيكل">
        <P>
          يُغني الاستعلام المُهيكل عن ترتيب النتائج في العميل، ويُترجم إلى SQL داخل محرك الاستعلام. يتطلّب
          فهرساً مركّباً عندما تجمع بين مرشحات متعددة وترتيب، ويرجع المؤشر <IC>nextCursor</IC> الموقّع بـ
          HMAC-SHA256 مع <IC>document_id ASC</IC> كفاصل حسم؛ ولا يُعرَض <IC>OFFSET</IC> أبداً.
        </P>

        <Api method="POST" path="/v1/projects/:projectId/query">
          <P>
            الرؤوس المطلوبة: <IC>x-vellum-api-key</IC>، واختيارياً رمز المستخدم النهائي. الحد الأقصى لعدد بنود{" "}
            <IC>where</IC> هو <IC>10</IC>، ولقيم <IC>in</IC> هو <IC>30</IC>، ولحقول <IC>orderBy</IC> هو <IC>3</IC>،
            ولـ <IC>limit</IC> هو <IC>500</IC>.
          </P>
          <Code lang="json" title="طلب" code={`{
  "collectionPath": "users/u_123/orders",
  "where": [
    { "field": "status", "op": "==", "value": "paid" },
    { "field": "total", "op": ">=", "value": 100 }
  ],
  "orderBy": [{ "field": "createdAt", "direction": "desc" }],
  "limit": 50,
  "select": ["status", "total", "createdAt"],
  "startAfter": "eyJ2Ijo0LCJpZCI6Im9yZF80NTYifQ"
}`} />
          <Code lang="json" title="200 OK" code={`{
  "documents": [
    {
      "path": "users/u_123/orders/ord_456",
      "collectionPath": "users/u_123/orders",
      "collectionGroup": "orders",
      "documentId": "ord_456",
      "data": {
        "status": "paid",
        "total": 149.5,
        "createdAt": { "$t": "ts", "$v": "2026-11-17T14:30:00.000Z", "$ms": 1794925800000 }
      },
      "sizeBytes": 143,
      "version": 2,
      "createdAt": "2026-11-17T14:30:00.000Z",
      "updatedAt": "2026-11-17T14:35:00.000Z"
    }
  ],
  "nextCursor": "eyJ2IjoyLCJpZCI6Im9yZF80NTYifQ",
  "meta": {
    "count": 1,
    "indexUsed": "idx_orders_status_total_v1",
    "executionTimeMs": 6,
    "compiledSql": "SELECT ... FROM document_index_entries WHERE sort_key >= $1 ORDER BY sort_key ASC LIMIT $2"
  }
}`} />
        </Api>

        <Api method="POST" path="/v1/projects/:projectId/documents:referencedBy">
          <P>
            الترويسات المطلوبة: <code>x-vellum-api-key</code> و<code>content-type: application/json</code>.
            العكس من <code>include</code>: لديك مسار مستند هدف وتريد المستندات التي
            يشير حقل المرجع فيها إليه، مع تضييق اختياري على مجموعة وحقل واحد. الترقيم
            بالمؤشرات فقط وبحد صفحة 1&ndash;100. يجب أن يكون الهدف قابلًا للقراءة
            (<code>get</code>) ويُعاد تفويض كل مستند مُرجَع (<code>list</code>)؛
            وتُرشَّح بصمت المستندات التي لا يحق للمفتاح قراءتها.
          </P>
          <CodeTabs
            tabs={[
              {
                label: "الطلب",
                lang: "json",
                code: JSON.stringify(
                  {
                    targetPath: "users/u_123",
                    collection: "posts",
                    field: "authorId",
                    limit: 25,
                    cursor: "eyJ2IjoxLCJpZCI6InBfOTk5In0",
                  },
                  null,
                  2
                ),
              },
              {
                label: "الاستجابة · 200",
                lang: "json",
                code: JSON.stringify(
                  {
                    documents: [
                      { path: "posts/p_001", data: { title: "مرحبًا", authorId: "u_123" }, version: 2 },
                    ],
                    nextCursor: "eyJ2IjoxLCJpZCI6InBfMDAxIn0",
                  },
                  null,
                  2
                ),
              },
            ]}
          />
          <P>
            قاعدة علاقة من نوع <code>restrict</code> تجعل حذف الهدف ما دام مرجوسًا يفشل بـ{" "}
            <code>412 RELATION_RESTRICT_VIOLATION</code>، وهذه النقطة تُشغِّل البحث العكسي في{" "}
            <PageLink slug="relationships">العلاقات</PageLink>. عرِّف القاعدة أولًا كي يُبنى فهرس GIN
            على <code>referenced_by</code> مسبقًا؛ راجع{" "}
            <PageLink slug="relationships">العلاقات</PageLink>.
          </P>
        </Api>
        <Callout tone="info" title="الفهارس ليست DDL على الجدول المشترك">
          <P>
            الفهارس المركّبة صفوف في <IC>document_indexes</IC> تُصان في <IC>document_index_entries</IC> بمفاتيح
            فرز <IC>BYTEA</IC> تحافظ على الترتيب. لا تُنفَّذ أوامر <IC>CREATE INDEX</IC> على جدول <IC>documents</IC>
            المشترك على الإطلاق.
          </P>
        </Callout>
      </Section>

      <Section id="writes" title="الكتابة الدفعية والمعاملات">
        <P>
          تُجمَّع حتى <IC>100</IC> عملية في كتابة دفعية واحدة بحجم إجمالي لا يتجاوز <IC>5 MiB</IC>، وتُنفَّذ ذرياً.
          أما المعاملات فتستخدم تحققاً متشائماً من الإصدار (OCC) مع <IC>SELECT … FOR UPDATE</IC> بترتيب{" "}
          <IC>path ASC</IC> حتمي، وتنتهي بعد <IC>5</IC> ثوانٍ كحد أقصى.
        </P>

        <Api method="POST" path="/v1/projects/:projectId/batchWrite">
          <P>
            الشكل canonical هو <IC>writes</IC>، ويُقبل <IC>operations</IC> كمرادف للتوافق. كل عنصر يحمل <IC>type</IC>{" "}
            و<IC>path</IC> و<IC>data</IC> عند لزومها، ويمكن أن يحمل <IC>ifVersion</IC> أو <IC>exists</IC>.
          </P>
          <P>الرؤوس المطلوبة: <IC>x-vellum-api-key</IC>، واختيارياً رمز المستخدم النهائي.</P>
          <Code lang="json" title="طلب" code={`{
  "writes": [
    {
      "type": "set",
      "path": "users/u_123",
      "data": { "name": "Amina", "active": true },
      "merge": true,
      "ifVersion": 4
    },
    {
      "type": "create",
      "path": "users/u_123/orders/ord_789",
      "data": { "status": "pending", "total": 25 },
      "exists": false
    },
    { "type": "delete", "path": "users/u_123/orders/ord_111" }
  ]
}`} />
          <Code lang="json" title="200 OK" code={`{
  "results": [
    {
      "path": "users/u_123",
      "collectionPath": "users",
      "collectionGroup": "users",
      "documentId": "u_123",
      "data": { "name": "Amina", "active": true },
      "sizeBytes": 96,
      "version": 5,
      "createdAt": "2026-11-01T08:12:00.000Z",
      "updatedAt": "2026-11-18T11:00:00.000Z"
    },
    { "path": "users/u_123/orders/ord_111", "status": "deleted", "version": 2, "updatedAt": "2026-11-18T11:00:00.000Z" }
  ],
  "committedAt": "2026-11-18T11:00:00.000Z"
}`} />
        </Api>

        <Api method="POST" path="/v1/projects/:projectId/documents:batchWrite">
          <P>
            اسم مستعار لـ <IC>/batchWrite</IC> بنفس الجسم ونفس الدلالات، مُقدَّم للعملاء الذين يفضّلون نمط{" "}
            <IC>documents:*</IC> في مساراتهم. يستقبل <IC>writes</IC> أو <IC>operations</IC> ويعيد نفس شكل{" "}
            <IC>BatchWriteResult</IC>.
          </P>
          <P>الرؤوس المطلوبة: <IC>x-vellum-api-key</IC>، واختيارياً رمز المستخدم النهائي.</P>
          <Code lang="json" title="طلب" code={`{
  "operations": [
    { "type": "update", "path": "counters/visits", "data": { "count": { "$op": "inc", "by": 1 } } }
  ]
}`} />
          <Code lang="json" title="200 OK" code={`{
  "results": [
    {
      "path": "counters/visits",
      "collectionPath": "counters",
      "collectionGroup": "counters",
      "documentId": "visits",
      "data": { "count": 1 },
      "sizeBytes": 42,
      "version": 1,
      "createdAt": "2026-11-18T11:05:00.000Z",
      "updatedAt": "2026-11-18T11:05:00.000Z"
    }
  ],
  "committedAt": "2026-11-18T11:05:00.000Z"
}`} />
        </Api>

        <Api method="POST" path="/v1/projects/:projectId/transactions:begin">
          <P>
            يفتح معاملة OCC ويُصدر رمزاً موقّعاً. لا جسم للطلب. يجب إعادة الرمز في طلب <IC>commit</IC>، ويجب إرفاقه
            برأس <IC>x-transaction-token</IC> عند أي قراءة ضمن المعاملة.
          </P>
          <P>الرؤوس المطلوبة: <IC>x-vellum-api-key</IC>، واختيارياً رمز المستخدم النهائي.</P>
          <Code lang="json" title="200 OK" code={`{
  "transactionId": "tx_01J9ZB8H2P",
  "transactionToken": "eyJ0eXAiOiJkb2NkYSt0eCIsInR4IjoidHhfMDFKOVpCOEgyUCJ9",
  "expiresAt": "2026-11-18T11:05:00.000Z"
}`} />
        </Api>

        <Api method="POST" path="/v1/projects/:projectId/transactions:commit">
          <P>
            يتحقق من إصدارات مجموعة القراءة ويُنفّذ كل العمليات ذرياً. يقبل <IC>writes</IC> أو <IC>mutations</IC>،
            وتُقرأ قيود الإصدار من <IC>ifVersion</IC> أو <IC>preconditions</IC> أو <IC>precondition</IC>. تجاوز
            <IC>5</IC> ثوانٍ يُنتج <IC>408 TRANSACTION_TIMEOUT</IC>، وتغيّر أي مستند مقروء يُنتج{" "}
            <IC>409 ABORTED</IC>.
          </P>
          <P>الرؤوس المطلوبة: <IC>x-vellum-api-key</IC>، واختيارياً رمز المستخدم النهائي.</P>
          <Code lang="json" title="طلب" code={`{
  "transactionToken": "eyJ0eXAiOiJkb2NkYSt0eCIsInR4IjoidHhfMDFKOVpCOEgyUCJ9",
  "writes": [
    {
      "type": "update",
      "path": "accounts/a_1",
      "data": { "balance": { "$op": "inc", "by": -50 } },
      "ifVersion": 7
    },
    {
      "type": "update",
      "path": "accounts/a_2",
      "data": { "balance": { "$op": "inc", "by": 50 } },
      "ifVersion": 2
    }
  ]
}`} />
          <Code lang="json" title="200 OK" code={`{
  "results": [
    {
      "path": "accounts/a_1",
      "collectionPath": "accounts",
      "collectionGroup": "accounts",
      "documentId": "a_1",
      "data": { "balance": 450 },
      "sizeBytes": 51,
      "version": 8,
      "createdAt": "2026-11-10T07:00:00.000Z",
      "updatedAt": "2026-11-18T11:04:50.000Z"
    },
    {
      "path": "accounts/a_2",
      "collectionPath": "accounts",
      "collectionGroup": "accounts",
      "documentId": "a_2",
      "data": { "balance": 150 },
      "sizeBytes": 51,
      "version": 3,
      "createdAt": "2026-11-10T07:00:00.000Z",
      "updatedAt": "2026-11-18T11:04:50.000Z"
    }
  ],
  "committedAt": "2026-11-18T11:04:50.000Z"
}`} />
        </Api>
      </Section>

      <Section id="indexes" title="الفهارس المركّبة">
        <P>
          إدارة الفهارس عملية امتيازية: تتطلّب مفتاح خادم <IC>sk_</IC> يحمل النطاق <IC>indexes:manage</IC>، وتُرفض
          بمفتاح <IC>pk_</IC>. حالة الفهرس تنتقل من <IC>building</IC> إلى <IC>ready</IC> بعد اكتمال البناء العكسي،
          وقد تكون <IC>failed</IC> أو <IC>deleting</IC>.
        </P>

        <Api method="GET" path="/v1/projects/:projectId/indexes">
          <P>يسرد الفهارس المركّبة وحالات بنائها في المشروع المطلوب.</P>
          <P>
            الرؤوس المطلوبة: <IC>x-vellum-api-key</IC> بمفتاح <IC>sk_</IC> ونطاق <IC>indexes:manage</IC>.
          </P>
          <Code lang="json" title="200 OK" code={`{
  "indexes": [
    {
      "id": "idx_9f3a21",
      "projectId": "proj_7c1f",
      "collectionPath": "users/u_123/orders",
      "fields": [
        { "fieldPath": "status", "direction": "asc" },
        { "fieldPath": "createdAt", "direction": "desc" }
      ],
      "definitionHash": "8e9c…",
      "status": "ready",
      "errorMessage": null,
      "createdAt": "2026-11-15T10:00:00.000Z",
      "updatedAt": "2026-11-15T10:02:00.000Z"
    }
  ]
}`} />
        </Api>

        <Api method="POST" path="/v1/projects/:projectId/indexes">
          <P>
            يُسجّل فهرساً جديداً ويبدأ بناءه العكسي. يجب أن يكون <IC>collectionPath</IC> مسار مجموعة صالحاً،
            وأن تكون <IC>fields</IC> مصفوفة غير فارغة؛ وإلا أجاب <IC>400 INVALID_ARGUMENT</IC>.
          </P>
          <P>
            الرؤوس المطلوبة: <IC>x-vellum-api-key</IC> بمفتاح <IC>sk_</IC> ونطاق <IC>indexes:manage</IC>.
          </P>
          <Code lang="json" title="طلب" code={`{
  "collectionPath": "users/u_123/orders",
  "fields": [
    { "fieldPath": "status", "direction": "asc" },
    { "fieldPath": "createdAt", "direction": "desc" }
  ]
}`} />
          <Code lang="json" title="201 Created" code={`{
  "id": "idx_9f3a21",
  "projectId": "proj_7c1f",
  "collectionPath": "users/u_123/orders",
  "fields": [
    { "fieldPath": "status", "direction": "asc" },
    { "fieldPath": "createdAt", "direction": "desc" }
  ],
  "definitionHash": "8e9c…",
  "status": "building",
  "errorMessage": null,
  "createdAt": "2026-11-18T12:00:00.000Z",
  "updatedAt": "2026-11-18T12:00:00.000Z"
}`} />
        </Api>

        <Api method="DELETE" path="/v1/projects/:projectId/indexes/:indexId">
          <P>يحذف الفهرس وكل إدخالاته من <IC>document_index_entries</IC>. العملية معتمدة على المعرّف ولا جسم لها.</P>
          <P>
            الرؤوس المطلوبة: <IC>x-vellum-api-key</IC> بمفتاح <IC>sk_</IC> ونطاق <IC>indexes:manage</IC>.
          </P>
          <Code lang="json" title="200 OK" code={`{
  "deleted": true,
  "indexId": "idx_9f3a21"
}`} />
        </Api>
      </Section>

      <Section id="collections" title="دورة حياة المجموعات (Collections)">
        <P>
          المجموعة صفّ دائم في الجدول <IC>data_db.project_collections</IC> مع سياسات RLS مفعّلة
          وقسرية، وليست عرضاً عابراً ناتجاً عن <IC>DISTINCT</IC>. توجد المجموعة حتى وهي خالية،
          وتحتفظ بإعداداتها بعد حذف المستندات وبعد تحديث الصفحة أو إعادة تشغيل الخادم. نفس
          نقاط النهاية الثماني متاحة على سطحين: مستوى البيانات العام الموضّح هنا، وسطح Console
          الموثَّق بالجلسة أسفل <IC>/v1/console/projects/:projectId/collections…</IC>
          والذي تستخدمه لوحة العميل.
        </P>
        <Callout tone="danger" title="أنواع المفاتيح: pk_ للقراءة وsk_ للتعديل">
          <P>
            على السطح العام تقبل طلبات <IC>GET</IC> (السرد، القراءة، التصدير) مفتاحاً عاماً{" "}
            <IC>pk_</IC>. أما كل تعديل — الإنشاء والتعديل والمسح والحذف والاستيراد — فيتطلّب مفتاح
            خادم <IC>sk_</IC> وإلا أجاب الخادم بـ <IC>403 PERMISSION_DENIED</IC>. نداءات Console
            تستخدم رمز جلسة <IC>CUSTOMER_CONSOLE</IC> وتُسجَّل في سجل التدقيق المتسلسل المشفّر.
          </P>
        </Callout>
        <Table
          head={["الطريقة", "اللاحقة", "المصادقة (عام / Console)", "الاستجابة"]}
          rows={[
            [<IC>GET</IC>, <IC>/collections</IC>, <><IC>pk_</IC>/<IC>sk_</IC> / جلسة</>, <><IC>{'{ collections: CollectionWithStats[], nextCursor }'}</IC></>],
            [<IC>POST</IC>, <IC>/collections</IC>, <><IC>sk_</IC> / جلسة</>, <>201 <IC>CollectionRecord</IC></>],
            [<IC>GET</IC>, <IC>/collections/:name</IC>, <><IC>pk_</IC>/<IC>sk_</IC> / جلسة</>, <><IC>CollectionWithStats | null</IC></>],
            [<IC>PATCH</IC>, <IC>/collections/:name</IC>, <><IC>sk_</IC> / جلسة</>, <IC>CollectionWithStats</IC>],
            [<IC>POST</IC>, <IC>/collections/:name/clear</IC>, <><IC>sk_</IC> / جلسة</>, <><IC>{'{ deletedCount, freedBytes }'}</IC></>],
            [<IC>DELETE</IC>, <IC>/collections/:name</IC>, <><IC>sk_</IC> / جلسة</>, <><IC>{'{ deletedCollection, deletedDocuments, freedBytes }'}</IC></>],
            [<IC>POST</IC>, <IC>/collections/:name/import</IC>, <><IC>sk_</IC> / جلسة</>, <><IC>{'{ importedCount, skippedCount, errors }'}</IC></>],
            [<IC>GET</IC>, <IC>/collections/:name/export</IC>, <><IC>pk_</IC>/<IC>sk_</IC> / جلسة</>, <><IC>{'{ documents, nextCursor }'}</IC></>],
          ]}
        />
        <Api method="GET" path="/v1/projects/:projectId/collections">
          <P>
            معاملات الاستعلام: <IC>search</IC> (تطابق جزئي حتى 256 حرفاً)، و<IC>limit</IC> (من 1 إلى 500،
            <strong> الافتراضي 50</strong>)، و<IC>cursor</IC> (مؤشر مواربة من <IC>nextCursor</IC>). استخدم{" "}
            <IC>?limit=500</IC> لرؤية كل المجموعات عند وجود أكثر من 50 مجموعة؛ ومستكشف البيانات في
            اللوحة يرسل هذه القيمة دائماً.
          </P>
          <Code
            lang="json"
            title="200 OK"
            code={`{
  "collections": [
    {
      "id": "col_01J9F5K2M8",
      "name": "users",
      "description": "Customer accounts",
      "defaultTtlSeconds": 86400,
      "schemaValidation": { "requiredFields": ["email"], "strict": false },
      "documentCount": 12,
      "storageBytes": 4096,
      "lastDocumentAt": "2026-11-19T10:04:00.000Z",
      "createdAt": "2026-11-19T10:00:00.000Z",
      "updatedAt": "2026-11-19T10:05:00.000Z"
    }
  ],
  "nextCursor": null
}`}
          />
        </Api>
        <Api method="POST" path="/v1/projects/:projectId/collections">
          <P>
            يتطلّب مفتاح <IC>sk_</IC>. الاسم من 1 إلى 128 حرفاً وفق النمط{" "}
            <IC>^[A-Za-z0-9][A-Za-z0-9._-]{'{0,127}'}$</IC>، و<IC>ifNotExists: true</IC> يجعل الإنشاء
            آمن التكرار. الإعدادات: <IC>description</IC> (≤2048 حرفاً)، و
            <IC> defaultTtlSeconds</IC> (عدد صحيح موجب)، و
            <IC> schemaValidation.requiredFields</IC> مع <IC>strict</IC> الاختياري، و<IC> metadata</IC>.
            أي حقل غير معروف يُنتج <IC>400 INVALID_ARGUMENT</IC>. أما <IC>PATCH …/:name</IC> فيقبل
            القيم <IC>null</IC> لمسح الإعدادات.
          </P>
          <Code
            lang="json"
            title="طلب"
            code={`{
  "name": "users",
  "description": "Customer accounts",
  "defaultTtlSeconds": 86400,
  "schemaValidation": { "requiredFields": ["email"], "strict": false },
  "ifNotExists": true
}`}
          />
        </Api>
        <Api method="POST" path="/v1/projects/:projectId/collections/:name/clear">
          <P>
            <strong>المسح</strong> يحذف كل المستندات حذفاً ناعماً لكنه يُبقي صف المجموعة وإعداداتها،
            ويُعيد <IC>{'{ deletedCount, freedBytes }'}</IC>. <strong>الحذف</strong>{" "}
            (<IC>DELETE …/:name</IC>) يُزيل الصف والمستندات ويُعيد{" "}
            <IC>{'{ deletedCollection, deletedDocuments, freedBytes }'}</IC>. كلتا العمليتين تُقيَّس
            وتُسجَّل في سجل التدقيق.
          </P>
        </Api>
        <Api method="POST" path="/v1/projects/:projectId/collections/:name/import">
          <P>
            الجسم مصفوفة JSON تضم 500 كائن كحد أقصى بصيغة <IC>{'{ id?, data }'}</IC> أو غلاف الحزم
            <IC>{'{ documents, mode }'}</IC>؛ العناصر غير
            الصالحة تُتخطى ويُبلَّغ عن فهرسها في <IC>errors</IC>. أما{" "}
            <IC>GET …/:name/export</IC> فيُصفّي حسب <IC>path ASC</IC> ويُعيد <IC>documents</IC> مع{" "}
            <IC>nextCursor</IC> دون <IC>OFFSET</IC>. تغلّف الحزم البرمجية ذلك بالدالتين{" "}
            <IC>importDocuments</IC> و<IC>exportDocuments</IC> — راجع{" "}
            <PageLink slug="sdks/javascript" lang="ar">حزمة JavaScript</PageLink> و{" "}
            <PageLink slug="sdks/flutter" lang="ar">حزمة Flutter</PageLink>.
          </P>
        </Api>
      </Section>

      <Section id="aux-and-limits" title="عمليات مساعدة وقيود سريعة">
        <Table
          head={["القيد", "القيمة", "الخطأ عند التجاوز"]}
          rows={[
            ["حجم المستند", <>1 MiB</>, <IC>DOCUMENT_TOO_LARGE</IC>],
            ["عمق المسار", <>10 مقاطع</>, <IC>INVALID_DOCUMENT_PATH</IC>],
            ["حجم المقطع", <>1,500 بايت</>, <IC>INVALID_DOCUMENT_PATH</IC>],
            ["عمق تداخل الكائنات", <>20 مستوى</>, <IC>MAX_NESTING_EXCEEDED</IC>],
            ["طول اسم الحقل", <>256 حرفاً</>, <IC>INVALID_FIELD_NAME</IC>],
            ["حجم الدفعة", <>100 عملية / 5 MiB</>, <><IC>BATCH_SIZE_EXCEEDED</IC> / <IC>PAYLOAD_TOO_LARGE</IC></>],
            ["مدة المعاملة", <>5 ثوانٍ</>, <IC>TRANSACTION_TIMEOUT</IC>],
            ["حد الاستعلام", <>500 (الافتراضي 50)</>, <IC>LIMIT_EXCEEDED</IC>],
          ]}
        />
        <UL
          items={[
            <PageLink slug="errors-and-limits" lang="ar">الحصص والحدود كاملة مع رموز الأخطاء</PageLink>,
            <PageLink slug="field-transforms" lang="ar">تحويلات الحقول <IC>$op</IC> بالتفصيل</PageLink>,
            <PageLink slug="pagination" lang="ar">آلية المؤشرات المعتمة والترقيم الصفحي</PageLink>,
            <PageLink slug="reference/realtime-protocol" lang="ar">استقبال التغييرات عبر WebSocket</PageLink>,
          ]}
        />
      </Section>
    </Doc>
  );
}
