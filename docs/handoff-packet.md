# TARG Handoff Packet — v1.0

> **Status:** draft, authoritative.
> **Owner:** product + eng.
> **Scope:** defines the artifact TARG produces at the end of every case, and the rules
> for rendering it into each handoff target (Cursor, Claude Code, Codex, GitHub, Linear,
> plain Markdown).
> **North-star rule:** if a change doesn't make the Handoff Packet better for an agent to
> act on, it doesn't belong in TARG.

---

## 1. Purpose

The Handoff Packet is the **only output of TARG that matters externally**. Everything
TARG does — evidence ingestion, diagnosis, classification, decomposition, work-bundling —
exists to produce one of these.

A Handoff Packet is consumed by one of two kinds of receiver:

1. **An AI coding agent** (Cursor, Claude Code, Codex, Copilot Workspaces, Gemini CLI…)
   that will read it as a prompt and either investigate or implement.
2. **A human collaborator** (engineer, EM, on-call) via a ticket (GitHub, Linear, Jira)
   or a raw Markdown paste.

In both cases, the packet must be **self-contained**: the receiver should never need to
open TARG to understand or act on it.

### 1.1 What "good" looks like

A good packet lets a competent receiver:

- **Restate the problem** in one sentence after reading the first section.
- **Locate the failure** (file, service, endpoint, or UI surface) within 15 seconds.
- **Decide** whether to fix, investigate, or reject as insufficient — without guessing.
- **Act** (write a PR, run a repro, open a follow-up) without asking TARG a clarifying
  question.

If any of those four things fails on a real case, the packet is wrong.

---

## 2. Design principles

These are non-negotiable. If a future change violates one of them, the change is wrong.

1. **Grounded before clever.** Every non-trivial claim must be tied to a specific
   piece of evidence, a repo location, or an explicit hypothesis label. No floating
   assertions.
2. **Calibrated, not coded.** Uncertainty is communicated in plain English, not in
   TARG's internal vocabulary. `confidence: unclear` becomes "Confidence: low — treat
   below as hypothesis, not conclusion."
3. **Best guess always.** Even at low confidence, the packet commits to a best current
   read. Users and agents cannot act on *"I don't know, go collect more evidence."*
4. **One source of truth, many renderings.** The packet is a typed data structure
   (`HandoffPacket`). Each target has a renderer; targets do not fork the data.
5. **Self-contained.** The receiver never needs TARG to act on the packet. Back-links
   are included for traceability but are never on the critical path.
6. **Budgeted.** Every target has a size budget. The packet has a defined truncation
   order so it degrades gracefully instead of exploding.
7. **No internal chrome.** Enum names, CUID identifiers, taxonomy labels, run IDs, and
   any vocabulary that only makes sense inside TARG do not leak into the packet.
8. **Versioned.** Every packet declares its schema version. Old renderings must remain
   parseable.

---

## 3. Receivers ("targets")

The v1 targets and their role:

| Target ID        | Kind          | Primary use                                             | Size budget |
| ---------------- | ------------- | ------------------------------------------------------- | ----------- |
| `cursor`         | Deep link     | Open in Cursor with the packet as prompt                | 6 KB URL    |
| `claude_code`    | Copy payload  | Paste as a Claude Code `/task` prompt                   | 8k tokens   |
| `codex`          | Copy payload  | Paste into Codex CLI or web                             | 8k tokens   |
| `copilot_ws`     | Copy payload  | Paste into GitHub Copilot Workspaces task description   | 8k tokens   |
| `github_issue`   | API dispatch  | Create an issue in the workspace's connected repo       | 65 KB body  |
| `linear_issue`   | API dispatch  | Create an issue in the workspace's connected Linear     | 65 KB body  |
| `markdown`       | Clipboard     | Paste anywhere (Slack, PRs, docs)                       | unbounded   |

All targets are rendered from the same `HandoffPacket` source. Per-target deltas are
defined in §7.

---

## 4. Versioning

- Each packet carries a top-level `schemaVersion` (integer) and `format: "targ.handoff"`.
- This spec defines **`schemaVersion: 1`**.
- Breaking changes bump the major version and keep the prior renderer live for one
  release cycle.
- Additive fields (new optional keys) are allowed within a major version and do not bump.

---

## 5. The HandoffPacket data model

The packet is a typed object. This is the source of truth; renderers consume it.

