/// File-level path resolver for the repo index.
///
/// Given a "hint" from TARG evidence — something vague like
/// "CheckoutService failed" or pseudo-concrete like "src/checkout.ts:42" —
/// rank candidate files from a snapshot that plausibly correspond to the
/// hint. The Handoff Packet builder consumes the top candidates to replace
/// fuzzy location text with real `owner/repo/path#L42` references.
///
/// Design goals:
/// - Pure function on file metadata (easy to unit-test, no DB in this layer).
/// - Multiple matcher strategies, each contributing a reason + score.
/// - Order-independent inputs; ties broken by path length then lexical sort.
/// - Never throws on malformed hints — returns an empty array instead.
///
/// Scoring is intentionally coarse (0.0–1.0 with ~0.05 increments). The goal
/// is rough ordering, not calibrated probabilities. Downstream consumers
/// should treat scores < 0.35 as low-confidence matches and prefer to surface
/// multiple candidates.

import type { RepoFileKind, RepoSymbolKind } from "@prisma/client";

export type ResolverInputFile = {
  path: string;
  kind: RepoFileKind;
  language: string | null;
};

export type ResolvedCandidate = {
  path: string;
  kind: RepoFileKind;
  language: string | null;
  score: number;
  /// Per-strategy explanations that contributed to the score. Surface this in
  /// diagnostic UIs when multiple candidates look plausible.
  reasons: string[];
  /// Optional 1-based line number, if the hint carried one (e.g. "foo.ts:42").
  line?: number;
};

export type ResolvePathOptions = {
  /// Maximum candidates to return. Default 5.
  limit?: number;
  /// Files at or below this score are dropped. Default 0.15 — low enough to
  /// keep weak matches visible when nothing better exists, high enough to
  /// filter complete noise.
  minScore?: number;
  /// When true, TEST files are excluded from results unless the hint itself
  /// looks test-related. Default true.
  biasAwayFromTests?: boolean;
};

const DEFAULT_LIMIT = 5;
const DEFAULT_MIN_SCORE = 0.15;

const HINT_SEPARATOR_REGEX = /[\s,;]+/;
/// Accepts `path:line`, `path#L42`, `path:42:5`. Captures path + first line.
const PATH_WITH_LINE_REGEX = /^(.+?)(?::(\d+)(?::\d+)?|#L(\d+))$/;
/// Only natural-language filler. We deliberately do NOT drop words like
/// "service", "class", "handler", "module" — those appear as real identifier
/// segments far too often (CheckoutService, PaymentHandler, ApiModule).
const STOPWORDS: ReadonlySet<string> = new Set([
  "the",
  "a",
  "an",
  "in",
  "at",
  "of",
  "to",
  "for",
  "on",
  "and",
  "or",
  "with",
  "is",
  "was",
  "are",
  "from",
  "when",
  "this",
  "that",
  "it",
  "failed",
  "fails",
  "failing",
  "error",
  "errors",
]);

/// Splits an identifier-like string into lowercase word tokens, handling
/// camelCase, PascalCase, snake_case, kebab-case, and dotted segments.
export function tokenize(raw: string): string[] {
  const primary = raw.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const tokens: string[] = [];
  for (const chunk of primary) {
    // Split camelCase / PascalCase.
    const sub = chunk
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/\s+/)
      .filter(Boolean);
    for (const token of sub) {
      const lower = token.toLowerCase();
      if (lower.length < 2) continue;
      if (STOPWORDS.has(lower)) continue;
      tokens.push(lower);
    }
  }
  return tokens;
}

