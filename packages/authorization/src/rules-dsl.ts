/**
 * @vellum/authorization — Security Rules DSL compiler, decompiler & simulator.
 *
 * A deliberately small, dependency-free recursive-descent compiler for the
 * human-friendly rules language described in the V2 Engine Contract §6.4.
 *
 * Design invariants (mirrors AGENTS.md and docs/V2-ENGINE-CONTRACT.md):
 *  - No `eval()` / `new Function()` — the source is tokenised and parsed into
 *    the deterministic v1 `SecurityRulesetAst` only.
 *  - Only the ops understood by `evaluateAstNode` are ever emitted:
 *    `all`, `any`, `not`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `in`, `hasKey`, `isType`.
 *    `&&` -> `all`, `||` -> `any`, `!` -> `not`; user functions are inlined.
 *  - The emitted AST always carries `version: 1` even though the DSL declares
 *    `rules_version = '2';` (the declaration is sugar only).
 *  - Syntax errors carry exact 1-based line/column plus a source snippet.
 *    Semantic concerns (unknown variable/function, unrepresentable
 *    `onlyChanged`) are returned as diagnostics rather than thrown.
 */

import { SYSTEM_LIMITS } from "@vellum/core";
import type { AuthContext } from "./jwt.js";
import {
  evaluateAstNode,
  matchRulePathPattern,
  validateSecurityRulesetAst,
  type AstExpression,
  type AstExpressionNode,
  type AstOperand,
  type RuleEvaluationContext,
  type SecurityRuleDefinition,
  type SecurityRulesetAst,
} from "./rules-ast.js";

// ---------------------------------------------------------------------------
// Public API types (locked signatures from §6.4)
// ---------------------------------------------------------------------------

export interface RulesDslDiagnostic {
  message: string;
  line: number;
  column: number;
  snippet?: string | undefined;
}

export interface CompileRulesDslResult {
  ast: SecurityRulesetAst;
  diagnostics: RulesDslDiagnostic[];
}

export interface SimulateRuleEvaluationParams {
  ruleset: SecurityRulesetAst | { rulesAst: SecurityRulesetAst };
  operation: "get" | "list" | "create" | "update" | "delete";
  path: string;
  auth: AuthContext | null;
  resourceData?: Record<string, unknown> | null | undefined;
  incomingData?: Record<string, unknown> | null | undefined;
}

export interface SimulateRuleEvaluationResult {
  allowed: boolean;
  matchedRule: string | null;
  evaluationTrace: string[];
}

/** Build a source line + caret snippet for a 1-based (line, column) position. */
function buildSnippet(source: string, line: number, column: number): string {
  const lines = source.split(/\r?\n/);
  const index = Math.max(0, Math.min(lines.length - 1, line - 1));
  const text = lines[index] ?? "";
  const caret = `${" ".repeat(Math.max(0, column - 1))}^`;
  return `${text}\n${caret}`;
}

/** Thrown for lexer/parser/grammar/complexity failures with an exact position. */
export class RulesDslSyntaxError extends Error {
  readonly line: number;
  readonly column: number;
  readonly snippet: string;

