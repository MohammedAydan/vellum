---
title: مجموعة Flutter البرمجية (vellum_flutter)
order: 1
group: المجموعات البرمجية
description: دليل تقني شامل لحزمة vellum_flutter بلغة Dart — إعداد العميل، CRUD، الاستعلامات وتدفق المؤشر، الدفعات المقسّمة، الوقت الفعلي، مصادقة EdDSA والحماية الإنتاجية.
---

# مجموعة Flutter البرمجية (`vellum_flutter`)

الدليل التقني الشامل لحزمة `vellum_flutter` الإصدار `0.0.2`، المستند بالكامل إلى التنفيذ الفعلي في `sdks/flutter/lib/vellum_flutter.dart`.

حزمة Dart خالصة (`>=3.4.0 <4.0.0`) آمنة تمامًا ضد القيم الفارغة (null-safe) ولا تعتمد على محرك Flutter، لذا تعمل بسلاسة على iOS وAndroid وWeb وسطح المكتب وخدمات Dart الخلفية.

---

## التثبيت وتهيئة العميل (`VellumClient`)

```yaml
dependencies:
  vellum_flutter: ^0.0.2
```

```dart
import 'package:vellum_flutter/vellum_flutter.dart';
import 'package:http/http.dart' as http;

final httpClient = http.Client(); // يُفضّل إعادة استخدامه لتجميع اتصالات TCP/TLS

final client = VellumClient(
  endpoint: 'https://api.example.com',
  projectId: 'proj_01j9...',
  apiKey: 'pk_live_...', // لا تضع مفاتيح sk_ داخل تطبيقات العملاء أبدًا
  httpClient: httpClient,
  authStorage: SecureAuthTokenStorage(),
  requestTimeout: const Duration(seconds: 15),
  maxRetries: 3,
  retryBaseDelay: const Duration(milliseconds: 250),
  retryMaxDelay: const Duration(seconds: 15),
  coalesceInFlightGets: true,
);
```

### أبرز خصائص المتانة في `VellumClient`

