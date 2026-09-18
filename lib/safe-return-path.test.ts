import { describe, expect, it } from "vitest";
import { safeReturnPath } from "./safe-return-path";

describe("safeReturnPath", () => {
  it("preserves same-origin relative paths with query and fragment", () => {
    expect(safeReturnPath("/team/invite?token=abc#accept", "/dashboard"))
      .toBe("/team/invite?token=abc#accept");
  });

  it("rejects absolute, protocol-relative, and backslash-normalized destinations", () => {
    expect(safeReturnPath("https://evil.example/path", "/dashboard")).toBe("/dashboard");
    expect(safeReturnPath("//evil.example/path", "/dashboard")).toBe("/dashboard");
    expect(safeReturnPath("/\\evil.example/path", "/dashboard")).toBe("/dashboard");
    expect(safeReturnPath("/foo\\bar", "/dashboard")).toBe("/dashboard");
  });

  it("falls back for empty or malformed values", () => {
    expect(safeReturnPath(null, "/dashboard")).toBe("/dashboard");
    expect(safeReturnPath("", "/dashboard")).toBe("/dashboard");
    expect(safeReturnPath("dashboard", "/dashboard")).toBe("/dashboard");
  });
});
