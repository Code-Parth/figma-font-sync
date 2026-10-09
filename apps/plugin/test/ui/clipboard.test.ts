import { describe, expect, test } from "bun:test";
import { copyText } from "../../src/ui/clipboard";

/** Just enough of the DOM for copyText: focus, a selection, a body and execCommand. */
class FakeElement {
  readonly style: Record<string, string> = {};
  readonly attributes = new Map<string, string>();
  value = "";
  readOnly = false;
  tabIndex = 0;
  selected = false;

  constructor(
    private readonly doc: FakeDocument,
    readonly tagName: string,
  ) {}

  focus(): void {
    this.doc.activeElement = this;
  }

  select(): void {
    this.selected = true;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  remove(): void {
    this.doc.body.children = this.doc.body.children.filter((child) => child !== this);
    if (this.doc.activeElement === this) this.doc.activeElement = this.doc.body;
  }
}

class FakeSelection {
  ranges: object[] = [];

  get rangeCount(): number {
    return this.ranges.length;
  }

  getRangeAt(index: number): object {
    const range = this.ranges[index];
    if (range === undefined) throw new Error("no range");
    return range;
  }

  removeAllRanges(): void {
    this.ranges = [];
  }

  addRange(range: object): void {
    this.ranges.push(range);
  }
}

type CopyCall = { command: string; textarea: FakeElement | undefined; focused: boolean; attached: boolean };

class FakeDocument {
  readonly body = {
    children: [] as FakeElement[],
    append: (child: FakeElement) => {
      this.body.children.push(child);
    },
    focus: () => {
      this.activeElement = this.body;
    },
  };
  activeElement: FakeElement | typeof this.body = this.body;
  readonly selection = new FakeSelection();
  readonly calls: CopyCall[] = [];

  constructor(private readonly result: boolean | Error = true) {}

  getSelection(): FakeSelection {
    return this.selection;
  }

  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }

  execCommand(command: string): boolean {
    const textarea = this.body.children.find((child) => child.tagName === "textarea");
    this.calls.push({
      command,
      textarea,
      focused: textarea !== undefined && this.activeElement === textarea,
      attached: textarea !== undefined,
    });
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }

  asDocument(): Document {
    // A structural fake: only the members copyText touches exist.
    return this as unknown as Document;
  }
}

describe("copyText", () => {
  test("copies from a focused, selected, off-screen textarea and removes it", () => {
    const doc = new FakeDocument();
    expect(copyText("figma-font-sync start", doc.asDocument())).toBe(true);

    expect(doc.calls).toHaveLength(1);
    const call = doc.calls[0];
    expect(call?.command).toBe("copy");
    expect(call?.attached).toBe(true);
    expect(call?.focused).toBe(true);
    expect(call?.textarea?.value).toBe("figma-font-sync start");
    expect(call?.textarea?.selected).toBe(true);
    expect(call?.textarea?.readOnly).toBe(true);
    expect(call?.textarea?.tabIndex).toBe(-1);
    expect(call?.textarea?.attributes.get("aria-hidden")).toBe("true");
    expect(call?.textarea?.style.position).toBe("fixed");
    expect(call?.textarea?.style.left).toBe("-9999px");
    expect(doc.body.children).toHaveLength(0);
  });

  test("puts focus and the selection back where they were", () => {
    const doc = new FakeDocument();
    const button = doc.createElement("button");
    button.focus();
    const range = { id: "user selection" };
    doc.selection.addRange(range);

    copyText("figma-font-sync setup", doc.asDocument());

    expect(doc.activeElement).toBe(button);
    expect(doc.selection.ranges).toEqual([range]);
    expect(doc.selection.ranges[0]).toBe(range);
  });

  test("an empty selection stays empty", () => {
    const doc = new FakeDocument();
    copyText("npm i -g figma-font-sync", doc.asDocument());
    expect(doc.selection.rangeCount).toBe(0);
  });

  test("false when the browser refuses", () => {
    const doc = new FakeDocument(false);
    expect(copyText("figma-font-sync start", doc.asDocument())).toBe(false);
    expect(doc.body.children).toHaveLength(0);
  });

  test("false, and still cleaned up, when execCommand throws", () => {
    const doc = new FakeDocument(new Error("SecurityError"));
    const button = doc.createElement("button");
    button.focus();
    expect(copyText("figma-font-sync start", doc.asDocument())).toBe(false);
    expect(doc.body.children).toHaveLength(0);
    expect(doc.activeElement).toBe(button);
  });
});
