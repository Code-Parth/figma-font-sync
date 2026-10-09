import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { keyOf } from "../../src/main/aggregate";
import { lastScanNodeIds, scanFonts } from "../../src/main/scan";
import { selectFont } from "../../src/main/select";
import type { ScanOptions } from "../../src/shared/messages";
import { createFigma, type FakeFigma, installFigma, text } from "./fake-figma";

const inter = { family: "Inter", style: "Regular" };
const interBold = { family: "Inter", style: "Bold" };
const brand = { family: "Brand Sans", style: "Black" };

const documentScope: ScanOptions = { scope: "document", deep: false };

function twoPageFile(overrides: Partial<Parameters<typeof createFigma>[0]> = {}): FakeFigma {
  return createFigma({
    fileName: "Marketing site",
    pages: [
      { id: "0:1", name: "Cover", nodes: [text("1:1", inter), text("1:2", [inter, brand], { missing: true })] },
      {
        id: "0:2",
        name: "Screens",
        nodes: [
          text("2:1", brand, { missing: true, type: "TEXT_PATH" }),
          text("2:2", interBold, { hidden: true }),
        ],
      },
    ],
    available: [inter, interBold, { family: "Roobert", style: "Medium" }],
    ...overrides,
  });
}

async function scan(fake: FakeFigma, options: ScanOptions = documentScope) {
  installFigma(fake);
  const progress: [number, number][] = [];
  const report = await scanFonts(options, (done, total) => progress.push([done, total]));
  return { report, progress };
}

afterAll(() => {
  Reflect.deleteProperty(globalThis, "figma");
  Reflect.deleteProperty(globalThis, "__html__");
});

