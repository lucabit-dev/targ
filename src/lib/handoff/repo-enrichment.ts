/**
 * Handoff Packet repo enrichment (Phase 2.3).
 *
 * Pure adapter that bridges the Handoff Packet builder (neutral, in-memory)
 * with the repo index resolver (also pure). The service layer injects a
 * `EnrichmentContext` that closes over preloaded snapshot files/symbols, so
 * this module never touches Prisma. Everything here is deterministic and
 * unit-testable with plain data.
 *
 * Responsibilities:
 *   1. Extract "hints" from the raw TARG domain view models — evidence
 *      summaries, stack frames, the diagnosis affected area, service names.
 *   2. Resolve each hint against the snapshot (both path- and symbol-based).
 *   3. Merge + dedupe candidates into `RepoLocation[]` per evidence item,
 *      plus the single best `affectedAreaLocation` and a top-N list of
 *      stack-trace locations for `repoContext.stackLocations`.
 *
 * What this module deliberately does NOT do:
 *   - Load snapshots / files / symbols. That's the enrichment service.
 *   - Trigger re-sync. That's the enrichment service.
 *   - Render Markdown. That's `render-markdown.ts`.
 */

import type { EvidenceViewModel } from "@/lib/evidence/view-model";
import type {
  HandoffPacketInput,
  RepoEnrichmentInput,
  RepoLocation,
} from "@/lib/handoff/packet";
import type {
  ResolvedCandidate,
  ResolvedSymbolCandidate,
  ResolvePathOptions,
  ResolveSymbolOptions,
} from "@/lib/repo-index/resolver";

const MAX_LOCATIONS_PER_EVIDENCE = 3;
const MAX_AFFECTED_AREA_CANDIDATES = 1;
const MAX_STACK_LOCATIONS = 5;
/// Candidates below this score are dropped even if the resolver returned them,
/// because per-item enrichment should only surface high-signal matches. The
/// resolver's own default floor is 0.15; we raise it to 0.25 for the handoff
/// path since the packet is user-facing and noise is costly.
const MIN_LOCATION_SCORE = 0.25;

