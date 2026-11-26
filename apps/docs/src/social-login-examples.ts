// Examples for the Social sign-in page (Google, GitHub and Apple).
// They mirror @vellumdb/sdk-js and vellum_flutter after 0.0.7.

export const popupTs = `// Call from a click handler so the browser allows the popup.
const result = await db.signInWithPopup("google"); // or "github" or "apple"

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

export const flutterBrowserDart = `// Android, iOS, macOS, Windows, Linux: nothing to register anywhere.
String? code; // show it while sign-in runs, for example with setState
final oauth = createVellumOAuth(
  auth: db.auth,
  onConfirmationCode: (c) => setState(() => code = c), // e.g. "K7M2QP"
);

final result = await oauth.signIn('github'); // or 'google' or 'apple'
setState(() => code = null);
if (result is VellumMfaRequired) {
  // finish with db.auth.verifyMfaChallenge(...)
}`;

export const flutterDeepLinkDart = `// Optional: come back to your app through a deep link instead.
final oauth = createVellumOAuth(
  auth: db.auth,
  redirectUri: 'myapp://auth-callback', // must be in the allowed redirect list
  onConfirmationCode: showCode, // needed for oauth.link(...)
);`;

export const androidBackupXml = `<!-- AndroidManifest.xml: <application android:dataExtractionRules="@xml/data_extraction_rules"
     android:fullBackupContent="@xml/backup_rules" ...> -->

<!-- res/xml/data_extraction_rules.xml (Android 12+) -->
<data-extraction-rules>
  <cloud-backup><exclude domain="sharedpref" path="FlutterSecureStorage"/></cloud-backup>
  <device-transfer><exclude domain="sharedpref" path="FlutterSecureStorage"/></device-transfer>
</data-extraction-rules>

<!-- res/xml/backup_rules.xml (Android 11 and older) -->
<full-backup-content>
  <exclude domain="sharedpref" path="FlutterSecureStorage.xml"/>
</full-backup-content>`;

export const flutterNativeDart = `// Optional. Add the official google_sign_in package to your own pubspec;
// vellum_flutter does not depend on it.
import 'package:google_sign_in/google_sign_in.dart';

await GoogleSignIn.instance.initialize(
  serverClientId: 'YOUR_WEB_CLIENT_ID.apps.googleusercontent.com',
);
final account = await GoogleSignIn.instance.authenticate();
final idToken = account.authentication.idToken!;
final result = await db.auth.signInWithGoogleIdToken(idToken: idToken);`;

export const flutterAppleDart = `// Optional. Add the official sign_in_with_apple package (and crypto) to your own pubspec.
// vellum_flutter does not depend on them.
import 'dart:convert';
import 'dart:math';
import 'package:crypto/crypto.dart';
import 'package:sign_in_with_apple/sign_in_with_apple.dart';

final rawNonce = base64UrlEncode(List<int>.generate(32, (_) => Random.secure().nextInt(256)));
final hashedNonce = sha256.convert(utf8.encode(rawNonce)).toString();

final credential = await SignInWithApple.getAppleIDCredential(
  scopes: [AppleIDAuthorizationScopes.email, AppleIDAuthorizationScopes.fullName],
  nonce: hashedNonce, // Apple puts this in the token
);
// Apple sends the name only on the very first sign-in, so pass it now.
final result = await db.auth.signInWithAppleIdToken(
  idToken: credential.identityToken!,
  nonce: rawNonce, // the raw value; Vellum hashes and compares it
  authorizationCode: credential.authorizationCode, // lets Vellum revoke the grant on account deletion
  givenName: credential.givenName,
  familyName: credential.familyName,
);`;

export const appleJsTs = `// Web: the same popup or redirect as the other providers.
await db.signInWithPopup("apple");

// Native wrapper (Capacitor, React Native): pass the ID token you got from Apple.
await db.signInWithAppleIdToken(identityToken, { nonce: rawNonce, authorizationCode });`;

export const flutterPubspec = `dependencies:
  vellum_flutter: ^0.0.7 # browser sign-in is built in`;

export const androidManifest = `<!-- inside the existing <activity> of your MainActivity -->
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="myapp" />
</intent-filter>`;

export const iosPlist = `<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array><string>myapp</string></array>
  </dict>
</array>`;

export const desktopDart = `// Windows, Linux and macOS: use a loopback redirect.
// Port 0 lets the OS pick a free port for every attempt (recommended, RFC 8252):
// the API accepts any port on 127.0.0.1, so there is nothing to add in Auth Studio.
final oauth = createVellumOAuth(
  auth: db.auth,
  redirectUri: 'http://127.0.0.1:0/callback',
);
// A fixed port also works (for example 'http://127.0.0.1:4455/callback').`;
