import { SdkEndpointNote } from "../../../sdk-endpoint-note";
import { betaJavaScriptInstall, betaDartInstall } from "../../../beta-install";
import {
  Callout,
  Code,
  CodeTabs,
  Doc,
  H3,
  P,
  PageLink,
  Section,
  Steps,
  Table,
} from "../../../ui";

const install = betaJavaScriptInstall;

const createBrowser = `import { createClient, BrowserLocalStorage } from "@vellumdb/sdk-js";

const db = createClient({
  endpoint: "https://api.vellum.dev",
  projectId: "<YOUR_PROJECT_ID>",
  apiKey: "<YOUR_PK_KEY>", // مفتاح عام pk_ في المتصفح
  timeoutMs: 30_000,
  maxRetries: 3,
  cache: { enabled: true, ttlMs: 30_000, maxEntries: 500 },
  dedupeReads: true,
  authStorage: new BrowserLocalStorage(),
  warnOnMissingIndexes: true,
});`;

const createServer = `import { createClient } from "@vellumdb/sdk-js";

const adminDb = createClient({
  endpoint: process.env.VELLUM_ENDPOINT!,
  projectId: process.env.VELLUM_PROJECT_ID!,
  apiKey: process.env.VELLUM_SERVER_KEY!, // مفتاح خادم sk_ على البنية الخلفية فقط
  timeoutMs: 15_000,
  maxRetries: 3,
});`;

const crudTs = `import { createClient, type DocDataConverter } from "@vellumdb/sdk-js";

interface User {
  id: string;
  name: string;
  active: boolean;
}

const userConverter: DocDataConverter<User> = {
  toDoc: (u) => ({ name: u.name, active: u.active }),
  fromDoc: (snap) => ({
    id: snap.id,
    name: String(snap.data().name ?? ""),
    active: Boolean(snap.data().active),
  }),
};

const users = db.collection("users").withConverter(userConverter);
const ref = users.doc("u_123");

await ref.set({ id: "u_123", name: "Ada", active: true });          // PUT (استبدال كامل)
await ref.upsert({ id: "u_123", name: "Ada", active: true });       // INSERT ... ON CONFLICT DO UPDATE
const beforeUpdate = await ref.get();
await ref.update({ active: false }, { ifVersion: beforeUpdate.version });              // PATCH مع فحص الإصدار

const controller = new AbortController();
const snap = await ref.get({ signal: controller.signal, bypassCache: false });
if (snap.exists) {
  console.log(snap.id, snap.version, snap.data().name);
}

await ref.delete({ ifVersion: snap.version });`;

const crudJs = `const users = db.collection("users");
const ref = users.doc("u_123");

await ref.create({ name: "Ada", active: true }, { ttlSeconds: 86400 });
await ref.set({ name: "Ada", active: true }, { merge: true });
await ref.upsert({ name: "Ada", active: true });
await ref.update({ active: false });

const snap = await ref.get();
if (snap.exists) {
  console.log(snap.id, snap.version, snap.data());
}
await ref.delete();`;

const fieldOps = `import { fieldOp } from "@vellumdb/sdk-js";

await db.doc("counters/c_1").update({
  hits: fieldOp.increment(1),
  touched: fieldOp.serverTimestamp(),
  tags: fieldOp.arrayUnion("v2", "hardened"),
  legacy: fieldOp.arrayRemove("old"),
  obsolete: fieldOp.deleteField(),
});`;

const queryTs = `type Order = { status: string; total: number; createdAt: string };

const query = db
  .collection<Order>("orders")
  .where("status", "==", "open")
  .where("total", ">=", 100)
  .orderBy("createdAt", "desc")
  .select("status", "total", "createdAt")
  .limit(25);

const page = await query.get();
console.log("count:", page.docs.length, "nextCursor:", page.nextCursor);

// التصفح الانسيابي عبر جميع الصفحات دون تحميل المجموعة كاملة في الذاكرة:
for await (const doc of query.stream({ pageSize: 50, maxDocs: 1_000 })) {
  console.log(doc.id, doc.data().total);
}

// التجميعات والحذف الشرطي:
const openCount = await db.collection("orders").where("status", "==", "open").count();
const totalRevenue = await db.collection("orders").where("status", "==", "paid").sum("total");
const byStatus = await db.collection("orders").aggregate({
  groupBy: ["status"],
  metrics: {
    orders: { op: "count" },
    revenue: { op: "sum", field: "total" },
  },
});
console.log({ openCount, totalRevenue, byStatus });`;

