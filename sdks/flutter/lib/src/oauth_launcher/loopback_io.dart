import 'dart:async';
import 'dart:io';

/// A bound loopback listener. With port 0 in the requested redirect, the OS
/// picks a free port; [redirect] always carries the port actually in use.
class LoopbackListener {
  LoopbackListener._(this._server, this.redirect) {
    _sub = _server.listen(_onRequest);
  }

  final HttpServer _server;
  late final StreamSubscription<HttpRequest> _sub;
  final Completer<String> _done = Completer<String>();

  /// The redirect URI to register with the start call.
  final Uri redirect;

  Future<void> _onRequest(HttpRequest request) async {
    final matches =
        request.uri.path == (redirect.path.isEmpty ? '/' : redirect.path);
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
    if (!_done.isCompleted) {
      _done.complete(redirect.replace(query: request.uri.query).toString());
    }
  }

  /// Opens the browser, then waits for the redirect (or [timeout]).
  Future<String> wait(
      Future<void> Function() openBrowser, Duration timeout) async {
    await openBrowser();
    return _done.future.timeout(timeout);
  }

  Future<void> close() async {
    await _sub.cancel();
    await _server.close(force: true);
  }
}

/// Binds the loopback port of [redirect] (port 0 means any free port).
Future<LoopbackListener> bindLoopbackListener(Uri redirect) async {
  final server =
      await HttpServer.bind(InternetAddress.loopbackIPv4, redirect.port);
  return LoopbackListener._(server, redirect.replace(port: server.port));
}

/// Listens on the loopback port of [redirect] for the provider redirect, shows a
/// short "you can close this window" page, and returns the full callback URL.
Future<String> awaitLoopbackCallback(
  Uri redirect,
  Future<void> Function() openBrowser,
  Duration timeout,
) async {
  final listener = await bindLoopbackListener(redirect);
  try {
    return await listener.wait(openBrowser, timeout);
  } finally {
    await listener.close();
  }
}
