---
title: بروتوكول WebSocket للوقت الفعلي
order: 3
group: المرجع
description: الإطارات المعيارية للعميل/الخادم، مصافحة المصادقة، الاشتراك/الاستئناف، العلامات المائية، كشف الفجوات وحدود الاتصال لـ /v1/realtime.
---

# بروتوكول WebSocket للوقت الفعلي

بوابة الوقت الفعلي هي نقطة نهاية WebSocket أصلية وفق RFC 6455 على العنوان:

```text
wss://<host>/v1/realtime
```

مصادر التنفيذ: `packages/api-contract/src/schemas/realtime.ts` (مخططات الإطارات المعيارية)، و`packages/realtime/src/hub.ts` و`outbox-poller.ts` و`pg-notify-pubsub.ts` و`types.ts`، و`apps/api/src/ws-rfc6455.ts` (النقل).

:::warning اختلاف التسمية بين الكود والوثيقة السردية القديمة
تصف `docs/05-http-and-realtime-api.md` مفردات أقدم: `auth_ok` و`sub_ack` (بالصيغة `mode: "initial_sync"\|"resumed"`) و`change` (بالصيغة `changeType: added/modified/removed`) و`sync_complete`. أما **أسماء الإطارات المعيارية فهي تلك الموجودة في مخططات Zod في `@vellum/api-contract` وفي المُوزِّع (hub) الحي**: `auth_ack` و`initial_sync` و`mutation` (بالصيغة `operation: create/update/delete`) و`resume_complete` و`error` و`pong`. تستخدم هذه الصفحة وجموعات SDK الأسماء المعيارية. وتذكر الوثيقة القديمة أيضًا Redis Pub/Sub؛ لكن بموجب مبدأ "صفر خدمات حالة خارجية" (Zero-Redis) تم **إلغاء** الوسيط — فالتسليم يتم عبر `LISTEN/NOTIFY` من PostgreSQL مع مستقصِص outbox دائم.
:::

## الاتصال ودورة الحياة

| المرحلة | السلوك |
| :--- | :--- |
| الترقية | `GET /v1/realtime` مع ترويسات WS القياسية. يتطلب `Sec-WebSocket-Key` والإصدار `13`. المسار الخاطئ → `404`؛ ومصافحة خاطئة → `400`. |
| فحص Origin | غياب `Origin` مقبول (للعملاء الأصليين). أمّا وجوده فيجب أن يطابق قائمة CORS المسموح بها (`CORS_ALLOWED_ORIGINS`)، وإلا `403 Forbidden`. القائمة الفارغة تفشل بانغلاق (fail closed) لعملاء المتصفح. |
| حد لكل IP | 50 اتصالًا متزامنًا لكل عنوان IP → `429 Too Many Requests` بعد ذلك. |
| مهلة المصادقة | افتراضي الكود: **5,000 مللي ثانية** لإرسال إطار `auth` صالح (`DEFAULT_AUTH_TIMEOUT_MS`)، ثم إطار `error` بالرمز `UNAUTHENTICATED` وإغلاق 1008. تقول الوثيقة السردية القديمة 10,000 مللي ثانية — وقيمة الكود هي المعتمدة. |
| حجم الإطار | حد صارم 1 MiB لكل إطار داخلي، يُفرَض قبل التخصيص. التجاوز → `PAYLOAD_TOO_LARGE` وإغلاق 1009 (`MAX_WS_FRAME_BYTES`). |
| نبضة/خمول | يرسل الخادم ping على مستوى WS كل 30,000 مللي ثانية؛ ويجب الرد على ping معلّق واحد خلال نافذة الخمول 30,000 مللي ثانية، وإلا إغلاق 1000. كما تُدعم إطارات JSON التطبيقية `ping`/`pong`. |
| ضغط الإخراج | حد 1 MiB (`MAX_WS_OUTBOUND_BUFFER_BYTES`). تجاوزه يُصدر `error` بالرمز `SLOW_CONSUMER_DISCONNECT` وإغلاق 1008. |

يجب على العميل المصادقة قبل أي عملية أخرى؛ فإرسال `subscribe`/`unsubscribe` أولًا يُثير `UNAUTHENTICATED` (يُسلَّم كإطار `error` بواسطة طبقة النقل).

## إطارات العميل → الخادم

معرّفة عبر `ClientFrameSchema` (اتحاد مميّز حسب `type`).

| `type` | الحقول | الغرض |
| :--- | :--- | :--- |
| `auth` | `projectId` (min 1)، `apiKey` (min 1)، `authToken?` | يجب أن يكون الإطار الأول. يوفّر `authToken` (JWT المستخدم النهائي) قيمة `authContext` للقواعد. |
| `subscribe` | `subId` (min 1)، `path?` (مسار مستند) **أو** `query?` (`QuerySpec`)، `resumeSeqId?` (عدد صحيح غير سالب) | الاشتراك في مستند واحد أو استعلام مجموعة. يُطلب واحد تمامًا من `path`/`query`؛ وتعمل قيمة `resumeSeqId` على إعادة تشغيل أحداث outbox بعد ذلك التسلسل. |
| `unsubscribe` | `subId` (min 1) | إيقاف اشتراك. |
| `ping` | `ts` (number) | نبضة تطبيقية؛ يُجاب عليها بـ `pong`. |

