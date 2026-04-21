import { describe, expect, it } from "vitest";

import {
  buildAgentJumpLines,
  pickLocationForCulpritSha,
  renderWhereToStartSection,
} from "@/lib/handoff/agent-jump-targets";
import { buildHandoffPacket } from "@/lib/handoff/packet";
import { CONTRADICTION_FIXTURE_INPUT } from "@/lib/handoff/fixtures/contradiction-split-service";

describe("pickLocationForCulpritSha", () => {
  const stack: Parameters<typeof pickLocationForCulpritSha>[2] = [
    {
      file: "src/a.ts",
      line: 10,
      blame: {
        author: "a",
        commitSha: "sha-a",
        commitMessage: "m",
        date: "2026-01-01T00:00:00Z",
      },
    },
    { file: "src/b.ts", line: 20 },
  ];

  it("prefers blame match", () => {
    const commit = {
      sha: "sha-x",
      message: "x",
      author: "a",
      date: "2026-01-01T00:00:00Z",
      touchedFiles: ["src/z.ts"],
    };
    expect(pickLocationForCulpritSha("sha-a", commit, stack)?.file).toBe(
      "src/a.ts"
    );
  });

  it("falls back to touched file", () => {
    const commit = {
      sha: "sha-b",
      message: "x",
      author: "a",
      date: "2026-01-01T00:00:00Z",
      touchedFiles: ["src/b.ts"],
    };
    expect(pickLocationForCulpritSha("sha-b", commit, stack)?.line).toBe(20);
  });
});

describe("buildAgentJumpLines + renderWhereToStartSection", () => {
  it("emits likely culprit and co-culprit lines when regressions align", () => {
    const packet = buildHandoffPacket({
      ...CONTRADICTION_FIXTURE_INPUT,
      repoEnrichment: {
        repoFullName: "acme/checkout",
        ref: "abcdabcdabcdabcdabcdabcdabcdabcdabcdabcd",
        stackLocations: [
          {
            file: "src/lib/checkout.ts",
            line: 42,
            blame: {
              author: "alice",
              commitSha: "primary0000000000000000000000000aaaa",
              commitMessage: "fix",
              date: "2026-04-01T00:00:00Z",
            },
          },
          {
            file: "src/lib/other.ts",
            line: 7,
            blame: {
              author: "bob",
              commitSha: "coo000000000000000000000000000000cafe",
              commitMessage: "refactor",
              date: "2026-04-02T00:00:00Z",
            },
          },
        ],
        suspectedRegressions: [
          {
            sha: "primary0000000000000000000000000aaaa",
            message: "fix checkout",
            author: "alice",
            date: "2026-04-01T00:00:00Z",
            prNumber: 100,
            touchedFiles: ["src/lib/checkout.ts"],
          },
          {
            sha: "coo000000000000000000000000000000cafe",
            message: "refactor other",
            author: "bob",
            date: "2026-04-02T00:00:00Z",
            prNumber: 200,
            touchedFiles: ["src/lib/other.ts"],
          },
        ],
        likelyCulprit: {
          sha: "primary0000000000000000000000000aaaa",
          confidence: "high",
          reasons: ["matches"],
        },
        coCulprits: [
          {
            sha: "coo000000000000000000000000000000cafe",
            confidence: "high",
            reasons: ["matches"],
          },
        ],
      },
    });

    const lines = buildAgentJumpLines(packet);
    expect(lines).toHaveLength(2);
    expect(lines[0].label).toBe("Likely culprit");
    expect(lines[0].tag).toBe("#100");
    expect(lines[0].location.file).toBe("src/lib/checkout.ts");
    expect(lines[1].label).toBe("Co-culprit");
    expect(lines[1].tag).toBe("#200");

    const md = renderWhereToStartSection(packet);
    expect(md).toContain("## Where to start");
    expect(md).toContain("Likely culprit (#100)");
    expect(md).toContain("Co-culprit (#200)");
    expect(md).toContain("Cmd+P");
    expect(md).toMatch(/blob\/abcdabcd/);
  });

  it("returns empty section when nothing resolves", () => {
    const packet = buildHandoffPacket(CONTRADICTION_FIXTURE_INPUT);
    expect(renderWhereToStartSection(packet)).toBe("");
  });
});
