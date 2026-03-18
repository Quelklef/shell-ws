import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderDisplay } from "./format";

describe("renderDisplay", () => {
  it("pretty prints json", () => {
    const result = renderDisplay(new TextEncoder().encode('{"ok":true}'));
    render(result.content);
    expect(screen.getByText(/"ok": true/)).toBeTruthy();
  });
});
