import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/foundation.dart';
import 'package:vellum_flutter/vellum_flutter_core.dart';

import 'encrypted_box.dart';

/// One queued write, as shown to [VellumOutbox.onDropped].
class VellumOutboxEntry {
  VellumOutboxEntry({
    required this.id,
    required this.method,
    required this.path,
    required this.body,
    required this.idempotencyKey,
    required this.userId,
    required this.createdAt,
    this.attempts = 0,
  });
  final String id;
  final String method;
  final String path;
  final JsonMap? body;
  final String idempotencyKey;
  final String userId;
  final DateTime createdAt;

  /// How many replays failed for a reason that may pass later.
  int attempts;
}

/// Why an entry left the queue without being applied.
enum VellumOutboxDropReason {
  /// The server refused it (400, 403 PERMISSION_DENIED, 404).
  rejected,

  /// The document changed meanwhile (409, 412): the write was based on old data.
  conflict,

  /// Older than [VellumOutbox.maxAge].
  expired,

  /// Queued by a different user than the one signed in.
  otherUser,

  /// Still failing after [VellumOutbox.maxAttempts] replays.
  failed,
}

/// Offline write queue. Writes made while offline are stored encrypted
/// (AES-256-GCM, key in the secure store) and replayed in order by [flush].
///
/// Security rules, all enforced here:
///  * Only document writes are accepted (`/documents/<path>` and `/batchWrite`).
///    Auth endpoints, transactions, reads, query strings, fragments, dot
///    segments and encoded separators (`%2e`, `%2f`, `%5c`) are refused, so no
///    password, token or code is ever queued and a path can not climb out of
///    `/documents`.
///  * Tokens and API keys are not stored: the client adds them at replay time.
///  * The queue is bound to the project (endpoint + project id) through the
///    name, key and authenticated data of the blob, and replays only through the
///    client it was created with.
///  * Each entry belongs to the user who made it. The signed-in user is checked
///    before every entry; a different user never replays it. Sign-out clears the
///    queue and destroys the key.
///  * Every entry carries an Idempotency-Key, so a replay after an unclear
///    failure can not apply a write twice inside the server's idempotency window
///    (24 hours). [maxAge] defaults to 23 hours for that reason: increments and
///    array transforms are not idempotent once that window has passed.
///  * Bounded: [maxEntries], [maxBodyBytes] per entry and [maxTotalBytes] in
///    all. A write that does not fit is refused with RESOURCE_EXHAUSTED; it is
///    never silently lost.
///
/// Replay outcomes: success removes the entry. 400, 403 PERMISSION_DENIED and
/// 404 drop it (`rejected`); 409 and 412 drop it as a `conflict`. Anything else
/// (network error, 401, 403 UNAUTHENTICATED, 408, 429, 5xx) stops the run and
/// keeps the entry; only 5xx answers count, and after [maxAttempts] of them the entry is dropped
/// as `failed`. Queued writes are last-writer-wins unless you pass `ifVersion`
/// (see [enqueueSet]); a stale `ifVersion` surfaces as a `conflict`.
///
/// On web the key is stored next to the data, so encryption adds no protection:
/// nothing is written to disk there unless you pass `allowWeb: true` (the queue
/// then only lives in memory).
class VellumOutbox {
  VellumOutbox({
    required this.client,
    required VellumEncryptedBox box,
    OfflineBlobStore? blobs,
    String namespace = 'vellum',
    this.maxEntries = 200,
    this.maxBodyBytes = 256 * 1024,
    int? maxTotalBytes,
    this.maxAge = const Duration(hours: 23),
    this.maxAttempts = 8,
    this.onDropped,
    this.autoFlushOnReconnect = true,
    this.autoFlushRetryBase = const Duration(seconds: 1),
    this.autoFlushRetryMax = const Duration(seconds: 30),
    @visibleForTesting Stream<VellumConnectionState>? connectionStates,
    bool allowWeb = false,
    Random? random,
    @visibleForTesting bool? isWeb,
  })  : _box = box,
        _blobs = blobs ?? const SharedPrefsBlobStore(),
        _scope = vellumOfflineScope(client.endpoint, client.projectId),
        _namespace = namespace,
        _persist = !(isWeb ?? kIsWeb) || allowWeb,
        maxTotalBytes = maxTotalBytes ?? ((isWeb ?? kIsWeb) ? 1024 * 1024 : 2 * 1024 * 1024),
        _random = random ?? Random.secure() {
    client.addSignOutHook(() async {
      await clear();
      await _box.destroyKey(_scope);
    });
    if (autoFlushOnReconnect) {
      try {
        _connectionSub = (connectionStates ?? client.connectionStateStream).listen(_onConnectionState);
      } catch (_) {
        // A client without a realtime layer simply never auto-flushes; flush() still works.
      }
    }
  }

