import { describe, expect, it } from "vitest";
import { nextStick } from "../followScroll.js";

describe("nextStick", () => {
  it("follows again once the reader is back near the bottom", () => {
    expect(nextStick(false, true, false)).toBe(true);
  });
  it("lets go only when the reader moves up away from the bottom", () => {
    expect(nextStick(true, false, true)).toBe(false);
  });
  it("keeps following when the layout changed but the reader did not scroll up", () => {
    expect(nextStick(true, false, false)).toBe(true);
    expect(nextStick(false, false, false)).toBe(false);
  });
});
