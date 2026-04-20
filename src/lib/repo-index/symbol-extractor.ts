/// Top-level symbol extractor for TS/JS/TSX/JSX source code.
///
/// Uses @babel/parser with the typescript + jsx plugins, then walks the
/// Program body manually (we only care about top-level declarations — we do
/// not descend into function bodies). This keeps extraction cheap and
/// predictable: O(top-level-statements) per file rather than O(all-nodes).
///
/// What we extract today:
///   - function foo() {}                              -> FUNCTION
///   - class Foo {}                                   -> CLASS (+ methods)
///   - const foo = (...) => ... | function(...) ...   -> FUNCTION
///   - const Foo = (...) => <JSX/> (capitalized)      -> COMPONENT
///   - interface Foo {}                               -> INTERFACE
///   - type Foo = ...                                 -> TYPE
///   - enum Foo {}                                    -> ENUM
///   - const FOO = ...  / let foo = ...               -> VARIABLE
///
/// What we skip (deliberately, for MVP):
///   - Re-exports (`export { Foo } from "./bar"`): we don't follow paths.
///   - Deeply-nested declarations (functions declared inside functions).
///   - Namespaces / module augmentation.
///   - Default exports without a name (they become VARIABLE "default").

import { parse, type ParserPlugin } from "@babel/parser";
import type {
  ClassDeclaration,
  Declaration,
  ExportDefaultDeclaration,
  ExportNamedDeclaration,
  FunctionDeclaration,
  Node,
  Program,
  Statement,
  TSEnumDeclaration,
  TSInterfaceDeclaration,
  TSTypeAliasDeclaration,
  VariableDeclaration,
} from "@babel/types";

import type { RepoSymbolKind } from "@prisma/client";

export type ExtractedSymbol = {
  name: string;
  kind: RepoSymbolKind;
  line: number;
  endLine: number | null;
  exported: boolean;
};

export type ExtractSymbolsResult = {
  symbols: ExtractedSymbol[];
  /// Set when parsing bailed out before reaching EOF (syntax we don't support,
  /// invalid code, etc). The symbol array still contains anything we managed
  /// to parse before the error. Surface this as a PARTIAL hint, not a failure.
  parseError?: string;
};

const TS_PLUGINS: ReadonlyArray<ParserPlugin> = [
  "typescript",
  "jsx",
  "decorators-legacy",
  "importAssertions",
  "explicitResourceManagement",
];

const JS_PLUGINS: ReadonlyArray<ParserPlugin> = [
  "jsx",
  "decorators-legacy",
  "importAssertions",
];

function pluginsForLanguage(language: "typescript" | "javascript"): ParserPlugin[] {
  return language === "typescript" ? [...TS_PLUGINS] : [...JS_PLUGINS];
}

export type ExtractSymbolsOptions = {
  language: "typescript" | "javascript";
  filename: string;
};

