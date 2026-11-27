/// Fluent DocumentReference, Query, and CollectionReference builders with converter support.
part of '../../vellum_flutter_core.dart';

class DocumentReference<T> {
  final VellumClient client;
  final String path;
  final String id;
  final FromVellum<T> fromJson;
  final ToVellum<T> toJson;

  /// True when [id] was generated locally by `collection.doc()`. Reading such
  /// a reference before its first save yields a snapshot with `exists == false`.
  final bool autoId;

  const DocumentReference({
    required this.client,
    required this.path,
    required this.id,
    required this.fromJson,
    required this.toJson,
    this.autoId = false,
  });

  CollectionReference<JsonMap> collection(String subCollectionName) {
    final safeSub = validateVellumSegment(
      subCollectionName,
      context: 'subcollection name',
    );
    return client.collection('$path/$safeSub');
  }

  /// Reads the document. [include] accepts `'field'` shorthands or [VellumInclude]
  /// specs; [select] accepts dot paths. Both are sent as URL-encoded JSON query
  /// parameters (`?include=[...]&select=[...]`).
  Future<DocumentSnapshot<T>> get({
    List<Object>? include,
    List<String>? select,
    CachePolicy? cachePolicy,
  }) async {
    final store = client.documentCache;
    final policy = cachePolicy ?? client.cachePolicy;
    if (store == null || policy == CachePolicy.networkOnly) {
      return _fetch(include: include, select: select);
    }
    final scope = client.auth.currentUser?.id ?? 'anon';
    final key =
        '$scope\u0000$path\u0000${jsonEncode(include == null ? null : serializeIncludeRelations(include))}\u0000${jsonEncode(select)}';

    Future<CachedDocument?> readStored({required bool fresh}) async {
      try {
        final entry = await store.get(key);
        if (entry == null) return null;
        if (fresh &&
            DateTime.now().difference(entry.storedAt) > client.cacheTtl) {
          return null;
        }
        return entry;
      } catch (_) {
        return null;
      }
    }

    DocumentSnapshot<T> fromStore(CachedDocument entry) =>
        _snapshotFromResponse(entry.value, fromCache: true);

    if (policy == CachePolicy.cacheOnly) {
      final entry = await readStored(fresh: false);
      return entry != null
          ? fromStore(entry)
          : DocumentSnapshot<T>(
              id: id, path: path, version: 0, data: null, fromCache: true);
    }
    if (policy == CachePolicy.cacheFirst) {
      final entry = await readStored(fresh: true);
      if (entry != null) return fromStore(entry);
    }
    try {
      final snap = await _fetch(
          include: include, select: select, store: store, storeKey: key);
      return snap;
    } catch (error) {
      if (policy == CachePolicy.networkFirst && _isConnectivityFailure(error)) {
        final entry = await readStored(fresh: false);
        if (entry != null) return fromStore(entry);
      }
      rethrow;
    }
  }

  DocumentSnapshot<T> _snapshotFromResponse(
    Map<String, Object?> res, {
    bool fromCache = false,
  }) {
    final rawData = (res['data'] as Map).cast<String, Object?>();
    final rawIncluded = res['_included'];
    final rawRedacted = res['_redactedRefs'];
    return DocumentSnapshot<T>(
      id: res['documentId'] as String,
      path: res['path'] as String,
      version: (res['version'] as num).toInt(),
      data: fromJson(rawData, res['documentId'] as String),
      included: rawIncluded is Map ? rawIncluded.cast<String, Object?>() : null,
      redactedRefs:
          rawRedacted is List ? rawRedacted.whereType<String>().toList() : null,
      fromCache: fromCache,
    );
  }

