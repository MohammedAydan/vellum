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

const auditEntry = `CREATE TABLE IF NOT EXISTS security_audit_logs (
  seq BIGSERIAL PRIMARY KEY,
  id UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  actor_realm TEXT NOT NULL CHECK (actor_realm IN
    ('super_admin','customer_console','project_end_user','system','anonymous')),
  actor_id TEXT,
  org_id UUID,
  project_id UUID,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','denied','error')),
  details JSONB NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL,
  entry_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);`;

const trigger = `CREATE OR REPLACE FUNCTION prevent_immutable_table_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'SECURITY_VIOLATION: Table % is strictly append-only and cannot be modified or deleted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_immutable_security_audit_logs
  BEFORE UPDATE OR DELETE ON security_audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_immutable_table_mutation();`;

const chain = `key        = hkdfSync('sha256', masterKey, 'vellum-chain-salt-v1', 'security-audit-v1', 32)
entry_hash = hex(HMAC-SHA256(key, \`\${seq}|\${prevHash}|\${timestampIso}|\${canonicalSerialize(payload)}\`))
genesis    = '0'.repeat(64)
verify     = recompute every entry, compare with timingSafeEqual`;

const curl = `BASE=http://localhost:8080

# عرض سجل التدقيق العام والتحقق الحي من السلسلة المشفّرة (جلسة super_admin فقط):
curl -s "$BASE/v1/admin/security/audit-logs" \\
  -H "Authorization: Bearer $ADMIN_SESSION_TOKEN"
curl -s -X POST "$BASE/v1/admin/security/audit-logs/verify-chain" \\
  -H "Authorization: Bearer $ADMIN_SESSION_TOKEN"
# -> { "valid": true, "totalChecked": N, "firstCorruptedSeq": null, "reason": null }

# تقييد مفتاح API بأصول وعناوين IP محددة (جلسة customer_console):
curl -s -X PATCH "$BASE/v1/console/orgs/$ORG/projects/$PROJECT/keys/$KEY/restrictions" \\
  -H "Authorization: Bearer $CONSOLE_SESSION_TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"allowedOrigins":["https://app.example.com"],"allowedIps":[],"expiresAt":null}'`;

