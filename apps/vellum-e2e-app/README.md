# Optional Flutter interactive console

This Material 3 application is an optional UI adapter for manual exploration. The standard Dart/Flutter live testbed is [examples/flutter_testbed_app](../../examples/flutter_testbed_app/README.md).

The console no longer maintains a separate copy of the 20-scenario runner. `lib/testbed_runner.dart` is a compatibility export of `package:flutter_testbed_app/testbed_runner.dart`, declared through a local path dependency. CLI, automated Dart tests and this UI therefore use the same scenario implementations and result types.

## Run

With Flutter available on PATH:

```bash
cd apps/vellum-e2e-app
flutter pub get
flutter run --dart-define=VELLUM_API_BASE_URL=http://127.0.0.1:8080
```

The Setup, Auth, Documents, Query, Realtime and Manage screens are retained. They call the real SDK against a running API. Existing paths and headless entry points remain compatible.

## Standard verification

Run the shared suite from the repository root:

```bash
cd examples/flutter_testbed_app
dart pub get
dart analyze --fatal-infos
dart test test/runner_compatibility_test.dart
# Requires a running development/test API backed by PostgreSQL:
dart run bin/run_live_testbed.dart
```

Building or testing the interactive Flutter screens still requires the Flutter toolchain:

```bash
cd apps/vellum-e2e-app
flutter pub get
flutter analyze
flutter test
flutter build linux --debug
```

A shared-runner pass is not a claim that this optional UI was rebuilt. Historical screenshots and reports are not current verification results.