describe("scanFonts", () => {
  test("document scope loads and reads every page, reporting progress per page", async () => {
    const fake = twoPageFile();
    const { report, progress } = await scan(fake);

    expect(fake.page("0:2").loaded).toBe(true);
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
    expect(report).toMatchObject({ fileName: "Marketing site", scope: "document", deep: false, nodeCount: 3 });
    expect(report.scannedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(report.fonts.map((usage) => [usage.family, usage.style, usage.nodeCount, usage.missingNodeCount])).toEqual([
      ["Brand Sans", "Black", 2, 2],
      ["Inter", "Regular", 2, 1],
    ]);
    expect(report.fonts[0]).toMatchObject({
      availableInFigma: false,
      pages: [
        { id: "0:1", name: "Cover" },
        { id: "0:2", name: "Screens" },
      ],
    });
  });

  test("falls back to text nodes when the runtime rejects TEXT_PATH, asking only once per scan", async () => {
    const fake = twoPageFile({ rejectTextPath: true });
    const { report } = await scan(fake);

    expect(fake.calls.textPathRejected).toBe(1);
    // The text-path node 2:1 cannot be found, so Brand Sans is counted from 1:2 alone.
    expect(report.nodeCount).toBe(2);
    expect(report.fonts.map((usage) => [usage.family, usage.style, usage.nodeCount])).toEqual([
      ["Brand Sans", "Black", 1],
      ["Inter", "Regular", 2],
    ]);
  });

  test("page scope reads only the current page", async () => {
    const fake = twoPageFile({ currentPageId: "0:2" });
    const { report, progress } = await scan(fake, { scope: "page", deep: true });

    expect(fake.page("0:1").loaded).toBe(false);
    expect(progress).toEqual([
      [0, 1],
      [1, 1],
    ]);
    expect(report.scope).toBe("page");
    expect(report.fonts.map((usage) => `${usage.family}/${usage.style}`)).toEqual(["Brand Sans/Black", "Inter/Bold"]);
  });

  test("deep includes hidden instance children; shallow skips them", async () => {
    const shallow = await scan(twoPageFile());
    expect(shallow.report.fonts.some((usage) => usage.style === "Bold")).toBe(false);

    const fake = twoPageFile();
    const deep = await scan(fake, { scope: "document", deep: true });
    expect(deep.report.nodeCount).toBe(4);
    expect(deep.report.fonts.find((usage) => usage.style === "Bold")?.availableInFigma).toBe(true);
    expect(fake.page("0:1").skipSeen).toEqual([false]);
  });

  test("restores skipInvisibleInstanceChildren afterwards", async () => {
    const fake = twoPageFile({ skipInvisibleInstanceChildren: true });
    await scan(fake, { scope: "document", deep: true });
    expect(fake.page("0:2").skipSeen).toEqual([false]);
    expect(fake.skipInvisibleInstanceChildren).toBe(true);

    const other = twoPageFile({ skipInvisibleInstanceChildren: false });
    await scan(other, documentScope);
    expect(other.page("0:1").skipSeen).toEqual([true]);
    expect(other.skipInvisibleInstanceChildren).toBe(false);
  });

  test("restores skipInvisibleInstanceChildren when the scan fails, and keeps the previous node ids", async () => {
    await scan(twoPageFile());
    const before = lastScanNodeIds();

    const fake = twoPageFile({ skipInvisibleInstanceChildren: true });
    fake.failNext.listAvailableFonts = new Error("font list unavailable");
    installFigma(fake);
    await expect(scanFonts({ scope: "document", deep: true }, () => {})).rejects.toThrow("font list unavailable");
    expect(fake.skipInvisibleInstanceChildren).toBe(true);
    expect(lastScanNodeIds()).toBe(before);
  });

  test("mixed nodes are read with getRangeAllFontNames over all characters", async () => {
    const mixed = text("1:9", [inter, brand], { characters: "Hello world" });
    const fake = createFigma({ pages: [{ id: "0:1", name: "Cover", nodes: [mixed] }], available: [inter] });
    const { report } = await scan(fake);
    expect(mixed.rangeCalls).toEqual([[0, 11]]);
    expect(report.fonts).toHaveLength(2);
  });

  test("availability ignores variationSettings on both sides", async () => {
    const variableNode = { family: "Inter", style: "Regular", variationSettings: { wght: 420 } };
    const fake = createFigma({
      pages: [{ id: "0:1", name: "Cover", nodes: [text("1:1", variableNode)] }],
      available: [{ family: "Inter", style: "Regular", variationSettings: { wght: 400 } }],
    });
    const { report } = await scan(fake);
    expect(report.fonts).toEqual([
      {
        family: "Inter",
        style: "Regular",
        nodeCount: 1,
        missingNodeCount: 0,
        pages: [{ id: "0:1", name: "Cover" }],
        textStyles: [],
        availableInFigma: true,
      },
    ]);
  });

  test("local text styles are reported even when nothing uses them", async () => {
    const fake = twoPageFile({
      styles: [
        { name: "Body", fontName: inter },
        { name: "Legacy/Heading", fontName: { family: "Old Grotesk", style: "Bold" } },
      ],
    });
    const { report } = await scan(fake);
    expect(report.fonts.find((usage) => usage.family === "Old Grotesk")).toMatchObject({
      nodeCount: 0,
      textStyles: ["Legacy/Heading"],
      availableInFigma: false,
    });
    expect(report.fonts.find((usage) => usage.family === "Inter")?.textStyles).toEqual(["Body"]);
  });

  test("skips a node deleted while the scan yielded", async () => {
    const nodes = Array.from({ length: 250 }, (_, index) => text(`1:${index}`, index === 220 ? brand : inter));
    const fake = createFigma({ pages: [{ id: "0:1", name: "Cover", nodes }] });
    const realSetTimeout = globalThis.setTimeout;
    // The first yield comes after 200 nodes; a collaborator deletes a later one meanwhile.
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, delay?: number) => {
      fake.removeNode("1:220");
      return realSetTimeout(handler, delay);
    }) as typeof setTimeout);
    try {
      const { report } = await scan(fake);
      expect(report.nodeCount).toBe(249);
      expect(report.fonts.map((usage) => usage.family)).toEqual(["Inter"]);
    } finally {
      timers.mockRestore();
    }
  });

  test("skips a page deleted while it loaded, still reporting progress for it", async () => {
    const fake = twoPageFile();
    const doomed = fake.page("0:2");
    doomed.loadAsync = async () => {
      doomed.removed = true;
    };
    const { report, progress } = await scan(fake);
    expect(progress).toEqual([
      [0, 2],
      [1, 2],
      [2, 2],
    ]);
    expect(report.nodeCount).toBe(2);
    expect(report.fonts.flatMap((usage) => usage.pages.map((page) => page.id))).toEqual(["0:1", "0:1"]);
  });

  test("yields to the event loop every 200 nodes", async () => {
    const nodes = Array.from({ length: 450 }, (_, index) => text(`1:${index}`, inter));
    const fake = createFigma({ pages: [{ id: "0:1", name: "Cover", nodes }] });
    const timers = spyOn(globalThis, "setTimeout");
    try {
      const { report } = await scan(fake);
      expect(report.nodeCount).toBe(450);
      expect(timers.mock.calls.filter((call) => call[1] === 0)).toHaveLength(2);
    } finally {
      timers.mockRestore();
    }
  });
});

