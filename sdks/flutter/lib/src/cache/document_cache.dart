/// Offline document cache: read policies plus a byte-bounded LRU store.
///
/// Pure Dart, so it works on Android, iOS, web and desktop. The default store is
/// in memory; implement [DocumentCacheStore] to persist to disk (for example
/// with sqflite, drift or Hive) without any other change.
part of '../../vellum_flutter.dart';

/// How document reads use the offline cache.
enum CachePolicy {
  /// Fetch from the network; on connectivity failure serve the stored copy
  /// (with `snapshot.fromCache == true`). This is the default.
  networkFirst,

  /// Use a fresh stored copy, otherwise fetch.
  cacheFirst,

  /// Never read the cache.
  networkOnly,

  /// Only the cache; a miss gives a snapshot with `exists == false`.
  cacheOnly,
}

/// A stored document response.
class CachedDocument {
  final String path;
  final Map<String, Object?> value;
  final DateTime storedAt;

  const CachedDocument({
    required this.path,
    required this.value,
    required this.storedAt,
  });
}

/// Storage behind [CachePolicy]. Implement this to persist to disk.
abstract class DocumentCacheStore {
  Future<CachedDocument?> get(String key);
  Future<void> set(String key, CachedDocument entry);

  /// Removes every entry stored for [path] (all users and select/include variants).
  Future<void> deletePath(String path);

  /// Removes every entry whose path starts with [prefix].
  Future<void> deletePrefix(String prefix);
  Future<void> clear();
}

/// Default byte-bounded LRU store (100 MB unless [maxBytes] is set).
class MemoryDocumentCacheStore implements DocumentCacheStore {
  final int maxBytes;
  // LinkedHashMap keeps insertion order: first key is least recently used.
  final Map<String, CachedDocument> _entries = <String, CachedDocument>{};
  final Map<String, int> _sizes = <String, int>{};
  int _bytes = 0;

  MemoryDocumentCacheStore({this.maxBytes = 100 * 1024 * 1024});

  int get length => _entries.length;
  int get sizeBytes => _bytes;

  @override
  Future<CachedDocument?> get(String key) async {
    final entry = _entries.remove(key);
    if (entry == null) return null;
    _entries[key] = entry;
    return entry;
  }

  @override
  Future<void> set(String key, CachedDocument entry) async {
    _remove(key);
    final size =
        (jsonEncode(entry.value).length + key.length + entry.path.length) * 2 +
            64;
    _entries[key] = entry;
    _sizes[key] = size;
    _bytes += size;
    while (_bytes > maxBytes && _entries.length > 1) {
      final oldest = _entries.keys.first;
      if (oldest == key) break;
      _remove(oldest);
    }
  }

  @override
  Future<void> deletePath(String path) async => _removeWhere((p) => p == path);

  @override
  Future<void> deletePrefix(String prefix) async =>
      _removeWhere((p) => p.startsWith(prefix));

  @override
  Future<void> clear() async {
    _entries.clear();
    _sizes.clear();
    _bytes = 0;
  }

  void _removeWhere(bool Function(String path) test) {
    final keys = <String>[
      for (final e in _entries.entries)
        if (test(e.value.path)) e.key,
    ];
    keys.forEach(_remove);
  }

  void _remove(String key) {
    if (_entries.remove(key) != null) {
      _bytes -= _sizes.remove(key) ?? 0;
    }
  }
}

/// True for network-level failures and gateway errors, not for API answers
/// such as 404 or 403 (those must never be masked by stored data).
bool _isConnectivityFailure(Object error) {
  if (error is VellumException) {
    final s = error.statusCode;
    return s == 0 || s == 502 || s == 503 || s == 504;
  }
  if (error is StateError || error is ArgumentError) return false;
  return true;
}
