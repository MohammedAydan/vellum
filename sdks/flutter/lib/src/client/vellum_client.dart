/// VellumClient, HTTP transport layer, index suggestion header handling, and request orchestration.
part of '../../vellum_flutter_core.dart';

String? _responseHeader(Map<String, String> headers, String name) {
  final String? direct = headers[name];
  if (direct != null) return direct;
  for (final MapEntry<String, String> entry in headers.entries) {
    if (entry.key.toLowerCase() == name) return entry.value;
  }
  return null;
}

void _handleIndexSuggestionHeaders(
  Map<String, String> headers, {
  required bool warn,
  IndexSuggestionCallback? callback,
}) {
  // `warnOnMissingIndexes: false` disables BOTH the print and the callback.
  if (!warn || headers.isEmpty) return;
  try {
    final String? url = _responseHeader(headers, 'x-vellum-index-url');
    final String? rawSuggestion =
        _responseHeader(headers, 'x-vellum-index-suggestion');
    if ((url == null || url.isEmpty) &&
        (rawSuggestion == null || rawSuggestion.isEmpty)) {
      return;
    }

    JsonMap payload = <String, Object?>{};
    if (rawSuggestion != null && rawSuggestion.isNotEmpty) {
      try {
        final Object? decoded = jsonDecode(rawSuggestion);
        if (decoded is Map) payload = decoded.cast<String, Object?>();
      } catch (_) {
        // A non-JSON suggestion value is tolerated — the URL still fingerprints.
      }
    }

    final Object? rawFingerprint = payload['fingerprint'];
    final String fingerprint =
        (rawFingerprint is String && rawFingerprint.isNotEmpty)
            ? rawFingerprint
            : 'url:${_fingerprintHash(url ?? rawSuggestion ?? '')}';
    if (!_seenIndexFingerprints.add(fingerprint)) return;

    final String reason = payload['reason'] is String
        ? payload['reason'] as String
        : 'A composite index can speed up this query.';
    final String? collectionPath = payload['collectionPath'] is String
        ? payload['collectionPath'] as String
        : null;
    final List<JsonMap> fields = <JsonMap>[];
    if (payload['fields'] is List) {
      for (final Object? item in payload['fields'] as List) {
        if (item is Map) fields.add(item.cast<String, Object?>());
      }
    }

    final VellumIndexSuggestion suggestion = VellumIndexSuggestion(
      fingerprint: fingerprint,
      url: url,
      reason: reason,
      collectionPath: collectionPath,
      fields: fields,
      payload: payload,
    );

    if (warn) {
      final List<String> lines = <String>[
        '[VELLUM Index Advisor] Missing composite index (fingerprint: ${_redactSecrets(fingerprint)})',
        '  Reason: ${_redactSecrets(reason)}',
        if (collectionPath != null)
          '  Collection: ${_redactSecrets(collectionPath)}',
        if (url != null && url.isNotEmpty)
          '  One-click fix: ${_redactSecrets(url)}',
      ];
      Zone.current.print(lines.join('\n'));
    }
    if (callback != null) {
      try {
        callback(suggestion);
      } catch (_) {
        // A throwing user callback must never break a document request.
      }
    }
  } catch (_) {
    // The advisor is strictly non-blocking and never fails a request.
  }
}

/// Calls [transport] and always yields a JSON object, even for array/scalar responses.
///
/// When a transport returns [VellumHttpResponse], its headers are inspected for
/// `x-vellum-index-*` suggestions on every response before the body is decoded.
Future<JsonMap> requestMap(
  HttpTransport transport,
  String method,
  String url,
  Map<String, String> headers,
  JsonMap? body, {
  bool? warnOnMissingIndexes,
  IndexSuggestionCallback? onIndexSuggestion,
}) async {
  final Object? decoded = await transport(method, url, headers, body);
  Object? payload = decoded;
  Map<String, String> responseHeaders = const <String, String>{};
  if (decoded is VellumHttpResponse) {
    payload = decoded.body;
    responseHeaders = decoded.headers;
  }
  _handleIndexSuggestionHeaders(
    responseHeaders,
    warn: warnOnMissingIndexes ?? _globalWarnOnMissingIndexes,
    callback: onIndexSuggestion ?? _globalOnIndexSuggestion,
  );
  return asStringDynamicMap(payload);
}

