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

/// One sign-in attempt prepared by a [VellumOAuthSessionFactory]: the redirect
/// URI to send to the API (known only once the listener is bound) and the
/// launcher that waits on it. [close] runs when the attempt ends.
class VellumOAuthSession {
  const VellumOAuthSession({
    required this.redirectUri,
    required this.launcher,
    required this.close,
  });
  final String redirectUri;
  final VellumOAuthLauncher launcher;
  final Future<void> Function() close;
}

/// Builds a [VellumOAuthSession] per attempt. Used for loopback redirects on an
/// ephemeral port (`http://127.0.0.1:0/callback`), where the real port exists
/// only after the listener is bound.
typedef VellumOAuthSessionFactory = Future<VellumOAuthSession> Function();

/// Receives the confirmation code the person must type into the browser page
/// to finish a redirect-less sign-in or a provider link. Show it in your UI
/// (a dialog or banner) and hide it when the `signIn`/`link` future completes.
typedef VellumConfirmationCodeCallback = void Function(String code);

/// The code derived from a PKCE [challenge]: `sha256("vellum-confirm:" +
/// challenge)`, first six bytes masked to 5 bits over a 32-symbol alphabet.
/// The server derives the same code from the challenge it stored.
String vellumConfirmationCode(String challenge) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  final digest = crypto.sha256.convert(utf8.encode('vellum-confirm:$challenge')).bytes;
  return String.fromCharCodes(<int>[
    for (var i = 0; i < 6; i++) alphabet.codeUnitAt(digest[i] & 31),
  ]);
}

