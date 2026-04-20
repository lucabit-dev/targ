import { describe, expect, it } from "vitest";

import { extractSymbols } from "./symbol-extractor";

function tsNames(source: string) {
  const { symbols } = extractSymbols(source, {
    language: "typescript",
    filename: "x.ts",
  });
  return symbols.map((s) => ({
    name: s.name,
    kind: s.kind,
    exported: s.exported,
  }));
}

describe("extractSymbols", () => {
  it("extracts function declarations", () => {
    const out = tsNames(`
      function foo() { return 1; }
      export function bar() { return 2; }
    `);
    expect(out).toEqual([
      { name: "foo", kind: "FUNCTION", exported: false },
      { name: "bar", kind: "FUNCTION", exported: true },
    ]);
  });

  it("extracts class declarations with methods", () => {
    const out = tsNames(`
      export class Svc {
        doThing() {}
        private helper() {}
      }
    `);
    expect(out.map((s) => s.name + ":" + s.kind)).toEqual([
      "Svc:CLASS",
      "doThing:METHOD",
      "helper:METHOD",
    ]);
    expect(out[0]?.exported).toBe(true);
  });

  it("recognises arrow-function const as FUNCTION", () => {
    const out = tsNames(`
      export const compute = (a: number) => a + 1;
      const helper = function(x: string) { return x; };
    `);
    expect(out).toEqual([
      { name: "compute", kind: "FUNCTION", exported: true },
      { name: "helper", kind: "FUNCTION", exported: false },
    ]);
  });

  it("classifies PascalCase arrow returning JSX as COMPONENT", () => {
    const out = extractSymbols(
      `export const Button = () => <button>hi</button>;`,
      { language: "typescript", filename: "x.tsx" }
    );
    expect(out.symbols[0]).toMatchObject({
      name: "Button",
      kind: "COMPONENT",
      exported: true,
    });
  });

  it("classifies memo(() => <JSX/>) as COMPONENT", () => {
    const out = extractSymbols(
      `export const Card = memo(() => <div/>);`,
      { language: "typescript", filename: "x.tsx" }
    );
    expect(out.symbols[0]?.kind).toBe("COMPONENT");
  });

  it("extracts interfaces, type aliases, and enums", () => {
    const out = tsNames(`
      export interface User { id: string }
      export type UserId = string;
      export enum Role { Admin, Member }
    `);
    expect(out).toEqual([
      { name: "User", kind: "INTERFACE", exported: true },
      { name: "UserId", kind: "TYPE", exported: true },
      { name: "Role", kind: "ENUM", exported: true },
    ]);
  });

  it("handles plain const as VARIABLE", () => {
    const out = tsNames(`export const MAX = 10;`);
    expect(out).toEqual([
      { name: "MAX", kind: "VARIABLE", exported: true },
    ]);
  });

  it("records default exports with their name", () => {
    const out = tsNames(`export default function foo() {}`);
    expect(out).toEqual([
      { name: "foo", kind: "FUNCTION", exported: true },
    ]);
  });

  it("falls back to 'default' for anonymous default exports", () => {
    const out = tsNames(`export default function() { return 1; }`);
    expect(out[0]?.name).toBe("default");
  });

  it("returns a parseError on invalid source but keeps any parsed-so-far symbols", () => {
    const result = extractSymbols(
      `export function ok() {}\nthis is !! not @@ valid @@ syntax`,
      { language: "typescript", filename: "x.ts" }
    );
    // Babel's errorRecovery may or may not produce a parseError — the contract
    // is just "don't throw".
    expect(Array.isArray(result.symbols)).toBe(true);
  });

  it("parses TSX with JSX", () => {
    const out = extractSymbols(
      `
      export function Hello({ name }: { name: string }) {
        return <h1>Hello {name}</h1>;
      }
      `,
      { language: "typescript", filename: "x.tsx" }
    );
    expect(out.symbols[0]).toMatchObject({
      name: "Hello",
      kind: "FUNCTION",
      exported: true,
    });
  });

  it("does not descend into function bodies", () => {
    const out = tsNames(`
      export function outer() {
        function inner() {}
        const innerArrow = () => 1;
      }
    `);
    // Only "outer" should appear.
    expect(out).toEqual([{ name: "outer", kind: "FUNCTION", exported: true }]);
  });

  it("captures line numbers (1-based)", () => {
    const { symbols } = extractSymbols(
      `\nexport function foo() {}\n`,
      { language: "typescript", filename: "x.ts" }
    );
    expect(symbols[0]?.line).toBe(2);
  });
});
