/// Google and GitHub sign-in for `vellum_flutter`.
///
/// ```dart
/// final oauth = createVellumOAuth(
///   auth: client.auth,
///   redirectUri: 'myapp://auth-callback', // add it to Auth Studio > Redirect URIs
/// );
/// final result = await oauth.signIn('github'); // or 'google'
/// ```
library;

export 'src/google_native.dart' show signInWithNativeGoogle;
export 'src/launcher.dart' show createVellumOAuth, flutterWebAuthLauncher;
