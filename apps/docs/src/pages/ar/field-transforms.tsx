import {
  Callout,
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
      title="تحويلات الحقول"
      description="كل رموز fieldOp الذرية، وطريقة تطبيقها وترتيبها وقيودها، مع تمثيلها على مستوى الأسلاك بصيغة $op."
      eyebrow="المفاهيم الأساسية"
    >
      <Section id="overview" title="نظرة عامة">
        <P>
          تسمح تحويلات الحقول للخادم بحساب قيمة حقل ذريًا، مما يتجنّب حالة تسابق القراءة-التعديل-الكتابة. يعرض SDK
          خمس مساعدات تحت <code>fieldOp</code>؛ وتتحول كل منها على مستوى الأسلاك إلى كائن رمزي بمفتاح <code>$op</code>
          يُطبَّق داخل معاملة قاعدة البيانات نفسها.
        </P>
        <CodeTabs
          tabs={[
            {
              label: "JS / TypeScript",
              lang: "ts",
              code: `import { fieldOp } from "@vellum/sdk-js";`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `import 'package:vellum_flutter/vellum_flutter.dart';

// FieldOp وFieldValue يُنتجان رموز $op؛ وVellumWire يُنتج قيم $t الموسومة.`,
            },
          ]}
        />
        <P>
          <strong>السيناريو:</strong> يمكن لعدة مستخدمين &laquo;الإعجاب&raquo; بمنشور في الوقت نفسه، وتريد عدّاد
          <code>likeCount</code> دقيقًا دون تنسيق بين العملاء. تستخدم <code>increment(1)</code> لزيادة العدّاد ذريًا
          و<code>arrayUnion</code> لتسجيل معرّفات المستخدمين الفريدين؛ يطبّق الخادم كلتيهما في معاملة واحدة، فلا تُفقد
          أي تحديثة.
        </P>
      </Section>

      <Section id="five-operations" title="العمليات الخمس">
        <P>
          الجدول التالي هو المرجع الكامل لتحويلات الحقول الخمسة: مساعد SDK، والرمز الذي يُرسل على الأسلاك، والسلوك،
          ورمز الخطأ عند تمرير معامل غير صالح.
        </P>
        <Table
          head={["مساعد SDK", "الرمز على الأسلاك", "السلوك", "خطأ الإدخال غير الصالح"]}
          rows={[
            [
              <code>fieldOp.serverTimestamp()</code>,
              <code>{"{ \"$op\": \"serverTimestamp\" }"}</code>,
              <>يُستبدل بطابع الوقت UTC للمعاملة بصيغة <code>{"{ \"$t\": \"ts\", \"$v\": \"...\", \"$ms\": ... }"}</code>.</>,
              "—",
            ],
            [
              <code>fieldOp.increment(n = 1)</code>,
              <code>{"{ \"$op\": \"inc\", \"by\": n }"}</code>,
              <>يضيف <code>n</code> إلى القيمة الحالية. والحقل الغائب يُهيّأ بقيمة <code>n</code>.</>,
              <><code>INVALID_ARGUMENT</code>؛ و<code>FAILED_PRECONDITION</code> (412) إن كان الحقل غير رقمي</>,
            ],
            [
              <code>fieldOp.arrayUnion(...items)</code>,
              <code>{"{ \"$op\": \"arrayUnion\", \"elements\": [...] }"}</code>,
              <>يُلحق العناصر غير الموجودة أصلًا (مساواة عميقة بقيم الأسلاك).</>,
              <><code>INVALID_ARGUMENT</code> إن كان <code>elements</code> مفقودًا</>,
            ],
            [
              <code>fieldOp.arrayRemove(...items)</code>,
              <code>{"{ \"$op\": \"arrayRemove\", \"elements\": [...] }"}</code>,
              <>يزيل كل تكرار يطابق أي عنصر من العناصر المقدّمة.</>,
              <><code>INVALID_ARGUMENT</code> إن كان <code>elements</code> مفقودًا</>,
            ],
            [
              <code>fieldOp.deleteField()</code>,
              <code>{"{ \"$op\": \"deleteField\" }"}</code>,
              <>يزيل الحقل من خريطته الأصلية.</>,
              "—",
            ],
          ]}
        />
        <CodeTabs
          tabs={[
            {
              label: "JS / TypeScript",
              lang: "ts",
              code: `import { createClient, fieldOp } from "@vellum/sdk-js";

const db = createClient({
  projectId: "<YOUR_PROJECT_ID>",
  apiKey: "<YOUR_API_KEY>",
});

await db.collection("users").doc("u_123").set(
  {
    loginCount: fieldOp.increment(1),
    roles: fieldOp.arrayUnion(["developer", "architect"]),
    tags: fieldOp.arrayRemove(["trial"]),
    lastLoginAt: fieldOp.serverTimestamp(),
    legacyFlag: fieldOp.deleteField(),
  },
  { merge: true }
);

// عدّادان مستقلان في كتابة واحدة.
await db.collection("stats").doc("global").update({
  posts: fieldOp.increment(1),
  lastPostAt: fieldOp.serverTimestamp(),
});`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `await client.setDoc('users/u_123', {
  'loginCount': FieldOp.increment(1),
  'roles': FieldOp.arrayUnion(['developer', 'architect']),
  'tags': FieldOp.arrayRemove(['trial']),
  'lastLoginAt': FieldOp.serverTimestamp(),
  'legacyFlag': FieldOp.deleteField(),
}, merge: true);`,
            },
            {
              label: "Wire JSON",
              lang: "json",
              title: "ما يُرسل فعليًا",
              code: `{
  "loginCount": { "$op": "inc", "by": 1 },
  "roles": { "$op": "arrayUnion", "elements": ["developer", "architect"] },
  "tags": { "$op": "arrayRemove", "elements": ["trial"] },
  "lastLoginAt": { "$op": "serverTimestamp" },
  "legacyFlag": { "$op": "deleteField" }
}`,
            },
          ]}
        />
        <P>
          يقبل <code>arrayUnion</code> و<code>arrayRemove</code> وسائط متغيرة أو مصفوفة واحدة؛ أي أن
          <code>fieldOp.arrayUnion(["a", "b"])</code> و<code>fieldOp.arrayUnion("a", "b")</code> متكافئان. وعلى مستوى
          الأسلاك تقبل الزيادة أيضًا الاسم المستعار <code>$op: "increment"</code> مع <code>$v</code> أو
          <code>value</code>، غير أن مساعد SDK القياسي يُصدر <code>inc</code> مع <code>by</code>.
        </P>
        <Callout tone="info" title="لماذا تُرسل الرموز بدلًا من الحساب في العميل؟">
          الرموز تُقيَّم في الخادم وقت الإتمام مقابل القيمة المخزّنة الحالية. لذلك لا يُفقد أي تحديث حتى لو زاد عميلان
          العدّاد نفسه في اللحظة ذاتها — بخلاف نمط القراءة ثم التعديل ثم الكتابة في العميل.
        </Callout>
      </Section>

      <Section id="where-allowed" title="أين تُسمح التحويلات">
        <P>
          التحويلات مقبولة فقط في مسارات الكتابة التي يتحقق فيها المحرك من البيانات مع تفعيل عمليات الحقول:
        </P>
        <UL
          items={[
            <><code>DocumentReference.set</code> مع <code>{"{ merge: true }"}</code></>,
            <><code>DocumentReference.update</code> (أو HTTP <code>PATCH</code>)</>,
            <>تعديلات <code>batchWrite</code></>,
            <>إتمام المعاملات (<code>tx.set</code> / <code>tx.update</code>) عبر <PageLink slug="batch-and-transactions" lang="ar">الكتابات الدفعية والمعاملات</PageLink></>,
          ]}
        />
        <Callout tone="danger" title="مكانان ممنوعان تمامًا">
          التحويلات <strong>غير</strong> صالحة في حمولات <code>create</code> ولا في قيم الاستعلامات. ظهور رمز
          <code>$op</code> في هذين الموضعين يُثير <code>INVALID_ARGUMENT</code> (400). كذلك فإن أي قيمة
          <code>$op</code> غير معروفة تُرفض بالرمز نفسه.
        </Callout>
      </Section>

      <Section id="atomicity-and-order" title="الذرية والترتيب">
        <UL
          items={[
            <>تُطبَّق جميع التحويلات في كتابة واحدة داخل معاملة قاعدة البيانات نفسها، باستخدام طابع زمني مشترك للمعاملة لـ <code>serverTimestamp</code>.</>,
            <>يُمرَّر التصحيح بترتيب إدراج مفاتيح الكائن. تُدمج الكائنات العادية المتداخلة بشكل متكرر، لذا يمكن أن يوجد تحويل على أي عمق.</>,
            <>يستخدم <code>arrayUnion</code> و<code>arrayRemove</code> مساواة قيم الأسلاك، لذا تُقارن القيم الموسومة (الطوابع الزمنية والمراجع وint64) بالنوع والقيمة لا بهوية JavaScript.</>,
            <>بالنسبة إلى <code>increment</code>، إن كانت القيمة الحالية int64 موسومًا (<code>{"$t: \"int\""}</code>) يحسب الخادم باستخدام <code>BigInt</code> ويخزّن نتيجة int64 موسومة؛ وإلا يستخدم جمع IEEE-754.</>,
          ]}
        />
      </Section>

      <Section id="restrictions" title="القيود وأوضاع الفشل">
        <Table
          head={["الحالة", "النتيجة"]}
          rows={[
            [
              <>زيادة حقل قيمته الحالية ليست رقمية (وليست int64 موسومًا)</>,
              <><code>FAILED_PRECONDITION</code> (412)</>,
            ],
            [
              <>اسم حقل <code>__proto__</code> أو <code>constructor</code> أو <code>prototype</code> عند أي مستوى دمج</>,
              <><code>INVALID_FIELD_NAME</code> (400) لمنع تلوث النموذج الأولي</>,
            ],
            [
              <>قيمة <code>by</code> غير منتهية أو <code>elements</code> ليس مصفوفة</>,
              <><code>INVALID_ARGUMENT</code> (400)</>,
            ],
            [
              <>قيمة <code>$op</code> غير معروفة أو ظهورها حيث لا تُسمح</>,
              <><code>INVALID_ARGUMENT</code> (400)</>,
            ],
            [
              <>تجاوز عمق 20 أو طول اسم 256 أو حجم 1 MiB بعد التحويل</>,
              <><code>MAX_NESTING_EXCEEDED</code> / <code>INVALID_FIELD_NAME</code> / <code>DOCUMENT_TOO_LARGE</code></>,
            ],
          ]}
        />
        <Callout tone="warning" title="لا تخلط التحويل مع ifVersion">
          لا تربط تحويلًا بشرط مسبق يعتمد على قيمة الحقل <em>بعد</em> التحويل. يقارن <code>ifVersion</code> إصدار
          المستند <em>قبل</em> الكتابة؛ ولا يتحقق من النتيجة المحسوبة. إن احتجت شروطًا مسبقة عبر مستندات متعددة،
          فاستخدم معاملة.
        </Callout>
      </Section>

      <Section id="pitfalls-and-next" title="الأخطاء الشائعة وما تقرأه بعد ذلك">
        <UL
          items={[
            <> <strong>استخدام تحويل في <code>create</code> أو قيمة استعلام:</strong> هذه المسارات ترفض رموز <code>$op</code> بـ <code>INVALID_ARGUMENT</code>.</>,
            <> <strong>زيادة حقل غير رقمي:</strong> يجب أن تُهيّأ الكتابة الأولى الحقل برقم أو بـ int64 موسوم.</>,
            <> <strong>افتراض القراءة بعد الكتابة داخل التحويل:</strong> تُحسب التحويلات وقت الإتمام مقابل القيمة المخزّنة الحالية.</>,
            <> <strong>نسيان تمثيل الأسلاك:</strong> راجع <PageLink slug="reference/wire-format" lang="ar">تنسيق الإرسال والمسارات</PageLink> لفهم الفرق بين <code>$t</code> و<code>$op</code>.</>,
          ]}
        />
      </Section>
    </Doc>
  );
}
