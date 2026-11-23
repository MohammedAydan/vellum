import {
  Api,
  Callout,
  Code,
  CodeTabs,
  Definitions,
  Doc,
  H3,
  P,
  PageLink,
  Section,
  Steps,
  Table,
  UL,
} from "../../ui";

export default function Page() {
  return (
    <Doc
      title="الوقت الفعلي"
      description="بث التغييرات عبر PostgreSQL LISTEN/NOTIFY مع صندوق بريد معاملاتي دائم، وعلامات الاستئناف seqId، وكشف الفجوات عبر اتصال WebSocket واحد."
      eyebrow="المفاهيم الأساسية"
    >
      <Section id="overview" title="نظرة عامة">
        <P>
          يبثّ VELLUM التغييرات الملتزَم بها على المستندات فورياً عبر <code>WebSocket</code> على المسار{" "}
          <code>/v1/realtime</code>. يحمل كل تغيير رقم تسلسل تصاعدياً <code>seqId</code> خاصاً بالمستأجر،
          مما يتيح للعميل عند انقطاع الشبكة إعادة الاتصال واستئناف الأحداث التي فاتته فقط دون فقدان أو
          تكرار.
        </P>
        <P>
          يخضع البث الفوري لنفس قواعد الأمان في مستوى البيانات: يُتحقَّق من مفتاح API وأي رمز{" "}
          <code>EdDSA</code> للمستخدم النهائي ضد مجموعة القواعد النشطة، فلا يمكن لاشتراك حيّ كشف مستند
          يرفضه طلب HTTP عادي. وتُدمج جميع اشتراكات العميل فوق اتصال WebSocket واحد متعدّد القنوات
          (Multiplexed).
        </P>
        <Callout tone="info" title="ماذا ستبني هنا؟">
          ستربط اشتراكاً لمستند واحد واشتراكاً لاستعلام حيّ، وتراقب حالة الاتصال عبر{" "}
          <code>onConnectionStateChange</code>، وتستفيد من الاستئناف التلقائي عبر{" "}
          <code>watermarkSeqId</code> في كل من TypeScript وFlutter.
        </Callout>
      </Section>

      <Section id="architecture" title="كيف يعمل التوصيل بلا Redis؟">
        <P>
          تبقى <strong>PostgreSQL</strong> هي خدمة الحالة الوحيدة في النظام. تأتي الديمومة من جدول{" "}
          <code>realtime_outbox</code> المحمي بـ RLS، بينما يعمل <code>LISTEN/NOTIFY</code> كإشارة إيقاظ
          فورية فقط:
        </P>
        <Steps
          items={[
            {
              title: "الالتزام يكتب صف صندوق البريد",
              body: "تدرج كل عملية إنشاء أو تحديث أو حذف صفّاً في realtime_outbox داخل نفس معاملة PostgreSQL مع رقم seq_id تصاعدي محصور بـ projectId.",
            },
            {
              title: "مُحفّز AFTER INSERT يطلق NOTIFY خفيفاً",
              body: "يحمل الإشعار { seqId, projectId } فقط دون بيانات المستند. يتلقاه عميل PostgreSQL مخصّص (Session-Mode) ويوقظ مستقصي صندوق البريد.",
            },
            {
              title: "المستقصي يجلب الصفوف ويوزّعها",
              body: "يقرأ المستقصي كاشف الفجوات الصفوف الكاملة عبر طبقة التخزين المحصورة بالمستأجر على دفعات من 500 صف ويوزعها عبر محور WebSocket، مع حلقة استقصاء احتياطية كل 1,000 ms تعمل حتى لو غاب LISTEN.",
            },
            {
              title: "منع التكرار عند حدود الاشتراك",
              body: "لأن NOTIFY والاستقصاء الاحتياطي قد يلاحظان نفس الصف، يزيل المحور أي seqId سبق تسليمه لكل اشتراك ليصل كل حدث مرة واحدة وبترتيب تصاعدي دقيق.",
            },
          ]}
        />
        <Definitions
          items={[
            { term: <code>realtime_outbox</code>, def: "سجل دائم للتعديلات الملتزَم بها لكل مستأجر، يُحتفَظ به لمدة 24 ساعة." },
            { term: <code>seqId</code>, def: "رقم تسلسل التغيير داخل المستأجر، متزايد بشكل صارم ولا يتكرر." },
            { term: <code>watermarkSeqId</code>, def: "أعلى رقم تسلسل تلقّاه العميل؛ يُستخدم كنقطة استئناف عند إعادة الاتصال." },
            { term: "كشف الفجوات (Gap Detection)", def: "عند رصد رقم تسلسل أكبر من watermark + 1، يجلب المستقصي الصفوف المفقودة قبل تسليم الأحداث اللاحقة." },
          ]}
        />
        <Callout tone="warning" title="اتصال LISTEN يتطلب وضع الجلسة (Session Mode)">
          نقاط النهاية المجمّعة مثل <code>-pooler</code> في Neon تُسقط اشتراكات <code>LISTEN</code>. وجّه
          المتغير <code>DATA_DATABASE_URL_LISTEN</code> إلى رابط اتصال مباشر بوضع الجلسة؛ وإذا تُرك فارغاً
          يعمل البث الفوري بوضع الاستقصاء الاحتياطي (Polling) تلقائياً بزمن استجابة أعلى قليلاً.
        </Callout>
      </Section>

      <Section id="subscribe" title="الاشتراك من الحزم البرمجية">
        <P>
          تُرسل الحزمة إطار <code>auth</code> أولاً، ثم إطار <code>subscribe</code> لكل هدف (مسار مستند أو
          استعلام، لا كلاهما في إطار واحد). يتحقق الخادم من قاعدة <code>get</code> لمسار المستند ومن قاعدة{" "}
          <code>list</code> للاستعلام.
        </P>
        <Api method="WS" path="/v1/realtime">
          <P>تتشارك جميع اشتراكات العميل اتصال WebSocket واحداً، ويُغلق الاتصال تلقائياً عند إلغاء آخر اشتراك.</P>
        </Api>
        <CodeTabs
          tabs={[
            {
              label: "JavaScript / TypeScript",
              lang: "ts",
              code: `import { createClient } from "@vellum/sdk-js";

const db = createClient({
  endpoint: "https://api.example.com",
  projectId: "<PROJECT_ID>",
  apiKey: "<pk_... or sk_...>",
});

// مراقبة حالة اتصال WebSocket (disconnected | connecting | connected | reconnecting)
const stopConn = db.onConnectionStateChange((state, prev) => {
  console.log(\`Realtime state: \${prev} -> \${state}\`);
});

// اشتراك مستند واحد — تصل التغييرات داخل snapshot.changes
const stopUser = db.collection("users").doc("u_123").onSnapshot(
  (snapshot) => {
    for (const change of snapshot.changes) {
      console.log(change.type, change.seqId, change.doc.path);
    }
  },
  (err) => console.error("Realtime error:", err)
);

// اشتراك استعلام — snapshot.docs تحتوي على المجموعة المحقّقة الحالية
const stopOrders = db
  .collection("orders")
  .where("status", "==", "open")
  .onSnapshot((snapshot) => {
    console.log(snapshot.docs.map((d) => d.id), snapshot.watermarkSeqId);
  });

// عند الانتهاء: إلغاء الاشتراكات وإغلاق الموارد
stopUser();
stopOrders();
stopConn();`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `import 'package:vellum_flutter/vellum_flutter.dart';

final client = VellumClient(
  endpoint: 'https://api.example.com',
  projectId: '<PROJECT_ID>',
  apiKey: '<pk_... or sk_...>',
);

final docSub = client.doc('users/u_123').snapshots().listen((snap) {
  print('version=\${snap.version} status=\${snap.data()?['status']}');
});

final querySub = client
    .collection('orders')
    .where('status', '==', 'open')
    .snapshots()
    .listen((page) {
  print('count=\${page.docs.length} watermark=\${page.watermarkSeqId}');
});

// إلغاء التدفق يلغي الاشتراك تلقائياً
await docSub.cancel();
await querySub.cancel();`,
            },
          ]}
        />
        <P>
          أنواع التغيير هي <code>added</code> و<code>modified</code> و<code>removed</code> (تقابل العمليات
          السلكية <code>create</code> و<code>update</code> و<code>delete</code>). في اشتراكات الاستعلام
          تحتوي <code>docs</code> على مجموعة النتائج الحالية، بينما في اشتراكات المستند المفرد تصل التحديثات
          عبر <code>changes</code>.
        </P>
      </Section>

      <Section id="frames" title="بروتوكول الإطارات السلكي">
        <P>
          إذا اتصلت مباشرة بـ <code>/v1/realtime</code> دون حزمة SDK، فجميع الإطارات كائنات JSON مميّزة
          بالحقل <code>type</code>. يجب إرسال <code>auth</code> كأول إطار خلال 5 ثوانٍ، فيرد الخادم بـ{" "}
          <code>auth_ack</code>، ثم يتلقى كل اشتراك جديد إطار <code>initial_sync</code> متبوعاً بإطارات{" "}
          <code>mutation</code> الحيّة:
        </P>
        <H3 id="client-frames">من العميل إلى الخادم</H3>
        <Table
          head={["type", "الحقول", "الغرض"]}
          rows={[
            [<code>auth</code>, <code>projectId, apiKey, authToken?</code>, "أول إطار إلزامي؛ authToken هو رمز EdDSA للمستخدم النهائي."],
            [<code>subscribe</code>, <code>subId, path? | query?, resumeSeqId?</code>, "الاشتراك في مسار مستند أو كائن QuerySpec (أحدهما فقط)."],
            [<code>unsubscribe</code>, <code>subId</code>, "إيقاف اشتراك محدد."],
            [<code>ping</code>, <code>ts</code>, "نبضة قلب تطبيقية يرد عليها الخادم بـ pong."],
          ]}
        />
        <H3 id="server-frames">من الخادم إلى العميل</H3>
        <Table
          head={["type", "الحقول", "المعنى"]}
          rows={[
            [<code>auth_ack</code>, <code>status: "authenticated", connectionId</code>, "نجاح المصادقة وفتح الجلسة."],
            [<code>initial_sync</code>, <code>subId, seqId, documents</code>, "اللقطة الأولية للمستندات المطابقة مع رقم العلامة المائية."],
            [<code>mutation</code>, <code>subId, seqId, operation, document</code>, "تغيير ملتزَم به يطابق الاشتراك."],
            [<code>resume_complete</code>, <code>subId, seqId (string), count, truncated</code>, "انتهاء إعادة تشغيل الأحداث الفائتة."],
            [<code>error</code>, <code>subId?, code, message</code>, "خطأ في البروتوكول أو الاشتراك."],
            [<code>pong</code>, <code>ts, serverTs</code>, "استجابة لنبضة ping."],
          ]}
        />
        <Code
          lang="json"
          title="تسلسل إطارات قياسي"
          code={`// Client -> Server
{ "type": "auth", "projectId": "prj_...", "apiKey": "pk_...", "authToken": "<EdDSA JWT>" }
{ "type": "subscribe", "subId": "sub_1", "query": { "collectionPath": "orders", "limit": 50 }, "resumeSeqId": 1042 }

// Server -> Client
{ "type": "auth_ack", "status": "authenticated", "connectionId": "conn_..." }
{ "type": "mutation", "subId": "sub_1", "seqId": 1043, "operation": "create", "document": { "path": "orders/o_2", "version": 1, "data": { "status": "open" } } }
{ "type": "resume_complete", "subId": "sub_1", "seqId": "1043", "count": 1, "truncated": false }`}
        />
      </Section>

      <Section id="resume" title="العلامات المائية والاستئناف وكشف الفجوات">
        <UL
          items={[
            <>
              يحتفظ جدول <code>realtime_outbox</code> بالأحداث لمدة <strong>24 ساعة</strong>؛ بعد انقضاء
              هذه النافذة يجب البدء بـ <code>initial_sync</code> جديد.
            </>,
            <>
              يعيد الاستئناف تشغيل ما يصل إلى <strong>5,000 حدث</strong> على دفعات من 500 صف؛ وعند بلوغ
              السقف يصل إطار <code>resume_complete</code> مع <code>truncated: true</code>.
            </>,
            <>
              تُخزَّن الأحداث الحيّة الواردة أثناء إعادة التشغيل مؤقتاً ثم تُفرَّغ بترتيب تصاعدي بعد انتهاء
              الاستئناف دون تداخل.
            </>,
            <>
              تعيد الحزمتان الاتصال تلقائياً بتراجع أُسّي مع تشتيت كامل (Full-Jitter Backoff: في Flutter{" "}
              <code>t0 = 500ms</code> و<code>tMax = 30s</code>) وتعيدان إرسال <code>resumeSeqId</code>{" "}
              الأخير تلقائياً.
            </>,
          ]}
        />
      </Section>

      <Section id="limits" title="الحدود وحالات الفشل المحصّنة">
        <P>
          تُفرض الحدود التالية على مستوى كل اتصال WebSocket حمايةً للذاكرة واستقرار الخادم:
        </P>
        <Table
          head={["القيد", "الحد المحصّن", "الخطأ / السلوك"]}
          rows={[
            ["الاشتراكات لكل اتصال", "25 اشتراكاً", <code>SUBSCRIPTION_LIMIT_EXCEEDED (400) / WS 1008</code>],
            ["حجم الإطار الوارد", "64 KiB (65,536 بايت)", <code>PAYLOAD_TOO_LARGE / WS 1008</code>],
            ["معدل الرسائل لكل اتصال", "60 رسالة / دقيقة", <code>WS_POLICY_VIOLATION (close 1008)</code>],
            ["المخزن المؤقت الصادر لكل اتصال", "1 MiB", <code>SLOW_CONSUMER_DISCONNECT (429)</code>],
            ["مهلة إطار المصادقة auth", "5,000 ms", <code>UNAUTHENTICATED, close 1008</code>],
            ["الاتصالات المتزامنة لكل IP", "50 اتصالاً", <code>429 Too Many Requests</code>],
            ["الاستئناف الأقصى للطلب الواحد", "5,000 حدث", <code>resume_complete.truncated = true</code>],
            ["مدة الاحتفاظ بصندوق البريد", "24 ساعة", "لا يمكن الاستئناف لما قبل 24 ساعة"],
          ]}
        />
        <P>
          للمرجع الكامل للإطارات راجع{" "}
          <PageLink slug="reference/realtime-protocol" lang="ar">بروتوكول WebSocket للوقت الفعلي</PageLink>،
          وللتفاصيل الأمنية راجع{" "}
          <PageLink slug="security-and-defense" lang="ar">الأمان والدفاع المتعدد الطبقات</PageLink>.
        </P>
      </Section>

      <Section id="opt-in-includes" title="الإلحاق الاختياري للعلاقات">
        <P>
          يمكن للاشتراكات أن تطلب من الخادم حلّ العلاقات <strong>في نقطة زمنية</strong> على كل مستند
          مُصدر: أرسل <code>resolveIncludes: true</code> مع قائمة <code>include</code> (في المستوى
          الأعلى، أو تحت <code>query.include</code> لاشتراكات الاستعلام). تهبط الحمولات المحلولة في{" "}
          <code>snapshot.doc.included</code>، وتظهر الأهداف المخفاة بقواعد الأمان في{" "}
          <code>redactedRefs</code>. هذه لقطات وقت الحدث، وليست ربطًا حيًا — فأي كتابة لاحقة في المستند
          المُشار إليه لا تُعيد إصدار الأصل.
        </P>
        <UL
          items={[
            <>بحد أقصى <strong>10 مواصفات</strong> لكل اشتراك، وبعمق <strong>1</strong> فقط — تُرفض العلاقات المتداخلة بخطأ <code>INVALID_ARGUMENT</code>.</>,
            <>بحد أقصى <strong>1000 مسار هدف فريد</strong> و<strong>1 MiB</strong> من بيانات الأهداف لكل حدث (<code>RESPONSE_TOO_LARGE</code>).</>,
            <>جلب دفعي واحد على مستوى المستأجر يجمع اتحاد المراجع لكل مشتركي الحدث — وليس استعلامًا لكل مشترك.</>,
            <>يُعاد تخويل كل هدف محلول لكل مشترك؛ الأهداف المرفوضة تُحجب ولا تُسرَّب.</>,
          ]}
        />
        <CodeTabs
          tabs={[
            {
              label: "TypeScript",
              lang: "ts",
              code: `const off = db.doc("orders/ord_1").onSnapshot(
  (snap) => console.log(snap.doc.included, snap.doc.redactedRefs),
  (err) => console.error(err),
  { resolveIncludes: true, include: ["customer", { field: "items", select: ["sku"] }] }
);`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `final sub = db.collection('orders').doc('ord_1').snapshots(
  resolveIncludes: true,
  include: ['customer', const VellumInclude(field: 'items', select: ['sku'])],
).listen((snap) {
  print(snap.included);      // الحمولات المحلولة
  print(snap.redactedRefs);  // الأهداف المخفاة بقواعد الأمان
});`,
            },
          ]}
        />
      </Section>
    </Doc>
  );
}
