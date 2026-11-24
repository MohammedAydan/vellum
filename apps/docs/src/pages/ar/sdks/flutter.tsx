import { SdkEndpointNote } from "../../../sdk-endpoint-note";
import { betaJavaScriptInstall, betaDartInstall } from "../../../beta-install";
import {
  Callout,
  Code,
  Doc,
  H3,
  P,
  PageLink,
  Section,
  Steps,
  Table,
  UL,
} from "../../../ui";

const pubspec = betaDartInstall;

const setup = `import 'package:vellum_flutter/vellum_flutter.dart';

final client = VellumClient(
  endpoint: 'https://api.vellum.dev',     // أصل الخادم دون /v1
  projectId: '<YOUR_PROJECT_ID>',
  apiKey: '<YOUR_PK_KEY>',               // pk_ في التطبيق، sk_ على الخادم فقط
  requestTimeout: const Duration(seconds: 30),
  maxRetries: 3,
  retryBaseDelay: const Duration(milliseconds: 250),
  retryMaxDelay: const Duration(seconds: 15),
  coalesceInFlightGets: true,
  warnOnMissingIndexes: true,
  onIndexSuggestion: (VellumIndexSuggestion suggestion) {
    print('Index advisor: \${suggestion.url}');
  },
);`;

const crud = `final users = client.collection('users');
final ref = users.doc('u_123');

await ref.set({'name': 'Ada', 'active': true});               // PUT (استبدال)
await ref.set({'name': 'Ada'}, merge: true);                  // PUT مع دمج
await ref.upsert({'name': 'Ada', 'active': true});            // INSERT ... ON CONFLICT DO UPDATE
await ref.update({'lastSeen': FieldValue.serverTimestamp()}); // PATCH

final snap = await ref.get();
if (snap.exists) {
  print('\${snap.id} v\${snap.version} \${snap.data()?['name']}');
}

// التزامن المتفائل لمستند واحد:
await ref.update({'active': false}, ifVersion: snap.version);
await ref.delete(ifVersion: snap.version + 1);

// دوال مختصرة مباشرة بالمسار:
await client.setDoc('users/u_456', {'name': 'Grace'});
final doc = await client.getDoc('users/u_456');
await client.updateDoc('users/u_456', {'active': false});
await client.deleteDoc('users/u_456');`;

const converter = `class User {
  final String id;
  final String name;
  const User({required this.id, required this.name});
}

final users = client.collection('users').withConverter<User>(
  fromVellum: (data, id) => User(id: id, name: data['name'] as String? ?? ''),
  toVellum: (user) => {'name': user.name},
);

final ref = users.doc('u_123');          // DocumentReference<User>
final User? me = (await ref.get()).data();
await ref.set(const User(id: 'u_123', name: 'Ada'));`;

const fieldOps = `await client.doc('counters/c_1').update({
  'hits': FieldOp.increment(1),
  'touched': FieldValue.serverTimestamp(),
  'tags': FieldValue.arrayUnion(['a', 'b']),
  'old': FieldValue.arrayRemove(['x']),
  'obsolete': FieldValue.deleteField(),
});

// قيم التنسيق السلكي الموسوم ($t / $v):
final payload = {
  'big': VellumWire.int64(9007199254740993),
  'when': VellumWire.timestamp(DateTime.now().toUtc()),
  'owner': VellumWire.reference('users/u_123'),
  'blob': VellumWire.bytes([72, 105]),
  'loc': VellumWire.geopoint(30.0444, 31.2357),
};
final Object? decoded = VellumWire.decodeWireValue(payload['big']); // int`;

