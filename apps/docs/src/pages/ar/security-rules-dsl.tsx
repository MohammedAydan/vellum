import {
  Api,
  Callout,
  Code,
  Doc,
  P,
  PageLink,
  Section,
  Table,
  UL,
} from "../../ui";

const exampleDsl = `rules_version = '2';

function isMember() {
  return isSignedIn() && hasAnyRole(['member', 'admin']);
}

match /users/{userId} {
  allow get: if isOwner(userId) || hasRole('admin');
  allow create: if isOwner(userId) && isEmailVerified()
                   && isType(incoming.displayName, 'string');
  allow update: if isOwner(userId) && unchanged(['ownerId', 'createdAt']);
  allow delete: if hasRole('admin');

  match /orders/{orderId} {
    allow read: if isOwner(userId);
  }
}`;

const exampleAst = `{
  "version": 1,
  "rules": [
    {
      "match": "/users/{userId}",
      "allow": {
        "get": {
          "op": "any",
          "conditions": [
            { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } },
            { "op": "==", "left": { "var": "auth.claims.role" }, "right": { "val": "admin" } }
          ]
        }
      }
    }
  ]
}`;

const endpoints = `BASE="https://api.example.com/v1/projects/$PROJECT_ID/rules"

# ترجمة DSL → شجرة v1 + التشخيصات.
curl -s -X POST "$BASE/compile" \\
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \\
  -d '${JSON.stringify({ source: "rules_version = '2';\nmatch /users/{uid} {\n  allow get: if isOwner(uid);\n}" }).replaceAll("'", "'\\''")}'

# تفكيك شجرة v1 → DSL.
curl -s -X POST "$BASE/decompile" \\
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \\
  -d '{ "rulesAst": { "version": 1, "rules": [] } }'

# محاكاة عملية (تستخدم القواعد الفعّالة إن غاب rulesAst).
curl -s -X POST "$BASE/simulate" \\
  -H "x-vellum-api-key: $API_KEY" -H "content-type: application/json" \\
  -d '{ "operation": "get", "path": "users/u_123",
        "auth": { "uid": "u_123", "claims": { "role": "member" } },
        "resourceData": { "ownerId": "u_123" }, "incomingData": null,
        "rulesAst": { "version": 1, "rules": [] } }'`;

const diagnostic = `{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "Expected '}' but found 'end of input' (line 5, column 3)",
    "line": 5,
    "column": 3,
    "snippet": "  allow get: if auth.uid == userId;\n  ^"
  }
}`;

