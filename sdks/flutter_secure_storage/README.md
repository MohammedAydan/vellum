# vellum_flutter_secure_storage

Persistent, encrypted session storage for `vellum_flutter`.

```yaml
dependencies:
  vellum_flutter: ^0.0.2
  vellum_flutter_secure_storage: ^0.0.2
```

That is all. Signed-in sessions now survive app restarts on Android, iOS, macOS,
Windows, Linux and the web (HTTPS or localhost). No code, no native setup.
If the platform secure store is unavailable at runtime, the session is kept in
memory instead and the app keeps working.

Android needs `minSdkVersion` 23 or higher (the Flutter default already is).
To pick the storage yourself: `VellumClient(authStorage: SecureAuthTokenStorage())`.
