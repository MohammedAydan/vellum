import {
  Api,
  Badge,
  Callout,
  Code,
  Doc,
  H3,
  P,
  PageLink,
  Section,
  Table,
  UL,
} from "../../ui";

const formulas = `overageReads    = max(0, usage.docReads    - plan.includedDocReads)
readCostCents   = ceil(overageReads    * plan.overageReadPer100kCents   / 100_000)
overageWrites   = max(0, usage.docWrites   - plan.includedDocWrites)
writeCostCents  = ceil(overageWrites   * plan.overageWritePer100kCents  / 100_000)
overageDeletes  = max(0, usage.docDeletes  - plan.includedDocDeletes)
deleteCostCents = ceil(overageDeletes  * plan.overageDeletePer100kCents / 100_000)

GB              = 1_073_741_824 bytes
storageGB       = ceil(max(0, usage.storageBytes - plan.includedStorageBytes) / GB)
storageCostCents= storageGB * plan.overageStoragePerGbCents
egressGB        = ceil(max(0, usage.egressBytes  - plan.includedEgressBytes)  / GB)
egressCostCents = egressGB  * plan.overageEgressPerGbCents

mauCostCents    = ceil(max(0, usage.authMau - plan.includedAuthMau)
                       * plan.overageMauPer1kCents / 1_000)

totalAmountCents = baseAmountCents + overageAmountCents   // سنتات صحيحة فقط`;

const chain = `key        = hkdfSync('sha256', masterKey, 'vellum-chain-salt-v1', 'billing-ledger-v1', 32)
entry_hash = hex(HMAC-SHA256(key, \`\${seq}|\${prevHash}|\${timestampIso}|\${canonicalSerialize(payload)}\`))
genesis    = '0'.repeat(64)
idempotency_key TEXT NOT NULL UNIQUE   // إعادة آمنة للتدفقات والتعديلات`;

const curl = `BASE=http://localhost:8080
ORG=<org-uuid>

# عرض العميل (جلسة console).
curl -s "$BASE/v1/console/orgs/$ORG/billing/summary" \\
  -H "Authorization: Bearer $CONSOLE_SESSION_TOKEN"
curl -s "$BASE/v1/console/orgs/$ORG/billing/plans" \\
  -H "Authorization: Bearer $CONSOLE_SESSION_TOKEN"
curl -s "$BASE/v1/console/orgs/$ORG/billing/invoices" \\
  -H "Authorization: Bearer $CONSOLE_SESSION_TOKEN"

# المالك: تغيير الخطة / تحديد سقف الإنفاق الصارم (سنتات صحيحة).
curl -s -X PATCH "$BASE/v1/console/orgs/$ORG/billing/subscription" \\
  -H "Authorization: Bearer $CONSOLE_SESSION_TOKEN" -H "content-type: application/json" \\
  -d '{"planId":"pro","monthlySpendCapCents":5000}'

# المدير (جلسة super-admin فقط): نظرة الإيرادات + إثبات الدفتر.
curl -s "$BASE/v1/admin/billing/overview" \\
  -H "Authorization: Bearer $ADMIN_SESSION_TOKEN"
curl -s -X POST "$BASE/v1/admin/billing/ledger/verify-chain" \\
  -H "Authorization: Bearer $ADMIN_SESSION_TOKEN"
# → { "valid": true, "totalChecked": N, "firstCorruptedSeq": null, "reason": null }

# إنشاء/اعتماد فواتير شهر.
curl -s -X POST "$BASE/v1/admin/billing/invoices/generate" \\
  -H "Authorization: Bearer $ADMIN_SESSION_TOKEN" -H "content-type: application/json" \\
  -d '{"billingMonth":"2026-11"}'`;

