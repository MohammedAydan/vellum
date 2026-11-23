import {
  Callout,
  Code,
  Doc,
  H3,
  P,
  PageLink,
  Section,
  Steps,
  Table,
  UL,
} from "../../../ui";

export default function Page() {
  return (
    <Doc
      title="رموز الأخطاء وإرشادات إعادة المحاولة"
      description="كل رمز معياري، وحالته HTTP، ومتى يحدث، وما إذا كانت إعادة المحاولة آمنة."
      eyebrow="المرجع"
    >
      <Section id="envelope" title="غلاف الخطأ الموحّد">
        <P>
          تُعيد كل عملية فاشلة البنية نفسها من{" "}
          <code>@vellum/core</code>: كائنًا يحمل <code>error.code</code> و
          <code>error.message</code> و<code>error.requestId</code> و<code>error.details</code>.
          وتحمل استجابة HTTP أيضًا الترويسة <code>X-Request-Id</code> بالقيمة نفسها. في SDK
          تُلقى استثناءات بخصائص <code>code</code> و<code>status</code> و<code>details</code> و
          <code>requestId</code> منسوخة من الغلاف.
        </P>
        <Code
          lang="json"
          title="error envelope"
          code={`{
  "error": {
    "code": "FAILED_PRECONDITION",
    "message": "Version precondition failed on 'users/u_123' (expected 4, actual 5)",
    "requestId": "req_01JCK9X2P8...",
    "details": {
      "path": "users/u_123",
      "expectedVersion": 4,
      "actualVersion": 5
    }
  }
}`}
        />
        <Callout tone="info" title="تعامل مع details كسجل">
          مفاتيح <code>details</code> تختلف باختلاف الرمز؛ لا تفترض شكلًا ثابتًا. ويُعدّ{" "}
          <code>requestId</code> الطريقة الآمنة لربط حادثة مُخفاة السجلات بطلبك عند إبلاغ الدعم.
        </Callout>
      </Section>

      <Section id="codes" title="الرموز المعيارية وحالات HTTP">
        <P>
          الرموز التالية هي المجموعة المرجعية في هرم الأخطاء؛ لكل رمز حالة HTTP واحدة ثابتة.
          يُنصح بالتفرّع على <code>code</code> لا على الحالة، لأن عدة رموز تتشارك الحالة نفسها
          (مثل 400 و429).
        </P>
        <H3 id="client-codes">أخطاء الطلب (400)</H3>
        <Table
          head={["الرمز", "HTTP", "السبب المعتاد", "إعادة المحاولة"]}
          rows={[
            [<><code>INVALID_ARGUMENT</code></>, "400", <>طلب مشوّه، رمز <code>$op</code> غير مسموح، أو قيمة تهيئة خاطئة.</>, "لا — أصلح الطلب."],
            [<><code>INVALID_DOCUMENT_PATH</code></>, "400", "عمق مسار خاطئ، مقطع طويل أو محجوز.", "لا — أصلح المسار."],
            [<><code>INVALID_FIELD_NAME</code></>, "400", "اسم حقل فارغ أو طويل أو يحمل أحرف تحكم.", "لا — أصلح الاسم."],
            [<><code>MAX_NESTING_EXCEEDED</code></>, "400", "تداخل المستند أعمق من 20 مستوى.", "لا — قلّل التداخل."],
            [<><code>BATCH_SIZE_EXCEEDED</code></>, "400", "أكثر من 100 عملية في دفعة واحدة.", "لا — قسّم الدفعة."],
            [<><code>INVALID_CURSOR</code></>, "400", "مؤشر معبّث أو مشوّه أو من شكل آخر.", "لا — ابدأ استعلامًا جديدًا للحصول على مؤشر صالح."],
            [<><code>QUERY_TOO_COMPLEX</code></>, "400", "مرشحات أو حقول ترتيب كثيرة، أو شجرة قواعد خارج الحدود.", "لا بعد التبسيط أو إضافة فهرس؛ لا تُعِد الإرسال كما هو."],
            [<><code>LIMIT_EXCEEDED</code></>, "400", "حدّ استعلام أكبر من 500.", <>لا — اخفض <code>limit</code>.</>],
            [<><code>SUBSCRIPTION_LIMIT_EXCEEDED</code></>, "400", "أكثر من 50 اشتراكًا على وصلة WebSocket واحدة.", "لا بعد إلغاء اشتراكات زائدة."],
          ]}
        />
        <H3 id="auth-and-access-codes">المصادقة والوصول (401–404)</H3>
        <Table
          head={["الرمز", "HTTP", "السبب المعتاد", "إعادة المحاولة"]}
          rows={[
            [<><code>UNAUTHENTICATED</code></>, "401", "مفتاح مفقود أو مشوّه أو منتهٍ أو ملغى، أو انتهت مهلة مصادقة WebSocket.", "لا — جدّد بيانات المصادقة أولًا."],
            [<><code>TOKEN_EXPIRED</code></>, "401", "انتهت صلاحية رمز المستخدم النهائي.", "نعم — بعد تحديث الرمز فقط."],
            [<><code>PERMISSION_DENIED</code></>, "403", "نطاق مفتاح الخادم غير كافٍ أو قواعد الأمان منعت العملية.", "لا — راجع الصلاحيات أو القواعد."],
            [<><code>NOT_FOUND</code></>, "404", "قراءة أو حذف مستند غير موجود.", "لا — تحقق من المسار."],
          ]}
        />
        <H3 id="conflict-codes">التعارض والشروط والوقت (408–412)</H3>
        <Table
          head={["الرمز", "HTTP", "السبب المعتاد", "إعادة المحاولة"]}
          rows={[
            [<><code>TRANSACTION_TIMEOUT</code></>, "408", "تجاوزت المعاملة 5 ثوانٍ.", "نعم — أعد runTransaction كاملًا بتراجع محدود."],
            [<><code>ALREADY_EXISTS</code></>, "409", <><code>create</code> على مسار مشغول أو فهرس مركّب مكرّر.</>, <>لا — استخدم <code>set</code> أو غيّر المعرّف.</>],
            [<><code>ABORTED_CONFLICT</code></>, "409", "تغيّرت نسخة مجموعة القراءة قبل الالتزام (OCC)، أو استبدلت قواعد العلاقات باستخدام If-Match قديم.", "نعم — أعد القراءة ثم أعد المحاولة."],
            [<><code>FAILED_PRECONDITION</code></>, "412", <>عدم تطابق <code>ifVersion</code> أو <code>exists</code>، أو هدف زيادة غير صالح، أو غياب فهرس مطلوب.</>, "نعم — بعد إعادة القراءة والتحقق من الشرط."],
          ]}
        />
        <H3 id="size-and-rate-codes">الحجم والمعدل (413–429)</H3>
        <Table
          head={["الرمز", "HTTP", "السبب المعتاد", "إعادة المحاولة"]}
          rows={[
            [<><code>DOCUMENT_TOO_LARGE</code></>, "413", "مستند مُطبَّع أكبر من 1 MiB.", "لا — قلّل الحجم."],
            [<><code>PAYLOAD_TOO_LARGE</code></>, "413", "حمولة دفعة أكبر من 5 MiB، أو إطار WebSocket أكبر من 1 MiB.", "لا — قسّم الحمولة."],
            [<><code>RESPONSE_TOO_LARGE</code></>, "413", "استجابة استعلام أكبر من 4 MiB.", <>لا — قلّل <code>limit</code> أو الإسقاط.</>],
            [<><code>RATE_LIMITED</code></>, "429", <>تجاوز حد الطلبات لكل مفتاح؛ تُرسل ترويسة <code>Retry-After</code>.</>, "نعم — بعد الانتظار المطلوب."],
            [<><code>TOO_MANY_REQUESTS</code></>, "429", "تجاوز معدل الطلبات العام.", "نعم — بتراجع أُسّي."],
            [<><code>QUOTA_EXCEEDED</code></>, "429", "تجاوز حصة الخطة (مثل عدد الفهارس المركّبة).", "لا — راجع الخطة أو انتظر إعادة تعيين الحصة."],
            [<><code>SLOW_CONSUMER_DISCONNECT</code></>, "429", "مخزن إرسال WebSocket تجاوز 1 MiB.", "لا — بعد تسريع الاستهلاك، وأعد الاتصال."],
          ]}
        />
        <H3 id="server-codes">أخطاء الخادم (500–504)</H3>
        <Table
          head={["الرمز", "HTTP", "السبب المعتاد", "إعادة المحاولة"]}
          rows={[
            [<><code>INTERNAL_ERROR</code></>, "500", "عطل غير متوقع في الخادم.", <>نعم — للعمليات الآمنة للتكرار، بتراجع وتشويش، مع إرفاق <code>requestId</code>.</>],
            [<><code>SERVICE_UNAVAILABLE</code></>, "503", "أحد المستويات أو التبعيات غير متاح.", "نعم — بتراجع حتى العودة."],
            [<><code>QUERY_DEADLINE_EXCEEDED</code></>, "504", "تجاوز الاستعلام ميزانية التنفيذ 5 ثوانٍ.", "لا قبل تبسيط الاستعلام أو إضافة فهرس."],
          ]}
        />
        <Callout tone="warning" title="أسماء قديمة في api-contract">
          تظهر أسماء مثل <code>ABORTED</code> و<code>RESOURCE_EXHAUSTED</code> و
          <code>DEADLINE_EXCEEDED</code> و<code>UNAVAILABLE</code> و<code>INTERNAL</code> و
          <code>TOO_MANY_REQUESTS</code> في تعداد <code>ErrorCodeEnum</code> لأسباب التوافق، لكن
          هرم الأخطاء التنفيذي في <code>@vellum/core</code> هو المرجع الملزم. يجب أن يتفرّع رمز
          العميل على الرموز الواردة في الجداول أعلاه.
        </Callout>
      </Section>

      <Section id="retry" title="استراتيجية إعادة المحاولة">
        <Steps
          items={[
            {
              title: "تفرّع على الرمز لا على الحالة",
              body: <P>اقرأ <code>error.code</code> من الغلاف أو <code>e.code</code> من الاستثناء؛ فالحالة الواحدة تغطي أسبابًا مختلفة تمامًا.</P>,
            },
            {
              title: "صنّف الخطأ",
              body: <P>الرموز العابرة مثل <code>ABORTED_CONFLICT</code> و<code>RATE_LIMITED</code> و<code>SERVICE_UNAVAILABLE</code> قابلة لإعادة المحاولة؛ وأخطاء الصلاحية والتحقق لا تُصلحها إعادة الإرسال.</P>,
            },
            {
              title: "احترم تلميح الانتظار",
              body: <P>عند <code>RATE_LIMITED</code> استخدم ترويسة <code>Retry-After</code> أو <code>details.retryAfterMs</code>، ثم أضف تشويشًا عشوائيًا لتفادي التزامن مع عملاء آخرين.</P>,
            },
            {
              title: "اجعل المحاولة آمنة",
              body: <P>أعد قراءة الإصدار الحالي عند <code>FAILED_PRECONDITION</code> و<code>ABORTED_CONFLICT</code>، واستخدم معرّفات مستندات ثابتة أو <code>set</code> عند التعامل مع <code>ALREADY_EXISTS</code>.</P>,
            },
            {
              title: "أرفق معرّف الطلب",
              body: <P>أدرج <code>requestId</code> في أي تقرير خطأ، وحدّد عدد المحاولات بسقف ثابت لتجنب حلقات إعادة المحاولة اللانهائية.</P>,
            },
          ]}
        />
        <Code
          lang="ts"
          title="تفرّع على الرمز"
          code={`try {
  await db.collection("users").doc("u_123").update({ name: "Ada" }, { ifVersion: 4 });
} catch (err) {
  const e = err as Error & { code?: string };
  switch (e.code) {
    case "FAILED_PRECONDITION":
      // أعد القراءة ثم أعد المحاولة بالنسخة الحالية.
      break;
    case "ABORTED_CONFLICT":
      // أعد runTransaction كاملًا بتراجع محدود.
      break;
    case "RATE_LIMITED":
      await new Promise((r) => setTimeout(r, 1000));
      break;
    case "PERMISSION_DENIED":
      // اعرض الخطأ للمستخدم؛ لا تُعِد المحاولة.
      break;
    default:
      throw err;
  }
}`}
        />
        <UL
          items={[
            <P>لا تفترض أنّ كل حالة 400 تعني نفس الشيء، ولا أنّ كل حالة 429 تُعالَج بالطريقة ذاتها.</P>,
            <P>إن كانت العملية غير آمنة للتكرار (مثل <code>inc</code> بلا مفتاح تكافؤ)، فلا تُعِد إرسالها تلقائيًا بعد أخطاء الخادم الغامضة.</P>,
          ]}
        />
      </Section>

      <Section id="ws-errors" title="أخطاء WebSocket">
        <P>
          تُرسل أخطاء الوقت الفعلي داخل إطار <code>error</code> يحمل <code>code</code> و
          <code>message</code> واختياريًا <code>subId</code>. أخطاء الاشتراك تُرفق بمعرّف
          الاشتراك، وأخطاء الوصلة تحمل <code>subId: "connection"</code>. من أمثلتها{" "}
          <code>UNAUTHENTICATED</code> عند انتهاء مهلة المصادقة، و
          <code>SUBSCRIPTION_LIMIT_EXCEEDED</code> عند تجاوز 50 اشتراكًا، و
          <code>SLOW_CONSUMER_DISCONNECT</code> عند تجاوز مخزن الإرسال 1 MiB، و
          <code>PAYLOAD_TOO_LARGE</code> عند تجاوز الإطار 1 MiB.
        </P>
        <Code
          lang="json"
          title="error frame"
          code={`{
  "type": "error",
  "subId": "orders-1",
  "code": "SUBSCRIPTION_LIMIT_EXCEEDED",
  "message": "Maximum of 50 active subscriptions per connection exceeded"
}`}
        />
        <P>
          تُغلق الوصلة بعد أخطاء السياسة برمز الإغلاق 1008، وبعد تجاوز حجم الإطار بالرمز 1009،
          وبعد الخمول بالرمز 1000. تفاصيل الإطارات والاستئناف في{" "}
          <PageLink slug="reference/realtime-protocol" lang="ar">بروتوكول WebSocket للوقت الفعلي</PageLink>
          {" "}والحصص في <PageLink slug="errors-and-limits" lang="ar">الحصص والحدود</PageLink>.
        </P>
      </Section>
    </Doc>
  );
}
