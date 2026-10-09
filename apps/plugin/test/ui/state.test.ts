import { describe, expect, test } from "bun:test";
import type { ScanReport } from "../../src/shared/messages";
import { describeSelection, initialState, reducer } from "../../src/ui/state";

const report: ScanReport = {
  fileName: "Poster",
  scope: "page",
  deep: false,
  scannedAt: 1_700_000_000_000,
  nodeCount: 3,
  fonts: [],
};

describe("reducer", () => {
  test("init marks the UI ready with the stored token and prefs", () => {
    const state = reducer(initialState, { type: "init", token: "t", prefs: { scope: "document", deep: true } });
    expect(state.ready).toBe(true);
    expect(state.token).toBe("t");
    expect(state.prefs).toEqual({ scope: "document", deep: true });
  });

  test("a scan runs from started through progress to result, keeping the old report meanwhile", () => {
    let state = reducer({ ...initialState, report }, { type: "scan-started" });
    expect(state.scan).toEqual({ phase: "scanning", pagesDone: 0, pagesTotal: 0 });
    expect(state.report).toBe(report);
    state = reducer(state, { type: "scan-progress", pagesDone: 2, pagesTotal: 5 });
    expect(state.scan).toEqual({ phase: "scanning", pagesDone: 2, pagesTotal: 5 });
    const next = { ...report, scannedAt: report.scannedAt + 1 };
    state = reducer(state, { type: "scan-result", report: next });
    expect(state.scan).toEqual({ phase: "idle" });
    expect(state.report).toBe(next);
  });

  test("a scan error keeps the previous report", () => {
    const state = reducer({ ...initialState, report }, { type: "scan-error", message: "Page failed to load" });
    expect(state.scan).toEqual({ phase: "error", message: "Page failed to load" });
    expect(state.report).toBe(report);
  });

  test("select-result fills in the requested font and is ignored without a request", () => {
    expect(reducer(initialState, { type: "select-result", selected: 3, pageName: "Cover" })).toBe(initialState);
    const font = { family: "Inter", style: "Bold" };
    let state = reducer(initialState, { type: "select-requested", font });
    expect(state.selection).toEqual({ font, result: null });
    state = reducer(state, { type: "select-result", selected: 3, pageName: "Cover" });
    expect(state.selection).toEqual({ font, result: { selected: 3, pageName: "Cover" } });
  });

  test("prefs, token and reload notices", () => {
    expect(reducer(initialState, { type: "prefs-changed", prefs: { scope: "document", deep: false } }).prefs.scope).toBe(
      "document",
    );
    expect(reducer({ ...initialState, token: "t" }, { type: "token-changed", token: null }).token).toBeNull();
    expect(reducer(initialState, { type: "reload-needed", reason: "installed" }).reload).toBe("installed");
  });
});

describe("describeSelection", () => {
  const font = { family: "Inter", style: "Bold" };

  test("pending, none, one and many", () => {
    expect(describeSelection({ font, result: null })).toBe("Selecting layers that use Inter Bold...");
    expect(describeSelection({ font, result: { selected: 0, pageName: null } })).toBe(
      "No layers using Inter Bold were found.",
    );
    expect(describeSelection({ font, result: { selected: 1, pageName: "Cover" } })).toBe(
      "Selected 1 layer using Inter Bold on Cover.",
    );
    expect(describeSelection({ font, result: { selected: 4, pageName: null } })).toBe(
      "Selected 4 layers using Inter Bold.",
    );
  });
});
