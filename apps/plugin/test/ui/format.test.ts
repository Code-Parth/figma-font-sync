import { describe, expect, test } from "bun:test";
import { formatBytes, formatDate, plural } from "../../src/ui/format";

describe("format", () => {
  test("plural", () => {
    expect(plural(1, "font")).toBe("1 font");
    expect(plural(0, "font")).toBe("0 fonts");
    expect(plural(2, "family", "families")).toBe("2 families");
  });

  test("formatDate falls back to the raw string when it cannot parse", () => {
    expect(formatDate("2026-10-01T10:00:00Z", "en-US")).toBe("Oct 1, 2026");
    expect(formatDate("not a date")).toBe("not a date");
  });

  test("formatBytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});