  final VellumClient client;
  final VellumEncryptedBox _box;
  final OfflineBlobStore _blobs;
  final String _scope;
  final String _namespace;
  final bool _persist;
  final Random _random;
  final int maxEntries;
  final int maxBodyBytes;
  final int maxTotalBytes;
  final Duration maxAge;
  final int maxAttempts;
  final void Function(VellumOutboxEntry entry, VellumOutboxDropReason reason, Object? error)? onDropped;

  /// Drain the queue automatically whenever the realtime connection becomes `connected`
  /// (single-flight: overlapping triggers share one run). Set false to flush by hand.
  final bool autoFlushOnReconnect;

  /// First retry delay after an automatic flush left entries behind (doubles, with jitter, up to [autoFlushRetryMax]).
  final Duration autoFlushRetryBase;
  final Duration autoFlushRetryMax;

  StreamSubscription<VellumConnectionState>? _connectionSub;
  Timer? _retryTimer;
  bool _connected = false;
  int _retryAttempt = 0;

  final List<VellumOutboxEntry> _entries = <VellumOutboxEntry>[];
  bool _loaded = false;
  int _generation = 0;
  Future<void>? _flushing;
  Future<void> _lock = Future<void>.value();

  void _onConnectionState(VellumConnectionState next) {
    final isConnected = next.state == VellumRealtimeConnectionState.connected;
    final wasConnected = _connected;
    _connected = isConnected;
    if (!isConnected) {
      _retryTimer?.cancel();
      _retryTimer = null;
      return;
    }
    if (wasConnected) return; // `connected` fired twice in a row: one flush is enough.
    _retryAttempt = 0;
    unawaited(_autoFlush());
  }

  Future<void> _autoFlush() async {
    _retryTimer?.cancel();
    _retryTimer = null;
    try {
      await flush();
    } catch (_) {
      // Network and server failures keep the entries queued; the retry below handles them.
    }
    if (!_connected || _entries.isEmpty || client.auth.currentUser == null) return;
    // Entries are still pending while the connection is up: retry with exponential backoff and jitter.
    final exp = autoFlushRetryBase.inMilliseconds * (1 << (_retryAttempt < 10 ? _retryAttempt : 10));
    final capped = exp > autoFlushRetryMax.inMilliseconds ? autoFlushRetryMax.inMilliseconds : exp;
    final delay = Duration(milliseconds: (capped * (0.5 + _random.nextDouble() * 0.5)).floor() + 1);
    _retryAttempt++;
    _retryTimer = Timer(delay, () => unawaited(_autoFlush()));
  }

  /// Stops the automatic flush listener. Queued entries stay on disk.
  Future<void> dispose() async {
    _retryTimer?.cancel();
    _retryTimer = null;
    await _connectionSub?.cancel();
    _connectionSub = null;
  }

  String get _blobKey => '$_namespace.$_scope.offline.outbox.v1';
  String get _context => 'outbox';

  int get length => _entries.length;
  List<VellumOutboxEntry> get pending => List<VellumOutboxEntry>.unmodifiable(_entries);

  static final RegExp _badEncoded = RegExp(r'%(2e|2f|5c)', caseSensitive: false);

  static bool _allowed(String method, String path) {
    final m = method.toUpperCase();
    if (path == '/batchWrite') return m == 'POST';
    const prefix = '/documents/';
    if (!path.startsWith(prefix)) return false;
    if (!(m == 'POST' || m == 'PUT' || m == 'PATCH' || m == 'DELETE')) return false;
    if (path.contains('?') || path.contains('#') || path.contains('\\')) return false;
    if (_badEncoded.hasMatch(path)) return false;
    final segments = path.substring(prefix.length).split('/');
    if (segments.isEmpty) return false;
    for (final s in segments) {
      if (s.isEmpty || s == '.' || s == '..' || s.contains(':')) return false;
    }
    return true;
  }

  Future<T> _locked<T>(Future<T> Function() action) {
    final run = _lock.then((_) => action());
    _lock = run.then((_) {}, onError: (_) {});
    return run;
  }

  /// Reads the saved queue. Call it once, after the session user is known.
  Future<void> load() => _locked(_load);

