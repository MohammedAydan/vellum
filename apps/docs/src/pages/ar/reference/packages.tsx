import {
  Callout,
  Doc,
  H3,
  P,
  PageLink,
  Section,
  Table,
  UL,
} from "../../../ui";

export default function Page() {
  return (
    <Doc
      title="واجهات الحزم البرمجية"
      description="جردٌ كامل لحزم @vellum/* الثلاث عشرة داخل packages/، مع المسؤولية الحقيقية لكل حزمة وأبرز صادراتها والحدود المعمارية التي تحكمها."
      eyebrow="المرجع"
    >
      <Section id="overview" title="نظرة عامة: خريطة الحزم">
        <P>
          يوزّع المستودع المنطق بأكمله على حزم مستقلة عن الأطر تحت{" "}
          <code>packages/</code>، بينما لا تعدو تطبيقات <code>apps/*</code> كونها
          محوّلات توصيل رقيقة. لا تُقيَّم شجرة القواعد ولا تُجمَّع عبارات SQL ولا تُسلسَّل
          القيم الموسومة داخل معالجات المسارات أو مكوّنات الواجهة.
        </P>
        <Callout tone="warning" title="هذه حزم داخلية، لا مجموعة SDK عامة">
          الحزم أدناه لبنات يستخدمها <code>apps/api</code> ومجموعتا SDK. صادراتها
          قابلة للتغيير بين الإصدارات، وبعض مساراتها — مثل مُنشئات القيم الموسومة
          في <code>@vellum/core</code> ومؤشرات <code>@vellum/query-engine</code> —
          حسّاسة لتنسيق الإرسال. يجب أن تعتمد تطبيقات العمل على{" "}
          <code>@vellumdb/sdk-js</code> أو على HTTP المباشر، لا على هذه الحزم مباشرة.
        </Callout>
        <Table
          head={["الطبقة", "الحزم", "الدور المعماري"]}
          rows={[
            [
              "التأسيس",
              <>
                <code>@vellum/core</code> · <code>@vellum/api-contract</code> ·{" "}
                <code>@vellum/observability</code>
              </>,
              "حدود ثابتة وأخطاء معيارية ومخططات تحقق وتسجيل مُخفٍّ للأسرار.",
            ],
            [
              "قواعد البيانات",
              <>
                <code>@vellum/database-control</code> ·{" "}
                <code>@vellum/database-data</code> · <code>@vellum/storage</code>
              </>,
              "مستوى التحكم، ومستوى البيانات، ومحوّل التخزين الذي يفرض عزل المستأجرين.",
            ],
            [
              "الأمان",
              <>
                <code>@vellum/auth</code> · <code>@vellum/authorization</code>
              </>,
              "مصادقة المستخدمين النهائيين والمجالات، وتوقيع المفاتيح وتقييم شجرة القواعد.",
            ],
            [
              "المحركات",
              <>
                <code>@vellum/query-engine</code> ·{" "}
                <code>@vellum/document-engine</code> ·{" "}
                <code>@vellum/realtime</code>
              </>,
              "تجميع الاستعلام واختيار الفهرس، محرك المستندات والمعاملات، والوقت الفعلي عبر LISTEN/NOTIFY.",
            ],
            [
              "التوصيل",
              <>
                <code>@vellumdb/sdk-js</code> · <code>@vellum/ui</code>
              </>,
              "عميل JavaScript الرسمي، ونظام التصميم المشترك لواجهات المنصات.",
            ],
          ]}
        />
        <P>
          الحزم كلها مستقلة عن Hono وNext.js وReact، لكن عدة حزم تستخدم{" "}
          <code>node:crypto</code> و<code>pg</code> وبالتالي تستهدف الخادم أو وقت
          التشغيل لا المتصفح. للاطلاع على السرد المعماري الكامل ابدأ بـ{" "}
          <PageLink slug="index" lang="ar">المقدمة</PageLink>.
        </P>
      </Section>

      <Section id="foundations" title="طبقة التأسيس">
        <H3 id="core">@vellum/core</H3>
        <P>
          <strong>المسؤولية:</strong> الحصص الثابتة للإصدار 1، وتسلسل الأخطاء
          المعياري، ومحلل المسارات، وتنسيق الإرسال الموسوم بـ <code>$t</code> و
          <code>$v</code>، ومُرمّز مفاتيح الفرز الحافظة للترتيب. هي أدنى الحزم في
          الرسم البياني ولا تعتمد على أي حزمة أخرى، وتعتمد عليها بقية الحزم.
        </P>
        <Table
          head={["الصادر", "الوظيفة"]}
          rows={[
            [
              <code>SYSTEM_LIMITS</code>,
              "كل حصص v1: 1 MiB للمستند، وعمق مسار 10، ودفعة 100 عملية، وغيرها.",
            ],
            [
              <><code>VellumError</code> / <code>ERROR_HTTP_STATUS</code></>,
              "الخطأ القابل للرمي وحالة HTTP المطابقة لكل رمز معياري.",
            ],
            [
              <><code>parseDocumentPath</code> / <code>parseCollectionPath</code></>,
              "التحقق من المسارات الزوجية (2–10) والفردية (1–9) وتفكيكها إلى مكوّناتها.",
            ],
            [
              <><code>validateWireValue</code> / <code>validateFieldName</code></>,
              "تحقق تعاودي من القيم الموسومة بعمق ≤ 20 وطول اسم حقل ≤ 256.",
            ],
            [
              <code>WireValue</code>,
              "منشئات int64 وtimestamp وreference وbytes وgeopoint وescapeMap.",
            ],
            [
              <><code>encodeSortableFloat64</code> / <code>encodeSortableInt64</code> / <code>TYPE_TAG</code></>,
              "ترميزات بايت كبيرة الخاتمة حافظة للترتيب، تُستخدم في sort_key الخاص بالفهارس المركّبة.",
            ],
          ]}
        />

        <H3 id="api-contract">@vellum/api-contract</H3>
        <P>
          <strong>المسؤولية:</strong> مخططات <code>Zod</code> وقت التشغيل لكل
          أشكال مستوى التحكم والمستندات والاستعلام والمعاملات والأخطاء وإطارات
          WebSocket، إضافةً إلى مولّد OpenAPI 3.1 الذي يخدّم{" "}
          <code>/v1/openapi.json</code>. هنا تُرسم الحدود التي تُرفض عندها الطلبات
          القادمة قبل وصولها إلى المنطق.
        </P>
        <Table
          head={["الصادر", "الوظيفة"]}
          rows={[
            [<code>generateOpenApiSpec</code>, "يبني وثيقة OpenAPI 3.1 كاملة."],
            [
              <><code>VALID_QUERY_OPERATORS</code></>,
              "مجموعات توافقية للتحقق السريع.",
            ],
            [
              <><code>QuerySpecSchema</code> / <code>BatchWriteSchema</code> / <code>CommitTransactionSchema</code></>,
              "تحقق وقت التشغيل من أجسام الطلبات العامة.",
            ],
            [
              <><code>ClientFrameSchema</code> / <code>ServerFrameSchema</code></>,
              "الاتحاد المعياري لإطارات WebSocket الواردة والصادرة.",
            ],
            [
              <><code>ApiErrorSchema</code> / <code>ErrorCodeEnum</code></>,
              "مغلّف الخطأ المعياري ومجموعة الرموز المعتمدة.",
            ],
          ]}
        />

        <H3 id="observability">@vellum/observability</H3>
        <P>
          <strong>المسؤولية:</strong> تسجيل JSON منظّم مع إخفاء الأسرار، وتحديد
          معدل بنافذة منزلقة، وتوليد معرّف الطلب. كل فشل HTTP يمر عبر مرشحات
          الإخفاء، فلا تُسجَّل مفاتيح <code>pk_</code> أو <code>sk_</code> ولا
          رموز <code>Bearer </code> ولا عناوين قواعد البيانات.
        </P>
        <Table
          head={["الصادر", "الوظيفة"]}
          rows={[
            [
              <><code>createLogger</code> / <code>StructuredLogger</code></>,
              "مسجّل Pino منظّم، ومسجّل داخلي تستخدمه طبقة API.",
            ],
            [
              <code>redactSensitiveData</code>,
              "إخفاء تعاودي للحقول والقيم الحساسة قبل الكتابة في السجل.",
            ],
            [
              <code>SlidingWindowRateLimiter</code>,
              "نافذة منزلقة لكل مفتاح؛ الافتراضي 100 طلب/ثانية.",
            ],
            [
              <code>generateRequestId</code>,
              "معرّف بالشكل req_&lt;24 hex&gt; يُرفق بكل استجابة ومغلّف خطأ.",
            ],
          ]}
        />
      </Section>

      <Section id="data-layer" title="طبقة قواعد البيانات والتخزين">
        <H3 id="database-control">@vellum/database-control</H3>
        <P>
          <strong>المسؤولية:</strong> مخطط Drizzle ومستودع قاعدة بيانات التحكم{" "}
          <code>control_db</code>: المستخدمون والمؤسسات والعضويات والمشاريع
          وتجزئة مفاتيح API ومجموعات قواعد الأمان وعدّادات القياس
          وسجلات التدقيق غير القابلة للتعديل. تهيئة المنصة وتسجيل المشغّلين
          والتحقق من المفاتيح والاستعادة من العطل تعتمد على هذه الحزمة وحدها، ولا
          تعتمد أبدًا على واجهة المستندات العامة.
        </P>
        <P>
          <strong>وحدات التصدير:</strong> <code>schema</code> (مخطط Drizzle) و
          <code>client</code> و<code>memory-store</code> و<code>pg-store</code> و
          <code>raw-sql</code> و<code>migrations-runner</code> و
          <code>env-file</code>.
        </P>

        <H3 id="database-data">@vellum/database-data</H3>
        <P>
          <strong>المسؤولية:</strong> مخطط Drizzle وسياسات أمان الصفوف (RLS) لقاعدة
          بيانات البيانات <code>data_db</code>: المستندات، وتعريفات الفهارس
          المركّبة وإدخالاتها، وصندوق البريد الدائم <code>realtime_outbox</code>
          ، وصفوف المعاملات. يهيّئ الثابت <code>INIT_DATA_PLANE_SQL</code> الجداول
          والفهارس الثابتة للخدمة ويفعّل السياسات؛ أمّا فهارس المستأجرين فتُخزَّن
          كصفوف ولا تُنشأ بأمر <code>CREATE INDEX</code> على جدول{" "}
          <code>documents</code> المشترك.
        </P>
        <P>
          <strong>وحدات التصدير:</strong> <code>schema</code> و<code>client</code>{" "}
          و<code>rls</code>. راجع{" "}
          <PageLink slug="indexes" lang="ar">الفهارس المركّبة</PageLink>.
        </P>

        <H3 id="storage">@vellum/storage</H3>
        <P>
          <strong>المسؤولية:</strong> عقد <code>StorageAdapter</code> مع محوّلات{" "}
          <code>memory</code> و<code>pg</code> و<code>neon</code>، وسياق المعاملة{" "}
          <code>TxHandle</code> الذي يربط إعدادات RLS، والثوابت
          المحضّرة، ومخزن TTL داخل العملية وناقل{" "}
          <code>NOTIFY vellum_cache_invalidate</code>. هنا بالضبط تُفرض قواعد عزل
          المستأجرين ومنع DDL الخاص بهم.
        </P>
        <Table
          head={["الصادر", "الوظيفة"]}
          rows={[
            [<code>createStorageAdapter</code>, "يختار المشغّل صراحةً أو من متغيرات البيئة أو من صيغة عنوان الاتصال."],
            [
              <><code>StorageAdapter</code> / <code>TenantContext</code></>,
              "عقد الاستمرارية الوحيد، وسياق إلزامي يضم projectId لكل عملية.",
            ],
            [
              <><code>runInTenantTransactionAsync</code> / <code>createSqlTransactionHandle</code></>,
              "يفتح اتصال PostgreSQL وي-bindّ سياق المستأجر قبل تنفيذ الاستدعاء.",
            ],
            [
              <><code>SQL_SET_STATEMENT_TIMEOUT</code> / <code>SQL_SET_PROJECT</code></>,
              "جملتا SET LOCAL اللتان تجعلان RLS يفشل مغلقًا.",
            ],
            [
              <><code>createTtlCache</code> / <code>createCacheInvalidationBus</code></>,
              "ذاكرة مؤقتة داخل العملية + ناقل LISTEN/NOTIFY لإبطالها عبر النسخ.",
            ],
          ]}
        />
      </Section>

      <Section id="security" title="طبقة الأمان">
        <H3 id="auth">@vellum/auth</H3>
        <P>
          <strong>المسؤولية:</strong> أوليات مصادقة المستخدمين النهائيين دون
          تبعيات crypto أصلية خارج <code>node:crypto</code> و<code>nodemailer</code>:
          تجزئة كلمات المرور، وتشفير مفاتيح Ed25519 الخاصة، وتوقيع رموز الوصول
          بـ EdDSA، وجلسات التحديث مع التدوير وكشف إعادة التشغيل، ورموز TOTP
          ورموز الاسترداد، وخدمات الجلسة عبر HMAC-SHA256.
          من هنا تُوقَّع رموز المستخدم النهائي التي يقبلها مستوى المستندات؛ أمّا
          رموز HS256 المُزوَّرة فتُرفض هناك.
        </P>
        <P>
          <strong>وحدات التصدير:</strong> <code>crypto/password</code> و
          <code>crypto/encrypt</code> و<code>crypto/jwt</code> و
          <code>realm-session</code> و<code>services/mfa-service</code> و
          <code>services/session-service</code> و<code>services/projector</code>{" "}
          و<code>mailer</code>. راجع{" "}
          <PageLink slug="end-user-auth" lang="ar">المستخدمين النهائيين والمجالات الثلاثة</PageLink>.
        </P>

        <H3 id="authorization">@vellum/authorization</H3>
        <P>
          <strong>المسؤولية:</strong> توليد مفاتيح API والتحقق منها (
          <code>pk_</code> و<code>sk_</code>)، والتحقق من مطالبات JWT، وإدارة
          الجلسات والإبطال، وأدوات TOTP، ومقيّم شجرة قواعد الأمان الحتمي. لا
          يُستخدم <code>eval()</code> ولا <code>new Function()</code>؛ تُقبل الشجرة
          إن كان عمقها ≤ 10 وعقدها ≤ 100، والرفض هو الافتراضي.
        </P>
        <Table
          head={["الصادر", "الوظيفة"]}
          rows={[
            [
              <><code>generateProjectApiKey</code> / <code>hashApiKey</code> / <code>verifyApiKey</code></>,
              "دورة حياة مفتاح API مع مقارنة ثابتة الزمن وتخزين مؤقت لمدة 30 ثانية.",
            ],
            [
              <><code>validateSecurityRulesetAst</code> / <code>evaluateAstNode</code> / <code>authorizeOperation</code></>,
              "التحقق من شجرة القواعد ومطابقتها وتقييمها متزامنًا دون تنفيذ ديناميكي.",
            ],
            [
              <><code>createSessionService</code> / <code>createInMemoryRevocationStore</code></>,
              "خدمة جلسات وإبطال claims، مع بديل داخلي للاختبارات.",
            ],
            [
              "مساعدات MFA",
              "توليد السر ورمز TOTP والتحقق منه واشتقاق رموز الاسترداد وتجزئتها واستهلاكها.",
            ],
          ]}
        />
        <Callout tone="info" title="تمييز مهم بين الحزمتين">
          <code>@vellum/auth</code> ينتج رموز EdDSA للمستخدمين النهائيين ويدير
          مجالات التحكم، أمّا <code>@vellum/authorization</code> فيحتفظ بأدوات JWT
          محلية توافقية ويضطلع بتوقيع المفاتيح وقواعد الأمان. المعيار الحاكم لمستوى
          المستندات هو EdDSA فقط. راجع{" "}
          <PageLink slug="security-rules" lang="ar">قواعد الأمان</PageLink>.
        </Callout>
      </Section>

      <Section id="engines" title="طبقة المحركات">
        <H3 id="query-engine">@vellum/query-engine</H3>
        <P>
          <strong>المسؤولية:</strong> تحقق الاستعلام وتطبيعه، واختيار الفهرس
          المركّب، وتجميع SQL ذي معاملات دون بناء مسندات بسلاسل نصية، وترميز وفك
          المؤشرات المعتمة الموقّعة بـ HMAC-SHA256. لا يظهر <code>OFFSET</code> في
          أي مسار عام؛ ويُستخدم <code>document_id ASC</code> كفاصل حسم نهائي.
        </P>
        <Table
          head={["الصادر", "الوظيفة"]}
          rows={[
            [<code>validateAndNormalizeQuery</code>, "يتحقق من where و orderBy و limit ويحدّد نطاق الحدود."],
            [<code>compileQueryToParameterizedSql</code>, "يُصدر SQL مقيدًا بالمستأجر وبمعاملات فقط."],
            [<code>selectCompositeIndexForQuery</code>, "يقرر إن كان الفهرس المركّب مطلوبًا وأيّ فهرس يطابق."],
            [<><code>encodeQueryCursor</code> / <code>decodeAndVerifyQueryCursor</code></>, "يوقع المؤشر ويتحقق من توقيعه وتجزئة شكل الاستعلام، ويرفض العبث بـ INVALID_CURSOR."],
          ]}
        />

        <H3 id="document-engine">@vellum/document-engine</H3>
        <P>
          <strong>المسؤولية:</strong> نواة أعمال المستندات: CRUD والتحويلات الذرية
          للحقول والكتابة الدفعية والاستعلام المنظّم ومعاملات التحقق المتفائل (OCC)
          المدعومة بـ PostgreSQL. معالجات المسارات تستدعي هذه الحزمة، ولا تعيد
          تنفيذ منطق القواعد أو SQL أو تنسيق الإرسال بنفسها.
        </P>
        <Table
          head={["الصادر", "الوظيفة"]}
          rows={[
            [<code>DocumentEngine</code>, "واجهة العمليات الرئيسية: get/create/set/update/delete و batchWrite و executeQuery ودورة المعاملة."],
            [<code>applyFieldTransforms</code>, "يطبّق رموز $op مثل inc و arrayUnion و arrayRemove و serverTimestamp و deleteField."],
            [<code>createTransactionManager</code>, "يدير begin و recordRead و verifyAndLock و markCommitted و rollback."],
            [<><code>decodeAndVerifyTransactionToken</code> / <code>transactionTokenHash</code></>, "يتحقق من رمز المعاملة الموقّع ويستخدم تجزئته كمفتاح صف في قاعدة البيانات."],
          ]}
        />

        <H3 id="realtime">@vellum/realtime</H3>
        <P>
          <strong>المسؤولية:</strong> الوقت الفعلي الأصلي في PostgreSQL: مركز بوابة
          WebSocket الذي يدبر الإطارات والاشتراكات والتوزيع وحماية المستهلك
          البطيء، ومستقصي صندوق البريد الدائم مع كشف الفجوات، وناقل{" "}
          <code>LISTEN/NOTIFY</code> بعميل مخصص غير مجمّع. لا وسيط خارجي ولا خدمة
          حالة ثانية.
        </P>
        <Table
          head={["الصادر", "الوظيفة"]}
          rows={[
            [<code>RealtimeGatewayHub</code>, "جلسات الاتصال والمصادقة والاشتراك والاستئناف والتوزيع."],
            [<code>OutboxPoller</code>, "يقرأ الصندوق على دفعات ويتتبع العلامة المائية ويكتشف الفجوات ويزيل التكرار."],
            [<><code>createPgNotifyBus</code> / <code>createPgRealtimeInfrastructure</code></>, "ينشئ اتصال LISTEN مخصصًا ويربط الناقل بالمستقصي والمركز."],
            [<code>PG_OUTBOX_CHANNEL</code>, "قناة NOTIFY المعيارية vellum_outbox."],
          ]}
        />
        <P>
          التفاصيل الكاملة للإطارات في{" "}
          <PageLink slug="reference/realtime-protocol" lang="ar">بروتوكول WebSocket للوقت الفعلي</PageLink>.
        </P>
      </Section>

      <Section id="delivery" title="طبقة التوصيل">
        <H3 id="sdk-js">@vellumdb/sdk-js</H3>
        <P>
          <strong>المسؤولية:</strong> عميل TypeScript/JavaScript الرسمي: إنشاء
          العميل والمراجع، والاستعلام والترقيم، والتحويلات الحقلية، والمصادقة،
          والنقل الخاص بالوقت الفعلي، وسياسة إعادة المحاولة. هذه هي الحزمة المقصودة
          للاستهلاك المباشر من تطبيقات العمل.
        </P>
        <UL
          items={[
            <><code>createClient({'{ projectId, apiKey, endpoint? }'})</code> ينشئ العميل.</>,
            <><code>db.collection(path).doc(id).set(data)</code> و<code>get()</code> و<code>update(data)</code> و<code>delete()</code>، مع <code>{'{ merge: true }'}</code> للدمج.</>,
            <><code>where(field, op, value).orderBy(field, dir?).limit(n).startAfter(cursor).get()</code> للاستعلام.</>,
            <><code>db.batchWrite([...])</code> و<code>db.runTransaction(fn)</code>، و<code>db.collection(path).snapshots()</code> للوقت الفعلي.</>,
            <><code>db.auth.signUpWithEmailAndPassword</code> و<code>signInWithEmailAndPassword</code> و<code>getIdToken</code> و<code>signOut</code> للمصادقة.</>,
          ]}
        />
        <P>
          للاستخدام العملي راجع <PageLink slug="sdks/javascript" lang="ar">مجموعة JavaScript / TypeScript</PageLink>{" "}
          و<PageLink slug="sdks/flutter" lang="ar">مجموعة Flutter / Dart</PageLink>.
        </P>

        <H3 id="ui">@vellum/ui</H3>
        <P>
          <strong>المسؤولية:</strong> نظام تصميم مبني على React 19 وTypeScript
          صارم وTailwind CSS 4 ومكوّنات Radix UI الوصولية، مع توجّه RTL أصيل عبر
          الخصائص المنطقية في CSS، وThemeProvider للوضعين الفاتح والداكن، ومعرض
          Storybook. تستخدمه تطبيقات الواجهة لتوحيد اللغة البصرية، وهو حزمة واجهات لا علاقة
          لها بمنطق المستندات.
        </P>
      </Section>

      <Section id="boundaries" title="القواعد الحاكمة للحدود">
        <P>
          تتحكم ثوابت معمارية صارمة في كيفية تعاون هذه الحزم؛ أي تعديل يتجاوز
          أحدها يُعدّ خرقًا للعقد حتى لو عمل الكود في الاختبارات.
        </P>
        <Table
          head={["القاعدة", "الأثر على هذه الحزم"]}
          rows={[
            [
              "حدود أحادية الكتلة",
              "المنطق كله في packages/*؛ ومحوّلات التوصيل في apps/* لا تحتوي تقييم AST ولا تسلسل إرسال ولا تجميع SQL.",
            ],
            [
              "ازدواج مستويي البيانات",
              "database-control و database-data منفصلان فيزيائيًا ومنطقيًا؛ والتهيئة والتحقق من المفاتيح لا يعتمدان على واجهة المستندات.",
            ],
            [
              "عزل المستأجرين",
              "كل عملية في مستوى البيانات تأخذ projectId، وكل معاملة تربط جملتي SET LOCAL.",
            ],
            [
              "صفر DDL للعملاء",
              "فهارس المستأجرين صفوف في document_indexes و document_index_entries بمفاتيح فرز BYTEA، لا CREATE INDEX على documents.",
            ],
            [
              "شجرة قواعد حتمية",
              "لا eval()؛ التحقق والتقييم المتزامن في @vellum/authorization بالرفض الافتراضي.",
            ],
            [
              "ترقيم بالمؤشرات فقط",
              "مؤشرات HMAC-SHA256 معتمة من @vellum/query-engine، بلا OFFSET.",
            ],
            [
              "صفر خدمات حالة خارجية",
              "PostgreSQL وحدها؛ الوقت الفعلي عبر LISTEN/NOTIFY وصندوق بريد دائم، والإبطال عبر NOTIFY vellum_cache_invalidate.",
            ],
          ]}
        />
        <P>
          قبل توجيه حركة حقيقية إلى هذا التجميع، راجع{" "}
          <PageLink slug="production-checklist" lang="ar">قائمة التحقق للإنتاج</PageLink>.
        </P>
      </Section>
    </Doc>
  );
}
