import 'package:vellum_flutter/vellum_flutter_core.dart';

/// Loopback redirects need `dart:io`, which web does not have.
Future<String> awaitLoopbackCallback(
  Uri redirect,
  Future<void> Function() openBrowser,
  Duration timeout,
) {
  throw const VellumException(
    code: 'UNSUPPORTED',
    message: 'Loopback sign-in is not available on this platform.',
    statusCode: 0,
  );
}