/// Sends one request through [client] and decodes body plus response headers.
Future<VellumHttpResponse> _sendHttpRequestWithHeaders(
  http.Client client,
  String method,
  String url,
  Map<String, String> headers,
  JsonMap? body,
) async {
  final uri = Uri.parse(url);
  http.Response response;
  final jsonBody = body != null ? jsonEncode(body) : null;
  switch (method.toUpperCase()) {
    case 'GET':
      response = await client.get(uri, headers: headers);
      break;
    case 'HEAD':
      response = await client.head(uri, headers: headers);
      break;
    case 'POST':
      response = await client.post(uri, headers: headers, body: jsonBody);
      break;
    case 'PUT':
      response = await client.put(uri, headers: headers, body: jsonBody);
      break;
    case 'PATCH':
      response = await client.patch(uri, headers: headers, body: jsonBody);
      break;
    case 'DELETE':
      response = await client.delete(uri, headers: headers, body: jsonBody);
      break;
    default:
      throw VellumException(
        code: 'INVALID_ARGUMENT',
        message: 'Unsupported HTTP method $method',
        statusCode: 400,
      );
  }

  Object? decoded;
  if (response.body.isNotEmpty) {
    try {
      decoded = jsonDecode(response.body);
    } on FormatException {
      if (response.statusCode < 400) rethrow;
      decoded = null;
    }
  }

  if (response.statusCode >= 400) {
    final error = decoded is Map ? decoded['error'] : null;
    final err = error is Map
        ? error.cast<String, Object?>()
        : const <String, Object?>{};
    final retryAfter = _responseHeader(response.headers, 'retry-after');
    final errDetails = err['details'] is Map
        ? (err['details'] as Map).cast<String, Object?>()
        : const <String, Object?>{};
    final details = <String, Object?>{
      ...errDetails,
      if (retryAfter != null && retryAfter.isNotEmpty) 'retryAfter': retryAfter,
    };
    throw VellumException(
      code: err['code'] is String ? err['code'] as String : 'INTERNAL_ERROR',
      message: err['message'] is String
          ? err['message'] as String
          : 'HTTP ${response.statusCode} response without an API error envelope. '
              'Check endpoint/baseUrl and the project REST prefix.',
      statusCode: response.statusCode,
      requestId: _responseHeader(response.headers, 'x-request-id'),
      details: details,
    );
  }
  return VellumHttpResponse(body: decoded, headers: response.headers);
}

/// Standard production HTTP transport using a short-lived `package:http`
/// client. Prefer [httpClientTransport] when the app owns a long-lived client.
///
/// Returns the decoded body directly (legacy behavior). [VellumClient] uses
/// [defaultHttpTransportWithHeaders] internally so index-advisor headers are
/// still inspected on every response.
Future<Object?> defaultHttpTransport(
  String method,
  String url,
  Map<String, String> headers,
  JsonMap? body,
) async {
  final client = http.Client();
  try {
    final response =
        await _sendHttpRequestWithHeaders(client, method, url, headers, body);
    _handleIndexSuggestionHeaders(
      response.headers,
      warn: _globalWarnOnMissingIndexes,
      callback: _globalOnIndexSuggestion,
    );
    return response.body;
  } finally {
    client.close();
  }
}

/// Header-aware counterpart of [defaultHttpTransport] used by [VellumClient].
Future<VellumHttpResponse> defaultHttpTransportWithHeaders(
  String method,
  String url,
  Map<String, String> headers,
  JsonMap? body,
) async {
  final client = http.Client();
  try {
    return await _sendHttpRequestWithHeaders(
        client, method, url, headers, body);
  } finally {
    client.close();
  }
}

/// Builds an [HttpTransport] backed by a caller-owned [http.Client].
///
/// The client is *not* closed by the SDK; the caller owns its lifecycle. This
/// is the seam used by `http.MockClient` in tests and by apps that want
/// connection pooling or their own interceptors. Returns the decoded body
/// directly; [VellumClient] uses [httpClientTransportWithHeaders] internally.
HttpTransport httpClientTransport(http.Client client) {
  return (
    String method,
    String url,
    Map<String, String> headers,
    JsonMap? body,
  ) async {
    final response =
        await _sendHttpRequestWithHeaders(client, method, url, headers, body);
    _handleIndexSuggestionHeaders(
      response.headers,
      warn: _globalWarnOnMissingIndexes,
      callback: _globalOnIndexSuggestion,
    );
    return response.body;
  };
}

/// Header-aware counterpart of [httpClientTransport] used by [VellumClient].
HttpTransport httpClientTransportWithHeaders(http.Client client) {
  return (
    String method,
    String url,
    Map<String, String> headers,
    JsonMap? body,
  ) async {
    return await _sendHttpRequestWithHeaders(
        client, method, url, headers, body);
  };
}

HttpTransport _resolveTransport(HttpTransport? explicit, http.Client? client) {
  if (explicit != null) return explicit;
  if (client != null) return httpClientTransportWithHeaders(client);
  return defaultHttpTransportWithHeaders;
}

/// Derives the full REST prefix from a host `endpoint`.
String _deriveBaseUrl(String endpoint, String projectId) {
  final cleanEndpoint = endpoint.endsWith('/')
      ? endpoint.substring(0, endpoint.length - 1)
      : endpoint;
  return '$cleanEndpoint/v1/projects/${Uri.encodeComponent(projectId)}';
}