const query = `final q = client
    .collection('orders')
    .where('status', '==', 'open')
    .where('total', '>=', 100)
    .select(['status', 'total', 'createdAt'])
    .include([const VellumInclude(field: 'customerId', as: 'customer')])
    .orderBy('createdAt', dir: 'desc')
    .limit(25);

final page = await q.get();
for (final d in page.docs) {
  print('\${d.path} v\${d.version} \${d.data()}');
}

// التصفح الانسيابي عبر التدفقات (Streams) بذاكرة محدودة:
await for (final doc in q.streamDocuments(pageSize: 50, maxPages: 10)) {
  print('\${doc.id}: \${doc.data()}');
}

// التجميعات والحذف الشرطي:
final int totalOpen = await client.collection('orders').where('status', '==', 'open').count();
final num? sumTotal = await client.collection('orders').where('status', '==', 'paid').sum('total');
final int deleted = await client.collection('sessions').where('expired', '==', true).deleteWhere(limit: 200);`;

const realtime = `final docSub = client.doc('users/u_123').snapshots().listen(
  (snap) => print('\${snap.path} v\${snap.version} \${snap.data()}'),
  onError: (e) => print('realtime error: $e'),
);

final querySub = client
    .collection('orders')
    .where('status', '==', 'open')
    .snapshots()
    .listen(
  (qs) {
    for (final change in qs.changes) {
      print('\${change.type} seq=\${change.seqId} \${change.doc.path}');
    }
    print('watermark=\${qs.watermarkSeqId} docs=\${qs.docs.length}');
  },
  onError: (e) => print('realtime error: $e'),
);

// دوال مختصرة:
final live = client.watchCollection('orders', where: {'status': 'open'}, limit: 25);
final one = client.watchDocument('users/u_123');`;

const batchAndTx = `// الكتابة الدفعية عبر الباني الانسيابي VellumWriteBatch:
final batch = client.batch()
  ..set(client.doc('users/u_1'), {'name': 'Ada', 'active': true})
  ..update(client.doc('users/u_2'), {'active': false})
  ..delete(client.doc('users/u_3'));
await batch.commit();

// معاملة تزامن متفائل (OCC) مع إعادة محاولة تلقائية عند ABORTED_CONFLICT:
final nextValue = await client.runTransaction<int>((tx) async {
  final snap = await tx.get(client.doc('counters/c_1'));
  final next = ((snap.data()?['n'] as num?) ?? 0).toInt() + 1;
  tx.set(client.doc('counters/c_1'), {'n': next});
  tx.update(client.doc('audit/last'), {'at': FieldValue.serverTimestamp()});
  return next;
}, maxAttempts: 5);`;

const auth = `// عند بدء التطبيق لاستعادة الجلسة من التخزين الآمن:
await client.auth.restore();

final result = await client.auth.signInWithEmailAndPassword(
  email: 'ada@example.com',
  password: 'correct-horse-battery-staple',
);
if (result is VellumMfaRequired) {
  await client.auth.verifyMfaChallenge(
    mfaTicket: result.mfaTicket,
    code: '123456',
    factorType: 'totp',
  );
}

final sub = client.auth.authStateChanges.listen((user) {
  print(user == null ? 'signed out' : 'signed in: \${user.id}');
});

await client.auth.updateProfile(displayName: 'Ada Lovelace');
await client.auth.signOut(allSessions: true);
await sub.cancel();`;

const errorCode = `try {
  await client.doc('users/u_123').get();
} on VellumException catch (e) {
  print('\${e.code} [\${e.statusCode}]: \${e.message} requestId=\${e.requestId}');
}`;