export default function Page() {
  return (
    <Doc
      title="لغة قواعد الأمان"
      description="لغة مقروءة للقواعد تُترجم إلى شجرة v1 الحتمية، مع ماكروهات ودوال ومجموعة أدوات كاملة للترجمة والتفكيك والمحاكاة."
      eyebrow="الأمان"
    >
      <Section id="overview" title="نظرة عامة">
        <P>
          لغة قواعد الأمان (Rules DSL) لغة صغيرة سهلة القراءة لكتابة قواعد الأمان. يُرمّز المُترجِم
          المصدر ويحلّله، ويوسّع الماكروهات والدوال المعرَّفة من المستخدم، ثم يُصدر شجرة JSON بالإصدار 1 —
          البنية نفسها الموصوفة في صفحة{" "}
          <PageLink slug="security-rules" lang="ar">قواعد الأمان</PageLink>. لا يوجد <code>eval()</code> ولا{" "}
          <code>new Function()</code>: لا يمشي مُقيِّم وقت التشغيل إلا على الشجرة الحتمية، في الذاكرة،
          بالرفض الافتراضي.
        </P>
        <Callout tone="info" title="صيغة تأليف، لا نموذج أمني جديد">
          اللغة تغيّر طريقة كتابة القواعد لا طريقة فرضها. النشر ما زال يخزّن قواعد{" "}
          <code>version: 1</code> مُتحقَّقًا منها في مستوى التحكم.
        </Callout>
      </Section>

      <Section id="version" title="rules_version = '2' مجرد سكر نحوي">
        <P>
          تبدأ مجموعة القواعد عادةً بـ <code>rules_version = '2';</code>. هذا التصريح{" "}
          <strong>سكر نحوي فقط</strong>: دالة <code>compileRulesDsl()</code> تُصدر دائمًا{" "}
          <code>{"{ \"version\": 1, \"rules\": [...] }"}</code>، لأن المُتحقِّق يشترط الإصدار 1.
          يُقبل تصريح <code>'1'</code>، وأي قيمة أخرى تُنتج تشخيصًا دون تغيير الإصدار المُصدر. يمكن حذف التصريح.
        </P>
        <Code lang="ts" title="DSL → شجرة" code={exampleDsl} />
        <P>يُحوّل المُترجِم ذلك إلى شجرة v1 المستخدمة في باقي النظام:</P>
        <Code lang="json" title="شجرة v1 المُصدرّة" code={exampleAst} />
      </Section>

      <Section id="syntax" title="الصياغة">
        <P>
          مجموعة القواعد سلسلة من تصريحات <code>function</code> و<code>match</code>، ويجب أن تحتوي على
         (match) واحد على الأقل. تُدعم التعليقات من نوع <code>//</code> و<code>/* … */</code>، والسلاسل
          بعلامتي تنصيص، والأرقام والقيم المنطقية و<code>null</code> ومصفوفات القيم. يربط البديل{" "}
          <code>{"{param}"}</code> مقطع مسار واحدًا، بينما يطابق <code>{"{document=**}"}</code> في
          النهاية مقطعًا أو أكثر. تُدمج المسارات المتداخلة.
        </P>
        <Code lang="ts" title="أشكال جمل allow" code={`allow get: if <expression>;
allow list, get: if <expression>;     // عمليات متشاركة في تعبير واحد
allow read: if <expression>;          // تتوسع إلى get + list
allow write: if <expression>;         // تتوسع إلى create + update + delete`} />
        <Table
          head={["الإنشاء", "DSL", "عملية الشجرة"]}
          rows={[
            ["AND منطقي", <code>a &amp;&amp; b</code>, <code>all</code>],
            ["OR منطقي", <code>a || b</code>, <code>any</code>],
            ["النفي", <code>!a</code>, <code>not</code>],
            ["المقارنة", <code>== != &lt; &lt;= &gt; &gt;=</code>, "نفس العامل"],
            ["الانتماء", <code>a in ['x','y']</code>, <code>in</code>],
            ["المفتاح / النوع", <code>hasKey(a,'f') · isType(a,'string')</code>, "hasKey · isType"],
          ]}
        />
        <Callout tone="warning" title="حدود التعقيد">
          التعقيد محدود بعمق 10 و100 عقدة. تجاوز أي منهما خطأ صياغة — يتحقق المُترجِم من التعقيد بعد
          توسيع الدوال.
        </Callout>
      </Section>

      <Section id="aliases" title="الأسماء المستعارة ومتغيرات السياق">
        <P>تُترجم الأسماء القصيرة إلى مسارات المتغيرات التي يفهمها المُقيِّم:</P>
        <Table
          head={["الاسم في DSL", "متغير الشجرة", "المعنى"]}
          rows={[
            [<code>auth</code>, <code>auth</code>, "هوية المستخدم النهائي (uid, email, email_verified, claims.*)"],
            [<code>resource</code>, <code>resource.data</code>, "بيانات المستند الحالية (null عند الإنشاء)"],
            [<code>incoming</code>, <code>request.data</code>, "البيانات الواردة (null عند القراءة/الحذف)"],
            [<code>request.auth.*</code>, <code>auth.*</code>, "طريقة بديلة لكتابة مطالبات الهوية"],
            [<code>request.resource.data.*</code>, <code>request.data.*</code>, "طريقة بديلة للبيانات الواردة"],
            [<code>path.&lt;param&gt;</code>, <code>path.&lt;param&gt;</code>, "القيمة المرتبطة ببديل المسار"],
            [<code>request.time</code>, <code>request.time</code>, "وقت الطلب بالمللي ثانية"],
          ]}
        />
      </Section>

      <Section id="macros" title="الماكروهات المدمجة">
        <Table
          head={["الماكرو", "الوسائط", "المعنى"]}
          rows={[
            [<code>isSignedIn() / isAuth()</code>, "0", <code>auth.uid != null</code>],
            [<code>isOwner(id)</code>, "1", "مسجّل الدخول ومعرّفه يساوي id"],
            [<code>hasRole(role)</code>, "1", <code>auth.claims.role == role</code>],
            [<code>hasAnyRole(['a','b'])</code>, "1", <code>auth.claims.role in [...]</code>],
            [<code>isEmailVerified()</code>, "0", <code>auth.email_verified == true</code>],
            [<code>unchanged(['a','b'])</code>, "1", "كل حقل مذكور لم يتغيّر"],
            [<code>onlyChanged(['a','b'])</code>, "1", "كل حقل مذكور تغيّر — راجع القيد أدناه"],
            [<code>hasKey(obj,'f') / isType(v,'string')</code>, "2", "اختبار مفتاح / نوع"],
          ]}
        />
        <Callout tone="danger" title="قيد onlyChanged">
          شجرة v1 لا تملك مقارنة ديناميكية لمجموعة المفاتيح، لذا لا يمكن لـ{" "}
          <code>onlyChanged([...])</code> <strong>فرض</strong> أن المفاتيح الأخرى لم تتغيّر تمامًا. يُصدر
          المُترجِم فحصًا بأن كل حقل مذكور قد اختلف، مع تشخيص ينصح بفرض "بقاء باقي المفاتيح كما هي" في
          منطق التطبيق. الدالة المجهولة تُترجم إلى <code>false</code> — لا تمنح تصريحًا بالخطأ.
        </Callout>
      </Section>

      <Section id="functions" title="الدوال المعرَّفة من المستخدم والتوسيع">
        <P>
          تُعرَّف الدوال كـ <code>function name(p) {"{ return <expr>; }"}</code>. تُوسَّع الاستدعاءات{" "}
          <strong>في موقعها</strong> — تُستبدل الوسائط بالمعاملات وتُصدر الشجرة الناتجة دون عُقد استدعاء
          في وقت التشغيل. التعريفات المعرَّفة من المستخدم تحجب الماكروهات بنفس الاسم، وتُدعم الإشارات
          الأمامية، ويُرفض التكرار، ويقتصر التوسيع على عمق 16.
        </P>
        <Code lang="ts" title="دالة مُوسَّعة" code={`function canReadPost() {
  return isSignedIn() && (hasRole('admin') || isOwner(path.userId));
}
match /posts/{postId} {
  allow get: if canReadPost();
}`} />
      </Section>

      <Section id="diagnostics" title="التشخيصات — سطر وعمود مضبوطان">
        <P>
          المواقع تبدأ من 1. يُرمى <code>RulesDslSyntaxError</code> لأخطاء الترميز والتحليل والقواعد
          والتعقيد، ويعرض <code>line</code> و<code>column</code> ومقتطف <code>snippet</code> مع مؤشر.
          وتُعيد مصفوفة تشخيصات منفصلة (مع الشجرة) الأمور التي لا تمنع الترجمة: الدوال/المتغيرات
          المجهولة، وقيد <code>onlyChanged</code>، وعناصر المصفوفة غير الحرفية، والإصدارات غير المدعومة.
        </P>
        <Code lang="json" title="خطأ ترجمة (HTTP 400)" code={diagnostic} />
        <Callout tone="info" title="ترجمة ناجحة">
          الترجمة الناجحة تُعيد <code>{"{ \"ast\": {...}, \"diagnostics\": [...] }"}</code>. قد تكون
          التشخيصات غير فارغة رغم نجاح الترجمة.
        </Callout>
      </Section>

      <Section id="endpoints" title="واجهات الترجمة والتفكيك والمحاكاة">
        <P>
          النقاط الثلاث تحت <code>/v1/projects/:projectId/rules/*</code> وتقبل مفتاح API أو
          جلسة Customer Console مُتحقَّقًا من مجالها. أدوات خالصة — لا تنشر أي مجموعة قواعد ولا تلمس
          بيانات المستندات.
        </P>
        <Table
          head={["الطريقة", "المسار", "الغرض"]}
          rows={[
            [<code>POST</code>, <code>…/rules/compile</code>, "مصدر DSL → شجرة v1 + تشخيصات"],
            [<code>POST</code>, <code>…/rules/decompile</code>, "شجرة v1 → نص DSL"],
            [<code>POST</code>, <code>…/rules/simulate</code>, "تجربة عملية مع سجل تقييم"],
          ]}
        />
        <Api method="POST" path="/v1/projects/:projectId/rules/simulate">
          <P>
            الجسم: <code>operation</code> و<code>path</code> واختياريًا <code>rulesAst</code> و
            <code>auth</code> و<code>resourceData</code> و<code>incomingData</code>. تُعيد{" "}
            <code>allowed</code> و<code>matchedRule</code> و<code>evaluationTrace</code>. عند غياب{" "}
            <code>rulesAst</code> تُستخدم القواعد الفعّالة.
          </P>
        </Api>
        <Code lang="bash" title="cURL" code={endpoints} />
        <P>
          النشر منفصل: أرسل <code>rulesAst</code> المُترجَم إلى نقطة rulesets كـ{" "}
          <code>{"{ \"rulesAst\": { \"version\": 1, \"rules\": [...] } }"}</code>. فقط الشجرة v1
          المُتحقَّق منها يمكن أن تصبح فعّالة.
        </P>
      </Section>

      <Section id="studio" title="استوديو القواعد في لوحة التحكم">
        <P>
          توفّر لوحة العميل وضعين متزامنين: <strong>وضع DSL</strong> (الافتراضي، مع قوالب إدراج سريعة
          وترجمة مباشرة أثناء التحرير) و<strong>وضع JSON</strong> (تحرير شجرة v1 مباشرة للمستخدمين
          المتقدمين). تظهر أخطاء الصياغة مع السطر والعمود والمقتطف في المحرر، وتُعرض التشخيصات غير
          القاتلة بشكل منفصل. تتيح لوحة <strong>محاكي القواعد</strong> تجربة عملية مقابل المسودة أو
          القواعد الفعّالة مع عرض القرار والقاعدة المطابقة وسجل التقييم الكامل. لا يُنشر شيء إلا عند
          النشر الصريح.
        </P>
      </Section>

      <Section id="pitfalls" title="الأخطاء الشائعة">
        <UL
          items={[
            <>افتراض أن <code>'2'</code> تُنتج شجرة v2 — إنها سكر نحوي؛ الناتج دائمًا بالإصدار 1.</>,
            <>الاعتماد على <code>onlyChanged</code> لتقييد الكتابة بأكملها — فرض الباقي في منطق التطبيق.</>,
            <>الثقة بحقل مالك يرسله العميل — قارن <code>auth.uid</code> ببديل المسار.</>,
            <>السماح بالتحديث دون فحص البيانات المخزّنة — أضف <code>unchanged(['ownerId'])</code>.</>,
            <>نسيان الرفض الافتراضي — عدم تطابق أي قاعدة يعني الرفض.</>,
          ]}
        />
        <P>
          تابع مع <PageLink slug="security-rules" lang="ar">قواعد الأمان</PageLink> لمعرفة مُقيِّم وقت
          التشغيل ودلالات المتغيرات.
        </P>
      </Section>
    </Doc>
  );
}
