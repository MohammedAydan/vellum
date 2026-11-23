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
  UL,
} from "../../../ui";

export default function Page() {
  return (
    <Doc
      title="بروتوكول WebSocket للوقت الفعلي"
      description="الإطارات المعيارية، ومصافحة المصادقة، والاشتراك والاستئناف، والعلامات المائية وكشف الفجوات عبر اتصال واحد."
      eyebrow="المرجع"
    >
      <Section id="overview" title="نظرة عامة">
        <P>
          يتصل العملاء بنقطة النهاية <code>wss://&lt;host&gt;/v1/realtime</code> (
          <code>ws://</code> في التطوير المحلي)، ويُوجَّهون جميع اشتراكاتهم عبر اتصال
          WebSocket واحد. البروتوكول نصّي: كل إطار رسالة JSON كائنٌ ذو حقل <code>type</code>
          يُميّز نوعه، ويجب التحقق من كل إطار قادم قبل معالجته وفق مخططات{" "}
          <code>@vellum/api-contract</code>.
        </P>
        <P>
          PostgreSQL هو الخدمة الوحيدة ذات الحالة. تُكتب كل عملية تعديل ملتزمة صفًّا في{" "}
          <code>realtime_outbox</code> داخل المعاملة نفسها، بقيمة <code>seq_id</code> متزايدة
          رتيبة. يُصدر مُحفّز <code>AFTER INSERT</code> إشعار <code>NOTIFY</code> على القناة{" "}
          <code>vellum_outbox</code> يحمل معرّف التسلسل والمستأجر فقط؛ فيستيقظ مستمع{" "}
          <code>LISTEN</code> مخصص، ثم يجلب المُستقصي الصفوف الكاملة عبر مُهايئ التخزين المقيد
          بالمستأجر ويعيد بثّها. تعمل حلقة استقصاء عادية أيضًا، فلا تُفقد الأحداث حتى عند تعذّر{" "}
          <code>LISTEN</code>. لا يوجد Redis ولا وسيط خارجي.
        </P>
        <Callout tone="info" title="الإشعار تنبيه لا بيانات">
          تحدّد PostgreSQL حمولة <code>NOTIFY</code> بـ 7,999 بايت، لذا لا تُرسل بيانات
          المستندات أبدًا داخل الإشعار. الصف الدائم في <code>realtime_outbox</code> هو مصدر
          الحقيقة؛ ويمنع الاستبعاد حسب <code>seqId</code> تسليم الصف الواحد أكثر من مرة عند
          التقاء <code>NOTIFY</code> والاستقصاء.
        </Callout>
        <P>
          على مستوى النقل: تُقبل الوصلة من مصادر <code>Origin</code> المسموح بها في{" "}
          <code>CORS_ALLOWED_ORIGINS</code> فقط، ويجب إرسال إطار المصادقة خلال 5 ثوانٍ، وتعمل
          نبضة قلب <code>ping/pong</code> كل 30 ثانية مع مهلة خمول 30 ثانية، ويُحدّد عدد
          الوصلات بـ 50 لكل عنوان IP، وبـ 1 MiB لكل إطار.
        </P>
      </Section>

      <Section id="handshake" title="مصافحة المصادقة">
        <P>
          يجب أن يكون أول إطار يرسله العميل من نوع <code>auth</code>. يتحقق الخادم من أن
          مفتاح API ينتمي فعلًا إلى المشروع المطلوب، ومن الرمز الاختياري
          <code>authToken</code> بمفتاح Ed25519 العام للمشروع — بتوقيع EdDSA فقط، وبدون أي
          بديل HS256. يُرفض الرمز المنتهي بـ <code>TOKEN_EXPIRED</code>، ويُرفض الرمز غير
          الصالح بـ <code>UNAUTHENTICATED</code> دون إعادة أي تفاصيل عن آلية التحقق.
        </P>
        <Steps
          items={[
            {
              title: "ترقية الاتصال",
              body: <P>استجابة ناجحة تعني <code>101 Switching Protocols</code> على المسار <code>/v1/realtime</code>. يُرفض origin غير مسموح بـ 403، وتجاوز 50 وصلة/IP بـ 429، وأي مسار آخر بـ 404.</P>,
            },
            {
              title: "إرسال إطار auth",
              body: <P>يشمل <code>projectId</code> و<code>apiKey</code> بمعرفة <code>pk_</code> أو <code>sk_</code>، واختياريًا <code>authToken</code> للمستخدم النهائي.</P>,
            },
            {
              title: "التحقق وإصدار التأكيد",
              body: <P>ينتج عن النجاح إطار <code>auth_ack</code> يحمل <code>status: "authenticated"</code> ومعرّف <code>connectionId</code>. قبل المصادقة تُرفض كل الإطارات الأخرى بـ <code>UNAUTHENTICATED</code>.</P>,
            },
            {
              title: "مهلة المصادقة",
              body: <P>إن لم تصل المصادقة خلال 5,000 ميلي ثانية يرسل الخادم خطأ <code>UNAUTHENTICATED</code> ويغلق الوصلة برمز الإغلاق 1008.</P>,
            },
          ]}
        />
        <CodeTabs
          tabs={[
            {
              label: "العميل → الخادم",
              lang: "json",
              title: "auth",
              code: `{
  "type": "auth",
  "projectId": "prj_01JCK9X2P8...",
  "apiKey": "pk_...",
  "authToken": "eyJhbGciOiJFZERTQS..."
}`,
            },
            {
              label: "الخادم → العميل",
              lang: "json",
              title: "auth_ack",
              code: `{
  "type": "auth_ack",
  "status": "authenticated",
  "connectionId": "conn_9f3a1c02bd41e7a5"
}`,
            },
            {
              label: "خطأ المصادقة",
              lang: "json",
              title: "error",
              code: `{
  "type": "error",
  "subId": "connection",
  "code": "UNAUTHENTICATED",
  "message": "Authentication timeout"
}`,
            },
          ]}
        />
        <Callout tone="danger" title="أسرار المصادقة">
          لا تكتب مفاتيح API أو رموز Bearer في السجلات أو رسائل الخطأ. تُمرَّر كل السجلات عبر
          مرشّحات الإخفاء في <code>@vellum/observability</code>؛ ويكفي <code>requestId</code>
          لربط أي حادثة بأمان.
        </Callout>
      </Section>

      <Section id="frames" title="إطارات العميل والخادم">
        <H3 id="client-frames">إطارات العميل</H3>
        <Table
          head={["الإطار", "الحقول", "الغرض"]}
          rows={[
            [<><code>auth</code></>, <><code>projectId</code>، <code>apiKey</code>، <code>authToken?</code></>, "أول إطار إلزامي؛ يُرسل مرة واحدة بعد الاتصال."],
            [<><code>subscribe</code></>, <><code>subId</code>، و<code>path</code> أو <code>query</code>، و<code>resumeSeqId?</code>، و<code>resolveIncludes?</code> (قيمة منطقية)، و<code>include?</code> (IncludeSpec[] بحد أقصى 10)</>, <>إنشاء اشتراك؛ يجب تقديم <code>path</code> أو <code>query</code> أحدهما على الأقل. و<code>resolveIncludes</code> يفعّل ترطيب العلاقات: تؤخذ المواصفات من <code>include</code> أو من <code>query.include</code> احتياطيًا، وبعمق واحد فقط.</>],
            [<><code>unsubscribe</code></>, <><code>subId</code></>, "إلغاء الاشتراك وإزالته من سجل الوصلة."],
            [<><code>ping</code></>, <><code>ts</code> (رقم)</>, <>نبضة قلب؛ يقابلها الإطار <code>pong</code>.</>],
          ]}
        />
        <H3 id="server-frames">إطارات الخادم</H3>
        <Table
          head={["الإطار", "الحقول", "المعنى"]}
          rows={[
            [<><code>auth_ack</code></>, <><code>status</code>، <code>connectionId</code></>, "نجاح المصادقة."],
            [<><code>initial_sync</code></>, <><code>subId</code>، <code>seqId</code> (رقم)، <code>documents[]</code></>, "اللقطة الحالية الكاملة مع علامة مائية ابتدائية."],
            [<><code>mutation</code></>, <><code>subId</code>، <code>seqId</code> (رقم)، <code>operation</code>، <code>document</code></>, <>تغيير ملتزم؛ العملية <code>create</code> أو <code>update</code> أو <code>delete</code>.</>],
            [<><code>resume_complete</code></>, <><code>subId</code>، <code>seqId</code> (نص)، <code>count</code>، <code>truncated</code></>, "انتهاء إعادة تشغيل أحداث الاستئناف."],
            [<><code>pong</code></>, <><code>ts</code>، <code>serverTs</code></>, "ردّ نبضة القلب مع طابع الخادم."],
            [<><code>error</code></>, <><code>code</code>، <code>message</code>، <code>subId?</code></>, "خطأ في الوصلة أو في اشتراك محدد."],
          ]}
        />
        <P>
          حقل <code>document</code> في إطارَي <code>initial_sync</code> و<code>mutation</code>
          يحمل الشكل المعياري: <code>path</code>، <code>collectionPath</code>،{" "}
          <code>collectionGroup</code>، <code>documentId</code>، <code>data</code>،{" "}
          <code>version</code>، <code>createdAt</code>، <code>updatedAt</code>. وتُرسل بيانات
          {" "}<code>data</code> ذاتها بتنسيق الإرسال الموسوم الموضح في{" "}
          <PageLink slug="reference/wire-format" lang="ar">تنسيق الإرسال والمسارات</PageLink>.
        </P>
        <P>
          عند تفعيل <code>resolveIncludes</code> يحمل كل حمولة مُسلَّمة حقلَين إضافيَّين:{" "}
          <code>_included</code> (خريطة من مسار المرجع إلى حمولة الهدف المرطَّبة) و{" "}
          <code>_redactedRefs</code> (مسارات مراجع حُجبت لأن المفتاح لا يحق له قراءة الهدف).
          الترطيب لقطة زمنية لحظة معالجة الحدث: تعديل الهدف وحده لا يعيد تشغيل الأب،
          والآباء المحذوفون أو المُزالون لا يُرطَّبون. أكثر من 10 مواصفات أو تداخل أعمق
          يفشل بـ <code>INVALID_ARGUMENT</code>، وأكثر من 1000 مسار مرجعي فريد في الحدث الواحد
          يفشل بـ <code>RESPONSE_TOO_LARGE</code>. راجع{" "}
          <PageLink slug="realtime" lang="ar">الوقت الحقيقي</PageLink> للعقد الكامل.
        </P>
        <CodeTabs
          tabs={[
            {
              label: "اشتراك بمسار",
              lang: "json",
              title: "subscribe / path",
              code: `{
  "type": "subscribe",
  "subId": "user-1",
  "path": "users/u_123"
}`,
            },
            {
              label: "اشتراك باستعلام",
              lang: "json",
              title: "subscribe / query",
              code: `{
  "type": "subscribe",
  "subId": "orders-1",
  "query": {
    "collectionPath": "orders",
    "where": [{ "field": "status", "op": "==", "value": "open" }],
    "orderBy": [{ "field": "createdAt", "direction": "desc" }],
    "limit": 50
  }
}`,
            },
            {
              label: "استئناف",
              lang: "json",
              title: "subscribe / resumeSeqId",
              code: `{
  "type": "subscribe",
  "subId": "orders-1",
  "path": "orders/ord_456",
  "resumeSeqId": 184203
}`,
            },
            {
              label: "إلغاء ونبضة",
              lang: "json",
              title: "unsubscribe / ping",
              code: `{ "type": "unsubscribe", "subId": "orders-1" }
{ "type": "ping", "ts": 1794753000123 }`,
            },
          ]}
        />
        <Code
          lang="json"
          title="mutation"
          code={`{
  "type": "mutation",
  "subId": "orders-1",
  "seqId": 184204,
  "operation": "update",
  "document": {
    "path": "orders/ord_456",
    "collectionPath": "orders",
    "collectionGroup": "orders",
    "documentId": "ord_456",
    "data": { "status": { "$t": "ts", "$v": "2026-11-18T10:00:00.000Z", "$ms": 1794991200000 } },
    "version": 7,
    "createdAt": "2026-11-18T09:00:00.000Z",
    "updatedAt": "2026-11-18T10:00:00.000Z"
  }
}`}
        />
      </Section>

      <Section id="subscriptions" title="الاشتراكات والتحديثات المباشرة">
        <P>
          ينشئ الاشتراك بمسار مستند معرّف <code>subId</code> ويُخضع للتحقق نفسه الذي تخضع له
          قراءة HTTP: تُحلَّل القواعد النحاسية للمسار عبر <code>parseDocumentPath</code>، ثم
          تُقيَّم قواعد الأمان بعملية <code>get</code>. يُرسل الخادم فورًا{" "}
          <code>initial_sync</code> بالمستند الحالي — أو قائمة فارغة إن لم يكن موجودًا — ومعها
          العلامة المائية الحالية. ولا تُرسل بعدها إلا التغييرات التي يطابق مسارها المسار
          المطلوب تمامًا.
        </P>
        <P>
          أمّا الاشتراك باستعلام فيُعتمد بعملية <code>list</code> على مجموعة المستندات، وتُطبَّق
          عليه قواعد التصفية والترتيب والحد ذاتها المطبقة على استعلام HTTP. تتغير حالة المطابقة
          مع كل حدث: يولّد ظهور مستند جديد مطابق عملية <code>create</code>، وتولّد مطابقة مستند
          كان مطابقًا فعلًا عملية <code>update</code>، ويولّد خروجه من مجموعة النتائج عملية{" "}
          <code>delete</code>. يُحدَّد عدد مستندات اللقطة الأولية بحدّ الاستعلام <code>limit</code>.
        </P>
        <UL
          items={[
            <P>يُحذف الاشتراك بإطار <code>unsubscribe</code> دون إطار تأكيد؛ ويُزال من سجل الوصلة فورًا.</P>,
            <P>تُحتسب كل رسالة <code>mutation</code> في عدّاد <code>realtimeMessagesSent</code> الخاص بالمشروع.</P>,
            <P>ردّ <code>ping</code> يحمل الوسم نفسه <code>ts</code> إضافةً إلى <code>serverTs</code> بالوقت الحالي؛ وإطار <code>error</code> المتعلق بالوصلة يحمل <code>subId: "connection"</code>.</P>,
            <P>تُرفض الاشتراكات الجديدة بعد تجاوز 50 اشتراكًا نشطًا على الوصلة بخطأ <code>SUBSCRIPTION_LIMIT_EXCEEDED</code> مرفق بـ <code>subId</code> الطالب.</P>,
          ]}
        />
        <Callout tone="warning" title="القواعد تطبَّق على الاشتراك نفسه">
          لا يكفي مفتاح API صالحًا: تُقيَّم قواعد الأمان مرة عند إنشاء الاشتراك، سواء أكان
          <code>get</code> لمسار مستند أم <code>list</code> لاستعلام مجموعة. رفض القاعدة يمنع
          إنشاء الاشتراك ويُعاد إطار <code>error</code> بالرمز المناسب.
        </Callout>
      </Section>

      <Section id="resume" title="الاستئناف والعلامات المائية وكشف الفجوات">
        <P>
          يحتفظ صندوق <code>realtime_outbox</code> بالأحداث 24 ساعة. عند إرسال{" "}
          <code>resumeSeqId</code> ضمن هذه النافذة يُسجَّل الاشتراك أولًا، ثم تُعاد الأحداث التي
          تلي هذا الموضع بترتيب تسلسلي صارم قبل العودة إلى البث الحي. يُرسل الخادم عند انتهاء
          إعادة التشغيل إطار <code>resume_complete</code> الذي يُعلن الحد الفاصل.
        </P>
        <Code
          lang="json"
          title="resume_complete"
          code={`{
  "type": "resume_complete",
  "subId": "orders-1",
  "seqId": "184203",
  "count": 37,
  "truncated": false
}`}
        />
        <UL
          items={[
            <P><code>count</code> عدد الأحداث المعاد تشغيلها، و<code>seqId</code> آخر تسلسل سُلِّم (نص لاشكال BigInt)، و<code>truncated: true</code> يعني بلوغ سقف 5,000 حدث لكل استئناف.</P>,
            <P>الأحداث الحية التي تصل أثناء إعادة التشغيل تُؤجَّل خلف حاجز <code>replaying</code>، ثم تُفرَّغ بترتيب تصاعدي بعد إطار <code>resume_complete</code>، فلا يسبق حديثٌ أقدمه.</P>,
            <P>الاستبعاد لكل اشتراك <code>seenSeqIds</code> يسقط التكرارات التي قد تظهر من <code>NOTIFY</code> والاستقصاء معًا، ويُحتفظ بآخر 10,000 معرّف.</P>,
            <P>العلامة المائية لكل مستأجر <code>projectId</code> متزايدة رتيبة؛ وأي <code>seq_id</code> أقل من العلامة أو مساوٍ لها لا يُسلَّم مجددًا.</P>,
          ]}
        />
        <P>
          يكتشف مُستقصي الصندوق الفجوة حين يصل إشعار بتسلسل أكبر من العلامة بأكثر من واحد
          (<code>incoming &gt; watermark + 1</code>)؛ فيسحب الصفوف المفقودة من الصندوق الدائم على
          دفعات من 500 صف، ويُسجّل الحدث في عدّاد الفجوات. ويكرر الاستقصاء كل ثانية كمسار احتياطي
          مع تراجع أُسّي عند الأخطاء (250 ms أساسًا و10 ثوانٍ سقفًا). الرسالة الواحدة تُسلَّم مرة
          واحدة على حدّ الاشتراك.
        </P>
        <Callout tone="warning" title="متى يُقطع الاستئناف">
          إذا ظهر <code>truncated: true</code> فابدأ من آخر <code>seqId</code> المستلم في استئناف
          جديد، أو اطلب لقطة كاملة بإطار <code>subscribe</code> دون <code>resumeSeqId</code>.
          والأحداث الأقدم من 24 ساعة تكون قد أُزيلت ولا يمكن استرجاعها.
        </Callout>
        <P>
          للاستخدام من SDK راجع{" "}
          <PageLink slug="realtime" lang="ar">الوقت الفعلي</PageLink>، ولرموز الأخطاء راجع{" "}
          <PageLink slug="reference/errors" lang="ar">رموز الأخطاء وإرشادات إعادة المحاولة</PageLink>.
        </P>
      </Section>

      <Section id="limits" title="الحدود وأخطاء الاتصال">
        <Table
          head={["الحد", "القيمة", "التجاوز"]}
          rows={[
            [<><code>MAX_WS_SUBSCRIPTIONS_PER_CONN</code></>, "50 اشتراكًا", <><code>SUBSCRIPTION_LIMIT_EXCEEDED</code> (400)</>],
            [<><code>MAX_WS_OUTBOUND_BUFFER_BYTES</code></>, "1,048,576 بايت (1 MiB)", <><code>SLOW_CONSUMER_DISCONNECT</code> (429) وإغلاق 1008</>],
            ["حجم إطار WebSocket واحد", "1,048,576 بايت (1 MiB)", <><code>PAYLOAD_TOO_LARGE</code> (413) وإغلاق 1009</>],
            ["مهلة إطار المصادقة", "5,000 ميلي ثانية", <><code>UNAUTHENTICATED</code> (401) وإغلاق 1008</>],
            ["نبضة القلب / مهلة الخمول", "30,000 / 30,000 ميلي ثانية", "إغلاق الوصلة برمز 1000"],
            ["الوصلات لكل عنوان IP", "50 وصلة", "رفض ترقية الاتصال بـ HTTP 429"],
            ["سقف إعادة التشغيل لكل استئناف", "5,000 حدث", <><code>resume_complete.truncated = true</code></>],
            ["الاحتفاظ بصفوف الصندوق", "24 ساعة", "لا يمكن استئناف الأحداث الأقدم"],
            ["حمولة NOTIFY", "7,999 بايت", "قيد على مستوى PostgreSQL؛ الإشعار بلا بيانات مستند"],
          ]}
        />
        <P>
          خطأ الاشتراك يُرسل داخل إطار <code>error</code> حاملًا <code>subId</code>، بينما يحمل
          خطأ الوصلة <code>subId: "connection"</code> أو يُرسل دون <code>subId</code>. المستهلك
          البطيء يُفصل بدل السماح بنمو الذاكرة بلا حدود، لذا يجب إبقاء دوال الاستقبال خفيفة
          ونقل العمل الثقيل إلى قائمة انتظار في التطبيق.
        </P>
        <P>
          الحدود الكاملة للإصدار 1 مُدرجة في{" "}
          <PageLink slug="errors-and-limits" lang="ar">الحصص والحدود</PageLink>.
        </P>
      </Section>
    </Doc>
  );
}
