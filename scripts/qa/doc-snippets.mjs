import ts from "typescript";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
export function extractSnippets(root) {
  function walk(p) {
    return readdirSync(p, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(p, e.name)) : [join(p, e.name)],
    );
  }
  const globals = new Map();
  for (const rel of [
    "apps/docs/src/quickstart-examples.ts",
    "apps/docs/src/beta-install.ts",
  ]) {
    const file = resolve(root, rel);
    const tree = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    function visit(n) {
      if (
        ts.isVariableDeclaration(n) &&
        n.initializer &&
        (ts.isStringLiteral(n.initializer) ||
          ts.isNoSubstitutionTemplateLiteral(n.initializer))
      )
        globals.set(n.name.getText(tree), n.initializer.text);
      ts.forEachChild(n, visit);
    }
    visit(tree);
  }
  const snippets = [];
  for (const file of walk(resolve(root, "apps/docs/src/pages")).filter((f) =>
    f.endsWith(".tsx"),
  )) {
    const text = readFileSync(file, "utf8"),
      tree = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      ),
      values = new Map(globals);
    function get(n) {
      if (!n) return;
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n))
        return n.text;
      if (ts.isIdentifier(n)) return values.get(n.text);
    }
    function collect(n) {
      if (ts.isVariableDeclaration(n) && n.initializer) {
        const v = get(n.initializer);
        if (v !== undefined) values.set(n.name.getText(tree), v);
      }
      ts.forEachChild(n, collect);
    }
    collect(tree);
    function add(n, code, lang) {
      if (code === undefined) return;
      snippets.push({
        file,
        line: tree.getLineAndCharacterOfPosition(n.getStart(tree)).line + 1,
        lang,
        code,
      });
    }
    function visit(n) {
      if (ts.isJsxSelfClosingElement(n) || ts.isJsxOpeningElement(n)) {
        const attrs = n.attributes.properties;
        const a = (name) =>
          attrs.find(
            (x) => ts.isJsxAttribute(x) && x.name.getText(tree) === name,
          )?.initializer;
        const val = (x) =>
          x && (ts.isJsxExpression(x) ? get(x.expression) : get(x));
        if (n.tagName.getText(tree) === "Code")
          add(n, val(a("code")), val(a("lang")) || "text");
        if (n.tagName.getText(tree) === "CodeTabs") {
          const tabs = a("tabs");
          if (
            tabs &&
            ts.isJsxExpression(tabs) &&
            tabs.expression &&
            ts.isArrayLiteralExpression(tabs.expression)
          )
            for (const el of tabs.expression.elements)
              if (ts.isObjectLiteralExpression(el)) {
                const prop = (name) =>
                  el.properties.find(
                    (x) =>
                      ts.isPropertyAssignment(x) &&
                      x.name.getText(tree) === name,
                  )?.initializer;
                add(el, get(prop("code")), get(prop("lang")) || "text");
              }
        }
      }
      ts.forEachChild(n, visit);
    }
    visit(tree);
  }
  return snippets.map((s) => ({ ...s, file: s.file.replace(root + "/", "") }));
}
