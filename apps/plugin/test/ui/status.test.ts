import { describe, expect, test } from "bun:test";
import type { FontUsage } from "../../src/shared/messages";
import type { ResolvedFont } from "../../src/ui/api/types.gen";
import {
  buildFontGroups,
  chunk,
  countStatuses,
  deriveStatus,
  fontKey,
  installable,
  resolveInBatches,
  STATUS_ORDER,
} from "../../src/ui/status";

function usage(family: string, style: string, availableInFigma: boolean): FontUsage {
  return { family, style, nodeCount: 1, missingNodeCount: availableInFigma ? 0 : 1, pages: [], textStyles: [], availableInFigma };
}

type Local = ResolvedFont["local"];
type Tier = NonNullable<ResolvedFont["library"]>["tier"];
const NOT_LOCAL: Local = { onDisk: false, installedBySync: false, uploadable: false };

/** A non-exact tier gives the library face a different name, as the helper's close matches do. */
function resolved(
  family: string,
  style: string,
  fileId: string | null,
  local: Partial<Local> = {},
  tier: Tier = "exact",
): ResolvedFont {
  return {
    family,
    style,
    library:
      fileId === null
        ? null
        : {
            fileId,
            tier,
            face: {
              family: tier === "exact" ? family : `${family} Library`,
              style,
              postscript: null,
              fullName: null,
              legacyFamily: null,
              legacyStyle: null,
              weight: 400,
              italic: false,
              variable: false,
            },
          },
    local: { ...NOT_LOCAL, ...local },
  };
}

describe("deriveStatus", () => {
  const missing = usage("Inter", "Bold", false);
  const available = usage("Inter", "Bold", true);

  test("missing and in the library: install", () => {
    expect(deriveStatus(missing, resolved("Inter", "Bold", "f1"), false)).toBe("install");
  });

  test("missing, in the library, installed by Font Sync: reload", () => {
    expect(deriveStatus(missing, resolved("Inter", "Bold", "f1", { installedBySync: true, onDisk: true }), false)).toBe(
      "reload",
    );
  });

  test("missing, in the library, already on disk from another source: reload", () => {
    expect(deriveStatus(missing, resolved("Inter", "Bold", "f1", { onDisk: true }), false)).toBe("reload");
  });

  test("missing, in the library, installedBySync without onDisk still means reload", () => {
    expect(deriveStatus(missing, resolved("Inter", "Bold", "f1", { installedBySync: true }), true)).toBe("reload");
  });

  test("missing, a close library match, on disk or installed: replace, since Figma lists it under another name", () => {
    for (const tier of ["normalized", "alias"] as const) {
      expect(deriveStatus(missing, resolved("Inter", "Bold", "f1", { installedBySync: true, onDisk: true }, tier), false)).toBe(
        "replace",
      );
      expect(deriveStatus(missing, resolved("Inter", "Bold", "f1", { onDisk: true }, tier), false)).toBe("replace");
      expect(deriveStatus(missing, resolved("Inter", "Bold", "f1", { installedBySync: true }, tier), false)).toBe("replace");
    }
  });

  test("missing, a close library match, not on this machine: install", () => {
    expect(deriveStatus(missing, resolved("Inter", "Bold", "f1", {}, "alias"), false)).toBe("install");
  });

  test("missing and not in the library: not-in-library, whatever is on disk", () => {
    expect(deriveStatus(missing, resolved("Inter", "Bold", null), true)).toBe("not-in-library");
    expect(deriveStatus(missing, resolved("Inter", "Bold", null, { onDisk: true, uploadable: true }), true)).toBe(
      "not-in-library",
    );
  });

  test("available and in the library: synced, even when uploadable", () => {
    expect(deriveStatus(available, resolved("Inter", "Bold", "f1"), false)).toBe("synced");
    expect(deriveStatus(available, resolved("Inter", "Bold", "f1", { onDisk: true, uploadable: true }), true)).toBe(
      "synced",
    );
  });

  test("available, not in the library, uploadable and the user can upload: add", () => {
    expect(deriveStatus(available, resolved("Inter", "Bold", null, { onDisk: true, uploadable: true }), true)).toBe(
      "add",
    );
  });

  test("available, uploadable, but the user cannot upload: local-only", () => {
    expect(deriveStatus(available, resolved("Inter", "Bold", null, { onDisk: true, uploadable: true }), false)).toBe(
      "local-only",
    );
  });

  test("available, on disk but not uploadable (a system font): local-only", () => {
    expect(deriveStatus(available, resolved("Inter", "Bold", null, { onDisk: true }), true)).toBe("local-only");
  });

  test("available, nowhere on this machine: figma-provided", () => {
    expect(deriveStatus(available, resolved("Inter", "Bold", null), true)).toBe("figma-provided");
  });

  test("uploadable without onDisk and without upload rights: figma-provided", () => {
    expect(deriveStatus(available, resolved("Inter", "Bold", null, { uploadable: true }), false)).toBe("figma-provided");
  });
});

