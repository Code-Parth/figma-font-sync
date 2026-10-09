import { describe, expect, it } from "bun:test";
import { FontParseError, MAX_FONT_BYTES, parseFont, sniffFormat } from "../../src/fonts/sfnt";
import type { Face } from "../../src/fonts/types";
import { buildCollection, buildFont, type FontSpec, findTable, nameTable, withTable } from "../support/font-builder";

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const keys = (faces: Face[]): string[] => faces.map((f) => `${f.family} / ${f.style}`);
const only = (bytes: Uint8Array): Face => {
  const { faces } = parseFont(bytes);
  expect(faces).toHaveLength(1);
  return faces[0] as Face;
};
const errorOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

/** Writes into a copy of `font`; checksums go stale, which the parser does not check. */
function patch(font: Uint8Array, tag: string, edit: (table: DataView) => void): Uint8Array {
  const copy = font.slice();
  const table = findTable(copy, tag);
  if (!table) throw new Error(`no ${tag} table`);
  edit(new DataView(copy.buffer, table.offset, table.length));
  return copy;
}

const inter: FontSpec = {
  names: { 1: "Inter Display Bold", 2: "Regular", 4: "Inter Display Bold", 6: "InterDisplay-Bold", 16: "Inter Display", 17: "Bold" },
  weight: 700,
};
const wght = { tag: "wght", min: 100, def: 400, max: 900 };

describe("sniffFormat", () => {
  it.each([
    ["ttcf", "ttc"],
    ["\0\x01\0\0", "ttf"],
    ["true", "ttf"],
    ["OTTO", "otf"],
    ["wOFF", "web"],
    ["wOF2", "web"],
    ["typ1", null],
    ["%PDF", null],
  ])("%j is %p", (signature, format) => {
    expect(sniffFormat(ascii(`${signature}rest of file`))).toBe(format as ReturnType<typeof sniffFormat>);
  });

  it("returns null for input shorter than a signature", () => {
    expect(sniffFormat(new Uint8Array())).toBeNull();
    expect(sniffFormat(ascii("OTT"))).toBeNull();
  });

  it("reads from the view's own offset", () => {
    expect(sniffFormat(ascii("xxxxOTTO").subarray(4))).toBe("otf");
  });
});

