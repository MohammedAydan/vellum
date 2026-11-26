/// Atomic and chunked write batch builders and OCC TransactionContext.
part of '../../vellum_flutter_core.dart';

/// Fluent bulk write builder supporting atomic [commit] and auto-chunked
/// [commitChunked] execution.
class VellumWriteBatch {
  final VellumClient client;
  final List<JsonMap> _writes = <JsonMap>[];

  VellumWriteBatch(this.client);

  int get length => _writes.length;
  bool get isEmpty => _writes.isEmpty;
  bool get isNotEmpty => _writes.isNotEmpty;
  List<JsonMap> get writes => List<JsonMap>.unmodifiable(_writes);

  /// Creates the document and fails the whole batch if it already exists.
  VellumWriteBatch create<T>(DocumentReference<T> ref, T value) {
    _writes.add(<String, Object?>{
      'type': 'create',
      'path': validateVellumPath(ref.path, requireEvenSegments: true),
      'data': ref.toJson(value),
    });
    return this;
  }

  /// [ifVersion] fails the whole batch with 412 when the stored version differs.
  /// [exists] `true` requires the document to exist, `false` requires it not to.
  VellumWriteBatch set<T>(
    DocumentReference<T> ref,
    T value, {
    bool merge = false,
    int? ifVersion,
    bool? exists,
  }) {
    _writes.add(<String, Object?>{
      'type': 'set',
      'path': validateVellumPath(ref.path, requireEvenSegments: true),
      'data': ref.toJson(value),
      'merge': merge,
      if (ifVersion != null) 'ifVersion': ifVersion,
      if (exists != null) 'exists': exists,
    });
    return this;
  }

  VellumWriteBatch update<T>(
    DocumentReference<T> ref,
    JsonMap patch, {
    int? ifVersion,
    bool? exists,
  }) {
    _writes.add(<String, Object?>{
      'type': 'update',
      'path': validateVellumPath(ref.path, requireEvenSegments: true),
      'data': patch,
      if (ifVersion != null) 'ifVersion': ifVersion,
      if (exists != null) 'exists': exists,
    });
    return this;
  }

  VellumWriteBatch delete<T>(
    DocumentReference<T> ref, {
    int? ifVersion,
    bool? exists,
  }) {
    _writes.add(<String, Object?>{
      'type': 'delete',
      'path': validateVellumPath(ref.path, requireEvenSegments: true),
      if (ifVersion != null) 'ifVersion': ifVersion,
      if (exists != null) 'exists': exists,
    });
    return this;
  }

  /// Submits all queued writes in a single atomic `/batchWrite` request.
  Future<JsonMap> commit({String? idempotencyKey}) =>
      client.batchWrite(List<JsonMap>.from(_writes),
          idempotencyKey: idempotencyKey);

  /// Submits all queued writes split into chunks of at most [chunkSize].
  Future<List<JsonMap>> commitChunked({
    int chunkSize = 100,
    String? idempotencyKeyPrefix,
  }) =>
      client.writeBatchChunked(
        List<JsonMap>.from(_writes),
        chunkSize: chunkSize,
        idempotencyKeyPrefix: idempotencyKeyPrefix,
      );
}

class TransactionContext {
  final VellumClient client;
  final String transactionToken;
  final List<JsonMap> stagedWrites = <JsonMap>[];

  TransactionContext({required this.client, required this.transactionToken});

  /// Reads [ref] inside the transaction. A missing document gives a snapshot
  /// with `exists == false` (version 0) instead of throwing, so the callback can
  /// branch on it and then [create] the document.
  Future<DocumentSnapshot<T>> get<T>(DocumentReference<T> ref) async {
    final encodedPath = encodeVellumPath(ref.path);
    final JsonMap res;
    try {
      res = await client.request(
        'GET',
        '/documents/$encodedPath?transactionToken=${Uri.encodeQueryComponent(transactionToken)}',
      );
    } on VellumException catch (err) {
      if (err.code == 'NOT_FOUND' || err.statusCode == 404) {
        return DocumentSnapshot<T>(
          id: ref.path.split('/').last,
          path: ref.path,
          version: 0,
          data: null,
        );
      }
      rethrow;
    }
    final rawData = (res['data'] as Map).cast<String, Object?>();
    return DocumentSnapshot<T>(
      id: res['documentId'] as String,
      path: res['path'] as String,
      version: (res['version'] as num).toInt(),
      data: ref.fromJson(rawData, res['documentId'] as String),
    );
  }

  /// Stages a write that fails the commit if the document already exists.
  void create<T>(DocumentReference<T> ref, T value) {
    stagedWrites.add({
      'type': 'create',
      'path': ref.path,
      'data': ref.toJson(value),
    });
  }

  void set<T>(DocumentReference<T> ref, T value, {bool merge = false}) {
    stagedWrites.add({
      'type': 'set',
      'path': ref.path,
      'data': ref.toJson(value),
      'merge': merge,
    });
  }

  void update<T>(DocumentReference<T> ref, JsonMap patch) {
    stagedWrites.add({
      'type': 'update',
      'path': ref.path,
      'data': patch,
    });
  }

  void delete<T>(DocumentReference<T> ref) {
    stagedWrites.add({
      'type': 'delete',
      'path': ref.path,
    });
  }

  @override
  String toString() =>
      'TransactionContext(transactionToken: <redacted>, stagedWrites: ${stagedWrites.length})';
}
