export type LegalKind = "privacy" | "terms";
export interface LegalSection { heading: string; items: string[] }
export interface LegalDoc { title: string; updated: string; sections: LegalSection[] }

export const ALPHA_NOTICE = {
  en: {
    title: "Alpha: in active development",
    body: "VELLUM is in active development (Alpha/Beta) and is not a final, stable product. There is no SLA. We do not guarantee uptime, stability or the safety of test data, and APIs or services may change or be shut down at any time without notice. The service is provided \"AS IS\" and \"AS AVAILABLE\" without warranties, and you alone are responsible for deciding to use it in your projects.",
  },
  ar: {
    title: "ألفا: قيد التطوير المستمر",
    body: "VELLUM قيد التطوير المستمر (Alpha/Beta) وليست منتجاً نهائياً مستقراً. لا توجد اتفاقية مستوى خدمة (SLA)، ولا نضمن استمرار الخدمة أو استقرارها أو سلامة البيانات التجريبية، وقد تتغير الواجهات أو الخدمات أو تتوقف في أي وقت دون إشعار. تُقدَّم الخدمة «كما هي» (AS IS) و«حسب التوفر» (AS AVAILABLE) دون أي ضمانات، وتتحمل وحدك مسؤولية استخدامها في مشاريعك.",
  },
} as const;