describe("parseFont naming", () => {
  it("uses typographic names 16/17 when present and keeps 1/2/4/6", () => {
    const font = buildFont(inter);
    expect(parseFont(font).format).toBe("ttf");
    expect(only(font)).toEqual({
      family: "Inter Display",
      style: "Bold",
      postscript: "InterDisplay-Bold",
      fullName: "Inter Display Bold",
      legacyFamily: "Inter Display Bold",
      legacyStyle: "Regular",
      weight: 700,
      italic: false,
      variable: false,
    });
  });

  it("falls back to 1/2 when 16/17 are absent", () => {
    const face = only(buildFont({ names: { 1: "Roobert TRIAL Heavy", 2: "Regular" }, flavor: "otf" }));
    expect([face.family, face.style]).toEqual(["Roobert TRIAL Heavy", "Regular"]);
    expect([face.postscript, face.fullName]).toEqual([null, null]);
    expect(parseFont(buildFont({ names: { 1: "A" }, flavor: "otf" })).format).toBe("otf");
  });

  it("takes each of family and style from the best ID independently", () => {
    expect(keys(parseFont(buildFont({ names: { 1: "Legacy", 2: "Bold", 16: "Typo" } })).faces)).toEqual(["Typo / Bold"]);
    expect(keys(parseFont(buildFont({ names: { 1: "Legacy", 2: "Bold", 17: "Heavy" } })).faces)).toEqual(["Legacy / Heavy"]);
  });

  it("calls a face with no subfamily name Regular", () => {
    expect(only(buildFont({ names: { 1: "Plain" } })).style).toBe("Regular");
  });

  it("falls back to Mac Roman records when there are no Windows names", () => {
    const face = only(buildFont({ names: {}, macNames: { 1: "Café Sans", 2: "Gras" } }));
    expect([face.family, face.style]).toEqual(["Café Sans", "Gras"]);
  });

  it("prefers Windows English over Mac", () => {
    expect(only(buildFont({ names: { 1: "Windows" }, macNames: { 1: "Mac" } })).family).toBe("Windows");
  });

  it("skips garbage and empty Windows records and falls through to Mac", () => {
    expect(only(buildFont({ names: { 1: "\u0001\u0010\u0002" }, macNames: { 1: "Clean" } })).family).toBe("Clean");
    expect(only(buildFont({ names: { 1: "", 2: "  " }, macNames: { 1: "Clean", 2: "Bold" } })).style).toBe("Bold");
  });

  it("strips trailing NULs and surrounding spaces", () => {
    expect(only(buildFont({ names: { 1: " Padded\u0000\u0000" } })).family).toBe("Padded");
  });

  it("ranks Windows English > Mac English > Unicode > Windows other languages", () => {
    const records = [
      { platform: 3, encoding: 1, language: 0x411, nameId: 1, text: "Japanese" },
      { platform: 0, encoding: 3, language: 0, nameId: 1, text: "Unicode" },
      { platform: 1, encoding: 0, language: 0, nameId: 1, text: "Mac" },
      { platform: 3, encoding: 10, language: 0x409, nameId: 1, text: "English" },
    ];
    const base = buildFont({ names: {} });
    const familyWith = (count: number) => only(withTable(base, "name", nameTable(records.slice(0, count)))).family;
    expect(familyWith(4)).toBe("English");
    expect(familyWith(3)).toBe("Mac");
    expect(familyWith(2)).toBe("Unicode");
    expect(familyWith(1)).toBe("Japanese");
  });

  it("ignores Mac records in other languages and legacy Windows code pages", () => {
    const font = withTable(
      buildFont({ names: {} }),
      "name",
      nameTable([
        { platform: 1, encoding: 0, language: 11, nameId: 1, text: "MacJapanese" },
        { platform: 3, encoding: 3, language: 0x804, nameId: 1, text: "PRC" },
        { platform: 3, encoding: 0, language: 0x409, nameId: 1, text: "Symbol" },
      ]),
    );
    expect(only(font).family).toBe("Symbol");
  });

  it("drops faces whose family starts with a dot", () => {
    expect(parseFont(buildFont({ names: { 1: ".SF NS", 2: "Regular" } })).faces).toEqual([]);
    const ttc = buildCollection([{ names: { 1: ".Hidden" } }, { names: { 1: "Visible" } }]);
    expect(keys(parseFont(ttc).faces)).toEqual(["Visible / Regular"]);
  });

  it("rejects a font with no family name at all", () => {
    expect(() => parseFont(buildFont({ names: { 2: "Bold" } }))).toThrow(FontParseError);
  });
});

describe("parseFont collections", () => {
  it("expands every member in order and reports ttc", () => {
    const ttc = buildCollection([
      { names: { 1: "Avenir Next", 2: "Regular" } },
      { names: { 1: "Avenir Next", 2: "Bold" }, weight: 700 },
      { names: { 1: "Avenir Next Condensed", 2: "Italic" }, italic: true, flavor: "otf" },
    ]);
    const parsed = parseFont(ttc);
    expect(parsed.format).toBe("ttc");
    expect(keys(parsed.faces)).toEqual(["Avenir Next / Regular", "Avenir Next / Bold", "Avenir Next Condensed / Italic"]);
    expect(parsed.faces.map((f) => [f.weight, f.italic])).toEqual([
      [400, false],
      [700, false],
      [400, true],
    ]);
  });

  it("keeps the first of identical {family, style} pairs within a file", () => {
    const ttc = buildCollection([
      { names: { 1: "Twin", 6: "Twin-First" } },
      { names: { 1: "Twin", 6: "Twin-Second" } },
    ]);
    expect(parseFont(ttc).faces.map((f) => f.postscript)).toEqual(["Twin-First"]);
  });

  it("rejects an empty collection", () => {
    const ttc = buildCollection([{ names: { 1: "A" } }]);
    new DataView(ttc.buffer).setUint32(8, 0);
    expect(() => parseFont(ttc)).toThrow(FontParseError);
  });
});

