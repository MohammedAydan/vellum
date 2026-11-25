import {
  popupTs, redirectTs, gisTs, callbackTs, flutterBrowserDart, flutterDeepLinkDart, androidBackupXml, flutterNativeDart, flutterPubspec, androidManifest, iosPlist, desktopDart, flutterAppleDart, appleJsTs } from "../../social-login-examples";
import { AlphaNotice, Callout, Code, CodeTabs, Doc, P, PageLink, Section, UL } from "../../ui";

export default function Page() {
  return (
    <Doc
      eyebrow="Core concepts"
      title="Social sign-in (Google, GitHub and Apple)"
      description="Let users sign in with Google, GitHub or Apple from the web or from a Flutter app. Vellum runs the OAuth flow on the server, so your app never handles a provider secret."
    >
      <AlphaNotice />
      <Callout tone="warning" title="Requires 0.0.3 or later">
        The methods on this page are available from version 0.0.3 of the JavaScript and Flutter SDKs.
      </Callout>

      <Section id="how" title="How it works">
        <UL items={[
          <>Your app starts the flow. Vellum sends the user to Google, GitHub or Apple and receives the result on the server.</>,
          <>Vellum checks the identity with the provider. Only a verified email address is accepted, and an existing
          account is linked only when that email is verified.</>,
          <>The user returns to your app with a one-time code. Your app trades it for a session. The code works once,
          for two minutes, and only with the secret that your app generated when it started.</>,
        ]} />
      </Section>

      <Section id="setup" title="Set up the provider">
        <UL items={[
          <>Create an OAuth client with Google (type Web application) an OAuth App with GitHub, or a Services ID with Apple (see below).</>,
          <>Register this callback URL with the provider:
          <code> /v1/projects/&lt;projectId&gt;/auth/oauth/google/callback</code> or
          <code> /auth/oauth/github/callback</code> or <code> /auth/oauth/apple/callback</code> on your API host.</>,
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
        <Callout tone="warning" title="The confirmation code protects your users">
          Redirect-less sign-in (and linking a provider to a signed-in account) ends with a code check. Your app shows a short code through <code>onConfirmationCode</code>;
          the page in the browser asks the person to type it before the sign-in is released. Without this, a link sent by an attacker could sign a victim in to the attacker's
          app, or attach the victim's Google account to the attacker's account. Show the code in plain sight while <code>signIn</code> runs (a dialog or banner) and hide it when the future completes.
          The browser page names your project and warns the person to continue only if they started the sign-in themselves. Five wrong codes end the attempt.
        </Callout>
        <P>
          Without a redirect URI the SDK opens the system browser and collects the result by polling the API with a PKCE verifier that
          never leaves the app. There is nothing to add to AndroidManifest.xml or Info.plist and nothing to add in Auth Studio, and it keeps
          working if the OS recreates your app while the browser is open. After signing in, the user returns to your app and the sign-in completes.
          It is off by default: turn it on in Auth Studio (Providers, "Redirect-less sign-in"), otherwise the SDK reports "Redirect-less sign-in is turned off for this project". Know the tradeoff before you do:
          the person confirms the sign-in by typing the code your app shows, but a fake app run by an attacker can show that code as well, so a determined phisher can still
          trick a user into approving a sign-in for the attacker's app. A deep link, and best of all an App Link or Universal Link, only ever reaches your own app, so it does not have this weakness.
          Use redirect-less sign-in when you cannot register a link, and prefer links for apps that hold sensitive data.
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
          ID token to <code>signInWithGoogleIdToken</code>. A token is accepted only if its audience is one of your project's Google client IDs. If you pass the web client ID as <code>serverClientId</code> (as above) that is the ID already configured. If you do not, Google issues the token for the Android or iOS client ID, so add those to "Additional Google client IDs" in Auth Studio &gt; Providers &gt; Google, otherwise sign-in fails.
        </P>
        <Code lang="dart" title="Native Google with google_sign_in (optional)" code={flutterNativeDart} />
      </Section>

      <Section id="apple" title="Sign in with Apple">
        <P>
          If your iOS app offers Google or GitHub sign-in, App Store guideline 4.8 requires an equivalent privacy-preserving option, which in practice means Sign in with Apple.
          In the Apple Developer portal create a Services ID (the web client ID), enable Sign in with Apple for it and register the callback URL above as a return URL.
          Create a Sign in with Apple key and download the <code>.p8</code> file once. In Auth Studio &gt; Providers &gt; Apple enter the Services ID, your Team ID, the Key ID and paste the <code>.p8</code> contents.
          The key is encrypted at rest and never returned. Vellum signs a short-lived client secret from it for each exchange.
        </P>
        <P>
          Apple only accepts an HTTPS return URL on a real domain: no <code>localhost</code>, no IP address and no fragment. To test the web flow locally, use a tunnel or a staging domain.
          Apple does not document PKCE for its token endpoint, so Vellum does not send a code challenge to Apple. The state and the confirmation code still protect the flow on Vellum's side.
        </P>
        <P>
          For native iOS and Android flows list your app bundle IDs under additional client IDs. The ID token is accepted only if its audience is the Services ID or one of those bundle IDs.
          Pass a random nonce: give Apple its SHA-256 hash and give Vellum the raw value. A token that carries a nonce is refused when none is supplied.
          Apple returns the user's name only on the first sign-in, so pass <code>givenName</code> and <code>familyName</code> then. Apple may also hide the real email behind a relay address, which Vellum accepts only when Apple marks it verified.
        </P>
        <P>
          When a user deletes their account or unlinks Apple, Vellum revokes the Apple grant, as Apple requires. This needs the <code>authorizationCode</code> from the sign-in, so pass it.
        </P>
        <Code lang="dart" title="Native Apple with sign_in_with_apple (optional)" code={flutterAppleDart} />
        <Code lang="ts" title="JavaScript" code={appleJsTs} />
      </Section>

      <Section id="security" title="Security notes">
        <UL items={[
          <>Apple ID tokens are verified against Apple's published keys, issuer, audience, expiry and nonce.</>,
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
