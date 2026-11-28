import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart' as crypto;
import 'package:cryptography/cryptography.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../secure_storage/secure_auth_token_storage.dart' show SecureKeyValue;

/// Where encrypted offline blobs are kept. Defaults to SharedPreferences (works
/// on every platform including web). Only ciphertext is ever written here.
abstract interface class OfflineBlobStore {
  Future<String?> read(String key);
  Future<void> write(String key, String value);
  Future<void> delete(String key);
}

class SharedPrefsBlobStore implements OfflineBlobStore {
  const SharedPrefsBlobStore();
  @override
  Future<String?> read(String key) async =>
      (await SharedPreferences.getInstance()).getString(key);
  @override
  Future<void> write(String key, String value) async {
    await (await SharedPreferences.getInstance()).setString(key, value);
  }

  @override
  Future<void> delete(String key) async {
    await (await SharedPreferences.getInstance()).remove(key);
  }
}

/// Identifies one backend project: `sha256(endpoint | projectId)`. Cache and
/// outbox names, encryption keys and authenticated data all derive from it, so
/// data written for one project can never be read or replayed for another.
String vellumOfflineScope(String endpoint, String projectId) => crypto.sha256
    .convert(utf8.encode('$endpoint|$projectId'))
    .toString()
    .substring(0, 32);

/// AES-256-GCM encryption for offline data (cache and outbox).
///
/// One 256-bit key per [scope] is generated on the device and kept in the
/// platform secure store (Keychain, Keystore) through [SecureKeyValue].
/// A key is generated and stored only when the secure store was read
/// successfully and held no key. If reading fails (locked keychain, no keyring,
/// insecure web origin) the key lives in memory only and is never written: data
/// sealed in that session can not be read after a restart, so nothing readable
/// is left behind. Each blob binds scope and purpose as authenticated data, so a
/// blob copied between projects, users or stores fails to decrypt.
///
/// On web the key sits in browser storage next to the ciphertext, so encryption
/// adds no real protection there; the persistent features are off on web unless
/// you opt in.
class VellumEncryptedBox {
  VellumEncryptedBox({
    required SecureKeyValue keyStore,
    String keyName = 'vellum.offline.key.v1',
    Random? random,
  })  : _keyStore = keyStore,
        _keyName = keyName,
        _random = random ?? Random.secure();

  final SecureKeyValue _keyStore;
  final String _keyName;
  final Random _random;
  final AesGcm _algo = AesGcm.with256bits();
  // The Future is memoized, not the key, so two concurrent first calls can not
  // each generate a different key.
  final Map<String, Future<SecretKey>> _keys = <String, Future<SecretKey>>{};

  List<int> _bytes(int n) => List<int>.generate(n, (_) => _random.nextInt(256));

  Future<SecretKey> _loadKey(String scope) =>
      _keys[scope] ??= _createKey(scope);

  Future<SecretKey> _createKey(String scope) async {
    final name = '$_keyName.$scope';
    String? stored;
    var readOk = true;
    try {
      stored = await _keyStore.read(name);
    } catch (_) {
      readOk = false;
    }
    if (stored != null) {
      try {
        final decoded = base64Decode(stored);
        if (decoded.length == 32) return SecretKey(decoded);
      } catch (_) {}
    }
    final raw = _bytes(32);
    if (readOk) {
      try {
        await _keyStore.write(name, base64Encode(raw));
      } catch (_) {
        // Memory-only key: see the class comment.
      }
    }
    return SecretKey(raw);
  }

  List<int> _aad(String scope, String context) =>
      utf8.encode('$scope|$context');

  /// Returns `v1.<base64(nonce|cipher|mac)>`.
  Future<String> seal(
    String plaintext, {
    required String scope,
    required String context,
  }) async {
    final box = await _algo.encrypt(
      utf8.encode(plaintext),
      secretKey: await _loadKey(scope),
      nonce: _bytes(12),
      aad: _aad(scope, context),
    );
    return 'v1.${base64Encode(box.concatenation())}';
  }

  /// Returns null when the blob is malformed, was tampered with, was sealed for
  /// another scope or [context], or the key is gone.
  Future<String?> open(
    String sealed, {
    required String scope,
    required String context,
  }) async {
    if (!sealed.startsWith('v1.')) return null;
    try {
      final data = base64Decode(sealed.substring(3));
      final box =
          SecretBox.fromConcatenation(data, nonceLength: 12, macLength: 16);
      final clear = await _algo.decrypt(
        box,
        secretKey: await _loadKey(scope),
        aad: _aad(scope, context),
      );
      return utf8.decode(clear);
    } catch (_) {
      return null;
    }
  }

  /// Deletes the key for [scope]: everything sealed with it becomes unreadable.
  /// Runs on sign-out.
  Future<void> destroyKey(String scope) async {
    _keys.remove(scope);
    try {
      await _keyStore.delete('$_keyName.$scope');
    } catch (_) {}
  }
}
