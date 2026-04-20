import type { CaseProblemLens, CaseSolveMode } from "@prisma/client";

/** API + planner values (lowercase snake). */
export type CaseSolveModeValue = "quick_patch" | "proper_fix" | "strategic_improvement";
export type CaseProblemLensValue = "code" | "ux_ui" | "product" | "doctrine" | "mixed";

export const prismaSolveModeMap: Record<CaseSolveModeValue, CaseSolveMode> = {
  quick_patch: "QUICK_PATCH",
  proper_fix: "PROPER_FIX",
  strategic_improvement: "STRATEGIC_IMPROVEMENT",
};

export const prismaProblemLensMap: Record<CaseProblemLensValue, CaseProblemLens> = {
  code: "CODE",
  ux_ui: "UX_UI",
  product: "PRODUCT",
  doctrine: "DOCTRINE",
  mixed: "MIXED",
};

const solveModeReverse: Record<CaseSolveMode, CaseSolveModeValue> = {
  QUICK_PATCH: "quick_patch",
  PROPER_FIX: "proper_fix",
  STRATEGIC_IMPROVEMENT: "strategic_improvement",
};

const problemLensReverse: Record<CaseProblemLens, CaseProblemLensValue> = {
  CODE: "code",
  UX_UI: "ux_ui",
  PRODUCT: "product",
  DOCTRINE: "doctrine",
  MIXED: "mixed",
};

export function solveModeFromPrisma(value: CaseSolveMode | null): CaseSolveModeValue | null {
  return value ? solveModeReverse[value] : null;
}

/** When unset on the case, planning UI defaults to balanced depth without a DB write until the user acts. */
export const DEFAULT_PLAN_DEPTH: CaseSolveModeValue = "proper_fix";

export function effectivePlanDepth(
  stored: CaseSolveModeValue | null
): CaseSolveModeValue {
  return stored ?? DEFAULT_PLAN_DEPTH;
}

/** Compact segment labels (full names in `title` on controls). */
export const PLAN_DEPTH_SEGMENT_LABELS: Record<CaseSolveModeValue, string> = {
  quick_patch: "Quick patch",
  proper_fix: "Proper fix",
  strategic_improvement: "Strategic",
};

export function problemLensFromPrisma(value: CaseProblemLens | null): CaseProblemLensValue | null {
  return value ? problemLensReverse[value] : null;
}

/** Short label for case chrome (matches home composer lens names). */
const PROBLEM_LENS_DISPLAY: Record<CaseProblemLens, string> = {
  CODE: "Code",
  UX_UI: "UX / UI",
  PRODUCT: "Product",
  DOCTRINE: "Doctrine",
  MIXED: "Mixed",
};

export function problemLensDisplayLabel(value: CaseProblemLens | null | undefined): string {
  return value ? PROBLEM_LENS_DISPLAY[value] : "Auto";
}
