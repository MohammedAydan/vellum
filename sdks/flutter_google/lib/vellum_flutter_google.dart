/// Optional native Google sign-in for `vellum_flutter`.
///
/// Browser-based Google and GitHub sign-in ships inside `vellum_flutter`
/// (`createVellumOAuth`). Add this package only if you want the native Google
/// account picker.
library;

export 'src/google_native.dart' show signInWithNativeGoogle;
