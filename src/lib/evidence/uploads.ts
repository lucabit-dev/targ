import path from "node:path";

import type { EvidenceKindValue } from "@/lib/evidence/constants";

const codeExtensions = new Set([
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".py",
  ".rb",
  ".go",
  ".java",
  ".kt",
  ".rs",
  ".php",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".css",
  ".html",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
]);

function extensionOf(fileName: string) {
  return path.extname(fileName).toLowerCase();
}

export function inferEvidenceKindFromUpload(
  originalName: string,
  mimeType?: string | null
): EvidenceKindValue | null {
  const extension = extensionOf(originalName);
  const lowerName = originalName.toLowerCase();
  const safeMimeType = mimeType?.toLowerCase() ?? "";

  if (safeMimeType.startsWith("image/")) {
    return "screenshot";
  }

  if (codeExtensions.has(extension)) {
    return "code";
  }

  if (extension === ".log") {
    return "log";
  }

  if (lowerName.includes("terminal") || lowerName.includes("stdout") || lowerName.includes("stderr")) {
    return "terminal";
  }

  if (lowerName.includes("error") || lowerName.includes("stacktrace")) {
    return "error_text";
  }

  if (
    safeMimeType.startsWith("text/") ||
    safeMimeType === "application/json" ||
    safeMimeType === "application/xml"
  ) {
    return extension === ".md" ? "note" : "log";
  }

  if (extension === ".md" || extension === ".txt") {
    return "note";
  }

  return null;
}

export function isTextLikeUpload(kind: EvidenceKindValue | null) {
  return kind !== null && kind !== "screenshot";
}
