import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

/// Minimal key/value surface the session store needs (a seam for tests).
abstract interface class SecureKeyValue {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class _FlutterSecureKeyValue implements SecureKeyValue {
  const _FlutterSecureKeyValue(this._store);
  final FlutterSecureStorage _store;

  @override
  Future<String?> read(String key) => _store.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _store.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _store.delete(key: key);
}

/// Session storage backed by the platform secure store, with a graceful
/// fallback: when the secure store is unavailable (no keyring on a Linux
/// session, an insecure web origin, a locked keychain, ...) the session is
/// kept in memory for the life of the process instead of failing the app.
class SecureAuthTokenStorage implements AuthTokenStorage {
  SecureAuthTokenStorage({SecureKeyValue? storage, String namespace = 'vellum'})
      : _store = storage ?? const _FlutterSecureKeyValue(FlutterSecureStorage()),
        _prefix = namespace;

  final SecureKeyValue _store;
  final String _prefix;
  final InMemoryAuthTokenStorage _memory = InMemoryAuthTokenStorage();
  bool _secureUnavailable = false;

  /// True once the secure store failed and the in-memory fallback is in use.
  bool get usingFallback => _secureUnavailable;

  String get _accessKey => '${_prefix}_access_token';
  String get _refreshKey => '${_prefix}_refresh_token';
  String get _userKey => '${_prefix}_user';

  Future<String?> _read(String key) async {
    if (_secureUnavailable) return null;
    try {
      return await _store.read(key);
    } catch (_) {
      _secureUnavailable = true;
      return null;
    }
  }

  Future<void> _write(String key, String? value) async {
    if (_secureUnavailable) return;
    try {
      if (value == null) {
        await _store.delete(key);
      } else {
        await _store.write(key, value);
      }
    } catch (_) {
      _secureUnavailable = true;
    }
  }

  @override
  Future<String?> readAccessToken() async =>
      await _read(_accessKey) ?? await _memory.readAccessToken();

  @override
  Future<void> writeAccessToken(String? token) async {
    await _memory.writeAccessToken(token);
    await _write(_accessKey, token);
  }

  @override
  Future<String?> readRefreshToken() async =>
      await _read(_refreshKey) ?? await _memory.readRefreshToken();

  @override
  Future<void> writeRefreshToken(String? token) async {
    await _memory.writeRefreshToken(token);
    await _write(_refreshKey, token);
  }

  @override
  Future<JsonMap?> readUser() async {
    final raw = await _read(_userKey);
    if (raw != null) {
      try {
        final Object? decoded = jsonDecode(raw);
        if (decoded is Map) return decoded.cast<String, Object?>();
      } catch (_) {
        // Corrupt entry: fall through to the in-memory copy.
      }
    }
    return _memory.readUser();
  }

  @override
  Future<void> writeUser(JsonMap? user) async {
    await _memory.writeUser(user);
    await _write(_userKey, user == null ? null : jsonEncode(user));
  }
}