```ts
export type HandoffPacket = {
  schemaVersion: 1;
  format: "targ.handoff";

  meta: {
    caseId: string;              // TARG case id (for back-link only)
    caseUrl: string;             // Absolute URL to the case in TARG
    generatedAt: string;         // ISO 8601
    generatorVersion: string;    // TARG version that produced this
  };

  problem: {
    title: string;               // 1 line, <=120 chars
    statement: string;           // User problem statement, lightly cleaned. 1–3 sentences.
    severity?: "low" | "medium" | "high" | "critical";
    tags?: string[];             // e.g. ["regression", "checkout", "production"]
  };

  read: {
    headline: string;            // "Best current read" in one sentence, <=240 chars.
    confidence: "high" | "medium" | "low";   // Translated from TARG enums (§8).
    confidenceNote?: string;     // One sentence explaining why, e.g. "two contradictory logs".
    affectedArea: {
      label: string;             // Human label: "submitCheckout in /srv/checkout.js"
      repoLocation?: RepoLocation; // Present when Phase 5 resolution succeeded.
      service?: string;
      endpoint?: string;
      surface?: string;          // UI surface if applicable
    };
  };

  evidence: EvidenceItem[];      // Ordered by relevance; see §5.1

  hypotheses: Hypothesis[];      // At least 1, at most 3 in the rendered packet

  openQuestions: string[];       // Concrete, answerable. No generic "add more logs".

  nextStep: {
    mode: "implement" | "investigate" | "collect_evidence";
    instruction: string;         // Imperative sentence aimed at the receiver.
    acceptanceCriteria: string[];// Observable outcomes that mean "done"
  };

  // Optional: only when Phase 5 (repo) is active.
  repoContext?: {
    repoFullName: string;        // "org/repo"
    ref: string;                 // commit sha or branch used for resolution
    stackLocations?: RepoLocation[];
    suspectedRegressions?: CommitRef[];
  };

  // Optional: only when Phase 7 (team memory) is active.
  priors?: PriorCase[];

  // Carried forward for agent use; not always rendered.
  policy: {
    mayCommit: boolean;          // false when confidence < medium, see §8
    mayOpenPr: boolean;          // false when mode != "implement"
    evidenceBasedOnly: boolean;  // true — agents must not invent new evidence
  };
};

export type EvidenceItem = {
  id: string;                    // Stable within a packet; used by claim refs
  kind: "log" | "terminal" | "error_text" | "screenshot" | "note" | "code";
  source: "upload" | "paste" | "manual_note";
  name: string;
  summary: string;               // <=180 chars; written by TARG, grounded in the text
  excerpt?: string;              // Redacted, clipped text (<=1200 chars in packet)
  screenshotText?: string;       // When OCR ran
  extracted?: {
    services?: string[];
    endpoints?: string[];
    timestamps?: string[];
    requestIds?: string[];
    stackFrames?: string[];      // Raw lines, max 20
  };
};

export type Hypothesis = {
  title: string;                 // <=120 chars
  reasoning: string;             // <=400 chars. "Because X in evidence[n], therefore Y."
  confidence: "high" | "medium" | "low";
  supportingEvidenceIds: string[];
  weakenedByEvidenceIds?: string[];
};

export type RepoLocation = {
  file: string;                  // Repo-relative path
  line?: number;
  excerpt?: string;              // ±5 lines around `line`
  blame?: {
    author: string;
    commitSha: string;
    commitMessage: string;
    prNumber?: number;
    date: string;                // ISO 8601
  };
};

export type CommitRef = {
  sha: string;
  message: string;
  author: string;
  date: string;
  prNumber?: number;
  url?: string;
  touchedFiles: string[];
};

export type PriorCase = {
  caseId: string;
  title: string;
  similarity: number;            // 0..1
  resolutionRootCause: string;
  resolutionSummary: string;
  resolvedAt: string;            // ISO 8601
};
```

### 5.1 Evidence ordering rule

Evidence in the packet is ordered by **how much each item shifted the diagnosis**,
not by upload order. Concretely:

1. Items referenced in `hypotheses[*].supportingEvidenceIds` first.
2. Then items referenced in `hypotheses[*].weakenedByEvidenceIds`.
3. Then items with non-empty `extracted.stackFrames`.
4. Then the rest, newest first.

Deduplicate by `id`. Never include an item that isn't referenced by *something* in the
packet — if evidence didn't influence the read, it doesn't belong in the handoff.

---

## 6. Canonical Markdown rendering

