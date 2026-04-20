/**
 * Canonical Markdown renderer for the Handoff Packet.
 *
 * Source of truth: docs/handoff-packet.md §6. Other targets (Cursor, Claude Code,
 * Codex, GitHub, Linear) derive from this output plus per-target deltas (§7).
 *
 * Rendering rules (§6.1):
 *   - Section headers are fixed. No translation, no emoji.
 *   - Empty optional sections are omitted — never rendered with empty bodies.
 *   - Evidence is numbered; hypotheses reference evidence by index, not UUID.
 *   - Lines are wrapped hard at 100 chars where it does not corrupt content.
 *   - Code fences use triple backticks with no language tag.
 */

import type {
  HandoffEvidenceItem,
  HandoffHypothesis,
  HandoffPacket,
  RepoLocation,
} from "@/lib/handoff/packet";

const LINE_WRAP = 100;

function wrap(paragraph: string): string {
  const compact = paragraph.replace(/\s+/g, " ").trim();
  if (compact.length <= LINE_WRAP) return compact;

  const words = compact.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const tentative = current ? `${current} ${word}` : word;
    if (tentative.length > LINE_WRAP && current) {
      lines.push(current);
      current = word;
    } else {
      current = tentative;
    }
  }
  if (current) lines.push(current);
  return lines.join("\n");
}

function formatBullet(value: string, continuationIndent = "  "): string {
  const wrapped = wrap(value);
  const [first, ...rest] = wrapped.split("\n");
  const tail = rest.length > 0
    ? `\n${rest.map((line) => `${continuationIndent}${line}`).join("\n")}`
    : "";
  return `- ${first}${tail}`;
}

function evidenceIndexMap(packet: HandoffPacket): Map<string, number> {
  const map = new Map<string, number>();
  packet.evidence.forEach((item, index) => map.set(item.id, index + 1));
  return map;
}

function renderPreamble(packet: HandoffPacket): string {
  const title = `# ${packet.problem.title}`;
  const statement = wrap(packet.problem.statement);
  const meta = `_Case: [${packet.meta.caseId}](${packet.meta.caseUrl}) · generated ${packet.meta.generatedAt}_`;
  return [title, "", statement, "", meta].join("\n");
}

function renderBestRead(packet: HandoffPacket): string {
  const lines: string[] = ["## Best current read", "", wrap(packet.read.headline)];

  const confidenceLine = packet.read.confidenceNote
    ? `**Confidence:** ${packet.read.confidence}. ${packet.read.confidenceNote}`
    : `**Confidence:** ${packet.read.confidence}.`;
  lines.push("", wrap(confidenceLine));

  const area = packet.read.affectedArea;
  const areaLineParts = [`**Affected area:** ${area.label}`];
  if (area.repoLocation) {
    const loc = formatRepoLocationInline(area.repoLocation);
    if (loc) areaLineParts.push(`→ \`${loc}\``);
  }
  lines.push("", wrap(areaLineParts.join(" ")));

  return lines.join("\n");
}

function formatRepoLocationInline(location: RepoLocation): string {
  return typeof location.line === "number"
    ? `${location.file}:${location.line}`
    : location.file;
}

function renderEvidence(
  packet: HandoffPacket,
  indexMap: Map<string, number>
): string {
  if (packet.evidence.length === 0) return "";

  const items = packet.evidence.map((item) => renderEvidenceItem(item, indexMap));
  return ["## Evidence", "", items.join("\n\n")].join("\n");
}

function renderEvidenceItem(
  item: HandoffEvidenceItem,
  indexMap: Map<string, number>
): string {
  const index = indexMap.get(item.id) ?? 0;
  const header = `${index}. **${item.name}** (${item.kind}, ${item.source})`;
  const summary = wrap(item.summary)
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");

  const body = item.excerpt ?? item.screenshotText;
  if (!body) return `${header}\n${summary}`;

  const fencedBody = body
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");
  return `${header}\n${summary}\n   \`\`\`\n${fencedBody}\n   \`\`\``;
}

function renderHypotheses(
  packet: HandoffPacket,
  indexMap: Map<string, number>
): string {
  if (packet.hypotheses.length === 0) return "";

  const items = packet.hypotheses.map((hypothesis, index) =>
    renderHypothesisItem(hypothesis, index + 1, indexMap)
  );
  return ["## Hypotheses", "", items.join("\n\n")].join("\n");
}

