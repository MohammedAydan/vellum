/// Server-Sent Events realtime channel for hosts without WebSocket support.
part of '../../vellum_flutter_core.dart';

/// Converts a realtime WebSocket or HTTP URL into the SSE stream URL.
///
/// The result never carries an explicit port `:0`, a fragment (`#`) or a query.
Uri vellumRealtimeSseUri(String url) {
  var value = url.trim();
  value =
      value.replaceFirst(RegExp(r'^wss://', caseSensitive: false), 'https://');
  value =
      value.replaceFirst(RegExp(r'^ws://', caseSensitive: false), 'http://');
  final parsed = Uri.parse(value);
  var path = parsed.path.replaceFirst(RegExp(r'/+$'), '');
  path = path.replaceFirst(RegExp(r'/v1/realtime(/stream)?$'), '');
  final int? port = parsed.hasPort && parsed.port > 0 ? parsed.port : null;
  return Uri(
    scheme: parsed.scheme,
    host: parsed.host,
    port: port,
    path: '$path/v1/realtime/stream',
  );
}

/// Normalizes any realtime URL (including `:0` and trailing `#`) to a clean
/// `ws(s)://host[:port]/v1/realtime` [Uri].
Uri vellumSanitizeRealtimeUri(String url) {
  final value = url.trim().replaceFirst(RegExp(r'#.*$'), '');
  final parsed = Uri.parse(value);
  final scheme = switch (parsed.scheme.toLowerCase()) {
    'https' || 'wss' => 'wss',
    _ => 'ws',
  };
  final int? port = parsed.hasPort && parsed.port > 0 ? parsed.port : null;
  var path = parsed.path.replaceFirst(RegExp(r'/+$'), '');
  if (!path.endsWith('/v1/realtime')) path = '$path/v1/realtime';
  return Uri(scheme: scheme, host: parsed.host, port: port, path: path);
}

class _SseSink implements WebSocketSink {
  final SseWebSocketChannel _channel;
  final Completer<void> _done = Completer<void>();

  _SseSink(this._channel);

  @override
  void add(Object? data) => _channel._onClientFrame(data);

  @override
  void addError(Object error, [StackTrace? stackTrace]) {}

  @override
  Future<void> addStream(Stream<Object?> stream) async {
    await for (final Object? data in stream) {
      add(data);
    }
  }

  @override
  Future<void> close([int? closeCode, String? closeReason]) {
    _channel._close(closeCode, closeReason);
    if (!_done.isCompleted) _done.complete();
    return _done.future;
  }

  @override
  Future<void> get done => _done.future;
}

