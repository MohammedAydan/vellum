/** Tiny HTML to Markdown converter for the server-rendered docs pages. */
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });

const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "path", "rect", "circle", "line"]);

function parse(html) {
  const root = { tag: "root", attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z][a-zA-Z0-9]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1];
    if (m[5] !== undefined) top.children.push(decode(m[5]));
    else if (m[1]) {
      const t = m[1].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === t) { stack.length = i; break; }
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      const attrs = {};
      for (const a of m[3].matchAll(/([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        attrs[a[1]] = decode(a[2] ?? a[3] ?? a[4] ?? "");
      }
      const node = { tag, attrs, children: [] };
      top.children.push(node);
      if (!m[4] && !VOID.has(tag)) stack.push(node);
    }
  }
  return root;
}

const text = (n) => (typeof n === "string" ? n : n.children.map(text).join("") + (cls(n, "flex") && n.tag === "span" ? "\n" : ""));
const cls = (n, c) => typeof n !== "string" && (n.attrs.class ?? "").split(/\s+/).includes(c);

function inline(nodes, base) {
  let out = "";
  for (const n of nodes) {
    if (typeof n === "string") { out += n.replace(/\s+/g, " "); continue; }
    switch (n.tag) {
      case "svg": case "button": case "script": case "style": break;
      case "br": out += "\n"; break;
      case "code": { const raw = text(n); const t = raw.trim(); if (!t) break; if (/^\s/.test(raw)) out += " "; out += t.includes("`") ? "``" + t + "``" : "`" + t + "`"; if (/\s$/.test(raw)) out += " "; break; }
      case "strong": case "b": out += "**" + inline(n.children, base).trim() + "**"; break;
      case "em": case "i": out += "*" + inline(n.children, base).trim() + "*"; break;
      case "a": {
        if (cls(n, "doc-anchor")) break;
        const label = inline(n.children, base).trim();
        let href = n.attrs.href ?? "";
        if (href.startsWith("/")) href = base + href;
        // Link to the Markdown twin of internal docs pages.
        href = href.replace(/^(https?:\/\/[^/]+)?(\/docs\/(?:ar\/)?[a-z0-9\/-]+?)\/(#.*)?$/i, (m, o = "", pth, frag = "") => (/\.\w+$/.test(pth) ? m : `${o}${pth}.md${frag}`));
        out += href && label ? `[${label}](${href})` : label;
        break;
      }
      default: out += inline(n.children, base);
    }
  }
  return out;
}

function cell(n, base) { return inline(n.children, base).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim(); }

function table(n, base) {
  const rows = [];
  const walk = (x) => {
    if (typeof x === "string") return;
    if (x.tag === "tr") rows.push(x.children.filter((c) => typeof c !== "string").map((c) => cell(c, base)));
    else x.children.forEach(walk);
  };
  walk(n);
  if (!rows.length) return "";
  const w = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(w - r.length).fill("")];
  const line = (r) => "| " + pad(r).join(" | ") + " |";
  return [line(rows[0]), line(Array(w).fill("---")), ...rows.slice(1).map(line)].join("\n");
}

function find(n, pred, acc = []) {
  if (typeof n === "string") return acc;
  if (pred(n)) acc.push(n);
  n.children.forEach((c) => find(c, pred, acc));
  return acc;
}

const INLINE = new Set(["code", "a", "strong", "b", "em", "i", "span", "small", "kbd"]);
const isInline = (n) => typeof n === "string" || (INLINE.has(n.tag) && !find(n, (x) => ["pre", "table", "ul", "ol", "p", "div"].includes(x.tag)).length);

function block(nodes, base, indent = "") {
  const parts = [];
  let run = [];
  const flush = () => { const s = inline(run, base).replace(/\s+/g, " ").trim(); if (s) parts.push(indent + s); run = []; };
  for (const n of nodes) {
    if (isInline(n)) { run.push(n); continue; }
    flush();
    const t = n.tag;
    if (["svg", "button", "script", "style", "nav", "head"].includes(t)) continue;
    if (/^h[1-6]$/.test(t)) {
      const s = inline(n.children, base).replace(/\s+/g, " ").trim();
      if (s) parts.push("#".repeat(+t[1]) + " " + s);
    } else if (t === "p") {
      const s = inline(n.children, base).trim();
      if (s) parts.push(indent + s);
    } else if (t === "pre") {
      parts.push("```" + (n.__lang ?? "") + "\n" + text(n).replace(/\s+$/, "") + "\n```");
    } else if (t === "table") {
      parts.push(table(n, base));
    } else if (t === "ul" || t === "ol") {
      const items = n.children.filter((c) => typeof c !== "string" && c.tag === "li");
      parts.push(items.map((li, i) => {
        const bullet = t === "ol" ? `${i + 1}. ` : "- ";
        const nested = li.children.filter((c) => typeof c !== "string" && ["ul", "ol", "pre"].includes(c.tag));
        const own = li.children.filter((c) => !nested.includes(c));
        let s = indent + bullet + inline(own, base).replace(/\s+/g, " ").trim();
        if (nested.length) s += "\n" + block(nested, base, indent + "  ");
        return s;
      }).join("\n"));
    } else if (t === "aside") {
      const title = find(n, (x) => cls(x, "callout-title"))[0];
      const body = find(n, (x) => cls(x, "callout-body"))[0];
      const head = title ? "**" + text(title).trim() + ".** " : "";
      const inner = body ? block(body.children, base) : "";
      parts.push((head + inner).split("\n").map((l) => "> " + l).join("\n"));
    } else if (t === "hr") {
      parts.push("---");
    } else if (cls(n, "code-tabs")) {
      const labels = find(n, (x) => x.tag === "button" && x.attrs.role === "tab").map(text);
      const pres = find(n, (x) => x.tag === "pre");
      pres.forEach((p, i) => { p.__lang = langOf(labels[i]); });
      parts.push(pres.map((p, i) => (labels.length === pres.length ? `**${labels[i]}**\n\n` : "") + block([p], base)).join("\n\n"));
    } else if (t === "pre" || t === "code") {
      parts.push("`" + text(n) + "`");
    } else {
      const s = block(n.children, base, indent);
      if (s) parts.push(s);
    }
  }
  flush();
  return parts.join("\n\n");
}

function langOf(label = "") {
  const l = label.toLowerCase();
  if (l.includes("typescript")) return "ts";
  if (l.includes("dart")) return "dart";
  if (l.includes("javascript")) return "js";
  if (l.includes("curl") || l.includes("shell") || l.includes("bash")) return "bash";
  if (l.includes("json")) return "json";
  if (l.includes("sql")) return "sql";
  return "";
}

export function htmlToMarkdown(html, { baseUrl = "" } = {}) {
  const tree = parse(html);
  const md = block(tree.children, baseUrl);
  return md.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}