Every target's rendering is derived from this canonical Markdown form. If a target has
no special rule (§7), this is what it ships.

The canonical form has **exactly these top-level sections, in this order**:

```markdown
# <problem.title>

<problem.statement>

_Case: [<meta.caseId>](<meta.caseUrl>) · generated <meta.generatedAt>_

## Best current read

<read.headline>

**Confidence:** <read.confidence>. <read.confidenceNote>

**Affected area:** <read.affectedArea.label>
<if repoLocation: "→ `<file>:<line>`">

## Evidence

1. **<evidence[0].name>** (<evidence[0].kind>, <evidence[0].source>)
   <evidence[0].summary>
   ```
   <evidence[0].excerpt or screenshotText, clipped>
   ```
2. ...

## Hypotheses

1. **<hypotheses[0].title>** — confidence: <…>
   <hypotheses[0].reasoning>
   Supports: evidence #<supportingEvidenceIds rendered as numeric refs>
2. ...

## Open questions

- <openQuestions[0]>
- ...

## Next step

**<nextStep.mode>:** <nextStep.instruction>

**Done when:**
- <acceptanceCriteria[0]>
- ...

## Repo context
<optional — only present when repoContext is set>

- `<stackLocations[0].file>:<line>` — last changed in
  <blame.prNumber ? "#<prNumber>" : "commit <sha[:7]>"> by @<author>,
  <relative date>: "<commitMessage, clipped>"
- Suspected recent regressions touching this path:
  - #<pr> by @<author>: "<message>"

## Seen before
<optional — only present when priors is non-empty>

- **<priors[0].title>** (<similarity*100>% similar)
  Root cause: <resolutionRootCause>
  Fix: <resolutionSummary>
```

### 6.1 Rendering rules

- Section headers are fixed. Do not translate them. Do not add emoji.
- Omit entire optional sections when their source is empty. Never render an empty
  section header.
- Evidence is numbered; hypotheses reference evidence as `#1`, `#2`, etc. Never reference
  evidence by UUID in the rendered packet.
- All Markdown is plain: no HTML, no custom containers, no footnotes.
- Line length: wrap hard at **100 chars** for readability in clipboard targets.
- Code fences are triple-backtick with no language tag (receivers often render neutral
  blocks better than syntax-highlighted ones for mixed content).

---

## 7. Per-target renderings

**Canonical Markdown** is always `renderPacketMarkdown(packet)` (§6). Agent-facing targets
may add **three kinds of delta** before/after that body: (1) optional preamble, (2) optional
`## Where to start` (Phase 3.0), (3) mandatory `## Instructions for the agent` where listed.
Human-facing and clipboard-canonical targets (`markdown`, issue dispatch) use **only** the
canonical Markdown (plus ticket preambles in §7.5–§7.6), with no Where-to-start block and no
agent-instructions block.

### 7.0 `## Where to start` (Phase 3.0)

When `repoContext` supplies enough structure (stack locations, blame, suspected regressions,
`likelyCulprit` / `coCulprits`), the renderer may emit a short section **`## Where to start`**
so coding agents open the right `path:line` before reading the rest of the packet.

- **Placement** is immediately **before** the canonical Markdown (after any one-line preamble
  for `cursor` only). GitHub blob links use `owner/repo` + `ref` from `repoContext`; bullets
  list likely culprit / co-culprit targets first when those fields resolve, else stack or
  affected-area fallbacks.
- **Omitted** when no jump target resolves (empty section — the deep link still carries the
  preamble + canonical packet + instructions).
- **Implementation:** `src/lib/handoff/agent-jump-targets.ts` (`renderWhereToStartSection`).
- **Included** for: `cursor`, `claude_code`, `codex`, `copilot_ws`.
- **Not included** for: `markdown`, `github_issue`, `linear_issue` (canonical body only for
  tickets; no agent-instruction block either).

### 7.1 `cursor`

- Output: deep link `cursor://anysphere.cursor-deeplink/prompt?text=<urlencoded>`.
- Prepend a single line **before** the optional `## Where to start` block and the canonical text:
  `You are triaging a bug via TARG. Use the packet below; do not invent evidence.`
- Then the optional **`## Where to start`** section (§7.0), then the canonical Markdown, then
  **`## Instructions for the agent`**:
  `- Read before writing. Do not modify files until you can name the failing boundary.`
  `- If confidence is low, investigate only — do not commit.`
  `- Cite evidence by its number (e.g., "from #2") when you reason.`