function renderHypothesisItem(
  hypothesis: HandoffHypothesis,
  ordinal: number,
  indexMap: Map<string, number>
): string {
  const header = `${ordinal}. **${hypothesis.title}** — confidence: ${hypothesis.confidence}`;
  const reasoning = wrap(hypothesis.reasoning)
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");

  const trailingLines: string[] = [];
  const supports = hypothesis.supportingEvidenceIds
    .map((id) => indexMap.get(id))
    .filter((n): n is number => typeof n === "number");
  if (supports.length > 0) {
    trailingLines.push(`   Supports: ${supports.map((n) => `#${n}`).join(", ")}`);
  }
  const weakens = (hypothesis.weakenedByEvidenceIds ?? [])
    .map((id) => indexMap.get(id))
    .filter((n): n is number => typeof n === "number");
  if (weakens.length > 0) {
    trailingLines.push(
      `   Weakened by: ${weakens.map((n) => `#${n}`).join(", ")}`
    );
  }

  return [header, reasoning, ...trailingLines].join("\n");
}

function renderOpenQuestions(packet: HandoffPacket): string {
  if (packet.openQuestions.length === 0) return "";
  const bullets = packet.openQuestions.map((q) => formatBullet(q));
  return ["## Open questions", "", bullets.join("\n")].join("\n");
}

function renderNextStep(packet: HandoffPacket): string {
  const header = `**${packet.nextStep.mode}:** ${packet.nextStep.instruction}`;
  const criteria = packet.nextStep.acceptanceCriteria
    .map((line) => formatBullet(line))
    .join("\n");
  return [
    "## Next step",
    "",
    wrap(header),
    "",
    "**Done when:**",
    criteria,
  ].join("\n");
}

function renderRepoContext(packet: HandoffPacket): string {
  const ctx = packet.repoContext;
  if (!ctx) return "";

  const lines: string[] = [];
  if (ctx.stackLocations && ctx.stackLocations.length > 0) {
    for (const location of ctx.stackLocations) {
      lines.push(formatBullet(formatRepoLocationBullet(location)));
    }
  }
  if (ctx.suspectedRegressions && ctx.suspectedRegressions.length > 0) {
    lines.push("- Suspected recent regressions touching this path:");
    for (const commit of ctx.suspectedRegressions) {
      const pr = commit.prNumber ? `#${commit.prNumber}` : commit.sha.slice(0, 7);
      lines.push(`  - ${pr} by @${commit.author}: "${commit.message}"`);
    }
  }
  if (lines.length === 0) return "";

  return ["## Repo context", "", lines.join("\n")].join("\n");
}

function formatRepoLocationBullet(location: RepoLocation): string {
  const locator = formatRepoLocationInline(location);
  if (!location.blame) return `\`${locator}\``;

  const who = location.blame.prNumber
    ? `#${location.blame.prNumber}`
    : `commit ${location.blame.commitSha.slice(0, 7)}`;
  const when = formatRelativeDate(location.blame.date);
  return `\`${locator}\` — last changed in ${who} by @${location.blame.author}, ${when}: "${location.blame.commitMessage}"`;
}

function formatRelativeDate(isoDate: string): string {
  const then = new Date(isoDate);
  if (Number.isNaN(then.getTime())) return isoDate;
  const diffMs = Date.now() - then.getTime();
  const days = Math.floor(diffMs / 86_400_000);
  if (days < 1) return "today";
  if (days === 1) return "1 day ago";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.floor(days / 7)} weeks ago`;
  return `${Math.floor(days / 30)} months ago`;
}

function renderPriors(packet: HandoffPacket): string {
  if (!packet.priors || packet.priors.length === 0) return "";
  const items = packet.priors.map((prior) => {
    const percent = Math.round(prior.similarity * 100);
    return [
      `- **${prior.title}** (${percent}% similar)`,
      `  Root cause: ${prior.resolutionRootCause}`,
      `  Fix: ${prior.resolutionSummary}`,
    ].join("\n");
  });
  return ["## Seen before", "", items.join("\n\n")].join("\n");
}

export function renderPacketMarkdown(packet: HandoffPacket): string {
  const indexMap = evidenceIndexMap(packet);

  const sections = [
    renderPreamble(packet),
    renderBestRead(packet),
    renderEvidence(packet, indexMap),
    renderHypotheses(packet, indexMap),
    renderOpenQuestions(packet),
    renderNextStep(packet),
    renderRepoContext(packet),
    renderPriors(packet),
  ].filter((section) => section.trim().length > 0);

  return `${sections.join("\n\n")}\n`;
}

// ---------------------------------------------------------------------------
// Per-target deltas (§7). Targets that need more than a trivial wrapper still
// live in their own module under `src/lib/handoff/targets/`.
// ---------------------------------------------------------------------------

const AGENT_INSTRUCTIONS_BLOCK = [
  "## Instructions for the agent",
  "",
  "- Read before writing. Do not modify files until you can name the failing boundary.",
  "- If confidence is low, investigate only — do not commit.",
  "- Cite evidence by its number (e.g., \"from #2\") when you reason.",
].join("\n");

export function appendAgentInstructions(markdown: string): string {
  return `${markdown.trimEnd()}\n\n${AGENT_INSTRUCTIONS_BLOCK}\n`;
}

const CURSOR_PREAMBLE =
  "You are triaging a bug via TARG. Use the packet below; do not invent evidence.";

export function renderForCursor(packet: HandoffPacket): string {
  const base = renderPacketMarkdown(packet);
  return appendAgentInstructions(`${CURSOR_PREAMBLE}\n\n${base}`);
}