  Future<void> _load() async {
    if (_loaded) return;
    _loaded = true;
    if (!_persist) return;
    final sealed = await _blobs.read(_blobKey);
    if (sealed == null) return;
    final clear = await _box.open(sealed, scope: _scope, context: _context);
    if (clear == null) {
      await _blobs.delete(_blobKey);
      return;
    }
    try {
      for (final raw in jsonDecode(clear) as List) {
        final e = (raw as Map).cast<String, Object?>();
        _entries.add(VellumOutboxEntry(
          id: e['id'] as String,
          method: e['m'] as String,
          path: e['p'] as String,
          body: e['b'] is Map ? (e['b'] as Map).cast<String, Object?>() : null,
          idempotencyKey: e['i'] as String,
          userId: e['u'] as String,
          createdAt: DateTime.parse(e['t'] as String),
          attempts: (e['a'] as num?)?.toInt() ?? 0,
        ));
      }
    } catch (_) {
      _entries.clear();
      await _blobs.delete(_blobKey);
    }
  }

  Future<void> _save() async {
    if (!_persist) return;
    if (_entries.isEmpty) {
      await _blobs.delete(_blobKey);
      return;
    }
    final json = jsonEncode(<Object?>[
      for (final e in _entries)
        <String, Object?>{
          'id': e.id,
          'm': e.method,
          'p': e.path,
          'b': e.body,
          'i': e.idempotencyKey,
          'u': e.userId,
          't': e.createdAt.toUtc().toIso8601String(),
          'a': e.attempts,
        },
    ]);
    await _blobs.write(_blobKey, await _box.seal(json, scope: _scope, context: _context));
  }

  int _bodySize(JsonMap? body) => body == null ? 0 : utf8.encode(jsonEncode(body)).length;

  String _id() => base64Url
      .encode(List<int>.generate(12, (_) => _random.nextInt(256)))
      .replaceAll('=', '');

  void _notify(VellumOutboxEntry entry, VellumOutboxDropReason reason, Object? error) {
    try {
      onDropped?.call(entry, reason, error);
    } catch (_) {
      // A throwing callback must not stall the queue.
    }
  }

  /// Queues a write for the signed-in user. Returns the entry (its
  /// `idempotencyKey` is generated unless you pass one).
  Future<VellumOutboxEntry> enqueue(
    String method,
    String path, {
    JsonMap? body,
    String? idempotencyKey,
  }) =>
      _locked(() async {
        await _load();
        final user = client.auth.currentUser;
        if (user == null) {
          throw const VellumException(
            code: 'UNAUTHENTICATED',
            message: 'Sign in before queueing offline writes',
            statusCode: 0,
          );
        }
        if (!_allowed(method, path)) {
          throw const VellumException(
            code: 'INVALID_ARGUMENT',
            message: 'Only document writes can be queued offline',
            statusCode: 0,
          );
        }
        final size = _bodySize(body);
        if (size > maxBodyBytes) {
          throw VellumException(
            code: 'RESOURCE_EXHAUSTED',
            message: 'Queued write is larger than $maxBodyBytes bytes',
            statusCode: 0,
          );
        }
        final total = _entries.fold<int>(0, (n, e) => n + _bodySize(e.body));
        if (_entries.length >= maxEntries || total + size > maxTotalBytes) {
          throw const VellumException(
            code: 'RESOURCE_EXHAUSTED',
            message: 'Offline queue is full',
            statusCode: 0,
          );
        }
        final entry = VellumOutboxEntry(
          id: _id(),
          method: method.toUpperCase(),
          path: path,
          body: body,
          idempotencyKey: idempotencyKey ?? 'ob_${_id()}',
          userId: user.id,
          createdAt: DateTime.now(),
        );
        _entries.add(entry);
        try {
          await _save();
        } catch (_) {
          _entries.remove(entry);
          throw const VellumException(
            code: 'RESOURCE_EXHAUSTED',
            message: 'Could not store the write on this device',
            statusCode: 0,
          );
        }
        return entry;
      });

  /// Queues `set` for [ref]. Pass [ifVersion] (the `version` of the snapshot the
  /// user saw) so a later change on the server is reported as a `conflict`
  /// instead of being overwritten.
  Future<VellumOutboxEntry> enqueueSet<T>(
    DocumentReference<T> ref,
    T value, {
    bool merge = false,
    int? ifVersion,
  }) =>
      enqueue('PUT', '/documents/${encodeVellumPath(ref.path)}', body: <String, Object?>{
        'data': replaceVellumDocumentReferences(ref.toJson(value)),
        'merge': merge,
        if (ifVersion != null) 'ifVersion': ifVersion,
      });

