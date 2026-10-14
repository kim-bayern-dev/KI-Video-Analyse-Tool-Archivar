import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/csr/lib/markdown";

describe("renderMarkdown: LaTeX math support", () => {
  it("renders inline LaTeX ($\\rightarrow$) via KaTeX instead of raw source", () => {
    const html = renderMarkdown(
      "Einführung des Themas $\\rightarrow$ Vorstellung des Kernkonzepts",
    );
    expect(html).toContain("katex");
    expect(html).not.toContain("$\\rightarrow$");
  });

  it("renders the narrative-arc sentence without leaking math delimiters", () => {
    const html = renderMarkdown(
      "Der narrative Bogen ist linear: Einführung $\\rightarrow$ Kernkonzept $\\rightarrow$ Analogie (Glasglocke).",
    );
    expect(html).not.toContain("$\\");
    expect((html.match(/katex/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("leaves currency-style dollar amounts untouched", () => {
    const html = renderMarkdown("Das kostet $5 und $10.");
    expect(html).not.toContain("katex");
    expect(html).toContain("$5");
  });

  it("renders block math ($$...$$) in display mode", () => {
    const html = renderMarkdown("Formel:\n\n$$E = mc^2$$");
    expect(html).toContain("katex-display");
  });
});
