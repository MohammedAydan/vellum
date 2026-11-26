/** Copy for the redesigned public pages. */
export const SNIP = {
  hero: `import { createClient } from "@vellumdb/sdk-js";

const db = createClient({
  endpoint: "https://api.example.com",
  projectId: "your-project-id",
  apiKey: "pk_...",
});

const page = await db
  .collection("tasks")
  .where("status", "==", "open")
  .where("tags", "array-contains", "launch")
  .orderBy("priority", "desc")
  .limit(20)
  .get();`,
  rulesShort: `match /users/{userId}/notes/{noteId} {
  allow get, list: if isOwner(path.userId);
  allow delete: if isOwner(path.userId);
}`,
  ts: `import { createClient } from "@vellumdb/sdk-js";

const db = createClient({
  endpoint: "https://api.example.com",
  projectId: "your-project-id",
  apiKey: "pk_...",
});

// Query across any of 13 operators
const page = await db
  .collection("tasks")
  .where("status", "==", "open")
  .where("tags", "array-contains", "launch")
  .orderBy("priority", "desc")
  .limit(20)
  .get();

// Live updates over WebSocket
const stop = db
  .collection("tasks")
  .where("status", "==", "open")
  .onSnapshot((snap) => render(snap.docs));`,
  dart: `import 'package:vellum_flutter/vellum_flutter.dart';

final db = VellumClient(
  endpoint: 'https://api.example.com',
  projectId: 'your-project-id',
  apiKey: 'pk_...',
);

final ref = db.collection('tasks').doc('task_01');

await ref.set({
  'title': 'Ship the launch page',
  'status': 'open',
  'createdAt': FieldOp.serverTimestamp(),
});

final snap = await ref.get();
print('v\${snap.version} \${snap.data()}');`,
  include: `const posts = await db
  .collection("posts")
  .where("published", "==", true)
  .include(["author"])
  .limit(25)
  .get();`,
  rules: `match /users/{userId}/notes/{noteId} {
  allow get, list: if isOwner(path.userId);
  allow create: if isOwner(path.userId)
    && isType(incoming.title, 'string');
  allow delete: if isOwner(path.userId);
}`,
  realtime: `const stop = db
  .collection("messages")
  .where("roomId", "==", "room_general")
  .onSnapshot((snap) => {
    console.log(snap.docs.length);
  });`,
  term: `$ curl https://vellum-console.vercel.app/llms.txt
$ curl https://vellum-console.vercel.app/docs/llms-full.txt
$ curl https://vellum-console.vercel.app/docs/quickstart.md
$ curl https://vellum-console.vercel.app/docs/openapi.json`,
};

