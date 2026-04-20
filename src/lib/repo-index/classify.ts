/// Path-based classifiers for repo indexing.
///
/// These run on every tree entry during sync, so they must be cheap and
/// deterministic. Accuracy only needs to be "good enough for resolver bias" —
/// the resolver still falls back to full-repo search when kind heuristics
/// produce no clear winner.

import type { RepoFileKind } from "@prisma/client";

const TEST_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)__tests__\//,
  /(^|\/)tests?\//,
  /(^|\/)spec\//,
  /(^|\/)e2e\//,
  /(^|\/)cypress\//,
  /(^|\/)playwright\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /\.(test|spec)\.py$/,
  /_test\.go$/,
  /_spec\.rb$/,
];

const DOCS_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)docs?\//,
  /(^|\/)documentation\//,
  /\.(md|mdx|rst|adoc|txt)$/i,
];

const CONFIG_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /(^|\/)\.github\//,
  /(^|\/)\.vscode\//,
  /(^|\/)\.idea\//,
  /(^|\/)config\//,
  /\.(json|ya?ml|toml|ini|env|lock)$/i,
  /(^|\/)(package|tsconfig|jest|vitest|eslint|prettier|next|tailwind|postcss|vite|rollup|webpack|babel|swc)\.config\./i,
  /(^|\/)\.?(eslintrc|prettierrc|gitignore|gitattributes|nvmrc|npmrc|editorconfig|dockerignore)(\..+)?$/i,
  /(^|\/)Dockerfile$/i,
  /(^|\/)Makefile$/i,
];

const ASSET_PATH_PATTERNS: ReadonlyArray<RegExp> = [
  /\.(png|jpe?g|gif|svg|webp|ico|bmp|tiff?)$/i,
  /\.(mp3|mp4|wav|ogg|webm|mov|avi)$/i,
  /\.(woff2?|ttf|otf|eot)$/i,
  /\.(pdf|zip|gz|tar|7z)$/i,
  /(^|\/)public\/.*\.(js|css)$/i,
];

const CODE_EXTENSION_LANGUAGES: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  kts: "kotlin",
  scala: "scala",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hh: "cpp",
  cs: "csharp",
  php: "php",
  lua: "lua",
  dart: "dart",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  clj: "clojure",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  vue: "vue",
  svelte: "svelte",
  r: "r",
  m: "objective-c",
  mm: "objective-c",
};

const DOCS_EXTENSION_LANGUAGES: Record<string, string> = {
  md: "markdown",
  mdx: "markdown",
  rst: "restructuredtext",
  adoc: "asciidoc",
  txt: "plaintext",
};

const CONFIG_EXTENSION_LANGUAGES: Record<string, string> = {
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  env: "env",
  lock: "lockfile",
};

function matchesAny(path: string, patterns: ReadonlyArray<RegExp>): boolean {
  return patterns.some((pattern) => pattern.test(path));
}

function extensionFromPath(path: string): string | null {
  const lastSlash = path.lastIndexOf("/");
  const basename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) {
    return null;
  }
  return basename.slice(dot + 1).toLowerCase();
}

export type ClassifiedFile = {
  kind: RepoFileKind;
  language: string | null;
};

/// Classifies a file by path. Order matters: test/asset checks before docs
/// (Markdown living under /docs is DOCS; a .md inside __tests__ is still
/// TEST for our bias purposes).
export function classifyFilePath(path: string): ClassifiedFile {
  if (matchesAny(path, TEST_PATH_PATTERNS)) {
    return { kind: "TEST", language: languageFromExtension(path) };
  }
  if (matchesAny(path, ASSET_PATH_PATTERNS)) {
    return { kind: "ASSET", language: null };
  }
  if (matchesAny(path, DOCS_PATH_PATTERNS)) {
    return {
      kind: "DOCS",
      language: DOCS_EXTENSION_LANGUAGES[extensionFromPath(path) ?? ""] ?? null,
    };
  }
  if (matchesAny(path, CONFIG_PATH_PATTERNS)) {
    return {
      kind: "CONFIG",
      language:
        CONFIG_EXTENSION_LANGUAGES[extensionFromPath(path) ?? ""] ?? null,
    };
  }

  const language = languageFromExtension(path);
  if (language) {
    return { kind: "CODE", language };
  }

  return { kind: "OTHER", language: null };
}

function languageFromExtension(path: string): string | null {
  const ext = extensionFromPath(path);
  if (!ext) {
    return null;
  }
  return CODE_EXTENSION_LANGUAGES[ext] ?? null;
}

/// Subset of languages currently supported by the symbol indexer. Kept here
/// (next to the language map) so the indexer and the resolver stay in sync
/// about what they can expect to find in TargRepoSymbol.
export const SYMBOL_INDEXED_LANGUAGES: ReadonlySet<string> = new Set([
  "typescript",
  "javascript",
]);

export function isSymbolIndexable(kind: RepoFileKind, language: string | null): boolean {
  if (kind !== "CODE") {
    return false;
  }
  return language !== null && SYMBOL_INDEXED_LANGUAGES.has(language);
}