/// A [WebSocketChannel] look-alike that carries the realtime protocol over a
/// streaming `POST /v1/realtime/stream`. Frames written to [sink] are collected
/// (auth + subscriptions); every change of subscriptions, and every server-side
/// stream renewal, opens a new stream that resumes each subscription from its
/// last seen `seqId`.
class SseWebSocketChannel extends StreamChannelMixin<Object?>
    implements WebSocketChannel {
  final Uri url;
  final http.Client Function() _clientFactory;
  final Duration _debounce;

  /// A stream that delivers nothing, not even the server's 15 second
  /// `: keep-alive` comment, for this long is treated as dead and reopened
  /// (with resume). Without this a half-open connection hangs forever.
  final Duration idleTimeout;
  Timer? _idleTimer;
  final StreamController<Object?> _incoming = StreamController<Object?>();
  late final _SseSink _sink = _SseSink(this);
  final Completer<void> _ready = Completer<void>()..complete();

  JsonMap? _authFrame;
  final Map<String, JsonMap> _subs = <String, JsonMap>{};
  final Map<String, int> _lastSeq = <String, int>{};
  http.Client? _client;
  int _generation = 0;
  Timer? _restartTimer;
  bool _ackForwarded = false;
  bool _streamOpen = false;
  bool _closed = false;
  int? _closeCode;
  String? _closeReason;

  SseWebSocketChannel(
    this.url, {
    http.Client Function()? clientFactory,
    Duration debounce = const Duration(milliseconds: 5),
    this.idleTimeout = const Duration(seconds: 45),
  })  : _clientFactory = clientFactory ?? http.Client.new,
        _debounce = debounce;

  /// Default factory used by the SDK: [vellumRealtimeSseUri] over `package:http`.
  static WebSocketChannel connect(Uri url) =>
      SseWebSocketChannel(vellumRealtimeSseUri(url.toString()));

  @override
  String? get protocol => null;

  @override
  int? get closeCode => _closeCode;

  @override
  String? get closeReason => _closeReason;

  @override
  Future<void> get ready => _ready.future;

  @override
  Stream<Object?> get stream => _incoming.stream;

  @override
  WebSocketSink get sink => _sink;

  void _onClientFrame(Object? data) {
    if (_closed || data is! String) return;
    final Object? decoded;
    try {
      decoded = jsonDecode(data);
    } catch (_) {
      return;
    }
    if (decoded is! Map) return;
    final frame = decoded.cast<String, Object?>();
    switch (frame['type']) {
      case 'auth':
        final reauth = _authFrame != null;
        _authFrame = frame;
        if (reauth) _ackForwarded = true;
        _scheduleRestart(reauth ? _debounce : Duration.zero);
      case 'subscribe':
        final subId = frame['subId'];
        if (subId is! String) return;
        final rest = Map<String, Object?>.of(frame)..remove('resumeSeqId');
        final resume = frame['resumeSeqId'];
        if (resume is num && !_lastSeq.containsKey(subId)) {
          _lastSeq[subId] = resume.toInt();
        }
        _subs[subId] = rest;
        if (_authFrame != null) _scheduleRestart(_debounce);
      case 'unsubscribe':
        final subId = frame['subId'];
        if (subId is! String) return;
        _subs.remove(subId);
        _lastSeq.remove(subId);
        if (_authFrame != null) _scheduleRestart(_debounce);
      case 'ping':
        if (_streamOpen) {
          _emit(<String, Object?>{
            'type': 'pong',
            'ts': frame['ts'],
            'serverTs': DateTime.now().millisecondsSinceEpoch,
          });
        }
    }
  }

  void _emit(JsonMap frame) {
    if (_closed || _incoming.isClosed) return;
    _incoming.add(jsonEncode(frame));
  }

  void _scheduleRestart(Duration delay) {
    _restartTimer?.cancel();
    _restartTimer = Timer(delay, () {
      _restartTimer = null;
      _startStream();
    });
  }

  List<JsonMap> _buildFrames() {
    final frames = <JsonMap>[_authFrame!];
    _subs.forEach((subId, sub) {
      final seq = _lastSeq[subId];
      frames.add(
          seq != null ? <String, Object?>{...sub, 'resumeSeqId': seq} : sub);
    });
    return frames;
  }

  /// (Re)starts the liveness timer. Called on open and on every received byte,
  /// so keep-alive comments count as proof the stream is alive.
  void _armIdle(int generation) {
    _idleTimer?.cancel();
    _idleTimer = Timer(idleTimeout, () {
      if (generation != _generation || _closed) return;
      if (!_incoming.isClosed) {
        _incoming
            .addError(TimeoutException('Realtime stream idle', idleTimeout));
      }
      _fail(generation, 1006, 'stream idle');
    });
  }

  void _fail(int generation, int code, String reason) {
    if (generation != _generation || _closed) return;
    _idleTimer?.cancel();
    _generation++;
    _streamOpen = false;
    _client?.close();
    _client = null;
    _closeCode = code;
    _closeReason = reason;
    _closed = true;
    if (!_incoming.isClosed) _incoming.close();
  }

  Future<void> _startStream() async {
    if (_closed || _authFrame == null) return;
    _client?.close();
    final generation = ++_generation;
    final client = _clientFactory();
    _client = client;
    _streamOpen = false;
    _armIdle(generation);
    try {
      final request = http.Request('POST', url)
        ..headers['content-type'] = 'application/json'
        ..headers['accept'] = 'text/event-stream'
        ..body = jsonEncode(<String, Object?>{'frames': _buildFrames()});
      final response = await client.send(request);
      if (generation != _generation) return;
      if (response.statusCode < 200 || response.statusCode >= 300) {
        var code = 'INTERNAL_ERROR';
        var message = 'HTTP ${response.statusCode}';
        try {
          final text = await response.stream.bytesToString();
          final parsed = jsonDecode(text);
          if (parsed is Map) {
            final error = parsed['error'];
            if (error is Map) {
              code = (error['code'] as String?) ?? code;
              message = (error['message'] as String?) ?? message;
            } else {
              code = (parsed['code'] as String?) ?? code;
              message = (parsed['message'] as String?) ?? message;
            }
          }
        } catch (_) {}
        _emit(<String, Object?>{
          'type': 'error',
          'code': code,
          'message': message
        });
        _fail(generation, 1008, message);
        return;
      }
      _streamOpen = true;
      var buffer = '';
      var renew = false;
      await for (final chunk in response.stream.transform(utf8.decoder)) {
        if (generation != _generation) return;
        _armIdle(generation);
        buffer += chunk.replaceAll('\r\n', '\n');
        var idx = buffer.indexOf('\n\n');
        while (idx >= 0) {
          final block = buffer.substring(0, idx);
          buffer = buffer.substring(idx + 2);
          idx = buffer.indexOf('\n\n');
          if (_handleBlock(block)) renew = true;
        }
      }
      if (generation != _generation) return;
      _idleTimer?.cancel();
      _streamOpen = false;
      if (renew) {
        // Bounded server stream lifetime reached: continue with resume.
        _ackForwarded = true;
        unawaited(_startStream());
      } else {
        _fail(generation, 1006, 'stream ended');
      }
    } catch (error) {
      if (generation != _generation) return;
      if (!_incoming.isClosed) _incoming.addError(error);
      _fail(generation, 1006, error.toString());
    }
  }

  /// Returns true when the server asked the client to renew the stream.
  bool _handleBlock(String block) {
    var event = 'message';
    final data = <String>[];
    for (final line in block.split('\n')) {
      if (line.startsWith(':')) continue;
      if (line.startsWith('event:')) {
        event = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        data.add(line.substring(5).replaceFirst(RegExp(r'^ '), ''));
      }
    }
    if (event == 'reconnect') return true;
    if (data.isEmpty) return false;
    final Object? decoded;
    try {
      decoded = jsonDecode(data.join('\n'));
    } catch (_) {
      return false;
    }
    if (decoded is! Map) return false;
    final frame = decoded.cast<String, Object?>();
    if (frame['type'] == 'auth_ack') {
      // Internal renewals must not trigger the transport's resubscribe again.
      if (_ackForwarded) return false;
      _ackForwarded = true;
    }
    final subId = frame['subId'];
    final rawSeq = frame['seqId'];
    final int? seq = rawSeq is num
        ? rawSeq.toInt()
        : (rawSeq is String ? int.tryParse(rawSeq) : null);
    if (subId is String && seq != null && _subs.containsKey(subId)) {
      final prev = _lastSeq[subId];
      // A mutation at or below the last seq already delivered is a replay (for example after a
      // stream renewal): drop it so listeners see each change once.
      if (frame['type'] == 'mutation' && prev != null && seq <= prev)
        return false;
      if (prev == null || seq > prev) _lastSeq[subId] = seq;
    }
    _emit(frame);
    return false;
  }

  void _close(int? code, String? reason) {
    if (_closed) return;
    _closed = true;
    _closeCode = code;
    _closeReason = reason;
    _generation++;
    _restartTimer?.cancel();
    _idleTimer?.cancel();
    _client?.close();
    _client = null;
    if (!_incoming.isClosed) _incoming.close();
  }
}