export const C = {
  en: {
    menu: "Menu",
    copy: "Copy", copied: "Copied",
    hero: {
      badge: "Public beta · 0.0.6",
      h1a: "The document database",
      h1b: "that lives in PostgreSQL",
      lead: "Collections, typed documents, queries, relations, realtime and end-user sign-in. One database to run. No Redis, no broker, no extra moving parts.",
      cta1: "Start with the quickstart", cta2: "Read the docs",
      note: "Open source · MIT",
      feedTitle: "Live",
      feed: [["updated", "tasks/task_01", "v4"], ["created", "tasks/task_02", "v1"], ["updated", "tasks/task_01", "v5"], ["deleted", "tasks/task_02", ""]],
    },
    stats: [["1", "database to operate", "PostgreSQL only"], ["13", "query operators", "parameterized SQL"], ["2", "official SDKs", "JavaScript and Flutter"], ["EN + AR", "documentation", "with Markdown for AI"]],
    how: { eyebrow: "Architecture", h2: "Your app talks to one API. PostgreSQL does the rest.", p: "Clients and SDKs call a REST and WebSocket API. The control plane and the data plane live in separate PostgreSQL databases, and every access decision is read from the database on each request.", nodes: ["Your app", "JavaScript · Flutter · REST", "Vellum API", "REST + realtime", "Control plane", "orgs · keys · rules", "Data plane", "documents · indexes"], pg: "PostgreSQL" },
    bento: {
      eyebrow: "Everything in one place", h2: "Built for the way apps actually use data",
      q: ["Queries that read like code", "Thirteen operators, composite indexes and cursor pagination, compiled to parameterized SQL."],
      r: ["Relations you can follow", "Mark a reference, include related documents in one read, and choose cascade, set null or restrict on delete."],
      rt: ["Realtime, anywhere", "WebSocket first. On serverless hosts the SDK falls back to server-sent events by itself."],
      a: ["Sign-in for your users", "Email and password, Google, GitHub and Apple, plus TOTP multi-factor authentication."],
      s: ["Rules at the database", "Declarative security rules and row-level security, so access does not depend on client code."],
      i: ["Indexes without ceremony", "Composite indexes build without a PostgreSQL index per tenant, with an advisor that suggests what you need."],
      providers: ["Email", "Google", "GitHub", "Apple", "TOTP"],
    },
    sdk: { eyebrow: "SDKs", h2: "One package per platform", p: "No native setup to add. Pick your platform and start reading and writing documents.", tabs: ["JavaScript", "Flutter"], install: ["npm install @vellumdb/sdk-js", "flutter pub add vellum_flutter"], more: "SDK guides" },
    ai: { eyebrow: "Built for AI assistants", h2: "Your coding assistant can read the docs too", p: "Vellum publishes llms.txt, a full-text version, Markdown for every page, a ready prompt for your assistant and a public OpenAPI file for the data API.", cta: "Use with AI agents" },
    faqTitle: "Frequently asked questions",
    cta: { h2: "Ship your next app on Vellum", p: "Create a project, grab a key and write your first document in a few minutes.", a: "Open the quickstart", b: "Create an account" },
    feat: {
      h1: "Everything your data layer needs", lead: "Documents, queries, relations, transactions and realtime, running on PostgreSQL with nothing else to operate.",
      rows: [
        ["Documents and queries", "Hierarchical collections hold typed JSONB documents, and the SDKs can generate ids for you. Queries support equality, ranges, in and not-in, array-contains, case-insensitive contains and prefix match, text search and or groups. They compile to parameterized SQL and paginate with signed cursors.", "code:ts"],
        ["Relations", "Mark a field as a reference, include related documents in a read, find which documents point at a given one, and choose a delete rule: cascade, set null or restrict.", "graph"],
        ["Realtime", "Listeners receive changes over WebSocket, and resume after a reconnect without missing events. Where long-lived sockets are not available, the SDK falls back to server-sent events automatically.", "feed"],
        ["Indexes and transactions", "Multi-field indexes are built without creating a PostgreSQL index per tenant, and an advisor suggests what your queries need. Writes use optimistic concurrency, with batches and multi-step transactions.", "chips"],
      ],
      chips: ["composite indexes", "index advisor", "optimistic concurrency", "batch writes", "transactions", "cursor pagination", "text search", "field operations"],
    },
    sdks: {
      h1: "SDKs for JavaScript and Flutter", lead: "One package per platform. Both are at version 0.0.6 and share the platform version.",
      rows: [
        ["JavaScript and TypeScript", "Works in browsers and Node.js. Includes auto-generated ids, automatic token refresh, caching, document references and Google, GitHub and Apple sign-in.", "npm install @vellumdb/sdk-js", "ts"],
        ["Flutter", "A single Flutter package with secure token storage and system-browser sign-in built in, so you add no native setup. Third-party sign-in libraries stay optional.", "flutter pub add vellum_flutter", "dart"],
      ],
      steps: [["Create a project", "Make a project and an API key for it."], ["Install the SDK", "Add the package for your platform."], ["Point it at your project", "Set the endpoint, project id and key. The quickstart has the exact setup."]],
      cta: "Open the quickstart",
    },
    sec: {
      h1: "Security you can reason about", lead: "Vellum is in public beta. These are the controls the platform ships with today.",
      planes: ["Control plane", "organizations, projects, keys, rulesets", "Data plane", "documents, indexes, realtime", "separate databases", "row-level security, fails closed"],
      cards: [
        ["Isolation by design", "The control plane and the data plane use separate databases. Every data table enforces row-level security keyed on the current project, and fails closed."],
        ["Declarative rules", "Security rules decide who can read and write each collection. Evaluation has a fixed step budget so a rule cannot run away."],
        ["End-user authentication", "Tokens are signed per project and isolated from other sessions. Sign-in supports email and password, Google, GitHub and Apple, with TOTP multi-factor authentication, recovery codes and lockouts."],
        ["Database-backed decisions", "API keys, allowed origins, session revocations, memberships, throttles and quotas are read from PostgreSQL on every request, so no access decision depends on one server's memory."],
        ["Request guards", "Payload size and query cost limits, CSRF and SSRF protections, constant-time secret comparison and safe client IP handling behind proxies."],
        ["Publishable keys", "Keys for client apps are scoped to a project and its allowed origins. Keep server credentials out of client code."],
      ],
      rulesTitle: "Rules read like policy",
      rulesP: "A rule says who may read or write a path. If no rule allows an operation, it is denied.",
      report: ["Report an issue", "Write to mohammedaydan12@gmail.com with details and we will respond.", "Email us"],
    },
    pagecta: "Read the docs",
  },
  ar: {
    menu: "القائمة",
    copy: "نسخ", copied: "تم النسخ",
    hero: {
      badge: "نسخة تجريبية عامة · 0.0.6",
      h1a: "قاعدة بيانات المستندات",
      h1b: "التي تعيش داخل PostgreSQL",
      lead: "مجموعات ومستندات منمّطة واستعلامات وعلاقات ووقت فعلي وتسجيل دخول للمستخدمين. قاعدة بيانات واحدة تشغّلها. بلا Redis ولا وسيط رسائل ولا أجزاء إضافية.",
      cta1: "ابدأ بالبدء السريع", cta2: "اقرأ التوثيق",
      note: "مفتوح المصدر · MIT",
      feedTitle: "مباشر",
      feed: [["تحديث", "tasks/task_01", "v4"], ["إنشاء", "tasks/task_02", "v1"], ["تحديث", "tasks/task_01", "v5"], ["حذف", "tasks/task_02", ""]],
    },
    stats: [["1", "قاعدة بيانات للتشغيل", "PostgreSQL فقط"], ["13", "عامل استعلام", "SQL مُعامَل"], ["2", "حزمة رسمية", "JavaScript وFlutter"], ["EN + AR", "توثيق", "مع Markdown للذكاء الاصطناعي"]],
    how: { eyebrow: "البنية", h2: "تطبيقك يتحدث مع واجهة واحدة. وPostgreSQL يتولى الباقي.", p: "تستدعي الحزم والعملاء واجهة REST وWebSocket. يعيش مستوى التحكم ومستوى البيانات في قاعدتي PostgreSQL منفصلتين، وكل قرار وصول يُقرأ من قاعدة البيانات في كل طلب.", nodes: ["تطبيقك", "JavaScript · Flutter · REST", "واجهة Vellum", "REST + وقت فعلي", "مستوى التحكم", "مؤسسات · مفاتيح · قواعد", "مستوى البيانات", "مستندات · فهارس"], pg: "PostgreSQL" },
    bento: {
      eyebrow: "كل شيء في مكان واحد", h2: "مصمم للطريقة التي تستخدم بها التطبيقات بياناتها",
      q: ["استعلامات تُقرأ كالكود", "ثلاثة عشر عاملًا وفهارس مركبة وترقيم بالمؤشر، تُترجم إلى SQL مُعامَل."],
      r: ["علاقات يمكنك تتبعها", "علّم مرجعًا، وضمّن المستندات المرتبطة في قراءة واحدة، واختر تتالي أو تعيين null أو منع عند الحذف."],
      rt: ["وقت فعلي في أي مكان", "WebSocket أولًا. وعلى الاستضافة بلا حالة تعود الحزمة تلقائيًا إلى الأحداث المرسلة من الخادم."],
      a: ["تسجيل دخول لمستخدميك", "بريد وكلمة مرور وGoogle وGitHub وApple، مع مصادقة متعددة العوامل TOTP."],
      s: ["قواعد عند قاعدة البيانات", "قواعد أمان تصريحية وأمان على مستوى الصفوف، فلا يعتمد الوصول على كود العميل."],
      i: ["فهارس بلا تعقيد", "تُبنى الفهارس المركبة دون فهرس PostgreSQL لكل مستأجر، مع مستشار يقترح ما تحتاجه."],
      providers: ["بريد", "Google", "GitHub", "Apple", "TOTP"],
    },
    sdk: { eyebrow: "الحزم البرمجية", h2: "حزمة واحدة لكل منصة", p: "لا إعداد native إضافي. اختر منصتك وابدأ بقراءة المستندات وكتابتها.", tabs: ["JavaScript", "Flutter"], install: ["npm install @vellumdb/sdk-js", "flutter pub add vellum_flutter"], more: "أدلة الحزم" },
    ai: { eyebrow: "مصمم لمساعدي الذكاء الاصطناعي", h2: "مساعدك البرمجي يستطيع قراءة التوثيق أيضًا", p: "ينشر Vellum ملف llms.txt ونسخة نصية كاملة وMarkdown لكل صفحة وتعليمات جاهزة لمساعدك وملف OpenAPI عامًا لواجهة البيانات.", cta: "الاستخدام مع وكلاء الذكاء الاصطناعي" },
    faqTitle: "الأسئلة الشائعة",
    cta: { h2: "أطلق تطبيقك القادم على Vellum", p: "أنشئ مشروعًا، وخذ مفتاحًا، واكتب أول مستند خلال دقائق.", a: "افتح البدء السريع", b: "أنشئ حسابًا" },
    feat: {
      h1: "كل ما تحتاجه طبقة بياناتك", lead: "مستندات واستعلامات وعلاقات ومعاملات ووقت فعلي، تعمل على PostgreSQL دون شيء آخر لتشغيله.",
      rows: [
        ["المستندات والاستعلامات", "تحتوي المجموعات الهرمية على مستندات JSONB منمّطة، ويمكن للحزم توليد المعرّفات لك. تدعم الاستعلامات المساواة والنطاقات وin وnot-in وarray-contains والاحتواء والبادئة بلا حساسية لحالة الأحرف والبحث النصي ومجموعات or. تُترجم إلى SQL مُعامَل وتُرقَّم بمؤشرات موقّعة.", "code:ts"],
        ["العلاقات", "علّم حقلًا كمرجع، وضمّن المستندات المرتبطة عند القراءة، واعرف أي المستندات تشير إلى مستند معيّن، واختر قاعدة الحذف: تتالي أو تعيين null أو منع.", "graph"],
        ["الوقت الفعلي", "يستقبل المستمعون التغييرات عبر WebSocket، ويستأنفون بعد انقطاع الاتصال دون فقدان أحداث. وحيث لا تتوفر الاتصالات الطويلة تعود الحزمة تلقائيًا إلى الأحداث المرسلة من الخادم.", "feed"],
        ["الفهارس والمعاملات", "تُبنى الفهارس متعددة الحقول دون إنشاء فهرس PostgreSQL لكل مستأجر، ويقترح مستشار الفهارس ما تحتاجه استعلاماتك. الكتابة بتزامن تفاؤلي، مع دفعات ومعاملات متعددة الخطوات.", "chips"],
      ],
      chips: ["فهارس مركبة", "مستشار الفهارس", "تزامن تفاؤلي", "كتابة دفعية", "معاملات", "ترقيم بالمؤشر", "بحث نصي", "عمليات على الحقول"],
    },
    sdks: {
      h1: "حزم JavaScript وFlutter", lead: "حزمة واحدة لكل منصة. كلتاهما بالإصدار 0.0.6 وتشتركان في إصدار المنصة.",
      rows: [
        ["JavaScript وTypeScript", "تعمل في المتصفح وNode.js. تشمل معرّفات تلقائية وتجديدًا تلقائيًا للرموز وتخزينًا مؤقتًا ومراجع للمستندات وتسجيل دخول عبر Google وGitHub وApple.", "npm install @vellumdb/sdk-js", "ts"],
        ["Flutter", "حزمة Flutter واحدة تتضمن تخزينًا آمنًا للرموز وتسجيل دخول عبر متصفح النظام، فلا تضيف إعداد native. مكتبات تسجيل الدخول الخارجية تبقى اختيارية.", "flutter pub add vellum_flutter", "dart"],
      ],
      steps: [["أنشئ مشروعًا", "أنشئ مشروعًا ومفتاح API له."], ["ثبّت الحزمة", "أضف الحزمة لمنصتك."], ["وجّهها إلى مشروعك", "حدد الـ endpoint ومعرّف المشروع والمفتاح. يعرض البدء السريع الإعداد الدقيق."]],
      cta: "افتح البدء السريع",
    },
    sec: {
      h1: "أمان يمكنك فهمه", lead: "Vellum في مرحلة تجريبية عامة. هذه هي الضوابط التي تأتي مع المنصة اليوم.",
      planes: ["مستوى التحكم", "مؤسسات ومشاريع ومفاتيح وقواعد", "مستوى البيانات", "مستندات وفهارس ووقت فعلي", "قاعدتان منفصلتان", "أمان على مستوى الصفوف، يفشل بإغلاق الوصول"],
      cards: [
        ["عزل مدمج في التصميم", "يستخدم مستوى التحكم ومستوى البيانات قاعدتي بيانات منفصلتين. كل جدول بيانات يفرض أمانًا على مستوى الصفوف مرتبطًا بالمشروع الحالي، ويفشل بإغلاق الوصول."],
        ["قواعد تصريحية", "تحدد قواعد الأمان من يقرأ ويكتب في كل مجموعة. للتقييم عدد خطوات ثابت كي لا تخرج القاعدة عن السيطرة."],
        ["مصادقة المستخدمين النهائيين", "تُوقَّع الرموز لكل مشروع وتُعزل عن بقية الجلسات. يدعم تسجيل الدخول البريد وكلمة المرور وGoogle وGitHub وApple، مع مصادقة متعددة العوامل TOTP ورموز استرداد وأقفال."],
        ["قرارات مخزنة في قاعدة البيانات", "تُقرأ مفاتيح API والأصول المسموح بها وإلغاء الجلسات والعضويات وحدود المعدل والحصص من PostgreSQL في كل طلب، فلا يعتمد أي قرار وصول على ذاكرة خادم واحد."],
        ["حماية الطلبات", "حدود لحجم الحمولة وتكلفة الاستعلام، وحماية من CSRF وSSRF، ومقارنة أسرار بزمن ثابت، ومعالجة آمنة لعنوان IP خلف الوكلاء."],
        ["المفاتيح القابلة للنشر", "المفاتيح المخصصة لتطبيقات العميل مقيدة بمشروع وأصوله المسموحة. أبقِ بيانات اعتماد الخادم خارج كود العميل."],
      ],
      rulesTitle: "القواعد تُقرأ كسياسة",
      rulesP: "تحدد القاعدة من يقرأ أو يكتب في مسار معيّن. وإذا لم تسمح أي قاعدة بعملية ما، تُرفض.",
      report: ["الإبلاغ عن مشكلة", "راسلنا على mohammedaydan12@gmail.com مع التفاصيل وسنرد.", "راسلنا"],
    },
    pagecta: "اقرأ التوثيق",
  },
};