- **`coalesceInFlightGets` (مفعّل افتراضيًا `true`)**: يدمج طلبات `GET` المتطابقة المتزامنة في طلب واحد (باستثناء قراءات المعاملات `transactionToken=`).
- **`requestTimeout` و`maxRetries`**: مهلة افتراضية `30s` (ترمي `VellumException(code: 'REQUEST_TIMEOUT', statusCode: 408)`) مع إعادة محاولة حتى 3 مرات للطلبات الآمنة مع احترام `Retry-After` وتراجع full-jitter.
- **تنقيح الأسرار التلقائي في `toString()`**: تخفي `VellumClient` و`VellumUser` و`VellumMfaRequired` و`TotpEnrollment` و`TransactionContext` و`VellumException` مفاتيح `pk_`/`sk_` ورموز `Bearer` وJWT تلقائيًا لمنع تسربها في السجلات.
- **حماية المسارات**: ترفض `validateVellumSegment` و`validateVellumPath` محاولات اجتياز المسار (`..`، `%2e%2e`، `%2f`، `\`، `?`، `#` وأحرف التحكم).

---

## عمليات CRUD وتحويلات الحقول و`withConverter<R>()`

```dart
final userRef = client.collection('users').doc('usr_ada');

// إنشاء مستند مع TTL ومفتاح عدم التكرار
await userRef.create(
  {
    'name': 'Ada Lovelace',
    'credits': 100,
    'tags': ['engineering'],
    'createdAt': FieldValue.serverTimestamp(),
  },
  ttlSeconds: 86400,
  idempotencyKey: 'create-usr-ada',
);

// قراءة مع إسقاط الحقول وتحميل العلاقات
final snap = await userRef.get(
  select: ['name', 'credits', 'tags'],
  include: ['organizationId'],
);

// اختصارات سريعة على العميل
final doc = await client.getDoc('users/usr_ada');
await client.setDoc('users/usr_ada', {'active': true}, merge: true);
await client.updateDoc(
  'users/usr_ada',
  {
    'credits': FieldValue.increment(-10),
    'tags': FieldValue.arrayUnion(['founders']),
    'legacyFlag': FieldValue.deleteField(),
  },
  ifVersion: doc.version,
);
await client.deleteDoc('users/usr_ada', ifVersion: doc.version + 2);
```

اربط نماذج Dart الخاصة بك باستخدام `withConverter<R>(fromVellum: ..., toVellum: ...)` على `CollectionReference` للحصول على استجابة ذات أنواع قوية.

---

## الاستعلامات، التجميعات وتدفق المؤشر (`streamPages` / `streamDocuments`)

يدعم الاستعلام جميع **المعاملات الـ 13**:
`==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `not-in`, `array-contains`, `array-contains-any`, `contains_ci`, `starts_with_ci`, `text_search`، بالإضافة إلى `or()` و`include()` (`VellumInclude`) و`select()`.

```dart
final query = client
    .collection('orders')
    .where('status', 'in', ['paid', 'shipped'])
    .or([
      [
        {'field': 'priority', 'op': '==', 'value': 'urgent'},
      ],
      [
        {'field': 'totalCents', 'op': '>=', 'value': 50000},
      ],
    ])
    .include([
      'customerId',
      const VellumInclude(field: 'assigneeId', collection: 'users', as: 'assignee', select: ['name']),
    ])
    .orderBy('createdAt', dir: 'desc');

// تدفق الصفحات أو المستندات بالمؤشر (بدون SQL OFFSET)
await for (final page in query.streamPages(pageSize: 100, maxPages: 20)) {
  print('Page docs: ${page.docs.length}');
}

await for (final doc in query.streamDocuments(pageSize: 100, maxPages: 20)) {
  print('${doc.id}: ${doc.data()}');
}

// التجميعات على الخادم
final count = await query.count();
final grouped = await query.aggregate(
  groupBy: ['region'],
  metrics: {
    'count': const AggregateMetric.count(),
    'revenue': const AggregateMetric.sum('totalCents'),
  },
);
```

---

## الكتابة المجمّعة المقسّمة والمعاملات (OCC)

```dart
// باني الدفعات مع التقسيم التلقائي (500 عملية لكل دفعة افتراضيًا)
final batch = client.batch();
for (final item in items) {
  batch.set(client.collection('catalog').doc(item.id), item.toJson(), merge: true);
}
await batch.commitChunked(chunkSize: 500, idempotencyKeyPrefix: 'catalog-sync');

// أو مباشرة عبر القائمة
await client.writeBatchChunked(writes, chunkSize: 500, idempotencyKeyPrefix: 'bulk');

// معاملة OCC مع إعادة المحاولة التلقائية عند ABORTED_CONFLICT
await client.runTransaction<void>((tx) async {
  final ref = client.doc('accounts/acc_1');
  final snap = await tx.get(ref);
  final bal = (snap.data()?['balance'] as num?)?.toInt() ?? 0;
  tx.update(ref, {'balance': bal - 50});
}, maxAttempts: 5);
```

---

## تدفقات الوقت الفعلي (`snapshots()`)

يستخدم `VellumRealtimeTransport` اتصال WebSocket موحّد مع تراجع decorrelated jitter (`500ms`–`30s`)، واستئناف تلقائي عبر `resumeSeqId`، وطابور إرسال محدود (`256` إطارًا)، ونبض Heartbeat (`25s`/`60s`).

```dart
final sub = client
    .collection('messages')
    .where('roomId', '==', 'general')
    .orderBy('createdAt', dir: 'desc')
    .limit(50)
    .snapshots()
    .listen(
      (snapshot) => print('Docs: ${snapshot.docs.length}, watermark: ${snapshot.watermarkSeqId}'),
      onError: (Object err) => print('Realtime error: $err'),
    );

await sub.cancel();
```

---

## مصادقة EdDSA التفاعلية والتخلص من الموارد (`dispose()` / `close()`)

- استعد الجلسة عند بدء التطبيق عبر `await client.auth.restore()` بعد حقن `AuthTokenStorage` آمن (مثل `flutter_secure_storage`).
- يحمي العداد الرتيب `sessionEpoch` من سباقات تجديد الرمز بعد `signOut()` أو `dispose()`، بينما تدمج `refreshOnUnauthorized` أخطاء `401` المتزامنة في طلب تجديد واحد (single-flight).
- تعيد `signInWithEmailAndPassword` نوعًا مغلقًا `VellumAuthResult` (`VellumSession` أو `VellumMfaRequired`) لمطابقة شاملة في Dart 3.
- استدعِ `client.dispose()` (أو `client.close()`) عند إنهاء العميل لتحرير المؤقتات واتصالات WebSocket والذاكرة المؤقتة.

## البنية المعيارية والحماية ضد التلاعب

حزمة `vellum_flutter` مقسّمة إلى 13 وحدة نظيفة داخل `lib/src/{core,models,auth,realtime,client}/` خلف `lib/vellum_flutter.dart` (Dart نقي متوافق مع الويب بدون `dart:io`) مع تغليف المجموعات بـ `Map.unmodifiable`/`List.unmodifiable` وإخفاء التوكنات والمفاتيح في `toString()`.
