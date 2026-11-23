---
title: JavaScript SDK (@vellum/sdk-js)
order: 2
group: المجموعات البرمجية
description: مرجع تقني شامل لحزمة @vellum/sdk-js — إعداد العميل، CRUD، الاستعلامات والتجميعات، التدفق بالمؤشر، الدفعات المقسّمة، التخزين المؤقت، الوقت الفعلي ومصادقة EdDSA.
---

# JavaScript SDK (`@vellum/sdk-js`)

المرجع التقني الشامل لحزمة `@vellum/sdk-js` الإصدار `0.0.1`، المستند بالكامل إلى الواجهات الفعلية في `packages/sdk-js/src/{index,types,client,field-ops,batch,read-cache,auth-client,auth-storage,realtime-transport,backoff,safe-json}.ts`.

تعمل الحزمة على **Node.js 18+** والمتصفحات الحديثة وبيئات Edge، مع دعم كامل لـ TypeScript الصارم.

---

## التثبيت وتهيئة العميل (`createClient`)

```bash
npm install @vellum/sdk-js
# أو
pnpm add @vellum/sdk-js
```

```ts
import {
  createClient,
  fieldOp,
  BrowserLocalStorage,
  MemoryAuthStorage,
} from "@vellum/sdk-js";
import type { VellumClient, DocDataConverter } from "@vellum/sdk-js";

const db: VellumClient = createClient({
  projectId: "proj_01j9...",
  apiKey: process.env.VELLUM_API_KEY!, // استخدم pk_... في المتصفح و sk_... في الخادم فقط
  endpoint: "https://api.example.com",
  timeoutMs: 15_000,
  maxRetries: 3,
  retryBaseDelayMs: 250,
  retryMaxDelayMs: 10_000,
  cache: { enabled: true, ttlMs: 30_000, maxEntries: 1_000 },
  dedupeReads: true,
  warnOnMissingIndexes: true,
});
```

### خيارات `ClientConfig` الأساسية

| الخيار | القيمة الافتراضية | الوصف |
| --- | --- | --- |
| `projectId` / `apiKey` | **إلزامي** | معرّف المشروع ومفتاح API (يُرسل عبر `x-vellum-api-key` و`x-project-key`). |
| `endpoint` | `"http://localhost:8080"` | عنوان الخادم الأساسي HTTP(S). |
| `realtimeUrl` | `<endpoint>/v1/realtime` | تجاوز صريح لعنوان WebSocket (`ws://` أو `wss://`). |
| `getAuthToken` | `null` | دالة مخصصة لتوفير رمز Bearer (تتجاوز جلسة `db.auth`). |
| `authStorage` | `BrowserLocalStorage` أو `MemoryAuthStorage` | تخزين جلسة المصادقة القابل للتبديل. |
| `timeoutMs` | `30_000` | مهلة الطلب عبر `AbortController` (يرمي خطأً بالرمز `REQUEST_TIMEOUT`). |
| `maxRetries` | `3` | إعادة المحاولة للطلبات القابلة للتكرار (`GET` و`/query` و`/documents:aggregate` أو عند وجود `Idempotency-Key`) مع احترام ترويسة `Retry-After` وتراجع full-jitter. |
| `cache` | `{ enabled: false, ttlMs: 30_000, maxEntries: 1_000 }` | تفعيل `BoundedReadCache` (LRU + TTL) لقراءات `doc.get()`. |
| `dedupeReads` | `false` | دمج طلبات `doc.get()` المتزامنة المتطابقة في طلب HTTP واحد مع إرجاع نسخ مستقلة محمية لكل مستدعٍ. |

---

## عمليات CRUD وتحويلات الحقول الذرية و`withConverter<T>()`

```ts
const userRef = db.collection("users").doc("usr_ada");

// إنشاء مستند جديد مع TTL ووقت الخادم الذري
await userRef.create(
  {
    name: "Ada Lovelace",
    credits: 100,
    tags: ["engineering"],
    createdAt: fieldOp.serverTimestamp(),
  },
  { ttlSeconds: 86_400 }
);

// قراءة مع إسقاط الحقول وتحميل العلاقات
const snap = await userRef.get({
  select: ["name", "credits", "tags"],
  include: ["organizationId"],
});

// إدراج أو تحديث (UPSERT)
await userRef.upsert({ name: "Ada Lovelace", credits: 150 }, { merge: true });

// تحديث جزئي ذري مع التحقق من الإصدار (OCC)
await userRef.update(
  {
    credits: fieldOp.increment(-20),
    tags: fieldOp.arrayUnion("founders"),
    oldField: fieldOp.deleteField(),
  },
  { ifVersion: snap.version }
);

// حذف مشروط بالإصدار
await userRef.delete({ ifVersion: snap.version + 1 });
```

### محوّلات الأنواع `withConverter<T>()`

اربط `DocDataConverter<T>` (`toDoc` / `fromDoc`) مع `CollectionRef` أو `DocumentRef` أو `QueryBuilder` لضمان أمان الأنواع من طرف إلى طرف في القراءة والكتابة والتدفق والوقت الفعلي:

```ts
interface Order {
  id: string;
  totalCents: number;
  status: string;
}

const orderConverter: DocDataConverter<Order> = {
  toDoc: (o) => ({ totalCents: o.totalCents, status: o.status }),
  fromDoc: (snap) => {
    const d = snap.data();
    return { id: snap.id, totalCents: Number(d["totalCents"] ?? 0), status: String(d["status"] ?? "") };
  },
};

const orders = db.collection("orders").withConverter(orderConverter);
const snap = await orders.doc("ord_1").get();
const order: Order = snap.data();
```

---

## الاستعلامات، العلاقات، التجميعات والتدفق بالمؤشر

يدعم باني الاستعلام جميع **المعاملات الـ 13**:
`==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not-in`, `array-contains`, `array-contains-any`, `contains_ci`, `starts_with_ci`, `text_search`.

```ts
const ac = new AbortController();

// تدفق المستندات بذاكرة محدودة وحدود أمان صريحة (بدون SQL OFFSET)
for await (const doc of db
  .collection("orders")
  .where("status", "in", ["paid", "shipped"])
  .or([
    [{ field: "priority", op: "==", value: "urgent" }],
    [{ field: "totalCents", op: ">=", value: 50_000 }],
  ])
  .include([
    "customerId",
    { field: "assigneeId", collection: "users", as: "assignee", select: ["name"] },
  ])
  .orderBy("createdAt", "desc")
  .stream({ pageSize: 100, maxPages: 20, maxDocs: 1_500, signal: ac.signal })) {
  console.log(doc.id, doc.data(), doc.included);
}

// التجميعات على الخادم
const openCount = await db.collection("orders").where("status", "==", "open").count();
const byRegion = await db.collection("orders").aggregate({
  groupBy: ["region"],
  metrics: {
    orders: { op: "count" },
    revenue: { op: "sum", field: "totalCents" },
  },
});
```

يمكنك أيضًا استخدام `pages({ pageSize, maxPages, maxDocs, signal })` لاستلام كل صفحة `QuerySnapshot<T>` على حدة، و`startAfter(cursor)` / `startAt(cursor)` للتحكم اليدوي بالمؤشرات الموقّعة بـ HMAC.

---

## الكتابة المجمّعة المقسّمة (`batchWriteChunked`) والمعاملات (`runTransaction`)

```ts
// تقسيم تلقائي إلى دفعات آمنة (500 عملية افتراضيًا) مع تزامن محدود (4 افتراضيًا)
const summary = await db.batchWriteChunked(operations, {
  chunkSize: 500,
  concurrency: 4,
  signal: ac.signal,
  onProgress: ({ completedOperations, totalOperations }) => {
    console.log(`${completedOperations}/${totalOperations}`);
  },
});

// معاملة OCC مع إعادة محاولة تلقائية عند ABORTED_CONFLICT
const { result } = await db.runTransaction(
  async (tx) => {
    const snap = await tx.get(db.doc("accounts/acc_1"));
    const balance = Number(snap.data()["balance"]);
    if (balance < 100) throw new Error("Insufficient balance");
    tx.update("accounts/acc_1", { balance: balance - 100 });
    return balance - 100;
  },
  { maxAttempts: 5, signal: ac.signal }
);
```

---

## الوقت الفعلي (Realtime) ومراقبة الاتصال

تعمل جميع اشتراكات `onSnapshot` عبر اتصال WebSocket واحد متعدد الإرسال مع استئناف `resumeSeqId` وتراجع decorrelated jitter ومراقبة نبض Heartbeat.

```ts
const offState = db.onConnectionStateChange((next, prev) => {
  console.log(`Connection: ${prev} -> ${next}`); // disconnected | connecting | connected | reconnecting
});

const unsub = db
  .collection("messages")
  .where("roomId", "==", "general")
  .orderBy("createdAt", "desc")
  .limit(50)
  .onSnapshot(
    (snapshot) => {
      console.log("Watermark:", snapshot.watermarkSeqId, "Docs:", snapshot.docs.length);
    },
    (err) => console.error(err)
  );

// تنظيف الاشتراكات
unsub();
offState();
```

---

## مصادقة المستخدم النهائي (EdDSA) وإدارة دورة الحياة

- يدعم `db.auth` (والدوال المماثلة على `db`) التسجيل والدخول بالبريد/كلمة المرور، الدخول المجهول، OAuth، التحقق الثنائي TOTP MFA، وإعادة تعيين كلمة المرور.
- يتم تجديد رمز الوصول استباقيًا قبل 45 ثانية من انتهائه، كما تُدمج أخطاء `401` المتزامنة في طلب تجديد واحد (single-flight) ثم يُعاد إرسال الطلب تلقائيًا وتُعاد مصادقة اتصال WebSocket الحي.
- استدعِ `db.clearCache()` لمسح الذاكرة المؤقتة عند الحاجة، و**استدعِ `db.dispose?.()` دائمًا** عند إيقاف التطبيق لإغلاق WebSocket ومؤقتات التجديد وتحرير المستمعين.

## البنية المعيارية والحماية ضد التلاعب

حزمة `@vellum/sdk-js` مقسّمة إلى مجلدات متخصصة (`src/core/`، `src/cache/`، `src/auth/`، `src/realtime/`، `src/references/`، `src/batch/`، `src/client/`) مع تجميد الواجهات العامة و`fieldOp` واللقطات بـ `Object.freeze` وإخفاء الأسرار في `toJSON()` و`toString()`.