describe("parseFont variable fonts", () => {
  const names = { 1: "Inter", 2: "Regular", 4: "Inter Regular", 6: "Inter-Regular" };

  it("lists one face per named instance with its PostScript name", () => {
    const font = buildFont({
      names,
      fvar: {
        axes: [wght],
        instances: [
          { subfamily: "Thin", coords: [100], postscript: "Inter-Thin" },
          { subfamily: "Regular", coords: [400], postscript: "Inter-Regular" },
          { subfamily: "Bold", coords: [700], postscript: "Inter-Bold" },
        ],
      },
    });
    const faces = parseFont(font).faces;
    expect(keys(faces)).toEqual(["Inter / Thin", "Inter / Regular", "Inter / Bold"]);
    expect(faces.map((f) => [f.postscript, f.weight, f.variable])).toEqual([
      ["Inter-Thin", 100, true],
      ["Inter-Regular", 400, true],
      ["Inter-Bold", 700, true],
    ]);
  });

  it("gives instances a null PostScript name when the records carry none", () => {
    const instances = [
      { subfamily: "Light", coords: [300] },
      { subfamily: "Regular", coords: [400] },
    ];
    expect(parseFont(buildFont({ names, fvar: { axes: [wght], instances } })).faces.map((f) => f.postscript)).toEqual([
      null,
      null,
    ]);
    // 0xFFFF in a record that has the field also means "none".
    const mixed = [{ subfamily: "Light", coords: [300], postscript: "Inter-Light" }, ...instances.slice(1)];
    expect(parseFont(buildFont({ names, fvar: { axes: [wght], instances: mixed } })).faces.map((f) => f.postscript)).toEqual([
      "Inter-Light",
      null,
    ]);
  });

  it("keeps legacy names and the full name only on the default instance", () => {
    const font = buildFont({
      names,
      fvar: {
        axes: [wght],
        instances: [
          { subfamily: "Regular", coords: [400] },
          { subfamily: "Bold", coords: [700] },
        ],
      },
    });
    const [regular, bold] = parseFont(font).faces;
    expect([regular?.legacyFamily, regular?.legacyStyle, regular?.fullName]).toEqual(["Inter", "Regular", "Inter Regular"]);
    expect([bold?.legacyFamily, bold?.legacyStyle, bold?.fullName]).toEqual([null, null, null]);
  });

  it("adds the default instance first when no named instance sits on the default coordinates", () => {
    const font = buildFont({
      names: { ...names, 16: "Inter Variable", 17: "Book" },
      fvar: {
        axes: [wght],
        instances: [
          { subfamily: "Thin", coords: [100] },
          { subfamily: "Black", coords: [900] },
        ],
      },
    });
    const faces = parseFont(font).faces;
    expect(keys(faces)).toEqual(["Inter Variable / Book", "Inter Variable / Thin", "Inter Variable / Black"]);
    expect(faces[0]).toMatchObject({ postscript: "Inter-Regular", weight: 400, variable: true, legacyFamily: "Inter" });
  });

  it("lists only the default instance when fvar has axes but no instances", () => {
    const faces = parseFont(buildFont({ names, fvar: { axes: [wght], instances: [] } })).faces;
    expect(faces.map((f) => [f.style, f.variable])).toEqual([["Regular", true]]);
  });

  it("treats an fvar with no axes as a static font", () => {
    expect(only(buildFont({ names, fvar: { axes: [], instances: [] } })).variable).toBe(false);
  });

  it("reads the integer part of the wght coordinate, as Figma reports it", () => {
    const font = buildFont({ names, fvar: { axes: [wght], instances: [{ subfamily: "Light", coords: [274.315] }] } });
    expect(parseFont(font).faces.find((f) => f.style === "Light")?.weight).toBe(274);
  });

  it("uses the OS/2 weight for every instance when there is no wght axis", () => {
    const font = buildFont({
      names,
      weight: 500,
      fvar: { axes: [{ tag: "wdth", min: 75, def: 100, max: 100 }], instances: [{ subfamily: "Condensed", coords: [75] }] },
    });
    expect(parseFont(font).faces.map((f) => f.weight)).toEqual([500, 500]);
  });

  it("marks instances italic from ital = 1, slnt != 0, or an italic base font", () => {
    const axes = [wght, { tag: "ital", min: 0, def: 0, max: 1 }, { tag: "slnt", min: -10, def: 0, max: 0 }];
    const instances = [
      { subfamily: "Regular", coords: [400, 0, 0] },
      { subfamily: "Italic", coords: [400, 1, 0] },
      { subfamily: "Oblique", coords: [400, 0, -10] },
    ];
    const italics = (italic: boolean) =>
      parseFont(buildFont({ names, italic, fvar: { axes, instances } })).faces.map((f) => f.italic);
    expect(italics(false)).toEqual([false, true, true]);
    expect(italics(true)).toEqual([true, true, true]);
  });

  it("steps instance records by instanceSize, not by their minimum size", () => {
    // One axis, instanceSize 12: subfamilyNameID, flags, one coordinate, postScriptNameID, 2 bytes of padding.
    const fvar = new DataView(new ArrayBuffer(16 + 20 + 2 * 12));
    [1, 0, 16, 2, 1, 20, 2, 12].forEach((v, i) => fvar.setUint16(i * 2, v));
    fvar.setUint32(16, 0x77676874); // wght
    [100, 400, 900].forEach((v, i) => fvar.setInt32(20 + 4 * i, v * 65536));
    fvar.setUint16(34, 256);
    const instance = (offset: number, nameId: number, weight: number, psId: number) => {
      fvar.setUint16(offset, nameId);
      fvar.setInt32(offset + 4, weight * 65536);
      fvar.setUint16(offset + 8, psId);
      fvar.setUint16(offset + 10, 0xbeef);
    };
    instance(36, 257, 300, 259);
    instance(48, 258, 800, 260);
    const font = withTable(
      buildFont({ names: { 1: "Step", 256: "Weight", 257: "Light", 258: "Heavy", 259: "Step-Light", 260: "Step-Heavy" } }),
      "fvar",
      new Uint8Array(fvar.buffer),
    );
    expect(parseFont(font).faces.map((f) => [f.style, f.weight, f.postscript])).toEqual([
      ["Regular", 400, null],
      ["Light", 300, "Step-Light"],
      ["Heavy", 800, "Step-Heavy"],
    ]);
  });

  it("skips an instance whose name cannot be resolved", () => {
    const font = buildFont({
      names,
      fvar: {
        axes: [wght],
        instances: [
          { subfamily: "Regular", coords: [400] },
          { subfamily: "Bold", coords: [700] },
        ],
      },
    });
    // Second record: header 16 + one 20-byte axis + one 8-byte instance.
    const broken = patch(font, "fvar", (t) => t.setUint16(16 + 20 + 8, 999));
    expect(keys(parseFont(broken).faces)).toEqual(["Inter / Regular"]);
  });

  it("rejects an fvar whose records are too small or run past the table", () => {
    const font = buildFont({ names, fvar: { axes: [wght], instances: [{ subfamily: "Bold", coords: [700] }] } });
    expect(() => parseFont(patch(font, "fvar", (t) => t.setUint16(14, 6)))).toThrow(FontParseError);
    expect(() => parseFont(patch(font, "fvar", (t) => t.setUint16(12, 500)))).toThrow(FontParseError);
  });
});

