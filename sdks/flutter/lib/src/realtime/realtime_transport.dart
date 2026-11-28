/// WebSocket realtime transport with decorrelated jitter, heartbeat, and bounded outbound queue.
part of '../../vellum_flutter_core.dart';

/// Converts an HTTP(S) or WS(S) endpoint into the canonical realtime URL.
String vellumRealtimeUrl(String endpoint) {
  var value = endpoint.replaceAll(RegExp(r'/+$'), '');
  if (value.startsWith('ws://') || value.startsWith('wss://')) {
    return value.endsWith('/v1/realtime') ? value : '$value/v1/realtime';
  }
  value = value
      .replaceFirst(RegExp(r'^http://'), 'ws://')
      .replaceFirst(RegExp(r'^https://'), 'wss://');
  return value.endsWith('/v1/realtime') ? value : '$value/v1/realtime';
}

/// JSON codec for VELLUM WebSocket protocol frames.
class RealtimeFrames {
  RealtimeFrames._();

  static String encode(JsonMap frame) => jsonEncode(frame);

  static JsonMap? decode(Object? data) {
    if (data is String) {
      try {
        final Object? decoded = jsonDecode(data);
        if (decoded is Map) return decoded.cast<String, Object?>();
      } catch (_) {
        return null;
      }
      return null;
    }
    if (data is List<int>) {
      return decode(utf8.decode(data, allowMalformed: true));
    }
    return null;
  }
}

/// Channel factory seam (defaults to `WebSocketChannel.connect`).
typedef RealtimeChannelFactory = WebSocketChannel Function(Uri url);

/// Connection state of the realtime transport, surfaced on the client as
/// `connectionState` / `connectionStateStream` (Track 3).
enum VellumRealtimeConnectionState {
  connecting,
  connected,
  reconnecting,
  disconnected
}

/// Connection state plus the transport kind actually in use (Track 3).
class VellumConnectionState {
  final VellumRealtimeConnectionState state;

  /// `websocket` or `sse` when knowable; null before the first connect in
  /// auto mode.
  final String? transportKind;

  const VellumConnectionState({required this.state, this.transportKind});

  @override
  String toString() =>
      'VellumConnectionState($state${transportKind != null ? ', $transportKind' : ''})';
}

class _TrackedSubscription {
  final String subId;
  final JsonMap target;
  int? lastSeqId;

  _TrackedSubscription(this.subId, this.target);
}

/// Native RFC 6455 realtime transport with auth handshake, heartbeat,
/// offline queue, subscription map and full-jitter reconnect + resume.
class VellumRealtimeTransport {
  final Uri url;
  final Future<JsonMap> Function() auth;
  final void Function(JsonMap frame) onFrame;
  final void Function(Object error)? onError;
  final void Function(VellumRealtimeConnectionState state)?
      onConnectionStateChange;
  final RealtimeChannelFactory channelFactory;
  final Duration heartbeatInterval;
  final Duration pongTimeout;
  final Duration connectTimeout;
  final int maxOutboundQueueSize;
  final int Function(int attempt) backoffMs;
  final bool _useCustomBackoff;

  WebSocketChannel? _channel;
  StreamSubscription<Object?>? _subscription;
  Timer? _heartbeatTimer;
  Timer? _reconnectTimer;
  Timer? _connectTimer;
  bool _authenticated = false;
  bool _closed = false;
  int _attempt = 0;
  int _lastReconnectDelayMs = 500;
  DateTime _lastPongAt = DateTime.now();

  final Map<String, _TrackedSubscription> _subscriptions =
      <String, _TrackedSubscription>{};
  final List<String> _outboundQueue = <String>[];
  final List<Completer<void>> _connectWaiters = <Completer<void>>[];

  VellumRealtimeTransport({
    required this.url,
    required this.auth,
    required this.onFrame,
    this.onError,
    this.onConnectionStateChange,
    RealtimeChannelFactory? channelFactory,
    this.heartbeatInterval = const Duration(seconds: 15),
    this.pongTimeout = const Duration(seconds: 35),
    this.connectTimeout = const Duration(seconds: 10),
    this.maxOutboundQueueSize = 256,
    int Function(int attempt)? backoffMs,
  })  : channelFactory =
            channelFactory ?? ((uri) => WebSocketChannel.connect(uri)),
        _useCustomBackoff = backoffMs != null,
        backoffMs =
            backoffMs ?? ((attempt) => computeReconnectBackoffMs(attempt));

