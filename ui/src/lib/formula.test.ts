import { describe, expect, it } from "vitest";
import { analyzeFormula } from "./formula";

describe("formula analysis", () => {
  it("parses let bindings and inlines them into TeX", () => {
    const result = analyzeFormula("let x = $1 + 2; y = x^2 in sqrt(y)");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tex).toContain("\\sqrt");
      expect(result.tex).toContain("\\mathrm{\\$1}");
      expect(result.tex).not.toContain("\\mathrm{x}");
    }
  });

  it("reports parse errors", () => {
    const result = analyzeFormula("let x = in 2");
    expect(result.ok).toBe(false);
  });
});
