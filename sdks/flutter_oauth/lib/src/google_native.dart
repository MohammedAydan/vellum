import 'package:google_sign_in/google_sign_in.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

bool _initialized = false;

/// Optional native Google sign-in through the official `google_sign_in`
/// package. The ID token it returns is verified by the Vellum server, so list
/// the client IDs in Auth Studio (Google card) before using it.
///
/// [clientId] is the iOS / web client ID where the platform needs one;
/// [serverClientId] is your web client ID (required on Android).
Future<VellumAuthResult> signInWithNativeGoogle(
  VellumAuthPort auth, {
  String? clientId,
  String? serverClientId,
  String? nonce,
}) async {
  final google = GoogleSignIn.instance;
  if (!_initialized) {
    await google.initialize(
      clientId: clientId,
      serverClientId: serverClientId,
      nonce: nonce,
    );
    _initialized = true;
  }
  if (!google.supportsAuthenticate()) {
    throw const VellumException(
      code: 'UNSUPPORTED',
      message:
          'Native Google sign-in is not available on this platform. Use createVellumOAuth(...).signIn("google").',
      statusCode: 0,
    );
  }
  final GoogleSignInAccount account;
  try {
    account = await google.authenticate();
  } on GoogleSignInException {
    throw const VellumException(
      code: 'CANCELLED',
      message: 'Google sign-in was cancelled',
      statusCode: 0,
    );
  }
  final idToken = account.authentication.idToken;
  if (idToken == null || idToken.isEmpty) {
    throw const VellumException(
      code: 'UNAUTHENTICATED',
      message:
          'Google did not return an ID token. Set serverClientId to your web client ID.',
      statusCode: 0,
    );
  }
  return auth.signInWithGoogleIdToken(idToken: idToken, nonce: nonce);
}
