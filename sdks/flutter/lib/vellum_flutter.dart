/// Official Production Flutter/Dart SDK (`vellum_flutter`) for VELLUM.
/// Matches the v1 Tagged Wire Format (`$t` / `$v`), REST `/v1` API, OCC transactions,
/// `withConverter<T>()` type-safe model mapping, and WebSocket Realtime protocol with
/// full-jitter exponential backoff (`t0 = 500ms`, `tMax = 30000ms`).
library vellum_flutter;

import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:http/http.dart' as http;
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

export 'generated/error_codes.g.dart';

// Core primitives, validation, backoff, and wire encoding
part 'src/core/exceptions.dart';
part 'src/core/path_validator.dart';
part 'src/core/backoff.dart';
part 'src/core/wire.dart';

// Immutable snapshots, query/collection models, and index advisor
part 'src/models/snapshots.dart';
part 'src/cache/document_cache.dart';

// End-user authentication, session models, and token storage
part 'src/auth/auth_models.dart';
part 'src/auth/token_storage.dart';
part 'src/auth/auth_client.dart';

// Realtime WebSocket transport and subscription manager
part 'src/realtime/realtime_transport.dart';
part 'src/realtime/sse_channel.dart';
part 'src/realtime/realtime_manager.dart';

// Main client, references/queries, and batch/transaction builders
part 'src/client/vellum_client.dart';
part 'src/client/references.dart';
part 'src/client/batch_and_tx.dart';
part 'src/contracts/ports.dart';
