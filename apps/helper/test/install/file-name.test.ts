import { describe, expect, it } from "bun:test";
import { installFileName } from "../../src/install";
import { face } from "./support";

const MD5 = "0123456789abcdef0123456789abcdef";
const SAFE = /^[A-Za-z0-9_-]+-[0-9a-f]{8}\.(ttf|otf|ttc)$/;

describe("installFileName", () => {
  it("uses the first face's PostScript name, the md5 prefix and the format", () => {
    expect(installFileName({ md5: MD5, format: "otf", faces: [face()], sourceName: "x.otf" })).toBe(
      "Inter-Bold-01234567.otf",
    );
    expect(installFileName({ md5: MD5, format: "ttf", faces: [face()], sourceName: "x" })).toEndWith(".ttf");
    expect(installFileName({ md5: MD5, format: "ttc", faces: [face()], sourceName: "x" })).toEndWith(".ttc");
  });

  it("lowercases the md5", () => {
    expect(installFileName({ md5: MD5.toUpperCase(), format: "ttf", faces: [face()], sourceName: "" })).toBe(
      "Inter-Bold-01234567.ttf",
    );
  });

  it("falls back to the source name without its extension when there is no PostScript name", () => {
    const name = installFileName({
      md5: MD5,
      format: "ttf",
      faces: [face({ postscript: null })],
      sourceName: "Brand Sans Regular.TTF",
    });
    expect(name).toBe("Brand_Sans_Regular-01234567.ttf");
    expect(installFileName({ md5: MD5, format: "ttf", faces: [], sourceName: "Brand.otf" })).toBe(
      "Brand-01234567.ttf",
    );
  });

  it("removes path separators and traversal", () => {
    for (const sourceName of ["../../etc/passwd", "..\\..\\Windows\\System32\\x.ttf", "a/b\\c.ttf", "..", "."]) {
      const name = installFileName({ md5: MD5, format: "ttf", faces: [], sourceName });
      expect(name).toMatch(SAFE);
      expect(name).not.toContain("/");
      expect(name).not.toContain("\\");
      expect(name).not.toContain("..");
    }
    expect(installFileName({ md5: MD5, format: "ttf", faces: [face({ postscript: "../x" })], sourceName: "" })).toBe(
      "x-01234567.ttf",
    );
  });

  it("keeps a single dot, so Windows device names and hidden files cannot appear", () => {
    expect(installFileName({ md5: MD5, format: "ttf", faces: [], sourceName: "NUL.x.ttf" })).toBe("NUL_x-01234567.ttf");
    expect(installFileName({ md5: MD5, format: "ttf", faces: [], sourceName: ".hidden.ttf" })).toBe(
      "hidden-01234567.ttf",
    );
    expect(installFileName({ md5: MD5, format: "ttf", faces: [], sourceName: "-rf.ttf" })).toBe("rf-01234567.ttf");
  });

  it("transliterates accents and drops other unicode", () => {
    expect(installFileName({ md5: MD5, format: "ttf", faces: [], sourceName: "Café Ünïcode.ttf" })).toBe(
      "Cafe_Unicode-01234567.ttf",
    );
    expect(installFileName({ md5: MD5, format: "ttf", faces: [], sourceName: "源ノ角ゴシック.otf" })).toBe(
      "font-01234567.ttf",
    );
    expect(installFileName({ md5: MD5, format: "otf", faces: [face({ postscript: "" })], sourceName: "" })).toBe(
      "font-01234567.otf",
    );
  });

  it("caps the name at 120 characters", () => {
    const faces = [face({ postscript: "A".repeat(500) })];
    const name = installFileName({ md5: MD5, format: "ttf", faces, sourceName: "" });
    expect(name.length).toBe(120);
    expect(name).toMatch(SAFE);
    expect(name).toEndWith("-01234567.ttf");
  });

  it("does not leave a separator before the hash after truncation", () => {
    const postscript = `${"A".repeat(106)}-B`;
    expect(installFileName({ md5: MD5, format: "ttf", faces: [face({ postscript })], sourceName: "" })).toBe(
      `${"A".repeat(106)}-01234567.ttf`,
    );
  });

  it("rejects an md5 that is not hex", () => {
    expect(() => installFileName({ md5: "../../evil", format: "ttf", faces: [face()], sourceName: "" })).toThrow();
  });
});
