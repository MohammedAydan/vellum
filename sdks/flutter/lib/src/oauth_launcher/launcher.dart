import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/widgets.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:vellum_flutter/vellum_flutter_core.dart';

import 'loopback_stub.dart' if (dart.library.io) 'loopback_io.dart';

bool _isLoopback(Uri redirect) =>
    (redirect.scheme == 'http') &&
    (redirect.host == '127.0.0.1' || redirect.host == 'localhost') &&
    redirect.hasPort;

Future<void> _openInBrowser(Uri url) async {
  final ok = await launchUrl(url, mode: LaunchMode.externalApplication);
  if (!ok) {
    throw const VellumException(
      code: 'CANCELLED',
      message: 'Could not open the system browser',
      statusCode: 0,
    );
  }
}

/// Opens the sign-in page in the system browser and returns the URL the flow
/// ended on. No webview and no native setup beyond registering your redirect:
///
/// * Custom scheme (`myapp://auth-callback`): iOS, Android and macOS deliver it
///   as a deep link (register the scheme in the app, as for any deep link).
/// * Loopback (`http://127.0.0.1:4455/callback`, with an explicit port):
///   desktop (Windows, Linux, macOS) catches the redirect on a local port, so no
///   scheme registration is needed. Add that exact URL to Auth Studio. Use port
///   0 (`http://127.0.0.1:0/callback`) to let the OS pick a free port for each
///   attempt (RFC 8252); that form works through [createVellumOAuth] only.
///
/// Flutter web is not covered by this launcher; pass your own
/// [VellumOAuthLauncher] to [VellumOAuth] there.
VellumOAuthLauncher systemBrowserLauncher({
  required String redirectUri,
  Duration timeout = const Duration(minutes: 5),
}) {
  final redirect = Uri.parse(redirectUri);
  if (_isLoopback(redirect) && redirect.port == 0) {
    throw ArgumentError.value(
      redirectUri,
      'redirectUri',
      'port 0 is resolved per attempt: use createVellumOAuth, which binds the port before the sign-in starts',
    );
  }
  return (Uri url, String callbackUrlScheme) async {
    if (kIsWeb) {
      throw const VellumException(
        code: 'UNSUPPORTED',
        message:
            'The built-in browser launcher does not support Flutter web. Pass your own VellumOAuthLauncher.',
        statusCode: 0,
      );
    }
    Future<void> open() => _openInBrowser(url);

    if (_isLoopback(redirect)) {
      return awaitLoopbackCallback(redirect, open, timeout);
    }
    final completer = Completer<String>();
    final sub = AppLinks().uriLinkStream.listen((link) {
      if (link.scheme == callbackUrlScheme && !completer.isCompleted) {
        completer.complete(link.toString());
      }
    });
    try {
      await open();
      return await completer.future.timeout(timeout);
    } finally {
      await sub.cancel();
    }
  };
}

/// Emits whenever the app returns to the foreground, so a redirect-less
/// sign-in can poll right away instead of waiting for its next timer tick.
class _ResumeSignals with WidgetsBindingObserver {
  _ResumeSignals() {
    _controller = StreamController<void>.broadcast(
      onListen: () => WidgetsBinding.instance.addObserver(this),
      onCancel: () => WidgetsBinding.instance.removeObserver(this),
    );
  }
  late final StreamController<void> _controller;
  Stream<void> get stream => _controller.stream;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && !_controller.isClosed) {
      _controller.add(null);
    }
  }
}

/// Ready-to-use [VellumOAuth] wired to the system browser.
///
/// With a [redirectUri] the browser returns to your app through a deep link
/// (custom scheme, or a loopback port on desktop). Without one the SDK uses
/// redirect-less sign-in: nothing to register in AndroidManifest.xml or
/// Info.plist, nothing to add in Auth Studio, and it survives the OS recreating
/// your app while the browser is open. Redirect-less is the recommended choice
/// on Android and iOS.
///
/// [onConfirmationCode] receives the short code the person must type into the
/// browser page to finish a redirect-less sign-in or any provider link. Show it
/// in a dialog or banner and hide it when the `signIn`/`link` future completes.
/// It is required for redirect-less sign-in.
VellumOAuth createVellumOAuth({
  required VellumAuthPort auth,
  String? redirectUri,
  VellumConfirmationCodeCallback? onConfirmationCode,
}) {
  if (redirectUri == null || redirectUri.isEmpty) {
    if (onConfirmationCode == null) {
      throw ArgumentError.notNull('onConfirmationCode');
    }
    return VellumOAuth.polling(
      auth: auth,
      onConfirmationCode: onConfirmationCode,
      resumeSignals: _ResumeSignals().stream,
      openUrl: (Uri url) async {
        if (kIsWeb) {
          throw const VellumException(
            code: 'UNSUPPORTED',
            message:
                'Redirect-less sign-in does not support Flutter web. Use the web SDK flow there.',
            statusCode: 0,
          );
        }
        final ok = await launchUrl(url, mode: LaunchMode.externalApplication);
        if (!ok) {
          throw const VellumException(
            code: 'CANCELLED',
            message: 'Could not open the system browser',
            statusCode: 0,
          );
        }
      },
    );
  }
  final parsed = Uri.parse(redirectUri);
  if (_isLoopback(parsed) && parsed.port == 0) {
    return VellumOAuth(
      auth: auth,
      redirectUri: redirectUri,
      onConfirmationCode: onConfirmationCode,
      launcher: (Uri url, String scheme) => Future<String>.error(
        const VellumException(
          code: 'UNSUPPORTED',
          message: 'Ephemeral loopback sign-in prepares its own launcher',
          statusCode: 0,
        ),
      ),
      sessionFactory: () async {
        if (kIsWeb) {
          throw const VellumException(
            code: 'UNSUPPORTED',
            message: 'Loopback sign-in does not support Flutter web. Pass your own VellumOAuthLauncher.',
            statusCode: 0,
          );
        }
        final listener = await bindLoopbackListener(parsed);
        return VellumOAuthSession(
          redirectUri: listener.redirect.toString(),
          launcher: (Uri url, String scheme) =>
              listener.wait(() => _openInBrowser(url), const Duration(minutes: 5)),
          close: listener.close,
        );
      },
    );
  }
  return VellumOAuth(
    auth: auth,
    redirectUri: redirectUri,
    onConfirmationCode: onConfirmationCode,
    launcher: systemBrowserLauncher(redirectUri: redirectUri),
  );
}
