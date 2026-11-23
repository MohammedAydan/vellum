/** Dependency-free, HTML-safe syntax highlighter for the static docs site. */

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const KEYWORDS = [
  "import", "from", "export", "default", "const", "let", "var", "function", "return", "async", "await",
  "if", "else", "for", "while", "switch", "case", "break", "continue", "try", "catch", "finally", "throw",
  "new", "class", "extends", "implements", "interface", "type", "as", "in", "of", "instanceof", "this",
  "true", "false", "null", "undefined", "void", "static", "public", "private", "protected", "readonly",
  "final", "late", "var", "val", "when", "is", "factory", "get", "set", "yield", "do", "super", "enum",
  "abstract", "sealed", "mixin", "external", "covariant", "typedef", "assert", "async", "sync",
];

const TOKEN_RULES = [
  ["comment", /\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*/],
  ["string", /`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/],
  ["number", /\b(?:0x[0-9a-fA-F]+|\d+(?:\.\d+)?)\b/],
  ["keyword", new RegExp(`\\b(?:${KEYWORDS.join("|")})\\b`)],
  ["fn", /\b[A-Za-z_$][\w$]*(?=\s*\()/],
  ["type", /\b[A-Z][A-Za-z0-9_]*\b/],
  ["property", /\.[A-Za-z_$][\w$]*/],
];

const COMBINED = new RegExp(TOKEN_RULES.map(([name, re]) => `(?<${name}>${re.source})`).join("|"), "gm");

export function highlight(code, lang = "text") {
  const text = String(code ?? "");
  if (lang === "text" || lang === "") return esc(text);
  let out = "";
  let last = 0;
  for (const match of text.matchAll(COMBINED)) {
    out += esc(text.slice(last, match.index));
    const name = TOKEN_RULES.find(([rule]) => match.groups?.[rule] !== undefined)?.[0] ?? "text";
    out += `<span class="hl-${name}">${esc(match[0])}</span>`;
    last = match.index + match[0].length;
  }
  return out + esc(text.slice(last));
}