describe("parseFont style bits", () => {
  const plain = { names: { 1: "Bits" } };

  it("reads usWeightClass and defaults to 400 without OS/2", () => {
    expect(only(buildFont({ ...plain, weight: 300 })).weight).toBe(300);
    expect(only(buildFont({ ...plain, weight: 300, omitTables: ["OS/2"] })).weight).toBe(400);
  });

  it("is italic from fsSelection ITALIC", () => {
    const font = patch(buildFont(plain), "OS/2", (t) => t.setUint16(62, 0x01));
    expect(only(font).italic).toBe(true);
  });

  it("is italic from fsSelection OBLIQUE", () => {
    const font = patch(buildFont(plain), "OS/2", (t) => t.setUint16(62, 0x200));
    expect(only(font).italic).toBe(true);
  });

  it("is italic from head.macStyle, with or without OS/2", () => {
    const font = patch(buildFont(plain), "head", (t) => t.setUint16(44, 0x02));
    expect(only(font).italic).toBe(true);
    expect(only(buildFont({ ...plain, italic: true, omitTables: ["OS/2", "post"] })).italic).toBe(true);
  });

  it("is italic from a non-zero post.italicAngle", () => {
    const font = patch(buildFont(plain), "post", (t) => t.setInt32(4, -6 * 65536));
    expect(only(font).italic).toBe(true);
  });

  it("is upright when no source says italic", () => {
    expect(only(buildFont(plain)).italic).toBe(false);
    expect(only(buildFont({ ...plain, omitTables: ["OS/2", "head", "post"] })).italic).toBe(false);
  });

  it("reads macStyle from an Apple 'bhed' table when there is no 'head'", () => {
    const font = buildFont({ ...plain, italic: true, omitTables: ["OS/2", "post"] });
    const head = findTable(font, "head");
    const bhed = withTable(withTable(font, "bhed", font.slice(head?.offset, (head?.offset ?? 0) + (head?.length ?? 0))), "head", null);
    expect(findTable(bhed, "head")).toBeNull();
    expect(only(bhed).italic).toBe(true);
  });

  it("tolerates a short OS/2 table", () => {
    const font = buildFont({ ...plain, weight: 600 });
    const os2 = findTable(font, "OS/2");
    const short = withTable(font, "OS/2", font.slice(os2?.offset, (os2?.offset ?? 0) + 10));
    expect(only(short)).toMatchObject({ weight: 600, italic: false });
  });
});

