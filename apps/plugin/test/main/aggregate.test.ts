import { describe, expect, test } from "bun:test";
import { aggregateFonts, keyOf, NODE_ID_CAP, type TextNodeRecord } from "../../src/main/aggregate";
import type { FontKey, FontUsage } from "../../src/shared/messages";

const inter = { family: "Inter", style: "Regular" };
const interBold = { family: "Inter", style: "Bold" };
const roobert = { family: "Roobert", style: "Medium" };
const brand = { family: "Brand Sans", style: "Black" };

function node(
  nodeId: string,
  fonts: FontKey[],
  page: { id: string; name: string } = { id: "0:1", name: "Cover" },
  hasMissingFont = false,
): TextNodeRecord {
  return { pageId: page.id, pageName: page.name, nodeId, fonts, hasMissingFont };
}

const cover = { id: "0:1", name: "Cover" };
const screens = { id: "0:2", name: "Screens" };
const archive = { id: "0:3", name: "Archive" };

function availableSet(...fonts: FontKey[]): Set<string> {
  return new Set(fonts.map(keyOf));
}

function find(fonts: FontUsage[], font: FontKey): FontUsage {
  const found = fonts.find((usage) => usage.family === font.family && usage.style === font.style);
  if (!found) throw new Error(`no usage for ${font.family} ${font.style}`);
  return found;
}

describe("keyOf", () => {
  test("joins family and style with a NUL so no real name can collide", () => {
    expect(keyOf(inter)).toBe("Inter\u0000Regular");
    expect(keyOf({ family: "A B", style: "C" })).not.toBe(keyOf({ family: "A", style: "B C" }));
  });

  test("ignores variationSettings", () => {
    const variable = { family: "Inter", style: "Regular", variationSettings: { wght: 400 } };
    expect(keyOf(variable)).toBe(keyOf(inter));
  });
});