### 7.2 `claude_code`

- Output: plain text copy payload.
- Wrap **optional `## Where to start`** (§7.0) **plus** the canonical Markdown inside a single
  `<targ_handoff>` XML-style tag (Where-to-start first when present). Claude treats wrapped
  context more reliably than raw prose.
- Append the same `## Instructions for the agent` block as §7.1, **outside** the XML wrapper
  (after `</targ_handoff>`), same as today.

### 7.3 `codex`

- Output: plain text copy payload.
- Prepend `# Task` as the first line, then **optional `## Where to start`** (§7.0), then the
  canonical text with `# ` replaced by `## ` in the first heading (Codex expects one top-level
  heading).
- Append the same agent-instructions block.

### 7.4 `copilot_ws`

- Output: plain text copy payload.
- No wrapper tags. **Optional `## Where to start`** (§7.0), then canonical Markdown as-is.
- Append the agent-instructions block.

### 7.5 `github_issue`

- Output: API dispatch to the workspace's connected repo.
- Title = `problem.title` (GitHub limit 256 chars; clip with ellipsis).
- Body = canonical Markdown **without the agent-instructions block** (it's a human
  ticket).
- Prepend a YAML frontmatter-free preamble:
  ```
  > Generated by TARG · [open case](<meta.caseUrl>)
  ```
- Labels: merge TARG-derived labels (`severity/<x>`, `confidence/<x>`, `kind/bug`) with
  `problem.tags`. Create missing labels on first dispatch (idempotent).
- Body never contains secrets (evidence excerpts are already redacted, but double-check
  `[REDACTED_SECRET]` tokens are preserved, not collapsed).

### 7.6 `linear_issue`

- Output: API dispatch via Linear GraphQL.
- Title = `problem.title`.
- Description = canonical Markdown without the agent-instructions block.
- Priority: `critical` → 1, `high` → 2, `medium` → 3, `low` → 4, none → 0.
- Labels: same as §7.5.

### 7.7 `markdown`

- Output: canonical Markdown, unchanged. Copied to clipboard.

---

## 8. Confidence translation

TARG's internal enums must be translated for external consumption. This is the only
sanctioned mapping.

| TARG internal                                                  | Packet `read.confidence` | Packet `policy.mayCommit` |
| -------------------------------------------------------------- | ------------------------ | ------------------------- |
| `CaseConfidence.LIKELY` + `DiagnosisNextActionMode.FIX`        | `high`                   | `true`                    |
| `CaseConfidence.LIKELY` + `VERIFY`                             | `high`                   | `false`                   |
| `CaseConfidence.PLAUSIBLE` (any next action)                   | `medium`                 | `false`                   |
| `CaseConfidence.UNCLEAR` (any next action)                     | `low`                    | `false`                   |

`nextStep.mode` translation:

| Next action mode                  | Packet `nextStep.mode` |
| --------------------------------- | ---------------------- |
| `FIX` + confidence `LIKELY`       | `implement`            |
| `FIX` + confidence below `LIKELY` | `investigate` (verifier should have downgraded this — guard at render) |
| `VERIFY`                          | `investigate`          |
| `REQUEST_INPUT`                   | `collect_evidence`     |

**Guard:** if the rendered `nextStep.mode` would be `implement` but `policy.mayCommit`
is `false`, the renderer throws. This is the only render-time assertion; it protects
against verifier bugs leaking through.

---

## 9. Invariants

Every packet must satisfy these before rendering. Failing invariants block the handoff
and are reported to the user as "TARG refused to produce a packet because …".

1. `evidence` contains no item whose `id` isn't real in the TARG database for this case.
   (Fixes the hallucinated-evidence-id hole.)
2. Every `hypothesis.supportingEvidenceIds[n]` and `weakenedByEvidenceIds[n]` resolves
   to an item in the packet's `evidence` array. No dangling references.
3. `nextStep.acceptanceCriteria` is non-empty. If TARG can't articulate "done when,"
   the packet is not ready.
4. `read.headline` is non-empty, regardless of confidence.
5. `policy.mayCommit === true` implies `read.confidence === "high"` AND
   `nextStep.mode === "implement"`.
6. No section text contains unredacted secrets. Runtime check: no substring matches
   the redaction patterns from `src/lib/evidence/parser.ts::redactSecrets`.
7. `meta.caseUrl` is absolute and resolvable.
8. Total packet Markdown size is within the target's budget after truncation (§10).

