import {
  Callout,
  Code,
  CodeTabs,
  Definitions,
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
      title="الحصص والحدود"
      description="غلاف الخطأ المعياري، وجدول رموز ERROR_HTTP_STATUS الكامل، وثوابت SYSTEM_LIMITS الثابتة في @vellum/core وحدود مُجمّع الاستعلام."
      eyebrow="المرجع"
    >
      <Section id="error-envelope" title="غلاف خطأ موحّد لكل فشل">
        <P>
          يُرفع كل فشل في VELLUM ككائن <code>VellumError</code> من حزمة <code>@vellum/core</code> يحمل رمزاً
          معيارياً <code>code</code> وحالة HTTP مطابقة وكائن <code>details</code> اختيارياً ومعرّف{" "}
          <code>requestId</code> يطابق ترويسة <code>X-Request-Id</code> لتتبع الحوادث دون كشف أي أسرار:
        </P>
        <Code
          lang="json"
          title="شكل استجابة الخطأ القياسية"
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
      </Section>

      <Section id="canonical-error-codes" title="رموز الأخطاء المعيارية (ERROR_HTTP_STATUS)">
        <P>
          تفرّع منطق المعالجة دائماً بناءً على <code>error.code</code> لا على رقم HTTP وحده، لأن عدة رموز
          معيارية تتشارك نفس حالة HTTP:
        </P>
        <Table
          head={["الرمز المعياري", "HTTP", "السبب المعتاد"]}
          rows={[
            [<code>INVALID_ARGUMENT</code>, "400", "طلب غير صالح، عامل غير مدعوم، أو قيمة إعداد خاطئة."],
            [<code>INVALID_DOCUMENT_PATH</code>, "400", "عمق مسار خاطئ، مقطع يتجاوز 1,500 بايت، أو محاولة اجتياز مسار."],
            [<code>INVALID_FIELD_NAME</code>, "400", "اسم حقل فارغ أو يتجاوز 256 حرفاً أو يحتوي على أحرف تحكم أو تلويث."],
            [<code>MAX_NESTING_EXCEEDED</code>, "400", "تداخل بيانات المستند يتجاوز 20 مستوى."],
            [<code>BATCH_SIZE_EXCEEDED</code>, "400", "تجاوز 100 عملية في دفعة أو معاملة واحدة."],
            [<code>INVALID_CURSOR</code>, "400", "مؤشر ترقيم تم التلاعب به أو أُعيد استخدامه مع استعلام مختلف."],
            [<code>QUERY_TOO_COMPLEX</code>, "400", "تجاوز حدود الفلاتر/الترتيب/التداخل/الإسقاط، أو شجرة قواعد الأمان."],
            [<code>LIMIT_EXCEEDED</code>, "400", "قيمة limit خارج النطاق 1–500."],
            [<code>SUBSCRIPTION_LIMIT_EXCEEDED</code>, "400", "تجاوز 25 اشتراك WebSocket على اتصال واحد."],
            [<code>UNAUTHENTICATED</code>, "401", "مفتاح API أو رمز مصادقة مفقود أو غير صالح أو ملغى."],
            [<code>TOKEN_EXPIRED</code>, "401", "انتهاء صلاحية رمز Bearer أو الجلسة."],
            [<code>PERMISSION_DENIED</code>, "403", "نقص نطاق مفتاح sk_ أو رفض قواعد الأمان أو قيود الأصل/IP."],
            [<code>NOT_FOUND</code>, "404", "مستند أو مشروع غير موجود."],
            [<code>TRANSACTION_TIMEOUT</code>, "408", "تجاوزت معاملة OCC نافذتها التفاعلية البالغة 5,000 ms."],
            [<code>ALREADY_EXISTS</code>, "409", "create على مسار قائم أو تعريف فهرس مركّب مكرّر."],
            [<code>ABORTED_CONFLICT</code>, "409", "تغيّر إصدار أحد مستندات مجموعة القراءة قبل التزام المعاملة."],
            [<code>ALREADY_COMMITTED</code>, "409", "محاولة الالتزام بمعاملة التزمت مسبقاً."],
            [<code>ALREADY_ROLLED_BACK</code>, "409", "محاولة استخدام معاملة تم التراجع عنها."],
            [<code>FAILED_PRECONDITION</code>, "412", "فشل شرط ifVersion أو هدف تحويل غير صالح أو غياب فهرس مركّب مطلوب."],
            [<code>DOCUMENT_TOO_LARGE</code>, "413", "تجاوز حجم المستند المسلسل 1 MiB."],
            [<code>PAYLOAD_TOO_LARGE</code>, "413", "تجاوز حمولة الدفعة 5 MiB أو إطار WebSocket حد 64 KiB."],
            [<code>RESPONSE_TOO_LARGE</code>, "413", "تجاوز استجابة الاستعلام 4 MiB."],
            [<code>RATE_LIMITED</code>, "429", "تجاوز حد الطلبات في الثانية للمفتاح؛ تُضبط ترويسة Retry-After."],
            [<code>TOO_MANY_REQUESTS</code>, "429", "تقييد معدل عام."],
            [<code>QUOTA_EXCEEDED</code>, "429", "تجاوز حصة الخطة (مثل عدد الفهارس المركّبة أو العمليات)."],
            [<code>SLOW_CONSUMER_DISCONNECT</code>, "429", "تجاوز المخزن الصادر لـ WebSocket حد 1 MiB."],
            [<code>INTERNAL_ERROR</code>, "500", "خطأ خادم غير متوقع."],
            [<code>SERVICE_UNAVAILABLE</code>, "503", "تعذر الوصول إلى أحد المستويات أو التبعيات."],
            [<code>QUERY_DEADLINE_EXCEEDED</code>, "504", "تجاوز الاستعلام مهلة statement_timeout البالغة 5,000 ms."],
          ]}
        />
      </Section>

      <Section id="locked-v1-quotas" title="ثوابت SYSTEM_LIMITS الثابتة في @vellum/core">
        <P>
          تُفرض القيم التالية مباشرة داخل المحرك في <code>packages/core/src/limits.ts</code>:
        </P>
        <Table
          head={["الثابت", "القيمة الثابتة", "الخطأ عند التجاوز"]}
          rows={[
            [<code>MAX_DOCUMENT_BYTES</code>, "1,048,576 (1 MiB)", <code>DOCUMENT_TOO_LARGE</code>],
            [<code>MAX_PATH_DEPTH</code>, "10 مقاطع (5 مجموعات متداخلة)", <code>INVALID_DOCUMENT_PATH</code>],
            [<code>MAX_PATH_SEGMENT_BYTES</code>, "1,500 بايت UTF-8", <code>INVALID_DOCUMENT_PATH</code>],
            [<code>MAX_OBJECT_NESTING_DEPTH</code>, "20 مستوى", <code>MAX_NESTING_EXCEEDED</code>],
            [<code>MAX_FIELD_NAME_LENGTH</code>, "256 حرفاً", <code>INVALID_FIELD_NAME</code>],
            [<code>MAX_BATCH_OPERATIONS</code>, "100 عملية", <code>BATCH_SIZE_EXCEEDED</code>],
            [<code>MAX_BATCH_PAYLOAD_BYTES</code>, "5,242,880 (5 MiB)", <code>PAYLOAD_TOO_LARGE</code>],
            [<code>MAX_TRANSACTION_DURATION_MS</code>, "5,000 ms", <code>TRANSACTION_TIMEOUT</code>],
            [<code>MAX_WHERE_CLAUSES</code>, "10 شروط", <code>QUERY_TOO_COMPLEX</code>],
            [<code>MAX_DISJUNCTIVE_VALUES</code>, "30 عنصراً", <code>QUERY_TOO_COMPLEX</code>],
            [<code>MAX_ORDER_BY_FIELDS</code>, "3 حقول", <code>QUERY_TOO_COMPLEX</code>],
            [<code>DEFAULT_QUERY_LIMIT</code>, "50 مستنداً", "— (قيمة افتراضية)"],
            [<code>MAX_QUERY_LIMIT</code>, "500 مستند", <code>LIMIT_EXCEEDED</code>],
            [<code>MAX_QUERY_RESPONSE_BYTES</code>, "4,194,304 (4 MiB)", <code>RESPONSE_TOO_LARGE</code>],
            [<code>MAX_QUERY_EXECUTION_MS</code>, "5,000 ms", <code>QUERY_DEADLINE_EXCEEDED</code>],
            [<code>MAX_COMPOSITE_INDEXES_FREE</code>, "50 فهرساً لكل مشروع", <code>QUOTA_EXCEEDED</code>],
            [<code>MAX_COMPOSITE_INDEXES_PRO</code>, "200 فهرس لكل مشروع", <code>QUOTA_EXCEEDED</code>],
            [<code>MAX_WS_SUBSCRIPTIONS_PER_CONN</code>, "25 اشتراكاً", <code>SUBSCRIPTION_LIMIT_EXCEEDED</code>],
            [<code>MAX_WS_OUTBOUND_BUFFER_BYTES</code>, "1,048,576 (1 MiB)", <code>SLOW_CONSUMER_DISCONNECT</code>],
            [<code>RULES_AST_MAX_DEPTH</code>, "10 مستويات", <code>QUERY_TOO_COMPLEX</code>],
            [<code>RULES_AST_MAX_NODES</code>, "100 عقدة لكل قاعدة", <code>QUERY_TOO_COMPLEX</code>],
            [<code>TOMBSTONE_RETENTION_DAYS_DEFAULT</code>, "7 أيام", "— (نافذة احتفاظ)"],
            [<code>OUTBOX_RETENTION_HOURS</code>, "24 ساعة", "— (نافذة استئناف الوقت الفعلي)"],
          ]}
        />
        <H3 id="compiler-guards">حدود الحماية الإضافية في مُجمّع الاستعلام</H3>
        <UL
          items={[
            <><code>UNINDEXED_SCAN_CAP = 1,000</code> صف كسقف للمسح الاحتياطي غير المفهرس دون بتر صامت.</>,
            <><code>MAX_SELECT_FIELDS = 50</code> حقلاً في الإسقاط، و<code>MAX_FIELD_DEPTH = 16</code> مستوى في المسار النقطي.</>,
            <><code>MAX_TEXT_FILTER_LENGTH = 1,024</code> حرفاً لعوامل النص، و<code>MAX_TOTAL_DISJUNCTIVE_EXPANSIONS = 120</code> توسّع OR.</>,
          ]}
        />
      </Section>

      <Section id="handling-errors" title="التعامل الآمن مع الأخطاء وإعادة المحاولة">
        <CodeTabs
          tabs={[
            {
              label: "TypeScript",
              lang: "ts",
              code: `try {
  await db.collection("users").doc("u_123").update(
    { name: "Ada" },
    { ifVersion: 4 }
  );
} catch (err) {
  const e = err as { code?: string; status?: number; details?: Record<string, unknown>; requestId?: string };
  switch (e.code) {
    case "FAILED_PRECONDITION":
    case "ABORTED_CONFLICT":
      // أعد قراءة الإصدار الحالي ثم أعد محاولة العملية.
      break;
    case "RATE_LIMITED": {
      const ms = Number(e.details?.retryAfterMs ?? 1000);
      await new Promise((r) => setTimeout(r, ms));
      break;
    }
    case "PERMISSION_DENIED":
      // تحقق من قواعد الأمان أو صلاحيات المفتاح.
      break;
    default:
      throw err;
  }
}`,
            },
            {
              label: "HTTP / cURL",
              lang: "bash",
              code: `curl -sS -X POST \\
  "http://localhost:8080/v1/projects/<PROJECT_ID>/query" \\
  -H "x-vellum-api-key: pk_..." \\
  -H "content-type: application/json" \\
  -d '{"collectionPath":"users"}' \\
  | jq '{code: .error.code, requestId: .error.requestId}'`,
            },
          ]}
        />
        <Definitions
          items={[
            { term: <code>ABORTED_CONFLICT</code>, def: "آمن لإعادة تشغيل المعاملة بعد إعادة القراءة (تقوم runTransaction بذلك تلقائياً)." },
            { term: <code>RATE_LIMITED</code>, def: "تراجع وفق ترويسة Retry-After قبل إعادة المحاولة؛ لا تكرر في حلقة ضيقة." },
            { term: <><code>UNAUTHENTICATED</code> / <code>TOKEN_EXPIRED</code></>, def: "جدّد بيانات الاعتماد أولاً قبل إعادة المحاولة." },
            { term: <><code>PERMISSION_DENIED</code> / <code>INVALID_ARGUMENT</code> / <code>QUOTA_EXCEEDED</code></>, def: "أخطاء حتمية لا تحلّها إعادة المحاولة؛ اعرضها للمتصل وعالج السبب الجذري." },
          ]}
        />
        <Callout tone="warning" title="احتفظ بـ requestId في سجلات الحوادث">
          معرّف <code>requestId</code> هو الطريقة الآمنة لربط أي حادث بسجلات الخادم المنقّاة دون مشاركة
          مفاتيح أو رموز سرية. راجع أيضاً{" "}
          <PageLink slug="reference/errors" lang="ar">رموز الأخطاء وإرشادات إعادة المحاولة</PageLink>.
        </Callout>
      </Section>
    </Doc>
  );
}
