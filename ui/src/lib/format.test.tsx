import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderDisplay } from "./format";

describe("renderDisplay", () => {
  it("pretty prints json", () => {
    const result = renderDisplay(new TextEncoder().encode('{"ok":true}'));
    render(result.content);
    expect(result.label).toBe("json");
    expect(screen.getByText(/"ok":/)).toBeTruthy();
    expect(document.querySelectorAll(".display-token-key").length).toBeGreaterThan(0);
  });

  it("renders jsona as highlighted structured text", () => {
    const result = renderDisplay(new TextEncoder().encode('{"ok":true}\n42\n'));
    expect(result.label).toBe("jsona");
    render(result.content);
    expect(document.querySelectorAll(".display-token-key").length).toBeGreaterThan(0);
    expect(screen.getByText("42")).toBeTruthy();
  });

  it("renders csv as a table", () => {
    const result = renderDisplay(new TextEncoder().encode("name,age\nalice,30\nbob,41\n"));
    render(result.content);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("name")).toBeTruthy();
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getByText("41")).toBeTruthy();
  });

  it("renders ansi-colored text as styled segments", () => {
    const result = renderDisplay(new TextEncoder().encode("plain \u001b[31mred\u001b[0m tail"));
    const view = render(result.content);
    expect(result.label).toBe("colored text");
    const redSegment = screen.getByText("red");
    expect(redSegment.className).toContain("display-ansi-segment");
    expect((redSegment as HTMLElement).style.color).toBeTruthy();
    expect(view.container.textContent).toBe("plain red tail");
  });
});
