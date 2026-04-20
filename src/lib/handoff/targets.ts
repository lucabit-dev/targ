/**
 * Per-target rendering + dispatch registry (docs/handoff-packet.md §3, §7).
 *
 * Each target maps to:
 *   - `budget`: max bytes of rendered Markdown before truncation kicks in.
 *   - `render`: pure transform from HandoffPacket -> rendered text.
 *   - `kind`: "copy" for clipboard payloads, "deep_link" for URLs, "dispatch"
 *     for targets that POST to an external API (not wired in Phase 1).
 */

import type { HandoffPacket } from "@/lib/handoff/packet";
import {
  renderForCursor,
  renderPacketMarkdown,
  appendAgentInstructions,
} from "@/lib/handoff/render-markdown";

export type HandoffTargetId =
  | "cursor"
  | "claude_code"
  | "codex"
  | "copilot_ws"
  | "github_issue"
  | "linear_issue"
  | "markdown";

type TargetConfig = {
  kind: "copy" | "deep_link" | "dispatch";
  /** Max bytes of rendered Markdown body. Cursor budget accounts for URL encoding. */
  budgetBytes: number;
  render: (packet: HandoffPacket) => { body: string; url?: string };
  /** Phase-gated: true until the dispatch integration is implemented. */
  notYetAvailable?: { reason: string };
};

const CURSOR_DEEP_LINK_PREFIX = "cursor://anysphere.cursor-deeplink/prompt?text=";
/** Cursor has no official deep-link length cap, but URLs above ~6 KB get flaky. */
const CURSOR_MD_BYTES = 3_500;
const AGENT_COPY_BYTES = 32_000;
const TICKET_BODY_BYTES = 65_000;

const CLAUDE_CODE_WRAPPER_OPEN = "<targ_handoff>";
const CLAUDE_CODE_WRAPPER_CLOSE = "</targ_handoff>";

function renderMarkdown(packet: HandoffPacket) {
  return { body: renderPacketMarkdown(packet) };
}

function renderCursor(packet: HandoffPacket) {
  const body = renderForCursor(packet);
  const url = `${CURSOR_DEEP_LINK_PREFIX}${encodeURIComponent(body)}`;
  return { body, url };
}

function renderClaudeCode(packet: HandoffPacket) {
  const canonical = renderPacketMarkdown(packet);
  const wrapped = `${CLAUDE_CODE_WRAPPER_OPEN}\n${canonical.trimEnd()}\n${CLAUDE_CODE_WRAPPER_CLOSE}`;
  return { body: appendAgentInstructions(wrapped) };
}

function renderCodex(packet: HandoffPacket) {
  const canonical = renderPacketMarkdown(packet).replace(/^# /m, "## ");
  return { body: appendAgentInstructions(`# Task\n\n${canonical}`) };
}

function renderCopilotWorkspaces(packet: HandoffPacket) {
  return { body: appendAgentInstructions(renderPacketMarkdown(packet)) };
}

const REGISTRY: Record<HandoffTargetId, TargetConfig> = {
  cursor: {
    kind: "deep_link",
    budgetBytes: CURSOR_MD_BYTES,
    render: renderCursor,
  },
  claude_code: {
    kind: "copy",
    budgetBytes: AGENT_COPY_BYTES,
    render: renderClaudeCode,
  },
  codex: {
    kind: "copy",
    budgetBytes: AGENT_COPY_BYTES,
    render: renderCodex,
  },
  copilot_ws: {
    kind: "copy",
    budgetBytes: AGENT_COPY_BYTES,
    render: renderCopilotWorkspaces,
  },
  github_issue: {
    kind: "dispatch",
    budgetBytes: TICKET_BODY_BYTES,
    render: renderMarkdown,
    notYetAvailable: {
      reason: "GitHub issue dispatch is not enabled yet; connect a repo first (Phase 5).",
    },
  },
  linear_issue: {
    kind: "dispatch",
    budgetBytes: TICKET_BODY_BYTES,
    render: renderMarkdown,
    notYetAvailable: {
      reason: "Linear issue dispatch is not enabled yet (Phase 4).",
    },
  },
  markdown: {
    kind: "copy",
    budgetBytes: Number.POSITIVE_INFINITY,
    render: renderMarkdown,
  },
};

export function getTargetConfig(target: HandoffTargetId): TargetConfig {
  return REGISTRY[target];
}

export function listEnabledTargets(): HandoffTargetId[] {
  return (Object.keys(REGISTRY) as HandoffTargetId[]).filter(
    (id) => !REGISTRY[id].notYetAvailable
  );
}

// Map between the API-facing lowercase ids and the Prisma `HandoffTarget` enum.
const API_TO_PRISMA: Record<HandoffTargetId, string> = {
  cursor: "CURSOR",
  claude_code: "CLAUDE_CODE",
  codex: "CODEX",
  copilot_ws: "COPILOT_WS",
  github_issue: "GITHUB_ISSUE",
  linear_issue: "LINEAR_ISSUE",
  markdown: "MARKDOWN",
};

export function toPrismaHandoffTarget(target: HandoffTargetId): string {
  return API_TO_PRISMA[target];
}