  Future<DocumentSnapshot<T>> _fetch({
    List<Object>? include,
    List<String>? select,
    DocumentCacheStore? store,
    String? storeKey,
  }) async {
    final queryParams = <String, String>{};
    if (include != null && include.isNotEmpty) {
      queryParams['include'] = jsonEncode(serializeIncludeRelations(include));
    }
    if (select != null && select.isNotEmpty) {
      queryParams['select'] = jsonEncode(select);
    }
    final suffix = queryParams.isEmpty
        ? ''
        : '?${queryParams.entries.map((MapEntry<String, String> entry) => '${entry.key}=${Uri.encodeQueryComponent(entry.value)}').join('&')}';
    final encodedPath = encodeVellumPath(path);
    final authEpoch = client.auth.sessionEpoch;
    final Map<String, Object?> res;
    try {
      res = await client.request('GET', '/documents/$encodedPath$suffix');
    } on VellumException catch (error) {
      // A missing document is a normal result (exists == false), like the JS SDK.
      // A missing project is a real error and still throws.
      final missingDoc = error.statusCode == 404 &&
          (autoId ||
              (error.code == 'NOT_FOUND' &&
                  !RegExp(r'^Project\b', caseSensitive: false)
                      .hasMatch(error.message)));
      if (missingDoc) {
        return DocumentSnapshot<T>(id: id, path: path, version: 0, data: null);
      }
      rethrow;
    }
    final snap = _snapshotFromResponse(res);
    if (store != null &&
        storeKey != null &&
        authEpoch == client.auth.sessionEpoch) {
      unawaited(store
          .set(
            storeKey,
            CachedDocument(path: path, value: res, storedAt: DateTime.now()),
          )
          .catchError((Object _) {}));
    }
    if (authEpoch == client.auth.sessionEpoch &&
        (include == null || include.isEmpty) &&
        (select == null || select.isEmpty)) {
      client.setCachedDocument(path, snap);
    }
    return snap;
  }

  /// Creates or overwrites the document. `ttlSeconds` / `expiresAt` set expiry
  /// and `upsert` requests INSERT … ON CONFLICT DO UPDATE semantics.
  Future<void> set(
    T value, {
    bool merge = false,
    int? ifVersion,
    int? ttlSeconds,
    String? expiresAt,
    bool upsert = false,
    String? idempotencyKey,
  }) async {
    final encodedPath = encodeVellumPath(path);
    await client.request(
      'PUT',
      '/documents/$encodedPath',
      body: <String, Object?>{
        'data': replaceVellumDocumentReferences(toJson(value)),
        'merge': merge,
        if (ifVersion != null) 'ifVersion': ifVersion,
        if (ttlSeconds != null) 'ttlSeconds': ttlSeconds,
        if (expiresAt != null) 'expiresAt': expiresAt,
        if (upsert) 'upsert': true,
      },
      idempotencyKey: idempotencyKey,
    );
  }

  /// Creates the document only when it does not exist yet (POST create route).
  Future<void> create(
    T value, {
    int? ttlSeconds,
    String? expiresAt,
    String? idempotencyKey,
  }) async {
    final encodedPath = encodeVellumPath(path);
    await client.request(
      'POST',
      '/documents/$encodedPath',
      body: <String, Object?>{
        'data': replaceVellumDocumentReferences(toJson(value)),
        if (ttlSeconds != null) 'ttlSeconds': ttlSeconds,
        if (expiresAt != null) 'expiresAt': expiresAt,
      },
      idempotencyKey: idempotencyKey,
    );
  }

  /// Unconditional insert-or-update — an alias for `set(..., upsert: true)`.
  Future<void> upsert(
    T value, {
    bool merge = false,
    int? ifVersion,
    int? ttlSeconds,
    String? expiresAt,
    String? idempotencyKey,
  }) =>
      set(
        value,
        merge: merge,
        ifVersion: ifVersion,
        ttlSeconds: ttlSeconds,
        expiresAt: expiresAt,
        upsert: true,
        idempotencyKey: idempotencyKey,
      );

  Future<void> update(
    JsonMap data, {
    int? ifVersion,
    String? idempotencyKey,
  }) async {
    final encodedPath = encodeVellumPath(path);
    await client.request(
      'PATCH',
      '/documents/$encodedPath',
      body: {
        'data': replaceVellumDocumentReferences(expandVellumUpdatePaths(data)),
        if (ifVersion != null) 'ifVersion': ifVersion,
      },
      idempotencyKey: idempotencyKey,
    );
  }

  Future<void> delete({int? ifVersion, String? idempotencyKey}) async {
    final encodedPath = encodeVellumPath(path);
    final qs = ifVersion != null ? '?ifVersion=$ifVersion' : '';
    await client.request(
      'DELETE',
      '/documents/$encodedPath$qs',
      idempotencyKey: idempotencyKey,
    );
  }

