import {
  popupTs, redirectTs, gisTs, callbackTs, flutterBrowserDart, flutterNativeDart, flutterPubspec, androidManifest,
} from "../../social-login-examples";
import { AlphaNotice, Callout, Code, CodeTabs, Doc, P, PageLink, Section, UL } from "../../ui";

export default function Page() {
  return (
    <Doc
      eyebrow="المفاهيم الأساسية"
      title="تسجيل الدخول الاجتماعي (Google وGitHub)"
      description="دع المستخدمين يسجّلون الدخول بحساب Google أو GitHub من الويب أو من تطبيق Flutter. ينفّذ Vellum خطوات OAuth على الخادم، فلا يتعامل تطبيقك مع أي سر خاص بالمزوّد."
    >
      <AlphaNotice lang="ar" />
      <Callout tone="warning" title="الإصدار القادم من الحزم">
        الدوال في هذه الصفحة تصدر بعد الإصدار 0.0.2. هي موجودة في المستودع ولم تُنشر بعد على npm أو pub.dev.
      </Callout>

      <Section id="how" title="كيف يعمل">
        <UL items={[
          <>يبدأ تطبيقك العملية. يرسل Vellum المستخدم إلى Google أو GitHub ويستقبل النتيجة على الخادم.</>,
          <>يتحقق Vellum من الهوية لدى المزوّد. يُقبل فقط بريد إلكتروني موثّق، ولا يُربط حساب موجود إلا
          عندما يكون هذا البريد موثّقاً.</>,
          <>يعود المستخدم إلى تطبيقك برمز يُستخدم مرة واحدة. يبدّله تطبيقك بجلسة. يعمل الرمز مرة واحدة ولمدة
          دقيقتين، ومع السر الذي ولّده تطبيقك عند البدء فقط.</>,
        ]} />
      </Section>

      <Section id="setup" title="إعداد المزوّد">
        <UL items={[
          <>أنشئ OAuth client لدى Google (من نوع Web application) أو OAuth App لدى GitHub.</>,
          <>سجّل عنوان Callback هذا لدى المزوّد:
          <code> /v1/projects/&lt;projectId&gt;/auth/oauth/google/callback</code> أو
          <code> /auth/oauth/github/callback</code> على عنوان الـ API الخاص بك.</>,
          <>احفظ معرّف العميل وسره في إعدادات المصادقة للمشروع. السر مشفّر في التخزين ولا يُعاد عرضه أبداً.</>,
          <>أضف كل صفحة أو رابط تطبيق قد يعود إليه المستخدم (مثل <code>https://app.example.com/login</code> أو <code>myapp://auth-callback</code>)
          إلى عناوين الرجوع المسموحة. أي عنوان خارج القائمة يُرفض.</>,
        ]} />
      </Section>

      <Section id="web" title="الويب: نافذة منبثقة أو إعادة توجيه">
        <P>
          النافذة المنبثقة تُبقي صفحتك كما هي. إعادة التوجيه أنسب لمتصفحات الهاتف التي تحجب النوافذ المنبثقة غالباً.
          يمكن أن تكون صفحة العودة هي صفحة تسجيل الدخول نفسها. تزيل الحزمة النتيجة من شريط العنوان.
        </P>
        <CodeTabs tabs={[
          { label: "نافذة منبثقة", lang: "ts", code: popupTs },
          { label: "إعادة توجيه", lang: "ts", code: redirectTs },
          { label: "Google Identity Services", lang: "ts", code: gisTs },
          { label: "صفحة عودة النافذة (اختياري)", lang: "ts", code: callbackTs },
        ]} />
      </Section>

      <Section id="flutter" title="Flutter">
        <P>
          أضف الحزمة المرافقة. تفتح جلسة المتصفح الآمنة للنظام على iOS وAndroid وmacOS وWindows وLinux والويب،
          وتعيد النتيجة إلى Vellum.
        </P>
        <Code lang="bash" title="pubspec.yaml" code={flutterPubspec} />
        <Code lang="dart" title="تسجيل الدخول" code={flutterBrowserDart} />
        <P>
          يحتاج Android إلى إدخال واحد في ملف manifest لمخطط رابط تطبيقك. لا يحتاج iOS وmacOS إلى إعداد لمخطط مخصص.
          على الويب يكون عنوان الرجوع صفحة https من تطبيقك تولّدها الإضافة؛ راجع توثيق الإضافة.
        </P>
        <Code lang="xml" title="AndroidManifest.xml (داخل application)" code={androidManifest} />
        <P>
          تفضّل منتقي الحسابات الأصلي لـ Google؟ استخدم حزمة <code>google_sign_in</code> الرسمية عبر الحزمة نفسها.
          أضف معرّفات عملاء Android وiOS إلى إعدادات Google في مشروعك ليُقبل رمزها.
        </P>
        <Code lang="dart" title="Google الأصلي (اختياري)" code={flutterNativeDart} />
      </Section>

      <Section id="security" title="ملاحظات أمنية">
        <UL items={[
          <>لا تصل رموز المزوّد إلى تطبيقك. تُفحص رموز Google بمفاتيح Google المنشورة والجهة المُصدرة والجمهور وانتهاء الصلاحية.</>,
          <>يحتاج مستخدمو GitHub إلى بريد أساسي موثّق. لا يُوثق بالبريد المعروض في الملف العام أبداً.</>,
          <>إذا فُعّل عامل ثانٍ للحساب، يعيد تسجيل الدخول تحدّياً تكمله بـ <code>verifyMfaChallenge</code>.</>,
          <>استدعاء <code>signInWithOAuth</code> القديم الذي يحمل ادعاءات المزوّد ما زال يتطلب مفتاح خادم سرياً ومخصصاً للخادم الخلفي لديك.
          راجع <PageLink slug="end-user-auth" lang="ar">مصادقة المستخدمين النهائيين</PageLink>.</>,
        ]} />
      </Section>
    </Doc>
  );
}
