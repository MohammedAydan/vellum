import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { extractSnippets } from "./doc-snippets.mjs";

// No snippets are executed. Only the compiler/analyzer reads their source.
const root = resolve(import.meta.dirname, "../..");
const work = mkdtempSync(join(tmpdir(), "vellum-docs-types-"));
const snippets = extractSnippets(root);
const publicJs = snippets.filter(
  (s) =>
    ["ts", "typescript", "js", "javascript"].includes(s.lang) &&
    !s.file.includes("security-rules-dsl") &&
    !s.file.includes("metering-and-billing"),
);
const dart = snippets.filter((s) => s.lang === "dart");
function run(exe, args, cwd = root) {
  const r = spawnSync(exe, args, { cwd, encoding: "utf8" });
  if (r.status !== 0)
    throw new Error(`${exe} failed:\n${r.stdout || ""}${r.stderr || ""}`);
}
try {
  const jsDir = join(work, "js");
  mkdirSync(jsDir);
  writeFileSync(join(jsDir, "package.json"), '{"type":"module"}');
  const files = [];
  for (const [i, s] of publicJs.entries()) {
    const file = join(jsDir, `${i}.ts`);
    files.push(file);
    const prefix = /\b(?:const|let) db\s*=/.test(s.code)
      ? ""
      : `import {createClient as docsCreateClient} from '@vellumdb/sdk-js';\nconst db=docsCreateClient({projectId:'docs',apiKey:'sk_docs',endpoint:'http://127.0.0.1:8080'});\n`;
    writeFileSync(
      file,
      `// ${s.file}:${s.line}\n${prefix}${s.code}\nexport {};\n`,
    );
  }
  const published = process.argv.includes("--published");
  if (published)
    run(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "@vellumdb/sdk-js@0.0.8",
        "@types/node",
      ],
      jsDir,
    );
  const config = {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ["node"],
      typeRoots: [resolve(root, "node_modules/@types")],
      ...(!published
        ? {
            baseUrl: root,
            paths: {
              "@vellumdb/sdk-js": [
                resolve(root, "packages/sdk-js/dist/index.d.ts"),
              ],
            },
          }
        : {}),
    },
    files,
  };
  writeFileSync(join(jsDir, "tsconfig.json"), JSON.stringify(config));
  run(process.execPath, [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "-p",
    join(jsDir, "tsconfig.json"),
  ]);
  const dartDir = join(work, "dart");
  mkdirSync(dartDir);
  writeFileSync(
    join(dartDir, "pubspec.yaml"),
    `name: vellum_docs_typecheck\nenvironment:\n  sdk: '>=3.4.0 <4.0.0'\n  flutter: '>=3.22.0'\ndependencies:\n  flutter:\n    sdk: flutter\n  vellum_flutter:${published ? " 0.0.8" : `\n    path: ${resolve(root, "sdks/flutter")}`}\n  http: ^1.2.2\n`,
  );
  for (const [i, s] of dart.entries()) {
    const imports = [],
      body = [];
    for (const line of s.code.split("\n"))
      (line.startsWith("import ") ? imports : body).push(line);
    if (!imports.some((l) => l.includes("vellum_flutter")))
      imports.unshift("import 'package:vellum_flutter/vellum_flutter.dart';");
    let text = body.join("\n");
    const classes = [];
    // Models precede executable fragments. Preserve them at Dart library scope.
    while (/^class \w+/m.test(text)) {
      const start = text.search(/^class \w+/m),
        brace = text.indexOf("{", start);
      let depth = 1,
        end = brace + 1;
      while (depth && end < text.length) {
        depth += (text[end] === "{") - (text[end] === "}");
        end++;
      }
      classes.push(text.slice(start, end));
      text = text.slice(0, start) + text.slice(end);
    }
    if (!text.includes("Future<void> main()")) {
      const setup = /\bfinal (?:db|client)\s*=/.test(text)
        ? ""
        : "final db=VellumClient(endpoint:'http://127.0.0.1:8080',projectId:'docs',apiKey:'sk_docs');\nfinal client=db;\n";
      text = `Future<void> main() async {\n${setup}${text}\n}`;
    }
    writeFileSync(
      join(dartDir, `${i}.dart`),
      `// ${s.file}:${s.line}\n${imports.join("\n")}\n${classes.join("\n")}\n${text}\n`,
    );
  }
  run("flutter", ["pub", "get"], dartDir);
  const analysis = spawnSync("dart", ["analyze", "--format", "machine"], {
    cwd: dartDir,
    encoding: "utf8",
  });
  const errors = (analysis.stdout || "")
    .split("\n")
    .filter((l) => l.startsWith("ERROR|"));
  const hasOnlyFragmentWarnings = (analysis.stdout || "")
    .split("\n")
    .some((line) => /^(WARNING|INFO)\|/.test(line));
  if (errors.length || analysis.status === null || (analysis.status !== 0 && !hasOnlyFragmentWarnings))
    throw new Error(
      errors.join("\n") || analysis.stderr || "Dart analyzer did not finish",
    );
  console.log(
    `Checked ${publicJs.length} consumer JS/TS snippets and ${dart.length} Dart snippets against ${published ? "published 0.0.8" : "local SDK builds"}.`,
  );
  console.log(
    "Rules DSL and backend metering signatures are separate languages, not consumer SDK programs. Runtime fixtures remain a separate gate.",
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