describe("parseFont rejects", () => {
  it("WOFF and WOFF2 with a conversion hint", () => {
    for (const signature of ["wOFF", "wOF2"]) {
      expect(() => parseFont(ascii(`${signature}${"\0".repeat(60)}`))).toThrow(
        new FontParseError("WOFF/WOFF2 is a web format; convert it to TTF or OTF first"),
      );
    }
  });

  it("anything that is not sfnt", () => {
    for (const input of [new Uint8Array(), ascii("\x89PNG\r\n\x1a\n"), ascii("typ1....")]) {
      expect(() => parseFont(input)).toThrow(FontParseError);
    }
  });

  it("input over MAX_FONT_BYTES before looking at it", () => {
    const big = new Uint8Array(MAX_FONT_BYTES + 1);
    big.set(buildFont({ names: { 1: "Big" } }));
    expect(() => parseFont(big)).toThrow("50 MB");
    expect(() => parseFont(big.subarray(0, MAX_FONT_BYTES))).not.toThrow();
  });

  it.each(["name", "cmap"])("a font without '%s'", (tag) => {
    expect(() => parseFont(buildFont({ names: { 1: "X" }, omitTables: [tag] }))).toThrow(new FontParseError(`The font has no '${tag}' table.`));
  });

  it("a font without any outline table", () => {
    expect(() => parseFont(buildFont({ names: { 1: "X" }, omitTables: ["glyf", "loca"] }))).toThrow("outlines");
    expect(() => parseFont(buildFont({ names: { 1: "X" }, flavor: "otf", omitTables: ["CFF "] }))).toThrow("outlines");
  });

  it("does not require 'head'", () => {
    expect(only(buildFont({ names: { 1: "Headless" }, omitTables: ["head"] })).family).toBe("Headless");
  });
});

