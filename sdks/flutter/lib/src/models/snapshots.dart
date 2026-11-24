/// Immutable document/query snapshots, relation/aggregation specs, index advisor, and collection models.
part of '../../vellum_flutter_core.dart';

/// A declarative eager-loaded relation (`include`) for documents and queries.
///
/// Mirrors the wire `IncludeSpec`: `field` is the relation field on the parent
/// document, `collection` optionally overrides the target collection, `as`
/// renames the key under `_included`, and `select` / `include` project or
/// recursively expand the related document.
class VellumInclude {
  final String field;
  final String? collection;
  final String? as;
  final List<String>? select;
  final List<VellumInclude>? include;

  const VellumInclude({
    required this.field,
    this.collection,
    this.as,
    this.select,
    this.include,
  });

  JsonMap toJson() => <String, Object?>{
        'field': field,
        if (collection != null) 'collection': collection!,
        if (as != null) 'as': as!,
        if (select != null) 'select': select!,
        if (include != null && include!.isNotEmpty)
          'include': include!.map((VellumInclude item) => item.toJson()).toList(),
      };
}

/// A single named server-side aggregation used by `Query.aggregate`.
class AggregateMetric {
  final String op;
  final String? field;

  const AggregateMetric({required this.op, this.field});

  const AggregateMetric.count() : op = 'count', field = null;
  const AggregateMetric.sum(String this.field) : op = 'sum';
  const AggregateMetric.avg(String this.field) : op = 'avg';
  const AggregateMetric.min(String this.field) : op = 'min';
  const AggregateMetric.max(String this.field) : op = 'max';

  JsonMap toJson() => <String, Object?>{
        'op': op,
        if (field != null) 'field': field!,
      };
}

/// Immutable Document Snapshot
class DocumentSnapshot<T> {
  final String id;
  final String path;
  final int version;
  final DateTime? createdAt;
  final DateTime? updatedAt;
  final T? _data;
  final JsonMap? _included;
  final List<String>? _redactedRefs;

  /// True when this snapshot was served from the offline cache.
  final bool fromCache;

  const DocumentSnapshot({
    required this.id,
    required this.path,
    required this.version,
    this.createdAt,
    this.updatedAt,
    required T? data,
    JsonMap? included,
    List<String>? redactedRefs,
    this.fromCache = false,
  })  : _data = data,
        _included = included,
        _redactedRefs = redactedRefs;

  bool get exists => _data != null;
  T? data() => _data;

  /// Eagerly-loaded relations returned under the response's `_included` key.
  JsonMap get included => _included == null
      ? const <String, Object?>{}
      : Map<String, Object?>.unmodifiable(_included);

  /// Document paths the server redacted for security-rule reasons.
  List<String> get redactedRefs => _redactedRefs == null
      ? const <String>[]
      : List<String>.unmodifiable(_redactedRefs);
}

/// One page of reverse-lookup (`POST /documents:referencedBy`) results.
///
/// [documents] are the dependents that reference the target document;
/// [nextCursor] is an opaque continuation token. Keep paging while
/// [nextCursor] is non-null, even after an empty page.
class ReferencedByPage<D> {
  final List<DocumentSnapshot<D>> documents;
  final String? nextCursor;

  const ReferencedByPage({required this.documents, this.nextCursor});
}

/// Realtime Document Change Event (`added`, `modified`, `removed`)
class DocumentChange<T> {
  final String type;
  final String seqId;
  final DocumentSnapshot<T> doc;

  const DocumentChange({
    required this.type,
    required this.seqId,
    required this.doc,
  });
}

/// Query Snapshot returned by `.get()` and emitted on `snapshots()`
class QuerySnapshot<T> {
  final List<DocumentSnapshot<T>> docs;
  final List<DocumentChange<T>> changes;
  final String? nextCursor;
  final String? watermarkSeqId;
  final JsonMap meta;

  const QuerySnapshot({
    required this.docs,
    this.changes = const [],
    this.nextCursor,
    this.watermarkSeqId,
    this.meta = const {},
  });
}

typedef FromVellum<T> = T Function(JsonMap data, String id);
typedef ToVellum<T> = JsonMap Function(T value);

/// A transport returns decoded JSON of any shape: object, array, scalar or null.
typedef HttpTransport = Future<Object?> Function(
  String method,
  String url,
  Map<String, String> headers,
  JsonMap? body,
);

/// A decoded response body together with its HTTP response headers.
///
/// Transports may return this instead of a bare body. [requestMap] recognizes
/// it, feeds the headers to the index advisor, and returns the decoded body.
/// Returning a plain body remains fully supported for backwards compatibility.
class VellumHttpResponse {
  final Object? body;
  final Map<String, String> headers;

  const VellumHttpResponse({
    required this.body,
    this.headers = const <String, String>{},
  });
}

/// A normalized index suggestion delivered to [IndexSuggestionCallback]s.
class VellumIndexSuggestion {
  final String fingerprint;
  final String? url;
  final String reason;
  final String? collectionPath;
  final List<JsonMap> fields;
  final JsonMap payload;