export const LEGAL: Record<"en" | "ar", Record<LegalKind, LegalDoc>> = {
  en: {
    privacy: {
      title: "Privacy Policy",
      updated: "Last updated: November 24, 2026. VELLUM is an Alpha service, so this policy may change as the product changes.",
      sections: [
        { heading: "Data we collect", items: [
          "Account data: your email address, name and a password hash, plus the organizations and projects you create.",
          "Your application data: the documents, indexes, rules and keys you store in your projects. You own it and we treat it as yours.",
          "End-user data of your apps: sign-in identifiers and sessions of the people who use your applications, stored in your project.",
          "Operational data: request logs and usage counters (such as request counts, IP address and timestamps) used to run, secure and meter the service.",
        ] },
        { heading: "Encryption and storage", items: [
          "Traffic to the API is served over HTTPS (TLS).",
          "Passwords are never stored in plain text. They are stored as salted scrypt hashes.",
          "Authentication secrets, such as multi-factor seeds, are encrypted at rest with AES-256-GCM.",
          "Your documents are stored in PostgreSQL, isolated per project with row-level security. Encryption at rest of the database volume depends on the database host.",
          "Because the service is in Alpha, do not store data you cannot afford to lose or that is regulated or highly sensitive.",
        ] },
        { heading: "No sale or sharing", items: [
          "We do not sell your data and we do not share it with third parties for advertising or marketing. We use infrastructure providers (for hosting and databases) only to run the service, and we may disclose data if the law requires it.",
        ] },
        { heading: "Retention and your choices", items: [
          "We keep your data while your account is active. You can delete documents, projects and your account, and deletion removes the data from the live service. Backups and logs may remain for a limited time. Because this is an Alpha service, data may also be lost or reset without notice.",
        ] },
        { heading: "Changes to this policy", items: [
          "We will update the date above when this policy changes. Continued use after a change means you accept the updated policy.",
        ] },
      ],
    },
    terms: {
      title: "Terms of Service",
      updated: "Last updated: November 24, 2026. By using VELLUM you agree to these terms. If you do not agree, do not use the service.",
      sections: [
        { heading: "Alpha status and no guarantees", items: [
          "Active development: VELLUM is currently under continuous development (Alpha/Beta). It is not a final, stable product.",
          "No uptime or stability guarantee: there is no service level agreement (SLA). We do not guarantee that the service will keep running, stay stable, or keep test data safe. APIs and services may change in breaking ways, be modified, or be shut down completely and permanently at any time without prior notice.",
          "Full disclaimer: the service is provided \"AS IS\" and \"AS AVAILABLE\", without any express or implied warranties, including merchantability, fitness for a particular purpose and non-infringement. You alone bear the full personal and legal responsibility for deciding to use it in any project. To the fullest extent permitted by law, the developers and owners of the project are not liable for any direct or indirect damages, including data loss, lost profits or business interruption, that result from use of the service or from its interruption.",
        ] },
        { heading: "Acceptable use", items: [
          "Do not use the service for anything unlawful, or to store content you have no right to store.",
          "Do not attempt to break, probe, overload or bypass the security, isolation or quotas of the service or of other users.",
          "Do not send malware, spam or abusive traffic, and do not resell access without permission.",
          "Keep your API keys and credentials secret. You are responsible for activity that uses them.",
        ] },
        { heading: "Technical limits", items: [
          "The service enforces request, document, query and rate limits. Limits can change during Alpha. We may throttle or suspend usage that threatens the stability or security of the service.",
        ] },
        { heading: "Intellectual property", items: [
          "You keep all rights to the data and content you store. You grant us only the permission needed to host, process and back up it in order to run the service for you. VELLUM, its software, name and documentation remain the property of their owners and are provided under the license that ships with each package.",
        ] },
        { heading: "Changes and termination", items: [
          "We may update these terms, and we may suspend or end the service or your access at any time. Continued use after a change means you accept it.",
        ] },
      ],
    },
  },
  ar: {
    privacy: {
      title: "سياسة الخصوصية",
      updated: "آخر تحديث: 24 نوفمبر 2026. VELLUM خدمة في مرحلة ألفا، لذلك قد تتغير هذه السياسة مع تغير المنتج.",
      sections: [
        { heading: "البيانات التي نجمعها", items: [
          "بيانات الحساب: بريدك الإلكتروني واسمك وتجزئة كلمة المرور، والمؤسسات والمشاريع التي تنشئها.",
          "بيانات تطبيقك: المستندات والفهارس والقواعد والمفاتيح التي تخزنها في مشاريعك. هي ملكك ونعاملها على هذا الأساس.",
          "بيانات مستخدمي تطبيقاتك: معرّفات تسجيل الدخول وجلسات من يستخدمون تطبيقاتك، وتُخزَّن داخل مشروعك.",
          "بيانات التشغيل: سجلات الطلبات وعدادات الاستخدام (مثل عدد الطلبات وعنوان IP والتوقيت) لتشغيل الخدمة وحمايتها وقياسها.",
        ] },
        { heading: "التشفير والتخزين", items: [
          "تُقدَّم حركة البيانات إلى API عبر HTTPS (TLS).",
          "لا تُخزَّن كلمات المرور كنص صريح، بل كتجزئات scrypt مملّحة.",
          "تُشفَّر أسرار المصادقة، مثل بذور التحقق متعدد العوامل، أثناء التخزين بخوارزمية AES-256-GCM.",
          "تُخزَّن مستنداتك في PostgreSQL معزولة لكل مشروع بأمان مستوى الصف. ويعتمد تشفير وحدة تخزين قاعدة البيانات على مزوّد الاستضافة.",
          "لأن الخدمة في مرحلة ألفا، لا تخزّن بيانات لا تحتمل فقدانها أو بيانات منظَّمة قانونياً أو شديدة الحساسية.",
        ] },
        { heading: "لا بيع ولا مشاركة", items: [
          "لا نبيع بياناتك ولا نشاركها مع أطراف ثالثة لأغراض الإعلان أو التسويق. نستخدم مزوّدي بنية تحتية (للاستضافة وقواعد البيانات) لتشغيل الخدمة فقط، وقد نكشف البيانات إذا أوجب القانون ذلك.",
        ] },
        { heading: "الاحتفاظ وخياراتك", items: [
          "نحتفظ ببياناتك طالما حسابك نشط. يمكنك حذف المستندات والمشاريع وحسابك، ويزيل الحذف البيانات من الخدمة الحية. قد تبقى النسخ الاحتياطية والسجلات لفترة محدودة. ولأن الخدمة في مرحلة ألفا، قد تُفقد البيانات أو تُعاد تهيئتها دون إشعار.",
        ] },
        { heading: "تغييرات السياسة", items: [
          "سنحدّث التاريخ أعلاه عند تغيير هذه السياسة. استمرارك في الاستخدام بعد التغيير يعني قبولك للسياسة المحدّثة.",
        ] },
      ],
    },
    terms: {
      title: "شروط الاستخدام",
      updated: "آخر تحديث: 24 نوفمبر 2026. باستخدامك VELLUM فإنك توافق على هذه الشروط. إن لم توافق فلا تستخدم الخدمة.",
      sections: [
        { heading: "حالة ألفا وعدم وجود ضمانات", items: [
          "تطوير مستمر: VELLUM قيد التطوير المستمر حالياً (Alpha/Beta) وليست منتجاً نهائياً مستقراً.",
          "لا ضمان للاستمرارية أو الاستقرار: لا توجد اتفاقية مستوى خدمة (SLA). لا نضمن استمرار الخدمة أو استقرارها أو سلامة البيانات التجريبية. وقد تتغير الواجهات البرمجية والخدمات تغييراً جذرياً أو تُعدَّل أو تُوقف إيقافاً كاملاً ونهائياً في أي وقت دون إشعار مسبق.",
          "إخلاء المسؤولية الكامل: تُقدَّم الخدمة «كما هي» (AS IS) و«حسب التوفر» (AS AVAILABLE) دون أي ضمانات صريحة أو ضمنية، بما فيها القابلية للتسويق والملاءمة لغرض معين وعدم الانتهاك. وتتحمل وحدك المسؤولية الشخصية والقانونية الكاملة عن قرار استخدامها في أي مشروع. وبأقصى ما يسمح به القانون، يُخلى مطورو المشروع ومالكوه من أي مسؤولية عن أي أضرار مباشرة أو غير مباشرة، بما فيها فقدان البيانات أو الأرباح أو توقف الأعمال، الناتجة عن استخدام الخدمة أو توقفها.",
        ] },
        { heading: "الاستخدام المقبول", items: [
          "لا تستخدم الخدمة في أي أمر غير قانوني، ولا لتخزين محتوى لا تملك حق تخزينه.",
          "لا تحاول اختراق أو فحص أو إرهاق أو تجاوز أمان الخدمة أو عزلها أو حصصها أو حصص المستخدمين الآخرين.",
          "لا ترسل برمجيات خبيثة أو بريداً مزعجاً أو حركة مسيئة، ولا تعد بيع الوصول دون إذن.",
          "حافظ على سرية مفاتيح API وبيانات الاعتماد. أنت مسؤول عن النشاط الذي يستخدمها.",
        ] },
        { heading: "الحدود التقنية", items: [
          "تفرض الخدمة حدوداً على الطلبات والمستندات والاستعلامات والمعدل. قد تتغير الحدود أثناء ألفا. ويجوز لنا تقييد أو إيقاف أي استخدام يهدد استقرار الخدمة أو أمانها.",
        ] },
        { heading: "الملكية الفكرية", items: [
          "تحتفظ بكل حقوقك في البيانات والمحتوى الذي تخزنه. وتمنحنا فقط الإذن اللازم لاستضافته ومعالجته ونسخه احتياطياً لتشغيل الخدمة لك. يبقى VELLUM وبرمجياته واسمه وتوثيقه ملكاً لأصحابه ويُقدَّم بموجب الترخيص المرفق مع كل حزمة.",
        ] },
        { heading: "التغييرات والإنهاء", items: [
          "قد نحدّث هذه الشروط، وقد نوقف الخدمة أو وصولك إليها في أي وقت. استمرارك في الاستخدام بعد التغيير يعني قبولك.",
        ] },
      ],
    },
  },
};