/// Validates configuration before any project key can be sent to a wrong route.
String _resolveBaseUrl(String? endpoint, String? baseUrl, String projectId) {
  Never invalid(String message) => throw VellumException(
        code: 'INVALID_ARGUMENT',
        message: message,
        statusCode: 400,
      );
  if (projectId.trim().isEmpty ||
      projectId != projectId.trim() ||
      RegExp(r'[\x00-\x1f\x7f/\\?#]').hasMatch(projectId)) {
    invalid(
        'projectId must be a non-empty project identifier without path separators');
  }
  if (endpoint != null && baseUrl != null) {
    invalid(
        'Use endpoint or baseUrl, not both. baseUrl is a full project REST prefix.');
  }
  final value = (baseUrl ?? endpoint ?? '').trim();
  final uri = Uri.tryParse(value);
  if (uri == null ||
      uri.hasQuery ||
      uri.hasFragment ||
      uri.userInfo.isNotEmpty ||
      (uri.hasScheme && (uri.scheme != 'https' && uri.scheme != 'http')) ||
      (uri.hasScheme && uri.host.isEmpty) ||
      (!uri.hasScheme &&
          (uri.hasAuthority || (value.isNotEmpty && !value.startsWith('/'))))) {
    invalid(
        'Use an HTTP(S) URL or a root-relative URL, without credentials, query or fragment');
  }
  final clean = value.replaceFirst(RegExp(r'/+$'), '');
  final path = uri.path.replaceFirst(RegExp(r'/+$'), '');
  if (baseUrl != null) {
    if (path.isEmpty || path == '/v1') {
      invalid(
          'baseUrl must include /v1/projects/<projectId>, not just the API origin or /v1. '
          'Use endpoint with the API origin instead. /v1/auth is console authentication, not project user authentication.');
    }
    final segments = uri.pathSegments.where((s) => s.isNotEmpty).toList();
    final projects = segments.lastIndexOf('projects');
    if (projects >= 0 &&
        (projects + 1 >= segments.length ||
            segments[projects + 1] != projectId ||
            projects + 2 != segments.length)) {
      invalid(
          'baseUrl must target the same projectId and end at its project REST prefix');
    }
    return clean;
  }
  if (path.endsWith('/v1') || path.contains('/v1/projects/')) {
    invalid(
        'endpoint is the API origin, without /v1 or /v1/projects/<projectId>. '
        'Use baseUrl only for a full project REST prefix.');
  }
  return _deriveBaseUrl(clean, projectId);
}

/// Primary Client Entrypoint for `vellum_flutter`.
///
/// Configure the REST target either with `endpoint` (a host origin, from which
/// the SDK derives `/v1/projects/:projectId`) or with `baseUrl` (the
/// full prefix, with trailing slashes removed). Supply only one option. `httpClient` and `authStorage` are the
/// preferred injection names; `httpTransport` and `authTokenStorage` remain as
/// fully supported aliases for existing callers.
class VellumClient implements VellumClientPort {
  @override
  final String endpoint;
  @override
  final String projectId;
  final String apiKey;
  @override
  final String baseUrl;
  final Future<String?> Function()? getAuthToken;

  /// Silent token refresh (60 s before expiry and on 401). Defaults to true;
  /// when false only an explicit `auth.getIdToken(forceRefresh: true)` refreshes.
  final bool autoRefresh;

  /// Default read policy; overridable per call with `get(cachePolicy: ...)`.
  final CachePolicy cachePolicy;

  /// Freshness window for [CachePolicy.cacheFirst].
  final Duration cacheTtl;

  /// Offline store. Defaults to a 100 MB in-memory LRU; pass your own
  /// [DocumentCacheStore] to persist to disk, or set `enableCache: false`.
  final DocumentCacheStore? documentCache;

  final List<Future<void> Function()> _signOutHooks = <Future<void> Function()>[];

  /// Registers cleanup that runs when the user signs out (the offline outbox
  /// uses it to drop queued writes). Hook errors never block sign-out.
  void addSignOutHook(Future<void> Function() hook) => _signOutHooks.add(hook);

  Future<void> runSignOutHooks() async {
    for (final hook in List<Future<void> Function()>.of(_signOutHooks)) {
      try {
        await hook();
      } catch (_) {}
    }
  }

  /// Clears stored documents (used on sign-out / user change).
  void clearDocumentCache() {
    final store = documentCache;
    if (store != null) unawaited(store.clear().catchError((Object _) {}));
  }
  String? _customToken;

  /// Injects an externally issued bearer token. It wins over [getAuthToken]
  /// and the SDK session; pass null to remove it.
  void setCustomToken(String? token) {
    final next = (token == null || token.isEmpty) ? null : token;
    if (next == _customToken) return;
    _customToken = next;
    realtime.refreshCredentials();
  }
  final HttpTransport httpTransport;
  final TokenStoragePort authTokenStorage;
  final String? realtimeUrlOverride;
  final RealtimeChannelFactory? webSocketChannelFactory;

