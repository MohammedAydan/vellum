/// Compatibility entry point for the optional Flutter interactive console.
///
/// The standard Dart/Flutter live testbed owns the only scenario runner.
/// Keep this forwarding file so existing console imports continue to compile.
library;

export 'package:flutter_testbed_app/testbed_runner.dart';
