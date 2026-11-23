/// Dependency injection composition root for `vellum_flutter`.
///
/// Provides factory helpers and a lightweight container so Flutter apps can
/// wire [VellumClientPort], [VellumAuthPort], [VellumRealtimePort], and
/// [TokenStoragePort] without coupling application layers to concrete types.
library vellum_flutter_di;

import 'dart:math';

import 'package:vellum_flutter/vellum_flutter.dart';
import 'package:http/http.dart' as http;

/// Creates a configured [VellumClientPort] backed by [VellumClient].
VellumClientPort createVellumClient({
  String? endpoint,
  required String projectId,
  required String apiKey,
  String? baseUrl,
  Future<String?> Function()? getAuthToken,
  HttpTransport? httpTransport,
  http.Client? httpClient,
  TokenStoragePort? authStorage,
  String? realtimeUrlOverride,
  RealtimeChannelFactory? webSocketChannelFactory,
  int Function(int attempt)? realtimeBackoff,
  IndexSuggestionCallback? onIndexSuggestion,
  bool warnOnMissingIndexes = true,
  Duration requestTimeout = const Duration(seconds: 30),
  int maxRetries = 3,
  Duration retryBaseDelay = const Duration(milliseconds: 250),
  Duration retryMaxDelay = const Duration(seconds: 15),
  bool coalesceInFlightGets = true,
  Random? random,
}) {
  return VellumClient(
    endpoint: endpoint,
    projectId: projectId,
    apiKey: apiKey,
    baseUrl: baseUrl,
    getAuthToken: getAuthToken,
    httpTransport: httpTransport,
    httpClient: httpClient,
    authStorage: authStorage,
    realtimeUrlOverride: realtimeUrlOverride,
    webSocketChannelFactory: webSocketChannelFactory,
    realtimeBackoff: realtimeBackoff,
    onIndexSuggestion: onIndexSuggestion,
    warnOnMissingIndexes: warnOnMissingIndexes,
    requestTimeout: requestTimeout,
    maxRetries: maxRetries,
    retryBaseDelay: retryBaseDelay,
    retryMaxDelay: retryMaxDelay,
    coalesceInFlightGets: coalesceInFlightGets,
    random: random,
  );
}

/// Composition root holding the typed contract ports for a VELLUM SDK instance.
class VellumSdkContainer {
  final VellumClientPort client;
  final VellumAuthPort auth;
  final VellumRealtimePort realtime;
  final TokenStoragePort tokenStorage;

  const VellumSdkContainer({
    required this.client,
    required this.auth,
    required this.realtime,
    required this.tokenStorage,
  });

  /// Builds a fully wired [VellumSdkContainer] with a shared [TokenStoragePort].
  factory VellumSdkContainer.create({
    String? endpoint,
    required String projectId,
    required String apiKey,
    String? baseUrl,
    Future<String?> Function()? getAuthToken,
    HttpTransport? httpTransport,
    http.Client? httpClient,
    TokenStoragePort? authStorage,
    String? realtimeUrlOverride,
    RealtimeChannelFactory? webSocketChannelFactory,
    int Function(int attempt)? realtimeBackoff,
    IndexSuggestionCallback? onIndexSuggestion,
    bool warnOnMissingIndexes = true,
    Duration requestTimeout = const Duration(seconds: 30),
    int maxRetries = 3,
    Duration retryBaseDelay = const Duration(milliseconds: 250),
    Duration retryMaxDelay = const Duration(seconds: 15),
    bool coalesceInFlightGets = true,
    Random? random,
  }) {
    final TokenStoragePort resolvedStorage =
        authStorage ?? InMemoryAuthTokenStorage();
    final VellumClientPort client = createVellumClient(
      endpoint: endpoint,
      projectId: projectId,
      apiKey: apiKey,
      baseUrl: baseUrl,
      getAuthToken: getAuthToken,
      httpTransport: httpTransport,
      httpClient: httpClient,
      authStorage: resolvedStorage,
      realtimeUrlOverride: realtimeUrlOverride,
      webSocketChannelFactory: webSocketChannelFactory,
      realtimeBackoff: realtimeBackoff,
      onIndexSuggestion: onIndexSuggestion,
      warnOnMissingIndexes: warnOnMissingIndexes,
      requestTimeout: requestTimeout,
      maxRetries: maxRetries,
      retryBaseDelay: retryBaseDelay,
      retryMaxDelay: retryMaxDelay,
      coalesceInFlightGets: coalesceInFlightGets,
      random: random,
    );
    return VellumSdkContainer(
      client: client,
      auth: client.auth,
      realtime: client.realtime,
      tokenStorage: resolvedStorage,
    );
  }

  /// Releases auth timers/streams, realtime sockets, and in-memory caches.
  void dispose() => client.dispose();
}