  /// Realtime transport: WebSocket first with automatic SSE fallback (default),
  /// WebSocket only, or SSE only. SSE works on hosts without WebSocket, such as
  /// Vercel.
  final VellumRealtimeMode realtimeMode;
  final int Function(int attempt)? realtimeBackoff;
  final IndexSuggestionCallback? onIndexSuggestion;
  final bool warnOnMissingIndexes;
  final Duration requestTimeout;
  final int maxRetries;
  final Duration retryBaseDelay;
  final Duration retryMaxDelay;
  final bool coalesceInFlightGets;
  final Random? _random;
  final Map<String, DocumentSnapshot<Object?>> _memoryCache = {};
  final Map<String, Future<JsonMap>> _inFlightGets =
      <String, Future<JsonMap>>{};

  @override
  late final VellumRealtimeManager realtime;
  VellumAuth? _auth;

  VellumClient({
    String? endpoint,
    required this.projectId,
    required this.apiKey,
    String? baseUrl,
    this.getAuthToken,
    this.autoRefresh = true,
    this.cachePolicy = CachePolicy.networkFirst,
    this.cacheTtl = const Duration(minutes: 5),
    DocumentCacheStore? cacheStore,
    bool enableCache = true,
    HttpTransport? httpTransport,
    http.Client? httpClient,
    TokenStoragePort? authStorage,
    TokenStoragePort? authTokenStorage,
    this.realtimeUrlOverride,
    this.webSocketChannelFactory,
    this.realtimeMode = VellumRealtimeMode.auto,
    this.realtimeBackoff,
    this.onIndexSuggestion,
    this.warnOnMissingIndexes = true,
    this.requestTimeout = const Duration(seconds: 30),
    this.maxRetries = 3,
    this.retryBaseDelay = const Duration(milliseconds: 250),
    this.retryMaxDelay = const Duration(seconds: 15),
    this.coalesceInFlightGets = true,
    Random? random,
  })  : endpoint = (endpoint ?? '').trim().replaceFirst(RegExp(r'/+$'), ''),
        baseUrl = _resolveBaseUrl(endpoint, baseUrl, projectId),
        httpTransport = _resolveTransport(httpTransport, httpClient),
        documentCache =
            enableCache ? (cacheStore ?? MemoryDocumentCacheStore()) : null,
        authTokenStorage =
            authStorage ?? authTokenStorage ?? _resolveDefaultAuthStorage(),
        _random = random {
    realtime = VellumRealtimeManager(this);
  }

  /// The auth controller bound to this client. Storage can be injected with
  /// either `authStorage` or the legacy `authTokenStorage` constructor
  /// argument; then call `auth.restore()` during app startup.
  @override
  VellumAuth get auth => _auth ??= VellumAuth(this, storage: authTokenStorage);

  /// Host origin used for the realtime WebSocket URL.
  ///
  /// Falls back to the scheme/authority of [baseUrl] when only the full prefix
  /// was configured. [realtimeUrlOverride] still takes precedence in the
  /// realtime manager.
  String get realtimeEndpoint {
    if (endpoint.isNotEmpty) return endpoint;
    final uri = Uri.tryParse(baseUrl);
    if (uri != null && uri.hasScheme && uri.authority.isNotEmpty) {
      return '${uri.scheme}://${uri.authority}';
    }
    return baseUrl;
  }

  String get authBaseUrl => '$baseUrl/auth';

  /// Bearer token for REST and WS: an explicit provider wins, the SDK auth
  /// state is the default.
  Future<String?> resolveAuthToken() async {
    final custom = _customToken;
    if (custom != null) return custom;
    final explicit = getAuthToken;
    if (explicit != null) {
      final token = await explicit();
      if (token != null && token.isNotEmpty) return token;
    }
    final user = auth.currentUser;
    if (user == null) return null;
    return auth.getIdToken();
  }

  /// In-memory offline cache helpers.
  void setCachedDocument(String path, DocumentSnapshot<Object?> snap) =>
      _memoryCache[path] = snap;

  DocumentSnapshot<Object?>? getCachedDocument(String path) =>
      _memoryCache[path];

  void clearCache() => _memoryCache.clear();

  static bool _isRetryableRequest(
    String method,
    String relativePath,
    Map<String, String> headers,
  ) {
    final upper = method.toUpperCase();
    final pathOnly = relativePath.split('?').first;
    if (upper == 'GET' || upper == 'HEAD') return true;
    if (upper == 'POST' &&
        (pathOnly == '/query' || pathOnly == '/documents:aggregate')) {
      return true;
    }
    final idem = _responseHeader(headers, 'idempotency-key') ??
        _responseHeader(headers, 'x-idempotency-key');
    return idem != null && idem.trim().isNotEmpty;
  }

