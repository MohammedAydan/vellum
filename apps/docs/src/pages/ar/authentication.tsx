import {
  Callout,
  Code,
  CodeTabs,
  Doc,
  H3,
  OL,
  P,
  PageLink,
  Section,
  Table,
  UL,
} from "../../ui";

export default function Page() {
  return (
    <Doc
      title="المصادقة"
      description="مفاتيح API، ورموز المستخدمين النهائيين، وتدوير المفاتيح، وأقل قدر من الامتيازات."
      eyebrow="البداية"
    >
      <Section id="overview" title="نظرة عامة">
        <P>
          في VELLUM <strong>بيانات اعتماد معزولة تماماً لكل سطح</strong>: تتشارك
          الأسطح في primitives التشفير عديمة الحالة فقط؛ أمّا التخزين، وأسرار
          التوقيع، وقيم <code>typ</code>/<code>iss</code>/<code>aud</code> في
          JWT، والClaims، والبرمجيات الوسيطة فهي منفصلة تماماً — أي رمز صادر عن
          سطح يُرفض في غيره.
        </P>
        <P>
          <strong>مستوى المستندات</strong> (<code>/v1/projects/...</code>)
          يستخدم مفاتيح API عبر <code>x-vellum-api-key</code> (والاسم القديم{" "}
          <code>x-project-key</code>)، مع حامل اختياري للمستخدم النهائي
          <strong> بتوقيع <code>EdDSA</code> فقط</strong>. لا يوجد بديل
          <code>HS256</code>، ولا مسار مجهول، ولا مفتاح رئيسي ضمني.
        </P>
        <Table
          head={["المجال", "المسار", "ملف تعريف الارتباط", "الخوارزمية", "typ في الرمز"]}
          rows={[
            [
              <code>PROJECT_END_USER</code>,
              <code>/v1/projects/:p/auth</code>,
              "رمز مخصّص بالمشروع",
              <strong>EdDSA</strong>,
              <code>vellum+enduser+jwt</code>,
            ],
          ]}
        />
        <Callout tone="info" title="المفتاح العام لا يمنح وصولاً">
          يمكن أن يظهر مفتاح API عام بأمان في متصفح أو تطبيق جوال، لكنه يمنح{" "}
          <strong>صفر وصول ضمني للبيانات</strong>. تُقيَّم كل عملية مقابل مجموعة
          قواعد الأمان الفعّالة في المشروع. أمّا مفتاح الخادم فلا يتجاوز القواعد
          إلا للنطاقات المحددة التي يحملها صراحةً.
        </Callout>
      </Section>

      <Section id="scenario" title="سيناريو">
        <P>
          تضيف ميزة يسجّل فيها المستخدمون الدخول إلى تطبيقك، ويقرأ العميل
          مستنداته الخاصة فقط. تُصدر مفتاحاً عاماً <code>pk_</code> للمتصفح،
          وتُرفق JWT المستخدم المسجّل بكل طلب، وتعتمد على قواعد الأمان لفرض
          الملكية — مع إبقاء المفتاح الرئيسي <code>sk_</code> على خادمك وحده.
        </P>
        <Code
          lang="bash"
          code={`# كل استدعاء لمستوى البيانات يقدّم المفتاح في ترويسة، لا في الرابط.
curl "https://api.example.com/v1/projects/<PROJECT_ID>/documents/users/u_123" \\
  -H "x-vellum-api-key: <YOUR_PUBLIC_KEY>" \\
  -H "Authorization: Bearer <END_USER_JWT>"`}
        />
        <P>
          يمكن كذلك تمرير حامل المستخدم النهائي في الترويسة{" "}
          <code>x-vellum-user-token</code> بدلاً من <code>authorization</code>.
        </P>
      </Section>

      <Section id="api-keys" title="مفاتيح API (pk_ / sk_)">
        <P>
          تُولَّد المفاتيح بالشكل <code>&lt;prefix&gt;_&lt;random&gt;</code>
          :
        </P>
        <Table
          head={["البادئة", "النوع", "الطول"]}
          rows={[
            [<code>pk_</code>, "عام", "32 حرف base62"],
            [<code>sk_</code>, "خادم", "48 حرف base62"],
          ]}
        />
        <P>
          أمثلة على <strong>الشكل فقط</strong> (ليست قيماً صالحة):{" "}
          <code>pk_...</code> و<code>sk_...</code>. تُحفظ بادئة من 16
          حرفاً وتجزئة واحدة فقط، حيث تكون التجزئة{" "}
          <code>SHA256(fullKey + ":" + API_KEY_PEPPER)</code> وتُقارَن بزمن
          ثابت. لا يُعاد المفتاح الصريح إلا مرة واحدة عند إنشائه. تُخزَّن
          المفاتيح المتحقَّق منها في الذاكرة 30 ثانية؛ ويُنشر الإشعار{" "}
          <code>NOTIFY vellum_cache_invalidate</code> عند الإلغاء أو التدوير
          لتُسقط بقية النسخ مداخلها المخزَّنة.
        </P>

        <H3 id="scopes">النطاقات (Scopes)</H3>
        <P>يحمل مفتاح الخادم نطاقات صريحة. النطاق المطلوب لكل عملية:</P>
        <Table
          head={["العملية", "النطاق المطلوب"]}
          rows={[
            [<><code>get</code> / <code>list</code> / <code>query</code></>, <code>documents:read</code>],
            [
              <><code>create</code> / <code>set</code> / <code>update</code> / <code>delete</code> / <code>batchWrite</code> / المعاملات</>,
              <code>documents:write</code>,
            ],
            ["إدارة الفهارس", <code>indexes:manage</code>],
          ]}
        />
        <P>
          النطاق <code>*</code> يمنح كل شيء. لا يمكن للمفتاح العام إدارة
          الفهارس المركّبة. غياب النطاق يُنتج <code>PERMISSION_DENIED</code>{" "}
          (403)، وغياب المفتاح أو بطلانه يُنتج <code>UNAUTHENTICATED</code>{" "}
          (401).
        </P>
        <CodeTabs
          tabs={[
            {
              label: "TypeScript",
              lang: "ts",
              code: `import { createClient } from "@vellumdb/sdk-js";

const db = createClient({
  endpoint: "https://api.example.com",
  projectId: "<YOUR_PROJECT_ID>",
  apiKey: "<YOUR_API_KEY>", // يُرسَل في x-vellum-api-key
  // Optional: getAuthToken: async () => yourCurrentUserJwt(), // رمز مستخدم نهائي اختياري لـ auth.uid
});`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `import 'package:vellum_flutter/vellum_flutter.dart';

final client = VellumClient(
  endpoint: 'https://api.example.com',
  projectId: '<YOUR_PROJECT_ID>',
  apiKey: '<YOUR_API_KEY>', // pk_ للعميل، sk_ على خادم موثوق
);`,
            },
          ]}
        />
      </Section>

      <Section id="end-user-tokens" title="رموز المستخدمين النهائيين وتقييم القواعد">
        <P>
          عند استخدام مفتاح عام، يُقدّم الرمز الاختياري{" "}
          <code>Authorization: Bearer &lt;jwt&gt;</code> هوية المستخدم النهائي.
          يوفّر ردّ الاتصال <code>getAuthToken</code> هذا الرمز في كل طلب، أو
          يمكنك استخدام واجهة المصادقة في الحزمة البرمجية للحصول عليه وإدارته.
        </P>
        <CodeTabs
          tabs={[
            {
              label: "TypeScript",
              lang: "ts",
              code: `const email = "ada@example.com";
const password = "correct-horse-battery-staple";
await db.auth.signUpWithEmailAndPassword({ email, password });
await db.auth.signInWithEmailAndPassword({ email, password });

const token = await db.auth.getIdToken(); // EdDSA، يُجدَّد تلقائياً قبل الانتهاء
const tokenUserId = db.auth.currentUser?.id;
if (tokenUserId) {
  const me = await db.collection("users").doc(tokenUserId).get();
  console.log(me.data());
}

await db.auth.signOut();`,
            },
            {
              label: "Flutter / Dart",
              lang: "dart",
              code: `const email = 'ada@example.com';
const password = 'correct-horse-battery-staple';
await client.auth.signUpWithEmailAndPassword(email: email, password: password);
await client.auth.signInWithEmailAndPassword(email: email, password: password);

final token = await client.auth.getIdToken(); // EdDSA مع تجديد صامت
await client.auth.signOut();`,
            },
          ]}
        />
        <P>
          تستطيع شجرة قواعد الأمان قراءة <code>auth.uid</code> و
          <code>auth.claims.&lt;field&gt;</code>، ولذلك يمكن لمفتاح عام واحد أن
          يخدم مستخدمين كثيرين بأمان. راجع{" "}
          <PageLink slug="security-rules" lang="ar">
            قواعد الأمان
          </PageLink>
          .
        </P>
        <Callout tone="danger" title="لا يوجد بديل HS256">
          تُتحقَّق رموز المستخدمين النهائيين بتوقيع <code>EdDSA</code> فقط في
          كل من HTTP وWebSocket، بمفتاح Ed25519 الخاص بالمشروع. أي رمز
          <code>HS256</code> يُرفض في مستوى المستندات حتى مع مفتاح API صالح.
          المفاتيح العامة متاحة على{" "}
          <code>GET /v1/projects/:projectId/auth/.well-known/jwks.json</code>
          .
        </Callout>
      </Section>


      <Section id="rotation-and-least-privilege" title="التدوير والإلغاء وأقل الامتيازات">
        <H3 id="rotation">التدوير والإلغاء</H3>
        <P>
          تُصدَر المفاتيح لكل مشروع. لا يظهر المفتاح الصريح إلا عند إنشائه؛
          وبعدها تظهر البادئات والنطاقات والحالة وبيانات الاستخدام فقط.
        </P>
        <OL
          items={[
            "أنشئ المفتاح الجديد.",
            "وزّعه على العملاء.",
            "تأكد من انتقال حركة الاستخدام إليه.",
            "ألغِ المفتاح القديم.",
          ]}
        />
        <P>
          لأن الإلغاء يُفرَض أيضاً مقابل سجل الخادم، فلا يمكن استخدام مفتاح
          مخزَّن مؤقتاً بعد ضبط <code>revokedAt</code> له.
        </P>

        <H3 id="least-privilege">أقل قدر من الامتيازات</H3>
        <UL
          items={[
            <>استخدم مفاتيح منفصلة لكل مشروع؛ ولا تُعد استخدام مفتاح عبر مشاريع مختلفة.</>,
            <>
              فضّل مفاتيح <code>pk_</code> في تطبيقات العميل واترك لقواعد الأمان
              تحديد الوصول؛ واستخدم مفاتيح <code>sk_</code> على الخوادم الموثوقة
              فقط.
            </>,
            <>
              امنح أضيق مجموعة نطاقات: الخدمات للقراءة فقط تأخذ{" "}
              <code>documents:read</code>، وأدوات الفهارس تأخذ{" "}
              <code>indexes:manage</code>.
            </>,
            <>اضبط تاريخ انتهاء للمفاتيح المؤقتة، ودوّرها بانتظام.</>,
          ]}
        />
        <Callout tone="warning" title="نظافة السجلات">
          لا تُسجَّل مفاتيح <code>pk_</code>/<code>sk_</code> الصريحة، ولا رموز
          JWT الحاملة، ولا عناوين قواعد البيانات. يُخفي مُسجّل البنية{" "}
          <code>@vellum/observability</code> هذه الأنماط تلقائياً؛ أبقِ كل سجلات
          التطبيق على هذا المسار.
        </Callout>
      </Section>

      <Section id="common-pitfalls" title="أخطاء شائعة">
        <UL
          items={[
            <>
              <strong>الخلط بين الأسطح.</strong> أي رمز صادر خارج مستوى
              المستندات يُرفض فيه، ومفتاح API لا يصرّح بأي شيء خارجه.
            </>,
            <>
              <strong>افتراض أن المفتاح العام مميّز.</strong> بدون مجموعة قواعد
              فعّالة، يُرفض الوصول بالمفتاح العام؛ يجب أن تسمح القواعد صراحةً
              بكل عملية.
            </>,
            <>
              <strong>استخدام النطاق <code>*</code> للراحة.</strong> مفتاح خادم
              واسع النطاق يُفقد أقل الامتيازات معناه؛ امنح ما يحتاجه الخدمة فقط.
            </>,
            <>
              <strong>نسيان التدوير.</strong> أنشئ البديل أولاً، ثم وزّعه على
              العملاء، ثم ألغِ القديم — ولا تُبطل المفتاح القديم قبل نشر الجديد.
            </>,
          ]}
        />
      </Section>

      <Section id="next-steps" title="ما ينبغي قراءته تالياً">
        <UL
          items={[
            <>
              <PageLink slug="end-user-auth" lang="ar">
                مصادقة المستخدمين النهائيين
              </PageLink>{" "}
              — تدوير الرموز، وإسقاط الملف الشخصي، ومصادقة WS، وتحديد المعدل.
            </>,
            <>
              <PageLink slug="sdks/javascript" lang="ar">
                JavaScript SDK
              </PageLink>{" "}
              و{" "}
              <PageLink slug="sdks/flutter" lang="ar">
                Flutter SDK
              </PageLink>{" "}
              — واجهة المصادقة والتجديد الصامت في كلا العميلين.
            </>,
            <>
              <PageLink slug="security-rules" lang="ar">
                قواعد الأمان
              </PageLink>{" "}
              — شجرة <code>AST</code> بالرفض الافتراضي التي تُقيَّم للمفاتيح
              العامة.
            </>,
            <>
              <PageLink slug="rest-api" lang="ar">
                REST API
              </PageLink>{" "}
              — كيفية إرسال المفتاح في كل نقطة نهاية.
            </>,
            <>
              <PageLink slug="production-checklist" lang="ar">
                قائمة التحقق للإنتاج
              </PageLink>{" "}
              — البوابات المسجّلة ونظافة الأسرار.
            </>,
          ]}
        />
      </Section>
    </Doc>
  );
}
