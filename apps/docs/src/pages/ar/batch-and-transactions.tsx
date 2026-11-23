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

const endpoint = "/v1/projects/:projectId";

export default function Page() {
  return (
    <Doc
      title="الكتابات الدفعية والمعاملات"
      description="الكتابة الدفعية الذرية batchWrite وbatchWriteChunked، ومعاملات التزامن المتفائل (OCC) المدعومة بقفل FOR UPDATE الأصلي في PostgreSQL."
      eyebrow="المفاهيم الأساسية"
    >
      <Section id="overview" title="نظرة عامة">
        <P>
          يقدّم VELLUM آليتين لتجميع عمليات الكتابة بضمان الذرية الكاملة: <code>batchWrite</code> لإرسال
          قائمة تعديلات معروفة مسبقاً تنجح كلها معاً أو تُلغى كلها معاً، و<code>runTransaction</code> لمنطق
          «اقرأ ثم عدّل» (Read-Modify-Write) حيث تعتمد القيم الجديدة على القيم الحالية وتلتزم المعاملة فقط
          إذا لم يعدّل أي كاتب آخر مجموعة القراءة قبل الالتزام.
        </P>
        <Callout tone="info" title="ضمان الذرية والبث الفوري">
          كلا المسارين يعمل داخل معاملة PostgreSQL أصلية، ولا تُكتب أحداث <code>realtime_outbox</code> إلا
          عند نجاح الالتزام، فلا يرى المشتركون أبداً دفعة مطبّقة جزئياً.
        </Callout>
      </Section>

      <Section id="batch-write" title="الكتابات الدفعية (batchWrite)">
        <P>
          الدفعة هي طلب HTTP واحد ومعاملة قاعدة بيانات واحدة تضم مصفوفة عمليات{" "}
          <code>create</code> و<code>set</code> و<code>update</code> و<code>delete</code> تُنفّذ بالترتيب
          المحدد.
        </P>
        <Api method="POST" path={`${endpoint}/batchWrite`}>
          <P>يتطلب نطاق <code>documents:write</code> لمفاتيح الخادم أو تصريح قواعد الأمان لكل عملية.</P>
        </Api>
        <CodeTabs
          tabs={[
            {
              label: "JavaScript / TypeScript",
              lang: "ts",
              code: `import { createClient, fieldOp } from "@vellumdb/sdk-js";

const db = createClient({
  endpoint: "https://api.example.com",
  projectId: "<PROJECT_ID>",
  apiKey: "<sk_...>",
});

const result = await db.batchWrite([
  { type: "create", path: "users/u_123", data: { name: "Ada", credits: 0 } },
  { type: "set", path: "users/u_123/stats/main", data: { logins: 0 }, merge: false },
  { type: "update", path: "counters/users", data: { total: fieldOp.increment(1) } },
  { type: "delete", path: "sessions/old_session" },
]);
console.log(result);`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `import 'package:vellum_flutter/vellum_flutter.dart';

final client = VellumClient(
  endpoint: 'https://api.example.com',
  projectId: '<PROJECT_ID>',
  apiKey: '<sk_...>',
);

// الطريقة المباشرة بقائمة خرائط:
final result = await client.batchWrite([
  {'type': 'create', 'path': 'users/u_123', 'data': {'name': 'Ada', 'credits': 0}},
  {'type': 'update', 'path': 'counters/users', 'data': {'total': FieldValue.increment(1)}},
  {'type': 'delete', 'path': 'sessions/old_session'},
]);

// أو عبر الباني الانسيابي VellumWriteBatch:
final batch = client.batch()
  ..set(client.doc('users/u_124'), {'name': 'Grace', 'credits': 10})
  ..update(client.doc('counters/users'), {'total': FieldValue.increment(1)})
  ..delete(client.doc('sessions/expired'));
await batch.commit();`,
            },
          ]}
        />
        <H3 id="batch-chunked">الكتابة الدفعية الضخمة (batchWriteChunked في TypeScript)</H3>
        <P>
          عندما تحتاج إلى كتابة مئات أو آلاف العمليات دون خرق سقف الـ 100 عملية لكل دفعة، توفّر حزمة{" "}
          <code>@vellumdb/sdk-js</code> الدالة <code>batchWriteChunked()</code> التي تقسّم العمليات تلقائياً
          إلى دفعات آمنة مع تحكم بالتزامن (<code>concurrency</code>)، وتقارير تقدّم (<code>onProgress</code>)،
          ودعم الإلغاء عبر <code>AbortSignal</code>:
        </P>
        <Code
          lang="ts"
          title="تقسيم دفعة كبيرة بأمان مع تتبع التقدم"
          code={`const operations = [{ type: "set", path: "users/u_123", data: { name: "Ada" } }];
const summary = await db.batchWriteChunked(operations, {
  chunkSize: 100, // التزم بحد الخادم 100 عملية للدفعة الذرية الواحدة
  concurrency: 4,
  onProgress: ({ completedOperations, totalOperations, completedChunks, totalChunks }) => {
    console.log(\`Chunk \${completedChunks}/\${totalChunks} (\${completedOperations}/\${totalOperations})\`);
  },
});
console.log(summary.totalOperations, summary.totalChunks);`}
        />
        <H3 id="batch-limits">الحدود ودلالات التنفيذ</H3>
        <Table
          head={["القيد", "القيمة الثابتة", "الخطأ عند التجاوز"]}
          rows={[
            ["عدد العمليات في الدفعة الواحدة", "100 عملية", <code>BATCH_SIZE_EXCEEDED (400)</code>],
            ["حجم الحمولة المسلسلة", "5 MiB", <code>PAYLOAD_TOO_LARGE (413)</code>],
            ["مصفوفة عمليات فارغة", "غير مسموح", <code>INVALID_ARGUMENT (400)</code>],
          ]}
        />
        <UL
          items={[
            "تُنفَّذ جميع التعديلات داخل معاملة واحدة؛ أي خطأ في أي عنصر يُلغي الدفعة بالكامل دون نجاح جزئي.",
            "يُتحقَّق من الشروط بالترتيب: فشل ifVersion يعيد FAILED_PRECONDITION (412)، وحذف مستند مفقود يعيد NOT_FOUND (404)، وإنشاء مستند قائم يعيد ALREADY_EXISTS (409).",
            "كتابة نفس المسار مرتين داخل دفعة واحدة تحافظ على دلالة قراءة كتاباتك (Read-Your-Writes).",
            <>
              تُدعم جميع تحويلات الحقول الذرية مثل <code>fieldOp.increment</code> داخل الدفعة — راجع{" "}
              <PageLink slug="field-transforms" lang="ar">تحويلات الحقول</PageLink>.
            </>,
          ]}
        />
        <Code
          lang="ts"
          title="شرط إصدار داخل دفعة"
          code={`await db.batchWrite([
  // تفشل الدفعة كلها بخطأ FAILED_PRECONDITION إذا لم يعد إصدار u_123 يساوي 4.
  { type: "update", path: "users/u_123", data: { name: "Grace" }, ifVersion: 4 },
  { type: "create", path: "audit/change_1", data: { field: "name" } },
]);`}
        />
      </Section>

      <Section id="occ" title="معاملات التزامن المتفائل (OCC Transactions)">
        <P>
          تتيح لك المعاملة قراءة عدة مستندات، وحساب القيم الجديدة، ثم الالتزام بضمان عدم تغيّر أي مستند في
          مجموعة القراءة. تُحفظ حالة المعاملة في جدول <code>transactions</code> داخل مستوى البيانات مع أقفال
          PostgreSQL الأصلية، مما يجعلها مشتركة بين جميع نسخ API دون أي حالة محلية أو Redis.
        </P>
        <Api method="POST" path={`${endpoint}/transactions:begin`}>
          <P>يُنشئ صف معاملة في مستوى البيانات ويُصدر <code>transactionToken</code> موقّعاً.</P>
        </Api>
        <Api method="POST" path={`${endpoint}/transactions:commit`}>
          <P>يتحقق من إصدارات مجموعة القراءة ويطبّق جميع الكتابات المجهّزة ذرياً.</P>
        </Api>
        <Steps
          items={[
            {
              title: "البدء (Begin)",
              body: "تستدعي الحزمة POST .../transactions:begin للحصول على transactionToken تُمرَّر مع كل قراءة تالية.",
            },
            {
              title: "القراءة وتسجيل الإصدارات",
              body: "كل استدعاء tx.get() يقرأ المستند ويسجّل إصداره الحالي في مجموعة القراءة (Read Set) الخاصة بالمعاملة.",
            },
            {
              title: "تجهيز الكتابات محلياً",
              body: "تُجمّع استدعاءات create / set / update / delete داخل سياق المعاملة دون إرسالها بعد، مما يسمح بإعادة تشغيل الدالة بأمان عند التعارض.",
            },
            {
              title: "الالتزام مع قفل حتمي يمنع الجمود (Deadlock-Free)",
              body: "عند POST .../transactions:commit يُقفل صف المعاملة وجميع مستندات مجموعة القراءة عبر SELECT ... FOR UPDATE بترتيب path ASC الحتمي، وتُقارن الإصدارات، ثم تُطبَّق الكتابات وأحداث صندوق البريد في معاملة PostgreSQL واحدة.",
            },
          ]}
        />
        <CodeTabs
          tabs={[
            {
              label: "JavaScript / TypeScript",
              lang: "ts",
              code: `import { createClient } from "@vellumdb/sdk-js";

const db = createClient({
  endpoint: "https://api.example.com",
  projectId: "<PROJECT_ID>",
  apiKey: "<sk_...>",
});

// تعيد runTransaction في TypeScript الكائن { result, commit }.
const { result, commit } = await db.runTransaction(
  async (tx) => {
    const from = await tx.get<{ balance: number }>("accounts/a");
    const to = await tx.get<{ balance: number }>({ path: "accounts/b" });
    const amount = 50;
    const fromBalance = from.data().balance;
    const toBalance = to.data().balance;

    tx.update("accounts/a", { balance: fromBalance - amount });
    tx.update("accounts/b", { balance: toBalance + amount });
    return { moved: amount };
  },
  { maxAttempts: 5 }
);
console.log(result, commit);`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `import 'package:vellum_flutter/vellum_flutter.dart';

final fromRef = client.doc('accounts/a');
final toRef = client.doc('accounts/b');

// تعيد runTransaction في Dart قيمة دالة المعاملة مباشرة.
final transfer = await client.runTransaction<Map<String, int>>((tx) async {
  const amount = 50;
  final from = await tx.get(fromRef);
  final to = await tx.get(toRef);
  final fromBalance = (from.data()?['balance'] as num).toInt();
  final toBalance = (to.data()?['balance'] as num).toInt();

  tx.update(fromRef, {'balance': fromBalance - amount});
  tx.update(toRef, {'balance': toBalance + amount});
  return {'moved': amount};
}, maxAttempts: 5);
print(transfer);`,
            },
          ]}
        />
        <P>
          لا يوجد مسار عام <code>/transactions:rollback</code> في v1: يتولى الخادم إصدار{" "}
          <code>ROLLBACK</code> أصلي في PostgreSQL تلقائياً عند حدوث أي تعارض أو خطأ أو انتهاء مهلة.
        </P>
      </Section>

      <Section id="conflicts" title="التعارضات وإعادة المحاولة والمهلة الزمنية">
        <P>
          إذا تغيّر أي مستند في مجموعة القراءة قبل الالتزام، يرفض الخادم الالتزام برمز{" "}
          <code>ABORTED_CONFLICT</code> (409). تلتقط كلتا الحزمتين هذا الرمز تحديداً، وتنتظران تراجعاً
          عشوائياً (Jittered Backoff)، ثم تعيدان تشغيل دالة المعاملة بالكامل حتى{" "}
          <code>maxAttempts</code> (الافتراضي <strong>5</strong> محاولات). تُرمى أي أخطاء أخرى فوراً دون
          إعادة محاولة.
        </P>
        <Table
          head={["الحالة", "الرمز المعياري", "HTTP"]}
          rows={[
            ["تجاوز المعاملة 5,000 ms", <code>TRANSACTION_TIMEOUT</code>, "408"],
            ["تغيّر إصدار أحد مستندات القراءة قبل الالتزام", <code>ABORTED_CONFLICT</code>, "409 (تعيد الحزمة المحاولة تلقائياً)"],
            ["محاولة الالتزام بمعاملة ملتزمة أو متراجع عنها مسبقاً", <><code>ALREADY_COMMITTED</code> / <code>ALREADY_ROLLED_BACK</code></>, "409"],
            ["فشل شرط ifVersion", <code>FAILED_PRECONDITION</code>, "412"],
            ["create على مسار قائم", <code>ALREADY_EXISTS</code>, "409"],
            ["delete على مسار مفقود", <code>NOT_FOUND</code>, "404"],
          ]}
        />
        <Callout tone="warning" title="اجعل دالة المعاملة نقية وسريعة">
          قد تُنفَّذ دالة المعاملة أكثر من مرة عند حدوث تعارض. لا تُرسل بريداً إلكترونياً ولا تستدعِ خدمات
          خارجية داخلها، واحسب العمليات الثقيلة قبل فتح المعاملة لتبقى ضمن ميزانية الـ 5 ثوانٍ.
        </Callout>
      </Section>

      <Section id="choosing" title="اختيار الآلية المناسبة">
        <Table
          head={["الآلية", "متى تستخدمها؟", "الضمان الأساسي"]}
          rows={[
            [
              <code>batchWrite</code>,
              "جميع الكتابات معروفة مسبقاً ولا تعتمد على القيم المخزّنة حالياً.",
              "التزام ذري كامل لما يصل إلى 100 عملية (5 MiB) بلا نجاح جزئي.",
            ],
            [
              <code>runTransaction</code>,
              "القيم الجديدة تعتمد على قراءة مستندات حالية (الأرصدة، المخزون، القيود الفريدة).",
              "تزامن متفائل OCC مع قفل FOR UPDATE بترتيب path ASC وإعادة محاولة تلقائية.",
            ],
            [
              <><code>ifVersion</code> على كتابة مفردة</>,
              "حماية مستند واحد من التعديل المتزامن (Compare-and-Set).",
              "يفشل بخطأ FAILED_PRECONDITION (412) إذا تغيّر الإصدار.",
            ],
          ]}
        />
        <P>
          للمزيد راجع <PageLink slug="field-transforms" lang="ar">تحويلات الحقول</PageLink> و{" "}
          <PageLink slug="realtime" lang="ar">الوقت الفعلي</PageLink> و{" "}
          <PageLink slug="errors-and-limits" lang="ar">الحصص والحدود</PageLink>.
        </P>
      </Section>
    </Doc>
  );
}
