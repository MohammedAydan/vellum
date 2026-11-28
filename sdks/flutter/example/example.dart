// ignore_for_file: avoid_print
// Minimal use of vellum_flutter: write a document, read it back and listen for changes.
//
// Replace the project id and public key with your own from the VELLUM console.
import 'package:vellum_flutter/vellum_flutter.dart';

Future<void> main() async {
  final client = VellumClient(
    projectId: 'your-project-id',
    apiKey: 'pk_your_public_key',
  );

  final note = client.doc('notes/hello');
  await note.set({'text': 'Hello from vellum_flutter'});

  final snapshot = await note.get();
  print('exists: ${snapshot.exists}, data: ${snapshot.data()}');

  final subscription = note.snapshots().listen((snap) {
    print('live update: ${snap.data()}');
  });

  await Future<void>.delayed(const Duration(seconds: 5));
  await subscription.cancel();
  client.close();
}
