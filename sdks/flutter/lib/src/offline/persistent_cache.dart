import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:vellum_flutter/vellum_flutter_core.dart';

import 'encrypted_box.dart';

/// A [DocumentCacheStore] that survives restarts. Reads are served from a
/// bounded in-memory LRU; the whole set is written encrypted (AES-256-GCM, key
/// in the secure store) to [OfflineBlobStore], debounced, never as plain text.
///
/// The blob is bound to the project (endpoint + project id) and to the signed-in
/// user: a different project or user can not read it, and a mismatching blob is
/// deleted. Usage:
///
/// ```dart
/// final cache = PersistentDocumentCacheStore(box: box);
/// final db = VellumClient(..., cacheStore: cache);
/// cache.attach(db);
/// await db.auth.restore();
/// await cache.load(); // only once the user is known
/// ```
///
/// The whole set is sealed in one piece on the main isolate, so the write is
/// debounced (5 seconds by default) and the cache is capped at 2 MB: sealing
/// costs roughly 100 ms per MB in a debug build. Call [flush] when the app is
/// paused so nothing is lost.
///
/// Cached documents stay readable offline for up to [maxEntryAge] even if the
/// security rules change on the server in the meantime.
///
/// On web the key is stored next to the data, so encryption adds no protection:
/// the store keeps nothing on disk there unless you pass `allowWeb: true`.
class PersistentDocumentCacheStore implements DocumentCacheStore {
  PersistentDocumentCacheStore({
    required VellumEncryptedBox box,
    OfflineBlobStore? blobs,
    String namespace = 'vellum',
    int maxBytes = 2 * 1024 * 1024,
    this.maxEntryAge = const Duration(days: 14),
    Duration saveDelay = const Duration(seconds: 5),
    bool allowWeb = false,
    @visibleForTesting bool? isWeb,
  })  : _box = box,
        _blobs = blobs ?? const SharedPrefsBlobStore(),
        _namespace = namespace,
        _saveDelay = saveDelay,
        _persist = !(isWeb ?? kIsWeb) || allowWeb,
        _memory = MemoryDocumentCacheStore(maxBytes: maxBytes);

  final VellumEncryptedBox _box;
  final OfflineBlobStore _blobs;
  final String _namespace;
  final Duration _saveDelay;
  final bool _persist;
  final MemoryDocumentCacheStore _memory;

  /// Entries older than this are dropped on load.
  final Duration maxEntryAge;
  Timer? _timer;
  VellumClient? _client;
  String _scope = '';
  String? _ownerUid; // who the mirror content belongs to
  final Map<String, CachedDocument> _mirror = <String, CachedDocument>{};

  String get _blobKey => '$_namespace.$_scope.offline.cache.v1';
  String? get _userId => _client?.auth.currentUser?.id;
  String _context(String uid) => 'cache:$uid';

  /// Binds the store to [client]'s project and user, and registers the sign-out
  /// cleanup (the blob is deleted and its key destroyed).
  void attach(VellumClient client) {
    _client = client;
    _scope = vellumOfflineScope(client.endpoint, client.projectId);
    client.addSignOutHook(() async {
      await clear();
      await _box.destroyKey(_scope);
    });
  }

  /// Restores the saved cache. Call it after the session user is known; with no
  /// signed-in user nothing is loaded.
  Future<void> load() async {
    if (_client == null) {
      throw StateError('Call attach(client) before load()');
    }
    final uid = _userId;
    if (!_persist || uid == null) return;
    _ownerUid = uid;
    final sealed = await _blobs.read(_blobKey);
    if (sealed == null) return;
    final clear = await _box.open(sealed, scope: _scope, context: _context(uid));
    if (clear == null) {
      // Other user, other project, lost key or tampered: start clean.
      await _blobs.delete(_blobKey);
      return;
    }
    try {
      final list = jsonDecode(clear) as List;
      final cutoff = DateTime.now().subtract(maxEntryAge);
      for (final raw in list) {
        final e = (raw as Map).cast<String, Object?>();
        final storedAt = DateTime.parse(e['t'] as String);
        if (storedAt.isBefore(cutoff)) continue;
        final doc = CachedDocument(
          path: e['p'] as String,
          value: (e['v'] as Map).cast<String, Object?>(),
          storedAt: storedAt,
        );
        final key = e['k'] as String;
        await _memory.set(key, doc);
        _mirror[key] = doc;
      }
    } catch (_) {
      await _blobs.delete(_blobKey);
      _mirror.clear();
      await _memory.clear();
    }
  }

  void _scheduleSave() {
    if (!_persist) return;
    _timer?.cancel();
    _timer = Timer(_saveDelay, () async {
      try {
        await flush();
      } catch (_) {
        // A full disk or a storage quota must never crash the app.
      }
    });
  }

  Future<List<Map<String, Object?>>> _live() async {
    final live = <Map<String, Object?>>[];
    for (final key in _mirror.keys.toList()) {
      final doc = await _memory.get(key);
      if (doc == null) {
        _mirror.remove(key);
        continue;
      }
      live.add(<String, Object?>{
        'k': key,
        'p': doc.path,
        'v': doc.value,
        't': doc.storedAt.toUtc().toIso8601String(),
      });
    }
    return live;
  }

  /// Writes the current content now (also called by the debounce timer). With
  /// no signed-in user nothing is written. If the write fails (storage full),
  /// the older half is dropped and it is tried once more.
  Future<void> flush() async {
    _timer?.cancel();
    final uid = _userId;
    if (!_persist || _client == null || uid == null) return;
    // Content filled under another user must never be written under this one.
    if (_ownerUid != null && _ownerUid != uid) return;
    var live = await _live();
    if (live.isEmpty) {
      await _blobs.delete(_blobKey);
      return;
    }
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        await _blobs.write(
          _blobKey,
          await _box.seal(jsonEncode(live), scope: _scope, context: _context(uid)),
        );
        return;
      } catch (_) {
        if (attempt == 1) rethrow;
        live = live.sublist(live.length ~/ 2);
        if (live.isEmpty) return;
      }
    }
  }

  @override
  Future<CachedDocument?> get(String key) => _memory.get(key);

  @override
  Future<void> set(String key, CachedDocument entry) async {
    final uid = _userId;
    if (_ownerUid != null && uid != _ownerUid) {
      // The session changed under us: drop what the previous user cached.
      await _memory.clear();
      _mirror.clear();
    }
    _ownerUid = uid;
    await _memory.set(key, entry);
    _mirror[key] = entry;
    _scheduleSave();
  }

  @override
  Future<void> deletePath(String path) async {
    await _memory.deletePath(path);
    _mirror.removeWhere((_, d) => d.path == path);
    _scheduleSave();
  }

  @override
  Future<void> deletePrefix(String prefix) async {
    await _memory.deletePrefix(prefix);
    _mirror.removeWhere((_, d) => d.path.startsWith(prefix));
    _scheduleSave();
  }

  @override
  Future<void> clear() async {
    _timer?.cancel();
    await _memory.clear();
    _mirror.clear();
    _ownerUid = null;
    if (_persist && _client != null) await _blobs.delete(_blobKey);
  }
}
