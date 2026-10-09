// A small stand-in for the parts of the Plugin API the main thread uses. It enforces the rules the real
// API would: pages must be loaded before findAllWithCriteria, removed nodes and pages throw when read,
// and with skipInvisibleInstanceChildren on, hidden instance children are neither found nor returned by
// getNodeByIdAsync.

export const MIXED = Symbol("mixed");

export type FakeFont = { family: string; style: string; variationSettings?: Record<string, number> };

export type FakeText = {
  id: string;
  type: "TEXT" | "TEXT_PATH";
  removed: boolean;
  parent: FakePage | null;
  characters: string;
  hasMissingFont: boolean;
  fontName: FakeFont | typeof MIXED;
  /** Inside an instance and hidden: skipped while skipInvisibleInstanceChildren is on. */
  hiddenInInstance: boolean;
  rangeCalls: [number, number][];
  getRangeAllFontNames(start: number, end: number): FakeFont[];
};

export type FakePage = {
  id: string;
  name: string;
  type: "PAGE";
  removed: boolean;
  parent: { type: "DOCUMENT" } | null;
  loaded: boolean;
  nodes: FakeText[];
  selection: FakeText[];
  /** skipInvisibleInstanceChildren as seen by each findAllWithCriteria call. */
  skipSeen: boolean[];
  loadAsync(): Promise<void>;
  findAllWithCriteria(criteria: { types: string[] }): FakeText[];
};

export function text(
  id: string,
  fonts: FakeFont | FakeFont[],
  options: { missing?: boolean; hidden?: boolean; type?: "TEXT" | "TEXT_PATH"; characters?: string } = {},
): FakeText {
  const list = Array.isArray(fonts) ? fonts : [fonts];
  const characters = options.characters ?? "x".repeat(Math.max(1, list.length));
  const fontName = list.length === 1 && list[0] ? list[0] : MIXED;
  const node: FakeText = {
    id,
    type: options.type ?? "TEXT",
    removed: false,
    parent: null,
    get characters() {
      return alive(node, characters);
    },
    get hasMissingFont() {
      return alive(node, options.missing ?? false);
    },
    get fontName() {
      return alive(node, fontName);
    },
    hiddenInInstance: options.hidden ?? false,
    rangeCalls: [],
    getRangeAllFontNames(start, end) {
      alive(node, null);
      node.rangeCalls.push([start, end]);
      return list;
    },
  };
  return node;
}

/** Like the Plugin API, a removed node or page throws on property reads other than id and removed. */
function alive<T>(node: { id: string; removed: boolean }, value: T): T {
  if (node.removed) throw new Error(`The node with id "${node.id}" does not exist`);
  return value;
}

export type FakeFigma = ReturnType<typeof createFigma>;

