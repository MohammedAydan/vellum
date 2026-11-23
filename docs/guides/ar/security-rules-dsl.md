---
title: لغة قواعد الأمان DSL
order: 12
group: Security
description: الصياغة الكاملة والدوال المدمجة وأنماط آمنة واختبارات بالمحرك الحقيقي.
---

# لغة قواعد الأمان DSL

DSL لغة لكتابة القواعد، وليست JavaScript أو Dart أو لغة قواعد Firebase. تتحول إلى تعبيرات JSON بالإصدار 1. ابدأ بدليل [قواعد الأمان](./security-rules.md) لفهم سياقات العمليات وصلاحية list واختلاف الوقت الفعلي.

## الصياغة وأول سياسة كاملة

```text
rules_version = '2';

function ownsNamespace() {
  return isOwner(path.userId);
}

match /users/{userId}/notes/{noteId} {
  allow get, list: if ownsNamespace();
  allow create, update: if ownsNamespace()
    && isType(incoming.title, 'string');
  allow delete: if ownsNamespace();
}
```

تصريح الإصدار اختياري؛ تقبل '1' و'2' وكلاهما ينتج JSON بالإصدار 1. أي إصدار آخر يصدر ملاحظة، ولا يغير المحرك. يمكن أن يبدأ مسار DSL بشرطة /. تستخدم أمثلة JSON المسارات النسبية. فضّل path.userId الصريحة؛ يدعم المترجم المصحح أيضًا الاسم المنفرد المطابق لمتغير المسار.

يحتوي الملف تصريحات function وmatch في المستوى الأعلى ويجب أن ينتج قاعدة واحدة على الأقل. تضم match المتداخلة مسارها لمسار الأب وتنتج قواعد مستقلة دون وراثة الصلاحيات. ضع المتغير التكراري في نهاية المسار. التعليقات // و/* ... */ مدعومة. استخدم الفاصلة المنقوطة دائمًا حتى حين يسمح المحلل بحذفها.

يجعل allow get, list العمليتين تشتركان في التعبير. يوسع read إلى get وlist وwrite إلى create وupdate وdelete. تكرار العملية داخل الكتلة نفسها يستبدل التعبير السابق ولا يضيف OR. أما القواعد المستقلة المطابقة فتستخدم OR؛ قد تهزم قاعدة متساهلة قاعدة أكثر تقييدًا.

## العوامل والقيم والأولوية

| الصيغة | المعنى |
| --- | --- |
| a == b, a != b | مساواة أو اختلاف مع مراعاة النوع؛ لا تنجح أي منهما مع طرف غائب. |
| a < b, a <= b, a > b, a >= b | ترتيب wire. افحص نوع الرقم قبل حدوده. |
| a in ['one', 'two'] | عضوية في مصفوفة باستخدام مساواة ذات أنواع محددة. |
| hasKey(value, 'field') | مفتاح مباشر مملوك للكائن، لا مسار متداخل ولا قائمة سماح. |
| isType(value, 'string') | فحص نوع؛ راجع جدول الأنواع في دليل القواعد. |
| a && b | نجاح التعبيرين. |
| a OR b (الرمز المزدوج) | نجاح واحد على الأقل. |
| !a | النفي؛ استخدم أقواسًا مع التعبيرات المركبة. |

في هذا المحلل تربط المقارنات أولًا، ثم ! ثم && ثم ||. استخدم الأقواس بدل الاعتماد على أولوية غير مألوفة. القيم تشمل نصوصًا باقتباس مفرد أو مزدوج وأرقامًا بإشارة وقيمًا منطقية وnull ومصفوفات ثابتة. عناصر المصفوفة الديناميكية غير مدعومة. لا تستخدم كائنات JavaScript الحرفية أو الوصول بالأقواس أو methods أو الحساب أو الحلقات أو الإسناد أو الشرط الثلاثي أو regex أو تجميع النصوص أو استدعاءات قاعدة البيانات.

يُقارن الحقل المنفرد في موضع شرط بالقيمة true، ولا توجد truthiness خاصة بـ JavaScript. اكتب شروطًا صريحة. الدوال مساعدات لتعبيرات منطقية وليست دوال لإرجاع قيم حسابية. استخدم استدعاء الدالة كشرط كامل، لا كطرف داخل مقارنة أخرى أو داخل مصفوفة.

## جميع الدوال المدمجة

