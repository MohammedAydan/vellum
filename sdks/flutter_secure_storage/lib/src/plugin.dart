import 'package:vellum_flutter/vellum_flutter.dart';

import 'secure_auth_token_storage.dart';

/// Registers [SecureAuthTokenStorage] as the default session store.
///
/// Flutter calls [registerWith] automatically at app start on Android, iOS,
/// Linux, macOS and Windows; the web entry point is in `web_registration.dart`.
class VellumSecureStoragePlugin {
  static void registerWith() => install();

  /// Installs the secure default. Safe to call more than once.
  static void install() {
    VellumDefaults.authStorageFactory = SecureAuthTokenStorage.new;
  }
}
