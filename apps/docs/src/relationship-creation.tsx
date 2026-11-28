import { Callout, CodeTabs, P, Section } from "./ui";

const js = `const ref = (path: string) => ({ $t: "ref" as const, $v: path });
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
await db.doc("posts/p1").update({ author: ref("users/u2") });
await db.doc("posts/p1").update({ author: null });`;

const dart = `await client.doc('users/u1').create({'name': 'Ada'});
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
await client.doc('posts/p1').update({
  'author': VellumWire.reference('users/u2'),
});
await client.doc('posts/p1').update({'author': null});`;

/** Keep creation separate from include/query configuration and delete policy. */
export function RelationshipCreation({ lang = "en" }: { lang?: "en" | "ar" }) {
  const ar = lang === "ar";
  return (
    <Section id="create-relationships" title={ar ? "إنشاء علاقة بين المستندات" : "Create a relationship between documents"}>
      <P>{ar
        ? "العلاقة حقل يحمل مرجعًا لمستند في نفس المشروع. أنشئ الهدف ثم اكتب مرجعه داخل المستند المصدر. استخدم مصفوفة مراجع لعدة أهداف. الأمثلة تستخدم عميل مشروع تمت تهيئته وصلاحيات كتابة مناسبة؛ استخدم معرّفات جديدة عند تكرارها."
        : "A relationship is a field containing a reference to a document in the same project. Create the target, then write its reference into the source document. Use an array for several targets. These examples assume an initialized project client and suitable write permissions. Use fresh IDs when rerunning create-only examples."}</P>
      <CodeTabs tabs={[
        { label: "JavaScript / TypeScript", lang: "typescript", code: js },
        { label: "Flutter / Dart", lang: "dart", code: dart },
      ]} />
      <P>{ar
        ? "المسار مثل users/u1 يكون داخل المشروع وليس رابطًا. include يحمّل الهدف عند القراءة، والتحديث يغيّر المرجع، وnull يزيل العلاقة دون حذف الهدف. المرجع لا ينشئ الهدف تلقائيًا ولا يضمن وجوده ولا يضيف حقلًا عكسيًا."
        : "Store a project-relative path such as users/u1, not a URL. include loads targets when reading. update reassigns a reference, and null unlinks it without deleting the target. A reference does not create its target, guarantee its existence, or add an inverse field."}</P>
      <Callout tone="info" title={ar ? "الإصدارات والصلاحيات" : "Versions and permissions"}>
        {ar
          ? "الدالة reference(path) متاحة في @vellumdb/sdk-js. القراءة الموسعة تفحص صلاحيات الهدف؛ الهدف الواحد المفقود أو الممنوع يرجع null، والمصفوفات تستبعد الأهداف غير المتاحة. include لا يثبت قواعد حذف دائمة."
          : "The JavaScript reference(path) helper is exported by @vellumdb/sdk-js. Expansion checks target read permission. Missing or denied scalar targets return null, while arrays omit unavailable targets. include does not install persistent delete rules."}
      </Callout>
    </Section>
  );
}