  /// Queues `update` for [ref], optionally guarded by [ifVersion].
  Future<VellumOutboxEntry> enqueueUpdate(
    DocumentReference<Object?> ref,
    JsonMap patch, {
    int? ifVersion,
  }) =>
      enqueue('PATCH', '/documents/${encodeVellumPath(ref.path)}', body: <String, Object?>{
        'data': replaceVellumDocumentReferences(expandVellumUpdatePaths(patch)),
        if (ifVersion != null) 'ifVersion': ifVersion,
      });

  /// Queues a delete. With [ifVersion] it goes through `/batchWrite`, since the
  /// delete route carries the version in a query string, which is not queueable.
  Future<VellumOutboxEntry> enqueueDelete(
    DocumentReference<Object?> ref, {
    int? ifVersion,
  }) {
    final path = validateVellumPath(ref.path, requireEvenSegments: true);
    if (ifVersion == null) {
      return enqueue('DELETE', '/documents/${encodeVellumPath(ref.path)}');
    }
    return enqueue('POST', '/batchWrite', body: <String, Object?>{
      'writes': <Object?>[
        <String, Object?>{'type': 'delete', 'path': path, 'ifVersion': ifVersion},
      ],
    });
  }

  /// Replays queued writes in order. Concurrent calls share one run. A
  /// [clear] (sign-out) stops a running replay.
  Future<void> flush() => _flushing ??= _locked(_flush).whenComplete(() => _flushing = null);

  static VellumOutboxDropReason? _dropReason(VellumException err) {
    switch (err.statusCode) {
      case 400:
      case 404:
        return VellumOutboxDropReason.rejected;
      case 403:
        return err.code == 'PERMISSION_DENIED' ? VellumOutboxDropReason.rejected : null;
      case 409:
      case 412:
        return VellumOutboxDropReason.conflict;
    }
    return null;
  }

  /// Saving after a replay must not make [flush] throw: the write already
  /// happened. A stale blob only means a repeat replay, which the idempotency
  /// key makes harmless.
  Future<void> _trySave() async {
    try {
      await _save();
    } catch (_) {}
  }

  Future<void> _flush() async {
    await _load();
    final generation = _generation;
    final startUser = client.auth.currentUser?.id;
    if (startUser == null) return;
    while (_entries.isNotEmpty) {
      if (generation != _generation) return;
      // The user can change while a replay is running: stop, never replay on.
      if (client.auth.currentUser?.id != startUser) return;
      final entry = _entries.first;
      if (entry.userId != startUser) {
        _entries.removeAt(0);
        _notify(entry, VellumOutboxDropReason.otherUser, null);
        await _trySave();
        continue;
      }
      if (DateTime.now().difference(entry.createdAt) > maxAge) {
        _entries.removeAt(0);
        _notify(entry, VellumOutboxDropReason.expired, null);
        await _trySave();
        continue;
      }
      Object? failure;
      try {
        await client.request(
          entry.method,
          entry.path,
          body: entry.body,
          idempotencyKey: entry.idempotencyKey,
        );
      } catch (err) {
        failure = err;
      }
      if (generation != _generation) return;
      if (failure == null) {
        _entries.removeAt(0);
        await _trySave();
        continue;
      }
      final reason = failure is VellumException ? _dropReason(failure) : null;
      if (reason != null) {
        _entries.removeAt(0);
        _notify(entry, reason, failure);
        await _trySave();
        continue;
      }
      // Keep it and stop. Only a server answer of 5xx counts as an attempt:
      // being offline, a signed-out session (401, 403 UNAUTHENTICATED), 408 and
      // 429 say nothing about the entry itself and must never make it expire.
      if (failure is VellumException && failure.statusCode >= 500) entry.attempts++;
      if (entry.attempts >= maxAttempts) {
        _entries.removeAt(0);
        _notify(entry, VellumOutboxDropReason.failed, failure);
      }
      await _trySave();
      return;
    }
  }

  /// Drops every queued write (called on sign-out) and stops a running replay.
  Future<void> clear() async {
    // Synchronous on purpose: it must not wait behind a replay that is waiting
    // on the network, and the running replay sees the new generation at once.
    _generation++;
    _loaded = true;
    _entries.clear();
    if (_persist) await _blobs.delete(_blobKey);
  }
}
