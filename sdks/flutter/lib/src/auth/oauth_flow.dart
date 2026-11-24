/// Browser-based Google / GitHub sign-in (code + PKCE), without any platform code.
part of '../../vellum_flutter_core.dart';

/// Opens [authorizeUrl] in a secure system browser session and returns the
/// full URL the browser was redirected to (the one that starts with the
/// redirect URI's scheme). `systemBrowserLauncher` (built into `vellum_flutter`)
/// provides this for iOS, Android, macOS, Windows and Linux.
typedef VellumOAuthLauncher = Future<String> Function(
  Uri authorizeUrl,
  String callbackUrlScheme,
);

/// Runs the server-side OAuth flow: start -> provider -> one-time code ->
/// session. The app never sees a provider token, and the one-time code is
/// useless without the PKCE verifier that never leaves this object.
class VellumOAuth {
  VellumOAuth({
    required this.auth,
    required this.launcher,
    required this.redirectUri,
    Random? random,
  }) : _random = random ?? Random.secure() {
    final scheme = Uri.parse(redirectUri).scheme;
    if (scheme.isEmpty) {
      throw ArgumentError.value(
        redirectUri,
        'redirectUri',
        'must be absolute, for example myapp://auth-callback or https://app.example.com/auth.html',
      );
    }
  }

  final VellumAuthPort auth;
  final VellumOAuthLauncher launcher;

  /// Must be in the project's allowed redirect URIs (Auth Studio).
  final String redirectUri;
  final Random _random;

  String _token(int bytes) => base64Url
      .encode(List<int>.generate(bytes, (_) => _random.nextInt(256)))
      .replaceAll('=', '');

  /// Signs in with `google` or `github`. Resolves to [VellumMfaRequired] when a
  /// second factor is needed, otherwise a [VellumSession].
  Future<VellumAuthResult> signIn(String provider) async {
    final verifier = _token(48);
    final state = _token(16);
    final challenge = base64Url
        .encode(crypto.sha256.convert(utf8.encode(verifier)).bytes)
        .replaceAll('=', '');
    final start = auth.oauthStartUri(
      provider: provider,
      redirectUri: redirectUri,
      codeChallenge: challenge,
      state: state,
    );
    final String returned;
    try {
      returned = await launcher(start, Uri.parse(redirectUri).scheme);
    } on VellumException {
      rethrow;
    } catch (_) {
      throw const VellumException(
        code: 'CANCELLED',
        message: 'Sign-in was cancelled or could not be opened',
        statusCode: 0,
      );
    }
    final uri = Uri.parse(returned);
    final error = uri.queryParameters['error'];
    if (error != null) {
      throw VellumException(
        code:
            error == 'access_denied' ? 'PERMISSION_DENIED' : 'UNAUTHENTICATED',
        message: uri.queryParameters['error_description'] ?? 'Sign-in failed',
        statusCode: 0,
      );
    }
    final code = uri.queryParameters['vellum_code'];
    if (code == null || uri.queryParameters['state'] != state) {
      throw const VellumException(
        code: 'UNAUTHENTICATED',
        message:
            'Sign-in response did not match the request. Please try again.',
        statusCode: 0,
      );
    }
    return auth.exchangeOAuthCode(code: code, codeVerifier: verifier);
  }
}
