import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

void main() {
  test('update() expands dotted keys into a nested patch', () async {
    final calls = <Map<String, Object?>>[];
    final client = VellumClient(
      baseUrl: 'http://localhost:8080/v1/projects/p',
      projectId: 'p',
      apiKey: 'pk_test',
      httpTransport: (method, url, headers, body) async {
        calls.add(<String, Object?>{'method': method, 'body': body});
        return <String, Object?>{};
      },
    );
    await client.collection('c').doc('d').update(<String, Object?>{
      'obj.a': 99,
      'obj.b.c': 1,
      'n': 2,
    });
    final data = (calls.single['body'] as Map)['data'] as Map;
    expect(data, {
      'obj': {
        'a': 99,
        'b': {'c': 1},
      },
      'n': 2,
    });
  });

  test('expandVellumUpdatePaths leaves plain data alone and rejects bad paths',
      () {
    final plain = <String, Object?>{'a': 1};
    expect(identical(expandVellumUpdatePaths(plain), plain), isTrue);
    expect(() => expandVellumUpdatePaths(<String, Object?>{'a..b': 1}),
        throwsArgumentError);
    expect(() => expandVellumUpdatePaths(<String, Object?>{'a.__proto__.b': 1}),
        throwsArgumentError);
  });
}
