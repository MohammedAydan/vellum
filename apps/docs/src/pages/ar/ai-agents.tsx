import { buildAgentPrompt, DEFAULT_DOCS_ORIGIN } from "../../agent-prompt";
import { Callout, Code, Doc, P, Section, Table, UL } from "../../ui";

export default function Page() {
  const origin = typeof window === "undefined" ? DEFAULT_DOCS_ORIGIN : window.location.origin;
  return (
    <Doc
      eyebrow="البداية"
      title="استخدام VELLUM مع وكلاء الذكاء الاصطناعي"
      description="أعطِ مساعد البرمجة ما يحتاجه لفهم المنصة واستخدام الحزم البرمجية بشكل صحيح: توثيق بصيغة Markdown، وملف فهرس، وتعليمات جاهزة."
    >
      <Section id="prompt" title="التعليمات الجاهزة">
        <P>
          الصق هذا النص في المساعد قبل أن تطلب منه بناء أي شيء. يوجّه المساعد إلى التوثيق بصيغة Markdown ويذكر القواعد التي
          تمنع أكثر الأخطاء شيوعًا. يمكنك أيضًا حفظه باسم <code>AGENTS.md</code> في مشروعك، وهو متاح بالنص نفسه في{" "}
          <code>/docs/AGENTS.md</code>.
        </P>
        <Code lang="markdown" title="Agent prompt" code={buildAgentPrompt(origin)} />
      </Section>

      <Section id="markdown" title="التوثيق بصيغة Markdown">
        <P>كل صفحة توثيق متاحة أيضًا كنص Markdown عادي دون عناصر الموقع.</P>
        <Table
          head={["ماذا", "أين"]}
          rows={[
            ["فهرس كل الصفحات", <code>/docs/llms.txt</code>],
            ["كل الصفحات في ملف واحد", <code>/docs/llms-full.txt</code>],
            ["صفحة واحدة", <>أضف <code>.md</code> إلى رابطها، مثل <code>/docs/query.md</code></>],
            ["الصفحات العربية", <><code>/docs/ar/llms.txt</code> و<code>/docs/ar/query.md</code></>],
            ["وصف واجهة HTTP", <><code>/docs/openapi.json</code> (OpenAPI 3.1)</>],
          ]}
        />
        <P>
          في أي صفحة، تتيح قائمة «نسخ الصفحة» نسخها بصيغة Markdown، أو فتح ملف Markdown، أو فتح الصفحة في ChatGPT أو Claude
          مع طلب يشير إليها.
        </P>
      </Section>

      <Section id="tips" title="للحصول على نتائج جيدة">
        <UL
          items={[
            "أخبر المساعد بالحزمة التي تستخدمها: TypeScript أو Flutter.",
            "مرّر له العنوان ومعرّف المشروع والمفتاح عبر متغيرات البيئة. لا تلصق مفتاحًا سريًا في محادثة أبدًا.",
            "اطلب منه ذكر صفحات التوثيق التي استند إليها، وجرّب الشيفرة على مشروع اختبار قبل الاعتماد عليها.",
          ]}
        />
        <Callout tone="info" title="المفاتيح">
          استخدم مفتاح <code>pk_</code> القابل للنشر في تطبيقات الويب والجوال مع تسجيل دخول المستخدم النهائي، وأبقِ مفاتيح{" "}
          <code>sk_</code> على خادمك.
        </Callout>
      </Section>
    </Doc>
  );
}
