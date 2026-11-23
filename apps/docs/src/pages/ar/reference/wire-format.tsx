import {
  Callout,
  Code,
  CodeTabs,
  Doc,
  P,
  PageLink,
  Section,
  Table,
  UL,
} from "../../../ui";

export default function Page() {
  return (
    <Doc
      title="تنسيق الإرسال والمسارات"
      description="الأنواع الموسومة $t/$v، وتحويلات $op، وقواعد المسارات والحدود الثابتة للإصدار 1."
      eyebrow="المرجع"
    >
      <Section id="overview" title="نظرة عامة">
        <P>
          يستخدم VELLUM تنسيق إرسال موسومًا (Canonical Tagged Wire Format v1) من{" "}
          <code>@vellum/core</code> للحفاظ على الأنواع الغنية عبر JSON فوق HTTP وWebSocket وداخل{" "}
          <code>JSONB</code> في PostgreSQL، دون تضارب مع خرائط يعرّفها المستخدم. تُخزَّن
          البدائيات القياسية — <code>null</code> والقيم المنطقية والسلاسل والأعداد المنتهية
          والمصفوفات — كقيم JSON أصلية، لتتمكن فهارس <code>jsonb_path_ops</code> GIN من فهرستها
          بلا غلاف إضافي.
        </P>
        <P>
          أمّا الأنواع الموسّعة فتُغلَّف بمفتاح محجوز هو <code>$t</code> (اسم النوع) ومفتاح
          القيمة <code>$v</code>. أي كائن المستخدم يحمل مفتاح <code>$t</code> حرفيًا يُغلَّف
          تلقائيًا بـ <code>$t: "map"</code> في عملية التطبيع، فيبقى النقل عكوسًا بلا فقدان.
          ولا يوجد أي تقييم ديناميكي للشيفرات: تُرشَّح الأنواع وتُتحقق قيمها وفق قواعد ثابتة
          قبل التخزين.
        </P>
        <Callout tone="info" title="حيث يُطبَّق التنسيق">
          تُطبَّق القواعد الواردة هنا على حدود محرّك المستندات: عند الكتابة، وفي الدفعات
          والمعاملات، وفي إطارات الوقت الفعلي. أي قيمة غير صالحة تُنتج <code>VellumError</code>
          برمز <code>INVALID_ARGUMENT</code> عدا حدود المسارات والتداخل المذكورة في نهاية الصفحة.
        </Callout>
      </Section>

      <Section id="tagged-types" title="الأنواع الموسومة $t/$v">
        <Table
          head={["النوع المنطقي", "التمثيل على السلك / JSONB", "قاعدة التحقق"]}
          rows={[
            [<><code>null</code></>, <><code>null</code></>, "قيمة JSON أصلية."],
            [<><code>boolean</code></>, <><code>true</code> / <code>false</code></>, "قيمة JSON منطقية أصلية."],
            [<><code>string</code></>, <><code>"hello"</code></>, "سلسلة UTF-8 صالحة."],
            [<><code>number</code> (double)</>, <><code>42</code> أو <code>3.14159</code></>, <>عدد IEEE-754 نهائي؛ تُرفض <code>NaN</code> و<code>Infinity</code> و<code>-Infinity</code>.</>],
            [<><code>int64</code></>, <><code>{"{\"$t\": \"int\", \"$v\": \"-9007199254740993\"}"}</code></>, <>سلسلة عشرية صحيحة داخل المدى <code>[-2^63, 2^63-1]</code>.</>],
            [<><code>timestamp</code></>, <><code>{"{\"$t\": \"ts\", \"$v\": \"2026-11-15T14:30:00.123Z\", \"$ms\": 1794753000123}"}</code></>, <>ساعة ISO-8601 UTC صالحة مع <code>$ms</code> نهائي بالمللي ثانية؛ تُطبَّع دائمًا لتحمل <code>$ms</code>.</>],
            [<><code>reference</code></>, <><code>{"{\"$t\": \"ref\", \"$v\": \"users/u_123\"}"}</code></>, "مسار مستند قياسي داخل المشروع نفسه."],
            [<><code>bytes</code></>, <><code>{"{\"$t\": \"bytes\", \"$v\": \"SGVsbG8=\"}"}</code></>, "سلسلة Base64 قياسية صالحة."],
            [<><code>geopoint</code></>, <><code>{"{\"$t\": \"geo\", \"$v\": {\"lat\": 30.0444, \"lng\": 31.2357}}"}</code></>, <><code>lat</code> نهائي في <code>[-90, 90]</code> و<code>lng</code> نهائي في <code>[-180, 180]</code>.</>],
            [<><code>array</code></>, <><code>[ ... ]</code></>, "مصفوفة JSON حتى عمق تداخل 20."],
            [<><code>map</code></>, <><code>{"{\"key\": \"value\"}"}</code></>, <>كائن JSON عادي لا يحمل المفتاح <code>$t</code>.</>],
            [<><code>Escaped User Map</code></>, <><code>{"{\"$t\": \"map\", \"$v\": {\"$t\": \"user_custom\"}}"}</code></>, <>غلاف عكوس عند احتواء كائن المستخدم على المفتاح <code>$t</code> حرفيًا.</>],
          ]}
        />
        <CodeTabs
          tabs={[
            {
              label: "مستند على السلك",
              lang: "json",
              title: "tagged wire format",
              code: `{
  "title": "Order #456",
  "paid": true,
  "amountMicros": { "$t": "int", "$v": "9007199254740993" },
  "createdAt": { "$t": "ts", "$v": "2026-11-15T14:30:00.123Z", "$ms": 1763217000123 },
  "customer": { "$t": "ref", "$v": "users/u_123" },
  "receipt": { "$t": "bytes", "$v": "SGVsbG8=" },
  "location": { "$t": "geo", "$v": { "lat": 30.0444, "lng": 31.2357 } },
  "tags": ["priority", "eu"],
  "meta": { "$t": "map", "$v": { "$t": "user_custom", "source": "import" } }
}`,
            },
            {
              label: "منشئات @vellum/core",
              lang: "ts",
              title: "WireValue",
              code: `import { WireValue } from "@vellum/core";

const data = {
  amountMicros: WireValue.int64("9007199254740993"),
  createdAt: WireValue.timestamp("2026-11-15T14:30:00.123Z"),
  customer: WireValue.reference("users/u_123"),
  receipt: WireValue.bytes(new Uint8Array([72, 101, 108, 108, 111])),
  location: WireValue.geopoint(30.0444, 31.2357),
  meta: WireValue.escapeMap({ $t: "user_custom", source: "import" }),
};`,
            },
          ]}
        />
        <P>
          يجب أن تكون بيانات المستند العلوية كائنًا عاديًا؛ ووجود <code>$t</code> أو{" "}
          <code>$op</code> في الجذر يُرفض بخطأ <code>INVALID_ARGUMENT</code>. وتُعاد كتابة
          الطوابع الزمنية في التطبيع إلى صيغة ISO-8601 موحّدة مع <code>$ms</code> محسوب من
          التاريخ، فتكون القيمة المخزَّنة حتمية بغض النظر عن التمثيل الذي أرسله العميل.
        </P>
      </Section>

      <Section id="field-ops" title="تحويلات الحقول $op">
        <P>
          التحويلات الذرية معرّفة بواسطة حقل <code>$op</code>، ولا تُقبل إلا في سياقات التحديث
          التي تسمح صراحةً بتحويلات الحقول (<code>update</code>، <code>batchWrite</code>،
          المعاملات). إرسال <code>$op</code> في سياق آخر يُنتج <code>INVALID_ARGUMENT</code>،
          وكذلك أي اسم عملية مجهول أو معامل مفقود.
        </P>
        <Table
          head={["الرمز $op", "المعاملات", "الدلالة"]}
          rows={[
            [<><code>serverTimestamp</code></>, "—", "يُعيَّن الحقل إلى طابع وقت الخادم لحظة الالتزام."],
            [<><code>deleteField</code></>, "—", "يحذف الحقل من المستند."],
            [<><code>inc</code> (أو <code>increment</code>)</>, <><code>by</code> أو <code>value</code> عدد نهائي</>, "يزيد القيمة العددية الحالية بمقدار محدد."],
            [<><code>arrayUnion</code></>, <><code>elements: unknown[]</code></>, "يضيف عناصر إلى مصفوفة دون تكرار."],
            [<><code>arrayRemove</code></>, <><code>elements: unknown[]</code></>, "يزيل العناصر المطابقة من المصفوفة."],
          ]}
        />
        <Code
          lang="json"
          title="تحديث ذري مركّب"
          code={`{
  "viewCount": { "$op": "inc", "by": 1 },
  "lastSeen": { "$op": "serverTimestamp" },
  "legacyField": { "$op": "deleteField" },
  "tags": { "$op": "arrayUnion", "elements": ["vip", "eu"] },
  "blocked": { "$op": "arrayRemove", "elements": ["spam"] }
}`}
        />
        <UL
          items={[
            <P>تُتحقَّق عناصر <code>elements</code> بشكل متكرر كقيم سلكية، ولا يُسمح بتحويلات <code>$op</code> داخلها.</P>,
            <P>يجب أن يكون معامل <code>inc</code> عددًا نهائيًا؛ وغيابه أو كونه عددًا غير نهائي يُرفض.</P>,
            <P>تُطبَّق التحويلات بالترتيب الذي تظهر به ضمن العملية الواحدة، وبشكل ذري مع بقية التعديلات.</P>,
          ]}
        />
      </Section>

      <Section id="paths" title="قواعد المسارات القياسية">
        <P>
          يُعنَّون كل مورد في مستوى بيانات المستندات بمسار UTF-8 مقسوم بشرطة مائلة{" "}
          <code>/</code>. مسار المستند يحتوي عددًا زوجيًا من المقاطع بين 2 و10 (أي حتى خمسة
          مستويات من المجموعات المتداخلة)، ومسار المجموعة يحتوي عددًا فرديًا بين 1 و9. لا
          تُسمح الشرطة المائلة في الطرفين، ولا المقاطع الفارغة.
        </P>
        <Table
          head={["قيد المقطع", "القيمة", "النتيجة عند المخالفة"]}
          rows={[
            ["الطول الأقصى", "1,500 بايت UTF-8", <><code>INVALID_DOCUMENT_PATH</code> (400)</>],
            ["المقاطع المحجوزة", <><code>.</code> و<code>..</code> و<code>%2e%2e</code> و<code>%2f</code></>, <><code>INVALID_DOCUMENT_PATH</code> (400)</>],
            ["البادئة/اللاحقة المحجوزة", <>أي مقطع يطابق <code>^__.*__$</code> مثل <code>__name__</code></>, <><code>INVALID_DOCUMENT_PATH</code> (400)</>],
            ["أحرف التحكم", <><code>0x00</code>–<code>0x1F</code> بما فيها البايت الصفري</>, <><code>INVALID_DOCUMENT_PATH</code> (400)</>],
            ["عدد المقاطع", "مستند: زوجي 2–10؛ مجموعة: فردي 1–9", <><code>INVALID_DOCUMENT_PATH</code> (400)</>],
          ]}
        />
        <Code
          lang="ts"
          title="تحليل مسار إلى مكوّناته"
          code={`import { parseDocumentPath } from "@vellum/core";

parseDocumentPath("users/u_123/orders/ord_456");
// {
//   path: "users/u_123/orders/ord_456",
//   collectionPath: "users/u_123/orders",
//   collectionGroup: "orders",
//   documentId: "ord_456",
//   pathDepth: 4,
//   segments: ["users", "u_123", "orders", "ord_456"]
// }`}
        />
        <P>
          أمثلة مقبولة: <code>users/u_123</code> بعمق 2، و
          <code>users/u_123/orders/ord_456</code> بعمق 4، و
          <code>c1/d1/c2/d2/c3/d3/c4/d4/c5/d5</code> بعمق 10. ومن أمثلة المجموعات:{" "}
          <code>users</code> و<code>users/u_123/orders</code>. أمّا المرجع الموسوم{" "}
          <code>$t: "ref"</code> فيُتحقق من مساره بالقواعد نفسها، ويجب أن يشير إلى مستند داخل
          المشروع نفسه.
        </P>
      </Section>

      <Section id="limits" title="الحدود المرتبطة بالتنسيق">
        <Table
          head={["الثابت في @vellum/core", "القيمة", "الخطأ عند التجاوز"]}
          rows={[
            [<><code>MAX_OBJECT_NESTING_DEPTH</code></>, <>20 مستوى داخل <code>data</code></>, <><code>MAX_NESTING_EXCEEDED</code> (400)</>],
            [<><code>MAX_FIELD_NAME_LENGTH</code></>, "256 حرفًا، غير فارٍ وبدون أحرف تحكم", <><code>INVALID_FIELD_NAME</code> (400)</>],
            [<><code>MAX_DOCUMENT_BYTES</code></>, "1,048,576 بايت (1 MiB) بعد التطبيع", <><code>DOCUMENT_TOO_LARGE</code> (413)</>],
            [<><code>MAX_PATH_DEPTH</code></>, "10 مقاطع", <><code>INVALID_DOCUMENT_PATH</code> (400)</>],
            [<><code>MAX_PATH_SEGMENT_BYTES</code></>, "1,500 بايت", <><code>INVALID_DOCUMENT_PATH</code> (400)</>],
            ["الأعداد غير النهائية", <><code>NaN</code> و<code>Infinity</code> مرفوضة</>, <><code>INVALID_ARGUMENT</code> (400)</>],
          ]}
        />
        <Callout tone="warning" title="القياس بعد التطبيع">
          يُقاس حجم المستند على النص JSON الناتج بعد تطبيع الطوابع الزمنية وإضافة{" "}
          <code>$ms</code>، لا على حمولة العميل الخام. احسب هامشًا للغلاف الموسوم عند الاقتراب
          من 1 MiB.
        </Callout>
        <P>
          للقائمة الكاملة بالحصص الثابتة راجع{" "}
          <PageLink slug="errors-and-limits" lang="ar">الحصص والحدود</PageLink>، ولخدمات
          إعادة المحاولة وأشكال أخطاء الواجهة راجع{" "}
          <PageLink slug="reference/errors" lang="ar">رموز الأخطاء وإرشادات إعادة المحاولة</PageLink>.
        </P>
      </Section>
    </Doc>
  );
}
