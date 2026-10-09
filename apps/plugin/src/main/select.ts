import type { FontKey } from "../shared/messages";
import { keyOf } from "./aggregate";
import { lastScanNodeIds } from "./scan";

export type SelectResult = { selected: number; pageName: string | null };

/**
 * Selects the layers that use `font`, from the last scan. Prefers the current page; otherwise the first
 * page (in document order) that still has any of them. Nodes deleted or moved off their page since the
 * scan are skipped.
 */
export async function selectFont(font: FontKey): Promise<SelectResult> {
  const byPage = lastScanNodeIds()?.get(keyOf(font));
  if (!byPage) return { selected: 0, pageName: null };

  const current = figma.currentPage.id;
  const others = [...byPage.keys()].filter((id) => id !== current);
  const pageIds = byPage.has(current) ? [current, ...others] : others;

  for (const pageId of pageIds) {
    const page = figma.root.children.find((candidate) => candidate.id === pageId);
    if (!page) continue;
    if (page.id !== figma.currentPage.id) await figma.setCurrentPageAsync(page);
    const nodes = await resolveOnPage(byPage.get(pageId) ?? [], page);
    if (nodes.length === 0) continue;
    page.selection = nodes;
    figma.viewport.scrollAndZoomIntoView(nodes);
    return { selected: page.selection.length, pageName: page.name };
  }
  return { selected: 0, pageName: null };
}

async function resolveOnPage(ids: string[], page: PageNode): Promise<SceneNode[]> {
  const found = await Promise.all(ids.map((id) => figma.getNodeByIdAsync(id)));
  const nodes: SceneNode[] = [];
  for (const node of found) {
    if (!node || node.removed || node.type === "DOCUMENT" || node.type === "PAGE") continue;
    // A node moved to another page since the scan is that page's to select, not this one's.
    if (pageOf(node) !== page) continue;
    nodes.push(node);
  }
  return nodes;
}

function pageOf(node: BaseNode): PageNode | null {
  for (let current: BaseNode | null = node; current; current = current.parent) {
    if (current.type === "PAGE") return current;
  }
  return null;
}
