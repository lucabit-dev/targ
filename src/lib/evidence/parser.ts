import type {
  EvidenceIngestStatusValue,
  EvidenceKindValue,
  EvidenceSourceValue,
} from "@/lib/evidence/constants";

type StackFrame = {
  raw: string;
};

export type ExtractedEvidence = {
  timestamps: string[];
  requestIds: string[];
  services: string[];
  endpoints: string[];
  stackFrames: StackFrame[];
  envHints: string[];
  versionHints: string[];
  secretsDetected: boolean;
  parseWarnings: string[];
  notices: string[];
  summary: string;
  screenshotText?: string | null;
  capturedFields?: string[];
  contextLinked?: boolean;
  contextSummary?: string | null;
  focusTags?: string[];
};

type NormalizedEvidenceResult = {
  ingestStatus: EvidenceIngestStatusValue;
  rawText: string | null;
  redactedText: string | null;
  extracted: ExtractedEvidence;
};

const TIMESTAMP_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}[T ][0-2]\d:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?\b/g,
  /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\b/g,
];

const REQUEST_ID_PATTERNS = [
  /\b(?:request|req|trace|correlation)[-_ ]?id[:= ]+([A-Za-z0-9-_/]{6,})/gi,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
];

const SERVICE_PATTERNS = [
  /\b(?:service|svc|app|component)[:= ]+([A-Za-z0-9._-]{2,})/gi,
];

const ENDPOINT_PATTERNS = [
  /\b(?:GET|POST|PUT|PATCH|DELETE)\s+([/][A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+)/g,
  /\bhttps?:\/\/[^\s)"']+/g,
];

const STACK_FRAME_PATTERNS = [
  /^\s*at\s+.+$/gm,
  /^\s*File\s+"[^"]+",\s+line\s+\d+.+$/gm,
];

const ENV_HINT_PATTERNS = [
  /\bproduction\b/gi,
  /\bstaging\b/gi,
  /\bpreview\b/gi,
  /\bdevelopment\b/gi,
  /\bdev\b/gi,
  /\blocal\b/gi,
  /\btest\b/gi,
];

const VERSION_PATTERNS = [
  /\bv?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?\b/g,
  /\bnode\s+v\d+\.\d+\.\d+\b/gi,
];

const NOTE_SECTION_PATTERNS = {
  expected: /^(?:expected|should|intended|wanted|want)\b[:\s-]*/i,
  actual: /^(?:actual|observed|seeing|current|result|happens|happening)\b[:\s-]*/i,
  impact: /^(?:impact|affects|affected|user impact|severity|risk)\b[:\s-]*/i,
  steps: /^(?:steps|repro|reproduction|how to reproduce|to reproduce)\b[:\s-]*/i,
  tried: /^(?:tried|attempted|tested|checked|already tried)\b[:\s-]*/i,
  context: /^(?:context|background|note|details)\b[:\s-]*/i,
} as const;

const NOTE_FIELD_NOTICE_LABELS = {
  expected_actual: "Expected vs actual captured",
  expected: "Expected behavior captured",
  actual: "Observed behavior captured",
  impact: "Impact captured",
  steps: "Reproduction steps captured",
  tried: "Attempted fixes captured",
  context: "Extra context captured",
} as const;

const SCREENSHOT_IGNORE_TOKENS = new Set([
  "screen",
  "screenshot",
  "screenshots",
  "shot",
  "capture",
  "captures",
  "image",
  "images",
  "img",
  "photo",
  "copy",
  "final",
  "edited",
  "edit",
  "new",
  "latest",
  "desktop",
  "window",
  "page",
  "state",
  "issue",
  "error",
  "png",
  "jpg",
  "jpeg",
  "webp",
  "heic",
  "heif",
]);

type NoteSectionKey = keyof typeof NOTE_SECTION_PATTERNS;

type NoteSections = Record<NoteSectionKey, string[]>;

type NormalizeTextEvidenceOptions = {
  originalName?: string | null;
  source?: EvidenceSourceValue | null;
};

type NormalizeScreenshotEvidenceOptions = {
  contextNotes?: string[];
};

