import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';
import 'package:vellum_flutter/vellum_flutter_core.dart';

/// Opens the sign-in page in the platform's secure browser session
/// (ASWebAuthenticationSession, Chrome Custom Tab / Auth Tab, a popup on web)
/// and returns the URL the flow ended on.
VellumOAuthLauncher flutterWebAuthLauncher({FlutterWebAuth2Options? options}) {
  return (Uri url, String callbackUrlScheme) {
    return FlutterWebAuth2.authenticate(
      url: url.toString(),
      callbackUrlScheme: callbackUrlScheme,
      options: options ?? const FlutterWebAuth2Options(),
    );
  };
}

/// Ready-to-use [VellumOAuth] wired to the system browser.
VellumOAuth createVellumOAuth({
  required VellumAuthPort auth,
  required String redirectUri,
  FlutterWebAuth2Options? options,
}) {
  return VellumOAuth(
    auth: auth,
    redirectUri: redirectUri,
    launcher: flutterWebAuthLauncher(options: options),
  );
}
