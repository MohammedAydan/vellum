import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:flutter_compat_app/main.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

VellumClient _client(Map<String, Map<String, Object?>> store) {
  return VellumClient(
    baseUrl: 'http://localhost:8080/v1/projects/p',
    projectId: 'p',
    apiKey: 'pk_test_secret_123',
    warnOnMissingIndexes: false,
    httpTransport: (String method, String url, Map<String, String> headers,
        Map<String, dynamic>? body) async {
      final path =
          Uri.decodeFull(url.split('/documents/').last.split('?').first);
      if (method == 'PUT') {
        store[path] = (body!['data'] as Map).cast<String, Object?>();
      }
      return VellumHttpResponse(body: <String, Object?>{
        'path': path,
        'documentId': path.split('/').last,
        'version': 1,
        'data': store[path],
      });
    },
  );
}

void main() {
  testWidgets('writes and reads a document through the SDK', (tester) async {
    final store = <String, Map<String, Object?>>{};
    await tester.pumpWidget(CompatApp(client: _client(store)));
    expect(find.text('idle'), findsOneWidget);
    await tester.tap(find.byKey(const Key('run')));
    await tester.pumpAndSettle();
    expect(find.text('ok:world'), findsOneWidget);
    expect(store.length, 1);
  });
}