/// How the SDK connects for realtime.
enum VellumRealtimeMode {
  /// WebSocket first; falls back to SSE (HTTP streaming) when WebSocket cannot
  /// be used, for example on serverless hosts such as Vercel.
  auto,

  /// WebSocket only, never falls back.
  websocket,

  /// HTTP streaming (SSE) only.
  sse,
}

/// WebSocket-first channel with automatic SSE fallback.
///
/// The connection is attempted over WebSocket. When it cannot be established
/// (upgrade refused, no WebSocket support, closed before the first server
/// frame, or no open within [openTimeout]) the channel switches to
/// [SseWebSocketChannel] and replays the auth frame and active subscriptions.
/// The decision is remembered per host for ten minutes.
class FallbackWebSocketChannel extends StreamChannelMixin<Object?>
    implements WebSocketChannel {
  static final Map<String, DateTime> _sticky = <String, DateTime>{};

  /// Test helper: forgets which hosts fell back to SSE.
  static void resetStickyFallback() => _sticky.clear();

  final Uri url;
  final WebSocketChannel Function(Uri url) _primaryFactory;
  final WebSocketChannel Function(Uri url) _fallbackFactory;
  final Duration _openTimeout;
  final void Function(Object reason)? _onFallback;
  final StreamController<Object?> _incoming = StreamController<Object?>();
  final Completer<void> _ready = Completer<void>();
  late final _FallbackSink _sink = _FallbackSink(this);

  WebSocketChannel? _inner;
  StreamSubscription<Object?>? _innerSub;
  Timer? _openTimer;
  bool _usingFallback = false;
  bool _opened = false;
  bool _gotMessage = false;
  bool _closed = false;
  String? _authRaw;
  final Map<String, String> _subsRaw = <String, String>{};

  FallbackWebSocketChannel(
    this.url, {
    WebSocketChannel Function(Uri url)? primaryFactory,
    WebSocketChannel Function(Uri url)? fallbackFactory,
    Duration openTimeout = const Duration(seconds: 4),
    void Function(Object reason)? onFallback,
  })  : _primaryFactory = primaryFactory ?? WebSocketChannel.connect,
        _fallbackFactory = fallbackFactory ?? SseWebSocketChannel.connect,
        _openTimeout = openTimeout,
        _onFallback = onFallback {
    final until = _sticky[url.host];
    if (until != null && until.isAfter(DateTime.now())) {
      _useFallback('remembered: host does not support WebSocket');
    } else {
      _startPrimary();
    }
  }

  /// Default factory used by the SDK in [VellumRealtimeMode.auto].
  static WebSocketChannel connect(Uri url) => FallbackWebSocketChannel(url);

  void _startPrimary() {
    final WebSocketChannel channel;
    try {
      channel = _primaryFactory(url);
    } catch (error) {
      _useFallback(error);
      return;
    }
    _attach(channel);
    _openTimer = Timer(_openTimeout, () {
      if (!_usingFallback && !_opened) {
        _useFallback(TimeoutException('WebSocket open timed out'));
      }
    });
    channel.ready.then((_) {
      if (_inner != channel || _closed) return;
      _openTimer?.cancel();
      _opened = true;
      if (!_ready.isCompleted) _ready.complete();
    }, onError: (Object error) {
      if (_inner == channel && !_usingFallback) _useFallback(error);
    });
  }

  void _attach(WebSocketChannel channel) {
    _inner = channel;
    _innerSub = channel.stream.listen(
      (Object? data) {
        if (_inner != channel) return;
        _gotMessage = true;
        if (!_incoming.isClosed) _incoming.add(data);
      },
      onError: (Object error) {
        if (_inner != channel) return;
        if (!_usingFallback && !_gotMessage) {
          _useFallback(error);
          return;
        }
        if (!_incoming.isClosed) _incoming.addError(error);
      },
      onDone: () {
        if (_inner != channel) return;
        if (!_usingFallback && !_gotMessage && !_closed) {
          _useFallback(
              StateError('WebSocket closed before the first server frame'));
          return;
        }
        if (!_incoming.isClosed) _incoming.close();
      },
      cancelOnError: false,
    );
  }

  void _useFallback(Object reason) {
    if (_usingFallback || _closed) return;
    _usingFallback = true;
    _openTimer?.cancel();
    _sticky[url.host] = DateTime.now().add(const Duration(minutes: 10));
    final old = _inner;
    _inner = null;
    _innerSub?.cancel();
    _innerSub = null;
    try {
      old?.sink.close();
    } catch (_) {}
    try {
      _onFallback?.call(reason);
    } catch (_) {}
    final fallback = _fallbackFactory(url);
    _attach(fallback);
    fallback.ready.then((_) {
      if (_inner != fallback || _closed) return;
      final wasOpen = _ready.isCompleted;
      _opened = true;
      if (!_ready.isCompleted) _ready.complete();
      if (wasOpen) {
        // The transport already authenticated over the dropped WebSocket.
        final auth = _authRaw;
        if (auth != null) {
          fallback.sink.add(auth);
        }
        for (final raw in _subsRaw.values) {
          fallback.sink.add(raw);
        }
      }
    }, onError: (Object error) {
      if (!_ready.isCompleted) _ready.completeError(error);
    });
  }

  void _record(Object? data) {
    if (data is! String) return;
    try {
      final decoded = jsonDecode(data);
      if (decoded is! Map) return;
      final type = decoded['type'];
      final subId = decoded['subId'];
      if (type == 'auth') {
        _authRaw = data;
      } else if (type == 'subscribe' && subId is String) {
        _subsRaw[subId] = data;
      } else if (type == 'unsubscribe' && subId is String) {
        _subsRaw.remove(subId);
      }
    } catch (_) {}
  }

  void _close(int? code, String? reason) {
    if (_closed) return;
    _closed = true;
    _openTimer?.cancel();
    final inner = _inner;
    _inner = null;
    _innerSub?.cancel();
    inner?.sink.close(code, reason);
    if (!_incoming.isClosed) _incoming.close();
  }

  @override
  String? get protocol => _inner?.protocol;

  @override
  int? get closeCode => _inner?.closeCode;

  @override
  String? get closeReason => _inner?.closeReason;

  @override
  Future<void> get ready => _ready.future;

  @override
  Stream<Object?> get stream => _incoming.stream;

  @override
  WebSocketSink get sink => _sink;
}

class _FallbackSink implements WebSocketSink {
  final FallbackWebSocketChannel _channel;
  final Completer<void> _done = Completer<void>();

  _FallbackSink(this._channel);

  @override
  void add(Object? data) {
    if (_channel._closed) return;
    _channel._record(data);
    _channel._inner?.sink.add(data);
  }

  @override
  void addError(Object error, [StackTrace? stackTrace]) {}

  @override
  Future<void> addStream(Stream<Object?> stream) async {
    await for (final Object? data in stream) {
      add(data);
    }
  }

  @override
  Future<void> close([int? closeCode, String? closeReason]) {
    _channel._close(closeCode, closeReason);
    if (!_done.isCompleted) _done.complete();
    return _done.future;
  }

  @override
  Future<void> get done => _done.future;
}