Invariants are enforced in `src/lib/handoff/packet.ts::assertPacketValid`, run
before any renderer is invoked.

---

## 10. Size budget and truncation

Truncation happens on the `HandoffPacket` object before rendering, in this order, until
the rendered target fits its budget:

1. Clip each `evidence[i].excerpt` to 800 chars, then 400, then 200.
2. Drop `evidence[i].excerpt` entirely for items beyond the top 5 (keep `summary`).
3. Drop `hypotheses` beyond the top 3.
4. Drop `priors` beyond the top 2.
5. Drop `repoContext.suspectedRegressions` beyond the top 3.
6. Drop `evidence` items beyond the top 5 (keep references they produced).
7. Drop `openQuestions` beyond the top 3.
8. If still over budget, replace the full packet with the "minimal packet" (§10.1) and
   append a "See full case" back-link.

At every step, the packet must still satisfy §9. If truncation would break an invariant
(e.g. a hypothesis referencing dropped evidence), the step is skipped and the next step
is tried.

### 10.1 Minimal packet

The fallback when a full packet won't fit a target's budget. Contains:

- `problem.title`
- `problem.statement`
- `read.headline`
- `read.confidence` + note
- `read.affectedArea.label`
- Top hypothesis (title + one-line reasoning)
- `nextStep.mode` + `nextStep.instruction`
- `meta.caseUrl`

Everything else is omitted. This fits comfortably in a Cursor deep link (< 2 KB) and
always leaves room for the receiver's own prompt space.

---

## 11. Mapping to TARG models

Which Prisma/view-model field feeds which packet field. The renderer depends on exactly
this mapping; any migration that renames a field must update `src/lib/handoff/packet.ts`
in the same change.

| Packet field                           | TARG source                                                             |
| -------------------------------------- | ----------------------------------------------------------------------- |
| `meta.caseId`                          | `TargCase.id`                                                           |
| `meta.caseUrl`                         | `${APP_URL}/cases/${TargCase.id}`                                       |
| `problem.title`                        | `TargCase.title`                                                        |
| `problem.statement`                    | `TargCase.userProblemStatement`                                         |
| `problem.severity`                     | `TargCase.severity` (lowercased)                                        |
| `problem.tags`                         | Derived: `[problemLens, solveMode, …extractedEnvHints]`                 |
| `read.headline`                        | `TargDiagnosisSnapshot.summary` (first sentence)                        |
| `read.confidence`                      | §8 translation of `TargDiagnosisSnapshot.confidence`                    |
| `read.confidenceNote`                  | `TargDiagnosisSnapshot.contradictions[0]` if any, else derived          |
| `read.affectedArea.label`              | `TargDiagnosisSnapshot.affectedArea`                                    |
| `read.affectedArea.repoLocation`       | Phase 5: first `extracted.stackLocations[0]` on a READY evidence        |
| `evidence[].*`                         | `TargEvidence` rows filtered/ordered by §5.1                            |
| `hypotheses[].*`                       | `TargDiagnosisSnapshot.hypotheses` (top 3), joined to `claimReferences` |
| `openQuestions`                        | `TargDiagnosisSnapshot.missingEvidence` (rewritten as questions)        |
| `nextStep.mode`                        | §8 translation of `TargDiagnosisSnapshot.nextActionMode`                |
| `nextStep.instruction`                 | `TargDiagnosisSnapshot.nextActionText`                                  |
| `nextStep.acceptanceCriteria`          | Phase 6: LLM-generated; Phase 1: derived from affected area + mode      |
| `repoContext.*`                        | Phase 5: from resolver + blame + recent-commits modules                 |
| `priors`                               | Phase 7: top-N from `TargCaseEmbedding` similarity search               |
| `policy.mayCommit` / `mayOpenPr`       | §8 table                                                                |

---

## 12. What the packet does NOT include

Called out explicitly because reviewers keep proposing these.

- **TARG IDs as prose.** `analysisRunId`, `workBundleId`, `breakdownId`, `snapshotId`
  never appear in rendered output. They're metadata at most.
- **TARG enums as labels.** `QUICK_PATCH`, `UX_UI`, `DOCTRINE`, `REQUEST_INPUT`,
  `NEEDS_REVIEW` never appear. They are translated (§8) or hidden.
- **Pipeline stage names.** `understand`, `diagnosis_snapshot`, `verify_bundle` are
  TARG-internal concepts. Receivers don't need them.
