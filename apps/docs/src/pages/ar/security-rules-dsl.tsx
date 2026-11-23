import { Code, Doc, P, PageLink, Section, Table } from "../../ui";
import "../../rules-guide.css";

// Keep these examples aligned with docs/guides/ar/security-rules-dsl.md.
export default function Page() {
  return (
    <Doc title="لغة قواعد الأمان DSL" description="الصياغة الكاملة والدوال المدمجة وأنماط آمنة واختبارات بالمحرك الحقيقي." eyebrow="الأمان">
      <div className="rules-guide">
        <P>{"DSL لغة لكتابة القواعد، وليست JavaScript أو Dart أو لغة قواعد Firebase. تتحول إلى تعبيرات JSON بالإصدار 1. ابدأ بدليل "}<PageLink slug="security-rules" lang="ar">{"قواعد الأمان"}</PageLink>{" لفهم سياقات العمليات وصلاحية list واختلاف الوقت الفعلي."}</P>
      <Section id="section-1" title="الصياغة وأول سياسة كاملة">
        <Code lang="text" code={"rules_version = '2';\n\nfunction ownsNamespace() {\n  return isOwner(path.userId);\n}\n\nmatch /users/{userId}/notes/{noteId} {\n  allow get, list: if ownsNamespace();\n  allow create, update: if ownsNamespace()\n    && isType(incoming.title, 'string');\n  allow delete: if ownsNamespace();\n}"} />
        <P>{"تصريح الإصدار اختياري؛ تقبل '1' و'2' وكلاهما ينتج JSON بالإصدار 1. أي إصدار آخر يصدر ملاحظة، ولا يغير المحرك. يمكن أن يبدأ مسار DSL بشرطة /. تستخدم أمثلة JSON المسارات النسبية. فضّل path.userId الصريحة؛ يدعم المترجم المصحح أيضًا الاسم المنفرد المطابق لمتغير المسار."}</P>
        <P>{"يحتوي الملف تصريحات function وmatch في المستوى الأعلى ويجب أن ينتج قاعدة واحدة على الأقل. تضم match المتداخلة مسارها لمسار الأب وتنتج قواعد مستقلة دون وراثة الصلاحيات. ضع المتغير التكراري في نهاية المسار. التعليقات // و/* ... */ مدعومة. استخدم الفاصلة المنقوطة دائمًا حتى حين يسمح المحلل بحذفها."}</P>
        <P>{"يجعل allow get, list العمليتين تشتركان في التعبير. يوسع read إلى get وlist وwrite إلى create وupdate وdelete. تكرار العملية داخل الكتلة نفسها يستبدل التعبير السابق ولا يضيف OR. أما القواعد المستقلة المطابقة فتستخدم OR؛ قد تهزم قاعدة متساهلة قاعدة أكثر تقييدًا."}</P>
      </Section>
      <Section id="section-2" title="العوامل والقيم والأولوية">
        <Table head={["الصيغة", "المعنى"]} rows={[["a == b, a != b", "مساواة أو اختلاف مع مراعاة النوع؛ لا تنجح أي منهما مع طرف غائب."], ["a < b, a <= b, a > b, a >= b", "ترتيب wire. افحص نوع الرقم قبل حدوده."], ["a in ['one', 'two']", "عضوية في مصفوفة باستخدام مساواة ذات أنواع محددة."], ["hasKey(value, 'field')", "مفتاح مباشر مملوك للكائن، لا مسار متداخل ولا قائمة سماح."], ["isType(value, 'string')", "فحص نوع؛ راجع جدول الأنواع في دليل القواعد."], ["a && b", "نجاح التعبيرين."], ["a OR b (الرمز المزدوج)", "نجاح واحد على الأقل."], ["!a", "النفي؛ استخدم أقواسًا مع التعبيرات المركبة."]]} />
        <P>{"في هذا المحلل تربط المقارنات أولًا، ثم ! ثم && ثم ||. استخدم الأقواس بدل الاعتماد على أولوية غير مألوفة. القيم تشمل نصوصًا باقتباس مفرد أو مزدوج وأرقامًا بإشارة وقيمًا منطقية وnull ومصفوفات ثابتة. عناصر المصفوفة الديناميكية غير مدعومة. لا تستخدم كائنات JavaScript الحرفية أو الوصول بالأقواس أو methods أو الحساب أو الحلقات أو الإسناد أو الشرط الثلاثي أو regex أو تجميع النصوص أو استدعاءات قاعدة البيانات."}</P>
        <P>{"يُقارن الحقل المنفرد في موضع شرط بالقيمة true، ولا توجد truthiness خاصة بـ JavaScript. اكتب شروطًا صريحة. الدوال مساعدات لتعبيرات منطقية وليست دوال لإرجاع قيم حسابية. استخدم استدعاء الدالة كشرط كامل، لا كطرف داخل مقارنة أخرى أو داخل مصفوفة."}</P>
      </Section>
      <Section id="section-3" title="جميع الدوال المدمجة">
        <Table head={["الدالة", "الوسائط", "السلوك الدقيق"]} rows={[["isSignedIn()", "دون وسائط", "auth.uid != null؛ الحساب المجهول ذو uid يعد مسجلًا."], ["isAuth()", "دون وسائط", "مرادف isSignedIn()."], ["isOwner(id)", "قيمة واحدة", "وجود هوية ومساواة uid للقيمة."], ["hasRole(role)", "قيمة واحدة", "مساواة auth.claims.role للقيمة، لا فحص مصفوفة claims.roles."], ["hasAnyRole(['writer', 'reviewer'])", "مصفوفة نصوص ثابتة", "وجود قيمة auth.claims.role المفردة داخل المصفوفة."], ["isEmailVerified()", "دون وسائط", "مساواة auth.email_verified لـ true، دون اشتراط uid بذاتها."], ["unchanged(['ownerId', 'createdAt'])", "مصفوفة نصوص ثابتة", "كل حقل جديد كامل يساوي الحقل المخزن. تقبل المسارات المنقطة. المصفوفة الفارغة true؛ الحقول الغائبة لا تتساوى."], ["onlyChanged(['title'])", "مصفوفة نصوص ثابتة", "نفي مساواة كل حقل مع إصدار ملاحظة. لا تمنع تغيير حقول أخرى؛ الفارغة true. ليست قائمة سماح للكتابة."], ["hasKey(value, 'field')", "قيمتان", "مفتاح مباشر مملوك لكائن غير مصفوفة؛ مفاتيح prototype المحجوزة ممنوعة."], ["isType(value, 'type')", "قيمتان", "null أو bool/boolean أو string أو number أو array أو map أو وسم wire مثل ref/int/ts/bytes/geo."]]} />
        <P>{"لا توجد دوال مدمجة أخرى. العدد الخاطئ للوسائط يفشل التجميع. تتطلب unchanged وonlyChanged وhasAnyRole مصفوفات نصوص ثابتة، لا متغيرًا يحتوي مصفوفة. لا تسمح للعميل بمنح نفسه مطالبة دور موثوقة. ولا تستبدل فحص الهوية بـ auth != null؛ سياق غير المسجل كائن يحتوي uid:null."}</P>
      </Section>
      <Section id="section-4" title="اختصارات السياق">
        <Table head={["DSL", "متغير JSON القياسي"]} rows={[["auth.uid, request.auth.uid", "auth.uid"], ["auth.email, auth.email_verified, auth.is_anonymous", "المسار نفسه"], ["auth.claims.team, request.auth.claims.team", "auth.claims.team"], ["path.userId", "path.userId"], ["resource, resource.title, resource.data.title", "resource.data, resource.data.title, resource.data.title"], ["incoming, incoming.title", "request.data, request.data.title"], ["request.resource.data.title", "request.data.title"], ["request.data.title, request.time", "المسار نفسه"]]} />
        <P>{"incoming هو المستند الجديد الكامل بعد الدمج والتحويلات؛ null عند القراءة والحذف. resource يساوي null عند الإنشاء وبوابات list على المجموعة. الحقول الغائبة undefined وليست null صريحة."}</P>
      </Section>
      <Section id="section-5" title="قراءة عامة وأدوار موثوقة والتحقق من الحقول">
        <P>{"تجعل هذه السياسة كل المنشورات عامة عمدًا. ينشئ المسجل منشوره، ويعدله المؤلف دون نقل الملكية، ويحذف صاحب دور reviewer الموثوق."}</P>
        <Code lang="text" code={"match /posts/{postId} {\n  allow read: if true;\n  allow create: if isSignedIn()\n    && incoming.authorId == auth.uid\n    && isType(incoming.title, 'string')\n    && isType(incoming.score, 'number')\n    && incoming.score >= 0 && incoming.score <= 100;\n  allow update: if isOwner(resource.authorId)\n    && unchanged(['authorId'])\n    && isType(incoming.title, 'string')\n    && isType(incoming.score, 'number')\n    && incoming.score >= 0 && incoming.score <= 100;\n  allow delete: if hasRole('reviewer');\n}"} />
        <P>{"تقيّد الشروط الحقول المذكورة ولا ترفض الحقول الإضافية. يقبل isType(title,'string') النص الفارغ؛ لا يوجد فحص للطول. لجعل المنشورات خاصة لا تغير get مع ترك list:true. استخدم مساحة خاصة بالمستخدم، أو امنع list على مجموعة متعددة الملاك."}</P>
      </Section>
      <Section id="section-6" title="العلاقات والحقول الثابتة">
        <Code lang="text" code={"match /users/{userId}/notes/{noteId} {\n  allow get, list: if isOwner(path.userId);\n  allow create: if isOwner(path.userId)\n    && isType(incoming.author, 'ref')\n    && incoming.author.$v == auth.claims.profilePath;\n  allow update: if isOwner(path.userId)\n    && unchanged(['author']);\n}"} />
        <P>{"يفترض المثال أن الرمز المتحقق منه يحمل profilePath موثوقة مثل profiles/alice. يتحقق النوع من مرجع موسوم، وتقارن $v مساره. لا يفحص وجود الهدف أو يقرأه أو يمنح صلاحية له أو ينشئ علاقة عكسية. يجب ألا يستطيع المستخدم تعيين profilePath لنفسه. تظل الأهداف المضمنة بحاجة لفحص get الخاص بها."}</P>
        <P>{"تفحص unchanged القيمة الجديدة الكاملة؛ لذلك يمكن لتعديل جزئي لا يذكر author النجاح، بينما يفشل استبدال المستند دون author. استخدم فحص الحقول المطلوبة وأنواعها عند الإنشاء؛ ليست unchanged تحققًا كافيًا للإنشاء."}</P>
      </Section>
      <Section id="section-7" title="الدوال القابلة لإعادة الاستخدام">
        <Code lang="text" code={"function mayRead(userId) {\n  return isOwner(userId) || hasAnyRole(['reviewer', 'support']);\n}\nmatch /users/{userId}/tickets/{ticketId} {\n  allow get, list: if mayRead(path.userId);\n}"} />
        <P>{"تحتوي الدالة تعبير return واحدًا. تستبدل الوسائط قيمًا أو تعبيرات كاملة، وتعمل الإشارات لدوال معرفة لاحقًا. التعريفات في المستوى الأعلى وأسماؤها فريدة. يمكن لتعريف مستخدم أن يحجب دالة مدمجة، لذا لا تسم مساعدك isOwner أو isSignedIn. تُوسع الاستدعاءات عند التجميع؛ يمنع الاستدعاء الذاتي، وحد عمق التوسيع 16، ويبقى التعبير النهائي مقيدًا بعمق 10 و100 عقدة. لا تضيف المساعدات قدرات تشغيل جديدة."}</P>
      </Section>
      <Section id="section-8" title="التجميع والتحويل العكسي والمحاكاة">
        <Table head={["الطريقة والمسار", "الطلب", "الاستجابة"]} rows={[["POST /v1/projects/:projectId/rules/compile", "source: نص DSL", "ast وdiagnostics"], ["POST /v1/projects/:projectId/rules/decompile", "rulesAst: AST إصدار 1", "dsl"], ["POST /v1/projects/:projectId/rules/simulate", "operation وpath واختياريًا rulesAst وauth وresourceData وincomingData", "allowed وmatchedRule وevaluationTrace"]]} />
        <P>{"استخدم مفتاح المشروع في X-Project-Key. لا تكتب هذه الأدوات مستندات ولا تفعل قواعد. يختار auth في المحاكاة مدخل الاختبار فقط، ولا يصادق على طلب بيانات حقيقي. عند حذف rulesAst تستخدم المحاكاة القواعد النشطة إن وجدت. يحافظ التحويل العكسي على سلوك التعبيرات المدعومة لا التعليقات وأسماء المساعدات والتنسيق."}</P>
        <Code lang="json" code={"{\n  \"operation\": \"get\",\n  \"path\": \"users/alice/notes/one\",\n  \"auth\": { \"uid\": \"alice\", \"claims\": {} },\n  \"resourceData\": { \"title\": \"Private note\" },\n  \"incomingData\": null,\n  \"rulesAst\": {\n    \"version\": 1,\n    \"rules\": [{\n      \"match\": \"users/{userId}/notes/{noteId}\",\n      \"allow\": { \"get\": {\n        \"op\": \"all\",\n        \"conditions\": [\n          { \"op\": \"!=\", \"left\": { \"var\": \"auth.uid\" }, \"right\": { \"val\": null } },\n          { \"op\": \"==\", \"left\": { \"var\": \"auth.uid\" }, \"right\": { \"var\": \"path.userId\" } }\n        ]\n      } }\n    }]\n  }\n}"} />
        <P>{"كرر مع uid:bob وuid:null وتوقع الرفض. ثم اختبر طلبات مستندات حقيقية بمفتاح عام ورمز مستخدم مع القواعد النشطة. لا تثبت المحاكاة بوابات المجموعات أو ترشيح النتائج أو نطاقات المفاتيح أو مصادقة المشروع أو سلوك الوقت الفعلي."}</P>
      </Section>
      <Section id="section-9" title="الملاحظات والأخطاء الشائعة">
        <P>{"أخطاء الصياغة تحمل line وcolumn يبدأان من 1 ومقطعًا يحدد موضع الخطأ. قد تنتج AST ناجحة مع ملاحظات غير مانعة: دوال مجهولة أو جذور متغيرات مجهولة أو إصدارات غير مدعومة أو مصفوفات غير ثابتة أو onlyChanged. اشترط صفر ملاحظات ثم اختبر حالات الرفض؛ الخطأ الإملائي داخل جذر معروف قد لا ينتج ملاحظة أصلًا."}</P>
        <P>{"تتحول الدالة المجهولة إلى false، لذا قد يصبح !unknownFunction() مساويًا true. تختلف المقارنات ذات الحقول الغائبة تحت النفي أيضًا. لا تعتبر تحذيرًا أو اسمًا مجهولًا ضمان رفض للسياسة. فضّل شروط وجود ونوع وهوية إيجابية."}</P>
        <P>{"الحد الأقصى لطول المصدر 131072 وحدة نص JavaScript؛ تسميه رسالة الخطأ bytes لكن التنفيذ يقيس طول النص. الحد 16384 رمزًا، وعمق المحلل 64. اجعل القواعد قصيرة كيلا تتجاوز العضوية ميزانية 256 خطوة. لا توجد قائمة عامة للحقول المسموحة؛ ليست onlyChanged ولا hasKey كذلك، والتحقق داخل عميل غير موثوق لا يوفرها."}</P>
        <P>{"تستخرج tests/integration/rules-guide-examples.test.ts الأمثلة الكاملة من الدليلين وتنفذها بالتفويض الحقيقي ومحرك المستندات المحلي. شغّل corepack pnpm exec vitest run tests/integration/rules-guide-examples.test.ts عند تعديلها."}</P>
      </Section>
      </div>
    </Doc>
  );
}
