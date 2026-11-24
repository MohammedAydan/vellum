import 'dart:async';
import 'dart:io';

/// Listens on the loopback port of [redirect] for the provider redirect, shows a
/// short "you can close this window" page, and returns the full callback URL.
Future<String> awaitLoopbackCallback(
  Uri redirect,
  Future<void> Function() openBrowser,
  Duration timeout,
) async {
  final server = await HttpServer.bind(InternetAddress.loopbackIPv4, redirect.port);
  try {
    final done = Completer<String>();
    final sub = server.listen((request) async {
      final matches = request.uri.path == (redirect.path.isEmpty ? '/' : redirect.path);
      request.response.headers.contentType = ContentType.html;
      if (!matches) {
        request.response.statusCode = HttpStatus.notFound;
        await request.response.close();
        return;
      }
      request.response.write(
        '<!doctype html><meta charset="utf-8"><title>Signed in</title>'
        '<body style="font-family:sans-serif;text-align:center;margin-top:20vh">'
        'You can close this window and return to the app.</body>',
      );
      await request.response.close();
      if (!done.isCompleted) {
        done.complete(redirect.replace(query: request.uri.query).toString());
      }
    });
    try {
      await openBrowser();
      return await done.future.timeout(timeout);
    } finally {
      await sub.cancel();
    }
  } finally {
    await server.close(force: true);
  }
}
