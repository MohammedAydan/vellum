// Examples for the Social sign-in page (Google and GitHub).
// They mirror @vellumdb/sdk-js and vellum_flutter after 0.0.3.

export const popupTs = `// Call from a click handler so the browser allows the popup.
const result = await db.signInWithPopup("google"); // or "github"

if ("mfaTicket" in result) {
  // A second factor is required: finish with db.verifyMfaChallenge(...)
} else {
  console.log("Signed in as", result.email);
}`;

export const redirectTs = `// Start: leaves your page and comes back to it.
await db.signInWithRedirect("github");

// On every app start (once, early): finishes the sign-in if this page load is the return.
const result = await db.getRedirectResult();
if (result && !("mfaTicket" in result)) {
  console.log("Signed in as", result.email);
}`;

export const gisTs = `// With Google Identity Services (One Tap or the Google button) you get an ID token.
// Pass it to Vellum, which verifies it on the server.
window.google.accounts.id.initialize({
  client_id: "YOUR_GOOGLE_CLIENT_ID",
  callback: async ({ credential }) => {
    await db.signInWithGoogleIdToken(credential);
  },
});`;

export const callbackTs = `// Optional. Only needed if a browser cuts the link between the popup and your page.
// Run it on your redirect page; it does nothing on other pages.
import { completeOAuthPopup } from "@vellumdb/sdk-js";
completeOAuthPopup();`;

export const flutterBrowserDart = `final oauth = createVellumOAuth(
  auth: db.auth,
  redirectUri: 'myapp://auth-callback', // must be in the allowed redirect list
);

final result = await oauth.signIn('github'); // or 'google'
if (result is VellumMfaRequired) {
  // finish with db.auth.verifyMfaChallenge(...)
}`;

export const flutterNativeDart = `// Optional: the official google_sign_in package (native account picker).
final result = await signInWithNativeGoogle(
  db.auth,
  serverClientId: 'YOUR_WEB_CLIENT_ID.apps.googleusercontent.com',
);`;

export const flutterPubspec = `dependencies:
  vellum_flutter: ^0.0.3
  vellum_flutter_oauth: ^0.0.3`;

export const androidManifest = `<activity
  android:name="com.linusu.flutter_web_auth_2.CallbackActivity"
  android:exported="true"
  android:taskAffinity="">
  <intent-filter android:label="flutter_web_auth_2">
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="myapp" />
  </intent-filter>
</activity>`;