export default function Page() {
  return (
    <Doc
      title="حزمة Flutter / Dart"
      description="الدليل العملي لحزمة vellum_flutter المحصّنة: إعداد العميل، الحماية من اجتياز المسارات، CRUD والمحوّلات، الاستعلام والتدفقات، البث الفوري، الدفعات والمعاملات، والمصادقة."
      eyebrow="المجموعات البرمجية"
    >

      <SdkEndpointNote arabic />
      <Callout tone="info" title="إعدادات اختيارية">
        المعرفات من <code>doc()</code> ورموز المصادقة وسياسة الكاش والمراجع مع <code>addWithRelated</code> ونقل الوقت الفعلي في <PageLink slug="advanced" lang="ar">الإعدادات المتقدمة</PageLink>.
      </Callout>

      <Section id="beta-install" title="تثبيت النسخة التجريبية">
      <P>الإصدار 0.0.2 متاح على npm وpub.dev. ثبّت الحزم المنشورة أدناه، ولا تحتاج إلى نسخة من المستودع.</P>
        <Code lang="bash" title="TypeScript / Node 22+" code={betaJavaScriptInstall} />
        <Code lang="yaml" title="Flutter / Dart 3.4+" code={betaDartInstall} />
      </Section>
      <Section id="install-and-setup" title="التثبيت وإعداد العميل">
        <P>
          <code>vellum_flutter</code> هي الحزمة الرسمية لـ Flutter وDart (<code>&gt;=3.4.0 &lt;4.0.0</code>).
          تتحدث نفس تنسيق الإرسال الموسوم (<code>$t/$v</code>) وبروتوكول <code>/v1</code> لـ REST
          وWebSocket، وتُصدَّر واجهتها الكاملة من ملف واحد هو{" "}
          <code>package:vellum_flutter/vellum_flutter.dart</code>.
        </P>
        <Steps
          items={[
            {
              title: "أضف الاعتمادية إلى pubspec.yaml",
              body: <>تعتمد الحزمة فقط على <code>http</code> و<code>web_socket_channel</code>.</>,
            },
            {
              title: "أنشئ عميلاً واحداً وأعد استخدامه",
              body: <>مرّر <code>endpoint</code> كسلسلة نصية لأصل الخادم دون <code>/v1</code>، واستخدم <code>pk_</code> في تطبيقات الجوال والويب.</>,
            },
          ]}
        />
        <Code code={pubspec} lang="yaml" title="pubspec.yaml" />
        <Code code={setup} lang="dart" title="تهيئة VellumClient" />
        <Table
          head={["الخيار", "القيمة الافتراضية", "الوظيفة"]}
          rows={[
            [<code>requestTimeout</code>, <code>Duration(seconds: 30)</code>, "مهلة كل طلب HTTP."],
            [<code>maxRetries</code>, <code>3</code>, "إعادة المحاولة التلقائية للطلبات الآمنة مع تراجع أُسّي وتشتيت."],
            [<code>coalesceInFlightGets</code>, <code>true</code>, "دمج طلبات القراءة المتزامنة لنفس المسار في طلب HTTP واحد."],
            [<code>warnOnMissingIndexes / onIndexSuggestion</code>, <code>true / null</code>, "التقاط توصيات مستشار الفهارس عبر VellumIndexSuggestion."],
            [<code>authStorage</code>, <code>InMemoryAuthTokenStorage()</code>, "طبقة حفظ الجلسة؛ طبّق AuthTokenStorage (مثل flutter_secure_storage) للإنتاج."],
          ]}
        />
        <Callout tone="info" title="حماية المسارات وإخفاء الأسرار تلقائياً">
          تتحقق <code>validateVellumPath()</code> و<code>validateVellumSegment()</code> من كل مسار قبل إرساله
          وترفض محاولات اجتياز المسار (<code>..</code>، <code>%2e%2e</code>، أحرف التحكم، <code>?</code>،{" "}
          <code>#</code>، <code>\</code>) بخطأ <code>INVALID_DOCUMENT_PATH</code>. كما تُخفي{" "}
          <code>VellumException.toString()</code> أي مفاتيح <code>pk_/sk_</code> أو رموز <code>Bearer</code>{" "}
          تلقائياً.
        </Callout>
      </Section>

      <Section id="crud-and-paths" title="عمليات CRUD والمحوّلات والتنسيق السلكي">
        <Code code={crud} lang="dart" />
        <H3 id="typed-models">نماذج مُنمّطة عبر withConverter</H3>
        <Code code={converter} lang="dart" />
        <H3 id="field-ops-and-wire-values">تحويلات الحقول والقيم الموسومة</H3>
        <Code code={fieldOps} lang="dart" />
      </Section>

      <Section id="queries-and-pagination" title="الاستعلام والتدفقات والتجميعات">
        <P>
          يدعم <code>Query&lt;T&gt;</code> بناء الاستعلامات غير القابلة للتعديل مع <code>where</code> و
          <code>or</code> و<code>select</code> و<code>include</code> و<code>orderBy</code> و
          <code>limit</code> و<code>startAfter</code>، بالإضافة إلى تدفقات الترقيم الصفحي{" "}
          <code>streamPages()</code> و<code>streamDocuments()</code>، والتجميعات <code>count()</code> و
          <code>sum()</code> و<code>avg()</code> و<code>aggregate()</code>، والحذف الشرطي{" "}
          <code>deleteWhere()</code>:
        </P>
        <Code code={query} lang="dart" />
      </Section>

      <Section id="realtime" title="تدفقات الوقت الفعلي (Streams)">
        <P>
          تعيد <code>DocumentReference.snapshots()</code> و<code>Query.snapshots()</code> تدفقات بث
          (Broadcast Streams) فوق اتصال WebSocket واحد يديره <code>VellumRealtimeTransport</code> بنبض كل
          25 ثانية، ومهلة 60 ثانية، وإعادة اتصال بتراجع عشوائي (<code>t0 = 500ms</code>،{" "}
          <code>tMax = 30s</code>) واستئناف تلقائي عبر <code>resumeSeqId</code>:
        </P>
        <Code code={realtime} lang="dart" />
      </Section>

      <Section id="batch-and-occ" title="الدفعات (VellumWriteBatch) ومعاملات OCC">
        <Code code={batchAndTx} lang="dart" />
      </Section>

      <Section id="end-user-auth" title="مصادقة المستخدمين النهائيين ومعالجة الأخطاء">
        <P>
          يربط <code>client.auth</code> جلسة المستخدم النهائي بطلبات REST وWebSocket تلقائياً، ويجدّد رمز{" "}
          <code>EdDSA</code> قبل 45 ثانية من انتهائه، ويعيد <code>VellumAuthResult</code> محكماً (إما{" "}
          <code>VellumSession</code> أو <code>VellumMfaRequired</code>):
        </P>
        <Code code={auth} lang="dart" />
        <H3 id="errors">الاستثناءات وإغلاق الموارد</H3>
        <Code code={errorCode} lang="dart" />
        <UL
          items={[
            <>استدعِ <code>client.dispose()</code> (أو <code>client.close()</code>) عند إنهاء التطبيق لإغلاق اتصال WebSocket وتدفقات المصادقة.</>,
            <>تنجح الحزمة في <code>dart analyze --fatal-infos --fatal-warnings</code> و<strong>48 اختبار وحدة</strong> و<strong>55/55 فحصاً حيّاً</strong> في <code>tests/dart-verify/</code>.</>,
          ]}
        />
        <P>
          راجع <PageLink slug="errors-and-limits" lang="ar">الحصص والحدود</PageLink>.
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
          حزمة <code>vellum_flutter</code> مبنية كمكتبة Dart نقية متوافقة مع الويب والموبايل وسطح
          المكتب (بدون أي استيراد لـ <code>dart:io</code>) ومقسّمة بوضوح عبر{" "}
          <code>lib/src/core/</code> و<code>lib/src/models/</code> و<code>lib/src/auth/</code>{" "}
          و<code>lib/src/realtime/</code> و<code>lib/src/client/</code>. تبقى الحالة الداخلية
          خاصة بالمكتبة (<code>_</code>) وغير قابلة للتلاعب من الخارج، وتُغلّف الخرائط والقوائم
          العامة بـ <code>Map.unmodifiable</code> و<code>List.unmodifiable</code> مع إخفاء تلقائي
          للمفاتيح والتوكنات في <code>toString()</code>.
        </P>
      </Section>
    </Doc>
  );
}