  const VellumIndexSuggestion({
    required this.fingerprint,
    this.url,
    required this.reason,
    this.collectionPath,
    this.fields = const <JsonMap>[],
    this.payload = const <String, Object?>{},
  });

  JsonMap toJson() => <String, Object?>{
        'fingerprint': fingerprint,
        if (url != null) 'url': url,
        'reason': reason,
        if (collectionPath != null) 'collectionPath': collectionPath,
        'fields': fields,
        'payload': payload,
      };
}

/// Hook invoked once per newly-seen index suggestion (see `setOnIndexSuggestion`).
typedef IndexSuggestionCallback = void Function(VellumIndexSuggestion suggestion);

/// Process-wide fingerprint ledger — a suggestion is only announced once.
final Set<String> _seenIndexFingerprints = <String>{};
IndexSuggestionCallback? _globalOnIndexSuggestion;
bool _globalWarnOnMissingIndexes = true;

/// Sets a process-wide fallback callback for index suggestions. A [VellumClient]
/// created with its own `onIndexSuggestion` overrides this for its requests.
void setOnIndexSuggestion(IndexSuggestionCallback? callback) {
  _globalOnIndexSuggestion = callback;
}

/// Enables/disables the process-wide fallback index advisor.
void setWarnOnMissingIndexes(bool enabled) {
  _globalWarnOnMissingIndexes = enabled;
}

/// Clears the process-wide deduplication ledger (mainly useful in tests).
void clearSeenIndexSuggestions() => _seenIndexFingerprints.clear();

/// Small deterministic FNV-1a hash used when the server omits a fingerprint.
String _fingerprintHash(String input) {
  var hash = 0x811c9dc5;
  for (final int unit in input.codeUnits) {
    hash ^= unit;
    hash = (hash * 0x01000193) & 0xffffffff;
  }
  return hash.toRadixString(16).padLeft(8, '0');
}

DocumentSnapshot<T>? snapshotFromWire<T>(Object? raw, FromVellum<T> fromJson) {
  if (raw is! Map) return null;
  final map = raw.cast<String, Object?>();
  final path = map['path'];
  if (path is! String) return null;
  final rawId = map['documentId'];
  final id = rawId is String ? rawId : path.split('/').last;
  final rawVersion = map['version'];
  final version = rawVersion is num ? rawVersion.toInt() : 0;
  final rawData = map['data'];
  final data = rawData is Map ? rawData.cast<String, Object?>() : <String, Object?>{};
  final rawIncluded = map['_included'];
  final included = rawIncluded is Map
      ? Map<String, Object?>.unmodifiable(rawIncluded.cast<String, Object?>())
      : null;
  final rawRedacted = map['_redactedRefs'];
  final redactedRefs = rawRedacted is List
      ? List<String>.unmodifiable(rawRedacted.whereType<String>())
      : null;
  return DocumentSnapshot<T>(
    id: id,
    path: path,
    version: version,
    data: fromJson(data, id),
    included: included,
    redactedRefs: redactedRefs,
  );
}

/* -------------------------------------------------------------------------- */
/* Collections lifecycle models                                                */
/* -------------------------------------------------------------------------- */

/// Coerces a JSON number (or numeric string) into an [int] without throwing.
int _collectionInt(Object? value) {
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value) ?? 0;
  return 0;
}

int? _collectionNullableInt(Object? value) {
  if (value == null) return null;
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value);
  return null;
}

/// A collection registry row joined with its live document statistics.
///
/// Mirrors the wire `CollectionWithStats` schema; no customer document payload
/// is ever embedded here (only aggregate counts and byte totals).
class VellumCollectionInfo {
  final String id;
  final String name;
  final String? description;
  final int? defaultTtlSeconds;
  final JsonMap? schemaValidation;
  final int documentCount;
  final int storageBytes;
  final String createdAt;
  final String updatedAt;
  final String? lastDocumentAt;

  const VellumCollectionInfo({
    this.id = '',
    this.name = '',
    this.description,
    this.defaultTtlSeconds,
    this.schemaValidation,
    this.documentCount = 0,
    this.storageBytes = 0,
    this.createdAt = '',
    this.updatedAt = '',
    this.lastDocumentAt,
  });

  factory VellumCollectionInfo.fromJson(JsonMap json) {
    return VellumCollectionInfo(
      id: json['id'] is String ? json['id'] as String : '',
      name: json['name'] is String ? json['name'] as String : '',
      description: json['description'] is String ? json['description'] as String : null,
      defaultTtlSeconds: _collectionNullableInt(json['defaultTtlSeconds']),
      schemaValidation: json['schemaValidation'] is Map
          ? Map<String, Object?>.unmodifiable(
              (json['schemaValidation'] as Map).cast<String, Object?>(),
            )
          : null,
      documentCount: _collectionInt(json['documentCount']),
      storageBytes: _collectionInt(json['storageBytes']),
      createdAt: json['createdAt'] is String ? json['createdAt'] as String : '',
      updatedAt: json['updatedAt'] is String ? json['updatedAt'] as String : '',
      lastDocumentAt: json['lastDocumentAt'] is String
          ? json['lastDocumentAt'] as String
          : null,
    );
  }