  bool get isAuthenticated => _authenticated;

  /// Kind of the live channel when it is known: `websocket` or `sse` from the
  /// auto-fallback channel; null otherwise (forced modes know their kind at
  /// the client).
  String? get activeTransportKind {
    final channel = _channel;
    if (channel is FallbackWebSocketChannel) return channel.transportKind;
    return null;
  }

  void _emitConnectionState(VellumRealtimeConnectionState state) {
    final listener = onConnectionStateChange;
    if (listener == null) return;
    try {
      listener(state);
    } catch (_) {
      // A throwing listener must never break realtime state transitions.
    }
  }

  /// Number of frames currently buffered in the bounded outbound queue.
  int get outboundQueueLength => _outboundQueue.length;

  /// Last observed `seqId` for [subId] (used as `resumeSeqId` on reconnect).
  int? lastSeqIdFor(String subId) => _subscriptions[subId]?.lastSeqId;

  Future<void> connect() async {
    if (_authenticated) return;
    if (_closed) throw StateError('Realtime transport is closed');
    final completer = Completer<void>();
    _connectWaiters.add(completer);
    if (_channel == null) _open();
    return completer.future;
  }

  void subscribe(String subId, JsonMap target) {
    _subscriptions[subId] = _TrackedSubscription(subId, target);
    if (_authenticated) {
      _write({'type': 'subscribe', 'subId': subId, ...target});
    } else if (_channel == null) {
      connect().catchError((_) {});
    }
  }

  /// Refreshes socket credentials without dropping stream listeners or resume
  /// positions. The server clears subscriptions on auth, then auth_ack restores
  /// them through the normal resubscribe path.
  void reauthenticate() {
    if (_closed || !_authenticated || _channel == null) return;
    _authenticated = false;
    _connectTimer?.cancel();
    _connectTimer = Timer(connectTimeout, () {
      if (!_authenticated) {
        _fail(TimeoutException('Realtime reauthentication timed out'));
      }
    });
    _sendAuth();
  }

  void unsubscribe(String subId) {
    _subscriptions.remove(subId);
    if (_closed) return;
    final frame =
        RealtimeFrames.encode({'type': 'unsubscribe', 'subId': subId});
    if (_authenticated && _channel != null) {
      _channel?.sink.add(frame);
    } else {
      _enqueueOutbound(frame);
    }
  }

  void _enqueueOutbound(String encodedFrame) {
    if (_closed || maxOutboundQueueSize <= 0) return;
    while (_outboundQueue.length >= maxOutboundQueueSize) {
      _outboundQueue.removeAt(0);
    }
    _outboundQueue.add(encodedFrame);
  }

  void close() {
    _closed = true;
    _authenticated = false;
    _emitConnectionState(VellumRealtimeConnectionState.disconnected);
    _heartbeatTimer?.cancel();
    _heartbeatTimer = null;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _connectTimer?.cancel();
    _connectTimer = null;
    for (final waiter in _connectWaiters) {
      if (!waiter.isCompleted) {
        waiter.completeError(StateError('Realtime transport closed'));
      }
    }
    _connectWaiters.clear();
    _outboundQueue.clear();
    _subscriptions.clear();
    final channel = _channel;
    _channel = null;
    _subscription?.cancel();
    _subscription = null;
    channel?.sink.close();
  }

  void _open() {
    _emitConnectionState(VellumRealtimeConnectionState.connecting);
    _connectTimer?.cancel();
    _connectTimer = Timer(connectTimeout, () {
      if (!_authenticated) {
        _fail(TimeoutException('Realtime connection timed out'));
      }
    });

    WebSocketChannel channel;
    try {
      channel = channelFactory(url);
    } catch (error) {
      _fail(error);
      return;
    }
    _channel = channel;
    _lastPongAt = DateTime.now();
    _subscription = channel.stream.listen(
      (data) {
        // Any inbound data proves the socket is alive, not only a pong.
        _lastPongAt = DateTime.now();
        final frame = RealtimeFrames.decode(data);
        if (frame != null) _handleFrame(frame);
      },
      onError: (Object error) {
        onError?.call(error);
      },
      onDone: () {
        _handleClose();
      },
      cancelOnError: false,
    );
    channel.ready.then((_) {
      if (_channel == channel && !_closed) _sendAuth();
    }, onError: (Object error) {
      if (_channel == channel) _fail(error);
    });
  }

  Future<void> _sendAuth() async {
    try {
      final frame = await auth();
      _write(frame);
    } catch (error) {
      _fail(error);
    }
  }

