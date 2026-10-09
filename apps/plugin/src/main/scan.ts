import type { ScanOptions, ScanReport } from "../shared/messages";
import { aggregateFonts, keyOf, type NodeIdIndex, type TextNodeRecord, type TextStyleRecord } from "./aggregate";

/** Nodes read between yields to the event loop, so Figma keeps painting during a long scan. */
const YIELD_EVERY = 200;

let lastNodeIds: NodeIdIndex | null = null;

/** Node ids from the most recent scan that finished, for select-font. Null before the first one. */
export function lastScanNodeIds(): NodeIdIndex | null {
  return lastNodeIds;
}

/**
 * Reads every text node in scope (and text-path node, where the runtime can search for them), page by
 * page (the manifest uses dynamic-page access, so each page is loaded on demand), plus the file's local
 * text styles.
 */
export async function scanFonts(
  options: ScanOptions,
  onProgress: (pagesDone: number, pagesTotal: number) => void,
): Promise<ScanReport> {
  const previousSkip = figma.skipInvisibleInstanceChildren;
  figma.skipInvisibleInstanceChildren = !options.deep;
  try {
    // Re-read on every scan: a font installed since the last one may have appeared.
    const available = new Set((await figma.listAvailableFontsAsync()).map((font) => keyOf(font.fontName)));
    const pages = options.scope === "page" ? [figma.currentPage] : figma.root.children;
    const records: TextNodeRecord[] = [];
    let sinceYield = 0;

    // The typings declare TextPathNode, but Figma's runtime (Oct 2026) rejects "TEXT_PATH" in
    // findAllWithCriteria and fails the whole call. Ask once per scan and fall back to "TEXT", so text on
    // a path is picked up as soon as the runtime accepts it.
    let textPathSearchable = true;
    const findText = (page: PageNode): (TextNode | TextPathNode)[] => {
      if (textPathSearchable) {
        try {
          return page.findAllWithCriteria({ types: ["TEXT", "TEXT_PATH"] });
        } catch {
          textPathSearchable = false;
        }
      }
      return page.findAllWithCriteria({ types: ["TEXT"] });
    };

    const readPage = async (page: PageNode) => {
      // Edits, undo and multiplayer can delete a page while this scan awaits.
      if (page.removed) return;
      await page.loadAsync();
      if (page.removed) return;
      for (const node of findText(page)) {
        // A node deleted or swapped out of an instance while the scan yielded throws on any property read.
        if (node.removed) continue;
        const fontName = node.fontName;
        records.push({
          pageId: page.id,
          pageName: page.name,
          nodeId: node.id,
          fonts: fontName === figma.mixed ? node.getRangeAllFontNames(0, node.characters.length) : [fontName],
          hasMissingFont: node.hasMissingFont,
        });
        sinceYield += 1;
        if (sinceYield >= YIELD_EVERY) {
          sinceYield = 0;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
    };

    onProgress(0, pages.length);
    for (let index = 0; index < pages.length; index += 1) {
      const page = pages[index];
      if (page) await readPage(page);
      onProgress(index + 1, pages.length);
    }

    const styles: TextStyleRecord[] = (await figma.getLocalTextStylesAsync()).map((style) => ({
      name: style.name,
      font: style.fontName,
    }));
    const { fonts, nodeIds } = aggregateFonts(records, styles, available);
    lastNodeIds = nodeIds;
    return {
      fileName: figma.root.name,
      scope: options.scope,
      deep: options.deep,
      scannedAt: Date.now(),
      nodeCount: records.length,
      fonts,
    };
  } finally {
    figma.skipInvisibleInstanceChildren = previousSkip;
  }
}