const realtimeTs = `const stopState = db.onConnectionStateChange((next, prev) => {
  console.log("WS:", prev, "->", next);
});

const unsubscribe = db
  .collection("orders")
  .where("status", "==", "open")
  .onSnapshot(
    (snapshot) => {
      for (const change of snapshot.changes) {
        console.log(change.type, change.seqId, change.doc.path);
      }
      console.log("watermark:", snapshot.watermarkSeqId, "docs:", snapshot.docs.length);
    },
    (error) => console.error("Realtime error:", error)
  );

// عند الإغلاق النظيف:
unsubscribe();
stopState();
db.dispose?.();`;

const batchAndTx = `// دفعة ذرية واحدة (حتى 100 عملية / 5 MiB)
await db.batchWrite([
  { type: "set", path: "users/u_1", data: { name: "Ada", active: true } },
  { type: "update", path: "users/u_2", data: { active: false } },
  { type: "delete", path: "users/u_3" },
]);

// تقسيم آلي للدفعات الضخمة مع تحكم بالتزامن وتقارير تقدّم
const largeWritesArray = [{ type: "set", path: "users/u_4", data: { name: "Grace" } }];
await db.batchWriteChunked(largeWritesArray, {
  chunkSize: 100,
  concurrency: 4,
  onProgress: (p) => console.log(\`\${p.completedOperations}/\${p.totalOperations}\`),
});

// معاملة تزامن متفائل (OCC) مع إعادة محاولة تلقائية عند ABORTED_CONFLICT
const { result, commit } = await db.runTransaction(
  async (tx) => {
    const snap = await tx.get<{ n: number }>("counters/c_1");
    const next = (snap.data().n ?? 0) + 1;
    tx.set("counters/c_1", { n: next });
    return next;
  },
  { maxAttempts: 5 }
);
console.log(result, commit);`;

const collections = `// القراءة تقبل pk_، بينما تتطلب عمليات الإدارة مفتاح sk_.
const { collections, nextCursor } = await db.listCollections({ limit: 500, search: "user" });
const info = await db.getCollectionInfo("users");

await db.createCollection("users", {
  description: "Customer accounts",
  defaultTtlSeconds: 86400,
  schemaValidation: { requiredFields: ["email"], strict: false },
  ifNotExists: true,
});
await db.updateCollection("users", { description: "Active customers" });

await db.importDocuments("users", [{ id: "u_1", data: { email: "ada@example.com" } }], { mode: "upsert" });
const exported = await db.exportDocuments("users", { limit: 500 });

// دوال مختصرة على CollectionReference:
const ref = db.collection("scratch");
await ref.create({ ifNotExists: true });
await ref.clear();
await ref.drop();`;

const authTs = `const stopAuth = db.auth.onAuthStateChanged((user) => {
  console.log("auth:", user ? user.id : "signed out");
});

await db.auth.signUpWithEmailAndPassword({
  email: "ada@example.com",
  password: "correct-horse-battery-staple",
  displayName: "Ada",
});

const signedIn = await db.auth.signInWithEmailAndPassword("ada@example.com", "correct-horse-battery-staple");
if ("mfaRequired" in signedIn) {
  await db.auth.verifyMfaChallenge(signedIn.mfaTicket, "123456", "totp");
}

const token = await db.auth.getIdToken();
await db.auth.updateProfile({ displayName: "Ada Lovelace" });
await db.auth.signOut({ allSessions: true });
stopAuth();`;

const errorsTs = `try {
  await db.doc("users/u_123").get();
} catch (err) {
  const e = err as Error & {
    code?: string;
    status?: number;
    details?: Record<string, unknown>;
    requestId?: string;
  };
  console.error(e.code, e.status, e.message, e.requestId);
}`;

