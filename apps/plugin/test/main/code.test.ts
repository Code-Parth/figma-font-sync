// code.ts wires itself to the global figma when imported, so each import below gets its own fake and a
// distinct ?query, which makes Bun evaluate the module again.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { MainToUi } from "../../src/shared/messages";
import { createFigma, type FakeFigma, installFigma, settle, text } from "./fake-figma";

const inter = { family: "Inter", style: "Regular" };
const brand = { family: "Brand Sans", style: "Black" };

async function startPlugin(fake: FakeFigma, instance: string): Promise<(message: unknown) => Promise<void>> {
  installFigma(fake);
  await import(`../../src/main/code.ts?${instance}`);
  await settle();
  return async (message) => {
    const onmessage = fake.ui.onmessage;
    if (!onmessage) throw new Error("code.ts did not register figma.ui.onmessage");
    onmessage(message, { origin: "null" });
    await settle();
  };
}

function posted(fake: FakeFigma): MainToUi[] {
  return fake.ui.posted as MainToUi[];
}

afterAll(() => {
  Reflect.deleteProperty(globalThis, "figma");
  Reflect.deleteProperty(globalThis, "__html__");
});

describe("plugin main thread", () => {
  let fake: FakeFigma;
  let send: (message: unknown) => Promise<void>;

  beforeAll(async () => {
    fake = createFigma({
      pages: [
        { id: "0:1", name: "Cover", nodes: [text("1:1", inter), text("1:2", brand, { missing: true })] },
        { id: "0:2", name: "Screens", nodes: [text("2:1", brand, { missing: true })] },
      ],
      available: [inter],
      storage: { pairToken: "stored-token", prefs: { scope: "page", deep: "yes" } },
    });
    send = await startPlugin(fake, "main");
  });

  test("opens the UI with the agreed size, theme colours and title", () => {
    expect(fake.shown).toEqual([
      { html: "<p>ui</p>", options: { width: 400, height: 620, themeColors: true, title: "Font Sync" } },
    ]);
  });

  test("posts init with the stored token and validated prefs", () => {
    expect(posted(fake)[0]).toEqual({ type: "init", token: "stored-token", prefs: { scope: "page", deep: false } });
  });

  test("ignores malformed messages", async () => {
    const before = fake.ui.posted.length;
    for (const message of [
      null,
      "scan",
      { type: "scan" },
      { type: "save-token", token: 1 },
      { type: "resize", width: "500", height: 700 },
      { type: "launch-missiles" },
    ]) {
      await send(message);
    }
    expect(fake.ui.posted.length).toBe(before);
    expect(fake.ui.sizes).toEqual([]);
    expect(fake.clientStorage.data.get("pairToken")).toBe("stored-token");
    expect(fake.notifications).toEqual([]);
  });

  test("save-token stores a token and deletes it on null or empty", async () => {
    await send({ type: "save-token", token: "new-token" });
    expect(fake.clientStorage.data.get("pairToken")).toBe("new-token");
    await send({ type: "save-token", token: null });
    expect(fake.clientStorage.data.has("pairToken")).toBe(false);
    await send({ type: "save-token", token: "again" });
    await send({ type: "save-token", token: "" });
    expect(fake.clientStorage.data.has("pairToken")).toBe(false);
  });

  test("save-prefs stores prefs", async () => {
    await send({ type: "save-prefs", prefs: { scope: "document", deep: true } });
    expect(fake.clientStorage.data.get("prefs")).toEqual({ scope: "document", deep: true });
  });

  test("open-external opens only Google Drive and Docs URLs", async () => {
    for (const url of [
      "https://drive.google.com/drive/folders/1AbC",
      "https://docs.google.com/document/d/1AbC",
      "https://drive.google.com.evil.example/",
      "http://drive.google.com/",
      "javascript:alert(1)",
    ]) {
      await send({ type: "open-external", url });
    }
    expect(fake.opened).toEqual(["https://drive.google.com/drive/folders/1AbC", "https://docs.google.com/document/d/1AbC"]);
  });

  test("notify passes the error flag through", async () => {
    fake.notifications.length = 0;
    await send({ type: "notify", message: "Installed 3 fonts" });
    await send({ type: "notify", message: "Helper not running", error: true });
    expect(fake.notifications).toEqual([
      { message: "Installed 3 fonts", options: { error: false } },
      { message: "Helper not running", options: { error: true } },
    ]);
    fake.notifications.length = 0;
  });

  test("resize clamps to 320..800 by 400..1000", async () => {
    await send({ type: "resize", width: 100, height: 5000 });
    await send({ type: "resize", width: 640.4, height: 720.6 });
    expect(fake.ui.sizes).toEqual([
      [320, 1000],
      [640, 721],
    ]);
  });

  test("select-font for a font no scan has seen selects nothing", async () => {
    fake.ui.posted.length = 0;
    await send({ type: "select-font", font: { family: "Never Scanned", style: "Regular" } });
    expect(posted(fake)).toEqual([{ type: "select-result", selected: 0, pageName: null }]);
  });

  test("scan posts progress, then the report", async () => {
    fake.ui.posted.length = 0;
    await send({ type: "scan", options: { scope: "document", deep: false } });
    const messages = posted(fake);
    expect(messages.filter((message) => message.type === "scan-progress")).toEqual([
      { type: "scan-progress", pagesDone: 0, pagesTotal: 2 },
      { type: "scan-progress", pagesDone: 1, pagesTotal: 2 },
      { type: "scan-progress", pagesDone: 2, pagesTotal: 2 },
    ]);
    const last = messages.at(-1);
    if (last?.type !== "scan-result") throw new Error(`expected scan-result, got ${JSON.stringify(last)}`);
    expect(last.report.nodeCount).toBe(3);
    expect(last.report.fonts.map((usage) => [usage.family, usage.availableInFigma, usage.missingNodeCount])).toEqual([
      ["Brand Sans", false, 2],
      ["Inter", true, 0],
    ]);
  });

  test("a scan requested while one runs is ignored", async () => {
    fake.ui.posted.length = 0;
    const calls = fake.calls.listAvailableFonts;
    const onmessage = fake.ui.onmessage;
    onmessage?.({ type: "scan", options: { scope: "document", deep: false } }, { origin: "null" });
    onmessage?.({ type: "scan", options: { scope: "page", deep: true } }, { origin: "null" });
    await settle();
    expect(fake.calls.listAvailableFonts).toBe(calls + 1);
    expect(posted(fake).filter((message) => message.type === "scan-result")).toHaveLength(1);

    // Once it finishes, the next scan runs.
    await send({ type: "scan", options: { scope: "page", deep: false } });
    expect(fake.calls.listAvailableFonts).toBe(calls + 2);
  });

  test("a failed scan posts scan-error and does not block the next one", async () => {
    fake.ui.posted.length = 0;
    fake.failNext.listAvailableFonts = new Error("font list unavailable");
    await send({ type: "scan", options: { scope: "document", deep: false } });
    expect(posted(fake).at(-1)).toEqual({ type: "scan-error", message: "font list unavailable" });

    await send({ type: "scan", options: { scope: "document", deep: false } });
    expect(posted(fake).at(-1)?.type).toBe("scan-result");
  });

  test("select-font selects the layers and reports the page", async () => {
    fake.ui.posted.length = 0;
    await send({ type: "select-font", font: brand });
    expect(posted(fake)).toEqual([{ type: "select-result", selected: 1, pageName: "Cover" }]);
    expect(fake.page("0:1").selection.map((node) => node.id)).toEqual(["1:2"]);
  });

  test("a failed select-font still answers, and tells the user why", async () => {
    fake.ui.posted.length = 0;
    fake.failNext.getNodeById = new Error("document closed");
    await send({ type: "select-font", font: inter });
    expect(posted(fake)).toEqual([{ type: "select-result", selected: 0, pageName: null }]);
    expect(fake.notifications).toEqual([{ message: "document closed", options: { error: true } }]);
  });
});

describe("plugin start-up", () => {
  test("an empty clientStorage gives no token and default prefs", async () => {
    const fake = createFigma({ pages: [{ id: "0:1", name: "Cover", nodes: [] }] });
    await startPlugin(fake, "empty-storage");
    expect(fake.ui.posted).toEqual([{ type: "init", token: null, prefs: { scope: "document", deep: false } }]);
  });

  test("unreadable clientStorage still posts init, unpaired with defaults", async () => {
    const fake = createFigma({ pages: [{ id: "0:1", name: "Cover", nodes: [] }] });
    fake.clientStorage.failReads = true;
    await startPlugin(fake, "broken-storage");
    expect(fake.ui.posted).toEqual([{ type: "init", token: null, prefs: { scope: "document", deep: false } }]);
    expect(fake.notifications).toEqual([
      { message: "Could not read saved settings: storage unavailable", options: { error: true } },
    ]);
  });
});