  /// Permission-filtered reverse lookup: which documents reference this one.
  ///
  /// Wraps `POST /documents:referencedBy`. [collection] narrows the search to
  /// one collection and [field] to one reference field; [limit] is 1-100 per
  /// page and [cursor] continues a previous page. [select] projects dot paths
  /// and [include] eagerly resolves relations on the dependents (`'field'`
  /// shorthands or [VellumInclude] specs).
  ///
  /// Dependents are not this document's type, so results are raw maps; use
  /// [referencedByAs] to decode them into your own model. Keep paging while
  /// `page.nextCursor` is non-null, even after an empty page.
  Future<ReferencedByPage<JsonMap>> referencedBy({
    String? collection,
    String? field,
    int? limit,
    String? cursor,
    List<String>? select,
    List<Object>? include,
  }) =>
      referencedByAs<JsonMap>(
        fromVellum: _rawReferencedByData,
        collection: collection,
        field: field,
        limit: limit,
        cursor: cursor,
        select: select,
        include: include,
      );

  /// Typed variant of [referencedBy]: [fromVellum] decodes each dependent's
  /// data. Dependents are not this document's type, so the reference's own
  /// converter is never applied here.
  Future<ReferencedByPage<D>> referencedByAs<D>({
    required FromVellum<D> fromVellum,
    String? collection,
    String? field,
    int? limit,
    String? cursor,
    List<String>? select,
    List<Object>? include,
  }) async {
    final res = await client.request(
      'POST',
      '/documents:referencedBy',
      body: <String, Object?>{
        'targetPath': path,
        if (collection != null) 'collection': collection,
        if (field != null) 'field': field,
        if (limit != null) 'limit': limit,
        if (cursor != null) 'cursor': cursor,
        if (select != null && select.isNotEmpty) 'select': select,
        if (include != null && include.isNotEmpty)
          'include': serializeIncludeRelations(include),
      },
    );
    final rawDocs = res['documents'];
    final documents = rawDocs is List
        ? rawDocs
            .map((Object? raw) => snapshotFromWire<D>(raw, fromVellum))
            .whereType<DocumentSnapshot<D>>()
            .toList()
        : <DocumentSnapshot<D>>[];
    return ReferencedByPage<D>(
      documents: documents,
      nextCursor: res['nextCursor'] as String?,
    );
  }

  static JsonMap _rawReferencedByData(JsonMap data, String id) => data;

  /// Realtime stream of document snapshots over the native WebSocket transport.
  ///
  /// [resolveIncludes] opts into server-side relation resolution: [include]
  /// (`'field'` shorthands or [VellumInclude] specs, max 10, depth 1) is
  /// resolved point-in-time whenever this document changes. Resolved payloads
  /// land on `DocumentSnapshot.included`; targets hidden by security rules
  /// appear in `DocumentSnapshot.redactedRefs`. These are snapshots at event
  /// time, not a live join.
  Stream<DocumentSnapshot<T>> snapshots({
    bool resolveIncludes = false,
    List<Object>? include,
  }) {
    late StreamController<DocumentSnapshot<T>> controller;
    String? subId;
    // Dedupe (Track 3): the same (exists, version) is never delivered twice,
    // so a cached onListen snapshot and its identical initial_sync copy
    // collapse into one emission.
    bool? lastExists;
    int? lastVersion;

    void emit(DocumentSnapshot<T> snap) {
      if (controller.isClosed) return;
      if (lastExists == snap.exists && lastVersion == snap.version) return;
      lastExists = snap.exists;
      lastVersion = snap.version;
      controller.add(snap);
    }

    void handleFrame(JsonMap frame) {
      if (controller.isClosed) return;
      final type = frame['type'];
      if (type == 'initial_sync') {
        final docs = frame['documents'];
        var sawDoc = false;
        if (docs is List) {
          for (final raw in docs) {
            final snap = snapshotFromWire<T>(raw, fromJson);
            if (snap != null) {
              sawDoc = true;
              emit(snap);
            }
          }
        }
        // Missing document (Track 3): report exists == false instead of
        // staying silent, so listeners can distinguish "missing" from
        // "nothing received yet".
        if (!sawDoc) {
          emit(DocumentSnapshot<T>(id: id, path: path, version: 0, data: null));
        }
      } else if (type == 'mutation') {
        final wire = snapshotFromWire<T>(frame['document'], fromJson);
        if (wire != null && !controller.isClosed) {
          // A deleted document reports exists == false and data() == null.
          emit(frame['operation'] == 'delete'
              ? DocumentSnapshot<T>(
                  id: wire.id,
                  path: wire.path,
                  version: wire.version,
                  data: null,
                )
              : wire);
        }
      } else if (type == 'error') {
        final err = frame['error'] is Map
            ? (frame['error'] as Map).cast<String, Object?>()
            : frame;
        controller.addError(VellumException(
          code:
              err['code'] is String ? err['code'] as String : 'REALTIME_ERROR',
          message: err['message'] is String
              ? err['message'] as String
              : 'Realtime error',
          statusCode: 400,
        ));
      }
    }

    controller = StreamController<DocumentSnapshot<T>>.broadcast(
      onListen: () {
        final cached = client.getCachedDocument(path);
        if (cached != null &&
            cached is DocumentSnapshot<T> &&
            !controller.isClosed) {
          emit(cached);
        }
        subId = client.realtime.subscribe(
          <String, Object?>{
            'path': path,
            if (resolveIncludes) 'resolveIncludes': true,
            if (include != null && include.isNotEmpty)
              'include': serializeIncludeRelations(include),
          },
          handleFrame,
          (error) {
            if (!controller.isClosed) controller.addError(error);
          },
          onClose: () {
            if (!controller.isClosed) controller.close();
          },
        );
      },
      onCancel: () {
        final activeSubId = subId;
        if (activeSubId != null) client.realtime.unsubscribe(activeSubId);
        if (!controller.isClosed) controller.close();
      },
    );
    return controller.stream;
  }
}

