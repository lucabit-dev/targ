import { describe, expect, it } from "vitest";

import { classifyFilePath, isSymbolIndexable } from "./classify";

describe("classifyFilePath", () => {
  it("classifies TypeScript source as CODE/typescript", () => {
    expect(classifyFilePath("src/lib/foo/bar.ts")).toEqual({
      kind: "CODE",
      language: "typescript",
    });
    expect(classifyFilePath("src/app/page.tsx")).toEqual({
      kind: "CODE",
      language: "typescript",
    });
  });

  it("classifies JS as CODE/javascript", () => {
    expect(classifyFilePath("scripts/build.mjs")).toEqual({
      kind: "CODE",
      language: "javascript",
    });
  });

  it("classifies test files as TEST (by suffix)", () => {
    expect(classifyFilePath("src/lib/foo.test.ts")).toEqual({
      kind: "TEST",
      language: "typescript",
    });
    expect(classifyFilePath("src/lib/foo.spec.tsx")).toEqual({
      kind: "TEST",
      language: "typescript",
    });
  });

  it("classifies test files as TEST (by directory)", () => {
    expect(classifyFilePath("src/__tests__/foo.ts")).toEqual({
      kind: "TEST",
      language: "typescript",
    });
    expect(classifyFilePath("e2e/login.spec.ts")).toEqual({
      kind: "TEST",
      language: "typescript",
    });
  });

  it("classifies Go test files", () => {
    expect(classifyFilePath("pkg/foo_test.go").kind).toBe("TEST");
  });

  it("classifies Markdown under docs/ as DOCS/markdown", () => {
    expect(classifyFilePath("docs/handoff-packet.md")).toEqual({
      kind: "DOCS",
      language: "markdown",
    });
  });

  it("classifies top-level README as DOCS", () => {
    expect(classifyFilePath("README.md")).toEqual({
      kind: "DOCS",
      language: "markdown",
    });
  });

  it("classifies package.json as CONFIG", () => {
    expect(classifyFilePath("package.json")).toEqual({
      kind: "CONFIG",
      language: "json",
    });
  });

  it("classifies dotfiles and config files as CONFIG", () => {
    expect(classifyFilePath(".eslintrc.json").kind).toBe("CONFIG");
    expect(classifyFilePath(".gitignore").kind).toBe("CONFIG");
    expect(classifyFilePath("Dockerfile").kind).toBe("CONFIG");
    expect(classifyFilePath("tsconfig.json").kind).toBe("CONFIG");
    expect(classifyFilePath("vitest.config.ts").kind).toBe("CONFIG");
  });

  it("classifies images and binaries as ASSET", () => {
    expect(classifyFilePath("public/logo.svg")).toEqual({
      kind: "ASSET",
      language: null,
    });
    expect(classifyFilePath("fonts/inter.woff2")).toEqual({
      kind: "ASSET",
      language: null,
    });
  });

  it("classifies unknown extensions as OTHER", () => {
    expect(classifyFilePath("some/random/file.xyz")).toEqual({
      kind: "OTHER",
      language: null,
    });
  });

  it("TEST takes precedence over DOCS for .md under __tests__", () => {
    expect(classifyFilePath("__tests__/README.md").kind).toBe("TEST");
  });
});

describe("isSymbolIndexable", () => {
  it("accepts TS/JS CODE files", () => {
    expect(isSymbolIndexable("CODE", "typescript")).toBe(true);
    expect(isSymbolIndexable("CODE", "javascript")).toBe(true);
  });

  it("rejects non-CODE files even with a supported language", () => {
    expect(isSymbolIndexable("TEST", "typescript")).toBe(false);
    expect(isSymbolIndexable("DOCS", "typescript")).toBe(false);
  });

  it("rejects CODE files in languages without a parser wired yet", () => {
    expect(isSymbolIndexable("CODE", "python")).toBe(false);
    expect(isSymbolIndexable("CODE", "go")).toBe(false);
    expect(isSymbolIndexable("CODE", null)).toBe(false);
  });
});
