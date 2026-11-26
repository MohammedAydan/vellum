import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

void main() {
  test('the default transport reuses one connection across requests', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final ports = <int>{};
    var requests = 0;
    server.listen((request) async {
      ports.add(request.connectionInfo!.remotePort);
      requests++;
      request.response.headers.contentType = ContentType.json;
      request.response.write(jsonEncode(<String, Object?>{'ok': true}));
      await request.response.close();
    });
    addTearDown(() => server.close(force: true));

    final client = VellumClient(
      endpoint: 'http://127.0.0.1:${server.port}',
      projectId: 'p',
      apiKey: 'pk_test',
    );
    for (var i = 0; i < 5; i++) {
      await client.request('GET', '/documents/a/b$i');
    }
    expect(requests, 5);
    expect(ports.length, 1, reason: 'every request opened its own connection');
  });
}