class Query<T> {
  final VellumClient client;
  final String collectionPath;
  final FromVellum<T> fromJson;
  final ToVellum<T> toJson;
  final List<JsonMap> whereClauses;
  final List<Map<String, String>> orderByClauses;
  final int limitValue;
  final List<String>? selectFields;
  final String? startAtCursor;
  final String? startAfterCursor;
  final List<JsonMap> includeSpecs;
  final List<List<JsonMap>> orGroups;

  const Query({
    required this.client,
    required this.collectionPath,
    required this.fromJson,
    required this.toJson,
    this.whereClauses = const [],
    this.orderByClauses = const [],
    this.limitValue = 50,
    this.selectFields,
    this.startAtCursor,
    this.startAfterCursor,
    this.includeSpecs = const [],
    this.orGroups = const [],
  });

  /// Returns a copy with any of the immutable query attributes replaced.
  /// A `null` argument means "keep the current value".
  Query<T> _copy({
    List<JsonMap>? where,
    List<Map<String, String>>? orderBy,
    int? limit,
    List<String>? select,
    String? startAt,
    String? startAfter,
    List<JsonMap>? include,
    List<List<JsonMap>>? or,
  }) {
    return Query<T>(
      client: client,
      collectionPath: collectionPath,
      fromJson: fromJson,
      toJson: toJson,
      whereClauses: where ?? whereClauses,
      orderByClauses: orderBy ?? orderByClauses,
      limitValue: limit ?? limitValue,
      selectFields: select ?? selectFields,
      startAtCursor: startAt ?? startAtCursor,
      startAfterCursor: startAfter ?? startAfterCursor,
      includeSpecs: include ?? includeSpecs,
      orGroups: or ?? orGroups,
    );
  }

  /// Adds a filter. V2 operators `contains_ci`, `starts_with_ci` and
  /// `text_search` are passed straight through — there is no client whitelist.
  Query<T> where(String field, String op, Object? value) {
    return _copy(where: [
      ...whereClauses,
      <String, Object?>{'field': field, 'op': op, 'value': value},
    ]);
  }

  /// Adds disjunctive groups: each group is ANDed internally, groups are ORed.
  Query<T> or(List<List<JsonMap>> groups) {
    return _copy(or: <List<JsonMap>>[...orGroups, ...groups]);
  }

  /// Projects the given dot paths (e.g. `author.profile.name`).
  Query<T> select(List<String> fields) =>
      _copy(select: List<String>.unmodifiable(fields));

  /// Eagerly loads relations. Items may be `'field'` shorthands or [VellumInclude]s.
  Query<T> include(List<Object> relations) => _copy(include: <JsonMap>[
        ...includeSpecs,
        ...serializeIncludeRelations(relations)
      ]);