  constructor(message: string, line: number, column: number, source: string) {
    super(`${message} (line ${line}, column ${column})`);
    this.name = "RulesDslSyntaxError";
    this.line = line;
    this.column = column;
    this.snippet = buildSnippet(source, line, column);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Internal node representation
// ---------------------------------------------------------------------------

interface ValOperand {
  val: unknown;
}
interface VarOperand {
  var: string;
}
interface ParamOperand {
  param: string;
}
interface DocOperand {
  doc: { collection: string; id: InternalNode; field?: string; exists?: boolean };
}
interface CallPlaceholder {
  call: string;
  args: InternalNode[];
  token: Token;
}

/**
 * The parser's intermediate expression type. It is a superset of the final
 * AST: it also carries `{param}` placeholders (function parameters), literal
 * `boolean` shorthands and `{call}` placeholders resolved in a later pass.
 */
interface InternalExpressionNode {
  op: string;
  conditions?: InternalNode[];
  condition?: InternalNode;
  left?: AstOperand;
  right?: AstOperand;
}

type InternalNode = boolean | InternalExpressionNode | ValOperand | VarOperand | ParamOperand | DocOperand | CallPlaceholder;

interface UserFunction {
  name: string;
  params: string[];
  body: InternalNode;
}

interface ParsedRule {
  match: string;
  allow: Record<string, InternalNode>;
  /** Token used to position complexity errors for this rule. */
  token: Token;
}

interface Token {
  type: "ident" | "string" | "number" | "punct" | "eof";
  value: string;
  raw: string;
  line: number;
  column: number;
  index: number;
}

const MAX_INLINE_DEPTH = 16;
const MAX_DSL_SOURCE_BYTES = 128 * 1024;
const MAX_DSL_TOKENS = 16_384;
const MAX_PARSE_DEPTH = 64;
const MAX_SIM_EVAL_STEPS = 256;
const MAX_SIM_EVAL_DEPTH = SYSTEM_LIMITS.RULES_AST_MAX_DEPTH + 2;
const DANGEROUS_DSL_KEYS = new Set<string>(["__proto__", "constructor", "prototype"]);

function isAsciiSpace(ch: string): boolean {
  const c = ch.charCodeAt(0);
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11;
}
function isAsciiDigit(ch: string): boolean {
  if (ch.length === 0) return false;
  const c = ch.charCodeAt(0);
  return c >= 48 && c <= 57;
}
function isIdentStart(ch: string): boolean {
  if (ch.length === 0) return false;
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 36;
}
function isIdentContinue(ch: string): boolean {
  if (ch.length === 0) return false;
  const c = ch.charCodeAt(0);
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 36;
}

const BUILTIN_NAMES = new Set([
  "isSignedIn",
  "isAuth",
  "isOwner",
  "hasRole",
  "hasAnyRole",
  "isEmailVerified",
  "unchanged",
  "onlyChanged",
  "hasKey",
  "isType",
]);
function isBuiltinName(name: string): boolean {
  return BUILTIN_NAMES.has(name);
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isAstNode(node: InternalNode): node is InternalExpressionNode {
  return typeof node === "object" && node !== null && "op" in node && typeof node.op === "string";
}
function isVal(node: InternalNode): node is ValOperand {
  return typeof node === "object" && node !== null && "val" in node;
}
function isVar(node: InternalNode): node is VarOperand {
  return typeof node === "object" && node !== null && "var" in node;
}
function isParam(node: InternalNode): node is ParamOperand {
  return typeof node === "object" && node !== null && "param" in node;
}
function isDoc(node: InternalNode): node is DocOperand {
  return typeof node === "object" && node !== null && "doc" in node;
}
function mapDocId(node: DocOperand, fn: (id: InternalNode) => InternalNode): DocOperand {
  return { doc: { ...node.doc, id: fn(node.doc.id) } };
}
function isCall(node: InternalNode): node is CallPlaceholder {
  return typeof node === "object" && node !== null && "call" in node;
}

/** Convert any parsed node into an AST operand (evaluator never sees `{param}` here). */
function asOperand(node: InternalNode): AstOperand {
  if (typeof node === "boolean") return { val: node };
  if (isVal(node) || isVar(node)) return node;
  return node;
}

/**
 * Convert a parsed node into a boolean-position internal node prior to call inlining.
 * Preserves `CallPlaceholder` nodes cleanly without type assertions so `resolveCalls`
 * can inline them before emitting the final `AstExpression`.
 */
function asParsedBooleanNode(node: InternalNode): InternalNode {
  if (typeof node === "boolean") return node;
  if (isAstNode(node)) return node;
  if (isCall(node)) return node;
  if (isVal(node) && typeof node.val === "boolean") return node.val;
  return { op: "==", left: asOperand(node), right: { val: true } };
}

/** Narrow a fully resolved `InternalExpressionNode` into a final `AstExpressionNode`. */
function toAstExpressionNode(node: InternalNode): AstExpressionNode {
  // The AST evaluator and validator accept bare boolean children in
  // `conditions`/`condition` (see rules-ast.ts: validateAstExpression and
  // evaluateAstNodeInternal), so preserve them instead of rewriting them into
  // an equality comparison — this keeps compiled DSL output byte-identical to
  // the pre-refactor behaviour.
  if (typeof node === "boolean") {
    return node as unknown as AstExpressionNode;
  }
  if (isVal(node) && typeof node.val === "boolean") {
    return node.val as unknown as AstExpressionNode;
  }
  if (isAstNode(node)) {
    const out: AstExpressionNode = { op: node.op };
    if (node.conditions) out.conditions = node.conditions.map(toAstExpressionNode);
    if (node.condition !== undefined) out.condition = toAstExpressionNode(node.condition);
    if (node.left !== undefined) out.left = node.left;
    if (node.right !== undefined) out.right = node.right;
    return out;
  }
  if (isCall(node)) {
    throw new Error(`Unresolved function call '${node.call}' in compiled AST`);
  }
  return { op: "==", left: asOperand(node), right: { val: true } };
}

/** Convert a resolved node into a final boolean AST expression. */
function asBooleanExpression(node: InternalNode): AstExpression {
  if (typeof node === "boolean") return node;
  if (isAstNode(node)) return toAstExpressionNode(node);
  if (isCall(node)) {
    throw new Error(`Unresolved function call '${node.call}' in compiled AST`);
  }
  // A literal boolean operand is already a valid boolean expression (this is
  // how unknown functions resolve to the safe value `false`).
  if (isVal(node) && typeof node.val === "boolean") return node.val;
  return { op: "==", left: asOperand(node), right: { val: true } };
}

/** Deep-clone an internal node (prevents shared-reference false "cycle" reports). */
function cloneNode(node: InternalNode): InternalNode {
  if (typeof node !== "object" || node === null) return node;
  if (isVal(node) || isVar(node) || isParam(node)) {
    return { ...node };
  }
  if (isDoc(node)) return mapDocId(node, cloneNode);
  if (isCall(node)) {
    return { call: node.call, args: node.args.map(cloneNode), token: node.token };
  }
  const cloned: InternalExpressionNode = { op: node.op };
  if (node.conditions) cloned.conditions = node.conditions.map(cloneNode);
  if (node.condition !== undefined) cloned.condition = cloneNode(node.condition);
  if (node.left !== undefined) cloned.left = cloneNode(node.left as InternalNode);
  if (node.right !== undefined) cloned.right = cloneNode(node.right as InternalNode);
  return cloned;
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

function tokenize(source: string): Token[] {
  if (typeof source !== "string") {
    throw new RulesDslSyntaxError("Rules DSL source must be a string", 1, 1, "");
  }
  if (source.length > MAX_DSL_SOURCE_BYTES) {
    throw new RulesDslSyntaxError(
      `Rules DSL source exceeds maximum size of ${MAX_DSL_SOURCE_BYTES} bytes`,
      1,
      1,
      source.slice(0, 120)
    );
  }
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let column = 1;

  const advance = (): string => {
    const ch = source.charAt(i);
    i += 1;
    if (ch === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    return ch;
  };
  const peekChar = (offset = 0): string => source.charAt(i + offset);
  const push = (type: Token["type"], value: string, raw: string, startLine: number, startCol: number, startIndex: number): void => {
    if (tokens.length >= MAX_DSL_TOKENS) {
      throw new RulesDslSyntaxError(`Rules DSL exceeds maximum token count of ${MAX_DSL_TOKENS}`, startLine, startCol, source);
    }
    tokens.push({ type, value, raw, line: startLine, column: startCol, index: startIndex });
  };

  while (i < source.length) {
    const ch = peekChar();

    // Whitespace
    if (isAsciiSpace(ch)) {
      advance();
      continue;
    }

    // Line comment
    if (ch === "/" && peekChar(1) === "/") {
      while (i < source.length && peekChar() !== "\n") advance();
      continue;
    }

    // Block comment
    if (ch === "/" && peekChar(1) === "*") {
      const startLine = line;
      const startCol = column;
      advance();
      advance();
      let closed = false;
      while (i < source.length) {
        if (peekChar() === "*" && peekChar(1) === "/") {
          advance();
          advance();
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        throw new RulesDslSyntaxError("Unterminated block comment", startLine, startCol, source);
      }
      continue;
    }

    const startLine = line;
    const startCol = column;
    const startIndex = i;

    // String literal (single or double quotes)
    if (ch === "'" || ch === '"') {
      const quote = advance();
      let value = "";
      let closed = false;
      while (i < source.length) {
        const c = advance();
        if (c === quote) {
          closed = true;
          break;
        }
        if (c === "\\") {
          const esc = advance();
          if (esc === "n") value += "\n";
          else if (esc === "t") value += "\t";
          else if (esc === "r") value += "\r";
          else if (esc === "\\") value += "\\";
          else if (esc === "'") value += "'";
          else if (esc === '"') value += '"';
          else if (esc === "u") {
            let hex = "";
            for (let k = 0; k < 4; k += 1) hex += advance();
            const parsed = Number.parseInt(hex, 16);
            value += Number.isNaN(parsed) ? esc : String.fromCharCode(parsed);
          } else value += esc;
        } else {
          value += c;
        }
      }
      if (!closed) {
        throw new RulesDslSyntaxError("Unterminated string literal", startLine, startCol, source);
      }
      push("string", value, source.slice(startIndex, i), startLine, startCol, startIndex);
      continue;
    }

    // Number literal
    if (isAsciiDigit(ch)) {
      let text = advance();
      while (isAsciiDigit(peekChar())) text += advance();
      if (peekChar() === "." && isAsciiDigit(peekChar(1))) {
        text += advance();
        while (isAsciiDigit(peekChar())) text += advance();
      }
      push("number", String(Number(text)), text, startLine, startCol, startIndex);
      continue;
    }

    // Identifier / keyword
    if (isIdentStart(ch)) {
      let text = advance();
      while (isIdentContinue(peekChar())) text += advance();
      push("ident", text, text, startLine, startCol, startIndex);
      continue;
    }

    // Multi-character operators
    const two = ch + peekChar(1);
    if (["&&", "||", "==", "!=", "<=", ">="].includes(two)) {
      advance();
      advance();
      push("punct", two, two, startLine, startCol, startIndex);
      continue;
    }

    // Single-character punctuation
    if ("{}()[]`,.:;!<>=/+-*".includes(ch)) {
      advance();
      push("punct", ch, ch, startLine, startCol, startIndex);
      continue;
    }

    throw new RulesDslSyntaxError(`Unexpected character '${ch}'`, startLine, startCol, source);
  }

  tokens.push({ type: "eof", value: "", raw: "", line, column, index: i });
  return tokens;
}

// ---------------------------------------------------------------------------
// Alias resolution
// ---------------------------------------------------------------------------

/**
 * Translate a dotted source path into the canonical variable path understood
 * by `evaluateAstNode`:
 *   auth              -> auth
 *   resource          -> resource.data
 *   incoming          -> request.data
 *   request.auth.*    -> auth.*
 *   request.resource.data.* -> request.data.*
 */
function resolveVarPath(dotted: string): string {
  const parts = dotted.split(".");
  const head = parts[0] ?? "";

  if (head === "request" && parts[1] === "auth") {
    return ["auth", ...parts.slice(2)].join(".");
  }
  if (head === "request" && parts[1] === "resource") {
    // request.resource.data.x -> request.data.x ; request.resource.x -> request.data.x
    const rest = parts[2] === "data" ? parts.slice(3) : parts.slice(2);
    return ["request", "data", ...rest].join(".");
  }
  if (head === "resource") {
    const rest = parts[1] === "data" ? parts.slice(2) : parts.slice(1);
    return ["resource", "data", ...rest].join(".");
  }
  if (head === "incoming") {
    return ["request", "data", ...parts.slice(1)].join(".");
  }
  // auth.*, path.*, request.data, request.time, unknown heads all pass through.
  return dotted;
}

function isKnownVarRoot(dotted: string): boolean {
  const head = dotted.split(".")[0] ?? "";
  return ["auth", "resource", "request", "incoming", "path"].includes(head);
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

class DslParser {
  private readonly tokens: Token[];
  private pos = 0;
  private parseDepth = 0;
  readonly diagnostics: RulesDslDiagnostic[] = [];
  readonly functions = new Map<string, UserFunction>();

  constructor(readonly source: string) {
    this.tokens = tokenize(source);
  }

  private current(): Token {
    return this.tokens[this.pos] ?? this.tokens[this.tokens.length - 1]!;
  }
  private peek(offset: number): Token {
    return this.tokens[this.pos + offset] ?? this.tokens[this.tokens.length - 1]!;
  }
  private at(value: string): boolean {
    return this.current().value === value;
  }
  private next(): Token {
    const token = this.current();
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }
  private consumeIf(value: string): boolean {
    if (this.at(value)) {
      this.next();
      return true;
    }
    return false;
  }
  private fail(message: string, token: Token = this.current()): never {
    throw new RulesDslSyntaxError(message, token.line, token.column, this.source);
  }
  private expect(value: string): Token {
    if (!this.at(value)) this.fail(`Expected '${value}' but found '${this.current().raw || "end of input"}'`);
    return this.next();
  }
  private expectIdentifier(what: string): Token {
    if (this.current().type !== "ident") this.fail(`Expected ${what} but found '${this.current().raw || "end of input"}'`);
    return this.next();
  }
  private warn(message: string, token: Token): void {
    this.diagnostics.push({
      message,
      line: token.line,
      column: token.column,
      snippet: buildSnippet(this.source, token.line, token.column),
    });
  }

  // -- top level ------------------------------------------------------------

  parse(): ParsedRule[] {
    // Optional version declaration — sugar only; AST always gets version: 1.
    if (this.at("rules_version")) {
      this.next();
      this.expect("=");
      const versionTok = this.current();
      if (versionTok.type !== "string" && versionTok.type !== "number") {
        this.fail("rules_version must be a string such as '2'", versionTok);
      }
      this.next();
      this.expect(";");
      if (versionTok.value !== "2" && versionTok.value !== "1") {
        this.warn(`rules_version '${versionTok.value}' is not supported; expected '2'. Compiling as version 1 AST.`, versionTok);
      }
    }

    const rules: ParsedRule[] = [];
    while (this.current().type !== "eof") {
      if (this.at("function")) this.parseFunction();
      else if (this.at("match")) rules.push(...this.parseMatchBlock("", this.current()));
      else this.fail(`Expected 'function' or 'match' but found '${this.current().raw}'`);
    }
    if (rules.length === 0) {
      this.fail("Ruleset must contain at least one 'match' block", this.current());
    }
    return rules;
  }

  private parseFunction(): void {
    this.expect("function");
    const nameTok = this.expectIdentifier("function name");
    if (this.functions.has(nameTok.value)) {
      this.fail(`Duplicate function declaration '${nameTok.value}'`, nameTok);
    }
    this.expect("(");
    const params: string[] = [];
    if (!this.at(")")) {
      do {
        params.push(this.expectIdentifier("parameter name").value);
      } while (this.consumeIf(","));
    }
    this.expect(")");
    this.expect("{");
    this.expect("return");
    const paramSet = new Set(params);
    const body = this.parseExpression(paramSet);
    this.consumeIf(";");
    this.expect("}");
    this.functions.set(nameTok.value, { name: nameTok.value, params, body });
  }

  /** Parse a `match <path> { ... }` block, flattening nested matches. */
  private parseMatchBlock(parentPath: string, matchTok: Token): ParsedRule[] {
    this.parseDepth += 1;
    if (this.parseDepth > MAX_PARSE_DEPTH) {
      this.fail(`Rules nesting exceeds maximum depth of ${MAX_PARSE_DEPTH}`, matchTok);
    }
    try {
      return this.parseMatchBlockInner(parentPath, matchTok);
    } finally {
      this.parseDepth -= 1;
    }
  }

  /** Path parameters in scope for the match block being parsed (`{userId}` -> `userId`). */
  private activePathParams: ReadonlySet<string> = new Set<string>();

  private parseMatchBlockInner(parentPath: string, matchTok: Token): ParsedRule[] {
    this.expect("match");
    const path = this.parseMatchPath(matchTok);
    const fullPath = joinMatchPaths(parentPath, path);
    const outerPathParams = this.activePathParams;
    this.activePathParams = new Set(
      Array.from(fullPath.matchAll(/\{([^}=]+)(?:=\*\*)?\}/g), (m) => m[1]!)
    );

    this.expect("{");
    const nestedRules: ParsedRule[] = [];
    let ownAllow: Record<string, InternalNode> | null = null;
    let ownToken: Token | null = null;
    while (!this.at("}")) {
      if (this.current().type === "eof") this.fail("Unterminated 'match' block", matchTok);
      if (this.at("match")) {
        nestedRules.push(...this.parseMatchBlock(fullPath, this.current()));
        continue;
      }
      if (this.at("allow")) {
        const parsed = this.parseAllow();
        if (ownAllow === null) {
          ownAllow = parsed.allow;
          ownToken = parsed.token;
        } else {
          Object.assign(ownAllow, parsed.allow);
        }
        continue;
      }
      this.fail(`Expected 'allow' or 'match' inside match block but found '${this.current().raw}'`);
    }
    this.expect("}");
    this.activePathParams = outerPathParams;

    const rules: ParsedRule[] = [];
    if (ownAllow !== null && ownToken !== null) {
      rules.push({ match: fullPath, allow: ownAllow, token: ownToken });
    }
    return rules.concat(nestedRules);
  }

  /** Read the path tokens between `match` and the body-opening `{`. */
  private parseMatchPath(matchTok: Token): string {
    const pieces: string[] = [];
    while (this.current().type !== "eof") {
      if (this.at("{")) {
        // A path parameter is `{ name }` or `{ name = ** }`. A block-opening
        // brace is any other `{` (it is followed by statements, not `}`).
        if (this.looksLikePathParam()) {
          this.next();
          const nameTok = this.expectIdentifier("path parameter name");
          const name = nameTok.value;
          if (DANGEROUS_DSL_KEYS.has(name)) {
            this.fail(`Reserved path parameter name '${name}' is not allowed`, nameTok);
          }
          if (this.consumeIf("=")) {
            this.expect("*");
            this.expect("*");
            pieces.push(`{${name}=**}`);
          } else {
            pieces.push(`{${name}}`);
          }
          this.expect("}");
          continue;
        }
        break; // body-opening brace
      }
      if (this.at("/") || this.current().type === "ident") {
        pieces.push(this.next().raw);
        continue;
      }
      break;
    }
    if (pieces.length === 0) this.fail("Expected a match path after 'match'", matchTok);
    return normalizeMatchPath(pieces.join(""));
  }

  private looksLikePathParam(): boolean {
    // `{ IDENT }` or `{ IDENT = * * }`
    if (this.peek(1).type !== "ident") return false;
    if (this.peek(2).value === "}") return true;
    return this.peek(2).value === "=" && this.peek(3).value === "*" && this.peek(4).value === "*" && this.peek(5).value === "}";
  }

  private parseAllow(): { allow: Record<string, InternalNode>; token: Token } {
    this.expect("allow");
    const ops: string[] = [];
    do {
      const opTok = this.expectIdentifier("rule operation");
      const op = opTok.value;
      if (!["get", "list", "create", "update", "delete", "read", "write"].includes(op)) {
        this.fail(`Unsupported rule operation '${op}'`, opTok);
      }
      ops.push(op);
    } while (this.consumeIf(","));
    this.expect(":");
    this.expect("if");
    const ifTok = this.current();
    const expr = this.parseExpression(new Set<string>());
    this.consumeIf(";");

    const allow: Record<string, InternalNode> = {};
    for (const op of ops) {
      if (op === "read") {
        allow["get"] = cloneNode(expr);
        allow["list"] = cloneNode(expr);
      } else if (op === "write") {
        allow["create"] = cloneNode(expr);
        allow["update"] = cloneNode(expr);
        allow["delete"] = cloneNode(expr);
      } else {
        allow[op] = cloneNode(expr);
      }
    }
    return { allow, token: ifTok };
  }

  // -- expression grammar ---------------------------------------------------

  private parseExpression(params: ReadonlySet<string>): InternalNode {
    this.parseDepth += 1;
    if (this.parseDepth > MAX_PARSE_DEPTH) {
      this.fail(`Expression nesting exceeds maximum depth of ${MAX_PARSE_DEPTH}`);
    }
    try {
      return this.parseOr(params);
    } finally {
      this.parseDepth -= 1;
    }
  }

  private parseOr(params: ReadonlySet<string>): InternalNode {
    const nodes = [this.parseAnd(params)];
    while (this.consumeIf("||")) nodes.push(this.parseAnd(params));
    if (nodes.length === 1) return nodes[0]!;
    return { op: "any", conditions: nodes.map(asParsedBooleanNode) };
  }

  private parseAnd(params: ReadonlySet<string>): InternalNode {
    const nodes = [this.parseUnary(params)];
    while (this.consumeIf("&&")) nodes.push(this.parseUnary(params));
    if (nodes.length === 1) return nodes[0]!;
    return { op: "all", conditions: nodes.map(asParsedBooleanNode) };
  }

  private parseUnary(params: ReadonlySet<string>): InternalNode {
    if (this.consumeIf("!")) {
      return { op: "not", condition: asParsedBooleanNode(this.parseUnary(params)) };
    }
    return this.parseComparison(params);
  }

  private parseComparison(params: ReadonlySet<string>): InternalNode {
    const left = this.parsePrimary(params);
    const token = this.current();
    const ops = ["==", "!=", "<", "<=", ">", ">=", "in", "hasKey", "isType"];
    if (ops.includes(token.value)) {
      this.next();
      const right = this.parsePrimary(params);
      return { op: token.value, left: asOperand(left), right: asOperand(right) };
    }
    return left;
  }

  private parsePrimary(params: ReadonlySet<string>): InternalNode {
    if (this.consumeIf("(")) {
      const expr = this.parseExpression(params);
      this.expect(")");
      return expr;
    }

    const t = this.current();
    // Quoted strings are always literals: 'null', 'true' and 'false' must not
    // be read as keywords.
    if (t.type === "string") {
      this.next();
      return { val: t.value };
    }
    if (t.value === "true" || t.value === "false") {
      this.next();
      return t.value === "true";
    }
    if (t.value === "null") {
      this.next();
      return { val: null };
    }
    if (t.type === "number") {
      this.next();
      return { val: Number(t.value) };
    }
    if (t.value === "-" || t.value === "+") {
      const signTok = this.next();
      const numTok = this.current();
      if (numTok.type !== "number") this.fail(`Expected a number after '${signTok.value}'`, numTok);
      this.next();
      return { val: signTok.value === "-" ? -Number(numTok.value) : Number(numTok.value) };
    }
    if (this.at("[")) {
      return this.parseArrayLiteral(params);
    }
    if (t.type === "ident") {
      if ((t.value === "get" || t.value === "exists") && this.peek(1).value === "(" && !this.functions.has(t.value)) {
        return this.parseLookup(params);
      }
      if (this.peek(1).value === "(") {
        return this.parseCall(params);
      }
      if (params.has(t.value)) {
        this.next();
        return { param: t.value };
      }
      return this.parseDottedPath();
    }
    this.fail(`Unexpected token '${t.raw || "end of input"}' in expression`, t);
  }

  /**
   * `exists('chats', id)` and `get('chats', id).data.memberIds`: read one other document while checking a
   * rule. The collection is a literal; the id is any expression (a path parameter, a field of the incoming
   * document, auth.uid).
   */
  private parseLookup(params: ReadonlySet<string>): InternalNode {
    const nameTok = this.next();
    this.expect("(");
    const collTok = this.current();
    if (collTok.type !== "string" || !/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+)*$/.test(collTok.value)) {
      this.fail(
        `${nameTok.value}() takes a collection path in quotes as its first argument, for example ${nameTok.value}('chats', chatId)`,
        collTok
      );
    }
    this.next();
    this.expect(",");
    const id = this.parseExpression(params);
    this.expect(")");
    if (nameTok.value === "exists") {
      return { op: "==", left: { doc: { collection: collTok.value, id, exists: true } }, right: { val: true } };
    }
    if (!(this.at(".") && this.peek(1).value === "data")) {
      this.fail("get(...) must be followed by .data and a field, for example get('chats', id).data.memberIds", this.current());
    }
    this.next();
    this.next();
    const parts: string[] = [];
    while (this.at(".") && this.peek(1).type === "ident") {
      this.next();
      parts.push(this.next().value);
    }
    return { doc: { collection: collTok.value, id, field: parts.join(".") } };
  }

  private parseArrayLiteral(params: ReadonlySet<string>): InternalNode {
    this.expect("[");
    const values: unknown[] = [];
    while (!this.at("]")) {
      if (this.current().type === "eof") this.fail("Unterminated array literal");
      const element = this.parsePrimary(params);
      if (typeof element === "boolean") {
        values.push(element);
      } else if (isVal(element)) {
        values.push(element.val);
      } else {
        this.warn("Array elements must be literals; a non-literal element was replaced with null", this.current());
        values.push(null);
      }
      if (!this.consumeIf(",")) break;
    }
    this.expect("]");
    return { val: values };
  }

  private parseDottedPath(): InternalNode {
    const first = this.next();
    // A bare identifier naming a path parameter (`userId` in `match /users/{userId}`)
    // is the path binding, i.e. `path.userId`.
    if (this.activePathParams.has(first.value) && !this.at(".")) {
      return { var: `path.${first.value}` };
    }
    const parts: string[] = [first.value];
    const pathToken = first;
    while (this.at(".") && this.peek(1).type === "ident") {
      this.next();
      parts.push(this.next().value);
    }
    const dotted = parts.join(".");
    if (!isKnownVarRoot(dotted)) {
      this.warn(`Unknown variable '${dotted}'; compiled as a variable path and may resolve to undefined`, pathToken);
    }
    return { var: resolveVarPath(dotted) };
  }

  /**
   * Parse `name(args...)` into a call placeholder. Resolution is deferred until
   * every `function` declaration has been seen, which lets user-defined
   * functions take precedence over same-named built-ins and supports forward
   * references between functions.
   */
  private parseCall(params: ReadonlySet<string>): InternalNode {
    const nameTok = this.next();
    const name = nameTok.value;
    this.expect("(");
    const args: InternalNode[] = [];
    if (!this.at(")")) {
      do {
        args.push(this.parseExpression(params));
      } while (this.consumeIf(","));
    }
    this.expect(")");
    return { call: name, args, token: nameTok };
  }

  /** Expand a built-in macro into a deterministic v1 AST node. */
  private expandBuiltin(name: string, args: InternalNode[], token: Token): InternalNode {
    switch (name) {
      case "isSignedIn":
      case "isAuth":
        this.assertArity(name, args, 0, token);
        return { op: "!=", left: { var: "auth.uid" }, right: { val: null } };
      case "isOwner": {
        this.assertArity(name, args, 1, token);
        return {
          op: "all",
          conditions: [
            { op: "!=", left: { var: "auth.uid" }, right: { val: null } },
            { op: "==", left: { var: "auth.uid" }, right: asOperand(args[0]!) },
          ],
        };
      }
      case "hasRole":
        this.assertArity(name, args, 1, token);
        return { op: "==", left: { var: "auth.claims.role" }, right: asOperand(args[0]!) };
      case "hasAnyRole": {
        this.assertArity(name, args, 1, token);
        return { op: "in", left: { var: "auth.claims.role" }, right: { val: this.stringArrayArgument(name, args[0]!, token) } };
      }
      case "isEmailVerified":
        this.assertArity(name, args, 0, token);
        return { op: "==", left: { var: "auth.email_verified" }, right: { val: true } };
      case "unchanged": {
        this.assertArity(name, args, 1, token);
        const fields = this.stringArrayArgument(name, args[0]!, token);
        if (fields.length === 0) return true;
        return {
          op: "all",
          // A field that is missing on both sides, or null on both sides, is unchanged.
          conditions: fields.map(
            (f): AstExpressionNode => ({
              op: "any",
              conditions: [
                { op: "==", left: { var: `request.data.${f}` }, right: { var: `resource.data.${f}` } },
                {
                  op: "all",
                  conditions: [
                    { op: "not", condition: { op: "hasKey", left: { var: "request.data" }, right: { val: f } } },
                    { op: "not", condition: { op: "hasKey", left: { var: "resource.data" }, right: { val: f } } },
                  ],
                },
              ],
            })
          ),
        };
      }
      case "onlyChanged": {
        this.assertArity(name, args, 1, token);
        const fields = this.stringArrayArgument(name, args[0]!, token);
        this.warn(
          "onlyChanged(...) cannot fully enforce that no other keys changed: the v1 rules AST has no dynamic key-set comparison. " +
            "Compiled a deterministic check that each listed field differs; enforce 'all other keys unchanged' in application logic.",
          token
        );
        if (fields.length === 0) return true;
        return {
          op: "all",
          conditions: fields.map(
            (f): AstExpressionNode => ({
              op: "not",
              condition: { op: "==", left: { var: `request.data.${f}` }, right: { var: `resource.data.${f}` } },
            })
          ),
        };
      }
      case "hasKey":
      case "isType":
        this.assertArity(name, args, 2, token);
        return { op: name, left: asOperand(args[0]!), right: asOperand(args[1]!) };
      default:
        return { val: false };
    }
  }

  private assertArity(name: string, args: InternalNode[], expected: number, token: Token): void {
    if (args.length !== expected) {
      this.fail(`${name}() expects ${expected} argument${expected === 1 ? "" : "s"} but got ${args.length}`, token);
    }
  }

  private stringArrayArgument(name: string, arg: InternalNode, token: Token): string[] {
    if (!isVal(arg) || !Array.isArray(arg.val) || !arg.val.every((v) => typeof v === "string")) {
      this.fail(`${name}() expects an array of string field names`, token);
    }
    return (arg.val as unknown[]).map((v) => String(v));
  }

  // -- call resolution / inlining ------------------------------------------

  resolveCalls(node: InternalNode, stack: string[] = []): InternalNode {
    if (isParam(node)) this.fail(`Unbound function parameter '${node.param}'`, this.current());
    if (isVal(node) || isVar(node) || typeof node === "boolean") return node;
    if (isDoc(node)) return mapDocId(node, (id) => this.resolveCalls(id, stack));

    if (isCall(node)) {
      const resolvedArgs = node.args.map((a) => this.resolveCalls(a, stack));
      const fn = this.functions.get(node.call);
      if (fn) {
        // User definitions shadow built-in macros of the same name.
        if (stack.includes(node.call)) {
          this.fail(`Recursive function call '${node.call}' cannot be inlined`, node.token);
        }
        if (stack.length >= MAX_INLINE_DEPTH) {
          this.fail(`Function inlining exceeded maximum depth of ${MAX_INLINE_DEPTH} at '${node.call}'`, node.token);
        }
        if (fn.params.length !== resolvedArgs.length) {
          this.fail(
            `Function '${node.call}' expects ${fn.params.length} argument(s) but got ${resolvedArgs.length}`,
            node.token
          );
        }
        const subst = new Map<string, InternalNode>();
        fn.params.forEach((p, i) => subst.set(p, resolvedArgs[i]!));
        const body = this.substitute(fn.body, subst, node.token);
        return this.resolveCalls(body, [...stack, node.call]);
      }
      if (isBuiltinName(node.call)) {
        return this.expandBuiltin(node.call, resolvedArgs, node.token);
      }
      this.warn(`Unknown function '${node.call}'; compiled as 'false'`, node.token);
      return { val: false };
    }

    // InternalExpressionNode — recurse through every child slot.
    const result: InternalExpressionNode = { op: node.op };
    if (node.conditions) result.conditions = node.conditions.map((c) => this.resolveCalls(c, stack));
    if (node.condition !== undefined) result.condition = this.resolveCalls(node.condition, stack);
    if (node.left !== undefined) result.left = this.resolveCalls(node.left as InternalNode, stack);
    if (node.right !== undefined) result.right = this.resolveCalls(node.right as InternalNode, stack);
    return result;
  }

  private substitute(node: InternalNode, subst: Map<string, InternalNode>, token: Token): InternalNode {
    if (isParam(node)) {
      const replacement = subst.get(node.param);
      if (replacement === undefined) this.fail(`Unknown function parameter '${node.param}'`, token);
      return cloneNode(replacement);
    }
    if (isVal(node) || isVar(node) || typeof node === "boolean") return node;
    if (isDoc(node)) return mapDocId(node, (id) => this.substitute(id, subst, token));
    if (isCall(node)) {
      return { call: node.call, args: node.args.map((a) => this.substitute(a, subst, token)), token: node.token };
    }
    const result: InternalExpressionNode = { op: node.op };
    if (node.conditions) result.conditions = node.conditions.map((c) => this.substitute(c, subst, token));
    if (node.condition !== undefined) result.condition = this.substitute(node.condition, subst, token);
    if (node.left !== undefined) result.left = this.substitute(node.left as InternalNode, subst, token);
    if (node.right !== undefined) result.right = this.substitute(node.right as InternalNode, subst, token);
    return result;
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function stripLeadingSlash(path: string): string {
  return path.replace(/^\/+/, "");
}
function ensureLeadingSlash(path: string): string {
  return `/${stripLeadingSlash(path)}`;
}
function normalizeMatchPath(path: string): string {
  return ensureLeadingSlash(path.replace(/\s+/g, ""));
}
function joinMatchPaths(parent: string, child: string): string {
  if (!parent) return child;
  return `${parent}/${stripLeadingSlash(child)}`.replace(/\/+/g, "/");
}

// ---------------------------------------------------------------------------
// Complexity guard (mirrors validateSecurityRulesetAst quotas)
// ---------------------------------------------------------------------------

function checkComplexity(node: InternalNode, token: Token, source: string): void {
  let nodes = 0;
  const walk = (current: InternalNode, depth: number): void => {
    if (depth > SYSTEM_LIMITS.RULES_AST_MAX_DEPTH) {
      throw new RulesDslSyntaxError(
        `Security rule expression exceeds maximum depth of ${SYSTEM_LIMITS.RULES_AST_MAX_DEPTH}`,
        token.line,
        token.column,
        source
      );
    }
    nodes += 1;
    if (nodes > SYSTEM_LIMITS.RULES_AST_MAX_NODES) {
      throw new RulesDslSyntaxError(
        `Security rule expression exceeds maximum node count of ${SYSTEM_LIMITS.RULES_AST_MAX_NODES}`,
        token.line,
        token.column,
        source
      );
    }
    if (!isAstNode(current)) return;
    if (current.conditions) for (const c of current.conditions) walk(c, depth + 1);
    if (current.condition !== undefined) walk(current.condition, depth + 1);
  };
  walk(node, 1);
}

// ---------------------------------------------------------------------------
// Public: compile
// ---------------------------------------------------------------------------

export function compileRulesDsl(source: string): CompileRulesDslResult {
  const parser = new DslParser(source);
  const parsedRules = parser.parse();

  const rules: SecurityRuleDefinition[] = parsedRules.map((parsed) => {
    const allow: SecurityRuleDefinition["allow"] = {};
    for (const [op, rawExpr] of Object.entries(parsed.allow)) {
      const resolved = parser.resolveCalls(rawExpr);
      checkComplexity(resolved, parsed.token, source);
      if (op === "list" && JSON.stringify(resolved, (k, v) => (k === "token" ? undefined : v)).includes('"doc":')) {
        throw new RulesDslSyntaxError(
          "get() and exists() cannot be used in a 'list' or 'read' rule, because a query is checked once and not per document. Use them in 'get', 'create', 'update' or 'delete' rules.",
          parsed.token.line,
          parsed.token.column,
          source
        );
      }
      // Clone so each operation owns an independent AST subtree.
      allow[op] = asBooleanExpression(cloneNode(resolved));
    }
    return { match: parsed.match, allow };
  });

  const ast: SecurityRulesetAst = { version: 1, rules };
  try {
    validateSecurityRulesetAst(ast);
  } catch (err) {
    const firstRule = parsedRules[0];
    const token = firstRule?.token;
    throw new RulesDslSyntaxError(
      err instanceof Error ? err.message : String(err),
      token?.line ?? 1,
      token?.column ?? 1,
      source
    );
  }

  detectWildcardOverlaps(rules, parsedRules, (message, token) => parser.warn(message, token as Token));

  return { ast, diagnostics: parser.diagnostics };
}

// ---------------------------------------------------------------------------
// Static analysis: wildcard-overlap warnings
// ---------------------------------------------------------------------------

interface PatternSegment {
  kind: "literal" | "param" | "recursive";
  value: string;
}

function splitMatchPattern(match: string): PatternSegment[] {
  return match.split("/").map((seg) => {
    if (seg.startsWith("{") && seg.endsWith("=**}")) {
      return { kind: "recursive", value: seg.slice(1, -4) };
    }
    if (seg.startsWith("{") && seg.endsWith("}")) {
      return { kind: "param", value: seg.slice(1, -1) };
    }
    return { kind: "literal", value: seg };
  });
}

/**
 * True when every path matched by `narrow` is also matched by `broad`, and
 * `broad` is strictly wider (a wildcard where `narrow` pins a literal).
 * Recursive wildcards cover any suffix from their position on.
 */
function patternCovers(broad: PatternSegment[], narrow: PatternSegment[]): { covers: boolean; wildcards: { name: string; literal: string }[] } {
  const wildcards: { name: string; literal: string }[] = [];
  const broadRecursiveAt = broad.findIndex((s) => s.kind === "recursive");
  const narrowHasRecursive = narrow.some((s) => s.kind === "recursive");
  if (narrowHasRecursive) {
    // Variable-depth narrow patterns are too ambiguous to reason about safely.
    return { covers: false, wildcards };
  }
  const compareLen = broadRecursiveAt === -1 ? broad.length : broadRecursiveAt;
  if (broadRecursiveAt === -1 && broad.length !== narrow.length) return { covers: false, wildcards };
  if (broadRecursiveAt !== -1 && broadRecursiveAt > narrow.length - 1) return { covers: false, wildcards };
  let strictlyBroader = broadRecursiveAt !== -1;
  for (let i = 0; i < compareLen; i += 1) {
    const b = broad[i]!;
    const n = narrow[i]!;
    if (b.kind === "literal") {
      if (n.kind !== "literal" || b.value !== n.value) return { covers: false, wildcards };
    } else {
      // param (or recursive at the tail, handled above) matches any segment
      if (n.kind === "literal") {
        strictlyBroader = true;
        wildcards.push({ name: b.value, literal: n.value });
      }
    }
  }
  return { covers: strictlyBroader, wildcards };
}

function effectiveAllowExpr(rule: SecurityRuleDefinition, op: string): unknown {
  const allow = rule.allow as Record<string, unknown>;
  if (allow[op] !== undefined) return allow[op];
  if ((op === "get" || op === "list") && allow["read"] !== undefined) return allow["read"];
  if ((op === "create" || op === "update" || op === "delete") && allow["write"] !== undefined) return allow["write"];
  return undefined;
}

function countExprNodes(expr: unknown, depth = 0): number {
  if (depth > 64 || expr === null || typeof expr !== "object") return 1;
  if (Array.isArray(expr)) return expr.reduce((sum, item) => sum + countExprNodes(item, depth + 1), 1);
  return Object.values(expr as Record<string, unknown>).reduce((sum, item) => sum + countExprNodes(item, depth + 1), 1);
}

/** True when the expression pins `path.<name>` away from `literal` (a wildcard guard). */
function expressionGuardsWildcard(expr: unknown, name: string, literal: string): boolean {
  if (expr === null || typeof expr !== "object") return false;
  const json = JSON.stringify(expr);
  const varNeedle = `"var":"path.${name}"`;
  return (
    (json.includes(varNeedle) && (json.includes(`"val":"${literal}"`) || json.includes(`"val": "${literal}"`)) && json.includes('"op":"!="'))
  );
}

const OVERLAP_OPS = ["get", "list", "create", "update", "delete", "read", "write"] as const;

/**
 * Warn when a parameterized wildcard `match` also covers a sibling `match`
 * path whose allow predicate for the same operation is stricter. Rules in
 * Vellum OR together: the broader block silently bypasses the stricter
 * sibling. The warning clears when the wildcard is explicitly guarded
 * (e.g. `if sub != 'messages'`).
 */
function detectWildcardOverlaps(
  rules: SecurityRuleDefinition[],
  parsedRules: { token: { line: number; column: number } }[],
  warn: (message: string, token: { line: number; column: number }) => void
): void {
  const segmentCache = rules.map((rule) => splitMatchPattern(rule.match));
  for (let i = 0; i < rules.length; i += 1) {
    for (let j = 0; j < rules.length; j += 1) {
      if (i === j) continue;
      const { covers, wildcards } = patternCovers(segmentCache[i]!, segmentCache[j]!);
      if (!covers) continue;
      const broad = rules[i]!;
      const narrow = rules[j]!;
      const seenOps = new Set<string>();
      for (const op of OVERLAP_OPS) {
        if (seenOps.has(op)) continue;
        seenOps.add(op);
        const broadExpr = effectiveAllowExpr(broad, op);
        const narrowExpr = effectiveAllowExpr(narrow, op);
        if (broadExpr === undefined || broadExpr === false) continue; // broad grants nothing here
        if (narrowExpr === undefined) continue; // sibling simply silent on this op
        if (narrowExpr !== false) {
          // Identical predicates are intentionally consistent; a broader rule
          // with strictly more constraint nodes is treated as the stricter one.
          // Everything else (fewer or equal nodes, different shape) is the
          // footgun this warning exists for.
          if (JSON.stringify(broadExpr) === JSON.stringify(narrowExpr)) continue;
          if (countExprNodes(broadExpr) > countExprNodes(narrowExpr)) continue;
        }
        // A guard on the wildcard segment (`sub != 'messages'`) resolves the overlap.
        if (
          wildcards.length > 0 &&
          wildcards.every((w) => expressionGuardsWildcard(broadExpr, w.name, w.literal))
        ) {
          continue;
        }
        const guardHint = wildcards.length > 0
          ? ` Guard the wildcard (for example 'if ${wildcards.map((w) => `${w.name} != '${w.literal}'`).join(" && ")}') or tighten the broader rule.`
          : " Tighten the broader rule or make the sibling at least as permissive.";
        warn(
          `WILDCARD_OVERLAP: match '${broad.match}' also matches every path covered by sibling match '${narrow.match}', but its '${op}' rule is looser. Rules OR together, so the stricter sibling does not protect those paths.${guardHint}`,
          parsedRules[i]?.token ?? { line: 1, column: 1 }
        );
        break; // one warning per rule pair is enough
      }
    }
  }
}
// ---------------------------------------------------------------------------

function formatLiteral(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  if (Array.isArray(value)) return `[${value.map(formatLiteral).join(", ")}]`;
  // Objects cannot be expressed as DSL literals; preserve them as a JSON
  // string so the value survives a compile/decompile cycle where possible.
  return `'${JSON.stringify(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function varToDsl(varPath: string): string {
  if (varPath === "resource.data") return "resource";
  if (varPath.startsWith("resource.data.")) return `resource.${varPath.slice("resource.data.".length)}`;
  if (varPath === "request.data") return "incoming";
  if (varPath.startsWith("request.data.")) return `incoming.${varPath.slice("request.data.".length)}`;
  if (varPath === "request.auth") return "auth";
  if (varPath.startsWith("request.auth.")) return `auth.${varPath.slice("request.auth.".length)}`;
  return varPath;
}

function operandToDsl(operand: AstOperand): string {
  if (operand && typeof operand === "object") {
    if ("val" in operand) return formatLiteral((operand as ValOperand).val);
    if ("var" in operand) return varToDsl((operand as VarOperand).var);
    if ("doc" in operand) {
      const spec = (operand as { doc: { collection: string; id: AstOperand; field?: string; exists?: boolean } }).doc;
      const idText = operandToDsl(spec.id);
      if (spec.exists === true) return `exists(${formatLiteral(spec.collection)}, ${idText})`;
      return `get(${formatLiteral(spec.collection)}, ${idText}).data${spec.field ? `.${spec.field}` : ""}`;
    }
  }
  return formatLiteral(operand);
}

function expressionToDsl(expr: AstExpression): string {
  if (typeof expr === "boolean") return expr ? "true" : "false";
  if (!expr || typeof expr !== "object") return "false";
  const node = expr as AstExpressionNode;
  if (node.op === "all" || node.op === "any") {
    const joiner = node.op === "all" ? " && " : " || ";
    const parts = (node.conditions ?? []).map((c) => {
      const text = expressionToDsl(c as AstExpression);
      return isAstNode(c as InternalNode) ? `(${text})` : text;
    });
    return parts.length > 0 ? parts.join(joiner) : "true";
  }
  if (node.op === "not") {
    return `!(${node.condition ? expressionToDsl(node.condition as AstExpression) : "false"})`;
  }
  if (node.op === "hasKey" || node.op === "isType") {
    return `${node.op}(${operandToDsl(node.left as AstOperand)}, ${operandToDsl(node.right as AstOperand)})`;
  }
  if (
    node.op === "==" &&
    node.left && typeof node.left === "object" && "doc" in node.left &&
    (node.left as { doc: { exists?: boolean } }).doc.exists === true &&
    node.right && typeof node.right === "object" && (node.right as { val?: unknown }).val === true
  ) {
    return operandToDsl(node.left);
  }
  if (node.left !== undefined && node.right !== undefined) {
    return `${operandToDsl(node.left)} ${node.op} ${operandToDsl(node.right)}`;
  }
  return "false";
}

const OP_ORDER = ["get", "list", "create", "update", "delete", "read", "write"];

export function decompileRulesAstToDsl(ast: SecurityRulesetAst): string {
  const lines: string[] = ["rules_version = '2';", ""];
  for (const rule of ast.rules ?? []) {
    lines.push(`match ${normalizeMatchPath(rule.match)} {`);
    const opNames = [
      ...OP_ORDER.filter((op) => rule.allow?.[op] !== undefined),
      ...Object.keys(rule.allow ?? {}).filter((op) => !OP_ORDER.includes(op)),
    ];
    for (const op of opNames) {
      const expr = rule.allow?.[op];
      lines.push(`  allow ${op}: if ${expressionToDsl(expr as AstExpression)};`);
    }
    lines.push("}", "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

// ---------------------------------------------------------------------------
// Public: simulator
// ---------------------------------------------------------------------------

function describeExpression(expr: AstExpression): string {
  if (typeof expr === "boolean") return `literal ${expr}`;
  if (!expr || typeof expr !== "object") return "invalid";
  const node = expr as AstExpressionNode;
  if (node.op === "all" || node.op === "any") return `${node.op}(${(node.conditions ?? []).length} conditions)`;
  if (node.op === "not") return "not(...)";
  return `${node.op}(${operandToDsl(node.left as AstOperand)}, ${operandToDsl(node.right as AstOperand)})`;
}

function traceEvaluate(
  expr: AstExpression,
  context: RuleEvaluationContext,
  trace: string[],
  label: string,
  depth = 1,
  budget: { steps: number } = { steps: 0 }
): boolean {
  if (depth > MAX_SIM_EVAL_DEPTH || ++budget.steps > MAX_SIM_EVAL_STEPS) {
    trace.push(`${label} evaluation budget exceeded → false`);
    return false;
  }
  if (typeof expr === "boolean") {
    trace.push(`${label} literal ${expr} → ${expr}`);
    return expr;
  }
  if (!expr || typeof expr !== "object") {
    trace.push(`${label} invalid expression → false`);
    return false;
  }
  const node = expr as AstExpressionNode;
  if (node.op === "all" || node.op === "any") {
    const childResults = (node.conditions ?? []).map((child, i) =>
      traceEvaluate(child as AstExpression, context, trace, `${label}.${node.op}[${i}]`, depth + 1, budget)
    );
    const result = node.op === "all" ? childResults.every(Boolean) : childResults.some(Boolean);
    trace.push(`${label} ${node.op} → ${result}`);
    return result;
  }
  if (node.op === "not") {
    const child = node.condition
      ? traceEvaluate(node.condition as AstExpression, context, trace, `${label}.not`, depth + 1, budget)
      : false;
    const result = !child;
    trace.push(`${label} not → ${result}`);
    return result;
  }
  // Leaf operators: reuse the canonical evaluator so semantics never diverge.
  const result = evaluateAstNode(expr, context);
  trace.push(`${label} ${describeExpression(expr)} → ${result}`);
  return result;
}

function matchPathBothWays(pattern: string, path: string): Record<string, string> | null {
  const candidates: Array<[string, string]> = [
    [pattern, path],
    [stripLeadingSlash(pattern), stripLeadingSlash(path)],
    [ensureLeadingSlash(pattern), ensureLeadingSlash(path)],
    [stripLeadingSlash(pattern), ensureLeadingSlash(path)],
    [ensureLeadingSlash(pattern), stripLeadingSlash(path)],
  ];
  for (const [p, t] of candidates) {
    const bindings = matchRulePathPattern(p, t);
    if (bindings) return bindings;
  }
  return null;
}

export function simulateRuleEvaluation(params: SimulateRuleEvaluationParams): SimulateRuleEvaluationResult {
  const ast = "rulesAst" in params.ruleset ? params.ruleset.rulesAst : params.ruleset;
  const evaluationTrace: string[] = [];
  const auth = params.auth ?? { uid: null, claims: {} };
  const pathParamsBase: Record<string, string> = {};

  evaluationTrace.push(`simulate: operation '${params.operation}' on path '${params.path}'`);

  for (const rule of ast.rules ?? []) {
    evaluationTrace.push(`path pattern tested: '${rule.match}' against '${params.path}'`);
    const bindings = matchPathBothWays(rule.match, params.path);
    if (!bindings) {
      evaluationTrace.push(`  '${rule.match}' → NO MATCH`);
      continue;
    }
    evaluationTrace.push(`  '${rule.match}' → MATCH (params: ${JSON.stringify({ ...pathParamsBase, ...bindings })})`);

    const expr =
      rule.allow?.[params.operation] ??
      (params.operation === "get" || params.operation === "list" ? rule.allow?.read : undefined) ??
      (params.operation === "create" || params.operation === "update" || params.operation === "delete"
        ? rule.allow?.write
        : undefined);

    if (expr === undefined) {
      evaluationTrace.push(`  operation '${params.operation}' → NO EXPRESSION defined; rule does not grant access`);
      continue;
    }
    evaluationTrace.push(`  operation '${params.operation}' expression evaluated: ${describeExpression(expr as AstExpression)}`);

    const context: RuleEvaluationContext = {
      auth,
      pathParams: { ...pathParamsBase, ...bindings },
      resourceData: params.resourceData ?? null,
      requestData: params.incomingData ?? null,
      requestTimeMs: Date.now(),
    };
    const allowed = traceEvaluate(expr as AstExpression, context, evaluationTrace, "root");
    if (allowed) {
      evaluationTrace.push(`DECISION: ALLOW (matched rule '${rule.match}')`);
      return { allowed: true, matchedRule: rule.match, evaluationTrace };
    }
    evaluationTrace.push(`  rule '${rule.match}' → DENY for '${params.operation}'; trying next rule`);
  }

  evaluationTrace.push("DECISION: DENY");
  return { allowed: false, matchedRule: null, evaluationTrace };
}