function basename(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function stripExtension(name: string): string {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return name;
  return name.slice(0, idx);
}

function parseHint(raw: string): { path: string; line: number | null } {
  const trimmed = raw.trim();
  const match = PATH_WITH_LINE_REGEX.exec(trimmed);
  if (match) {
    const line = Number(match[2] ?? match[3]);
    return {
      path: match[1]!,
      line: Number.isFinite(line) && line > 0 ? line : null,
    };
  }
  return { path: trimmed, line: null };
}

function hintLooksLikeTest(hint: string): boolean {
  const lower = hint.toLowerCase();
  return (
    lower.includes("test") ||
    lower.includes("spec") ||
    lower.includes("fixture") ||
    lower.includes("mock")
  );
}

function kindPenalty(kind: RepoFileKind, biasAwayFromTests: boolean, hintIsTesty: boolean): number {
  if (kind === "CODE") return 0;
  if (kind === "TEST") {
    if (!biasAwayFromTests || hintIsTesty) return -0.05;
    return -0.4;
  }
  if (kind === "CONFIG") return -0.1;
  if (kind === "DOCS") return -0.15;
  if (kind === "ASSET") return -0.3;
  return -0.2;
}

/// Ranks files against a hint. See module header for scoring semantics.
export function resolvePath(
  hint: string,
  files: ReadonlyArray<ResolverInputFile>,
  options: ResolvePathOptions = {}
): ResolvedCandidate[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const biasAwayFromTests = options.biasAwayFromTests ?? true;

  const { path: hintPath, line } = parseHint(hint);
  if (!hintPath) return [];
  const hintLower = hintPath.toLowerCase();
  const hintBase = basename(hintLower);
  const hintBaseNoExt = stripExtension(hintBase);
  const hintTokens = new Set(
    tokenize(hintPath).concat(
      // Also pull extra tokens from free-form hints like "CheckoutService failed"
      hintPath.split(HINT_SEPARATOR_REGEX).flatMap(tokenize)
    )
  );
  const hintIsTesty = hintLooksLikeTest(hintPath);

  const scored: ResolvedCandidate[] = [];

  for (const file of files) {
    const pathLower = file.path.toLowerCase();
    const baseLower = basename(pathLower);
    const baseNoExt = stripExtension(baseLower);

    let score = 0;
    const reasons: string[] = [];

    if (pathLower === hintLower) {
      score = 1;
      reasons.push("exact path match");
    } else if (pathLower.endsWith(`/${hintLower}`) || pathLower === hintLower) {
      score = 0.92;
      reasons.push("path suffix match");
    } else if (baseLower === hintBase) {
      score = 0.85;
      reasons.push("exact basename match");
    } else if (baseNoExt === hintBaseNoExt && hintBaseNoExt.length >= 3) {
      score = 0.78;
      reasons.push("basename match (ignoring extension)");
    } else if (hintLower && pathLower.includes(hintLower) && hintLower.length >= 3) {
      score = 0.62;
      reasons.push("path contains hint as substring");
    } else if (hintBase && baseLower.includes(hintBase) && hintBase.length >= 3) {
      score = 0.5;
      reasons.push("basename contains hint");
    } else if (hintBaseNoExt && baseNoExt.includes(hintBaseNoExt) && hintBaseNoExt.length >= 3) {
      score = 0.45;
      reasons.push("basename contains hint (no extension)");
    }

    if (hintTokens.size > 0) {
      const pathTokens = new Set(tokenize(file.path));
      let overlap = 0;
      for (const token of hintTokens) {
        if (pathTokens.has(token)) overlap += 1;
      }
      if (overlap > 0) {
        const jaccard =
          overlap /
          Math.max(1, hintTokens.size + pathTokens.size - overlap);
        const tokenScore = Math.min(0.5, jaccard * 1.2);
        if (tokenScore > 0) {
          // If we had no structural match, this is the whole score.
          // Otherwise it acts as a bonus, capped so it cannot overtake a real match.
          if (score === 0) {
            score = tokenScore;
            reasons.push(
              `token overlap: ${overlap} shared token${overlap === 1 ? "" : "s"}`
            );
          } else {
            const bonus = Math.min(0.1, tokenScore * 0.3);
            score = Math.min(1, score + bonus);
            if (bonus >= 0.02) {
              reasons.push(
                `token overlap bonus (+${bonus.toFixed(2)}, ${overlap} shared)`
              );
            }
          }
        }
      }
    }

    if (score <= 0) continue;

    const penalty = kindPenalty(file.kind, biasAwayFromTests, hintIsTesty);
    if (penalty !== 0) {
      score += penalty;
      reasons.push(
        `${file.kind.toLowerCase()} file (${penalty > 0 ? "+" : ""}${penalty.toFixed(2)})`
      );
    }

    if (score < minScore) continue;

    const clamped = Math.max(0, Math.min(1, score));
    scored.push({
      path: file.path,
      kind: file.kind,
      language: file.language,
      score: clamped,
      reasons,
      ...(line !== null ? { line } : {}),
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.path.length !== b.path.length) return a.path.length - b.path.length;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  return scored.slice(0, limit);
}

export type ResolverInputSymbol = {
  name: string;
  kind: RepoSymbolKind;
  line: number;
  endLine: number | null;
  exported: boolean;
  filePath: string;
  fileKind: RepoFileKind;
  fileLanguage: string | null;
};

export type ResolvedSymbolCandidate = {
  name: string;
  kind: RepoSymbolKind;
  line: number;
  endLine: number | null;
  exported: boolean;
  filePath: string;
  fileKind: RepoFileKind;
  fileLanguage: string | null;
  score: number;
  reasons: string[];
};

export type ResolveSymbolOptions = {
  /// Maximum candidates to return. Default 5.
  limit?: number;
  /// Minimum score required to survive. Default 0.2.
  minScore?: number;
  /// Filter to specific symbol kinds.
  kinds?: ReadonlyArray<RepoSymbolKind>;
  /// When true, prefer exported symbols over internal helpers. Default true.
  preferExported?: boolean;
  /// When true, penalize symbols defined in TEST files unless the query
  /// itself looks test-related. Default true.
  biasAwayFromTests?: boolean;
};

/// Ranks symbols against a query. Matching strategies:
///   - Exact name (case-sensitive)         -> 1.0
///   - Exact name (case-insensitive)       -> 0.9
///   - Query is a token of the symbol      -> 0.6
///   - Symbol is a token of the query      -> 0.5
///   - Substring match                     -> 0.4
/// Modifiers: +0.1 for exported, test-file penalty per fileKind.
export function resolveSymbol(
  query: string,
  symbols: ReadonlyArray<ResolverInputSymbol>,
  options: ResolveSymbolOptions = {}
): ResolvedSymbolCandidate[] {
  const limit = options.limit ?? 5;
  const minScore = options.minScore ?? 0.2;
  const preferExported = options.preferExported ?? true;
  const biasAwayFromTests = options.biasAwayFromTests ?? true;
  const kindsFilter = options.kinds ? new Set(options.kinds) : null;

  const trimmed = query.trim();
  if (!trimmed) return [];

  const lower = trimmed.toLowerCase();
  const queryTokens = new Set(tokenize(trimmed));
  const hintIsTesty = hintLooksLikeTest(trimmed);

  const scored: ResolvedSymbolCandidate[] = [];

  for (const sym of symbols) {
    if (kindsFilter && !kindsFilter.has(sym.kind)) continue;

    let score = 0;
    const reasons: string[] = [];

    if (sym.name === trimmed) {
      score = 1;
      reasons.push("exact symbol name");
    } else if (sym.name.toLowerCase() === lower) {
      score = 0.9;
      reasons.push("case-insensitive exact match");
    } else {
      const symTokens = new Set(tokenize(sym.name));
      const queryIsToken = queryTokens.size === 1 && symTokens.has(lower);
      const symIsToken = symTokens.size === 1 && queryTokens.has(sym.name.toLowerCase());
      if (queryIsToken) {
        score = 0.6;
        reasons.push("query matches a token of the symbol name");
      } else if (symIsToken) {
        score = 0.5;
        reasons.push("symbol is a token of the query");
      } else if (sym.name.toLowerCase().includes(lower) && lower.length >= 3) {
        score = 0.4;
        reasons.push("symbol name contains query as substring");
      } else {
        // Token-set overlap fallback for multi-word queries.
        let overlap = 0;
        for (const token of queryTokens) {
          if (symTokens.has(token)) overlap += 1;
        }
        if (overlap > 0) {
          const jaccard =
            overlap /
            Math.max(1, queryTokens.size + symTokens.size - overlap);
          score = Math.min(0.45, jaccard * 0.9);
          if (score >= minScore * 0.9) {
            reasons.push(
              `token overlap with symbol name (${overlap} shared)`
            );
          } else {
            score = 0;
          }
        }
      }
    }

    if (score <= 0) continue;

    if (preferExported && sym.exported) {
      score = Math.min(1, score + 0.08);
      reasons.push("exported (+0.08)");
    }

    const penalty = kindPenalty(sym.fileKind, biasAwayFromTests, hintIsTesty);
    if (penalty !== 0) {
      score += penalty;
      reasons.push(
        `${sym.fileKind.toLowerCase()} file (${penalty > 0 ? "+" : ""}${penalty.toFixed(2)})`
      );
    }

    if (score < minScore) continue;

    scored.push({
      name: sym.name,
      kind: sym.kind,
      line: sym.line,
      endLine: sym.endLine,
      exported: sym.exported,
      filePath: sym.filePath,
      fileKind: sym.fileKind,
      fileLanguage: sym.fileLanguage,
      score: Math.max(0, Math.min(1, score)),
      reasons,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.filePath.length !== b.filePath.length)
      return a.filePath.length - b.filePath.length;
    return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0;
  });

  return scored.slice(0, limit);
}