  Query<T> orderBy(String field, {String dir = 'asc'}) {
    return _copy(orderBy: [
      ...orderByClauses,
      <String, String>{'field': field, 'dir': dir},
    ]);
  }

  Query<T> limit(int limit) => _copy(limit: limit);

  Query<T> startAfter(String cursor) => _copy(startAfter: cursor);

  JsonMap toQuerySpec() => <String, Object?>{
        'collectionPath': collectionPath,
        'where': whereClauses,
        if (orGroups.isNotEmpty) 'or': orGroups,
        'orderBy': orderByClauses,
        'limit': limitValue,
        if (selectFields != null) 'select': selectFields,
        if (includeSpecs.isNotEmpty) 'include': includeSpecs,
        if (startAtCursor != null) 'startAt': startAtCursor,
        if (startAfterCursor != null) 'startAfter': startAfterCursor,
      };

  /// Canonical `QuerySpec` for the WebSocket `subscribe` frame.
  ///
  /// The WS contract nests the spec under `query`, expects `direction` (not
  /// `dir`) in order-by clauses and rejects opaque cursor strings inside
  /// `startAt`/`startAfter`. [toQuerySpec] is kept intact for the HTTP surface
  /// and SDK compatibility; this adapter translates it for the wire.
  JsonMap toRealtimeQuerySpec() {
    final spec = <String, Object?>{
      'collectionPath': collectionPath,
      'where': whereClauses,
      if (orGroups.isNotEmpty) 'or': orGroups,
      'orderBy': orderByClauses
          .map(
            (clause) => <String, Object?>{
              'field': clause['field'],
              'direction': clause['dir'] ?? 'asc',
            },
          )
          .toList(),
      'limit': limitValue,
      if (selectFields != null) 'select': selectFields,
      if (includeSpecs.isNotEmpty) 'include': includeSpecs,
    };
    return spec;
  }

  Future<QuerySnapshot<T>> get() async {
    final res = await client.request('POST', '/query', body: toQuerySpec());
    final rawDocs =
        (res['documents'] as List<Object?>).map(asStringDynamicMap).toList();
    final snapshots = rawDocs.map((d) {
      final dataMap = (d['data'] as Map).cast<String, Object?>();
      final id = d['documentId'] as String;
      final rawIncluded = d['_included'];
      final rawRedacted = d['_redactedRefs'];
      return DocumentSnapshot<T>(
        id: id,
        path: d['path'] as String,
        version: (d['version'] as num).toInt(),
        data: fromJson(dataMap, id),
        included:
            rawIncluded is Map ? rawIncluded.cast<String, Object?>() : null,
        redactedRefs: rawRedacted is List
            ? rawRedacted.whereType<String>().toList()
            : null,
      );
    }).toList();

    return QuerySnapshot<T>(
      docs: snapshots,
      nextCursor: res['nextCursor'] as String?,
      meta: (res['meta'] as Map?)?.cast<String, Object?>() ?? const {},
    );
  }

  /// Lazily streams cursor-paginated [QuerySnapshot] pages until exhausted or
  /// [maxPages] is reached.
  Stream<QuerySnapshot<T>> streamPages({int? pageSize, int? maxPages}) async* {
    if (pageSize != null && pageSize <= 0) {
      throw const VellumException(
        code: 'INVALID_ARGUMENT',
        message: 'pageSize must be greater than zero',
        statusCode: 400,
      );
    }
    if (maxPages != null && maxPages <= 0) return;

    var current = pageSize != null ? limit(pageSize) : this;
    var pagesFetched = 0;
    String? previousCursor;

    while (true) {
      final page = await current.get();
      yield page;
      pagesFetched++;

      if (maxPages != null && pagesFetched >= maxPages) break;
      final cursor = page.nextCursor;
      if (cursor == null || cursor.isEmpty || page.docs.isEmpty) break;
      if (cursor == previousCursor) break;

      previousCursor = cursor;
      current = current.startAfter(cursor);
    }
  }

  /// Lazily streams individual [DocumentSnapshot]s across all cursor pages.
  Stream<DocumentSnapshot<T>> streamDocuments({
    int? pageSize,
    int? maxPages,
  }) async* {
    await for (final page
        in streamPages(pageSize: pageSize, maxPages: maxPages)) {
      for (final doc in page.docs) {
        yield doc;
      }
    }
  }