describe("selectFont", () => {
  test("selects on the current page when it has the font", async () => {
    const fake = twoPageFile({ currentPageId: "0:2" });
    await scan(fake);

    const result = await selectFont(brand);
    expect(result).toEqual({ selected: 1, pageName: "Screens" });
    expect(fake.calls.setCurrentPage).toEqual([]);
    expect(fake.page("0:2").selection.map((node) => node.id)).toEqual(["2:1"]);
    expect(fake.viewport.scrolledTo.map((nodes) => nodes.map((node) => node.id))).toEqual([["2:1"]]);
  });

  test("otherwise switches to the first page that has it", async () => {
    const fake = twoPageFile({ currentPageId: "0:2" });
    await scan(fake);

    const result = await selectFont(inter);
    expect(result).toEqual({ selected: 2, pageName: "Cover" });
    expect(fake.calls.setCurrentPage).toEqual(["0:1"]);
    expect(fake.currentPage.id).toBe("0:1");
    expect(fake.page("0:1").selection.map((node) => node.id)).toEqual(["1:1", "1:2"]);
  });

  test("ignores variationSettings on the requested font", async () => {
    await scan(twoPageFile());
    const variable = { family: "Inter", style: "Regular", variationSettings: { wght: 500 } };
    const result = await selectFont(variable);
    expect(result.selected).toBe(2);
  });

  test("skips nodes deleted since the scan", async () => {
    const fake = twoPageFile();
    await scan(fake);
    fake.removeNode("1:1");
    expect(await selectFont(inter)).toEqual({ selected: 1, pageName: "Cover" });
  });

  test("falls through to the next page when the preferred one has none left", async () => {
    const fake = twoPageFile();
    await scan(fake);
    fake.removeNode("1:2");
    expect(await selectFont(brand)).toEqual({ selected: 1, pageName: "Screens" });
    expect(fake.page("0:2").selection.map((node) => node.id)).toEqual(["2:1"]);
  });

  test("leaves out a node moved to another page since the scan", async () => {
    const fake = twoPageFile();
    await scan(fake);
    fake.moveNode("1:2", "0:2");
    expect(await selectFont(inter)).toEqual({ selected: 1, pageName: "Cover" });
    expect(fake.page("0:1").selection.map((node) => node.id)).toEqual(["1:1"]);
  });

  test("a font with no nodes, or only text styles, selects nothing", async () => {
    const fake = twoPageFile({ styles: [{ name: "Unused", fontName: { family: "Old Grotesk", style: "Bold" } }] });
    await scan(fake);
    expect(await selectFont({ family: "Nope", style: "Regular" })).toEqual({ selected: 0, pageName: null });
    expect(await selectFont({ family: "Old Grotesk", style: "Bold" })).toEqual({ selected: 0, pageName: null });
    expect(fake.viewport.scrolledTo).toEqual([]);
  });

  test("selects nothing when every node is gone", async () => {
    const fake = twoPageFile();
    await scan(fake);
    fake.removeNode("1:2");
    fake.removeNode("2:1");
    expect(await selectFont(brand)).toEqual({ selected: 0, pageName: null });
    expect(fake.viewport.scrolledTo).toEqual([]);
  });

  test("uses node ids from the latest scan only", async () => {
    await scan(twoPageFile());
    expect(lastScanNodeIds()?.has(keyOf(brand))).toBe(true);
    const fake = createFigma({ pages: [{ id: "0:1", name: "Cover", nodes: [text("1:1", inter)] }] });
    await scan(fake);
    expect(await selectFont(brand)).toEqual({ selected: 0, pageName: null });
  });
});