  static bool _isRetryableError(Object error) {
    if (error is VellumException) {
      return error.statusCode == 429 ||
          error.statusCode == 408 ||
          (error.statusCode >= 500 && error.statusCode <= 599) ||
          error.code == 'REQUEST_TIMEOUT';
    }
    if (error is TimeoutException || error is http.ClientException) {
      return true;
    }
    final typeName = error.runtimeType.toString();
    return typeName.contains('SocketException') ||
        typeName.contains('HandshakeException');
  }

  Future<JsonMap> _executeOnce(
    String method,
    String url,
    Map<String, String> headers,
    JsonMap? body,
  ) async {
    try {
      return await requestMap(
        httpTransport,
        method,
        url,
        headers,
        body,
        warnOnMissingIndexes: warnOnMissingIndexes,
        onIndexSuggestion: onIndexSuggestion,
      ).timeout(
        requestTimeout,
        onTimeout: () => throw VellumException(
          code: 'REQUEST_TIMEOUT',
          message: 'Request timed out after ${requestTimeout.inMilliseconds}ms',
          statusCode: 408,
        ),
      );
    } on TimeoutException catch (err) {
      throw VellumException(
        code: 'REQUEST_TIMEOUT',
        message: err.message ??
            'Request timed out after ${requestTimeout.inMilliseconds}ms',
        statusCode: 408,
      );
    }
  }

  Future<JsonMap> _executeWithRetry(
    String method,
    String relativePath,
    String url,
    Map<String, String> headers,
    JsonMap? body,
  ) async {
    final canRetry = _isRetryableRequest(method, relativePath, headers);
    final allowedRetries = canRetry ? max(0, maxRetries) : 0;

    for (var attempt = 0;; attempt++) {
      try {
        return await _executeOnce(method, url, headers, body);
      } catch (err) {
        if (attempt >= allowedRetries || !_isRetryableError(err)) {
          rethrow;
        }
        Duration? retryAfterDelay;
        if (err is VellumException) {
          final rawRetryAfter = err.details['retryAfter'];
          if (rawRetryAfter is String) {
            retryAfterDelay = parseRetryAfterHeader(rawRetryAfter);
          } else if (rawRetryAfter is num) {
            retryAfterDelay =
                Duration(milliseconds: (rawRetryAfter * 1000).round());
          }
        }
        final Duration delay;
        if (retryAfterDelay != null) {
          delay =
              retryAfterDelay > retryMaxDelay ? retryMaxDelay : retryAfterDelay;
        } else {
          final ms = computeRetryBackoffMs(
            attempt,
            baseMs: retryBaseDelay.inMilliseconds,
            maxMs: retryMaxDelay.inMilliseconds,
            random: _random,
          );
          delay = Duration(milliseconds: ms);
        }
        if (delay > Duration.zero) {
          await Future<void>.delayed(delay);
        }
      }
    }
  }

  Future<JsonMap> request(
    String method,
    String relativePath, {
    JsonMap? body,
    bool includeAuth = true,
    String? idempotencyKey,
    Map<String, String>? extraHeaders,
  }) async {
    final result = await _sendRequest(
      method,
      relativePath,
      body: body,
      includeAuth: includeAuth,
      idempotencyKey: idempotencyKey,
      extraHeaders: extraHeaders,
    );
    _invalidateAfterWrite(method, relativePath);
    return result;
  }

  /// Keeps the offline cache honest: any successful write drops the stored
  /// copies it could affect (batches and transactions clear the whole store).
  void _invalidateAfterWrite(String method, String relativePath) {
    final store = documentCache;
    if (store == null || method == 'GET' || method == 'HEAD') return;
    if (relativePath.startsWith('/batchWrite') ||
        relativePath.startsWith('/transactions:commit')) {
      unawaited(store.clear().catchError((Object _) {}));
      return;
    }
    const prefix = '/documents/';
    if (relativePath.startsWith(prefix)) {
      final raw = relativePath.substring(prefix.length).split('?').first;
      final path = Uri.decodeFull(raw);
      unawaited(store.deletePath(path).catchError((Object _) {}));
      final slash = path.lastIndexOf('/');
      if (slash > 0) {
        // Collection queries that included this document are no longer exact.
        unawaited(store.deletePrefix('${path.substring(0, slash)}/').catchError((Object _) {}));
      }
    }
  }