/// Capture group 1 = the path-like token, optionally followed by `:line` or
/// `#L42`. Supports the common extensions we're likely to index. Tight-ish
/// to avoid matching prose words that happen to contain dots.
const PATH_IN_TEXT_REGEX =
  /(?<![\w/])((?:[\w.-]+\/)*[\w.-]+\.(?:tsx?|jsx?|mjs|cjs|d\.ts|py|go|rb|java|rs|kt|swift|php|cs|cpp|c|h|hpp|css|scss|less|html|vue|svelte|json|ya?ml|toml|md|sql|sh|bash|zsh)(?:[:#]L?\d+(?::\d+)?)?)/gi;

/// A stack-frame line like `at Foo.bar (src/lib/foo.ts:42:15)`. Captures the
/// parenthetical location; the resolver parses the `:line:col` internally.
const STACK_FRAME_PAREN_LOC_REGEX = /\(([^()]+:\d+(?::\d+)?)\)/g;
/// Bare stack frames like `  at Foo.bar src/lib/foo.ts:42:15` (no parens).
const STACK_FRAME_BARE_LOC_REGEX =
  /\bat\s+\S+\s+((?:[\w.-]+\/)*[\w.-]+\.\w+:\d+(?::\d+)?)/gi;

// ---------------------------------------------------------------------------
// Context injected by the service layer
// ---------------------------------------------------------------------------

export type EnrichmentContext = {
  /// `owner/repo`, copied verbatim onto the packet's `repoContext.repoFullName`.
  repoFullName: string;
  /// Commit SHA the snapshot is pinned to. Copied onto `repoContext.ref`.
  ref: string;
  /// Resolve a hint string against the snapshot's file list. Expected to be
  /// a closure that preloads files once and calls `resolvePath` in-memory.
  resolvePath: (hint: string, options?: ResolvePathOptions) => ResolvedCandidate[];
  /// Resolve a symbol query against the snapshot's symbol list. Expected to
  /// be a closure that preloads symbols once and calls `resolveSymbol`.
  resolveSymbol: (
    query: string,
    options?: ResolveSymbolOptions
  ) => ResolvedSymbolCandidate[];
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function enrichPacketInput(
  input: HandoffPacketInput,
  ctx: EnrichmentContext
): RepoEnrichmentInput {
  const evidenceLocations: Record<string, RepoLocation[]> = {};
  const aggregatedStackLocations: ScoredLocation[] = [];

  for (const item of input.evidence) {
    const { pathHints, symbolHints, stackHints } = extractEvidenceHints(item);

    const perItemLocations: ScoredLocation[] = [];
    for (const hint of pathHints) {
      perItemLocations.push(...scorePathHint(hint, ctx));
    }
    for (const hint of symbolHints) {
      perItemLocations.push(...scoreSymbolHint(hint, ctx));
    }

    const stackLocations: ScoredLocation[] = [];
    for (const hint of stackHints) {
      // Stack frames are the most reliable source — pass them through the
      // path resolver directly (it handles `:line` syntax). The resolver
      // returns the top candidate carrying the `line` from the hint.
      stackLocations.push(...scorePathHint(hint, ctx));
    }

    const merged = dedupeAndRank(
      [...perItemLocations, ...stackLocations],
      MAX_LOCATIONS_PER_EVIDENCE
    );
    if (merged.length > 0) {
      evidenceLocations[item.id] = merged.map(stripScore);
    }

    aggregatedStackLocations.push(...stackLocations);
  }

  const affectedAreaLocation = resolveAffectedArea(
    input.diagnosis.affectedArea,
    ctx
  );

  const stackLocations = dedupeAndRank(
    aggregatedStackLocations,
    MAX_STACK_LOCATIONS
  ).map(stripScore);

  const enrichment: RepoEnrichmentInput = {
    repoFullName: ctx.repoFullName,
    ref: ctx.ref,
  };
  if (Object.keys(evidenceLocations).length > 0) {
    enrichment.evidenceLocations = evidenceLocations;
  }
  if (affectedAreaLocation) {
    enrichment.affectedAreaLocation = affectedAreaLocation;
  }
  if (stackLocations.length > 0) {
    enrichment.stackLocations = stackLocations;
  }
  return enrichment;
}

// ---------------------------------------------------------------------------
// Hint extraction (pure, no resolver calls)
// ---------------------------------------------------------------------------

export type EvidenceHints = {
  /// Strings that look like file paths (possibly with `:line`). Fed to the
  /// path resolver as-is; the resolver recognises `path:line:col`.
  pathHints: string[];
  /// Strings containing identifier-like tokens (service names, function
  /// names, classes). Fed to the symbol resolver.
  symbolHints: string[];
  /// Stack-frame locations specifically — separated because they're also
  /// aggregated into the packet's top-level `repoContext.stackLocations`.
  stackHints: string[];
};

export function extractEvidenceHints(
  evidence: EvidenceViewModel
): EvidenceHints {
  const pathHints = new Set<string>();
  const symbolHints = new Set<string>();
  const stackHints = new Set<string>();

  const extracted = (evidence.extracted ?? null) as Record<string, unknown> | null;

  // 1. Stack frames — the strongest signal. Extract the `(path:line:col)`
  //    tail (or bare `path:line` form) from each frame and preserve the
  //    function name separately as a symbol hint.
  for (const raw of collectStackFrameStrings(extracted)) {
    for (const loc of extractStackFrameLocations(raw)) {
      stackHints.add(loc);
    }
    const func = extractStackFrameFunction(raw);
    if (func) symbolHints.add(func);
  }

  // 2. Services extracted by evidence parsing — already clean identifiers.
  for (const service of arrayOfStrings(extracted?.services)) {
    symbolHints.add(service);
  }

  // 3. Free-text path references inside the summary / excerpt / screenshot
  //    text. These catch "see src/lib/foo.ts" style notes.
  const bodyText = [
    evidence.summary ?? "",
    typeof extracted?.screenshotText === "string"
      ? (extracted.screenshotText as string)
      : "",
    evidence.rawText ?? evidence.redactedText ?? "",
  ].join("\n");
  for (const pathHint of extractPathsFromText(bodyText)) {
    pathHints.add(pathHint);
  }

  // 4. The evidence summary itself as a symbol query — the resolver tokenises
  //    internally and filters stopwords. Useful for notes like
  //    "CheckoutService returned 500".
  if (evidence.summary && evidence.summary.trim().length > 0) {
    symbolHints.add(evidence.summary);
  }

  return {
    pathHints: [...pathHints],
    symbolHints: [...symbolHints],
    stackHints: [...stackHints],
  };
}

function arrayOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

function collectStackFrameStrings(
  extracted: Record<string, unknown> | null
): string[] {
  if (!extracted) return [];
  const frames = extracted.stackFrames;
  if (!Array.isArray(frames)) return [];
  return frames
    .map((frame) => {
      if (typeof frame === "string") return frame;
      if (
        frame &&
        typeof frame === "object" &&
        "raw" in frame &&
        typeof (frame as { raw: unknown }).raw === "string"
      ) {
        return (frame as { raw: string }).raw;
      }
      return null;
    })
    .filter((s): s is string => typeof s === "string" && s.trim().length > 0);
}

function extractStackFrameLocations(frame: string): string[] {
  const out = new Set<string>();
  for (const match of frame.matchAll(STACK_FRAME_PAREN_LOC_REGEX)) {
    if (match[1]) out.add(match[1].trim());
  }
  for (const match of frame.matchAll(STACK_FRAME_BARE_LOC_REGEX)) {
    if (match[1]) out.add(match[1].trim());
  }
  return [...out];
}

function extractStackFrameFunction(frame: string): string | null {
  // Matches `at Foo.bar (` or `at <anonymous> (` — returns the function id
  // (or null if it's `<anonymous>` / missing).
  const match = frame.match(/\bat\s+([A-Za-z_$][\w$.]*)\b/);
  if (!match) return null;
  const name = match[1];
  if (name === "anonymous" || name === "async") return null;
  return name;
}

export function extractPathsFromText(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const match of text.matchAll(PATH_IN_TEXT_REGEX)) {
    const candidate = match[1];
    if (!candidate) continue;
    // Skip URLs — http(s) fragments are caught by the generic path regex if
    // we don't guard. The regex uses a `(?<![\w/])` lookbehind so `://` is
    // excluded already, but a second belt-and-braces check: reject tokens
    // preceded immediately by `://` in the original text.
    const idx = match.index ?? -1;
    if (idx >= 3 && text.slice(idx - 3, idx) === "://") continue;
    out.add(candidate);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Scoring + merging
// ---------------------------------------------------------------------------

type ScoredLocation = RepoLocation & { __score: number };

function scorePathHint(hint: string, ctx: EnrichmentContext): ScoredLocation[] {
  const candidates = ctx.resolvePath(hint, { limit: 3 });
  return candidates
    .filter((c) => c.score >= MIN_LOCATION_SCORE)
    .map((c) => ({
      file: c.path,
      ...(typeof c.line === "number" ? { line: c.line } : {}),
      __score: c.score,
    }));
}

function scoreSymbolHint(
  query: string,
  ctx: EnrichmentContext
): ScoredLocation[] {
  const candidates = ctx.resolveSymbol(query, { limit: 3 });
  return candidates
    .filter((c) => c.score >= MIN_LOCATION_SCORE)
    .map((c) => ({
      file: c.filePath,
      line: c.line,
      __score: c.score,
    }));
}

function resolveAffectedArea(
  area: string | null | undefined,
  ctx: EnrichmentContext
): RepoLocation | undefined {
  if (!area || area.trim().length === 0) return undefined;
  const pathCandidates = scorePathHint(area, ctx);
  const symbolCandidates = scoreSymbolHint(area, ctx);
  const merged = dedupeAndRank(
    [...pathCandidates, ...symbolCandidates],
    MAX_AFFECTED_AREA_CANDIDATES
  );
  return merged[0] ? stripScore(merged[0]) : undefined;
}

function dedupeAndRank(
  candidates: ScoredLocation[],
  limit: number
): ScoredLocation[] {
  const best = new Map<string, ScoredLocation>();
  for (const candidate of candidates) {
    const key = `${candidate.file}#${candidate.line ?? ""}`;
    const existing = best.get(key);
    if (!existing || existing.__score < candidate.__score) {
      best.set(key, candidate);
    }
  }
  return [...best.values()]
    .sort((a, b) => {
      if (b.__score !== a.__score) return b.__score - a.__score;
      // Tie break: shorter paths first (more likely the canonical location),
      // then lexical for determinism.
      if (a.file.length !== b.file.length) return a.file.length - b.file.length;
      return a.file.localeCompare(b.file);
    })
    .slice(0, limit);
}

function stripScore(location: ScoredLocation): RepoLocation {
  const out: RepoLocation = { file: location.file };
  if (typeof location.line === "number") out.line = location.line;
  if (location.excerpt !== undefined) out.excerpt = location.excerpt;
  if (location.blame !== undefined) out.blame = location.blame;
  return out;
}
