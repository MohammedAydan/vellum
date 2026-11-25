/** Tiny build-time syntax highlighter. Output is escaped HTML with <i class="t-*"> spans. */
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const KW = {
  ts: "const|let|await|async|import|from|return|new|try|finally|true|false|null",
  dart: "final|const|await|async|import|Future|void|true|false|null",
  rules: "match|allow|if|function|return|rules_version",
  bash: "curl",
  json: "",
};
export function highlight(code, lang = "ts") {
  const kw = KW[lang] || KW.ts;
  const re = new RegExp(
    [
      "(?<c>(?<!:)\\/\\/[^\\n]*|(?<![\\w$])#[^\\n]*)",
      "(?<s>\"(?:[^\"\\\\\\n]|\\\\.)*\"|'(?:[^'\\\\\\n]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`)",
      kw ? `(?<k>\\b(?:${kw})\\b)` : "(?<k>(?!x)x)",
      "(?<n>\\b\\d+(?:\\.\\d+)?\\b)",
      "(?<f>\\b[A-Za-z_][\\w]*(?=\\())",
      "(?<p>\\.[A-Za-z_]\\w*)",
    ].join("|"),
    "g",
  );
  let out = "", last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const g = m.groups;
    const cls = g.c ? "c" : g.s ? "s" : g.k ? "k" : g.n ? "n" : g.f ? "f" : "p";
    out += `<i class="t-${cls}">${esc(m[0])}</i>`;
    last = m.index + m[0].length;
  }
  return out + esc(code.slice(last));
}
