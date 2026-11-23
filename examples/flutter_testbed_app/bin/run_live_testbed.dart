import 'dart:io';

import 'package:flutter_testbed_app/testbed_runner.dart';

Future<void> main(List<String> arguments) async {
  final explicitBaseUrl = arguments.isEmpty ? null : arguments.first;
  final runner = VellumLiveTestbedRunner(baseUrl: explicitBaseUrl);

  stdout.writeln('VELLUM - Flutter SDK live testbed');
  stdout.writeln('Target: ${runner.baseUrl}');
  stdout.writeln('');

  final List<ScenarioResult> results;
  try {
    results = await runner.runAll();
  } catch (error) {
    stderr.writeln('BOOTSTRAP FAILED: $error');
    stderr.writeln(
      'Set VELLUM_API_BASE_URL to a running API (default http://127.0.0.1:8080).',
    );
    exitCode = 1;
    return;
  }

  const separator =
      '--------------------------------------------------------------------------------';
  stdout.writeln(separator);
  stdout.writeln(
    '${'Scenario'.padRight(56)}${'Result'.padRight(8)}Latency',
  );
  stdout.writeln(separator);
  for (final result in results) {
    stdout.writeln(
      '${result.name.padRight(56)}'
      '${result.status.padRight(8)}'
      '${result.latencyMs} ms',
    );
  }
  stdout.writeln(separator);

  final failures = results.where((result) => !result.passed).toList();
  if (failures.isEmpty) {
    stdout.writeln('All ${results.length} live scenarios passed.');
    exitCode = 0;
    return;
  }

  stdout.writeln('${failures.length} of ${results.length} scenarios failed:');
  for (final failure in failures) {
    stdout.writeln('  - ${failure.name}: ${failure.error ?? 'unknown error'}');
  }
  exitCode = 1;
}