```json
{ "type": "auth", "projectId": "prj_...", "apiKey": "sk_...", "authToken": "<jwt>" }
{ "type": "subscribe", "subId": "sub_1", "path": "users/u_123" }
{ "type": "subscribe", "subId": "sub_2", "query": { "collectionPath": "users", "limit": 50 }, "resumeSeqId": 1042 }
{ "type": "ping", "ts": 1794753000123 }
```

التحقق من المصادقة: يُتحقَّق من مفتاح API ويجب أن يخص المشروع/البيئة المُعنوَنين (وإلا `PERMISSION_DENIED`)؛ ويُتحقَّق من `authToken` عبر `verifyEndUserJwt`. ويجيب الخادم بـ `auth_ack`.

## إطارات الخادم → العميل

معرّفة عبر `ServerFrameSchema` (اتحاد مميّز حسب `type`).

| `type` | الحقول | المعنى |
| :--- | :--- | :--- |
| `auth_ack` | `status:"authenticated"`، `connectionId` | نجحت المصادقة. |
| `initial_sync` | `subId`، `seqId` (number)، `documents: DocumentPayload[]` | المستندات المطابقة الحالية لاشتراك جديد. `seqId` هو العلامة المائية الحالية لـ outbox. |
| `mutation` | `subId`، `seqId` (number)، `operation:"create"\|"update"\|"delete"`، `document: DocumentPayload` | تغيير مُودَع يطابق الاشتراك (مسار مستند أو انتقال في عضوية استعلام). |
| `resume_complete` | `subId`، `seqId` (string)، `count` (int)، `truncated` (bool) | يُرسل بعد انتهاء إعادة تشغيل `resumeSeqId`؛ و`seqId` هو آخر تسلسل مُسلَّم. وتعني `truncated` أن حد إعادة التشغيل قد بلغ ذروته. |
| `error` | `subId?`، `code` (رمز خطأ معياري)، `message` | خطأ في البروتوكول/الاشتراك. حالات انتهاء مصادقة طبقة النقل تستخدم `subId:"connection"`. |
| `pong` | `ts`، `serverTs` | الرد على `ping` تطبيقي. |

```json
{ "type": "auth_ack", "status": "authenticated", "connectionId": "conn_..." }
{ "type": "initial_sync", "subId": "sub_1", "seqId": 1042, "documents": [ /* DocumentPayload[] */ ] }
{ "type": "mutation", "subId": "sub_1", "seqId": 1043, "operation": "update", "document": { /* DocumentPayload */ } }
{ "type": "resume_complete", "subId": "sub_2", "seqId": "1042", "count": 7, "truncated": false }
{ "type": "error", "subId": "sub_3", "code": "PERMISSION_DENIED", "message": "..." }
```

`DocumentPayload` هو `{ path, collectionPath, collectionGroup, documentId, data, version, createdAt, updatedAt, sizeBytes? }` (مطابق لـ `DocumentPayloadSchema`). تُسقط مجموعات SDK قيمة `operation` على نوع التغيير: `create → added` و`update → modified` و`delete → removed`.

## قواعد الاشتراك والتصريح

| نوع الاشتراك | التحقق | عملية القواعد المُتحقَّق منها |
| :--- | :--- | :--- |
| `path` | `parseDocumentPath` | `get` على المسار |
| `query` | `validateAndNormalizeQuery` | `list` على `<collectionPath>/__ws_sub__` |

كلاهما يستخدم مجموعة القواعد النشطة للبيئة المُصادَق عليها بالإضافة إلى نطاقات مفتاح API. وأي فشل في التحقق يُصدر إطار `error` برمز الخطأ ولا يُسجَّل الاشتراك.

## العلامات المائية والاستئناف وكشف الفجوات

التسليم دائم مرتب حسب الترتيب؛ ولا يوجد وسيط يعمل في الذاكرة فقط.

