// Pure aggregation of scanned text nodes into the per-font report. No figma globals here,
// so it runs under bun:test.

import type { FontKey, FontUsage } from "../shared/messages";

/** Node ids kept per font for select-font; bounds memory in files with huge text counts. */
export const NODE_ID_CAP = 5000;

/** Figma identifies a font by family and style only; variationSettings never takes part. */
export function keyOf(font: FontKey): string {
  return `${font.family}\u0000${font.style}`;
}

/** One text or text-path node as the scanner read it. */
export type TextNodeRecord = {
  pageId: string;
  pageName: string;
  nodeId: string;
  /** Every font in the node. The same family and style may repeat (variable fonts with different axes). */
  fonts: FontKey[];
  hasMissingFont: boolean;
};

export type TextStyleRecord = { name: string; font: FontKey };

/** Font key to page id to node ids, both levels in document order. */
export type NodeIdIndex = Map<string, Map<string, string[]>>;

export type Aggregate = {
  /** Sorted by family, then style. */
  fonts: FontUsage[];
  nodeIds: NodeIdIndex;
};

type Entry = {
  usage: FontUsage;
  pageIds: Set<string>;
  nodeIds: Map<string, string[]>;
  keptIds: number;
};

export function aggregateFonts(
  nodes: Iterable<TextNodeRecord>,
  styles: Iterable<TextStyleRecord>,
  available: ReadonlySet<string>,
  cap: number = NODE_ID_CAP,
): Aggregate {
  const entries = new Map<string, Entry>();

  const entryFor = (font: FontKey, key: string): Entry => {
    let entry = entries.get(key);
    if (!entry) {
      // Copy family and style only: FontName objects from Figma also carry variationSettings.
      entry = {
        usage: {
          family: font.family,
          style: font.style,
          nodeCount: 0,
          missingNodeCount: 0,
          pages: [],
          textStyles: [],
          availableInFigma: available.has(key),
        },
        pageIds: new Set(),
        nodeIds: new Map(),
        keptIds: 0,
      };
      entries.set(key, entry);
    }
    return entry;
  };

  for (const node of nodes) {
    const counted = new Set<string>();
    for (const font of node.fonts) {
      const key = keyOf(font);
      if (counted.has(key)) continue;
      counted.add(key);

      const entry = entryFor(font, key);
      entry.usage.nodeCount += 1;
      if (node.hasMissingFont) entry.usage.missingNodeCount += 1;
      if (!entry.pageIds.has(node.pageId)) {
        entry.pageIds.add(node.pageId);
        entry.usage.pages.push({ id: node.pageId, name: node.pageName });
      }
      if (entry.keptIds < cap) {
        const ids = entry.nodeIds.get(node.pageId);
        if (ids) ids.push(node.nodeId);
        else entry.nodeIds.set(node.pageId, [node.nodeId]);
        entry.keptIds += 1;
      }
    }
  }

  for (const style of styles) {
    const { textStyles } = entryFor(style.font, keyOf(style.font)).usage;
    if (!textStyles.includes(style.name)) textStyles.push(style.name);
  }

  const sorted = [...entries.values()].sort(
    (a, b) => compareText(a.usage.family, b.usage.family) || compareText(a.usage.style, b.usage.style),
  );
  const nodeIds: NodeIdIndex = new Map();
  for (const [key, entry] of entries) {
    if (entry.nodeIds.size > 0) nodeIds.set(key, entry.nodeIds);
  }
  return { fonts: sorted.map((entry) => entry.usage), nodeIds };
}

// Case-insensitive first so "inter" sits next to "Inter", then by code unit so the order is total.
// Not localeCompare: the order should not change with the user's locale.
function compareText(a: string, b: string): number {
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (lowerA !== lowerB) return lowerA < lowerB ? -1 : 1;
  if (a !== b) return a < b ? -1 : 1;
  return 0;
}
