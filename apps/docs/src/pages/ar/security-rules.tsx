import {
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
      title="قواعد الأمان"
      description="شجرة قواعد v1 بصيغة JSON، وتقييم حتمي بالرفض الافتراضي، وحدّا عمق 10 وعقدة 100، ودون أي استخدام لـ eval."
      eyebrow="الأمان"
    >
      <Section id="overview" title="نظرة عامة">
        <P>
          تحدّد قواعد الأمان ما إذا كان مفتاح API عام (<code>pk_</code>) مسموحاً له قراءة مستند أو الكتابة فيه.
          تُخزَّن القواعد في مستوى التحكم كـ<strong>شجرة تعبيرات مجرّدة (AST) بصيغة JSON مُنشّأة</strong>، وتُقيَّم
          متزامنةً في الذاكرة — دون توليد شيفرة أو تنفيذها إطلاقاً. أمّا المفاتيح الخادمة (<code>sk_</code>) فتتجاوز
          شجرة القواعد للعمليات التي تغطيها نطاقاتها (<code>documents:read</code> و <code>documents:write</code>)،
          بينما تخضع المفاتيح العامة للتقييم دائماً.
        </P>
        <Callout tone="warning" title="الرفض هو الافتراض">
          <P>
            إذا لم تُطابق أي قاعدة المسار ولم يُعدّ أي تعبير ذا قيمة <code>true</code> للعملية المطلوبة، رُفض الطلب
            بالرمز <code>PERMISSION_DENIED</code> والحالة <code>403</code>. وكذلك يُرفض أي طلب بمفتاح عام عندما لا
            توجد مجموعة قواعد فعّالة في المشروع.
          </P>
        </Callout>
      </Section>

      <Section id="ast-shape" title="شكل مجموعة القواعد (v1)">
        <P>
          يجب أن يكون <code>version</code> مساوياً للقيمة <code>1</code> وأن تكون <code>rules</code> مصفوفة. تحتوي كل
          قاعدة على نمط <code>match</code> وكائن <code>allow</code> مفاتيحه أسماء العمليات: <code>get</code> و{" "}
          <code>list</code> و <code>create</code> و <code>update</code> و <code>delete</code>، إضافةً إلى الاختصارين{" "}
          <code>read</code> (يغطّي <code>get</code> و <code>list</code>) و <code>write</code> (يغطّي{" "}
          <code>create</code> و <code>update</code> و <code>delete</code>).
        </P>
        <Code
          lang="json"
          title="ruleset.json"
          code={`{
  "version": 1,
  "rules": [
    {
      "match": "users/{userId}",
      "allow": {
        "get": { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } },
        "list": { "op": "==", "left": { "var": "auth.claims.role" }, "right": { "val": "admin" } },
        "create": {
          "op": "all",
          "conditions": [
            { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } },
            { "op": "==", "left": { "var": "request.data.ownerId" }, "right": { "var": "auth.uid" } }
          ]
        },
        "update": { "op": "==", "left": { "var": "resource.data.ownerId" }, "right": { "var": "auth.uid" } },
        "delete": { "op": "==", "left": { "var": "auth.claims.role" }, "right": { "val": "admin" } }
      }
    }
  ]
}`}
        />
        <P>
          في هذا المثال يقرأ كل مستخدم مستندَه الخاص فقط، وتُقيد قائمة المستخدمين (<code>list</code>) والحذف على
          أصحاب المطالبة <code>role = admin</code>، بينما يشترط الإنشاء (<code>create</code>) تحقّق شرطين معاً عبر
          المُركّب <code>all</code>.
        </P>
        <H3 id="wildcards">مطابقة المسارات والبدائل</H3>
        <UL
          items={[
            <>
              <code>{"{paramName}"}</code> يربط مقطعاً واحداً من المسار بالمتغير <code>path.paramName</code>؛ ففي{" "}
              <code>users/{"{userId}"}</code> يصبح معرّف المستخدم متاحاً عبر <code>path.userId</code>.
            </>,
            <>
              <code>{"{document=**}"}</code> في نهاية النمط يطابق مقطعاً واحداً أو أكثر ويربط المسار الفرعي النسبي
              بالمتغير <code>path.document</code>.
            </>,
            <>
              إذا طابقت قواعد متعددة المسار نفسه، فالوصول يُمنح عندما تُقيَّم أي قاعدة منها إلى <code>true</code>
              للعملية (دلالة OR). أمّا عدم المطابقة أو كذب كل التعابير فمعناه الرفض.
            </>,
          ]}
        />
      </Section>

      <Section id="operators" title="المشغلات والمتغيرات">
        <P>
         كل تعبير إمّا قيمة منطقية مجرّدة (<code>true</code> أو <code>false</code>) أو عقدة تحمل <code>op</code>{" "}
          ومعاملين <code>left</code> و <code>right</code>، أو مُركّباً يحمل <code>conditions</code> أو{" "}
          <code>condition</code>. المعامل إمّا حرفي <code>{"{ \"val\": ... }"}</code> أو قيمة سياق{" "}
          <code>{"{ \"var\": \"...\" }"}</code>. وتستخدم المقارنات منطق المساواة والترتيب نفسه الذي يستخدمه محرّك
          الاستعلام على قيم الإرسال الموسومة.
        </P>
        <Table
          head={["الفئة", "المشغلات"]}
          rows={[
            ["المقارنات", <><code>==</code>، <code>!=</code>، <code>&lt;</code>، <code>&lt;=</code>، <code>&gt;</code>، <code>&gt;=</code>، <code>in</code></>],
            ["الكائن والنوع", <><code>hasKey</code> و <code>isType</code></>],
            ["الدمج", <><code>all</code> (كل <code>conditions</code>)، <code>any</code> (بعضها)، <code>not</code> (شرط واحد <code>condition</code>)</>],
          ]}
        />
        <P>
          يقبل <code>isType</code> الأنواع <code>null</code> و <code>bool</code>/<code>boolean</code> و{" "}
          <code>string</code> و <code>number</code> و <code>array</code> و <code>map</code>، إضافةً إلى وسم قيم
          الإرسال الموسومة مثل <code>$t</code>. أمّا <code>hasKey</code> فيختبر وجود مفتاح في كائن، و <code>in</code>{" "}
          فيختبر انتماء القيمة إلى مصفوفة.
        </P>
        <Table
          head={["المتغير", "المعنى"]}
          rows={[
            [<code>auth.uid</code>, <>معرّف المستخدم النهائي من رمز الحامل، أو <code>null</code> بدونه.</>],
            [
              <><code>auth.email</code> و <code>auth.email_verified</code> و <code>auth.is_anonymous</code></>,
              "حقول الهوية القادمة من الرمز.",
            ],
            [<code>auth.claims.&lt;path&gt;</code>, <>مطالبة من مطالبات المستخدم النهائي؛ و <code>request.auth.*</code> اسم بديل لها.</>],
            [<code>path.&lt;param&gt;</code>, <>القيمة التي يربطها البديل في <code>match</code>.</>],
            [<code>resource.data[.&lt;path&gt;]</code>, <>بيانات المستند الحالية، و <code>null</code> عند الإنشاء.</>],
            [<code>request.data[.&lt;path&gt;]</code>, <>البيانات الواردة، و <code>null</code> في عمليات القراءة والحذف.</>],
            [<code>request.time</code>, "وقت الطلب بالمللي ثانية منذ الحقبة."],
          ]}
        />
      </Section>

      <Section id="bounds" title="حدود التحقق والحتمية">
        <P>
          تُفحص القواعد على مستوى النشر قبل أن تصبح فعّالة، ويُقيَّم التعبير زمن التنفيذ في الذاكرة فقط: لا تنفيذ
          ديناميكي للشيفرة، ولا استدعاءات شبكية، ولا إدخال/إخراج متكرر. لذلك لا يمكن لتعبير معقّد أن يحوّل الطلب إلى
          وسيلة لإنكار الخدمة.
        </P>
        <Table
          head={["القيد أو الحالة", "السلوك"]}
          rows={[
            ["عمق الشجرة", <>الحد الأقصى <strong>10</strong>؛ وتجاوزه يُصدر <code>QUERY_TOO_COMPLEX</code>.</>],
            ["عدد العقد", <>الحد الأقصى <strong>100 عقدة لكل تعبير قاعدة</strong>؛ وتجاوزه يُصدر <code>QUERY_TOO_COMPLEX</code>.</>],
            ["مراجع دائرية", <>تُرفض أثناء التحقق بالرمز <code>INVALID_ARGUMENT</code>.</>],
            ["شكل غير صالح", <><code>version</code> ≠ 1، أو غياب <code>match</code>/<code>allow</code>، أو عملية/مشغّل غير مدعوم — كله يُرفض بـ <code>INVALID_ARGUMENT</code>.</>],
            ["مشغّل أو متغير مجهول", <>يُقيَّم إلى <code>false</code>، فيؤدي إلى الرفض افتراضياً.</>],
            ["لا قاعدة مطابقة", <>يُصدر <code>PERMISSION_DENIED</code> (403) عند التقييم.</>],
          ]}
        />
        <Callout tone="danger" title="صفر eval">
          <P>
            لا يستخدم VELLUM الدوال <code>eval()</code> أو <code>new Function()</code> أو أي تنفيذ ديناميكي للشيفرة غير
            الموثوقة. الشجرة بيانات تُفحص وفق مخطط v1 ثم تُفسَّر باستخدام قائمة مشغّلات ثابتة؛ ولهذا لا يمكن لصياغة
            قاعدة أن تخرج عن حدود التقييم الحتمي. راجع{" "}
            <PageLink slug="reference/errors" lang="ar">رموز الأخطاء</PageLink> لمعرفة حالات HTTP المرافقة.
          </P>
        </Callout>
      </Section>

      <Section id="publishing" title="النشر والمحاكاة">
        <P>
          تُنشر المجموعة عبر واجهة مستوى التحكم بالمصادقة الجلسية؛ فيُتحقق من الشجرة، وتُكتب سجلّة تدقيق، وتُلغى
          ذاكرة التخزين المؤقت محلياً وعبر مثيلات الخدمة الأخرى بواسطة <code>NOTIFY vellum_cache_invalidate</code>.
          ويسري الأثر فوراً على المشروع المعني.
        </P>
        <Table
          head={["الطريقة", "نقطة النهاية", "الوظيفة"]}
          rows={[
            ["POST", <code>/v1/projects/:projectId/rulesets</code>, <>التحقق من شجرة جديدة ونشرها؛ يُعيد 201 ويسجّل <code>ruleset.published</code>.</>],
            ["GET", <code>/v1/projects/:projectId/rulesets</code>, "قراءة المجموعة الفعّالة أو المجموعة المدمجة الافتراضية."],
          ]}
        />
        <CodeTabs
          tabs={[
            {
              label: "curl",
              lang: "bash",
              code: `curl -X POST "https://api.vellum.dev/v1/projects/<PROJECT_ID>/rulesets" \\
  -H "Authorization: Bearer <SESSION_TOKEN>" \\
  -H "content-type: application/json" \\
  -d '{ "rulesAst": { "version": 1, "rules": [] } }'`,
            },
            {
              label: "جسم الطلب",
              lang: "json",
              code: `{
  "rulesAst": {
    "version": 1,
    "rules": [
      {
        "match": "users/{userId}",
        "allow": { "read": { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } } }
      }
    ]
  }
}`,
            },
          ]}
        />
        <P>
          توفّر لوحة التحكم <strong>محاكي القواعد</strong> (Rule Simulator) لتجربة شجرة مرشحة مقابل سياق مصادقة ومسار
          ومستند مُحاكى، وإظهار ما إذا كان الطلب سيُسمح وأي قاعدة طابقته — كل ذلك قبل النشر. ويمكن أيضاً التحقق من
          شجرة مرشحة بمفتاح عام. ولمعرفة كيفية ربط القواعد بسياق الهوية، راجع{" "}
          <PageLink slug="end-user-auth" lang="ar">المستخدمين النهائيين والمجالات الثلاثة</PageLink>.
        </P>
      </Section>

      <Section id="least-privilege" title="أنماط أقل الامتيازات والأخطاء الشائعة">
        <P>
          اربط ملكية المستند ببديل في المسار ولا تثق بحقل يرسله العميل، وتحقق من <code>resource.data</code> عند
          التحديث حتى لا يتمكن تعديل خبيث من نقل الملكية. استخدم <code>read</code> و <code>write</code> كاختصارين
          عندما تنطبق القاعدة نفسها على كلتا العمليتين.
        </P>
        <Code
          lang="json"
          title="orders rule"
          code={`{
  "match": "users/{userId}/orders/{orderId}",
  "allow": {
    "get": { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } },
    "create": {
      "op": "all",
      "conditions": [
        { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } },
        { "op": "isType", "left": { "var": "request.data.total" }, "right": { "val": "number" } }
      ]
    }
  }
}`}
        />
        <UL
          items={[
            <>
              <strong>الثقة بحقل ملكية يرسله العميل:</strong> اربط الملكية ببديل المسار وقارنها بـ <code>auth.uid</code>.
            </>,
            <>
              <strong>السماح بالتحديث دون فحص <code>resource.data</code>:</strong> قد ينقل تصحيح ضار الملكية إذا فحصت
              البيانات الواردة وحدها.
            </>,
            <>
              <strong>نسيان الرفض الافتراضي:</strong> لا يوجد تطابق يعني الرفض؛ انشر المجموعة وتحقق من أن{" "}
              <code>version: 1</code>.
            </>,
            <>
              <strong>شجرة عميقة أو كبيرة:</strong> تجاوز العمق 10 أو الـ 100 عقدة يُصدر{" "}
              <code>QUERY_TOO_COMPLEX</code> وقت النشر — قسّم القواعد إلى قواعد أصغر.
            </>,
          ]}
        />
        <P>
          تُطابق القواعد مسارات المستندات الموصوفة في{" "}
          <PageLink slug="crud" lang="ar">CRUD ومسارات المستندات</PageLink>؛ وتُقيَّم المطالبات المستخدمة هنا من رموز
          المستخدم النهائي الموضحة في{" "}
          <PageLink slug="end-user-auth" lang="ar">صفحة المصادقة</PageLink>.
        </P>
      </Section>
    </Doc>
  );
}