  Future<JsonMap> _sendRequest(
    String method,
    String relativePath, {
    JsonMap? body,
    bool includeAuth = true,
    String? idempotencyKey,
    Map<String, String>? extraHeaders,
  }) async {
    final headers = <String, String>{
      // Canonical alias plus legacy header; both are always sent.
      'x-vellum-api-key': apiKey,
      'X-Project-Key': apiKey,
      'Content-Type': 'application/json',
      if (extraHeaders != null) ...extraHeaders,
      if (idempotencyKey != null && idempotencyKey.isNotEmpty)
        'Idempotency-Key': idempotencyKey,
    };
    String? usedToken;
    if (includeAuth) {
      final token = await resolveAuthToken();
      if (token != null && token.isNotEmpty) {
        usedToken = token;
        headers['Authorization'] = 'Bearer $token';
      }
    }

    final url = '$baseUrl$relativePath';

    Future<JsonMap> run() async {
      try {
        return await _executeWithRetry(
            method, relativePath, url, headers, body);
      } on VellumException catch (err) {
        // Reactive 401: coalesce into one single-flight refresh and replay the
        // exact request once with the new bearer. Never retry the refresh
        // endpoint itself, and never replay more than once.
        final currentRefreshToken = auth.currentUser?.refreshToken;
        final canRefresh = includeAuth &&
            relativePath != '/auth/token/refresh' &&
            err.statusCode == 401 &&
            currentRefreshToken != null &&
            currentRefreshToken.isNotEmpty;
        if (!canRefresh) rethrow;

        final refreshed = await auth.refreshOnUnauthorized(usedToken);
        if (refreshed == null ||
            refreshed.isEmpty ||
            'Bearer $refreshed' == headers['Authorization']) {
          rethrow;
        }
        final retryHeaders = Map<String, String>.from(headers)
          ..['Authorization'] = 'Bearer $refreshed';
        return await _executeWithRetry(
          method,
          relativePath,
          url,
          retryHeaders,
          body,
        );
      }
    }

    // Transparent single-flight coalescing for concurrent identical GETs
    // (skipping transactional reads).
    final isCoalescableGet = coalesceInFlightGets &&
        method.toUpperCase() == 'GET' &&
        body == null &&
        !relativePath.contains('transactionToken=');
    if (!isCoalescableGet) {
      return run();
    }

    final dedupeKey = '$url|${headers['Authorization'] ?? ''}';
    final existing = _inFlightGets[dedupeKey];
    if (existing != null) return existing;

    final future = run();
    _inFlightGets[dedupeKey] = future;
    try {
      return await future;
    } finally {
      if (identical(_inFlightGets[dedupeKey], future)) {
        _inFlightGets.remove(dedupeKey);
      }
    }
  }

  /// Releases auth timers/streams, closes realtime connections, and clears
  /// in-memory caches.
  @override
  void dispose() {
    _auth?.dispose();
    realtime.dispose();
    _memoryCache.clear();
    _inFlightGets.clear();
  }

  /// Alias for [dispose].
  @override
  void close() => dispose();

  @override
  String toString() =>
      'VellumClient(projectId: $projectId, baseUrl: $baseUrl, apiKey: <redacted>)';

  @override
  CollectionReference<JsonMap> collection(String path) {
    final clean = validateVellumPath(path);
    return CollectionReference<JsonMap>(
      client: this,
      collectionPath: clean,
      fromJson: (data, _) => data,
      toJson: (value) => value,
    );
  }

  @override
  DocumentReference<JsonMap> doc(String path) {
    final clean = validateVellumPath(path, requireEvenSegments: true);
    final segments = clean.split('/');
    final docId = segments.last;
    final colPath = segments.sublist(0, segments.length - 1).join('/');
    return collection(colPath).doc(docId);
  }

  /// Reads a document by path. Thin alias for `doc(path).get()`.
  @override
  Future<DocumentSnapshot<JsonMap>> getDoc(String path) => doc(path).get();

  /// Creates or overwrites a document by path, optionally merging.
  @override
  Future<void> setDoc(
    String path,
    JsonMap data, {
    bool merge = false,
    int? ifVersion,
    String? idempotencyKey,
  }) =>
      doc(path).set(
        data,
        merge: merge,
        ifVersion: ifVersion,
        idempotencyKey: idempotencyKey,
      );

  /// Applies an atomic field patch to a document by path.
  @override
  Future<void> updateDoc(
    String path,
    JsonMap data, {
    int? ifVersion,
    String? idempotencyKey,
  }) =>
      doc(path).update(
        data,
        ifVersion: ifVersion,
        idempotencyKey: idempotencyKey,
      );

  /// Deletes a document by path, optionally with optimistic concurrency.
  @override
  Future<void> deleteDoc(
    String path, {
    int? ifVersion,
    String? idempotencyKey,
  }) =>
      doc(path).delete(
        ifVersion: ifVersion,
        idempotencyKey: idempotencyKey,
      );