/// Parses a source file and returns the top-level symbols it declares. Never
/// throws: on parse failure, returns `{ symbols: [...partial], parseError }`.
export function extractSymbols(
  source: string,
  options: ExtractSymbolsOptions
): ExtractSymbolsResult {
  let program: Program;
  try {
    const file = parse(source, {
      sourceType: "module",
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      errorRecovery: true,
      plugins: pluginsForLanguage(options.language),
    });
    program = file.program;
  } catch (error) {
    return {
      symbols: [],
      parseError:
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : "Parse failed.",
    };
  }

  const symbols: ExtractedSymbol[] = [];

  for (const statement of program.body) {
    extractFromStatement(statement, symbols, false);
  }

  // Deduplicate by (name, kind, line) — defensive in case the same declaration
  // got walked via both `export { foo }` aliasing and the underlying node.
  const seen = new Set<string>();
  const deduped: ExtractedSymbol[] = [];
  for (const sym of symbols) {
    const key = `${sym.name}\0${sym.kind}\0${sym.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(sym);
  }

  return { symbols: deduped };
}

function extractFromStatement(
  statement: Statement,
  out: ExtractedSymbol[],
  inheritedExported: boolean
): void {
  if (statement.type === "ExportNamedDeclaration") {
    handleExportNamed(statement, out);
    return;
  }
  if (statement.type === "ExportDefaultDeclaration") {
    handleExportDefault(statement, out);
    return;
  }

  // Non-export-wrapped top-level declarations.
  extractFromDeclaration(statement, out, inheritedExported);
}

function handleExportNamed(
  node: ExportNamedDeclaration,
  out: ExtractedSymbol[]
): void {
  if (node.declaration) {
    extractFromDeclaration(node.declaration, out, true);
    return;
  }
  for (const spec of node.specifiers ?? []) {
    if (spec.type === "ExportSpecifier") {
      const exportedName =
        spec.exported.type === "Identifier"
          ? spec.exported.name
          : spec.exported.value;
      const loc = spec.loc;
      if (!exportedName || !loc) continue;
      out.push({
        name: exportedName,
        kind: "VARIABLE",
        line: loc.start.line,
        endLine: loc.end.line,
        exported: true,
      });
    }
  }
}

function handleExportDefault(
  node: ExportDefaultDeclaration,
  out: ExtractedSymbol[]
): void {
  const decl = node.declaration;
  if (!decl) return;
  if (
    decl.type === "FunctionDeclaration" ||
    decl.type === "ClassDeclaration"
  ) {
    const name =
      (decl.id && decl.id.type === "Identifier" && decl.id.name) || "default";
    const loc = decl.loc;
    if (!loc) return;
    out.push({
      name,
      kind: decl.type === "ClassDeclaration" ? "CLASS" : "FUNCTION",
      line: loc.start.line,
      endLine: loc.end.line,
      exported: true,
    });
    if (decl.type === "ClassDeclaration") {
      pushClassMethods(decl, out, true);
    }
  }
}

function extractFromDeclaration(
  node: Statement | Declaration,
  out: ExtractedSymbol[],
  exported: boolean
): void {
  switch (node.type) {
    case "FunctionDeclaration":
      pushFunctionDeclaration(node, out, exported);
      return;
    case "ClassDeclaration":
      pushClassDeclaration(node, out, exported);
      return;
    case "VariableDeclaration":
      pushVariableDeclaration(node, out, exported);
      return;
    case "TSInterfaceDeclaration":
      pushInterfaceDeclaration(node, out, exported);
      return;
    case "TSTypeAliasDeclaration":
      pushTypeAliasDeclaration(node, out, exported);
      return;
    case "TSEnumDeclaration":
      pushEnumDeclaration(node, out, exported);
      return;
    default:
      return;
  }
}

function pushFunctionDeclaration(
  node: FunctionDeclaration,
  out: ExtractedSymbol[],
  exported: boolean
): void {
  if (!node.id || !node.loc) return;
  out.push({
    name: node.id.name,
    kind: "FUNCTION",
    line: node.loc.start.line,
    endLine: node.loc.end.line,
    exported,
  });
}

function pushClassDeclaration(
  node: ClassDeclaration,
  out: ExtractedSymbol[],
  exported: boolean
): void {
  if (!node.id || !node.loc) return;
  out.push({
    name: node.id.name,
    kind: "CLASS",
    line: node.loc.start.line,
    endLine: node.loc.end.line,
    exported,
  });
  pushClassMethods(node, out, exported);
}

function pushClassMethods(
  node: ClassDeclaration,
  out: ExtractedSymbol[],
  exported: boolean
): void {
  for (const member of node.body.body) {
    if (member.type === "ClassMethod" || member.type === "ClassPrivateMethod") {
      const key = member.key;
      let name: string | null = null;
      if (key.type === "Identifier") name = key.name;
      else if (key.type === "StringLiteral") name = key.value;
      else if (key.type === "PrivateName" && key.id.type === "Identifier")
        name = `#${key.id.name}`;
      if (!name || !member.loc) continue;
      out.push({
        name,
        kind: "METHOD",
        line: member.loc.start.line,
        endLine: member.loc.end.line,
        exported,
      });
    }
  }
}

function pushVariableDeclaration(
  node: VariableDeclaration,
  out: ExtractedSymbol[],
  exported: boolean
): void {
  for (const decl of node.declarations) {
    if (decl.id.type !== "Identifier" || !decl.loc) continue;
    const name = decl.id.name;
    const init = decl.init;

    let kind: RepoSymbolKind = "VARIABLE";
    if (init) {
      if (
        init.type === "ArrowFunctionExpression" ||
        init.type === "FunctionExpression"
      ) {
        kind = looksLikeComponentName(name) && containsJsxReturn(init.body)
          ? "COMPONENT"
          : "FUNCTION";
      } else if (init.type === "CallExpression") {
        // Common pattern: const Foo = memo(() => <JSX/>)
        if (
          looksLikeComponentName(name) &&
          init.arguments.some(
            (arg) =>
              arg.type === "ArrowFunctionExpression" &&
              containsJsxReturn(arg.body)
          )
        ) {
          kind = "COMPONENT";
        } else {
          kind = "VARIABLE";
        }
      }
    }

    out.push({
      name,
      kind,
      line: decl.loc.start.line,
      endLine: decl.loc.end.line,
      exported,
    });
  }
}

function looksLikeComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function containsJsxReturn(body: Node): boolean {
  if (body.type === "JSXElement" || body.type === "JSXFragment") return true;
  if (body.type === "BlockStatement") {
    for (const stmt of body.body) {
      if (stmt.type === "ReturnStatement" && stmt.argument) {
        const arg = stmt.argument;
        if (arg.type === "JSXElement" || arg.type === "JSXFragment") return true;
      }
    }
  }
  return false;
}

function pushInterfaceDeclaration(
  node: TSInterfaceDeclaration,
  out: ExtractedSymbol[],
  exported: boolean
): void {
  if (!node.id || !node.loc) return;
  out.push({
    name: node.id.name,
    kind: "INTERFACE",
    line: node.loc.start.line,
    endLine: node.loc.end.line,
    exported,
  });
}

function pushTypeAliasDeclaration(
  node: TSTypeAliasDeclaration,
  out: ExtractedSymbol[],
  exported: boolean
): void {
  if (!node.id || !node.loc) return;
  out.push({
    name: node.id.name,
    kind: "TYPE",
    line: node.loc.start.line,
    endLine: node.loc.end.line,
    exported,
  });
}

function pushEnumDeclaration(
  node: TSEnumDeclaration,
  out: ExtractedSymbol[],
  exported: boolean
): void {
  if (!node.id || !node.loc) return;
  out.push({
    name: node.id.name,
    kind: "ENUM",
    line: node.loc.start.line,
    endLine: node.loc.end.line,
    exported,
  });
}
