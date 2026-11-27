export const DOCS_JSONLD_TYPE = "TechArticle";

/** Shared UI strings. */
export const T = {
  en: {
    brandTag: "Document database on PostgreSQL",
    nav: { features: "Features", sdks: "SDKs", security: "Security", docs: "Docs", signin: "Sign in", start: "Get started" },
    skip: "Skip to content",
    footer: { product: "Product", resources: "Resources", legal: "Legal", privacy: "Privacy", terms: "Terms", llms: "llms.txt for AI", openapi: "OpenAPI", github: "GitHub", contact: "Contact", beta: "Public beta. APIs may change before a stable release.", lang: "العربية" },
    notFound: { title: "Page not found", body: "This page does not exist. It may have moved.", home: "Back to home", docs: "Read the docs" },
  },
  ar: {
    brandTag: "قاعدة بيانات مستندات على PostgreSQL",
    nav: { features: "المميزات", sdks: "الحزم البرمجية", security: "الأمان", docs: "التوثيق", signin: "تسجيل الدخول", start: "ابدأ الآن" },
    skip: "انتقل إلى المحتوى",
    footer: { product: "المنتج", resources: "المراجع", legal: "قانوني", privacy: "الخصوصية", terms: "الشروط", llms: "llms.txt للذكاء الاصطناعي", openapi: "OpenAPI", github: "GitHub", contact: "تواصل", beta: "نسخة تجريبية عامة. قد تتغير واجهات البرمجة قبل الإصدار المستقر.", lang: "English" },
    notFound: { title: "الصفحة غير موجودة", body: "هذه الصفحة غير موجودة. ربما تم نقلها.", home: "العودة للرئيسية", docs: "اقرأ التوثيق" },
  },
};

const faq = {
  en: [
    ["What is Vellum?", "Vellum is a multi-tenant document database platform that runs entirely on PostgreSQL. It gives you collections of typed JSON documents, a REST and WebSocket API, declarative security rules, end-user authentication and official JavaScript and Flutter SDKs."],
    ["Does Vellum need Redis or a message broker?", "No. PostgreSQL is the only stateful dependency. Realtime streaming uses LISTEN/NOTIFY with a durable outbox, and access decisions are read from the database on every request."],
    ["Which SDKs are available?", "The JavaScript and TypeScript SDK is published on npm as @vellumdb/sdk-js, and the Flutter SDK is published on pub.dev as vellum_flutter."],
    ["Is Vellum production ready?", "Vellum is in public beta (version 0.0.8). Every package shares one version, and APIs may still change before a stable release."],
    ["Can an AI coding assistant use Vellum?", "Yes. The docs publish llms.txt, llms-full.txt, a Markdown version of every page, a ready prompt and a public OpenAPI file for the data API."],
  ],
  ar: [
    ["ما هو Vellum؟", "Vellum منصة قاعدة بيانات مستندات متعددة المستأجرين تعمل بالكامل على PostgreSQL. توفر مجموعات من مستندات JSON المنمّطة، وواجهة REST وWebSocket، وقواعد أمان تصريحية، ومصادقة للمستخدمين النهائيين، وحزم رسمية لـ JavaScript وFlutter."],
    ["هل يحتاج Vellum إلى Redis أو وسيط رسائل؟", "لا. PostgreSQL هو المكوّن الوحيد الذي يحفظ الحالة. البث الفوري يعتمد على LISTEN/NOTIFY مع صندوق إرسال دائم، وقرارات الوصول تُقرأ من قاعدة البيانات في كل طلب."],
    ["ما الحزم البرمجية المتاحة؟", "حزمة JavaScript وTypeScript منشورة على npm باسم @vellumdb/sdk-js، وحزمة Flutter منشورة على pub.dev باسم vellum_flutter."],
    ["هل Vellum جاهز للإنتاج؟", "Vellum في مرحلة تجريبية عامة (الإصدار 0.0.8). كل الحزم تشترك في إصدار واحد، وقد تتغير واجهات البرمجة قبل الإصدار المستقر."],
    ["هل يستطيع مساعد برمجة بالذكاء الاصطناعي استخدام Vellum؟", "نعم. يوفر التوثيق ملفات llms.txt وllms-full.txt ونسخة Markdown لكل صفحة وتعليمات جاهزة وملف OpenAPI عامًا لواجهة البيانات."],
  ],
};
export const FAQ = faq;

