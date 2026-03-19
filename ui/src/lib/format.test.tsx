import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderDisplay } from "./format";

describe("renderDisplay", () => {
  it("pretty prints json", () => {
    const result = renderDisplay(new TextEncoder().encode('{"ok":true}'));
    render(result.content);
    expect(screen.getByText(/"ok": true/)).toBeTruthy();
  });

  it("renders csv as a table", () => {
    const result = renderDisplay(new TextEncoder().encode("name,age\nalice,30\nbob,41\n"));
    render(result.content);
    expect(screen.getByRole("table")).toBeTruthy();
    expect(screen.getByText("name")).toBeTruthy();
    expect(screen.getByText("alice")).toBeTruthy();
    expect(screen.getByText("41")).toBeTruthy();
  });
});
