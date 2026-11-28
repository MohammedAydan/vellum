/// Multiplexed realtime subscription manager with resumeSeqId and leak-free disposal.
part of '../../vellum_flutter_core.dart';

/// Multiplexes realtime subscriptions over [VellumRealtimeTransport] sockets: up to
/// [subscriptionsPerSocket] (the server limit, 25) share one socket, and each further
/// group of 25 opens one more pooled socket, up to [maxSockets]. Past that cap the
/// subscription's error handler receives `SUBSCRIPTION_LIMIT_EXCEEDED` instead of
/// the subscription silently never delivering.
class VellumRealtimeManager implements VellumRealtimePort {
  final VellumClient client;
  static const int subscriptionsPerSocket = 25;

  /// Maximum pooled sockets (40 x 25 = 1,000 subscriptions). Set to 1 to disable pooling.
  final int maxSockets;
  final List<VellumRealtimeTransport> _transports = <VellumRealtimeTransport>[];
  final Map<String, VellumRealtimeTransport> _shardOf = <String, VellumRealtimeTransport>{};
  final Map<VellumRealtimeTransport, int> _shardCounts = <VellumRealtimeTransport, int>{};

  /// Number of sockets currently allocated (visible for tests and diagnostics).
  int get socketCount => _transports.length;
  VellumRealtimeTransport? get _transport => _transports.isEmpty ? null : _transports.first;
  final Map<String, void Function(JsonMap)> _frameHandlers =
      <String, void Function(JsonMap)>{};
  final Map<String, void Function(Object)> _errorHandlers = <String, void Function(Object)>{};
  final Map<String, void Function()> _closeHandlers = <String, void Function()>{};
  int _counter = 0;
  VellumRealtimeConnectionState _connectionState =
      VellumRealtimeConnectionState.disconnected;
  final StreamController<VellumRealtimeConnectionState>
      _connectionStateController =
      StreamController<VellumRealtimeConnectionState>.broadcast();
  bool _outageErrorDelivered = false;

  VellumRealtimeManager(this.client, {this.maxSockets = 40});

  /// Current connection state of the realtime transport (Track 3).
  VellumRealtimeConnectionState get connectionState => _connectionState;

  /// Broadcast stream of connection-state transitions (Track 3).
  Stream<VellumRealtimeConnectionState> get connectionStateStream =>
      _connectionStateController.stream;

  /// Kind of the live transport (`websocket` / `sse`) when knowable, else null.
  String? get activeTransportKind => _transport?.activeTransportKind;

  void _onConnectionState(VellumRealtimeConnectionState state) {
    _connectionState = state;
    if (state == VellumRealtimeConnectionState.connected) {
      _outageErrorDelivered = false;
    }
    if (!_connectionStateController.isClosed) {
      _connectionStateController.add(state);
    }
  }

  @override
  String subscribe(
    JsonMap target,
    void Function(JsonMap frame) onFrame,
    void Function(Object error)? onError, {
    void Function()? onClose,
  }) {
    final subId = 'sub_${DateTime.now().microsecondsSinceEpoch}_${_counter++}';
    if (onError != null) _errorHandlers[subId] = onError;
    if (onClose != null) _closeHandlers[subId] = onClose;
    _frameHandlers[subId] = onFrame;

    VellumRealtimeTransport? transport;
    for (final t in _transports) {
      if ((_shardCounts[t] ?? 0) < subscriptionsPerSocket) {
        transport = t;
        break;
      }
    }
    if (transport == null) {
      if (_transports.length >= maxSockets) {
        _frameHandlers.remove(subId);
        _errorHandlers.remove(subId);
        _closeHandlers.remove(subId);
        if (onError != null) {
          onError(const VellumException(
            code: 'SUBSCRIPTION_LIMIT_EXCEEDED',
            message: 'Too many active subscriptions: $subscriptionsPerSocket per socket, '
                'limited by maxSockets',
            statusCode: 0,
          ));
        }
        return subId;
      }
      late final VellumRealtimeTransport created;
      created = VellumRealtimeTransport(
        url: vellumSanitizeRealtimeUri(client.realtimeUrlOverride ?? vellumRealtimeUrl(client.realtimeEndpoint)),
        auth: () async {
          final token = await client.resolveAuthToken();
          return <String, Object?>{
            'type': 'auth',
            'projectId': client.projectId,
            'apiKey': client.apiKey,
            if (token != null && token.isNotEmpty) 'authToken': token,
          };
        },
        onFrame: (JsonMap frame) {
          final id = frame['subId'] is String ? frame['subId'] as String : null;
          if (id == null) return;
          final handler = _frameHandlers[id];
          handler?.call(frame);
        },
        onError: (Object error) {
          // Once per subscription per outage (Track 3): a transport-level fault
          // fans a single error to each subscription until the connection
          // recovers, instead of an error per failed connect attempt.
          if (_outageErrorDelivered) return;
          _outageErrorDelivered = true;
          for (final handler in _errorHandlers.values) {
            handler(error);
          }
        },
        // Only the first socket drives the client's connection state.
        onConnectionStateChange: (VellumRealtimeConnectionState st) {
          if (_transports.isEmpty || identical(_transports.first, created)) _onConnectionState(st);
        },
        channelFactory: client.webSocketChannelFactory ??
            switch (client.realtimeMode) {
              VellumRealtimeMode.auto => FallbackWebSocketChannel.connect,
              VellumRealtimeMode.websocket => null,
              VellumRealtimeMode.sse => SseWebSocketChannel.connect,
            },
        backoffMs: client.realtimeBackoff,
      );
      _transports.add(created);
      transport = created;
    }
    _shardOf[subId] = transport;
    _shardCounts[transport] = (_shardCounts[transport] ?? 0) + 1;
    transport.subscribe(subId, target);
    return subId;
  }

  @override
  void unsubscribe(String subId) {
    _frameHandlers.remove(subId);
    _errorHandlers.remove(subId);
    _closeHandlers.remove(subId);
    final transport = _shardOf.remove(subId);
    if (transport == null) return;
    transport.unsubscribe(subId);
    final left = (_shardCounts[transport] ?? 1) - 1;
    if (left > 0) {
      _shardCounts[transport] = left;
      return;
    }
    _shardCounts.remove(transport);
    // Close an emptied socket (primary included) so idle sockets never accumulate.
    transport.close();
    _transports.remove(transport);
  }

  /// Re-authenticates active subscriptions after an end-user token rotation.
  void refreshCredentials() {
    for (final t in _transports) {
      t.reauthenticate();
    }
  }

  /// Closes the underlying WebSocket transport and notifies all active streams.
  @override
  void dispose() {
    final closers = _closeHandlers.values.toList();
    _frameHandlers.clear();
    _errorHandlers.clear();
    _closeHandlers.clear();
    final transports = List<VellumRealtimeTransport>.of(_transports);
    _transports.clear();
    _shardOf.clear();
    _shardCounts.clear();
    for (final t in transports) {
      t.close();
    }
    _onConnectionState(VellumRealtimeConnectionState.disconnected);
    for (final closer in closers) {
      try {
        closer();
      } catch (_) {}
    }
  }

  /// Alias for [dispose].
  @override
  void close() => dispose();
}
