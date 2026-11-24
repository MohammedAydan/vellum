import 'package:flutter/material.dart';
import 'package:vellum_flutter/vellum_flutter.dart';

/// Writes a document and reads it back. Returns a short status line.
Future<String> roundTrip(VellumClient client) async {
  final ref = client.collection('compat').doc();
  await ref.set(<String, Object?>{'hello': 'world'});
  final snap = await ref.get();
  return 'ok:${snap.data()?['hello']}';
}

class CompatApp extends StatelessWidget {
  const CompatApp({super.key, required this.client});

  final VellumClient client;

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Vellum compat',
      theme: ThemeData(colorSchemeSeed: Colors.blueGrey, useMaterial3: true),
      home: _Home(client: client),
    );
  }
}

class _Home extends StatefulWidget {
  const _Home({required this.client});

  final VellumClient client;

  @override
  State<_Home> createState() => _HomeState();
}

class _HomeState extends State<_Home> {
  String _status = 'idle';

  Future<void> _run() async {
    setState(() => _status = 'running');
    try {
      final result = await roundTrip(widget.client);
      if (mounted) setState(() => _status = result);
    } catch (error) {
      if (mounted) setState(() => _status = 'error:$error');
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Vellum compat')),
      body: Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(_status, key: const Key('status')),
            const SizedBox(height: 16),
            FilledButton(
              key: const Key('run'),
              onPressed: _run,
              child: const Text('Write and read'),
            ),
          ],
        ),
      ),
    );
  }
}

void main() {
  final client = VellumClient(
    endpoint: const String.fromEnvironment('VELLUM_ENDPOINT',
        defaultValue: 'http://localhost:8080'),
    projectId: const String.fromEnvironment('VELLUM_PROJECT', defaultValue: 'demo'),
    apiKey: const String.fromEnvironment('VELLUM_API_KEY', defaultValue: 'pk_demo'),
  );
  runApp(CompatApp(client: client));
}
