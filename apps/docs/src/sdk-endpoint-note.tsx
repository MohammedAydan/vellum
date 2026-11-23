import { Callout } from "./ui";

export function SdkEndpointNote({ arabic = false }: { arabic?: boolean }) {
  return arabic ? (
    <Callout tone="warning" title="عنوان الخادم ومصادقة المشروع">
      استخدم <code>endpoint</code> لأصل الخادم فقط، مثل <bdi>https://api.example.com</bdi>،
      دون <code>/v1</code> أو <code>/auth</code>. يضيف SDK المسار <code>/v1/projects/PROJECT_ID</code> تلقائياً.
      في Dart فقط، <code>baseUrl</code> بديل متقدم يجب أن يكون المسار الكامل
      <bdi> https://api.example.com/v1/projects/PROJECT_ID</bdi>، وليس أصل الخادم أو <code>/v1</code> وحدها.
      لا تجمع <code>endpoint</code> و<code>baseUrl</code>. ينشئ <code>db.auth</code> مستخدم مشروع باستخدام
      <code> displayName</code>، وليس حساب إدارة المنصة. إذا طلب الخطأ <code>name</code> بدلاً من
      <code> displayName</code> فتحقق من المسار.
    </Callout>
  ) : (
    <Callout tone="warning" title="API origin and project authentication">
      Use <code>endpoint</code> for the API origin only, such as <code>https://api.example.com</code>,
      without <code>/v1</code> or <code>/auth</code>. The SDK adds <code>/v1/projects/PROJECT_ID</code>.
      Dart also has an advanced <code>baseUrl</code> override: it must be the full
      <code> https://api.example.com/v1/projects/PROJECT_ID</code> prefix, not the origin or <code>/v1</code> alone.
      Do not supply both <code>endpoint</code> and <code>baseUrl</code>. <code>db.auth</code> creates project
      end users with <code>displayName</code>, not operator accounts. An error asking for <code>name</code>
      instead of <code>displayName</code> is a sign to verify the project route.
    </Callout>
  );
}
