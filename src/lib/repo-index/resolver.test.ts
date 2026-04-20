import { describe, expect, it } from "vitest";

import { resolvePath, tokenize, type ResolverInputFile } from "./resolver";

const FILES: ReadonlyArray<ResolverInputFile> = [
  { path: "src/lib/checkout/checkout-service.ts", kind: "CODE", language: "typescript" },
  { path: "src/lib/checkout/checkout-service.test.ts", kind: "TEST", language: "typescript" },
  { path: "src/lib/billing/payment.ts", kind: "CODE", language: "typescript" },
  { path: "src/lib/billing/payment.spec.ts", kind: "TEST", language: "typescript" },
  { path: "src/app/api/cases/route.ts", kind: "CODE", language: "typescript" },
  { path: "src/components/checkout-form.tsx", kind: "CODE", language: "typescript" },
  { path: "README.md", kind: "DOCS", language: "markdown" },
  { path: "docs/handoff-packet.md", kind: "DOCS", language: "markdown" },
  { path: "package.json", kind: "CONFIG", language: "json" },
  { path: "public/logo.svg", kind: "ASSET", language: null },
];

describe("tokenize", () => {
  it("splits camelCase into lowercase tokens", () => {
    expect(tokenize("CheckoutService")).toEqual(["checkout", "service"]);
  });

  it("splits snake_case and kebab-case", () => {
    expect(tokenize("checkout_service-v2")).toEqual(["checkout", "service", "v2"]);
  });

  it("drops stopwords and very short tokens but keeps identifier parts", () => {
    // "the" and "failed" are stopwords; "service" is an identifier fragment.
    expect(tokenize("the checkout service failed")).toEqual([
      "checkout",
      "service",
    ]);
  });

  it("preserves consecutive capitals correctly (APIKey -> api, key)", () => {
    expect(tokenize("APIKeyManager")).toEqual(["api", "key", "manager"]);
  });
});

describe("resolvePath", () => {
  it("returns [] for empty hint", () => {
    expect(resolvePath("", FILES)).toEqual([]);
    expect(resolvePath("   ", FILES)).toEqual([]);
  });

  it("returns exact path match at score 1", () => {
    const result = resolvePath("src/lib/billing/payment.ts", FILES);
    expect(result[0]).toMatchObject({
      path: "src/lib/billing/payment.ts",
      score: 1,
    });
    expect(result[0]?.reasons).toContain("exact path match");
  });

  it("handles path:line syntax and propagates the line number", () => {
    const result = resolvePath("src/lib/billing/payment.ts:42", FILES);
    expect(result[0]?.path).toBe("src/lib/billing/payment.ts");
    expect(result[0]?.line).toBe(42);
  });

  it("handles github-style path#L42 syntax", () => {
    const result = resolvePath("src/lib/billing/payment.ts#L17", FILES);
    expect(result[0]?.line).toBe(17);
  });

  it("matches by basename when only the file name is given", () => {
    const result = resolvePath("payment.ts", FILES);
    expect(result[0]?.path).toBe("src/lib/billing/payment.ts");
    expect(result[0]?.score).toBeGreaterThanOrEqual(0.78);
  });

  it("biases away from test files for non-testy hints", () => {
    const result = resolvePath("checkout-service.ts", FILES);
    expect(result[0]?.path).toBe("src/lib/checkout/checkout-service.ts");
    const testRow = result.find(
      (r) => r.path === "src/lib/checkout/checkout-service.test.ts"
    );
    // Test file should either be absent or ranked below the production file.
    if (testRow) {
      expect(testRow.score).toBeLessThan(result[0]!.score);
    }
  });

  it("keeps test files for testy hints", () => {
    const result = resolvePath("checkout-service.test.ts", FILES);
    expect(result[0]?.path).toBe("src/lib/checkout/checkout-service.test.ts");
  });

  it("falls back to token overlap for identifier-like hints", () => {
    const result = resolvePath("CheckoutService", FILES);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]?.path.toLowerCase()).toContain("checkout");
  });

  it("handles free-form hints like \"checkout service failed in production\"", () => {
    const result = resolvePath("checkout service failed in production", FILES);
    expect(result[0]?.path.toLowerCase()).toContain("checkout");
  });

  it("returns an empty array when nothing matches", () => {
    const result = resolvePath("totallyUnrelatedThing", FILES);
    expect(result).toEqual([]);
  });

  it("respects limit option", () => {
    const result = resolvePath("checkout", FILES, { limit: 1 });
    expect(result).toHaveLength(1);
  });

  it("penalises ASSET hits more than CODE hits", () => {
    const codeOnly: ResolverInputFile[] = [
      { path: "src/logo.ts", kind: "CODE", language: "typescript" },
      { path: "public/logo.svg", kind: "ASSET", language: null },
    ];
    const result = resolvePath("logo", codeOnly);
    expect(result[0]?.path).toBe("src/logo.ts");
  });

  it("sorts by path length as a tie-breaker when scores tie", () => {
    const tied: ResolverInputFile[] = [
      { path: "a/b/c/foo.ts", kind: "CODE", language: "typescript" },
      { path: "foo.ts", kind: "CODE", language: "typescript" },
    ];
    const result = resolvePath("foo.ts", tied);
    expect(result[0]?.path).toBe("foo.ts");
  });
});
