import 'dart:async';

import 'package:app_links/app_links.dart';
import 'package:flutter/foundation.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:vellum_flutter/vellum_flutter_core.dart';

import 'loopback_stub.dart' if (dart.library.io) 'loopback_io.dart';

bool _isLoopback(Uri redirect) =>
    (redirect.scheme == 'http') &&
    (redirect.host == '127.0.0.1' || redirect.host == 'localhost') &&
    redirect.hasPort;

/// Opens the sign-in page in the system browser and returns the URL the flow
/// ended on. No webview and no native setup beyond registering your redirect:
///
/// * Custom scheme (`myapp://auth-callback`): iOS, Android and macOS deliver it
///   as a deep link (register the scheme in the app, as for any deep link).
/// * Loopback (`http://127.0.0.1:4455/callback`, with an explicit port):
///   desktop (Windows, Linux, macOS) catches the redirect on a local port, so no
///   scheme registration is needed. Add that exact URL to Auth Studio.
///
/// Flutter web is not covered by this launcher; pass your own
/// [VellumOAuthLauncher] to [VellumOAuth] there.
VellumOAuthLauncher systemBrowserLauncher({
  required String redirectUri,
  Duration timeout = const Duration(minutes: 5),
}) {
  final redirect = Uri.parse(redirectUri);
  return (Uri url, String callbackUrlScheme) async {
    if (kIsWeb) {
      throw const VellumException(
        code: 'UNSUPPORTED',
        message:
            'The built-in browser launcher does not support Flutter web. Pass your own VellumOAuthLauncher.',
        statusCode: 0,
      );
    }
    Future<void> open() async {
      final ok = await launchUrl(url, mode: LaunchMode.externalApplication);
      if (!ok) {
        throw const VellumException(
          code: 'CANCELLED',
          message: 'Could not open the system browser',
          statusCode: 0,
        );
      }
    }

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

/// Ready-to-use [VellumOAuth] wired to the system browser.
VellumOAuth createVellumOAuth({
  required VellumAuthPort auth,
  required String redirectUri,
}) {
  return VellumOAuth(
    auth: auth,
    redirectUri: redirectUri,
    launcher: systemBrowserLauncher(redirectUri: redirectUri),
  );
}