  /// Builds a reusable query over [collectionPath].
  ///
  /// `where` accepts either a `Map` of `field -> value` (equality filters) or
  /// an iterable of `{field, op, value}` maps. `orderBy` accepts a field name,
  /// a `{field, dir}` map, or an iterable of either. `cursor` maps to
  /// `startAfter` — the HMAC-signed opaque value returned as `nextCursor`.
  ///
  /// ```dart
  /// final q = client.query('orders',
  ///     where: {'status': 'open'}, orderBy: 'createdAt', limit: 20);
  /// final page = await q.get();
  /// ```
  @override
  Query<JsonMap> query(
    String collectionPath, {
    Object? where,
    Object? orderBy,
    int? limit,
    String? cursor,
  }) {
    Query<JsonMap> q = collection(collectionPath);

    if (where is Map) {
      where.forEach((Object? field, Object? value) {
        if (field is String) q = q.where(field, '==', value);
      });
    } else if (where is Iterable) {
      for (final Object? clause in where) {
        if (clause is! Map) continue;
        final field = clause['field'];
        final op = clause['op'];
        if (field is String && op is String) {
          q = q.where(field, op, clause['value']);
        }
      }
    }

    if (orderBy is String) {
      q = q.orderBy(orderBy);
    } else if (orderBy is Map) {
      final field = orderBy['field'];
      final dir = orderBy['dir'];
      if (field is String) {
        q = q.orderBy(field, dir: dir is String ? dir : 'asc');
      }
    } else if (orderBy is Iterable) {
      for (final Object? clause in orderBy) {
        if (clause is String) {
          q = q.orderBy(clause);
        } else if (clause is Map) {
          final field = clause['field'];
          final dir = clause['dir'];
          if (field is String) {
            q = q.orderBy(field, dir: dir is String ? dir : 'asc');
          }
        }
      }
    }

    if (limit != null) q = q.limit(limit);
    if (cursor != null) q = q.startAfter(cursor);
    return q;
  }

  /// Executes an atomic batch of writes through `POST /batchWrite`.
  @override
  Future<JsonMap> batchWrite(
    List<JsonMap> writes, {
    String? idempotencyKey,
  }) =>
      request(
        'POST',
        '/batchWrite',
        body: <String, Object?>{'writes': writes},
        idempotencyKey: idempotencyKey,
      );

  /// Splits a large list of writes into bounded chunks (default 500 per batch)
  /// and submits each chunk sequentially via [batchWrite].
  @override
  Future<List<JsonMap>> writeBatchChunked(
    List<JsonMap> writes, {
    int chunkSize = 500,
    String? idempotencyKeyPrefix,
  }) async {
    if (chunkSize <= 0) {
      throw const VellumException(
        code: 'INVALID_ARGUMENT',
        message: 'chunkSize must be greater than zero',
        statusCode: 400,
      );
    }
    if (writes.isEmpty) return const <JsonMap>[];
    final results = <JsonMap>[];
    var chunkIndex = 0;
    for (var i = 0; i < writes.length; i += chunkSize) {
      final end = min(i + chunkSize, writes.length);
      final chunk = writes.sublist(i, end);
      final key =
          idempotencyKeyPrefix != null && idempotencyKeyPrefix.isNotEmpty
              ? '$idempotencyKeyPrefix-$chunkIndex'
              : null;
      results.add(await batchWrite(chunk, idempotencyKey: key));
      chunkIndex++;
    }
    return results;
  }

  /// Creates a fluent write batch builder supporting both atomic [VellumWriteBatch.commit]
  /// and auto-chunked [VellumWriteBatch.commitChunked].
  @override
  VellumWriteBatch batch() => VellumWriteBatch(this);

  /// Realtime stream of a collection, optionally filtered and ordered.
  @override
  Stream<QuerySnapshot<JsonMap>> watchCollection(
    String collectionPath, {
    Object? where,
    Object? orderBy,
    int? limit,
    String? cursor,
  }) =>
      query(
        collectionPath,
        where: where,
        orderBy: orderBy,
        limit: limit,
        cursor: cursor,
      ).snapshots();

  /// Realtime stream of a single document.
  @override
  Stream<DocumentSnapshot<JsonMap>> watchDocument(String path) =>
      doc(path).snapshots();

  /// Executes an interactive OCC transaction with automatic retry on `ABORTED_CONFLICT`.
  @override
  Future<R> runTransaction<R>(
    Future<R> Function(TransactionContext tx) updateFn, {
    int maxAttempts = 5,
  }) async {
    for (var attempt = 0; attempt < maxAttempts; attempt++) {
      final beginRes = await request('POST', '/transactions:begin',
          body: const <String, Object?>{});
      final txToken = beginRes['transactionToken'] as String;
      final txContext =
          TransactionContext(client: this, transactionToken: txToken);

      try {
        final result = await updateFn(txContext);
        await request(
          'POST',
          '/transactions:commit',
          body: {
            'transactionToken': txToken,
            'writes': txContext.stagedWrites,
          },
        );
        // The commit changed documents the cache may hold: drop them now, not in
        // the background, so the next read cannot return a stale copy.
        final store = documentCache;
        if (store != null) {
          try {
            await store.clear();
          } catch (_) {}
        }
        return result;
      } on VellumException catch (err) {
        if (err.code == 'ABORTED_CONFLICT' && attempt + 1 < maxAttempts) {
          final backoffMs = computeReconnectBackoffMs(attempt);
          await Future<void>.delayed(Duration(milliseconds: backoffMs));
          continue;
        }
        rethrow;
      }
    }
    throw const VellumException(
      code: 'ABORTED_CONFLICT',
      message: 'Transaction exhausted maximum retry attempts',
      statusCode: 409,
    );
  }