  JsonMap toJson() => <String, Object?>{
        'id': id,
        'name': name,
        'description': description,
        'defaultTtlSeconds': defaultTtlSeconds,
        'schemaValidation': schemaValidation,
        'documentCount': documentCount,
        'storageBytes': storageBytes,
        'createdAt': createdAt,
        'updatedAt': updatedAt,
        'lastDocumentAt': lastDocumentAt,
      };
}

/// Response of `GET /collections`.
class ListCollectionsResult {
  final List<VellumCollectionInfo> collections;
  final String? nextCursor;

  const ListCollectionsResult({
    this.collections = const <VellumCollectionInfo>[],
    this.nextCursor,
  });

  factory ListCollectionsResult.fromJson(JsonMap json) {
    final List<VellumCollectionInfo> collections = <VellumCollectionInfo>[];
    final Object? raw = json['collections'];
    if (raw is List) {
      for (final Object? item in raw) {
        if (item is Map) {
          collections.add(VellumCollectionInfo.fromJson(item.cast<String, Object?>()));
        }
      }
    }
    return ListCollectionsResult(
      collections: List<VellumCollectionInfo>.unmodifiable(collections),
      nextCursor: json['nextCursor'] is String ? json['nextCursor'] as String : null,
    );
  }

  JsonMap toJson() => <String, Object?>{
        'collections': collections.map((VellumCollectionInfo c) => c.toJson()).toList(),
        'nextCursor': nextCursor,
      };
}

/// Response of `POST /collections/:name/clear`.
class ClearCollectionResult {
  final int deletedCount;
  final int freedBytes;

  const ClearCollectionResult({
    this.deletedCount = 0,
    this.freedBytes = 0,
  });

  factory ClearCollectionResult.fromJson(JsonMap json) {
    return ClearCollectionResult(
      deletedCount: _collectionInt(json['deletedCount']),
      freedBytes: _collectionInt(json['freedBytes']),
    );
  }

  JsonMap toJson() => <String, Object?>{
        'deletedCount': deletedCount,
        'freedBytes': freedBytes,
      };
}

/// Response of `DELETE /collections/:name`.
class DeleteCollectionResult {
  final bool deletedCollection;
  final int deletedDocuments;
  final int freedBytes;

  const DeleteCollectionResult({
    this.deletedCollection = false,
    this.deletedDocuments = 0,
    this.freedBytes = 0,
  });

  factory DeleteCollectionResult.fromJson(JsonMap json) {
    return DeleteCollectionResult(
      deletedCollection: json['deletedCollection'] == true,
      deletedDocuments: _collectionInt(json['deletedDocuments']),
      freedBytes: _collectionInt(json['freedBytes']),
    );
  }

  JsonMap toJson() => <String, Object?>{
        'deletedCollection': deletedCollection,
        'deletedDocuments': deletedDocuments,
        'freedBytes': freedBytes,
      };
}

/// Response of `POST /collections/:name/import`.
class ImportResult {
  final int importedCount;
  final int skippedCount;
  final List<JsonMap> errors;

  const ImportResult({
    this.importedCount = 0,
    this.skippedCount = 0,
    this.errors = const <JsonMap>[],
  });

  factory ImportResult.fromJson(JsonMap json) {
    final List<JsonMap> errors = <JsonMap>[];
    final Object? raw = json['errors'];
    if (raw is List) {
      for (final Object? item in raw) {
        if (item is Map) {
          errors.add(Map<String, Object?>.unmodifiable(item.cast<String, Object?>()));
        }
      }
    }
    return ImportResult(
      importedCount: _collectionInt(json['importedCount']),
      skippedCount: _collectionInt(json['skippedCount']),
      errors: List<JsonMap>.unmodifiable(errors),
    );
  }

  JsonMap toJson() => <String, Object?>{
        'importedCount': importedCount,
        'skippedCount': skippedCount,
        'errors': errors,
      };
}

/// Response of `GET /collections/:name/export`.
class ExportResult {
  final List<JsonMap> documents;
  final String? nextCursor;

  const ExportResult({
    this.documents = const <JsonMap>[],
    this.nextCursor,
  });

  factory ExportResult.fromJson(JsonMap json) {
    final List<JsonMap> documents = <JsonMap>[];
    final Object? raw = json['documents'];
    if (raw is List) {
      for (final Object? item in raw) {
        if (item is Map) {
          documents.add(Map<String, Object?>.unmodifiable(item.cast<String, Object?>()));
        }
      }
    }
    return ExportResult(
      documents: List<JsonMap>.unmodifiable(documents),
      nextCursor: json['nextCursor'] is String ? json['nextCursor'] as String : null,
    );
  }

  JsonMap toJson() => <String, Object?>{
        'documents': documents,
        'nextCursor': nextCursor,
      };
}
