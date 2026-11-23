/// Public entry point for the live VELLUM Flutter showcase.
///
/// The showcase uses a conditional export so the SAME public API works in two
/// toolchains:
///
///  * **Flutter** (`dart.library.flutter` is true): the real Material 3 widget
///    tree in `src/showcase_flutter.dart` is exported. `VellumShowcaseApp` is a
///    `StatelessWidget` you can pass to `runApp()`.
///  * **Pure Dart** (`dart analyze`, `dart test`, the CLI testbed): the typed
///    descriptor in `src/showcase_stub.dart` is exported. It exposes the same
///    `VellumShowcaseApp` constructor plus the shared scenario model, so the
///    showcase can be inspected and verified without a Flutter SDK.
///
/// Both implementations share `lib/src/showcase_model.dart`; there is no
/// duplicated scenario data and no placeholder behavior.
library;

export 'src/showcase_model.dart';

export 'src/showcase_stub.dart'
    if (dart.library.flutter) 'src/showcase_flutter.dart';