  /// Runs a server-side aggregation via `POST /documents:aggregate`.
  ///
  /// Returns the whole response map (normally `{ rows: [...], executionTimeMs }`).
  Future<JsonMap> aggregate({
    List<String>? groupBy,
    required Map<String, AggregateMetric> metrics,
  }) async {
    final JsonMap res = await client.request(
      'POST',
      '/documents:aggregate',
      body: <String, Object?>{
        'collectionPath': collectionPath,
        if (whereClauses.isNotEmpty) 'where': whereClauses,
        if (orGroups.isNotEmpty) 'or': orGroups,
        if (groupBy != null && groupBy.isNotEmpty) 'groupBy': groupBy,
        'metrics': metrics.map<String, Object?>(
          (String name, AggregateMetric metric) =>
              MapEntry<String, Object?>(name, metric.toJson()),
        ),
      },
    );
    return asStringDynamicMap(res);
  }

  static List<JsonMap> _aggregateRows(JsonMap response) {
    final Object? rows = response['rows'];
    if (rows is! List) return const <JsonMap>[];
    return rows
        .whereType<Map<Object?, Object?>>()
        .map((Map<Object?, Object?> row) => row.cast<String, Object?>())
        .toList();
  }

  static num? _aggregateValue(JsonMap response, String name) {
    final List<JsonMap> rows = _aggregateRows(response);
    if (rows.isEmpty) return null;
    final Object? value = rows.first[name];
    if (value is num) return value;
    if (value is String) return num.tryParse(value);
    return null;
  }

  /// Counts matching documents. Returns `0` when the server returns no rows.
  Future<int> count() async {
    final JsonMap response = await aggregate(
      metrics: <String, AggregateMetric>{
        'count': const AggregateMetric.count()
      },
    );
    return _aggregateValue(response, 'count')?.toInt() ?? 0;
  }

  /// Sums a dot-path field across matching documents.
  Future<num?> sum(String field) async {
    final JsonMap response = await aggregate(
      metrics: <String, AggregateMetric>{'sum': AggregateMetric.sum(field)},
    );
    return _aggregateValue(response, 'sum');
  }

  /// Averages a dot-path field across matching documents.
  Future<num?> avg(String field) async {
    final JsonMap response = await aggregate(
      metrics: <String, AggregateMetric>{'avg': AggregateMetric.avg(field)},
    );
    return _aggregateValue(response, 'avg');
  }

  /// Deletes matching documents via `POST /documents:bulk-delete`.
  /// Returns the server-reported `deletedCount`.
  Future<int> deleteWhere({int limit = 1000}) async {
    final JsonMap res = await client.request(
      'POST',
      '/documents:bulk-delete',
      body: <String, Object?>{
        'collectionPath': collectionPath,
        if (whereClauses.isNotEmpty) 'where': whereClauses,
        if (orGroups.isNotEmpty) 'or': orGroups,
        'limit': limit,
      },
    );
    final Object? deleted = res['deletedCount'];
    return deleted is num ? deleted.toInt() : 0;
  }

