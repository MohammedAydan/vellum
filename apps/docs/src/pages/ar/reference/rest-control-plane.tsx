import type { ReactNode } from "react";
import {
  Api,
  Callout,
  Code,
  Doc,
  H3,
  PageLink,
  P,
  Section,
  Table,
  UL,
} from "../../../ui";

/** Inline LTR span for technical identifiers inside Arabic prose. */
const IC = ({ children }: { children: ReactNode }) => <code dir="ltr">{children}</code>;

export default function Page() {
  return (
    <Doc
      title="واجهة REST لمستوى التحكم"
      description="مرجع المصادقة والمؤسسات والمشاريع والمفاتيح ومجموعات القواعد والقياس. ثلاثة مجالات معزولة، ولكل مجال رموزه وملف تعريف الارتباط الخاص به."
      eyebrow="المرجع — مستوى التحكم"
    >
      <Section id="realms" title="المجالات الثلاثة">
        <P>
          مستوى التحكم ليس واجهة واحدة ذات صلاحيات متدرّجة، بل ثلاثة مجالات مصادقة منفصلة تماماً. لكل مجال خدمة
          جلسات خاصة به توقّع رموز الوصول وتتحقق منها، وملف تعريف ارتباط HttpOnly خاص به يحمل رمز التحديث. الرمز
          الصادر عن مجال لا يُقبل في مجال آخر حتى لو كان المستخدم نفسه.
        </P>
        <Table
          head={["المجال", "البادئة", "رمز التحديث", "الجمهور"]}
          rows={[
            [
              <IC>SUPER_ADMIN</IC>,
              <IC>/v1/admin/**</IC>,
              <IC>vellum_admin_rt</IC>,
              <>مشغّلو المنصة؛ المسار <IC>/v1/admin/auth</IC> للتحقق من المستخدمين النهائيين.</>,
            ],
            [
              <IC>CUSTOMER_CONSOLE</IC>,
              <IC>/v1/console/**</IC>,
              <IC>vellum_console_rt</IC>,
              "عملاء المنصة؛ يديرون مؤسساتهم ومشاريعهم من لوحة التحكم.",
            ],
            [
              <IC>PROJECT_END_USER</IC>,
              <IC>/v1/projects/:projectId/auth/**</IC>,
              "جلسة داخل قاعدة البيانات",
              "المستخدمون النهائيون لتطبيقك؛ رموز EdDSA مقيّدة بالمشروع.",
            ],
          ]}
        />
        <Callout tone="danger" title="فصل صارم للرموز">
          <P>
            رموز <IC>SUPER_ADMIN</IC> موقّعة بخدمة الجلسات الفائقة، ورموز <IC>CUSTOMER_CONSOLE</IC> موقّعة بخدمة
            جلسات العميل. أي حارِز للتحقق يستقبل رمزاً من المجال الخطأ يرفضه بـ <IC>UNAUTHENTICATED</IC>؛ لا يوجد
            قبول متبادل ولا تراجع إلى مجال آخر.
          </P>
        </Callout>
        <P>
          تُخزَّن تجزئة SHA-256 فقط لرموز التحديث في <IC>control_plane_refresh_sessions</IC>. التدوير لمرة واحدة
          مع نافذة سماح <IC>15</IC> ثانية للتبويبات المتزامنة؛ وأي إعادة استخدام خارج النافذة يُلغي كل جلسات المستخدم
          في ذلك المجال.
        </P>
      </Section>

      <Section id="customer-auth" title="مصادقة العملاء وجلسة Console">
        <P>
          يبدأ عميل المنصة بحساب أسفل <IC>/v1/auth</IC>. عند التسجيل يُنشأ تلقائياً مؤسسة ومشروع افتراضي
          ومفتاح API. تُعاد الجلسة في الجسم وفي ملف تعريف ارتباط <IC>vellum_console_rt</IC>. التحقق
          من كلمة المرور غير متزامن بخوارزمية scrypt بمعاملات <IC>N=2^14, r=8, p=1</IC>.
        </P>

        <Api method="POST" path="/v1/auth/sign-up/email">
          <P>ينشئ حساب عميل والمؤسسة والمشروع الافتراضي ومفتاح التطوير، ويعيد جلسة Console.</P>
          <P>الرؤوس المطلوبة: <IC>Content-Type: application/json</IC>. لا مصادقة مسبقة.</P>
          <Code lang="json" title="طلب" code={`{
  "name": "Amina Hassan",
  "email": "amina@example.com",
  "password": "a-strong-password"
}`} />
          <Code lang="json" title="201 Created" code={`{
  "success": true,
  "user": {
    "id": "usr_7a2f",
    "name": "Amina Hassan",
    "email": "amina@example.com",
    "platformRole": "customer"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6ImFjY2VzcyJ9…",
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6ImFjY2VzcyJ9…",
  "refreshToken": "k9Pq2xRt8vLm5nZ1…",
  "organization": {
    "id": "org_3d91",
    "slug": "amina-hassan-lk3p9",
    "name": "Amina Hassan's Organization",
    "planId": "free"
  },
  "project": {
    "id": "proj_7c1f",
    "slug": "default",
    "name": "Default Project"
  },
  "apiKey": { "id": "key_5b20", "keyPrefix": "pk_1a2b3c4d" },
  "expiresAt": "2026-11-18T09:30:00.000Z"
}`} />
        </Api>

        <Api method="POST" path="/v1/auth/sign-in/email">
          <P>
            يتحقق من كلمة المرور ويعيد جلسة جديدة. غياب تجزئة كلمة مرور مخزّنة يعني فشلاً؛ لا توجد ثغرة «تعيين
            كلمة المرور عند أول دخول». معدل المحاولات محدود بـ <IC>10</IC> محاولات كل <IC>15</IC> دقيقة لكل زوج
            (عنوان IP، بريد إلكتروني).
          </P>
          <P>الرؤوس المطلوبة: <IC>Content-Type: application/json</IC>.</P>
          <Code lang="json" title="طلب" code={`{
  "email": "amina@example.com",
  "password": "a-strong-password"
}`} />
          <Code lang="json" title="200 OK" code={`{
  "success": true,
  "user": {
    "id": "usr_7a2f",
    "name": "Amina Hassan",
    "email": "amina@example.com",
    "platformRole": "customer"
  },
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6ImFjY2VzcyJ9…",
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6ImFjY2VzcyJ9…",
  "refreshToken": "m2Nq8vLx4pR7sT0w…",
  "expiresAt": "2026-11-18T09:30:00.000Z"
}`} />
        </Api>

        <Api method="POST" path="/v1/console/auth/refresh">
          <P>
            نقطة عامة مُعفاة من حارِز Console؛ تتحقق من رمز التحديث نفسه وتديره. يُقرأ الرمز من الجسم أو من ملف
            التعريف <IC>vellum_console_rt</IC>، ويُعاد ملف تعريف مُحدَّث مع زوج رموز جديد.
          </P>
          <P>الرؤوس المطلوبة: ملف تعريف <IC>vellum_console_rt</IC> أو حقل <IC>refreshToken</IC> في الجسم.</P>
          <Code lang="json" title="طلب" code={`{
  "refreshToken": "k9Pq2xRt8vLm5nZ1…"
}`} />
          <Code lang="json" title="200 OK" code={`{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6ImFjY2VzcyJ9…",
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6ImFjY2VzcyJ9…",
  "refreshToken": "p4Zr1xKt9wM6nQ2v…",
  "expiresAt": "2026-11-18T09:45:00.000Z",
  "user": {
    "id": "usr_7a2f",
    "name": "Amina Hassan",
    "email": "amina@example.com",
    "platformRole": "customer"
  }
}`} />
        </Api>

        <Api method="GET" path="/v1/auth/session">
          <P>يتحقق من رمز الوصول المقدم ويعيد مطالباته؛ غياب رأس التفويض يُعيد <IC>session: null</IC>.</P>
          <P>الرؤوس المطلوبة: <IC>Authorization: Bearer &lt;access-token&gt;</IC>.</P>
          <Code lang="json" title="200 OK" code={`{
  "session": {
    "valid": true,
    "uid": "usr_7a2f",
    "claims": {
      "sub": "usr_7a2f",
      "uid": "usr_7a2f",
      "role": "customer",
      "orgIds": ["org_3d91"],
      "typ": "access",
      "jti": "jti_01J9Z"
    },
    "expiresAt": "2026-11-18T09:30:00.000Z"
  }
}`} />
        </Api>

        <Api method="POST" path="/v1/auth/sign-out">
          <P>يلغي جلسة التحديث إذا حمل الطلب رمز تحديث صالحاً، وإلا تكون العملية بلا أثر.</P>
          <P>الرؤوس المطلوبة: <IC>Authorization: Bearer &lt;token&gt;</IC> اختيارياً.</P>
          <Code lang="json" title="200 OK" code={`{
  "success": true,
  "message": "Signed out successfully"
}`} />
        </Api>

        <Api method="GET" path="/v1/auth/mfa/status">
          <P>حالة تسجيل TOTP للمستخدم الحالي. جميع نقاط <IC>/v1/auth/mfa/**</IC> تتطلّب جلسة صالحة.</P>
          <P>الرؤوس المطلوبة: <IC>Authorization: Bearer &lt;access-token&gt;</IC>.</P>
          <Code lang="json" title="200 OK" code={`{
  "enabled": true,
  "factorType": "totp",
  "enrolledAt": "2026-11-10T12:00:00.000Z"
}`} />
        </Api>
      </Section>

      <Section id="console" title="واجهة Console">
        <P>
          تستخدم لوحة تحكم العميل هذه الواجهة بدلاً من مفاتيح API الرئيسية. كل طلب يتطلّب جلسة{" "}
          <IC>CUSTOMER_CONSOLE</IC> وفحص عضوية في المؤسسة، وكل عملية تغيير تُسجَّل في سجل التدقيق. تُترجم الطلبات إلى
          استدعاءات لمحرك المستندات أو متجر التحكم؛ لا يحتوي معالج الطريق على SQL ولا تقييم قواعد.
        </P>

        <Api method="GET" path="/v1/console/organizations">
          <P>المؤسسات التي يملكها المستخدم أو عضو فيها. أصحاب الدورين <IC>owner</IC> و<IC>admin</IC> يرون الدليل كاملاً.</P>
          <P>الرؤوس المطلوبة: جلسة Console (ملف <IC>vellum_console_rt</IC> أو رمز وصول).</P>
          <Code lang="json" title="200 OK" code={`[
  {
    "id": "org_3d91",
    "slug": "amina-hassan-lk3p9",
    "name": "Amina Hassan's Organization",
    "billingEmail": "amina@example.com",
    "planId": "free",
    "status": "active"
  }
]`} />
        </Api>

        <Api method="GET" path="/v1/console/organizations/:orgId/projects">
          <P>مشاريع مؤسسة محددة، بعد التحقق من عضوية المستخدم فيها.</P>
          <P>الرؤوس المطلوبة: جلسة Console.</P>
          <Code lang="json" title="200 OK" code={`[
  {
    "id": "proj_7c1f",
    "organizationId": "org_3d91",
    "slug": "default",
    "name": "Default Project",
    "status": "active"
  }
]`} />
        </Api>

        <Api method="POST" path="/v1/console/projects/:projectId/documents/*">
          <P>
            نسخة Console من إنشاء المستندات، تتطلب صلاحية كتابة على المشروع. تُسجَّل عملية{" "}
            <IC>console.document.created</IC> في سجل التدقيق. تطبّق قواعد الأمان بمعرّف المستخدم من الجلسة.
          </P>
          <P>الرؤوس المطلوبة: جلسة Console.</P>
          <Code lang="json" title="طلب" code={`{
  "data": {
    "name": "Amina",
    "email": "amina@example.com",
    "ownerId": "usr_7a2f"
  }
}`} />
          <Code lang="json" title="201 Created" code={`{
  "path": "users/usr_7a2f",
  "collectionPath": "users",
  "collectionGroup": "users",
  "documentId": "usr_7a2f",
  "data": { "name": "Amina", "email": "amina@example.com", "ownerId": "usr_7a2f" },
  "sizeBytes": 112,
  "version": 1,
  "createdAt": "2026-11-18T12:00:00.000Z",
  "updatedAt": "2026-11-18T12:00:00.000Z"
}`} />
        </Api>

        <Api method="GET" path="/v1/console/projects/:projectId/indexes">
          <P>قائمة الفهارس المركّبة في المشروع، كما في مستوى البيانات، لكن بجلسة Console.</P>
          <P>الرؤوس المطلوبة: جلسة Console.</P>
          <Code lang="json" title="200 OK" code={`{
  "indexes": [
    {
      "id": "idx_9f3a21",
      "collectionPath": "users",
      "fields": [{ "fieldPath": "email", "direction": "asc" }],
      "status": "ready",
      "errorMessage": null
    }
  ]
}`} />
        </Api>

        <Api method="POST" path="/v1/console/projects/:projectId/rulesets">
          <P>
            ينشر مجموعة قواعد جديدة بعد التحقق من شجرة AST وفق مخطط v1 (عمق <IC>10</IC> كحد أقصى، و
            <IC>100</IC> عقدة كحد أقصى). القواعد غير الصالحة تُرفض بـ <IC>400 INVALID_ARGUMENT</IC> قبل أي نشر، وتُبطل
            ذاكرة التخزين المؤقت عبر <IC>NOTIFY</IC>.
          </P>
          <P>الرؤوس المطلوبة: جلسة Console بصلاحية كتابة.</P>
          <Code lang="json" title="طلب" code={`{
  "rulesAst": {
    "schemaVersion": "1.0",
    "rules": [
      {
        "pattern": "users/{uid}",
        "allow": {
          "op": "==",
          "left": { "var": "auth.uid" },
          "right": { "var": "resource.ownerId" }
        }
      }
    ]
  }
}`} />
          <Code lang="json" title="201 Created" code={`{
  "id": "rules_2f8c",
  "projectId": "proj_7c1f",
  "version": 3,
  "rulesAst": {
    "schemaVersion": "1.0",
    "rules": [
      {
        "pattern": "users/{uid}",
        "allow": {
          "op": "==",
          "left": { "var": "auth.uid" },
          "right": { "var": "resource.ownerId" }
        }
      }
    ]
  },
  "publishedAt": "2026-11-18T12:10:00.000Z"
}`} />
        </Api>

        <Api method="POST" path="/v1/console/projects/:projectId/api-keys">
          <P>
            ينشئ مفتاحاً للمشروع. القيمة <IC>publishable</IC> أو <IC>public</IC> تُنتج مفتاحاً عاماً؛ وأي
            قيمة أخرى تُنتج مفتاح خادم. المفتاح الخام يُعاد مرة واحدة فقط في <IC>rawKey</IC>.
          </P>
          <P>الرؤوس المطلوبة: جلسة Console بصلاحية كتابة.</P>
          <Code lang="json" title="طلب" code={`{
  "name": "Backend server",
  "keyType": "server"
}`} />
          <Code lang="json" title="201 Created" code={`{
  "apiKey": {
    "id": "key_9c41",
    "projectId": "proj_7c1f",
    "name": "Backend server",
    "keyType": "server",
    "keyPrefix": "sk_4d8e9f2a",
    "scopes": ["documents:read", "documents:write", "indexes:manage"],
    "createdAt": "2026-11-18T12:15:00.000Z"
  },
  "rawKey": "sk_4d8e9f2a7b6c1d0e"
}`} />
        </Api>

        <Api method="DELETE" path="/v1/console/projects/:projectId/api-keys/:keyId">
          <P>يلغي المفتاح بعد التحقق من انتمائه إلى المشروع المطلوب، ويبطل نسخة الذاكرة المؤقتة فوراً.</P>
          <P>الرؤوس المطلوبة: جلسة Console بصلاحية كتابة.</P>
          <Code lang="json" title="200 OK" code={`{
  "success": true,
  "revoked": {
    "id": "key_9c41",
    "keyPrefix": "sk_4d8e9f2a",
    "revokedAt": "2026-11-18T12:20:00.000Z"
  }
}`} />
        </Api>
      </Section>

      <Section id="admin" title="واجهة المشغّل">
        <P>
          هذه الواجهة مخصّصة لمشغّلي المنصة وتتطلب جلسة <IC>SUPER_ADMIN</IC>. الإعداد الأولي ينشئ المالك الرئيسي
          مرة واحدة فقط. جميع القراءات من قياس حقيقي في PostgreSQL، وكل استجابة تمرّ عبر حاجز إزالة الأسرار وحاجز
          الخصوصية قبل الإرسال.
        </P>

        <Api method="GET" path="/v1/admin/setup-status">
          <P>فحص عام يخبر ما إذا كانت المنصة مُهيَّأة، دون كشف أي بيانات حساسة.</P>
          <P>الرؤوس المطلوبة: لا شيء.</P>
          <Code lang="json" title="200 OK" code={`{
  "initialized": true,
  "ownerCount": 1,
  "requiresSetup": false,
  "totalUsers": 14
}`} />
        </Api>

        <Api method="POST" path="/v1/admin/setup-owner">
          <P>ينشئ حساب المالك الرئيسي ومنحه امتيازات المجال الفائق. يفشل بـ <IC>409 ALREADY_EXISTS</IC> إذا وُجد مالك.</P>
          <P>الرؤوس المطلوبة: <IC>Content-Type: application/json</IC>.</P>
          <Code lang="json" title="طلب" code={`{
  "name": "Platform Owner",
  "email": "owner@example.com",
  "password": "at-least-8-chars"
}`} />
          <Code lang="json" title="201 Created" code={`{
  "success": true,
  "user": {
    "id": "usr_owner",
    "name": "Platform Owner",
    "email": "owner@example.com",
    "platformRole": "owner"
  },
  "token": "eyJhbGciOiJIUzI1NiJ9…",
  "accessToken": "eyJhbGciOiJIUzI1NiJ9…",
  "refreshToken": "q7Wz3xRt5vN1mL8s…",
  "expiresAt": "2026-11-18T09:30:00.000Z"
}`} />
        </Api>

        <Api method="POST" path="/v1/admin/login">
          <P>دخول المشغّل. الأدوار المقبولة <IC>owner</IC> و<IC>admin</IC> و<IC>support_readonly</IC>، والحساب الموقوف مرفوض.</P>
          <P>الرؤوس المطلوبة: <IC>Content-Type: application/json</IC>؛ ويُضبط ملف <IC>vellum_admin_rt</IC> في الاستجابة.</P>
          <Code lang="json" title="طلب" code={`{
  "email": "owner@example.com",
  "password": "at-least-8-chars"
}`} />
          <Code lang="json" title="200 OK" code={`{
  "success": true,
  "user": {
    "id": "usr_owner",
    "name": "Platform Owner",
    "email": "owner@example.com",
    "platformRole": "owner"
  },
  "accessToken": "eyJhbGciOiJIUzI1NiJ9…",
  "refreshToken": "r8Xy4mKt6wP2nQ9s…",
  "expiresAt": "2026-11-18T09:30:00.000Z"
}`} />
        </Api>

        <Api method="GET" path="/v1/admin/overview">
          <P>نظرة على الكتلة: عدد المستأجرين والمشاريع والمفاتيح والمستخدمين، وحالة قاعدتي البيانات، وقياسات الاتصال والصندوق.</P>
          <P>الرؤوس المطلوبة: جلسة Super Admin.</P>
          <Code lang="json" title="200 OK" code={`{
  "status": "healthy",
  "version": "0.0.1",
  "tenantsCount": 12,
  "projectsCount": 31,
  "keysCount": 87,
  "usersCount": 14,
  "planes": { "controlDb": "connected", "dataDb": "connected" },
  "metrics": [
    {
      "time": "2026-11-18",
      "qps": 3.42,
      "p95Ms": 0,
      "outboxLag": 0,
      "documentReads": 184320,
      "documentWrites": 112040,
      "storageBytes": 58720256,
      "source": "project_usage_daily"
    }
  ],
  "nodes": [
    {
      "id": "pg-control-primary",
      "role": "Control Plane PostgreSQL (Primary)",
      "type": "control",
      "endpoint": "control-plane://postgresql",
      "status": "healthy",
      "cpuUsage": 0,
      "memoryUsage": 0,
      "activeConnections": 7,
      "maxConnections": 100,
      "uptime": "12d 4h"
    }
  ]
}`} />
        </Api>

        <Api method="GET" path="/v1/admin/tenants">
          <P>دليل المستأجرين مع الاستخدام اليومي المجمَّع من <IC>project_usage_daily</IC>، دون أي حمولة مستندات.</P>
          <P>الرؤوس المطلوبة: جلسة Super Admin.</P>
          <Code lang="json" title="200 OK" code={`[
  {
    "id": "org_3d91",
    "name": "Amina Hassan's Organization",
    "slug": "amina-hassan-lk3p9",
    "billingEmail": "amina@example.com",
    "plan": "free",
    "status": "active",
    "storageMb": 56,
    "dailyReads": 184320,
    "dailyWrites": 112040,
    "projectsCount": 1,
    "createdAt": "2026-11-01T08:00:00.000Z"
  }
]`} />
        </Api>

        <Api method="POST" path="/v1/admin/tenants/:orgId/suspend">
          <P>يُوقف المستأجر؛ تُرفض بعدها طلبات مستوى البيانات الخاصة به بـ <IC>PERMISSION_DENIED</IC>. الإجراء مُقيَّد بدور كتابة ويُسجَّل في سجل التدقيق.</P>
          <P>الرؤوس المطلوبة: جلسة Super Admin بدور <IC>owner</IC> أو <IC>admin</IC>. لا جسم للطلب.</P>
          <Code lang="json" title="200 OK" code={`{
  "success": true,
  "status": "suspended"
}`} />
        </Api>

        <Api method="GET" path="/v1/admin/audit-logs">
          <P>
            مستكشف سجلات التدقيق غير القابلة للتعديل، مع تصفية خادمية وترقيم صفحي بمفتاح (<IC>created_at</IC>،
            <IC>id</IC>) بترتيب تنازلي، و <IC>OFFSET</IC> غير مستخدم. تُعاد بيانات الصفحة في الترويسات{" "}
            <IC>X-Total-Count</IC> و<IC>X-Has-More</IC> و<IC>X-Next-Cursor</IC>؛ وإضافة <IC>?envelope=true</IC> تُعيد
            جسماً منظّماً.
          </P>
          <P>
            الرؤوس المطلوبة: جلسة Super Admin. معاملات الاستعلام: <IC>limit</IC> و<IC>cursor</IC> و
            <IC>action</IC> و<IC>organizationId</IC> و<IC>from</IC> و<IC>to</IC>.
          </P>
          <Code lang="json" title="200 OK مع envelope=true" code={`{
  "items": [
    {
      "id": "log_01J9Z",
      "timestamp": "2026-11-18T12:20:00.000Z",
      "actorUserId": "usr_owner",
      "actorType": "operator",
      "action": "tenant.suspended",
      "category": "lifecycle",
      "organizationId": "org_3d91",
      "projectId": "proj_global",
      "targetId": "org_3d91",
      "metadata": { "slug": "amina-hassan-lk3p9", "status": "suspended" }
    }
  ],
  "total": 482,
  "nextCursor": "eyJ0IjoiMjAyNi0xMS0xOFQxMjoyMDowMC4wMDBaIiwiaWQiOiJsb2dfMDFKOVoifQ",
  "hasMore": true
}`} />
        </Api>

        <Api method="GET" path="/v1/admin/features">
          <P>قائمة ميزات المنصة المدعومة بـ PostgreSQL، مع نسبة النشر ووصف كل ميزة.</P>
          <P>الرؤوس المطلوبة: جلسة Super Admin.</P>
          <Code lang="json" title="200 OK" code={`[
  {
    "key": "realtime_v2",
    "description": "Enable durable outbox realtime delivery",
    "enabled": true,
    "rolloutPercent": 100,
    "updatedAt": "2026-11-12T10:00:00.000Z"
  }
]`} />
        </Api>
      </Section>

      <Section id="end-users" title="مستويات مصادقة المستخدمين النهائيين">
        <P>
          هذه المستويات خاصة بمستخدمي تطبيقك لا بمشغّلي المنصة. المستوى العام يتطلب مفتاح مشروع صالحاً، والرموز
          الناتجة EdDSA. مستوى الإدارة يتطلب مفتاح خادم <IC>sk_</IC> أو جلسة، ولا يُخرج أبداً تجزئات كلمات المرور
          ولا حمولات المستندات.
        </P>

        <Api method="POST" path="/v1/projects/:projectId/auth/sign-up/email">
          <P>تسجيل مستخدم نهائي بالبريد وكلمة المرور، مع تطبيق سياسة كلمة المرور وحصة المستخدمين في المشروع.</P>
          <P>
            الرؤوس المطلوبة: <IC>x-vellum-api-key</IC> لمفتاح المشروع. الاستجابة <IC>201</IC> تتضمن زوج رموز وجلسة.
          </P>
          <Code lang="json" title="طلب" code={`{
  "email": "enduser@example.com",
  "password": "a-strong-password",
  "displayName": "End User"
}`} />
          <Code lang="json" title="201 Created" code={`{
  "user": {
    "id": "eusr_4c81",
    "email": "enduser@example.com",
    "emailVerified": false,
    "displayName": "End User"
  },
  "accessToken": "eyJhbGciOiJFZERTQSIsInR5cCI6ImRvY2RiK2VuZHVzZXIrand9…",
  "refreshToken": "op_7dKq2mX9vL4nR1s…",
  "tokenType": "Bearer",
  "sessionId": "ses_3a19",
  "expiresAt": "2026-11-18T13:00:00.000Z"
}`} />
        </Api>

        <Api method="POST" path="/v1/projects/:projectId/auth/token/refresh">
          <P>يدير رمز التحديث ويعيد زوج رموز جديداً؛ الرموز القديمة تُبطل عند التدوير.</P>
          <P>الرؤوس المطلوبة: <IC>x-vellum-api-key</IC>.</P>
          <Code lang="json" title="طلب" code={`{
  "refreshToken": "op_7dKq2mX9vL4nR1s…"
}`} />
          <Code lang="json" title="200 OK" code={`{
  "accessToken": "eyJhbGciOiJFZERTQSJ9…",
  "refreshToken": "op_9mZq3vLx6tR8wK2…",
  "tokenType": "Bearer",
  "sessionId": "ses_3a19",
  "expiresAt": "2026-11-18T13:30:00.000Z"
}`} />
        </Api>

        <Api method="GET" path="/v1/projects/:projectId/auth/.well-known/jwks.json">
          <P>
            مستند JWKS عام لهذا المشروع، لا يتطلب مفتاح API. تحتاج خدمات التحقق من الرموز إلى مفاتيح Ed25519
            العامة للتحقق من توقيعات EdDSA محلياً.
          </P>
          <P>الرؤوس المطلوبة: لا شيء.</P>
          <Code lang="json" title="200 OK" code={`{
  "keys": [
    {
      "kty": "OKP",
      "crv": "Ed25519",
      "kid": "key_2026_11",
      "use": "sig",
      "alg": "EdDSA",
      "x": "11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"
    }
  ]
}`} />
        </Api>

        <Api method="GET" path="/v1/projects/:projectId/auth/admin/users">
          <P>
            دليل المستخدمين النهائيين مع ترقيم صفحي بالمؤشر، وتصفية بالاسم والحالة. يتطلب مفتاح <IC>sk_</IC> أو
            جلسة ذات صلاحية.
          </P>
          <P>الرؤوس المطلوبة: <IC>x-vellum-api-key</IC> بمفتاح <IC>sk_</IC> أو <IC>Authorization: Bearer</IC>.</P>
          <Code lang="json" title="200 OK" code={`{
  "users": [
    {
      "id": "eusr_4c81",
      "email": "enduser@example.com",
      "emailVerified": false,
      "displayName": "End User",
      "isDisabled": false,
      "isAnonymous": false,
      "createdAt": "2026-11-18T12:00:00.000Z"
    }
  ],
  "nextCursor": "eyJpZCI6ImV1c3JfNGM4MSJ9",
  "hasMore": false
}`} />
        </Api>

        <Api method="PATCH" path="/v1/projects/:projectId/auth/admin/config">
          <P>
            يعدّل إعدادات مصادقة المشروع، مثل تفعيل التسجيل وسياسة كلمة المرور وMFA وإسقاط المستخدمين إلى مستندات.
            يُطبَّق التغيير على الحقول المرسلة فقط.
          </P>
          <P>الرؤوس المطلوبة: مفتاح <IC>sk_</IC> أو جلسة.</P>
          <Code lang="json" title="طلب" code={`{
  "enableEmailPassword": true,
  "enableTotpMfa": true,
  "passwordMinLength": 10,
  "enableUserProjection": true,
  "projectionCollectionPath": "users"
}`} />
          <Code lang="json" title="200 OK" code={`{
  "projectId": "proj_7c1f",
  "enableEmailPassword": true,
  "enableAnonymousAuth": false,
  "enableTotpMfa": true,
  "passwordMinLength": 10,
  "enableUserProjection": true,
  "projectionCollectionPath": "users",
  "maxUsersQuota": 10000
}`} />
        </Api>

        <Api method="POST" path="/v1/admin/auth/session/refresh">
          <P>تحديث جلسة المجال الفائق، ويتطلّب إضافية علم مستخدم المنصة الفائق. يُقرأ الرمز من ملف <IC>vellum_admin_rt</IC>.</P>
          <P>الرؤوس المطلوبة: ملف <IC>vellum_admin_rt</IC> أو حقل <IC>refreshToken</IC>.</P>
          <Code lang="json" title="200 OK" code={`{
  "accessToken": "eyJhbGciOiJIUzI1NiJ9…",
  "refreshToken": "s5Lw8nRt2dQ6mZ1x…",
  "expiresAt": "2026-11-18T09:45:00.000Z",
  "user": {
    "id": "usr_owner",
    "name": "Platform Owner",
    "email": "owner@example.com",
    "platformRole": "owner"
  }
}`} />
        </Api>

        <Api method="GET" path="/v1/admin/auth/overview">
          <P>عدد المشاريع التي تفعّل المصادقة وعدد المشاريع الموقوفة منها وإجمالي المستخدمين النهائيين، دون أي حمولة مستندات.</P>
          <P>الرؤوس المطلوبة: جلسة Super Admin.</P>
          <Code lang="json" title="200 OK" code={`{
  "projectsWithAuth": 8,
  "suspendedProjects": 1,
  "totalEndUsers": 4821,
  "globalSignupsEnabled": true,
  "generatedAt": "2026-11-18T12:30:00.000Z"
}`} />
        </Api>
      </Section>

      <Section id="metering-and-privacy" title="القياس وخصوصية المشغّل">
        <Api method="GET" path="/v1/projects/:projectId/usage">
          <P>
            قراءات يومية دائمة من <IC>project_usage_daily</IC> مع إجماليات محسوبة، تتطلّب جلسة وتحققاً من صلاحية
            المشروع. يقبل <IC>?from=YYYY-MM-DD</IC> و<IC>?to=YYYY-MM-DD</IC>.
          </P>
          <P>الرؤوس المطلوبة: جلسة صالحة بدور <IC>owner</IC> أو <IC>admin</IC> أو <IC>support_readonly</IC> أو <IC>customer</IC>.</P>
          <Code lang="json" title="200 OK" code={`{
  "projectId": "proj_7c1f",
  "from": "2026-11-01",
  "to": "2026-11-18",
  "generatedAt": "2026-11-18T12:35:00.000Z",
  "days": 18,
  "totals": {
    "documentReads": 184320,
    "documentWrites": 112040,
    "documentDeletes": 3120,
    "realtimeMessagesSent": 90210,
    "egressBytes": 40960000,
    "storageBytes": 58720256
  },
  "usage": [
    {
      "projectId": "proj_7c1f",
            "usageDate": "2026-11-18",
      "documentReads": 184320,
      "documentWrites": 112040,
      "documentDeletes": 3120,
      "realtimeMessagesSent": 90210,
      "egressBytes": 40960000,
      "storageBytes": 58720256,
      "updatedAt": "2026-11-18T12:00:00.000Z"
    }
  ]
}`} />
        </Api>

        <Callout tone="warning" title="قيد خصوصية ثابت">
          <P>
            يستطيع مشغّلو المنصة فحص بيانات المستأجرين الوصفية والحصص وصحة الفهار وسجلات التدقيق، لكنهم لا يرون
            أبداً حمولة <IC>documents.data</IC>. كل استجابة إدارية تمرّ عبر حاجز متكرر يحذف مفاتيح الأسرار وحقول
            بيانات المستندات قبل الإرسال.
          </P>
        </Callout>

        <H3 id="related">صفحات ذات صلة</H3>
        <UL
          items={[
            <PageLink slug="rest-api" lang="ar">نظرة عامة على REST API</PageLink>,
            <PageLink slug="reference/rest-data-plane" lang="ar">واجهة REST لمستوى البيانات</PageLink>,
            <PageLink slug="end-user-auth" lang="ar">المستخدمون النهائيون والمجالات الثلاثة</PageLink>,
            <PageLink slug="authentication" lang="ar">المصادقة ومفاتيح API والجلسات</PageLink>,
          ]}
        />
      </Section>
    </Doc>
  );
}