describe("buildFontGroups", () => {
  const fonts = [
    usage("Roboto", "Regular", true),
    usage("Inter", "Regular", true),
    usage("Zeta", "Bold", false),
    usage("Inter", "Bold", false),
    usage("Inter", "Black", false),
  ];
  const answers = [
    resolved("Roboto", "Regular", null),
    resolved("Inter", "Regular", "f-inter"),
    resolved("Zeta", "Bold", null),
    resolved("Inter", "Bold", "f-inter"),
    resolved("Inter", "Black", "f-black", { installedBySync: true }),
  ];

  test("groups by family with missing groups first, then by name", () => {
    const groups = buildFontGroups(fonts, answers, false);
    expect(groups.map((group) => group.family)).toEqual(["Inter", "Zeta", "Roboto"]);
  });

  test("orders rows inside a group by status, missing first", () => {
    const inter = buildFontGroups(fonts, answers, false)[0];
    expect(inter?.rows.map((row) => [row.usage.style, row.status])).toEqual([
      ["Bold", "install"],
      ["Black", "reload"],
      ["Regular", "synced"],
    ]);
  });

  test("leaves status null without resolve results, still putting missing fonts first", () => {
    const groups = buildFontGroups(fonts, null, false);
    expect(groups.flatMap((group) => group.rows.map((row) => row.status))).toEqual([null, null, null, null, null]);
    expect(groups[0]?.rows.map((row) => row.usage.style)).toEqual(["Black", "Bold", "Regular"]);
    expect(groups.map((group) => group.family)).toEqual(["Inter", "Zeta", "Roboto"]);
  });

  test("matches resolve results by family and style, not by position", () => {
    const groups = buildFontGroups([usage("A", "B", true)], [resolved("X", "Y", "f"), resolved("A", "B", null)], false);
    expect(groups[0]?.rows[0]?.status).toBe("figma-provided");
  });

  test("a font missing from the resolve response has no status", () => {
    const groups = buildFontGroups([usage("A", "B", true)], [], false);
    expect(groups[0]?.rows[0]?.status).toBeNull();
  });

  test("counts and installable", () => {
    const groups = buildFontGroups(fonts, answers, false);
    const counts = countStatuses(groups);
    expect(counts).toEqual({
      install: 1,
      reload: 1,
      replace: 0,
      "not-in-library": 1,
      add: 0,
      "local-only": 0,
      synced: 1,
      "figma-provided": 1,
    });
    expect(Object.keys(counts).sort()).toEqual([...STATUS_ORDER].sort());
    const { rows, fileIds } = installable(groups);
    expect(rows.map((row) => row.key)).toEqual([fontKey({ family: "Inter", style: "Bold" })]);
    expect(fileIds).toEqual(["f-inter"]);
  });

  test("installable dedupes file ids shared by several styles", () => {
    const groups = buildFontGroups(
      [usage("V", "Light", false), usage("V", "Heavy", false)],
      [resolved("V", "Light", "f-var"), resolved("V", "Heavy", "f-var")],
      false,
    );
    const { rows, fileIds } = installable(groups);
    expect(rows).toHaveLength(2);
    expect(fileIds).toEqual(["f-var"]);
  });
});

describe("fontKey", () => {
  test("does not collide when family and style split differently", () => {
    expect(fontKey({ family: "A B", style: "C" })).not.toBe(fontKey({ family: "A", style: "B C" }));
  });
});

describe("chunk", () => {
  test("splits into batches of the given size", () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });

  test("rejects a size below 1", () => {
    expect(() => chunk([1], 0)).toThrow(RangeError);
  });
});

describe("resolveInBatches", () => {
  test("sends batches in order with only family and style, and concatenates the answers", async () => {
    const fonts = Array.from({ length: 2500 }, (_, index) => usage(`F${index}`, "Regular", true));
    const batches: unknown[][] = [];
    const result = await resolveInBatches(fonts, async (batch) => {
      batches.push(batch);
      return batch.map((font) => resolved(font.family, font.style, null));
    });
    expect(batches.map((batch) => batch.length)).toEqual([1000, 1000, 500]);
    expect(batches[0]?.[0]).toEqual({ family: "F0", style: "Regular" });
    expect(result).toHaveLength(2500);
    expect(result[2499]?.family).toBe("F2499");
  });

  test("makes no request for an empty file", async () => {
    let calls = 0;
    const result = await resolveInBatches([], async () => {
      calls += 1;
      return [];
    });
    expect(calls).toBe(0);
    expect(result).toEqual([]);
  });

  test("stops at the first failing batch", async () => {
    const fonts = [usage("A", "R", true), usage("B", "R", true), usage("C", "R", true)];
    let calls = 0;
    const attempt = resolveInBatches(
      fonts,
      async () => {
        calls += 1;
        throw new Error("boom");
      },
      1,
    );
    await expect(attempt).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });
});
