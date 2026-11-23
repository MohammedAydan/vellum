/// Pure-Dart implementation of the showcase surface.
///
/// This module is selected by `flutter_ui_showcase.dart` whenever the code is
/// compiled with the pure Dart SDK (`dart analyze`, `dart test`, the CLI
/// testbed). It is NOT a mock: it exposes the real shared scenario model and a
/// buildable showcase descriptor, so tooling can introspect the same UI
/// configuration that the Flutter widget tree renders.
library;

import 'showcase_model.dart';

export 'showcase_model.dart';

/// Platform-neutral handle for the showcase application.
///
/// Under Flutter this name resolves to the Material `StatelessWidget` defined
/// in `src/showcase_flutter.dart`; under pure Dart it resolves to this class
/// with an identical constructor surface.
class VellumShowcaseApp {
  final String apiBaseUrl;
  final String projectId;
  final String publicApiKey;

  const VellumShowcaseApp({
    this.apiBaseUrl = 'http://127.0.0.1:8080',
    this.projectId = '',
    this.publicApiKey = '',
  });

  /// Stable description used by diagnostics and tests.
  String describe() => describeShowcase();

  @override
  String toString() => describe();
}
