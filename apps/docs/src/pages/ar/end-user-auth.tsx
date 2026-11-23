import {
  Api,
  Badge,
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

export default function Page() {
  return (
    <Doc
      title="مصادقة المستخدمين النهائيين"
      description="رموز EdDSA حصراً على مستوى البيانات، وتدوير رموز التحديث بنافذة سماح 15 ثانية، ونقاط نهاية المصادقة الفعلية."
      eyebrow="المصادقة"
    >
      <Section id="isolated-credentials" title="بيانات اعتماد معزولة">
        <P>
          بيانات الاعتماد في VELLUM <strong>منفصلة تماماً</strong> لكل سطح، ولا تتقاسم سوى بدائل التشفير عديمة الحالة من{" "}
          <code>@vellum/auth</code> (مثل <code>scrypt</code> و <code>AES-256-GCM</code> و <code>SHA-256</code> و{" "}
          <code>TOTP</code> ومولّدات الرموز ومنطق التدوير). أمّا جداول التخزين ومفاتيح التوقيع ونوع الرمز{" "}
          <code>typ</code> والمُصدِر <code>iss</code> والجمهور <code>aud</code> وشكل المطالبات وخدمات الجلسات
          والوسائط، فهي مستقلة بشكل كامل؛ ولذلك يُرفض أي رمز صادر عن سطح في غيره.
        </P>
        <Table
          head={["المجال", "تخزين الجلسات", "السر", "الخوارزمية", "typ", "iss", "aud"]}
          rows={[
            [
              <code>project_end_user</code>,
              <><code>data_db.project_auth_*</code> (مع <code>FORCE RLS</code>)</>,
              "مفتاح Ed25519 لكل مشروع",
              <strong>EdDSA</strong>,
              <code>vellum+enduser+jwt</code>,
              <code>{"https://api.vellum.dev/v1/projects/<projectId>/auth"}</code>,
              <code>{"<projectId>"}</code>,
            ],
          ]}
        />
        <Callout tone="danger" title="لا بديل HS256 للمستخدمين النهائيين">
          <P>
            يتم التحقق من رموز المستخدم النهائي بخوارزمية <strong>EdDSA فقط</strong> على كلٍّ من HTTP و WebSocket،
            مقابل مفتاح Ed25519 العام الخاص بالمشروع. أي رمز <code>HS256</code>
            يُرفض على مستوى المستندات حتى لو صُحب بمفتاح API صالح؛ لأن التحقق يشترط{" "}
            <code>alg=EdDSA</code> و <code>typ=vellum+enduser+jwt</code> والمطابقة التامة لـ <code>aud</code> و{" "}
            <code>iss</code>.
          </P>
        </Callout>
      </Section>

      <Section id="end-user-tokens" title="رموز المستخدم النهائي و JWKS">
        <P>
          تُوقَّع رموز الوصول لكل مشروع على حدة، وتحمل مطالبات الهوية وصلاحيات المستخدم. ويُعدّ <code>iss</code>{" "}
          إلزامياً أثناء التحقق، وتُبلَّغ الرموز المنتهية بخطأ <code>TOKEN_EXPIRED</code> مع{" "}
          <code>retryableWithRefresh: true</code> حتى تتمكن الحزمة البرمجية من تحديثها بشفافية.
        </P>
        <Code
          lang="json"
          title="Access token"
          code={`{
  "header": { "alg": "EdDSA", "typ": "vellum+enduser+jwt", "kid": "<keyId>" },
  "payload": {
    "iss": "https://api.vellum.dev/v1/projects/<projectId>/auth",
    "sub": "<uid>",
    "aud": "<projectId>",
    "email": "user@example.com",
    "email_verified": true,
    "is_anonymous": false,
    "claims": { "role": "admin" },
    "iat": 1731000000,
    "exp": 1731003600,
    "auth_time": 1730999900,
    "jti": "<uuid>"
  }
}`}
        />
        <UL
          items={[
            <>
              <code>sub</code> معرّف المستخدم، و <code>claims</code> تحمل المطالبات المخصّصة التي تقرأها{" "}
              <PageLink slug="security-rules" lang="ar">قواعد الأمان</PageLink> عبر <code>auth.claims.*</code>.
            </>,
            <>
              <code>jti</code> معرّف فريد لكل رمز، ويُستخدم في تعقب الجلسة وإبطالها.
            </>,
            <>
              المفتاح <code>kid</code> يحدّد المفتاح العام المناسب داخل مستند JWKS عند التدوير.
            </>,
          ]}
        />
        <Api method="GET" path="/v1/projects/:projectId/auth/.well-known/jwks.json">
          <P>
            مستند JWKS عام يعرض مفاتيح <code>OKP/Ed25519</code> للمشروع، ويمكن لخوادم البوابات والعملاء جلبه
            <strong> دون أي مفتاح API</strong>. هذا هو المسار الوحيد في هذه المجموعة من النقاط الذي لا يتطلب مفتاح مشروع.
          </P>
        </Api>
      </Section>

      <Section id="refresh-rotation" title="تدوير رموز التحديث ونافذة السماح">
        <P>
          رموز التحديث قيم معتمة بطول 32 بايتاً، ولا يُخزَّن سوى تجزئة <code>SHA-256</code> لها. أثناء التدوير تُحفظ
          التجزئة السابقة مع الطابع <code>rotated_at</code>، ويُزاد عدّاد التدوير <code>rotation_counter</code>.
          وبهذا يُفرَّق بين التحديث المتزامن المشروع وإعادة التشغيل الخبيثة.
        </P>
        <UL
          items={[
            <>
              <strong>التجزئة الحالية:</strong> تدوير عادي — تُستبدل التجزئة ويُحدَّث <code>rotated_at</code>، ويُصدر
              زوج رموز جديد.
            </>,
            <>
              <strong>التجزئة السابقة خلال 15 ثانية:</strong> يُعدّ الطلب تبويباً متزامناً بريئاً؛ فتُنشأ جلسة
              جديدة للمستخدم نفسه دون إبطال أي جلسة أخرى.
            </>,
            <>
              <strong>التجزئة السابقة بعد 15 ثانية:</strong> يُعدّ إعادة تشغيل؛ فتُلغى <strong>جميع جلسات</strong>{" "}
              المستخدم بالسبب <code>refresh_token_replay_detected</code> ويُعاد الخطأ <code>UNAUTHENTICATED</code>.
            </>,
          ]}
        />
        <CodeTabs
          tabs={[
            {
              label: "curl",
              lang: "bash",
              code: `curl -X POST "https://api.vellum.dev/v1/projects/<PROJECT_ID>/auth/token/refresh" \\
  -H "content-type: application/json" \\
  -H "x-vellum-api-key: <pk_...>" \\
  -d '{ "refreshToken": "<rt_...>" }'`,
            },
            {
              label: "الاستجابة",
              lang: "json",
              code: `{
  "accessToken": "<EdDSA JWT>",
  "refreshToken": "<rt_...>",
  "tokenType": "Bearer",
  "sessionId": "<sessionId>",
  "expiresAt": "2026-11-18T12:00:00.000Z"
}`,
            },
          ]}
        />
        <P>
          تُجري الحزمتان البرمجيتان تحديثاً استباقياً قبل انتهاء الصلاحية بـ 45 ثانية، وتوحّدان الطلبات المتزامنة
          بقفل <code>single-flight</code>؛ وعند ورود <code>401</code> تُجريان تحديثاً قسرياً واحداً ثم تُعيدان الطلب
          الأصلي مرة واحدة. يمكن الاطّلاع على تفاصيل التكامل في{" "}
          <PageLink slug="sdks/javascript" lang="ar">حزمة JavaScript</PageLink> و{" "}
          <PageLink slug="sdks/flutter" lang="ar">حزمة Flutter</PageLink>.
        </P>
      </Section>

      <Section id="rest-endpoints" title="نقاط نهاية REST للمستخدم النهائي">
        <P>
          جميع المسارات أدناه متفرّعة من <code>/v1/projects/:projectId/auth</code> وتتطلب مفتاح API للمشروع
          في الترويسة <code>x-vellum-api-key</code>، باستثناء نقطة JWKS. يُحمل هوية المستخدم برمز الحامل في{" "}
          <code>authorization</code> أو <code>x-vellum-user-token</code>.
        </P>
        <Table
          head={["الطريقة", "المسار النسبي", "الوظيفة"]}
          rows={[
            ["POST", <code>/sign-up/email</code>, "إنشاء مستخدم بالبريد وكلمة المرور وإصدار جلسة (201)."],
            ["POST", <code>/sign-in/email</code>, <>تسجيل الدخول؛ قد يُعيد <code>mfaRequired</code> وتذكرة MFA.</>],
            ["POST", <code>/sign-in/anonymous</code>, "إنشاء مستخدم مجهول وإصدار جلسة (201)."],
            ["POST", <code>/sign-in/provider</code>, "الدخول عبر مزوّد هوية وربط الهوية أو إنشاء المستخدم."],
            ["POST", <code>/token/refresh</code>, "تدوير رمز التحديث وإصدار زوج رموز جديد."],
            ["POST", <code>/sign-out</code>, "إبطال جلسة محدّدة أو جميع جلسات المستخدم."],
            ["GET", <code>/user</code>, "قراءة الملف الشخصي للمستخدم المصادَّق."],
            ["PATCH", <code>/user</code>, "تحديث الملف الشخصي والمطالبات وإعادة إسقاط المستند."],
            ["POST", <code>/password/reset</code>, "إرسال رمز إعادة تعيين؛ استجابة غير كاشفة دائماً."],
            ["POST", <code>/password/confirm</code>, "استهلاك الرمز وتغيير كلمة المرور وإبطال الجلسات."],
            ["POST", <code>/email/verify/request</code>, "إرسال رمز تأكيد البريد؛ استجابة غير كاشفة دائماً."],
            ["POST", <code>/email/verify/confirm</code>, <>استهلاك الرمز وتحديث <code>emailVerified</code>.</>],
            ["POST", <code>/mfa/enroll</code>, "إنشاء سر TOTP ورموز الاسترداد و URI للتسجيل."],
            ["POST", <code>/mfa/verify</code>, "التحقق من رمز TOTP أو رمز الاسترداد وتفعيل العامل."],
            ["POST", <code>/mfa/challenge</code>, "استهلاك تذكرة MFA وإصدار جلسة بعد نجاح التحقق."],
            [
              "GET",
              <code>/.well-known/jwks.json</code>,
              <>المفاتيح العامة <Badge tone="info">دون مفتاح API</Badge></>,
            ],
          ]}
        />
        <CodeTabs
          tabs={[
            {
              label: "sign-up/email",
              lang: "bash",
              code: `curl -X POST "https://api.vellum.dev/v1/projects/<PROJECT_ID>/auth/sign-up/email" \\
  -H "content-type: application/json" \\
  -H "x-vellum-api-key: <pk_...>" \\
  -d '{
    "email": "user@example.com",
    "password": "S3cure!pass",
    "displayName": "User"
  }'`,
            },
            {
              label: "mfa/challenge",
              lang: "bash",
              code: `curl -X POST "https://api.vellum.dev/v1/projects/<PROJECT_ID>/auth/mfa/challenge" \\
  -H "content-type: application/json" \\
  -H "x-vellum-api-key: <pk_...>" \\
  -d '{ "mfaTicket": "<ticket>", "code": "123456", "factorType": "totp" }'`,
            },
          ]}
        />
        <Callout tone="info" title="استجابات عدم الكشف">
          <P>
            تُجيب نقطتا <code>/password/reset</code> و <code>/email/verify/request</code> دائماً بـ{" "}
            <code>{"{ \"success\": true, \"sent\": true }"}</code> سواء وُجد البريد أم لا، خشية كشف وجود
            الحسابات. وفي بيئة التطوير بدون SMTP فقط يُعاد <code>devToken</code> مع <code>expiresAt</code> عند وجود
            المستخدم.
          </P>
        </Callout>
      </Section>

      <Section id="ws-and-sdks" title="المصادقة على WebSocket والحزم البرمجية">
        <P>
          تبدأ اتصالات الوقت الفعلي بإطار <code>auth</code> يحمل مفتاح المشروع ورمز المستخدم، ويُتحقق من الرمز
          بمفتاح Ed25519 الخاص بالمشروع. وبعد كل تدوير للرمز تُعيد الحزمة البرمجية إرسال إطار <code>auth</code> على
          الاتصال الحي نفسه.
        </P>
        <Code
          lang="json"
          title="auth frame"
          code={`{ "type": "auth", "projectId": "<PROJECT_ID>",
  "apiKey": "<pk_...>", "authToken": "<EdDSA JWT>" }`}
        />
        <H3 id="query-subscription">اشتراك استعلامي</H3>
        <P><a href="/docs/ar/realtime/#subscribe">الاشتراك في دليل الوقت الفعلي</a></P>
        <Code
          lang="json"
          title="subscribe frame"
          code={`{ "type": "subscribe", "subId": "sub_ab12cd34",
  "query": {
    "collectionPath": "tasks",
    "where": [{ "field": "done", "op": "==", "value": false }],
    "orderBy": [{ "field": "priority", "direction": "asc" }],
    "limit": 20
  } }`}
        />
        <CodeTabs
          tabs={[
            {
              label: "TypeScript",
              lang: "ts",
              code: `import { createClient } from "@vellumdb/sdk-js";

const db = createClient({
  projectId: "<PROJECT_ID>",
  apiKey: "<pk_...>",
});

const user = await db.auth.signUpWithEmailAndPassword("user@example.com", "S3cure!pass");
const token = await db.auth.getIdToken();
await db.auth.signOut();

const unsub = db.collection("tasks").snapshots((snapshot) => console.log(snapshot.docs));`,
            },
            {
              label: "Flutter",
              lang: "dart",
              code: `final client = VellumClient(
  endpoint: "https://api.vellum.dev",
  projectId: "<PROJECT_ID>",
  apiKey: "<pk_...>",
);

final user = await client.auth.signUpWithEmailAndPassword(
  email: "user@example.com",
  password: "S3cure!pass",
);
final token = await client.auth.getIdToken();`,
            },
          ]}
        />
      </Section>

      <Section id="rate-limits" title="تحديد المعدل وإسقاط المستخدم">
        <P>
          تُطبَّق نوافذ زمنية داخل العملية الواحدة (بدون Redis أو أي خدمة حالة خارجية). تُعاد الاستجابة المُقيَّدة
          بالحالة <code>429</code> والرمز <code>TOO_MANY_REQUESTS</code> مع ترويسة <code>Retry-After</code>
          بالثواني، وفق ما هو موضح في{" "}
          <PageLink slug="reference/errors" lang="ar">مرجع رموز الأخطاء</PageLink>.
        </P>
        <Table
          head={["النقطة", "الحد", "النافذة", "مفتاح الحد"]}
          rows={[
            [<code>/sign-in/email</code>, "10 محاولات فاشلة", "15 دقيقة", <>(ip, email)</>],
            [<><code>/password/reset</code> و <code>/email/verify/request</code></>, "5 طلبات", "15 دقيقة", <>(ip, email) أو ip + SHA-256(bearer)</>],
            [<><code>/mfa/challenge</code> و <code>/mfa/verify</code></>, "5 محاولات فاشلة", "5 دقائق", "لكل مستخدم؛ تُبطل التذكرة"],
          ]}
        />
        <P>
          عند تفعيل <code>enable_user_projection</code> (وهو الإعداد الافتراضي) تكتب خدمة المصادقة مستند{" "}
          <code>users/{"{uid}"}</code> عبر <code>DocumentEngine.setDocument</code> بصلاحية{" "}
          <code>system_bypass</code> ودلالة دمج <code>merge: true</code>؛ وتُعاد مزامنته بعد التسجيل وتحديث الملف
          الشخصي وتأكيد البريد. ويمكن لقواعد الأمان قراءة هذه الهوية عبر <code>auth.uid</code> و{" "}
          <code>auth.claims.*</code>، كما هو مبين في{" "}
          <PageLink slug="security-rules" lang="ar">قواعد الأمان</PageLink> و{" "}
          <PageLink slug="reference/realtime-protocol" lang="ar">بروتوكول الوقت الفعلي</PageLink>.
        </P>
      </Section>
    </Doc>
  );
}
