import { describe, expect, it } from "vitest";

import { encodeId } from "./utils";

describe("utils", () => {
  it("encodes compact base62 ids", () => {
    const id = encodeId("node-text");
    const parts = id.split("-");
    expect(parts[0]).toBe("node");
    expect(parts[1]).toBe("text");
    expect(parts[2]).toMatch(/^[0-9A-Za-z]+$/);
    expect(parts[3]).toMatch(/^[0-9A-Za-z]+$/);
  });

  it("produces distinct ids", () => {
    expect(encodeId("edge")).not.toBe(encodeId("edge"));
  });
});
