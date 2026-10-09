// Opt-in accuracy check against Figma's own font listing. Set FONT_SYNC_ORACLE to a saved response of
// FigmaAgent's GET /figma/font-files ({ fontFiles: { absPath: [{ family, style }] } }). The listing is
// machine-specific, so it is never committed and this test is skipped without it.
import { describe, expect, it } from "bun:test";
import { keyOf } from "../../src/fonts/match";
import { FontParseError, MAX_FONT_BYTES, parseFont } from "../../src/fonts/sfnt";
import type { FontKey } from "../../src/fonts/types";

const oraclePath = process.env.FONT_SYNC_ORACLE;

describe.skipIf(!oraclePath)("FigmaAgent oracle", () => {
  it("parseFont reproduces Figma's {family, style} for every listed file", async () => {
    const oracle = (await Bun.file(oraclePath ?? "").json()) as { fontFiles: Record<string, FontKey[]> };
    let expected = 0;
    let matched = 0;
    let oversizeFaces = 0;
    let unreadableFiles = 0;
    const misses: string[] = [];
    const extras: string[] = [];

    for (const [file, figmaFaces] of Object.entries(oracle.fontFiles)) {
      const theirs = new Set(figmaFaces.map(keyOf));
      // Over the cap is a deliberate rejection, counted apart from naming mistakes.
      if (Bun.file(file).size > MAX_FONT_BYTES) {
        expected += theirs.size;
        oversizeFaces += theirs.size;
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = await Bun.file(file).bytes();
      } catch {
        unreadableFiles++;
        continue;
      }
      let ours = new Set<string>();
      try {
        ours = new Set(parseFont(bytes).faces.map(keyOf));
      } catch (error) {
        if (!(error instanceof FontParseError)) throw error;
        misses.push(`${file}: ${error.message}`);
      }
      for (const key of theirs) {
        expected++;
        if (ours.has(key)) matched++;
        else misses.push(`${file}: missing ${JSON.stringify(key.replace("\u0000", " / "))}`);
      }
      for (const key of ours) {
        if (!theirs.has(key)) extras.push(`${file}: extra ${JSON.stringify(key.replace("\u0000", " / "))}`);
      }
    }

    const withinCap = expected - oversizeFaces;
    const percent = (n: number, of: number) => `${((100 * n) / of).toFixed(2)}%`;
    // Deliberate output: the match rate is this test's product.
    console.log(
      [
        `oracle: ${matched}/${withinCap} faces within the ${MAX_FONT_BYTES / 1024 / 1024} MB cap (${percent(matched, withinCap)})`,
        `${matched}/${expected} of all listed faces (${percent(matched, expected)}); ${oversizeFaces} faces in oversize files`,
        `${unreadableFiles} unreadable files, ${extras.length} extra faces`,
        ...misses.map((m) => `  ${m}`),
        ...extras.map((m) => `  ${m}`),
      ].join("\n"),
    );
    // Known exception on macOS: CoreText localizes some styles (Galvji "Oblique" is listed as "Italic").
    expect(matched / withinCap).toBeGreaterThanOrEqual(0.995);
  }, 120_000);
});
