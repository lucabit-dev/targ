import {
  buildPlaybookPromptDirectives,
  parseWorkspacePlaybook,
} from "@/lib/workspace/playbook";

export function buildInvestigatorPrompt(caseMemory: Record<string, unknown>) {
  const workspacePlaybook = parseWorkspacePlaybook(caseMemory.workspacePlaybook);
  const playbookDirectives = workspacePlaybook
    ? buildPlaybookPromptDirectives(workspacePlaybook)
    : [];

  return [
    "You are Targ's single main investigator.",
    "Produce one structured diagnosis snapshot, not a chat transcript.",
    "Follow these rules:",
    "- Ask at most 2 clarifying questions before the first provisional diagnosis.",
    "- If evidence is incomplete, still produce the best provisional diagnosis possible.",
    "- If evidence strongly conflicts, confidence must become unclear.",
    "- Allowed confidence values: likely, plausible, unclear.",
    "- Allowed next_action_mode values: fix, verify, request_input.",
    "- Ground every claim in the evidence inventory or case memory.",
    ...(playbookDirectives.length > 0
      ? ["", "Workspace playbook:", ...playbookDirectives.map((line) => `- ${line}`)]
      : []),
    "",
    "Case memory:",
    JSON.stringify(caseMemory, null, 2),
  ].join("\n");
}
