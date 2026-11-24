@TestOn('vm')
library;

import 'package:flutter_testbed_app/testbed_runner.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('all 20 live scenarios pass against VELLUM_API_BASE_URL', () async {
    final runner = VellumLiveTestbedRunner();
    final results = await runner.runAll();

    expect(results, hasLength(20), reason: 'the runner must execute 20 scenarios');

    final failures = results.where((result) => !result.passed).toList();
    final report = failures
        .map((result) => '${result.name}: ${result.error ?? 'unknown error'}')
        .join('\n');
    expect(
      failures,
      isEmpty,
      reason: 'Live API is required at ${runner.baseUrl}. Failures:\n$report',
    );
  }, timeout: const Timeout(Duration(minutes: 5)));
}
