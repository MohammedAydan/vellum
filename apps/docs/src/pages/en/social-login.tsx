import {
  popupTs, redirectTs, gisTs, callbackTs, flutterBrowserDart, flutterDeepLinkDart, androidBackupXml, flutterNativeDart, flutterPubspec, androidManifest, iosPlist, desktopDart,
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
          This is built into vellum_flutter. It opens the system browser (no webview, no extra plugin to install) and returns the result to Vellum.
        </P>
        <Code lang="bash" title="pubspec.yaml" code={flutterPubspec} />
        <Code lang="dart" title="Sign in" code={flutterBrowserDart} />
        <P>
          Without a redirect URI the SDK opens the system browser and collects the result by polling the API with a PKCE verifier that
          never leaves the app. There is nothing to add to AndroidManifest.xml or Info.plist and nothing to add in Auth Studio, and it keeps
          working if the OS recreates your app while the browser is open. After signing in, the user returns to your app and the sign-in completes.
          This is the recommended way on Android and iOS.
        </P>
        <P>
          Prefer a deep link? Pass a custom scheme such as <code>myapp://auth-callback</code>, add it to the allowed redirect list, and register the scheme in
          your app like any deep link. On Windows and Linux you can also use a loopback redirect with a fixed port. The built-in launcher does not cover Flutter web; use the web SDK flow there.
        </P>
        <Code lang="dart" title="Deep link (optional)" code={flutterDeepLinkDart} />
        <P>
          If you use a deep link, prefer Android App Links (<code>https://</code> links verified through <code>assetlinks.json</code>) or iOS Universal Links
          (<code>apple-app-site-association</code>) over a custom scheme: any other app can register the same custom scheme, while a verified https link
          can only open your app. Use that https URL as the <code>redirectUri</code> and add it to the allowed redirect list. The one-time code is also bound to the PKCE verifier,
          so a link intercepted by another app cannot be redeemed, but verified links remove the attempt entirely.
        </P>
        <P>
          Sessions are kept in the Keychain (iOS and macOS, available after the first unlock and never copied to another device) and in an
          Android Keystore-backed store. On iOS the Keychain survives an uninstall, so the SDK clears its own session keys on the first launch after a fresh install. On Android, keep the session store
          out of backups so a restored backup never carries encrypted data without its key:
        </P>
        <Code lang="xml" title="Exclude the secure storage file from Android backups" code={androidBackupXml} />
        <Code lang="xml" title="AndroidManifest.xml (inside MainActivity)" code={androidManifest} />
        <Code lang="xml" title="Info.plist (iOS and macOS)" code={iosPlist} />
        <Code lang="dart" title="Desktop loopback redirect" code={desktopDart} />
        <P>
          Prefer the native account picker for Google? Add the official <code>google_sign_in</code> package to your own app and pass its
          ID token to <code>signInWithGoogleIdToken</code>. A token is accepted only if its audience is one of your project's Google client IDs. If you pass the web client ID as <code>serverClientId</code> (as above) that is the ID already configured. If you do not, Google issues the token for the Android or iOS client ID, so add those to "Additional Google client IDs" in Auth Studio > Providers > Google, otherwise sign-in fails.
        </P>
        <Code lang="dart" title="Native Google with google_sign_in (optional)" code={flutterNativeDart} />
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