function uniqueStrings(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function clipText(value: string, maxLength: number) {
  const compact = value.replace(/\s+/g, " ").trim();

  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function stripEvidenceFileExtension(value: string) {
  return value.replace(/\.[A-Za-z0-9]{2,5}$/u, "");
}

function toSentence(value: string, maxLength = 180) {
  const clipped = clipText(value, maxLength);

  if (!clipped) {
    return "";
  }

  return /[.!?]$/.test(clipped) ? clipped : `${clipped}.`;
}

function firstNonEmpty(values: string[]) {
  return values.find(Boolean) ?? "";
}

function isScreenshotContextName(originalName?: string | null) {
  return typeof originalName === "string" && /screenshot context/i.test(originalName);
}

function collectMatches(text: string, patterns: RegExp[]) {
  const values: string[] = [];

  for (const pattern of patterns) {
    const matches = text.matchAll(pattern);

    for (const match of matches) {
      const value = match[1] ?? match[0];

      if (value) {
        values.push(value);
      }
    }
  }

  return uniqueStrings(values);
}

function collectStackFrames(text: string) {
  const values: string[] = [];

  for (const pattern of STACK_FRAME_PATTERNS) {
    const matches = text.matchAll(pattern);

    for (const match of matches) {
      if (match[0]) {
        values.push(match[0].trim());
      }
    }
  }

  return uniqueStrings(values).slice(0, 20).map((raw) => ({ raw }));
}

function redactSecrets(text: string) {
  let redacted = text;
  let secretsDetected = false;

  redacted = redacted.replace(/\b(AKIA[0-9A-Z]{16})\b/g, () => {
    secretsDetected = true;
    return "[REDACTED_SECRET]";
  });

  redacted = redacted.replace(/\b(ghp_[A-Za-z0-9]{20,})\b/g, () => {
    secretsDetected = true;
    return "[REDACTED_SECRET]";
  });

  redacted = redacted.replace(
    /\b(api[_-]?key|secret|token|password)\b(\s*[:=]\s*["']?)([A-Za-z0-9_\-+/=]{8,})/gi,
    (_match, label: string, separator: string) => {
      secretsDetected = true;
      return `${label}${separator}[REDACTED_SECRET]`;
    }
  );

  return { redacted, secretsDetected };
}

function createEmptyNoteSections(): NoteSections {
  return {
    expected: [],
    actual: [],
    impact: [],
    steps: [],
    tried: [],
    context: [],
  };
}

function normalizeLabeledLine(line: string) {
  return line
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
}

function detectNoteSection(line: string): NoteSectionKey | null {
  for (const [key, pattern] of Object.entries(NOTE_SECTION_PATTERNS) as Array<
    [NoteSectionKey, RegExp]
  >) {
    if (pattern.test(line)) {
      return key;
    }
  }

  return null;
}

function extractNoteSections(text: string) {
  const sections = createEmptyNoteSections();
  const lines = text.split(/\r?\n/);
  let activeSection: NoteSectionKey | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();

    if (!trimmed) {
      activeSection = null;
      continue;
    }

    const normalizedLine = normalizeLabeledLine(trimmed);
    const section = detectNoteSection(normalizedLine);

    if (section) {
      activeSection = section;

      const content = normalizedLine.replace(NOTE_SECTION_PATTERNS[section], "").trim();

      if (content) {
        sections[section].push(content);
      }

      continue;
    }

    if (
      activeSection &&
      (activeSection !== "steps" || /^[-*]|\d+[.)]/.test(trimmed) || normalizedLine.length > 0)
    ) {
      sections[activeSection].push(normalizedLine);
    }
  }

  const deduped = Object.fromEntries(
    Object.entries(sections).map(([key, values]) => [key, uniqueStrings(values)])
  ) as NoteSections;

  const capturedFields: string[] = [];

  if (deduped.expected.length > 0 && deduped.actual.length > 0) {
    capturedFields.push(NOTE_FIELD_NOTICE_LABELS.expected_actual);
  } else {
    if (deduped.expected.length > 0) {
      capturedFields.push(NOTE_FIELD_NOTICE_LABELS.expected);
    }

    if (deduped.actual.length > 0) {
      capturedFields.push(NOTE_FIELD_NOTICE_LABELS.actual);
    }
  }

  if (deduped.impact.length > 0) {
    capturedFields.push(NOTE_FIELD_NOTICE_LABELS.impact);
  }

  if (deduped.steps.length > 0) {
    capturedFields.push(NOTE_FIELD_NOTICE_LABELS.steps);
  }

  if (deduped.tried.length > 0) {
    capturedFields.push(NOTE_FIELD_NOTICE_LABELS.tried);
  }

  if (deduped.context.length > 0) {
    capturedFields.push(NOTE_FIELD_NOTICE_LABELS.context);
  }

  return {
    sections: deduped,
    capturedFields,
  };
}

function summarizeNoteEvidence(params: {
  text: string;
  originalName?: string | null;
  source?: EvidenceSourceValue | null;
}) {
  const { sections, capturedFields } = extractNoteSections(params.text);
  const isScreenshotContext =
    isScreenshotContextName(params.originalName) ||
    (params.source === "manual_note" && /\bscreenshot\b/i.test(params.text));
  const primarySignal = firstNonEmpty([
    sections.actual[0],
    sections.context[0],
    sections.expected[0],
    sections.impact[0],
    sections.steps[0],
    sections.tried[0],
  ]);

  let summary = "";

  if (isScreenshotContext) {
    const detail = primarySignal || params.text;
    summary = toSentence(`Screenshot context: ${detail}`, 180);
  } else if (sections.expected[0] && sections.actual[0]) {
    summary = toSentence(
      `Expected ${sections.expected[0]}, but observed ${sections.actual[0]}`,
      180
    );
  } else if (sections.actual[0] && sections.impact[0]) {
    summary = toSentence(
      `Observed ${sections.actual[0]}. Impact: ${sections.impact[0]}`,
      180
    );
  } else if (primarySignal) {
    summary = toSentence(primarySignal, 180);
  }

  return {
    sections,
    capturedFields,
    notices: isScreenshotContext ? ["Screenshot context note"] : [],
    summary: summary || toSentence(params.text, 180),
    isScreenshotContext,
  };
}

function deriveScreenshotFocusTags(originalName: string) {
  const stem = stripEvidenceFileExtension(originalName);
  const rawTokens = stem
    .split(/[^A-Za-z0-9]+/u)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  return uniqueStrings(
    rawTokens.filter((token) => {
      if (SCREENSHOT_IGNORE_TOKENS.has(token)) {
        return false;
      }

      if (token.length <= 2 && !/^\d{3}$/.test(token)) {
        return false;
      }

      return true;
    })
  ).slice(0, 4);
}

function summarizeScreenshotEvidence(
  originalName: string,
  options?: NormalizeScreenshotEvidenceOptions
) {
  const contextNotes = uniqueStrings(options?.contextNotes ?? []);
  const contextSummary = contextNotes.length > 0 ? clipText(contextNotes[0] ?? "", 160) : null;
  const focusTags = deriveScreenshotFocusTags(originalName);
  const notices = [...(contextSummary ? ["Manual screenshot context linked"] : [])];

  if (focusTags.length > 0) {
    notices.push("Filename hints extracted");
  }

  const parseWarnings = [
    contextSummary
      ? "Screenshot text extraction is not available in local mode yet. Summary is based on the linked screenshot note and filename."
      : "Screenshot text extraction is not available in local mode yet. Add a short screenshot context note to explain what matters.",
  ];

  const summary = contextSummary
    ? toSentence(`Screenshot evidence: ${contextSummary}`, 180)
    : focusTags.length > 0
      ? toSentence(`Screenshot evidence related to ${focusTags.join(", ")}`, 180)
      : toSentence(
          `${stripEvidenceFileExtension(originalName)} was uploaded as screenshot evidence and still needs manual review`,
          180
        );

  return {
    summary,
    parseWarnings,
    notices,
    focusTags,
    contextSummary,
  };
}

function summarizeText(
  kind: EvidenceKindValue,
  text: string,
  stackFrameCount: number,
  options?: NormalizeTextEvidenceOptions
) {
  const firstMeaningfulLine =
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? "";

  const compact = firstMeaningfulLine.replace(/\s+/g, " ");

  if (kind === "note") {
    return summarizeNoteEvidence({
      text,
      originalName: options?.originalName,
      source: options?.source,
    });
  }

  if (stackFrameCount > 0) {
    return {
      summary: `Stack trace evidence with ${stackFrameCount} frame${stackFrameCount === 1 ? "" : "s"}.`,
      capturedFields: [],
      notices: [],
    };
  }

  if (compact.length > 0) {
    return {
      summary: compact.slice(0, 180),
      capturedFields: [],
      notices: [],
    };
  }

  return {
    summary: `${kind.replace("_", " ")} evidence added.`,
    capturedFields: [],
    notices: [],
  };
}

export function normalizeTextEvidence(
  kind: EvidenceKindValue,
  rawText: string,
  options?: NormalizeTextEvidenceOptions
): NormalizedEvidenceResult {
  const trimmedText = rawText.trim();
  const { redacted, secretsDetected } = redactSecrets(trimmedText);
  const timestamps = collectMatches(trimmedText, TIMESTAMP_PATTERNS);
  const requestIds = collectMatches(trimmedText, REQUEST_ID_PATTERNS);
  const services = collectMatches(trimmedText, SERVICE_PATTERNS);
  const endpoints = collectMatches(trimmedText, ENDPOINT_PATTERNS);
  const stackFrames = collectStackFrames(trimmedText);
  const envHints = collectMatches(trimmedText, ENV_HINT_PATTERNS);
  const versionHints = collectMatches(trimmedText, VERSION_PATTERNS);
  const parseWarnings: string[] = [];
  const notices: string[] = [];
  const textSummary = summarizeText(kind, redacted, stackFrames.length, options);
  const structuredSignalsCount =
    (textSummary.capturedFields?.length ?? 0) + (textSummary.notices?.length ?? 0);

  if (stackFrames.length > 0) {
    notices.push("Stack trace detected");
  }

  if (timestamps.length > 0) {
    notices.push("Timestamps recognized");
  }

  if (secretsDetected) {
    notices.push("Possible secret detected");
    parseWarnings.push("Possible secret detected. Sensitive values were redacted.");
  }

  if (
    timestamps.length === 0 &&
    requestIds.length === 0 &&
    services.length === 0 &&
    endpoints.length === 0 &&
    stackFrames.length === 0 &&
    envHints.length === 0 &&
    versionHints.length === 0 &&
    structuredSignalsCount === 0
  ) {
    parseWarnings.push("Limited structured fields were extracted from this evidence.");
  }

  if (textSummary.notices.length > 0) {
    notices.push(...textSummary.notices);
  }

  if (textSummary.capturedFields.length > 0) {
    notices.push(...textSummary.capturedFields);
  }

  const extracted: ExtractedEvidence = {
    timestamps,
    requestIds,
    services,
    endpoints,
    stackFrames,
    envHints,
    versionHints,
    secretsDetected,
    parseWarnings,
    notices: uniqueStrings(notices),
    summary: textSummary.summary,
    capturedFields: textSummary.capturedFields,
  };

  return {
    ingestStatus: "ready",
    rawText: trimmedText,
    redactedText: redacted,
    extracted,
  };
}

export function normalizeScreenshotEvidence(
  originalName: string,
  options?: NormalizeScreenshotEvidenceOptions
): NormalizedEvidenceResult {
  const screenshotSummary = summarizeScreenshotEvidence(originalName, options);

  return {
    ingestStatus: "needs_review",
    rawText: null,
    redactedText: null,
    extracted: {
      timestamps: [],
      requestIds: [],
      services: [],
      endpoints: [],
      stackFrames: [],
      envHints: [],
      versionHints: [],
      secretsDetected: false,
      parseWarnings: screenshotSummary.parseWarnings,
      notices: screenshotSummary.notices,
      summary: screenshotSummary.summary,
      screenshotText: null,
      contextLinked: Boolean(screenshotSummary.contextSummary),
      contextSummary: screenshotSummary.contextSummary,
      focusTags: screenshotSummary.focusTags,
    },
  };
}

export function normalizeUnsupportedEvidence(originalName: string): NormalizedEvidenceResult {
  return {
    ingestStatus: "unsupported",
    rawText: null,
    redactedText: null,
    extracted: {
      timestamps: [],
      requestIds: [],
      services: [],
      endpoints: [],
      stackFrames: [],
      envHints: [],
      versionHints: [],
      secretsDetected: false,
      parseWarnings: ["This file type is not supported yet."],
      notices: ["This file type is not supported yet"],
      summary: `${originalName} was stored, but this file type is not supported yet.`,
      screenshotText: null,
    },
  };
}
