import {
  popupTs, redirectTs, gisTs, callbackTs, flutterBrowserDart, flutterDeepLinkDart, androidBackupXml, flutterNativeDart, flutterPubspec, androidManifest, iosPlist, desktopDart, flutterAppleDart, appleJsTs } from "../../social-login-examples";
import { AlphaNotice, Callout, Code, CodeTabs, Doc, P, PageLink, Section, UL } from "../../ui";

export default function Page() {
  return (
    <Doc
      eyebrow="المفاهيم الأساسية"
      title="تسجيل الدخول الاجتماعي (Google وGitHub وApple)"
      description="دع المستخدمين يسجّلون الدخول بحساب Google أو GitHub أو Apple من الويب أو من تطبيق Flutter. ينفّذ Vellum خطوات OAuth على الخادم، فلا يتعامل تطبيقك مع أي سر خاص بالمزوّد."
    >
      <AlphaNotice lang="ar" />
      <Callout tone="warning" title="يتطلب الإصدار 0.0.3 أو أحدث">
        الدوال في هذه الصفحة متاحة من الإصدار 0.0.3 لحزمتي JavaScript وFlutter.
      </Callout>

      <Section id="how" title="كيف يعمل">
        <UL items={[
          <>يبدأ تطبيقك العملية. يرسل Vellum المستخدم إلى Google أو GitHub أو Apple ويستقبل النتيجة على الخادم.</>,
          <>يتحقق Vellum من الهوية لدى المزوّد. يُقبل فقط بريد إلكتروني موثّق، ولا يُربط حساب موجود إلا
          عندما يكون هذا البريد موثّقاً.</>,
          <>يعود المستخدم إلى تطبيقك برمز يُستخدم مرة واحدة. يبدّله تطبيقك بجلسة. يعمل الرمز مرة واحدة ولمدة
          دقيقتين، ومع السر الذي ولّده تطبيقك عند البدء فقط.</>,
        ]} />
      </Section>

      <Section id="setup" title="إعداد المزوّد">
        <UL items={[
          <>أنشئ OAuth client لدى Google (من نوع Web application) أو OAuth App لدى GitHub، أو Services ID لدى Apple (انظر أدناه).</>,
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
        <Callout tone="warning" title="رمز التأكيد يحمي مستخدميك">
          ينتهي تسجيل الدخول بدون إعادة توجيه (وكذلك ربط مزوّد بحساب مسجّل) بخطوة إدخال رمز. يعرض تطبيقك رمزاً قصيراً عبر <code>onConfirmationCode</code>،
          وتطلب صفحة المتصفح من الشخص كتابته قبل إتمام تسجيل الدخول. بدون ذلك قد يرسل مهاجم رابطاً يجعل الضحية يسجّل الدخول إلى تطبيق المهاجم،
          أو يربط حساب Google الخاص بالضحية بحساب المهاجم. اعرض الرمز بوضوح أثناء <code>signIn</code> (في نافذة أو شريط) وأخفِه عند اكتمال العملية.
          تذكر الصفحة اسم مشروعك وتحذّر الشخص من المتابعة إلا إذا بدأ العملية بنفسه. خمس محاولات خاطئة تُنهي المحاولة.
        </Callout>
        <P>
          بدون عنوان رجوع (redirect URI) يفتح الـSDK متصفح النظام ويجلب النتيجة بالاستعلام الدوري من الـAPI باستخدام PKCE verifier لا يغادر تطبيقك.
          لا تضيف شيئا إلى AndroidManifest.xml أو Info.plist ولا إلى Auth Studio، ويستمر العمل حتى لو أعاد النظام إنشاء تطبيقك أثناء فتح المتصفح.
          بعد تسجيل الدخول يعود المستخدم إلى تطبيقك فيكتمل الدخول. هذه هي الطريقة الموصى بها على Android وiOS.
        
          هذا الخيار معطّل افتراضياً: فعّله من Auth Studio (المزوّدون، "تسجيل الدخول بدون إعادة توجيه")، وإلا سيعرض الـSDK رسالة أن الميزة متوقفة لهذا المشروع. اعرف المقايضة قبل ذلك:
          يؤكد الشخص تسجيل الدخول بكتابة الرمز الذي يعرضه تطبيقك، لكن تطبيقاً مزيفاً يشغّله مهاجم يستطيع عرض الرمز أيضاً، فقد يخدع مهاجم مصرّ المستخدم ليوافق على تسجيل دخول لتطبيق المهاجم.
          الرابط العميق، وأفضل منه App Link أو Universal Link، لا يصل إلا إلى تطبيقك أنت فلا يعاني من هذه الثغرة. استخدم الخيار عندما لا تستطيع تسجيل رابط، وفضّل الروابط للتطبيقات التي تحمل بيانات حساسة.
        </P>
        <P>
          تفضّل الرابط العميق؟ مرّر مخططا مخصصا مثل <code>myapp://auth-callback</code> وأضفه إلى قائمة عناوين الرجوع المسموحة وسجّله في تطبيقك كأي رابط عميق.
          على Windows وLinux يمكنك أيضا استخدام loopback بمنفذ ثابت أو بالمنفذ 0 (يختار النظام منفذاً حراً لكل محاولة، ويقبل الـAPI أي منفذ على 127.0.0.1). المشغّل المدمج لا يغطي Flutter web؛ استخدم مسار الويب هناك.
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

      <Section id="apple" title="تسجيل الدخول بحساب Apple">
        <P>
          إذا كان تطبيق iOS يقدّم الدخول بـGoogle أو GitHub فإن بند App Store رقم 4.8 يشترط خياراً مماثلاً يحمي الخصوصية، أي عملياً Sign in with Apple.
          في بوابة Apple Developer أنشئ Services ID (وهو معرّف عميل الويب) وفعّل Sign in with Apple له وسجّل رابط الرجوع (callback) أعلاه.
          ثم أنشئ مفتاح Sign in with Apple ونزّل ملف <code>.p8</code> مرة واحدة فقط. في Auth Studio &gt; Providers &gt; Apple أدخل Services ID ومعرّف الفريق (Team ID) ومعرّف المفتاح (Key ID) والصق محتوى ملف <code>.p8</code>.
          يُشفَّر المفتاح عند التخزين ولا يُعاد أبداً. يوقّع Vellum منه سراً قصير العمر لكل عملية تبادل.
        </P>
        <P>
          تقبل Apple رابط رجوع HTTPS فقط على نطاق حقيقي: بلا <code>localhost</code> وبلا عنوان IP وبلا جزء fragment. لاختبار تدفق الويب محلياً استخدم نفقاً (tunnel) أو نطاقاً تجريبياً.
          لا توثّق Apple دعم PKCE في نقطة الرموز لديها، لذلك لا يرسل Vellum تحدّي الشيفرة إلى Apple. تبقى state ورمز التأكيد يحميان التدفق من جهة Vellum.
        </P>
        <P>
          في التدفق الأصلي على iOS وAndroid أضف معرّفات حزم التطبيق (bundle IDs) إلى معرّفات العملاء الإضافية. يُقبل رمز الهوية فقط إذا كان جمهوره Services ID أو أحد هذه المعرّفات.
          مرّر nonce عشوائياً: أعطِ Apple قيمته المجزأة بـSHA-256 وأعطِ Vellum القيمة الخام. يُرفض الرمز الذي يحمل nonce إذا لم يُرسَل nonce.
          يفشل تسجيل الدخول إذا حذفت Apple مطالبة البريد الإلكتروني، وقد يحدث ذلك لمستخدم يخفي بريده لاحقاً. في Flutter مرّر الـnonce دائماً كما في المثال: جزّئه لـApple وأعطِ Vellum القيمة الخام.
          لا ترسل Apple اسم المستخدم إلا في أول تسجيل دخول، لذا مرّر <code>givenName</code> و<code>familyName</code> حينها. وقد تخفي Apple البريد الحقيقي خلف عنوان وسيط، ويقبله Vellum فقط عندما تعلّمه Apple موثّقاً.
        </P>
        <P>
          عندما يحذف المستخدم حسابه أو يفك ربط Apple يلغي Vellum منحة Apple كما تشترط Apple. يحتاج هذا إلى <code>authorizationCode</code> من تسجيل الدخول، فمرّره.
        </P>
        <Code lang="dart" title="Apple الأصلي مع sign_in_with_apple (اختياري)" code={flutterAppleDart} />
        <Code lang="ts" title="JavaScript" code={appleJsTs} />
      </Section>

      <Section id="security" title="ملاحظات أمنية">
        <UL items={[
          <>تُفحص رموز Apple بمفاتيح Apple المنشورة والجهة المُصدرة والجمهور وانتهاء الصلاحية وقيمة nonce.</>,
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