export const PAGES = [
  {
    slug: "home",
    title: { en: "Vellum | PostgreSQL-native document database", ar: "Vellum | قاعدة بيانات مستندات على PostgreSQL" },
    desc: {
      en: "Vellum is a multi-tenant document database that runs entirely on PostgreSQL, with a REST and realtime API, end-user auth, security rules and SDKs for JavaScript and Flutter.",
      ar: "Vellum قاعدة بيانات مستندات متعددة المستأجرين تعمل بالكامل على PostgreSQL، مع واجهة REST وبث فوري ومصادقة وقواعد أمان وحزم لـ JavaScript وFlutter.",
    },
    body: {
      en: {
        h1: "A document database that runs on the PostgreSQL you already trust",
        lead: "Vellum gives you collections, typed documents, queries, relations, realtime updates and end-user sign-in. There is no Redis and no broker. PostgreSQL holds all state.",
        cta: [["Read the quickstart", "/docs/quickstart"], ["Open the console", "/login"]],
        install: [["JavaScript", "npm install @vellumdb/sdk-js"], ["Flutter", "flutter pub add vellum_flutter"]],
        sections: [
          ["What Vellum is", "Vellum is a multi-tenant document database platform. It stores typed JSON documents in hierarchical collections, serves them over a REST and WebSocket API, and enforces access with declarative security rules."],
          ["Built for developers", "Official SDKs for JavaScript and Flutter keep setup short: auto-generated document ids, automatic token refresh, caching, references between documents and realtime listeners with an automatic fallback."],
          ["Predictable on serverless", "Everything that decides access is read from PostgreSQL on every request. Behaviour is the same on one server or many, including serverless functions."],
        ],
        cards: [
          ["Documents and queries", "Typed JSON documents, 13 query operators, composite indexes and cursor pagination.", "/features"],
          ["Relations", "Mark references, include related documents, look up reverse references and set delete rules.", "/features"],
          ["Realtime", "WebSocket first, with an automatic server-sent events fallback for serverless hosts.", "/features"],
          ["Sign-in for your users", "Email and password, Google and GitHub sign-in, and TOTP multi-factor authentication.", "/security"],
          ["Security rules", "Declarative rules with a bounded evaluation budget and row-level security in the database.", "/security"],
          ["Built for AI assistants", "llms.txt, Markdown for every page, a ready prompt and a public OpenAPI file.", "/docs/ai-agents"],
        ],
        faqTitle: "Frequently asked questions",
      },
      ar: {
        h1: "قاعدة بيانات مستندات تعمل على PostgreSQL الذي تثق به",
        lead: "يوفر Vellum مجموعات ومستندات منمّطة واستعلامات وعلاقات وتحديثات فورية وتسجيل دخول للمستخدمين. لا يوجد Redis ولا وسيط رسائل. PostgreSQL يحفظ كل الحالة.",
        cta: [["اقرأ البدء السريع", "/docs/ar/quickstart"], ["افتح لوحة التحكم", "/login"]],
        install: [["JavaScript", "npm install @vellumdb/sdk-js"], ["Flutter", "flutter pub add vellum_flutter"]],
        sections: [
          ["ما هو Vellum", "Vellum منصة قاعدة بيانات مستندات متعددة المستأجرين. تخزّن مستندات JSON منمّطة في مجموعات هرمية، وتقدمها عبر واجهة REST وWebSocket، وتفرض الوصول بقواعد أمان تصريحية."],
          ["مصمم للمطورين", "الحزم الرسمية لـ JavaScript وFlutter تقصّر الإعداد: معرّفات تلقائية للمستندات، وتجديد تلقائي للرموز، وتخزين مؤقت، ومراجع بين المستندات، ومستمعون فوريون مع بديل تلقائي."],
          ["ثابت على الخوادم بلا حالة", "كل ما يقرر الوصول يُقرأ من PostgreSQL في كل طلب. السلوك نفسه على خادم واحد أو عدة خوادم، بما فيها دوال serverless."],
        ],
        cards: [
          ["المستندات والاستعلامات", "مستندات JSON منمّطة و13 عامل استعلام وفهارس مركبة وترقيم بالمؤشر.", "/ar/features"],
          ["العلاقات", "علّم المراجع، وضمّن المستندات المرتبطة، وابحث عن المراجع العكسية، وحدد قواعد الحذف.", "/ar/features"],
          ["الوقت الفعلي", "WebSocket أولًا، مع بديل تلقائي عبر الأحداث المرسلة من الخادم للاستضافة بلا حالة.", "/ar/features"],
          ["تسجيل دخول لمستخدميك", "بريد وكلمة مرور، وتسجيل عبر Google وGitHub، ومصادقة متعددة العوامل TOTP.", "/ar/security"],
          ["قواعد الأمان", "قواعد تصريحية بميزانية تقييم محدودة وأمان على مستوى الصفوف في قاعدة البيانات.", "/ar/security"],
          ["مصمم لمساعدي الذكاء الاصطناعي", "llms.txt وMarkdown لكل صفحة وتعليمات جاهزة وملف OpenAPI عام.", "/docs/ar/ai-agents"],
        ],
        faqTitle: "الأسئلة الشائعة",
      },
    },
  },
  {
    slug: "features",
    title: { en: "Features | Vellum", ar: "المميزات | Vellum" },
    desc: {
      en: "Documents, queries, composite indexes, relations, transactions and realtime on PostgreSQL. What Vellum does and how.",
      ar: "المستندات والاستعلامات والفهارس المركبة والعلاقات والمعاملات والوقت الفعلي على PostgreSQL. ماذا يقدم Vellum وكيف.",
    },
    body: {
      en: {
        h1: "Features",
        lead: "Everything below runs on PostgreSQL, with no extra services to operate.",
        sections: [
          ["Documents and collections", "Hierarchical collections hold typed JSONB documents. The SDKs can generate document ids for you."],
          ["Queries", "Thirteen operators, including equality, ranges, in and not-in, array-contains, case-insensitive contains and prefix match, and text search, plus or groups. Queries compile to parameterized SQL and paginate with signed cursors."],
          ["Composite indexes", "Multi-field indexes are built without creating a PostgreSQL index per tenant, and an index advisor suggests what your queries need."],
          ["Relations", "Mark a field as a reference, include related documents in a read, find which documents point at a given one, and choose a delete rule: cascade, set null or restrict. The console shows a relations map and a preview of related records."],
          ["Transactions", "Optimistic concurrency with batch writes and multi-step transactions."],
          ["Realtime", "Listeners receive changes over WebSocket. On hosts where long-lived sockets are not available, the SDK falls back to server-sent events automatically."],
          ["Console", "Create organizations and projects, manage API keys, browse data, run queries, edit rules and indexes, and review usage."],
        ],
      },
      ar: {
        h1: "المميزات",
        lead: "كل ما يلي يعمل على PostgreSQL، دون خدمات إضافية تحتاج إلى تشغيلها.",
        sections: [
          ["المستندات والمجموعات", "تحتوي المجموعات الهرمية على مستندات JSONB منمّطة. يمكن للحزم البرمجية توليد معرّفات المستندات لك."],
          ["الاستعلامات", "ثلاثة عشر عاملًا تشمل المساواة والنطاقات وin وnot-in وarray-contains والاحتواء والبادئة بلا حساسية لحالة الأحرف والبحث النصي، مع مجموعات or. تُترجم الاستعلامات إلى SQL مُعامَل وتُرقَّم بمؤشرات موقّعة."],
          ["الفهارس المركبة", "تُبنى الفهارس متعددة الحقول دون إنشاء فهرس PostgreSQL لكل مستأجر، ويقترح مستشار الفهارس ما تحتاجه استعلاماتك."],
          ["العلاقات", "علّم حقلًا كمرجع، وضمّن المستندات المرتبطة عند القراءة، واعرف أي المستندات تشير إلى مستند معيّن، واختر قاعدة الحذف: تتالي أو تعيين null أو منع. تعرض لوحة التحكم خريطة العلاقات ومعاينة للسجلات المرتبطة."],
          ["المعاملات", "تزامن تفاؤلي مع كتابات دفعية ومعاملات متعددة الخطوات."],
          ["الوقت الفعلي", "يستقبل المستمعون التغييرات عبر WebSocket. وفي الاستضافة التي لا تدعم الاتصالات الطويلة، تعود الحزمة تلقائيًا إلى الأحداث المرسلة من الخادم."],
          ["لوحة التحكم", "أنشئ المؤسسات والمشاريع، وأدر مفاتيح API، وتصفح البيانات، ونفّذ الاستعلامات، وعدّل القواعد والفهارس، وراجع الاستخدام."],
        ],
      },
    },
  },
  {
    slug: "sdks",
    title: { en: "SDKs for JavaScript and Flutter | Vellum", ar: "حزم JavaScript وFlutter | Vellum" },
    desc: {
      en: "Install the Vellum SDK for JavaScript (@vellumdb/sdk-js) or Flutter (vellum_flutter). One package per platform, no extra native setup.",
      ar: "ثبّت حزمة Vellum لـ JavaScript (@vellumdb/sdk-js) أو Flutter (vellum_flutter). حزمة واحدة لكل منصة دون إعداد native إضافي.",
    },
    body: {
      en: {
        h1: "SDKs",
        lead: "One package per platform. Both are at version 0.0.8 and share the platform version.",
        install: [["JavaScript and TypeScript (npm)", "npm install @vellumdb/sdk-js"], ["Flutter (pub.dev)", "flutter pub add vellum_flutter"]],
        sections: [
          ["JavaScript and TypeScript", "Works in browsers and Node.js. Includes auto-generated ids, automatic token refresh, caching, document references and Google and GitHub sign-in with popup or redirect."],
          ["Flutter", "A single Flutter package with secure token storage and system-browser Google and GitHub sign-in built in, so you do not add native setup. Third-party sign-in libraries stay optional."],
          ["Connect to your project", "Create a project in the console, create an API key, then point the SDK at your project. The quickstart shows the exact client setup for each platform."],
        ],
        cta: [["Quickstart", "/docs/quickstart"], ["SDK reference", "/docs"]],
      },
      ar: {
        h1: "الحزم البرمجية",
        lead: "حزمة واحدة لكل منصة. كلتاهما بالإصدار 0.0.8 وتشتركان في إصدار المنصة.",
        install: [["JavaScript وTypeScript (npm)", "npm install @vellumdb/sdk-js"], ["Flutter (pub.dev)", "flutter pub add vellum_flutter"]],
        sections: [
          ["JavaScript وTypeScript", "تعمل في المتصفح وNode.js. تشمل معرّفات تلقائية وتجديدًا تلقائيًا للرموز وتخزينًا مؤقتًا ومراجع للمستندات وتسجيل دخول عبر Google وGitHub بنافذة منبثقة أو إعادة توجيه."],
          ["Flutter", "حزمة Flutter واحدة تتضمن تخزينًا آمنًا للرموز وتسجيل دخول Google وGitHub عبر متصفح النظام، فلا تحتاج إلى إعداد native. مكتبات تسجيل الدخول الخارجية تبقى اختيارية."],
          ["اربط مشروعك", "أنشئ مشروعًا في لوحة التحكم، ثم أنشئ مفتاح API، ثم وجّه الحزمة إلى مشروعك. يعرض البدء السريع إعداد العميل الدقيق لكل منصة."],
        ],
        cta: [["البدء السريع", "/docs/ar/quickstart"], ["مرجع الحزم", "/docs/ar"]],
      },
    },
  },
  {
    slug: "security",
    title: { en: "Security | Vellum", ar: "الأمان | Vellum" },
    desc: {
      en: "How Vellum protects your data: row-level security in PostgreSQL, declarative rules, isolated end-user tokens, MFA and database-backed access decisions.",
      ar: "كيف يحمي Vellum بياناتك: أمان على مستوى الصفوف في PostgreSQL، وقواعد تصريحية، ورموز معزولة للمستخدمين النهائيين، ومصادقة متعددة العوامل، وقرارات وصول مخزنة في قاعدة البيانات.",
    },
    body: {
      en: {
        h1: "Security",
        lead: "Vellum is in public beta. These are the controls the platform ships with today.",
        sections: [
          ["Isolation by design", "The control plane and the data plane use separate databases. Every data table enforces row-level security keyed on the current project, and fails closed."],
          ["Declarative rules", "Security rules decide who can read and write each collection. Evaluation has a fixed step budget so a rule cannot run away."],
          ["End-user authentication", "End-user tokens are signed per project and are isolated from console sessions. Sign-in supports email and password, Google and GitHub with server-side PKCE and state checks, and TOTP multi-factor authentication with recovery codes and lockouts."],
          ["Database-backed decisions", "API keys, allowed origins, session revocations, memberships, throttles and quotas are read from PostgreSQL on every request, so no access decision depends on one server's memory."],
          ["Request guards", "Payload size and query cost limits, CSRF and SSRF protections, constant-time secret comparison and safe client IP handling behind proxies."],
          ["Publishable keys", "Keys intended for client apps are scoped to a project and its allowed origins. Keep admin and server credentials out of client code."],
          ["Report an issue", "Write to mohammedaydan12@gmail.com with details and we will respond."],
        ],
      },
      ar: {
        h1: "الأمان",
        lead: "Vellum في مرحلة تجريبية عامة. هذه هي الضوابط التي تأتي مع المنصة اليوم.",
        sections: [
          ["عزل مدمج في التصميم", "يستخدم مستوى التحكم ومستوى البيانات قاعدتي بيانات منفصلتين. كل جدول بيانات يفرض أمانًا على مستوى الصفوف مرتبطًا بالمشروع الحالي، ويفشل بإغلاق الوصول."],
          ["قواعد تصريحية", "تحدد قواعد الأمان من يقرأ ويكتب في كل مجموعة. للتقييم عدد خطوات ثابت كي لا تخرج القاعدة عن السيطرة."],
          ["مصادقة المستخدمين النهائيين", "تُوقَّع رموز المستخدمين النهائيين لكل مشروع وتُعزل عن جلسات لوحة التحكم. يدعم تسجيل الدخول البريد وكلمة المرور وGoogle وGitHub مع PKCE وفحص state على الخادم، ومصادقة متعددة العوامل TOTP مع رموز استرداد وأقفال."],
          ["قرارات مخزنة في قاعدة البيانات", "تُقرأ مفاتيح API والأصول المسموح بها وإلغاء الجلسات والعضويات وحدود المعدل والحصص من PostgreSQL في كل طلب، فلا يعتمد أي قرار وصول على ذاكرة خادم واحد."],
          ["حماية الطلبات", "حدود لحجم الحمولة وتكلفة الاستعلام، وحماية من CSRF وSSRF، ومقارنة أسرار بزمن ثابت، ومعالجة آمنة لعنوان IP خلف الوكلاء."],
          ["المفاتيح القابلة للنشر", "المفاتيح المخصصة لتطبيقات العميل مقيدة بمشروع وأصوله المسموحة. أبقِ بيانات اعتماد الإدارة والخادم خارج كود العميل."],
          ["الإبلاغ عن مشكلة", "راسلنا على mohammedaydan12@gmail.com مع التفاصيل وسنرد."],
        ],
      },
    },
  },
];
