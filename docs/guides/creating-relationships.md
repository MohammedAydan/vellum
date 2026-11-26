# Create relationships between documents

A relationship is a normal document field containing a reference to another document in the same project. You do not need a separate relationship-creation endpoint. Use a single reference for one target, or an array of references for several targets.

## JavaScript and TypeScript

This example works with `@vellumdb/sdk-js`. `db` is an initialized project client with permission to write these documents.

```ts
const ref = (path: string) => ({ $t: "ref" as const, $v: path });

// Create the target documents first.
await db.doc("users/u1").create({ name: "Ada" });
await db.doc("users/u2").create({ name: "Sam" });

// Create a source document with one-to-one and one-to-many references.
await db.doc("posts/p1").create({
  title: "First post",
  author: ref("users/u1"),
  reviewers: [ref("users/u1"), ref("users/u2")],
});

// Loading a relationship is separate from writing it.
const post = await db.doc("posts/p1").get({
  include: ["author", "reviewers"],
});
console.log(post.included?.["author"]);
console.log(post.included?.["reviewers"]);

// Reassign, then unlink. Neither operation changes the target document.
await db.doc("posts/p1").update({ author: ref("users/u2") });
await db.doc("posts/p1").update({ author: null });

// Reverse lookup: find posts that still refer to u1 as a reviewer.
let cursor: string | undefined;
do {
  const page = await db.doc("users/u1").referencedBy({
    collection: "posts", field: "reviewers", limit: 25, cursor,
  });
  for (const source of page.documents) console.log(source.path);
  cursor = page.nextCursor ?? undefined;
} while (cursor !== undefined);
```

The source tree also exports a validated `reference(path)` helper. After installing a release containing that helper, replace the local `ref` function with `import { reference as ref } from "@vellumdb/sdk-js"`. Older releases (0.0.1) do not export it.

## Flutter and Dart

`client` is an initialized project client. `VellumWire.reference` is available in published `vellum_flutter` 0.0.1.

```dart
await client.doc('users/u1').create({'name': 'Ada'});
await client.doc('users/u2').create({'name': 'Sam'});
await client.doc('posts/p1').create({
  'title': 'First post',
  'author': VellumWire.reference('users/u1'),
  'reviewers': [
    VellumWire.reference('users/u1'),
    VellumWire.reference('users/u2'),
  ],
});
final post = await client.doc('posts/p1').get(
  include: ['author', 'reviewers'],
);
print(post.included?['author']);
print(post.included?['reviewers']);
await client.doc('posts/p1').update({
  'author': VellumWire.reference('users/u2'),
});
await client.doc('posts/p1').update({'author': null});
String? cursor;
do {
  final page = await client.doc('users/u1').referencedBy(
    collection: 'posts', field: 'reviewers', limit: 25, cursor: cursor,
  );
  for (final source in page.documents) {
    print(source.path);
  }
  cursor = page.nextCursor;
} while (cursor != null);
```

## REST

The same value goes inside `data` on the normal document write routes. For example, after creating `users/u1`:

```http
POST /v1/projects/PROJECT_ID/documents/posts/p1
Content-Type: application/json
x-vellum-api-key: PROJECT_API_KEY

{"data":{"title":"First post","author":{"$t":"ref","$v":"users/u1"}}}
```

Requests must satisfy the project's security rules and authentication requirements. Where needed, send the signed-in user's bearer token with the project API key.

## Behavior and limits

- Store a project-relative canonical document path such as `users/u1`, not a URL, project ID, collection-only path, or live SDK `DocumentReference` instance. Paths alternate collection/document segments, with 2 to 10 segments. The API caps paths at 2048 characters and each segment at 1500 UTF-8 bytes. Reserved `__...__`, traversal and control-character segments are invalid.
- A reference does not create its target, prove that the target exists, enforce uniqueness, or create a reciprocal field. Creating the targets first makes examples predictable, but a write can contain a dangling reference.
- Include expansion checks read permission for each target. A denied scalar target resolves to null and the attachment key appears in `redactedRefs`. Missing scalar targets resolve to null. Arrays omit missing and denied targets; denied targets also add redaction metadata. Do not treat the number of expanded targets as the number of stored references.
- Use explicit full paths instead of inferred collection names. Nested includes have a maximum depth of 3 and bounded fan-out.
- Changing or removing a reference is an ordinary document update. Existing array operations can add or remove members; pass the exact stored tagged value for removal.
- `include` only controls reading. It does not install persistent delete behavior. A reference alone is not a foreign-key constraint. Existing project delete rules, if configured, determine restrict/cascade/set-null behavior; otherwise dangling references can remain after target deletion.
- Writes use the existing document realtime events. Query/document subscriptions can request includes. This guide adds no new event type or delivery guarantee.
- Use fresh example document IDs, or handle already-existing documents when rerunning these create-only examples.
