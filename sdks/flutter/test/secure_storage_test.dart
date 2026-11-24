import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    FlutterSecureStorage.setMockInitialValues(<String, String>{});
    VellumDefaults.authStorageFactory = null;
  });

  test('sessions persist across storage instances', () async {
    final first = SecureAuthTokenStorage();
    await first.writeAccessToken('access-1');
    await first.writeRefreshToken('refresh-1');
    await first.writeUser(<String, Object?>{'id': 'u1', 'email': 'a@b.c'});

    final second = SecureAuthTokenStorage();
    expect(await second.readAccessToken(), 'access-1');
    expect(await second.readRefreshToken(), 'refresh-1');
    expect((await second.readUser())?['id'], 'u1');

    await second.writeAccessToken(null);
    expect(await SecureAuthTokenStorage().readAccessToken(), isNull);
  });

  test('plugin registration makes it the default for new clients', () {
    VellumSecureStoragePlugin.registerWith();
    final client = VellumClient(
        baseUrl: 'http://localhost:8080/v1/projects/p',
        projectId: 'p',
        apiKey: 'k');
    expect(client.authTokenStorage, isA<SecureAuthTokenStorage>());
  });

  test('falls back to memory when the secure store throws', () async {
    final storage = SecureAuthTokenStorage(storage: _BrokenStorage());
    await storage.writeAccessToken('t');
    expect(storage.usingFallback, isTrue);
    expect(await storage.readAccessToken(), 't');
  });
}

class _BrokenStorage implements SecureKeyValue {
  @override
  Future<String?> read(String key) => throw StateError('no keyring');

  @override
  Future<void> write(String key, String value) =>
      throw StateError('no keyring');

  @override
  Future<void> delete(String key) => throw StateError('no keyring');
}
