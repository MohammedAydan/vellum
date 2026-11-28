/// Declarative field operations, tagged wire format helpers, and JSON coercion.
part of '../../vellum_flutter_core.dart';

/// Declarative Atomic Field Operations (`$op`)
class FieldOp {
  FieldOp._();

  static JsonMap serverTimestamp() =>
      const <String, Object?>{'\$op': 'serverTimestamp'};

  static JsonMap increment(num by) =>
      <String, Object?>{'\$op': 'inc', 'by': by};

  static JsonMap arrayUnion(JsonList elements) => <String, Object?>{
        '\$op': 'arrayUnion',
        'elements': elements,
      };

  static JsonMap arrayRemove(JsonList elements) => <String, Object?>{
        '\$op': 'arrayRemove',
        'elements': elements,
      };

  static JsonMap deleteField() =>
      const <String, Object?>{'\$op': 'deleteField'};
}

/// Declarative Atomic Field Values matching Specification Section 8 & Firebase conventions
class FieldValue {
  FieldValue._();

  static JsonMap serverTimestamp() => FieldOp.serverTimestamp();

  static JsonMap increment(num by) => FieldOp.increment(by);

  static JsonMap arrayUnion(JsonList elements) => FieldOp.arrayUnion(elements);

  static JsonMap arrayRemove(JsonList elements) =>
      FieldOp.arrayRemove(elements);

  static JsonMap delete() => FieldOp.deleteField();

  static JsonMap deleteField() => FieldOp.deleteField();
}

/// Converts `include()` arguments (`'field'` shorthands and/or [VellumInclude]
/// specs) into wire-ready include maps. Raw maps are passed through so callers
/// can use forward-compatible fields such as `onDelete`.
List<JsonMap> serializeIncludeRelations(List<Object> relations) {
  return relations.map((Object relation) {
    if (relation is VellumInclude) return relation.toJson();
    if (relation is String) return <String, Object?>{'field': relation};
    if (relation is Map) return relation.cast<String, Object?>();
    throw const VellumException(
      code: 'INVALID_ARGUMENT',
      message: 'include items must be a String, VellumInclude or Map',
      statusCode: 400,
    );
  }).toList();
}

/// Tagged Wire Format Helpers (`int64`, `timestamp`, `reference`, `bytes`, `geopoint`, `escapeMap`)
class VellumWire {
  VellumWire._();

  static JsonMap int64(int value) => <String, Object?>{
        '\$t': 'int',
        '\$v': value.toString(),
      };

  static JsonMap timestamp(DateTime dt) {
    final utc = dt.toUtc();
    return <String, Object?>{
      '\$t': 'ts',
      '\$v': utc.toIso8601String(),
      '\$ms': utc.millisecondsSinceEpoch,
    };
  }

  /// Creates a project-relative reference value, not a target document.
  /// Validates the path without checking target existence or permissions.
  static JsonMap reference(String documentPath) {
    final clean = validateVellumPath(documentPath, requireEvenSegments: true);
    final segments = clean.split('/');
    if (clean != documentPath ||
        documentPath.trim() != documentPath ||
        documentPath.length > 2048 ||
        segments.length > 10 ||
        segments.any((segment) =>
            RegExp(r'^__.*__$').hasMatch(segment) ||
            utf8.encode(segment).length > 1500)) {
      throw const VellumException(
        code: 'INVALID_DOCUMENT_PATH',
        message:
            'Reference requires a canonical document path within path limits',
        statusCode: 400,
      );
    }
    return Map<String, Object?>.unmodifiable(<String, Object?>{
      '\$t': 'ref',
      '\$v': documentPath,
    });
  }

  static JsonMap bytes(List<int> rawBytes) => <String, Object?>{
        '\$t': 'bytes',
        '\$v': base64Encode(rawBytes),
      };

  static JsonMap geopoint(double lat, double lng) => <String, Object?>{
        '\$t': 'geo',
        '\$v': <String, Object?>{'lat': lat, 'lng': lng},
      };

  static JsonMap escapeMap(JsonMap map) {
    if (map.containsKey('\$t')) {
      return <String, Object?>{'\$t': 'map', '\$v': map};
    }
    return map;
  }

  /// Decodes a wire-tagged value to its standard Dart runtime representation.
  ///
  /// Returns [Object?] so callers must narrow the decoded value before using
  /// it. Nested maps and lists are decoded recursively.
  static Object? decodeWireValue(Object? value) {
    if (value is Map && value.containsKey('\$t')) {
      final map = asStringDynamicMap(value);
      final tag = map['\$t'];
      final v = map['\$v'];
      switch (tag) {
        case 'int':
          return int.parse(v.toString());
        case 'ts':
          return DateTime.parse(v.toString());
        case 'ref':
          return v.toString();
        case 'bytes':
          return base64Decode(v.toString());
        case 'geo':
          final geoMap = asStringDynamicMap(v);
          return <String, Object?>{'lat': geoMap['lat'], 'lng': geoMap['lng']};
        case 'map':
          return v;
        default:
          return v;
      }
    }
    if (value is Map) {
      final map = asStringDynamicMap(value);
      return map.map<String, Object?>(
        (String k, Object? v) =>
            MapEntry<String, Object?>(k, decodeWireValue(v)),
      );
    }
    if (value is List) {
      return value
          .map<Object?>((Object? item) => decodeWireValue(item))
          .toList();
    }
    return value;
  }
}

/// Coerces a decoded JSON value into a string-keyed map without ever throwing.
/// Arrays, scalars and empty bodies become an empty map so legacy callers that
/// index into the result keep working; use [requestMap] when invoking a transport directly.
JsonMap asStringDynamicMap(Object? decoded) {
  if (decoded is JsonMap) return decoded;
  if (decoded is Map) return decoded.cast<String, Object?>();
  return <String, Object?>{};
}
