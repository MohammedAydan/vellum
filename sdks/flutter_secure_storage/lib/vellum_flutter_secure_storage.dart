/// Persistent, encrypted session storage for `vellum_flutter`.
///
/// Adding this package to `pubspec.yaml` is all that is needed: it registers
/// itself as the default session store through Flutter's plugin mechanism.
/// Use [SecureAuthTokenStorage] directly to pass it explicitly.
library;

export 'src/plugin.dart' show VellumSecureStoragePlugin;
export 'src/secure_auth_token_storage.dart' show SecureAuthTokenStorage, SecureKeyValue;
