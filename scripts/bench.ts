/**
 * mitata microbenchmarks for the three hot pure-JS paths.
 * Run with `corepack pnpm bench`. No database and no network required.
 */
import { bench, group, run } from "mitata";
import {
  compileQuery,
  decodeWire,
  encodeSortKey,
  encodeWire,
  makeNormalizedQuery,
  makeSortableDoc,
  makeWireDocument,
} from "../tests/unit/bench-perf/fixtures.js";

const document = makeWireDocument(42);
const encoded = encodeWire(document);
const sortableDocs = Array.from({ length: 8 }, (_, index) => makeSortableDoc(index + 1));
const normalizedQuery = makeNormalizedQuery();

group("wire-format encode/decode", () => {
  bench("normalizeAndValidateDocumentData (encode)", () => encodeWire(document));
  bench("validateWireValue + JSON.parse (decode)", () => decodeWire(encoded.json));
  bench("full encode->decode round trip", () => decodeWire(encodeWire(document).json));
});

group("sort-key encoder", () => {
  bench("encodeCompositeSortKey (3 fields)", () => encodeSortKey(sortableDocs[0]!));
  bench("encodeCompositeSortKey (8 docs)", () => {
    for (const doc of sortableDocs) encodeSortKey(doc);
  });
});

group("query compilation", () => {
  bench("validateAndNormalizeQuery + compile (unindexed)", () => compileQuery(normalizedQuery, false));
  bench("validateAndNormalizeQuery + compile (indexed)", () => compileQuery(normalizedQuery, true));
});

await run();
