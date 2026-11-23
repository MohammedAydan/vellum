import 'package:test/test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

void main() {
  group('VellumWire.reference', () {
    for (final path in ['users/u1', 'teams/t1/members/u1', 'users/محمد']) {
      test('creates an immutable canonical reference: $path', () {
        final value = VellumWire.reference(path);
        expect(value, {'\$t': 'ref', '\$v': path});
        expect(() => value['\$v'] = 'users/changed', throwsUnsupportedError);
      });
    }
    for (final path in [
      '',
      ' users/u1',
      'users/u1 ',
      'users',
      '/users/u1',
      'users/u1/',
      'users//u1',
      'users/..',
      'users/%2e%2e',
      'users/%2fother',
      'users/u?x',
      'users/u#x',
      'users/u\\x',
      'users/u\u0000',
      'users/__reserved__',
      'users/${'x' * 1501}',
      'users/${'界' * 501}',
      'a/b/c/d/e/f/g/h/i/j/k/l',
      'a/${'x' * 1200}/b/${'y' * 850}',
    ]) {
      test('rejects invalid reference path: ${path.length} characters', () {
        expect(
            () => VellumWire.reference(path), throwsA(isA<VellumException>()));
      });
    }
    test('accepts the contract length boundary', () {
      final path = 'a/${'x' * 1020}/b/${'y' * 1023}';
      expect(path.length, 2048);
      expect(VellumWire.reference(path)['\$v'], path);
    });
    test('serializes through existing document create and update', () async {
      final bodies = <JsonMap>[];
      final client = VellumClient(
        baseUrl: 'https://example.test/v1/projects/project',
        projectId: 'project',
        apiKey: 'pk_test_reference_creation',
        httpTransport: (method, url, headers, body) async {
          if (body != null) bodies.add(body);
          return <String, Object?>{};
        },
      );
      await client.doc('posts/p1').create({
        'author': VellumWire.reference('users/محمد'),
        'readers': [VellumWire.reference('users/u2')],
      });
      await client
          .doc('posts/p1')
          .update({'author': VellumWire.reference('users/u2')});
      expect((bodies.first['data'] as Map)['author'],
          {'\$t': 'ref', '\$v': 'users/محمد'});
      expect((bodies.last['data'] as Map)['author'],
          {'\$t': 'ref', '\$v': 'users/u2'});
      client.dispose();
    });
  });
}
