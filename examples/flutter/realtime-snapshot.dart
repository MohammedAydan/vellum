import 'dart:io';
// Executed against the live PostgreSQL API by scripts/run-dart-examples.mjs.
//
// Realtime snapshots — watch a sensor document and a channel query.
// What you'll build: a live ops dashboard that listens via `snapshots()` and
// observes a new reading and a new matching sensor.
// Real-world scenario: the SDK multiplexes subscriptions over one WebSocket
// transport with full-jitter reconnect; cancelling the stream unsubscribes.
import 'package:vellum_flutter/vellum_flutter.dart';

Future<void> main() async {
  final endpoint = Platform.environment['VELLUM_API_BASE'] ??
      const String.fromEnvironment('VELLUM_API_BASE',
          defaultValue: 'http://127.0.0.1:8080');
  final projectId = Platform.environment['VELLUM_PROJECT_ID'] ??
      const String.fromEnvironment('VELLUM_PROJECT_ID');
  final apiKey = Platform.environment['VELLUM_API_KEY'] ??
      const String.fromEnvironment('VELLUM_API_KEY');

  final client =
      VellumClient(endpoint: endpoint, projectId: projectId, apiKey: apiKey);
  final prefix = 'ex_flutter_realtime_${DateTime.now().microsecondsSinceEpoch}';
  final col = client.collection(prefix);
  final ref = col.doc('sensor-1');

  try {
    print('=== Realtime Snapshots (Flutter) ===');
    await ref.set({'reading': 1, 'channel': 'sensors'});

    final docSub = ref.snapshots().listen((snap) {
      print(
          'document change: version=${snap.version} reading=${snap.data()?['reading']}');
    });
    final querySub =
        col.where('channel', '==', 'sensors').snapshots().listen((page) {
      print(
          'query snapshot: count=${page.docs.length} watermark=${page.watermarkSeqId}');
    });

    await Future<void>.delayed(const Duration(seconds: 1));
    await ref.update({'reading': 2});
    await col.doc('sensor-2').set({'reading': 3, 'channel': 'sensors'});
    await Future<void>.delayed(const Duration(seconds: 1));

    final finalDoc = await ref.get();
    print('finalReading=${finalDoc.data()?['reading']}');

    await docSub.cancel();
    await querySub.cancel();
  } finally {
    for (final id in ['sensor-1', 'sensor-2']) {
      try {
        await col.doc(id).delete();
      } catch (_) {}
    }
    client.dispose();
  }
}