| الدالة | الوسائط | السلوك الدقيق |
| --- | --- | --- |
| isSignedIn() | دون وسائط | auth.uid != null؛ الحساب المجهول ذو uid يعد مسجلًا. |
| isAuth() | دون وسائط | مرادف isSignedIn(). |
| isOwner(id) | قيمة واحدة | وجود هوية ومساواة uid للقيمة. |
| hasRole(role) | قيمة واحدة | مساواة auth.claims.role للقيمة، لا فحص مصفوفة claims.roles. |
| hasAnyRole(['writer', 'reviewer']) | مصفوفة نصوص ثابتة | وجود قيمة auth.claims.role المفردة داخل المصفوفة. |
| isEmailVerified() | دون وسائط | مساواة auth.email_verified لـ true، دون اشتراط uid بذاتها. |
| unchanged(['ownerId', 'createdAt']) | مصفوفة نصوص ثابتة | كل حقل جديد كامل يساوي الحقل المخزن. تقبل المسارات المنقطة. المصفوفة الفارغة true؛ الحقول الغائبة لا تتساوى. |
| onlyChanged(['title']) | مصفوفة نصوص ثابتة | نفي مساواة كل حقل مع إصدار ملاحظة. لا تمنع تغيير حقول أخرى؛ الفارغة true. ليست قائمة سماح للكتابة. |
| hasKey(value, 'field') | قيمتان | مفتاح مباشر مملوك لكائن غير مصفوفة؛ مفاتيح prototype المحجوزة ممنوعة. |
| isType(value, 'type') | قيمتان | null أو bool/boolean أو string أو number أو array أو map أو وسم wire مثل ref/int/ts/bytes/geo. |

لا توجد دوال مدمجة أخرى. العدد الخاطئ للوسائط يفشل التجميع. تتطلب unchanged وonlyChanged وhasAnyRole مصفوفات نصوص ثابتة، لا متغيرًا يحتوي مصفوفة. لا تسمح للعميل بمنح نفسه مطالبة دور موثوقة. ولا تستبدل فحص الهوية بـ auth != null؛ سياق غير المسجل كائن يحتوي uid:null.

## اختصارات السياق

| DSL | متغير JSON القياسي |
| --- | --- |
| auth.uid, request.auth.uid | auth.uid |
| auth.email, auth.email_verified, auth.is_anonymous | المسار نفسه |
| auth.claims.team, request.auth.claims.team | auth.claims.team |
| path.userId | path.userId |
| resource, resource.title, resource.data.title | resource.data, resource.data.title, resource.data.title |
| incoming, incoming.title | request.data, request.data.title |
| request.resource.data.title | request.data.title |
| request.data.title, request.time | المسار نفسه |

incoming هو المستند الجديد الكامل بعد الدمج والتحويلات؛ null عند القراءة والحذف. resource يساوي null عند الإنشاء وبوابات list على المجموعة. الحقول الغائبة undefined وليست null صريحة.

## قراءة عامة وأدوار موثوقة والتحقق من الحقول

تجعل هذه السياسة كل المنشورات عامة عمدًا. ينشئ المسجل منشوره، ويعدله المؤلف دون نقل الملكية، ويحذف صاحب دور reviewer الموثوق.

```text
match /posts/{postId} {
  allow read: if true;
  allow create: if isSignedIn()
    && incoming.authorId == auth.uid
    && isType(incoming.title, 'string')
    && isType(incoming.score, 'number')
    && incoming.score >= 0 && incoming.score <= 100;
  allow update: if isOwner(resource.authorId)
    && unchanged(['authorId'])
    && isType(incoming.title, 'string')
    && isType(incoming.score, 'number')
    && incoming.score >= 0 && incoming.score <= 100;
  allow delete: if hasRole('reviewer');
}
```

تقيّد الشروط الحقول المذكورة ولا ترفض الحقول الإضافية. يقبل isType(title,'string') النص الفارغ؛ لا يوجد فحص للطول. لجعل المنشورات خاصة لا تغير get مع ترك list:true. استخدم مساحة خاصة بالمستخدم، أو امنع list على مجموعة متعددة الملاك.

## العلاقات والحقول الثابتة

```text
match /users/{userId}/notes/{noteId} {
  allow get, list: if isOwner(path.userId);
  allow create: if isOwner(path.userId)
    && isType(incoming.author, 'ref')
    && incoming.author.$v == auth.claims.profilePath;
  allow update: if isOwner(path.userId)
    && unchanged(['author']);
}
```

يفترض المثال أن الرمز المتحقق منه يحمل profilePath موثوقة مثل profiles/alice. يتحقق النوع من مرجع موسوم، وتقارن $v مساره. لا يفحص وجود الهدف أو يقرأه أو يمنح صلاحية له أو ينشئ علاقة عكسية. يجب ألا يستطيع المستخدم تعيين profilePath لنفسه. تظل الأهداف المضمنة بحاجة لفحص get الخاص بها.

تفحص unchanged القيمة الجديدة الكاملة؛ لذلك يمكن لتعديل جزئي لا يذكر author النجاح، بينما يفشل استبدال المستند دون author. استخدم فحص الحقول المطلوبة وأنواعها عند الإنشاء؛ ليست unchanged تحققًا كافيًا للإنشاء.

