import {
  autoIdTs, autoIdDart, authTs, authDart, secureStorageDart, cacheTs, cacheDart,
  relationsTs, relationsDart, realtimeTs,
} from "../../advanced-examples";
import { AlphaNotice, Callout, Code, CodeTabs, Doc, P, PageLink, Section, Table } from "../../ui";

export default function Page() {
  return (
    <Doc
      eyebrow="البداية"
      title="الإعدادات المتقدمة"
      description="كل ما في هذه الصفحة اختياري. يعمل البدء السريع بالإعدادات الافتراضية؛ ارجع إلى هنا عند الحاجة لضبط المعرفات أو المصادقة أو الكاش أو المراجع أو الوقت الفعلي."
    >
      <AlphaNotice lang="ar" />
      <Callout tone="info" title="الإعدادات الافتراضية أولاً">
        لا تحتاج إلى أي من هذه الإعدادات للبدء. لكل إعداد قيمة افتراضية آمنة وتعمل بالطريقة نفسها على كل
        المنصات المدعومة: Flutter على أندرويد وiOS والويب وسطح المكتب، وJavaScript في المتصفح وNode وبيئات
        edge وserverless وReact Native.
      </Callout>

      <Section id="auto-id" title="معرفات المستندات: doc() وadd()">
        <P>
          استدعِ <code>doc()</code> دون معرّف لتحصل على مرجع جديد بمعرّف من 20 حرفاً قابل للترتيب زمنياً.
          يُنشأ المعرّف على الجهاز، فلا يُرسل أي طلب حتى تكتب.
        </P>
        <CodeTabs tabs={[
          { label: "TypeScript", lang: "ts", code: autoIdTs },
          { label: "Flutter / Dart", lang: "dart", code: autoIdDart },
        ]} />
      </Section>

      <Section id="auth" title="المصادقة: التجديد التلقائي والرموز المخصصة">
        <P>
          تُجدَّد الجلسة قبل انتهائها بنحو 60 ثانية، ومرة أخرى إذا أعاد الطلب 401. الطلبات المتزامنة تشترك في
          تجديد واحد. استخدم <code>setCustomToken</code> لإرسال رمز من مزوّد الهوية الخاص بك، أو{" "}
          <code>autoRefresh: false</code> لتتولى التجديد بنفسك.
        </P>
        <CodeTabs tabs={[
          { label: "TypeScript", lang: "ts", code: authTs },
          { label: "Flutter / Dart", lang: "dart", code: authDart },
        ]} />
      </Section>

      <Section id="secure-storage" title="Flutter: تخزين الرموز الآمن (اختياري)">
        <P>
          يحتفظ عميل Flutter بالجلسة في الذاكرة افتراضياً، فلا شيء لتثبيته. إذا أردت بقاء الجلسة بعد إعادة
          تشغيل التطبيق داخل keychain أو keystore، أضف <code>flutter_secure_storage</code> إلى تطبيقك والصق
          هذا الصنف. يستخدم الواجهة الحالية <code>AuthTokenStorage</code>.
        </P>
        <Code lang="dart" title="SecureAuthTokenStorage" code={secureStorageDart} />
      </Section>

      <Section id="cache" title="سياسة الكاش">
        <P>اختر كيف تستخدم القراءات المخزن المحلي. الافتراضي هو <code>networkFirst</code>.</P>
        <Table
          head={["السياسة", "السلوك"]}
          rows={[
            [<code>networkFirst</code>, "اجلب من الشبكة، وإن كان الجهاز دون اتصال أعد النسخة المخزنة (بعلامة fromCache)."],
            [<code>cacheFirst</code>, "أعد نسخة مخزنة حديثة (افتراضياً 5 دقائق) وإلا اجلب من الشبكة."],
            [<code>networkOnly</code>, "لا تقرأ من المخزن أبداً."],
            [<code>cacheOnly</code>, "من المخزن فقط. الإخفاق يعيد مستنداً غير موجود."],
          ]}
        />
        <CodeTabs tabs={[
          { label: "TypeScript", lang: "ts", code: cacheTs },
          { label: "Flutter / Dart", lang: "dart", code: cacheDart },
        ]} />
        <Callout tone="info" title="أين تُخزَّن البيانات">
          يستخدم JavaScript قاعدة IndexedDB في المتصفح ومخزناً محدوداً في الذاكرة في غيره (Node وedge
          وReact Native). يستخدم Flutter مخزناً محدوداً في الذاكرة على كل المنصات، والحفظ على القرص اختياري
          بتنفيذ <code>DocumentCacheStore</code>.
        </Callout>
      </Section>

      <Section id="references" title="المراجع والكتابة المترابطة">
        <P>
          ضع مرجع مستند مباشرة في بياناتك. ولإنشاء مستند أب وأبنائه معاً استخدم <code>addWithRelated</code>:
          طلب ذري واحد، إما أن ينجح كله أو لا يُكتب شيء، حتى 500 مستند. راجع{" "}
          <PageLink slug="relationships" lang="ar">العلاقات</PageLink> لقراءة المستندات المرتبطة.
        </P>
        <CodeTabs tabs={[
          { label: "TypeScript", lang: "ts", code: relationsTs },
          { label: "Flutter / Dart", lang: "dart", code: relationsDart },
        ]} />
      </Section>

      <Section id="realtime-transport" title="نقل الوقت الفعلي">
        <P>
          تفتح الحزمتان WebSocket افتراضياً. إذا تعذّر استخدامه، مثل الاستضافات التي لا تدعم الترقية، تنتقلان
          تلقائياً إلى بث HTTP (SSE) مع الحفاظ على المستمعين وموضع الاستئناف. يمكنك تثبيت وسيلة واحدة عند الحاجة.
          راجع <PageLink slug="realtime" lang="ar">الوقت الفعلي</PageLink>.
        </P>
        <Code lang="ts" title="TypeScript" code={realtimeTs} />
        <Code lang="dart" title="Flutter / Dart" code={`final db = VellumClient(
  endpoint: 'https://api.example.com', projectId: 'PROJECT_ID', apiKey: 'API_KEY',
  realtimeMode: VellumRealtimeMode.auto, // or .websocket / .sse
);`} />
      </Section>
    </Doc>
  );
}
