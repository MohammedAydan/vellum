import {
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

const rlsSnippet = `-- تطبيق سياق المستأجر والمهل في رحلة شبكة واحدة مُعامَلة (Neon / PgBouncer Safe)
SELECT
  set_config('app.current_project_id', $1, true),
  set_config('statement_timeout',      $2, true), -- الافتراضي 5000ms
  set_config('lock_timeout',           $3, true), -- الافتراضي 2000ms
  set_config('idle_in_transaction_session_timeout', $4, true); -- الافتراضي 15000ms

-- سياسة RLS فاشلة بأمان (Fail-Closed) على جميع جداول المستأجرين الـ 12:
CREATE POLICY tenant_rls_documents ON documents FOR ALL
  USING (project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid)
  WITH CHECK (project_id = NULLIF(current_setting('app.current_project_id', true), '')::uuid);`;

export default function Page() {
  return (
    <Doc
      title="الأمان والدفاع المتعدد الطبقات"
      description="نموذج التهديدات، وعزل RLS المحصّن، وحواجز الحمولة وتكلفة الاستعلام، وتأمين WebSocket، والحماية من SSRF، وقيود مفاتيح API."
      eyebrow="الأمان"
    >
      <Section id="overview" title="نظرة عامة">
        <P>
          يُحيط نظام <strong>Security Fortress</strong> بمستوى البيانات المبني على PostgreSQL بطبقات دفاع
          حتمية تفشل بأمان (Fail-Closed) دون إضافة أي خدمة حالة ثانية ودون كتابات قاعدة بيانات متزامنة على
          المسار الساخن. جميع الثوابت الموثّقة هنا قيم فعلية مفروضة في الشيفرة المصدرية.
        </P>
        <Callout tone="info" title="وثائق مكملة">
          لتأليف قواعد الوصول راجع <PageLink slug="security-rules" lang="ar">قواعد الأمان</PageLink> و{" "}
          <PageLink slug="security-rules-dsl" lang="ar">لغة قواعد الأمان</PageLink>، وللمصادقة راجع{" "}
          <PageLink slug="end-user-auth" lang="ar">مصادقة المستخدمين النهائيين</PageLink>.
        </Callout>
      </Section>

      <Section id="threat-model" title="نموذج التهديدات">
        <Table
          head={["الأصل المحمي", "الحدود", "التهديد الرئيسي"]}
          rows={[
            ["مستندات العملاء", "مستوى البيانات /v1/projects/...", "الوصول العابر للمستأجرين، تهريب الحمولات، وتلويث النماذج الأولية"],
            ["مفاتيح API (pk_ / sk_)", "جميع نقاط HTTP وWebSocket", "السرقة، إعادة الاستخدام من أصول أو عناوين IP غير مصرح بها"],
            ["رموز المستخدمين النهائيين", "مستوى البيانات", "رفض أي رمز غير موقّع بـ EdDSA، وهجمات التخمين"],
            ["الطلبات الخارجة من الخادم", "جلب JWKS / SMTP / Webhooks", "هجمات SSRF نحو الشبكات الخاصة وخدمات البيانات السحابية"],
          ]}
        />
      </Section>

      <Section id="rls-hardening" title="عزل المستأجرين المحصّن عبر PostgreSQL RLS">
        <P>
          تُفرض سياسات <code>ENABLE ROW LEVEL SECURITY</code> و<code>FORCE ROW LEVEL SECURITY</code> على
          جميع جداول المستأجرين الـ 12 في مستوى البيانات (<code>documents</code>،{" "}
          <code>document_indexes</code>، <code>document_index_entries</code>،{" "}
          <code>realtime_outbox</code>، <code>project_collections</code>،{" "}
          <code>project_auth_users</code>، <code>project_auth_identities</code>،{" "}
          <code>project_auth_sessions</code>، <code>project_auth_mfa</code>،{" "}
          <code>project_auth_tokens</code>، <code>transactions</code>،{" "}
          <code>batch_idempotency_keys</code>).
        </P>
        <Code lang="sql" title="سياق المعاملة المعزول في packages/database-data/src/rls.ts" code={rlsSnippet} />
        <UL
          items={[
            <>
              <strong>تحقق مسبق قبل سحب أي اتصال:</strong> تتحقق <code>withTenantContext()</code> من صحة
              UUID (وترفض UUID الصفري افتراضياً)، ومن حدود المهل (1 إلى 300,000 ms)، ومن أسماء الأدوار
              (مع حظر الأدوار المميزة مثل <code>postgres</code> و<code>superuser</code> و
              <code>neon_superuser</code> و<code>rdsadmin</code> و<code>pg_*</code>).
            </>,
            <>
              <strong>معاملة محلية بالكامل (<code>is_local = true</code>):</strong> لا تتسرب أي إعدادات GUC
              إلى اتصال مجمّع في PgBouncer أو Neon. وإذا فشل <code>ROLLBACK</code> عند حدوث خطأ، تُمرّر
              <code>withTenantContext</code> الخطأ إلى <code>client.release(destroyError)</code> لتدمير
              الاتصال الملوّث ومنع أي تداخل بين المستأجرين.
            </>,
            <>
              <strong>تطهير المطالبات (Claims Sanitization):</strong> تُفحص <code>app.current_claims</code>{" "}
              بحد أقصى 4,096 بايت و32 مفتاحاً وعمق 3 مستويات مع إزالة مفاتيح <code>__proto__</code> و
              <code>constructor</code> و<code>prototype</code> ورفض أحرف التحكم.
            </>,
          ]}
        />
      </Section>

      <Section id="middleware-order" title="ترتيب طبقات الحماية في الطلب">
        <UL
          items={[
            <>ترويسات الأمان القياسية (<code>securityHeaders</code>).</>,
            <>فحص قائمة الحظر الفورية — <code>isBlocked(ip)</code> بزمن <code>&lt;0.002 ms</code> ← <code>403</code> فوراً.</>,
            <>سقف حجم الجسم — 1 MiB للمستند المفرد و5 MiB للدفعة ← <code>413 PAYLOAD_TOO_LARGE</code>.</>,
            <><code>assertSafeJsonPayload</code> ← <code>400 INVALID_ARGUMENT</code> مع تسجيل تهديد.</>,
            <>قوائم السماح لـ Origin وIP على مفتاح API ← <code>403 ORIGIN_NOT_ALLOWED</code> / <code>IP_NOT_ALLOWED</code>.</>,
            <>حاجز الحصص <code>QuotaGuard.checkQuota</code> بزمن O(1) ← <code>429</code> / <code>402</code> مع ترويسة <code>x-vellum-quota-warning</code> عند 80% و95%.</>,
            <>تنفيذ المعالج ثم تسجيل القياس غير المعطّل.</>,
          ]}
        />
      </Section>

      <Section id="credentials" title="اعتماد المستخدمين النهائيين">
        <Table
          head={["بيانات الاعتماد", "آلية الاعتماد", "السطح المخدوم"]}
          rows={[
            [<Badge tone="success">project_end_user</Badge>, "رمز EdDSA (Ed25519) فقط بنوع vellum+enduser+jwt ومفتاح خاص بكل مشروع؛ بلا أي رجوع إلى HS256", "مستوى البيانات /v1/projects/..."],
          ]}
        />
      </Section>

      <Section id="payload-guard" title="حاجز الحمولة وتكلفة الاستعلام">
        <H3 id="payload">assertSafeJsonPayload</H3>
        <Table
          head={["الثابت", "الحد الأقصى", "الاستجابة عند التجاوز"]}
          rows={[
            [<code>maxDocumentBytes</code>, "1,048,576 (1 MiB)", <code>413 PAYLOAD_TOO_LARGE</code>],
            [<code>maxBatchBytes</code>, "5,242,880 (5 MiB)", <code>413 PAYLOAD_TOO_LARGE</code>],
            [<code>maxJsonDepth</code>, "20 مستوى", <code>400 INVALID_ARGUMENT</code>],
            [<code>maxObjectKeys</code>, "500 مفتاح تراكمي", <code>400 INVALID_ARGUMENT</code>],
            [<code>maxArrayLength</code>, "5,000 عنصر", <code>400 INVALID_ARGUMENT</code>],
          ]}
        />
        <P>
          تُرفض مفاتيح تلويث النماذج الأولية (<code>__proto__</code>، <code>constructor</code>،{" "}
          <code>prototype</code>) وبايتات <code>\u0000</code> في أي مسار أو اسم حقل قبل دخول محرك البيانات.
        </P>
        <H3 id="query-cost">حاجز تكلفة الاستعلام (assertQueryCost)</H3>
        <Table
          head={["الثابت", "السقف", "الثابت", "السقف"]}
          rows={[
            [<code>MAX_WHERE_CLAUSES</code>, "15 (ومحرك الاستعلام يفرض 10)", <code>MAX_OR_BRANCHES</code>, "10"],
            [<code>MAX_IN_ARRAY_SIZE</code>, "50 (ومحرك الاستعلام يفرض 30)", <code>MAX_INCLUDE_DEPTH</code>, "3"],
            [<code>MAX_INCLUDE_TOTAL_DOCS</code>, "100", <code>MAX_QUERY_LIMIT</code>, "500"],
            [<code>MAX_TEXT_SEARCH_LENGTH</code>, "200 حرف", <code>MAX_LIKE_WILDCARDS</code>, "5"],
          ]}
        />
      </Section>

      <Section id="websocket" title="تأمين WebSocket وحماية SSRF">
        <H3 id="ws-limits">حدود WebSocket المحصّنة</H3>
        <Table
          head={["الإعداد", "القيمة الثابتة", "ملاحظة"]}
          rows={[
            [<code>maxConcurrentWs</code>, "حسب الخطة (50 / 1,000 / 10,000)", "فحص QuotaGuard عند الترقية"],
            [<code>MAX_WS_PER_IP</code>, "50 اتصالاً", "حد لكل عنوان IP"],
            [<code>MAX_WS_FRAME_BYTES</code>, "65,536 (64 KiB)", "سقف الإطار الوارد"],
            [<code>MAX_SUBSCRIPTIONS_PER_SOCKET</code>, "25 اشتراكاً", "يطابق SYSTEM_LIMITS"],
            ["نبض Ping/Pong ومهلة الخمول", "30 ثانية", "قطع الاتصالات الميتة"],
            ["معدل الرسائل", "60 رسالة / دقيقة / اتصال", "التجاوز يغلق بـ 1008 ويسجل ws_flood"],
            ["المخزن الصادر", "1 MiB", "فصل المستهلك البطيء"],
          ]}
        />
        <H3 id="ssrf">حاجز SSRF (assertSafeExternalUrl)</H3>
        <P>
          تستعلم <code>assertSafeExternalUrl()</code> من DNS عبر{" "}
          <code>dns.promises.lookup({"{ all: true }"})</code> وترفض الطلب إذا وقع <strong>أي عنوان</strong>{" "}
          ضمن النطاقات الخاصة أو المحلية (<code>127.0.0.0/8</code>، <code>::1</code>،{" "}
          <code>10/8</code>، <code>172.16/12</code>، <code>192.168/16</code>،{" "}
          <code>169.254/16</code>، <code>fe80::/10</code>، <code>100.64/10</code>،{" "}
          <code>fc00::/7</code>، <code>0.0.0.0/8</code>)، وتسمح بـ <code>https:</code> فقط في الإنتاج.
        </P>
      </Section>

      <Section id="keys-csrf" title="قيود المفاتيح وCSRF وترويسات الأمان">
        <P>
          تضيف ترحيلة <code>0007</code> العمودين <code>allowed_origins</code> و<code>allowed_ips</code>{" "}
          (بصيغة JSONB) إلى جدول <code>api_keys</code>؛ المصفوفة الفارغة تعني غير مقيد، وأي مخالفة تعيد{" "}
          <code>403 ORIGIN_NOT_ALLOWED</code> أو <code>403 IP_NOT_ALLOWED</code> أو{" "}
          <code>403 API_KEY_EXPIRED</code>.
        </P>
        <Table
          head={["الترويسة", "القيمة"]}
          rows={[
            [<code>Strict-Transport-Security</code>, "max-age=63072000; includeSubDomains (في الإنتاج فقط)"],
            [<code>X-Content-Type-Options</code>, "nosniff"],
            [<code>X-Frame-Options</code>, "DENY"],
            [<code>Cross-Origin-Opener-Policy</code>, "same-origin"],
            [<code>Permissions-Policy</code>, "camera=(), microphone=(), geolocation=()"],
            [<code>Content-Security-Policy</code>, "صارمة لصفحات HTML فقط — بلا unsafe-inline أو unsafe-eval"],
          ]}
        />
      </Section>


      <Section id="threat-detector" title="كاشف التهديدات وقائمة الحظر التلقائية">
        <Table
          head={["الإشارة", "العتبة / النافذة", "الخطورة", "الإجراء التلقائي"]}
          rows={[
            ["فشل المصادقة المتكرر", "≥ 20 خلال 5 دقائق لكل IP", <code>high (brute_force)</code>, "حظر IP لمدة 15 دقيقة"],
            ["prototype_pollution / ssrf_attempt", "≥ 3 خلال 10 دقائق لكل IP", <code>critical</code>, "حظر IP لمدة 60 دقيقة"],
            ["cross_tenant_probe / 403-admin", "≥ 5 خلال 5 دقائق", <code>critical</code>, "تنبيه فوري وتسجيل تهديد"],
            ["إغراق WebSocket", "60 رسالة / دقيقة / اتصال", <code>high (ws_flood)</code>, "إغلاق 1008 + تسجيل تهديد"],
          ]}
        />
      </Section>

    </Doc>
  );
}