describe("parseFont on damaged input", () => {
  const samples: [string, Uint8Array][] = [
    ["ttf", buildFont(inter)],
    ["otf", buildFont({ ...inter, flavor: "otf", macNames: { 1: "Inter Mac" } })],
    [
      "variable",
      buildFont({
        names: { 1: "Var" },
        fvar: { axes: [wght], instances: [{ subfamily: "Thin", coords: [100], postscript: "Var-Thin" }] },
      }),
    ],
    ["ttc", buildCollection([inter, { names: { 1: "Second" }, flavor: "otf" }])],
  ];

  /** Only FontParseError may escape: a RangeError or TypeError here is a parser bug. */
  const outcome = (bytes: Uint8Array): "ok" | "rejected" => {
    const error = errorOf(() => parseFont(bytes));
    if (error === null) return "ok";
    if (error instanceof FontParseError) return "rejected";
    throw error;
  };

  it.each(samples)("%s cut at every length throws only FontParseError", (_, font) => {
    const view = new DataView(font.buffer, font.byteOffset, font.byteLength);
    const directories = String.fromCharCode(...font.subarray(0, 4)) === "ttcf" ? view.getUint32(8) : 1;
    let dataEnd = 0;
    for (let member = 0; member < directories; member++) {
      for (const tag of ["OS/2", "cmap", "glyf", "CFF ", "head", "name", "post", "fvar", "loca", "maxp", "hhea", "hmtx"]) {
        const table = findTable(font, tag, member);
        if (table) dataEnd = Math.max(dataEnd, table.offset + table.length);
      }
    }
    for (let length = 0; length < font.length; length++) {
      // A subarray still has the cut-off bytes in its buffer; the parser must not read through to them.
      for (const cut of [font.slice(0, length), font.subarray(0, length)]) {
        const result = outcome(cut);
        if (length < dataEnd) expect(result).toBe("rejected");
      }
    }
  });

  it.each(samples)("%s with random byte damage throws only FontParseError", (_, font) => {
    // mulberry32: a fixed seed keeps failures reproducible.
    let seed = 0x5eed;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const counts = { ok: 0, rejected: 0 };
    for (let i = 0; i < 1500; i++) {
      const damaged = font.slice();
      const edits = 1 + Math.floor(random() * 8);
      for (let e = 0; e < edits; e++) damaged[Math.floor(random() * damaged.length)] = Math.floor(random() * 256);
      counts[outcome(damaged)]++;
    }
    expect(counts.rejected).toBeGreaterThan(0);
  });

  it("rejects absurd counts and offsets with FontParseError", () => {
    const font = buildFont(inter);
    const name = findTable(font, "name");
    const set = (bytes: Uint8Array, offset: number, value: number, size: 16 | 32) => {
      const copy = bytes.slice();
      const view = new DataView(copy.buffer);
      if (size === 16) view.setUint16(offset, value);
      else view.setUint32(offset, value);
      return copy;
    };
    expect(() => parseFont(set(font, 4, 0xffff, 16))).toThrow(FontParseError); // numTables
    expect(() => parseFont(set(font, 12 + 8, 0xfffffff0, 32))).toThrow(FontParseError); // first table offset
    expect(() => parseFont(set(font, 12 + 12, 0xfffffff0, 32))).toThrow(FontParseError); // first table length
    expect(() => parseFont(set(font, (name?.offset ?? 0) + 2, 0xffff, 16))).toThrow(FontParseError); // name count
    expect(() => parseFont(set(buildCollection([inter]), 8, 0xffffffff, 32))).toThrow(FontParseError); // numFonts
    expect(() => parseFont(set(buildCollection([inter]), 12, 0xfffffff0, 32))).toThrow(FontParseError); // directory offset
  });

  it("skips a name record that points outside the table and uses the next rank", () => {
    const font = buildFont({ names: { 1: "Windows" }, macNames: { 1: "Mac" } });
    // Records are sorted by platform: Mac (1,0,0) first, Windows second. Point Windows' string far away.
    const damaged = patch(font, "name", (t) => t.setUint16(6 + 12 + 10, 0xfff0));
    expect(only(damaged).family).toBe("Mac");
    // With the storage offset past the table every record is unusable, so there is no family left.
    expect(() => parseFont(patch(font, "name", (t) => t.setUint16(4, 0xfff0)))).toThrow("no family name");
  });

  it("parses a font that sits at an offset inside a larger buffer", () => {
    const font = buildFont(inter);
    const host = new Uint8Array(font.length + 13);
    host.set(font, 7);
    expect(only(host.subarray(7, 7 + font.length)).family).toBe("Inter Display");
  });
});
