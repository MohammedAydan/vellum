/// Pluggable auth token storage interface and in-memory default implementation.
part of '../../vellum_flutter.dart';

/* -------------------------------------------------------------------------- */
/* End-user auth                                                              */
/* -------------------------------------------------------------------------- */

/// Storage seam for session material. The default keeps everything in memory;
/// production apps should provide a secure implementation. Hook example using
/// `flutter_secure_storage` (add `flutter_secure_storage: ^9.0.0` to pubspec):
///
/// ```dart
/// class SecureAuthTokenStorage implements AuthTokenStorage {
///   final FlutterSecureStorage _store = const FlutterSecureStorage();
///
///   Future<String?> readAccessToken() => _store.read(key: 'vellum_access_token');
///   Future<void> writeAccessToken(String? token) async => token == null
///       ? _store.delete(key: 'vellum_access_token')
///       : _store.write(key: 'vellum_access_token', value: token);
///   Future<String?> readRefreshToken() => _store.read(key: 'vellum_refresh_token');
///   Future<void> writeRefreshToken(String? token) async => token == null
///       ? _store.delete(key: 'vellum_refresh_token')
///       : _store.write(key: 'vellum_refresh_token', value: token);
///   Future<JsonMap?> readUser() async {
///     final raw = await _store.read(key: 'vellum_user');
///     if (raw == null) return null;
///     final Object? decoded = jsonDecode(raw);
///     return decoded is Map ? decoded.cast<String, Object?>() : null;
///   }
///   Future<void> writeUser(JsonMap? user) async => user == null
///       ? _store.delete(key: 'vellum_user')
///       : _store.write(key: 'vellum_user', value: jsonEncode(user));
/// }
/// ```
///
/// Pass it to `VellumClient(authTokenStorage: SecureAuthTokenStorage())` and call
/// `client.auth.restore()` during startup.
abstract class AuthTokenStorage implements TokenStoragePort {
  @override
  Future<String?> readAccessToken();

  @override
  Future<void> writeAccessToken(String? token);

  @override
  Future<String?> readRefreshToken();

  @override
  Future<void> writeRefreshToken(String? token);

  @override
  Future<JsonMap?> readUser();

  @override
  Future<void> writeUser(JsonMap? user);
}

/// Process-local session storage (never persists across app restarts).
class InMemoryAuthTokenStorage implements AuthTokenStorage {
  String? _accessToken;
  String? _refreshToken;
  JsonMap? _user;

  @override
  Future<String?> readAccessToken() async => _accessToken;

  @override
  Future<void> writeAccessToken(String? token) async {
    _accessToken = token;
  }

  @override
  Future<String?> readRefreshToken() async => _refreshToken;

  @override
  Future<void> writeRefreshToken(String? token) async {
    _refreshToken = token;
  }

  @override
  Future<JsonMap?> readUser() async =>
      _user == null ? null : Map<String, Object?>.from(_user!);

  @override
  Future<void> writeUser(JsonMap? user) async {
    _user = user == null ? null : Map<String, Object?>.from(user);
  }

  @override
  String toString() =>
      'InMemoryAuthTokenStorage(hasSession: ${_accessToken != null || _refreshToken != null})';
}

/// Process-wide defaults that companion packages can register (for example
/// `vellum_flutter_secure_storage`, which installs a platform keychain /
/// keystore backed session store). Nothing is registered by default, so the
/// package stays pure Dart and `InMemoryAuthTokenStorage` remains the fallback.
abstract final class VellumDefaults {
  /// Creates the session storage used when a client is built without
  /// `authStorage`. Must not throw; a throwing factory is ignored.
  static TokenStoragePort Function()? authStorageFactory;
}

TokenStoragePort _resolveDefaultAuthStorage() {
  final factory = VellumDefaults.authStorageFactory;
  if (factory != null) {
    try {
      return factory();
    } catch (_) {
      // Fall through to the in-memory default.
    }
  }
  return InMemoryAuthTokenStorage();
}
