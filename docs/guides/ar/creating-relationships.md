# إنشاء علاقات بين المستندات

العلاقة حقل عادي داخل المستند، وقيمته مرجع لمستند آخر في نفس المشروع. استخدم مرجعًا واحدًا لعلاقة مع مستند واحد، أو مصفوفة مراجع لعلاقة مع عدة مستندات. لا تحتاج إلى مسار API منفصل لإنشاء العلاقة.

## JavaScript وTypeScript

المثال يعمل مع الإصدار المنشور `@vellumdb/sdk-js` رقم 0.0.1. المتغير `db` يمثل عميل المشروع بعد تهيئته، مع صلاحية كتابة المستندات المستخدمة.

```ts
const ref = (path: string) => ({ $t: "ref" as const, $v: path });
await db.doc("users/u1").create({ name: "Ada" });
await db.doc("users/u2").create({ name: "Sam" });
await db.doc("posts/p1").create({
  title: "First post",
  author: ref("users/u1"),
  reviewers: [ref("users/u1"), ref("users/u2")],
});
const post = await db.doc("posts/p1").get({
  include: ["author", "reviewers"],
});
console.log(post.included?.["author"]);
console.log(post.included?.["reviewers"]);
await db.doc("posts/p1").update({ author: ref("users/u2") });
await db.doc("posts/p1").update({ author: null });
let cursor: string | undefined;
do {
  const page = await db.doc("users/u1").referencedBy({
    collection: "posts", field: "reviewers", limit: 25, cursor,
  });
  for (const source of page.documents) console.log(source.path);
  cursor = page.nextCursor ?? undefined;
} while (cursor !== undefined);
```

أضفنا في الشفرة المصدرية الدالة `reference(path)` للتحقق من المسار وإنتاج نفس المرجع. بعد تثبيت إصدار يحتوي عليها، استبدل تعريف `ref` المحلي بـ `import { reference as ref } from "@vellumdb/sdk-js"`. الإصدار المنشور 0.0.1 لا يصدّر هذه الدالة، لذلك يستخدم المثال أعلاه القيمة الموسومة مباشرة.

## Flutter وDart

المتغير `client` يمثل عميل المشروع بعد تهيئته. الدالة `VellumWire.reference` موجودة في الإصدار المنشور `vellum_flutter` رقم 0.0.1.

```dart
await client.doc('users/u1').create({'name': 'Ada'});
await client.doc('users/u2').create({'name': 'Sam'});
await client.doc('posts/p1').create({
  'title': 'First post',
  'author': VellumWire.reference('users/u1'),
  'reviewers': [
    VellumWire.reference('users/u1'),
    VellumWire.reference('users/u2'),
  ],
});
final post = await client.doc('posts/p1').get(
  include: ['author', 'reviewers'],
);
print(post.included?['author']);
print(post.included?['reviewers']);
await client.doc('posts/p1').update({
  'author': VellumWire.reference('users/u2'),
});
await client.doc('posts/p1').update({'author': null});
String? cursor;
do {
  final page = await client.doc('users/u1').referencedBy(
    collection: 'posts', field: 'reviewers', limit: 25, cursor: cursor,
  );
  for (final source in page.documents) {
    print(source.path);
  }
  cursor = page.nextCursor;
} while (cursor != null);
```

## REST

بعد إنشاء `users/u1` أرسل المرجع ضمن `data` في مسار كتابة المستند المعتاد:

```http
POST /v1/projects/PROJECT_ID/documents/posts/p1
Content-Type: application/json
x-vellum-api-key: PROJECT_API_KEY

{"data":{"title":"First post","author":{"$t":"ref","$v":"users/u1"}}}
```

يجب أن يطابق الطلب قواعد الأمان ومتطلبات المصادقة الخاصة بالمشروع. إذا كانت القواعد تتطلب مستخدمًا مسجلًا، أرسل bearer token الخاص به بجانب مفتاح API للمشروع.

## السلوك والحدود

- خزّن مسار المستند داخل المشروع مثل `users/u1`، وليس رابطًا أو معرّف مشروع أو مسار collection فقط أو كائن `DocumentReference` حيًا من المكتبة.
- المسار من 2 إلى 10 أجزاء بالتبادل بين collection ومستند. الحد 2048 حرفًا للمسار و1500 بايت UTF-8 لكل جزء. الأجزاء المحجوزة `__...__` ومسارات الرجوع ومحارف التحكم غير صالحة.
- المرجع لا ينشئ المستند الهدف ولا يضمن وجوده أو تفرده، ولا يضيف علاقة عكسية تلقائيًا. إنشاء الأهداف أولًا يجعل المثال واضحًا، لكنه ليس فحص foreign key تلقائيًا.
- `include` يحمّل العلاقات عند القراءة. كل هدف يخضع لفحص صلاحية القراءة. الهدف الواحد المفقود أو الممنوع يرجع null. المنع يضيف اسم حقل الإرفاق إلى `redactedRefs`. المصفوفات تستبعد الأهداف المفقودة والممنوعة، فلا تعتمد على عدد النتائج الموسعة كعدد للمراجع الأصلية.
- استخدم المسار الكامل بدل الاعتماد على استنتاج اسم collection. أقصى عمق لـ include هو 3 مع حدود لعدد وحجم النتائج.
- غيّر المرجع أو اجعله null لتغيير العلاقة أو إزالتها. يمكن استخدام عمليات المصفوفات الحالية لإضافة أو إزالة مرجع، مع تمرير القيمة الموسومة نفسها عند الإزالة. هذا لا يحذف الهدف.
- `include` خيار قراءة، وليس طريقة لتثبيت سلوك حذف دائم. المرجع وحده لا يفرض foreign key. قواعد الحذف الموجودة للمشروع، إن كانت مهيأة، تحدد سلوك restrict أو cascade أو set_null. بدونها يمكن أن يبقى مرجع لهدف محذوف.
- الكتابة ترسل أحداث realtime المعتادة للمستندات. الاشتراكات تستطيع طلب include؛ لا يضيف هذا الدليل نوع أحداث أو ضمان تسليم جديدًا.
- عند تكرار المثال استخدم معرّفات جديدة أو تعامل مع خطأ وجود المستند مسبقًا، لأن الأمثلة تستخدم create.