  /// Realtime stream of query snapshots over the native WebSocket transport.
  ///
  /// [resolveIncludes] opts into server-side relation resolution: [include]
  /// (`'field'` shorthands or [VellumInclude] specs, max 10, depth 1) is
  /// resolved point-in-time on every emitted document. When omitted, the
  /// query's own `.include(...)` specs are reused. Resolved payloads land on
  /// `DocumentSnapshot.included`; targets hidden by security rules appear in
  /// `DocumentSnapshot.redactedRefs`. These are snapshots at event time, not
  /// a live join.
  Stream<QuerySnapshot<T>> snapshots({
    bool resolveIncludes = false,
    List<Object>? include,
  }) {
    late StreamController<QuerySnapshot<T>> controller;
    final docs = <DocumentSnapshot<T>>[];
    String? subId;

    void emit(List<DocumentChange<T>> changes, String? watermark) {
      if (controller.isClosed) return;
      controller.add(QuerySnapshot<T>(
        docs: List<DocumentSnapshot<T>>.unmodifiable(docs),
        changes: changes,
        watermarkSeqId: watermark,
      ));
    }

    void handleFrame(JsonMap frame) {
      if (controller.isClosed) return;
      final type = frame['type'];
      final seq = frame['seqId'];
      final watermark =
          seq is num ? seq.toString() : (seq is String ? seq : null);

      if (type == 'initial_sync') {
        docs.clear();
        final rawDocs = frame['documents'];
        final changes = <DocumentChange<T>>[];
        if (rawDocs is List) {
          for (final raw in rawDocs) {
            final snap = snapshotFromWire<T>(raw, fromJson);
            if (snap == null) continue;
            docs.add(snap);
            changes.add(DocumentChange<T>(
                type: 'added', seqId: watermark ?? '0', doc: snap));
          }
        }
        emit(changes, watermark);
      } else if (type == 'mutation') {
        final snap = snapshotFromWire<T>(frame['document'], fromJson);
        if (snap == null) return;
        final operation = frame['operation'];
        final changeType = operation == 'create'
            ? 'added'
            : operation == 'delete'
                ? 'removed'
                : 'modified';
        if (changeType == 'removed') {
          docs.removeWhere((doc) => doc.path == snap.path);
        } else {
          final index = docs.indexWhere((doc) => doc.path == snap.path);
          // Out-of-order events from concurrent writes: ignore an update that
          // is older than the version already held.
          // The same version again is a duplicate (an SSE reconnect or an
          // overlapping catch-up) and is not delivered twice.
          if ((operation == 'update' || operation == 'create') &&
              index >= 0 &&
              snap.version > 0 &&
              docs[index].version >= snap.version) {
            return;
          }
          if (index >= 0) {
            docs[index] = snap;
          } else {
            docs.add(snap);
          }
        }
        emit([
          DocumentChange<T>(
              type: changeType, seqId: watermark ?? '0', doc: snap)
        ], watermark);
      } else if (type == 'error') {
        final err = frame['error'] is Map
            ? (frame['error'] as Map).cast<String, Object?>()
            : frame;
        controller.addError(VellumException(
          code:
              err['code'] is String ? err['code'] as String : 'REALTIME_ERROR',
          message: err['message'] is String
              ? err['message'] as String
              : 'Realtime error',
          statusCode: 400,
        ));
      }
    }

    controller = StreamController<QuerySnapshot<T>>.broadcast(
      onListen: () {
        subId = client.realtime.subscribe(
          <String, Object?>{
            'query': toRealtimeQuerySpec(),
            if (resolveIncludes) 'resolveIncludes': true,
            if (include != null && include.isNotEmpty)
              'include': serializeIncludeRelations(include),
          },
          handleFrame,
          (error) {
            if (!controller.isClosed) controller.addError(error);
          },
          onClose: () {
            if (!controller.isClosed) controller.close();
          },
        );
      },
      onCancel: () {
        final activeSubId = subId;
        if (activeSubId != null) client.realtime.unsubscribe(activeSubId);
        if (!controller.isClosed) controller.close();
      },
    );
    return controller.stream;
  }
}

class CollectionReference<T> extends Query<T> {
  const CollectionReference({
    required super.client,
    required super.collectionPath,
    required super.fromJson,
    required super.toJson,
  });

  /// Type-safe converter (`withConverter<T>()`) for Dart domain models
  CollectionReference<R> withConverter<R>({
    required FromVellum<R> fromVellum,
    required ToVellum<R> toVellum,
  }) {
    return CollectionReference<R>(
      client: client,
      collectionPath: collectionPath,
      fromJson: fromVellum,
      toJson: toVellum,
    );
  }

  /// Addresses a document. Without [documentId] a unique, time-sortable ID is
  /// generated locally (no network request); the document is created on `set()`.
  DocumentReference<T> doc([String? documentId]) {
    final isAuto = documentId == null;
    final safeId = validateVellumSegment(
      documentId ?? generateVellumAutoId(),
      context: 'document ID',
    );
    return DocumentReference<T>(
      autoId: isAuto,
      client: client,
      path: '$collectionPath/$safeId',
      id: safeId,
      fromJson: fromJson,
      toJson: toJson,
    );
  }

  /// Creates a document with an auto-generated ID and returns its reference.
  Future<DocumentReference<T>> add(T value, {String? idempotencyKey}) async {
    final ref = doc();
    await ref.create(value, idempotencyKey: idempotencyKey);
    return ref;
  }

