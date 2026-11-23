# SDK naming migration

Vellum is the product name. New application code should use the canonical SDK names below. Existing compatibility exports stay available; changing application imports is optional in this release.

## JavaScript and TypeScript

```ts
// Preferred
import { VellumClient, VellumAuthClient } from '@vellum/sdk-js';
import type { VellumClientConfig } from '@vellum/sdk-js';

// Still supported, with deprecated class aliases
import { VellumClient, VellumAuthClient } from '@vellum/sdk-js';
import type { VellumClientConfig } from '@vellum/sdk-js';
```

`VellumClient === VellumClient` and `VellumAuthClient === VellumAuthClient`. Type aliases retain their existing structure. No constructor options or request formats change.

Repository contributors should use `packages/sdk-js/src/client/vellum-client.ts`. The previous `vellum-client.ts` source file re-exports that module so existing source consumers continue to resolve it. The package exports map exposes only the package root; this does not add a supported deep-import API.

## Flutter and Dart

```dart
// Preferred
import 'package:vellum_flutter/vellum_flutter.dart';

// Existing compatibility library remains available
// import 'package:vellum_flutter/vellum_flutter.dart';
```

Prefer `VellumClient`, `VellumException`, and the corresponding `Vellum*` models. Existing `Vellum*` typedefs and the old library filename continue to work. This change adds no new Dart analyzer deprecation diagnostics.

## Compatibility boundary

There is no scheduled alias removal. Any removal belongs to a future major release, with a separate migration notice. Existing package IDs, error identifiers, wire fields, API headers, environment variables, SQL roles, storage keys and cookie names are unchanged. A product-name cleanup is not a data migration.