1. **outbox.** كل تعديل مستند مُودَع يكتب صفًا في `realtime_outbox` مع `seq_id` متزايد رتيبي لكل `(projectId)`.
2. **الإيقاظ.** يوفّر `LISTEN/NOTIFY` في PostgreSQL حمولة مختصرة `{seqId, projectId, projectId}` على القناة المعيارية. ويستخدم `LISTEN` عميلًا مخصصًا واحدًا غير مجمّع (non-pooled).
3. **احتياطي الاستقصاء.** يستقصي `OutboxPoller` أيضًا كل 1,000 مللي ثانية ويجلب الصفوف الكاملة من مُكيّف التخزين المحدد للمستأجر بدُفعات من 500، فلا تُفقد أحداث عند غياب NOTIFY.
4. **كشف الفجوات.** يحتفظ كل مستأجر بعلامة مائية واحدة. إذا كان التسلسل المرصود في الإشعار أكبر من `watermark + 1`، تُسجَّل فجوة ويُشغَّل استعلام اللحاق من العلامة المائية؛ ويعيد المُوزِّع نشر الصفوف الفائتة بالترتيب. ولا تُعاد تسليم قيمة `seq ≤ watermark` أبدًا (ويكون إلغاء التكرار بين NOTIFY والاستقصاء تامًا عند حد الاشتراك عبر `seenSeqIds`).
5. **اشتراك جديد.** يحمل `initial_sync` العلامة المائية الحالية كـ `seqId`.
6. **الاستئناف.** يمرّ `subscribe` مع `resumeSeqId` على outbox بعد تلك القيمة (بحد أقصى 5,000 حدث لكل إعادة تشغيل، واستعلامات دُفعات من 500 صف)، ثم يُصدر `resume_complete`. تُخزَّن الأحداث الحية التي تصل أثناء إعادة التشغيل وتُفرَّغ بعدها بترتيب seq تصاعدي، فيلاحظ العميل إعادة التشغيل ثم الحي دون تداخل. وتُخبر `truncated:true` العميل بأن حد إعادة التشغيل قد بلغ ذروته.

تتعقّب مجموعات SDK أعلى `seqId` لكل اشتراك وتضمنه تلقائيًا كـ `resumeSeqId` عند إعادة الاشتراك بعد إعادة الاتصال. لاحظ أن `initial_sync`/`mutation` تحمل `seqId` كـ **عدد (number)**، بينما تحمله `resume_complete` كـ **نص (string)** (لتوافق الإرسال).

## رموز الأخطاء والحدود

| الشرط | الرمز | ما يعادله HTTP |
| :--- | :--- | :--- |
| إطار مصادقة مفقود/منتهي | `UNAUTHENTICATED` | 401 |
| عدم تطابق المفتاح/المشروع/البيئة، أو رفض القواعد | `PERMISSION_DENIED` | 403 |
| >25 اشتراكًا على اتصال واحد | `SUBSCRIPTION_LIMIT_EXCEEDED` | 400 |
| مخزن الإخراج >1 MiB | `SLOW_CONSUMER_DISCONNECT` | 429 |
| إطار داخلي >1 MiB | `PAYLOAD_TOO_LARGE` | 413 |
| إطار مشوّه / opcode غير معروف | `INVALID_ARGUMENT` | 400 |

راجع [الأخطاء](./errors.md) للمجموعة المعيارية الكاملة.

## مرجع سريع

- ما يقابلها عبر HTTP في مستوى البيانات: [مستوى البيانات عبر REST](./rest-data-plane.md)
- نقاط اتصال الوقت الفعلي في JS SDK (`webSocketFactory`، `realtimeHub`): [JavaScript SDK](../sdks/javascript.md)
- تدفقات الوقت الفعلي في Flutter: [Flutter SDK](../sdks/flutter.md)
- الدليل المعماري: [النشر والتشغيل](../../../06-deployment-and-operations.md)

## حدود الاتصال وتجميع المقابس وصندوق الكتابة

- يقبل الاتصال الواحد 25 اشتراكا كحد أقصى (`MAX_WS_SUBSCRIPTIONS_PER_CONN = 25`). الاشتراك رقم 26 يحصل على `{ "type": "error", "code": "SUBSCRIPTION_LIMIT_EXCEEDED" }` لذلك `subId`. حزمة `@vellumdb/sdk-js` وحزمة `vellum_flutter` تجمعان حتى 25 اشتراكا على مقبس واحد وتفتحان مقبسا إضافيا لكل 25 اشتراكا بعدها (حتى 40 مقبسا). الخيار `maxSockets` يحدد السقف، والقيمة 1 توقف التجميع.
- يسمح لكل مقبس بحتى 600 إطار عميل في الدقيقة، من غير إطارات `ping` و`pong`. عند تجاوز ذلك يغلق الخادم الاتصال بالرمز `1008` والسبب `WS_POLICY_VIOLATION: MESSAGE_RATE`.
- الكتابة دون اتصال: `PersistentWriteOutbox` في JS و`VellumOutbox` في Flutter تضعان الكتابات في طابور مع Idempotency-Key وتعيد إرسالها بالترتيب. `VellumOutbox` يفرغ الطابور تلقائيا عند عودة الاتصال (`autoFlushOnReconnect`، الافتراضي true).
- استخدم `listIdentities()` لعرض مزودي تسجيل الدخول المرتبطين. الدالة `listLinkedProviders()` قديمة.
- في تطوير Vite المحلي: أضف أصل التطوير إلى الأصول المسموحة لمفتاح API في لوحة التحكم (يقبل `http://localhost:*` و`http://127.0.0.1:*` مع مفتاح تطوير)، أو احذف ترويسة origin في وكيل التطوير.
