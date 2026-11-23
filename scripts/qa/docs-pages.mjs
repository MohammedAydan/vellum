import ts from 'typescript';
import { readFileSync } from 'node:fs';

/** Read route metadata without importing React or evaluating documentation. */
export function docsPageSlugs() {
  const file = new URL('../../apps/docs/src/nav.ts', import.meta.url);
  const source = ts.createSourceFile(file.pathname, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const slugs = [];
  function visit(node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === 'slug' && ts.isStringLiteral(node.initializer)) {
      slugs.push(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (slugs.length === 0 || new Set(slugs).size !== slugs.length) {
    throw new Error('Documentation navigation must have nonempty unique routes');
  }
  return slugs;
}
