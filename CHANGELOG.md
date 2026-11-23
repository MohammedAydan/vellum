# Changelog

## Unreleased

### Version alignment (0.0.1)

- The whole project and every SDK now share one version: `0.0.1`. This covers all workspace `package.json` files (`apps/*`, `packages/*`, `examples/js-testbed-app`), the Flutter/Dart pubspecs (`sdks/flutter`, testbeds, e2e app, dart-verify) and their lockfile entries, the `/v1/health*` and `/admin/overview` runtime version fields, and the OpenAPI contract info version (source and generated artifact).
- `node scripts/check-version-sync.mjs` (`pnpm version:check`) keeps them in sync and runs in CI.

### Flutter/Dart SDK parity

- `DocumentReference.referencedBy()` and `referencedByAs<D>()` wrap `POST /documents:referencedBy`: permission-filtered reverse lookup with opaque cursor pagination, optional collection/field narrowing, `select` and `include`. Results preserve empty continuation pages and never apply the target's converter to dependents.
- `DocumentReference.snapshots()` and `Query.snapshots()` accept `resolveIncludes` and `include`: opt-in point-in-time relation resolution on realtime frames (max 10 specs, depth 1). Resolved payloads surface on `DocumentSnapshot.included`, redacted targets on `DocumentSnapshot.redactedRefs`.
- Renamed the primary test file to `vellum_flutter_test.dart`; example secure-storage keys in docs now use `vellum_*` names. The HTTP wire headers (`x-vellum-api-key`, `x-vellum-index-*`) are intentionally unchanged: they remain the canonical server contract.

### SDK naming compatibility

- The JavaScript client implementation now lives in `client/vellum-client.ts`. The old source path remains a re-export shim; neither source path is a supported package subpath export.
- Import `VellumClient` and `VellumAuthClient` from `@vellum/sdk-js` in new code. Existing root exports `VellumClient`, `VellumAuthClient` and the `Vellum*` type aliases remain available. Class aliases refer to the same constructors, not wrappers.
- In Flutter/Dart, use `package:vellum_flutter/vellum_flutter.dart` and the `Vellum*` names. The `vellum_flutter.dart` compatibility barrel and existing `Vellum*` typedefs remain available without a removal date. No new Dart analyzer deprecation diagnostics are introduced in this release.
- No aliases are removed here. Removal, if needed, requires a separate major-version change with migration notes. This release does not rename npm/pub package IDs, HTTP headers, wire fields, SQL roles, stored keys, cookies, or existing persisted identifiers.

See [SDK naming migration](docs/SDK-NAMING-MIGRATION.md).