- **Evidence that didn't influence the read.** If it's not referenced by a hypothesis
  or the affected area, it's noise.
- **Contradictions repeated three times.** One canonical mention in `confidenceNote`,
  plus per-hypothesis `weakenedByEvidenceIds`. Do not also add a standalone
  "## Contradictions" section.
- **Marketing.** "Generated by TARG with confidence-calibrated grounded reasoning…"
  No. One line back-link in the preamble, nothing else.

---

## 13. Worked example

A realistic rendering of the seeded golden case
`evals/golden/cases/obvious_bug_checkout_fix.json`, after Phase 5 has resolved the stack.

```markdown
# Checkout API throws a clear runtime error

Checkout fails consistently after submit and the logs point at one API boundary.

_Case: [c_4xk2mzq8](https://targ.app/cases/c_4xk2mzq8) · generated 2026-04-20T14:22:11Z_

## Best current read

An unhandled error in `submitCheckout` is surfacing as a 500 on every POST to
`/api/checkout`.

**Confidence:** high. Two independent log lines point at the same stack frame with no
conflicting signal.

**Affected area:** `submitCheckout` in `/srv/checkout.js:44` → `src/srv/checkout.js:44`

## Evidence

1. **api-log-a** (log, paste)
   500 on GET /api/checkout with an explicit "payment failed" error thrown from
   submitCheckout at line 44.
   ```
   2026-04-09T00:00:00Z service=api requestId=req-500 GET /api/checkout
   Error: payment failed
       at submitCheckout (/srv/checkout.js:44:9)
   ```
2. **api-terminal-b** (terminal, paste)
   A retry of the same request hits the same frame, confirming it is not transient.
   ```
   2026-04-09T00:00:01Z service=api requestId=req-500 retry checkout
       at submitCheckout (/srv/checkout.js:44:9)
   ```

## Hypotheses

1. **`submitCheckout` rethrows a payment-provider error without handling it** —
   confidence: high
   Both evidence #1 and #2 terminate at the same frame; the message "payment failed"
   suggests the provider's error path reaches user-facing 500s unmodified.
   Supports: #1, #2

2. **Retry logic re-enters the failing path without backoff** — confidence: medium
   The retry in #2 lands on the same frame one second later, which implies no meaningful
   isolation between attempts.
   Supports: #2

## Open questions

- Is `submitCheckout` wrapped in a try/catch that swallows the provider error elsewhere,
  or is this the only surface where it is caught?
- Does the payment provider return a structured error code that the client could branch
  on, or only a message string?

## Next step

**implement:** Add error handling around the payment call in `submitCheckout` so
provider failures surface as a 4xx with a structured reason instead of a 500, and make
retries observe at least one backoff cycle.

**Done when:**
- A failing payment returns a 4xx with a stable error code to the client.
- A retry loop does not re-enter the failing frame within the same request cycle.
- Existing tests still pass; a new test covers the 4xx path.

## Repo context

- `src/srv/checkout.js:44` — last changed in #1892 by @luca, 3 days ago:
  "refactor retry loop to share provider client"
- Suspected recent regressions touching this path:
  - #1892 by @luca: "refactor retry loop to share provider client"
  - #1877 by @maria: "bump payments-sdk to 4.2.1"

## Seen before

- **Checkout 500 after payments-sdk bump** (78% similar)
  Root cause: payments-sdk 4.2.0 → 4.2.1 changed the shape of the provider error object.
  Fix: unwrapped `err.cause.code` in `submitCheckout` and mapped to internal code.
```

With the Cursor agent-instructions block appended, this packet fits well under 4 KB.

---

## 14. Evolution policy

- Additive changes (new optional fields, new targets) are allowed without a version bump
  as long as renderers tolerate missing fields.
- Renames, removals, or semantic changes bump `schemaVersion`.
- Any change to §8 (confidence translation) requires a review note in this doc plus
  updated test cases in `src/lib/handoff/packet.test.ts`.
- New targets must be added to §3 and §7 before any code ships.
- If two targets end up needing the same delta, promote it to canonical (§6) instead
  of duplicating.

---

## 15. Checklist — "is this change packet-worthy?"

Before merging any change to TARG, ask:

- [ ] Does it make the packet more grounded, more specific, or cheaper to produce?
- [ ] Or does it expand the set of targets that can consume the packet?
- [ ] Or does it tighten an invariant in §9?

If the answer to all three is no, reconsider.