describe("aggregateFonts", () => {
  test("empty input gives an empty report", () => {
    const result = aggregateFonts([], [], new Set());
    expect(result.fonts).toEqual([]);
    expect(result.nodeIds.size).toBe(0);
  });

  test("a mixed-font node counts once for each of its fonts", () => {
    const { fonts } = aggregateFonts([node("1:1", [inter, interBold, roobert])], [], new Set());
    expect(fonts.map((usage) => [usage.family, usage.style, usage.nodeCount])).toEqual([
      ["Inter", "Bold", 1],
      ["Inter", "Regular", 1],
      ["Roobert", "Medium", 1],
    ]);
  });

  test("ranges that differ only in variationSettings count the node once", () => {
    const light = { family: "Inter", style: "Regular", variationSettings: { wght: 380 } };
    const heavy = { family: "Inter", style: "Regular", variationSettings: { wght: 420 } };
    const { fonts, nodeIds } = aggregateFonts([node("1:1", [light, heavy])], [], new Set());
    expect(fonts).toHaveLength(1);
    expect(fonts[0]?.nodeCount).toBe(1);
    expect(nodeIds.get(keyOf(inter))?.get(cover.id)).toEqual(["1:1"]);
  });

  test("output carries family and style only, never variationSettings", () => {
    const variable = { family: "Inter", style: "Regular", variationSettings: { wght: 400 } };
    const { fonts } = aggregateFonts([node("1:1", [variable])], [{ name: "Body", font: variable }], new Set());
    expect(Object.keys(fonts[0] ?? {}).sort()).toEqual(
      ["availableInFigma", "family", "missingNodeCount", "nodeCount", "pages", "style", "textStyles"].sort(),
    );
  });

  test("the same font across pages lists each page once, in first-seen order", () => {
    const { fonts } = aggregateFonts(
      [
        node("2:1", [inter], screens),
        node("1:1", [inter], cover),
        node("2:2", [inter], screens),
        node("3:1", [inter], archive),
      ],
      [],
      new Set(),
    );
    const usage = find(fonts, inter);
    expect(usage.nodeCount).toBe(4);
    expect(usage.pages).toEqual([screens, cover, archive]);
  });

  test("missingNodeCount counts nodes with hasMissingFont, per font they use", () => {
    const { fonts } = aggregateFonts(
      [
        node("1:1", [brand], cover, true),
        node("1:2", [brand], cover, true),
        node("1:3", [brand], cover, false),
        node("1:4", [inter, brand], cover, true),
        node("1:5", [inter], cover, false),
      ],
      [],
      availableSet(inter),
    );
    expect(find(fonts, brand)).toMatchObject({ nodeCount: 4, missingNodeCount: 3, availableInFigma: false });
    expect(find(fonts, inter)).toMatchObject({ nodeCount: 2, missingNodeCount: 1, availableInFigma: true });
  });

  test("a node listing the same font twice is one missing node, not two", () => {
    const { fonts } = aggregateFonts([node("1:1", [brand, brand], cover, true)], [], new Set());
    expect(find(fonts, brand)).toMatchObject({ nodeCount: 1, missingNodeCount: 1 });
  });

  test("text styles add their fonts even when no node uses them", () => {
    const { fonts, nodeIds } = aggregateFonts(
      [node("1:1", [inter])],
      [
        { name: "Body", font: inter },
        { name: "Display/Hero", font: brand },
      ],
      availableSet(inter),
    );
    expect(find(fonts, brand)).toEqual({
      family: "Brand Sans",
      style: "Black",
      nodeCount: 0,
      missingNodeCount: 0,
      pages: [],
      textStyles: ["Display/Hero"],
      availableInFigma: false,
    });
    expect(find(fonts, inter).textStyles).toEqual(["Body"]);
    expect(nodeIds.has(keyOf(brand))).toBe(false);
  });

  test("several styles on one font are all listed, duplicates once", () => {
    const { fonts } = aggregateFonts(
      [],
      [
        { name: "Body", font: inter },
        { name: "Caption", font: inter },
        { name: "Body", font: inter },
      ],
      new Set(),
    );
    expect(find(fonts, inter).textStyles).toEqual(["Body", "Caption"]);
  });

  test("availableInFigma comes from the available set, by family and style only", () => {
    const variable = { family: "Inter", style: "Regular", variationSettings: { wght: 400 } };
    const { fonts } = aggregateFonts([node("1:1", [inter, interBold])], [], new Set([keyOf(variable)]));
    expect(find(fonts, inter).availableInFigma).toBe(true);
    expect(find(fonts, interBold).availableInFigma).toBe(false);
  });

  test("availability is case-sensitive, as Figma's own font matching is", () => {
    const { fonts } = aggregateFonts([node("1:1", [{ family: "inter", style: "regular" }])], [], availableSet(inter));
    expect(fonts[0]?.availableInFigma).toBe(false);
  });

  test("sorts by family, then style, case-insensitively with a stable tie-break", () => {
    const input = [
      { family: "Roobert", style: "Medium" },
      { family: "inter", style: "Regular" },
      { family: "Inter", style: "Regular" },
      { family: "Inter", style: "bold" },
      { family: "Inter", style: "Black" },
      { family: "Brand Sans", style: "Black" },
      { family: "Inter Display", style: "Bold" },
    ];
    const { fonts } = aggregateFonts([node("1:1", input)], [], new Set());
    expect(fonts.map((usage) => `${usage.family}/${usage.style}`)).toEqual([
      "Brand Sans/Black",
      "Inter/Black",
      "Inter/bold",
      "Inter/Regular",
      "inter/Regular",
      "Inter Display/Bold",
      "Roobert/Medium",
    ]);
  });

  test("does not sort missing fonts first; that is the UI's call", () => {
    const { fonts } = aggregateFonts([node("1:1", [inter, brand])], [], availableSet(inter));
    expect(fonts.map((usage) => usage.family)).toEqual(["Brand Sans", "Inter"]);
  });

  test("node ids are grouped by page in document order", () => {
    const { nodeIds } = aggregateFonts(
      [
        node("1:1", [inter], cover),
        node("2:1", [inter, roobert], screens),
        node("1:2", [inter], cover),
        node("2:2", [roobert], screens),
      ],
      [],
      new Set(),
    );
    const interIds = nodeIds.get(keyOf(inter));
    expect([...(interIds?.keys() ?? [])]).toEqual([cover.id, screens.id]);
    expect(interIds?.get(cover.id)).toEqual(["1:1", "1:2"]);
    expect(interIds?.get(screens.id)).toEqual(["2:1"]);
    expect(nodeIds.get(keyOf(roobert))?.get(screens.id)).toEqual(["2:1", "2:2"]);
    expect(nodeIds.get(keyOf(roobert))?.has(cover.id)).toBe(false);
  });

  test("node ids stop at the cap per font across all pages, while counts keep going", () => {
    const records = [
      node("1:1", [inter], cover),
      node("1:2", [inter, roobert], cover),
      node("2:1", [inter], screens),
      node("2:2", [inter], screens),
      node("3:1", [inter], archive),
    ];
    const { fonts, nodeIds } = aggregateFonts(records, [], new Set(), 3);
    const interIds = nodeIds.get(keyOf(inter));
    expect(interIds?.get(cover.id)).toEqual(["1:1", "1:2"]);
    expect(interIds?.get(screens.id)).toEqual(["2:1"]);
    expect(interIds?.has(archive.id)).toBe(false);
    expect(find(fonts, inter).nodeCount).toBe(5);
    expect(find(fonts, inter).pages).toEqual([cover, screens, archive]);
    // The cap is per font: roobert's one id is unaffected by inter filling up.
    expect(nodeIds.get(keyOf(roobert))?.get(cover.id)).toEqual(["1:2"]);
  });

  test("the default cap is 5000", () => {
    expect(NODE_ID_CAP).toBe(5000);
    const records = Array.from({ length: NODE_ID_CAP + 10 }, (_, index) => node(`1:${index}`, [inter]));
    const { fonts, nodeIds } = aggregateFonts(records, [], new Set());
    expect(nodeIds.get(keyOf(inter))?.get(cover.id)).toHaveLength(NODE_ID_CAP);
    expect(find(fonts, inter).nodeCount).toBe(NODE_ID_CAP + 10);
  });

  test("accepts any iterable of records", () => {
    function* records() {
      yield node("1:1", [inter]);
      yield node("1:2", [inter]);
    }
    expect(aggregateFonts(records(), [], new Set()).fonts[0]?.nodeCount).toBe(2);
  });
});