## الدوال القابلة لإعادة الاستخدام

```text
function mayRead(userId) {
  return isOwner(userId) || hasAnyRole(['reviewer', 'support']);
}
match /users/{userId}/tickets/{ticketId} {
  allow get, list: if mayRead(path.userId);
}
```

تحتوي الدالة تعبير return واحدًا. تستبدل الوسائط قيمًا أو تعبيرات كاملة، وتعمل الإشارات لدوال معرفة لاحقًا. التعريفات في المستوى الأعلى وأسماؤها فريدة. يمكن لتعريف مستخدم أن يحجب دالة مدمجة، لذا لا تسم مساعدك isOwner أو isSignedIn. تُوسع الاستدعاءات عند التجميع؛ يمنع الاستدعاء الذاتي، وحد عمق التوسيع 16، ويبقى التعبير النهائي مقيدًا بعمق 10 و100 عقدة. لا تضيف المساعدات قدرات تشغيل جديدة.

## التجميع والتحويل العكسي والمحاكاة

| الطريقة والمسار | الطلب | الاستجابة |
| --- | --- | --- |
| POST /v1/projects/:projectId/rules/compile | source: نص DSL | ast وdiagnostics |
| POST /v1/projects/:projectId/rules/decompile | rulesAst: AST إصدار 1 | dsl |
| POST /v1/projects/:projectId/rules/simulate | operation وpath واختياريًا rulesAst وauth وresourceData وincomingData | allowed وmatchedRule وevaluationTrace |

استخدم مفتاح المشروع في X-Project-Key. لا تكتب هذه الأدوات مستندات ولا تفعل قواعد. يختار auth في المحاكاة مدخل الاختبار فقط، ولا يصادق على طلب بيانات حقيقي. عند حذف rulesAst تستخدم المحاكاة القواعد النشطة إن وجدت. يحافظ التحويل العكسي على سلوك التعبيرات المدعومة لا التعليقات وأسماء المساعدات والتنسيق.

```json
{
  "operation": "get",
  "path": "users/alice/notes/one",
  "auth": { "uid": "alice", "claims": {} },
  "resourceData": { "title": "Private note" },
  "incomingData": null,
  "rulesAst": {
    "version": 1,
    "rules": [{
      "match": "users/{userId}/notes/{noteId}",
      "allow": { "get": {
        "op": "all",
        "conditions": [
          { "op": "!=", "left": { "var": "auth.uid" }, "right": { "val": null } },
          { "op": "==", "left": { "var": "auth.uid" }, "right": { "var": "path.userId" } }
        ]
      } }
    }]
  }
}
```

كرر مع uid:bob وuid:null وتوقع الرفض. ثم اختبر طلبات مستندات حقيقية بمفتاح عام ورمز مستخدم مع القواعد النشطة. لا تثبت المحاكاة بوابات المجموعات أو ترشيح النتائج أو نطاقات المفاتيح أو مصادقة المشروع أو سلوك الوقت الفعلي.

## الملاحظات والأخطاء الشائعة

أخطاء الصياغة تحمل line وcolumn يبدأان من 1 ومقطعًا يحدد موضع الخطأ. قد تنتج AST ناجحة مع ملاحظات غير مانعة: دوال مجهولة أو جذور متغيرات مجهولة أو إصدارات غير مدعومة أو مصفوفات غير ثابتة أو onlyChanged. اشترط صفر ملاحظات ثم اختبر حالات الرفض؛ الخطأ الإملائي داخل جذر معروف قد لا ينتج ملاحظة أصلًا.

تتحول الدالة المجهولة إلى false، لذا قد يصبح !unknownFunction() مساويًا true. تختلف المقارنات ذات الحقول الغائبة تحت النفي أيضًا. لا تعتبر تحذيرًا أو اسمًا مجهولًا ضمان رفض للسياسة. فضّل شروط وجود ونوع وهوية إيجابية.

الحد الأقصى لطول المصدر 131072 وحدة نص JavaScript؛ تسميه رسالة الخطأ bytes لكن التنفيذ يقيس طول النص. الحد 16384 رمزًا، وعمق المحلل 64. اجعل القواعد قصيرة كيلا تتجاوز العضوية ميزانية 256 خطوة. لا توجد قائمة عامة للحقول المسموحة؛ ليست onlyChanged ولا hasKey كذلك، والتحقق داخل عميل غير موثوق لا يوفرها.

تستخرج tests/integration/rules-guide-examples.test.ts الأمثلة الكاملة من الدليلين وتنفذها بالتفويض الحقيقي ومحرك المستندات المحلي. شغّل corepack pnpm exec vitest run tests/integration/rules-guide-examples.test.ts عند تعديلها.