  /// Creates a document and its related documents in ONE atomic request.
  ///
  /// [related] maps a field on the parent to the child collection and docs.
  /// The parent gets `field: [ref, ...]`; each child gets a `parentField`
  /// reference back to the parent when set. Either everything is written or
  /// nothing is. At most 500 documents per call.
  Future<DocumentReference<T>> addWithRelated(
    T value,
    Map<String, RelatedWrite> related, {
    String? idempotencyKey,
  }) async {
    final parent = doc();
    final parentData = <String, Object?>{
      ...(replaceVellumDocumentReferences(toJson(value)) as Map)
          .cast<String, Object?>(),
    };
    final writes = <JsonMap>[];
    related.forEach((field, spec) {
      final collection =
          validateVellumSegment(spec.collection, context: 'related collection');
      final refs = <Object?>[];
      for (final child in spec.docs) {
        final childPath = '$collection/${generateVellumAutoId()}';
        refs.add(VellumWire.reference(childPath));
        writes.add(<String, Object?>{
          'type': 'set',
          'path': childPath,
          'data': <String, Object?>{
            ...(replaceVellumDocumentReferences(child) as Map)
                .cast<String, Object?>(),
            if (spec.parentField != null)
              spec.parentField!: VellumWire.reference(parent.path),
          },
        });
      }
      parentData[field] = refs;
    });
    writes.insert(0, <String, Object?>{
      'type': 'set',
      'path': parent.path,
      'data': parentData,
    });
    if (writes.length > 100) {
      throw ArgumentError(
          'addWithRelated supports at most 100 documents per call (the batch write limit)');
    }
    await client.batchWrite(writes, idempotencyKey: idempotencyKey);
    return parent;
  }
}

/// One group of related documents for [CollectionReference.addWithRelated].
class RelatedWrite {
  /// Collection the related documents are created in.
  final String collection;

  /// Documents to create (may contain [DocumentReference] values).
  final List<JsonMap> docs;

  /// Optional field on each child that references the new parent document.
  final String? parentField;

  const RelatedWrite({
    required this.collection,
    required this.docs,
    this.parentField,
  });
}

/// Replaces [DocumentReference] values in write data with the tagged
/// reference wire value, so `{'customer': client.doc('users/u1')}` works.
Object? replaceVellumDocumentReferences(Object? value, [int depth = 0]) {
  if (value is DocumentReference) return VellumWire.reference(value.path);
  if (depth >= 32) return value;
  if (value is List) {
    return <Object?>[
      for (final item in value)
        replaceVellumDocumentReferences(item, depth + 1),
    ];
  }
  if (value is Map) {
    return <String, Object?>{
      for (final entry in value.entries)
        entry.key as String:
            replaceVellumDocumentReferences(entry.value, depth + 1),
    };
  }
  return value;
}

/// `update()` treats a top-level key with dots as a path into a nested map:
/// `{'profile.name': 'Ada'}` changes only `profile.name`. Without this the server
/// would store a literal key named "profile.name" next to the nested map.
JsonMap expandVellumUpdatePaths(JsonMap data) {
  if (!data.keys.any((k) => k.contains('.'))) return data;
  const forbidden = <String>{'__proto__', 'constructor', 'prototype'};
  Map<String, Object?> merge(Map<String, Object?> a, Map<String, Object?> b) {
    final out = <String, Object?>{...a};
    b.forEach((k, v) {
      final cur = out[k];
      out[k] = cur is Map<String, Object?> && v is Map<String, Object?>
          ? merge(cur, v)
          : v;
    });
    return out;
  }

  final out = <String, Object?>{};
  data.forEach((key, value) {
    if (!key.contains('.')) {
      final existing = out[key];
      out[key] =
          existing is Map<String, Object?> && value is Map<String, Object?>
              ? merge(existing, value)
              : value;
      return;
    }
    final parts = key.split('.');
    if (parts.any((p) => p.isEmpty || forbidden.contains(p))) {
      throw ArgumentError.value(key, 'key', 'Invalid field path in update()');
    }
    var cursor = out;
    for (var i = 0; i < parts.length - 1; i++) {
      final next = cursor[parts[i]];
      if (next is Map<String, Object?>) {
        cursor = next;
      } else {
        final created = <String, Object?>{};
        cursor[parts[i]] = created;
        cursor = created;
      }
    }
    cursor[parts.last] = value;
  });
  return out;
}