  /* --------------------------- Collections lifecycle ---------------------- */

  /// Builds a collection-scoped relative path, percent-encoding the name so
  /// slashes, spaces and other reserved characters stay inside one segment.
  String _collectionPath(String name) {
    final safe = validateVellumSegment(
      name,
      context: 'collection name',
      allowSlash: true,
    );
    return '/collections/${Uri.encodeComponent(safe)}';
  }

  /// Appends an encoded query string to a relative path (no `?` when empty).
  String _withQuery(String path, Map<String, String> query) {
    final encoded = Uri(queryParameters: query).query;
    return encoded.isEmpty ? path : '$path?$encoded';
  }

  /// Lists registered collections together with their live document statistics.
  @override
  Future<ListCollectionsResult> listCollections({
    String? search,
    int? limit,
    String? cursor,
  }) async {
    final Map<String, String> query = <String, String>{
      if (search != null) 'search': search,
      if (limit != null) 'limit': '$limit',
      if (cursor != null) 'cursor': cursor,
    };
    final JsonMap res = await request('GET', _withQuery('/collections', query));
    return ListCollectionsResult.fromJson(res);
  }

  /// Creates a collection in the current project's registry.
  @override
  Future<VellumCollectionInfo> createCollection(
    String name, {
    String? description,
    int? defaultTtlSeconds,
    JsonMap? schemaValidation,
    JsonMap? metadata,
    bool? ifNotExists,
  }) async {
    final JsonMap res = await request(
      'POST',
      '/collections',
      body: <String, Object?>{
        'name': name,
        if (description != null) 'description': description,
        if (defaultTtlSeconds != null) 'defaultTtlSeconds': defaultTtlSeconds,
        if (schemaValidation != null) 'schemaValidation': schemaValidation,
        if (metadata != null) 'metadata': metadata,
        if (ifNotExists != null) 'ifNotExists': ifNotExists,
      },
    );
    return VellumCollectionInfo.fromJson(res);
  }

  /// Fetches one collection. A missing collection (HTTP 404) yields `null`.
  @override
  Future<VellumCollectionInfo?> getCollectionInfo(String name) async {
    try {
      final JsonMap res = await request('GET', _collectionPath(name));
      // A nullable JSON endpoint may answer with an empty body.
      if (res.isEmpty) return null;
      return VellumCollectionInfo.fromJson(res);
    } on VellumException catch (err) {
      if (err.statusCode == 404) return null;
      rethrow;
    }
  }

  /// Patches collection settings. Only supplied fields are sent on the wire.
  @override
  Future<VellumCollectionInfo> updateCollection(
    String name, {
    String? description,
    int? defaultTtlSeconds,
    JsonMap? schemaValidation,
  }) async {
    final JsonMap res = await request(
      'PATCH',
      _collectionPath(name),
      body: <String, Object?>{
        if (description != null) 'description': description,
        if (defaultTtlSeconds != null) 'defaultTtlSeconds': defaultTtlSeconds,
        if (schemaValidation != null) 'schemaValidation': schemaValidation,
      },
    );
    return VellumCollectionInfo.fromJson(res);
  }

  /// Deletes every document in a collection while keeping the collection itself.
  @override
  Future<ClearCollectionResult> clearCollection(String name) async {
    final JsonMap res = await request('POST', '${_collectionPath(name)}/clear',
        body: <String, Object?>{});
    return ClearCollectionResult.fromJson(res);
  }

  /// Drops the collection and all of its documents.
  @override
  Future<DeleteCollectionResult> deleteCollection(String name) async {
    final JsonMap res = await request('DELETE', _collectionPath(name));
    return DeleteCollectionResult.fromJson(res);
  }

  /// Bulk-imports documents. [mode] is `upsert` (default) or `insert_only`.
  @override
  Future<ImportResult> importDocuments(
    String collection,
    List<JsonMap> docs, {
    String? mode,
  }) async {
    final JsonMap res = await request(
      'POST',
      '${_collectionPath(collection)}/import',
      body: <String, Object?>{
        'documents': docs,
        if (mode != null) 'mode': mode,
      },
    );
    return ImportResult.fromJson(res);
  }

  /// Exports documents with cursor-only pagination (no SQL OFFSET).
  @override
  Future<ExportResult> exportDocuments(
    String collection, {
    int? limit,
    String? cursor,
  }) async {
    final Map<String, String> query = <String, String>{
      if (limit != null) 'limit': '$limit',
      if (cursor != null) 'cursor': cursor,
    };
    final JsonMap res = await request(
      'GET',
      _withQuery('${_collectionPath(collection)}/export', query),
    );
    return ExportResult.fromJson(res);
  }
}