/// Runs the server-side OAuth flow: start -> provider -> one-time code ->
/// session. The app never sees a provider token, and the one-time code is
/// useless without the PKCE verifier that never leaves this object.
class VellumOAuth {
  VellumOAuth({
    required this.auth,
    required this.launcher,
    required this.redirectUri,
    this.onConfirmationCode,
    this.sessionFactory,
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

  /// Redirect-less sign-in: needs no redirect URI, no deep-link registration
  /// and no Auth Studio entry. [openUrl] opens the provider page in the system
  /// browser; the SDK then polls the API (about every [pollInterval]) until the
  /// browser step is done or [timeout] passes. Safe on Android and iOS even if
  /// the OS recreates the app while the browser is open, because the only secret
  /// is the PKCE verifier held by this object. Pass [resumeSignals] (the Flutter
  /// wrapper does) to poll immediately when the app returns to the foreground.
  VellumOAuth.polling({
    required this.auth,
    required Future<void> Function(Uri url) openUrl,
    required VellumConfirmationCodeCallback this.onConfirmationCode,
    this.pollInterval = const Duration(seconds: 2),
    this.timeout = const Duration(minutes: 5),
    Stream<void>? resumeSignals,
    Random? random,
  })  : launcher = _noLauncher,
        sessionFactory = null,
        redirectUri = '',
        _openUrl = openUrl,
        _resume = resumeSignals,
        _random = random ?? Random.secure();

  static Future<String> _noLauncher(Uri url, String scheme) => Future<String>.error(
        const VellumException(
          code: 'UNSUPPORTED',
          message: 'Polling sign-in does not use a launcher',
          statusCode: 0,
        ),
      );

  final VellumAuthPort auth;
  final VellumOAuthLauncher launcher;

  /// When set, each attempt asks it for its redirect URI and launcher instead of
  /// using [redirectUri] and [launcher] (loopback with an ephemeral port).
  final VellumOAuthSessionFactory? sessionFactory;

  /// Called with the code the person must type into the browser page before a
  /// redirect-less sign-in or a provider link completes. Required for
  /// redirect-less sign-in and for [link]; it stops a phishing link from
  /// signing someone in to, or linking their account to, an attacker's app.
  final VellumConfirmationCodeCallback? onConfirmationCode;
  Future<void> Function(Uri url)? _openUrl;
  Stream<void>? _resume;
  Duration pollInterval = const Duration(seconds: 2);
  Duration timeout = const Duration(minutes: 5);

  /// Must be in the project's allowed redirect URIs (Auth Studio).
  final String redirectUri;
  final Random _random;

  String _token(int bytes) => base64Url
      .encode(List<int>.generate(bytes, (_) => _random.nextInt(256)))
      .replaceAll('=', '');

  /// Signs in with `google` or `github`. Resolves to [VellumMfaRequired] when a
  /// second factor is needed, otherwise a [VellumSession].
  Future<VellumAuthResult> signIn(String provider) => _run(provider, false);

  /// Adds `google` or `github` to the signed-in user's account (the provider's
  /// email may differ). Fails when that provider account belongs to another user.
  Future<VellumAuthResult> link(String provider, {String? currentPassword}) {
    if (auth.currentUser == null) {
      throw const VellumException(
        code: 'UNAUTHENTICATED',
        message: 'Sign in before linking a provider',
        statusCode: 0,
      );
    }
    if (onConfirmationCode == null) {
      throw ArgumentError(
        'link() needs onConfirmationCode: the person must type the code shown '
        'in the app into the browser page to approve the link.',
      );
    }
    return _run(provider, true, currentPassword);
  }

  Future<VellumAuthResult> _run(String provider, bool link, [String? currentPassword]) async {
    final verifier = _token(48);
    final state = _token(16);
    final challenge = base64Url
        .encode(crypto.sha256.convert(utf8.encode(verifier)).bytes)
        .replaceAll('=', '');
    if (_openUrl != null) {
      return _signInPolling(provider, verifier, challenge, link, currentPassword);
    }
    final prepared = await sessionFactory?.call();
    try {
      return await _runRedirect(
        provider,
        link,
        currentPassword,
        verifier,
        state,
        challenge,
        prepared?.redirectUri ?? redirectUri,
        prepared?.launcher ?? launcher,
      );
    } finally {
      await prepared?.close();
    }
  }

  Future<VellumAuthResult> _runRedirect(
    String provider,
    bool link,
    String? currentPassword,
    String verifier,
    String state,
    String challenge,
    String redirectUri,
    VellumOAuthLauncher launcher,
  ) async {
    final start = await auth.oauthStart(
      provider: provider,
      redirectUri: redirectUri,
      codeChallenge: challenge,
      state: state,
      link: link,
      currentPassword: currentPassword,
    );
    if (link) onConfirmationCode!(vellumConfirmationCode(challenge));
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

  Future<VellumAuthResult> _signInPolling(
    String provider,
    String verifier,
    String challenge,
    bool link,
    String? currentPassword,
  ) async {
    final start = await auth.oauthStartPoll(
      provider: provider,
      codeChallenge: challenge,
      link: link,
      currentPassword: currentPassword,
    );
    onConfirmationCode!(vellumConfirmationCode(challenge));
    try {
      await _openUrl!(start);
    } on VellumException {
      rethrow;
    } catch (_) {
      throw const VellumException(
        code: 'CANCELLED',
        message: 'Sign-in could not be opened',
        statusCode: 0,
      );
    }
    final deadline = DateTime.now().add(timeout);
    var wake = Completer<void>();
    final sub = _resume?.listen((_) {
      if (!wake.isCompleted) wake.complete();
    });
    try {
      while (DateTime.now().isBefore(deadline)) {
        final result = await auth.pollOAuth(codeVerifier: verifier);
        if (result != null) return result;
        wake = Completer<void>();
        await Future.any<void>(<Future<void>>[
          Future<void>.delayed(pollInterval),
          wake.future,
        ]);
      }
    } finally {
      await sub?.cancel();
    }
    throw const VellumException(
      code: 'CANCELLED',
      message: 'Sign-in timed out. Please try again.',
      statusCode: 0,
    );
  }
}
