import {
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

export default function Page() {
  return (
    <Doc
      title="CRUD ومسارات المستندات"
      description="المسارات القياسية، ومراجع المستندات والمجموعات، وعمليات create وset وupdate وdelete، والشرط المسبق ifVersion، وتنسيق الأسلاك الموسوم."
      eyebrow="المفاهيم الأساسية"
    >
      <Section id="path-rules" title="قواعد المسارات">
        <P>
          كل مورد في مستوى البيانات يُعنون بمسار قياسي UTF-8 مفصول بـ <code>/</code>. تتناوب المسارات بين مقاطع
          المجموعات ومقاطع معرّفات المستندات، ويُشتقّ من هذا التناوب معنى كل مقطع: فالمقطع في موضع زوجي مجموعة،
          والمقطع في موضع فردي معرّف مستند.
        </P>
        <Table
          head={["النوع", "عدد المقاطع", "أمثلة"]}
          rows={[
            ["مستند", "زوجي، من 2 إلى 10", <><code>users/u_123</code>، <code>users/u_123/orders/ord_456</code></>],
            ["مجموعة", "فردي، من 1 إلى 9", <><code>users</code>، <code>users/u_123/orders</code></>],
          ]}
        />
        <P>
          يسمح مسار بعمق 10 بخمس مجموعات متداخلة. وبتحليل المسار <code>users/u_123/orders/ord_456</code> نحصل على
          العناصر القياسية التالية التي تُرسل مع كل مستند:
        </P>
        <Table
          head={["العنصر", "القيمة"]}
          rows={[
            [<code>path</code>, <code>users/u_123/orders/ord_456</code>],
            [<code>collectionPath</code>, <code>users/u_123/orders</code>],
            [<code>collectionGroup</code>, <code>orders</code>],
            [<code>documentId</code>, <code>ord_456</code>],
            [<code>pathDepth</code>, <code>4</code>],
          ]}
        />
        <P>
          يفرض <code>@vellum/core</code> حدودًا صارمة على المسارات والبيانات معًا. أي تجاوز يُرفض قبل تنفيذ أي استعلام:
        </P>
        <Table
          head={["الحد", "القيمة المسموحة", "رمز الخطأ"]}
          rows={[
            ["عمق المسار", "مستند: 2–10 مقاطع · مجموعة: 1–9 مقاطع", <code>INVALID_DOCUMENT_PATH</code>],
            ["طول المقطع", "1,500 بايت كحد أقصى (UTF-8)", <code>INVALID_DOCUMENT_PATH</code>],
            [<>الأحرف الممنوعة: <code>/</code> وبايت NUL و<code>0x00</code>–<code>0x1F</code> و<code>.</code> و<code>..</code></>, <code>INVALID_DOCUMENT_PATH</code>],
            ["المقاطع المحجوزة", <>أي مقطع يطابق <code>^__.*__$</code> مثل <code>__name__</code></>, <code>INVALID_DOCUMENT_PATH</code>],
            ["عمق تداخل البيانات", "20 مستوى", <code>MAX_NESTING_EXCEEDED</code>],
            ["طول اسم الحقل", "256 حرفًا", <code>INVALID_FIELD_NAME</code>],
            ["حجم المستند المتسلسل", "1 MiB (1,048,576 بايت)", <code>DOCUMENT_TOO_LARGE</code>],
          ]}
        />
        <Callout tone="warning" title="تنبيه">
          تجاوز حد العمق يُثير <code>INVALID_DOCUMENT_PATH</code> (400). المقاطع الطويلة جدًا أو المحجوزة تُنتج الرمز
          نفسه. الأسماء مثل <code>__name__</code> محفوظة لبيانات المحرك الوصفية ولا يجوز استخدامها في مسارات المستخدمين.
        </Callout>
      </Section>

      <Section id="references" title="مراجع المستندات والمجموعات">
        <P>
          المراجع أدوات بناء غير قابلة للتعديل؛ استدعاء طريقة على مرجع يُرجع قيمة جديدة بالحالة المحدّثة. تُنشأ المراجع
          دائمًا من عميل مُهيّأ بمعرّف المشروع ومفتاح API، لذا لا حاجة لتمرير سياق المستأجر في كل عملية.
        </P>
        <CodeTabs
          tabs={[
            {
              label: "JS / TypeScript",
              lang: "ts",
              code: `import { createClient } from "@vellumdb/sdk-js";

const db = createClient({
  projectId: "<YOUR_PROJECT_ID>",
  apiKey: "<YOUR_API_KEY>",
});

// مرجع مستند (عدد زوجي من المقاطع).
const user = db.collection("users").doc("u_123");

// مرجع مجموعة (عدد فردي من المقاطع)، ثم مستند بداخلها.
const orders = db.collection("users/u_123/orders");
const order = orders.doc("ord_456");

// مجموعة فرعية أخرى أسفل المستند نفسه.
const events = db.collection("users/u_123/events");`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `import 'package:vellum_flutter/vellum_flutter.dart';

final client = VellumClient(
  endpoint: 'http://127.0.0.1:8080',
  projectId: '<YOUR_PROJECT_ID>',
  apiKey: '<YOUR_API_KEY>',
);

final user = client.collection('users').doc('u_123');
final orders = client.collection('users/u_123/orders');
final events = client.collection('users/u_123/events');`,
            },
          ]}
        />
        <P>
          كل عملية بيانات محصورة داخل النطاق <code>projectId</code>. تربط طبقة التخزين هذا السياق داخل
          كل معاملة عبر <code>SET LOCAL app.current_project_id</code> و<code>SET LOCAL app.current_project_id</code>
          و<code>SET LOCAL statement_timeout = '5000ms'</code>؛ وبذلك تفشل سياسات أمان مستوى الصفوف (RLS) بإغلاق إذا
          حُذف السياق.
        </P>
      </Section>

      <Section id="write-operations" title="create وset وupdate وdelete">
        <P>
          تُنشأ المستندات وتُعدَّل بأربع عمليات واضحة: <code>create</code> للإنشاء الصريح، و<code>set</code> للاستبدال
          أو الدمج العميق، و<code>update</code> لتعديل حقول بعينها، و<code>delete</code> للحذف الناعم. يُرجع
          <code>create</code> و<code>set</code> المستند المخزّن كاملًا، بينما يطبّق <code>update</code> المفاتيح المقدّمة
          فقط ويترك الباقي دون تغيير.
        </P>
        <CodeTabs
          tabs={[
            {
              label: "JS / TypeScript",
              lang: "ts",
              code: `import { fieldOp } from "@vellumdb/sdk-js";

// create — يفشل بـ ALREADY_EXISTS إذا كان المسار مشغولًا.
await user.create({ name: "Ada", role: "admin" });

// set — استبدال كامل افتراضيًا، أو دمج عميق مع merge: true.
await user.set({ name: "Ada Lovelace" }, { merge: true });

// update — تعديل الحقول المقدّمة فقط؛ ويدعم تحويلات الحقول.
await user.update({ lastSeenAt: fieldOp.serverTimestamp() });

// delete — حذف ناعم (شاهد قبر + حدث في realtime_outbox).
await user.delete();

// القراءة تُرجع المستند مع بياناته الوصفية التي يديرها الخادم.
const snap = await user.get();
console.log(snap.path, snap.version, snap.exists, snap.data());`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `// create — يفشل بـ ALREADY_EXISTS إن كان المسار مشغولًا.
await client.request('POST', '/documents/users/u_123', body: {
  'data': {'name': 'Ada', 'role': 'admin'},
});

// set — دمج عميق أو استبدال كامل.
await client.setDoc('users/u_123', {'name': 'Ada Lovelace'}, merge: true);
await client.setDoc('users/u_123', {'name': 'Ada L.'}, merge: false);

// update — تعديل جزئي مع تحويل ذري.
await client.updateDoc('users/u_123', {
  'lastSeenAt': FieldOp.serverTimestamp(),
});

final snap = await client.getDoc('users/u_123');
print(snap.path + ' · version=' + snap.version.toString());
await client.deleteDoc('users/u_123');`,
            },
          ]}
        />
        <P>
          تعكس الطبقة HTTP هذه العمليات مباشرةً؛ ويمكن استخدامها من أي لغة تدعم POST وPUT وPATCH وDELETE:
        </P>
        <Table
          head={["الطريقة", "العملية", "دلالة النجاح"]}
          rows={[
            [<code>POST</code>, "إنشاء مستند", <><code>201</code> والمستند المُنشأ؛ يفشل بـ <code>ALREADY_EXISTS</code> إن وُجد</>],
            [<code>PUT</code>, <><code>set</code> مع <code>merge</code> اختياري</>, <><code>200</code> والمستند المحفوظ</>],
            [<code>PATCH</code>, <><code>update</code> وتحويلات <code>$op</code></>, <><code>200</code> والمستند المُحدَّث</>],
            [<code>DELETE</code>, "حذف ناعم", <><code>200</code> ونتيجة الحذف</>],
          ]}
        />
        <Callout tone="info" title="الحذف ناعم دائمًا">
          لا يُزيل <code>delete</code> الصف من قاعدة البيانات فورًا، بل يكتب علامة حذف (tombstone) وحدثًا في
          <code>realtime_outbox</code>. تتولى عامل الاحتفاظ تنظيف الصفوف القديمة لاحقًا. لا تفترض أن قراءة مباشرة بعد
          الحذف ستُرجع <code>NOT_FOUND</code> لأسباب تتعلق بزمن الانتشار.
        </Callout>
      </Section>

      <Section id="optimistic-concurrency" title="التحكم المتفائل في التزامن بـ ifVersion">
        <P>
          لكل مستند <code>version</code> تتزايد رتيبيًا مع كل كتابة. مرّر الإصدار المتوقع كشرط مسبق لرفض الكتابة إذا
          سبق كاتب آخر وغيّر المستند. يُرجع فشل الشرط المسبق <code>FAILED_PRECONDITION</code> (412) مع
          <code>expectedVersion</code> و<code>actualVersion</code> في تفاصيل الخطأ.
        </P>
        <CodeTabs
          tabs={[
            {
              label: "JS / TypeScript",
              lang: "ts",
              code: `const snap = await user.get();

if (snap.version !== expected) {
  // عالج التعارض قبل إرسال الكتابة.
}

await user.update(
  { status: "approved" },
  { ifVersion: snap.version }
);
// إن رفع كاتب آخر الإصدار: FAILED_PRECONDITION (412).`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `final snap = await client.getDoc('users/u_123');

await client.collection('users').doc('u_123').update(
  {'status': 'approved'},
  ifVersion: snap.version,
);
// إن رفع كاتب آخر الإصدار: FAILED_PRECONDITION (412).`,
            },
            {
              label: "REST",
              lang: "http",
              code: `PATCH /v1/projects/<PROJECT_ID>/documents/users/u_123
x-vellum-api-key: <YOUR_API_KEY>
content-type: application/json

{ "data": { "status": "approved" }, "ifVersion": 4 }

# عند عدم التطابق: 412 FAILED_PRECONDITION`,
            },
          ]}
        />
        <P>
          يقبل كل من <code>set</code> و<code>delete</code> الخيار نفسه. أما الذرية عبر مستندات متعددة مع شروط مسبقة
          فتتحقق عبر <PageLink slug="batch-and-transactions" lang="ar">الكتابات الدفعية والمعاملات</PageLink>، لا عبر
          شرط مسبق منفرد لكل مستند.
        </P>
      </Section>

      <Section id="tagged-wire-format" title="أساسيات تنسيق الأسلاك الموسوم">
        <P>
          تُخزَّن أنواع JSON الأصلية (<code>null</code> و<code>boolean</code> و<code>string</code> و<code>number</code>
          المنتهي و<code>array</code>) مباشرةً حتى تتمكن فهارس <code>jsonb_path_ops</code> في PostgreSQL من استخدامها
          بلا حمل إضافي. أمّا الأنواع الموسّعة فتستخدم المفتاحين المحجوزين <code>$t</code> (الوسم) و<code>$v</code>
          (القيمة):
        </P>
        <Table
          head={["النوع المنطقي", "التمثيل على الأسلاك"]}
          rows={[
            [<code>int64</code>, <code>{'{"$t": "int", "$v": "-9007199254740993"}'}</code>],
            [<code>timestamp</code>, <code>{'{"$t": "ts", "$v": "2026-11-15T14:30:00.123Z", "$ms": 1794753000123}'}</code>],
            [<code>reference</code>, <code>{'{"$t": "ref", "$v": "users/u_123"}'}</code>],
            [<code>bytes</code>, <><code>{'{"$t": "bytes", "$v": "SGVsbG8="}'}</code> (Base64)</>],
            [<code>geopoint</code>, <code>{'{"$t": "geo", "$v": {"lat": 30.0444, "lng": 31.2357}}'}</code>],
            [<>خريطة مستخدم تحتوي <code>$t</code></>, <><code>{'{"$t": "map", "$v": {"$t": "user_custom"}}'}</code> (هروب تلقائي بلا فقدان)</>],
          ]}
        />
        <UL
          items={[
            <>يجب أن تكون الأرقام منتهية؛ يُرفض <code>NaN</code> و<code>Infinity</code> بـ <code>INVALID_ARGUMENT</code>.</>,
            <>الحد الأقصى لتداخل الكائنات والمصفوفات 20 مستوى (<code>MAX_NESTING_EXCEEDED</code>).</>,
            <>أسماء الحقول حتى 256 حرفًا ولا تحتوي أحرف تحكم (<code>INVALID_FIELD_NAME</code>).</>,
            <>لا يتجاوز المستند المتسلسل 1 MiB (<code>DOCUMENT_TOO_LARGE</code>).</>,
          ]}
        />
        <Callout tone="success" title="المراجع سلاسل مسارات">
          يجب أن تكون المراجع (<code>$t: "ref"</code>) مسارات قياسية صالحة داخل المشروع نفسه. هي سلاسل
          مسارات عادية على مستوى الأسلاك؛ لا يجلب لك VELLUM المستند الهدف تلقائيًا، بل تقوم أنت بقراءته عند الحاجة.
        </Callout>
      </Section>

      <Section id="pitfalls-and-next" title="الأخطاء الشائعة وما تقرأه بعد ذلك">
        <UL
          items={[
            <> <strong>الخلط بين مسار المستند ومسار المجموعة:</strong> مسار المستند عدد مقاطعه زوجي، ومسار المجموعة فردي.</>,
            <> <strong>توقّع أن <code>create</code> متكرر النتيجة:</strong> يفشل بـ <code>ALREADY_EXISTS</code>؛ استخدم <code>set</code> عند الرغبة بالاستبدال.</>,
            <> <strong>افتراض أن التحويلات تُقيَّم في المتصفح:</strong> تُحسب في الخادم وقت الإتمام؛ راجع <PageLink slug="field-transforms" lang="ar">تحويلات الحقول</PageLink>.</>,
            <> <strong>تجاهل الفهرس المطلوب عند الاستعلام:</strong> ابدأ بصفحة <PageLink slug="query" lang="ar">الاستعلام</PageLink> لفهم متطلبات الفهرسة.</>,
          ]}
        />
        <Code
          lang="json"
          title="شكل المستند المُعاد"
          code={`{
  "path": "users/u_123",
  "collectionPath": "users",
  "collectionGroup": "users",
  "documentId": "u_123",
  "data": { "name": "Ada", "age": 36 },
  "sizeBytes": 128,
  "version": 3,
  "createdAt": "2026-11-15T14:30:00.123Z",
  "updatedAt": "2026-11-17T09:00:00.000Z"
}`}
        />
      </Section>
    </Doc>
  );
}
