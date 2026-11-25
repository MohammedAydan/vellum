import {
  popupTs, redirectTs, gisTs, callbackTs, flutterBrowserDart, flutterDeepLinkDart, androidBackupXml, flutterNativeDart, flutterPubspec, androidManifest, iosPlist, desktopDart,
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
      <Callout tone="warning" title="يتطلب الإصدار 0.0.3 أو أحدث">
        الدوال في هذه الصفحة متاحة من الإصدار 0.0.3 لحزمتي JavaScript وFlutter.
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
          هذا مدمج في vellum_flutter. يفتح متصفح النظام (بدون webview وبدون إضافة تثبّتها) ويعيد النتيجة إلى Vellum.
        </P>
        <Code lang="bash" title="pubspec.yaml" code={flutterPubspec} />
        <Code lang="dart" title="تسجيل الدخول" code={flutterBrowserDart} />
        <P>
          بدون عنوان رجوع (redirect URI) يفتح الـSDK متصفح النظام ويجلب النتيجة بالاستعلام الدوري من الـAPI باستخدام PKCE verifier لا يغادر تطبيقك.
          لا تضيف شيئا إلى AndroidManifest.xml أو Info.plist ولا إلى Auth Studio، ويستمر العمل حتى لو أعاد النظام إنشاء تطبيقك أثناء فتح المتصفح.
          بعد تسجيل الدخول يعود المستخدم إلى تطبيقك فيكتمل الدخول. هذه هي الطريقة الموصى بها على Android وiOS.
        </P>
        <P>
          تفضّل الرابط العميق؟ مرّر مخططا مخصصا مثل <code>myapp://auth-callback</code> وأضفه إلى قائمة عناوين الرجوع المسموحة وسجّله في تطبيقك كأي رابط عميق.
          على Windows وLinux يمكنك أيضا استخدام loopback بمنفذ ثابت. المشغّل المدمج لا يغطي Flutter web؛ استخدم مسار الويب هناك.
        </P>
        <Code lang="dart" title="رابط عميق (اختياري)" code={flutterDeepLinkDart} />
        <P>
          إذا استخدمت رابطا عميقا ففضّل Android App Links (روابط <code>https://</code> موثّقة عبر <code>assetlinks.json</code>) أو iOS Universal Links
          (<code>apple-app-site-association</code>) على المخطط المخصص: أي تطبيق آخر يستطيع تسجيل نفس المخطط المخصص، أما رابط https الموثّق فلا يفتح إلا تطبيقك. استخدم رابط https هذا كقيمة <code>redirectUri</code> وأضفه إلى قائمة عناوين الرجوع المسموحة.
          الرمز المؤقت مرتبط أيضا بـPKCE verifier فلا يمكن استبداله لو اعترضه تطبيق آخر، لكن الروابط الموثّقة تمنع المحاولة من الأساس.
        </P>
        <P>
          تُحفظ الجلسة في Keychain (على iOS وmacOS، متاحة بعد أول فتح قفل ولا تُنسخ إلى جهاز آخر) وفي مخزن Android المدعوم بـKeystore. على iOS يبقى Keychain بعد حذف التطبيق، لذلك يمسح الـSDK مفاتيح جلسته عند أول تشغيل بعد تثبيت جديد.
          على Android أبعد ملف مخزن الجلسة عن النسخ الاحتياطي حتى لا تُستعاد بيانات مشفّرة بدون مفتاحها:
        </P>
        <Code lang="xml" title="استبعاد ملف التخزين الآمن من نسخ Android الاحتياطي" code={androidBackupXml} />
        <Code lang="xml" title="AndroidManifest.xml (داخل MainActivity)" code={androidManifest} />
        <Code lang="xml" title="Info.plist (iOS وmacOS)" code={iosPlist} />
        <Code lang="dart" title="رجوع loopback على سطح المكتب" code={desktopDart} />
        <P>
          تفضّل منتقي الحسابات الأصلي لـ Google؟ أضف حزمة <code>google_sign_in</code> الرسمية إلى تطبيقك ومرّر رمز الهوية إلى <code>signInWithGoogleIdToken</code>.
          يُقبل الرمز فقط إذا كان جمهوره (audience) أحد معرّفات عملاء Google في مشروعك. إن مرّرت معرّف عميل الويب كـ<code>serverClientId</code> (كما أعلاه) فهو المعرّف المضبوط أصلا. وإن لم تفعل يصدر Google الرمز لمعرّف عميل Android أو iOS، فأضفهما إلى "معرّفات عملاء Google إضافية" في Auth Studio &gt; Providers &gt; Google وإلا فشل الدخول.
        </P>
        <Code lang="dart" title="Google الأصلي مع google_sign_in (اختياري)" code={flutterNativeDart} />
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
