// Verifies the conditional showcase facade under the pure Dart toolchain.
// Under Flutter the same import resolves to the Material widget implementation.
import 'package:flutter_testbed_app/flutter_ui_showcase.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('flutter_ui_showcase conditional facade', () {
    test('exposes all 16 shared scenario descriptors', () {
      expect(kScenarios, hasLength(16));
      expect(kScenarios.map((s) => s.number).toList(),
          equals(List<String>.generate(16, (i) => (i + 1).toString().padLeft(2, '0'))));
      expect(kScenarios.every((s) => s.title.isNotEmpty && s.detail.isNotEmpty), isTrue);
      expect(ShowcaseIcon.values, hasLength(16));
    });

    test('VellumShowcaseApp is constructible and describes the live showcase', () {
      const app = VellumShowcaseApp(
        apiBaseUrl: 'http://127.0.0.1:8080',
        projectId: 'proj_test',
        publicApiKey: 'pk_test',
      );
      expect(app.projectId, 'proj_test');
      expect(app.describe(), contains('16 live scenarios'));
      expect(describeShowcase(), contains('VELLUM Flutter Showcase'));
    });
  });
}