  void _handleFrame(JsonMap frame) {
    final type = frame['type'];
    if (type == 'auth_ack') {
      _connectTimer?.cancel();
      _connectTimer = null;
      _authenticated = true;
      _emitConnectionState(VellumRealtimeConnectionState.connected);
      _attempt = 0;
      _lastReconnectDelayMs = 500;
      _lastPongAt = DateTime.now();
      _startHeartbeat();
      _flushOutboundQueue();
      _resubscribeAll();
      for (final waiter in _connectWaiters) {
        if (!waiter.isCompleted) waiter.complete();
      }
      _connectWaiters.clear();
      return;
    }
    if (type == 'pong') {
      _lastPongAt = DateTime.now();
      return;
    }

    final subId = frame['subId'] is String ? frame['subId'] as String : null;
    final rawSeq = frame['seqId'] ?? frame['watermarkSeqId'];
    int? parsedSeq;
    if (rawSeq is num) {
      parsedSeq = rawSeq.toInt();
    } else if (rawSeq is String) {
      parsedSeq = int.tryParse(rawSeq);
    }
    if (subId != null && parsedSeq != null) {
      final tracked = _subscriptions[subId];
      final lastSeqId = tracked?.lastSeqId;
      if (tracked != null && (lastSeqId == null || parsedSeq > lastSeqId)) {
        tracked.lastSeqId = parsedSeq;
      }
    }
    onFrame(frame);
  }

  void _startHeartbeat() {
    _heartbeatTimer?.cancel();
    _heartbeatTimer = Timer.periodic(heartbeatInterval, (_) {
      if (_closed || !_authenticated || _channel == null) return;
      if (DateTime.now().difference(_lastPongAt) > pongTimeout) {
        // Proactively tear down dead half-open sockets and trigger reconnect.
        _authenticated = false;
        _heartbeatTimer?.cancel();
        _heartbeatTimer = null;
        _fail(TimeoutException('Realtime heartbeat pong timed out'));
        return;
      }
      _write({'type': 'ping', 'ts': DateTime.now().millisecondsSinceEpoch});
    });
  }

  void _resubscribeAll() {
    for (final tracked in _subscriptions.values) {
      final resumeSeqId = tracked.lastSeqId;
      _write({
        'type': 'subscribe',
        'subId': tracked.subId,
        ...tracked.target,
        if (resumeSeqId != null) 'resumeSeqId': resumeSeqId,
      });
    }
  }

  void _write(JsonMap frame) {
    if (_closed) return;
    final encoded = RealtimeFrames.encode(frame);
    final channel = _channel;
    if (channel == null) {
      _enqueueOutbound(encoded);
      return;
    }
    channel.sink.add(encoded);
  }

  void _flushOutboundQueue() {
    final channel = _channel;
    if (channel == null) return;
    for (final frame in _outboundQueue) {
      channel.sink.add(frame);
    }
    _outboundQueue.clear();
  }

  void _fail(Object error) {
    final channel = _channel;
    _channel = null;
    _subscription?.cancel();
    _subscription = null;
    channel?.sink.close();
    _connectTimer?.cancel();
    if (_closed) return;
    onError?.call(error);
    for (final waiter in _connectWaiters) {
      if (!waiter.isCompleted) waiter.completeError(error);
    }
    _connectWaiters.clear();
    _scheduleReconnect();
  }

  void _handleClose() {
    _channel = null;
    _subscription = null;
    _connectTimer?.cancel();
    _heartbeatTimer?.cancel();
    _authenticated = false;
    if (_closed) return;
    for (final waiter in _connectWaiters) {
      if (!waiter.isCompleted) {
        waiter.completeError(StateError('Realtime connection closed'));
      }
    }
    _connectWaiters.clear();
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_closed || _reconnectTimer != null) return;
    _emitConnectionState(VellumRealtimeConnectionState.reconnecting);
    final delay = _useCustomBackoff
        ? backoffMs(_attempt)
        : computeDecorrelatedJitterBackoffMs(_lastReconnectDelayMs);
    _lastReconnectDelayMs = max(500, delay);
    _attempt++;
    _reconnectTimer = Timer(Duration(milliseconds: delay), () {
      _reconnectTimer = null;
      if (!_closed) _open();
    });
  }

  @override
  String toString() =>
      'VellumRealtimeTransport(url: $url, authenticated: $_authenticated, closed: $_closed)';
}
