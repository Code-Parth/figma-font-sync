import { describe, expect, it } from "bun:test";
import { buildCollection, buildFont, findTable, nameTable, withTable } from "../support/font-builder";

const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const tagAt = (bytes: Uint8Array, offset: number): string => String.fromCharCode(...bytes.subarray(offset, offset + 4));

function directory(bytes: Uint8Array, offset: number): { tag: string; checksum: number; offset: number; length: number }[] {
  const v = view(bytes);
  return Array.from({ length: v.getUint16(offset + 4) }, (_, i) => {
    const r = offset + 12 + 16 * i;
    return { tag: tagAt(bytes, r), checksum: v.getUint32(r + 4), offset: v.getUint32(r + 8), length: v.getUint32(r + 12) };
  });
}

function checksum(bytes: Uint8Array): number {
  const padded = new Uint8Array(Math.ceil(bytes.length / 4) * 4);
  padded.set(bytes);
  const v = view(padded);
  let sum = 0;
  for (let i = 0; i < padded.length; i += 4) sum = (sum + v.getUint32(i)) >>> 0;
  return sum;
}

const spec = { names: { 1: "Builder Sans", 2: "Regular" } };

describe("buildFont", () => {
  it("writes a sorted, aligned, checksummed table directory", () => {
    const font = buildFont(spec);
    expect(view(font).getUint32(0)).toBe(0x00010000);
    const tables = directory(font, 0);
    const tags = tables.map((t) => t.tag);
    expect(tags).toEqual([...tags].sort());
    expect(tags).toEqual(["OS/2", "cmap", "glyf", "head", "hhea", "hmtx", "loca", "maxp", "name", "post"]);
    for (const t of tables) {
      expect(t.offset % 4).toBe(0);
      expect(t.offset + t.length).toBeLessThanOrEqual(font.length);
      if (t.tag !== "head") expect(t.checksum).toBe(checksum(font.subarray(t.offset, t.offset + t.length)));
    }
    // checkSumAdjustment makes the whole file sum to the spec's magic constant.
    expect(checksum(font)).toBe(0xb1b0afba);
  });

  it("writes head, OS/2 and the style bits from the spec", () => {
    const font = buildFont({ ...spec, weight: 700, width: 3, italic: true });
    const v = view(font);
    const head = findTable(font, "head");
    const os2 = findTable(font, "OS/2");
    expect(head?.length).toBe(54);
    expect(v.getUint32((head?.offset ?? 0) + 12)).toBe(0x5f0f3cf5);
    expect(v.getUint16((head?.offset ?? 0) + 44)).toBe(0b11);
    expect(os2?.length).toBe(96);
    expect(v.getUint16(os2?.offset ?? 0)).toBe(4);
    expect(v.getUint16((os2?.offset ?? 0) + 4)).toBe(700);
    expect(v.getUint16((os2?.offset ?? 0) + 6)).toBe(3);
    expect(v.getUint16((os2?.offset ?? 0) + 62)).toBe(0x21);
  });

  it("writes OTTO and a CFF table for otf", () => {
    const font = buildFont({ ...spec, flavor: "otf" });
    expect(tagAt(font, 0)).toBe("OTTO");
    expect(findTable(font, "CFF ")).not.toBeNull();
    expect(findTable(font, "glyf")).toBeNull();
    expect(findTable(font, "maxp")?.length).toBe(6);
  });

  it("omits tables on request", () => {
    const font = buildFont({ ...spec, omitTables: ["OS/2", "cmap"] });
    expect(findTable(font, "OS/2")).toBeNull();
    expect(findTable(font, "cmap")).toBeNull();
    expect(findTable(font, "name")).not.toBeNull();
  });

  it("adds a postScriptNameID to every instance only when one instance has a PostScript name", () => {
    const axes = [{ tag: "wght", min: 100, def: 400, max: 900 }];
    const without = buildFont({ ...spec, fvar: { axes, instances: [{ subfamily: "Thin", coords: [100] }] } });
    const withPs = buildFont({
      ...spec,
      fvar: { axes, instances: [{ subfamily: "Thin", coords: [100], postscript: "B-Thin" }, { subfamily: "Bold", coords: [700] }] },
    });
    expect(view(without).getUint16((findTable(without, "fvar")?.offset ?? 0) + 14)).toBe(8);
    expect(view(withPs).getUint16((findTable(withPs, "fvar")?.offset ?? 0) + 14)).toBe(10);
  });

  it("rejects instances whose coordinate count does not match the axes", () => {
    const fvar = { axes: [{ tag: "wght", min: 100, def: 400, max: 900 }], instances: [{ subfamily: "X", coords: [1, 2] }] };
    expect(() => buildFont({ ...spec, fvar })).toThrow("coords");
  });

  it("refuses Mac names that Mac Roman cannot encode", () => {
    expect(() => buildFont({ names: {}, macNames: { 1: "中文" } })).toThrow("Mac Roman");
  });
});

describe("buildCollection", () => {
  it("writes a ttcf v1 header whose table offsets are absolute and shares identical tables", () => {
    const ttc = buildCollection([spec, { names: { 1: "Builder Sans", 2: "Bold" }, weight: 700 }]);
    const v = view(ttc);
    expect(tagAt(ttc, 0)).toBe("ttcf");
    expect(v.getUint16(4)).toBe(1);
    expect(v.getUint16(6)).toBe(0);
    expect(v.getUint32(8)).toBe(2);
    const [first, second] = [0, 1].map((i) => directory(ttc, v.getUint32(12 + 4 * i)));
    for (const t of [...(first ?? []), ...(second ?? [])]) {
      expect(t.offset).toBeGreaterThanOrEqual(12 + 8);
      expect(t.offset + t.length).toBeLessThanOrEqual(ttc.length);
    }
    const offsetOf = (tables: typeof first, tag: string) => tables?.find((t) => t.tag === tag)?.offset;
    expect(offsetOf(first, "cmap")).toBe(offsetOf(second, "cmap"));
    expect(offsetOf(first, "name")).not.toBe(offsetOf(second, "name"));
    expect(findTable(ttc, "name", 1)?.offset).toBe(offsetOf(second, "name"));
  });

  it("writes a collection header even for one font", () => {
    expect(tagAt(buildCollection([spec]), 0)).toBe("ttcf");
  });
});

describe("withTable and nameTable", () => {
  it("replaces, adds and removes tables", () => {
    const font = buildFont(spec);
    const names = nameTable([{ platform: 0, encoding: 3, language: 0, nameId: 1, text: "Other" }]);
    const replaced = withTable(font, "name", names);
    const located = findTable(replaced, "name");
    expect(replaced.subarray(located?.offset, (located?.offset ?? 0) + (located?.length ?? 0))).toEqual(names);
    expect(findTable(withTable(font, "head", null), "head")).toBeNull();
    expect(findTable(withTable(font, "bhed", new Uint8Array(54)), "bhed")?.length).toBe(54);
  });
});
