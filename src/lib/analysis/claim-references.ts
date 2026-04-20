import { EVIDENCE_SOURCE_LABELS, fromPrismaEvidenceSource } from "@/lib/evidence/constants";
import { prismaClaimReferenceRelationMap } from "@/lib/analysis/constants";

type EvidenceRecord = {
  id: string;
  originalName: string;
  source: string;
  redactedText: string | null;
  rawText: string | null;
  extracted: unknown;
};

type DiagnosisPayload = {
  trace: Array<{
    claim: string;
    evidence: string;
  }>;
  contradictions: string[];
  missing_evidence: string[];
  claim_references: Array<{
    claim: string;
    evidenceIds: string[];
  }>;
};

type PersistedClaimReferenceRow = {
  claimKey: string;
  claimText: string;
  relation: string;
  sourceLabel: string | null;
  summary: string | null;
  excerptText: string | null;
  evidenceId: string | null;
};

function extractedSummary(extracted: unknown) {
  if (extracted && typeof extracted === "object" && !Array.isArray(extracted)) {
    const value = (extracted as Record<string, unknown>).summary;
    return typeof value === "string" ? value : null;
  }

  return null;
}

function extractedList(extracted: unknown, key: string) {
  if (extracted && typeof extracted === "object" && !Array.isArray(extracted)) {
    const value = (extracted as Record<string, unknown>)[key];
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  }

  return [];
}

function tokenize(text: string) {
  return Array.from(
    new Set(
      text
        .toLowerCase()
        .split(/[^a-z0-9/_.-]+/g)
        .map((token) => token.trim())
        .filter((token) => token.length >= 4)
    )
  );
}

function excerptFromText(text: string, query: string) {
  const trimmed = text.trim();

  if (!trimmed) {
    return null;
  }

  const lines = trimmed.split("\n").filter(Boolean);
  const queryTokens = tokenize(query);

  for (const line of lines) {
    const lowerLine = line.toLowerCase();

    if (queryTokens.some((token) => lowerLine.includes(token))) {
      return line.slice(0, 220);
    }
  }

  return lines[0]?.slice(0, 220) ?? null;
}

function buildEvidenceReferenceRow(params: {
  claimKey: string;
  claimText: string;
  relation: "supports" | "weakens" | "unclear";
  evidence: EvidenceRecord;
  query: string;
}): PersistedClaimReferenceRow {
  const text = params.evidence.redactedText ?? params.evidence.rawText ?? "";
  const source = fromPrismaEvidenceSource(params.evidence.source);

  return {
    claimKey: params.claimKey,
    claimText: params.claimText,
    relation: prismaClaimReferenceRelationMap[params.relation],
    sourceLabel: EVIDENCE_SOURCE_LABELS[source],
    summary: extractedSummary(params.evidence.extracted),
    excerptText: excerptFromText(text, params.query),
    evidenceId: params.evidence.id,
  };
}

function matchEvidenceByKeywords(evidence: EvidenceRecord[], query: string) {
  const tokens = tokenize(query);

  if (tokens.length === 0) {
    return [];
  }

  return evidence
    .map((item) => {
      const searchable = [
        item.originalName,
        extractedSummary(item.extracted) ?? "",
        item.redactedText ?? item.rawText ?? "",
        ...extractedList(item.extracted, "services"),
        ...extractedList(item.extracted, "endpoints"),
        ...extractedList(item.extracted, "envHints"),
      ]
        .join("\n")
        .toLowerCase();

      const score = tokens.reduce(
        (accumulator, token) => accumulator + (searchable.includes(token) ? 1 : 0),
        0
      );

      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.item);
}

function buildMissingEvidenceRows(
  evidence: EvidenceRecord[],
  item: string,
  index: number
) {
  const claimKey = `missing-${index}`;

  let matches: EvidenceRecord[] = [];

  if (item.toLowerCase().includes("timestamp")) {
    matches = evidence.filter(
      (entry) => extractedList(entry.extracted, "timestamps").length === 0
    );
  } else if (item.toLowerCase().includes("request") || item.toLowerCase().includes("trace")) {
    matches = evidence.filter(
      (entry) =>
        extractedList(entry.extracted, "endpoints").length > 0 &&
        extractedList(entry.extracted, "requestIds").length === 0
    );
  } else if (item.toLowerCase().includes("stack")) {
    matches = evidence.filter(
      (entry) => extractedList(entry.extracted, "stackFrames").length === 0
    );
  }

  return matches.slice(0, 3).map((entry) =>
    buildEvidenceReferenceRow({
      claimKey,
      claimText: item,
      relation: "unclear",
      evidence: entry,
      query: item,
    })
  );
}

export function buildPersistedClaimReferenceRows(params: {
  diagnosisPayload: DiagnosisPayload;
  evidence: EvidenceRecord[];
}) {
  const rows: PersistedClaimReferenceRow[] = [];

  params.diagnosisPayload.claim_references.forEach((reference, index) => {
    const claimKey = `trace-${index}`;

    reference.evidenceIds.forEach((evidenceId) => {
      const evidence = params.evidence.find((item) => item.id === evidenceId);

      if (!evidence) {
        return;
      }

      rows.push(
        buildEvidenceReferenceRow({
          claimKey,
          claimText: reference.claim,
          relation: "supports",
          evidence,
          query: reference.claim,
        })
      );
    });
  });

  params.diagnosisPayload.contradictions.forEach((contradiction, index) => {
    const matches = matchEvidenceByKeywords(params.evidence, contradiction).slice(0, 3);

    matches.forEach((evidence) => {
      rows.push(
        buildEvidenceReferenceRow({
          claimKey: `contradiction-${index}`,
          claimText: contradiction,
          relation: "weakens",
          evidence,
          query: contradiction,
        })
      );
    });
  });

  params.diagnosisPayload.missing_evidence.forEach((item, index) => {
    rows.push(...buildMissingEvidenceRows(params.evidence, item, index));
  });

  return rows;
}
