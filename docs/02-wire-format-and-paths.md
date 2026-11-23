# 02 — Canonical Document Paths & Tagged Wire Format Specification

## 1. Canonical Path Rules

Every resource in the Document Data Plane is addressed by a canonical `/`-separated UTF-8 path:

1. **Document Paths (Even Segments):** Must contain an even number of segments between `2` and `10` (up to 5 levels of nested collections):
   - Depth 2: `users/u_123`
   - Depth 4: `users/u_123/orders/ord_456`
   - Depth 10: `c1/d1/c2/d2/c3/d3/c4/d4/c5/d5`
2. **Collection Paths (Odd Segments):** Must contain an odd number of segments between `1` and `9`:
   - Depth 1: `users`
   - Depth 3: `users/u_123/orders`
3. **Segment Validation Constraints:**
   - Maximum byte length per segment: `1,500 bytes` (UTF-8).
   - Disallowed characters: forward slash `/`, null byte `\0`, and ASCII control characters (`0x00`–`0x1F`).
   - Reserved segments: `.` and `..` are rejected.
   - Reserved prefix/suffix: Any segment matching `^__.*__$` (e.g., `__name__`, `__system__`) is strictly reserved for internal engine metadata and rejected on user paths.
4. **Deterministic Path Decomposition:**
   Given `"users/u_123/orders/ord_456"`:
   - `path`: `"users/u_123/orders/ord_456"`
   - `collectionPath`: `"users/u_123/orders"`
   - `collectionGroup`: `"orders"` (final collection segment)
   - `documentId`: `"ord_456"`
   - `pathDepth`: `4`

---

## 2. Tagged Wire Format (v1)

To preserve rich data types across JSON over HTTP/WebSockets and inside PostgreSQL `JSONB` without colliding with user-defined maps, `@vellum/core` implements the **Canonical Tagged Wire Format**.

Standard JSON primitives (`null`, `boolean`, `string`, finite `number`, `array`) are stored directly as native JSON primitives so PostgreSQL `jsonb_path_ops` GIN indexes can index them without wrapper overhead. Extended types use the reserved tag key `"$t"` and value key `"$v"`:

| Logical Type | Wire & JSONB Representation | Validation Rules |
| :--- | :--- | :--- |
| `null` | `null` | Native JSON `null` |
| `boolean` | `true` / `false` | Native JSON boolean |
| `string` | `"hello"` | Valid UTF-8 string |
| `number` (double) | `42` or `3.14159` | Finite IEEE-754 float (`NaN`, `Infinity`, `-Infinity` rejected) |
| `int64` | `{"$t": "int", "$v": "-9007199254740993"}` | Signed 64-bit integer string $\in [-2^{63}, 2^{63}-1]$ |
| `timestamp` | `{"$t": "ts", "$v": "2026-11-15T14:30:00.123Z", "$ms": 1794753000123}` | ISO-8601 UTC string + exact epoch milliseconds `$ms` |
| `reference` | `{"$t": "ref", "$v": "users/u_123"}` | Valid canonical document path in the same project |
| `bytes` | `{"$t": "bytes", "$v": "SGVsbG8="}` | Valid standard Base64 string |
| `geopoint` | `{"$t": "geo", "$v": {"lat": 30.0444, "lng": 31.2357}}` | Finite `lat` $\in [-90, 90]$ and `lng` $\in [-180, 180]$ |
| `array` | `[ ... ]` | JSON array up to nesting depth `20` |
| `map` | `{"key": "value"}` | Plain JSON object without key `"$t"` |
| Escaped User Map | `{"$t": "map", "$v": {"$t": "user_custom"}}` | Automatic lossless wrapper when a user object contains literal key `"$t"` |

---

## 3. Nesting Depth, Field Names & Payload Size Limits

- **Maximum Object/Array Nesting Depth:** `20` levels inside `data`. Exceeding this throws `MAX_NESTING_EXCEEDED`.
- **Maximum Field Name Length:** `256` characters, cannot be empty, cannot contain unescaped `.` in top-level path expressions or control characters. Violating this throws `INVALID_FIELD_NAME`.
- **Maximum Serialized Document Size:** `1,048,576 bytes` (`1 MiB` UTF-8). Violating this throws `DOCUMENT_TOO_LARGE`.
