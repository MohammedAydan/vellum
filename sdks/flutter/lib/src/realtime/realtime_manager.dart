/// Multiplexed realtime subscription manager with resumeSeqId and leak-free disposal.
part of '../../vellum_flutter.dart';

/// Multiplexes realtime subscriptions over a single [VellumRealtimeTransport].
class VellumRealtimeManager implements VellumRealtimePort {
  final VellumClient client;
  VellumRealtimeTransport? _transport;
  final Map<String, void Function(JsonMap)> _frameHandlers =
      <String, void Function(JsonMap)>{};
  final Map<String, void Function(Object)> _errorHandlers = <String, void Function(Object)>{};
  final Map<String, void Function()> _closeHandlers = <String, void Function()>{};
  int _counter = 0;

  VellumRealtimeManager(this.client);

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

    final transport = _transport ??= VellumRealtimeTransport(
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
        for (final handler in _errorHandlers.values) {
          handler(error);
        }
      },
      channelFactory: client.webSocketChannelFactory ??
          switch (client.realtimeMode) {
            VellumRealtimeMode.auto => FallbackWebSocketChannel.connect,
            VellumRealtimeMode.websocket => null,
            VellumRealtimeMode.sse => SseWebSocketChannel.connect,
          },
      backoffMs: client.realtimeBackoff,
    );
    transport.subscribe(subId, target);
    return subId;
  }

  @override
  void unsubscribe(String subId) {
    _frameHandlers.remove(subId);
    _errorHandlers.remove(subId);
    _closeHandlers.remove(subId);
    final transport = _transport;
    if (transport == null) return;
    transport.unsubscribe(subId);
    if (_frameHandlers.isEmpty) {
      transport.close();
      _transport = null;
    }
  }

  /// Re-authenticates active subscriptions after an end-user token rotation.
  void refreshCredentials() => _transport?.reauthenticate();

  /// Closes the underlying WebSocket transport and notifies all active streams.
  @override
  void dispose() {
    final closers = _closeHandlers.values.toList();
    _frameHandlers.clear();
    _errorHandlers.clear();
    _closeHandlers.clear();
    final transport = _transport;
    _transport = null;
    transport?.close();
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
