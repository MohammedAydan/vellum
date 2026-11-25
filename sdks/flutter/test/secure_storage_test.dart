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

  test('first launch after a fresh install clears a session left in the Keychain (iOS/macOS)', () async {
    final store = _MapStorage()
      ..data['vellum_access_token'] = 'stale-access'
      ..data['vellum_refresh_token'] = 'stale-refresh'
      ..data['vellum_user'] = '{"id":"old"}'
      ..data['other_app_secret'] = 'keep-me';
    var first = true;
    final storage = SecureAuthTokenStorage(
      storage: store,
      clearOnFirstLaunch: true,
      firstLaunchCheck: () async {
        final r = first;
        first = false;
        return r;
      },
    );
    expect(await storage.readAccessToken(), isNull);
    expect(store.data.containsKey('vellum_refresh_token'), isFalse);
    expect(store.data['other_app_secret'], 'keep-me');
    await storage.writeAccessToken('new');
    // A later launch (marker present) keeps the session.
    final later = SecureAuthTokenStorage(
      storage: store,
      clearOnFirstLaunch: true,
      firstLaunchCheck: () async => false,
    );
    expect(await later.readAccessToken(), 'new');
  });

  test('a failing marker store never wipes the session', () async {
    final store = _MapStorage()..data['vellum_access_token'] = 'keep';
    final storage = SecureAuthTokenStorage(
      storage: store,
      clearOnFirstLaunch: true,
      firstLaunchCheck: () async => throw StateError('no prefs'),
    );
    expect(await storage.readAccessToken(), 'keep');
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

class _MapStorage implements SecureKeyValue {
  final Map<String, String> data = <String, String>{};
  @override
  Future<String?> read(String key) async => data[key];
  @override
  Future<void> write(String key, String value) async => data[key] = value;
  @override
  Future<void> delete(String key) async => data.remove(key);
}