export function createFigma(setup: {
  pages: { id: string; name: string; nodes: FakeText[] }[];
  currentPageId?: string;
  available?: FakeFont[];
  styles?: { name: string; fontName: FakeFont }[];
  skipInvisibleInstanceChildren?: boolean;
  fileName?: string;
  storage?: Record<string, unknown>;
  /** Behave like the Oct 2026 runtime, whose findAllWithCriteria rejects "TEXT_PATH". */
  rejectTextPath?: boolean;
}) {
  const document = { type: "DOCUMENT" as const, name: setup.fileName ?? "Design file", children: [] as FakePage[] };

  const fake = {
    mixed: MIXED,
    skipInvisibleInstanceChildren: setup.skipInvisibleInstanceChildren ?? false,
    root: document,
    currentPage: undefined as unknown as FakePage,
    calls: { listAvailableFonts: 0, setCurrentPage: [] as string[], textPathRejected: 0 },
    failNext: { listAvailableFonts: null as Error | null, getNodeById: null as Error | null },

    async listAvailableFontsAsync() {
      fake.calls.listAvailableFonts += 1;
      const error = fake.failNext.listAvailableFonts;
      if (error) {
        fake.failNext.listAvailableFonts = null;
        throw error;
      }
      return (setup.available ?? []).map((fontName) => ({ fontName }));
    },
    async getLocalTextStylesAsync() {
      return (setup.styles ?? []).map((style) => ({ type: "TEXT" as const, ...style }));
    },
    async setCurrentPageAsync(page: FakePage) {
      fake.calls.setCurrentPage.push(page.id);
      page.loaded = true;
      fake.currentPage = page;
    },
    async getNodeByIdAsync(id: string) {
      const error = fake.failNext.getNodeById;
      if (error) {
        fake.failNext.getNodeById = null;
        throw error;
      }
      for (const page of document.children) {
        if (page.id === id) return page;
        const node = page.nodes.find((candidate) => candidate.id === id);
        if (node) return node.hiddenInInstance && fake.skipInvisibleInstanceChildren ? null : node;
      }
      return null;
    },

    viewport: {
      scrolledTo: [] as FakeText[][],
      scrollAndZoomIntoView(nodes: FakeText[]) {
        fake.viewport.scrolledTo.push([...nodes]);
      },
    },

    ui: {
      posted: [] as unknown[],
      sizes: [] as [number, number][],
      onmessage: undefined as ((message: unknown, props: { origin: string }) => void) | undefined,
      postMessage(message: unknown) {
        fake.ui.posted.push(message);
      },
      resize(width: number, height: number) {
        fake.ui.sizes.push([width, height]);
      },
    },
    shown: [] as { html: string; options: unknown }[],
    showUI(html: string, options: unknown) {
      fake.shown.push({ html, options });
    },

    clientStorage: {
      data: new Map<string, unknown>(Object.entries(setup.storage ?? {})),
      failReads: false,
      async getAsync(key: string) {
        if (fake.clientStorage.failReads) throw new Error("storage unavailable");
        return fake.clientStorage.data.get(key);
      },
      async setAsync(key: string, value: unknown) {
        fake.clientStorage.data.set(key, structuredClone(value));
      },
      async deleteAsync(key: string) {
        fake.clientStorage.data.delete(key);
      },
    },

    notifications: [] as { message: string; options: unknown }[],
    notify(message: string, options?: unknown) {
      fake.notifications.push({ message, options });
    },
    opened: [] as string[],
    openExternal(url: string) {
      fake.opened.push(url);
    },

    /** Test helpers, not Plugin API. */
    page(id: string): FakePage {
      const page = document.children.find((candidate) => candidate.id === id);
      if (!page) throw new Error(`no page ${id}`);
      return page;
    },
    removeNode(id: string) {
      for (const page of document.children) {
        const index = page.nodes.findIndex((node) => node.id === id);
        const node = page.nodes[index];
        if (!node) continue;
        page.nodes.splice(index, 1);
        node.removed = true;
        node.parent = null;
      }
    },
    moveNode(id: string, toPageId: string) {
      const target = fake.page(toPageId);
      for (const page of document.children) {
        const index = page.nodes.findIndex((node) => node.id === id);
        const node = page.nodes[index];
        if (!node) continue;
        page.nodes.splice(index, 1);
        target.nodes.push(node);
        node.parent = target;
        return;
      }
    },
  };

  for (const spec of setup.pages) {
    const page: FakePage = {
      id: spec.id,
      name: spec.name,
      type: "PAGE",
      removed: false,
      parent: document,
      loaded: false,
      nodes: spec.nodes,
      selection: [],
      skipSeen: [],
      async loadAsync() {
        page.loaded = true;
      },
      findAllWithCriteria(criteria) {
        alive(page, null);
        if (!page.loaded) throw new Error(`page ${page.id} not loaded`);
        if (setup.rejectTextPath && criteria.types.includes("TEXT_PATH")) {
          fake.calls.textPathRejected += 1;
          throw new Error(
            `in findAllWithCriteria: Property "criteria" failed validation: Invalid enum value. received 'TEXT_PATH' at .types[1]`,
          );
        }
        page.skipSeen.push(fake.skipInvisibleInstanceChildren);
        return page.nodes.filter(
          (node) =>
            criteria.types.includes(node.type) && !(node.hiddenInInstance && fake.skipInvisibleInstanceChildren),
        );
      },
    };
    for (const node of spec.nodes) node.parent = page;
    document.children.push(page);
  }
  const current = setup.currentPageId ? fake.page(setup.currentPageId) : document.children[0];
  if (!current) throw new Error("a fake document needs at least one page");
  current.loaded = true;
  fake.currentPage = current;
  return fake;
}

/** Installs `fake` as the global `figma` the main-thread modules read at call time. */
export function installFigma(fake: FakeFigma): void {
  Object.assign(globalThis, { figma: fake, __html__: "<p>ui</p>" });
}

/** Lets every pending promise and zero-delay timer run. */
export async function settle(turns = 3): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
