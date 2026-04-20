import { readFile } from "node:fs/promises";
import path from "node:path";

import { goldenCaseSchema, type GoldenCase } from "@/lib/evals/types";

const GOLDEN_ROOT = path.join(process.cwd(), "evals", "golden");

type GoldenIndexEntry = {
  id: string;
  status: "seeded" | "scaffold";
  file?: string;
};

export async function loadGoldenDataset() {
  const indexPath = path.join(GOLDEN_ROOT, "index.json");
  const index = JSON.parse(await readFile(indexPath, "utf8")) as {
    targetCount: number;
    cases: GoldenIndexEntry[];
  };

  const seededCases: GoldenCase[] = [];

  for (const entry of index.cases) {
    if (entry.status !== "seeded" || !entry.file) {
      continue;
    }

    const filePath = path.join(GOLDEN_ROOT, entry.file);
    const raw = JSON.parse(await readFile(filePath, "utf8"));
    seededCases.push(goldenCaseSchema.parse(raw));
  }

  return {
    targetCount: index.targetCount,
    seededCases,
    scaffoldCount: index.cases.filter((entry) => entry.status === "scaffold").length,
  };
}
