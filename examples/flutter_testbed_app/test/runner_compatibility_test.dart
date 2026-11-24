import 'package:flutter_testbed_app/testbed_runner.dart' as standard;
import 'package:flutter_test/flutter_test.dart';
// Exercise the old console source entry without requiring the Flutter SDK.
// ignore: avoid_relative_lib_imports
import '../../../apps/vellum-e2e-app/lib/testbed_runner.dart' as console;

void main() {
  test('interactive console forwards the standard result type', () {
    const result = console.ScenarioResult(
      name: 'compatibility',
      passed: true,
      latencyMs: 0,
    );
    expect(result, isA<standard.ScenarioResult>());
    expect(result.status, 'PASS');
  });

  test('interactive console forwards the standard runner type', () {
    final runner = console.VellumLiveTestbedRunner(
      baseUrl: 'http://127.0.0.1:1',
    );
    expect(runner, isA<standard.VellumLiveTestbedRunner>());
    expect(runner.baseUrl, 'http://127.0.0.1:1');
  });
}