export default function Page() {
  return (
    <Doc
      title="حزمة JavaScript / TypeScript"
      description="الدليل العملي الكامل لحزمة @vellumdb/sdk-js المحصّنة: إعداد العميل، المهلة وإعادة المحاولة، الذاكرة المؤقتة المحدودة، المحوّلات المُنَمّطة، التدفقات، الدفعات المقسّمة، المعاملات، والمصادقة."
      eyebrow="المجموعات البرمجية"
    >

      <SdkEndpointNote arabic />
      <Callout tone="info" title="إعدادات اختيارية">
        المعرفات من <code>doc()</code> ورموز المصادقة وسياسة الكاش والمراجع مع <code>addWithRelated</code> ونقل الوقت الفعلي في <PageLink slug="advanced" lang="ar">الإعدادات المتقدمة</PageLink>.
      </Callout>

      <Section id="beta-install" title="تثبيت النسخة التجريبية">
      <P>الإصدار 0.0.9 متاح على npm وpub.dev. ثبّت الحزم المنشورة أدناه، ولا تحتاج إلى نسخة من المستودع.</P>
        <Code lang="bash" title="TypeScript / Node 22+" code={betaJavaScriptInstall} />
        <Code lang="yaml" title="Flutter / Dart 3.4+" code={betaDartInstall} />
      </Section>
      <Section id="install-and-setup" title="التثبيت وإعداد العميل">
        <P>
          <code>@vellumdb/sdk-js</code> هي الحزمة الرسمية لـ Node.js (22+) والمتصفحات. تعمل كغلاف مُنمّط
          وخفيف فوق واجهة <code>/v1</code> مع دعم مدمج للمهل (<code>AbortController</code>)، وإعادة المحاولة
          للعمليات المتكررة الآمنة (Idempotent)، وتجميع طلبات القراءة المتزامنة، وذاكرة LRU/TTL اختيارية،
          ومستشار الفهارس.
        </P>
        <Code code={install} lang="bash" title="التثبيت" />
        <Steps
          items={[
            {
              title: "احصل على projectId ومفتاح API",
              body: <>استخدم مفتاح <code>pk_</code> في المتصفح، واحتفظ بمفتاح <code>sk_</code> في الخادم فقط.</>,
            },
            {
              title: "أنشئ عميلاً واحداً وأعد استخدامه",
              body: <>يمتلك العميل اتصال WebSocket المشترك وحالة المصادقة والذاكرة المؤقتة؛ أنشئه مرة واحدة لكل مشروع واستدعِ <code>db.dispose?.()</code> عند الإغلاق.</>,
            },
          ]}
        />
        <CodeTabs
          tabs={[
            { label: "المتصفح", lang: "ts", code: createBrowser },
            { label: "الخادم (Node.js)", lang: "ts", code: createServer },
          ]}
        />
        <H3 id="client-options">خيارات createClient(config)</H3>
        <Table
          head={["الخيار", "القيمة الافتراضية", "الوظيفة"]}
          rows={[
            [<code>projectId</code>, "إلزامي", "معرّف المشروع المستهدف."],
            [<code>apiKey</code>, "إلزامي", <>يُرسل في <code>x-vellum-api-key</code> (مع الاسم القديم للتوافق).</>],
            [<code>endpoint</code>, <code>http://localhost:8080</code>, "أصل الخادم دون لاحقة /v1."],
            [<code>timeoutMs</code>, <code>30_000</code>, "مهلة كل طلب HTTP بالمللي ثانية (0 لتعطيلها؛ ترمي REQUEST_TIMEOUT)."],
            [<code>maxRetries</code>, <code>3</code>, "إعادة المحاولة التلقائية لأخطاء 429/5xx والشبكة للطلبات الآمنة فقط (GET و/query أو مع Idempotency-Key)."],
            [<code>retryBaseDelayMs / retryMaxDelayMs</code>, <code>250 / 10_000</code>, "حدود التراجع الأُسّي بتشتيت كامل (Full-Jitter) مع احترام Retry-After."],
            [<code>cache</code>, <code>undefined</code>, "ذاكرة قراءة LRU/TTL اختيارية لـ doc.get() مع إبطال تلقائي عند الكتابة (ttlMs: 30_000، maxEntries: 1_000)."],
            [<code>dedupeReads</code>, <code>false</code>, "تجميع طلبات doc.get() المتزامنة لنفس المسار في طلب HTTP واحد (Single-Flight) مع نسخ دفاعية مستقلة."],
            [<code>warnOnMissingIndexes / onIndexSuggestion</code>, <code>true / null</code>, "طباعة والتقاط توصيات مستشار الفهارس من ترويسات x-vellum-index-*."],
            [<code>authStorage / getAuthToken</code>, "localStorage أو الذاكرة", "حفظ جلسة المستخدم النهائي أو تزويد رمز Bearer خارجي."],
          ]}
        />
      </Section>

      <Section id="crud-and-paths" title="عمليات CRUD والمحوّلات المُنَمّطة (withConverter)">
        <P>
          توفّر المراجع <code>CollectionReference</code> و<code>DocumentReference</code> واجهة كاملة تدعم{" "}
          <code>withConverter&lt;U&gt;(converter)</code> لسلامة الأنواع من الطرف إلى الطرف، و<code>upsert()</code>،
          وخيارات <code>ttlSeconds</code> / <code>expiresAt</code>، و<code>ifVersion</code>، و<code>AbortSignal</code>:
        </P>
        <CodeTabs
          tabs={[
            { label: "TypeScript (مع withConverter)", lang: "ts", code: crudTs },
            { label: "JavaScript", lang: "js", code: crudJs },
          ]}
        />
        <H3 id="field-transforms">تحويلات الحقول الذرية (fieldOp)</H3>
        <Code code={fieldOps} lang="ts" />
      </Section>

      <Section id="queries-and-pagination" title="الاستعلامات والتدفقات والتجميعات">
        <P>
          منشئ الاستعلام غير قابل للتعديل ويدعم جميع عوامل التصفية الـ 13، و<code>or()</code>، و
          <code>include()</code>، و<code>select()</code>، والترقيم بالمؤشرات عبر <code>startAt</code> /{" "}
          <code>startAfter</code>، والمولّدات غير المتزامنة <code>pages()</code> و<code>stream()</code>،
          ودوال التجميع <code>aggregate()</code> و<code>count()</code> و<code>sum()</code> و
          <code>avg()</code> و<code>min()</code> و<code>max()</code>، والحذف الشرطي{" "}
          <code>deleteWhere()</code>:
        </P>
        <Code code={queryTs} lang="ts" />
      </Section>

      <Section id="realtime" title="الاشتراكات الفورية ومراقبة الاتصال">
        <P>
          تُرجع <code>onSnapshot(callback, onError?)</code> دالة لإلغاء الاشتراك. كما يكشف العميل الخاصية{" "}
          <code>db.connectionState</code> ودالة <code>db.onConnectionStateChange(listener)</code> لتتبع
          دورة حياة اتصال WebSocket بدقة:
        </P>
        <Code code={realtimeTs} lang="ts" />
      </Section>

      <Section id="batch-and-transactions" title="الدفعات المقسّمة ومعاملات OCC">
        <Code code={batchAndTx} lang="ts" />
      </Section>

      <Section id="collections" title="إدارة دورة حياة المجموعات">
        <Code code={collections} lang="ts" />
      </Section>

      <Section id="end-user-auth" title="مصادقة المستخدمين النهائيين والأخطاء">
        <P>
          يُدير <code>db.auth</code> (مع نفس الدوال متاحة مباشرة على <code>db</code>) التسجيل وتسجيل الدخول
          ومصادقة MFA (TOTP) والتجديد الاستباقي للرموز وإعادة محاولة طلبات <code>401</code> مرة واحدة بعد
          تحديث الرمز تلقائياً، وإعادة مصادقة WebSocket عند تغيّر الرمز:
        </P>
        <Code code={authTs} lang="ts" />
        <H3 id="errors">معالجة الأخطاء</H3>
        <P>
          ترمي الاستجابات غير الناجحة كائن <code>Error</code> مزوّداً بالحقول <code>code</code> و
          <code>status</code> و<code>details</code> و<code>requestId</code>:
        </P>
        <Code code={errorsTs} lang="ts" />
        <Callout tone="info" title="دوال إدارة الذاكرة والموارد">
          استدعِ <code>db.clearCache()</code> لمسح ذاكرة القراءة الاختيارية يدوياً، و<code>db.dispose?.()</code>{" "}
          لإغلاق اتصال WebSocket ومؤقتات تجديد المصادقة بنظافة عند إنهاء التطبيق أو الاختبارات.
        </Callout>
        <P>
          راجع <PageLink slug="errors-and-limits" lang="ar">الحصص والحدود</PageLink> و{" "}
          <PageLink slug="reference/errors" lang="ar">رموز الأخطاء وإرشادات إعادة المحاولة</PageLink>.
        </P>
      </Section>

      <Callout tone="warning" title="تغيير الحساب والاشتراكات الفورية">
        أعد إنشاء الاشتراكات بعد تسجيل الدخول أو الخروج أو تبديل المستخدم.
        في الإصدار المنشور 0.0.1، أغلق العميل القديم باستخدام dispose وأنشئ عميلاً جديداً
        لكل حساب، ولا تشارك ذاكرة العميل بين المستخدمين. الإصلاح القادم ينهي الاشتراكات
        القديمة عند تغيير الهوية. مع getAuthToken خارجي، أعد ضبط الاشتراكات عند تغيير الهوية.
      </Callout>
      <Section id="modular-architecture" title="البنية المعيارية والحماية ضد التلاعب">
        <P>
          حزمة <code>@vellumdb/sdk-js</code> مقسّمة إلى مجلدات وملفات متخصصة داخل{" "}
          <code>src/</code> (<code>core/</code>، <code>cache/</code>، <code>auth/</code>،{" "}
          <code>realtime/</code>، <code>references/</code>، <code>batch/</code>، و{" "}
          <code>client/</code>) مع نقطة تصدير موحّدة نظيفة. جميع الواجهات العامة ورموز{" "}
          <code>fieldOp</code> واللقطات مجمّدة بـ <code>Object.freeze</code> لمنع التلاعب، كما
          تحجب دوال <code>toJSON()</code> و<code>toString()</code> مفاتيح API والتوكنات تلقائياً
          وتعيد كل قراءة نسخة معزولة محمية من Prototype Pollution.
        </P>
      </Section>
    </Doc>
  );
}
