import {
  popupTs, redirectTs, gisTs, callbackTs, flutterBrowserDart, flutterNativeDart, flutterPubspec, androidManifest,
} from "../../social-login-examples";
import { AlphaNotice, Callout, Code, CodeTabs, Doc, P, PageLink, Section, UL } from "../../ui";

export default function Page() {
  return (
    <Doc
      eyebrow="Core concepts"
      title="Social sign-in (Google and GitHub)"
      description="Let users sign in with Google or GitHub from the web or from a Flutter app. Vellum runs the OAuth flow on the server, so your app never handles a provider secret."
    >
      <AlphaNotice />
      <Callout tone="warning" title="Requires 0.0.3 or later">
        The methods on this page are available from version 0.0.3 of the JavaScript and Flutter SDKs.
      </Callout>

      <Section id="how" title="How it works">
        <UL items={[
          <>Your app starts the flow. Vellum sends the user to Google or GitHub and receives the result on the server.</>,
          <>Vellum checks the identity with the provider. Only a verified email address is accepted, and an existing
          account is linked only when that email is verified.</>,
          <>The user returns to your app with a one-time code. Your app trades it for a session. The code works once,
          for two minutes, and only with the secret that your app generated when it started.</>,
        ]} />
      </Section>

      <Section id="setup" title="Set up the provider">
        <UL items={[
          <>Create an OAuth client with Google (type Web application) or an OAuth App with GitHub.</>,
          <>Register this callback URL with the provider:
          <code> /v1/projects/&lt;projectId&gt;/auth/oauth/google/callback</code> or
          <code> /auth/oauth/github/callback</code> on your API host.</>,
          <>Save the client ID and client secret in your project's auth settings. The secret is encrypted at rest and is never returned.</>,
          <>Add every page or app link users may return to (for example <code>https://app.example.com/login</code> or <code>myapp://auth-callback</code>)
          to the allowed redirect URIs. Anything not on the list is refused.</>,
        ]} />
      </Section>

      <Section id="web" title="Web: popup or redirect">
        <P>
          The popup keeps your page in place. The redirect is the better choice on mobile browsers, where popups are often blocked.
          The return page can be your login page itself. The SDK removes the result from the address bar.
        </P>
        <CodeTabs tabs={[
          { label: "Popup", lang: "ts", code: popupTs },
          { label: "Redirect", lang: "ts", code: redirectTs },
          { label: "Google Identity Services", lang: "ts", code: gisTs },
          { label: "Popup return page (optional)", lang: "ts", code: callbackTs },
        ]} />
      </Section>

      <Section id="flutter" title="Flutter">
        <P>
          This is built into vellum_flutter. It opens the system browser session on iOS, Android, macOS, Windows, Linux and web,
          and returns the result to Vellum.
        </P>
        <Code lang="bash" title="pubspec.yaml" code={flutterPubspec} />
        <Code lang="dart" title="Sign in" code={flutterBrowserDart} />
        <P>
          Android needs one manifest entry for your app link scheme. iOS and macOS need no setup for a custom scheme.
          On web, the redirect URI is an https page of your app that the plugin generates; see the plugin documentation.
        </P>
        <Code lang="xml" title="AndroidManifest.xml (inside application)" code={androidManifest} />
        <P>
          Prefer the native account picker for Google? Use the official <code>google_sign_in</code> package through the same
          package. Add your Android and iOS client IDs to the Google settings of your project so their tokens are accepted.
        </P>
        <Code lang="dart" title="Native Google (optional)" code={flutterNativeDart} />
      </Section>

      <Section id="security" title="Security notes">
        <UL items={[
          <>Provider tokens never reach your app. Google ID tokens are verified against Google's published keys, issuer, audience and expiry.</>,
          <>GitHub users need a verified primary email. The public profile email is never trusted.</>,
          <>If the account has a second factor enabled, sign-in returns a challenge that you finish with <code>verifyMfaChallenge</code>.</>,
          <>The older <code>signInWithOAuth</code> call that carries provider claims still needs a secret server key and is meant for your own backend.
          See <PageLink slug="end-user-auth">End-user authentication</PageLink>.</>,
        ]} />
      </Section>
    </Doc>
  );
}