export default function Page() {
  return (
    <Doc
      title="الأمان والدفاع المتعدد الطبقات"
      description="نموذج التهديدات، وعزل RLS المحصّن، والمجالات الثلاثة، وحواجز الحمولة وتكلفة الاستعلام، وتأمين WebSocket، والحماية من SSRF، وسجل التدقيق المتسلسل المشفّر."
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
          <PageLink slug="end-user-auth" lang="ar">المستخدمون النهائيون والمجالات الثلاثة</PageLink>،
          وللقياس والفوترة راجع <PageLink slug="metering-and-billing" lang="ar">القياس والفوترة</PageLink>.
        </Callout>
      </Section>

      <Section id="threat-model" title="نموذج التهديدات">
        <Table
          head={["الأصل المحمي", "الحدود", "التهديد الرئيسي"]}
          rows={[
            ["مستندات العملاء", "مستوى البيانات /v1/projects/...", "الوصول العابر للمستأجرين، تهريب الحمولات، وتلويث النماذج الأولية"],
            ["بيانات المنصة وسجل التدقيق", "مستوى التحكم /v1/console و /v1/admin", "تصعيد الصلاحيات أو العبث بسجلات التدقيق"],
            ["مفاتيح API (pk_ / sk_)", "جميع نقاط HTTP وWebSocket", "السرقة، إعادة الاستخدام من أصول أو عناوين IP غير مصرح بها"],
            ["رموز الجلسات والمستخدمين", "المجالات الثلاثة", "خلط الرموز بين المجالات، وهجمات التخمين"],
            ["حالة الفوترة والحصص", "مستوى التحكم", "تجاوز الحصص أو التلاعب بدفتر القيود"],
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
            <>التحقق من أصل CSRF للكتابات المعتمدة على الكوكيز في <code>/v1/console/*</code> و<code>/v1/admin/*</code>.</>,
            <>قوائم السماح لـ Origin وIP على مفتاح API ← <code>403 ORIGIN_NOT_ALLOWED</code> / <code>IP_NOT_ALLOWED</code>.</>,
            <>حاجز الحصص <code>QuotaGuard.checkQuota</code> بزمن O(1) ← <code>429</code> / <code>402</code> مع ترويسة <code>x-vellum-quota-warning</code> عند 80% و95%.</>,
            <>تنفيذ المعالج ثم تسجيل القياس غير المعطّل.</>,
          ]}
        />
      </Section>

      <Section id="realms" title="عزل المجالات الثلاثة">
        <Table
          head={["المجال", "آلية الاعتماد", "السطح المخدوم"]}
          rows={[
            [<Badge tone="danger">super_admin</Badge>, "جلسة HS256 مرتبطة بالمجال + كوكي تحديث مع تحقق users.isPlatformSuperAdmin === true", "/v1/admin/* ولوحة /admin/"],
            [<Badge tone="info">customer_console</Badge>, "جلسة HS256 مرتبطة بالمجال + كوكي HttpOnly مع تحقق عضوية المؤسسة", "/v1/console/* ولوحة /"],
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
          <code>403 API_KEY_EXPIRED</code>. كما تفرض <code>verifyCsrfOrigin()</code> تطابق الأصل على
          كتابات لوحتَي التحكم.
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

      <Section id="audit-chain" title="سجل التدقيق غير القابل للتعديل والسلسلة المشفّرة">
        <Code lang="sql" title="جدول security_audit_logs" code={auditEntry} />
        <Code lang="sql" title="مُحفّز منع التعديل والحذف" code={trigger} />
        <Code lang="text" title="اشتقاق المفتاح وسلسلة HMAC-SHA256" code={chain} />
        <Callout tone="info" title="كشف العبث بدقة بتّ واحد">
          تُقارن الدالة <code>verifyHashChain()</code> كل قيد منذ <code>genesis = '0'.repeat(64)</code>{" "}
          باستخدام <code>timingSafeEqual</code> وتعيد{" "}
          <code>{"{ valid, totalChecked, firstCorruptedSeq, reason }"}</code>. كما يُفصل نطاق HKDF{" "}
          <code>security-audit-v1</code> تماماً عن <code>billing-ledger-v1</code>.
        </Callout>
      </Section>

      <Section id="threat-detector" title="كاشف التهديدات وقائمة الحظر التلقائية">
        <Table
          head={["الإشارة", "العتبة / النافذة", "الخطورة", "الإجراء التلقائي"]}
          rows={[
            ["فشل المصادقة المتكرر", "≥ 20 خلال 5 دقائق لكل IP", <code>high (brute_force)</code>, "حظر IP لمدة 15 دقيقة"],
            ["prototype_pollution / ssrf_attempt", "≥ 3 خلال 10 دقائق لكل IP", <code>critical</code>, "حظر IP لمدة 60 دقيقة"],
            ["cross_tenant_probe / 403-admin", "≥ 5 خلال 5 دقائق", <code>critical</code>, "تنبيه فوري للمشرف العام"],
            ["إغراق WebSocket", "60 رسالة / دقيقة / اتصال", <code>high (ws_flood)</code>, "إغلاق 1008 + تسجيل تهديد"],
          ]}
        />
      </Section>

      <Section id="endpoints" title="نقاط نهاية الأمان">
        <Api method="GET" path="/v1/admin/security/overview">
          <P>ملخص التهديدات حسب الخطورة، والحظر النشط، وسلامة السلسلة المشفّرة (<code>super_admin</code> فقط).</P>
        </Api>
        <Api method="POST" path="/v1/admin/security/audit-logs/verify-chain">
          <P>تحقق حيّ من سلامة سلسلة <code>security_audit_logs</code> بالكامل.</P>
        </Api>
        <Api method="POST" path="/v1/admin/security/blocklist">
          <P>حظر <code>ip</code> أو <code>api_key_id</code> أو <code>org_id</code> أو <code>project_id</code> (و<code>DELETE /:id</code> لفك الحظر).</P>
        </Api>
        <Api method="GET" path="/v1/console/orgs/:orgId/security/audit-logs">
          <P>سجل التدقيق المحصور بالمؤسسة، مع تقييد المفاتيح عبر <code>PATCH …/keys/:keyId/restrictions</code>.</P>
        </Api>
        <Code lang="bash" title="أمثلة cURL" code={curl} />
      </Section>
    </Doc>
  );
}
