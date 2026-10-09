import { describe, expect, it } from "bun:test";
import { FaceIndex, keyOf, normalizeFamily, normalizeStyle } from "../../src/fonts/match";
import type { Face } from "../../src/fonts/types";

const face = (family: string, style: string, extra: Partial<Face> = {}): Face => ({
  family,
  style,
  postscript: null,
  fullName: null,
  legacyFamily: null,
  legacyStyle: null,
  weight: 400,
  italic: false,
  variable: false,
  ...extra,
});

describe("normalizers", () => {
  it.each(["SemiBold", "Semibold", "Semi Bold", "semi-bold", "Semi_Bold", " SEMI\tBOLD "])("style %j is semibold", (style) => {
    expect(normalizeStyle(style)).toBe("semibold");
  });

  it("applies NFKC before case folding", () => {
    expect(normalizeStyle("Ｂｏｌｄ")).toBe("bold"); // fullwidth "Bold"
    expect(normalizeFamily("Café Sans")).toBe("café sans");
  });

  it("collapses but keeps spaces in families", () => {
    expect(normalizeFamily("  Inter \t  Display ")).toBe("inter display");
    expect(normalizeFamily("InterDisplay")).not.toBe(normalizeFamily("Inter Display"));
  });

  it("keyOf joins with a NUL that no name contains", () => {
    expect(keyOf({ family: "A B", style: "C" })).not.toBe(keyOf({ family: "A", style: "B C" }));
  });
});

describe("FaceIndex", () => {
  it("matches exactly first", () => {
    const index = new FaceIndex([{ face: face("Inter", "SemiBold"), ref: "a" }]);
    expect(index.match({ family: "Inter", style: "SemiBold" })).toMatchObject({ ref: "a", tier: "exact" });
  });

  it("matches across case, spacing and separators at the normalized tier", () => {
    const index = new FaceIndex([{ face: face("SF Pro", "Compressed Semibold"), ref: "sf" }]);
    expect(index.match({ family: "sf  pro", style: "Compressed Semi-Bold" })).toMatchObject({ ref: "sf", tier: "normalized" });
    expect(index.match({ family: "SFPro", style: "Compressed Semibold" })).toBeNull();
  });

  it("matches the legacy 1/2 pair at the alias tier", () => {
    const roobert = face("Roobert TRIAL", "Heavy", { legacyFamily: "Roobert TRIAL Heavy", legacyStyle: "Regular" });
    const index = new FaceIndex([{ face: roobert, ref: 1 }]);
    expect(index.match({ family: "Roobert TRIAL Heavy", style: "Regular" })).toEqual({ ref: 1, face: roobert, tier: "alias" });
    expect(index.match({ family: "roobert trial heavy", style: "REGULAR" })?.tier).toBe("alias");
  });

  it("matches a family/style split of the full name at the alias tier", () => {
    // A library file with only legacy names, queried with the typographic pair a newer build produces.
    const legacyOnly = face("Roobert TRIAL Heavy", "Regular", { fullName: "Roobert TRIAL Heavy" });
    const index = new FaceIndex([{ face: legacyOnly, ref: "r" }]);
    expect(index.match({ family: "Roobert TRIAL", style: "Heavy" })).toMatchObject({ ref: "r", tier: "alias" });
    expect(index.match({ family: "Roobert", style: "TRIAL Heavy" })).toMatchObject({ ref: "r", tier: "alias" });
    expect(index.match({ family: "Roobert TRIAL Heavy", style: "" })).toBeNull();
    expect(index.match({ family: "Roobert TRIAL", style: "Bold" })).toBeNull();
  });

  it("skips alias keys for missing names", () => {
    const index = new FaceIndex([{ face: face("Solo", "Regular", { legacyFamily: "Solo" }), ref: 0 }]);
    expect(index.match({ family: "Solo", style: "" })).toBeNull();
  });

  it("prefers an exact hit over an earlier normalized one", () => {
    const index = new FaceIndex([
      { face: face("Inter", "Semibold"), ref: "normalized" },
      { face: face("Inter", "SemiBold"), ref: "exact" },
    ]);
    expect(index.match({ family: "Inter", style: "SemiBold" })).toMatchObject({ ref: "exact", tier: "exact" });
  });

  it("prefers a normalized hit over an earlier alias", () => {
    const index = new FaceIndex([
      { face: face("Other", "Regular", { legacyFamily: "Inter", legacyStyle: "Bold" }), ref: "alias" },
      { face: face("inter", "bold"), ref: "normalized" },
    ]);
    expect(index.match({ family: "Inter", style: "Bold" })).toMatchObject({ ref: "normalized", tier: "normalized" });
  });

  it("keeps the first entry within a tier", () => {
    const index = new FaceIndex([
      { face: face("Inter", "Bold"), ref: "first" },
      { face: face("Inter", "Bold"), ref: "second" },
      { face: face("A", "B", { legacyFamily: "Legacy", legacyStyle: "Regular" }), ref: "alias-first" },
      { face: face("C", "D", { fullName: "Legacy Regular" }), ref: "alias-second" },
    ]);
    expect(index.match({ family: "Inter", style: "Bold" })?.ref).toBe("first");
    expect(index.match({ family: "inter", style: "bold" })?.ref).toBe("first");
    expect(index.match({ family: "Legacy", style: "Regular" })?.ref).toBe("alias-first");
  });

  it("accepts any iterable and returns null on a miss", () => {
    function* entries() {
      yield { face: face("Gen", "Regular"), ref: 1 };
    }
    const index = new FaceIndex(entries());
    expect(index.match({ family: "Gen", style: "Regular" })?.ref).toBe(1);
    expect(index.match({ family: "Gen", style: "Bold" })).toBeNull();
    expect(new FaceIndex([]).match({ family: "Gen", style: "Regular" })).toBeNull();
  });
});
