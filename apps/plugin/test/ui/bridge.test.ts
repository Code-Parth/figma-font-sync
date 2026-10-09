import { describe, expect, it } from "bun:test";
import { readMessage } from "../../src/ui/bridge";

describe("readMessage", () => {
  it("passes main-thread messages through", () => {
    const init = { type: "init", token: null, prefs: { scope: "document", deep: false } };
    expect(readMessage({ pluginMessage: init })).toEqual(init as never);
  });

  it("drops message types the main thread never sends, including the UI's own", () => {
    expect(readMessage({ pluginMessage: { type: "save-token", token: "t" } })).toBeNull();
    expect(readMessage({ pluginMessage: { type: "unknown" } })).toBeNull();
  });

  it("drops data that is not a plugin message", () => {
    expect(readMessage(null)).toBeNull();
    expect(readMessage({ type: "init" })).toBeNull();
    expect(readMessage({ pluginMessage: { type: 1 } })).toBeNull();
  });
});
