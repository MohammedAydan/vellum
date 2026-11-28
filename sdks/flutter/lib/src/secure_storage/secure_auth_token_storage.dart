import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:vellum_flutter/vellum_flutter_core.dart';

/// Minimal key/value surface the session store needs (a seam for tests).
abstract interface class SecureKeyValue {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

/// The session lives in the Keychain on Apple platforms, readable only after
/// the first unlock and never copied to another device or a backup. On Android
/// the plugin's current default (a Keystore-wrapped AES-GCM key) is used.
const FlutterSecureStorage _defaultSecureStore = FlutterSecureStorage(
  iOptions: IOSOptions(
    accessibility: KeychainAccessibility.first_unlock_this_device,
    synchronizable: false, // never synced to iCloud Keychain
  ),
  mOptions: MacOsOptions(
    accessibility: KeychainAccessibility.first_unlock_this_device,
    synchronizable: false,
  ),
);

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

/// The platform secure store as a [SecureKeyValue] (Keychain on Apple platforms,
/// Keystore-wrapped on Android). Used for the offline encryption key.
SecureKeyValue defaultSecureKeyValue() =>
    const _FlutterSecureKeyValue(_defaultSecureStore);

/// Session storage backed by the platform secure store, with a graceful
/// fallback: when the secure store is unavailable (no keyring on a Linux
/// session, an insecure web origin, a locked keychain, ...) the session is
/// kept in memory for the life of the process instead of failing the app.
class SecureAuthTokenStorage implements AuthTokenStorage {
  /// [firstLaunchCheck] resolves to true exactly once per install. The Keychain
  /// survives an uninstall on iOS and macOS, so a session left by a previous
  /// install would otherwise sign the user straight back in. The marker lives in
  /// SharedPreferences, which is removed with the app. Only this SDK's own keys
  /// are removed, never other Keychain items of your app.
  SecureAuthTokenStorage({
    SecureKeyValue? storage,
    String namespace = 'vellum',
    Future<bool> Function()? firstLaunchCheck,
    bool? clearOnFirstLaunch,
  })  : _store = storage ?? const _FlutterSecureKeyValue(_defaultSecureStore),
        _prefix = namespace,
        _firstLaunchCheck = firstLaunchCheck ??
            (storage == null
                ? (() => _sharedPrefsFirstLaunch(namespace))
                : null),
        _clearOnFirstLaunch = clearOnFirstLaunch ??
            (!kIsWeb &&
                (defaultTargetPlatform == TargetPlatform.iOS ||
                    defaultTargetPlatform == TargetPlatform.macOS));

  static Future<bool> _sharedPrefsFirstLaunch(String namespace) async {
    final prefs = await SharedPreferences.getInstance();
    final key = '${namespace}_install_marker';
    if (prefs.getBool(key) == true) return false;
    await prefs.setBool(key, true);
    return true;
  }

  final Future<bool> Function()? _firstLaunchCheck;
  final bool _clearOnFirstLaunch;
  Future<void>? _freshInstallGuard;

  Future<void> _ensureFreshInstall() =>
      _freshInstallGuard ??= _runFreshInstallGuard();

  Future<void> _runFreshInstallGuard() async {
    final check = _firstLaunchCheck;
    if (check == null) return;
    try {
      final first = await check();
      if (first && _clearOnFirstLaunch) {
        for (final key in <String>[_accessKey, _refreshKey, _userKey]) {
          await _store.delete(key);
        }
      }
    } catch (_) {
      // No marker store available (for example in a unit test): leave the session alone.
    }
  }

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
    await _ensureFreshInstall();
    if (_secureUnavailable) return null;
    try {
      return await _store.read(key);
    } catch (_) {
      _secureUnavailable = true;
      return null;
    }
  }

  Future<void> _write(String key, String? value) async {
    await _ensureFreshInstall();
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