export default function Page() {
  return (
    <Doc
      title="القياس والفوترة"
      description="قياس في الذاكرة بزمن ثابت مع تفريغ كل ٥ ثوانٍ، ذاكرة حصص بمدة ١٠ ثوانٍ، خطط وسقف إنفاق صارم، تكاليف زيادة بالسنتات الصحيحة، دفتر حسابات غير قابل للتعديل بسلسلة مشفّرة، فواتير وتحقق من Stripe."
      eyebrow="التشغيل"
    >
      <Section id="overview" title="نظرة عامة">
        <P>
          للنظام المالي قاعدة أداء واحدة صارمة: <strong>لا كتابة متزامنة إلى قاعدة البيانات في المسار
          السريع</strong> (<code>getDocument</code>، <code>queryDocuments</code>،{" "}
          <code>setDocument</code>، <code>deleteDocument</code>، إطارات WS). القياس تراكم فروق في{" "}
          <code>Map</code> بزمن O(1)؛ وفحص الحصص قراءة ذاكرة بزمن O(1). PostgreSQL هي الخدمة الوحيدة
          ذات الحالة، وكل المبالغ سنتات صحيحة—لا أعداد عشرية طائرة.
        </P>
        <Callout tone="info" title="أسس مشتركة">
          بديلة السلسلة المشفّرة ومُحفّز عدم التعديل وترتيب الوسائط مشتركة مع{" "}
          <PageLink slug="security-and-defense" lang="ar">الأمان والدفاع المتعدد الطبقات</PageLink>.
          وتُغطى الحصص والحدود عمومًا في{" "}
          <PageLink slug="errors-and-limits" lang="ar">الحصص والحدود</PageLink>.
        </Callout>
      </Section>

      <Section id="metering" title="قياس في الذاكرة بزمن O(1)">
        <P>
          تعرض <code>UsageMeteringEngine</code> من <code>@vellum/billing</code> طرق{" "}
          <code>record*</code> متزامنة فقط على مسار الطلب. كل استدعاء يعدّل{" "}
          <code>PendingDelta</code> وإجمالي المؤسسة اللحظي ثم يعود—بلا إدخال/إخراج ولا{" "}
          <code>await</code>. مفتاح الـ Map هو{" "}
          <code>{"`${orgId}|${projectId}|${envId}|${YYYY-MM}`"}</code>. وتُزيل{" "}
          <code>authUsers: Set</code> تكرار المستخدمين النشطين شهريًا.
        </P>
        <Code
          lang="typescript"
          title="واجهة مسار الطلب (كلها void ومتزامنة)"
          code={`recordReads(orgId, projectId, envId, count): void
recordWrites(orgId, projectId, envId, count, storageDeltaBytes): void
recordDeletes(orgId, projectId, envId, count, storageDeltaBytes): void
recordEgress(orgId, projectId, envId, bytes): void
recordActiveAuthUser(orgId, projectId, envId, userId): void
recordWsConnectionDelta(orgId, projectId, envId, delta: 1 | -1): void
totalsFor(orgId): Readonly<UsageTotals>   // بطاقات اللوحة الحية`}
        />
        <H3 id="flush">تبادل Map ذري + تفريغ غير متزامن كل ٥ ثوانٍ</H3>
        <P>
          تُبدّل <code>flush()</code> متغير <code>pendingDeltas</code> إلى <strong>Map جديدة قبل أي
          إدخال/إخراج</strong>. لا تحجب معالجات الطلب عند التفريغ: الفروق المسجلة بعد التبديل تذهب إلى
          الخريطة الجديدة في الدورة التالية. يُنفّذ التفريغ <code>UPSERT</code> دفعيًا في ملخّصات
          الشهر/اليوم، ثم يلحق صف <code>usage_flush</code> في دفتر الحسابات بسلسلة مشفّرة. الفاصل
          الافتراضي <strong>5,000 مللي ثانية</strong>، وتضمن <code>stop()</code> تفريغًا أخيرًا عند
          SIGINT/SIGTERM.
        </P>
      </Section>

      <Section id="quota-guard" title="ذاكرة لقطة الحصص و QuotaGuard بزمن ثابت">
        <P>
          <code>QuotaGuard.checkQuota(orgId, op)</code> قراءة ذاكرة خالصة على لقطة تُحدَّث كل{" "}
          <strong>10 ثوانٍ</strong> مع إبطال بالدفع. العمليات: <code>read</code>، <code>write</code>،{" "}
          <code>delete</code>، <code>ws_connect</code>، <code>auth_signup</code>. ترتيب الفرض مُثبَّت:
        </P>
        <UL
          items={[
            <><code>status === 'suspended'</code> → <code>402 SUBSCRIPTION_SUSPENDED</code>.</>,
            <><code>hardLimitEnforced &amp;&amp; used &gt;= included</code> → <code>429 QUOTA_EXCEEDED</code> (مع metric/used/limit).</>,
            <><code>monthlySpendCapCents !== null &amp;&amp; calculateBillCents(...) &gt;= cap</code> → <code>402 MONTHLY_SPEND_CAP_REACHED</code> (currentCents/capCents).</>,
            <>وإلا يسمح؛ وعند ٨٠٪/٩٥٪ يُرفق <code>x-vellum-quota-warning: 80% | 95%</code>.</>,
          ]}
        />
        <P>الحاجز هو الخطوة ٧ من وساطة القلعة، قبل المعالج وقياس ما بعد المعالج.</P>
      </Section>

      <Section id="plans" title="جدول الخطط المُثبَّت">
        <P>
          تُزرع <code>billing_plans</code> بدقة عبر الترحيل <code>0008</code>. التخزين والإرسال بالبايت
          (الغيغابايت = 1,073,741,824 بايت)؛ والأسعار سنتات شهرية.
        </P>
        <Table
          head={["الخطة", "الأساس", "قراءات", "كتابات", "حذوف", "تخزين", "إرسال", "MAU", "WS"]}
          rows={[
            [<><Badge tone="info">free</Badge> المبتدئة</>, "$0", "1,500,000", "600,000", "600,000", "1 GiB", "10 GiB", "10,000", "50"],
            [<><Badge tone="success">pro</Badge> الدفع حسب الاستخدام</>, "$25.00", "5,000,000", "2,000,000", "1,000,000", "20 GiB", "100 GiB", "100,000", "1000"],
            [<><Badge tone="warning">enterprise</Badge> المؤسسات</>, "$299.00", "50,000,000", "20,000,000", "10,000,000", "200 GiB", "1024 GiB", "1,000,000", "10000"],
          ]}
        />
        <Table
          head={["الخطة", "سنت/100k قراءة", "سنت/100k كتابة", "سنت/100k حذف", "سنت/GB تخزين", "سنت/GB إرسال", "سنت/1k MAU", "حدود صارمة"]}
          rows={[
            ["free", "0", "0", "0", "0", "0", "0", "true"],
            ["pro", "6", "18", "2", "18", "12", "500", "false"],
            ["enterprise", "4", "12", "1", "14", "9", "300", "false"],
          ]}
        />
        <P>
          تفرض المجانية حدودًا صارمة (<code>429</code>) بمعدلات زيادة صفرية. أما المحترفة والمؤسسية
          فتستخدمان حصصًا لينة مع زيادات محسوبة. <code>org_subscriptions</code> مفتاحها{" "}
          <code>org_id</code>، وتفترض <code>free</code>، وتحمل الحالة و{" "}
          <code>monthly_spend_cap_cents</code> (<code>NULL</code> = بلا سقف) و{" "}
          <code>quota_override</code> بصيغة JSONB وطوابع تنبيه ٨٠٪/٩٥٪.
        </P>
      </Section>

      <Section id="spend-cap" title="سلوك سقف الإنفاق الصارم">
        <P>
          يعدّل المالك الاشتراك بالخطة والسقف والبريد المالي. يُقيَّم السقف في الخطوة ٣، بعد تعليق
          الاشتراك وحد الحصة الصارم. عندما تصل الفاتورة المتوقعة إلى{" "}
          <code>monthlySpendCapCents</code> أو تتجاوزها، تُرفض عمليات مستوى البيانات:
        </P>
        <Code
          lang="json"
          title="402 MONTHLY_SPEND_CAP_REACHED"
          code={`{
  "error": {
    "code": "MONTHLY_SPEND_CAP_REACHED",
    "status": 402,
    "currentCents": 2499,
    "capCents": 2500
  }
}`}
        />
        <P>
          تعرض اللوحة مفتاح سقف الإنفاق الشهري الصارم وحقلًا بالدولار؛ وتستدعي تغييرات الخطة/السقف{" "}
          <code>QuotaGuard.invalidate(orgId)</code>.
        </P>
      </Section>

      <Section id="formulas" title="معادلات الزيادة بالسنتات الصحيحة">
        <P>
          تستخدم <code>calculateMonthlyBill(plan, usage)</code>{" "}
          <strong>قسمة ceiling على أعداد صحيحة</strong>—بلا أي عدد عشري طائر:
        </P>
        <Code lang="text" title="المعادلات الدقيقة" code={formulas} />
        <P>
          مثال—خطة pro مع 5,150,000 قراءة و2,000,000 كتابة: 150,000 قراءة زائدة × 6 سنت / 100,000
          = 9 سنتات؛ وصفر كتابات زائدة. الإجمالي = 2,500 + 9 = <strong>2,509 سنت ($25.09)</strong>
          قبل بقية المقاييس. يؤكد اختبار التكامل دقة الفواتير بالسنت.
        </P>
      </Section>

      <Section id="ledger" title="دفتر الحسابات الثنائي غير القابل للتعديل والفواتير">
        <P>
          جدول <code>billing_ledger_entries</code> (الترحيل <code>0008</code>) للإلحاق فقط:
          <code>seq</code> و<code>org_id</code> و<code>billing_month</code> و<code>entry_type</code>{" "}
          (<code>usage_flush</code>، <code>plan_charge</code>، <code>overage_charge</code>،{" "}
          <code>credit_grant</code>، <code>payment_received</code>، <code>refund</code>،{" "}
          <code>admin_adjustment</code>) و<code>amount_cents</code> و<code>metric_snapshot</code> و{" "}
          <code>idempotency_key UNIQUE</code> و<code>prev_hash</code> و<code>entry_hash</code>. يُعيد
          المُحفّز <code>trg_immutable_billing_ledger</code> استخدام{" "}
          <code>prevent_immutable_table_mutation()</code> من الترحيل <code>0007</code>، لذا يُثير{" "}
          <code>UPDATE</code>/<code>DELETE</code> خطأ <code>SECURITY_VIOLATION</code>.
        </P>
        <Code lang="text" title="سلسلة دفتر الحسابات (نطاق billing-ledger-v1)" code={chain} />
        <P>
          <code>usage_monthly_rollups</code> هو مصدر الحقيقة المالي؛ ويوجد{" "}
          <code>project_usage_daily</code> التشغيلي السابق جنبًا إلى جنب لكنه ليس سجل الفوترة.
          تستخدم <code>billing_invoices</code> أرقام <code>INV-YYYYMM-0001</code>، وتخزّن الأساس
          والزيادة والخصومات والإجمالي بالسنتات مع <code>line_items</code> بصيغة JSONB، وهي فريدة لكل
          مؤسسة وشهر. تُنشئ <code>generateMonthlyInvoice()</code> فاتورة من الدفتر والملخّصات.
        </P>
      </Section>

      <Section id="webhook" title="تحقق Stripe HMAC ومنع إعادة التشغيل">
        <P>
          تحلّل <code>verifyStripeWebhook(rawBody, header, secret)</code> الترويسة{" "}
          <code>{ "t=<unix>,v1=<hex hmac-sha256>" }</code>، وتُعيد حساب{" "}
          <code>{"HMAC-SHA256(secret, `${t}.${rawBody}`)"}</code> عبر <code>timingSafeEqual</code>،
          وترفض الطوابع الأقدم من <strong>300 ثانية</strong>. عند النجاح تُدرج <code>event_id</code>{" "}
          في <code>billing_webhook_events</code> (مفتاح أساسي)—فُرّض أي تكرار قبل أي كتابة في الدفتر.
          تتحقق نقطة <code>POST /v1/webhooks/billing/stripe</code> بالتوقيع ومنع الإعادة فقط.
        </P>
      </Section>

      <Section id="endpoints" title="نقاط نهاية العملاء والمديرين">
        <H3 id="customer">وحدة تحكم العميل (جلسة + عضوية مؤسسة)</H3>
        <Api method="GET" path="/v1/console/orgs/:orgId/billing/summary">
          <P>الخطة، والاستخدام الحي مقابل الحصص، والتكلفة المتوقعة، والسلسلة اليومية والسقف.</P>
        </Api>
        <Api method="GET" path="/v1/console/orgs/:orgId/billing/plans">
          <P>سرد الخطط.</P>
        </Api>
        <Api method="PATCH" path="/v1/console/orgs/:orgId/billing/subscription">
          <P>للمالك فقط: تغيير الخطة والسقف والبريد المالي.</P>
        </Api>
        <Api method="GET" path="/v1/console/orgs/:orgId/billing/invoices">
          <P>سرد الفواتير؛ والتفاصيل في <code>/invoices/:invoiceId</code>.</P>
        </Api>
        <H3 id="admin">مدير المنصة (العملاء يحصلون على 403)</H3>
        <Api method="GET" path="/v1/admin/billing/overview">
          <P>الإيراد الشهري المتكرر، والزيادة المتوقعة، وأعلى المؤسسات والمقتربة من السقف.</P>
        </Api>
        <Api method="GET" path="/v1/admin/billing/orgs">
          <P>جدول فوترة المؤسسات؛ و<code>PATCH /orgs/:orgId/override</code> يغيّر الخطة/الحالة/الحصة أو يضيف تعديلًا.</P>
        </Api>
        <Api method="POST" path="/v1/admin/billing/invoices/generate">
          <P>إنشاء/اعتماد فواتير شهر.</P>
        </Api>
        <Api method="POST" path="/v1/admin/billing/ledger/verify-chain">
          <P>إثبات <code>verifyHashChain</code> حيّ على <code>billing_ledger_entries</code>.</P>
        </Api>
        <P>
          مسار لوحة العميل <code>/orgs/$orgId/billing</code> يعرض بطاقات الخطة/الاستخدام (قراءات،
          كتابات، حذوف، تخزين، إرسال، MAU، ذروة WS) ورسم ١٤/٣٠ يومًا وسقف الإنفاق ومحدد الخطة
          وجدول الفواتير. ومسار المدير <code>/billing</code> (يُقدَّم على <code>/admin/billing</code>)
          يعرض مؤشرات الإيراد والزيادة والقراءات/الكتابات والإرسال وجدول حصص المؤسسات وإجراءات
          التعليق/الخصم/التجاوز/إنشاء الفواتير. لا تُعرض أبدًا حمولات{" "}
          <code>documents.data</code> للعملاء على المدير.
        </P>
      </Section>

      <Section id="verify" title="كيفية التحقق">
        <P>مع تشغيل API على قاعدتي PostgreSQL، استخدم مسارات نقاط النهاية الحقيقية:</P>
        <Code lang="bash" title="جولة التحقق" code={curl} />
        <P>
          المتوقع: بعد تفريغ الـ ٥ ثوانٍ تطابق <code>billing/summary</code> ما تُظهره{" "}
          <code>totalsFor()</code>؛ وتحصل مؤسسة الخطة المجانية على <code>429 QUOTA_EXCEEDED</code>؛
          ومؤسسة pro ذات السقف على <code>402 MONTHLY_SPEND_CAP_REACHED</code>؛ ويعيد كلا طرفي
          التحقق <code>valid: true</code> حتى يُعبَّث بصف. الأدلة الآلية في{" "}
          <code>tests/integration/billing-metering-and-quotas.test.ts</code> و{" "}
          <code>tests/load/security-metering-overhead.ts</code> (زيادة &lt;0.5 مللي ثانية في المسار
          السريع؛ نتائج <code>PHASE5_REAL=1</code> في{" "}
          <code>docs/evidence/SECURITY-BILLING-PERFORMANCE.md</code>).
        </P>
      </Section>
    </Doc>
  );
}
