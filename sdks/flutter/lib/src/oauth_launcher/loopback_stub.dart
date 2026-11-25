import 'package:vellum_flutter/vellum_flutter_core.dart';

const _unsupported = VellumException(
  code: 'UNSUPPORTED',
  message: 'Loopback sign-in is not available on this platform.',
  statusCode: 0,
);

/// Loopback redirects need `dart:io`, which web does not have.
class LoopbackListener {
  Uri get redirect => throw _unsupported;
  Future<String> wait(Future<void> Function() openBrowser, Duration timeout) =>
      throw _unsupported;
  Future<void> close() async {}
}

Future<LoopbackListener> bindLoopbackListener(Uri redirect) => throw _unsupported;

Future<String> awaitLoopbackCallback(
  Uri redirect,
  Future<void> Function() openBrowser,
  Duration timeout,
) =>
    throw _unsupported;
