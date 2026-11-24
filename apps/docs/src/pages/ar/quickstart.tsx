import { SdkEndpointNote } from "../../sdk-endpoint-note";
import { betaJavaScriptInstall, betaDartInstall } from "../../beta-install";
import { quickstartTypeScript, quickstartDart } from "../../quickstart-examples";
import { AlphaNotice, Callout, Code, CodeTabs, Doc, P, PageLink, Section, UL } from "../../ui";
export default function Page() {
  return <Doc eyebrow="البداية" title="البدء السريع" description="تحقق من جاهزية API، وثبّت نسخة Beta، ثم اكتب واقرأ واستعلم واحذف مع تنظيف موارد العميل.">
    <AlphaNotice lang="ar" />
    <SdkEndpointNote arabic />
      <Section id="beta-install" title="تثبيت النسخة التجريبية">
      <P>الإصدار 0.0.2 متاح على npm وpub.dev. ثبّت الحزم المنشورة أدناه، ولا تحتاج إلى نسخة من المستودع.</P>
      <Code lang="bash" title="TypeScript / Node 22+" code={betaJavaScriptInstall} />
      <Code lang="yaml" title="Flutter / Dart 3.4+" code={betaDartInstall} />
    </Section>
    <Section id="verify-health" title="1. التحقق من حياة API وجاهزيته">
      <P>يفحص /health حياة العملية دون PostgreSQL. يفحص /ready اتصالي قواعد البيانات ويعيد 503 أثناء الإغلاق التدريجي. تتوفر أيضاً المسارات ذات الإصدار أدناه.</P>
      <Code lang="bash" code={`curl -fsS http://localhost:8080/health
curl -fsS http://localhost:8080/ready
curl -fsS http://localhost:8080/v1/health/live
curl -fsS http://localhost:8080/v1/health/ready`} />
    </Section>
    <Section id="install" title="2. تثبيت الحزمة">
      <P>استخدم خطوات Beta أعلاه مع Node 22 أو Dart 3.4 فأحدث. اضبط VELLUM_PROJECT_ID وVELLUM_API_KEY لمشروعك، واحتفظ بمفتاح sk_ في الخادم الموثوق فقط. استخدم pk_ مع مصادقة المستخدم وقواعد الأمان في التطبيقات.</P>
    </Section>
    <Section id="first-operations" title="3. الكتابة والقراءة والاستعلام والحذف">
      <P>المثالان متطابقان مع النسخة الإنجليزية: إنشاء مستند، قراءة إصداره، تحديث ذري بشرط الإصدار، استعلام، حذف، ثم dispose() داخل finally حتى عند الفشل. تمرر متغيرات Dart باستخدام --define.</P>
      <CodeTabs tabs={[
        { label: "TypeScript", lang: "ts", code: quickstartTypeScript },
        { label: "Flutter / Dart", lang: "dart", code: quickstartDart },
      ]} />
    </Section>
    <Section id="operators-at-a-glance" title="4. معاملات الاستعلام الثلاثة عشر">
      <UL items={[
        <>المقارنة: <code>== != &lt; &lt;= &gt; &gt;=</code>.</>,
        <>المجموعات: <code>in</code> و<code>not-in</code>، حتى 30 قيمة لكل منهما.</>,
        <>المصفوفات: <code>array-contains</code> و<code>array-contains-any</code>، حتى 30 قيمة و120 توسعاً للاستعلام.</>,
        <>النص: <code>contains_ci</code> و<code>starts_with_ci</code> و<code>text_search</code>، حتى 1024 حرفاً للمعامل.</>,
      ]} />
      <P>راجع <PageLink slug="query" lang="ar">دليل الاستعلام</PageLink> للترشيح والترتيب والإسقاط.</P>
    </Section>
    <Section id="dispose-best-practices" title="5. دورة حياة العميل وتنظيف الموارد">
      <Callout tone="info" title="تحتاج تحكماً أكثر؟">
        تستخدم هذه الصفحة الإعدادات الافتراضية فقط. المعرفات والرموز وسياسة الكاش والمراجع ونقل الوقت الفعلي في{" "}
        <PageLink slug="advanced" lang="ar">الإعدادات المتقدمة</PageLink>. استدعِ <code>collection.doc()</code> دون وسيط للحصول على معرّف تلقائي.
      </Callout>
      <Callout tone="warning" title="استدعِ dispose() عند إنهاء العميل">استدعِ db.dispose() داخل finally في البرامج والاختبارات. في التطبيق طويل العمر شارك عميلاً واحداً ونظفه عند إنهاء التطبيق أو الواجهة، لإغلاق المؤقتات والذاكرة واتصالات WebSocket.</Callout>
      <P>تابع <PageLink slug="pagination" lang="ar">الترقيم الصفحي</PageLink> و<PageLink slug="realtime" lang="ar">الوقت الفعلي</PageLink> و<PageLink slug="production-checklist" lang="ar">قائمة الإنتاج</PageLink>.</P>
    </Section>
  </Doc>;
}
